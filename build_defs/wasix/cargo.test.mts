import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { canonicalWasixAotMetadata } from '../../src/wasix/runtime/tools/wasix-aot-manifest.mts';
import {
  AOT_PACKAGES,
  AOT_TARGET_TRIPLES,
  CORE_AOT_ARTIFACTS,
  CORE_RUNTIME_ARCHIVE_FILES,
  RUNTIME_PACKAGE,
} from '../../src/wasix/runtime/tools/wasix-cargo-artifact-contract.mts';
import { extractPortableArchiveTree } from '../../tools/packaging/portable-archive.mts';
import {
  packageRuntimeCargo,
  type RuntimeCargoSpec,
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
        CORE_AOT_ARTIFACTS.map(async (name, index) => {
          const raw = Buffer.from(`independent serialized-image framing fixture ${name}`);
          const bytes = zstdCompressSync(raw);
          const file = `${index}.bin.zst`;
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
  const first = path.join(root, 'first.crate');
  const second = path.join(root, 'second.crate');
  packageRuntimeCargo(spec, first);
  packageRuntimeCargo(spec, second);
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
