# Hermes Agent Session Smoke Test

Use this before telling the user a deployed agent is healthy.

## Health

Check:

```text
GET https://<host>/api/health
GET https://<host>/slack/health
GET https://<host>/v1/models
```

Use the `TFY-API-KEY` from the agent's SecretGroup as the `/v1/*`
bearer token. The controller is fail-closed: it refuses to start without
both `TFY_API_KEY` and `HERMES_RUN_TOKEN_SECRET` set.

Expected Slack health:

- `botTokenConfigured: true`
- `signingSecretConfigured: true`

## Backend Session Test

Run the test through `/v1/responses`, not Slack, so failures are easier to
isolate. The controller derives a fresh `hermes_session_id` per top-level call
and chains via `previous_response_id`.

1. POST `/v1/responses` with a fresh prompt → save `response.id` as session 1.
2. Send 10 follow-ups, each with `previous_response_id` pointing at the prior
   response. The controller will look up the run row, reuse its
   `hermes_session_id`, and the executor will pull the same
   `/api/internal/runs/<id>/session-db` blob for each turn.
3. POST another fresh `/v1/responses` → save `response.id` as session 2.
4. Send 5 follow-ups to session 2.
5. Return to session 1's last `response.id` and chain one more turn.
6. Fire one turn against each session in parallel and confirm both complete.

All turns should complete with a final result. The two sessions must not leak
context into each other — verify by asking session 2 to recall a fact only
mentioned in session 1; it should not know.

What this exercises end-to-end:

- `slack_threads` is bypassed for `/v1/*`; continuity uses `runs.openai_id`
  → `hermes_session_id` instead.
- The session DB ship cycle: controller GET-responds with the blob,
  executor runs Hermes against `/workspace/.hermes/state.db`, executor
  POSTs the updated blob back, controller atomic-renames into
  `/data/sessions/<id>.db`.
- The per-run HMAC token (`HERMES_RUN_TOKEN_SECRET`) gates every callback.

## Run Diagnostics

Inspect run events. For a healthy run, expect:

- `manifestSystemPromptConfigured: true`
- correct `mcpServerCount`
- expected `toolsets`
- expected `skillCount`
- `openaiBaseUrlConfigured: true`
- `openaiApiKeyConfigured: true`
- final `stdout_delta` or final run `result`

For MCP-backed agents, include one prompt that forces a real MCP tool call and
confirm `tool_start` and `tool_complete` events appear.

## Slack Handoff Test

Ask the user to mention the agent in a real channel:

```text
@<name> hello, summarize what you can do
```

While they test, monitor API/run logs and confirm:

- Slack webhook reaches `/slack/events`
- exactly one run is created for the user message
- executor job starts
- Hermes activity appears
- final answer posts in the Slack thread

If `slack.allowed_channels` or `slack.allowed_users` is configured in
`hermes.yaml`, also test one denied channel or user path before declaring the
allowlist healthy.

If the agent responds without a mention in a channel, fix routing before
declaring success.
