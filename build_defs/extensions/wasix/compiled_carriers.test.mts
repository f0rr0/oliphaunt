import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assertWasixExtensionArchiveInstall,
  WASIX_EXTENSION_INSTALL_SIDECAR_SCHEMA,
} from '../../../src/extensions/contracts/wasix-extension-install.mts';
import {
  assertSingleWasixNapiAddonMember,
  assertWasixNapiCarrierManifest,
  assertWasixNapiConstructionData,
  assertWasixTypescriptNativeCarrier,
} from '../../../src/wasix/node-addon/tools/carrier-contract.mts';
import { assertWasixAotArtifactPayloads } from '../../../src/wasix/runtime/tools/check-release-assets.mts';
import { assertCanonicalWasixAotManifest } from '../../../src/wasix/runtime/tools/wasix-aot-manifest.mts';
import { AOT_TARGET_TRIPLES } from '../../../src/wasix/runtime/tools/wasix-cargo-artifact-contract.mts';
import {
  extractPortableArchiveTree,
  readPortableArchiveEntries,
} from '../../../tools/packaging/portable-archive.mts';
import { readWasixCargoCarrierPayload, readWasixCargoCarrierSet } from '../wasix_carriers.mts';

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
  currentAddonInput,
  addonInputs,
  currentAddonInputs,
  contribPortableInput,
] = process.argv.slice(2);
const napiContract = JSON.parse(readFileSync(napiInput, 'utf8'));
const addonTemplate = JSON.parse(readFileSync(addonTemplateInput, 'utf8'));
const hostManifestBytes = readFileSync(hostManifestInput);
const hostManifest = JSON.parse(hostManifestBytes.toString());
const githubRoot = path.dirname(githubInput);
const npmRoot = path.dirname(npmInput);
const cargoRoot = path.dirname(cargoInput);
const spec = JSON.parse(readFileSync(input, 'utf8'));
const partInputs = process.argv.slice(22);
const partParents = Object.keys(spec.outputs.cargoParts ?? {});
assert.equal(process.argv.length, 22 + partParents.length);
if (partParents.length)
  assert.deepEqual(
    partParents.sort(),
    spec.carriers
      .filter((row: { ecosystem: string }) => row.ecosystem === 'cargo')
      .map((row: { name: string }) => row.name)
      .sort(),
  );
assert.deepEqual(partInputs.map((file) => path.basename(file)).sort(), partParents.sort());
const frozen = JSON.parse(readFileSync(frozenInput, 'utf8'));
const compiled = moduleInput !== '-';
const linkContract = compiled ? JSON.parse(readFileSync(linkInput, 'utf8')) : null;
const selection = linkContract?.runtimeSelection;
if (selection) {
  assert(['completed-publication', 'current-source'].includes(selection.kind));
  for (const key of ['declaredModuleSha256', 'currentModuleSha256', 'selectedModuleSha256'])
    assert.match(selection[key], /^[a-f0-9]{64}$/u);
  assert.deepEqual(selection.missingExports, [...new Set(selection.missingExports)].sort());
  assert(
    selection.missingExports.every((name: unknown) => typeof name === 'string' && name.length > 0),
  );
  assert.equal(selection.kind === 'current-source', selection.missingExports.length > 0);
  assert.equal(
    selection.selectedModuleSha256,
    selection.kind === 'current-source'
      ? selection.currentModuleSha256
      : selection.declaredModuleSha256,
  );
  assert.equal(selection.selectedModuleSha256, hostManifest.runtime['module-sha256']);
}
const current = selection?.kind === 'current-source';
if (current)
  assert.notEqual(
    currentAddonInput,
    '-',
    'selected current core requires its actual source addon carrier',
  );
const napi = current
  ? {
      ...napiContract,
      current: true,
      version: napiContract.currentVersion,
      constructionContract: napiContract.currentConstructionContract,
    }
  : napiContract;
const selectedFacadeInput = current ? '-' : facadeInput;
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
    assert.equal(linkContract.sourceFingerprint, hostManifest['source-fingerprint']);
    assert.equal(linkContract.postgresVersion, hostManifest.runtime['postgres-version']);
    const link = linkContract.moduleLinkMetadata[spec.sqlName];
    const exports = new Set(link.exports.map((row: { name: string }) => row.name));
    const modules = new Map<string, string>(
      linkContract.nativeModules.map((module: { name: string; path: string }) => [
        module.path,
        module.name,
      ]),
    );
    const callable = new Map<string, Set<string>>([[spec.sqlName, new Set()]]);
    for (const [sql, entry] of portable) {
      if (!sql.endsWith('.sql')) continue;
      const sqlName = path.posix.basename(sql).split('--')[0];
      const control = portable.get(`share/postgresql/extension/${sqlName}.control`);
      const modulePathname = control
        ?.data()
        .toString()
        .match(/^\s*module_pathname\s*=\s*'([^']+)'/imu)?.[1];
      for (const match of entry
        .data()
        .toString()
        .matchAll(/\bAS\s+'([^']+)'\s*,\s*'([^']+)'/giu)) {
        let library = match[1];
        if (library.toUpperCase() === 'MODULE_PATHNAME') {
          assert(
            modulePathname || !sql.includes('--') || sqlName === spec.sqlName,
            `${sql} has no control module_pathname`,
          );
          library = modulePathname ?? `$libdir/${spec.descriptor['native-module-file']}`;
        }
        assert(library.startsWith('$libdir/'), `${sql} references unknown module ${library}`);
        const modulePath = `lib/postgresql/${library.slice('$libdir/'.length)}${library.endsWith('.so') ? '' : '.so'}`;
        const moduleName = modules.get(modulePath);
        assert(moduleName, `${sql} references undeclared module ${library}`);
        const functions = callable.get(moduleName) ?? new Set<string>();
        functions.add(match[2]);
        callable.set(moduleName, functions);
      }
    }
    for (const [module, functions] of callable) {
      const moduleExports =
        module === spec.sqlName
          ? exports
          : new Set(
              linkContract.moduleLinkMetadata[module].exports.map(
                (row: { name: string }) => row.name,
              ),
            );
      for (const name of ['Pg_magic_func', ...functions])
        assert(moduleExports.has(name), `compiled module ${module} lost PostgreSQL export ${name}`);
      for (const name of functions)
        assert(
          moduleExports.has(`pg_finfo_${name}`),
          `compiled module ${module} lost function metadata ${name}`,
        );
      if (spec.sqlName === 'postgis' && module !== spec.sqlName)
        assert(
          moduleExports.has('_PG_init'),
          `compiled module ${module} lost its PostgreSQL initializer`,
        );
    }
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
  const crates = readdirSync(cargoRoot)
    .filter((name) => name.endsWith('.crate'))
    .map((name) => realpathSync(path.join(cargoRoot, name)));
  const cargo = readWasixCargoCarrierSet(spec.carriers, [...crates, ...partInputs]);
  assert.equal(cargo.filter((row) => row.declared).length, installed.size);
  for (const carrier of cargo.filter((row) => row.declared)) {
    const files = readWasixCargoCarrierPayload(cargo, carrier);
    if (carrier.name.endsWith('-wasix')) {
      assert.deepEqual([...files.keys()], [`extensions/${spec.sqlName}/extension.tar.zst`]);
      assert.deepEqual(files.get(`extensions/${spec.sqlName}/extension.tar.zst`), archive);
    } else {
      const aot = JSON.parse(
        carrier.entries.get(`${carrier.prefix}/manifests/${spec.sqlName}.json`)!.data().toString(),
      );
      assert.deepEqual(
        [...files.keys()].sort(),
        aot.artifacts
          .map((row: { path: string }) => `extensions/${spec.sqlName}/${row.path}`)
          .sort(),
      );
      assertMemberAot(
        aot,
        carrier.target,
        (relative) => files.get(`extensions/${spec.sqlName}/${relative}`)!,
      );
    }
  }
  const addonArchive = realpathSync(current ? currentAddonInput : addonInput);
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
    assert.equal(selectedFacadeInput, '-');
    assert.equal(addonTemplate.version, napi.version);
    runtimeContract = { ...addonTemplate.oliphaunt, packageLicense: addonTemplate.license };
  } else {
    const originalBytes = readFileSync(addonArchive);
    assert.equal(digest(originalBytes), napi.original.file.sha256);
    assert.equal(originalBytes.length, napi.original.file.size);
    const facadeBytes = readFileSync(selectedFacadeInput);
    assert.equal(digest(facadeBytes), napi.facade.file.sha256);
    assert.equal(facadeBytes.length, napi.facade.file.size);
    const facadeEntries = readPortableArchiveEntries(realpathSync(selectedFacadeInput));
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
  const heldSource =
    !napi.current && addonProvenance.schema === 'oliphaunt-wasix-napi-construction-data-v3';
  const constructed =
    napi.current ||
    heldSource ||
    addonProvenance.schema === 'oliphaunt-wasix-napi-construction-data-v2';
  if (napi.current || heldSource) {
    // Completed carriers retain their own historical SDK/extension contract;
    // the original archive and facade identities were authenticated above.
    const contract = heldSource
      ? {
          targetTriple: addonProvenance.buildInputs.targetTriple,
          sdkVersion: addonProvenance.buildInputs.sdk.version,
          sqlNames: addonProvenance.buildInputs.inputs.extensionArtifacts.flatMap((row: any) =>
            row.portableArchives.map((member: any) => member.sqlName),
          ),
        }
      : napi.constructionContract;
    assert(contract, 'source addon requires its actual producer construction contract');
    assertWasixNapiConstructionData(
      addonProvenance,
      napi.target.target,
      digest(addonMember('package/prebuilds/oliphaunt_wasix_napi.node')),
      {
        ...contract,
        runtimeVersion: addonManifest.oliphaunt.runtimeVersion,
      },
    );
  } else {
    if (!constructed) assert.equal(addonProvenance.schema, 'oliphaunt-wasix-napi-provenance-v1');
    assert.equal(
      addonProvenance.buildInputs.schema,
      constructed ? 'oliphaunt-wasix-napi-build-inputs-v2' : 'oliphaunt-wasix-napi-build-inputs-v1',
    );
  }
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
  const dependencyFacts: { sqlName: string; sha256: string; size: number; modules: string[] }[] =
    [];
  const dependencyArchives = new Map<string, any>(
    addonProvenance.buildInputs.inputs.extensionArtifacts.flatMap((row: any) => {
      assert.equal(row.product, 'oliphaunt-extension-contrib-pg18');
      return row.portableArchives.map((member: any) => [member.sqlName, member]);
    }),
  );
  const selectedInputs = current ? currentAddonInputs : addonInputs;
  let completedContrib: ReturnType<typeof readPortableArchiveEntries> | undefined;
  if (selectedInputs === '-' && frozen.wasixInstall.dependencies.length > 0) {
    assert.notEqual(contribPortableInput, '-', 'held dependency requires its original carrier');
    const original = napi.contribPortable;
    assert.equal(original.publication.version, addonManifest.oliphaunt.runtimeVersion);
    const bytes = readFileSync(contribPortableInput);
    assert.equal(digest(bytes), original.file.sha256);
    assert.equal(bytes.length, original.file.size);
    completedContrib = readPortableArchiveEntries(realpathSync(contribPortableInput));
  }
  const visitedDependencies = new Set<string>();
  const visitDependency = (sqlName: string) => {
    if (sqlName === 'plpgsql' || sqlName === spec.sqlName || visitedDependencies.has(sqlName))
      return;
    visitedDependencies.add(sqlName);
    const declared = dependencyArchives.get(sqlName);
    assert(declared, `selected addon has no declared dependency ${sqlName}`);
    let bytes: Buffer;
    if (selectedInputs !== '-') bytes = readFileSync(path.join(selectedInputs, declared.path));
    else {
      const member = completedContrib?.get(
        `oliphaunt-extension-contrib-pg18-wasix-${addonManifest.oliphaunt.runtimeVersion}/payload/files/extensions/${sqlName}/extension.tar.zst`,
      );
      assert(member?.isFile && !member.isSymbolicLink, `missing original ${sqlName} archive`);
      bytes = Buffer.from(member.data());
    }
    assert.equal(digest(bytes), declared.sha256, `${sqlName} differs from addon input`);
    // Published v1 provenance carries SHA-256 only; the executing addon also checks size.
    if (declared.size !== undefined)
      assert.equal(bytes.length, declared.size, `${sqlName} size differs from addon input`);
    const archiveFile = path.join(root, `${sqlName}.tar.zst`);
    writeFileSync(archiveFile, bytes);
    const entries = readPortableArchiveEntries(archiveFile);
    for (const [name, entry] of entries) {
      if (!entry.isFile || !name.endsWith('.control')) continue;
      for (const line of entry.data().toString().split('\n')) {
        if (!/^\s*requires\s*=/u.test(line)) continue;
        const value = line.match(/^\s*requires\s*=\s*(?:'([^']*)'|([^#]*?))\s*(?:#.*)?$/u);
        assert(value, `${sqlName} has malformed control requires`);
        for (const dependency of (value[1] ?? value[2]).split(',').map((name) => name.trim()))
          if (dependency) visitDependency(dependency);
      }
    }
    dependencyFacts.push({
      sqlName,
      sha256: declared.sha256,
      size: bytes.length,
      modules: [...entries]
        .filter(([name, entry]) => entry.isFile && name.startsWith('lib/postgresql/'))
        .map(([name]) => name)
        .sort(),
    });
  };
  for (const dependency of frozen.wasixInstall.dependencies) visitDependency(dependency);
  const dependenciesInput = path.join(root, 'selected-dependencies.json');
  writeFileSync(dependenciesInput, JSON.stringify(dependencyFacts));
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
      dependenciesInput,
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
