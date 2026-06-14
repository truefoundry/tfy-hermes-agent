---
name: deploy-hermes-slack-agent
description: Onboards standalone TrueFoundry Hermes Slack agents from hermes.yaml. Use when a user wants to create, validate, deploy, update, or smoke-test a Hermes agent with a generated Slack app manifest, TrueFoundry SecretGroup, controller, executor, and state volume.
---

# Deploy Hermes Slack Agent

Use this skill as an interactive deployment operator, not as a static checklist.
Keep the conversation moving one missing input or one manual task at a time.

## Core Contract

- Source of truth: `hermes.yaml`.
- Generated output: `<agent-name>/` with TrueFoundry YAML files and `slack-app-manifest.json`.
- Architecture: one Slack app per agent, plus `secrets`, `state`, `controller`, and `executor`. State durability is the controller's RWO `/data` volume; offsite snapshotting is out of scope for the deployed stack.
- Slack transport: HTTP Events API and Interactivity only. Do not use Socket Mode, WebSockets, slash commands, Slack user groups, or Slack OAuth.
- Secrets: never ask the user to paste raw Slack tokens, signing secrets, or TrueFoundry API keys into chat. Have them fill the TrueFoundry SecretGroup or local environment directly.
- Deployment gate: do not deploy until `validate` passes. `deploy` re-runs `validate` as its first action.

## Load References

- Read `references/deployment-example.md` when creating or reviewing `hermes.yaml`, generated manifests, Slack app setup, SecretGroup setup, validation, deployment, or failure handling.
- Read `references/session-smoke-test.md` before declaring a deployment healthy or when debugging runtime behavior.

## Workflow

Track this sequence and resume from the first incomplete step. Hard precondition before step 1: a local `TFY_API_KEY` must be set and authenticate against the target host. If missing, stop and ask the user to authenticate before continuing.

1. Collect missing manifest fields: `name`, `workspace_fqn`, optional `host`, `description`, `instructions`, `model`, `skills`, `mcp_servers`, `secrets`, optional `slack`.
2. Write or update `hermes.yaml`.
3. Run validation (see Validate Checks below):
   ```bash
   npx @truefoundry/tfy-hermes-agent validate hermes.yaml
   ```
4. Compile generated files:
   ```bash
   npx @truefoundry/tfy-hermes-agent compile hermes.yaml
   ```
5. Stop for Slack app creation from `<agent-name>/slack-app-manifest.json`.
6. Stop for SecretGroup filling with `SLACK-BOT-TOKEN`, `SLACK-SIGNING-SECRET`, `HARNESS-INTERNAL-TOKEN`, and `TFY_API_KEY`.
7. Deploy (re-runs `validate` first):
   ```bash
   npx @truefoundry/tfy-hermes-agent deploy hermes.yaml
   ```
8. Verify health, backend sessions, Slack URL verification, and one real Slack mention.

## Validate Checks

`validate` always runs live against the user's `TFY_API_KEY`. Every check below must pass before `deploy`.

Auth & access:
- `TFY_API_KEY` authenticates against the target host.
- `workspace_fqn` exists and the key has access to it.

Naming & routing:
- `name` does not clash with an existing deployment in the workspace. A match on the current agent's own deployment is an update, not a clash.
- `host` (if specified) is not already routed to another deployment.

Resource references:
- Every `skills` FQN exists in the agent-skill registry and is fetchable with the key.
- Every `skills` FQN is version-pinned (e.g. `:1`); floating tags are rejected.
- Every `mcp_servers` URL is a TrueFoundry MCP Gateway URL.
- Every `mcp_servers` URL resolves and is reachable with the key.
- `model` is in the model list reachable from the key.

Secrets:
- The `secrets` SecretGroup exists in the workspace, or the key has permission to create it.

## Input Rules

- `name`: lowercase Slack-safe handle, for example `devrel-assistant`.
- `workspace_fqn`: TrueFoundry workspace FQN, for example `tfy-ea-dev-eo-az:sai-ws`.
- `host`: optional; inferred from `TFY_HOST` or `TFY_SECRET_TENANT` when set. If neither is set, ask the user for `host`.
- `skills`: full FQNs with pinned versions only, for example `agent-skill:tfy-eo/sai-mlrepo/humanizer:1`. Floating tags are rejected by validate.
- `mcp_servers`: TrueFoundry MCP Gateway URLs only.
- `secrets`: default to `<name>-hermes-secrets` if unspecified.
- `slack.allowed_channels`: optional list of Slack channel/group/DM IDs (e.g. `C0123456789`). When omitted or empty, the agent is open to all channels where it is installed and invited.
- `slack.allowed_users`: optional list of Slack user IDs (e.g. `U0123456789`). When omitted or empty, the agent is open to all users.

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

- `hermes.yaml` exists and `validate` passes.
- Generated files are compiled under `<agent-name>/`.
- Slack app is installed and backed by the per-agent SecretGroup.
- TrueFoundry `state`, `controller`, and `executor` are deployed.
- `/api/health`, `/slack/health`, and `/v1/models` respond.
- Backend session smoke tests pass.
- Slack Events and Interactivity URLs are verified.
- A real Slack mention receives a final Hermes response.
