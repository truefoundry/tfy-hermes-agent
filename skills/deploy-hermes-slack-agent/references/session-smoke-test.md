# Hermes Agent Session Smoke Test

Use this before telling the user a deployed agent is healthy.

## Health

Check:

```text
GET https://<host>/api/health
GET https://<host>/slack/health
GET https://<host>/v1/models
```

Expected Slack health:

- `botTokenConfigured: true`
- `signingSecretConfigured: true`
- `oauthConfigured: false`
- `createUsergroups: false`
- `requireChannelDeployment: false`

## Backend Session Test

Run the test through the agent API, not Slack, so failures are easier to isolate.

1. Create session 1.
2. Send 10 turns to session 1.
3. Create session 2.
4. Send 5 turns to session 2.
5. Return to session 1 and send one more turn.
6. Send one turn to session 1 and one turn to session 2 in parallel.

All turns should complete with a final result. The two sessions must not leak
context into each other.

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

If the agent responds without a mention in a channel, fix routing before
declaring success.
