# AGENTS.md

- Keep this repo focused on the reusable TrueFoundry Hermes deployment package.
- Do not vendor the upstream Hermes Agent source tree here.
- Secrets must remain TrueFoundry SecretGroup references in manifests.
- Keep `README.md` short and orientation-focused; put deployment runbooks in repo-local skills and references.
- Treat `hermes.yaml` plus the CLI manifest builders (`bin/tfy-hermes-agent.mjs`) as the source of truth for generated Slack and TrueFoundry manifests.
- Keep runtime naming consistent: the runtime is `controller` and `executor` only. Use those names for folders, entrypoint files, Dockerfiles, and generated manifest component names.
- Keep generated env vars minimal; prefer `hermes.yaml` fields over new env knobs, and do not add alias env names for the same setting. When you remove a code path that read an env var, also remove the env var from the relevant manifest builder.
- Validate changed JavaScript with `npm run check` before committing. Smoke the CLI against the example with `node bin/tfy-hermes-agent.mjs deploy examples/agent.hermes.yaml --skip-live-checks --emit-manifests /tmp/hermes-out` to confirm manifests still serialize.
- TrueFoundry services do not support WebSockets; Slack support must use the HTTP Events API plus outbound Slack Web API calls, not Socket Mode or any WebSocket-dependent flow.
