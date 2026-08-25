#!/usr/bin/env bun

import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { zstdCompressSync } from "node:zlib";

import { captureCommandOutput } from "../dev/capture-command-output.mjs";
import { createDeterministicTar } from "./cargo-source-package.mjs";
import { validateNpmTrustedPublishingManifest } from "./npm-trusted-publishing.mjs";
import { readPortableArchiveEntries } from "./portable-archive.mjs";
import {
  assertReleaseNoticesInArchive,
  assertReleaseNoticesInDirectory,
  releaseNoticeRows,
  releaseProfilePackageLicense,
  stageReleaseNotices,
} from "./release-notices.mjs";
import {
  WASIX_PORTABLE_RELEASE_MEMBERS,
  WASIX_RUNTIME_NPM_PACKAGE,
  WASIX_RUNTIME_PRODUCT,
} from "./wasix-runtime-npm-contract.mjs";
import {
  WASIX_ICU_DATA_ARCHIVE_PATH,
  WASIX_ICU_DESCRIPTOR_SCHEMA,
  WASIX_ICU_NPM_ASSET_PATHS,
  WASIX_ICU_NPM_PACKAGE,
  WASIX_ICU_PRODUCT,
} from "./wasix-icu-npm-contract.mjs";

const TOOL = "wasix-icu-npm-carrier.mjs";
const ROOT = path.resolve(import.meta.dirname, "../..");
const LOWER_SHA256 = /^[0-9a-f]{64}$/u;
const NOTICE_OPTIONS = Object.freeze({ profile: "wasix-icu-data" });
const ICU_RELEASE_PREFIX = "target/oliphaunt-wasix/icu/share/icu/";

function fail(message) {
  throw new Error(`${TOOL}: ${message}`);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function requireEntry(entries, member, label) {
  const entry = entries.get(member);
  if (entry === undefined || !entry.isFile || entry.isSymbolicLink || entry.size <= 0) {
    fail(`${label} must contain ${member} as a non-empty regular file`);
  }
  return Buffer.from(entry.data());
}

function parseJson(bytes, label) {
  try {
    const value = JSON.parse(bytes.toString("utf8"));
    if (value === null || Array.isArray(value) || typeof value !== "object") fail(`${label} must be an object`);
    return value;
  } catch (error) {
    fail(`${label} is not valid UTF-8 JSON: ${error.message}`);
  }
}

function checkedDigest(value, label) {
  if (typeof value !== "string" || !LOWER_SHA256.test(value)) fail(`${label} is not a lowercase SHA-256 digest`);
  return value;
}

function logicalTreeDigest(rows) {
  const digest = createHash("sha256");
  for (const row of [...rows].sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)))) {
    digest.update(row.path);
    digest.update(Buffer.of(0));
    digest.update(String(row.bytes.length));
    digest.update(Buffer.of(0));
    digest.update(row.bytes);
    digest.update("\n");
  }
  return digest.digest("hex");
}

function canonicalIcuArchive(icuReleaseArchive) {
  const entries = readPortableArchiveEntries(path.resolve(icuReleaseArchive));
  const rows = [];
  for (const [member, entry] of entries) {
    if (!member.startsWith(ICU_RELEASE_PREFIX) || !entry.isFile) continue;
    if (entry.isSymbolicLink) fail(`ICU release data must not contain links: ${member}`);
    rows.push({ path: member.slice(ICU_RELEASE_PREFIX.length), bytes: Buffer.from(entry.data()) });
  }
  if (rows.length === 0 || !rows.some(({ path }) => path.split("/")[0]?.startsWith("icudt"))) {
    fail("ICU release asset has no icudt files-data tree");
  }
  const scratch = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-wasix-icu-npm-"));
  try {
    const stage = path.join(scratch, "stage");
    for (const row of rows) {
      const output = path.join(stage, "share/icu", ...row.path.split("/"));
      mkdirSync(path.dirname(output), { recursive: true });
      writeFileSync(output, row.bytes, { mode: 0o644 });
    }
    const tar = createDeterministicTar(stage, ".", { fail, fixedFileMode: 0o644 });
    return Object.freeze({ bytes: zstdCompressSync(tar), dataTreeSha256: logicalTreeDigest(rows) });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function wasixIcuNpmInputs({ version, portableReleaseArchive, icuDataReleaseArchive }) {
  const runtimeEntries = readPortableArchiveEntries(path.resolve(portableReleaseArchive));
  const manifest = parseJson(
    requireEntry(runtimeEntries, WASIX_PORTABLE_RELEASE_MEMBERS.manifest, "WASIX runtime release"),
    "WASIX runtime manifest",
  );
  const seedArchiveBytes = requireEntry(
    runtimeEntries,
    WASIX_PORTABLE_RELEASE_MEMBERS.icuSeedArchive,
    "WASIX runtime release",
  );
  const seedManifestBytes = requireEntry(
    runtimeEntries,
    WASIX_PORTABLE_RELEASE_MEMBERS.icuSeedManifest,
    "WASIX runtime release",
  );
  const seed = parseJson(seedManifestBytes, "WASIX ICU cluster seed manifest");
  const outer = manifest["cluster-seeds"]?.icu;
  const data = canonicalIcuArchive(icuDataReleaseArchive);
  if (
    manifest["format-version"] !== 2
    || seed.schema !== "oliphaunt-cluster-seed-v1"
    || seed.catalogProfile !== "icu"
    || seed.artifactRole !== "cluster-seed-icu"
    || seed.runtime?.product !== WASIX_RUNTIME_PRODUCT
    || seed.runtime?.version !== version
    || seed.runtime?.physicalFormat !== "wasix-pg18-v1"
    || seed.runtime?.compatibilityKey !== "wasix-pg18-datum32-v1"
    || seed.icu?.artifactRole !== "icu-data"
    || seed.icu?.dataVersion !== "76.1"
    || seed.icu?.dataForm !== "files-le"
    || seed.icu?.dataTreeSha256 !== data.dataTreeSha256
    || outer?.sha256 !== sha256(seedArchiveBytes)
    || outer?.size !== seedArchiveBytes.length
    || outer?.["icu-data-tree-sha256"] !== data.dataTreeSha256
  ) {
    fail("ICU data, ICU cluster seed, and WASIX runtime do not form one compatible closure");
  }
  checkedDigest(seed.icu.dataTreeSha256, "ICU logical data tree");
  return Object.freeze({
    compatibility: Object.freeze({
      runtimeProduct: WASIX_RUNTIME_PRODUCT,
      runtimeVersion: version,
      postgresMajor: "18",
      physicalFormat: "wasix-pg18-v1",
      compatibilityKey: "wasix-pg18-datum32-v1",
      dataVersion: "76.1",
      dataForm: "files-le",
      dataTreeSha256: data.dataTreeSha256,
    }),
    dataArchive: Object.freeze({ archive: WASIX_ICU_DATA_ARCHIVE_PATH, bytes: data.bytes, sha256: sha256(data.bytes), size: data.bytes.length }),
    clusterSeedArchive: Object.freeze({ archive: outer.archive, bytes: seedArchiveBytes, sha256: outer.sha256, size: outer.size }),
    clusterSeedManifest: Object.freeze({ bytes: seedManifestBytes, sha256: sha256(seedManifestBytes), size: seedManifestBytes.length }),
  });
}

function asset(value, sourcePath, includeArchive) {
  return Object.freeze({
    ...(includeArchive ? { archive: value.archive } : {}),
    sha256: value.sha256,
    size: value.size,
    source: new URL(`./${sourcePath}`, import.meta.url),
  });
}

function renderDescriptor({ version, inputs }) {
  const literal = JSON.stringify({
    schema: WASIX_ICU_DESCRIPTOR_SCHEMA,
    runtime: "wasix",
    product: WASIX_ICU_PRODUCT,
    version,
    compatibility: inputs.compatibility,
    dataArchive: { archive: inputs.dataArchive.archive, sha256: inputs.dataArchive.sha256, size: inputs.dataArchive.size },
    clusterSeedArchive: { archive: inputs.clusterSeedArchive.archive, sha256: inputs.clusterSeedArchive.sha256, size: inputs.clusterSeedArchive.size },
    clusterSeedManifest: { sha256: inputs.clusterSeedManifest.sha256, size: inputs.clusterSeedManifest.size },
  }, null, 2);
  return `const descriptor = ${literal};\nconst paths = ${JSON.stringify(WASIX_ICU_NPM_ASSET_PATHS)};\nfor (const name of ["dataArchive", "clusterSeedArchive", "clusterSeedManifest"]) {\n  descriptor[name].source = new URL(\`./\${paths[name]}\`, import.meta.url);\n  Object.freeze(descriptor[name]);\n}\nObject.freeze(descriptor.compatibility);\nObject.freeze(descriptor);\nexport { descriptor };\nexport default descriptor;\n`;
}

function descriptorTypes() {
  return `export type OliphauntWasixIcuDescriptor = Readonly<{\n  schema: "${WASIX_ICU_DESCRIPTOR_SCHEMA}"; runtime: "wasix"; product: "${WASIX_ICU_PRODUCT}"; version: string;\n  compatibility: Readonly<{ runtimeProduct: "${WASIX_RUNTIME_PRODUCT}"; runtimeVersion: string; postgresMajor: "18"; physicalFormat: "wasix-pg18-v1"; compatibilityKey: "wasix-pg18-datum32-v1"; dataVersion: "76.1"; dataForm: "files-le"; dataTreeSha256: string }>;\n  dataArchive: Readonly<{ archive: string; sha256: string; size: number; source: URL }>;\n  clusterSeedArchive: Readonly<{ archive: string; sha256: string; size: number; source: URL }>;\n  clusterSeedManifest: Readonly<{ sha256: string; size: number; source: URL }>;\n}>;\ndeclare const descriptor: OliphauntWasixIcuDescriptor;\nexport { descriptor };\nexport default descriptor;\n`;
}

export function stageWasixIcuNpmCarrier({ version, portableReleaseArchive, icuDataReleaseArchive, packageDir }) {
  const output = path.resolve(packageDir);
  const inputs = wasixIcuNpmInputs({ version, portableReleaseArchive, icuDataReleaseArchive });
  rmSync(output, { recursive: true, force: true });
  mkdirSync(path.join(output, "assets"), { recursive: true });
  for (const name of ["dataArchive", "clusterSeedArchive", "clusterSeedManifest"]) {
    const destination = path.join(output, ...WASIX_ICU_NPM_ASSET_PATHS[name].split("/"));
    writeFileSync(destination, inputs[name].bytes, { mode: 0o644 });
    chmodSync(destination, 0o644);
  }
  writeFileSync(path.join(output, "index.js"), renderDescriptor({ version, inputs }), { mode: 0o644 });
  writeFileSync(path.join(output, "index.d.ts"), descriptorTypes(), { mode: 0o644 });
  writeFileSync(path.join(output, "README.md"), `# ${WASIX_ICU_NPM_PACKAGE}\n\nOptional ICU data and matching ICU catalog cluster seed for ${WASIX_RUNTIME_NPM_PACKAGE}.\n\n\`import icu from '${WASIX_ICU_NPM_PACKAGE}'\` and pass \`{ icu }\` to \`Oliphaunt.open\`.\n`, { mode: 0o644 });
  stageReleaseNotices(output, NOTICE_OPTIONS);
  const packageJson = {
    name: WASIX_ICU_NPM_PACKAGE,
    version,
    description: "Optional ICU data and matching cluster seed for Oliphaunt WASIX.",
    license: releaseProfilePackageLicense("wasix-icu-data").spdx,
    type: "module",
    sideEffects: false,
    repository: { type: "git", url: "git+https://github.com/f0rr0/oliphaunt.git" },
    oliphaunt: { product: WASIX_ICU_PRODUCT, kind: "icu-data", runtime: "wasix", descriptorSchema: WASIX_ICU_DESCRIPTOR_SCHEMA },
    publishConfig: { access: "public", provenance: true },
    files: ["README.md", "index.js", "index.d.ts", "assets", ...releaseNoticeRows(NOTICE_OPTIONS).map(({ member }) => member)],
    exports: { ".": { types: "./index.d.ts", import: "./index.js", default: "./index.js" }, "./package.json": "./package.json" },
  };
  validateNpmTrustedPublishingManifest(packageJson, `${WASIX_ICU_NPM_PACKAGE} generated package`);
  writeFileSync(path.join(output, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`, { mode: 0o644 });
  assertReleaseNoticesInDirectory(output, NOTICE_OPTIONS);
  return Object.freeze({ packageDir: output, packageName: WASIX_ICU_NPM_PACKAGE, descriptor: inputs });
}

export function packWasixIcuNpmCarrier({
  version,
  portableReleaseArchive,
  icuDataReleaseArchive,
  packageDir = path.join(ROOT, "target/release/npm-package-sources/wasix-icu"),
  tarballRoot = path.join(ROOT, "target/release/npm-packages/wasix-icu"),
}) {
  const staged = stageWasixIcuNpmCarrier({ version, portableReleaseArchive, icuDataReleaseArchive, packageDir });
  rmSync(tarballRoot, { recursive: true, force: true });
  mkdirSync(tarballRoot, { recursive: true });
  const result = captureCommandOutput(process.platform === "win32" ? "pnpm.cmd" : "pnpm", ["pack", "--pack-destination", tarballRoot, "--json"], { cwd: staged.packageDir, label: `pnpm pack for ${WASIX_ICU_NPM_PACKAGE}`, maxOutputBytes: 32 * 1024 * 1024, shell: process.platform === "win32" });
  if (result.status !== 0) fail(`pnpm pack failed: ${String(result.stderr || result.stdout).trim()}`);
  const packed = JSON.parse(result.stdout);
  const filename = Array.isArray(packed) ? packed[0]?.filename : packed?.filename;
  if (typeof filename !== "string") fail("pnpm pack did not report a filename");
  const tarball = path.isAbsolute(filename) ? filename : path.join(tarballRoot, filename);
  assertReleaseNoticesInArchive(tarball, { ...NOTICE_OPTIONS, prefix: "package" });
  return Object.freeze({ ...staged, tarball });
}
