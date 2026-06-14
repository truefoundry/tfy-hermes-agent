import json
import os
import sys
from pathlib import Path

from truefoundry.ml import ArtifactPath, get_client


def set_env_alias(target: str, *sources: str) -> None:
    if os.environ.get(target):
        return
    for source in sources:
        value = os.environ.get(source, "").strip()
        if value:
            os.environ[target] = value
            return


def required_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


def main() -> None:
    if len(sys.argv) != 2:
        raise RuntimeError("usage: log_artifact.py <snapshot-file>")

    snapshot_file = Path(sys.argv[1]).resolve()
    if not snapshot_file.is_file():
        raise RuntimeError(f"snapshot file not found: {snapshot_file}")

    ml_repo = required_env("HERMES_SNAPSHOT_ML_REPO")
    artifact_name = required_env("HERMES_SNAPSHOT_ARTIFACT_NAME")
    agent = os.environ.get("HERMES_AGENT_HANDLE", artifact_name)
    workspace_fqn = os.environ.get("TFY_WORKSPACE_FQN", "")

    set_env_alias("TRUEFOUNDRY_HOST", "TFY_HOST", "TFY_BASE_URL")
    set_env_alias("TRUEFOUNDRY_API_KEY", "TFY_API_KEY", "TFY_PLATFORM_API_KEY")
    set_env_alias("MLF_HOST", "TFY_HOST", "TFY_BASE_URL")
    set_env_alias("MLF_API_KEY", "TFY_API_KEY", "TFY_PLATFORM_API_KEY")

    client = get_client()
    artifact_version = client.log_artifact(
        ml_repo=ml_repo,
        name=artifact_name,
        artifact_paths=[ArtifactPath(src=str(snapshot_file), dest=snapshot_file.name)],
        description=f"Hermes state snapshot for {agent}",
        metadata={
            "agent": agent,
            "workspace_fqn": workspace_fqn,
            "snapshot_file": snapshot_file.name,
            "snapshot_size_bytes": snapshot_file.stat().st_size,
            "snapshotter": "tfy-hermes-agent",
        },
        progress=False,
    )

    print(json.dumps({
        "artifact_fqn": getattr(artifact_version, "fqn", None),
        "artifact_version": getattr(artifact_version, "version", None),
        "artifact_name": artifact_name,
        "ml_repo": ml_repo,
    }))


if __name__ == "__main__":
    main()
