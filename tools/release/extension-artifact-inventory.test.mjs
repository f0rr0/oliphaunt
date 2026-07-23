#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "../test/fd-backed-spawn-sync.mjs";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import test from "node:test";
import { createGzip } from "node:zlib";

import {
  EXTENSION_ARTIFACT_PROPERTY_KEYS,
  parseExtensionArtifactProperties,
  validateExtensionArtifactArchive,
} from "./extension-artifact-inventory.mjs";
import {
  EXTENSION_ARTIFACT_ARCHIVE_POLICY,
  validateExtensionArtifactArchivePlan,
} from "./extension-artifact-archive-policy.mjs";
import { canonicalGzipSync } from "./portable-archive.mjs";
import {
  extensionCarrierLegalContract,
  stageExtensionUpstreamLicenses,
} from "./extension-upstream-licenses.mjs";
import { extensionProductForSqlName } from "./release-artifact-targets.mjs";
import { stageReleaseNotices } from "./release-notices.mjs";
import { elfFixture } from "../test/release-fixture-utils.mjs";

const REPOSITORY = path.resolve(import.meta.dirname, "../..");

function writeString(buffer, offset, length, value) {
  const bytes = Buffer.from(value);
  assert.ok(bytes.length <= length);
  bytes.copy(buffer, offset);
}

function writeOctal(buffer, offset, length, value) {
  writeString(buffer, offset, length, `${value.toString(8).padStart(length - 1, "0")}\0`);
}

function tarPathParts(archiveName) {
  if (Buffer.byteLength(archiveName) <= 100) return { name: archiveName, prefix: "" };
  const parts = archiveName.split("/");
  for (let index = 1; index < parts.length; index += 1) {
    const prefix = parts.slice(0, index).join("/");
    const name = parts.slice(index).join("/");
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) {
      return { name, prefix };
    }
  }
  throw new Error(`test archive path is too long for ustar: ${archiveName}`);
}

function tarHeader(archiveName, bytes, mode = 0o644) {
  const header = Buffer.alloc(512);
  const { name, prefix } = tarPathParts(archiveName);
  writeString(header, 0, 100, name);
  writeOctal(header, 100, 8, mode);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, bytes);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  writeString(header, 156, 1, "0");
  writeString(header, 257, 6, "ustar\0");
  writeString(header, 263, 2, "00");
  writeString(header, 265, 32, "root");
  writeString(header, 297, 32, "root");
  writeString(header, 345, 155, prefix);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeString(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  return header;
}

function refreshChecksum(header) {
  header.fill(0x20, 148, 156);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeString(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
}

function rewriteTarPath(header, { name, prefix }) {
  header.fill(0, 0, 100);
  header.fill(0, 345, 500);
  writeString(header, 0, 100, name);
  writeString(header, 345, 155, prefix);
}

function canonicalArchive(entries, { mutateHeader = undefined, trailingZeroBlocks = 2 } = {}) {
  const chunks = [];
  for (const [index, [name, raw]] of [...entries].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).entries()) {
    const data = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    const header = tarHeader(name, data.length, name.includes("/lib/postgresql/") ? 0o755 : 0o644);
    mutateHeader?.(header, name, index);
    if (mutateHeader !== undefined) refreshChecksum(header);
    chunks.push(header);
    chunks.push(data);
    if (data.length % 512 !== 0) chunks.push(Buffer.alloc(512 - (data.length % 512)));
  }
  chunks.push(Buffer.alloc(512 * trailingZeroBlocks));
  return canonicalGzipSync(Buffer.concat(chunks));
}

function legalContract(sqlName, target) {
  return extensionCarrierLegalContract(
    extensionProductForSqlName(sqlName, "extension-artifact-inventory.test.mjs"),
    [sqlName],
    { family: "native", target },
  );
}

function manifest(overrides = {}) {
  const sqlName = overrides.sqlName ?? "pgtap";
  const nativeTarget = overrides.nativeTarget ?? "linux-x64-gnu";
  const legal = legalContract(sqlName, nativeTarget);
  const values = {
    packageLayout: "oliphaunt-extension-artifact-v1",
    pgMajor: "18",
    sqlName,
    createsExtension: "yes",
    nativeModuleStem: "",
    nativeModuleFile: "",
    nativeTarget,
    nativeRuntimeProduct: "liboliphaunt-native",
    nativeRuntimeVersion: "1.2.3",
    dependencies: "",
    dataFiles: "",
    extensionSqlFileNames: "uninstall_pgtap.sql",
    extensionSqlFilePrefixes: "pgtap-core,pgtap-schema",
    sharedPreloadLibraries: "",
    mobilePrebuilt: "no",
    mobileStaticArchives: "",
    mobileStaticDependencyArchives: "",
    staticSymbolPrefix: "",
    staticSymbolAliases: "",
    licenseFiles: legal.licenseFiles.join(","),
    licenseProfile: legal.profile,
    files: "files",
    ...overrides,
  };
  return `${EXTENSION_ARTIFACT_PROPERTY_KEYS.map((key) => `${key}=${values[key]}`).join("\n")}\n`;
}

async function canonicalLegalEntries(root, sqlName, target = "linux-x64-gnu") {
  const contract = legalContract(sqlName, target);
  const stage = await fs.mkdtemp(path.join(root, `legal-${sqlName}-`));
  try {
    stageReleaseNotices(stage, { profile: contract.profile });
    stageExtensionUpstreamLicenses(sqlName, path.join(stage, "files"));
    const rows = [];
    const visit = async (directory) => {
      const entries = await fs.readdir(directory, { withFileTypes: true });
      entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
      for (const entry of entries) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          await visit(file);
        } else {
          assert.equal(entry.isFile(), true, `legal fixture contains a non-file entry: ${file}`);
          rows.push([
            path.relative(stage, file).split(path.sep).join("/"),
            await fs.readFile(file),
          ]);
        }
      }
    };
    await visit(stage);
    return new Map(rows);
  } finally {
    await fs.rm(stage, { recursive: true, force: true });
  }
}

const pgtapMetadata = {
  sqlName: "pgtap",
  createsExtension: true,
  nativeModuleStem: null,
  dependencies: [],
  dataFiles: [],
  extensionSqlFileNames: ["uninstall_pgtap.sql"],
  extensionSqlFilePrefixes: ["pgtap-core", "pgtap-schema"],
  sharedPreloadLibraries: [],
};

async function writeArchive(root, name, entries, options = undefined) {
  const file = path.join(root, name);
  await fs.writeFile(file, canonicalArchive(entries, options));
  return file;
}

async function expectArchiveFailure(root, name, entries, metadata, pattern) {
  const file = await writeArchive(root, name, entries);
  assert.throws(
    () => validateExtensionArtifactArchive({
      file,
      metadata,
      target: "linux-x64-gnu",
      nativeRuntimeVersion: "1.2.3",
      label: name,
    }),
    pattern,
  );
}

async function main() {
  assert.deepEqual(EXTENSION_ARTIFACT_ARCHIVE_POLICY, {
    maxCompressedBytes: 128 * 1024 * 1024,
    maxExpandedBytes: 512 * 1024 * 1024,
    maxMemberBytes: 256 * 1024 * 1024,
    maxMembers: 4096,
  });
  const observedAndroidPostgisMembers = [154_827_564, 110_259_522, 80_534_608];
  observedAndroidPostgisMembers.length = 27;
  observedAndroidPostgisMembers.fill(0, 3);
  const observedAndroidPostgisExpanded = validateExtensionArtifactArchivePlan(
    observedAndroidPostgisMembers.map((bytes, index) => ({ name: `member-${index}`, bytes })),
    "observed Android ARM64 PostGIS artifact",
  );
  assert.ok(64_676_748 <= EXTENSION_ARTIFACT_ARCHIVE_POLICY.maxCompressedBytes);
  assert.ok(observedAndroidPostgisExpanded <= EXTENSION_ARTIFACT_ARCHIVE_POLICY.maxExpandedBytes);

  const packagerSource = await fs.readFile(
    path.join(
      REPOSITORY,
      "src/extensions/artifacts/native/tools/extension-artifact-packager.mjs",
    ),
    "utf8",
  );
  assert.doesNotMatch(
    packagerSource,
    /localeCompare/u,
    "native extension carrier ordering must be ordinal and locale-independent",
  );
  assert.match(
    packagerSource,
    /compareText\(left[.]target, right[.]target\)[\s\S]*compareText\(left[.]name, right[.]name\)/u,
    "mobile static dependency metadata must use the ordinal carrier comparator",
  );
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "oliphaunt-extension-inventory-")));
  try {
    const pgtapLegal = await canonicalLegalEntries(root, "pgtap");
    const legitimate = new Map([
      ["manifest.properties", manifest()],
      ["files/share/postgresql/extension/pgtap--1.3.5.sql", "install"],
      ["files/share/postgresql/extension/pgtap-core--fixture.sql", "owned prefix"],
      ["files/share/postgresql/extension/pgtap.control", "default_version = '1.3.5'\n"],
      ["files/share/postgresql/extension/uninstall_pgtap.sql", "owned exact"],
      ...pgtapLegal,
    ]);
    const validFile = await writeArchive(root, "legitimate.tar.gz", legitimate);
    assert.equal((await fs.readFile(validFile)).subarray(0, 10).toString("hex"), "1f8b0800000000000003");
    const validated = validateExtensionArtifactArchive({
      file: validFile,
      metadata: pgtapMetadata,
      target: "linux-x64-gnu",
      nativeRuntimeVersion: "1.2.3",
      label: "legitimate",
    });
    assert.deepEqual(
      validated.legalFiles.map(({ path: member }) => member),
      [...pgtapLegal.keys()].sort(),
    );
    assert.equal(validated.runtimeFiles.length, 4 + legalContract("pgtap", "linux-x64-gnu").licenseFiles.length);

    const pgtapUpstreamLegalMember = `files/${legalContract(
      "pgtap",
      "linux-x64-gnu",
    ).licenseFiles[0]}`;
    assert.equal(pgtapLegal.has(pgtapUpstreamLegalMember), true);
    for (const [caseName, member] of [
      ["root", "LICENSE"],
      ["upstream", pgtapUpstreamLegalMember],
    ]) {
      const missingLegal = new Map(legitimate);
      missingLegal.delete(member);
      await expectArchiveFailure(
        root,
        `missing-${caseName}-legal.tar.gz`,
        missingLegal,
        pgtapMetadata,
        new RegExp(`missing: ${member.replaceAll("/", "\\/").replaceAll(".", "\\.")}`, "u"),
      );

      const mutatedLegal = new Map(legitimate);
      mutatedLegal.set(member, `mutated ${caseName} legal bytes`);
      await expectArchiveFailure(
        root,
        `mutated-${caseName}-legal.tar.gz`,
        mutatedLegal,
        pgtapMetadata,
        /legal member .* does not match canonical bytes/u,
      );

      const executableLegalFile = await writeArchive(
        root,
        `executable-${caseName}-legal.tar.gz`,
        legitimate,
        {
          mutateHeader(header, name) {
            if (name === member) writeOctal(header, 100, 8, 0o755);
          },
        },
      );
      assert.throws(
        () => validateExtensionArtifactArchive({
          file: executableLegalFile,
          metadata: pgtapMetadata,
          target: "linux-x64-gnu",
          nativeRuntimeVersion: "1.2.3",
          label: `executable ${caseName} legal member`,
        }),
        new RegExp(`legal member ${member.replaceAll("/", "\\/").replaceAll(".", "\\.")} must have mode 0644`, "u"),
      );
    }

    const unexpectedLegal = new Map(legitimate);
    unexpectedLegal.set("THIRD_PARTY_LICENSES/undeclared.txt", "not contracted");
    await expectArchiveFailure(
      root,
      "unexpected-legal.tar.gz",
      unexpectedLegal,
      pgtapMetadata,
      /undeclared: THIRD_PARTY_LICENSES\/undeclared[.]txt/u,
    );

    for (const [name, overrides, pattern] of [
      ["license-files", { licenseFiles: "" }, /manifest licenseFiles must be/u],
      ["license-profile", { licenseProfile: "contrib-native" }, /manifest licenseProfile must be/u],
    ]) {
      const driftedLegalProperty = new Map(legitimate);
      driftedLegalProperty.set("manifest.properties", manifest(overrides));
      await expectArchiveFailure(
        root,
        `drifted-${name}.tar.gz`,
        driftedLegalProperty,
        pgtapMetadata,
        pattern,
      );
    }
    assert.throws(
      () => parseExtensionArtifactProperties(
        manifest().replace(
          /licenseFiles=([^\n]*)\nlicenseProfile=([^\n]*)\n/u,
          "licenseProfile=$2\nlicenseFiles=$1\n",
        ),
        "reordered legal properties",
      ),
      /properties must use the canonical field order/u,
    );

    const carrierSymlink = path.join(root, "carrier-symlink.tar.gz");
    await fs.symlink(validFile, carrierSymlink);
    assert.throws(
      () => validateExtensionArtifactArchive({
        file: carrierSymlink,
        metadata: pgtapMetadata,
        target: "linux-x64-gnu",
        nativeRuntimeVersion: "1.2.3",
        label: "carrier symlink",
      }),
      /regular non-symlink file/u,
    );

    const extraPaddingFile = await writeArchive(root, "extra-zero-padding.tar.gz", legitimate, {
      trailingZeroBlocks: 3,
    });
    assert.throws(
      () => validateExtensionArtifactArchive({
        file: extraPaddingFile,
        metadata: pgtapMetadata,
        target: "linux-x64-gnu",
        nativeRuntimeVersion: "1.2.3",
        label: "extra zero padding",
      }),
      /tar end marker or trailing padding is not canonical/u,
    );

    const shortAlternateSplit = await writeArchive(
      root,
      "short-alternate-ustar-split.tar.gz",
      legitimate,
      {
        mutateHeader(header, name) {
          if (name === "files/share/postgresql/extension/pgtap.control") {
            rewriteTarPath(header, {
              prefix: "files",
              name: "share/postgresql/extension/pgtap.control",
            });
          }
        },
      },
    );
    assert.throws(
      () => validateExtensionArtifactArchive({
        file: shortAlternateSplit,
        metadata: pgtapMetadata,
        target: "linux-x64-gnu",
        nativeRuntimeVersion: "1.2.3",
        label: "short alternate ustar split",
      }),
      /canonical ustar name\/prefix split/u,
    );

    const longMember = `files/share/postgresql/data/${"a".repeat(40)}/${"b".repeat(40)}/${"c".repeat(40)}.bin`;
    const longAlternateSplit = await writeArchive(
      root,
      "long-alternate-ustar-split.tar.gz",
      new Map([...legitimate, [longMember, "long path"]]),
      {
        mutateHeader(header, name) {
          if (name !== longMember) return;
          const parts = name.split("/");
          const validSplits = [];
          for (let index = 1; index < parts.length; index += 1) {
            const prefix = parts.slice(0, index).join("/");
            const memberName = parts.slice(index).join("/");
            if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(memberName) <= 100) {
              validSplits.push({ prefix, name: memberName });
            }
          }
          assert.ok(validSplits.length > 1);
          rewriteTarPath(header, validSplits[1]);
        },
      },
    );
    assert.throws(
      () => validateExtensionArtifactArchive({
        file: longAlternateSplit,
        metadata: pgtapMetadata,
        target: "linux-x64-gnu",
        nativeRuntimeVersion: "1.2.3",
        label: "long alternate ustar split",
      }),
      /canonical ustar name\/prefix split/u,
    );

    const producerRuntime = path.join(root, "producer-runtime");
    const producerExtensionDir = path.join(producerRuntime, "share/postgresql/extension");
    await fs.mkdir(producerExtensionDir, { recursive: true });
    for (const [name, bytes] of [
      ["pgtap.control", "default_version = '1.3.5'\n"],
      ["pgtap--1.3.5.sql", "install"],
      ["uninstall_pgtap.sql", "owned exact"],
      ["pgtap-core--fixture.sql", "owned prefix"],
      ["pgtap-core-evil.control", "must be filtered"],
      ["foreign.control", "must be filtered"],
    ]) {
      await fs.writeFile(path.join(producerExtensionDir, name), bytes);
    }
    const producerArchive = path.join(root, "producer-contract.tar.gz");
    const producer = spawnSync(
      path.join(REPOSITORY, "tools/dev/bun.sh"),
      [
        "src/extensions/artifacts/native/tools/extension-artifact-packager.mjs",
        "create-artifact",
        "--runtime", producerRuntime,
        "--sql-name", "pgtap",
        "--native-target", "linux-x64-gnu",
        "--native-runtime-product", "liboliphaunt-native",
        "--native-runtime-version", "1.2.3",
        "--format", "tar-gz",
        "--output", producerArchive,
        "--force",
      ],
      { cwd: REPOSITORY, encoding: "utf8" },
    );
    assert.equal(producer.status, 0, producer.stderr || producer.stdout);
    assert.equal(
      (await fs.readFile(producerArchive)).subarray(0, 10).toString("hex"),
      "1f8b0800000000000003",
    );
    const producerValidated = validateExtensionArtifactArchive({
      file: producerArchive,
      metadata: pgtapMetadata,
      target: "linux-x64-gnu",
      nativeRuntimeVersion: "1.2.3",
      label: "real producer contract",
    });
    assert.equal(producerValidated.entries.has(
      "files/share/postgresql/extension/pgtap-core-evil.control",
    ), false);
    assert.equal(producerValidated.entries.has(
      "files/share/postgresql/extension/foreign.control",
    ), false);

    await fs.writeFile(
      path.join(producerExtensionDir, "pgtap.control"),
      "default_version = '1.3.4'\n",
    );
    const sourceSkewedProducer = spawnSync(
      path.join(REPOSITORY, "tools/dev/bun.sh"),
      [
        "src/extensions/artifacts/native/tools/extension-artifact-packager.mjs",
        "create-artifact",
        "--runtime", producerRuntime,
        "--sql-name", "pgtap",
        "--native-target", "linux-x64-gnu",
        "--native-runtime-product", "liboliphaunt-native",
        "--native-runtime-version", "1.2.3",
        "--format", "tar-gz",
        "--output", path.join(root, "producer-source-version-skew.tar.gz"),
        "--force",
      ],
      { cwd: REPOSITORY, encoding: "utf8" },
    );
    assert.notEqual(sourceSkewedProducer.status, 0);
    assert.match(
      sourceSkewedProducer.stderr || sourceSkewedProducer.stdout,
      /pgtap[.]control default_version '1[.]3[.]4' does not match source-owned catalog version '1[.]3[.]5'/u,
    );
    await fs.writeFile(
      path.join(producerExtensionDir, "pgtap.control"),
      "default_version = '1.3.5'\n",
    );

    await fs.rm(path.join(producerExtensionDir, "pgtap--1.3.5.sql"));
    for (const [name, bytes] of [
      ["pgtap--1.3.3.sql", "older install"],
      ["pgtap--1.3.3--1.3.4.sql", "first update"],
      ["pgtap--1.3.4--1.3.5.sql", "default update"],
    ]) {
      await fs.writeFile(path.join(producerExtensionDir, name), bytes);
    }
    const updateChainArchive = path.join(root, "producer-update-chain.tar.gz");
    const updateChainProducer = spawnSync(
      path.join(REPOSITORY, "tools/dev/bun.sh"),
      [
        "src/extensions/artifacts/native/tools/extension-artifact-packager.mjs",
        "create-artifact",
        "--runtime", producerRuntime,
        "--sql-name", "pgtap",
        "--native-target", "linux-x64-gnu",
        "--native-runtime-product", "liboliphaunt-native",
        "--native-runtime-version", "1.2.3",
        "--format", "tar-gz",
        "--output", updateChainArchive,
        "--force",
      ],
      { cwd: REPOSITORY, encoding: "utf8" },
    );
    assert.equal(updateChainProducer.status, 0, updateChainProducer.stderr || updateChainProducer.stdout);
    const updateChainValidated = validateExtensionArtifactArchive({
      file: updateChainArchive,
      metadata: pgtapMetadata,
      target: "linux-x64-gnu",
      nativeRuntimeVersion: "1.2.3",
      label: "reachable default through packaged updates",
    });
    for (const name of [
      "pgtap--1.3.3.sql",
      "pgtap--1.3.3--1.3.4.sql",
      "pgtap--1.3.4--1.3.5.sql",
    ]) {
      assert.equal(
        updateChainValidated.entries.has(`files/share/postgresql/extension/${name}`),
        true,
        `producer omitted ${name}`,
      );
    }

    await fs.rm(path.join(producerExtensionDir, "pgtap--1.3.4--1.3.5.sql"));
    const disconnectedUpdateProducer = spawnSync(
      path.join(REPOSITORY, "tools/dev/bun.sh"),
      [
        "src/extensions/artifacts/native/tools/extension-artifact-packager.mjs",
        "create-artifact",
        "--runtime", producerRuntime,
        "--sql-name", "pgtap",
        "--native-target", "linux-x64-gnu",
        "--native-runtime-product", "liboliphaunt-native",
        "--native-runtime-version", "1.2.3",
        "--format", "tar-gz",
        "--output", path.join(root, "producer-disconnected-update.tar.gz"),
        "--force",
      ],
      { cwd: REPOSITORY, encoding: "utf8" },
    );
    assert.notEqual(disconnectedUpdateProducer.status, 0);
    assert.match(
      disconnectedUpdateProducer.stderr || disconnectedUpdateProducer.stdout,
      /default_version '1[.]3[.]5' has no canonical installation script or update path/u,
    );
    for (const name of ["pgtap--1.3.3.sql", "pgtap--1.3.3--1.3.4.sql"]) {
      await fs.rm(path.join(producerExtensionDir, name));
    }
    await fs.writeFile(path.join(producerExtensionDir, "pgtap--1.3.5.sql"), "install");

    await fs.rm(path.join(producerExtensionDir, "pgtap--1.3.5.sql"));
    await fs.writeFile(
      path.join(producerExtensionDir, "pgtap--1.3.4--1.3.5.sql"),
      "transition only",
    );
    const ancillaryOnlyProducer = spawnSync(
      path.join(REPOSITORY, "tools/dev/bun.sh"),
      [
        "src/extensions/artifacts/native/tools/extension-artifact-packager.mjs",
        "create-artifact",
        "--runtime", producerRuntime,
        "--sql-name", "pgtap",
        "--native-target", "linux-x64-gnu",
        "--native-runtime-product", "liboliphaunt-native",
        "--native-runtime-version", "1.2.3",
        "--format", "tar-gz",
        "--output", path.join(root, "producer-ancillary-only.tar.gz"),
        "--force",
      ],
      { cwd: REPOSITORY, encoding: "utf8" },
    );
    assert.notEqual(ancillaryOnlyProducer.status, 0);
    assert.match(
      ancillaryOnlyProducer.stderr || ancillaryOnlyProducer.stdout,
      /control file and canonical base install SQL/u,
    );
    await fs.rm(path.join(producerExtensionDir, "pgtap--1.3.4--1.3.5.sql"));
    await fs.writeFile(
      path.join(producerExtensionDir, "pgtap--release.sql"),
      "letter-leading version is not a canonical base install",
    );
    const letterLeadingProducer = spawnSync(
      path.join(REPOSITORY, "tools/dev/bun.sh"),
      [
        "src/extensions/artifacts/native/tools/extension-artifact-packager.mjs",
        "create-artifact",
        "--runtime", producerRuntime,
        "--sql-name", "pgtap",
        "--native-target", "linux-x64-gnu",
        "--native-runtime-product", "liboliphaunt-native",
        "--native-runtime-version", "1.2.3",
        "--format", "tar-gz",
        "--output", path.join(root, "producer-letter-leading-only.tar.gz"),
        "--force",
      ],
      { cwd: REPOSITORY, encoding: "utf8" },
    );
    assert.notEqual(letterLeadingProducer.status, 0);
    assert.match(
      letterLeadingProducer.stderr || letterLeadingProducer.stdout,
      /control file and canonical base install SQL/u,
    );
    await fs.rm(path.join(producerExtensionDir, "pgtap--release.sql"));
    await fs.writeFile(path.join(producerExtensionDir, "pgtap--1.3.5.sql"), "install");

    const streamedDataFiles = [
      "oliphaunt-streaming/a.bin",
      "oliphaunt-streaming/b.bin",
      "oliphaunt-streaming/c.bin",
    ];
    for (const [index, dataFile] of streamedDataFiles.entries()) {
      const destination = path.join(producerRuntime, "share/postgresql", dataFile);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, Buffer.alloc(24 * 1024 * 1024, index + 1));
    }
    const streamedProducerArchive = path.join(root, "producer-expanded-over-64mib.tar.gz");
    const streamedProducer = spawnSync(
      path.join(REPOSITORY, "tools/dev/bun.sh"),
      [
        "src/extensions/artifacts/native/tools/extension-artifact-packager.mjs",
        "create-artifact",
        "--runtime", producerRuntime,
        "--sql-name", "pgtap",
        "--native-target", "linux-x64-gnu",
        "--native-runtime-product", "liboliphaunt-native",
        "--native-runtime-version", "1.2.3",
        "--data-files", streamedDataFiles.join(","),
        "--format", "tar-gz",
        "--output", streamedProducerArchive,
        "--force",
      ],
      { cwd: REPOSITORY, encoding: "utf8" },
    );
    assert.equal(streamedProducer.status, 0, streamedProducer.stderr || streamedProducer.stdout);
    const streamedValidated = validateExtensionArtifactArchive({
      file: streamedProducerArchive,
      metadata: { ...pgtapMetadata, dataFiles: streamedDataFiles },
      target: "linux-x64-gnu",
      nativeRuntimeVersion: "1.2.3",
      label: "current producer expanded over 64 MiB",
    });
    assert.ok(
      streamedValidated.runtimeFiles.reduce((total, row) => total + row.bytes, 0)
        > 64 * 1024 * 1024,
    );

    const staleEighteenFieldManifest = manifest()
      .replace("extensionSqlFileNames=uninstall_pgtap.sql\n", "")
      .replace("extensionSqlFilePrefixes=pgtap-core,pgtap-schema\n", "");
    assert.throws(
      () => parseExtensionArtifactProperties(staleEighteenFieldManifest, "stale leaf manifest"),
      /property fields must be exactly/u,
    );
    for (const [field, value] of [
      ["extensionSqlFileNames", "foreign.sql"],
      ["extensionSqlFilePrefixes", "foreign-prefix"],
    ]) {
      const drifted = new Map(legitimate);
      drifted.set("manifest.properties", manifest({ [field]: value }));
      await expectArchiveFailure(
        root,
        `frozen-${field}-drift.tar.gz`,
        drifted,
        pgtapMetadata,
        new RegExp(`manifest ${field} must be`, "u"),
      );
    }

    const contaminated = new Map(legitimate);
    contaminated.set("files/share/postgresql/extension/foreign.control", "undeclared");
    await expectArchiveFailure(
      root,
      "recomputed-contaminated.tar.gz",
      contaminated,
      pgtapMetadata,
      /undeclared extension SQL\/control file.*foreign\.control/u,
    );

    const prefixedControl = new Map(legitimate);
    prefixedControl.set("files/share/postgresql/extension/pgtap-core-evil.control", "undeclared");
    await expectArchiveFailure(
      root,
      "prefixed-control.tar.gz",
      prefixedControl,
      pgtapMetadata,
      /pgtap-core-evil\.control/u,
    );

    const ancillaryOnly = new Map(legitimate);
    ancillaryOnly.delete("files/share/postgresql/extension/pgtap--1.3.5.sql");
    ancillaryOnly.set(
      "files/share/postgresql/extension/pgtap--1.3.4--1.3.5.sql",
      "transition SQL is owned but is not a base install",
    );
    await expectArchiveFailure(
      root,
      "ancillary-only.tar.gz",
      ancillaryOnly,
      pgtapMetadata,
      /control and canonical base installation SQL/u,
    );

    const disconnectedDefault = new Map(legitimate);
    disconnectedDefault.delete("files/share/postgresql/extension/pgtap--1.3.5.sql");
    disconnectedDefault.set("files/share/postgresql/extension/pgtap--1.3.3.sql", "older install");
    disconnectedDefault.set(
      "files/share/postgresql/extension/pgtap--1.3.3--1.3.4.sql",
      "incomplete update path",
    );
    await expectArchiveFailure(
      root,
      "disconnected-default.tar.gz",
      disconnectedDefault,
      pgtapMetadata,
      /default_version '1[.]3[.]5' has no canonical installation script or update path/u,
    );

    const plainSqlOnly = new Map(legitimate);
    plainSqlOnly.delete("files/share/postgresql/extension/pgtap--1.3.5.sql");
    plainSqlOnly.set(
      "files/share/postgresql/extension/pgtap.sql",
      "PostgreSQL 18 does not discover this as a versioned install script",
    );
    await expectArchiveFailure(
      root,
      "plain-sql-only.tar.gz",
      plainSqlOnly,
      pgtapMetadata,
      /control and canonical base installation SQL/u,
    );

    const letterLeadingOnly = new Map(legitimate);
    letterLeadingOnly.delete("files/share/postgresql/extension/pgtap--1.3.5.sql");
    letterLeadingOnly.set(
      "files/share/postgresql/extension/pgtap--release.sql",
      "letter-leading version is owned but is not a base install",
    );
    await expectArchiveFailure(
      root,
      "letter-leading-only.tar.gz",
      letterLeadingOnly,
      pgtapMetadata,
      /control and canonical base installation SQL/u,
    );

    const autoExplainMetadata = {
      ...pgtapMetadata,
      sqlName: "auto_explain",
      createsExtension: false,
      nativeModuleStem: "auto_explain",
      extensionSqlFileNames: [],
      extensionSqlFilePrefixes: [],
    };
    const moduleFile = "auto_explain.so";
    const producerAutoRuntime = path.join(root, "producer-auto-runtime");
    const producerAutoEmbedded = path.join(root, "producer-auto-embedded");
    const stripShim = path.join(root, "no-op-elf-strip");
    await fs.mkdir(path.join(producerAutoRuntime, "lib/postgresql"), { recursive: true });
    await fs.mkdir(producerAutoEmbedded, { recursive: true });
    await fs.writeFile(
      path.join(producerAutoRuntime, "lib/postgresql", moduleFile),
      elfFixture({ machine: 62 }),
    );
    await fs.writeFile(
      path.join(producerAutoEmbedded, moduleFile),
      elfFixture({ machine: 62, requiredVersions: ["GLIBC_2.17"] }),
    );
    await fs.chmod(path.join(producerAutoRuntime, "lib/postgresql", moduleFile), 0o755);
    await fs.chmod(path.join(producerAutoEmbedded, moduleFile), 0o755);
    await fs.writeFile(stripShim, "#!/usr/bin/env sh\nexit 0\n");
    await fs.chmod(stripShim, 0o755);
    const producerAutoArchive = path.join(root, "producer-auto-explain.tar.gz");
    const producerAuto = spawnSync(
      path.join(REPOSITORY, "tools/dev/bun.sh"),
      [
        "src/extensions/artifacts/native/tools/extension-artifact-packager.mjs",
        "create-artifact",
        "--runtime", producerAutoRuntime,
        "--embedded-module-root", producerAutoEmbedded,
        "--sql-name", "auto_explain",
        "--creates-extension", "false",
        "--native-module-stem", "auto_explain",
        "--native-module-file", moduleFile,
        "--native-target", "linux-x64-gnu",
        "--native-runtime-product", "liboliphaunt-native",
        "--native-runtime-version", "1.2.3",
        "--stage-root", path.join(root, "producer-stage"),
        "--format", "tar-gz",
        "--output", producerAutoArchive,
        "--force",
      ],
      {
        cwd: REPOSITORY,
        encoding: "utf8",
        env: { ...process.env, OLIPHAUNT_ELF_STRIP: stripShim },
      },
    );
    assert.equal(producerAuto.status, 0, producerAuto.stderr || producerAuto.stdout);
    const producerAutoValidated = validateExtensionArtifactArchive({
      file: producerAutoArchive,
      metadata: autoExplainMetadata,
      target: "linux-x64-gnu",
      nativeRuntimeVersion: "1.2.3",
      label: "dual-profile producer contract",
    });
    const serverMember = `files/lib/postgresql/${moduleFile}`;
    const embeddedMember = `files/lib/modules/${moduleFile}`;
    assert.equal(producerAutoValidated.entries.has(serverMember), true);
    assert.equal(producerAutoValidated.entries.has(embeddedMember), true);
    assert.notEqual(
      producerAutoValidated.entries.get(serverMember).sha256,
      producerAutoValidated.entries.get(embeddedMember).sha256,
      "normal and embedded module byte identities must remain independently frozen",
    );

    const missingEmbeddedRootProducer = spawnSync(
      path.join(REPOSITORY, "tools/dev/bun.sh"),
      [
        "src/extensions/artifacts/native/tools/extension-artifact-packager.mjs",
        "create-artifact",
        "--runtime", producerAutoRuntime,
        "--sql-name", "auto_explain",
        "--creates-extension", "false",
        "--native-module-stem", "auto_explain",
        "--native-module-file", moduleFile,
        "--native-target", "linux-x64-gnu",
        "--native-runtime-product", "liboliphaunt-native",
        "--native-runtime-version", "1.2.3",
        "--output", path.join(root, "producer-auto-explain-missing-embedded"),
        "--force",
      ],
      { cwd: REPOSITORY, encoding: "utf8" },
    );
    assert.notEqual(missingEmbeddedRootProducer.status, 0);
    assert.match(
      missingEmbeddedRootProducer.stderr || missingEmbeddedRootProducer.stdout,
      /desktop prebuilt extension artifacts with nativeModuleStem require --embedded-module-root/u,
    );
    const sqlOnlyEmbeddedRootProducer = spawnSync(
      path.join(REPOSITORY, "tools/dev/bun.sh"),
      [
        "src/extensions/artifacts/native/tools/extension-artifact-packager.mjs",
        "create-artifact",
        "--runtime", producerRuntime,
        "--embedded-module-root", producerAutoEmbedded,
        "--sql-name", "pgtap",
        "--native-target", "linux-x64-gnu",
        "--native-runtime-product", "liboliphaunt-native",
        "--native-runtime-version", "1.2.3",
        "--output", path.join(root, "producer-pgtap-unexpected-embedded"),
        "--force",
      ],
      { cwd: REPOSITORY, encoding: "utf8" },
    );
    assert.notEqual(sqlOnlyEmbeddedRootProducer.status, 0);
    assert.match(
      sqlOnlyEmbeddedRootProducer.stderr || sqlOnlyEmbeddedRootProducer.stdout,
      /--embedded-module-root is only valid for desktop native-module extension artifacts/u,
    );
    const autoExplain = new Map([
      ["manifest.properties", manifest({
        sqlName: "auto_explain",
        createsExtension: "no",
        nativeModuleStem: "auto_explain",
        nativeModuleFile: "auto_explain.so",
        extensionSqlFileNames: "",
        extensionSqlFilePrefixes: "",
      })],
      ["files/lib/postgresql/auto_explain.so", "module"],
      ["files/share/postgresql/extension/auto_explain.control", "undeclared"],
    ]);
    await expectArchiveFailure(
      root,
      "load-only-control.tar.gz",
      autoExplain,
      autoExplainMetadata,
      /auto_explain\.control/u,
    );

    const postgisMetadata = {
      sqlName: "postgis",
      createsExtension: true,
      nativeModuleStem: "postgis-3",
      dependencies: [],
      dataFiles: [
        "contrib/postgis-3.6/legacy.sql",
        "contrib/postgis-3.6/legacy_gist.sql",
        "contrib/postgis-3.6/legacy_minimal.sql",
        "contrib/postgis-3.6/postgis.sql",
        "contrib/postgis-3.6/postgis_upgrade.sql",
        "contrib/postgis-3.6/spatial_ref_sys.sql",
        "contrib/postgis-3.6/uninstall_legacy.sql",
        "contrib/postgis-3.6/uninstall_postgis.sql",
        "proj/proj.db",
      ],
      extensionSqlFileNames: [],
      extensionSqlFilePrefixes: ["postgis_comments"],
      sharedPreloadLibraries: [],
    };
    const postgisLegal = await canonicalLegalEntries(root, "postgis");
    const postgis = new Map([
      ["manifest.properties", manifest({
        sqlName: "postgis",
        nativeModuleStem: "postgis-3",
        nativeModuleFile: "postgis-3.so",
        dataFiles: postgisMetadata.dataFiles.join(","),
        extensionSqlFileNames: postgisMetadata.extensionSqlFileNames.join(","),
        extensionSqlFilePrefixes: postgisMetadata.extensionSqlFilePrefixes.join(","),
      })],
      ["files/lib/postgresql/postgis-3.so", "module"],
      ["files/lib/modules/postgis-3.so", "embedded module"],
      ["files/share/postgresql/extension/postgis--3.6.1--3.6.2.sql", "upgrade"],
      ["files/share/postgresql/extension/postgis--3.6.2--3.6.3.sql", "upgrade"],
      ["files/share/postgresql/extension/postgis--3.6.3.sql", "install"],
      ["files/share/postgresql/extension/postgis.control", "default_version = '3.6.3'\n"],
      ...postgisMetadata.dataFiles.map((dataFile) => [
        `files/share/postgresql/${dataFile}`,
        `declared data ${dataFile}`,
      ]),
      ...postgisLegal,
    ]);
    const postgisFile = await writeArchive(root, "postgis-legitimate.tar.gz", postgis);
    const validatedPostgis = validateExtensionArtifactArchive({
      file: postgisFile,
      metadata: postgisMetadata,
      target: "linux-x64-gnu",
      nativeRuntimeVersion: "1.2.3",
      label: "postgis legitimate",
    });
    assert.equal(
      validatedPostgis.runtimeFiles.length,
      [...postgis.keys()].filter((member) => member.startsWith("files/")).length,
    );
    assert.deepEqual(
      validatedPostgis.legalFiles.map(({ path: member }) => member),
      [...postgisLegal.keys()].sort(),
    );

    const missingEmbeddedPostgis = new Map(postgis);
    missingEmbeddedPostgis.delete("files/lib/modules/postgis-3.so");
    await expectArchiveFailure(
      root,
      "postgis-missing-embedded-module.tar.gz",
      missingEmbeddedPostgis,
      postgisMetadata,
      /missing: files\/lib\/modules\/postgis-3[.]so/u,
    );

    for (const [name, text, pattern] of [
      ["bom", `\uFEFF${manifest()}`, /canonical NFC UTF-8/u],
      ["crlf", manifest().replaceAll("\n", "\r\n"), /canonical NFC UTF-8/u],
      ["blank", manifest().replace("pgMajor=18\n", "pgMajor=18\n\n"), /internal blank line/u],
      ["duplicate", manifest().replace("pgMajor=18\n", "pgMajor=18\npgMajor=18\n"), /repeats property pgMajor/u],
    ]) {
      assert.throws(
        () => parseExtensionArtifactProperties(text, name),
        pattern,
      );
    }

    const invalidUtf8 = new Map(legitimate);
    invalidUtf8.set("manifest.properties", Buffer.concat([Buffer.from(manifest().slice(0, -1)), Buffer.from([0xff, 0x0a])]));
    await expectArchiveFailure(
      root,
      "invalid-utf8.tar.gz",
      invalidUtf8,
      pgtapMetadata,
      /invalid UTF-8/u,
    );
    const bomManifest = new Map(legitimate);
    bomManifest.set("manifest.properties", Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(manifest()),
    ]));
    await expectArchiveFailure(
      root,
      "bom-manifest.tar.gz",
      bomManifest,
      pgtapMetadata,
      /canonical NFC UTF-8/u,
    );

    const caseCollision = new Map(legitimate);
    caseCollision.set("files/share/postgresql/extension/Pgtap.control", "collision");
    await expectArchiveFailure(
      root,
      "case-collision.tar.gz",
      caseCollision,
      pgtapMetadata,
      /case\/NFC-colliding members/u,
    );

    for (const [name, memberPath, pattern] of [
      ["backslash-path", "files\\share/postgresql/extension/evil", /without backslashes/u],
      ["traversal-path", "../evil", /canonical relative path/u],
      ["non-nfc-path", "files/share/postgresql/extension/pgta\u0065\u0301.sql", /NFC UTF-8/u],
    ]) {
      const entries = new Map(legitimate);
      entries.set(memberPath, "unsafe");
      await expectArchiveFailure(root, `${name}.tar.gz`, entries, pgtapMetadata, pattern);
    }

    const duplicateMembers = [...legitimate, [
      "files/share/postgresql/extension/pgtap.control",
      "duplicate",
    ]];
    await expectArchiveFailure(
      root,
      "duplicate-member.tar.gz",
      duplicateMembers,
      pgtapMetadata,
      /duplicate member.*pgtap\.control/u,
    );

    const symlinkFile = await writeArchive(root, "symlink-type.tar.gz", legitimate, {
      mutateHeader(header, _name, index) {
        if (index === 0) header[156] = "2".charCodeAt(0);
      },
    });
    assert.throws(
      () => validateExtensionArtifactArchive({
        file: symlinkFile,
        metadata: pgtapMetadata,
        target: "linux-x64-gnu",
        nativeRuntimeVersion: "1.2.3",
        label: "symlink type",
      }),
      /must be a regular file/u,
    );

    const invalidHeader = Buffer.from(await fs.readFile(validFile));
    invalidHeader[9] = 0x13;
    const invalidHeaderFile = path.join(root, "invalid-gzip-header.tar.gz");
    await fs.writeFile(invalidHeaderFile, invalidHeader);
    assert.throws(
      () => validateExtensionArtifactArchive({
        file: invalidHeaderFile,
        metadata: pgtapMetadata,
        target: "linux-x64-gnu",
        nativeRuntimeVersion: "1.2.3",
        label: "invalid gzip header",
      }),
      /canonical cross-platform gzip header/u,
    );

    const invalidAlias = new Map(legitimate);
    invalidAlias.set("manifest.properties", manifest({ staticSymbolAliases: "sql:not-valid!" }));
    await expectArchiveFailure(
      root,
      "invalid-alias.tar.gz",
      invalidAlias,
      pgtapMetadata,
      /C-identifier pair/u,
    );
    const duplicateAlias = new Map(legitimate);
    duplicateAlias.set(
      "manifest.properties",
      manifest({ staticSymbolAliases: "sql_symbol:linked_one,sql_symbol:linked_two" }),
    );
    await expectArchiveFailure(
      root,
      "duplicate-alias.tar.gz",
      duplicateAlias,
      pgtapMetadata,
      /repeats SQL-visible symbol sql_symbol/u,
    );

    const oversizedMemberName = "files/share/postgresql/extension/pgtap--oversized.sql";
    const oversizedMember = new Map(legitimate);
    oversizedMember.set(oversizedMemberName, "declared-size-only");
    const oversizedMemberFile = await writeArchive(
      root,
      "oversized-member.tar.gz",
      oversizedMember,
      {
        mutateHeader(header, name) {
          if (name === oversizedMemberName) {
            writeOctal(
              header,
              124,
              12,
              EXTENSION_ARTIFACT_ARCHIVE_POLICY.maxMemberBytes + 1,
            );
          }
        },
      },
    );
    assert.throws(
      () => validateExtensionArtifactArchive({
        file: oversizedMemberFile,
        metadata: pgtapMetadata,
        target: "linux-x64-gnu",
        nativeRuntimeVersion: "1.2.3",
        label: "oversized member",
      }),
      /member .* exceeds 268435456 bytes/u,
    );

    assert.throws(
      () => validateExtensionArtifactArchivePlan([
        { name: "one", bytes: EXTENSION_ARTIFACT_ARCHIVE_POLICY.maxMemberBytes },
        { name: "two", bytes: EXTENSION_ARTIFACT_ARCHIVE_POLICY.maxMemberBytes },
      ]),
      /expands beyond 536870912 bytes/u,
    );

    const excessiveMembers = new Map([["manifest.properties", manifest()]]);
    for (let index = 0; index < 4097; index += 1) {
      excessiveMembers.set(
        `files/share/postgresql/extension/pgtap--${String(index).padStart(4, "0")}.sql`,
        "x",
      );
    }
    await expectArchiveFailure(
      root,
      "excessive-members.tar.gz",
      excessiveMembers,
      pgtapMetadata,
      /more than 4096 members/u,
    );

    const unbounded = path.join(root, "expanded-bomb.tar.gz");
    async function* oversizedZeros() {
      const chunk = Buffer.alloc(1024 * 1024);
      const chunks = EXTENSION_ARTIFACT_ARCHIVE_POLICY.maxExpandedBytes / chunk.length + 1;
      for (let index = 0; index < chunks; index += 1) yield chunk;
    }
    await pipeline(Readable.from(oversizedZeros()), createGzip(), createWriteStream(unbounded));
    const unboundedDescriptor = await fs.open(unbounded, "r+");
    try {
      await unboundedDescriptor.write(Buffer.from("1f8b0800000000000003", "hex"), 0, 10, 0);
    } finally {
      await unboundedDescriptor.close();
    }
    assert.throws(
      () => validateExtensionArtifactArchive({
        file: unbounded,
        metadata: pgtapMetadata,
        target: "linux-x64-gnu",
        nativeRuntimeVersion: "1.2.3",
        label: "expanded bomb",
      }),
      /valid bounded gzip stream|expanded archive exceeds/u,
    );

    console.log("extension-artifact-inventory.test.mjs: exact inventory and adversarial bounds checks passed");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("extension artifact inventory enforces exact inventory and adversarial bounds", main);
