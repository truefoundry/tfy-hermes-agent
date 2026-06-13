# tfy-hermes-agent

Reusable TrueFoundry deployment package for Hermes Agent.

This repo keeps the deployment wrapper small: a control API, a per-turn job
runner, Dockerfiles, and TrueFoundry YAML templates. It does not vendor the full
upstream Hermes codebase. The runtime image installs `hermes-agent` at build
time.

## Why This Exists

Projects should not need to copy a large agent repo just to host Hermes on
TrueFoundry. They should be able to keep a small `hermes.yaml` in their own repo
or render the templates here with different workspace, host, model, and secret
settings.

## Included

- `control-api/` - HTTP control plane for agents, sessions, runs, MCP visibility,
  and run completion callbacks.
- `runner/` - TrueFoundry Job entrypoint that executes one `hermes -z` turn.
- `manifests/` - reusable TrueFoundry YAML templates.
- `examples/hermes.yaml` - compact project-local example for deploying the
  control API from this repo.

## Policy

- Skills must be loaded from the configured Skills Registry only.
- Secrets must be referenced as `tfy-secret://...`; raw secret values are
  rejected by the control API.
- MCP servers must be visible through TrueFoundry MCP Gateway with the configured
  token before they can be attached by name.

## Render Manifests

```bash
export TFY_WORKSPACE_FQN=tfy-ea-dev-eo-az:sai-ws
export TFY_SECRET_TENANT=tfy-eo
export TFY_BASE_URL=https://tfy-eo.truefoundry.cloud
export CONTROL_API_HOST=harness-control-api-sai-ws.ml.tfy-eo.truefoundry.cloud
export HERMES_API_HOST=hermes-api-sai-ws.ml.tfy-eo.truefoundry.cloud
export HERMES_REPO_URL=https://github.com/truefoundry/tfy-hermes-agent
export HERMES_SOURCE_REF=main

./scripts/render-manifests.sh
```

Deploy the rendered files with `tfy deploy -f .rendered/<file>.yaml`.

## Project-Local YAML

If another project only wants to reference this package, copy
`examples/hermes.yaml` into that project and swap:

- `workspace_fqn`
- exposed host
- `repo_url` and `ref` if using a fork or pinned commit
- SecretGroup tenant/name/key references
