---
name: deploy-hermes-slack-agent
description: Onboards standalone TrueFoundry Hermes agents from hermes.yaml — Slack, API-only (`init --api-only`), or both. Use when a user wants to create, deploy, update, or smoke-test a Hermes agent with generated manifests, auto-provisioned SecretGroup, volume, controller, and executor.
---

# Deploy Hermes Slack Agent

Use this skill as an interactive deployment operator, not as a static checklist.
Keep the conversation moving one missing input or one manual task at a time.

## Core Contract

- Source of truth: `agents/<name>/<name>.yaml`.
- Generated output: compiled to `agents/<name>/deployments/`; `deploy` runs `tfy apply -f` on each file. Pass `--emit-manifests <dir>` to write elsewhere. SecretGroup is provisioned via API, not as a deployments file.
- Architecture: Slack deployments use one Slack app per agent; API-only (`init --api-only`) skips Slack. Both paths use a `secrets` SecretGroup (`deploy` auto-creates if missing) and three TrueFoundry resources `deploy` applies — `volume` (RWO PVC mounted at /data on the controller), `controller` (Service), and `executor` (Job template). State durability is the controller's RWO `/data` volume; offsite snapshotting is out of scope for the deployed stack.
- Slack transport: HTTP Events API and Interactivity only. Do not use Socket Mode, WebSockets, slash commands, Slack user groups, or Slack OAuth.
- Secrets: never ask the user to paste raw Slack tokens, signing secrets, TrueFoundry API keys, or the HERMES run-token secret into chat. `deploy` sets `HERMES-RUN-TOKEN-SECRET` and `TFY-API-KEY` automatically. For Slack, the user pastes bot token + signing secret into the SecretGroup UI after deploy — the only manual secret step.
- Deployment gate: `deploy` calls `ensureSecretGroup` then runs live validation unless `--skip-live-checks` is passed. There is no separate `validate` command.

## Load References

- Read `references/deployment-example.md` when creating or reviewing `hermes.yaml`, generated manifests, Slack app setup, deploy (including auto-provisioned secrets), or failure handling.
- Read `references/session-smoke-test.md` before declaring a deployment healthy or when debugging runtime behavior.

## Workflow

Track this sequence and resume from the first incomplete step.

### Step 0 — Prerequisites

Hard stop until these are satisfied:

1. **Runtime versions:** Node 22+ (tfy-hermes-agent), Python 3.9+ (tfy CLI).

2. **tfy CLI** installed and authenticated:
   ```bash
   pip install -U "truefoundry"
   tfy login --host https://<tenant>.truefoundry.cloud
   ```
   Or `TFY_HOST` + `TFY_API_KEY` in the shell (overrides `credentials.json`).
   If `~/.truefoundry/credentials.json` is missing, stop and have the user run `tfy login`.
   For production agents: `tfy login --host <url> --api-key <virtual-account-pat>` with `application:read` + `application:trigger`.

3. **tfy-hermes-agent** installed in the user's project or globally:
   ```bash
   npm install github:truefoundry/tfy-hermes-agent
   # or: npm install -g github:truefoundry/tfy-hermes-agent
   ```
   Commands below use `tfy-hermes-agent`. If installed locally, use `npx tfy-hermes-agent` instead.

4. Verify: `tfy version` and `tfy-hermes-agent help`.

### Step 1 — Agent config

If `agents/<name>/<name>.yaml` does not exist:

```bash
tfy-hermes-agent init
# API-only: tfy-hermes-agent init --api-only
```

Creates `agents/<name>/` with `<name>.yaml`, `slack-app-manifest.json` (unless `--api-only`), `.hermes-secrets.local`, and an empty `deployments/` folder.

**Init wizard prompts**

Required: `name`, `description`, `model`, `workspace_fqn`, `gateway_url`, `secrets` (SecretGroup name only — `deploy` creates it).

Then optional (Enter to skip each; omitted from `hermes.yaml` when blank):

| Field | Wizard prompt |
|---|---|
| `version` | Git ref for image build (default `main`, omitted if unchanged) |
| `host` | Public controller URL |
| `instructions` | Multiline system prompt |
| `skills` | Comma-separated version-pinned FQNs |
| `mcp_servers` | Comma-separated MCP Gateway URLs |
| `slack_team_id` | Slack team id (`T…`) — skipped with `--api-only` |
| `slack.allowed_channels` | Comma-separated channel IDs — skipped with `--api-only` |
| `slack.allowed_users` | Comma-separated user IDs — skipped with `--api-only` |

Or copy `agents/devrel-assistant/devrel-assistant.yaml` from the package and edit in place.

If it already exists, collect any missing fields and edit in place. See **Input Rules** below and `references/deployment-example.md`.

### Step 2 — Slack app (skip if API-only)

Stop for manual Slack work before deploy:

1. Go to [https://api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From an app manifest** → paste `agents/<name>/slack-app-manifest.json` from `init`.
2. **Install App** to the workspace.
3. Copy bot token and signing secret (paste into SecretGroup after deploy in step 3):
   - **OAuth & Permissions** → Bot User OAuth Token → `SLACK-BOT-TOKEN`
   - **Basic Information** → Signing Secret → `SLACK-SIGNING-SECRET`

### Step 3 — Deploy

No separate SecretGroup step. `deploy` auto-creates the group and sets `HERMES-RUN-TOKEN-SECRET` (from `.hermes-secrets.local`) and `TFY-API-KEY` (from `credentials.json` or env). For Slack, the only manual secret work is pasting tokens from step 2 into `SLACK-BOT-TOKEN` and `SLACK-SIGNING-SECRET` after deploy runs.

Stop only if secret-store integration discovery fails (then create the SecretGroup manually in the UI).

Preview manifests offline (optional):

```bash
tfy-hermes-agent deploy <name> --skip-live-checks
```

Compiles to `agents/<name>/deployments/`: `<name>-volume.yaml`, `<name>-controller.yaml`, `<name>-executor.yaml`.

Apply to TrueFoundry (`ensureSecretGroup` via API first, then live validation, then `tfy apply -f` from `deployments/` in order: volume → controller → executor):

```bash
tfy-hermes-agent deploy <name>
# or: tfy-hermes-agent deploy agents/<name>/<name>.yaml
```

Reads `~/.truefoundry/credentials.json` from `tfy login` when `TFY_HOST` / `TFY_API_KEY` are unset.

Flags:
- `--update` — overwrite existing deployment
- `--emit-manifests <dir>` — write compiled yaml to a custom directory instead of `deployments/`
- `--skip-live-checks` — compile only; does not apply or provision secrets

After a git-source image change, rebuild with `tfy deploy --force -f <manifest>` (not plain `tfy apply`).

### Step 4 — Post-deploy Slack URLs (skip if API-only)

After deploy, stop and have the user confirm Slack settings match the controller host:

- `https://<host>/slack/events`
- `https://<host>/slack/interactions`

Invite the bot to target channels.

### Step 5 — Verify

**All deployments:**

```bash
curl -fsS https://<host>/api/health
curl -fsS -H "Authorization: Bearer <TFY-API-KEY>" https://<host>/v1/models
```

**Slack deployments** (skip if API-only):

```bash
curl -fsS https://<host>/slack/health
```

Then run backend session smoke tests (`references/session-smoke-test.md`). For Slack, finish with one real mention.

## What `deploy` Validates Live

`deploy` always runs live unless `--skip-live-checks` is passed. Credentials come from `TFY_HOST` + `TFY_API_KEY` (env) or `~/.truefoundry/credentials.json` (`host`, `access_token`). Every check must pass before manifests apply.

Auth & access:
- Credentials authenticate against the target host.
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
- `ensureSecretGroup` runs inside `deploy` — creates the SecretGroup when missing, sets `HERMES-RUN-TOKEN-SECRET` and `TFY-API-KEY` automatically. All four keys must exist before manifests apply (Slack keys start as placeholders; user pastes real tokens after deploy if Slack is in scope).

## Input Rules

| Field | Required | Notes |
|---|---|---|
| `name` | yes | Lowercase Slack-safe handle, 2–32 chars, e.g. `devrel-assistant`. |
| `workspace_fqn` | yes | `cluster:workspace`, e.g. `tfy-ea-dev-eo-az:sai-ws`. |
| `gateway_url` | yes | OpenAI-compatible gateway URL for Hermes model calls. |
| `model` | yes | Gateway model id, e.g. `openai-main/gpt-5.5`. |
| `secrets` | yes | SecretGroup name (default `<name>-hermes-secrets`); `deploy` creates and populates `TFY-API-KEY` + `HERMES-RUN-TOKEN-SECRET`. Init only asks for the name. |
| `version` | no | Git ref for controller/executor image build. Default `main`. Slashed branches fail on TF's git puller — use commit SHA. |
| `host` | no | Public controller URL; inferred from `TFY_HOST` + `name` + workspace if omitted. |
| `description` | no | Short agent description. |
| `instructions` | no | System prompt appended each executor turn. |
| `slack.allowed_channels` | no | Channel/group/DM IDs. Omitted = all channels bot is in. |
| `slack.allowed_users` | no | User IDs. Omitted = all users. |
| `slack_team_id` | no | Slack team id if pinning a workspace. |
| `skills` | no | Version-pinned FQNs, e.g. `agent-skill:tfy-eo/sai-mlrepo/humanizer:1`. |
| `mcp_servers` | no | TrueFoundry MCP Gateway URLs only. |

If the user gives names instead of FQNs, URLs, or Slack IDs, pause and ask for exact values or offer to look them up when tooling is available. Prefer `tfy-hermes-agent init` when starting from scratch — it prompts every optional field.

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

- Installing/authenticating `tfy` (`tfy login`) or `tfy-hermes-agent`
- Production Virtual Account PAT setup (`tfy login --api-key …`) when the user's personal token lacks `application:read` + `application:trigger`
- Manual SecretGroup creation only when `deploy` cannot discover a secret-store integration
- Slack app at https://api.slack.com/apps (skip if API-only) — before deploy
- Slack token entry in SecretGroup UI after deploy (never in chat; only manual secret step)
- Slack URL verification in Slack settings (skip if API-only)
- First real Slack message result (skip if API-only)

When stopping, give exactly one concrete task and the file/path/name the user needs.

## Completion Criteria

The flow is complete only when:

- Both CLIs installed; TrueFoundry credentials available via `tfy login` or env vars
- `hermes.yaml` exists and `deploy` succeeds (auto secrets + live validation + `tfy apply` for volume, controller, executor)
- `TFY-API-KEY` and `HERMES-RUN-TOKEN-SECRET` set by `deploy` (no manual step)
- Slack tokens pasted into SecretGroup after deploy (if Slack is in scope)
- `/api/health` and `/v1/models` respond
- `/slack/health` responds with configured tokens (if Slack is in scope)
- Backend session smoke tests pass (see `references/session-smoke-test.md`)
- Slack Events and Interactivity URLs verified in Slack settings (if Slack is in scope)
- A real Slack mention receives a final Hermes response (if Slack is in scope)
