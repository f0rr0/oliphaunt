import assert from "node:assert/strict";
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { gzipSync, gunzipSync } from "node:zlib";

import {
  ICU_DATA_RELATIVE_PATH,
  assertIcuPackedDataMatchesSource,
  assertIcuPackageManifest,
  assertIcuPackedInventory,
  assertIcuPodspec,
  assertIcuReactNativeConfig,
  assertPackedIcuCarrier,
} from "./icu-npm-carrier-contract.mjs";
import { readPortableArchiveEntries } from "./portable-archive.mjs";
import { stageReleaseNotices } from "./release-notices.mjs";
import { spawnSync } from "../test/fd-backed-spawn-sync.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const ICU_PACKAGE_ROOT = path.join(ROOT, "src/runtimes/liboliphaunt/native/icu-npm");
const PNPM = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const manifest = JSON.parse(readFileSync(path.join(ICU_PACKAGE_ROOT, "package.json"), "utf8"));
const config = readFileSync(path.join(ICU_PACKAGE_ROOT, "react-native.config.js"));
const podspec = readFileSync(path.join(ICU_PACKAGE_ROOT, "OliphauntICU.podspec"));
const canonicalEntries = [
  { name: "package/package.json", isFile: true },
  { name: "package/react-native.config.js", isFile: true },
  { name: "package/OliphauntICU.podspec", isFile: true },
  { name: "package/OliphauntICU.bundle/", isFile: false },
  { name: "package/OliphauntICU.bundle/share/icu/icudt77l/root.res", isFile: true },
];

test("ICU npm source descriptors encode the autolink-excluded, structure-preserving carrier contract", () => {
  assert.equal(manifest.oliphaunt.dataRelativePath, ICU_DATA_RELATIVE_PATH);
  assert.doesNotThrow(() => assertIcuPackageManifest(manifest));
  assert.doesNotThrow(() => assertIcuReactNativeConfig(config));
  assert.doesNotThrow(() => assertIcuPodspec(podspec));
  assert.doesNotThrow(() => assertPackedIcuCarrier({
    entries: canonicalEntries,
    packageJson: manifest,
    packedConfig: config,
    packedPodspec: podspec,
    sourceConfig: config,
    sourcePodspec: podspec,
  }));
});

test("ICU npm pack includes one canonical bundle and preserves both native descriptors byte-for-byte", (t) => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "oliphaunt-icu-npm-contract-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stage = path.join(root, "stage");
  const output = path.join(root, "packed");
  cpSync(ICU_PACKAGE_ROOT, stage, { recursive: true });
  mkdirSync(path.join(stage, ...ICU_DATA_RELATIVE_PATH.split("/"), "icudt-test"), { recursive: true });
  writeFileSync(
    path.join(stage, ...ICU_DATA_RELATIVE_PATH.split("/"), "icudt-test", "root.res"),
    "fixture\n",
  );
  stageReleaseNotices(stage, { profile: "native-icu-data" });
  mkdirSync(output);
  const packed = spawnSync(
    PNPM,
    ["pack", "--pack-destination", output, "--json"],
    { cwd: stage, encoding: "utf8" },
  );
  assert.equal(packed.status, 0, `${packed.stdout}\n${packed.stderr}`);
  const packedRows = JSON.parse(packed.stdout);
  const row = Array.isArray(packedRows) ? packedRows[0] : packedRows;
  const tarball = path.isAbsolute(row.filename)
    ? row.filename
    : path.join(output, path.basename(row.filename));
  const entries = readPortableArchiveEntries(tarball);
  assert.equal(entries.has("package/share/icu/icudt-test/root.res"), false);
  assert.equal(entries.has("package/OliphauntICU.bundle/share/icu/icudt-test/root.res"), true);
  assertPackedIcuCarrier({
    entries: [...entries].map(([name, entry]) => ({ name, isFile: entry.isFile })),
    packageJson: JSON.parse(Buffer.from(entries.get("package/package.json").data()).toString("utf8")),
    packedConfig: Buffer.from(entries.get("package/react-native.config.js").data()),
    packedPodspec: Buffer.from(entries.get("package/OliphauntICU.podspec").data()),
    sourceConfig: config,
    sourcePodspec: podspec,
  });
  const sourceEntries = new Map([
    [
      "share/icu/icudt-test/root.res",
      {
        data: () => Buffer.from("fixture\n"),
        isFile: true,
        size: Buffer.byteLength("fixture\n"),
      },
    ],
  ]);
  assert.doesNotThrow(() => assertIcuPackedDataMatchesSource({
    packedEntries: entries,
    sourceEntries,
  }));
  assert.throws(
    () => assertIcuPackedDataMatchesSource({
      packedEntries: entries,
      sourceEntries: new Map([
        [
          "share/icu/icudt-test/root.res",
          { data: () => Buffer.from("changed\n"), isFile: true, size: Buffer.byteLength("changed\n") },
        ],
      ]),
    }),
    /ICU data differs/u,
  );

  const tar = gunzipSync(readFileSync(tarball));
  const firstSize = Number.parseInt(
    tar.subarray(124, 136).toString("ascii").replace(/\0.*$/u, "").trim() || "0",
    8,
  );
  const firstSpan = 512 + Math.ceil(firstSize / 512) * 512;
  let endOffset = 0;
  while (endOffset + 512 <= tar.length) {
    const header = tar.subarray(endOffset, endOffset + 512);
    if (header.every((byte) => byte === 0)) break;
    const size = Number.parseInt(
      header.subarray(124, 136).toString("ascii").replace(/\0.*$/u, "").trim() || "0",
      8,
    );
    endOffset += 512 + Math.ceil(size / 512) * 512;
  }
  const duplicateArchive = path.join(root, "duplicate-member.tgz");
  writeFileSync(
    duplicateArchive,
    gzipSync(Buffer.concat([
      tar.subarray(0, endOffset),
      tar.subarray(0, firstSpan),
      tar.subarray(endOffset),
    ])),
  );
  assert.throws(
    () => readPortableArchiveEntries(duplicateArchive),
    /repeats archive member/u,
  );
});

test("ICU npm manifest rejects ESM autolinking and the legacy payload selector", () => {
  assert.throws(
    () => assertIcuPackageManifest({ ...manifest, type: "module" }),
    /type must be "commonjs"/u,
  );
  assert.throws(
    () => assertIcuPackageManifest({ ...manifest, files: [...manifest.files, "share"] }),
    /must not include the legacy ICU tree/u,
  );
});

test("ICU native descriptors fail closed on partial autolinking or flattened CocoaPods resources", () => {
  assert.throws(
    () => assertIcuReactNativeConfig("module.exports = { dependency: { platforms: { ios: null } } };\n"),
    /keys must be \["android","ios"\]/u,
  );
  assert.throws(
    () => assertIcuPodspec("s.resource_bundles = { 'OliphauntICU' => ['share/icu/**/*'] }\n"),
    /preassembled OliphauntICU\.bundle/u,
  );
});

test("ICU packed inventory accepts one bundle tree and rejects legacy, additional, or duplicate trees", () => {
  assert.doesNotThrow(() => assertIcuPackedInventory(canonicalEntries));
  assert.throws(
    () => assertIcuPackedInventory([
      ...canonicalEntries,
      { name: "package/share/icu/icudt77l/root.res", isFile: true },
    ]),
    /forbidden legacy ICU data member/u,
  );
  assert.throws(
    () => assertIcuPackedInventory([
      ...canonicalEntries,
      { name: "package/duplicate/share/icu/icudt77l/root.res", isFile: true },
    ]),
    /unexpected additional ICU data tree/u,
  );
  assert.throws(
    () => assertIcuPackedInventory([...canonicalEntries, canonicalEntries.at(-1)]),
    /repeats member/u,
  );
});

test("ICU packed carrier preserves the reviewed config and podspec bytes exactly", () => {
  assert.throws(
    () => assertPackedIcuCarrier({
      entries: canonicalEntries,
      packageJson: manifest,
      packedConfig: Buffer.concat([config, Buffer.from("\n")]),
      packedPodspec: podspec,
      sourceConfig: config,
      sourcePodspec: podspec,
    }),
    /packed bytes differ from the reviewed source descriptor/u,
  );
  assert.throws(
    () => assertPackedIcuCarrier({
      entries: canonicalEntries,
      packageJson: manifest,
      packedConfig: config,
      packedPodspec: Buffer.concat([podspec, Buffer.from("\n")]),
      sourceConfig: config,
      sourcePodspec: podspec,
    }),
    /packed bytes differ from the reviewed source descriptor/u,
  );
});
