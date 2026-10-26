import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { canonicalWasixAotMetadata } from '../../src/wasix/runtime/tools/wasix-aot-manifest.mts';
import {
  AOT_TARGET_TRIPLES,
  TOOLS_AOT_PACKAGES,
  TOOLS_PACKAGE,
} from '../../src/wasix/runtime/tools/wasix-cargo-artifact-contract.mts';
import { readPortableArchiveEntries } from '../../tools/packaging/portable-archive.mts';
import { releaseNoticeRows, stageReleaseNotices } from '../../tools/packaging/release-notices.mts';
import { sourceFacts } from './package.mts';
import { packageToolsCarriers, type ToolsCarrierSpec } from './tools-carriers.mts';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const platforms = {
  'linux-arm64-gnu': { suffix: 'linux-arm64-gnu', os: 'linux', cpu: 'arm64', libc: 'glibc' },
  'linux-x64-gnu': { suffix: 'linux-x64-gnu', os: 'linux', cpu: 'x64', libc: 'glibc' },
  'macos-arm64': { suffix: 'darwin-arm64', os: 'darwin', cpu: 'arm64' },
  'windows-x64-msvc': { suffix: 'win32-x64-msvc', os: 'win32', cpu: 'x64' },
};
type Target = 'portable' | keyof typeof platforms;

async function fixture(target: Target = 'portable', version = '7.8.9', runtimeVersion = '3.4.5') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oliphaunt-wasix-tools-carriers-'));
  roots.push(root);
  const payload = path.join(root, 'payload');
  await mkdir(payload);
  const portable = target === 'portable';
  const platform = portable ? undefined : platforms[target];
  const cargoPackage = portable ? TOOLS_PACKAGE : TOOLS_AOT_PACKAGES[target];
  const npmPackage = `@oliphaunt/liboliphaunt-wasix-tools${platform ? `-${platform.suffix}` : ''}`;
  const template = `src/wasix/postgres-tools/crates/${portable ? 'tools' : `aot/${AOT_TARGET_TRIPLES[target]}`}`;
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
      'src/wasix/postgres-tools/npm/native.mts',
    ].map((file) => [file, path.resolve(file)]),
  );
  const postgresSeries = path.resolve('src/wasix/runtime/postgres/series');
  const patchNames = (await readFile(postgresSeries, 'utf8'))
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  const facts = {
    postgresSource: path.resolve('src/third-party/postgres/source.toml'),
    postgresSeries,
    patches: Object.fromEntries(patchNames.map((file) => [file, path.resolve(file)])),
    icuSource: path.resolve('src/third-party/icu/source.toml'),
  };
  const sourceFingerprint = (await sourceFacts(facts)).source_fingerprint;
  const bytesByPath = new Map<string, Buffer>();
  const modules = [0, 1].map((index) =>
    Buffer.concat([Buffer.from('\0asm\x01\0\0\0'), Buffer.from([0, 3, 1, 120, index])]),
  );
  let manifest: any;
  if (portable) {
    manifest = {
      schema: 'postgres-tools-wasix-portable-v1',
      version,
      runtimeVersion,
      sourceFingerprint,
    };
    for (const [index, key] of ['pgDump', 'psql'].entries()) {
      const name = index === 0 ? 'pg_dump' : 'psql';
      const file = `bin/${name}.wasix.wasm`;
      bytesByPath.set(file, modules[index]);
      manifest[key] = {
        name,
        path: file,
        sha256: sha(modules[index]),
        size: modules[index].length,
      };
    }
    stageReleaseNotices(payload, { profile: 'wasix-tools' });
    for (const row of releaseNoticeRows({ profile: 'wasix-tools' }))
      bytesByPath.set(row.member, await readFile(path.join(payload, row.member)));
  } else {
    const canonical = canonicalWasixAotMetadata(undefined, AOT_TARGET_TRIPLES[target]);
    manifest = {
      'format-version': 1,
      'source-lane': canonical.sourceLane,
      engine: canonical.engine,
      'wasmer-version': canonical.wasmerVersion,
      'wasmer-wasix-version': canonical.wasmerWasixVersion,
      'target-triple': AOT_TARGET_TRIPLES[target],
      'source-fingerprint': sourceFingerprint,
      artifacts: ['pg_dump', 'psql'].map((name, index) => {
        // Format/hash fixtures only; these bytes make no executable AOT claim.
        const raw = Buffer.from(`independent ${target} serialized-tool fixture ${name}`);
        const bytes = zstdCompressSync(raw);
        const file = `tools/${name}.bin.zst`;
        bytesByPath.set(file, bytes);
        return {
          name: `tool:${name}`,
          path: file,
          compressed: true,
          sha256: sha(bytes),
          'module-sha256': sha(modules[index]),
          'raw-sha256': sha(raw),
          'raw-size': raw.length,
        };
      }),
    };
  }
  bytesByPath.set('manifest.json', Buffer.from(`${JSON.stringify(manifest)}\n`));
  for (const [relative, bytes] of bytesByPath) {
    const file = path.join(payload, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, bytes);
    // Public archive modes must not inherit writable Windows-style input modes.
    await chmod(file, 0o666);
  }
  const spec: ToolsCarrierSpec = {
    ...facts,
    version,
    runtimeVersion,
    artifact: {
      target,
      asset: `postgres-tools-wasix-{version}-${portable ? 'portable' : `aot-${target}`}.tar.gz`,
      ...(platform
        ? {
            triple: AOT_TARGET_TRIPLES[target],
            npm_package: npmPackage,
            npm_os: platform.os,
            npm_cpu: platform.cpu,
            ...('libc' in platform ? { npm_libc: platform.libc } : {}),
          }
        : {}),
    },
    cargoPackage,
    npmPackage,
    payload,
    payloadFiles: [...bytesByPath.keys()].map((file) => path.join(payload, file)),
    sources,
    notices,
    toolchain: path.resolve('src/wasix/runtime/toolchain.toml'),
    engineSources: path.resolve('src/wasix/runtime/engine/sources.json'),
    outputs: {
      github: path.join(
        root,
        `postgres-tools-wasix-${version}-${portable ? 'portable' : `aot-${target}`}.tar.gz`,
      ),
      npm: path.join(root, `${npmPackage.replace('@', '').replace('/', '-')}-${version}.tgz`),
      cargo: path.join(root, `${cargoPackage}-${version}.crate`),
    },
  };
  const saveManifest = () =>
    writeFile(path.join(payload, 'manifest.json'), `${JSON.stringify(manifest)}\n`);
  return { root, spec, manifest, bytesByPath, saveManifest };
}

async function archive(file: string) {
  // The public GitHub tar convention uses a single leading ./ prefix.
  const entries = new Map(
    [...(await new Bun.Archive(await readFile(file)).files())].map(([name, item]) => [
      name.replace(/^\.\//u, ''),
      item,
    ]),
  );
  const read = async (name: string) => {
    const item = entries.get(name);
    if (!item) throw new Error(`independent archive inspection found no ${name}`);
    return Buffer.from(await item.arrayBuffer());
  };
  const files = [...entries.keys()].filter((name) => !name.endsWith('/')).sort();
  return { files, read };
}

for (const target of ['portable', ...Object.keys(platforms)] as Target[]) {
  test(`final ${target} tools archives preserve the exact payload, identities, local Cargo sources and notices`, async () => {
    const { root, spec, manifest, bytesByPath } = await fixture(target);
    await packageToolsCarriers(spec);
    const first = await Promise.all(Object.values(spec.outputs).map((file) => readFile(file)));
    const repeated = {
      ...spec,
      payloadFiles: [...spec.payloadFiles].reverse(),
      outputs: Object.fromEntries(
        Object.entries(spec.outputs).map(([kind, file]) => [
          kind,
          path.join(root, 'repeat', path.basename(file)),
        ]),
      ) as ToolsCarrierSpec['outputs'],
    };
    await packageToolsCarriers(repeated);
    expect(
      await Promise.all(Object.values(repeated.outputs).map((file) => readFile(file))),
    ).toEqual(first);

    const portable = target === 'portable';
    const payloadNotices = releaseNoticeRows({ profile: portable ? 'wasix-tools' : 'wasix-aot' });
    const payloadNames = [
      ...new Set([...bytesByPath.keys(), ...payloadNotices.map((row) => row.member)]),
    ].sort();
    const github = await archive(spec.outputs.github);
    expect(github.files).toEqual(payloadNames);
    const cargo = await archive(spec.outputs.cargo);
    const cargoPrefix = `${spec.cargoPackage}-${spec.version}/`;
    const payloadPrefix = `${cargoPrefix}${portable ? 'payload' : 'artifacts'}/`;
    expect(cargo.files).toEqual(
      [
        ...Object.keys(spec.sources).map((file) => `${cargoPrefix}${file}`),
        ...payloadNotices.map((row) => `${cargoPrefix}${row.member}`),
        ...payloadNames.map((file) => `${payloadPrefix}${file}`),
      ].sort(),
    );
    expect(
      cargo.files
        .filter((file) => file.startsWith(payloadPrefix))
        .map((file) => file.slice(payloadPrefix.length)),
    ).toEqual(payloadNames);
    const cargoManifest = Bun.TOML.parse((await cargo.read(`${cargoPrefix}Cargo.toml`)).toString());
    const original = Bun.TOML.parse(await readFile(spec.sources['Cargo.toml'], 'utf8'));
    expect(cargoManifest.package).toMatchObject({
      name: spec.cargoPackage,
      version: spec.version,
      links: original.package.links,
    });
    expect(cargoManifest.package.publish).toBeUndefined();
    expect(await cargo.read(`${cargoPrefix}build.rs`)).toEqual(
      Buffer.from('const PACKAGE_LOCAL: bool = true;\ninclude!("build-support.rs");\n'),
    );
    for (const file of ['build-support.rs', 'src/lib.rs', 'README.md'])
      expect(await cargo.read(`${cargoPrefix}${file}`)).toEqual(await readFile(spec.sources[file]));
    expect(
      cargo.files.some((file) => /(?:BUILD\.bazel|moon\.yml|target\/|\.inputs\.json)$/u.test(file)),
    ).toBe(false);

    const npm = await archive(spec.outputs.npm);
    const npmManifest = JSON.parse((await npm.read('package/package.json')).toString());
    expect(npmManifest.name).toBe(spec.npmPackage);
    expect(npmManifest.version).toBe(spec.version);
    expect(npmManifest.publishConfig).toEqual({ access: 'public', provenance: true });
    const npmNotices = releaseNoticeRows({ profile: 'wasix-runtime' });
    expect(npm.files).toEqual(
      [
        'package/package.json',
        ...npmNotices.map((row) => `package/${row.member}`),
        ...(portable
          ? [
              'README.md',
              'index.js',
              'native.js',
              'index.d.ts',
              'assets/pg_dump.wasix.wasm',
              'assets/psql.wasix.wasm',
            ].map((name) => `package/${name}`)
          : payloadNames.map((name) => `package/assets/${name}`)),
      ].sort(),
    );
    if (portable) {
      expect(npmManifest.oliphaunt.runtimeVersion).toBe('3.4.5');
      expect(npmManifest.oliphaunt.runtimeVersion).not.toBe(npmManifest.version);
      expect(Object.values(npmManifest.optionalDependencies)).toEqual(Array(4).fill(spec.version));
      for (const [key, name] of [
        ['pgDump', 'pg_dump'],
        ['psql', 'psql'],
      ]) {
        const bytes = await npm.read(`package/assets/${name}.wasix.wasm`);
        expect(sha(bytes)).toBe(manifest[key].sha256);
        expect(bytes.length).toBe(manifest[key].size);
      }
    } else {
      const platform = platforms[target];
      expect(npmManifest.os).toEqual([platform.os]);
      expect(npmManifest.cpu).toEqual([platform.cpu]);
      expect(npmManifest.libc).toEqual('libc' in platform ? [platform.libc] : undefined);
      for (const row of manifest.artifacts) {
        const bytes = await npm.read(`package/assets/${row.path}`);
        expect(sha(bytes)).toBe(row.sha256);
        const raw = zstdDecompressSync(bytes);
        expect(sha(raw)).toBe(row['raw-sha256']);
        expect(raw.length).toBe(row['raw-size']);
      }
    }
    for (const [relative, bytes] of bytesByPath) {
      expect(await github.read(relative)).toEqual(bytes);
      expect(await cargo.read(`${payloadPrefix}${relative}`)).toEqual(bytes);
    }
    for (const [file, prefix, rows] of [
      [spec.outputs.github, '', payloadNotices],
      [spec.outputs.cargo, cargoPrefix, payloadNotices],
      [spec.outputs.npm, 'package/', npmNotices],
    ] as const) {
      const strict = readPortableArchiveEntries(file);
      for (const row of rows) {
        const notice = strict.get(`${prefix}${row.member}`);
        expect(notice?.data()).toEqual(await readFile(row.source));
        expect(notice?.mode).toBe(0o644);
      }
      expect(
        [...strict.values()].filter((entry) => entry.isFile).every((entry) => entry.mode === 0o644),
      ).toBe(true);
    }
  });
}

test('tools carriers reject wrong family, target, template and final filename identities', async () => {
  const { spec } = await fixture('linux-x64-gnu');
  for (const invalid of [
    { ...spec, cargoPackage: 'liboliphaunt-wasix-aot-x86_64-unknown-linux-gnu' },
    { ...spec, artifact: { ...spec.artifact, triple: 'aarch64-apple-darwin' } },
    { ...spec, npmPackage: '@oliphaunt/liboliphaunt-wasix' },
    {
      ...spec,
      sources: {
        ...spec.sources,
        'Cargo.toml': path.resolve('src/wasix/runtime/crates/assets/Cargo.toml'),
      },
    },
    {
      ...spec,
      outputs: {
        ...spec.outputs,
        github: path.join(path.dirname(spec.outputs.github), 'runtime.tar.gz'),
      },
    },
  ])
    await expect(packageToolsCarriers(invalid)).rejects.toThrow();
});

test('portable tools reject corrupt bytes, missing tools and mismatched independent producer versions', async () => {
  const { spec, manifest, saveManifest } = await fixture();
  const tool = path.join(spec.payload, 'bin/pg_dump.wasix.wasm');
  const original = await readFile(tool);
  await writeFile(tool, Buffer.concat([original, Buffer.from('corrupt')]));
  await expect(packageToolsCarriers(spec)).rejects.toThrow('archive bytes do not match');
  await writeFile(tool, original);
  await expect(
    packageToolsCarriers({
      ...spec,
      payloadFiles: spec.payloadFiles.filter((file) => file !== tool),
    }),
  ).rejects.toThrow();
  for (const field of ['version', 'runtimeVersion', 'sourceFingerprint']) {
    const original = manifest[field];
    manifest[field] = field === 'sourceFingerprint' ? 'stale source' : '99.0.0';
    await saveManifest();
    await expect(packageToolsCarriers(spec)).rejects.toThrow('incompatible producer identity');
    manifest[field] = original;
  }
});

test('AOT tools reject foreign/runtime members, stale source, wrong target and corrupt serialized framing', async () => {
  const { spec, manifest, saveManifest } = await fixture('linux-x64-gnu');
  for (const [object, field, bad] of [
    [manifest, 'target-triple', 'aarch64-apple-darwin'],
    [manifest, 'source-fingerprint', 'stale source'],
    [manifest.artifacts[0], 'name', 'runtime'],
    [manifest.artifacts[0], 'raw-sha256', 'f'.repeat(64)],
  ] as const) {
    const original = object[field];
    object[field] = bad;
    await saveManifest();
    await expect(packageToolsCarriers(spec)).rejects.toThrow();
    object[field] = original;
  }
  await saveManifest();
  const artifact = path.join(spec.payload, manifest.artifacts[0].path);
  await expect(
    packageToolsCarriers({
      ...spec,
      payloadFiles: spec.payloadFiles.filter((file) => file !== artifact),
    }),
  ).rejects.toThrow();
  await writeFile(artifact, 'invalid compressed bytes');
  await expect(packageToolsCarriers(spec)).rejects.toThrow();
});

test('tools final envelopes reject undeclared/duplicate/unsafe leaves and incomplete legal sources', async () => {
  const { spec } = await fixture();
  for (const invalid of [
    { ...spec, payloadFiles: [] },
    { ...spec, payloadFiles: [...spec.payloadFiles, spec.payloadFiles[0]] },
    { ...spec, payloadFiles: [...spec.payloadFiles, spec.sources['Cargo.toml']] },
    { ...spec, sources: { ...spec.sources, '../escape': spec.sources['README.md'] } },
    { ...spec, notices: {} },
  ])
    await expect(packageToolsCarriers(invalid)).rejects.toThrow();
});

test('a declared runtime file cannot leak into portable tools GitHub or Cargo archives', async () => {
  const { spec } = await fixture();
  const runtime = path.join(spec.payload, 'bin/postgres');
  await writeFile(runtime, '\0asm\x01\0\0\0');
  await expect(
    packageToolsCarriers({ ...spec, payloadFiles: [...spec.payloadFiles, runtime] }),
  ).rejects.toThrow();
});

test('portable tools preserve required legal bytes instead of silently omitting or replacing them', async () => {
  const { spec } = await fixture();
  const notice = path.join(spec.payload, 'THIRD_PARTY_LICENSES/PostgreSQL-COPYRIGHT');
  await expect(
    packageToolsCarriers({
      ...spec,
      payloadFiles: spec.payloadFiles.filter((file) => file !== notice),
    }),
  ).rejects.toThrow();
  await writeFile(notice, 'wrong legal notice');
  await expect(packageToolsCarriers(spec)).rejects.toThrow();
});
