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
import { parseProperties } from "./native-cluster-seed-contract.mjs";

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
  mkdirSync(path.join(root, "source", "76.1", "config"), { recursive: true });
  writeFileSync(path.join(source, "root.res"), "root\n");
  writeFileSync(path.join(source, "coll", "en.res"), "en\n");
  writeFileSync(path.join(root, "source", "76.1", "config", "mh-darwin"), "build-only\n");
  writeFileSync(path.join(root, "source", "LICENSE"), "install-scaffolding\n");

  const first = run(path.dirname(source), output);
  expect(first.status, first.stderr).toBe(0);
  const version = currentProductVersionSync("liboliphaunt-native");
  const archive = path.join(output, `liboliphaunt-${version}-icu-data.tar.gz`);
  const firstDigest = sha256(archive);

  const listing = spawnSync("tar", ["-tzf", archive], { encoding: "utf8" });
  expect(listing.status, listing.stderr).toBe(0);
  const members = listing.stdout.split(/\r?\n/u).filter(Boolean);
  expect(members).toContain("share/icu/icudt76l/root.res");
  expect(members.some((member) => member.startsWith("share/icu/76.1"))).toBe(false);
  expect(members).not.toContain("share/icu/LICENSE");
  expect(members).toContain("manifest.properties");
  expect(members.some((member) => member.startsWith("cluster-seed"))).toBe(false);
  expect(members).toContain("package-size.tsv");
  expect(members).not.toContain("THIRD_PARTY_LICENSES/PostgreSQL-COPYRIGHT");
  expect(members).toContain("THIRD_PARTY_LICENSES/ICU-LICENSE");
  const receipt = spawnSync("tar", ["-xOzf", archive, "manifest.properties"], { encoding: "utf8" });
  expect(receipt.status, receipt.stderr).toBe(0);
  const fields = parseProperties(receipt.stdout, "portable ICU data receipt");
  expect(Object.fromEntries(fields)).toEqual({
    schema: "oliphaunt-icu-data-v1",
    artifactRole: "icu-data",
    icuDataVersion: "76.1",
    icuDataForm: "files-le",
    icuDataTreeSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
  });
  const sizeReport = spawnSync("tar", ["-xOzf", archive, "package-size.tsv"], { encoding: "utf8" });
  expect(sizeReport.status, sizeReport.stderr).toBe(0);
  expect(sizeReport.stdout).toMatch(/^kind\tid\textensions\tfiles\tbytes\npackage\ttotal\t-\t-\t[0-9]+\npackage\ticu-data\t-\t-\t[0-9]+\n$/u);

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
