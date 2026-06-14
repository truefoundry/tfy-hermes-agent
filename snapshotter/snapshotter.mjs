import { copyFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

const stateRoot = process.env.HARNESS_STATE_DIR || "/data/state";
const snapshotRoot = process.env.HERMES_SNAPSHOT_DIR || "/data/snapshots";
const retainCount = Number(process.env.HERMES_SNAPSHOT_RETAIN_COUNT || 50);

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
  console.log(`snapshot written: ${target}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
