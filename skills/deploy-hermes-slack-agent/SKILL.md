---
name: deploy-hermes-slack-agent
description: Onboards standalone TrueFoundry Hermes Slack agents from hermes.yaml. Use when a user wants to create, deploy, update, or smoke-test a Hermes agent with a generated Slack app manifest, TrueFoundry SecretGroup, volume, controller, and executor.
---

# Deploy Hermes Slack Agent

Use this skill as an interactive deployment operator, not as a static checklist.
Keep the conversation moving one missing input or one manual task at a time.

## Core Contract

- Source of truth: `hermes.yaml`.
- Distribution: GitHub only — not on the npm registry. Install with `npm install github:truefoundry/tfy-hermes-agent`.
- Two CLIs required: **tfy** (`pip install -U "truefoundry"`) applies manifests; **tfy-hermes-agent** generates them and orchestrates `tfy apply`.
- Generated output: TrueFoundry manifests built in memory and piped to `tfy apply`. Pass `--emit-manifests <dir>` only when the user wants the YAML files on disk for inspection.
- Architecture: one Slack app per agent, a `secrets` SecretGroup the user creates out-of-band, and three TrueFoundry resources `deploy` applies — `volume` (RWO PVC mounted at /data on the controller), `controller` (Service), and `executor` (Job template). State durability is the controller's RWO `/data` volume; offsite snapshotting is out of scope for the deployed stack.
- Slack transport: HTTP Events API and Interactivity only. Do not use Socket Mode, WebSockets, slash commands, Slack user groups, or Slack OAuth.
- Secrets: never ask the user to paste raw Slack tokens, signing secrets, TrueFoundry API keys, or the HMAC run-token secret into chat. Have them fill the TrueFoundry SecretGroup directly.
- Deployment gate: `deploy` runs live validation as its first action. There is no separate `validate` command.

## Load References

- Read `references/deployment-example.md` when creating or reviewing `hermes.yaml`, generated manifests, Slack app setup, SecretGroup setup, deployment, or failure handling.
- Read `references/session-smoke-test.md` before declaring a deployment healthy or when debugging runtime behavior.

## Workflow

Track this sequence and resume from the first incomplete step.

### Step 0 — Prerequisites

Hard stop until these are satisfied:

1. **tfy CLI** installed and authenticated:
   ```bash
   pip install -U "truefoundry"
   tfy login --host https://<tenant>.truefoundry.cloud
   ```
   Or `TFY_HOST` + `TFY_API_KEY` set in the shell (used by both `tfy` and `deploy`).

2. **tfy-hermes-agent** installed in the user's project or globally:
   ```bash
   npm install github:truefoundry/tfy-hermes-agent
   # or: npm install -g github:truefoundry/tfy-hermes-agent
   ```
   Commands below use `tfy-hermes-agent`. If installed locally, use `npx tfy-hermes-agent` instead.

3. Verify: `tfy version` and `tfy-hermes-agent help`.

### Step 1 — TrueFoundry API key

Stop and have the user create a PAT in the tenant UI (**Settings → Access Tokens** or a **Virtual Account** scoped to the target workspace):

- `application:read` — controller looks up the executor deployment
- `application:trigger` — controller dispatches executor jobs

The token becomes:
- `TFY_API_KEY` in the shell for `deploy` live validation
- `TFY-API-KEY` in the SecretGroup (step 3)

A write-only PAT silently breaks job dispatch.

### Step 2 — `hermes.yaml`

If `hermes.yaml` does not exist:

```bash
tfy-hermes-agent init
```

This writes `hermes.yaml` and `slack-app-manifest.json` in the current directory.

If it already exists, collect any missing fields and edit in place. See **Input Rules** below and `references/deployment-example.md`.

### Step 3 — SecretGroup (manual, before deploy)

`deploy` does **not** create the SecretGroup. Stop and have the user create it in the TrueFoundry UI under the workspace from `workspace_fqn`, named by `secrets:` in `hermes.yaml` (default `<name>-hermes-secrets`).

Fill these four keys (**hyphens only** — TrueFoundry rejects underscores):

| Key | What to put |
|---|---|
| `TFY-API-KEY` | PAT from step 1 |
| `HERMES-RUN-TOKEN-SECRET` | 32+ random chars (`openssl rand -hex 32`). Master HMAC secret for per-run executor callbacks — not a Slack token. |
| `SLACK-BOT-TOKEN` | `xoxb-…` from Slack app (step 4), or placeholder until Slack is wired |
| `SLACK-SIGNING-SECRET` | Signing secret from Slack app (step 4), or placeholder until Slack is wired |

### Step 4 — Slack app (skip if API-only)

Stop for manual Slack work:

1. Create app at [api.slack.com/apps](https://api.slack.com/apps) → **From an app manifest** → paste `slack-app-manifest.json` from `init`.
2. **Install App** to the workspace.
3. Copy into the SecretGroup:
   - **OAuth & Permissions** → Bot User OAuth Token → `SLACK-BOT-TOKEN`
   - **Basic Information** → Signing Secret → `SLACK-SIGNING-SECRET`

### Step 5 — Deploy

Preview manifests offline (optional):

```bash
tfy-hermes-agent deploy hermes.yaml --skip-live-checks --emit-manifests ./manifests
```

Emits `<name>-volume.yaml`, `<name>-controller.yaml`, `<name>-executor.yaml` (and `<name>-secrets.scaffold.yaml` with `--update`).

Apply to TrueFoundry (live validation first, then `tfy apply` in order: volume → controller → executor):

```bash
tfy-hermes-agent deploy hermes.yaml
```

Flags:
- `--update` — overwrite existing deployment; also applies secrets scaffold
- `--emit-manifests <dir>` — write YAML to disk in addition to applying
- `--skip-live-checks` — preview only; does not apply

After a git-source image change, rebuild with `tfy deploy --force -f <manifest>` (not plain `tfy apply`).

### Step 6 — Post-deploy Slack URLs

After deploy, stop and have the user confirm Slack settings match the controller host:

- `https://<host>/slack/events`
- `https://<host>/slack/interactions`

Invite the bot to target channels.

### Step 7 — Verify

```bash
curl -fsS https://<host>/api/health
curl -fsS https://<host>/slack/health
curl -fsS -H "Authorization: Bearer <TFY-API-KEY>" https://<host>/v1/models
```

Then run session smoke tests (`references/session-smoke-test.md`) and one real Slack mention.

## What `deploy` Validates Live

`deploy` always runs live against the user's `TFY_API_KEY` unless `--skip-live-checks` is passed. Every check must pass before manifests apply.

Auth & access:
- `TFY_API_KEY` authenticates against the target host.
- `workspace_fqn` exists and the key has access to it.

Naming & routing:
- `name` does not clash with an existing deployment in the workspace. A match on the current agent's own deployment is an update, allowed only with `--update`.
- `host` (if specified) is not already routed to another deployment.

Resource references:
- Every `skills` FQN exists in the agent-skill registry and is fetchable with the key.
- Every `skills` FQN is version-pinned (e.g. `:1`); floating tags are rejected.
- Every `mcp_servers` URL is a TrueFoundry MCP Gateway URL.
- Every `mcp_servers` URL resolves and is reachable with the key.
- `model` is in the model list reachable from the key.

Secrets:
- The `secrets` SecretGroup already exists in the workspace and contains all four required keys. `deploy` does not create the SecretGroup; if it is missing, validation fails with `SecretGroup not found: <name> (create it in TrueFoundry first)`.

## Input Rules

| Field | Required | Notes |
|---|---|---|
| `name` | yes | Lowercase Slack-safe handle, 2–32 chars, e.g. `devrel-assistant`. |
| `workspace_fqn` | yes | `cluster:workspace`, e.g. `tfy-ea-dev-eo-az:sai-ws`. |
| `gateway_url` | yes | OpenAI-compatible gateway URL for Hermes model calls. |
| `model` | yes | Gateway model id, e.g. `openai-main/gpt-5.5`. |
| `secrets` | yes | Existing SecretGroup name; default `<name>-hermes-secrets`. |
| `version` | no | Git ref for controller/executor image build. Default `main`. Slashed branches fail on TF's git puller — use commit SHA. |
| `host` | no | Public controller URL; inferred from `TFY_HOST` + `name` + workspace if omitted. |
| `description` | no | Short agent description. |
| `instructions` | no | System prompt appended each executor turn. |
| `slack.allowed_channels` | no | Channel/group/DM IDs. Omitted = all channels bot is in. |
| `slack.allowed_users` | no | User IDs. Omitted = all users. |
| `slack_team_id` | no | Slack team id if pinning a workspace. |
| `skills` | no | Version-pinned FQNs, e.g. `agent-skill:tfy-eo/sai-mlrepo/humanizer:1`. |
| `mcp_servers` | no | TrueFoundry MCP Gateway URLs only. |

If the user gives names instead of FQNs, URLs, or Slack IDs, pause and ask for exact values or offer to look them up when tooling is available.

## Auth Model

| Surface | Credential | SecretGroup key |
|---|---|---|
| `/v1/*` | Bearer | `TFY-API-KEY` |
| `/api/internal/*` | Per-run HMAC | minted from `HERMES-RUN-TOKEN-SECRET` |
| `/slack/*` webhooks | Slack signature | `SLACK-SIGNING-SECRET` |
| Slack outbound | Bot token | `SLACK-BOT-TOKEN` |
| LLM gateway (executor) | Bearer | `TFY-API-KEY` |

## Manual Stops

Only stop for external work:

- Installing/authenticating `tfy` or `tfy-hermes-agent`
- Creating a TrueFoundry API key / Virtual Account PAT
- SecretGroup creation and value entry
- Slack app creation and installation
- Slack URL verification in Slack settings
- First real Slack message result

When stopping, give exactly one concrete task and the file/path/name the user needs.

## Completion Criteria

The flow is complete only when:

- Both CLIs installed; `TFY_HOST`/`TFY_API_KEY` authenticate
- `hermes.yaml` exists and `deploy` succeeds (live validation passed and `tfy apply` reported success for volume, controller, and executor)
- SecretGroup exists with all four keys filled
- Slack app installed (if Slack is in scope)
- `/api/health`, `/slack/health`, and `/v1/models` respond
- Session smoke tests pass (see `references/session-smoke-test.md`)
- Slack Events and Interactivity URLs verified in Slack settings
- A real Slack mention receives a final Hermes response
