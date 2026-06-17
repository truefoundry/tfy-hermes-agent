# CLAUDE.md — Claude Code project notes for tfy-hermes-agent

This file is read by Claude Code when it opens this repo. Keep it short.

## What this repo is

A thin TrueFoundry deployment wrapper around the OSS [Hermes Agent](https://github.com/NousResearch/hermes-agent) (`hermes-agent` on PyPI). Three runtime pieces + a CLI:

- `controller/controller.mjs` — long-running Node service. Handles Slack webhooks, OpenAI-compatible `/v1/*`, and per-run executor callbacks. Owns the only persistent state (SQLite on a controller-only PVC).
- `executor/executor.mjs` — turn runner for `truefoundry-job` (TF Job entrypoint). `executor/server.mjs` — internal HTTP service for `truefoundry-service`. Both decode a signed payload, shuttle the session DB, run Hermes, post results back.
- `bin/tfy-hermes-agent.mjs` — CLI. `init` (interactive wizard: required fields, executor backend, optional fields; `--api-only` for no Slack) and `deploy` (auto-provisions SecretGroup secrets, validate + apply manifests).
- `skills/deploy-hermes-slack-agent/` — runbook used by AI coding agents to drive an end-to-end deploy.

**Executor modes** (agent yaml `executor`, default `truefoundry-job`):

| Value | Turn runs in | Tool sandbox |
|---|---|---|
| `truefoundry-job` | Disposable TF Job | Job container |
| `truefoundry-service` | Long-lived executor Service | Hermes `terminal.backend: daytona` (default) |

`truefoundry-service` adds `DAYTONA-API-KEY` to the SecretGroup.

## Don't do these things

- **Don't vendor Hermes source here.** Hermes is a pip dep (`hermes-agent[mcp]==0.16.0`) pulled into the executor image. Wrapping it is fine; modifying its internals is not.
- **Don't store secrets in plain files.** All secrets flow through TrueFoundry SecretGroups via `tfy-secret://...` env references. Base keys: `TFY-API-KEY`, `HERMES-RUN-TOKEN-SECRET`, `SLACK-BOT-TOKEN`, `SLACK-SIGNING-SECRET`. Add `DAYTONA-API-KEY` when `executor: truefoundry-service`. **Hyphens only** — TrueFoundry rejects underscores in secret key names.
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

CLI auth: `deploy` reads `~/.truefoundry/credentials.json` from `tfy login` (`host`, `access_token`). Env vars override. Production: `tfy login --host <url> --api-key <virtual-account-pat>`.

## Common tasks

- **Run tests:** `npm run check` (syntax checks + unit tests, ~1s).
- **Build images locally:** `docker build -f Dockerfile.controller -t hermes-controller:local .` and `docker build -f Dockerfile.executor -t hermes-executor:local .`. Both build clean on Apple Silicon and linux/amd64; if a remote build fails and a local build passes, the platform's build farm is the suspect (start by trying the commit SHA in `version:` instead of a branch name with slashes — TF's git puller has issues with branch names containing `/`).
- **Emit manifests without applying:** run `init`, then `tfy-hermes-agent deploy <name> --skip-live-checks --emit-manifests /tmp/out` (after `tfy login` or with `TFY_HOST` set).
- **Force a controller restart without a rebuild** (to pick up new SecretGroup values): re-`tfy apply -f <controller-manifest>` with the same file. Rolling restart, ~30s, no build.

## Lessons learned the hard way (so far)

These all happened during the first manual rollout (Jun 14–15 2026). Search the commit log if you hit something similar.

1. **TF's git puller doesn't accept slashes in branch refs** for `image.build_source.branch_name`. Use a commit SHA in `hermes.yaml`'s `version:` field if your branch is `docs/skills-install-command`-style. Branches like `main`, `staging`, `dev` work fine.
2. **`workspace_fqn` query param is silently ignored** by `/api/svc/v1/apps`. Always use `workspaceFqn` (camelCase). Same applies to most filter params — they're camelCase server-side.
3. **`tfy apply` only triggers a rebuild for `image.type: image`** (pre-built). For `image.type: build` (git source) you must use `tfy deploy --force`. `tfy apply` will accept the manifest and silently never build.
4. **`deploy` auto-creates SecretGroups** via `/api/svc/v1/secret-groups` using the tenant's default secret-store `integrationId`. Fails if no integration is discoverable — then create manually in the UI.
5. **`/v1/*` clients can't use a write-only PAT.** The controller calls `tfyGet('/api/svc/v1/apps?...')` to find the executor's deployment ID; this requires `read` on the workspace's apps. A Virtual Account scoped to `application:read` + `application:trigger` works.

## Branch / PR conventions

- Branch off `main` for larger changes (`docs/<topic>`, `feat/<topic>`).
- Run `npm run check` before pushing.
- PR title under 70 chars; details in body. Co-author with Claude when assisted.
- Small fixes may land directly on `main`.
