import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync, zstdCompressSync } from 'node:zlib';
import { canonicalWasixAotMetadata } from '../../src/wasix/runtime/tools/wasix-aot-manifest.mts';
import {
  AOT_PACKAGES,
  AOT_TARGET_TRIPLES,
  CORE_AOT_ARTIFACTS,
  CORE_RUNTIME_ARCHIVE_FILES,
  RUNTIME_PACKAGE,
} from '../../src/wasix/runtime/tools/wasix-cargo-artifact-contract.mts';
import { readPortableArchiveEntries } from '../../tools/packaging/portable-archive.mts';
import { renderToml } from '../languages/cargo-metadata.mts';
import { packageRuntimeCargo, type RuntimeCargoSpec } from './cargo.mts';
import {
  extractWasixCargoConstructionInputs,
  wasixHostSmokeCargoIdentities,
  wasixHostSmokeCargoRows,
  wasixRuntimeCargoParent,
  writeWasixCargoConstructionReceipt,
} from './cargo-inputs.mts';

const root = mkdtempSync(path.join(os.tmpdir(), 'wasix-packed-carriers-'));
const versionManifest = path.resolve('src/wasix/runtime/crates/assets/Cargo.toml');
const version = Bun.TOML.parse(readFileSync(versionManifest, 'utf8')).package.version;
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

function copyFile(sourceRoot: string, relative: string, source: string) {
  const destination = path.join(sourceRoot, relative);
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, readFileSync(source));
}

async function makeInput(targetId: string | null, { base = root, oversized = false } = {}) {
  const packageName = targetId === null ? RUNTIME_PACKAGE : AOT_PACKAGES[targetId];
  const triple = targetId === null ? null : AOT_TARGET_TRIPLES[targetId];
  const canonical = canonicalWasixAotMetadata(undefined, triple ?? undefined);
  const payload = path.join(base, `payload-${targetId ?? 'portable'}`);
  mkdirSync(payload, { recursive: true });
  const moduleBytes = Buffer.from('\0asm\x01\0\0\0');
  const payloadManifest =
    targetId === null
      ? {
          extensions: [],
          runtime: {
            archive: 'oliphaunt.wasix.tar.zst',
            sha256: sha(zstdCompressSync(Buffer.from('placeholder'))),
          },
        }
      : {
          'source-lane': canonical.sourceLane,
          engine: canonical.engine,
          'wasmer-version': canonical.wasmerVersion,
          'wasmer-wasix-version': canonical.wasmerWasixVersion,
          'format-version': 1,
          'target-triple': triple,
          'source-fingerprint': 'independent fixture',
          artifacts: [],
        };
  if (targetId === null) {
    const archive = new Bun.Archive(
      Object.fromEntries(CORE_RUNTIME_ARCHIVE_FILES.map((file) => [file, moduleBytes])),
    );
    const bytes = zstdCompressSync(Buffer.from(await archive.bytes()));
    writeFileSync(path.join(payload, 'oliphaunt.wasix.tar.zst'), bytes);
    payloadManifest.runtime.sha256 = sha(bytes);
    mkdirSync(path.join(payload, 'bin'), { recursive: true });
    writeFileSync(path.join(payload, 'bin/initdb.wasix.wasm'), moduleBytes);
  } else {
    payloadManifest.artifacts = CORE_AOT_ARTIFACTS.map((name, index) => {
      const raw =
        oversized && index === 0
          ? randomBytes(12 * 1024 * 1024)
          : Buffer.from(`independent serialized-image fixture ${name}`);
      const bytes = zstdCompressSync(raw);
      const file = `${index}.bin.zst`;
      writeFileSync(path.join(payload, file), bytes);
      return {
        name,
        path: file,
        compressed: true,
        sha256: sha(bytes),
        'module-sha256': sha(moduleBytes),
        'raw-sha256': sha(raw),
        'raw-size': raw.length,
      };
    });
  }
  const manifestFile = path.join(payload, 'manifest.json');
  writeFileSync(manifestFile, `${JSON.stringify(payloadManifest)}\n`);

  const template =
    targetId === null
      ? path.resolve('src/wasix/runtime/crates/assets')
      : path.resolve('src/wasix/runtime/crates/aot', triple!);
  const sources = Object.fromEntries(
    ['Cargo.toml', 'README.md', 'build.rs', 'build-support.rs', 'src/lib.rs'].map((file) => [
      file,
      path.join(template, file),
    ]),
  );
  const notices = {
    LICENSE: path.resolve('LICENSE'),
    'THIRD_PARTY_NOTICES.md': path.resolve('THIRD_PARTY_NOTICES.md'),
    'src/wasix/sdks/rust/THIRD_PARTY_NOTICES.md': path.resolve(
      'src/wasix/sdks/rust/THIRD_PARTY_NOTICES.md',
    ),
    'src/third-party/postgres/COPYRIGHT': path.resolve('src/third-party/postgres/COPYRIGHT'),
    'src/third-party/postgres/source.toml': path.resolve('src/third-party/postgres/source.toml'),
    'src/third-party/icu/LICENSE': path.resolve('src/third-party/icu/LICENSE'),
    'src/third-party/icu/source.toml': path.resolve('src/third-party/icu/source.toml'),
  };
  const sourceRoot = path.join(base, `source-${targetId ?? 'portable'}`);
  for (const [relative, source] of Object.entries(notices)) copyFile(sourceRoot, relative, source);
  copyFile(
    sourceRoot,
    'src/wasix/runtime/toolchain.toml',
    path.resolve('src/wasix/runtime/toolchain.toml'),
  );
  copyFile(
    sourceRoot,
    'src/wasix/runtime/engine/sources.json',
    path.resolve('src/wasix/runtime/engine/sources.json'),
  );

  const payloadFiles = [manifestFile];
  if (targetId === null) {
    payloadFiles.push(
      path.join(payload, 'oliphaunt.wasix.tar.zst'),
      path.join(payload, 'bin/initdb.wasix.wasm'),
    );
  } else {
    payloadFiles.push(...payloadManifest.artifacts.map((row) => path.join(payload, row.path)));
  }
  const spec: RuntimeCargoSpec = {
    version,
    packageName,
    target: targetId,
    payload,
    payloadFiles,
    sources,
    notices,
    toolchain: path.resolve('src/wasix/runtime/toolchain.toml'),
    engineSources: path.resolve('src/wasix/runtime/engine/sources.json'),
    partsReader: path.resolve('build_defs/wasix/cargo-parts.rs'),
  };
  const files = packageRuntimeCargo(spec, path.join(base, `packages-${packageName}`));
  const file = files.find((file) => path.basename(file) === `${packageName}-${version}.crate`)!;
  return { file, files, name: packageName, target: targetId ?? 'portable', sourceRoot };
}

test('imports genuine canonical crate envelopes and rejects receipt substitutions', async () => {
  try {
    const inputDirectory = path.join(root, 'inputs');
    mkdirSync(inputDirectory);
    const packed = await Promise.all(
      [null, ...Object.keys(AOT_PACKAGES)].map((target) => makeInput(target)),
    );
    const inputs = packed.map((row) => {
      const file = path.join(inputDirectory, path.basename(row.file));
      writeFileSync(file, readFileSync(row.file));
      return { ...row, file };
    });
    const releaseManifest = path.resolve('src/wasix/runtime/release.toml');
    const toolchainManifest = path.resolve('src/wasix/runtime/toolchain.toml');
    const cargoLock = path.resolve('Cargo.lock');
    const receipt = writeWasixCargoConstructionReceipt(inputs, {
      sourceCommit: '1'.repeat(40),
      sourceTree: '2'.repeat(40),
      releaseManifest,
      toolchainManifest,
      cargoLock,
      versionManifest,
    });
    const output = path.join(root, 'repository');
    extractWasixCargoConstructionInputs(receipt, inputDirectory, '1'.repeat(40), output, {
      releaseManifest,
      toolchainManifest,
      cargoLock,
      versionManifest,
      rustDefs: '@@main//build_defs/languages:rust.bzl',
      cratesDefs: '@@cargo_crates//:defs.bzl',
      sourceRoot: packed[0].sourceRoot,
    });
    for (const row of packed) {
      const triple = row.target === 'portable' ? null : AOT_TARGET_TRIPLES[row.target];
      const packagePath = triple
        ? path.join(output, 'src/wasix/runtime/crates/aot', triple)
        : path.join(output, 'src/wasix/runtime/crates/assets');
      const sourcePath = triple
        ? path.resolve('src/wasix/runtime/crates/aot', triple)
        : path.resolve('src/wasix/runtime/crates/assets');
      assert.equal(
        readFileSync(path.join(packagePath, 'src/lib.rs'), 'utf8'),
        readFileSync(path.join(sourcePath, 'src/lib.rs'), 'utf8'),
      );
      assert.equal(
        readFileSync(path.join(packagePath, 'build-support.rs'), 'utf8'),
        readFileSync(path.join(sourcePath, 'build-support.rs'), 'utf8'),
      );
      assert.equal(
        readFileSync(path.join(packagePath, 'build.rs'), 'utf8'),
        'const PACKAGE_LOCAL: bool = true;\ninclude!("build-support.rs");\n',
      );
      const payloadDir = path.join(packagePath, triple ? 'artifacts' : 'payload');
      assert(existsSync(path.join(payloadDir, 'manifest.json')));
      assert.match(
        readFileSync(path.join(packagePath, 'BUILD.bazel'), 'utf8'),
        /cargo_generator\(/u,
      );
    }
    const cargoBzl = readFileSync(path.join(output, 'cargo.bzl'), 'utf8');
    assert.match(cargoBzl, /^CARGO = \{/u);
    assert.match(cargoBzl, /release_strip": None/u);
    assert.match(cargoBzl, /oliphaunt_artifact_liboliphaunt_wasix_runtime/u);
    assert(!cargoBzl.includes('wasix_runtime_carriers'));
    const generatedBuild = readFileSync(
      path.join(output, 'src/wasix/runtime/crates/assets/BUILD.bazel'),
      'utf8',
    );
    assert(generatedBuild.includes('@@main//build_defs/languages:rust.bzl'));
    assert(generatedBuild.includes('@@cargo_crates//:defs.bzl'));
    assert.equal(
      readFileSync(path.join(output, 'Cargo.lock'), 'utf8'),
      readFileSync(cargoLock, 'utf8'),
    );
    assert(!existsSync(path.join(output, '.staged')));
    assert.equal(receipt.crates.find((row) => row.name === RUNTIME_PACKAGE)?.role, 'platform-leaf');

    // Public support envelopes are immutable data inputs, never projected into
    // foreign Cargo libraries or used to start a foreign WASIX producer.
    const toolsManifestPath = 'src/wasix/postgres-tools/crates/tools/Cargo.toml';
    copyFile(packed[0].sourceRoot, toolsManifestPath, path.resolve(toolsManifestPath));
    const supportArchive = async (
      identity: ReturnType<typeof wasixHostSmokeCargoIdentities>[number],
      name = identity.name,
      {
        dependencies = {},
        payload = {},
        metadata = {},
        archiveVersion = identity.version,
      } = {} as {
        dependencies?: Record<string, unknown>;
        payload?: Record<string, string>;
        metadata?: Record<string, unknown>;
        archiveVersion?: string;
      },
    ) => {
      const file = path.join(inputDirectory, `${name}-${identity.version}.crate`);
      const prefix = `${name}-${archiveVersion}`;
      const envelope = new Bun.Archive({
        [`${prefix}/Cargo.toml`]: renderToml({
          package: { name, version: archiveVersion, metadata },
          'build-dependencies': dependencies,
        }),
        ...Object.fromEntries(
          Object.entries(payload).map(([name, bytes]) => [`${prefix}/payload/${name}`, bytes]),
        ),
      });
      writeFileSync(file, gzipSync(Buffer.from(await envelope.bytes())));
      return { file, name, target: identity.target };
    };
    const supportIdentities = wasixHostSmokeCargoIdentities(packed[0].sourceRoot, version);
    const hostSmokeInputs = (
      await Promise.all(
        supportIdentities.map(async (identity) => {
          if (identity.product !== 'liboliphaunt-wasix') return [await supportArchive(identity)];
          const names = ['001', '002'].map((part) => `${identity.name}-part-${part}`);
          return Promise.all([
            supportArchive(identity, identity.name, {
              dependencies: Object.fromEntries(
                names.map((name) => [name, { version: `=${identity.version}` }]),
              ),
            }),
            ...names.map((name, index) =>
              supportArchive(identity, name, {
                payload: { [`chunks/example.part00000${index}`]: String(index) },
              }),
            ),
          ]);
        }),
      )
    ).flat();
    const supportReceipt = writeWasixCargoConstructionReceipt(inputs, {
      sourceCommit: '1'.repeat(40),
      sourceTree: '2'.repeat(40),
      releaseManifest,
      toolchainManifest,
      cargoLock,
      versionManifest,
      hostSmokeInputs,
      sourceRoot: packed[0].sourceRoot,
    });
    const supportOutput = path.join(root, 'host-repository');
    const importSupport = (value: unknown, destination: string) =>
      extractWasixCargoConstructionInputs(value, inputDirectory, '1'.repeat(40), destination, {
        releaseManifest,
        toolchainManifest,
        cargoLock,
        versionManifest,
        rustDefs: '@@main//build_defs/languages:rust.bzl',
        cratesDefs: '@@cargo_crates//:defs.bzl',
        sourceRoot: packed[0].sourceRoot,
      });
    importSupport(supportReceipt, supportOutput);
    assert.equal(supportReceipt.hostSmokeCrates?.length, 20);
    const contribIdentity = supportIdentities.find((row) => row.target === 'wasix-portable');
    assert(contribIdentity);
    const firstPart = `${contribIdentity.name}-part-001`;
    const secondPart = `${contribIdentity.name}-part-002`;
    const supportRows = (values = hostSmokeInputs) =>
      wasixHostSmokeCargoRows(values, packed[0].sourceRoot, version);
    assert.throws(
      () => supportRows(hostSmokeInputs.filter((row) => row.name !== firstPart)),
      /contiguous|complete/u,
    );
    assert.throws(() => supportRows([...hostSmokeInputs, hostSmokeInputs[0]]), /ten canonical/u);
    assert.throws(
      () =>
        supportRows(
          hostSmokeInputs.map((row) =>
            row.name === firstPart ? { ...row, target: 'different-target' } : row,
          ),
        ),
      /target differs/u,
    );
    for (const suffix of ['000', '1000']) {
      const invalid = await supportArchive(
        contribIdentity,
        `${contribIdentity.name}-part-${suffix}`,
      );
      assert.throws(() => supportRows([...hostSmokeInputs, invalid]), /1-based|target differs/u);
    }
    const toolsIdentity = supportIdentities.find((row) => row.product === 'postgres-tools-wasix');
    assert(toolsIdentity);
    assert.throws(
      () =>
        supportRows([
          ...hostSmokeInputs,
          { ...hostSmokeInputs[0], name: `${toolsIdentity.name}-part-001` },
        ]),
      /target differs/u,
    );
    const additional = await supportArchive(contribIdentity, `${contribIdentity.name}-part-003`);
    assert.throws(() => supportRows([...hostSmokeInputs, additional]), /complete/u);
    for (const [key, name, options, error] of [
      ['version', firstPart, { archiveVersion: '9.9.9' }, /version|identity/u],
      [
        'qualification',
        firstPart,
        { metadata: { oliphaunt: { qualificationOnly: true } } },
        /qualification-only/u,
      ],
      ['chunk', secondPart, { payload: { 'chunks/example.part000002': '2' } }, /non-contiguous/u],
      [
        'pin',
        contribIdentity.name,
        { dependencies: { [firstPart]: { version }, [secondPart]: { version: `=${version}` } } },
        /AssertionError|exact/u,
      ],
    ] as const) {
      const original = hostSmokeInputs.find((row) => row.name === name);
      assert(original);
      const bytes = readFileSync(original.file);
      await supportArchive(contribIdentity, name, options);
      assert.throws(() => supportRows(), error, key);
      writeFileSync(original.file, bytes);
    }
    const reordered = structuredClone(supportReceipt);
    assert(reordered.hostSmokeCrates);
    reordered.hostSmokeCrates = reordered.hostSmokeCrates.map(
      (row) => Object.fromEntries(Object.entries(row).reverse()) as typeof row,
    );
    importSupport(reordered, path.join(root, 'reordered-host-repository'));
    for (const row of [...hostSmokeInputs, ...inputs.filter((row) => row.name === RUNTIME_PACKAGE)])
      assert.deepEqual(
        readFileSync(path.join(supportOutput, 'host-smoke', path.basename(row.file))),
        readFileSync(row.file),
      );
    assert.equal(
      readFileSync(path.join(supportOutput, 'cargo-facts.json'), 'utf8'),
      readFileSync(path.join(output, 'cargo-facts.json'), 'utf8'),
    );
    assert.match(
      readFileSync(path.join(supportOutput, 'BUILD.bazel'), 'utf8'),
      /filegroup\(name = "host_smoke"/u,
    );
    for (const [key, mutation] of [
      [
        'hash',
        (rows: any[]) => {
          rows[0].sha256 = '0'.repeat(64);
        },
      ],
      [
        'target',
        (rows: any[]) => {
          rows[0].target = 'different-target';
        },
      ],
      [
        'version',
        (rows: any[]) => {
          rows[0].version = 'different-version';
        },
      ],
      [
        'path',
        (rows: any[]) => {
          rows[0].path = `../${rows[0].path}`;
        },
      ],
      [
        'missing',
        (rows: any[]) => {
          rows.pop();
        },
      ],
      [
        'duplicate',
        (rows: any[]) => {
          rows[0] = rows[1];
        },
      ],
    ] as const) {
      const invalid = structuredClone(supportReceipt);
      assert(invalid.hostSmokeCrates);
      mutation(invalid.hostSmokeCrates);
      assert.throws(() => importSupport(invalid, path.join(root, `invalid-support-${key}`)));
    }

    const badRole = structuredClone(receipt);
    badRole.crates[0].role = 'artifact';
    assert.throws(
      () =>
        extractWasixCargoConstructionInputs(
          badRole,
          inputDirectory,
          '1'.repeat(40),
          path.join(root, 'bad-role'),
          {
            releaseManifest,
            toolchainManifest,
            cargoLock,
            versionManifest,
            rustDefs: '@@main//build_defs/languages:rust.bzl',
            cratesDefs: '@@cargo_crates//:defs.bzl',
            sourceRoot: packed[0].sourceRoot,
          },
        ),
      /invalid WASIX Cargo receipt row/u,
    );
    assert.throws(
      () =>
        extractWasixCargoConstructionInputs(
          receipt,
          inputDirectory,
          '3'.repeat(40),
          path.join(root, 'bad-source'),
          {
            releaseManifest,
            toolchainManifest,
            cargoLock,
            versionManifest,
            rustDefs: '@@main//build_defs/languages:rust.bzl',
            cratesDefs: '@@cargo_crates//:defs.bzl',
            sourceRoot: packed[0].sourceRoot,
          },
        ),
      /exact source inputs/u,
    );
    const wrongLock = path.join(root, 'wrong-Cargo.lock');
    writeFileSync(wrongLock, `${readFileSync(cargoLock, 'utf8')}\n# changed\n`);
    assert.throws(
      () =>
        extractWasixCargoConstructionInputs(
          receipt,
          inputDirectory,
          '1'.repeat(40),
          path.join(root, 'bad-lock'),
          {
            releaseManifest,
            toolchainManifest,
            cargoLock: wrongLock,
            versionManifest,
            rustDefs: '@@main//build_defs/languages:rust.bzl',
            cratesDefs: '@@cargo_crates//:defs.bzl',
            sourceRoot: packed[0].sourceRoot,
          },
        ),
      /exact source inputs/u,
    );
    const replaced = inputs[0];
    writeFileSync(replaced.file, 'replaced crate bytes');
    assert.throws(
      () =>
        extractWasixCargoConstructionInputs(
          receipt,
          inputDirectory,
          '1'.repeat(40),
          path.join(root, 'bad-hash'),
          {
            releaseManifest,
            toolchainManifest,
            cargoLock,
            versionManifest,
            rustDefs: '@@main//build_defs/languages:rust.bzl',
            cratesDefs: '@@cargo_crates//:defs.bzl',
            sourceRoot: packed[0].sourceRoot,
          },
        ),
      /hash differs/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('imports emitted multipart AOT as real members with an exact private lock projection', async () => {
  const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'wasix-split-construction-'));
  try {
    const target = 'windows-x64-msvc';
    const parentName = AOT_PACKAGES[target];
    const packed = await Promise.all(
      [null, ...Object.keys(AOT_PACKAGES)].map((targetId) =>
        makeInput(targetId, { base: fixtureRoot, oversized: targetId === target }),
      ),
    );
    const inputDirectory = path.join(fixtureRoot, 'inputs');
    mkdirSync(inputDirectory);
    const inputs = packed.flatMap((row) =>
      row.files.map((archive) => {
        const file = path.join(inputDirectory, path.basename(archive));
        writeFileSync(file, readFileSync(archive));
        return {
          file,
          name: path.basename(file).slice(0, -`-${version}.crate`.length),
          target: row.target,
        };
      }),
    );
    const parts = inputs.filter(
      (row) => row.name !== parentName && wasixRuntimeCargoParent(row.name) === parentName,
    );
    assert(parts.length >= 2, 'Oversized emitted AOT must use multiple real data parts');
    const receiptOptions = {
      sourceCommit: '1'.repeat(40),
      sourceTree: '2'.repeat(40),
      releaseManifest: path.resolve('src/wasix/runtime/release.toml'),
      toolchainManifest: path.resolve('src/wasix/runtime/toolchain.toml'),
      cargoLock: path.resolve('Cargo.lock'),
      versionManifest,
    };
    const receiptFor = (rows = inputs) => writeWasixCargoConstructionReceipt(rows, receiptOptions);
    const receipt = receiptFor();
    assert.equal(receipt.cargoLockSha256, sha(readFileSync(receiptOptions.cargoLock)));
    for (const part of parts) {
      const row = receipt.crates.find((row) => row.name === part.name)!;
      assert.equal(row.role, 'payload-part');
      assert.equal(row.target, target);
      assert.equal(row.kind, 'wasix-aot');
      assert.equal(row.version, version);
    }
    const output = path.join(fixtureRoot, 'repository');
    const importReceipt = (value: unknown, destination: string) =>
      extractWasixCargoConstructionInputs(value, inputDirectory, '1'.repeat(40), destination, {
        ...receiptOptions,
        rustDefs: '@@main//build_defs/languages:rust.bzl',
        cratesDefs: '@@cargo_crates//:defs.bzl',
        sourceRoot: packed[0].sourceRoot,
      });
    const imported = importReceipt(receipt, output);
    assert.equal(imported.packages.length, inputs.length);
    const parentPath = `src/wasix/runtime/crates/aot/${AOT_TARGET_TRIPLES[target]}`;
    const parentDirectory = path.join(output, parentPath);
    const manifest = Bun.TOML.parse(readFileSync(path.join(parentDirectory, 'Cargo.toml'), 'utf8'));
    assert.equal(manifest.package.version, version);
    assert.match(
      readFileSync(path.join(parentDirectory, 'build.rs'), 'utf8'),
      /const PART_ROOTS: &\[&str\]/u,
    );
    assert.match(
      readFileSync(path.join(parentDirectory, 'build-support.rs'), 'utf8'),
      /reconstruct_payload\(PART_ROOTS\)/u,
    );
    assert.equal(
      readFileSync(path.join(parentDirectory, 'cargo-parts.rs'), 'utf8'),
      readFileSync('build_defs/wasix/cargo-parts.rs', 'utf8'),
    );
    assert(
      !existsSync(path.join(parentDirectory, 'artifacts')),
      'Import must retain part readers without duplicating reconstructed payloads',
    );
    const parentBuild = readFileSync(path.join(parentDirectory, 'BUILD.bazel'), 'utf8');
    assert(parentBuild.includes('"cargo-parts.rs"'));
    assert(parentBuild.includes(`"OLIPHAUNT_BAZEL_EXEC_ROOT": "$\${pwd}"`));
    const originalLock = Bun.TOML.parse(readFileSync(receiptOptions.cargoLock, 'utf8'));
    const derivedLock = Bun.TOML.parse(readFileSync(path.join(output, 'Cargo.lock'), 'utf8'));
    assert.deepEqual(
      derivedLock.package.filter((row) => row.source),
      originalLock.package.filter((row) => row.source),
    );
    const oldParent = originalLock.package.find((row) => row.name === parentName && !row.source);
    const newParent = derivedLock.package.find((row) => row.name === parentName && !row.source);
    assert.deepEqual(newParent, {
      ...oldParent,
      dependencies: [...oldParent.dependencies, ...parts.map((row) => row.name).sort()],
    });
    assert.deepEqual(
      derivedLock.package.filter(
        (row) => row.name !== parentName && !parts.some((part) => part.name === row.name),
      ),
      originalLock.package.filter((row) => row.name !== parentName),
    );
    const facts = JSON.parse(readFileSync(path.join(output, 'cargo-facts.json'), 'utf8'));
    for (const part of parts) {
      const memberPath = `${parentPath}/parts/${part.name}`;
      assert.deepEqual(manifest['build-dependencies'][part.name], {
        version: `=${version}`,
        path: `parts/${part.name}`,
      });
      assert.deepEqual(
        derivedLock.package.find((row) => row.name === part.name),
        { name: part.name, version },
      );
      assert.equal(facts[memberPath].version, version);
      assert.equal(facts[memberPath].build, 'build.rs');
      assert(parentBuild.includes(`"${part.name}": "//${memberPath}:lib"`));
      assert(parentBuild.includes(`//${memberPath}:packed_payload`));
      const partBuild = readFileSync(path.join(output, memberPath, 'BUILD.bazel'), 'utf8');
      assert(partBuild.includes('cargo_generator(data = [":packed_payload"]'));
      assert(partBuild.includes('cargo_library(build_script = ":build_script"'));
      assert(partBuild.includes('rustc_env = {"CARGO_MANIFEST_DIR": packed_cargo_manifest_dir()}'));
      assert(existsSync(path.join(output, memberPath, 'payload')));
    }
    assert(!existsSync(path.join(output, '.staged')));
    assert.throws(
      () => receiptFor(inputs.filter((row) => row.name !== parts[0].name)),
      /complete|exactly|contiguous/u,
    );
    const badHash = structuredClone(receipt);
    badHash.crates.find((row) => row.name === parts[0].name)!.sha256 = '0'.repeat(64);
    assert.throws(
      () => importReceipt(badHash, path.join(fixtureRoot, 'bad-hash')),
      /hash differs/u,
    );

    // Authenticate exact manifests before deriving any local dependency/lock rows.
    for (const [name, select, change, error] of [
      [
        'part-dependency',
        parts[0].name,
        (value) => {
          value.dependencies = { unexpected: { version: '=1.0.0' } };
        },
        /only data/u,
      ],
      [
        'qualification-only',
        parts[0].name,
        (value) => {
          value.package.metadata = { oliphaunt: { qualificationOnly: true } };
        },
        /qualification-only/u,
      ],
      [
        'loose-parent-pin',
        parentName,
        (value) => {
          value['build-dependencies'][parts[0].name].version = version;
        },
        /exact part version/u,
      ],
    ] as const) {
      const original = inputs.find((row) => row.name === select)!;
      const entries = readPortableArchiveEntries(original.file);
      const changed = new Bun.Archive(
        Object.fromEntries(
          [...entries.values()]
            .filter((entry) => entry.isFile)
            .map((entry) => {
              if (!entry.name.endsWith('/Cargo.toml')) return [entry.name, entry.data()];
              const value = Bun.TOML.parse(entry.data().toString());
              change(value);
              return [entry.name, renderToml(value)];
            }),
        ),
      );
      const file = path.join(fixtureRoot, name, path.basename(original.file));
      mkdirSync(path.dirname(file));
      writeFileSync(file, gzipSync(Buffer.from(await changed.bytes())));
      assert.throws(
        () => receiptFor(inputs.map((row) => (row.name === select ? { ...row, file } : row))),
        error,
      );
    }
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}, 30_000);
