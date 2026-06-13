# tfy-hermes-agent

Deploy a Hermes assistant to TrueFoundry from a project-local `assistant.yaml`.

```bash
npx github:truefoundry/tfy-hermes-agent deploy assistant.yaml
```

No npm/PyPI package is required. The runner comes from GitHub.

## Prereqs

Before writing `assistant.yaml`, you need:

- TrueFoundry host, for example `https://tfy.example.com`
- TrueFoundry workspace FQN, for example `cluster:workspace`
- TrueFoundry credentials available locally or in CI
- a public hostname for the Hermes API/control service
- a TrueFoundry SecretGroup for gateway credentials
- only `tfy-secret://...` refs in config; no raw secrets
- MCP Gateway URLs for servers visible with your token
- skill names that exist in your Skills Registry
- a model reachable through your TrueFoundry AI Gateway
- optional Slack app bot token and signing secret stored as TFY secrets

## Minimal `assistant.yaml`

```yaml
name: devrel-assistant
workspace_fqn: cluster:workspace
tfy_base_url: https://tfy.example.com

hosts:
  control_api: hermes-control.example.com

model: openai-main/gpt-5.5

secrets:
  gateway_base_url: tfy-secret://tenant:secret-group:TFY-GATEWAY-BASE-URL
  gateway_api_key: tfy-secret://tenant:secret-group:TFY-GATEWAY-API-KEY

mcp_servers:
  - ${gateway_base_url}/mcp/linear/server

skills:
  - truefoundry-service-test
```

Optional Slack bridge:

```yaml
secrets:
  slack_bot_token: tfy-secret://tenant:secret-group:SLACK-BOT-TOKEN
  slack_signing_secret: tfy-secret://tenant:secret-group:SLACK-SIGNING-SECRET

slack:
  enabled: true
  app_name: Hermes Agent
  handles:
    - hermes
  channel_ids: []
  response_mode: mentions
```

Slack request URL: `https://<control_api_host>/slack/events`.

OpenAI-compatible API base URL: `https://<control_api_host>/v1`.

Supported OpenAI-style endpoints:

- `GET /v1/models`
- `POST /v1/responses`
- `GET /v1/responses/:id`
- `POST /v1/chat/completions`
- `GET /v1/chat/completions/:id`

The adapter supports text-only, non-streaming calls. `stream: true` returns an
OpenAI-style error response because Hermes turns currently run as background
jobs that return final stdout. Use `background: true` with `POST /v1/responses`
to create an async run and poll `GET /v1/responses/:id`.

## Commands

```bash
npx github:truefoundry/tfy-hermes-agent validate assistant.yaml
npx github:truefoundry/tfy-hermes-agent render assistant.yaml
npx github:truefoundry/tfy-hermes-agent deploy assistant.yaml
npx github:truefoundry/tfy-hermes-agent test assistant.yaml
```

## GitHub Actions

Copy `examples/github-actions/deploy-hermes-assistant.yml` into your project as:

```text
.github/workflows/deploy-hermes-assistant.yml
```

Add `TFY_API_KEY` as a GitHub Actions secret. The workflow deploys `assistant/assistant.yaml`.
