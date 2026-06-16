---
name: deploy-hermes-slack-agent
description: Onboards standalone TrueFoundry Hermes Slack agents from hermes.yaml. Use when a user wants to create, deploy, update, or smoke-test a Hermes agent with a generated Slack app manifest, TrueFoundry SecretGroup, volume, controller, and executor.
---

# Deploy Hermes Slack Agent

Use this skill as an interactive deployment operator, not as a static checklist.
Keep the conversation moving one missing input or one manual task at a time.

## Core Contract

- Source of truth: `hermes.yaml`.
- Generated output: TrueFoundry manifests built in memory and piped to `tfy apply`. Pass `--emit-manifests <dir>` only when the user wants the YAML files on disk for inspection.
- Architecture: one Slack app per agent, a `secrets` SecretGroup the user creates out-of-band, and three TrueFoundry resources `deploy` applies — `volume` (RWO PVC mounted at /data on the controller), `controller` (Service), and `executor` (Job template). State durability is the controller's RWO `/data` volume; offsite snapshotting is out of scope for the deployed stack.
- Slack transport: HTTP Events API and Interactivity only. Do not use Socket Mode, WebSockets, slash commands, Slack user groups, or Slack OAuth.
- Secrets: never ask the user to paste raw Slack tokens, signing secrets, TrueFoundry API keys, or the HMAC run-token secret into chat. Have them fill the TrueFoundry SecretGroup directly.
- Deployment gate: `deploy` runs live validation as its first action. There is no separate `validate` command.

## Load References

- Read `references/deployment-example.md` when creating or reviewing `hermes.yaml`, generated manifests, Slack app setup, SecretGroup setup, deployment, or failure handling.
- Read `references/session-smoke-test.md` before declaring a deployment healthy or when debugging runtime behavior.

## Workflow

Track this sequence and resume from the first incomplete step. Hard precondition before step 1: `TFY_HOST` and `TFY_API_KEY` must be set in the local environment and authenticate against the target host. If missing, stop and ask the user to authenticate before continuing.

1. If `hermes.yaml` does not exist, run the interactive wizard:
   ```bash
   npx @truefoundry/tfy-hermes-agent init
   ```
   This writes `hermes.yaml` and `slack-app-manifest.json` in the current directory and prints the SecretGroup name plus the required keys.

2. If `hermes.yaml` already exists, collect any missing manifest fields and edit it in place: `name`, `workspace_fqn`, `description`, `instructions`, `model`, `gateway_url`, `skills`, `mcp_servers`, `secrets`, optional `slack` allowlist.

3. Stop for Slack app creation from `slack-app-manifest.json`. The user creates and installs the app in their Slack workspace.

4. Stop for SecretGroup filling with these four keys:
   - `TFY-API-KEY` (used for control-plane calls, the LLM-gateway bearer, and inbound `/v1/*` auth). **Needs `application:read` + `application:trigger`** on the workspace — a write-only PAT silently breaks job dispatch. Use a Virtual Account PAT, not a one-off personal token.
   - `HERMES-RUN-TOKEN-SECRET` (32+ random chars; signs per-run executor callbacks)
   - `SLACK-BOT-TOKEN` (from the installed Slack app)
   - `SLACK-SIGNING-SECRET` (from the installed Slack app)

5. Deploy. `deploy` runs live validation against TrueFoundry first; if any check fails it stops without applying.
   ```bash
   npx @truefoundry/tfy-hermes-agent deploy hermes.yaml
   ```
   Pass `--update` to overwrite an existing deployment, `--emit-manifests <dir>` to also write the YAML files to disk, or `--skip-live-checks` only when iterating offline.

6. Verify health, Slack URL verification, and one real Slack mention.

## What `deploy` Validates Live

`deploy` always runs live against the user's `TFY_API_KEY` unless `--skip-live-checks` is passed. Every check must pass before manifests apply.

Auth & access:
- `TFY_API_KEY` authenticates against the target host.
- `workspace_fqn` exists and the key has access to it.

Naming & routing:
- `name` does not clash with an existing deployment in the workspace. A match on the current agent's own deployment is an update, allowed only with `--update`.
- `host` (if specified) is not already routed to another deployment.

Resource references:
- Every `skills` FQN exists in the agent-skill registry and is fetchable with the key.
- Every `skills` FQN is version-pinned (e.g. `:1`); floating tags are rejected.
- Every `mcp_servers` URL is a TrueFoundry MCP Gateway URL.
- Every `mcp_servers` URL resolves and is reachable with the key.
- `model` is in the model list reachable from the key.

Secrets:
- The `secrets` SecretGroup already exists in the workspace and contains all four required keys. `deploy` does not create the SecretGroup; if it is missing, validation fails with `SecretGroup not found: <name> (create it in TrueFoundry first)`.

## Input Rules

- `name`: lowercase Slack-safe handle, for example `devrel-assistant`.
- `workspace_fqn`: TrueFoundry workspace FQN, for example `tfy-ea-dev-eo-az:sai-ws`.
- `version`: optional git ref (branch, tag, or commit SHA) of `truefoundry/tfy-hermes-agent` to build the controller/executor images from. Defaults to `main`. **Slashed branch names** (e.g. `feat/foo`) are rejected by the TrueFoundry git puller — use the commit SHA (`git rev-parse HEAD`) for those.
- `host`: optional; inferred from `TFY_HOST` (the tenant slug is parsed out of it). If `TFY_HOST` isn't set, ask the user for `host` directly.
- `gateway_url`: required OpenAI-compatible gateway URL used by the executor for Hermes model calls.
- `skills`: full FQNs with pinned versions only, for example `agent-skill:tfy-eo/sai-mlrepo/humanizer:1`. Floating tags are rejected.
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

- `hermes.yaml` exists and `deploy` succeeds (live validation passed and `tfy apply` reported success for `volume`, `controller`, and `executor`).
- Slack app is installed and backed by the per-agent SecretGroup with all four required keys filled.
- `/api/health`, `/slack/health`, and `/v1/models` respond.
- Session smoke tests pass (see `references/session-smoke-test.md`).
- Slack Events and Interactivity URLs are verified in Slack settings.
- A real Slack mention receives a final Hermes response.
