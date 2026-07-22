import { expect, test } from "bun:test";
import { spawnSync } from "../test/fd-backed-spawn-sync.mjs";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";

import * as extensionMaterializer from "./extension-registry-carrier-materializer.mjs";
import {
  extensionCarrierLegalContract,
  stageExtensionUpstreamLicenses,
} from "./extension-upstream-licenses.mjs";
import {
  WINDOWS_STANDARD_USER_EXTENSION_DISCOVERY_PROOF,
} from "./extension-manifest-discovery-proof.mjs";
import * as localRegistryCompatibility from "./local-registry-publish.mjs";
import { publicExtensionReleaseAsset } from "./build-extension-ci-artifacts.mjs";
import { iosBaseLegalMetadata } from "./ios-carrier-manifest.mjs";
import { stageReleaseNotices } from "./release-notices.mjs";
import {
  canonicalExtensionNpmTargets,
  cargoMetadataForCrate,
  createCargoCandidateScope,
  exactNativeExtensionMemberDependencies,
  localRegistryCommandInvocation,
  npmReleaseAssetStagingLayout,
  packageNativeExtensionCargoCrates,
  parseCargoCandidateProductsJson,
  renderNpmExtensionBundleManifest,
  selectScopedCargoCandidates,
  stageExtensionNpmPackages,
  stageWindowsVcRuntimeMembers,
} from "./local-registry-publish.mjs";
import { ROOT } from "./release-cli-utils.mjs";
import {
  extensionNpmTargetPackage,
  nativeExtensionCargoPackageName,
} from "./extension-registry-packages.mjs";
import {
  currentProductVersionSync,
  extensionProductForSqlName,
} from "./release-artifact-targets.mjs";
import { tagPrefix } from "./release-graph.mjs";
import { discoverPublicationArtifacts } from "./publication-lock.mjs";
import {
  WINDOWS_VC_RUNTIME_RECEIPT,
  windowsVcRuntimeProfileNames,
} from "./windows-vc-runtime-closure.mjs";
import {
  stageWindowsVcRuntimeMembers as stageDryRunWindowsVcRuntimeMembers,
} from "./release-product-dry-run.mjs";
import { elfFixture } from "../test/release-fixture-utils.mjs";

const posixTest = process.platform === "win32" ? test.skip : test;

const EXTENSION_ARTIFACT_PROPERTY_KEYS = [
  "packageLayout",
  "pgMajor",
  "sqlName",
  "createsExtension",
  "nativeModuleStem",
  "nativeModuleFile",
  "nativeTarget",
  "nativeRuntimeProduct",
  "nativeRuntimeVersion",
  "dependencies",
  "dataFiles",
  "extensionSqlFileNames",
  "extensionSqlFilePrefixes",
  "sharedPreloadLibraries",
  "mobilePrebuilt",
  "mobileStaticArchives",
  "mobileStaticDependencyArchives",
  "staticSymbolPrefix",
  "staticSymbolAliases",
  "licenseFiles",
  "licenseProfile",
  "files",
];

function writeTarString(buffer, offset, length, value) {
  const bytes = Buffer.from(value);
  expect(bytes.length).toBeLessThanOrEqual(length);
  bytes.copy(buffer, offset);
}

function writeTarOctal(buffer, offset, length, value) {
  writeTarString(buffer, offset, length, `${value.toString(8).padStart(length - 1, "0")}\0`);
}

function canonicalTarHeader(name, bytes, mode) {
  const header = Buffer.alloc(512);
  writeTarString(header, 0, 100, name);
  writeTarOctal(header, 100, 8, mode);
  writeTarOctal(header, 108, 8, 0);
  writeTarOctal(header, 116, 8, 0);
  writeTarOctal(header, 124, 12, bytes);
  writeTarOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  writeTarString(header, 156, 1, "0");
  writeTarString(header, 257, 6, "ustar\0");
  writeTarString(header, 263, 2, "00");
  writeTarString(header, 265, 32, "root");
  writeTarString(header, 297, 32, "root");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeTarString(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  return header;
}

function canonicalExtensionArchive(entries) {
  const chunks = [];
  for (const [name, raw] of [...entries].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) {
    const data = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    const mode = name.startsWith("files/lib/postgresql/") || name.startsWith("files/lib/modules/")
      ? 0o755
      : 0o644;
    chunks.push(canonicalTarHeader(name, data.length, mode), data);
    if (data.length % 512 !== 0) chunks.push(Buffer.alloc(512 - (data.length % 512)));
  }
  chunks.push(Buffer.alloc(1024));
  const compressed = Buffer.from(gzipSync(Buffer.concat(chunks), { mtime: 0 }));
  compressed.fill(0, 4, 9);
  compressed[9] = 0x03;
  return compressed;
}

function writeExactExtensionArtifact(asset, {
  sqlName,
  target,
  nativeRuntimeVersion,
  nativeModuleStem = null,
  nativeModuleBytes = null,
  embeddedModuleBytes = nativeModuleBytes,
  dependencies = [],
  dataFiles = [],
  sharedPreloadLibraries = [],
  extraEntries = [],
}) {
  const legal = extensionCarrierLegalContract(
    extensionProductForSqlName(sqlName, "local-registry-publish.test.mjs"),
    [sqlName],
    { family: "native", target },
  );
  const inventory = {
    sqlName,
    createsExtension: true,
    nativeModuleStem,
    dependencies: [...dependencies].sort(),
    dataFiles: dataFiles.map(([name]) => name).sort(),
    extensionSqlFileNames: [],
    extensionSqlFilePrefixes: [],
    sharedPreloadLibraries: [...sharedPreloadLibraries].sort(),
  };
  const values = {
    packageLayout: "oliphaunt-extension-artifact-v1",
    pgMajor: "18",
    sqlName,
    createsExtension: "yes",
    nativeModuleStem: nativeModuleStem ?? "",
    nativeModuleFile: nativeModuleStem === null ? "" : `${nativeModuleStem}.so`,
    nativeTarget: target,
    nativeRuntimeProduct: "liboliphaunt-native",
    nativeRuntimeVersion,
    dependencies: inventory.dependencies.join(","),
    dataFiles: inventory.dataFiles.join(","),
    extensionSqlFileNames: inventory.extensionSqlFileNames.join(","),
    extensionSqlFilePrefixes: inventory.extensionSqlFilePrefixes.join(","),
    sharedPreloadLibraries: inventory.sharedPreloadLibraries.join(","),
    mobilePrebuilt: "no",
    mobileStaticArchives: "",
    mobileStaticDependencyArchives: "",
    staticSymbolPrefix: "",
    staticSymbolAliases: "",
    licenseFiles: legal.licenseFiles.join(","),
    licenseProfile: legal.profile,
    files: "files",
  };
  const entries = new Map([
    ["manifest.properties", `${EXTENSION_ARTIFACT_PROPERTY_KEYS.map((key) => `${key}=${values[key]}`).join("\n")}\n`],
    [`files/share/postgresql/extension/${sqlName}--1.0.0.sql`, "install"],
    [
      `files/share/postgresql/extension/${sqlName}.control`,
      "default_version = '1.0.0'\n",
    ],
  ]);
  if (nativeModuleStem !== null) {
    if (!Buffer.isBuffer(nativeModuleBytes)) throw new Error("nativeModuleBytes are required");
    if (!Buffer.isBuffer(embeddedModuleBytes)) throw new Error("embeddedModuleBytes are required");
    entries.set(`files/lib/postgresql/${nativeModuleStem}.so`, nativeModuleBytes);
    entries.set(`files/lib/modules/${nativeModuleStem}.so`, embeddedModuleBytes);
  }
  for (const [name, bytes] of dataFiles) {
    entries.set(`files/share/postgresql/${name}`, bytes);
  }
  const legalRoot = `${asset}.legal`;
  rmSync(legalRoot, { recursive: true, force: true });
  for (const [name, bytes] of exactExtensionLegalEntries(legalRoot, sqlName, legal.profile)) {
    entries.set(name, bytes);
  }
  for (const [name, bytes] of extraEntries) entries.set(name, bytes);
  writeFileSync(asset, canonicalExtensionArchive(entries));
  rmSync(legalRoot, { recursive: true, force: true });
  return inventory;
}

function frozenExtensionCompatibility(nativeRuntimeVersion) {
  return {
    extensionRuntimeContract: "src/shared/extension-runtime-contract/contract.toml",
    nativeRuntimeProduct: "liboliphaunt-native",
    nativeRuntimeVersion,
    postgresMajor: "18",
    wasixRuntimeProduct: "liboliphaunt-wasix",
    wasixRuntimeVersion: currentProductVersionSync("liboliphaunt-wasix"),
  };
}

function publicExtensionAsset(asset) {
  return Object.fromEntries([
    "name",
    "family",
    "target",
    "kind",
    "identity",
    "sha256",
    "bytes",
    "carrierAsset",
    "carrierRoot",
    "memberPath",
    "memberCount",
  ].filter((key) => Object.hasOwn(asset, key)).map((key) => [key, asset[key]]));
}

function filesUnder(root) {
  if (!existsSync(root)) return [];
  const files = [];
  for (const name of readdirSync(root).sort()) {
    const file = path.join(root, name);
    if (statSync(file).isDirectory()) files.push(...filesUnder(file));
    else files.push(file);
  }
  return files;
}

function exactExtensionLegalEntries(root, sqlName, profile) {
  stageReleaseNotices(root, { profile });
  stageExtensionUpstreamLicenses(sqlName, path.join(root, "files"));
  return filesUnder(root).map((file) => [
    path.relative(root, file).split(path.sep).join("/"),
    readFileSync(file),
  ]);
}

test("keeps the local-registry compatibility exports bound to the focused extension materializer", () => {
  for (const name of [
    "canonicalExtensionNpmTargets",
    "exactNativeExtensionMemberDependencies",
    "frozenExtensionMemberInventory",
    "localRegistryCommandInvocation",
    "packageNativeExtensionCargoCrates",
    "renderNpmExtensionBundleManifest",
    "stageExtensionNpmPackages",
  ]) {
    expect(localRegistryCompatibility[name]).toBe(extensionMaterializer[name]);
  }
});

test("discovers nested extension manifests without Bun.Glob's Windows directory-open contract", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-extension-discovery-"));
  try {
    const manifests = [
      path.join(root, "windows-x64-msvc", "vector", "extension-artifacts.json"),
      path.join(root, "ios-xcframework", "postgis", "extension-artifacts.json"),
    ];
    for (const [index, manifest] of manifests.entries()) {
      mkdirSync(path.dirname(manifest), { recursive: true });
      writeFileSync(manifest, `${JSON.stringify({
        product: `oliphaunt-extension-fixture-${index}`,
        version: "1.0.0",
        sqlName: `fixture_${index}`,
      })}\n`);
    }
    writeFileSync(path.join(root, "not-a-manifest.json"), "{}\n");

    const expected = [...manifests].sort();
    expect(extensionMaterializer.discoverExtensionManifests([root])).toEqual(expected);
    const directFirstExpected = [manifests[0], manifests[1]];
    expect(extensionMaterializer.discoverExtensionManifests([
      manifests[0],
      root,
      root,
    ])).toEqual(directFirstExpected);

    const metadataTool = path.join(ROOT, "tools/release/local_registry_metadata.mjs");
    const result = spawnSync(
      process.execPath,
      [
        metadataTool,
        "discover-extension-manifests",
        "--root", manifests[0],
        "--root", root,
        "--root", root,
      ],
      { encoding: "utf8" },
    );
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(JSON.parse(result.stdout).map((candidate) => path.normalize(candidate))).toEqual(
      directFirstExpected,
    );

    const proofRoot = path.join(root, "windows-x64-msvc");
    const proofManifest = manifests[0];
    const proofSha256 = createHash("sha256")
      .update(readFileSync(proofManifest))
      .digest("hex");
    const materializerTool = path.join(
      ROOT,
      "tools/release/extension-registry-carrier-materializer.mjs",
    );
    const discoveryProofTool = path.join(
      ROOT,
      "tools/release/extension-manifest-discovery-proof.mjs",
    );
    const proofResult = spawnSync(
      process.execPath,
      [
        discoveryProofTool,
        "--windows-standard-user-discovery-proof",
        proofRoot,
        proofManifest,
        proofSha256,
      ],
      { encoding: "utf8" },
    );
    expect(proofResult.status, proofResult.stderr || proofResult.stdout).toBe(0);
    expect(proofResult.stdout.trim()).toBe(
      `${WINDOWS_STANDARD_USER_EXTENSION_DISCOVERY_PROOF}`
        + `\tvector/extension-artifacts.json\t${proofSha256}`,
    );
    expect(proofResult.stderr).toBe("");

    const wrongDigestResult = spawnSync(
      process.execPath,
      [
        discoveryProofTool,
        "--windows-standard-user-discovery-proof",
        proofRoot,
        proofManifest,
        "0".repeat(64),
      ],
      { encoding: "utf8" },
    );
    expect(wrongDigestResult.status).not.toBe(0);
    expect(wrongDigestResult.stderr).toContain("manifest digest disagrees");

    const escapedManifestResult = spawnSync(
      process.execPath,
      [
        discoveryProofTool,
        "--windows-standard-user-discovery-proof",
        proofRoot,
        manifests[1],
        createHash("sha256").update(readFileSync(manifests[1])).digest("hex"),
      ],
      { encoding: "utf8" },
    );
    expect(escapedManifestResult.status).not.toBe(0);
    expect(escapedManifestResult.stderr).toContain("expected manifest escaped its root");

    const extraManifest = path.join(proofRoot, "extra", "extension-artifacts.json");
    mkdirSync(path.dirname(extraManifest), { recursive: true });
    writeFileSync(extraManifest, '{"product":"unexpected"}\n');
    const ambiguousDiscoveryResult = spawnSync(
      process.execPath,
      [
        discoveryProofTool,
        "--windows-standard-user-discovery-proof",
        proofRoot,
        proofManifest,
        proofSha256,
      ],
      { encoding: "utf8" },
    );
    expect(ambiguousDiscoveryResult.status).not.toBe(0);
    expect(ambiguousDiscoveryResult.stderr).toContain("exactly the expected nested manifest");

    for (const implementation of [
      materializerTool,
      metadataTool,
    ]) {
      expect(readFileSync(implementation, "utf8")).not.toContain(
        'new Bun.Glob("**/extension-artifacts.json")',
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

posixTest("extension manifest discovery rejects symlinks instead of skipping or traversing them", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-extension-discovery-link-"));
  try {
    const target = path.join(root, "target");
    mkdirSync(target);
    const targetManifest = path.join(target, "extension-artifacts.json");
    const linkedTarget = path.join(root, "linked-target");
    writeFileSync(targetManifest, "{}\n");
    symlinkSync(target, linkedTarget, "dir");
    expect(() => extensionMaterializer.discoverExtensionManifests([root])).toThrow(
      "must not contain a symbolic link or junction",
    );

    const proofResult = spawnSync(
      process.execPath,
      [
        path.join(ROOT, "tools/release/extension-manifest-discovery-proof.mjs"),
        "--windows-standard-user-discovery-proof",
        linkedTarget,
        targetManifest,
        createHash("sha256").update(readFileSync(targetManifest)).digest("hex"),
      ],
      { encoding: "utf8" },
    );
    expect(proofResult.status).not.toBe(0);
    expect(proofResult.stderr).toContain("must not be a symbolic link or junction");

    const result = spawnSync(
      process.execPath,
      [
        path.join(ROOT, "tools/release/local_registry_metadata.mjs"),
        "discover-extension-manifests",
        "--root", root,
      ],
      { encoding: "utf8" },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("must not contain a symbolic link or junction");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

posixTest("extension manifest discovery rejects unsupported special filesystem entries", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-extension-discovery-special-"));
  try {
    const fifo = path.join(root, "unexpected.fifo");
    const created = spawnSync("mkfifo", [fifo], { encoding: "utf8" });
    expect(created.status, created.stderr || created.stdout).toBe(0);
    expect(() => extensionMaterializer.discoverExtensionManifests([root])).toThrow(
      "contains an unsupported filesystem entry",
    );

    const result = spawnSync(
      process.execPath,
      [
        path.join(ROOT, "tools/release/local_registry_metadata.mjs"),
        "discover-extension-manifests",
        "--root", root,
      ],
      { encoding: "utf8" },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("contains an unsupported filesystem entry");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("confines temporary npm release-asset copies to the per-run registry root", () => {
  const registryRoot = path.join(ROOT, "target/js-exact-candidate-contract/registry");
  const layout = npmReleaseAssetStagingLayout(registryRoot);
  expect(layout).toEqual({
    outputRoot: path.join(registryRoot, "npm-generated/release-asset-packages"),
    liboliphauntAssetDir: path.join(
      registryRoot,
      "npm-generated/release-asset-packages/release-assets/liboliphaunt",
    ),
    brokerAssetDir: path.join(
      registryRoot,
      "npm-generated/release-asset-packages/release-assets/oliphaunt-broker",
    ),
  });
  for (const candidate of Object.values(layout)) {
    const relative = path.relative(registryRoot, candidate);
    expect(relative).not.toBe("");
    expect(path.isAbsolute(relative)).toBe(false);
    expect(relative).not.toBe("..");
    expect(relative.startsWith(`..${path.sep}`)).toBe(false);
  }

  const publisher = readFileSync(
    path.join(ROOT, "tools/release/local-registry-publish.mjs"),
    "utf8",
  );
  const start = publisher.indexOf("function stageLiboliphauntNpmPayloads(");
  const end = publisher.indexOf("\nfunction stageExtensionNpmPackagesDryRun(", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const stagingImplementation = publisher.slice(start, end);
  expect(stagingImplementation).toContain("npmReleaseAssetStagingLayout(registryRoot)");
  expect(stagingImplementation).not.toContain('path.join(ROOT, "target/liboliphaunt');
  expect(stagingImplementation).not.toContain('path.join(ROOT, "target/oliphaunt-broker');
});

test("forces every Windows tar archive operand to remain local", () => {
  expect(localRegistryCommandInvocation(
    "tar",
    [
      "-xf",
      String.raw`D:\a\oliphaunt\release-assets\icu-data.tar.gz`,
      "-C",
      String.raw`D:\a\oliphaunt\target\local-registry-archive-extract\extract-proof`,
      "share/icu",
    ],
    { platform: "win32", cwd: String.raw`D:\a\oliphaunt` },
  )).toEqual({
    command: "tar",
    args: [
      "-xf",
      "icu-data.tar.gz",
      "-C",
      "../target/local-registry-archive-extract/extract-proof",
      "share/icu",
    ],
    cwd: String.raw`D:\a\oliphaunt\release-assets`,
    shell: false,
  });
  expect(localRegistryCommandInvocation(
    "tar",
    ["-xOzf", String.raw`D:\a\oliphaunt\candidate.tgz`, "package/package.json"],
    { platform: "win32", cwd: String.raw`D:\a\oliphaunt` },
  )).toEqual({
    command: "tar",
    args: [
      "-xOzf",
      "candidate.tgz",
      "package/package.json",
    ],
    cwd: String.raw`D:\a\oliphaunt`,
    shell: false,
  });
  expect(localRegistryCommandInvocation(
    "tar",
    ["-tzf", "candidate.tgz"],
    { platform: "win32", cwd: String.raw`D:\a\oliphaunt` },
  ).args).toEqual([
    "-tzf",
    "candidate.tgz",
  ]);
  expect(localRegistryCommandInvocation(
    "pnpm",
    ["pack"],
    { platform: "win32" },
  )).toEqual({ command: "pnpm.cmd", args: ["pack"], shell: true });
  expect(localRegistryCommandInvocation(
    "tar",
    ["-tzf", "/tmp/candidate.tgz"],
    { platform: "linux" },
  )).toEqual({ command: "tar", args: ["-tzf", "/tmp/candidate.tgz"], shell: false });
});

test("inspects a registry crate independently of the repository Cargo workspace", () => {
  const targetRoot = path.join(ROOT, "target");
  mkdirSync(targetRoot, { recursive: true });
  const root = mkdtempSync(path.join(targetRoot, "oliphaunt-detached-crate-"));
  try {
    const crate = path.join(root, "detached-candidate-0.1.0.crate");
    writeFileSync(crate, canonicalExtensionArchive(new Map([
      [
        "detached-candidate-0.1.0/Cargo.toml",
        [
          "[package]",
          'name = "detached-candidate"',
          'version = "0.1.0"',
          'edition = "2024"',
          "",
          "[lib]",
          'path = "src/lib.rs"',
          "",
        ].join("\n"),
      ],
      ["detached-candidate-0.1.0/src/lib.rs", "pub fn proof() {}\n"],
    ])));
    const metadata = cargoMetadataForCrate(crate);
    expect(metadata.name).toBe("detached-candidate");
    expect(metadata.version).toBe("0.1.0");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("recovers and verifies exact Windows VC runtime members after unreliable bulk extraction", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-windows-vc-recovery-"));
  try {
    const source = path.join(root, "source");
    const bin = path.join(source, "runtime", "bin");
    const stage = path.join(root, "stage");
    const archive = path.join(root, "runtime.zip");
    mkdirSync(bin, { recursive: true });
    const names = windowsVcRuntimeProfileNames("provider").sort();
    const receipt = [];
    for (const name of names) {
      const bytes = Buffer.from(`exact-${name}\n`);
      writeFileSync(path.join(bin, name), bytes);
      receipt.push(`${createHash("sha256").update(bytes).digest("hex")}  ${name}`);
    }
    writeFileSync(path.join(bin, WINDOWS_VC_RUNTIME_RECEIPT), `${receipt.join("\n")}\n`);
    const packed = spawnSync("zip", ["-X", "-q", "-r", archive, "runtime"], {
      cwd: source,
      encoding: "utf8",
    });
    expect(packed.status, packed.stderr || packed.stdout).toBe(0);

    // Model both hosted failure shapes: the surrounding runtime tree exists,
    // while bulk extraction omitted some members and truncated others.
    mkdirSync(path.join(stage, "runtime", "bin"), { recursive: true });
    writeFileSync(path.join(stage, "runtime", "bin", WINDOWS_VC_RUNTIME_RECEIPT), "truncated\n");
    writeFileSync(path.join(stage, "runtime", "bin", names[0]), "truncated\n");
    const members = stageWindowsVcRuntimeMembers(
      archive,
      stage,
      "windows-x64-msvc",
      "runtime/bin",
      { alreadyExtracted: true, profile: "provider" },
    );
    expect(members).toEqual([
      `runtime/bin/${WINDOWS_VC_RUNTIME_RECEIPT}`,
      ...names.map((name) => `runtime/bin/${name}`),
    ]);
    for (const member of members) {
      expect(existsSync(path.join(stage, ...member.split("/")))).toBe(true);
    }
    for (const name of names) {
      expect(readFileSync(path.join(stage, "runtime", "bin", name), "utf8")).toBe(
        `exact-${name}\n`,
      );
    }

    const dryRunStage = path.join(root, "dry-run-stage");
    mkdirSync(path.join(dryRunStage, "runtime", "bin"), { recursive: true });
    writeFileSync(path.join(dryRunStage, "runtime", "bin", names[0]), "truncated\n");
    expect(stageDryRunWindowsVcRuntimeMembers(
      archive,
      dryRunStage,
      "windows-x64-msvc",
      "runtime/bin",
      { alreadyExtracted: true, profile: "provider" },
    )).toEqual(members);
    for (const name of names) {
      expect(readFileSync(path.join(dryRunStage, "runtime", "bin", name), "utf8")).toBe(
        `exact-${name}\n`,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("uses an exact lock-backed Verdaccio runtime without pnpm dlx", () => {
  const runtimeRoot = `${ROOT}/tools/release/verdaccio-runtime`;
  const runtimeManifest = JSON.parse(readFileSync(`${runtimeRoot}/package.json`, "utf8"));
  const rootManifest = JSON.parse(readFileSync(`${ROOT}/package.json`, "utf8"));
  const lock = Bun.YAML.parse(readFileSync(`${runtimeRoot}/pnpm-lock.yaml`, "utf8"));
  const workspace = readFileSync(`${ROOT}/pnpm-workspace.yaml`, "utf8");
  const source = readFileSync(`${ROOT}/tools/release/local-registry-publish.mjs`, "utf8");
  const installer = readFileSync(`${ROOT}/tools/release/install-verdaccio-runtime.sh`, "utf8");

  expect(runtimeManifest).toMatchObject({
    name: "@oliphaunt/verdaccio-runtime",
    private: true,
    packageManager: "pnpm@11.5.0",
    dependencies: { verdaccio: "6.8.0" },
  });
  expect(lock.importers?.["."]?.dependencies?.verdaccio).toEqual({
    specifier: "6.8.0",
    version: expect.stringMatching(/^6[.]8[.]0(?:$|[(])/u),
  });
  expect(lock.packages?.["verdaccio@6.8.0"]?.resolution?.integrity).toStartWith("sha512-");
  expect(rootManifest.dependencies?.verdaccio).toBeUndefined();
  expect(rootManifest.devDependencies?.verdaccio).toBeUndefined();
  expect(workspace).not.toContain("tools/release/verdaccio-runtime");
  expect(source).toContain("installVerdaccioRuntime();");
  expect(source).toContain('from "../dev/capture-command-output.mjs"');
  expect(source).toContain('["--dir", VERDACCIO_RUNTIME_ROOT, "exec", "verdaccio", "--config", config, "--listen", registryUrl]');
  expect(source).not.toContain('["dlx", "verdaccio@');
  expect(source).toContain('NPM_CONFIG_USERCONFIG: npmrc');
  expect(source).toContain('NPM_CONFIG_REGISTRY: registryUrl');
  expect(source).toContain('"--no-git-checks"');
  expect(source).not.toContain('"--userconfig"');
  expect(source).not.toContain('"--fetch-retries=0"');
  const registryCommand = source.slice(
    source.indexOf("function runPnpmRegistryCommand"),
    source.indexOf("async function publishNpmTarballs"),
  );
  expect(registryCommand).toContain('captureLocalCommand("pnpm", args');
  expect(registryCommand).not.toContain('"pipe"');
  expect(registryCommand).not.toContain('stdio: "inherit"');
  for (const token of [
    "--ignore-workspace",
    "--frozen-lockfile",
    "--ignore-scripts",
    "--trust-lockfile",
    "--prefer-offline",
    "--offline",
  ]) {
    expect(installer).toContain(token);
  }
});

test("gives expanded npm extension bundles their own schema", () => {
  const members = [
    {
      sqlName: "hstore",
      kind: "runtime",
      identity: null,
      path: "extensions/hstore/hstore.tar.gz",
      sha256: "0".repeat(64),
      bytes: 1,
      runtimeRelativePath: "extensions/hstore/runtime",
    },
  ];
  expect(
    renderNpmExtensionBundleManifest({
      product: "oliphaunt-extension-contrib-pg18",
      version: "1.2.3",
      target: "linux-x64-gnu",
      members,
    }),
  ).toEqual({
    schema: "oliphaunt-npm-extension-bundle-v1",
    product: "oliphaunt-extension-contrib-pg18",
    version: "1.2.3",
    family: "native",
    target: "linux-x64-gnu",
    members,
  });
});

test("preserves the aggregate member count in the public release carrier contract", () => {
  expect(publicExtensionReleaseAsset({
    name: "oliphaunt-extension-contrib-pg18-1.2.3-native-linux-x64-gnu-bundle.tar.gz",
    family: "native",
    target: "linux-x64-gnu",
    kind: "extension-bundle",
    identity: null,
    sha256: "a".repeat(64),
    bytes: 1234,
    memberCount: 32,
    path: "private/staging/path",
    source: "private/source/path",
  })).toEqual({
    name: "oliphaunt-extension-contrib-pg18-1.2.3-native-linux-x64-gnu-bundle.tar.gz",
    family: "native",
    target: "linux-x64-gnu",
    kind: "extension-bundle",
    identity: null,
    sha256: "a".repeat(64),
    bytes: 1234,
    memberCount: 32,
  });
});

test("keeps the full canonical desktop target map in locally staged extension meta packages", () => {
  expect(canonicalExtensionNpmTargets("oliphaunt-extension-vector")).toEqual([
    "linux-arm64-gnu",
    "linux-x64-gnu",
    "macos-arm64",
    "windows-x64-msvc",
  ]);
});

test("local Cargo staging uses the same prepared legal source as qualified SDK artifacts", () => {
  const implementation = readFileSync(
    path.join(ROOT, "tools/release/local-registry-publish.mjs"),
    "utf8",
  );
  expect(implementation).toContain("prepareOliphauntBuildReleaseSource({");
  expect(implementation).toContain("prepareRustReleaseSource({");
  expect(implementation).toContain('stageDir: path.join(releaseSourceRoot, "oliphaunt-build")');
  expect(implementation).toContain('stageDir: path.join(releaseSourceRoot, "oliphaunt")');
  expect(implementation).not.toContain(
    'path.join(ROOT, "src/sdks/rust/crates/oliphaunt-build/Cargo.toml")',
  );
});

function candidate(carrier, checksum = carrier.name) {
  return {
    cratePath: `/tmp/${carrier.name}-${carrier.version}.crate`,
    checksum,
    packageData: {
      name: carrier.name,
      version: carrier.version,
    },
  };
}

function expectedCandidates(scope) {
  return [...scope.expectedCarriers.values()].map((carrier) => candidate(carrier));
}

test("parses an exact, unique release product selection", () => {
  expect(parseCargoCandidateProductsJson('["oliphaunt-rust"]')).toEqual(["oliphaunt-rust"]);
  expect(() => parseCargoCandidateProductsJson("not-json")).toThrow("must be valid JSON");
  expect(() => parseCargoCandidateProductsJson("[]")).toThrow("non-empty JSON string list");
  expect(() => parseCargoCandidateProductsJson('["oliphaunt-rust","oliphaunt-rust"]')).toThrow(
    "must not contain duplicate products",
  );
});

test("keeps exactly selected Cargo carriers and excludes known unselected products", () => {
  const scope = createCargoCandidateScope(["oliphaunt-rust"]);
  expect([...scope.expectedCarriers.keys()].sort()).toEqual(["oliphaunt", "oliphaunt-build"]);
  const unselected = scope.fullCatalog.carriers.find(
    (carrier) => carrier.ecosystem === "cargo" && carrier.product === "oliphaunt-wasix-rust",
  );
  expect(unselected).toBeDefined();
  const result = selectScopedCargoCandidates(scope, [
    ...expectedCandidates(scope),
    candidate(unselected),
  ]);
  expect(result.selected.map((entry) => entry.packageData.name)).toEqual(["oliphaunt", "oliphaunt-build"]);
  expect(result.skipped).toHaveLength(1);
  expect(result.skipped[0]).toContain("excluded unselected Cargo carrier");
});

test("requires every declared selected Cargo carrier", () => {
  const scope = createCargoCandidateScope(["oliphaunt-rust"]);
  expect(() => selectScopedCargoCandidates(scope, expectedCandidates(scope).slice(0, 1))).toThrow(
    "missing selected Cargo carriers",
  );
});

test("rejects version drift and conflicting bytes for a selected carrier", () => {
  const scope = createCargoCandidateScope(["oliphaunt-rust"]);
  const candidates = expectedCandidates(scope);
  const drifted = structuredClone(candidates[0]);
  drifted.packageData.version = "999.0.0";
  expect(() => selectScopedCargoCandidates(scope, [drifted, ...candidates.slice(1)])).toThrow(
    "has artifact version 999.0.0",
  );

  const conflicting = { ...candidates[0], cratePath: "/tmp/conflicting.crate", checksum: "different" };
  expect(() => selectScopedCargoCandidates(scope, [...candidates, conflicting])).toThrow(
    "has conflicting candidate bytes",
  );
});

test("deduplicates byte-identical archives and permits selected dynamic part crates", () => {
  const rustScope = createCargoCandidateScope(["oliphaunt-rust"]);
  const rustCandidates = expectedCandidates(rustScope);
  const duplicate = { ...rustCandidates[0], cratePath: "/tmp/duplicate.crate" };
  const deduplicated = selectScopedCargoCandidates(rustScope, [...rustCandidates, duplicate]);
  expect(deduplicated.selected).toHaveLength(rustScope.expectedCarriers.size);
  expect(deduplicated.skipped.some((message) => message.includes("deduplicated byte-identical"))).toBe(true);

  const runtimeScope = createCargoCandidateScope(["liboliphaunt-native"]);
  const parent = runtimeScope.expectedCarriers.get("liboliphaunt-native-linux-x64-gnu");
  expect(parent).toBeDefined();
  const part = candidate({ ...parent, name: `${parent.name}-part-001` }, "part-bytes");
  const selected = selectScopedCargoCandidates(runtimeScope, [
    ...expectedCandidates(runtimeScope),
    part,
  ]);
  expect(selected.selected.some((entry) => entry.packageData.name === part.packageData.name)).toBe(true);
});

test("rejects undeclared Cargo archive identities in exact candidate roots", () => {
  const scope = createCargoCandidateScope(["oliphaunt-rust"]);
  expect(() => selectScopedCargoCandidates(scope, [
    ...expectedCandidates(scope),
    {
      cratePath: "/tmp/undeclared-0.1.0.crate",
      checksum: "undeclared",
      packageData: { name: "undeclared", version: "0.1.0" },
    },
  ])).toThrow("artifact identity cargo:undeclared is not declared");
});

test("requires an exact native extension member dependency map", () => {
  expect(exactNativeExtensionMemberDependencies(
    ["postgis", "postgis_raster"],
    { postgis: [], postgis_raster: ["postgis"] },
  )).toEqual([
    ["postgis", []],
    ["postgis_raster", ["postgis"]],
  ]);
  expect(() => exactNativeExtensionMemberDependencies(
    ["postgis", "postgis_raster"],
    { postgis: [] },
  )).toThrow('missing=["postgis_raster"], extra=[]');
  expect(() => exactNativeExtensionMemberDependencies(
    ["postgis"],
    { postgis: [], postgis_raster: ["postgis"] },
  )).toThrow('missing=[], extra=["postgis_raster"]');
});

test("derives extension carrier licenses from physical payload and target semantics", () => {
  expect(extensionMaterializer.nativeExtensionCarrierLegal(
    "oliphaunt-extension-contrib-pg18",
    ["hstore", "pgcrypto"],
    { carriesPayload: false },
  )).toEqual({ profile: "code-facade", packageSpdx: "MIT", upstreamMembers: [] });
  expect(extensionMaterializer.nativeExtensionCarrierLegal(
    "oliphaunt-extension-contrib-pg18",
    ["hstore", "pgcrypto"],
    { target: "linux-x64-gnu", carriesPayload: true },
  ).packageSpdx).toBe("MIT AND PostgreSQL");
  expect(extensionMaterializer.nativeExtensionCarrierLegal(
    "oliphaunt-extension-contrib-pg18",
    ["hstore", "pgcrypto"],
    { target: "windows-x64-msvc", carriesPayload: true },
  ).packageSpdx).toBe("MIT AND PostgreSQL AND Apache-2.0");
  expect(extensionMaterializer.nativeExtensionCarrierLegal(
    "oliphaunt-extension-vector",
    ["vector"],
    { target: "linux-x64-gnu", carriesPayload: true },
  )).toEqual({
    profile: "external-native",
    packageSpdx: "MIT AND PostgreSQL",
    upstreamMembers: ["vector"],
  });
});

test("native extension Cargo carrier assembly preserves target-qualified module bytes", {
  timeout: 30_000,
}, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-extension-carrier-bytes-"));
  const previousPath = process.env.PATH;
  const previousTrap = process.env.OLIPHAUNT_STRIP_TRAP;
  try {
    const product = "oliphaunt-extension-vector";
    const version = "9.8.7";
    const sqlName = "vector";
    const target = "linux-x64-gnu";
    const extensionRoot = path.join(root, product);
    const releaseAssets = path.join(extensionRoot, "release-assets");
    const assetName = `${product}-${version}-${target}.tar.gz`;
    const asset = path.join(releaseAssets, assetName);
    const module = elfFixture({ machine: 62, requiredVersions: ["GLIBC_2.17"] });
    const embeddedModule = elfFixture({
      machine: 62,
      requiredVersions: ["GLIBC_2.17", "GLIBC_2.27"],
    });
    // Prove Cargo materialization consumes the product-frozen compatibility
    // contract rather than the repository's live runtime version.
    const nativeRuntimeVersion = "8.7.6";
    mkdirSync(releaseAssets, { recursive: true });
    const inventory = writeExactExtensionArtifact(asset, {
      sqlName,
      target,
      nativeRuntimeVersion,
      nativeModuleStem: "vector",
      nativeModuleBytes: module,
      embeddedModuleBytes: embeddedModule,
    });
    const assetSha256 = createHash("sha256").update(readFileSync(asset)).digest("hex");
    const compatibility = frozenExtensionCompatibility(nativeRuntimeVersion);
    const runtimeAsset = {
      family: "native",
      kind: "runtime",
      target,
      identity: null,
      name: assetName,
      path: asset,
      source: asset,
      sha256: assetSha256,
      bytes: statSync(asset).size,
    };
    writeFileSync(path.join(extensionRoot, "extension-artifacts.json"), `${JSON.stringify({
      schema: "oliphaunt-extension-ci-artifacts-v1",
      product,
      version,
      compatibility,
      ...inventory,
      assets: [runtimeAsset],
    })}\n`);
    writeFileSync(path.join(releaseAssets, `${product}-${version}-manifest.json`), `${JSON.stringify({
      product,
      version,
      schema: "oliphaunt-extension-release-manifest-v1",
      versioning: "upstream-bound",
      compatibility,
      ...inventory,
      assets: [publicExtensionAsset(runtimeAsset)],
    })}\n`);

    const fakeBin = path.join(root, "fake-bin");
    const stripTrap = path.join(root, "strip-invoked");
    mkdirSync(fakeBin);
    const fakeStrip = path.join(fakeBin, "strip");
    writeFileSync(
      fakeStrip,
      "#!/bin/sh\nprintf invoked > \"$OLIPHAUNT_STRIP_TRAP\"\nexit 0\n",
    );
    chmodSync(fakeStrip, 0o755);
    process.env.PATH = `${fakeBin}${path.delimiter}${previousPath ?? ""}`;
    process.env.OLIPHAUNT_STRIP_TRAP = stripTrap;

    const result = { staged: [], skipped: [] };
    const outputs = packageNativeExtensionCargoCrates(
      [extensionRoot],
      path.join(root, "staging"),
      target,
      true,
      result,
    );
    expect(outputs).toHaveLength(1);
    expect(result.skipped).toEqual([]);
    expect(existsSync(stripTrap)).toBe(false);
    const staging = path.join(root, "staging");
    expect(existsSync(path.join(staging, "native-extension-sources"))).toBe(false);
    expect(existsSync(path.join(staging, "native-extension-cargo-target"))).toBe(false);
    expect(filesUnder(staging).filter((file) => file.endsWith(".crate"))).toEqual(outputs);
    const discovered = discoverPublicationArtifacts([staging]);
    expect(discovered.map(({ ecosystem, name, version: artifactVersion }) =>
      `${ecosystem}:${name}@${artifactVersion}`)).toEqual([
      `cargo:${nativeExtensionCargoPackageName(product, target)}@${version}`,
    ]);

    const crateName = nativeExtensionCargoPackageName(product, target);
    const packedModule = spawnSync("tar", [
      "-xOzf",
      outputs[0],
      `${crateName}-${version}/payload/lib/postgresql/vector.so`,
    ]);
    expect(packedModule.status, packedModule.stderr?.toString()).toBe(0);
    expect(createHash("sha256").update(packedModule.stdout).digest("hex")).toBe(
      createHash("sha256").update(module).digest("hex"),
    );
    const packedEmbeddedModule = spawnSync("tar", [
      "-xOzf",
      outputs[0],
      `${crateName}-${version}/payload/lib/modules/vector.so`,
    ]);
    expect(packedEmbeddedModule.status, packedEmbeddedModule.stderr?.toString()).toBe(0);
    expect(createHash("sha256").update(packedEmbeddedModule.stdout).digest("hex")).toBe(
      createHash("sha256").update(embeddedModule).digest("hex"),
    );
    expect(createHash("sha256").update(packedEmbeddedModule.stdout).digest("hex")).not.toBe(
      createHash("sha256").update(packedModule.stdout).digest("hex"),
    );
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousTrap === undefined) delete process.env.OLIPHAUNT_STRIP_TRAP;
    else process.env.OLIPHAUNT_STRIP_TRAP = previousTrap;
    rmSync(root, { recursive: true, force: true });
  }
});

test("native extension Cargo carrier streams nested bundle archives larger than one MiB", {
  timeout: 30_000,
}, () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-extension-carrier-bundle-"));
  try {
    const product = "oliphaunt-extension-vector";
    const version = "9.8.7";
    const sqlName = "vector";
    const target = "linux-x64-gnu";
    const extensionRoot = path.join(root, product);
    const releaseAssets = path.join(extensionRoot, "release-assets");
    const payload = randomBytes(2 * 1024 * 1024);
    const nativeRuntimeVersion = currentProductVersionSync("liboliphaunt-native");
    const module = elfFixture({ machine: 62, requiredVersions: ["GLIBC_2.17"] });
    const dataFile = "oliphaunt-tests/vector-bundle.bin";
    const innerName = `${product}-${version}-${target}-runtime.tar.gz`;
    const inner = path.join(root, innerName);
    const inventory = writeExactExtensionArtifact(inner, {
      sqlName,
      target,
      nativeRuntimeVersion,
      nativeModuleStem: "vector",
      nativeModuleBytes: module,
      dataFiles: [[dataFile, payload]],
    });
    expect(statSync(inner).size).toBeGreaterThan(1024 * 1024);

    const archiveRoot = `${product}-${version}-native-${target}-bundle`;
    const carrierName = `${archiveRoot}.tar.gz`;
    const memberPath = `extensions/${sqlName}/${innerName}`;
    const outerStageParent = path.join(root, "outer-stage");
    const nested = path.join(outerStageParent, archiveRoot, ...memberPath.split("/"));
    mkdirSync(path.dirname(nested), { recursive: true });
    copyFileSync(inner, nested);
    mkdirSync(releaseAssets, { recursive: true });
    const carrier = path.join(releaseAssets, carrierName);
    const outerPacked = spawnSync("tar", [
      "-czf", carrier,
      "-C", outerStageParent,
      archiveRoot,
    ]);
    expect(outerPacked.status, outerPacked.stderr?.toString()).toBe(0);
    const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
    const compatibility = frozenExtensionCompatibility(nativeRuntimeVersion);
    const runtimeAsset = {
      family: "native",
      kind: "runtime",
      target,
      identity: null,
      name: innerName,
      sha256: sha256(inner),
      bytes: statSync(inner).size,
      carrierAsset: carrierName,
      carrierRoot: archiveRoot,
      memberPath,
    };
    const carrierAsset = {
      family: "native",
      kind: "extension-bundle",
      target,
      name: carrierName,
      sha256: sha256(carrier),
      bytes: statSync(carrier).size,
      memberCount: 1,
    };
    writeFileSync(path.join(extensionRoot, "extension-artifacts.json"), `${JSON.stringify({
      schema: "oliphaunt-extension-ci-artifacts-v2",
      product,
      version,
      compatibility,
      extensions: [{
        ...inventory,
        assets: [runtimeAsset],
      }],
      carrierAssets: [carrierAsset],
    })}\n`);
    writeFileSync(path.join(releaseAssets, `${product}-${version}-manifest.json`), `${JSON.stringify({
      schema: "oliphaunt-extension-release-manifest-v2",
      product,
      version,
      versioning: "upstream-bound",
      compatibility,
      extensions: [{ ...inventory, assets: [publicExtensionAsset(runtimeAsset)] }],
      assets: [publicExtensionAsset(carrierAsset)],
    })}\n`);

    const result = { staged: [], skipped: [] };
    const outputs = packageNativeExtensionCargoCrates(
      [extensionRoot],
      path.join(root, "staging"),
      target,
      true,
      result,
    );
    expect(outputs).toHaveLength(1);
    expect(result.skipped).toEqual([]);
    const crateName = nativeExtensionCargoPackageName(product, target);
    const extracted = path.join(root, "packed-payload");
    const packedRelative = `${crateName}-${version}/payload/extensions/vector/share/postgresql/${dataFile}`;
    mkdirSync(extracted, { recursive: true });
    const packedPayload = spawnSync("tar", ["-xzf", outputs[0], "-C", extracted, packedRelative]);
    expect(packedPayload.status, packedPayload.stderr?.toString()).toBe(0);
    expect(createHash("sha256").update(readFileSync(path.join(extracted, packedRelative))).digest("hex")).toBe(
      createHash("sha256").update(payload).digest("hex"),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("split native extension Cargo carrier preserves exact member dependencies", {
  timeout: 90_000,
}, () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-extension-carrier-split-"));
  try {
    const product = "oliphaunt-extension-vector";
    const version = "9.8.7";
    const sqlName = "vector";
    const target = "linux-x64-gnu";
    const extensionRoot = path.join(root, product);
    const releaseAssets = path.join(extensionRoot, "release-assets");
    const assetName = `${product}-${version}-${target}.tar.gz`;
    const asset = path.join(releaseAssets, assetName);
    mkdirSync(releaseAssets, { recursive: true });
    const nativeRuntimeVersion = currentProductVersionSync("liboliphaunt-native");
    const module = elfFixture({ machine: 62, requiredVersions: ["GLIBC_2.17"] });
    // Incompressible bytes force the real Cargo package splitter instead of
    // merely testing its renderer in isolation.
    const inventory = writeExactExtensionArtifact(asset, {
      sqlName,
      target,
      nativeRuntimeVersion,
      nativeModuleStem: "vector",
      nativeModuleBytes: module,
      dependencies: ["cube"],
      dataFiles: [["oliphaunt-tests/vector-regression.bin", randomBytes(10 * 1024 * 1024)]],
    });
    const assetSha256 = createHash("sha256").update(readFileSync(asset)).digest("hex");
    const compatibility = frozenExtensionCompatibility(nativeRuntimeVersion);
    const runtimeAsset = {
      family: "native",
      kind: "runtime",
      target,
      identity: null,
      name: assetName,
      path: asset,
      source: asset,
      sha256: assetSha256,
      bytes: statSync(asset).size,
    };
    writeFileSync(path.join(extensionRoot, "extension-artifacts.json"), `${JSON.stringify({
      schema: "oliphaunt-extension-ci-artifacts-v1",
      product,
      version,
      compatibility,
      ...inventory,
      assets: [runtimeAsset],
    })}\n`);
    writeFileSync(path.join(releaseAssets, `${product}-${version}-manifest.json`), `${JSON.stringify({
      product,
      version,
      schema: "oliphaunt-extension-release-manifest-v1",
      versioning: "upstream-bound",
      compatibility,
      ...inventory,
      assets: [publicExtensionAsset(runtimeAsset)],
    })}\n`);

    const result = { staged: [], skipped: [] };
    const outputs = packageNativeExtensionCargoCrates(
      [extensionRoot],
      path.join(root, "staging"),
      target,
      true,
      result,
    );
    expect(result.skipped).toEqual([]);
    const crateName = nativeExtensionCargoPackageName(product, target);
    const parent = outputs.find((output) => path.basename(output) === `${crateName}-${version}.crate`);
    const parts = outputs.filter((output) => path.basename(output).startsWith(`${crateName}-part-`));
    expect(parent).toBeDefined();
    expect(parts.length).toBeGreaterThan(1);
    const staging = path.join(root, "staging");
    expect(existsSync(path.join(staging, "native-extension-sources"))).toBe(false);
    expect(existsSync(path.join(staging, "native-extension-cargo-target"))).toBe(false);
    expect(filesUnder(staging).filter((file) => file.endsWith(".crate"))).toEqual(
      [...outputs].sort(),
    );
    expect(discoverPublicationArtifacts([staging])).toHaveLength(outputs.length);

    const packedBuildScript = spawnSync("tar", [
      "-xOzf",
      parent,
      `${crateName}-${version}/build.rs`,
    ]);
    expect(packedBuildScript.status, packedBuildScript.stderr?.toString()).toBe(0);
    const buildScript = packedBuildScript.stdout.toString("utf8");
    expect(buildScript).toContain('    ("vector", &["cube"]),');
    expect(buildScript.match(/\("vector", &\["cube"\]\)/gu)).toHaveLength(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("extension registry materialization has no live global catalog dependency", () => {
  const source = readFileSync(path.join(ROOT, "tools/release/local-registry-publish.mjs"), "utf8");
  expect(source).not.toContain("src/extensions/generated/sdk/js.json");
  expect(source).not.toContain("extensionMetadata(");
  expect(source).not.toContain("extensionSqlNames(");
});

test("npm extension materialization rejects a recomputed carrier with an undeclared leaf", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-extension-npm-contaminated-"));
  try {
    const product = "oliphaunt-extension-pgtap";
    const version = "9.8.7";
    const sqlName = "pgtap";
    const target = "linux-x64-gnu";
    const extensionRoot = path.join(root, product);
    const releaseAssets = path.join(extensionRoot, "release-assets");
    const assetName = `${product}-${version}-${target}.tar.gz`;
    const asset = path.join(releaseAssets, assetName);
    const nativeRuntimeVersion = currentProductVersionSync("liboliphaunt-native");
    mkdirSync(releaseAssets, { recursive: true });
    const inventory = writeExactExtensionArtifact(asset, {
      sqlName,
      target,
      nativeRuntimeVersion,
      extraEntries: [[
        "files/share/postgresql/extension/foreign.control",
        "recomputed undeclared bytes",
      ]],
    });
    const compatibility = frozenExtensionCompatibility(nativeRuntimeVersion);
    const runtimeAsset = {
      family: "native",
      kind: "runtime",
      target,
      identity: null,
      name: assetName,
      path: asset,
      source: asset,
      sha256: createHash("sha256").update(readFileSync(asset)).digest("hex"),
      bytes: statSync(asset).size,
    };
    writeFileSync(path.join(extensionRoot, "extension-artifacts.json"), `${JSON.stringify({
      schema: "oliphaunt-extension-ci-artifacts-v1",
      product,
      version,
      compatibility,
      ...inventory,
      assets: [runtimeAsset],
    })}\n`);
    writeFileSync(path.join(releaseAssets, `${product}-${version}-manifest.json`), `${JSON.stringify({
      schema: "oliphaunt-extension-release-manifest-v1",
      product,
      version,
      versioning: "upstream-bound",
      compatibility,
      ...inventory,
      assets: [publicExtensionAsset(runtimeAsset)],
    })}\n`);
    expect(() => stageExtensionNpmPackages(
      [extensionRoot],
      path.join(root, "staging"),
      target,
      { staged: [], skipped: [] },
    )).toThrow(/undeclared extension SQL\/control file.*foreign\.control/u);

    writeFileSync(path.join(releaseAssets, `${product}-${version}-manifest.json`), `${JSON.stringify({
      schema: "oliphaunt-extension-release-manifest-v1",
      product,
      version,
      versioning: "upstream-bound",
      compatibility,
      ...inventory,
      dataFiles: ["forged/unqualified.dat"],
      assets: [publicExtensionAsset(runtimeAsset)],
    })}\n`);
    expect(() => stageExtensionNpmPackages(
      [extensionRoot],
      path.join(root, "staging-mismatched-contract"),
      target,
      { staged: [], skipped: [] },
    )).toThrow(/CI and release inventory contracts differ/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("native extension npm carrier assembly preserves exact target-qualified runtime bytes", {
  timeout: 30_000,
}, () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-extension-npm-bytes-"));
  const previousPath = process.env.PATH;
  const previousTrap = process.env.OLIPHAUNT_STRIP_TRAP;
  try {
    const product = "oliphaunt-extension-pgtap";
    const version = "9.8.7";
    const sqlName = "pgtap";
    const target = "linux-x64-gnu";
    const extensionRoot = path.join(root, product);
    const releaseAssets = path.join(extensionRoot, "release-assets");
    const assetName = `${product}-${version}-${target}.tar.gz`;
    const asset = path.join(releaseAssets, assetName);
    mkdirSync(releaseAssets, { recursive: true });
    const liboliphauntVersion = currentProductVersionSync("liboliphaunt-native");
    const inventory = writeExactExtensionArtifact(asset, {
      sqlName,
      target,
      nativeRuntimeVersion: liboliphauntVersion,
    });
    const assetSha = createHash("sha256").update(readFileSync(asset)).digest("hex");
    const assetRow = {
      family: "native",
      kind: "runtime",
      identity: null,
      name: assetName,
      path: asset,
      bytes: statSync(asset).size,
      sha256: assetSha,
    };
    const manifest = {
      schema: "oliphaunt-extension-ci-artifacts-v1",
      product,
      version,
      compatibility: frozenExtensionCompatibility(liboliphauntVersion),
      ...inventory,
      iosNativeDependencies: [],
      iosRegistration: null,
      assets: [
        { ...assetRow, target },
        { ...assetRow, target: "ios-xcframework" },
      ],
    };
    writeFileSync(
      path.join(extensionRoot, "extension-artifacts.json"),
      `${JSON.stringify(manifest)}\n`,
    );
    writeFileSync(
      path.join(releaseAssets, `${product}-${version}-manifest.json`),
      `${JSON.stringify({
        schema: "oliphaunt-extension-release-manifest-v1",
        product,
        version,
        versioning: "upstream-bound",
        compatibility: manifest.compatibility,
        ...inventory,
        assets: manifest.assets.map(publicExtensionAsset),
      })}\n`,
    );

    const baseCarrierManifest = path.join(root, "base-carrier.json");
    writeFileSync(baseCarrierManifest, `${JSON.stringify({
      product: "liboliphaunt-native",
      version: liboliphauntVersion,
      tag: `${tagPrefix("liboliphaunt-native", "test")}${liboliphauntVersion}`,
      assets: [
        { role: "base-xcframework", name: "base.zip", url: "https://example.invalid/base.zip", sha256: "0".repeat(64), bytes: 1, format: "zip", member: "base.xcframework" },
        { role: "runtime-resources", name: "runtime.tar.gz", url: "https://example.invalid/runtime.tar.gz", sha256: "1".repeat(64), bytes: 1, format: "tar.gz", member: "oliphaunt" },
        { role: "icu-data", name: "icu.tar.gz", url: "https://example.invalid/icu.tar.gz", sha256: "2".repeat(64), bytes: 1, format: "tar.gz", member: "share/icu" },
      ],
      legal: iosBaseLegalMetadata(),
    })}\n`);

    const fakeBin = path.join(root, "fake-bin");
    const stripTrap = path.join(root, "strip-invoked");
    mkdirSync(fakeBin);
    const fakeStrip = path.join(fakeBin, "strip");
    writeFileSync(
      fakeStrip,
      "#!/bin/sh\nprintf invoked > \"$OLIPHAUNT_STRIP_TRAP\"\nexit 0\n",
    );
    chmodSync(fakeStrip, 0o755);
    process.env.PATH = `${fakeBin}${path.delimiter}${previousPath ?? ""}`;
    process.env.OLIPHAUNT_STRIP_TRAP = stripTrap;

    const result = { staged: [], skipped: [] };
    const tarballRoot = stageExtensionNpmPackages(
      [extensionRoot],
      path.join(root, "staging"),
      target,
      result,
      { metaTargets: [target], baseCarrierManifest },
    );
    expect(tarballRoot).not.toBeNull();
    expect(result.skipped).toEqual([]);
    expect(existsSync(stripTrap)).toBe(false);

    const targetPackage = extensionNpmTargetPackage(sqlName, target);
    const tarball = filesUnder(tarballRoot)
      .filter((file) => file.endsWith(".tgz"))
      .find((file) => {
        const packedJson = spawnSync("tar", ["-xOzf", file, "package/package.json"], {
          encoding: "utf8",
        });
        return packedJson.status === 0 && JSON.parse(packedJson.stdout).name === targetPackage;
      });
    expect(tarball).toBeDefined();
    const packedPackageJson = spawnSync("tar", ["-xOzf", tarball, "package/package.json"], {
      encoding: "utf8",
    });
    expect(packedPackageJson.status, packedPackageJson.stderr?.toString()).toBe(0);
    expect(JSON.parse(packedPackageJson.stdout).oliphaunt.extensionContract).toBe(
      "extension-contract.json",
    );
    const packedContract = spawnSync("tar", [
      "-xOzf",
      tarball,
      "package/extension-contract.json",
    ], { encoding: "utf8" });
    expect(packedContract.status, packedContract.stderr?.toString()).toBe(0);
    expect(JSON.parse(packedContract.stdout)).toEqual(
      extensionMaterializer.renderNpmExtensionContractManifest({
        product,
        version,
        target,
        members: [inventory],
      }),
    );
    const packedModule = spawnSync("tar", [
      "-xOzf",
      tarball,
      "package/runtime/share/postgresql/extension/pgtap--1.0.0.sql",
    ]);
    expect(packedModule.status, packedModule.stderr?.toString()).toBe(0);
    expect(createHash("sha256").update(packedModule.stdout).digest("hex")).toBe(
      createHash("sha256").update("install").digest("hex"),
    );
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousTrap === undefined) delete process.env.OLIPHAUNT_STRIP_TRAP;
    else process.env.OLIPHAUNT_STRIP_TRAP = previousTrap;
    rmSync(root, { recursive: true, force: true });
  }
});
