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

Or set env vars (used by both `tfy` and `tfy-hermes-agent deploy`):

```bash
export TFY_HOST=https://<your-tenant>.truefoundry.cloud
export TFY_API_KEY=<your-pat>
```

Verify:

```bash
tfy version
tfy-hermes-agent help   # if installed globally; else: npx tfy-hermes-agent help
```

---

## Add this to any codebase

From your project directory (where you want `hermes.yaml` to live):

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

**Hermes deploy CLI** (generates manifests and calls `tfy apply`):

```bash
npm install github:truefoundry/tfy-hermes-agent
# or: npm install -g github:truefoundry/tfy-hermes-agent
```

If tfy-hermes-agent is installed locally, use `npx tfy-hermes-agent` or:

```bash
node node_modules/@truefoundry/tfy-hermes-agent/bin/tfy-hermes-agent.mjs
```

### 2. Get a TrueFoundry API key

In your tenant's TrueFoundry UI:

1. Open **Settings → Access Tokens** (or create a **Virtual Account** for the agent).
2. Create a PAT scoped to the target workspace with at least:
   - `application:read` — controller looks up the executor deployment
   - `application:trigger` — controller dispatches executor jobs
3. Copy the token. This becomes `TFY-API-KEY` in the SecretGroup (step 4) and is also used as `TFY_API_KEY` in your shell for `deploy`.

A write-only PAT will silently break job dispatch.

### 3. Write `hermes.yaml`

Either run the wizard:

```bash
tfy-hermes-agent init
```

This writes `hermes.yaml` and `slack-app-manifest.json` in the current directory.

Or copy `examples/agent.hermes.yaml` and edit it. See [hermes.yaml fields](#hermesyaml-fields) below.

### 4. Create the SecretGroup (manual, before deploy)

`deploy` does **not** create the SecretGroup. Create it in the TrueFoundry UI under the workspace from `workspace_fqn`, using the name from `secrets:` in `hermes.yaml` (default `<name>-hermes-secrets`).

Fill these four keys. **Hyphens only** — TrueFoundry rejects underscores in secret key names.

| Key | What to put there |
|---|---|
| `TFY-API-KEY` | The PAT from step 2. Used for control-plane calls, LLM gateway auth, and inbound `/v1/*` bearer. |
| `HERMES-RUN-TOKEN-SECRET` | 32+ random characters you generate (`openssl rand -hex 32`). Master secret for per-run HMAC tokens between controller and executor (`/api/internal/*` callbacks). Not a Slack token. |
| `SLACK-BOT-TOKEN` | `xoxb-…` from your Slack app (step 5). Use a placeholder if Slack is not wired yet. |
| `SLACK-SIGNING-SECRET` | Signing secret from your Slack app (step 5). Use a placeholder if Slack is not wired yet. |

Never commit these values. They live only in the SecretGroup.

### 5. Slack app (skip if API-only)

Only needed if you want Slack. Socket Mode is not supported.

1. `init` already wrote `slack-app-manifest.json`. If you wrote `hermes.yaml` by hand, run `init` once or copy the manifest from a prior run.
2. In [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From an app manifest** → paste `slack-app-manifest.json`.
3. **Install App** to your workspace.
4. Copy from the Slack app settings:
   - **OAuth & Permissions** → **Bot User OAuth Token** → `SLACK-BOT-TOKEN`
   - **Basic Information** → **App Credentials** → **Signing Secret** → `SLACK-SIGNING-SECRET`
5. Paste both into the SecretGroup from step 4.
6. Deploy first (step 6), then confirm Slack **Event Subscriptions** and **Interactivity** URLs match your controller host:
   - `https://<host>/slack/events`
   - `https://<host>/slack/interactions`

Invite the bot to channels where it should respond.

### 6. Generate and apply TrueFoundry manifests

Preview manifests without applying:

```bash
tfy-hermes-agent deploy hermes.yaml --skip-live-checks --emit-manifests ./manifests
```

This writes:

| File | Resource | What it is |
|---|---|---|
| `<name>-volume.yaml` | Volume | 10Gi RWO PVC at `/data` on the controller (session state) |
| `<name>-controller.yaml` | Service | Long-running HTTP service (Slack + `/v1/*`) |
| `<name>-executor.yaml` | Job | Per-turn Hermes runner (triggered manually by the controller) |

With `--update`, a fourth file is also emitted:

| File | Resource | What it is |
|---|---|---|
| `<name>-secrets.scaffold.yaml` | SecretGroup | Metadata scaffold only — values still come from the UI |

Apply to TrueFoundry (runs live validation first, then `tfy apply` on each manifest in order: volume → controller → executor):

```bash
tfy-hermes-agent deploy hermes.yaml
```

Flags:

- `--update` — overwrite an existing deployment of the same name; also applies the secrets scaffold.
- `--emit-manifests <dir>` — write YAML files to disk in addition to applying.
- `--skip-live-checks` — preview offline only; does not apply.

After a git-source image change, rebuild with `tfy deploy --force -f <manifest>` (not plain `tfy apply`).

### 7. Verify

```bash
curl -fsS https://<host>/api/health
curl -fsS https://<host>/slack/health
curl -fsS -H "Authorization: Bearer <TFY-API-KEY>" https://<host>/v1/models
```

Send a Slack mention or call `/v1/chat/completions` to confirm end-to-end.

---

## `hermes.yaml` fields

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
| `secrets` | yes | Name of an existing SecretGroup with the four keys above. |
| `version` | no | Git ref to build controller/executor images from (`main`, tag, or commit SHA). Default `main`. Slashed branch names fail on TF's git puller — use a commit SHA instead. |
| `host` | no | Public controller URL. Derived from `TFY_HOST` + `name` + workspace if omitted. |
| `description` | no | Short agent description (Slack assistant view). |
| `instructions` | no | System prompt appended on each executor turn. |
| `slack.allowed_channels` | no | Slack channel/group/DM IDs. Empty or omitted = all channels the bot is in. |
| `slack.allowed_users` | no | Slack user IDs. Empty or omitted = all users. |
| `slack_team_id` | no | Slack team id if you need to pin a workspace. |
| `skills` | no | Version-pinned agent-skill FQNs, e.g. `agent-skill:tenant/repo/skill:1`. |
| `mcp_servers` | no | TrueFoundry MCP Gateway URLs. |

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
