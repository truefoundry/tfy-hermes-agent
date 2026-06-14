# tfy-hermes-agent

Reusable TrueFoundry deployment package for Hermes Agent.

This repo keeps the deployment wrapper small: an OpenAI-compatible Hermes API,
a per-turn job runner, Dockerfiles, and TrueFoundry YAML templates. It does not
vendor the full upstream Hermes codebase. The runtime image installs
`hermes-agent` at build time.

## Why This Exists

Projects should not need to copy a large agent repo just to host Hermes on
TrueFoundry. They should be able to keep a small `hermes.yaml` in their own repo
or render the templates here with different workspace, host, model, and secret
settings.

## Included

- `control-api/` - OpenAI-compatible `/v1/responses` and
  `/v1/chat/completions` API plus internal control routes for agents, sessions,
  runs, MCP visibility, and run completion callbacks.
- `runner/` - TrueFoundry Job entrypoint that executes one `hermes -z` turn.
- `manifests/` - reusable TrueFoundry YAML templates.
- `skills/deploy-hermes-slack-agent/` - repo-local operator skill for guiding a
  user through manifest generation, Slack app setup, secrets, deploy, health,
  and first-message verification.
- `examples/agent.hermes.yaml` - intended high-level standalone agent config
  that a project-local compiler can expand into TrueFoundry and Slack manifests.
- `examples/hermes.yaml` - compact project-local example for deploying the
  OpenAI-compatible Hermes API from this repo.

## Policy

- Skills must be loaded from the configured Skills Registry only.
- Secrets must be referenced as `tfy-secret://...`; raw secret values are
  rejected by the control API on `POST/PATCH /api/agents`, `POST /api/sessions`,
  and `POST /api/sessions/:id/messages`.
- All deployment-time secrets live in the per-agent TrueFoundry SecretGroup and
  are referenced from manifests via `tfy-secret://...` only.
- The control API's `/v1/*` endpoints require `Authorization: Bearer
  $HERMES_OPENAI_API_KEY` when that env is set.
- The control API's `/api/internal/*` callbacks require `Authorization: Bearer
  $HARNESS_INTERNAL_TOKEN`; the turn-runner reads the same token from its env.
- MCP servers must be visible through TrueFoundry MCP Gateway with the configured
  token before they can be attached by name.

## Render Manifests

```bash
export TFY_WORKSPACE_FQN=tfy-ea-dev-eo-az:sai-ws
export TFY_SECRET_TENANT=tfy-eo
export TFY_BASE_URL=https://tfy-eo.truefoundry.cloud
export HERMES_AGENT_SECRET_GROUP=devrel-assistant-hermes-secrets
export HERMES_API_HOST=hermes-api-sai-ws.ml.tfy-eo.truefoundry.cloud
export HERMES_REPO_URL=https://github.com/truefoundry/tfy-hermes-agent
export HERMES_SOURCE_REF=main

./scripts/render-manifests.sh
```

Deploy the rendered files with `tfy apply -f .rendered/<file>.yaml`.

For project-local standalone agents, use the compiler:

```bash
npx @truefoundry/tfy-hermes-agent validate hermes.yaml
npx @truefoundry/tfy-hermes-agent compile hermes.yaml
npx @truefoundry/tfy-hermes-agent slack-manifest hermes.yaml > slack-app-manifest.json
npx @truefoundry/tfy-hermes-agent deploy hermes.yaml
```

## OpenAI SDK Compatibility

Point the OpenAI SDK at the exposed Hermes API host:

```js
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.HERMES_API_KEY || "unused",
  baseURL: "https://hermes-api-sai-ws.ml.tfy-eo.truefoundry.cloud/v1"
});

const response = await client.responses.create({
  model: "openai-main/gpt-5.5",
  input: "Summarize this repo."
});

console.log(response.output_text);
```

Supported endpoints:

- `GET /v1/models`
- `POST /v1/responses`
- `GET /v1/responses/:id`
- `POST /v1/chat/completions`
- `GET /v1/chat/completions/:id`

The adapter supports text-only synchronous, background, and streaming calls.
`stream: true` returns Server-Sent Events for both `POST /v1/responses` and
`POST /v1/chat/completions`. Streaming uses Hermes stdout deltas when the runner
emits them; if the provider buffers output until the end, the adapter emits the
final result as a single text delta before the completed event. Use
`background: true` with `POST /v1/responses` to create an async run and poll
`GET /v1/responses/:id`.

Synchronous SDK calls wait up to `HERMES_OPENAI_SYNC_TIMEOUT_MS` milliseconds
for the TrueFoundry job to complete. The default is `120000`.

The `/api/...` routes remain available for operational workflows and for the
turn runner callback, but new clients should use `/v1/responses` or
`/v1/chat/completions` by default.

## Standalone Slack Agent UX

This package also includes optional Slack Events API endpoints for a native
Slack agent experience:

- `/slack/events` - handles Slack Events API callbacks.
- `/slack/interactions` - stores response feedback button clicks.
- `/slack/commands` - optional operational command endpoint.
- `/slack/health` - reports whether Slack secrets are configured.

The default architecture is one Slack app per Hermes agent. Each standalone
agent deployment gets its own TrueFoundry API service, turn-runner job, volume,
and Slack app. The Slack bot's display name is the mention handle users talk to
in Slack.

When configured, Hermes responds to that app's bot mentions and assistant DM
messages in Slack threads. The adapter sets the thread title, shows a Slack
assistant loading status, starts a streamed reply with a task card, appends the
Hermes response, and finishes with feedback controls.

Example:

```text
@devrel-assistant summarize this launch thread
```

Runtime identity is configured by environment variables on the `hermes-api`
service:

```yaml
HERMES_AGENT_HANDLE: devrel-assistant
HERMES_AGENT_NAME: DevRel Assistant
HERMES_AGENT_DESCRIPTION: Helps with DevRel launches, follow-ups, events, and dashboard analysis.
HERMES_AGENT_INSTRUCTIONS: |
  You are the DevRel assistant. Be concise, operational, and evidence-driven.
HERMES_AGENT_SKILLS: event-follow-up,daily-devrel-scrum
HERMES_AGENT_MCP_SERVERS: posthog,linear,slack
HERMES_AGENT_SECRET_REFS: ""
```

Slack setup:

1. Create a Slack app from `examples/slack-app-manifest.yaml`.
2. Replace `YOUR-HERMES-API-HOST` with the exposed Hermes API host.
3. Replace the app name and bot display name with the agent name/handle.
4. Install the app into the workspace and copy the bot token and signing secret.
5. Enable the app's Agents & AI Apps experience in Slack app settings.
6. Store the Slack bot token, signing secret, and gateway credentials in the
   agent-specific SecretGroup.
7. Add these environment variables to the `hermes-api` service:

```yaml
TFY_GATEWAY_BASE_URL: tfy-secret://YOUR_TENANT:YOUR_AGENT_SECRET_GROUP:TFY-GATEWAY-BASE-URL
TFY_GATEWAY_API_KEY: tfy-secret://YOUR_TENANT:YOUR_AGENT_SECRET_GROUP:TFY-GATEWAY-API-KEY
SLACK_BOT_TOKEN: tfy-secret://YOUR_TENANT:YOUR_AGENT_SECRET_GROUP:SLACK-BOT-TOKEN
SLACK_SIGNING_SECRET: tfy-secret://YOUR_TENANT:YOUR_AGENT_SECRET_GROUP:SLACK-SIGNING-SECRET
SLACK_REDIRECT_URI: https://YOUR-HERMES-API-HOST/slack/oauth/callback
```

`SLACK_CLIENT_ID` and `SLACK_CLIENT_SECRET` are only needed when enabling Slack
OAuth for multi-workspace installs. A single-workspace standalone app only needs
the bot token and signing secret.

The default Slack manifest does not include a slash command because slash command
names are workspace-global and would conflict across one-app-per-agent
deployments.

Optional tuning:

```yaml
HERMES_SLACK_RUN_TIMEOUT_MS: "120000"
HERMES_SLACK_STATUS_TEXT: "is thinking..."
HERMES_SLACK_LOADING_MESSAGES: "Reading the thread|Planning the next step|Running Hermes|Preparing the reply"
HERMES_SLACK_STREAM_CHUNK_DELAY_MS: "120"
HERMES_SLACK_CREATE_USERGROUPS: "false"
HERMES_SLACK_REQUIRE_CHANNEL_DEPLOYMENT: "false"
```

`HERMES_SLACK_CREATE_USERGROUPS=false` is the standalone default. Set it to
`true` only for the older shared-app/multiple-user-groups mode. With
`HERMES_SLACK_REQUIRE_CHANNEL_DEPLOYMENT=true`, channel mentions are rejected
until the agent has been deployed there; DMs are still allowed. Standalone apps
usually leave this off and rely on Slack channel membership.

Local smoke-test knobs:

```bash
HERMES_SLACK_DRY_RUN=1
HERMES_LOCAL_RUN_RESULT="Dry-run Hermes response"
```

`HERMES_SLACK_DRY_RUN=1` records Slack API calls in persisted state instead of
calling Slack. `HERMES_LOCAL_RUN_RESULT` completes runs locally without
triggering a TrueFoundry job.

Streaming behavior: the turn runner forwards Hermes stdout deltas back to the
control API while the job is running, and the Slack adapter appends those deltas
to the active Slack stream. If the Hermes CLI or model provider buffers output
until the end, Slack still shows status/task progress immediately and then
appends the final text in chunks.

## Project-Local YAML

The target project-local input is `examples/agent.hermes.yaml`: one flat file
that describes the agent identity, instructions, skill FQNs, MCP Gateway URLs,
workspace, host, and per-agent SecretGroup. The compiler expands that into:

- a per-agent SecretGroup
- a TrueFoundry volume
- a `hermes-api` service
- a `hermes-turn-runner` job
- a per-agent Slack app manifest

Example:

```yaml
name: devrel-assistant

workspace_fqn: tfy-ea-dev-eo-az:sai-ws
host: https://devrel-assistant-sai-ws.ml.tfy-eo.truefoundry.cloud

description: Helps with DevRel launches, event follow-ups, and dashboard analysis.

instructions: |
  You are the DevRel assistant. Be concise, operational, and evidence-driven.
  Prefer concrete next steps, cite available context, and call out missing inputs.

model: openai-main/gpt-5.5

secrets: devrel-assistant-hermes-secrets

skills:
  - agent-skill:tfy-eo/sai-mlrepo/humanizer:1
  - agent-skill:tfy-eo/sai-mlrepo/event-follow-up:3

mcp_servers:
  - https://mcp-gateway.example.com/servers/posthog
  - https://mcp-gateway.example.com/servers/linear
  - https://mcp-gateway.example.com/servers/slack
```

The per-agent SecretGroup isolates each deployment. Both `hermes-api` and
`hermes-turn-runner` reference the same group, so deleting or rotating one
agent's secrets does not touch any other agent:

```yaml
name: devrel-assistant-hermes-secrets
type: secret-group
workspace_fqn: tfy-ea-dev-eo-az:sai-ws
secrets:
  TFY-GATEWAY-BASE-URL: "https://your-openai-compatible-gateway/v1"
  TFY-GATEWAY-API-KEY: "replace-in-truefoundry-only"
  TFY-PLATFORM-API-KEY: "replace-in-truefoundry-only"
  HARNESS-INTERNAL-TOKEN: "openssl rand -hex 32 -> paste here"
  HERMES-OPENAI-API-KEY: "openssl rand -hex 32 -> paste here"
  SLACK-BOT-TOKEN: "xoxb-replace-in-truefoundry-only"
  SLACK-SIGNING-SECRET: "replace-in-truefoundry-only"
```

`TFY-PLATFORM-API-KEY` is a TrueFoundry personal API token with permission to
trigger jobs and list deployments in the target workspace. The control API uses
it for `/api/svc/v1/*` calls (job dispatch, MCP gateway visibility). Keep it
distinct from `TFY-GATEWAY-API-KEY`, which is the inference gateway key the
turn-runner uses to talk to the OpenAI-compatible model endpoint.

`HARNESS-INTERNAL-TOKEN` authenticates the turn-runner to the control API's
`/api/internal/*` callbacks. `HERMES-OPENAI-API-KEY` is the Bearer token clients
must present on `/v1/*` requests; unset it only when the service is fronted by
an authenticated gateway.

For direct low-level template usage, projects can copy `examples/hermes.yaml`
and swap:

- `workspace_fqn`
- exposed host
- `HERMES_AGENT_HANDLE`, `HERMES_AGENT_NAME`, and instructions
- `repo_url` and `ref` if using a fork or pinned commit
- per-agent SecretGroup tenant/name/key references

Compiler validation:

- derives the SecretGroup tenant from `host`, with `TFY_SECRET_TENANT` as a
  fallback for non-TrueFoundry domains
- validates skill entries as `agent-skill:<tenant>/<repo>/<name>:<version>` FQNs
- validates MCP entries as URLs
- with TrueFoundry credentials, checks deployment name collisions, required
  SecretGroup keys, and MCP Gateway visibility
- refuses to deploy over existing API/job names unless `--update` is passed
