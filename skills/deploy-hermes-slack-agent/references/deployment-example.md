# Hermes Slack Agent Deployment Example

Reference for creating or reviewing a standalone Hermes Slack agent deployment.
Matches the flow in the repo `README.md`.

## Contents

- Prerequisites
- On-disk layout
- Step-by-step flow
- Agent config fields
- Auto-provisioned secrets (inside `deploy`)
- Slack app
- Compiled manifests (`deployments/`)
- Health checks
- Failure handling

## Prerequisites

Two CLIs and tenant credentials:

| Tool | Install | Used for |
|---|---|---|
| **tfy** | `pip install -U "truefoundry"` | `tfy apply` / `tfy deploy` |
| **tfy-hermes-agent** | `npm install github:truefoundry/tfy-hermes-agent` | `init`, manifest compilation, `deploy` |

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

## On-disk layout

Each agent lives under `agents/<name>/`:

```text
agents/devrel-assistant/
├── devrel-assistant.yaml           # source config — edit this
├── slack-app-manifest.json         # Slack app setup (init only)
├── .hermes-secrets.local           # gitignored HERMES-RUN-TOKEN-SECRET seed
└── deployments/                    # compiled by deploy
    ├── devrel-assistant-volume.yaml
    ├── devrel-assistant-controller.yaml
    └── devrel-assistant-executor.yaml
```

Multiple agents in one repo:

```text
agents/
├── devrel-assistant/
│   ├── devrel-assistant.yaml
│   └── deployments/...
└── oncall-bot/
    ├── oncall-bot.yaml
    └── deployments/...
```

SecretGroup is **not** a file in `deployments/` — `deploy` provisions it via API before apply.

## Step-by-step flow

### 1. Install both CLIs

```bash
pip install -U "truefoundry"
npm install github:truefoundry/tfy-hermes-agent
```

Global install optional: `npm install -g github:truefoundry/tfy-hermes-agent`

### 2. Create agent config

```bash
tfy-hermes-agent init
# API-only: tfy-hermes-agent init --api-only
```

Creates `agents/<name>/` with `<name>.yaml`, `slack-app-manifest.json` (unless `--api-only`), `.hermes-secrets.local`, and `deployments/`.

**Wizard prompts:** required fields (`name`, `description`, `model`, `workspace_fqn`, `gateway_url`, `secrets` name), then optional (`version`, `host`, `instructions`, `skills`, `mcp_servers`, and Slack allowlists — blank skips, omitted from yaml). `--api-only` skips Slack file and Slack optional prompts.

Or copy `agents/devrel-assistant/devrel-assistant.yaml` from the package into `agents/<name>/` and edit.

### 3. Slack app (skip if API-only)

1. Go to [https://api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From an app manifest** → paste `agents/<name>/slack-app-manifest.json`
2. Install to workspace
3. Copy bot token + signing secret (paste into SecretGroup after deploy in step 4)

No Socket Mode. No Slack user groups.

### 4. Deploy

No separate SecretGroup step. `deploy` auto-creates the group via API, sets `HERMES-RUN-TOKEN-SECRET` (from `agents/<name>/.hermes-secrets.local`) and `TFY-API-KEY` (from `credentials.json` or env). For Slack, paste tokens from step 3 into `SLACK-BOT-TOKEN` and `SLACK-SIGNING-SECRET` after deploy — the only manual secret step.

Preview (compile only):

```bash
tfy-hermes-agent deploy devrel-assistant --skip-live-checks
```

Apply:

```bash
tfy-hermes-agent deploy devrel-assistant
# or: tfy-hermes-agent deploy agents/devrel-assistant/devrel-assistant.yaml
```

`deploy` compiles to `agents/<name>/deployments/`, then applies with `tfy apply -f` in order:

```text
<name>-volume.yaml       → Volume (10Gi RWO, /data on controller)
<name>-controller.yaml   → Service (Slack + /v1/*)
<name>-executor.yaml     → Job template (hermes -z per turn)
```

After git-source image changes:

```bash
tfy deploy --force -f agents/<name>/deployments/<name>-controller.yaml
tfy deploy --force -f agents/<name>/deployments/<name>-executor.yaml
```

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

## Agent config (`agents/<name>/<name>.yaml`)

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
| `name` | yes | Lowercase handle, 2–32 chars; becomes `agents/<name>/` folder |
| `workspace_fqn` | yes | `cluster:workspace` |
| `gateway_url` | yes | OpenAI-compatible gateway `/v1` URL |
| `model` | yes | Gateway model id |
| `secrets` | yes | SecretGroup name only; `deploy` creates group via API and sets `TFY-API-KEY` + `HERMES-RUN-TOKEN-SECRET` |
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

No standalone SecretGroup step. `deploy` runs `ensureSecretGroup` via API first:

| Key | Set by |
|---|---|
| `TFY-API-KEY` | `deploy` from `credentials.json` or `TFY_API_KEY` |
| `HERMES-RUN-TOKEN-SECRET` | `deploy` from `agents/<name>/.hermes-secrets.local` or generated |
| `SLACK-BOT-TOKEN` | User after deploy (from Slack app) — placeholders until then |
| `SLACK-SIGNING-SECRET` | User after deploy (from Slack app) — placeholders until then |

Hyphens only in secret key names.

## Compiled manifests (`deployments/`)

Written by `deploy` (default: `agents/<name>/deployments/`). Do not hand-edit — change `agents/<name>/<name>.yaml` and re-run `deploy`.

| File | Resource | Notes |
|---|---|---|
| `<name>-volume.yaml` | Volume | 10Gi RWO PVC at `/data` on controller |
| `<name>-controller.yaml` | Service | Slack webhooks + OpenAI-compatible `/v1/*` |
| `<name>-executor.yaml` | Job | Per-turn Hermes runner; references SecretGroup via `tfy-secret://` |

Controller and executor manifests embed `tfy-secret://` references to the SecretGroup named in the agent config — they do not contain secret values.

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
- `tfy apply` succeeds but no rebuild: use `tfy deploy --force -f agents/<name>/deployments/<name>-controller.yaml` (and executor).
- `Invalid workspace id`: query params must be camelCase (`workspaceFqn`).
- Stale files in `deployments/`: re-run `deploy` to overwrite; do not apply old manifests after renaming an agent.
