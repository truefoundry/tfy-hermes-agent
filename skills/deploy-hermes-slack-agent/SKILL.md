---
name: deploy-hermes-slack-agent
description: Onboards standalone TrueFoundry Hermes Slack agents from hermes.yaml. Use when a user wants to create, validate, deploy, update, or smoke-test a Hermes agent with a generated Slack app manifest, TrueFoundry SecretGroup, controller, executor, state volume, and snapshotter.
---

# Deploy Hermes Slack Agent

Use this skill as an interactive deployment operator, not as a static checklist.
Keep the conversation moving one missing input or one manual task at a time.

## Core Contract

- Source of truth: `hermes.yaml`.
- Generated output: `<agent-name>/` with TrueFoundry YAML files and `slack-app-manifest.json`.
- Architecture: one Slack app per agent, plus `secrets`, `state`, `controller`, `executor`, and `snapshotter`.
- Slack transport: HTTP Events API and Interactivity only. Do not use Socket Mode, WebSockets, slash commands, Slack user groups, or Slack OAuth.
- Secrets: never ask the user to paste raw Slack tokens, signing secrets, or TrueFoundry API keys into chat. Have them fill the TrueFoundry SecretGroup or local environment directly.
- Deployment gate: do not deploy until local validation passes and either live validation passes or the user explicitly accepts a known limitation.

## Load References

- Read `references/deployment-example.md` when creating or reviewing `hermes.yaml`, generated manifests, Slack app setup, SecretGroup setup, validation, deployment, or failure handling.
- Read `references/session-smoke-test.md` before declaring a deployment healthy or when debugging runtime behavior.

## Workflow

Track this sequence and resume from the first incomplete step:

1. Collect missing manifest fields: `name`, `workspace_fqn`, optional `host`, `description`, `instructions`, `model`, `skills`, `mcp_servers`, `secrets`, optional `slack`, optional `snapshot`.
2. Write or update `hermes.yaml`.
3. Run local validation:
   ```bash
   npx @truefoundry/tfy-hermes-agent validate hermes.yaml --skip-live-checks
   ```
4. Compile generated files:
   ```bash
   npx @truefoundry/tfy-hermes-agent compile hermes.yaml
   ```
5. Stop for Slack app creation from `<agent-name>/slack-app-manifest.json`.
6. Stop for SecretGroup filling with `SLACK-BOT-TOKEN`, `SLACK-SIGNING-SECRET`, `HARNESS-INTERNAL-TOKEN`, and `TFY_API_KEY`.
7. Run live validation when credentials are available:
   ```bash
   npx @truefoundry/tfy-hermes-agent validate hermes.yaml
   ```
8. Deploy only after validation:
   ```bash
   npx @truefoundry/tfy-hermes-agent deploy hermes.yaml
   ```
9. Verify health, backend sessions, snapshotter, Slack URL verification, and one real Slack mention.

## Input Rules

- `name`: lowercase Slack-safe handle, for example `devrel-assistant`.
- `workspace_fqn`: TrueFoundry workspace FQN, for example `tfy-ea-dev-eo-az:sai-ws`.
- `host`: optional; infer from tenant env when available.
- `skills`: full FQNs only, for example `agent-skill:tfy-eo/sai-mlrepo/humanizer:1`.
- `mcp_servers`: TrueFoundry MCP Gateway URLs only.
- `secrets`: default to `<name>-hermes-secrets` if unspecified.
- `slack.channels`: optional Slack channel/group/DM ID allowlist. Empty means unrestricted.
- `slack.users`: optional Slack user ID allowlist. Empty means unrestricted.
- `snapshot`: optional; when present, requires `ml_repo` and `artifact_name`.

If the user gives names instead of FQNs, URLs, or Slack IDs, pause and ask for exact values or offer to look them up when tooling is available.

## Manual Stops

Only stop for external work:

- Slack app creation and installation.
- SecretGroup value entry.
- Missing local TrueFoundry credentials.
- Slack URL verification in Slack settings.
- First real Slack message result.

When stopping, give exactly one concrete task and the file/path/name the user needs.

## Completion Criteria

The flow is complete only when:

- `hermes.yaml` exists and local/live validation pass.
- Generated files are compiled under `<agent-name>/`.
- Slack app is installed and backed by the per-agent SecretGroup.
- TrueFoundry `state`, `controller`, `executor`, and `snapshotter` are deployed.
- `/api/health`, `/slack/health`, and `/v1/models` respond.
- Backend session smoke tests pass.
- Snapshotter writes a local snapshot, and writes an artifact version when `snapshot` is configured.
- Slack Events and Interactivity URLs are verified.
- A real Slack mention receives a final Hermes response.
