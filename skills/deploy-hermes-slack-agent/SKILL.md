---
name: deploy-hermes-slack-agent
description: Onboard a user step by step to create, validate, deploy, and test a standalone TrueFoundry Hermes Slack agent from hermes.yaml. Use when the user wants an interactive guided flow that asks for agent name, instructions, MCP servers, skills, host, workspace, Slack app setup, secrets, deployment, health checks, and first Slack message verification.
---

# Deploy Hermes Slack Agent

Use this skill as an onboarding assistant, not as a static checklist. The target architecture is one Slack app plus five TrueFoundry components per agent: `secrets`, `state`, `controller`, `executor`, and `snapshotter`.

## What This Flow Must Produce

The end state is not just "a deployment exists". The end state is:

```text
hermes.yaml -> secrets/state/controller/executor/snapshotter manifests -> Slack app -> Hermes executor
```

where:

- Slack sends Events API and Interactivity webhooks to the agent API over HTTP.
- The executor starts Hermes with the manifest MCP servers mounted and discovered.
- The executor downloads manifest skill FQNs into `$HERMES_HOME/skills` before invoking Hermes.
- Manifest `name`, `description`, and `instructions` are appended to Hermes' internal prompt as an additional system layer. Do not replace Hermes' native prompt stack, native identity, safety/tool guidance, or `SOUL.md`.
- The snapshotter always writes controller state to `/data/snapshots` on the state volume. If `snapshot` is configured, it also logs immutable TrueFoundry artifact versions in the configured ML Repo.
- The Slack UX shows Hermes activity and a final answer in the same assistant thread.

## Interaction Contract

- Ask for one missing input or one manual task at a time.
- Do the next automatic step yourself whenever enough information is available.
- Stop only when user input, a Slack UI action, a TrueFoundry UI action, or missing local credentials are required.
- Do not dump the whole process upfront.
- After each user answer or confirmation, continue from the next incomplete onboarding state.
- Never ask the user to paste raw Slack tokens, signing secrets, or TrueFoundry API keys into chat.
- Tell the user to store secrets directly in the named TrueFoundry SecretGroup or in local environment variables.
- Do not use Socket Mode.
- Do not create Slack user groups. This flow is one Slack app per Hermes agent.
- Ask whether Slack access should be restricted by channel IDs or user IDs. If the user does not provide either list, leave that dimension unrestricted.
- Treat `hermes.yaml` as source of truth and generated manifests as derived output.
- Treat generated `.hermes-rendered/*` manifests as disposable deploy output unless the user asks to commit them.
- Do not deploy until validation passes or the user explicitly accepts a known limitation.

## Onboarding State

Maintain this state internally and progress in order. If a value is obvious from the repo or user context, state the assumption briefly and continue.

1. `name`: lowercase Slack-safe agent handle, for example `devrel-assistant`
2. `workspace_fqn`: target TrueFoundry workspace, for example `tfy-ea-dev-eo-az:sai-ws`
3. `host`: optional full public URL for the agent API; infer it when tenant env is available
4. `description`: one short sentence
5. `instructions`: the agent behavior instructions
6. `model`: default `openai-main/gpt-5.5` if the user does not specify
7. `skills`: list of skill FQNs, for example `agent-skill:tfy-eo/sai-mlrepo/humanizer:1`
8. `mcp_servers`: list of MCP Gateway URLs
9. `secrets`: per-agent SecretGroup name, default `<name>-hermes-secrets`
10. `slack.channels`: optional Slack channel/group/DM ID allowlist; default unrestricted
11. `slack.users`: optional Slack user ID allowlist; default unrestricted
12. `snapshot`: optional artifact snapshot config with `ml_repo` and `artifact_name`
13. `hermes.yaml`: written or updated in the user's project
14. Slack app manifest: generated from `hermes.yaml`
15. Slack app: manually created and installed by the user
16. SecretGroup: manually filled by the user
17. live validation: passed with TrueFoundry credentials
18. deployment: compiled and applied
19. health checks: service and Slack health reachable
20. Slack URLs: Events API and Interactivity verified
21. first message: real Slack mention receives a response

## Architecture Rules Learned From Production

- **One Slack app per agent is acceptable and preferred for now.** Avoid the one-app/multiple-handle user-group design unless Slack officially exposes the right app-owned handles for this use case.
- **No Socket Mode.** TrueFoundry services must use HTTP request URLs:
  - `https://<host>/slack/events`
  - `https://<host>/slack/interactions`
- **OAuth is not required for one workspace / one app.** Users create/install the Slack app manually, then store `SLACK-BOT-TOKEN` and `SLACK-SIGNING-SECRET` in the SecretGroup.
- **Mention-only in channels.** In public/private channels and channel threads, the bot should run only on a direct mention. DMs may respond without mention.
- **Slack access allowlists are optional.** If `slack.channels` is omitted or empty, the agent can respond in any Slack channel or DM where the app is present. If it is set, only those Slack channel/group/DM IDs can trigger it. If `slack.users` is omitted or empty, any Slack user can trigger it. If it is set, only those Slack user IDs can trigger it.
- **Prompt layering is additive.** `hermes.yaml` instructions should append to Hermes' internal prompt through the executor, not replace `SOUL.md` and not get pasted into the user message as ordinary context.
- **MCP servers are URLs only.** They must be reachable through the TrueFoundry MCP Gateway. The executor derives toolset names, writes Hermes MCP config, runs discovery synchronously, and passes those toolsets into oneshot.
- **Skills are FQNs only.** Use `agent-skill:<tenant>/<repo>/<skill>:<version>`. The executor resolves presigned tarball URLs with `TFY_API_KEY`, extracts them into `$HERMES_HOME/skills`, and then starts Hermes.
- **Snapshots are volume-only unless configured.** If `snapshot` is omitted, the snapshotter only writes `/data/snapshots` on the state volume. If `snapshot` is set, it must contain `ml_repo` and `artifact_name`, and the snapshotter must log TrueFoundry artifact versions.
- **Slack streaming does not need WebSockets.** Use Slack assistant/thread APIs over HTTP. If provider/Hermes output is buffered, Slack still shows activity first and appends the final answer when ready.
- **A thinking card without a final answer is a bug.** Check Slack stream finalization, final markdown text formatting, and duplicate final-send paths before blaming the model.
- **Duplicate runs usually mean duplicate Slack event routing.** Check event id dedupe, bot-message ignores, assistant-thread follow-up handling, and whether both mention and message handlers are firing for the same Slack event.

## References

- Read `references/deployment-example.md` when creating or reviewing a concrete `hermes.yaml`, generated SecretGroup scaffold, or Slack app setup.
- Read `references/session-smoke-test.md` before declaring a deployed agent healthy.

## TrueFoundry Deploy Skill Routing

When TrueFoundry deploy skills from `truefoundry/tfy-deploy-skills` are available, use them for platform operations instead of reimplementing deployment mechanics in this skill. Keep `hermes.yaml` and `npx @truefoundry/tfy-hermes-agent` as the source of truth for Hermes-specific compilation.

Preferred routing:

- Use `truefoundry-status` before live operations to confirm `TFY_BASE_URL` or `TFY_HOST`, `TFY_API_KEY`, and API connectivity.
- Use `truefoundry-workspaces` when the target `workspace_fqn` is missing or uncertain.
- Use `truefoundry-secrets` for SecretGroup creation, placeholder key creation, and key existence checks. Still never ask the user to paste secret values into chat.
- Use `truefoundry-ml-repos` to confirm or discover the ML Repo used by `snapshot.ml_repo`.
- Use `truefoundry-deploy` for applying compiled `state`, `controller`, `executor`, and `snapshotter` manifests when available.
- Use `truefoundry-monitor` or `truefoundry-applications` to wait for controller rollout and inspect component health.
- Use `truefoundry-logs` for controller/executor/snapshotter failures.
- Use `truefoundry-service-test` for `/api/health`, `/slack/health`, `/v1/models`, and session smoke tests when it fits the available tooling.

If those skills are not installed, continue with the explicit `npx @truefoundry/tfy-hermes-agent`, `tfy apply`, `curl`, and log-inspection commands in this skill. Do not block onboarding just because the deploy skills are unavailable.

## Deploy Dependency Order

Some resources can be prepared in parallel, but runtime readiness has dependencies:

```text
hermes.yaml
  -> local validation
  -> Slack manifest generation
  -> Slack app manually created and installed
  -> SecretGroup manually created/filled
  -> live validation
  -> compile TFY manifests
  -> confirm secrets + apply state + controller
  -> wait for API health
  -> configure/verify Slack Event + Interactivity URLs
  -> apply/update executor + snapshotter
  -> first Slack mention test
```

Parallel-safe:

- Generate Slack manifest while preparing the SecretGroup.
- Create or confirm secrets and state before the controller service exists.
- Compile manifests anytime after `hermes.yaml` is valid.

Serial requirements:

- Slack URL verification requires deployed API health.
- Executor test requires controller service, SecretGroup values, and executor job version deployed.
- MCP/skill verification requires executor execution, not just compiler validation.

## Conversation Flow

Start by identifying the first missing state item and ask only that.

Examples:

- "What should the Slack handle be? Example: `devrel-assistant`."
- "Which TrueFoundry workspace FQN should this deploy to?"
- "What public host should Slack call for this agent? I can infer it if `TFY_HOST`, `TFY_BASE_URL`, or `TFY_SECRET_TENANT` is set."
- "What should this agent do? Give me the operating instructions, not just a title."
- "Should this agent be restricted to specific Slack channels? Send Slack channel IDs like `C...` or say `all`."
- "Should this agent be restricted to specific Slack users? Send Slack user IDs like `U...` or say `all`."

When asking about optional lists:

- For skills, accept `none`, an empty list, or full FQNs only.
- For MCP servers, accept `none`, an empty list, or URLs reachable through MCP Gateway only.
- For Slack channels, accept `all`, `none`, an empty list, or Slack IDs starting with `C`, `G`, or `D`.
- For Slack users, accept `all`, `none`, an empty list, or Slack IDs starting with `U` or `W`.
- If the user gives names instead of FQNs or URLs, pause and ask for the exact values or offer to look them up if tooling is available.
- Only write the `slack` block when at least one allowlist is non-empty; otherwise omit it and rely on the default open Slack access.

When all manifest fields are known, write or update `hermes.yaml`:

```yaml
name: devrel-assistant

workspace_fqn: tfy-ea-dev-eo-az:sai-ws

description: Helps with DevRel launches, event follow-ups, and dashboard analysis.

instructions: |
  You are the DevRel assistant. Be concise, operational, and evidence-driven.
  Prefer concrete next steps, cite available context, and call out missing inputs.

model: openai-main/gpt-5.5

secrets: devrel-assistant-hermes-secrets

snapshot:
  ml_repo: devrel-assistant
  artifact_name: devrel-assistant-state-snapshots

# Optional. Omit this block when Slack access is unrestricted.
slack:
  channels:
    - C0123456789
  users:
    - U0123456789

skills:
  - agent-skill:tfy-eo/sai-mlrepo/humanizer:1

mcp_servers:
  - https://mcp-gateway.example.com/servers/posthog
```

Then immediately run local validation:

```bash
npx @truefoundry/tfy-hermes-agent validate hermes.yaml --skip-live-checks
```

Fix manifest errors yourself if possible. Ask the user only when the fix changes product intent or requires a missing value.

## Manual Stop 1: Slack App

After local validation passes, generate the Slack manifest:

```bash
npx @truefoundry/tfy-hermes-agent slack-manifest hermes.yaml > slack-app-manifest.json
```

Then stop and give exactly one manual task:

"Create the Slack app from `slack-app-manifest.json`, install it in the intended workspace, then come back and say it is installed. URL verification may fail until the service is deployed; that is expected."

Do not continue to secrets or deployment until the user confirms the Slack app exists.

Expected Slack URLs come from `host`:

```text
https://<host>/slack/events
https://<host>/slack/interactions
```

## Manual Stop 2: SecretGroup

After the user confirms the Slack app exists, generate rendered manifests if needed:

```bash
npx @truefoundry/tfy-hermes-agent compile hermes.yaml
```

If `truefoundry-secrets` is available and local TrueFoundry credentials are configured, create the SecretGroup scaffold keys for the user with placeholders. Otherwise, ask the user to create or update it manually.

Then stop and give exactly one manual task:

"Create or update the TrueFoundry SecretGroup named `<secrets>` from the generated scaffold. It should contain exactly these keys: `SLACK-BOT-TOKEN`, `SLACK-SIGNING-SECRET`, `HARNESS-INTERNAL-TOKEN`, `TFY_GATEWAY_URL`, `TFY_API_KEY`, and `TFY_HOST`. The compiler generates `HARNESS-INTERNAL-TOKEN` for new agents. Leave that generated value unless rotating the agent. Fill the other placeholders in TrueFoundry directly, not in chat. Tell me when the SecretGroup is ready."

Do not ask the user to paste the values.

Secret key purpose:

- `SLACK-BOT-TOKEN`: Slack bot token from the installed Slack app.
- `SLACK-SIGNING-SECRET`: Slack signing secret from the Slack app.
- `HARNESS-INTERNAL-TOKEN`: private shared secret between controller service and executor callbacks.
- `TFY_GATEWAY_URL`: OpenAI-compatible model gateway URL.
- `TFY_API_KEY`: one TrueFoundry API key used for platform calls, MCP/skill resolution, model gateway calls, and `/v1/*` Bearer auth.
- `TFY_HOST`: TrueFoundry tenant/control-plane host, kept with the agent for platform calls and future migrations.

## Live Validation

After the user confirms the SecretGroup is ready, run live validation if local TrueFoundry credentials exist:

```bash
npx @truefoundry/tfy-hermes-agent validate hermes.yaml
```

If `truefoundry-status`, `truefoundry-workspaces`, `truefoundry-secrets`, or related deploy skills are available, use them to resolve live validation failures before asking the user.

If credentials are missing, stop with one task:

"Set `TFY_BASE_URL` and `TFY_API_KEY` in this terminal, or run the validation command locally and send me whether it passed."

Live validation should confirm:

- no controller, executor, or snapshotter name collision, unless `--update` is intended
- no host collision
- SecretGroup exists and contains required keys
- MCP server URLs are visible through TrueFoundry MCP Gateway
- skills are valid FQNs
- `snapshot.ml_repo` exists and is accessible, if `snapshot` is configured

Resolve failures in-place when possible. If a failure requires user choice, ask only that choice.

## Deploy

Deploy only after live validation passes:

```bash
npx @truefoundry/tfy-hermes-agent deploy hermes.yaml
```

If `truefoundry-deploy` and `truefoundry-monitor` are available, use them to apply and monitor the compiled manifests. Preserve the compiler's deploy ordering and keep the generated SecretGroup scaffold out of automatic deploy unless the user explicitly asked to create placeholders.

Use `--update` only when the user has confirmed they want to replace the running deployment. `--update` redeploys the controller service and executor job in-place and can interrupt in-flight Slack requests:

```bash
npx @truefoundry/tfy-hermes-agent deploy hermes.yaml --update
```

Expected generated resources:

```text
<name>-controller
<name>-executor
<secrets>
<name>-state
<name>-snapshotter
```

If `snapshot` is configured, the snapshotter job should log each state snapshot to the configured artifact:

```text
artifact:<tenant>/<snapshot.ml_repo>/<snapshot.artifact_name>:<version>
```

The deployment builds from the `main` branch of this package by default. Only override `HERMES_SOURCE_REF` if the user is explicitly testing an unmerged branch, and unset it after the test:

```bash
# Only when testing an unmerged branch
export HERMES_SOURCE_REF=<branch-or-commit>
# unset HERMES_SOURCE_REF after the test
```

## Health Checks

After deploy, run health checks yourself:

```bash
curl -fsS https://<host>/api/health
curl -fsS https://<host>/slack/health
curl -fsS https://<host>/v1/models
```

Expected `/slack/health` includes:

- `botTokenConfigured: true`
- `signingSecretConfigured: true`
- `oauthConfigured: false` (one-app-per-agent flow does not need Slack OAuth)
- `createUsergroups: false`
- `requireChannelDeployment: false`

If health fails, inspect TrueFoundry application rollout and logs before returning to Slack.

Prefer `truefoundry-applications`, `truefoundry-monitor`, `truefoundry-logs`, and `truefoundry-service-test` for these checks when available.

Before claiming the deployment works, run or verify at least one backend session test against the agent API. The run diagnostics should show:

- `manifestSystemPromptConfigured: true`
- correct `mcpServerCount`
- expected MCP `toolsets`
- expected `skillCount`
- `openaiBaseUrlConfigured: true`
- `openaiApiKeyConfigured: true`
- snapshotter logs include `local snapshot written`; if `snapshot` is configured, they also include `artifact snapshot written`

For MCP-backed agents, ask a smoke-test question that forces a tool call, then inspect events for `tool_start` and `tool_complete`.

Run the multi-session smoke test before Slack handoff:

1. Create session 1 and send 10 turns.
2. Create session 2 and send 5 turns.
3. Return to session 1 and send one more turn; confirm it preserves session 1 context.
4. Run one session 1 turn and one session 2 turn in parallel; both should complete without cross-session leakage.
5. Confirm every completed run has a final result, not just Hermes activity/thinking events.

## Manual Stop 3: Slack URL Verification

When health checks pass, stop with one manual task:

"Go back to the Slack app settings, verify the Event Subscriptions and Interactivity URLs, reinstall the app if Slack says scopes changed, and invite the app to the target channel. Tell me when Slack accepts both URLs."

Do not proceed until the user confirms Slack accepts both URLs.

## Manual Stop 4: First Message

Ask the user to send one real Slack mention:

```text
@<name> hello, summarize what you can do
```

Then ask for only the result. If it fails, troubleshoot based on the symptom:

While the user sends the first request, monitor controller/executor logs or run events. Confirm the Slack webhook arrives, exactly one run is created, the executor starts, and the final Slack response is posted.

- Slack URL verification fails: confirm API health, `/slack/health`, and same-app signing secret.
- Slack auth error: reinstall the app and refresh `SLACK-BOT-TOKEN` in the SecretGroup.
- No channel response: invite the Slack app to the channel and confirm Slack scopes.
- Agent responds without a mention in a channel: fix routing so only DMs or directly-mentioned channel messages trigger runs.
- Run starts but does not complete: inspect `<name>-executor` job logs and gateway credentials.
- Thinking completes but no final output: inspect Slack assistant stream completion and final message chunk formatting.
- Two runs for one Slack message: inspect Slack event dedupe and ensure bot/self messages are ignored.
- Agent says MCP tools are missing: verify `mcp_servers` in `hermes.yaml`, executor diagnostic toolsets, and Hermes MCP discovery before oneshot.
- Agent ignores personality/instructions: verify the executor is appending manifest instructions as an ephemeral system prompt instead of only including them in the user message.
- `snapshot` is configured but snapshotter only writes `/data/snapshots`: verify `snapshot.ml_repo`, `HERMES_SNAPSHOT_ML_REPO`, `TFY_HOST`, and `TFY_API_KEY`.
- MCP validation fails: use only MCP server URLs registered and reachable through TrueFoundry MCP Gateway.
- Skill validation fails: use full skill FQNs like `agent-skill:<tenant>/<repo>/<skill>:<version>`.

## Completion Criteria

The onboarding is complete only when all are true:

- `hermes.yaml` exists in the user's project.
- Local and live validation pass.
- Slack app is created, installed, and backed by the per-agent SecretGroup.
- TrueFoundry secrets, state, controller, executor, and snapshotter are deployed.
- Snapshotter successfully writes a local state snapshot, and writes at least one TrueFoundry artifact version when `snapshot` is configured.
- `/api/health`, `/slack/health`, and `/v1/models` respond.
- Slack Event and Interactivity URLs are verified.
- A real Slack mention receives a successful Hermes response.
