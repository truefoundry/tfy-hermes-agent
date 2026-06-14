# AGENTS.md

- Keep this repo focused on the reusable TrueFoundry Hermes deployment package.
- Do not vendor the upstream Hermes Agent source tree here.
- Secrets must remain TrueFoundry SecretGroup references in manifests.
- Prefer small, explicit YAML templates that can be copied into another project.
- Validate changed JavaScript with `npm run check` and render manifests before committing.
- TrueFoundry services do not support WebSockets; Slack support must use the HTTP Events API plus outbound Slack Web API calls, not Socket Mode or any WebSocket-dependent flow.
