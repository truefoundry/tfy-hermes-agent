# tfy-hermes-agent

Small TrueFoundry deployment package for Hermes Agent.

This repo does not contain Hermes itself. It contains the wrapper needed to run
Hermes on TrueFoundry:

- `controller/` - HTTP service for health, Slack Events, Slack interactions,
  OpenAI-compatible `/v1/*` routes, and executor callbacks.
- `executor/` - one-turn TrueFoundry job that runs Hermes.
- `snapshotter/` - job that snapshots the shared Hermes state volume.
- `bin/tfy-hermes-agent.mjs` - validates, compiles, and deploys `hermes.yaml`.
- `skills/deploy-hermes-slack-agent/` - full deployment runbook.

Install the skill into your coding agent with [`skills`](https://skills.sh):

```bash
npx skills add truefoundry/tfy-hermes-agent -y
```

Add `-g` to install globally, or `-a claude-code` to target a specific agent.

`hermes.yaml` is the source of truth. Compile it to create an agent-named output
folder:

```bash
npx @truefoundry/tfy-hermes-agent validate hermes.yaml --skip-live-checks
npx @truefoundry/tfy-hermes-agent compile hermes.yaml
npx @truefoundry/tfy-hermes-agent deploy hermes.yaml
```

For an agent named `devrel-assistant`, compile writes:

```text
devrel-assistant/
  devrel-assistant-controller.yaml
  devrel-assistant-executor.yaml
  devrel-assistant-secrets.scaffold.yaml
  devrel-assistant-snapshotter.yaml
  devrel-assistant-state.yaml
  slack-app-manifest.json
```

Generated manifests reference secrets through TrueFoundry SecretGroups. Do not
commit raw secrets or generated customer manifests to this repo.

Optional environment knobs used by the compiler:

- `TFY_HOST`, `TFY_API_KEY` - required for live validation and `deploy`.
- `TFY_SECRET_TENANT` - tenant slug used to infer `host` when `hermes.yaml`
  omits it and `TFY_HOST` is not set.
- `HERMES_REPO_URL`, `HERMES_SOURCE_REF`, `HERMES_SOURCE_BRANCH` - override the
  git source baked into generated `build_source` blocks. Defaults to this
  package's upstream repo on `main`.

Slack uses the HTTP Events API:

```text
https://<agent-host>/slack/events
https://<agent-host>/slack/interactions
```

TrueFoundry services do not support Slack Socket Mode or WebSocket-dependent
flows.

Development check:

```bash
npm run check
```
