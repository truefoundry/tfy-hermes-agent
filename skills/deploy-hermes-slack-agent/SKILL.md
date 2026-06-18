---
name: deploy-hermes-slack-agent
description: Onboards standalone TrueFoundry Hermes agents from agents/<name>/<name>.yaml — Slack, API-only (`init --api-only`), or both. Use when a user wants to create, deploy, update, or smoke-test a Hermes agent with compiled manifests in agents/<name>/deployments/, auto-provisioned SecretGroup, controller, runtime, worker, and volumes.
---

# Deploy Hermes Slack Agent

Use this skill as an interactive deployment operator, not as a static checklist.
Keep the conversation moving one missing input or one manual task at a time.

## Core Contract

- **Source of truth:** `agents/<name>/<name>.yaml` in the user's project (created by `init` or written by hand).
- **Distribution:** GitHub only — not on the npm registry. Install with `npm install github:truefoundry/tfy-hermes-agent`.
- **Two CLIs required:** **tfy** (`pip install -U "truefoundry"`) applies manifests; **tfy-hermes-agent** compiles them and orchestrates `tfy apply -f`.
- **On-disk layout** (per agent):

  ```text
  agents/<name>/
  ├── <name>.yaml                 # edit this — source config
  ├── slack-app-manifest.json     # Slack setup only (skipped with init --api-only)
  ├── .hermes-secrets.local       # gitignored HERMES-RUN-TOKEN-SECRET seed
  └── deployments/                # compiled TF manifests (written by deploy)
      ├── <name>-volume.yaml
      ├── <name>-runtime-volume.yaml
      ├── <name>-runtime.yaml
      ├── <name>-worker.yaml
      ├── <name>-controller.yaml
      └── <name>-artifact-cleanup.yaml # only when slack_inbound_artifact_repo is set
  ```

- **Generated output:** `deploy` compiles to `agents/<name>/deployments/` and runs `tfy apply -f` on each file in order. Order is volume → runtime-volume → runtime → worker → controller, plus artifact cleanup when Slack artifact storage is enabled. Pass `--emit-manifests <dir>` to write elsewhere. **SecretGroup is provisioned via API, not as a deployments file.**
- **Architecture:** Slack deployments use one Slack app per agent; API-only (`init --api-only`) skips Slack. The supported topology uses a `secrets` SecretGroup (`deploy` auto-creates if missing), controller Service for HTTP ingress, private stateful runtime Service for Hermes turns, manual worker Job for async/maintenance surfaces, a controller RWO `/data` volume, and a runtime RWO `/workspace/.hermes` volume. Runtime concurrency defaults to 1 for SQLite state safety.
- **Slack transport:** HTTP Events API and Interactivity only. Do not use Socket Mode, WebSockets, slash commands, Slack user groups, or Slack OAuth.
- **Slack files:** The controller downloads Slack files with the bot token, uploads them to TrueFoundry Artifacts, and passes artifact read URLs to the executor. The executor downloads files into its workspace before Hermes starts. Images are passed as Hermes image inputs; other file types are referenced in the prompt by `local_path`. When `slack_inbound_artifact_repo` is configured, the generated stack includes a weekly artifact cleanup job that deletes only old Hermes Slack run artifacts. The cleanup job must use `HERMES-ARTIFACT-CLEANUP-TFY-API-KEY`, preferably a virtual-account token scoped to the inbound artifact ML repo, rather than the controller/executor `TFY-API-KEY`. Configure `slack_inbound_artifact_cleanup.failure_alert` only when the tenant already has a valid TrueFoundry notification-channel integration FQN; otherwise omit it so manifests continue to apply.
- **Secrets:** never ask the user to paste raw Slack tokens, signing secrets, TrueFoundry API keys, or the HERMES run-token secret into chat. `deploy` sets `HERMES-RUN-TOKEN-SECRET` (from `agents/<name>/.hermes-secrets.local`) and `TFY-API-KEY` automatically. For Slack, the user pastes bot token + signing secret into the SecretGroup UI after deploy — the only manual secret step.
- **Deployment gate:** `deploy` calls `ensureSecretGroup` (API) then runs live validation unless `--skip-live-checks` is passed. There is no separate `validate` command.

## Load References

- Read `references/deployment-example.md` when creating or reviewing agent config, compiled manifests in `deployments/`, Slack app setup, deploy (including auto-provisioned secrets), or failure handling.
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

Agent fields: `name`, `description`, `instructions`, `model`, `skills`, and `mcp_servers`. `model` defaults to `openai-main/gpt-5.5`; blank optional fields are omitted from yaml.

Deployment/operator fields such as `workspace_fqn`, `gateway_url`, `host`, and `secrets` can be set in yaml, but deploy can fill them from `TFY_WORKSPACE_FQN`, `OPENAI_BASE_URL` / the default TrueFoundry gateway, `TFY_HOST`, and `<name>-hermes-secrets`.

Then optional (Enter to skip each; omitted from the yaml when blank):

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

Or write `agents/<name>/<name>.yaml` by hand using **Input Rules** below and `references/deployment-example.md`.

If it already exists, collect any missing fields and edit `agents/<name>/<name>.yaml` in place. See **Input Rules** below and `references/deployment-example.md`.

### Step 2 — Slack app (skip if API-only)

Stop for manual Slack work before deploy:

1. Go to [https://api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From an app manifest** → paste `agents/<name>/slack-app-manifest.json` from `init`.
2. **Install App** to the workspace.
3. Copy bot token and signing secret (paste into SecretGroup after deploy in step 3):
   - **OAuth & Permissions** → Bot User OAuth Token → `SLACK-BOT-TOKEN`
   - **Basic Information** → Signing Secret → `SLACK-SIGNING-SECRET`

### Step 3 — Deploy

No separate SecretGroup step. `deploy` auto-creates the group via API and sets `HERMES-RUN-TOKEN-SECRET` (from `agents/<name>/.hermes-secrets.local`) and `TFY-API-KEY` (from `credentials.json` or env). For Slack, the manual secret work is pasting tokens from step 2 into `SLACK-BOT-TOKEN` and `SLACK-SIGNING-SECRET` after deploy runs. If Slack artifact cleanup is enabled, set `HERMES-ARTIFACT-CLEANUP-TFY-API-KEY` to a virtual-account token scoped to the inbound artifact ML repo.

Stop only if secret-store integration discovery fails (then create the SecretGroup manually in the UI).

Preview manifests offline (compile only — no API secret provisioning, no apply):

```bash
tfy-hermes-agent deploy <name> --skip-live-checks
```

Compiles to `agents/<name>/deployments/`:

| File | Resource |
|---|---|
| `<name>-volume.yaml` | Volume (10Gi RWO, /data on controller) |
| `<name>-runtime-volume.yaml` | Volume (10Gi RWO, /workspace/.hermes on runtime) |
| `<name>-runtime.yaml` | Service (private Hermes runtime) |
| `<name>-worker.yaml` | Job (manual worker image for async/maintenance surfaces) |
| `<name>-controller.yaml` | Service (Slack + `/v1/*`) |

Apply to TrueFoundry (`ensureSecretGroup` via API first, then live validation, then `tfy apply -f` from `deployments/`):

```bash
tfy-hermes-agent deploy <name>
# or: tfy-hermes-agent deploy agents/<name>/<name>.yaml
```

Reads `~/.truefoundry/credentials.json` from `tfy login` when `TFY_HOST` / `TFY_API_KEY` are unset.

Flags:

- `--update` — overwrite an existing deployment of the same name in the workspace
- `--emit-manifests <dir>` — write compiled yaml to a custom directory instead of `agents/<name>/deployments/`
- `--skip-live-checks` — compile only; does not apply or provision secrets

After a git-source image change, rebuild with:

```bash
tfy deploy --force -f agents/<name>/deployments/<name>-controller.yaml
tfy deploy --force -f agents/<name>/deployments/<name>-runtime.yaml
```

(not plain `tfy apply`).

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

- `ensureSecretGroup` runs inside `deploy` via API — creates the SecretGroup when missing, sets `HERMES-RUN-TOKEN-SECRET` and `TFY-API-KEY` automatically. Slack keys start as placeholders; user pastes real tokens after deploy if Slack is in scope. When Slack artifact cleanup is enabled, `HERMES-ARTIFACT-CLEANUP-TFY-API-KEY` must also exist and should be scoped to the inbound artifact ML repo.

## Input Rules

| Field | Required | Notes |
|---|---|---|
| `name` | yes | Lowercase Slack-safe handle, 2–32 chars, e.g. `devrel-assistant`. Becomes the `agents/<name>/` folder name. |
| `workspace_fqn` | no | `cluster:workspace`, e.g. `tfy-ea-dev-eo-az:sai-ws`. Defaults to `TFY_WORKSPACE_FQN` at deploy time. |
| `gateway_url` | no | OpenAI-compatible gateway URL for Hermes model calls. Defaults to `OPENAI_BASE_URL`, then `https://gateway.truefoundry.ai`. |
| `model` | no | Gateway model id, e.g. `openai-main/gpt-5.5`. Defaults to `openai-main/gpt-5.5`. |
| `secrets` | no | SecretGroup name. Defaults to `<name>-hermes-secrets`; `deploy` creates and populates `TFY-API-KEY` + `HERMES-RUN-TOKEN-SECRET` via API. |
| `version` | no | Git ref for controller/runtime/worker image build. Default `main`. Slashed branches fail on TF's git puller — use commit SHA. |
| `host` | no | Public controller URL; inferred from `TFY_HOST` + `name` + workspace if omitted. |
| `description` | no | Short agent description. |
| `instructions` | no | System prompt appended each executor turn. |
| `slack.allowed_channels` | no | Channel/group/DM IDs. Omitted = all channels bot is in. |
| `slack.allowed_users` | no | User IDs. Omitted = all users. |
| `slack_team_id` | no | Slack team id if pinning a workspace. |
| `agent_email` | no | AgentMail email address for this assistant. |
| `discord` | no | Discord bridge config; allowlists use numeric Discord IDs. |
| `skills` | no | Version-pinned FQNs, e.g. `agent-skill:tfy-eo/sai-mlrepo/humanizer:1`. |
| `mcp_servers` | no | TrueFoundry MCP Gateway URLs only. |
| `executor` | no | Unsupported. Do not set; deployments always use controller + runtime + worker. |
| `terminal` | no | Unsupported. Do not set; runtime behavior is managed by the runtime image. |

If the user gives names instead of FQNs, URLs, or Slack IDs, pause and ask for exact values or offer to look them up when tooling is available. Prefer `tfy-hermes-agent init` when starting from scratch — it prompts every optional field.

## Auth Model

| Surface | Credential | SecretGroup key |
|---|---|---|
| `/v1/*` | Bearer | `TFY-API-KEY` |
| `/api/internal/*` | Per-run HMAC | minted from `HERMES-RUN-TOKEN-SECRET` |
| `/slack/*` webhooks | Slack signature | `SLACK-SIGNING-SECRET` |
| Slack outbound | Bot token | `SLACK-BOT-TOKEN` |
| `/agentmail/*` webhooks | Svix signature | `AGENTMAIL-WEBHOOK-SECRET` |
| AgentMail replies | Bearer | `AGENTMAIL-API-KEY` |
| `/discord/*` interactions | Ed25519 public key | `DISCORD-PUBLIC-KEY` |
| Discord bot operations | Bot token | `DISCORD-BOT-TOKEN` |
| LLM gateway (runtime/worker) | Bearer | `TFY-API-KEY` |
| STT/TTS gateway (runtime/worker) | Bearer | `HERMES-STT-API-KEY` / `HERMES-TTS-API-KEY`, fallback to `TFY-API-KEY` |

## Manual Stops

Only stop for external work:

- Installing/authenticating `tfy` (`tfy login`) or `tfy-hermes-agent`
- Production Virtual Account PAT setup (`tfy login --api-key …`) when the user's personal token lacks `application:read` + `application:trigger`
- Manual SecretGroup creation only when `deploy` cannot discover a secret-store integration
- Slack app at https://api.slack.com/apps (skip if API-only) — before deploy; manifest at `agents/<name>/slack-app-manifest.json`
- Slack token entry in SecretGroup UI after deploy (never in chat; only manual secret step)
- AgentMail API key + webhook signing secret in SecretGroup when `agent_email` is set
- Discord bot token + public key in SecretGroup and Discord Interactions URL setup when `discord.enabled` is true
- Slack URL verification in Slack settings (skip if API-only)
- First real Slack message result (skip if API-only)

When stopping, give exactly one concrete task and the file/path/name the user needs (e.g. `agents/my-bot/slack-app-manifest.json`, not a generic filename).

## Completion Criteria

The flow is complete only when:

- Both CLIs installed; TrueFoundry credentials available via `tfy login` or env vars
- `agents/<name>/<name>.yaml` exists and `deploy` succeeds (API secrets + live validation + `tfy apply -f` on generated deployment manifests)
- `TFY-API-KEY` and `HERMES-RUN-TOKEN-SECRET` set by `deploy` (no manual step)
- Slack tokens pasted into SecretGroup after deploy (if Slack is in scope)
- `HERMES-ARTIFACT-CLEANUP-TFY-API-KEY` set to a scoped virtual-account token when Slack artifact cleanup is enabled
- `/api/health` and `/v1/models` respond
- `/slack/health` responds with configured tokens (if Slack is in scope)
- `/agentmail/health` responds with configured secrets when `agent_email` is set
- `/discord/health` responds with configured secrets when `discord.enabled` is true
- Backend session smoke tests pass (see `references/session-smoke-test.md`)
- Slack Events and Interactivity URLs verified in Slack settings (if Slack is in scope)
- A real Slack mention receives a final Hermes response (if Slack is in scope)
