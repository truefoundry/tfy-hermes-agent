# tfy-eo Hermes Test Agent

This example is the reusable test deployment for validating Hermes Slack and API features on the `tfy-eo` tenant.

## Source Manifest

- Config: `examples/tfy-eo-test-agent/hermes-test-agent.yaml`
- Slack app manifest: `examples/tfy-eo-test-agent/slack-app-manifest.json`
- TrueFoundry workspace: `tfy-ea-dev-eo-az:sai-ws`
- Public host: `https://hermes-test-agent-sai-ws.ml.tfy-eo.truefoundry.cloud`
- Gateway URL: `https://gateway.truefoundry.ai`
- Model: `openai-main/gpt-5.5`
- Source version: see `version` in `hermes-test-agent.yaml`
- SecretGroup: `hermes-test-agent-secrets`

The generated TrueFoundry manifests live in `examples/tfy-eo-test-agent/deployments/`. Do not edit those files directly; change `hermes-test-agent.yaml` and regenerate them.

## Regenerate Manifests

From the repo root:

```bash
node bin/tfy-hermes-agent.mjs deploy examples/tfy-eo-test-agent/hermes-test-agent.yaml --skip-live-checks
```

This writes:

- `deployments/hermes-test-agent-volume.yaml`
- `deployments/hermes-test-agent-runtime-volume.yaml`
- `deployments/hermes-test-agent-runtime.yaml`
- `deployments/hermes-test-agent-worker.yaml`
- `deployments/hermes-test-agent-controller.yaml`
- `deployments/hermes-test-agent-artifact-cleanup.yaml`

The checked-in Slack manifest should point at the same host:

- `https://hermes-test-agent-sai-ws.ml.tfy-eo.truefoundry.cloud/slack/events`
- `https://hermes-test-agent-sai-ws.ml.tfy-eo.truefoundry.cloud/slack/interactions`

## Deploy

Authenticate to the tenant first:

```bash
tfy login --host https://tfy-eo.truefoundry.cloud
```

Then apply the example:

```bash
node bin/tfy-hermes-agent.mjs deploy examples/tfy-eo-test-agent/hermes-test-agent.yaml
```

If the test agent already exists and you intentionally want to replace it:

```bash
node bin/tfy-hermes-agent.mjs deploy examples/tfy-eo-test-agent/hermes-test-agent.yaml --update
```

`deploy` creates or updates the SecretGroup and sets `TFY-API-KEY` plus `HERMES-RUN-TOKEN-SECRET` automatically. For Slack feature tests, paste the Slack app's bot token and signing secret into `SLACK-BOT-TOKEN` and `SLACK-SIGNING-SECRET` in the SecretGroup after deploy. The cleanup job uses `HERMES-ARTIFACT-CLEANUP-TFY-API-KEY`; set it to a virtual-account token scoped to `hermes-inbound-artifacts-prod`.

When testing a feature branch with a slash in the branch name, set `version` in `hermes-test-agent.yaml` to the commit SHA instead of the branch name.
