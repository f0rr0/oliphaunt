/** Source lineage of reached constructor imports; this mints no producer authority. */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  type ExtensionFinalInputFile,
  projectNativeAppleBaseInput,
  projectNativeCurrentArtifacts,
  projectNativeExtensionFinalInputs,
  projectNativeSwiftSourceInput,
} from '../release/native-extension-final-inputs.mts';
import { fileIdentity, safeRelative } from '../release/native-file-identity.mts';
import type { NativeBuildSource } from '../release/native-build-qualification.mts';
import { validateNativeSupplierArtifacts } from '../release/native-supplier-artifacts.mts';

export type NativeImportedRoot = ExtensionFinalInputFile['producer'];

const importedRepositories = [
  'oliphaunt_metadata',
  'postmaster_guest',
  'wasix_runtime_carriers',
  'react_native_native_base',
  'react_native_swift_package',
];
const matchesRepository = (actual: string, expected: string) =>
  actual === expected || actual.endsWith(`+${expected}`);

/** Imported constructors only; unrelated external SDK source leaves have no producer lineage. */
export function isNativeImportSourceLabel(label: string) {
  const match = /^@@?([^/]+)\/\//u.exec(label);
  return !!match && importedRepositories.some((name) => matchesRepository(match[1], name));
}

type NativeImportContext = {
  snapshot: any;
  source: NativeBuildSource;
  executionRoot: string;
  wasixCargoInputs?: string;
};

/** Only current constructor Files reached by the configured consumer can inherit source inputs. */
export function nativeImportProjection({
  labels,
  ...context
}: NativeImportContext & { labels: string[] }): NativeImportedRoot[] {
  return createNativeImportProjection(context)(labels);
}

/** Share immutable original File verification across root slices in one capture. */
export function createNativeImportProjection({
  snapshot,
  source,
  executionRoot,
  wasixCargoInputs,
}: NativeImportContext) {
  assert.deepEqual(snapshot.source, source, 'imported source projection source differs');
  const files = [
    ...projectNativeCurrentArtifacts(snapshot.nativeCurrentArtifacts ?? [], source).files,
    ...projectNativeExtensionFinalInputs(snapshot.extensionFinalInputs ?? []).files,
    ...(snapshot.nativeAppleBase
      ? projectNativeAppleBaseInput(snapshot.nativeAppleBase).files
      : []),
    ...(snapshot.nativeSwiftSource
      ? projectNativeSwiftSourceInput(snapshot.nativeSwiftSource).files
      : []),
  ];
  const originals: ExtensionFinalInputFile[] = [];
  const collect = (value: any) => {
    if (!value || typeof value !== 'object') return;
    if (value.producer && typeof value.path === 'string') originals.push(value);
    else for (const child of Object.values(value)) collect(child);
  };
  collect(snapshot);
  const aliases = new Map(
    files.map((alias) => {
      const candidates = originals.filter(
        (file) =>
          file.path === alias.source && file.size === alias.size && file.sha256 === alias.sha256,
      );
      for (const file of candidates)
        assert.ok(
          isDeepStrictEqual(file, candidates[0]),
          'imported File has conflicting producer facts',
        );
      return [alias.path, candidates[0]] as const;
    }),
  );
  const current = snapshot.nativeCurrentArtifacts ?? [];
  const completed = validateNativeSupplierArtifacts(snapshot.supplierArtifacts ?? []);
  let imported = new Map<string, NativeImportedRoot>();
  const retain = (file: ExtensionFinalInputFile) => {
    assert.ok(file?.producer, 'reached current import has no original producer');
    const { root, configuration, evidenceDigest, invocationId, output } = file.producer;
    const key = JSON.stringify([root, configuration, evidenceDigest, invocationId, output]);
    imported.set(key, structuredClone(file.producer));
  };
  const matchesRepo = matchesRepository;
  const equalFile = (file: ExtensionFinalInputFile, actual: string) => {
    const identity = fileIdentity(realpathSync(actual));
    assert.deepEqual(
      { size: identity.size, sha256: identity.sha256 },
      { size: file.size, sha256: file.sha256 },
      'reached import bytes differ from original producer File',
    );
    retain(file);
  };
  const descriptors = new Map<string, any>();
  const readDescriptor = (directory: string, name: string) => {
    const file = path.join(directory, `${name}.json`);
    if (!descriptors.has(file)) descriptors.set(file, JSON.parse(readFileSync(file, 'utf8')));
    return descriptors.get(file);
  };
  const verifiedDescriptors = new Map<string, ExtensionFinalInputFile[]>();
  const descriptorFile = (row: any, file = row.file) => {
    assert.ok(file && typeof file.path === 'string', 'captured import lacks its original File');
    const key = JSON.stringify([row.publication, row.artifact, file]);
    if (verifiedDescriptors.has(key)) {
      for (const original of verifiedDescriptors.get(key)!) retain(original);
      return;
    }
    const alias = /^@@?([^/]+)\/\/:(.+)$/u.exec(file.path);
    const matchesPath = (original: { path: string }, member: string) =>
      alias
        ? matchesRepo(alias[1], 'oliphaunt_metadata') && alias[2] === member
        : path.isAbsolute(file.path) && realpathSync(file.path) === realpathSync(original.path);
    if (row.publication) {
      const held = completed.filter(
        (candidate) =>
          isDeepStrictEqual(candidate.publication, row.publication) &&
          candidate.artifact === row.artifact &&
          candidate.file.size === file.size &&
          candidate.file.sha256 === file.sha256 &&
          matchesPath(
            candidate.file,
            `supplier-artifacts/${candidate.publication.product}/${candidate.publication.version}/${candidate.file.sha256}/${path.basename(candidate.file.path)}`,
          ),
      );
      assert.equal(held.length, 1, 'captured held import lacks its completed original File');
      const retained = fileIdentity(held[0].file.path);
      assert.deepEqual(
        { size: retained.size, sha256: retained.sha256 },
        { size: file.size, sha256: file.sha256 },
        'captured held import differs from its original File',
      );
      verifiedDescriptors.set(key, []);
      return;
    }
    const candidates = originals.filter(
      (original) =>
        original.size === file.size &&
        original.sha256 === file.sha256 &&
        original.member === file.member &&
        isDeepStrictEqual(original.producer, file.producer) &&
        [...aliases].some(
          ([member, candidate]) => candidate === original && matchesPath(original, member),
        ),
    );
    assert.ok(candidates.length, 'captured current import lacks its original producer File');
    for (const original of candidates) {
      const identity = fileIdentity(original.path);
      assert.deepEqual(
        { size: identity.size, sha256: identity.sha256 },
        { size: file.size, sha256: file.sha256 },
        'captured current import differs from its original producer File',
      );
      retain(original);
    }
    verifiedDescriptors.set(key, candidates);
  };
  let receipt: any;
  const cargoReceipt = () => {
    if (receipt) return receipt;
    assert.ok(wasixCargoInputs, 'reached WASIX import needs its original Cargo receipt');
    receipt = JSON.parse(readFileSync(path.join(wasixCargoInputs, 'receipt.json'), 'utf8'));
    assert.equal(receipt.schema, 'oliphaunt-wasix-cargo-construction-v1');
    assert.deepEqual(receipt.source, source, 'WASIX import receipt source differs');
    assert.ok(Array.isArray(receipt.crates) && receipt.crates.length);
    const rows = [...receipt.crates, ...(receipt.hostSmokeCrates ?? [])];
    assert.equal(
      new Set(rows.map((row) => row.name)).size,
      rows.length,
      'WASIX import receipt repeats a crate',
    );
    for (const row of rows) {
      assert.equal(row.path, `${row.name}-${row.version}.crate`);
      safeRelative(row.path);
      assert.equal(path.posix.basename(row.path), row.path);
      const candidates = current.filter(
        (artifact) => artifact.artifact === `cargo:${row.name}` && artifact.version === row.version,
      );
      assert.equal(candidates.length, 1, 'WASIX receipt lacks one original current Cargo producer');
      assert.deepEqual(
        { size: row.size, sha256: row.sha256 },
        { size: candidates[0].file.size, sha256: candidates[0].file.sha256 },
        'WASIX receipt differs from original current Cargo File',
      );
      const copied = fileIdentity(path.join(wasixCargoInputs, row.path));
      assert.deepEqual(
        { size: copied.size, sha256: copied.sha256 },
        { size: row.size, sha256: row.sha256 },
        'WASIX receipt archive changed',
      );
    }
    return receipt;
  };
  const cargoOriginal = (name: string, version: string) => {
    const rows = [...cargoReceipt().crates, ...(cargoReceipt().hostSmokeCrates ?? [])].filter(
      (row) => row.name === name && row.version === version,
    );
    assert.equal(rows.length, 1, 'reached WASIX Cargo source lacks its receipt identity');
    const candidates = current.filter(
      (artifact) => artifact.artifact === `cargo:${name}` && artifact.version === version,
    );
    assert.equal(candidates.length, 1);
    return candidates[0].file as ExtensionFinalInputFile;
  };
  const cargoPackages = new Map<string, ExtensionFinalInputFile>();
  return (labels: string[]): NativeImportedRoot[] => {
    imported = new Map<string, NativeImportedRoot>();
    for (const label of [...new Set(labels)]) {
      const match = /^@@?([^/]+)\/\/([^:]*):(.+)$/u.exec(label);
      if (!match) continue;
      const [, repository, pkg, name] = match;
      if (!isNativeImportSourceLabel(label)) continue;
      assert.match(repository, /^[A-Za-z0-9._+~-]+$/u);
      const member = [pkg, name].filter(Boolean).join('/');
      safeRelative(member);
      const directory = path.join(executionRoot, 'external', repository);
      const actual = path.join(directory, member);
      if (matchesRepo(repository, 'react_native_native_base')) {
        let role: string;
        if (member.startsWith('framework/')) role = 'framework';
        else if (member.startsWith('resources/')) role = 'resources';
        else if (member.startsWith('archives/')) {
          const rows = ['framework', 'resources'].map((role) => ({
            role,
            row: readDescriptor(directory, role),
          }));
          const selected = rows.filter(
            ({ row }) => path.basename(row.file.path) === path.basename(member),
          );
          assert.equal(selected.length, 1, 'captured Apple archive lacks its original role');
          role = selected[0].role;
        } else if (member === 'BUILD.bazel') continue;
        else assert.fail('unknown reached captured Apple source');
        assert.ok(
          statSync(realpathSync(actual)).isFile(),
          'captured Apple input is not a regular File',
        );
        const row = readDescriptor(directory, role);
        if (member.startsWith('archives/')) {
          const identity = fileIdentity(realpathSync(actual));
          assert.deepEqual(
            { size: identity.size, sha256: identity.sha256 },
            { size: row.file.size, sha256: row.file.sha256 },
            'captured Apple archive differs from its original File',
          );
        }
        descriptorFile(row);
        continue;
      }
      if (matchesRepo(repository, 'react_native_swift_package')) {
        if (member === 'BUILD.bazel') continue;
        assert.ok(
          statSync(realpathSync(actual)).isFile(),
          'captured Swift input is not a regular File',
        );
        const sourceRow = readDescriptor(directory, 'source');
        const bindings = readDescriptor(directory, 'bindings');
        const bindingsMember =
          member.startsWith('OliphauntNativeBindingsFFI.xcframework/') ||
          (member.startsWith('archives/') &&
            path.basename(member) === path.basename(bindings.file.path));
        if (bindingsMember) descriptorFile(bindings);
        else {
          // Repository construction verifies the original carrier together with source bytes.
          descriptorFile(sourceRow, sourceRow.publication ? sourceRow.file : sourceRow.archive);
          if (!sourceRow.publication) descriptorFile(sourceRow, sourceRow.carrier);
          if (['construction.json', 'construction.bzl'].includes(member)) descriptorFile(bindings);
        }
        if (
          member.startsWith('archives/') ||
          (member === 'carrier.json' && !sourceRow.publication)
        ) {
          const file = bindingsMember
            ? bindings.file
            : member === 'carrier.json'
              ? sourceRow.carrier
              : sourceRow.publication
                ? sourceRow.file
                : sourceRow.archive;
          const identity = fileIdentity(realpathSync(actual));
          assert.deepEqual(
            { size: identity.size, sha256: identity.sha256 },
            { size: file.size, sha256: file.sha256 },
            'captured Swift archive differs from its original File',
          );
        }
        continue;
      }
      if (matchesRepo(repository, 'oliphaunt_metadata')) {
        const original = aliases.get(member);
        if (original) equalFile(original, actual);
        else if (
          /^(?:native-current-artifacts|native-apple-base|native-swift-source|extension-final-inputs)\//u.test(
            member,
          )
        )
          assert.fail('reached constructor alias lacks its original producer');
        continue;
      }
      if (matchesRepo(repository, 'postmaster_guest')) {
        if (
          !member.startsWith('release-archives/') &&
          (pkg || ['BUILD.bazel', 'guest.bzl'].includes(name))
        )
          continue;
        const parts = member.split('/');
        const artifact = `github-release:${parts.at(-1)}`;
        const candidates = current.filter(
          (row) => row.artifact === artifact && (parts.length < 3 || row.product === parts[1]),
        );
        const held = completed.filter(
          (row) =>
            row.artifact === artifact && (parts.length < 3 || row.publication.product === parts[1]),
        );
        const identity = fileIdentity(realpathSync(actual));
        const sameBytes = ({ file }: { file: { size: number; sha256: string } }) =>
          file.size === identity.size && file.sha256 === identity.sha256;
        let present = candidates.filter(sameBytes);
        let published = held.filter(sameBytes);
        if (present.length && published.length) {
          // Equal bytes alone cannot relabel a held publication as a current producer.
          // A direct original File path can disambiguate; copied ambiguous inputs fail closed.
          const original = realpathSync(actual);
          present = present.filter(({ file }) => realpathSync(file.path) === original);
          published = published.filter(({ file }) => realpathSync(file.path) === original);
        }
        if (published.length && !present.length) {
          for (const row of published) {
            const retained = fileIdentity(row.file.path);
            assert.deepEqual(
              { size: retained.size, sha256: retained.sha256 },
              { size: row.file.size, sha256: row.file.sha256 },
              'reached completed archive differs from its retained File',
            );
          }
          continue;
        }
        assert.equal(
          present.length,
          1,
          'reached release archive lacks one unambiguous original current producer',
        );
        assert.equal(
          published.length,
          0,
          'reached release archive mixes completed/current origins',
        );
        equalFile(present[0].file, actual);
        continue;
      }
      const value = cargoReceipt();
      const rows = [...value.crates, ...(value.hostSmokeCrates ?? [])];
      if (member.startsWith('host-smoke/')) {
        const candidates = rows.filter((row) => row.path === path.posix.basename(member));
        assert.equal(candidates.length, 1, 'reached host-smoke crate is absent from its receipt');
        equalFile(cargoOriginal(candidates[0].name, candidates[0].version), actual);
        continue;
      }
      let parent = path.dirname(actual);
      while (parent !== directory && !existsSync(path.join(parent, 'Cargo.toml')))
        parent = path.dirname(parent);
      assert.ok(
        parent === directory || parent.startsWith(`${directory}${path.sep}`),
        'WASIX Cargo source escaped its imported repository',
      );
      if (parent === directory) {
        assert.ok(
          ['Cargo.toml', 'Cargo.lock', 'cargo.bzl', 'cargo-facts.json', 'BUILD.bazel'].includes(
            member,
          ),
          'unknown reached WASIX repository source',
        );
        for (const row of value.crates) retain(cargoOriginal(row.name, row.version));
      } else {
        assert.ok(
          statSync(realpathSync(actual)).isFile(),
          'imported Cargo source is not a regular File',
        );
        if (!cargoPackages.has(parent)) {
          const manifest = Bun.TOML.parse(readFileSync(path.join(parent, 'Cargo.toml'), 'utf8'));
          cargoPackages.set(
            parent,
            cargoOriginal(manifest.package?.name, manifest.package?.version),
          );
        }
        retain(cargoPackages.get(parent)!);
      }
    }
    return [...imported.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([, root]) => root);
  };
}
