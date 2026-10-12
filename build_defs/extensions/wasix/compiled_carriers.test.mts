import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assertWasixExtensionArchiveInstall,
  WASIX_EXTENSION_INSTALL_SIDECAR_SCHEMA,
} from '../../../src/extensions/contracts/wasix-extension-install.mts';
import {
  assertSingleWasixNapiAddonMember,
  assertWasixNapiCarrierManifest,
  assertWasixTypescriptNativeCarrier,
} from '../../../src/wasix/node-addon/tools/carrier-contract.mts';
import { assertWasixAotArtifactPayloads } from '../../../src/wasix/runtime/tools/check-release-assets.mts';
import { assertCanonicalWasixAotManifest } from '../../../src/wasix/runtime/tools/wasix-aot-manifest.mts';
import { AOT_TARGET_TRIPLES } from '../../../src/wasix/runtime/tools/wasix-cargo-artifact-contract.mts';
import {
  extractPortableArchiveTree,
  readPortableArchiveEntries,
} from '../../../tools/packaging/portable-archive.mts';

const [
  input,
  githubInput,
  npmInput,
  cargoInput,
  frozenInput,
  moduleInput,
  addonInput,
  node,
  consumerInput,
  linkInput,
  fixtureInput,
  hostModuleInput,
  hostManifestInput,
  napiInput,
  facadeInput,
  addonTemplateInput,
] = process.argv.slice(2);
assert.equal(process.argv.length, 18);
const napi = JSON.parse(readFileSync(napiInput, 'utf8'));
const addonTemplate = JSON.parse(readFileSync(addonTemplateInput, 'utf8'));
const hostManifestBytes = readFileSync(hostManifestInput);
const hostManifest = JSON.parse(hostManifestBytes.toString());
const githubRoot = path.dirname(githubInput);
const npmRoot = path.dirname(npmInput);
const cargoRoot = path.dirname(cargoInput);
const spec = JSON.parse(readFileSync(input, 'utf8'));
const frozen = JSON.parse(readFileSync(frozenInput, 'utf8'));
const compiled = moduleInput !== '-';
assert.equal(compiled, frozen.wasixInstall.nativeModules.length > 0);
const root = mkdtempSync(
  path.join(process.env.TEST_TMPDIR ?? os.tmpdir(), 'installed-wasix-member-'),
);
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
assert.equal(hostManifest['format-version'], 2);
assert.equal(hostManifest['source-lane'], 'stable');
assert.equal(hostManifest.runtime['runtime-kind'], 'wasix-dynamic-main');
assert.equal(digest(readFileSync(hostModuleInput)), hostManifest.runtime['module-sha256']);
function assertMemberAot(aot: any, target: string, readArtifact: (relative: string) => Buffer) {
  assertCanonicalWasixAotManifest(aot, { expectedTarget: target });
  assertWasixAotArtifactPayloads(aot, { readArtifact });
  assert.equal(aot.artifacts.length, frozen.wasixInstall.nativeModules.length);
  for (const artifact of aot.artifacts) {
    const name =
      artifact.name === `extension:${spec.sqlName}`
        ? spec.sqlName
        : artifact.name.slice(`extension:${spec.sqlName}:`.length);
    const module = frozen.wasixInstall.nativeModules.find(
      (row: { name: string }) => row.name === name,
    );
    assert(module, 'AOT member has no exact compiled module');
    assert.equal(artifact['module-sha256'], module.moduleSha256);
  }
}
try {
  assert.equal(frozen.product, spec.product);
  assert.equal(frozen.version, spec.version);
  assert.equal(frozen.compatibility.wasixRuntimeVersion, spec.compatibility.wasix_runtime_version);
  const asset = frozen.assets[0];
  const archive = readFileSync(path.join(githubRoot, asset.name));
  assertWasixExtensionArchiveInstall(archive, {
    schema: WASIX_EXTENSION_INSTALL_SIDECAR_SCHEMA,
    sqlName: spec.sqlName,
    archive: `extensions/${spec.sqlName}.tar.zst`,
    sha256: asset.sha256,
    size: asset.bytes,
    install: frozen.wasixInstall,
  });
  const portable = readPortableArchiveEntries(realpathSync(path.join(githubRoot, asset.name)));
  if (compiled) {
    assert.deepEqual(
      portable.get(`lib/postgresql/${spec.descriptor['native-module-file']}`)!.data(),
      readFileSync(moduleInput),
      'GitHub member changed the real compiler output',
    );
    assert(frozen.wasixInstall.coreExportsRequired.length > 0);
    assert.deepEqual(frozen.wasixInstall.unresolvedImports, []);
    const linkContract = JSON.parse(readFileSync(linkInput, 'utf8'));
    assert.equal(linkContract.sourceFingerprint, hostManifest['source-fingerprint']);
    assert.equal(linkContract.postgresVersion, hostManifest.runtime['postgres-version']);
    const link = linkContract.moduleLinkMetadata[spec.sqlName];
    const exports = new Set(link.exports.map((row: { name: string }) => row.name));
    const callable = new Set<string>();
    for (const [name, entry] of portable)
      if (name.endsWith('.sql'))
        for (const match of entry
          .data()
          .toString()
          .matchAll(/\bAS\s+'(?:MODULE_PATHNAME|\$libdir\/[^']+)'\s*,\s*'([^']+)'/giu))
          callable.add(match[1]);
    for (const name of ['Pg_magic_func', ...callable])
      assert(exports.has(name), `compiled member lost PostgreSQL export ${name}`);
    for (const name of callable)
      assert(exports.has(`pg_finfo_${name}`), `compiled member lost function metadata ${name}`);
    if (['vector', 'pg_ivm', 'pg_textsearch', 'postgis'].includes(spec.sqlName))
      assert(exports.has('_PG_init'), 'compiled member lost its PostgreSQL initializer');
    if (spec.sqlName === 'vector')
      for (const name of ['HnswParallelBuildMain', 'IvfflatParallelBuildMain'])
        assert(exports.has(name), `compiled vector lost parallel worker export ${name}`);
    if (spec.sqlName === 'pg_textsearch')
      assert(
        exports.has('tp_parallel_build_worker_main'),
        'compiled textsearch lost parallel worker',
      );
    if (spec.sqlName === 'pg_hashids') {
      for (const name of ['hashids_encode_hex', 'hashids_decode_hex', 'malloc', 'calloc', 'free'])
        assert(!exports.has(name), `compiled member exports internal helper or allocator ${name}`);
      for (const name of ['palloc0', 'pfree'])
        assert(
          link.imports.some(
            (row: { name: string; module: string }) => row.module === 'env' && row.name === name,
          ),
          `compiled member lost core allocator import ${name}`,
        );
    }
  } else {
    assert.equal(linkInput, '-');
    assert.equal(frozen.nativeModuleStem, null);
    assert.deepEqual(frozen.wasixInstall.coreExportsRequired, []);
    assert.deepEqual(frozen.wasixInstall.unresolvedImports, []);
    assert(
      [...portable]
        .filter(([, entry]) => entry.isFile)
        .every(([file]) => file.startsWith('share/postgresql/extension/')),
    );
  }
  const installed = new Map<string, string>();
  for (const filename of readdirSync(npmRoot).filter((name) => name.endsWith('.tgz'))) {
    const archivePath = realpathSync(path.join(npmRoot, filename));
    const entries = readPortableArchiveEntries(archivePath);
    const manifest = JSON.parse(entries.get('package/package.json')!.data().toString());
    assert.equal(manifest.version, spec.version);
    assert.equal(manifest.oliphaunt.product, spec.product);
    const destination = path.join(root, 'node_modules', manifest.name);
    extractPortableArchiveTree(archivePath, destination, 'package');
    installed.set(manifest.name, destination);
    if (manifest.oliphaunt.kind === 'exact-extension-wasix')
      assert.deepEqual(
        entries.get(`package/extensions/${spec.sqlName}/extension.tar.zst`)!.data(),
        archive,
      );
    else {
      const aot = JSON.parse(entries.get('package/aot-manifest.json')!.data().toString());
      assertMemberAot(aot, AOT_TARGET_TRIPLES[manifest.oliphaunt.target], (relative) =>
        Buffer.from(entries.get(`package/${relative}`)!.data()),
      );
      assert.equal(
        frozen.wasixInstall.nativeModules[0].moduleSha256,
        digest(readFileSync(moduleInput)),
      );
    }
  }
  assert.equal(installed.size, compiled ? Object.keys(AOT_TARGET_TRIPLES).length + 1 : 1);
  const crates = readdirSync(cargoRoot).filter((name) => name.endsWith('.crate'));
  assert.equal(crates.length, installed.size);
  for (const filename of crates) {
    const entries = readPortableArchiveEntries(realpathSync(path.join(cargoRoot, filename)));
    const prefix = filename.slice(0, -'.crate'.length);
    const manifest = Bun.TOML.parse(entries.get(`${prefix}/Cargo.toml`)!.data().toString());
    assert.equal(manifest.package.version, spec.version);
    if (manifest.package.name.endsWith('-wasix'))
      assert.deepEqual(
        entries.get(`${prefix}/payload/files/extensions/${spec.sqlName}/extension.tar.zst`)!.data(),
        archive,
      );
    else {
      const carrier = spec.carriers.find(
        (row: { ecosystem: string; name: string }) =>
          row.ecosystem === 'cargo' && row.name === manifest.package.name,
      );
      assert(carrier, 'Cargo AOT has no declared canonical identity');
      const aot = JSON.parse(
        entries.get(`${prefix}/manifests/${spec.sqlName}.json`)!.data().toString(),
      );
      assertMemberAot(aot, carrier.target, (relative) =>
        Buffer.from(
          entries.get(`${prefix}/payload/files/extensions/${spec.sqlName}/${relative}`)!.data(),
        ),
      );
    }
  }
  const addonArchive = realpathSync(addonInput);
  const addonEntries = readPortableArchiveEntries(addonArchive);
  const addonMember = (name: string) => {
    const entry = addonEntries.get(name);
    assert(entry?.isFile && !entry.isSymbolicLink, `missing regular addon member ${name}`);
    const bytes = Buffer.from(entry.data());
    assert(bytes.length > 0, `empty addon member ${name}`);
    return bytes;
  };
  const addonManifest = JSON.parse(addonMember('package/package.json').toString());
  let runtimeContract;
  if (napi.current) {
    assert.equal(facadeInput, '-');
    assert.equal(addonTemplate.version, napi.version);
    runtimeContract = { ...addonTemplate.oliphaunt, packageLicense: addonTemplate.license };
  } else {
    const originalBytes = readFileSync(addonArchive);
    assert.equal(digest(originalBytes), napi.original.file.sha256);
    assert.equal(originalBytes.length, napi.original.file.size);
    const facadeBytes = readFileSync(facadeInput);
    assert.equal(digest(facadeBytes), napi.facade.file.sha256);
    assert.equal(facadeBytes.length, napi.facade.file.size);
    const facadeEntries = readPortableArchiveEntries(realpathSync(facadeInput));
    const facadePackage = facadeEntries.get('package/package.json');
    assert(facadePackage?.isFile && !facadePackage.isSymbolicLink);
    const facadeManifest = JSON.parse(facadePackage.data().toString());
    assert.equal(`npm:${facadeManifest.name}`, napi.facade.artifact);
    assert.equal(facadeManifest.version, napi.facade.publication.version);
    assert.equal(`npm:${addonManifest.name}`, napi.original.artifact);
    assert.equal(addonManifest.version, napi.original.publication.version);
    assertWasixTypescriptNativeCarrier(facadeManifest, addonManifest);
    runtimeContract = {
      runtimeProduct: facadeManifest.oliphaunt.runtimeProduct,
      runtimeVersion: facadeManifest.oliphaunt.runtimeVersion,
      addonAbiVersion: facadeManifest.oliphaunt.wasixAddonAbiVersion,
      nodeApiVersion: facadeManifest.oliphaunt.nodeApiVersion,
      packageLicense: addonTemplate.license,
    };
  }
  assert.equal(runtimeContract.runtimeVersion, spec.compatibility.wasix_runtime_version);
  assertWasixNapiCarrierManifest(
    addonManifest,
    {
      target: napi.target.target,
      npmPackage: napi.target.npm_package,
      npmOs: napi.target.npm_os,
      npmCpu: napi.target.npm_cpu,
      npmLibc: napi.target.npm_libc ?? undefined,
    },
    napi.version,
    'installed declared WASIX addon',
    runtimeContract,
  );
  assertSingleWasixNapiAddonMember(addonEntries, 'package/prebuilds/oliphaunt_wasix_napi.node');
  const addonProvenance = JSON.parse(addonMember('package/artifact-provenance.json').toString());
  const constructed = addonProvenance.schema === 'oliphaunt-wasix-napi-construction-data-v2';
  if (!constructed) assert.equal(addonProvenance.schema, 'oliphaunt-wasix-napi-provenance-v1');
  assert.equal(
    addonProvenance.buildInputs.schema,
    constructed ? 'oliphaunt-wasix-napi-build-inputs-v2' : 'oliphaunt-wasix-napi-build-inputs-v1',
  );
  assert.equal(
    addonProvenance.buildInputs.inputs.portableManifest.sha256,
    digest(hostManifestBytes),
  );
  if (constructed) {
    assert.equal(
      addonProvenance.buildInputs.inputs.portableManifest.size,
      hostManifestBytes.length,
    );
    assert.equal(
      addonProvenance.buildInputs.inputs.runtimeArchive.sha256,
      hostManifest.runtime.sha256,
    );
    assert(
      Number.isSafeInteger(addonProvenance.buildInputs.inputs.runtimeArchive.size) &&
        addonProvenance.buildInputs.inputs.runtimeArchive.size > 0,
    );
  }
  assert.equal(
    addonProvenance.binary.sha256,
    digest(addonMember('package/prebuilds/oliphaunt_wasix_napi.node')),
  );
  extractPortableArchiveTree(
    addonArchive,
    path.join(root, 'node_modules', addonManifest.name),
    'package',
  );
  const env = { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' };
  for (const key of Object.keys(env))
    if (/^(?:BUN_|RUNFILES|TEST_SRCDIR)/u.test(key)) delete env[key];
  const result = Bun.spawnSync(
    [
      realpathSync(node),
      '--experimental-strip-types',
      '--preserve-symlinks-main',
      realpathSync(consumerInput),
      addonManifest.name,
      spec.product,
      spec.sqlName,
      realpathSync(input),
      realpathSync(frozenInput),
      realpathSync(fixtureInput),
      realpathSync(hostManifestInput),
    ],
    { cwd: root, env, stdout: 'pipe', stderr: 'pipe', timeout: 240_000 },
  );
  assert.equal(result.exitCode, 0, `${result.stderr.toString()}\n${result.stdout.toString()}`);
  console.log(result.stdout.toString().trim());
  console.log(
    compiled
      ? 'Real compiled WASIX portable + four AOT Cargo/npm carriers preserve exact compiler bytes and installed owner/version contracts: PASS'
      : 'Real SQL-only WASIX portable Cargo/npm/GitHub carriers preserve exact installed owner/version contracts: PASS',
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
