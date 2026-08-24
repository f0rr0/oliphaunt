import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "../test/fd-backed-spawn-sync.mjs";

import { currentProductVersionSync } from "./release-artifact-targets.mjs";
import { ROOT } from "./release-graph.mjs";
import { filesystemTreeRows, logicalTreeSha256 } from "./native-cluster-seed-contract.mjs";

const SCRIPT = path.join(ROOT, "tools/release/package-liboliphaunt-icu-data.sh");
const scratch = [];

afterEach(() => {
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporaryRoot() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-icu-package-test-"));
  scratch.push(directory);
  return directory;
}

function run(source, output, { env = process.env } = {}) {
  let icuDataTreeSha256;
  try {
    icuDataTreeSha256 = logicalTreeSha256(filesystemTreeRows(source));
  } catch {
    icuDataTreeSha256 = "a".repeat(64);
  }
  const seed = path.join(path.dirname(output), "icu-cluster-seed");
  mkdirSync(path.join(seed, "files/global"), { recursive: true });
  writeFileSync(path.join(seed, "files/PG_VERSION"), "18\n");
  writeFileSync(path.join(seed, "files/global/pg_control"), "control\n");
  writeFileSync(
    path.join(seed, "manifest.properties"),
    `schema=oliphaunt-runtime-resources-v1\nlayout=oliphaunt-cluster-seed-v1\nartifactRole=cluster-seed-icu\ncatalogProfile=icu\npostgresMajor=18\nphysicalFormat=native-pg18-v1\ncompatibilityKey=native-pg18-datum64-v1\ninitialSuperuser=postgres\nicuDataVersion=76.1\nicuDataForm=files-le\nicuDataTreeSha256=${icuDataTreeSha256}\nruntimeFeatures=icu\n`,
  );
  return spawnSync("bash", [SCRIPT, source, output, seed], {
    cwd: ROOT,
    encoding: "utf8",
    env,
  });
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

test("packages the portable ICU payload deterministically outside platform release artifacts", () => {
  const root = temporaryRoot();
  const source = path.join(root, "source", "icudt76l");
  const output = path.join(root, "output");
  mkdirSync(path.join(source, "coll"), { recursive: true });
  writeFileSync(path.join(source, "root.res"), "root\n");
  writeFileSync(path.join(source, "coll", "en.res"), "en\n");

  const first = run(path.dirname(source), output);
  expect(first.status, first.stderr).toBe(0);
  const version = currentProductVersionSync("liboliphaunt-native");
  const archive = path.join(output, `liboliphaunt-${version}-icu-data.tar.gz`);
  const firstDigest = sha256(archive);

  const listing = spawnSync("tar", ["-tzf", archive], { encoding: "utf8" });
  expect(listing.status, listing.stderr).toBe(0);
  const members = listing.stdout.split(/\r?\n/u).filter(Boolean);
  expect(members).toContain("share/icu/icudt76l/root.res");
  expect(members).toContain("cluster-seed/manifest.properties");
  expect(members).toContain("cluster-seed/files/PG_VERSION");
  expect(members).toContain("cluster-seed/files/global/pg_control");
  expect(members).toContain("package-size.tsv");
  expect(members).toContain("THIRD_PARTY_LICENSES/PostgreSQL-COPYRIGHT");
  expect(members).toContain("THIRD_PARTY_LICENSES/ICU-LICENSE");
  const sizeReport = spawnSync("tar", ["-xOzf", archive, "package-size.tsv"], { encoding: "utf8" });
  expect(sizeReport.status, sizeReport.stderr).toBe(0);
  expect(sizeReport.stdout).toMatch(/^kind\tid\textensions\tfiles\tbytes\npackage\ttotal\t-\t-\t[0-9]+\npackage\ticu-data\t-\t-\t[0-9]+\npackage\tcluster-seed-icu\t-\t-\t[0-9]+\n$/u);

  const second = run(path.dirname(source), output);
  expect(second.status, second.stderr).toBe(0);
  expect(sha256(archive)).toBe(firstDigest);
});

test("rejects empty or symlinked portable ICU inputs", () => {
  const root = temporaryRoot();
  const empty = path.join(root, "empty");
  const linked = path.join(root, "linked");
  const output = path.join(root, "output");
  mkdirSync(empty);
  expect(run(empty, output).status).not.toBe(0);

  mkdirSync(path.join(linked, "icudt76l"), { recursive: true });
  writeFileSync(path.join(linked, "payload.res"), "payload\n");
  symlinkSync(path.join(linked, "payload.res"), path.join(linked, "icudt76l", "payload.res"));
  const result = run(linked, output);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("must not contain symbolic links");
});

test("canonicalizes only its mktemp-owned stage below a symlinked OS temp alias", () => {
  if (process.platform === "win32") return;

  const root = temporaryRoot();
  const source = path.join(root, "source", "icudt76l");
  const output = path.join(root, "output");
  const realTemp = path.join(root, "real-temp");
  const linkedTemp = path.join(root, "linked-temp");
  mkdirSync(source, { recursive: true });
  mkdirSync(realTemp);
  writeFileSync(path.join(source, "root.res"), "root\n");
  symlinkSync(realTemp, linkedTemp);

  const result = run(path.dirname(source), output, {
    env: { ...process.env, TMPDIR: linkedTemp },
  });
  expect(result.status, result.stderr).toBe(0);

  const version = currentProductVersionSync("liboliphaunt-native");
  expect(readFileSync(path.join(output, `liboliphaunt-${version}-icu-data.tar.gz`)).length).toBeGreaterThan(0);
});
