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
  return spawnSync("bash", [SCRIPT, source, output], {
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
  expect(listing.stdout.split(/\r?\n/u).filter(Boolean)).toEqual([
    ".",
    "THIRD_PARTY_LICENSES/",
    "share/",
    "LICENSE",
    "THIRD_PARTY_NOTICES.liboliphaunt-native.md",
    "THIRD_PARTY_NOTICES.md",
    "THIRD_PARTY_LICENSES/ICU-LICENSE",
    "share/icu/",
    "share/icu/icudt76l/",
    "share/icu/icudt76l/coll/",
    "share/icu/icudt76l/root.res",
    "share/icu/icudt76l/coll/en.res",
  ]);

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
