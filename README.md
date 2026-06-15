# tfy-hermes-agent

Small TrueFoundry deployment package for Hermes Agent.

This repo does not contain Hermes itself. It contains the wrapper needed to run
Hermes on TrueFoundry:

- `controller/` - HTTP service for health, Slack Events, Slack interactions,
  OpenAI-compatible `/v1/*` routes, and executor callbacks.
- `executor/` - one-turn TrueFoundry job that runs Hermes.
- `bin/tfy-hermes-agent.mjs` - scaffolds `hermes.yaml` and deploys it.
- `skills/deploy-hermes-slack-agent/` - full deployment runbook.

State durability lives on the controller's RWO `/data` volume (one
`wrapper.db` plus one SQLite file per Slack thread under `/data/sessions/`).
Offsite backup is out of scope for the deployed stack; run a periodic
`sqlite3 .backup` cron against the same volume if you need it.

Install the skill into your coding agent with [`skills`](https://skills.sh):

```bash
npx skills add truefoundry/tfy-hermes-agent -y
```

Add `-g` to install globally, or `-a claude-code` to target a specific agent.

`hermes.yaml` is the source of truth. The CLI has two commands:

```bash
npx @truefoundry/tfy-hermes-agent init                  # interactive wizard, writes hermes.yaml + slack-app-manifest.json
npx @truefoundry/tfy-hermes-agent deploy hermes.yaml    # validate + tfy apply (pipes manifests from memory)
```

`deploy` runs live validation against TrueFoundry as its first action and then
applies four resources in order: SecretGroup scaffold (on first run or
`--update`), volume PVC, controller Service, executor Job template.

Useful flags:

- `--update` - overwrite an existing deployment of the same name.
- `--emit-manifests <dir>` - also write the generated YAML files to `<dir>`
  for inspection. Without this flag, manifests are piped directly to
  `tfy apply` from memory.
- `--skip-live-checks` - bypass control-plane validation; only for offline
  iteration.

For agent `devrel-assistant`, `--emit-manifests ./out` writes:

```text
out/
  devrel-assistant-secrets.scaffold.yaml
  devrel-assistant-volume.yaml
  devrel-assistant-controller.yaml
  devrel-assistant-executor.yaml
slack-app-manifest.json              (only `init` writes this, in cwd)
```

Generated manifests reference secrets through TrueFoundry SecretGroups. Do not
commit raw secrets or generated customer manifests to this repo.

The agent's SecretGroup must contain these four keys filled in the TrueFoundry UI:

- `TFY-API-KEY` — used by the controller for outbound TrueFoundry calls (job dispatch, skill fetch), passed to Hermes as the LLM-gateway bearer, and required as the inbound `/v1/*` bearer. Fail-closed on startup.
- `HERMES-RUN-TOKEN-SECRET` — 32+ random chars; HMAC master for per-run executor callback tokens. Fail-closed on startup.
- `SLACK-BOT-TOKEN` — `xoxb-…` from the Slack app (placeholder OK if you're not wiring Slack yet)
- `SLACK-SIGNING-SECRET` — from the Slack app (placeholder OK)

Optional environment knobs used by the CLI:

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
