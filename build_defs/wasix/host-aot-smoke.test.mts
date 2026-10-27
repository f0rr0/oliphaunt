import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync, zstdCompressSync } from 'node:zlib';
import { canonicalWasixAotMetadata } from '../../src/wasix/runtime/tools/wasix-aot-manifest.mts';
import {
  AOT_TARGET_TRIPLES,
  RUNTIME_PACKAGE,
  TOOLS_AOT_PACKAGES,
  TOOLS_PACKAGE,
  wasixExtensionAotPackageName,
  wasixExtensionPackageName,
} from '../../src/wasix/runtime/tools/wasix-cargo-artifact-contract.mts';
import { renderCargoToml } from '../../tools/packaging/cargo-manifest.mts';
import { readPortableArchiveEntries } from '../../tools/packaging/portable-archive.mts';
import { releaseNoticeRows, stageReleaseNotices } from '../../tools/packaging/release-notices.mts';
import { wasixHostSmokeCargoIdentities, wasixHostSmokeCargoRows } from './cargo-inputs.mts';
import {
  assertWasixAotSmokeHost,
  type HostSmokeSpec,
  prepareWasixHostAotSmoke,
  readWasixHostAotSmokeSpec,
} from './host-aot-smoke.mts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const module = Buffer.from('\0asm\x01\0\0\0');
const product = 'oliphaunt-extension-contrib-pg18';
const version = '8.9.10';
const toolsVersion = '4.5.6';
const fingerprint = 'independent source/hash fixture; no executable AOT claim';

async function fixture(targetId: string, mutation: string = '') {
  const root = mkdtempSync(path.join(os.tmpdir(), 'wasix-host-smoke-format-'));
  roots.push(root);
  const target = AOT_TARGET_TRIPLES[targetId];
  const crates: Record<string, string> = {};
  const pack = async (
    name: string,
    packageVersion: string,
    files: Record<string, Uint8Array | string>,
  ) => {
    const prefix = `${name}-${packageVersion}`;
    const members = Object.fromEntries(
      Object.entries({
        'Cargo.toml': `[package]\nname="${name}"\nversion="${packageVersion}"\n`,
        ...files,
      }).map(([file, bytes]) => [`${prefix}/${file}`, bytes]),
    );
    const file = path.join(root, `${prefix}.crate`);
    writeFileSync(file, gzipSync(Buffer.from(await new Bun.Archive(members).bytes())));
    crates[path.basename(file)] = file;
  };
  const coreArchive = zstdCompressSync(
    Buffer.from(await new Bun.Archive({ 'oliphaunt/bin/postgres': module }).bytes()),
  );
  await pack(RUNTIME_PACKAGE, version, {
    'payload/manifest.json': JSON.stringify({
      'source-fingerprint': fingerprint,
      runtime: {
        sha256: sha(coreArchive),
        'module-sha256': sha(module),
        'postgres-version': '18.3',
      },
    }),
    'payload/oliphaunt.wasix.tar.zst': coreArchive,
  });
  const uuid = mutation === 'module' ? Buffer.concat([module, Buffer.from('changed')]) : module;
  const archive = zstdCompressSync(
    Buffer.from(await new Bun.Archive({ 'lib/postgresql/uuid-ossp.so': uuid }).bytes()),
  );
  await pack(wasixExtensionPackageName(product), version, {
    'payload/files/extensions/uuid-ossp/extension.tar.zst': archive,
  });
  const canonical = canonicalWasixAotMetadata(undefined, target);
  const manifest = (artifacts: unknown[]) => ({
    'format-version': 1,
    'source-lane': canonical.sourceLane,
    engine: canonical.engine,
    'wasmer-version': canonical.wasmerVersion,
    'wasmer-wasix-version': canonical.wasmerWasixVersion,
    'target-triple': target,
    'source-fingerprint': fingerprint,
    'postgres-version': '18.3',
    artifacts,
  });
  const image = (name: string, file: string) => {
    const raw = Buffer.from(`independent serialized hash fixture ${name}`);
    const compressed = zstdCompressSync(raw);
    return {
      bytes: compressed,
      row: {
        name,
        path: file,
        compressed: true,
        sha256: sha(compressed),
        'module-sha256': sha(module),
        'raw-sha256': sha(raw),
        'raw-size': raw.length,
      },
    };
  };
  const side = image('extension:uuid-ossp', 'uuid.bin.zst');
  const sideManifest = manifest([side.row]);
  if (mutation === 'target') sideManifest['target-triple'] = 'unsupported-target';
  if (mutation === 'source') sideManifest['source-fingerprint'] = 'stale source';
  if (mutation === 'postgres') sideManifest['postgres-version'] = 'different PostgreSQL';
  await pack(wasixExtensionAotPackageName(product, target), version, {
    'manifests/uuid-ossp.json': JSON.stringify(sideManifest),
    'payload/files/extensions/uuid-ossp/uuid.bin.zst':
      mutation === 'image' ? Buffer.from('changed image') : side.bytes,
  });
  const legal = (profile: string) => {
    const directory = path.join(root, profile);
    stageReleaseNotices(directory, { profile });
    return Object.fromEntries(
      releaseNoticeRows({ profile }).map((row) => [
        row.member,
        readFileSync(path.join(directory, row.member)),
      ]),
    );
  };
  const toolsManifest: Record<string, any> = {
    schema: 'postgres-tools-wasix-portable-v1',
    version: toolsVersion,
    runtimeVersion: mutation === 'runtime' ? 'stale runtime' : version,
    sourceFingerprint: fingerprint,
  };
  for (const [key, name] of [
    ['pgDump', 'pg_dump'],
    ['psql', 'psql'],
  ])
    toolsManifest[key] = {
      name,
      path: `bin/${name}.wasix.wasm`,
      sha256: sha(module),
      size: module.length,
    };
  await pack(TOOLS_PACKAGE, toolsVersion, {
    ...Object.fromEntries(
      Object.entries(legal('wasix-tools')).map(([file, bytes]) => [`payload/${file}`, bytes]),
    ),
    'payload/manifest.json': JSON.stringify(toolsManifest),
    'payload/bin/pg_dump.wasix.wasm': module,
    ...(mutation === 'missing-tool' ? {} : { 'payload/bin/psql.wasix.wasm': module }),
  });
  const dump = image('tool:pg_dump', 'tools/pg_dump.bin.zst');
  const psql = image('tool:psql', 'tools/psql.bin.zst');
  await pack(TOOLS_AOT_PACKAGES[targetId], toolsVersion, {
    ...Object.fromEntries(
      Object.entries(legal('wasix-aot')).map(([file, bytes]) => [`artifacts/${file}`, bytes]),
    ),
    'artifacts/manifest.json': JSON.stringify(manifest([dump.row, psql.row])),
    'artifacts/tools/pg_dump.bin.zst': dump.bytes,
    'artifacts/tools/psql.bin.zst': psql.bytes,
  });
  return {
    root,
    spec: { target, runtimeVersion: version, toolsVersion, crates } satisfies HostSmokeSpec,
  };
}

async function repack(file: string, update: (files: Record<string, Uint8Array | string>) => void) {
  const entries = readPortableArchiveEntries(file);
  const prefix = path.basename(file, '.crate');
  const files = Object.fromEntries(
    [...entries.values()]
      .filter((entry) => entry.isFile)
      .map((entry) => [entry.name.slice(prefix.length + 1), entry.data()]),
  );
  update(files);
  const archive = new Bun.Archive(
    Object.fromEntries(Object.entries(files).map(([name, bytes]) => [`${prefix}/${name}`, bytes])),
  );
  writeFileSync(file, gzipSync(Buffer.from(await archive.bytes())));
}

/** Use the extension's actual complete-file/chunk layout without constructing a WASIX module. */
async function splitContrib(spec: HostSmokeSpec) {
  for (const name of [
    wasixExtensionPackageName(product),
    wasixExtensionAotPackageName(product, spec.target),
  ]) {
    const file = spec.crates[`${name}-${version}.crate`];
    const entries = readPortableArchiveEntries(file);
    const prefix = `${name}-${version}/payload/files/`;
    const payload = [...entries.values()].filter(
      (entry) => entry.isFile && entry.name.startsWith(prefix),
    );
    expect(payload.length).toBeGreaterThan(0);
    const parts: string[] = [];
    for (let index = 0; index < 2; index++) {
      const part = `${name}-part-${String(index + 1).padStart(3, '0')}`;
      parts.push(part);
      const chunks = Object.fromEntries(
        payload.map((entry) => {
          const bytes = entry.data();
          const middle = Math.ceil(bytes.length / 2);
          return [
            `payload/chunks/${entry.name.slice(prefix.length)}.part${String(index).padStart(6, '0')}`,
            bytes.subarray(index ? middle : 0, index ? bytes.length : middle),
          ];
        }),
      );
      const filename = `${part}-${version}.crate`;
      const destination = path.join(path.dirname(file), name, filename);
      mkdirSync(path.dirname(destination), { recursive: true });
      const archive = new Bun.Archive(
        Object.fromEntries(
          Object.entries({
            'Cargo.toml': renderCargoToml({ package: { name: part, version } }),
            ...chunks,
          }).map(([member, bytes]) => [`${part}-${version}/${member}`, bytes]),
        ),
      );
      writeFileSync(destination, gzipSync(Buffer.from(await archive.bytes())));
      spec.crates[filename] = destination;
    }
    await repack(file, (files) => {
      const manifest = Bun.TOML.parse(files['Cargo.toml'].toString());
      manifest.dependencies = Object.fromEntries(
        parts.map((name) => [name, { version: `=${version}` }]),
      );
      files['Cargo.toml'] = renderCargoToml(manifest);
      for (const member of Object.keys(files))
        if (member.startsWith('payload/')) delete files[member];
    });
  }
}

for (const [targetId, target] of Object.entries(AOT_TARGET_TRIPLES)) {
  test(`prepares exactly UUID-OSSP and split tools for ${target}`, async () => {
    const { root, spec } = await fixture(targetId);
    const packets = prepareWasixHostAotSmoke(spec, path.join(root, 'prepared'));
    const extension = JSON.parse(readFileSync(packets.extensionPacket, 'utf8'));
    const tools = JSON.parse(readFileSync(packets.toolsPacket, 'utf8'));
    expect(extension.archives.map((row: any) => row.sqlName)).toEqual(['uuid-ossp']);
    expect(extension.aotArtifacts).toHaveLength(1);
    expect(extension.coreModuleSha256).toEqual(sha(module));
    expect(JSON.parse(readFileSync(extension.aotManifest, 'utf8'))['target-triple']).toEqual(
      target,
    );
    expect(tools.runtimeVersion).toEqual(version);
    expect(readFileSync(tools.pgDump.wasm)).toEqual(module);
    expect(readFileSync(tools.psql.wasm)).toEqual(module);
    expect(JSON.parse(readFileSync(tools.psql.manifest, 'utf8'))['target-triple']).toEqual(target);
  });
  test(`prepares declared portable and AOT contrib parts for ${target}`, async () => {
    const { root, spec } = await fixture(targetId);
    await splitContrib(spec);
    const specification = path.join(root, 'split.inputs.json');
    const { crates, ...metadata } = spec;
    writeFileSync(specification, JSON.stringify(metadata));
    const resolved = readWasixHostAotSmokeSpec(specification, Object.values(crates));
    expect(Object.keys(resolved.crates)).toHaveLength(9);
    const packets = prepareWasixHostAotSmoke(resolved, path.join(root, 'prepared'));
    const extension = JSON.parse(readFileSync(packets.extensionPacket, 'utf8'));
    expect(extension.coreModuleSha256).toEqual(sha(module));
    expect(extension.aotArtifacts).toHaveLength(1);
    expect(readFileSync(extension.aotArtifacts[0].source)).toEqual(
      zstdCompressSync(Buffer.from('independent serialized hash fixture extension:uuid-ossp')),
    );
    const tools = JSON.parse(readFileSync(packets.toolsPacket, 'utf8'));
    expect(readFileSync(tools.pgDump.wasm)).toEqual(module);
    expect(readFileSync(tools.psql.wasm)).toEqual(module);
  });
}
test('contrib families reject missing, duplicate, foreign, unpinned and corrupt part inputs', async () => {
  for (const mutation of ['missing', 'loose-pin', 'qualification-only', 'corrupt', 'chunk-gap']) {
    const { root, spec } = await fixture('windows-x64-msvc');
    await splitContrib(spec);
    const parent = wasixExtensionAotPackageName(product, spec.target);
    const filename = `${parent}-part-001-${version}.crate`;
    const part = spec.crates[filename];
    if (mutation === 'missing') delete spec.crates[filename];
    else if (mutation === 'loose-pin')
      await repack(spec.crates[`${parent}-${version}.crate`], (files) => {
        const manifest = Bun.TOML.parse(files['Cargo.toml'].toString());
        manifest.dependencies[`${parent}-part-001`].version = version;
        files['Cargo.toml'] = renderCargoToml(manifest);
      });
    else
      await repack(part, (files) => {
        if (mutation === 'qualification-only') {
          const manifest = Bun.TOML.parse(files['Cargo.toml'].toString());
          manifest.package.metadata = { oliphaunt: { qualificationOnly: true } };
          files['Cargo.toml'] = renderCargoToml(manifest);
        } else {
          const chunk = Object.keys(files).find((name) => name.startsWith('payload/chunks/'))!;
          if (mutation === 'chunk-gap') {
            files[chunk.replace('.part000000', '.part000002')] = files[chunk];
            delete files[chunk];
          } else {
            const changed = Buffer.from(files[chunk]);
            changed[0] ^= 1;
            files[chunk] = changed;
          }
        }
      });
    expect(() => prepareWasixHostAotSmoke(spec, path.join(root, 'rejected'))).toThrow();
  }
  const { root, spec } = await fixture('linux-x64-gnu');
  await splitContrib(spec);
  const specification = path.join(root, 'host.inputs.json');
  const { crates, ...metadata } = spec;
  writeFileSync(specification, JSON.stringify(metadata));
  const inputs = Object.values(crates);
  const part = inputs.find((file) => path.basename(file).includes('-part-001-'))!;
  expect(() => readWasixHostAotSmokeSpec(specification, [...inputs, part])).toThrow(/unique/u);
  expect(() =>
    readWasixHostAotSmokeSpec(specification, [
      ...inputs,
      path.join(root, `oliphaunt-extension-contrib-pg18-aot-linux-arm64-part-001-${version}.crate`),
    ]),
  ).toThrow(/unexpected archive/u);
  expect(() =>
    readWasixHostAotSmokeSpec(specification, [
      ...inputs,
      path.join(root, `${TOOLS_PACKAGE}-part-001-${toolsVersion}.crate`),
    ]),
  ).toThrow(/unexpected archive/u);
});
test('resolved main and external runfiles preserve exact host envelope inputs', async () => {
  const { root, spec } = await fixture('linux-arm64-gnu');
  const runfiles = path.join(root, 'runfiles');
  const archiveFiles = Object.values(spec.crates).map((file, index) => {
    const directory = path.join(
      runfiles,
      index === 0
        ? '_main/generated-carriers/crate.packages'
        : '+_repo_rules32+wasix_runtime_carriers/host-smoke',
    );
    mkdirSync(directory, { recursive: true });
    const output = path.join(directory, path.basename(file));
    copyFileSync(file, output);
    return output;
  });
  const specification = path.join(root, 'host.inputs.json');
  const { crates: _crates, ...metadata } = spec;
  writeFileSync(specification, JSON.stringify({ ...metadata, workspace: '_main' }));
  const resolved = readWasixHostAotSmokeSpec(specification, archiveFiles);
  const leaves = archiveFiles.map((file) => {
    const relative = path.relative(runfiles, file).replaceAll('\\', '/');
    return relative.startsWith('_main/') ? relative.slice(6) : `../${relative}`;
  });
  expect(readWasixHostAotSmokeSpec(specification, leaves, runfiles)).toEqual(resolved);
  expect(() => readWasixHostAotSmokeSpec(specification, leaves.slice(1), runfiles)).toThrow(
    /five resolved/u,
  );
  expect(() =>
    readWasixHostAotSmokeSpec(specification, [...leaves, 'unrelated.crate'], runfiles),
  ).toThrow(/unexpected archive/u);
  expect(() =>
    readWasixHostAotSmokeSpec(
      specification,
      [...leaves.slice(1), 'generated-carriers/foreign.crate'],
      runfiles,
    ),
  ).toThrow(/exact five canonical/u);
  const packets = prepareWasixHostAotSmoke(resolved, path.join(root, 'from-runfiles'));
  const tools = JSON.parse(readFileSync(packets.toolsPacket, 'utf8'));
  expect(readFileSync(tools.pgDump.wasm)).toEqual(module);
  expect(readFileSync(tools.psql.wasm)).toEqual(module);
  expect(JSON.parse(readFileSync(tools.psql.manifest, 'utf8'))['target-triple']).toEqual(
    spec.target,
  );
  expect(() => readWasixHostAotSmokeSpec(specification, archiveFiles.slice(1))).toThrow(
    /five resolved/u,
  );
  expect(() =>
    readWasixHostAotSmokeSpec(specification, [...archiveFiles.slice(1), archiveFiles[1]]),
  ).toThrow(/unique/u);
  expect(() =>
    readWasixHostAotSmokeSpec(
      specification,
      archiveFiles.map((file) => path.relative(runfiles, file)),
    ),
  ).toThrow(/resolved declared/u);
});
test('rejects wrong target/source/core module and changed/missing utility inputs', async () => {
  for (const mutation of [
    'target',
    'source',
    'postgres',
    'module',
    'image',
    'runtime',
    'missing-tool',
  ]) {
    const { root, spec } = await fixture('linux-x64-gnu', mutation);
    expect(() => prepareWasixHostAotSmoke(spec, path.join(root, 'prepared'))).toThrow();
  }
});
test('host execution accepts each supported native executor and rejects cross-host execution', () => {
  for (const [platform, architecture, targetId] of [
    ['linux', 'x64', 'linux-x64-gnu'],
    ['linux', 'arm64', 'linux-arm64-gnu'],
    ['darwin', 'arm64', 'macos-arm64'],
    ['win32', 'x64', 'windows-x64-msvc'],
  ]) {
    expect(() =>
      assertWasixAotSmokeHost(AOT_TARGET_TRIPLES[targetId], platform, architecture),
    ).not.toThrow();
    expect(() => assertWasixAotSmokeHost('different-target', platform, architecture)).toThrow();
  }
  expect(() =>
    assertWasixAotSmokeHost(AOT_TARGET_TRIPLES['macos-arm64'], 'darwin', 'x64'),
  ).toThrow();
});
test('canonical support receipt rejects absent, duplicate, wrong version and target archives', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'wasix-host-smoke-receipt-'));
  roots.push(root);
  const toolsManifest = path.join(root, 'src/wasix/postgres-tools/crates/tools/Cargo.toml');
  mkdirSync(path.dirname(toolsManifest), { recursive: true });
  writeFileSync(toolsManifest, `[package]\nname="${TOOLS_PACKAGE}"\nversion="${toolsVersion}"\n`);
  const identities = wasixHostSmokeCargoIdentities(root, version);
  const inputs = await Promise.all(
    identities.map(async (identity) => {
      const file = path.join(root, `${identity.name}-${identity.version}.crate`);
      const contents = new Bun.Archive({
        [`${identity.name}-${identity.version}/Cargo.toml`]: `[package]\nname="${identity.name}"\nversion="${identity.version}"\n`,
      });
      writeFileSync(file, gzipSync(Buffer.from(await contents.bytes())));
      return { file, name: identity.name, target: identity.target };
    }),
  );
  const receipt = wasixHostSmokeCargoRows(inputs, root, version);
  expect(receipt).toHaveLength(10);
  expect(
    receipt.every((row) => row.sha256 === sha(readFileSync(path.join(root, row.path)))),
  ).toBeTrue();
  expect(() => wasixHostSmokeCargoRows(inputs.slice(1), root, version)).toThrow();
  expect(() => wasixHostSmokeCargoRows([...inputs.slice(1), inputs[1]], root, version)).toThrow();
  expect(() =>
    wasixHostSmokeCargoRows(
      inputs.map((row, index) => (index === 0 ? { ...row, target: 'wrong-target' } : row)),
      root,
      version,
    ),
  ).toThrow();
  expect(() => wasixHostSmokeCargoRows(inputs, root, 'different-version')).toThrow();
});
