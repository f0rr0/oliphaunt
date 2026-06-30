import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const ARCHIVE_DIR = path.resolve(import.meta.dir, "../release/archive_dir.mjs");

export function fail(message) {
  console.error(`release-fixture-utils.mjs: ${message}`);
  process.exit(1);
}

export function parseCommonArgs(argv, description) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key.startsWith("--") || value === undefined || value.startsWith("--")) {
      fail(`${description}\nusage: --asset-dir <dir> --version <version>`);
    }
    args.set(key, value);
    index += 1;
  }
  const assetDir = args.get("--asset-dir");
  const version = args.get("--version");
  if (!assetDir || !version || args.size !== 2) {
    fail(`${description}\nusage: --asset-dir <dir> --version <version>`);
  }
  return { assetDir: path.resolve(assetDir), version };
}

export async function writeEntriesArchive(output, entries, modes = {}) {
  const stage = await fs.mkdtemp(path.join(os.tmpdir(), "oliphaunt-release-fixture-"));
  try {
    for (const [name, data] of Object.entries(entries).sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      const file = path.join(stage, ...name.split("/"));
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, data);
      await fs.chmod(file, modes[name] ?? 0o644);
    }
    await archiveDirectory(stage, output);
  } finally {
    await fs.rm(stage, { recursive: true, force: true });
  }
}

export async function archiveDirectory(source, output) {
  const result = spawnSync(process.execPath, [ARCHIVE_DIR, source, output], {
    stdio: "inherit",
  });
  if (result.status !== 0) {
    fail(`failed to create archive ${output}`);
  }
}

export async function writeChecksumManifest(assetDir, name) {
  const checksumAsset = path.join(assetDir, name);
  const dirents = await fs.readdir(assetDir, { withFileTypes: true });
  const files = dirents
    .filter((entry) => entry.isFile() && entry.name !== name)
    .map((entry) => entry.name)
    .sort();
  const lines = [];
  for (const file of files) {
    const digest = createHash("sha256")
      .update(await fs.readFile(path.join(assetDir, file)))
      .digest("hex");
    lines.push(`${digest}  ./${file}`);
  }
  await fs.writeFile(checksumAsset, `${lines.join("\n")}\n`, "utf8");
}
