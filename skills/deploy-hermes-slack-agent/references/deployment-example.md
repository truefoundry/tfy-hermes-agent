# Hermes Slack Agent Deployment Example

Reference for creating or reviewing a standalone Hermes Slack agent deployment.
Matches the flow in the repo `README.md`.

## Contents

- Prerequisites
- Step-by-step flow
- `hermes.yaml` fields
- Auto-provisioned secrets (inside `deploy`)
- Slack app
- Generated manifests
- Health checks
- Failure handling

## Prerequisites

Two CLIs and tenant credentials:

| Tool | Install | Used for |
|---|---|---|
| **tfy** | `pip install -U "truefoundry"` | `tfy apply` / `tfy deploy` |
| **tfy-hermes-agent** | `npm install github:truefoundry/tfy-hermes-agent` | `init`, manifest generation, `deploy` |

Also: **Node 22+**, **Python 3.9+**.

Authenticate:

```bash
pip install -U "truefoundry"
tfy login --host https://<tenant>.truefoundry.cloud
```

`deploy` reads `~/.truefoundry/credentials.json` automatically. Without it (and without `TFY_HOST` / `TFY_API_KEY` in the shell), `deploy` fails with a `tfy login` hint.

For production agents, use a Virtual Account PAT with `application:read` + `application:trigger`:

```bash
tfy login --host https://<tenant>.truefoundry.cloud --api-key <virtual-account-pat>
```

Or set env vars explicitly:

```bash
export TFY_HOST=https://<tenant>.truefoundry.cloud
export TFY_API_KEY=<pat>
```

Verify: `tfy version` and `tfy-hermes-agent help` (or `npx tfy-hermes-agent help`).

## Step-by-step flow

### 1. Install both CLIs

```bash
pip install -U "truefoundry"
npm install github:truefoundry/tfy-hermes-agent
```

Global install optional: `npm install -g github:truefoundry/tfy-hermes-agent`

### 2. Write `hermes.yaml`

```bash
tfy-hermes-agent init
# API-only: tfy-hermes-agent init --api-only
```

Writes `<name>.hermes.yaml` (from the agent handle), `slack-app-manifest.json` (unless `--api-only`), and `.hermes-secrets.local` (generated HMAC secret).

**Wizard prompts:** required fields (`name`, `description`, `model`, `workspace_fqn`, `gateway_url`, `secrets` name), then optional (`version`, `host`, `instructions`, `skills`, `mcp_servers`, and Slack allowlists — blank skips, omitted from yaml). `--api-only` skips Slack file and Slack optional prompts.

### 3. Slack app (skip if API-only)

1. Go to [https://api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From an app manifest** → `slack-app-manifest.json`
2. Install to workspace
3. Copy bot token + signing secret (paste into SecretGroup after deploy in step 4)

No Socket Mode. No Slack user groups.

### 4. Deploy

No separate SecretGroup step. `deploy` auto-creates the group, sets `HERMES-RUN-TOKEN-SECRET` (from `.hermes-secrets.local`) and `TFY-API-KEY` (from `credentials.json` or env). For Slack, paste tokens from step 3 into `SLACK-BOT-TOKEN` and `SLACK-SIGNING-SECRET` after deploy — the only manual secret step.

Preview:

```bash
tfy-hermes-agent deploy hermes.yaml --skip-live-checks --emit-manifests ./manifests
```

Apply:

```bash
tfy-hermes-agent deploy hermes.yaml
```

`deploy` applies in order:

```text
<name>-volume.yaml       → Volume (10Gi RWO, /data on controller)
<name>-controller.yaml   → Service (Slack + /v1/*)
<name>-executor.yaml     → Job template (hermes -z per turn)
```

With `--update`, also emits/applies `<name>-secrets.scaffold.yaml` (metadata only).

After git-source image changes: `tfy deploy --force -f <manifest>`.

For Slack, after deploy verify URLs:

- `https://<host>/slack/events`
- `https://<host>/slack/interactions`

### 5. Verify

**All deployments:**

```bash
curl -fsS https://<host>/api/health
curl -fsS -H "Authorization: Bearer <TFY-API-KEY>" https://<host>/v1/models
```

**Slack deployments** (skip if API-only):

```bash
curl -fsS https://<host>/slack/health
```

See `session-smoke-test.md` for backend session tests and one real Slack mention (skip Slack mention if API-only).

## hermes.yaml

```yaml
name: devrel-assistant

workspace_fqn: tfy-ea-dev-eo-az:sai-ws

description: DevRel operating assistant for TrueFoundry.

instructions: |
  Be short, direct, operational, and evidence-heavy.

model: openai-main/gpt-5.5

gateway_url: https://your-openai-compatible-gateway/v1

secrets: devrel-assistant-hermes-secrets

slack:
  allowed_channels: [C0123456789]
  allowed_users: [U0123456789]

skills:
  - agent-skill:tfy-eo/sai-mlrepo/humanizer:1

mcp_servers:
  - https://gateway.truefoundry.ai/tfy-eo/mcp/devrel-dashboard-mcp/server
```

### Field reference

| Field | Required | Notes |
|---|---|---|
| `name` | yes | Lowercase handle, 2–32 chars |
| `workspace_fqn` | yes | `cluster:workspace` |
| `gateway_url` | yes | OpenAI-compatible gateway `/v1` URL |
| `model` | yes | Gateway model id |
| `secrets` | yes | SecretGroup name only; `deploy` creates group and sets `TFY-API-KEY` + `HERMES-RUN-TOKEN-SECRET` |
| `version` | no | Git ref for image build; `init` prompts |
| `host` | no | Derived from `TFY_HOST` if omitted; `init` prompts |
| `description` | no | Slack assistant description; `init` prompts |
| `instructions` | no | Ephemeral system prompt per turn; `init` prompts (multiline) |
| `slack.allowed_channels` | no | Omitted = all channels; `init` prompts |
| `slack.allowed_users` | no | Omitted = all users; `init` prompts |
| `slack_team_id` | no | Pin Slack workspace; `init` prompts |
| `skills` | no | Version-pinned `agent-skill:…:N` FQNs; `init` prompts |
| `mcp_servers` | no | MCP Gateway URLs; `init` prompts |

## Auto-provisioned secrets

No standalone SecretGroup step. `deploy` runs `ensureSecretGroup` first:

| Key | Set by |
|---|---|
| `TFY-API-KEY` | `deploy` from `credentials.json` or `TFY_API_KEY` |
| `HERMES-RUN-TOKEN-SECRET` | `deploy` from `.hermes-secrets.local` or generated |
| `SLACK-BOT-TOKEN` | User after deploy (from Slack app) — placeholders until then |
| `SLACK-SIGNING-SECRET` | User after deploy (from Slack app) — placeholders until then |

Hyphens only in secret key names.

## Auth model

| Surface | Credential | Source |
|---|---|---|
| `/v1/*` | Bearer | `TFY-API-KEY` |
| `/api/internal/*` | Per-run HMAC | `HERMES-RUN-TOKEN-SECRET` |
| `/slack/*` | Signature HMAC | `SLACK-SIGNING-SECRET` |
| Slack outbound | Bot token | `SLACK-BOT-TOKEN` |
| LLM (executor) | Gateway bearer | `TFY-API-KEY` |

## Health Checks

Expected `/slack/health`:

- `botTokenConfigured: true`
- `signingSecretConfigured: true`

## Failure Handling

- Missing credentials: run `tfy login` or set `TFY_HOST` + `TFY_API_KEY`.
- SecretGroup not created: `deploy` could not find a secret-store integration — create the group manually in the UI.
- Controller refuses to start: confirm `TFY-API-KEY` and `HERMES-RUN-TOKEN-SECRET` in SecretGroup.
- Slack URL verification fails: confirm `/api/health`, `/slack/health`, signing secret matches app.
- Slack auth fails: reinstall app, refresh `SLACK-BOT-TOKEN`.
- No channel response: invite bot, confirm scopes.
- Run dispatched but never completes: inspect `<name>-executor` job logs and gateway credentials.
- `401` on internal callbacks: `HERMES-RUN-TOKEN-SECRET` mismatch or expired per-run token.
- `active deployment not found for job <executor>`: `TFY-API-KEY` missing `application:read`.
- `BUILD_FAILED` with slashed `version:` branch: use commit SHA (`git rev-parse HEAD`).
- `tfy apply` succeeds but no rebuild: use `tfy deploy --force` for `image.type: build`.
- `Invalid workspace id`: query params must be camelCase (`workspaceFqn`).
