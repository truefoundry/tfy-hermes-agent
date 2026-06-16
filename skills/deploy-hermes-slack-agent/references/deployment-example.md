# Hermes Slack Agent Deployment Example

Use this when creating or reviewing a standalone Hermes Slack agent deployment.

## Contents

- Agent inputs
- `hermes.yaml`
- SecretGroup scaffold
- Slack app
- Deployment
- Health checks
- Failure handling

## Agent Inputs

Collect these first:

- `name`: lowercase Slack-safe handle, for example `devrel-assistant`
- `description`: one short sentence
- `instructions`: operating behavior/personality
- `model`: gateway model id (e.g. `openai-main/gpt-5.5`)
- `gateway_url`: OpenAI-compatible gateway URL used by Hermes model calls
- `mcp_servers`: MCP Gateway URLs only
- `skills`: skill FQNs only, for example `agent-skill:tfy-eo/sai-mlrepo/humanizer:1`
- `host`: optional public agent API URL; inferred from agent name, workspace, and tenant env when omitted
- `workspace_fqn`: TrueFoundry workspace FQN
- `secrets`: SecretGroup name, default `<name>-hermes-secrets`
- `slack`: optional access policy with `allowed_channels` and `allowed_users` lists

`init` walks the user through these interactively:

```bash
npx @truefoundry/tfy-hermes-agent init
```

## hermes.yaml

```yaml
name: devrel-assistant

workspace_fqn: tfy-ea-dev-eo-az:sai-ws

description: Sai's DevRel operating assistant for TrueFoundry.

instructions: |
  You are Sai's DevRel operating assistant for TrueFoundry.
  Be short, direct, operational, and evidence-heavy.
  Use configured MCP tools for factual DevRel state.
  Draft before sending messages unless explicitly confirmed.

model: openai-main/gpt-5.5

gateway_url: https://your-openai-compatible-gateway/v1

secrets: devrel-assistant-hermes-secrets

# Optional. Omit this block when Slack access is unrestricted.
# Defaults: open to all users and all channels when this block is absent.
slack:
  allowed_channels:
    - C0123456789
  allowed_users:
    - U0123456789

skills: []

mcp_servers:
  - https://gateway.truefoundry.ai/tfy-eo/mcp/devrel-dashboard-mcp/server
```

## SecretGroup Scaffold

`deploy` does NOT create the SecretGroup — it validates one exists with all
four keys and fails with `SecretGroup not found: <name> (create it in
TrueFoundry first)` otherwise. Create the SecretGroup in the TrueFoundry UI
under the workspace named in `secrets:`, then fill these four keys before
running `deploy`:

| Key | Notes |
|---|---|
| `TFY-API-KEY` | Virtual Account PAT with `application:read` + `application:trigger` |
| `HERMES-RUN-TOKEN-SECRET` | 32+ random characters |
| `SLACK-BOT-TOKEN` | `xoxb-…` from the installed Slack app |
| `SLACK-SIGNING-SECRET` | from the installed Slack app |

Passing `--update` to `deploy` emits an additional scaffold manifest
(`<name>-secrets.scaffold.yaml`) and runs `tfy apply` against it — only
useful for refreshing the SecretGroup's metadata after it already exists.

What each one does:

- `TFY-API-KEY` — used by the controller for control-plane calls (job dispatch, skill fetch), passed to Hermes as the LLM-gateway bearer (`OPENAI_API_KEY`), AND used as the inbound `/v1/*` bearer that clients send to the controller. Fail-closed: the controller refuses to start without it. **Must have read access on the workspace's apps** (not just write) — the controller looks up the executor's deployment ID via `GET /api/svc/v1/apps?workspaceFqn=...&applicationName=...` and a write-only PAT will return empty data, breaking job dispatch with `active deployment not found`. Use a Virtual Account PAT scoped to `application:read` + `application:trigger`.
- `HERMES-RUN-TOKEN-SECRET` — master HMAC secret. The controller signs a per-run callback token for each turn; the executor presents it on every callback (`/events`, `/complete`, `/session-db`). 32+ random characters. Fail-closed.
- `SLACK-BOT-TOKEN` — `xoxb-…` token from the installed Slack app.
- `SLACK-SIGNING-SECRET` — signing secret from the installed Slack app, used to verify webhook authenticity.

Do not ask the user to paste these values into chat. They go directly into the TrueFoundry SecretGroup UI.

## Slack App

1. Run `npx @truefoundry/tfy-hermes-agent init` to generate `slack-app-manifest.json`.
2. User creates the Slack app from the manifest.
3. User installs the app into the workspace.
4. User copies the signing secret and bot token into the SecretGroup.
5. After deploy, verify Slack settings point at:
   - `https://<host>/slack/events`
   - `https://<host>/slack/interactions`

Do not use Socket Mode. Do not create Slack user groups.

If `slack` is omitted, Slack access is open: any user and any channel where the
app is installed and invited can trigger the agent. If `slack.allowed_channels`
is set, only those channel/group/DM IDs can trigger the agent. If
`slack.allowed_users` is set, only those user IDs can trigger the agent.

## Deployment

```bash
npx @truefoundry/tfy-hermes-agent deploy hermes.yaml
```

Flags:

- `--update` — overwrite an existing deployment of the same name.
- `--emit-manifests <dir>` — also write the generated YAML files to `<dir>` for inspection. Without this flag, manifests are piped directly to `tfy apply` from memory.
- `--skip-live-checks` — bypass control-plane validation; only use while iterating offline.

`deploy` applies three resources in this order:

```text
<name>-volume.yaml             (RWO PVC, 10Gi default, mounted at /data on the controller)
<name>-controller.yaml         (Service, replicas: 1, mounts the volume)
<name>-executor.yaml           (Job template, no volume mount, runs hermes -z per turn)
```

Passing `--update` prepends `<name>-secrets.scaffold.yaml` to refresh the
SecretGroup's metadata; the default flow leaves the SecretGroup untouched.

State durability lives on the controller's RWO `/data` volume. There is no
deployed snapshot job; if offsite backup is required, run an out-of-band
`sqlite3 .backup` cron against the same volume.

## Health Checks

After deploy:

```bash
curl -fsS https://<host>/api/health
curl -fsS https://<host>/slack/health
curl -fsS -H "Authorization: Bearer <TFY-API-KEY>" https://<host>/v1/models
```

Expected `/slack/health` includes:

- `botTokenConfigured: true`
- `signingSecretConfigured: true`

## Failure Handling

- Controller refuses to start: confirm `TFY-API-KEY` and `HERMES-RUN-TOKEN-SECRET` are set; both are fail-closed on startup.
- Slack URL verification fails: confirm `/api/health`, `/slack/health`, and same-app signing secret.
- Slack auth fails: reinstall the app and refresh `SLACK-BOT-TOKEN` in the SecretGroup.
- No channel response: invite the Slack app to the channel and confirm scopes.
- Agent responds without a mention in a channel: fix routing before declaring success.
- Run dispatched but never completes: inspect `<name>-executor` job logs and gateway credentials; the controller's reconciler marks stuck runs `failed` after the run TTL.
- Executor crashes mid-turn: the conversation in `/data/sessions/<id>.db` is unchanged (the upload is the commit), and the next user message starts a clean turn from the prior state.
- Thinking completes but no final output: inspect Slack stream completion and final markdown formatting.
- Two runs for one message: inspect event dedupe (`slack_seen_events` table) and `metadata.job_run_name_alias` idempotency on Trigger Job.
- MCP tools are missing: verify `mcp_servers`, executor diagnostic toolsets, and MCP discovery before oneshot.
- Instructions are ignored: verify manifest instructions are appended as an ephemeral system prompt.
- `401 invalid bearer token` on internal callbacks: per-run HMAC token expired or wrong; check controller and executor agree on `HERMES_RUN_TOKEN_SECRET`.
- `active deployment not found for job <executor>`: the `TFY-API-KEY` in the SecretGroup is missing `read` permission on the workspace's apps. The controller can dispatch but can't look up the executor's deployment ID. Replace with a PAT that has `application:read`.
- `BUILD_FAILED` at ~90s with no log message: TrueFoundry's git puller rejects branch refs containing `/`. If `version:` in `hermes.yaml` is a slashed branch, replace with the commit SHA (`git rev-parse HEAD`) and redeploy.
- `tfy apply` "succeeds" but no rebuild happens: `tfy apply` only triggers a build for `image.type: image`. For `image.type: build` (git sources, which is our default) use `tfy deploy --force -f <manifest>`. `tfy apply` will reuse the existing image and just roll a new pod (useful after a SecretGroup change — env vars refresh without rebuild).
- `Invalid workspace id` on `/api/svc/v1/*` queries: the platform's query params are camelCase (`workspaceFqn`, not `workspace_fqn`). Snake-case is silently ignored upstream of the filter logic.
