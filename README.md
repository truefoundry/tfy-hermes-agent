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
- MCP server names that are visible through TrueFoundry MCP Gateway with your token
- skill names that exist in your Skills Registry
- a model reachable through your TrueFoundry AI Gateway

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
  - linear

skills:
  - truefoundry-service-test
```

## Commands

```bash
npx github:truefoundry/tfy-hermes-agent validate assistant.yaml
npx github:truefoundry/tfy-hermes-agent render assistant.yaml
npx github:truefoundry/tfy-hermes-agent deploy assistant.yaml
npx github:truefoundry/tfy-hermes-agent test assistant.yaml
```
