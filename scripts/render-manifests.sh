#!/usr/bin/env bash
set -euo pipefail

: "${TFY_WORKSPACE_FQN:?TFY_WORKSPACE_FQN is required (cluster:workspace)}"
: "${TFY_SECRET_TENANT:?TFY_SECRET_TENANT is required (the SecretGroup tenant slug)}"
: "${TFY_BASE_URL:?TFY_BASE_URL is required (TrueFoundry control-plane URL)}"
: "${HERMES_AGENT_SECRET_GROUP:?HERMES_AGENT_SECRET_GROUP is required (per-agent SecretGroup name)}"
: "${HERMES_API_HOST:?HERMES_API_HOST is required (exposed hostname for the service)}"
: "${HERMES_REPO_URL:?HERMES_REPO_URL is required (the git URL of this repo)}"
: "${HERMES_SOURCE_REF:?HERMES_SOURCE_REF is required (branch, tag, or commit to build)}"
: "${HERMES_AGENT_HANDLE:?HERMES_AGENT_HANDLE is required (e.g. devrel-assistant)}"

: "${HERMES_AGENT_NAME:=$HERMES_AGENT_HANDLE}"
: "${HERMES_AGENT_DESCRIPTION:=Standalone Hermes Slack agent}"
: "${HERMES_AGENT_INSTRUCTIONS:=}"
: "${HERMES_AGENT_SKILLS:=}"
: "${HERMES_AGENT_MCP_SERVERS:=}"
: "${HERMES_SLACK_ALLOWED_CHANNELS:=}"
: "${HERMES_SLACK_ALLOWED_USERS:=}"
: "${HERMES_MODEL:=openai-main/gpt-5.5}"
: "${HERMES_SNAPSHOT_ML_REPO:=}"
: "${HERMES_SNAPSHOT_ARTIFACT_NAME:=}"
if [[ -n "$HERMES_SNAPSHOT_ML_REPO" ]]; then
  : "${HERMES_SNAPSHOT_ARTIFACT_NAME:=$HERMES_AGENT_HANDLE-state-snapshots}"
  HERMES_SNAPSHOT_DISABLE_ARTIFACT_UPLOAD=0
else
  HERMES_SNAPSHOT_DISABLE_ARTIFACT_UPLOAD=1
fi

export TFY_WORKSPACE_FQN TFY_SECRET_TENANT TFY_BASE_URL
export HERMES_AGENT_SECRET_GROUP HERMES_API_HOST HERMES_REPO_URL HERMES_SOURCE_REF
export HERMES_AGENT_HANDLE HERMES_AGENT_NAME HERMES_AGENT_DESCRIPTION HERMES_AGENT_INSTRUCTIONS
export HERMES_AGENT_SKILLS HERMES_AGENT_MCP_SERVERS HERMES_MODEL
export HERMES_SLACK_ALLOWED_CHANNELS HERMES_SLACK_ALLOWED_USERS
export HERMES_SNAPSHOT_ML_REPO HERMES_SNAPSHOT_ARTIFACT_NAME HERMES_SNAPSHOT_DISABLE_ARTIFACT_UPLOAD

mkdir -p .rendered
for file in manifests/*.yaml; do
  name="$(basename "$file")"
  envsubst < "$file" > ".rendered/$name"
done

if grep -R '\${[A-Za-z_][A-Za-z0-9_]*}' .rendered >/dev/null; then
  echo "Unresolved placeholders remain in .rendered manifests" >&2
  grep -R '\${[A-Za-z_][A-Za-z0-9_]*}' .rendered >&2
  exit 1
fi
