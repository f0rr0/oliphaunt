/** Physical proof of exact current WASIX resource and extension ABI inputs. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { WASIX_PORTABLE_RELEASE_MEMBERS } from '../../src/wasix/runtime/tools/wasix-runtime-npm-contract.mts';
import { wasixRuntimeNpmPayloadInputs } from '../../src/wasix/runtime/tools/wasix-runtime-npm-payload.mts';
import {
  readPortableArchiveEntries,
  readPortableTarZstdBufferEntries,
} from '../packaging/portable-archive.mts';
import {
  assertAuthenticatedNativeBuildOrigin,
  validateReviewedNativeProducerAssurance,
} from './authenticate-native-build-evidence.mts';
import type { ReleaseMetadata } from './bazel-release-metadata.mts';
import {
  canonicalShippingLabel,
  validateNativeShippingSuppliers,
} from './bazel-shipping-inputs.mts';
import { fileIdentity } from './native-file-identity.mts';
import type { prepareNativeReleaseDelivery } from './native-release-preparation.mts';

type Preparation = Pick<
  Awaited<ReturnType<typeof prepareNativeReleaseDelivery>>,
  'observation' | 'origins' | 'suppliers' | 'baselines'
>;
type Association = Readonly<{ product: string; sourceProduct: string }>;
type Inspection = {
  metadata: ReleaseMetadata;
  observation: Preparation['observation'];
  suppliers: Preparation['suppliers']['suppliers'];
  readOutput: (file: any) => Buffer;
  inputIdentity: (supplier: any, file: any) => { size: number; sha256: string };
  readDeclaredRuntime?: (product: string, version: string) => Buffer;
  readDeclaredCargo?: (supplier: any) => string;
};

/** Physical construction projection only. The controller below authenticates the producer inputs. */
export function inspectNativeCurrentExactInputs(input: Inspection): readonly Association[] {
  return Object.freeze([
    ...inspectCurrentResourceInputs(input),
    ...inspectCurrentWasixExtensionInputs(input),
  ]);
}

function inspectCurrentResourceInputs({
  metadata,
  observation,
  suppliers,
  readOutput,
  inputIdentity,
}: Inspection): readonly Association[] {
  const declaration = metadata.databaseResourceWasixConsumer;
  assert.ok(declaration, 'WASIX admitted consumer declaration is missing');
  if (declaration.source === 'completed') return Object.freeze([]);
  assert.equal(declaration.source, 'current');
  const producer = 'liboliphaunt-wasix';
  const consumer = 'database-resources';
  assert.equal(
    declaration.version,
    metadata.products[producer].version,
    'current WASIX admitted version differs from source',
  );
  const product = observation.products.find(({ product }) => product.id === producer);
  const resources = observation.products.find(({ product }) => product.id === consumer);
  assert.ok(product && resources, 'current WASIX exact contract owners are missing');
  assert.equal(product.product.version, metadata.products[producer].version);
  assert.equal(resources.product.version, metadata.products[consumer].version);
  const archives = product.productArtifacts.filter(
    (row) =>
      row.kind === 'wasix-runtime' &&
      row.target === 'portable' &&
      row.role === 'github-release-asset',
  );
  assert.equal(
    archives.length,
    1,
    'current WASIX contract needs one actual portable public archive',
  );
  assert.equal(archives[0].qualifiedFiles.length, 1);
  const coreFile = archives[0].qualifiedFiles[0];
  const coreBytes = readOutput(coreFile);
  const core = readPortableTarZstdBufferEntries(coreBytes);
  const manifest = core.get(WASIX_PORTABLE_RELEASE_MEMBERS.manifest);
  const runtime = core.get(WASIX_PORTABLE_RELEASE_MEMBERS.runtimeArchive);
  assert.ok(manifest?.isFile && runtime?.isFile, 'current WASIX portable archive is incomplete');
  const coreManifest = JSON.parse(manifest.data().toString('utf8'));
  wasixRuntimeNpmPayloadInputs({
    manifestBytes: manifest.data(),
    runtimeBytes: runtime.data(),
    label: 'qualified current resource consumer',
  });
  assert.ok(metadata.databaseResourceContract, 'WASIX resource contract is missing');
  const profiles = Object.keys(metadata.databaseResourceContract.profiles as object);
  const declarations = metadata.databaseResourceArtifacts.filter(
    (row) =>
      row.kind === 'wasix-seeds' &&
      row.target === 'portable' &&
      String(row.asset).endsWith('.json'),
  );
  assert.equal(
    declarations.length,
    profiles.length,
    'WASIX exact contract profile inventory differs',
  );
  for (const expected of declarations) {
    const descriptors = resources.productArtifacts.filter(
      (row) =>
        row.id ===
        `github-release:${String(expected.asset).replace('{version}', resources.product.version)}`,
    );
    assert.equal(
      descriptors.length,
      1,
      'WASIX exact contract lacks a qualified profile descriptor',
    );
    assert.equal(descriptors[0].qualifiedFiles.length, 1);
    const descriptorFile = descriptors[0].qualifiedFiles[0];
    const descriptor = JSON.parse(readOutput(descriptorFile).toString('utf8'));
    assert.equal(descriptor.runtime.engineFamily, 'wasix');
    assert.equal(
      descriptor.runtime.version,
      declaration.version,
      'WASIX exact descriptor does not admit the current source version',
    );
    assert.equal(
      descriptor.runtime.consumerSha256,
      coreManifest.runtime['module-sha256'],
      'WASIX descriptor admits another module',
    );
    assert.equal(descriptor.runtime.target, 'portable');
    assert.ok(profiles.includes(descriptor.catalogProfile));
    assert.ok(
      String(expected.asset).includes(`-${descriptor.catalogProfile}.json`),
      'WASIX profile descriptor is relabelled',
    );
    const supplied = suppliers.filter(
      (row) =>
        row.consumer === consumer &&
        row.product === producer &&
        canonicalShippingLabel(row.root) === canonicalShippingLabel(descriptorFile.label),
    );
    assert.equal(
      supplied.length,
      1,
      'WASIX exact descriptor lacks its own actual supplier binding',
    );
    const supplier = supplied[0];
    assert.equal(supplier.binding, 'abi-contract');
    assert.equal(
      supplier.origin.kind,
      'current-source',
      'WASIX exact adoption cannot relabel a held supplier',
    );
    assert.equal(supplier.version, declaration.version);
    assert.equal(supplier.configuration, 'portable');
    assert.equal(
      supplier.files.length,
      1,
      'WASIX exact consumer needs the entire actual portable archive File',
    );
    assert.equal(supplier.files[0].member, undefined);
    assert.deepEqual(
      inputIdentity(supplier, supplier.files[0]),
      { size: coreFile.size, sha256: coreFile.sha256 },
      'WASIX exact consumer File differs from the actual producer archive',
    );
  }
  return Object.freeze([Object.freeze({ product: consumer, sourceProduct: producer })]);
}

function inspectCurrentWasixExtensionInputs({
  metadata,
  observation,
  suppliers,
  readOutput,
  inputIdentity,
  readDeclaredRuntime,
  readDeclaredCargo,
}: Inspection): readonly Association[] {
  const producer = 'liboliphaunt-wasix';
  const roots = (observation.authenticated ?? []).flatMap(({ evidence }) =>
    evidence.cohorts.flatMap((cohort) => cohort.roots.map((root) => ({ cohort, root }))),
  );
  const consumers = new Set(
    roots
      .filter(({ root }) => root.package.role === 'extension-release-link-input')
      .map(({ root }) => root.package.product),
  );
  const internal = roots.filter(
    ({ root }) =>
      root.package.role === 'extension-release-link-input' ||
      (root.package.role === 'extension-release-frozen-input' &&
        root.package.configuration === 'wasix-portable' &&
        consumers.has(root.package.product)),
  );
  const seen = new Set<string>();
  for (const { root } of internal) {
    const key = `${root.package.product}/${root.package.role}`;
    assert.ok(!seen.has(key), 'WASIX exact extension has duplicate internal roots');
    seen.add(key);
  }
  const identity = (bytes: Buffer) => ({
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });
  const digest = (value: unknown) => {
    assert.ok(
      typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value),
      'WASIX exact digest is invalid',
    );
    return value;
  };
  const strings = (value: unknown, label: string) => {
    assert.ok(
      Array.isArray(value) && value.every((name) => typeof name === 'string' && name.length),
      label,
    );
    assert.deepEqual(value, [...new Set(value)].sort(), `${label} must be sorted and unique`);
    return value as string[];
  };
  const document = ({ cohort, root }: (typeof roots)[number]) => {
    assert.equal(root.package.outputs.length, 1, 'WASIX exact internal root needs one output');
    const output = root.package.outputs[0];
    const captures = cohort.outputs.filter((row) => row.path === output.path);
    assert.equal(captures.length, 1, 'WASIX exact internal output is not captured');
    assert.equal(captures[0].members.length, 1, 'WASIX exact internal output is not one File');
    const member = captures[0].members[0];
    assert.equal(member.type, 'file');
    assert.equal(member.path, '');
    const file = { label: root.label, path: output.path, size: member.size, sha256: member.sha256 };
    const bytes = readOutput(file);
    assert.deepEqual(
      identity(bytes),
      { size: file.size, sha256: file.sha256 },
      'WASIX exact original document changed',
    );
    return JSON.parse(bytes.toString('utf8'));
  };
  const portable = (bytes: Buffer, label: string) => {
    const entries = readPortableTarZstdBufferEntries(bytes);
    const manifest = entries.get(WASIX_PORTABLE_RELEASE_MEMBERS.manifest);
    const runtime = entries.get(WASIX_PORTABLE_RELEASE_MEMBERS.runtimeArchive);
    assert.ok(
      manifest?.isFile && !manifest.isSymbolicLink && runtime?.isFile && !runtime.isSymbolicLink,
      `${label} portable archive is incomplete`,
    );
    const inputs = wasixRuntimeNpmPayloadInputs({
      manifestBytes: manifest.data(),
      runtimeBytes: runtime.data(),
      label,
    });
    return { inputs, manifest: JSON.parse(manifest.data().toString('utf8')) };
  };
  // Mirror the original analyzer: receipt selection alone never proves ABI adoption.
  const resolve = (item: any, exports: any[]) => {
    assert.ok(
      typeof item.name === 'string' && item.name.length && typeof item.kind === 'string',
      'WASIX exact import is invalid',
    );
    let candidates = exports.filter((row) => row.name === item.name);
    if (!candidates.length)
      candidates = exports.filter(
        (row) => row.name.replace(/^_+/u, '') === item.name.replace(/^_+/u, ''),
      );
    if (!candidates.length) return undefined;
    const kind =
      item.module === 'GOT.func' ? 'func' : item.module === 'GOT.mem' ? 'global' : item.kind;
    const found = candidates.find((row) => row.kind === kind);
    assert.ok(found, 'WASIX exact import has an incompatible export kind');
    return found.name as string;
  };
  const associations: Association[] = [];
  for (const entry of internal.filter(
    ({ root }) => root.package.role === 'extension-release-link-input',
  )) {
    const pkg = entry.root.package;
    const declared = metadata.extensionReleaseMetadata.filter(
      (row) => row.class === 'external' && row.product === pkg.product,
    );
    assert.equal(declared.length, 1, 'WASIX exact link names an unknown external product');
    const extension = declared[0];
    assert.equal(pkg.ecosystem, 'internal');
    assert.equal(pkg.configuration, 'wasix-portable');
    assert.equal(
      pkg.version,
      metadata.products[pkg.product]?.version,
      'WASIX exact extension version differs',
    );
    const receipt = document(entry);
    assert.equal(receipt.schema, 'oliphaunt-declared-wasix-extension-link-v1');
    assert.equal(receipt.sqlName, extension.sqlName, 'WASIX exact link names another SQL member');
    const selection = receipt.runtimeSelection;
    if (selection === undefined) continue;
    assert.ok(
      ['completed-publication', 'current-source'].includes(selection.kind),
      'WASIX exact selection kind is invalid',
    );
    if (selection.kind === 'completed-publication') continue;
    const missing = strings(selection.missingExports, 'WASIX exact missing exports');
    assert.ok(missing.length, 'WASIX exact adoption needs a positive missing-export proof');
    assert.ok(
      readDeclaredRuntime,
      'WASIX exact adoption needs its completed public runtime reader',
    );
    const compatibility = extension.compatibility as Record<string, string>;
    assert.equal(compatibility.wasixRuntimeProduct, producer);
    const version = compatibility.wasixRuntimeVersion;
    assert.equal(
      version,
      metadata.products[producer].version,
      'WASIX exact adoption cannot replace an older runtime floor',
    );
    const held = portable(
      readDeclaredRuntime(producer, version),
      'completed WASIX extension runtime',
    );
    const products = observation.products.filter(({ product }) => product.id === producer);
    assert.equal(products.length, 1, 'WASIX exact runtime owner is missing or repeated');
    assert.equal(products[0].product.version, version);
    const archives = products[0].productArtifacts.filter(
      (row) =>
        row.kind === 'wasix-runtime' &&
        row.target === 'portable' &&
        row.role === 'github-release-asset',
    );
    assert.equal(
      archives.length,
      1,
      'WASIX exact extension needs one current public runtime archive',
    );
    assert.equal(archives[0].qualifiedFiles.length, 1);
    const coreFile = archives[0].qualifiedFiles[0];
    const original = roots.filter(
      ({ root }) =>
        canonicalShippingLabel(root.label) === canonicalShippingLabel(coreFile.label) &&
        root.package.product === producer &&
        root.package.role === 'github-release-asset' &&
        root.package.outputs.some((output) => output.path === coreFile.path),
    );
    assert.equal(original.length, 1, 'WASIX exact candidate lacks its original public root');
    assert.equal(original[0].root.package.version, version);
    assert.equal(original[0].root.package.ecosystem, 'github');
    assert.equal(original[0].root.package.configuration, 'portable');
    assert.equal(original[0].root.package.outputs.length, 1);
    assert.equal(
      canonicalShippingLabel(original[0].root.package.outputs[0].owner),
      '//src/wasix/runtime:release_archive_portable',
      'WASIX exact candidate is not the original portable producer File',
    );
    const bytes = readOutput(coreFile);
    assert.deepEqual(
      identity(bytes),
      { size: coreFile.size, sha256: coreFile.sha256 },
      'WASIX exact current archive changed',
    );
    const current = portable(bytes, 'current WASIX extension runtime');
    assert.equal(
      digest(selection.declaredModuleSha256),
      held.manifest.runtime['module-sha256'],
      'WASIX exact declared module differs from completed archive',
    );
    assert.equal(
      digest(selection.currentModuleSha256),
      current.manifest.runtime['module-sha256'],
      'WASIX exact current module differs from original archive',
    );
    assert.equal(
      digest(selection.selectedModuleSha256),
      selection.currentModuleSha256,
      'WASIX exact selected module is not current',
    );
    assert.equal(receipt.sourceFingerprint, current.manifest['source-fingerprint']);
    assert.equal(receipt.postgresVersion, current.manifest.runtime['postgres-version']);
    const supplied = suppliers.filter(
      (row) =>
        row.consumer === pkg.product &&
        row.product === producer &&
        canonicalShippingLabel(row.root) === canonicalShippingLabel(entry.root.label),
    );
    const heldSuppliers = supplied.filter((row) => row.origin.kind === 'completed-publication');
    const currentSuppliers = supplied.filter((row) => row.origin.kind === 'current-source');
    assert.equal(heldSuppliers.length, 1, 'WASIX exact link needs one held runtime supplier');
    assert.equal(currentSuppliers.length, 1, 'WASIX exact link needs one current runtime supplier');
    const historical = heldSuppliers[0];
    assert.ok(historical.origin.kind === 'completed-publication');
    assert.equal(historical.binding, 'abi-contract');
    assert.equal(historical.version, version);
    const cargoDeclarations = metadata.publicationCarriers.filter(
      (row) =>
        row.product === producer &&
        row.ecosystem === 'cargo' &&
        row.name === 'liboliphaunt-wasix-portable',
    );
    assert.equal(
      cargoDeclarations.length,
      1,
      'WASIX exact held runtime has no canonical Cargo carrier',
    );
    assert.equal(historical.configuration, cargoDeclarations[0].target ?? 'portable');
    assert.equal(historical.origin.publication.product, producer);
    assert.equal(historical.origin.publication.version, version);
    assert.equal(historical.origin.artifact, 'cargo:liboliphaunt-wasix-portable');
    assert.equal(
      historical.files.length,
      1,
      'WASIX exact held runtime needs its original Cargo archive',
    );
    assert.equal(historical.files[0].member, undefined);
    assert.ok(readDeclaredCargo, 'WASIX exact adoption needs its completed Cargo reader');
    const cargoPath = readDeclaredCargo(historical);
    const cargoIdentity = identity(readFileSync(cargoPath));
    assert.deepEqual(
      inputIdentity(historical, historical.files[0]),
      cargoIdentity,
      'WASIX exact held supplier differs from completed Cargo archive',
    );
    const cargo = readPortableArchiveEntries(cargoPath, { format: 'tar.gz' });
    assert.deepEqual(
      identity(readFileSync(cargoPath)),
      cargoIdentity,
      'WASIX exact completed Cargo archive changed',
    );
    const prefix = `liboliphaunt-wasix-portable-${version}`;
    assert.ok(
      [...cargo.keys()].every((name) => name === prefix || name.startsWith(`${prefix}/`)),
      'WASIX exact completed Cargo prefix differs',
    );
    const cargoManifest = cargo.get(`${prefix}/Cargo.toml`);
    assert.ok(
      cargoManifest?.isFile && !cargoManifest.isSymbolicLink,
      'WASIX exact completed Cargo manifest is missing',
    );
    const cargoPackage = Bun.TOML.parse(cargoManifest.data().toString('utf8')).package;
    assert.equal(cargoPackage?.name, 'liboliphaunt-wasix-portable');
    assert.equal(cargoPackage?.version, version);
    for (const [member, expected] of [
      ['payload/manifest.json', held.inputs.manifest],
      ['payload/oliphaunt.wasix.tar.zst', held.inputs.runtimeArchive],
    ] as const) {
      const file = cargo.get(`${prefix}/${member}`);
      assert.ok(
        file?.isFile && !file.isSymbolicLink,
        'WASIX exact completed Cargo payload is missing',
      );
      assert.deepEqual(
        identity(file.data()),
        { size: expected.size, sha256: expected.sha256 },
        'WASIX exact held Cargo payload differs from completed public archive',
      );
    }
    const candidate = currentSuppliers[0];
    assert.equal(candidate.binding, 'abi-contract');
    assert.equal(candidate.version, version);
    assert.equal(candidate.configuration, 'wasix-portable');
    assert.equal(candidate.files.length, 1);
    assert.equal(candidate.files[0].member, undefined);
    assert.equal(
      candidate.files[0].path,
      coreFile.path,
      'WASIX exact candidate is not the original public archive',
    );
    assert.deepEqual(
      inputIdentity(candidate, candidate.files[0]),
      { size: coreFile.size, sha256: coreFile.sha256 },
      'WASIX exact current supplier differs from original public archive',
    );
    const frozenRoots = internal.filter(
      ({ root }) =>
        root.package.product === pkg.product &&
        root.package.role === 'extension-release-frozen-input',
    );
    assert.equal(frozenRoots.length, 1, 'WASIX exact link needs one original frozen member');
    const frozenRoot = frozenRoots[0];
    assert.equal(
      frozenRoot.cohort,
      entry.cohort,
      'WASIX exact frozen member comes from another producer',
    );
    assert.equal(frozenRoot.root.package.version, pkg.version);
    assert.equal(frozenRoot.root.package.configuration, pkg.configuration);
    const frozen = document(frozenRoot);
    assert.equal(frozenRoot.root.package.ecosystem, 'internal');
    assert.equal(
      canonicalShippingLabel(frozenRoot.root.package.outputs[0].owner),
      canonicalShippingLabel(pkg.outputs[0].owner),
      'WASIX exact link and frozen member have different constructors',
    );
    assert.equal(frozen.product, pkg.product);
    assert.equal(frozen.version, pkg.version);
    assert.equal(frozen.sqlName, receipt.sqlName);
    assert.equal(frozen.compatibility.wasixRuntimeVersion, version);
    assert.deepEqual(
      frozen.wasixInstall.nativeModules,
      receipt.nativeModules,
      'WASIX exact compiled modules differ from frozen member',
    );
    assert.deepEqual(
      frozen.wasixInstall.coreExportsRequired,
      receipt.coreExportsRequired,
      'WASIX exact core requirements differ from frozen member',
    );
    assert.deepEqual(receipt.unresolvedImports, []);
    assert.deepEqual(frozen.wasixInstall.unresolvedImports, []);
    assert.ok(
      Array.isArray(receipt.nativeModules) && receipt.nativeModules.length,
      'WASIX exact adoption needs compiled modules',
    );
    const names = receipt.nativeModules.map((module) => module.name);
    assert.deepEqual(
      names,
      [...new Set(names)].sort(),
      'WASIX exact compiled modules repeat or are unsorted',
    );
    assert.ok(names.includes(receipt.sqlName));
    assert.deepEqual(Object.keys(receipt.moduleLinkMetadata).sort(), names);
    const byBasename = new Map<string, string>();
    for (const module of receipt.nativeModules) {
      assert.equal(digest(module.sha256), digest(module.moduleSha256));
      assert.ok(Number.isSafeInteger(module.size) && module.size > 0);
      assert.ok(
        typeof module.path === 'string' &&
          module.path.startsWith('lib/postgresql/') &&
          !module.path.split('/').some((part) => !part || part === '.' || part === '..'),
      );
      const basename = path.posix.basename(module.path);
      assert.ok(!byBasename.has(basename), 'WASIX exact compiled module basenames repeat');
      byBasename.set(basename, module.name);
    }
    const unresolved: string[] = [];
    const required = new Set<string>();
    for (const module of receipt.nativeModules) {
      const providers: any[] = [];
      const pending = [module.name];
      const visited = new Set<string>();
      while (pending.length) {
        const name = pending.pop()!;
        if (visited.has(name)) continue;
        visited.add(name);
        const link = receipt.moduleLinkMetadata[name];
        assert.ok(link && Array.isArray(link.imports) && Array.isArray(link.exports));
        providers.push(...link.exports);
        assert.ok(Array.isArray(link['dylink-needed']));
        for (const needed of link['dylink-needed']) {
          const dependency = byBasename.get(needed);
          assert.ok(dependency, 'WASIX exact side-module dependency is missing');
          pending.push(dependency);
        }
      }
      for (const item of receipt.moduleLinkMetadata[module.name].imports) {
        if (!['env', 'GOT.func', 'GOT.mem'].includes(item.module)) continue;
        if (
          (item.module === 'env' &&
            [
              '__c_longjmp',
              '__cpp_exception',
              '__indirect_function_table',
              '__memory_base',
              '__stack_pointer',
              '__table_base',
              'memory',
            ].includes(item.name)) ||
          (item.module === 'GOT.mem' &&
            ['__heap_base', '__stack_high', '__stack_low'].includes(item.name))
        )
          continue;
        if (resolve(item, providers)) continue;
        if (!resolve(item, held.manifest.runtime.link.exports)) unresolved.push(item.name);
        const resolved = resolve(item, current.manifest.runtime.link.exports);
        assert.ok(resolved, 'WASIX exact selected runtime still lacks a required export');
        required.add(resolved);
      }
    }
    assert.deepEqual(
      missing,
      [...new Set(unresolved)].sort(),
      'WASIX exact missing-export proof differs from actual imports',
    );
    assert.deepEqual(
      strings(receipt.coreExportsRequired, 'WASIX exact core exports'),
      [...required].sort(),
      'WASIX exact selected core requirements differ from actual imports',
    );
    associations.push(Object.freeze({ product: pkg.product, sourceProduct: producer }));
  }
  return Object.freeze(associations);
}

/** Only the actual retained reviewed producer capabilities can feed the RP controller. */
export function deriveQualifiedNativeCurrentExactInputs(
  preparation: Preparation,
  metadata: ReleaseMetadata,
): readonly Association[] {
  assert.ok(
    preparation.suppliers.buildBound && !preparation.suppliers.unknowns.length,
    'current exact contracts require complete physical supplier coverage',
  );
  const observed = preparation.observation.authenticated;
  assert.ok(observed.length, 'current exact contracts need producing evidence');
  const source = observed[0].evidence.source;
  for (const origin of preparation.origins.values()) {
    assertAuthenticatedNativeBuildOrigin(origin);
    const matches = observed.filter((build) => build.origin === origin);
    assert.equal(
      matches.length,
      1,
      'current exact contracts need the same acquired observed producer',
    );
    const build = matches[0];
    assert.deepEqual(build.evidence.source, source, 'current exact producer source differs');
    assert.deepEqual(
      build.qualification.source,
      source,
      'current exact qualification source differs',
    );
    assert.deepEqual(build.evidence, origin.evidence, 'current exact producer evidence changed');
    assert.ok(
      build.producerAssurance && origin.finalFiles,
      'current exact contract needs original reviewed qualification and retained Files',
    );
    validateReviewedNativeProducerAssurance(build.producerAssurance, {
      source: build.evidence.source,
      github: origin.github,
      artifact: origin.artifact,
      evidenceDigest: origin.evidenceDigest,
      requiredTests: build.qualification.requiredTests,
    });
    assert.equal(build.qualification.qualificationPolicy, 'bound');
  }
  assert.equal(
    observed.length,
    preparation.origins.size,
    'current exact contract imported an unacquired producer',
  );
  const locate = (file: any) => {
    const roots = [...preparation.origins].flatMap(([directory, origin]) =>
      origin.evidence.cohorts.flatMap((cohort, index) =>
        cohort.roots
          .filter(
            (root) =>
              canonicalShippingLabel(root.label) === canonicalShippingLabel(file.label) &&
              root.package.outputs.some(
                ({ path }) => file.path === path || file.path.startsWith(`${path}/`),
              ),
          )
          .map(() => ({ directory, origin, cohort, index })),
      ),
    );
    assert.equal(roots.length, 1, 'current exact File needs one original configured root');
    const { directory, origin, index } = roots[0];
    assert.ok(origin.finalFiles, 'current exact File has no retained transport');
    const captured = origin.finalFiles.files.filter(
      (row) => row.cohort === index && row.path === file.path,
    );
    assert.equal(captured.length, 1, 'current exact File is absent from retained transport');
    const expected = { size: file.size, sha256: file.sha256 };
    assert.deepEqual({ size: captured[0].size, sha256: captured[0].sha256 }, expected);
    const absolute = path.join(directory, 'files', String(index), file.path);
    const actual = fileIdentity(absolute);
    assert.deepEqual(
      { size: actual.size, sha256: actual.sha256 },
      expected,
      'current exact original output changed',
    );
    return absolute;
  };
  const associations = inspectNativeCurrentExactInputs({
    metadata,
    observation: preparation.observation,
    suppliers: preparation.suppliers.suppliers,
    readOutput: (file) => readFileSync(locate(file)),
    inputIdentity: (supplier, file) => {
      const cohorts = observed
        .flatMap(({ evidence }) => evidence.cohorts)
        .filter((cohort) =>
          cohort.rootConfigurations.some(
            ({ label, configuration }) =>
              canonicalShippingLabel(label) === supplier.root &&
              configuration === supplier.rootConfiguration,
          ),
        );
      assert.equal(cohorts.length, 1, 'current exact supplier has ambiguous configured provenance');
      const roots = cohorts[0].roots.filter(
        (root) => canonicalShippingLabel(root.label) === supplier.root,
      );
      assert.equal(roots.length, 1, 'current exact supplier needs its original ShippingInfo root');
      const { product, version, configuration, binding, origin, files } = supplier;
      const declaration = { product, version, configuration, binding, origin, files };
      const supplied = validateNativeShippingSuppliers(roots[0].package.supplierInputs);
      assert.equal(
        supplied.filter((row) => isDeepStrictEqual(row, declaration)).length,
        1,
        'current exact supplier differs from original captured ShippingInfo',
      );
      const captures = cohorts[0].inputs.filter((input) => input.path === file.path);
      assert.equal(captures.length, 1, 'current exact supplier File is not captured');
      assert.equal(captures[0].members.length, 1);
      const member = captures[0].members[0];
      assert.equal(member.path, '');
      assert.equal(member.type, 'file');
      return { size: member.size, sha256: member.sha256 };
    },
    readDeclaredRuntime: (product, version) => {
      const baselines = preparation.baselines.filter(
        (row) => row.publication.product === product && row.publication.version === version,
      );
      assert.equal(
        baselines.length,
        1,
        'WASIX exact declared runtime needs one completed baseline',
      );
      const rows = metadata.wasixArtifacts.filter(
        (row) =>
          row.product === product && row.kind === 'wasix-runtime' && row.target === 'portable',
      );
      assert.equal(rows.length, 1, 'WASIX exact declared runtime needs one portable public row');
      const artifact = `github-release:${String(rows[0].asset).replace('{version}', version)}`;
      const file = baselines[0].productArtifacts?.[artifact];
      assert.ok(file, 'WASIX exact declared runtime public archive is missing');
      return readFileSync(file);
    },
    readDeclaredCargo: (supplier) => {
      assert.ok(supplier.origin.kind === 'completed-publication');
      const baselines = preparation.baselines.filter(
        (row) =>
          row.publication.product === supplier.product &&
          row.publication.version === supplier.version,
      );
      assert.equal(baselines.length, 1, 'WASIX exact held Cargo needs one completed baseline');
      assert.deepEqual(
        baselines[0].publication,
        supplier.origin.publication,
        'WASIX exact held Cargo publication differs',
      );
      const files = baselines[0].carriers[supplier.origin.artifact];
      assert.equal(
        files?.length,
        1,
        'WASIX exact held Cargo original archive is missing or repeated',
      );
      return files[0];
    },
  });
  for (const origin of preparation.origins.values()) origin.finalFiles?.assertUnchanged?.();
  return associations;
}
