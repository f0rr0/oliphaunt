import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  validatePortableToolsPayload,
  validateToolsAotPayload,
} from '../../src/wasix/postgres-tools/tools/package-assets.mts';
import { assertWasixAotArtifactPayloads } from '../../src/wasix/runtime/tools/check-release-assets.mts';
import { assertCanonicalWasixAotManifest } from '../../src/wasix/runtime/tools/wasix-aot-manifest.mts';
import {
  AOT_TARGET_TRIPLES,
  RUNTIME_PACKAGE,
  TOOLS_AOT_PACKAGES,
  TOOLS_PACKAGE,
  wasixExtensionAotPackageName,
  wasixExtensionPackageName,
} from '../../src/wasix/runtime/tools/wasix-cargo-artifact-contract.mts';
import {
  readPortableArchiveEntries,
  readPortableTarZstdBufferEntries,
} from '../../tools/packaging/portable-archive.mts';
import {
  readWasixCargoCarrierPayload,
  readWasixCargoCarrierSet,
} from '../../tools/packaging/wasix-extension-cargo-family.mts';

export type HostSmokeSpec = {
  target: string;
  runtimeVersion: string;
  toolsVersion: string;
  crates: Record<string, string>;
};
const PRODUCT = 'oliphaunt-extension-contrib-pg18';
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export function readWasixHostAotSmokeSpec(
  specification: string,
  crates: readonly string[],
  runfiles?: string,
): HostSmokeSpec {
  const spec = JSON.parse(readFileSync(specification, 'utf8'));
  if (runfiles)
    crates = crates.map((file) =>
      path.join(runfiles, file.startsWith('../') ? file.slice(3) : `${spec.workspace}/${file}`),
    );
  assert(
    crates.length >= 5 && crates.every((file) => path.isAbsolute(file)),
    'WASIX host smoke requires five resolved declared parent archives and their parts',
  );
  const byName = Object.fromEntries(crates.map((file) => [path.basename(file), file]));
  assert.equal(
    Object.keys(byName).length,
    crates.length,
    'WASIX host smoke archive names must be unique',
  );
  const targetId = Object.keys(AOT_TARGET_TRIPLES).find(
    (key) => AOT_TARGET_TRIPLES[key] === spec.target,
  );
  assert(targetId, 'WASIX host smoke needs a canonical native target');
  const contrib = [
    wasixExtensionPackageName(PRODUCT),
    wasixExtensionAotPackageName(PRODUCT, spec.target),
  ];
  const parents = [
    `${RUNTIME_PACKAGE}-${spec.runtimeVersion}.crate`,
    ...contrib.map((name) => `${name}-${spec.runtimeVersion}.crate`),
    `${TOOLS_PACKAGE}-${spec.toolsVersion}.crate`,
    `${TOOLS_AOT_PACKAGES[targetId]}-${spec.toolsVersion}.crate`,
  ];
  assert.deepEqual(
    Object.keys(byName)
      .filter((name) => parents.includes(name))
      .sort(),
    parents.sort(),
    'WASIX host smoke requires its exact five canonical parent archives',
  );
  for (const file of Object.keys(byName).filter((name) => !parents.includes(name)))
    assert(
      contrib.some((parent) => {
        const prefix = `${parent}-part-`;
        const suffix = `-${spec.runtimeVersion}.crate`;
        const index = file.slice(prefix.length, -suffix.length);
        return (
          file.startsWith(prefix) &&
          file.endsWith(suffix) &&
          /^[0-9]{3}$/u.test(index) &&
          Number(index) > 0
        );
      }),
      'WASIX host smoke has an unexpected archive outside its selected contrib families',
    );
  return { ...spec, crates: byName };
}

export function assertWasixAotSmokeHost(
  target: string,
  platform: string = process.platform,
  architecture: string = process.arch,
) {
  const hostId = {
    'linux-x64': 'linux-x64-gnu',
    'linux-arm64': 'linux-arm64-gnu',
    'darwin-arm64': 'macos-arm64',
    'win32-x64': 'windows-x64-msvc',
  }[`${platform}-${architecture}`];
  assert(
    hostId && target === AOT_TARGET_TRIPLES[hostId],
    'WASIX AOT smoke must execute on its declared native host',
  );
}

/** Extract the selected host's genuine final envelopes; no WASIX producer runs here. */
export function prepareWasixHostAotSmoke(spec: HostSmokeSpec, root: string) {
  const targetId = Object.keys(AOT_TARGET_TRIPLES).find(
    (key) => AOT_TARGET_TRIPLES[key] === spec.target,
  );
  assert(targetId, 'WASIX host smoke needs a canonical native target');
  const contribNames = [
    wasixExtensionPackageName(PRODUCT),
    wasixExtensionAotPackageName(PRODUCT, spec.target),
  ];
  const contrib = readWasixCargoCarrierSet(
    contribNames.map((name, index) => ({
      product: 'liboliphaunt-wasix',
      ecosystem: 'cargo',
      name,
      version: spec.runtimeVersion,
      role: index === 0 ? 'portable-leaf' : 'aot-leaf',
      target: index === 0 ? 'wasix-portable' : spec.target,
    })),
    Object.values(spec.crates)
      .filter((file) => contribNames.some((name) => path.basename(file).startsWith(`${name}-`)))
      .map((file) => realpathSync(file)),
  );
  const write = (relative: string, bytes: Uint8Array | string) => {
    const file = path.join(root, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, bytes);
    chmodSync(file, 0o644);
    return file;
  };
  const crate = (name: string, version: string) => {
    const filename = `${name}-${version}.crate`;
    assert(spec.crates[filename], `WASIX host smoke is missing its exact final ${filename}`);
    const parent = contrib.find((row) => row.name === name);
    const entries =
      parent?.entries ?? readPortableArchiveEntries(realpathSync(spec.crates[filename]));
    const payload = parent ? readWasixCargoCarrierPayload(contrib, parent) : undefined;
    const prefix = `${name}-${version}/`;
    const bytes = (relative: string) => {
      if (payload && relative.startsWith('payload/files/')) {
        const data = payload.get(relative.slice('payload/files/'.length));
        assert(data, `WASIX host smoke needs regular ${filename}:${relative}`);
        return data;
      }
      const entry = entries.get(prefix + relative);
      assert(
        entry?.isFile && !entry.isSymbolicLink,
        `WASIX host smoke needs regular ${filename}:${relative}`,
      );
      return Buffer.from(entry.data());
    };
    const manifest = Bun.TOML.parse(bytes('Cargo.toml').toString()).package;
    assert.equal(manifest.name, name);
    assert.equal(manifest.version, version);
    const extract = (directory: string, destination: string) => {
      const memberPrefix = `${prefix}${directory}/`;
      for (const [member, entry] of entries) {
        if (!member.startsWith(memberPrefix) || entry.isDirectory) continue;
        assert(entry.isFile && !entry.isSymbolicLink, 'WASIX host smoke payload must be regular');
        const relative = member.slice(memberPrefix.length);
        assert(relative && !relative.split('/').some((part) => ['', '.', '..'].includes(part)));
        write(`${destination}/${relative}`, entry.data());
      }
      return path.join(root, destination);
    };
    return { bytes, extract };
  };
  const core = crate(RUNTIME_PACKAGE, spec.runtimeVersion);
  const coreManifest = JSON.parse(core.bytes('payload/manifest.json').toString());
  const coreArchive = core.bytes('payload/oliphaunt.wasix.tar.zst');
  assert.equal(digest(coreArchive), coreManifest.runtime.sha256);
  const coreModule = readPortableTarZstdBufferEntries(coreArchive).get('oliphaunt/bin/postgres');
  assert(
    coreModule?.isFile && !coreModule.isSymbolicLink,
    'WASIX host smoke requires its actual current core module',
  );
  const coreModuleSha256 = digest(coreModule.data());
  assert.equal(coreModuleSha256, coreManifest.runtime['module-sha256']);
  const sourceFingerprint = coreManifest['source-fingerprint'];
  assert.equal(typeof sourceFingerprint, 'string');

  const portable = crate(wasixExtensionPackageName(PRODUCT), spec.runtimeVersion);
  const archive = portable.bytes('payload/files/extensions/uuid-ossp/extension.tar.zst');
  const module = readPortableTarZstdBufferEntries(archive).get('lib/postgresql/uuid-ossp.so');
  assert(module?.isFile && !module.isSymbolicLink, 'UUID-OSSP final archive has no side module');
  const aot = crate(wasixExtensionAotPackageName(PRODUCT, spec.target), spec.runtimeVersion);
  const aotManifest = JSON.parse(aot.bytes('manifests/uuid-ossp.json').toString());
  assertCanonicalWasixAotManifest(aotManifest, { expectedTarget: spec.target });
  assert.equal(
    aotManifest['source-fingerprint'],
    sourceFingerprint,
    'UUID-OSSP AOT source differs from its exact core',
  );
  assert.equal(
    aotManifest['postgres-version'],
    coreManifest.runtime['postgres-version'],
    'UUID-OSSP AOT PostgreSQL identity differs from its exact core',
  );
  assert.deepEqual(
    aotManifest.artifacts.map((row: { name: string }) => row.name),
    ['extension:uuid-ossp'],
  );
  assert.equal(
    aotManifest.artifacts[0]['module-sha256'],
    digest(module.data()),
    'UUID-OSSP AOT side-module identity differs from its final portable archive',
  );
  assertWasixAotArtifactPayloads(aotManifest, {
    readArtifact: (relative: string) => aot.bytes(`payload/files/extensions/uuid-ossp/${relative}`),
  });
  const extensionPacket = write(
    'extension-packet.json',
    JSON.stringify({
      product: PRODUCT,
      version: spec.runtimeVersion,
      runtimeVersion: spec.runtimeVersion,
      archives: [
        {
          sqlName: 'uuid-ossp',
          path: write('extension.tar.zst', archive),
          sha256: digest(archive),
        },
      ],
      aotManifest: write('extension-aot/manifest.json', JSON.stringify(aotManifest)),
      aotArtifacts: aotManifest.artifacts.map((row: { path: string }) => ({
        path: row.path,
        source: write(
          `extension-aot/${row.path}`,
          aot.bytes(`payload/files/extensions/uuid-ossp/${row.path}`),
        ),
      })),
      coreModuleSha256,
      coreManifest: write('core-manifest.json', JSON.stringify(coreManifest)),
    }),
  );
  const toolsPortable = crate(TOOLS_PACKAGE, spec.toolsVersion).extract(
    'payload',
    'tools/portable',
  );
  const toolsAot = crate(TOOLS_AOT_PACKAGES[targetId], spec.toolsVersion).extract(
    'artifacts',
    'tools/aot',
  );
  const portableManifest = validatePortableToolsPayload(toolsPortable, spec.toolsVersion, {
    runtimeVersion: spec.runtimeVersion,
    sourceFingerprint,
  });
  const toolsManifest = validateToolsAotPayload(toolsAot, spec.target, { sourceFingerprint });
  const tool = (key: 'pgDump' | 'psql') => {
    const wasm = portableManifest[key];
    const image = toolsManifest.artifacts.find(
      (row: { name: string }) => row.name === `tool:${wasm.name}`,
    );
    assert(image, 'WASIX host smoke needs the matching split-tool AOT image');
    assert.equal(image['module-sha256'], wasm.sha256);
    return {
      wasm: path.join(toolsPortable, wasm.path),
      aot: path.join(toolsAot, image.path),
      manifest: path.join(toolsAot, 'manifest.json'),
    };
  };
  const toolsPacket = write(
    'tools-packet.json',
    JSON.stringify({
      version: spec.toolsVersion,
      runtimeVersion: spec.runtimeVersion,
      pgDump: tool('pgDump'),
      psql: tool('psql'),
    }),
  );
  return { extensionPacket, toolsPacket };
}

if (import.meta.main) {
  assert.equal(
    process.argv.length,
    6,
    'WASIX host smoke requires its configured specification, Rust test binary and declared archive leaves',
  );
  const spec = readWasixHostAotSmokeSpec(
    process.argv[2],
    readFileSync(process.argv[4], 'utf8').split('\n').filter(Boolean),
    process.argv[5],
  );
  assertWasixAotSmokeHost(spec.target);
  const root = mkdtempSync(
    path.join(process.env.TEST_TMPDIR ?? os.tmpdir(), 'wasix-host-aot-smoke-'),
  );
  try {
    const { extensionPacket, toolsPacket } = prepareWasixHostAotSmoke(spec, root);
    const result = Bun.spawnSync(
      [
        realpathSync(process.argv[3]),
        '--ignored',
        '--exact',
        'oliphaunt::extensions::extension_tests::declared_uuid_ossp_carriers_pass_aot_host_smoke',
        '--nocapture',
        '--test-threads=1',
      ],
      {
        env: {
          ...process.env,
          OLIPHAUNT_WASM_AOT_VERIFY: 'full',
          OLIPHAUNT_DECLARED_EXTENSION_PACKET: extensionPacket,
          OLIPHAUNT_DECLARED_TOOLS_PACKET: toolsPacket,
        },
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 900000,
      },
    );
    assert.equal(result.exitCode, 0, `${result.stderr.toString()}\n${result.stdout.toString()}`);
    assert.match(result.stdout.toString(), /\b1 passed; 0 failed;/u);
    console.log(result.stdout.toString().trim());
    console.log(
      'Actual current-source UUID-OSSP AOT execution/restart/materialization and split-tool dump/restore: PASS',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
