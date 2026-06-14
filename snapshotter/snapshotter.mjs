import { copyFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const stateRoot = process.env.HARNESS_STATE_DIR || "/data/state";
const snapshotRoot = process.env.HERMES_SNAPSHOT_DIR || "/data/snapshots";
const retainCount = Number(process.env.HERMES_SNAPSHOT_RETAIN_COUNT || 50);
const artifactUploadDisabled = process.env.HERMES_SNAPSHOT_DISABLE_ARTIFACT_UPLOAD === "1";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function pruneSnapshots() {
  if (!Number.isFinite(retainCount) || retainCount <= 0) return;
  const entries = await readdir(snapshotRoot).catch(() => []);
  const snapshots = [];
  for (const entry of entries) {
    if (!/^state-\d{4}-\d{2}-\d{2}T.*\.json$/.test(entry)) continue;
    const file = path.join(snapshotRoot, entry);
    const info = await stat(file).catch(() => null);
    if (info?.isFile()) snapshots.push({ file, mtimeMs: info.mtimeMs });
  }
  snapshots.sort((a, b) => b.mtimeMs - a.mtimeMs);
  await Promise.all(snapshots.slice(retainCount).map((item) => rm(item.file, { force: true })));
}

async function main() {
  const source = path.join(stateRoot, "state.json");
  await mkdir(snapshotRoot, { recursive: true });
  await stat(source);
  const target = path.join(snapshotRoot, `state-${timestamp()}.json`);
  await copyFile(source, target);
  await pruneSnapshots();
  console.log(`local snapshot written: ${target}`);
  if (artifactUploadDisabled) {
    console.log("artifact upload disabled by HERMES_SNAPSHOT_DISABLE_ARTIFACT_UPLOAD=1");
    return;
  }
  const result = await logArtifact(target);
  console.log(`artifact snapshot written: ${result}`);
}

function logArtifact(snapshotFile) {
  return new Promise((resolve, reject) => {
    const child = spawn("python3", [path.join("snapshotter", "log_artifact.py"), snapshotFile], {
      cwd: repoRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`artifact upload failed with ${code}: ${stderr || stdout}`));
    });
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
