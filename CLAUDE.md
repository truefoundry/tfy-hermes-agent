# CLAUDE.md — Claude Code project notes for tfy-hermes-agent

This file is read by Claude Code when it opens this repo. Keep it short.

## What this repo is

A thin TrueFoundry deployment wrapper around the OSS [Hermes Agent](https://github.com/NousResearch/hermes-agent) (`hermes-agent` on PyPI). Three runtime pieces + a CLI:

- `controller/controller.mjs` — long-running Node service. Handles Slack webhooks, OpenAI-compatible `/v1/*`, and per-run executor callbacks. Owns the only persistent state (SQLite on a controller-only PVC).
- `executor/executor.mjs` — per-turn TrueFoundry Job. Decodes a signed payload, downloads the session DB, runs `hermes -z`, uploads the updated DB, posts results back.
- `bin/tfy-hermes-agent.mjs` — CLI. Two commands: `init` (interactive wizard) and `deploy` (validate + apply manifests).
- `skills/deploy-hermes-slack-agent/` — runbook used by AI coding agents to drive an end-to-end deploy.

## Don't do these things

- **Don't vendor Hermes source here.** Hermes is a pip dep (`hermes-agent[mcp]==0.16.0`) pulled into the executor image. Wrapping it is fine; modifying its internals is not.
- **Don't store secrets in plain files.** All secrets flow through TrueFoundry SecretGroups via `tfy-secret://...` env references. The 4 keys are `TFY-API-KEY`, `HERMES-RUN-TOKEN-SECRET`, `SLACK-BOT-TOKEN`, `SLACK-SIGNING-SECRET`. **Hyphens only** — TrueFoundry rejects underscores in secret key names.
- **Don't write to the controller's volume from the executor.** The executor uses its container's ephemeral FS. Session DBs travel over HTTP.
- **Don't use the TrueFoundry Python SDK.** Use `tfy` CLI, the deploy skills, or raw REST endpoints (`/api/svc/v1/*`, `/api/ml/v1/*`). The SDK has Pydantic v1 issues on Python 3.13+.
- **Don't add a new env knob for something `hermes.yaml` could express.** Prefer manifest fields.
- **Don't try TrueFoundry's ingress-level `auth: { type: basic_auth }`** on the same port that serves Slack. Slack webhooks can't speak Basic. We tried; we reverted. See git log for `Wire ingress-level basic_auth` and its revert.

## Auth model

Three credentials, each scoped:

| Surface | Credential | Where it lives |
|---|---|---|
| `/v1/*` inbound (clients) | `Authorization: Bearer <TFY_API_KEY>` | `TFY-API-KEY` in the agent's SecretGroup |
| `/api/internal/*` (executor callbacks) | `Authorization: Bearer <per-run HMAC>` | Minted per turn from `HERMES-RUN-TOKEN-SECRET` |
| `/slack/*` (Slack webhooks) | `X-Slack-Signature` HMAC of body | Verified with `SLACK-SIGNING-SECRET` |

`TFY-API-KEY` is reused for three things — control-plane writes (job dispatch, skill fetch), the LLM gateway bearer, and inbound `/v1/*`. The token needs **read** permission on the workspace's apps too — a write-only Virtual Account PAT will silently fail at `triggerJob` because the controller can't look up the executor's deployment ID.

## Common tasks

- **Run tests:** `npm run check` (24 tests, syntax checks, ~500ms).
- **Build images locally:** `docker build -f Dockerfile.controller -t hermes-controller:local .` and `docker build -f Dockerfile.executor -t hermes-executor:local .`. Both build clean on Apple Silicon and linux/amd64; if a remote build fails and a local build passes, the platform's build farm is the suspect (start by trying the commit SHA in `version:` instead of a branch name with slashes — TF's git puller has issues with branch names containing `/`).
- **Smoke-test the controller:** boot with `docker run -e TFY_API_KEY=x -e HERMES_RUN_TOKEN_SECRET=y -e HERMES_SKIP_EXECUTOR_DISPATCH=1 -p 8787:8787 hermes-controller:local` and curl `/api/health`.
- **Emit manifests without applying:** `TFY_HOST=https://tfy-eo.truefoundry.cloud node bin/tfy-hermes-agent.mjs deploy examples/agent.hermes.yaml --skip-live-checks --emit-manifests /tmp/out`.
- **Force a controller restart without a rebuild** (to pick up new SecretGroup values): re-`tfy apply -f <controller-manifest>` with the same file. Rolling restart, ~30s, no build.

## Lessons learned the hard way (so far)

These all happened during the first manual rollout (Jun 14–15 2026). Search the commit log if you hit something similar.

1. **TF's git puller doesn't accept slashes in branch refs** for `image.build_source.branch_name`. Use a commit SHA in `hermes.yaml`'s `version:` field if your branch is `docs/skills-install-command`-style. Branches like `main`, `staging`, `dev` work fine.
2. **`workspace_fqn` query param is silently ignored** by `/api/svc/v1/apps`. Always use `workspaceFqn` (camelCase). Same applies to most filter params — they're camelCase server-side.
3. **`tfy apply` only triggers a rebuild for `image.type: image`** (pre-built). For `image.type: build` (git source) you must use `tfy deploy --force`. `tfy apply` will accept the manifest and silently never build.
4. **A SecretGroup needs `integration_fqn` and `collaborators`** at create time. The CLI emits a scaffold with these populated for the tenant's default Azure Vault — adjust if your tenant uses a different secret store.
5. **`/v1/*` clients can't use a write-only PAT.** The controller calls `tfyGet('/api/svc/v1/apps?...')` to find the executor's deployment ID; this requires `read` on the workspace's apps. A Virtual Account scoped to `application:read` + `application:trigger` works.

## Branch / PR conventions

- Branch off `main`, push to `docs/<topic>` or `feat/<topic>` etc.
- Run `npm run check` before pushing.
- PR title under 70 chars; details in body. Co-author with Claude when assisted.
- Don't push directly to `main`.
