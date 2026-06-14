import json
import os
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path


STATE_ROOT = Path(os.environ.get("HARNESS_STATE_DIR", "/data/state"))
SNAPSHOT_ROOT = Path(os.environ.get("HERMES_SNAPSHOT_DIR", "/data/snapshots"))
RETAIN_COUNT = int(os.environ.get("HERMES_SNAPSHOT_RETAIN_COUNT", "50"))
ARTIFACT_UPLOAD_DISABLED = os.environ.get("HERMES_SNAPSHOT_DISABLE_ARTIFACT_UPLOAD") == "1"


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


def timestamp() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z").replace(":", "-").replace(".", "-")


def prune_snapshots() -> None:
    if RETAIN_COUNT <= 0:
        return
    snapshots = sorted(
        (path for path in SNAPSHOT_ROOT.glob("state-*.json") if path.is_file()),
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    )
    for path in snapshots[RETAIN_COUNT:]:
        path.unlink(missing_ok=True)


def log_artifact(snapshot_file: Path) -> dict:
    from truefoundry.ml import ArtifactPath, get_client

    ml_repo = required_env("HERMES_SNAPSHOT_ML_REPO")
    artifact_name = required_env("HERMES_SNAPSHOT_ARTIFACT_NAME")
    agent = os.environ.get("HERMES_AGENT_HANDLE", artifact_name)
    workspace_fqn = os.environ.get("TFY_WORKSPACE_FQN", "")

    set_env_alias("TRUEFOUNDRY_HOST", "TFY_HOST")
    set_env_alias("TRUEFOUNDRY_API_KEY", "TFY_API_KEY")
    set_env_alias("MLF_HOST", "TFY_HOST")
    set_env_alias("MLF_API_KEY", "TFY_API_KEY")

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
    return {
        "artifact_fqn": getattr(artifact_version, "fqn", None),
        "artifact_version": getattr(artifact_version, "version", None),
        "artifact_name": artifact_name,
        "ml_repo": ml_repo,
    }


def main() -> None:
    source = STATE_ROOT / "state.json"
    if not source.is_file():
        raise RuntimeError(f"state file not found: {source}")

    SNAPSHOT_ROOT.mkdir(parents=True, exist_ok=True)
    target = SNAPSHOT_ROOT / f"state-{timestamp()}.json"
    shutil.copyfile(source, target)
    prune_snapshots()
    print(f"local snapshot written: {target}")

    if ARTIFACT_UPLOAD_DISABLED:
        print("artifact upload disabled by HERMES_SNAPSHOT_DISABLE_ARTIFACT_UPLOAD=1")
        return

    result = log_artifact(target)
    print(f"artifact snapshot written: {json.dumps(result, separators=(',', ':'))}")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
