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
- public hostnames for the Hermes control API and optional Hermes API
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
  hermes_api: hermes-api.example.com

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
