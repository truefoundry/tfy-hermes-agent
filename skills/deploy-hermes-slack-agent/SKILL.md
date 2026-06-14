---
name: deploy-hermes-slack-agent
description: Onboard a user step by step to create, validate, deploy, and test a standalone TrueFoundry Hermes Slack agent from hermes.yaml. Use when the user wants an interactive guided flow that asks for agent name, instructions, MCP servers, skills, host, workspace, Slack app setup, secrets, deployment, health checks, and first Slack message verification.
---

# Deploy Hermes Slack Agent

Use this skill as an onboarding assistant, not as a static checklist. The target architecture is one Slack app, one TrueFoundry API service, one runner job, one state volume, and one isolated SecretGroup per agent.

## Interaction Contract

- Ask for one missing input or one manual task at a time.
- Do the next automatic step yourself whenever enough information is available.
- Stop only when user input, a Slack UI action, a TrueFoundry UI action, or missing local credentials are required.
- Do not dump the whole process upfront.
- After each user answer or confirmation, continue from the next incomplete onboarding state.
- Never ask the user to paste raw Slack tokens, signing secrets, or TrueFoundry API keys into chat.
- Tell the user to store secrets directly in the named TrueFoundry SecretGroup or in local environment variables.
- Do not use Socket Mode.
- Do not create Slack user groups. This flow is one Slack app per Hermes agent.
- Treat `hermes.yaml` as source of truth and generated manifests as derived output.
- Do not deploy until validation passes or the user explicitly accepts a known limitation.

## Onboarding State

Maintain this state internally and progress in order. If a value is obvious from the repo or user context, state the assumption briefly and continue.

1. `name`: lowercase Slack-safe agent handle, for example `devrel-assistant`
2. `workspace_fqn`: target TrueFoundry workspace, for example `tfy-ea-dev-eo-az:sai-ws`
3. `host`: full public URL for the agent API
4. `description`: one short sentence
5. `instructions`: the agent behavior instructions
6. `model`: default `openai-main/gpt-5.5` if the user does not specify
7. `skills`: list of skill FQNs, for example `agent-skill:tfy-eo/sai-mlrepo/humanizer:1`
8. `mcp_servers`: list of MCP Gateway URLs
9. `secrets`: per-agent SecretGroup name, default `<name>-hermes-secrets`
10. `hermes.yaml`: written or updated in the user's project
11. Slack app manifest: generated from `hermes.yaml`
12. Slack app: manually created and installed by the user
13. SecretGroup: manually filled by the user
14. live validation: passed with TrueFoundry credentials
15. deployment: compiled and applied
16. health checks: service and Slack health reachable
17. Slack URLs: Events API and Interactivity verified
18. first message: real Slack mention receives a response

## Conversation Flow

Start by identifying the first missing state item and ask only that.

Examples:

- "What should the Slack handle be? Example: `devrel-assistant`."
- "Which TrueFoundry workspace FQN should this deploy to?"
- "What public host should Slack call for this agent?"
- "What should this agent do? Give me the operating instructions, not just a title."

When asking about optional lists:

- For skills, accept `none`, an empty list, or full FQNs only.
- For MCP servers, accept `none`, an empty list, or URLs reachable through MCP Gateway only.
- If the user gives names instead of FQNs or URLs, pause and ask for the exact values or offer to look them up if tooling is available.

When all manifest fields are known, write or update `hermes.yaml`:

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

Then immediately run local validation:

```bash
npx @truefoundry/tfy-hermes-agent validate hermes.yaml --skip-live-checks
```

Fix manifest errors yourself if possible. Ask the user only when the fix changes product intent or requires a missing value.

## Manual Stop 1: Slack App

After local validation passes, generate the Slack manifest:

```bash
npx @truefoundry/tfy-hermes-agent slack-manifest hermes.yaml > slack-app-manifest.json
```

Then stop and give exactly one manual task:

"Create the Slack app from `slack-app-manifest.json`, install it in the intended workspace, then come back and say it is installed. URL verification may fail until the service is deployed; that is expected."

Do not continue to secrets or deployment until the user confirms the Slack app exists.

Expected Slack URLs come from `host`:

```text
https://<host>/slack/events
https://<host>/slack/interactions
```

## Manual Stop 2: SecretGroup

After the user confirms the Slack app exists, generate rendered manifests if needed:

```bash
npx @truefoundry/tfy-hermes-agent compile hermes.yaml
```

Then stop and give exactly one manual task:

"Create or update the TrueFoundry SecretGroup named `<secrets>` and add these keys: `TFY-GATEWAY-BASE-URL`, `TFY-GATEWAY-API-KEY`, `SLACK-BOT-TOKEN`, and `SLACK-SIGNING-SECRET`. Put the values in TrueFoundry directly, not in chat. Tell me when the SecretGroup is ready."

Do not ask the user to paste the values.

## Live Validation

After the user confirms the SecretGroup is ready, run live validation if local TrueFoundry credentials exist:

```bash
npx @truefoundry/tfy-hermes-agent validate hermes.yaml
```

If credentials are missing, stop with one task:

"Set `TFY_BASE_URL` and `TFY_API_KEY` in this terminal, or run the validation command locally and send me whether it passed."

Live validation should confirm:

- no API or job deployment name collision, unless `--update` is intended
- no host collision
- SecretGroup exists and contains required keys
- MCP server URLs are visible through TrueFoundry MCP Gateway
- skills are valid FQNs

Resolve failures in-place when possible. If a failure requires user choice, ask only that choice.

## Deploy

Deploy only after live validation passes:

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

If this repo branch is being tested before package release or merge, set the source ref explicitly before deployment:

```bash
export HERMES_SOURCE_REF=codex/standalone-hermes-slack-agents
```

## Health Checks

After deploy, run health checks yourself:

```bash
curl -fsS https://<host>/api/health
curl -fsS https://<host>/slack/health
curl -fsS https://<host>/v1/models
```

Expected `/slack/health` includes:

- `botTokenConfigured: true`
- `signingSecretConfigured: true`
- `createUsergroups: false`
- `requireChannelDeployment: false`

If health fails, inspect TrueFoundry application rollout and logs before returning to Slack.

## Manual Stop 3: Slack URL Verification

When health checks pass, stop with one manual task:

"Go back to the Slack app settings, verify the Event Subscriptions and Interactivity URLs, reinstall the app if Slack says scopes changed, and invite the app to the target channel. Tell me when Slack accepts both URLs."

Do not proceed until the user confirms Slack accepts both URLs.

## Manual Stop 4: First Message

Ask the user to send one real Slack mention:

```text
@<name> hello, summarize what you can do
```

Then ask for only the result. If it fails, troubleshoot based on the symptom:

- Slack URL verification fails: confirm API health, `/slack/health`, and same-app signing secret.
- Slack auth error: reinstall the app and refresh `SLACK-BOT-TOKEN` in the SecretGroup.
- No channel response: invite the Slack app to the channel and confirm Slack scopes.
- Run starts but does not complete: inspect `<name>-hermes-turn-runner` job logs and gateway credentials.
- MCP validation fails: use only MCP server URLs registered and reachable through TrueFoundry MCP Gateway.
- Skill validation fails: use full skill FQNs like `agent-skill:<tenant>/<repo>/<skill>:<version>`.

## Completion Criteria

The onboarding is complete only when all are true:

- `hermes.yaml` exists in the user's project.
- Local and live validation pass.
- Slack app is created, installed, and backed by the per-agent SecretGroup.
- TrueFoundry API service and runner are deployed.
- `/api/health`, `/slack/health`, and `/v1/models` respond.
- Slack Event and Interactivity URLs are verified.
- A real Slack mention receives a successful Hermes response.
