# tfy-hermes-agent

Deploy [Hermes Agent](https://github.com/NousResearch/hermes-agent) on TrueFoundry. Talk to it from Slack or an OpenAI-compatible `/v1/*` API.

Distributed from GitHub only — not on the npm registry.

---

## Prerequisites

You need two CLIs and tenant credentials:

| Tool | Install | Used for |
|---|---|---|
| **tfy-hermes-agent** | `npm install github:truefoundry/tfy-hermes-agent` | `init`, manifest generation, `deploy` orchestration |
| **tfy** (TrueFoundry CLI) | `pip install -U "truefoundry"` | `tfy apply` / `tfy deploy` to push manifests to your tenant |

Also requires **Node 22+** (for tfy-hermes-agent) and **Python 3.9+** (for the tfy CLI).

Authenticate the tfy CLI against your tenant:

```bash
pip install -U "truefoundry"
tfy login --host https://<your-tenant>.truefoundry.cloud
```

Or set env vars explicitly (overrides `credentials.json`):

```bash
export TFY_HOST=https://<your-tenant>.truefoundry.cloud
export TFY_API_KEY=<your-pat>
```

If `~/.truefoundry/credentials.json` is missing or empty, `deploy` stops and asks you to run `tfy login` first.

Verify:

```bash
tfy version
tfy-hermes-agent help   # if installed globally; else: npx tfy-hermes-agent help
```

---

## Add this to any codebase

From your project directory (where you want the `agents/` folder):

```bash
pip install -U "truefoundry"
npm install github:truefoundry/tfy-hermes-agent
```

Or install tfy-hermes-agent globally:

```bash
npm install -g github:truefoundry/tfy-hermes-agent
```

---

## End-to-end steps (in order)

### 1. Install both CLIs

**TrueFoundry CLI** (applies manifests to your tenant):

```bash
pip install -U "truefoundry"
tfy login --host https://<your-tenant>.truefoundry.cloud
```

`deploy` reads `~/.truefoundry/credentials.json` from `tfy login` automatically. Env vars `TFY_HOST` / `TFY_API_KEY` override the file.

For production agents, prefer a **Virtual Account PAT** with `application:read` + `application:trigger` (a write-only PAT silently breaks job dispatch):

```bash
tfy login --host https://<your-tenant>.truefoundry.cloud --api-key <virtual-account-pat>
```

**Hermes deploy CLI** (generates manifests and calls `tfy apply`):

```bash
npm install github:truefoundry/tfy-hermes-agent
# or: npm install -g github:truefoundry/tfy-hermes-agent
```

If tfy-hermes-agent is installed locally, use `npx tfy-hermes-agent` or:

```bash
node node_modules/@truefoundry/tfy-hermes-agent/bin/tfy-hermes-agent.mjs
```

### 2. Create an agent config

Either run the wizard:

```bash
tfy-hermes-agent init
# API-only (no Slack): tfy-hermes-agent init --api-only
```

This creates `agents/<name>/` with:

```
agents/<name>/
├── <name>.yaml                 # source config — edit this
├── slack-app-manifest.json     # Slack setup (skipped with --api-only)
├── .hermes-secrets.local       # gitignored HERMES-RUN-TOKEN-SECRET seed
└── deployments/                # compiled TF manifests (written by deploy)
```

The wizard asks required fields first, then executor backend (`truefoundry-job` default or `truefoundry-service` + Daytona), then optional ones (press Enter to skip). Optional: `version`, `host`, `instructions`, `skills`, `mcp_servers`, `slack_team_id`, `slack.allowed_channels`, `slack.allowed_users` (Slack allowlists skipped with `--api-only`). Blank values are omitted from the yaml. Job mode omits `executor` from the yaml; service mode writes `executor` and `terminal`. The `secrets` field is only a name — `deploy` creates the SecretGroup via API.

Or write the yaml by hand using the [agent config fields](#agent-config-fields) below.

### 3. Slack app (skip if API-only)

Only needed if you want Slack. Socket Mode is not supported.

1. `init` already wrote `agents/<name>/slack-app-manifest.json`. If you wrote the config by hand, run `init` once or copy the manifest from a prior run.
2. Go to [https://api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From an app manifest** → paste `agents/<name>/slack-app-manifest.json`.
3. **Install App** to your workspace.
4. Copy from the Slack app settings (paste into the SecretGroup after deploy in step 4):
   - **OAuth & Permissions** → **Bot User OAuth Token** → `SLACK-BOT-TOKEN`
   - **Basic Information** → **App Credentials** → **Signing Secret** → `SLACK-SIGNING-SECRET`

### 4. Deploy

`deploy` is the only command that touches TrueFoundry. It auto-provisions secrets you do **not** need to set manually:

- Creates the SecretGroup named in the agent yaml `secrets` field (if missing)
- Sets `HERMES-RUN-TOKEN-SECRET` from `agents/<name>/.hermes-secrets.local` (or generates one)
- Sets `TFY-API-KEY` from `~/.truefoundry/credentials.json` or shell `TFY_API_KEY`

For Slack, paste `SLACK-BOT-TOKEN` and `SLACK-SIGNING-SECRET` into that SecretGroup after deploy (tokens from step 3). `deploy` seeds placeholders until you do.

For `executor: truefoundry-service`, also set `DAYTONA-API-KEY` in the SecretGroup before tool-using turns.

Manual SecretGroup creation is only needed if `deploy` cannot discover a secret-store integration in your tenant.

Preview manifests without applying:

```bash
tfy-hermes-agent deploy <name> --skip-live-checks
```

This compiles into `agents/<name>/deployments/`:

| File | Resource | What it is |
|---|---|---|
| `<name>-volume.yaml` | Volume | 10Gi RWO PVC at `/data` on the controller (session state) |
| `<name>-controller.yaml` | Service | Long-running HTTP service (Slack + `/v1/*`) |
| `<name>-executor.yaml` | Job or Service | Hermes runner (`truefoundry-job` default, or internal Service for `truefoundry-service`) |

SecretGroup is **not** a deployments file — `deploy` provisions it via API before apply.

Apply to TrueFoundry (reads `~/.truefoundry/credentials.json` from `tfy login` if env vars are unset; otherwise asks you to log in):

```bash
tfy-hermes-agent deploy <name>
# or: tfy-hermes-agent deploy agents/<name>/<name>.yaml
```

`deploy` compiles to `agents/<name>/deployments/`, then runs `tfy apply -f` on each file in order (volume → controller → executor, plus artifact cleanup when Slack artifact storage is enabled).

Flags:

- `--update` — overwrite an existing deployment of the same name.
- `--emit-manifests <dir>` — write compiled yaml to a custom directory instead of `deployments/`.
- `--skip-live-checks` — compile only; does not apply or provision secrets.

After a git-source image change, rebuild with `tfy deploy --force -f agents/<name>/deployments/<name>-controller.yaml` (and executor) — not plain `tfy apply`.

For Slack deployments, after deploy confirm **Event Subscriptions** and **Interactivity** URLs match your controller host:

- `https://<host>/slack/events`
- `https://<host>/slack/interactions`

Invite the bot to channels where it should respond.

### Slack file attachments

Slack file messages are accepted through the HTTP Events API. The controller downloads Slack files with the bot token, uploads them to a TrueFoundry Artifact version, and sends artifact read URLs to the executor. The executor downloads those artifacts into its workspace before Hermes starts.

Image attachments are passed to Hermes as image inputs using their local workspace paths. Other file types are made available in the executor workspace and referenced in the prompt with `local_path`.

When `slack_inbound_artifact_repo` is set, deploy also emits a weekly `<name>-cleanup` TrueFoundry job. By default it deletes only Hermes Slack run artifacts older than 7 days (`slack-run_…` names with Slack run metadata), leaving unrelated artifacts in the repo untouched.

### 5. Verify

```bash
curl -fsS https://<host>/api/health
curl -fsS https://<host>/slack/health
curl -fsS -H "Authorization: Bearer <TFY-API-KEY>" https://<host>/v1/models
```

Send a Slack mention or call `/v1/chat/completions` to confirm end-to-end.

---

## Agent config fields

```yaml
# Required
name: devrel-assistant
workspace_fqn: tfy-ea-dev-eo-az:sai-ws
gateway_url: https://your-gateway/v1
model: openai-main/gpt-5.5
secrets: devrel-assistant-hermes-secrets

# Optional
version: main
host: https://devrel-assistant-sai-ws.ml.tfy-eo.truefoundry.cloud
description: Helps with DevRel launches.
instructions: |
  Be concise and evidence-driven.
slack:
  allowed_channels: [C0123456789]
  allowed_users: [U0123456789]
slack_team_id: T0123456789
slack_inbound_artifact_repo: hermes-inbound-artifacts-prod
slack_inbound_artifact_cleanup:
  enabled: true
  retention_days: 7
  schedule: "0 2 * * 0"
skills:
  - agent-skill:tfy-eo/sai-mlrepo/humanizer:1
mcp_servers:
  - https://mcp-gateway.example.com/servers/linear
```

| Field | Required | Notes |
|---|---|---|
| `name` | yes | Lowercase handle, 2–32 chars, letters/numbers/hyphens. Becomes Slack bot name and TF resource prefix. |
| `workspace_fqn` | yes | `cluster:workspace`, e.g. `tfy-ea-dev-eo-az:sai-ws`. |
| `gateway_url` | yes | OpenAI-compatible LLM gateway URL (TrueFoundry AI Gateway `/v1` endpoint). |
| `model` | yes | Model id your gateway accepts, e.g. `openai-main/gpt-5.5`. |
| `secrets` | yes | SecretGroup name (default `<name>-hermes-secrets`); `deploy` creates and populates `TFY-API-KEY` + `HERMES-RUN-TOKEN-SECRET`. |
| `version` | no | Git ref to build controller/executor images from (`main`, tag, or commit SHA). Default `main`. Slashed branch names fail on TF's git puller — use a commit SHA instead. `init` prompts; omitted from yaml if left as default. |
| `host` | no | Public controller URL. Derived from `TFY_HOST` + `name` + workspace if omitted. `init` prompts. |
| `description` | no | Short agent description (Slack assistant view). `init` prompts (can be blank). |
| `instructions` | no | System prompt appended on each executor turn. `init` prompts (multiline). |
| `slack.allowed_channels` | no | Slack channel/group/DM IDs. Empty or omitted = all channels the bot is in. `init` prompts. |
| `slack.allowed_users` | no | Slack user IDs. Empty or omitted = all users. `init` prompts. |
| `slack_team_id` | no | Slack team id if you need to pin a workspace. `init` prompts. |
| `slack_inbound_artifact_repo` | no | ML repo name or `tfy-mlrepo://` FQN for Slack file uploads. Required if users will send Slack attachments. |
| `slack_inbound_artifact_cleanup` | no | Cleanup policy for Slack artifact versions. Defaults to enabled when `slack_inbound_artifact_repo` is set, with 7-day retention and weekly cron `0 2 * * 0`. |
| `skills` | no | Version-pinned agent-skill FQNs, e.g. `agent-skill:tenant/repo/skill:1`. `init` prompts. |
| `mcp_servers` | no | TrueFoundry MCP Gateway URLs. `init` prompts. |
| `executor` | no | `truefoundry-job` (default) or `truefoundry-service`. `init` prompts; job default omitted from yaml. |
| `terminal` | no | Only for `truefoundry-service`. Defaults to `daytona`. `init` writes when service is chosen. |

---

## Quickstart with a coding agent

```bash
npx skills add truefoundry/tfy-hermes-agent -y
```

Then say **"create a Hermes Slack agent"**.

---

## Auth model (what each credential does)

| Surface | Credential | Source |
|---|---|---|
| `/v1/*` (API clients) | `Authorization: Bearer <TFY-API-KEY>` | SecretGroup `TFY-API-KEY` |
| `/api/internal/*` (executor callbacks) | Per-run HMAC bearer | Minted from SecretGroup `HERMES-RUN-TOKEN-SECRET` |
| `/slack/*` (webhooks) | `X-Slack-Signature` HMAC | Verified with SecretGroup `SLACK-SIGNING-SECRET` |
| Slack outbound messages | Bot token | SecretGroup `SLACK-BOT-TOKEN` |
| LLM calls (executor) | Gateway bearer | SecretGroup `TFY-API-KEY` via `OPENAI_API_KEY` |
| Daytona tool sandbox | API key | SecretGroup `DAYTONA-API-KEY` (only when `executor: truefoundry-service`) |
