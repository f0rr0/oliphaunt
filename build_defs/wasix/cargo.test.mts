import { afterAll, afterEach, expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
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
import { extractPortableArchiveTree } from '../../tools/packaging/portable-archive.mts';
import { cargoLinkEnvironment } from '../languages/cargo-environment.mts';
import {
  extractRuntimeCargoFamily,
  packageRuntimeCargo,
  type RuntimeCargoSpec,
  readRuntimeCargoFamily,
  validatePackedRuntimeCargo,
} from './cargo.mts';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

async function fixture(target: string | null = null) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oliphaunt-wasix-cargo-'));
  roots.push(root);
  const payload = path.join(root, 'payload');
  await mkdir(payload);
  const module = Buffer.from('\0asm\x01\0\0\0');
  const template = target
    ? `src/wasix/runtime/crates/aot/${AOT_TARGET_TRIPLES[target]}`
    : 'src/wasix/runtime/crates/assets';
  const sources = Object.fromEntries(
    ['Cargo.toml', 'README.md', 'build.rs', 'build-support.rs', 'src/lib.rs'].map((file) => [
      file,
      path.resolve(template, file),
    ]),
  );
  const notices = Object.fromEntries(
    [
      'LICENSE',
      'THIRD_PARTY_NOTICES.md',
      'src/wasix/sdks/rust/THIRD_PARTY_NOTICES.md',
      'src/third-party/postgres/COPYRIGHT',
      'src/third-party/postgres/source.toml',
      'src/third-party/icu/LICENSE',
      'src/third-party/icu/source.toml',
    ].map((file) => [file, path.resolve(file)]),
  );
  let manifest;
  if (target) {
    const canonical = canonicalWasixAotMetadata(undefined, AOT_TARGET_TRIPLES[target]);
    manifest = {
      'format-version': 1,
      'source-lane': canonical.sourceLane,
      engine: canonical.engine,
      'wasmer-version': canonical.wasmerVersion,
      'wasmer-wasix-version': canonical.wasmerWasixVersion,
      'target-triple': AOT_TARGET_TRIPLES[target],
      'source-fingerprint': 'independent fixture',
      artifacts: await Promise.all(
        CORE_AOT_ARTIFACTS.map(async (name) => {
          const raw = Buffer.from(`independent serialized-image framing fixture ${name}`);
          const bytes = zstdCompressSync(raw);
          const file = `${name.split(':').at(-1)}-llvm-opta.bin.zst`;
          await writeFile(path.join(payload, file), bytes);
          return {
            name,
            path: file,
            compressed: true,
            sha256: sha(bytes),
            'module-sha256': sha(module),
            'raw-sha256': sha(raw),
            'raw-size': raw.length,
          };
        }),
      ),
    };
  } else {
    const runtime = zstdCompressSync(
      Buffer.from(
        await new Bun.Archive(
          Object.fromEntries(CORE_RUNTIME_ARCHIVE_FILES.map((name) => [name, module])),
        ).bytes(),
      ),
    );
    await writeFile(path.join(payload, 'oliphaunt.wasix.tar.zst'), runtime);
    await mkdir(path.join(payload, 'bin'));
    await writeFile(path.join(payload, 'bin/initdb.wasix.wasm'), module);
    manifest = {
      extensions: [],
      runtime: { archive: 'oliphaunt.wasix.tar.zst', sha256: sha(runtime) },
    };
  }
  const manifestPath = path.join(payload, 'manifest.json');
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
  const spec: RuntimeCargoSpec = {
    version: '7.8.9',
    packageName: target ? AOT_PACKAGES[target] : RUNTIME_PACKAGE,
    target,
    payload,
    payloadFiles: [
      manifestPath,
      ...(target
        ? manifest.artifacts.map((row) => path.join(payload, row.path))
        : ['oliphaunt.wasix.tar.zst', 'bin/initdb.wasix.wasm'].map((file) =>
            path.join(payload, file),
          )),
    ],
    sources,
    notices,
    toolchain: path.resolve('src/wasix/runtime/toolchain.toml'),
    engineSources: path.resolve('src/wasix/runtime/engine/sources.json'),
  };
  const sourceRoot = path.join(root, 'canonical-source');
  for (const [relative, source] of Object.entries({
    ...notices,
    'src/wasix/runtime/toolchain.toml': spec.toolchain,
    'src/wasix/runtime/engine/sources.json': spec.engineSources,
  })) {
    const file = path.join(sourceRoot, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, await readFile(source));
  }
  return { root, spec, manifest, manifestPath, sourceRoot };
}

async function verifyCanonicalEnvelope(target: string | null) {
  const { root, spec, sourceRoot } = await fixture(target);
  const [first] = packageRuntimeCargo(spec, path.join(root, 'first'));
  const [second] = packageRuntimeCargo(spec, path.join(root, 'second'));
  expect(await readFile(first)).toEqual(await readFile(second));
  const files = await new Bun.Archive(await readFile(first)).files();
  const read = async (name: string) => {
    const file = files.get(`${spec.packageName}-${spec.version}/${name}`);
    if (!file) throw new Error(`independent archive reader found no ${name}`);
    return Buffer.from(await file.arrayBuffer());
  };
  const manifest = Bun.TOML.parse((await read('Cargo.toml')).toString());
  expect(manifest.package).toMatchObject({ name: spec.packageName, version: spec.version });
  expect(manifest.package.publish).toBeUndefined();
  expect((await read('build.rs')).toString()).toBe(
    'const PACKAGE_LOCAL: bool = true;\ninclude!("build-support.rs");\n',
  );
  expect(await read('build-support.rs')).toEqual(await readFile(spec.sources['build-support.rs']));
  expect(await read('src/lib.rs')).toEqual(await readFile(spec.sources['src/lib.rs']));
  expect(await read(`${target ? 'artifacts' : 'payload'}/manifest.json`)).toEqual(
    await readFile(path.join(spec.payload, 'manifest.json')),
  );
  expect([...files.keys()].some((member) => member.includes('BUILD.bazel'))).toBe(false);
  const extracted = path.join(root, 'installed');
  extractPortableArchiveTree(first, extracted, `${spec.packageName}-${spec.version}`);
  validatePackedRuntimeCargo(extracted, spec, sourceRoot);
  await writeFile(path.join(extracted, 'build.rs'), await readFile(spec.sources['build.rs']));
  expect(() => validatePackedRuntimeCargo(extracted, spec, sourceRoot)).toThrow(
    'must require its package-local payload',
  );
}

for (const target of [null, ...Object.keys(AOT_TARGET_TRIPLES)]) {
  test(`canonical ${target ?? 'portable'} Cargo envelope preserves sources and payload bytes`, () => {
    return verifyCanonicalEnvelope(target);
  });
}

let cargoScratch: string | undefined;
let cargoContext: ReturnType<typeof prepareCargo> | undefined;
afterAll(async () => {
  if (cargoScratch) await rm(cargoScratch, { recursive: true, force: true });
});

async function prepareCargo() {
  const runfiles = process.env.RUNFILES_DIR ?? process.env.TEST_SRCDIR;
  assert(
    runfiles && process.env.OLIPHAUNT_SOURCE_COMPILE_TEST_TOOLS && process.env.TEST_TMPDIR,
    'Run runtime_cargo_test with its declared Cargo/Rust/compiler and registry inputs',
  );
  const tools = JSON.parse(
    await readFile(path.join(runfiles, process.env.OLIPHAUNT_SOURCE_COMPILE_TEST_TOOLS), 'utf8'),
  );
  const tool = (name: string) => path.join(runfiles, tools[name]);
  cargoScratch = await mkdtemp(path.join(process.env.TEST_TMPDIR, 'wasix-cargo-consumer-'));
  const cargoHome = path.join(cargoScratch, 'cargo-home');
  assert(
    Object.keys(tools.cargoHome).length > 0,
    'Cargo consumer needs declared offline registry inputs',
  );
  for (const [file, relative] of Object.entries(tools.cargoHome) as [string, string][]) {
    const output = path.join(cargoHome, 'registry', relative);
    await mkdir(path.dirname(output), { recursive: true });
    await copyFile(path.join(runfiles, file), output);
  }
  return {
    cargo: tool('cargo'),
    env: {
      ...cargoLinkEnvironment(JSON.parse(await readFile(tool('compiler'), 'utf8')), runfiles),
      CARGO_HOME: cargoHome,
      CARGO_TARGET_DIR: path.join(cargoScratch, 'target'),
      CARGO_NET_OFFLINE: 'true',
      CARGO_TERM_COLOR: 'never',
      RUSTC: tool('rustc'),
      RUSTDOC: tool('rustdoc'),
      PATH: path.dirname(tool('rustc')),
      HOME: cargoScratch,
      TMPDIR: cargoScratch,
    },
  };
}

/** Compile the actual published readers and exact-version part dependencies, not a repacked facade. */
async function verifyCargoConsumer(family: string[], spec: RuntimeCargoSpec, root: string) {
  cargoContext ??= prepareCargo();
  const tools = await cargoContext;
  const { parent, parts } = readRuntimeCargoFamily(family, spec.target);
  const extracted = path.join(root, 'cargo-consumer');
  for (const row of [parent, ...parts]) {
    extractPortableArchiveTree(
      row.file,
      path.join(extracted, row.name),
      `${row.name}-${row.version}`,
    );
  }
  const consumer = path.join(extracted, 'consumer');
  await mkdir(path.join(consumer, 'src'), { recursive: true });
  await mkdir(path.join(consumer, 'expected'));
  const manifest = JSON.parse(await readFile(path.join(spec.payload, 'manifest.json'), 'utf8'));
  for (const artifact of manifest.artifacts) {
    await copyFile(
      path.join(spec.payload, artifact.path),
      path.join(consumer, 'expected', artifact.path),
    );
  }
  await writeFile(
    path.join(consumer, 'Cargo.toml'),
    [
      '[package]',
      'name = "wasix-aot-installed-regression"',
      'version = "0.0.0"',
      'edition = "2024"',
      '[workspace]',
      '[dependencies]',
      `aot = { package = "${parent.name}", version = "=${parent.version}", path = "../${parent.name}" }`,
      '[patch.crates-io]',
      ...parts.map(
        (part) => `${part.name} = { version = "=${part.version}", path = "../${part.name}" }`,
      ),
      '',
    ].join('\n'),
  );
  const metadata = `DEP_${parent.manifest.package.links.toUpperCase()}_MANIFEST`;
  await writeFile(
    path.join(consumer, 'build.rs'),
    `fn main() {
    let path = std::env::var(${JSON.stringify(metadata)}).expect("unchanged parent links metadata");
    let manifest = std::fs::read_to_string(path).expect("installed artifact metadata");
    assert!(manifest.contains(${JSON.stringify('kind = "wasix-aot"')}));
    assert!(manifest.contains(${JSON.stringify(`target = "${AOT_TARGET_TRIPLES[spec.target]}"`)}));
  }\n`,
  );
  await writeFile(
    path.join(consumer, 'src/main.rs'),
    `fn main() {
    assert_eq!(aot::TARGET_TRIPLE, ${JSON.stringify(AOT_TARGET_TRIPLES[spec.target])});
    assert_eq!(aot::ENGINE, ${JSON.stringify(manifest.engine)});
    assert!(aot::HAS_EMBEDDED_AOT);
    assert!(aot::MANIFEST_JSON.contains(${JSON.stringify(AOT_TARGET_TRIPLES[spec.target])}));
    ${manifest.artifacts.map((artifact) => `assert_eq!(aot::artifact_bytes(${JSON.stringify(artifact.name)}).unwrap(), include_bytes!(${JSON.stringify(`../expected/${artifact.path}`)}));`).join('\n')}
    assert!(aot::artifact_bytes("undeclared-artifact").is_none());
  }\n`,
  );
  let revision = 0;
  const run = async () => {
    // Invalidate the real parent's build script so all adversaries exercise its reader.
    await writeFile(
      path.join(extracted, parent.name, 'build.rs'),
      parent.entries.get(`${parent.name}-${parent.version}/build.rs`).data().toString() +
        '\n'.repeat(++revision),
    );
    const result = Bun.spawnSync(
      [
        tools.cargo,
        'run',
        '--offline',
        '--quiet',
        '--manifest-path',
        path.join(consumer, 'Cargo.toml'),
      ],
      { env: tools.env },
    );
    return { code: result.exitCode, output: result.stderr.toString() + result.stdout.toString() };
  };
  let result = await run();
  assert.equal(result.code, 0, result.output);
  const part = parts.find((row) =>
    [...row.entries.values()].some(
      (entry) => entry.isFile && /\/payload\/chunks\//u.test(entry.name),
    ),
  );
  assert(part, 'Oversized installed fixture must contain a chunked part');
  const payload = path.join(extracted, part.name, 'payload');
  await rename(payload, `${payload}.absent`);
  result = await run();
  assert.notEqual(result.code, 0, 'Cargo must reject a missing installed payload part');
  assert.match(result.output, /missing WASIX AOT payload part/u);
  await rename(`${payload}.absent`, payload);
  const chunk = [...part.entries.values()].find(
    (entry) => entry.isFile && /\/payload\/chunks\//u.test(entry.name),
  );
  assert(chunk, 'Oversized installed fixture must contain a chunk');
  const chunkPath = path.join(
    extracted,
    part.name,
    chunk.name.slice(`${part.name}-${part.version}/`.length),
  );
  const bytes = chunk.data();
  const corrupt = Buffer.from(bytes);
  corrupt[0] ^= 1;
  await writeFile(chunkPath, corrupt);
  result = await run();
  assert.notEqual(result.code, 0, 'Cargo must reject corrupt installed payload bytes');
  assert.match(result.output, /WASIX AOT payload digest mismatch/u);
  await writeFile(chunkPath, bytes);
  result = await run();
  assert.equal(result.code, 0, result.output);
}

for (const target of Object.keys(AOT_TARGET_TRIPLES)) {
  test(`oversized ${target} Cargo family reconstructs and compiles exact bytes, rejects absent/corrupt parts`, async () => {
    const { root, spec, manifest, manifestPath, sourceRoot } = await fixture(target);
    const row = manifest.artifacts[0];
    const raw = randomBytes(12 * 1024 * 1024);
    const bytes = zstdCompressSync(raw);
    await writeFile(path.join(spec.payload, row.path), bytes);
    Object.assign(row, { sha256: sha(bytes), 'raw-sha256': sha(raw), 'raw-size': raw.length });
    await writeFile(manifestPath, JSON.stringify(manifest));
    const family = packageRuntimeCargo(spec, path.join(root, 'family'));
    expect(family.length).toBeGreaterThan(2);
    for (const file of family)
      expect((await readFile(file)).length).toBeLessThanOrEqual(10 * 1024 * 1024);
    const parent = extractRuntimeCargoFamily(
      family,
      path.join(root, 'installed-family'),
      target,
      sourceRoot,
    );
    expect(await readFile(path.join(parent, 'artifacts', row.path))).toEqual(bytes);
    expect(() =>
      extractRuntimeCargoFamily(family.slice(1), path.join(root, 'missing'), target, sourceRoot),
    ).toThrow();
    expect(() =>
      extractRuntimeCargoFamily(
        [...family, family[0]],
        path.join(root, 'duplicate'),
        target,
        sourceRoot,
      ),
    ).toThrow('repeats an archive');
    const part = readRuntimeCargoFamily(family, target).parts.find((row) =>
      [...row.entries.values()].some(
        (entry) => entry.isFile && /\/payload\/chunks\//u.test(entry.name),
      ),
    );
    assert(part, 'Large fixture must split an artifact into chunks');
    const first = part.entries;
    const member = [...first.values()].find(
      (entry) => entry.isFile && /\/payload\/chunks\//u.test(entry.name),
    );
    if (!member) throw new Error('large fixture must split an artifact into chunks');
    const damaged = Buffer.from(member.data());
    damaged[0] ^= 1;
    const modified = new Bun.Archive(
      Object.fromEntries(
        [...first.values()]
          .filter((entry) => entry.isFile)
          .map((entry) => [entry.name, entry === member ? damaged : entry.data()]),
      ),
    );
    const damagedFile = path.join(root, 'damaged', path.basename(part.file));
    await mkdir(path.dirname(damagedFile));
    await writeFile(damagedFile, gzipSync(Buffer.from(await modified.bytes())));
    expect(() =>
      extractRuntimeCargoFamily(
        family.map((file) => (file === part.file ? damagedFile : file)),
        path.join(root, 'corrupt'),
        target,
        sourceRoot,
      ),
    ).toThrow('SHA-256 mismatch');
    await verifyCargoConsumer(family, spec, root);
  }, 120_000);
}

test('runtime Cargo rejects wrong carrier identity, unsafe sources, missing notices and stale payloads', async () => {
  const { root, spec, manifest, manifestPath } = await fixture();
  const output = path.join(root, 'invalid.crate');
  expect(() => packageRuntimeCargo({ ...spec, target: 'linux-x64-gnu' }, output)).toThrow(
    'Canonical release package name disagrees',
  );
  expect(() =>
    packageRuntimeCargo({ ...spec, sources: { ...spec.sources, '../escape': 'LICENSE' } }, output),
  ).toThrow('non-portable Cargo package path');
  expect(() => packageRuntimeCargo({ ...spec, payloadFiles: [] }, output)).toThrow(
    'requires its declared TreeArtifact leaves',
  );
  expect(() =>
    packageRuntimeCargo(
      { ...spec, payloadFiles: [...spec.payloadFiles, spec.payloadFiles[0]] },
      output,
    ),
  ).toThrow('Duplicate declared WASIX Cargo payload leaf');
  const outsideManifest = path.join(root, 'outside-Cargo.toml');
  await writeFile(outsideManifest, await readFile(spec.sources['Cargo.toml']));
  expect(() => packageRuntimeCargo({ ...spec, payloadFiles: [outsideManifest] }, output)).toThrow(
    'non-portable Cargo package path',
  );
  expect(() => packageRuntimeCargo({ ...spec, notices: {} }, output)).toThrow();
  manifest.extensions = ['omitted extension'];
  await writeFile(manifestPath, JSON.stringify(manifest));
  expect(() => packageRuntimeCargo(spec, output)).toThrow('empty extensions array');
  manifest.extensions = [];
  await writeFile(manifestPath, JSON.stringify(manifest));
  await writeFile(path.join(spec.payload, 'oliphaunt.wasix.tar.zst'), 'stale bytes');
  expect(() => packageRuntimeCargo(spec, output)).toThrow('runtime.sha256 mismatch');
});

test('AOT Cargo rejects mixed target/engine, incomplete closure and mismatched serialized bytes', async () => {
  const { root, spec, manifest, manifestPath } = await fixture('linux-x64-gnu');
  const output = path.join(root, 'invalid.crate');
  for (const [field, bad] of [
    ['target-triple', 'aarch64-apple-darwin'],
    ['engine', 'unqualified-engine'],
  ]) {
    const original = manifest[field];
    manifest[field] = bad;
    await writeFile(manifestPath, JSON.stringify(manifest));
    expect(() => packageRuntimeCargo(spec, output)).toThrow(`${field} must match canonical`);
    manifest[field] = original;
  }
  const omitted = manifest.artifacts.pop();
  await writeFile(manifestPath, JSON.stringify(manifest));
  await rm(path.join(spec.payload, omitted.path));
  spec.payloadFiles = spec.payloadFiles.filter(
    (file) => file !== path.join(spec.payload, omitted.path),
  );
  expect(() => packageRuntimeCargo(spec, output)).toThrow('missing core runtime AOT artifacts');
  await writeFile(path.join(spec.payload, manifest.artifacts[0].path), 'stale bytes');
  expect(() => packageRuntimeCargo(spec, output)).toThrow('compressed SHA-256 mismatch');
});
