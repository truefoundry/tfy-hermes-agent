# AGENTS.md

- Keep this repo focused on the reusable TrueFoundry Hermes deployment package.
- Do not vendor the upstream Hermes Agent source tree here.
- Secrets must remain TrueFoundry SecretGroup references in manifests.
- Prefer small, explicit YAML templates that can be copied into another project.
- Validate changed JavaScript with `npm run check` and render manifests before committing.
