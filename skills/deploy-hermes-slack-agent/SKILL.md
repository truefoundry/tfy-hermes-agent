---
name: deploy-hermes-slack-agent
description: Guide a user through creating, validating, deploying, and testing a standalone TrueFoundry Hermes Slack agent from hermes.yaml. Use when the user wants help generating the Hermes manifest, creating the Slack app, setting TrueFoundry secrets, deploying with npx, checking app health, and sending the first working Slack message.
---

# Deploy Hermes Slack Agent

Use this skill to hand-hold a user from a project-local `hermes.yaml` to a working standalone Slack agent. The target architecture is one Slack app, one TrueFoundry API service, one runner job, one state volume, and one isolated SecretGroup per agent.

## Ground Rules

- Never ask the user to paste raw Slack tokens, signing secrets, or TrueFoundry API keys into chat.
- Tell the user to put secret values directly into the named TrueFoundry SecretGroup or set them as local environment variables before running commands.
- Do not use Socket Mode. This flow uses Slack Events API and Interactivity request URLs.
- Do not create Slack user groups. This flow is one Slack app per agent.
- Treat `hermes.yaml` as the source of truth and generated manifests as derived output.
- Do not deploy until validation passes or the user explicitly accepts a known limitation.

## Required Inputs

Collect or infer these before deployment:

- `name`: lowercase Slack-safe agent handle, for example `devrel-assistant`
- `workspace_fqn`: target TrueFoundry workspace, for example `tfy-ea-dev-eo-az:sai-ws`
- `host`: full public hostname or URL for the agent API
- `description`: one short sentence
- `instructions`: the agent's behavior instructions
- `model`: default `openai-main/gpt-5.5` if not specified
- `secrets`: per-agent SecretGroup name
- `skills`: list of skill FQNs, for example `agent-skill:tfy-eo/sai-mlrepo/humanizer:1`
- `mcp_servers`: list of MCP Gateway URLs

## Step 1: Create Or Review `hermes.yaml`

Generate or update the user's manifest in the target project:

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

mcp_servers:
  - https://mcp-gateway.example.com/servers/posthog
```

Validate before moving on:

```bash
npx @truefoundry/tfy-hermes-agent validate hermes.yaml --skip-live-checks
```

## Step 2: Generate Slack App Manifest

Generate the Slack app manifest:

```bash
npx @truefoundry/tfy-hermes-agent slack-manifest hermes.yaml > slack-app-manifest.json
```

Ask the user to create a Slack app manually:

1. Go to Slack API app creation.
2. Choose create from manifest.
3. Paste `slack-app-manifest.json`.
4. Create the app in the intended workspace.
5. Install the app.
6. Copy the bot token and signing secret directly into the per-agent TrueFoundry SecretGroup.

Expected Slack URLs are generated from `host`:

```text
https://<host>/slack/events
https://<host>/slack/interactions
```

If Slack URL verification fails before deployment, that is expected. Continue after secrets are set and the Hermes API is deployed.

## Step 3: Create Or Verify SecretGroup

The SecretGroup named by `secrets` must contain:

```text
TFY-GATEWAY-BASE-URL
TFY-GATEWAY-API-KEY
SLACK-BOT-TOKEN
SLACK-SIGNING-SECRET
```

Generate a scaffold if helpful:

```bash
npx @truefoundry/tfy-hermes-agent compile hermes.yaml
```

Then use `.hermes-rendered/secret-group.scaffold.yaml` only as a key checklist. Do not commit real secret values.

## Step 4: Live Validation

Once TrueFoundry credentials and the SecretGroup exist, run:

```bash
export TFY_BASE_URL=https://<tenant>.truefoundry.cloud
export TFY_API_KEY=<set-outside-chat>
npx @truefoundry/tfy-hermes-agent validate hermes.yaml
```

This should check:

- no API/job deployment name collision, unless `--update` is intended
- no host collision
- SecretGroup exists and contains required keys
- MCP server URLs are visible through TrueFoundry MCP Gateway
- skills are valid FQNs

Fix any validation failures before deployment.

## Step 5: Compile And Deploy

Compile:

```bash
npx @truefoundry/tfy-hermes-agent compile hermes.yaml
```

Deploy:

```bash
npx @truefoundry/tfy-hermes-agent deploy hermes.yaml
```

Use `--update` only when intentionally updating existing resources:

```bash
npx @truefoundry/tfy-hermes-agent deploy hermes.yaml --update
```

Expected generated resources:

```text
<name>-hermes-api
<name>-hermes-turn-runner
<name>-hermes-state
<secrets>
```

## Step 6: Health Checks

After deployment, verify:

```bash
curl -fsS https://<host>/api/health
curl -fsS https://<host>/slack/health
curl -fsS https://<host>/v1/models
```

Expected `/slack/health`:

- `botTokenConfigured: true`
- `signingSecretConfigured: true`
- `createUsergroups: false`
- `requireChannelDeployment: false`

If health fails, inspect the TrueFoundry application rollout and logs before going back to Slack.

## Step 7: Finish Slack Verification

Return to Slack app settings:

1. Verify Event Subscriptions request URL.
2. Verify Interactivity request URL.
3. Reinstall the app if Slack says scopes changed.
4. Invite the app to the target Slack channel.

Do not proceed until Slack accepts both URLs.

## Step 8: First Message Test

In Slack, send:

```text
@<name> hello, summarize what you can do
```

Expected behavior:

- Slack creates or uses a thread.
- The agent shows a thinking/loading status.
- The response streams or appears in the thread.
- Feedback controls appear on completion.

Also test the OpenAI-compatible endpoint:

```bash
curl -fsS https://<host>/v1/responses \
  -H 'content-type: application/json' \
  -d '{"model":"openai-main/gpt-5.5","input":"Say hello from this Hermes agent."}'
```

## Troubleshooting

- **Slack URL verification fails**: confirm the API is deployed, `/slack/health` is reachable, and the signing secret in SecretGroup is from the same Slack app.
- **Slack returns auth errors**: reinstall the Slack app and refresh `SLACK-BOT-TOKEN`.
- **No response in channel**: invite the Slack app to the channel and confirm `app_mentions:read` plus message history scopes.
- **Run starts but never completes**: inspect the `<name>-hermes-turn-runner` job logs and verify gateway credentials.
- **MCP validation fails**: use only MCP server URLs registered and reachable through TrueFoundry MCP Gateway.
- **Skill validation fails**: use full skill FQNs such as `agent-skill:<tenant>/<repo>/<skill>:<version>`.

## Completion Criteria

The deployment is done only when all are true:

- TrueFoundry API service is healthy.
- TrueFoundry runner job is deployable.
- `/api/health`, `/slack/health`, and `/v1/models` respond.
- Slack Event and Interactivity URLs are verified.
- The Slack app is installed and invited to a channel.
- A real Slack mention receives a successful Hermes response.
