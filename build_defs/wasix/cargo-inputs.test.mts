import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
import { packageRuntimeCargo, type RuntimeCargoSpec } from './cargo.mts';
import {
  extractWasixCargoConstructionInputs,
  wasixHostSmokeCargoIdentities,
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

async function makeInput(targetId: string | null) {
  const packageName = targetId === null ? RUNTIME_PACKAGE : AOT_PACKAGES[targetId];
  const triple = targetId === null ? null : AOT_TARGET_TRIPLES[targetId];
  const canonical = canonicalWasixAotMetadata(undefined, triple ?? undefined);
  const payload = path.join(root, `payload-${targetId ?? 'portable'}`);
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
      const raw = Buffer.from(`independent serialized-image fixture ${name}`);
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
  const sourceRoot = path.join(root, `source-${targetId ?? 'portable'}`);
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
  };
  const file = path.join(root, `${packageName}-${version}.crate`);
  packageRuntimeCargo(spec, file);
  return { file, name: packageName, target: targetId ?? 'portable', sourceRoot };
}

test('imports genuine canonical crate envelopes and rejects receipt substitutions', async () => {
  try {
    const inputDirectory = path.join(root, 'inputs');
    mkdirSync(inputDirectory);
    const packed = await Promise.all([null, ...Object.keys(AOT_PACKAGES)].map(makeInput));
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
    const hostSmokeInputs = await Promise.all(
      wasixHostSmokeCargoIdentities(packed[0].sourceRoot, version).map(async (identity) => {
        const file = path.join(inputDirectory, `${identity.name}-${identity.version}.crate`);
        const envelope = new Bun.Archive({
          [`${identity.name}-${identity.version}/Cargo.toml`]: `[package]\nname="${identity.name}"\nversion="${identity.version}"\n`,
        });
        writeFileSync(file, gzipSync(Buffer.from(await envelope.bytes())));
        return { file, name: identity.name, target: identity.target };
      }),
    );
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
