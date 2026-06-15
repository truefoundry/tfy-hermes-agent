# tfy-hermes-agent

Deploy your AI assistant powered by [Hermes Agent](https://github.com/NousResearch/hermes-agent) on TrueFoundry and use it on Slack or OpenAI-compatible API.

## Quickstart

Let your coding agent drive it:

```bash
npx skills add truefoundry/tfy-hermes-agent -y
```

Then say **"create a Hermes Slack agent"** to Claude Code (or any agent). It'll walk through the wizard, the Slack app, and the deploy.

Doing it by hand:

```bash
npx @truefoundry/tfy-hermes-agent init           # writes hermes.yaml
npx @truefoundry/tfy-hermes-agent deploy hermes.yaml
```

`deploy` needs `TFY_HOST` and `TFY_API_KEY` in your env.

## Example `hermes.yaml`

```yaml
# Required
name: devrel-assistant
workspace_fqn: tfy-ea-dev-eo-az:sai-ws
gateway_url: https://your-gateway/v1
model: openai-main/gpt-5.5
secrets: devrel-assistant-hermes-secrets

# Optional
description: Helps with DevRel launches.
instructions: Be concise and evidence-driven.
slack:
  allowed_channels: [C0123456789]
skills:
  - agent-skill:tfy-eo/sai-mlrepo/humanizer:1
mcp_servers:
  - https://mcp-gateway.example.com/servers/linear
```

**Required:** `name`, `workspace_fqn`, `gateway_url`, `model` (whatever your gateway accepts), `secrets`.

**Optional:** `version` (git ref for image build, default `main`), `host` (derived from `TFY_HOST` if omitted), `description`, `instructions`, `slack.allowed_channels`, `slack.allowed_users`, `slack_team_id`, `skills`, `mcp_servers`.

## Secrets

Fill these four keys in the SecretGroup named by `secrets:`. **Hyphens only** — TrueFoundry rejects underscores.

| Key | What it's for |
|---|---|
| `TFY-API-KEY` | Outbound TF calls, LLM gateway, and inbound `/v1/*` auth. Needs `application:read` + `application:trigger`. |
| `HERMES-RUN-TOKEN-SECRET` | 32+ random chars. HMAC key for executor callbacks. |
| `SLACK-BOT-TOKEN` | `xoxb-…` from your Slack app. |
| `SLACK-SIGNING-SECRET` | From your Slack app. |

`SLACK-*` can be placeholders if you're not wiring Slack yet.
