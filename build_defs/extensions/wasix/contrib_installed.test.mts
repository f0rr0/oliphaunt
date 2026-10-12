import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  assertWasixExtensionArchiveInstall,
  EXTENSION_RUNTIME_CONTRACT_SCHEMA,
  WASIX_EXTENSION_INSTALL_SIDECAR_SCHEMA,
} from '../../../src/extensions/contracts/wasix-extension-install.mts';
import { assertWasixAotArtifactPayloads } from '../../../src/wasix/runtime/tools/check-release-assets.mts';
import { assertCanonicalWasixAotManifest } from '../../../src/wasix/runtime/tools/wasix-aot-manifest.mts';
import { AOT_TARGET_TRIPLES } from '../../../src/wasix/runtime/tools/wasix-cargo-artifact-contract.mts';
import { readPortableArchiveEntries } from '../../../tools/packaging/portable-archive.mts';

assert.equal(process.argv.length, 9, 'contrib installed test requires its seven declared inputs');
const [specInput, npmInput, cargoInput, frozenInput, coreInput, coreManifestInput, binary] =
  process.argv.slice(2);
const spec = JSON.parse(readFileSync(specInput, 'utf8'));
const frozen = JSON.parse(readFileSync(frozenInput, 'utf8'));
const root = mkdtempSync(
  path.join(process.env.TEST_TMPDIR ?? os.tmpdir(), 'installed-wasix-contrib-'),
);
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function write(relative: string, bytes: Uint8Array | string) {
  const file = path.join(root, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, bytes);
  return file;
}
try {
  assert.equal(spec.owner, 'liboliphaunt-wasix');
  assert.equal(spec.product, 'oliphaunt-extension-contrib-pg18');
  assert.equal(spec.version, spec.runtimeVersion);
  assert.equal(frozen.product, spec.product);
  assert.equal(frozen.version, spec.version);
  assert.deepEqual(frozen.compatibility, spec.releaseMetadata.compatibility);
  const core = JSON.parse(readFileSync(coreManifestInput, 'utf8'));
  const coreModuleSha256 = digest(readFileSync(coreInput));
  assert.equal(core.runtime['module-sha256'], coreModuleSha256);
  const npm = readPortableArchiveEntries(realpathSync(npmInput));
  const metadata = JSON.parse(npm.get('package/package.json')!.data().toString());
  assert.equal(metadata.name, '@oliphaunt/extension-contrib-pg18-wasix');
  assert.equal(metadata.version, spec.version);
  assert.equal(metadata.oliphaunt.product, spec.product);
  assert.equal(metadata.oliphaunt.kind, 'exact-extension-wasix-bundle');
  assert.equal(metadata.oliphaunt.runtime, 'wasix');
  assert.equal(metadata.oliphaunt.target, spec.target);
  assert.equal(metadata.oliphaunt.wasixRuntimeProduct, spec.compatibility.wasix_runtime_product);
  assert.equal(metadata.oliphaunt.wasixRuntimeVersion, spec.compatibility.wasix_runtime_version);
  assert.equal(metadata.oliphaunt.runtimeBound, true);
  assert.deepEqual([...metadata.oliphaunt.members].sort(), spec.expectedMembers);
  assert.deepEqual(Object.keys(metadata.oliphaunt.carriers).sort(), spec.expectedMembers);
  assert.deepEqual(
    frozen.extensions.map((row: { sqlName: string }) => row.sqlName).sort(),
    spec.expectedMembers,
  );
  const archives = spec.expectedMembers.map((sqlName: string) => {
    const carrier = metadata.oliphaunt.carriers[sqlName];
    const member = frozen.extensions.find((row: { sqlName: string }) => row.sqlName === sqlName);
    assert.deepEqual(
      member.dataFiles.map((relative: string) => `share/postgresql/${relative}`).sort(),
      member.wasixInstall.installedFiles
        .filter(
          (relative: string) =>
            relative.startsWith('share/postgresql/') &&
            !relative.startsWith('share/postgresql/extension/'),
        )
        .sort(),
      `${sqlName} frozen auxiliary data must name its exact physical installation inventory`,
    );
    const entry = npm.get(`package/${carrier.path}`);
    assert(entry?.isFile && !entry.isSymbolicLink);
    const bytes = Buffer.from(entry.data());
    assertWasixExtensionArchiveInstall(bytes, {
      schema: WASIX_EXTENSION_INSTALL_SIDECAR_SCHEMA,
      sqlName,
      archive: `extensions/${sqlName}.tar.zst`,
      sha256: carrier.sha256,
      size: carrier.size,
      install: member.wasixInstall,
    });
    return { sqlName, path: write(`npm/${carrier.path}`, bytes), sha256: carrier.sha256 };
  });
  for (const sqlName of spec.expectedMembers) {
    const relative = metadata.oliphaunt.memberExports[sqlName];
    assert.equal(relative, `./${sqlName}`);
    const descriptorPath = metadata.exports[relative].import;
    assert.equal(descriptorPath, `./descriptors/${sqlName}.js`);
    const descriptorEntry = npm.get(`package/${descriptorPath.slice(2)}`);
    assert(descriptorEntry?.isFile && !descriptorEntry.isSymbolicLink);
    const descriptorFile = write(`npm/${descriptorPath.slice(2)}`, descriptorEntry.data());
    const { default: descriptor } = await import(pathToFileURL(descriptorFile).href);
    assert.equal(descriptor.schema, metadata.oliphaunt.descriptorSchema);
    assert.equal(descriptor.runtime, metadata.oliphaunt.runtime);
    assert.equal(descriptor.product, spec.product);
    assert.equal(descriptor.version, spec.version);
    assert.equal(descriptor.sqlName, sqlName);
    assert.deepEqual(descriptor.compatibility, {
      extensionRuntimeContract: EXTENSION_RUNTIME_CONTRACT_SCHEMA,
      postgresMajor: frozen.compatibility.postgresMajor,
      wasixRuntimeProduct: frozen.compatibility.wasixRuntimeProduct,
      wasixRuntimeVersion: frozen.compatibility.wasixRuntimeVersion,
    });
    assert(descriptor.carriers.some((carrier: { sqlName: string }) => carrier.sqlName === sqlName));
    assert.equal(
      new Set(descriptor.carriers.map((carrier: { sqlName: string }) => carrier.sqlName)).size,
      descriptor.carriers.length,
    );
    for (const carrier of descriptor.carriers) {
      const member = frozen.extensions.find(
        (row: { sqlName: string }) => row.sqlName === carrier.sqlName,
      );
      const archive = archives.find((row: { sqlName: string }) => row.sqlName === carrier.sqlName);
      assert(member && archive, 'public descriptor references an undeclared contrib member');
      assert.equal(carrier.product, spec.product);
      assert.equal(carrier.version, spec.version);
      assert.equal(carrier.archive, `extensions/${carrier.sqlName}.tar.zst`);
      assert.equal(carrier.sha256, archive.sha256);
      assert.equal(carrier.size, readFileSync(archive.path).length);
      assert.equal(carrier.source.href, pathToFileURL(archive.path).href);
      assert.deepEqual(carrier.install, member.wasixInstall);
    }
  }
  const crates = readdirSync(path.dirname(cargoInput))
    .filter((name) => name.endsWith('.crate'))
    .map((name) => path.join(path.dirname(cargoInput), name));
  const cargoRows = crates.map((file) => {
    const entries = readPortableArchiveEntries(realpathSync(file));
    const prefix = path.basename(file, '.crate');
    const cargo = Bun.TOML.parse(entries.get(`${prefix}/Cargo.toml`)!.data().toString());
    assert.equal(cargo.package.version, spec.version);
    return { name: cargo.package.name, prefix, entries };
  });
  const base = spec.carriers.filter((row: { ecosystem: string }) => row.ecosystem === 'cargo');
  assert.deepEqual(
    cargoRows.map((row) => row.name).sort(),
    base.map((row: { name: string }) => row.name).sort(),
  );
  const portable = cargoRows.find((row) => row.name.endsWith('-wasix'))!;
  for (const archive of archives)
    assert.deepEqual(
      portable.entries
        .get(`${portable.prefix}/payload/files/extensions/${archive.sqlName}/extension.tar.zst`)!
        .data(),
      readFileSync(archive.path),
      'Cargo and npm contrib portable bytes differ',
    );
  let host: { aotManifest: string; aotArtifacts: { path: string; source: string }[] } | undefined;
  for (const target of Object.values(AOT_TARGET_TRIPLES)) {
    const row = base.find((row: { target: string }) => row.target === target);
    assert(row, 'missing canonical contrib AOT identity');
    const owner = cargoRows.find((carrier) => carrier.name === row.name)!;
    const files = new Map<string, Buffer>();
    for (const [name, entry] of owner.entries)
      if (name.startsWith(`${owner.prefix}/payload/files/`) && entry.isFile)
        files.set(name.slice(`${owner.prefix}/payload/files/`.length), Buffer.from(entry.data()));
    const manifests = spec.expectedMembers.map((sqlName: string) => {
      const manifest = JSON.parse(
        owner.entries.get(`${owner.prefix}/manifests/${sqlName}.json`)!.data().toString(),
      );
      assertCanonicalWasixAotManifest(manifest, { expectedTarget: target });
      assertWasixAotArtifactPayloads(manifest, {
        readArtifact: (relative: string) => files.get(`extensions/${sqlName}/${relative}`)!,
      });
      const member = frozen.extensions.find(
        (member: { sqlName: string }) => member.sqlName === sqlName,
      );
      assert.equal(manifest.artifacts.length, member.wasixInstall.nativeModules.length);
      for (const artifact of manifest.artifacts)
        assert.equal(
          artifact['module-sha256'],
          member.wasixInstall.nativeModules.find(
            (module: { name: string }) =>
              artifact.name ===
              `extension:${sqlName}${module.name === sqlName ? '' : `:${module.name}`}`,
          ).moduleSha256,
        );
      return {
        ...manifest,
        artifacts: manifest.artifacts.map((artifact: { path: string }) => ({
          ...artifact,
          path: `extensions/${sqlName}/${artifact.path}`,
        })),
      };
    });
    const header = (manifest: { artifacts: unknown }) => {
      const { artifacts: _artifacts, ...rest } = manifest;
      return rest;
    };
    for (const manifest of manifests) assert.deepEqual(header(manifest), header(manifests[0]));
    const merged = {
      ...header(manifests[0]),
      artifacts: manifests.flatMap((manifest: { artifacts: unknown[] }) => manifest.artifacts),
    };
    assertCanonicalWasixAotManifest(merged, { expectedTarget: target });
    assertWasixAotArtifactPayloads(merged, {
      readArtifact: (relative: string) => files.get(relative)!,
    });
    if (target === 'x86_64-unknown-linux-gnu')
      host = {
        aotManifest: write('host-aot/manifest.json', JSON.stringify(merged)),
        aotArtifacts: merged.artifacts.map((artifact: { path: string }) => ({
          path: artifact.path,
          source: write(`host-aot/${artifact.path}`, files.get(artifact.path)!),
        })),
      };
  }
  assert(host, 'installed contrib test requires its declared GNU host cohort');
  const packet = write(
    'packet.json',
    JSON.stringify({
      product: spec.product,
      version: spec.version,
      runtimeVersion: spec.runtimeVersion,
      archives,
      ...host,
      coreModuleSha256,
      coreManifest: realpathSync(coreManifestInput),
    }),
  );
  const result = Bun.spawnSync(
    [
      realpathSync(binary),
      '--ignored',
      '--exact',
      'oliphaunt::extensions::extension_tests::declared_contrib_carriers_pass_full_lifecycle',
      '--nocapture',
      '--test-threads=1',
    ],
    {
      env: { ...process.env, OLIPHAUNT_DECLARED_EXTENSION_PACKET: packet },
      cwd: process.cwd(),
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 900000,
    },
  );
  assert.equal(result.exitCode, 0, `${result.stderr.toString()}\n${result.stdout.toString()}`);
  assert.match(result.stdout.toString(), /1 passed; 0 failed/u);
  console.log(result.stdout.toString().trim());
  console.log(
    'Actual 32-member WASIX contrib npm/Cargo portable and four AOT cohorts with exact source-built core lifecycle: PASS',
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
