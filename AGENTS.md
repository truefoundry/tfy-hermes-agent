# AGENTS.md

- Keep this repo focused on the reusable TrueFoundry Hermes deployment package.
- Do not vendor the upstream Hermes Agent source tree here.
- Secrets must remain TrueFoundry SecretGroup references in manifests.
- `README.md` is the end-user setup runbook; `skills/deploy-hermes-slack-agent/` is the operator runbook for AI agents.
- Treat `hermes.yaml` plus the CLI manifest builders (`bin/tfy-hermes-agent.mjs`) as the source of truth for generated Slack and TrueFoundry manifests. `init` prompts required fields then all optional fields (Enter to skip); `deploy` auto-provisions the SecretGroup and `TFY-API-KEY` / `HERMES-RUN-TOKEN-SECRET`.
- Keep runtime naming consistent: the runtime is `controller` and `executor` only. Use those names for folders, entrypoint files, Dockerfiles, and generated manifest component names.
- Keep generated env vars minimal; prefer `hermes.yaml` fields over new env knobs, and do not add alias env names for the same setting. When you remove a code path that read an env var, also remove the env var from the relevant manifest builder.
- Validate changed JavaScript with `npm run check` before committing. Smoke the CLI with `tfy-hermes-agent deploy devrel-assistant --skip-live-checks --emit-manifests /tmp/hermes-out` (requires `tfy login` or `TFY_HOST`/`TFY_API_KEY`).
- TrueFoundry services do not support WebSockets; Slack support must use the HTTP Events API plus outbound Slack Web API calls, not Socket Mode or any WebSocket-dependent flow.
- Do not use the TrueFoundry Python SDK from CLI or runtime code. Use the `tfy` CLI, the `tfy-deploy-skills` skills, or raw REST against `/api/svc/v1/*` and `/api/ml/v1/*`. The SDK has Pydantic v1 issues on modern Python.
- SecretGroup key names must be hyphenated (no underscores) — the platform rejects underscores in secret keys at create time. Env-var names inside the container can use underscores; do the mapping in the manifest builder.
- TrueFoundry's git puller (used by `image.type: build`) rejects branch refs containing `/`. The compiler accepts `version:` as a branch, tag, or commit SHA; document that slashed branches must be deployed by SHA.
- Most `/api/svc/v1/*` filter query params are camelCase (`workspaceFqn`, `applicationName`). Snake-case variants are silently ignored and return unfiltered results.

## Cursor Cloud specific instructions

- Dependencies are pure Node (`>=22`, already present). The startup update script runs `npm install` at the root and in `executor/`. Lint+test is `npm run check` (`node --check` syntax checks + `npm test`, 31 tests). There is no ESLint.
- Run the controller standalone for dev without TrueFoundry: `TFY_API_KEY=test-key HERMES_RUN_TOKEN_SECRET=test-secret STATE_ROOT=/tmp/hermes-state PORT=8787 HERMES_SKIP_EXECUTOR_DISPATCH=1 node controller/controller.mjs`. `TFY_API_KEY` and `HERMES_RUN_TOKEN_SECRET` are required at boot (any value); set `STATE_ROOT` to a writable dir since the default `/data` is not writable as a non-root user; `HERMES_SKIP_EXECUTOR_DISPATCH=1` stops the controller from trying to dispatch real TrueFoundry executor jobs.
- The `executor` cannot run end-to-end locally (it needs the `hermes-agent` pip package and a TrueFoundry job dispatch + LLM gateway). To exercise a full controller turn locally, simulate the executor's HTTP callbacks: mint a per-run HMAC token with `signRunToken({ runId, secret })` from `controller/tokens.mjs` (secret = `HERMES_RUN_TOKEN_SECRET`), then POST `/api/internal/runs/<runId>/events` and `/api/internal/runs/<runId>/complete`. Recover `runId` from an OpenAI id with `runIdFromOpenAIId` in `controller/openai-adapter.mjs` (e.g. `resp_abc` -> `run_abc`).
- CLI compile-only preview (`deploy <name> --skip-live-checks --emit-manifests <dir>`) needs no TrueFoundry credentials, but still requires `TFY_HOST` to be set (or `host:` in the agent yaml) to infer the tenant; otherwise it exits with "host is required".
