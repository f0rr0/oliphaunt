/** Canonical final core-runtime carriers from declared current payloads. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  validateAotReleaseAsset,
  validatePortableReleaseAsset,
} from '../../src/wasix/runtime/tools/check-release-assets.mts';
import {
  stageAotAssets,
  stagePortableAssets,
} from '../../src/wasix/runtime/tools/package-release-assets.mts';
import {
  AOT_PACKAGES,
  AOT_TARGET_TRIPLES,
  RUNTIME_PACKAGE,
} from '../../src/wasix/runtime/tools/wasix-cargo-artifact-contract.mts';
import { WASIX_PORTABLE_RELEASE_MEMBERS } from '../../src/wasix/runtime/tools/wasix-runtime-npm-contract.mts';
import {
  assertWasixRuntimeNpmArchive,
  wasixRuntimeNpmPayloadInputs,
} from '../../src/wasix/runtime/tools/wasix-runtime-npm-payload.mts';
import { createDeterministicTar } from '../../tools/packaging/archive-directory.mts';
import {
  readPortableArchiveEntries,
  releaseZstdCompressSync,
} from '../../tools/packaging/portable-archive.mts';
import { stageReleaseNotices } from '../../tools/packaging/release-notices.mts';
import { ROOT } from '../../tools/release/release-artifact-targets.mts';
import { writeNativeChecksums } from '../native/carriers/checksums.mts';
import {
  copyDeclaredSources,
  copyDeclaredToolchain,
  extractRuntimeCargoFamily,
  stageDeclaredPayload,
} from './cargo.mts';
import { type RuntimePayloadSpec, sourceFacts } from './package.mts';

interface RuntimeArtifact {
  product: string;
  kind: string;
  target?: string;
  triple?: string;
  asset: string;
}

export interface RuntimeReleaseSpec
  extends Pick<RuntimePayloadSpec, 'postgresSource' | 'postgresSeries' | 'patches' | 'icuSource'> {
  version: string;
  artifact: RuntimeArtifact;
  payload: string;
  payloadFiles: string[];
  notices: Record<string, string>;
  generated: Record<string, string>;
  toolchain: string;
  engineSources?: string | null;
  output: string;
}

export async function packageRuntimeReleaseAsset(spec: RuntimeReleaseSpec): Promise<void> {
  const portable = spec.artifact.target === 'portable';
  assert.equal(spec.artifact.product, 'liboliphaunt-wasix');
  assert.equal(spec.artifact.kind, portable ? 'wasix-runtime' : 'wasix-aot-runtime');
  assert.match(spec.version, /^\d+\.\d+\.\d+$/u);
  assert(
    portable ||
      (typeof spec.artifact.target === 'string' &&
        Object.hasOwn(AOT_TARGET_TRIPLES, spec.artifact.target) &&
        spec.artifact.triple === AOT_TARGET_TRIPLES[spec.artifact.target]),
  );
  const asset = spec.artifact.asset.replaceAll('{version}', spec.version);
  assert.equal(path.basename(asset), asset);
  assert.equal(path.basename(spec.output), asset);
  assert(asset.endsWith('.tar.zst'));
  mkdirSync(path.dirname(spec.output), { recursive: true });
  const scratch = mkdtempSync(
    path.join(path.dirname(path.resolve(spec.output)), '.wasix-runtime-release-'),
  );
  try {
    const payload = path.join(scratch, 'payload');
    stageDeclaredPayload(spec, payload);
    const sourceRoot = path.join(scratch, 'sources');
    copyDeclaredSources(spec.notices, sourceRoot);
    copyDeclaredToolchain(spec, sourceRoot);
    const stage = path.join(scratch, 'archive');
    const { source_fingerprint: fingerprint } = await sourceFacts(spec);
    if (portable) {
      stagePortableAssets(payload, path.join(stage, 'target/oliphaunt-wasix/assets'), fingerprint);
      copyDeclaredSources(spec.generated, stage);
      stageReleaseNotices(stage, { profile: 'wasix-runtime', sourceRoot });
    } else {
      const target = path.join(stage, 'target/oliphaunt-wasix/aot', spec.artifact.triple);
      stageAotAssets(payload, target, spec.artifact.triple, fingerprint);
      stageReleaseNotices(target, { profile: 'wasix-aot', sourceRoot });
    }
    writeFileSync(spec.output, releaseZstdCompressSync(await createDeterministicTar(stage)));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

interface RegistryCarrier {
  ecosystem: string;
  name: string;
  target?: string;
}
export interface RuntimeFinalPackageSpec {
  version: string;
  artifacts: RuntimeArtifact[];
  registryCarriers: RegistryCarrier[];
  packages: { ecosystem: string; name: string; version: string; files: string[] }[];
  portable: string;
  exportPolicy: string;
}

export function verifyRuntimeFinalPackages(spec: RuntimeFinalPackageSpec): void {
  const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
  const json = (file: string) => JSON.parse(readFileSync(file, 'utf8'));
  const currentManifestBytes = readFileSync(
    realpathSync(path.join(spec.portable, 'manifest.json')),
  );
  const currentRuntimeBytes = readFileSync(
    realpathSync(path.join(spec.portable, 'oliphaunt.wasix.tar.zst')),
  );
  const currentManifest = JSON.parse(currentManifestBytes.toString('utf8'));
  const current = wasixRuntimeNpmPayloadInputs({
    manifestBytes: currentManifestBytes,
    runtimeBytes: currentRuntimeBytes,
    label: 'actual current portable producer',
  });
  const expected = [
    ...spec.artifacts.map((row) => `github:${row.asset.replaceAll('{version}', spec.version)}`),
    ...spec.registryCarriers.map((row) => `${row.ecosystem}:${row.name}`),
  ].sort();
  assert.equal(
    new Set(expected).size,
    expected.length,
    'Canonical runtime carrier identities must be unique',
  );
  assert.deepEqual(
    spec.packages.map((row) => `${row.ecosystem}:${row.name}`).sort(),
    expected,
    'Final runtime carrier inventory differs from its canonical owner',
  );
  const families = new Map<string, string[]>();
  const byIdentity = new Map(
    spec.packages.map((row) => {
      assert.equal(row.version, spec.version);
      assert.equal(row.files.length, 1, 'Each final runtime carrier must own exactly one archive');
      const input = realpathSync(row.files[0]);
      if (row.ecosystem === 'cargo') {
        const archives = statSync(input).isDirectory()
          ? readdirSync(input).map((name) => {
              assert(name.endsWith('.crate'), 'Cargo family contains a non-crate file');
              const file = path.join(input, name);
              assert(statSync(file).isFile(), 'Cargo family member is not a regular archive');
              return file;
            })
          : [input];
        families.set(row.name, archives);
        const parents = archives.filter(
          (file) => path.basename(file) === `${row.name}-${row.version}.crate`,
        );
        assert.equal(parents.length, 1, 'Cargo family must contain its canonical parent');
        return [`cargo:${row.name}`, parents[0]] as const;
      }
      assert(statSync(input).isFile(), 'Final runtime archive must be a regular file');
      return [`${row.ecosystem}:${row.name}`, input] as const;
    }),
  );
  const scratch = mkdtempSync(
    path.join(process.env.TEST_TMPDIR ?? os.tmpdir(), 'wasix-final-packages-'),
  );
  try {
    const githubManifests = new Map<string, unknown>();
    const archives = [];
    const rows = spec.artifacts.filter((row) => row.kind !== 'checksums');
    assert.equal(rows.length, 5);
    for (const row of rows) {
      const file = byIdentity.get(`github:${row.asset.replaceAll('{version}', spec.version)}`);
      assert(file);
      archives.push(file);
      if (row.target === 'portable') {
        const entries = validatePortableReleaseAsset(file);
        assert.deepEqual(
          entries.get('src/runtimes/liboliphaunt-wasix/assets/generated/wasix-dl.exports')?.data(),
          readFileSync(realpathSync(spec.exportPolicy)),
          'Portable release export policy differs from its actual current compiled producer',
        );
        const manifest = JSON.parse(
          entries.get(WASIX_PORTABLE_RELEASE_MEMBERS.manifest).data().toString('utf8'),
        );
        assert.deepEqual(
          manifest,
          currentManifest,
          'GitHub portable metadata differs from the actual current producer',
        );
        assert.equal(
          sha(entries.get(WASIX_PORTABLE_RELEASE_MEMBERS.runtimeArchive).data()),
          current.runtimeArchive.sha256,
        );
        githubManifests.set('portable', manifest);
      } else {
        assert.equal(row.triple, AOT_TARGET_TRIPLES[row.target]);
        const entries = validateAotReleaseAsset(file, row.triple);
        const manifest = JSON.parse(
          entries
            .get(`target/oliphaunt-wasix/aot/${row.triple}/manifest.json`)
            .data()
            .toString('utf8'),
        );
        assert.equal(manifest['source-fingerprint'], currentManifest['source-fingerprint']);
        assert.equal(
          manifest.artifacts.find((item) => item.name === 'runtime:oliphaunt')?.['module-sha256'],
          currentManifest.runtime['module-sha256'],
        );
        githubManifests.set(row.target, manifest);
      }
    }
    const checksumRows = spec.artifacts.filter((row) => row.kind === 'checksums');
    assert.equal(checksumRows.length, 1);
    const checksum = byIdentity.get(
      `github:${checksumRows[0].asset.replaceAll('{version}', spec.version)}`,
    );
    assert(checksum);
    const expectedChecksum = path.join(scratch, 'expected.sha256');
    writeNativeChecksums({
      expected: rows.map((row) => row.asset.replaceAll('{version}', spec.version)),
      files: archives,
      output: expectedChecksum,
    });
    assert.deepEqual(
      readFileSync(checksum),
      readFileSync(expectedChecksum),
      'Final checksum does not cover exactly the canonical five runtime archives',
    );
    for (const carrier of spec.registryCarriers) {
      const file = byIdentity.get(`${carrier.ecosystem}:${carrier.name}`);
      assert(file);
      if (carrier.ecosystem === 'npm') {
        assertWasixRuntimeNpmArchive(file, {
          version: spec.version,
          descriptor: { version: spec.version, ...current },
        });
      } else {
        assert.equal(carrier.ecosystem, 'cargo');
        const target =
          carrier.name === RUNTIME_PACKAGE
            ? null
            : Object.keys(AOT_PACKAGES).find((id) => AOT_PACKAGES[id] === carrier.name);
        assert(target !== undefined, 'Unknown final runtime Cargo carrier');
        const archiveRoot = `${carrier.name}-${spec.version}`;
        const cargoManifest = readPortableArchiveEntries(file).get(`${archiveRoot}/Cargo.toml`);
        assert(cargoManifest?.isFile);
        const manifest = Bun.TOML.parse(cargoManifest.data().toString('utf8'));
        assert.equal(manifest.package.name, carrier.name);
        assert.equal(manifest.package.version, spec.version);
        const family = families.get(carrier.name);
        assert(family, `Missing declared Cargo family: ${carrier.name}`);
        const extracted = extractRuntimeCargoFamily(
          family,
          path.join(scratch, carrier.name),
          target,
          ROOT,
        );
        const payload = path.join(extracted, target === null ? 'payload' : 'artifacts');
        assert.deepEqual(
          json(path.join(payload, 'manifest.json')),
          githubManifests.get(target ?? 'portable'),
          'Cargo and GitHub runtime metadata differ',
        );
        if (target === null)
          assert.equal(
            sha(readFileSync(path.join(payload, 'oliphaunt.wasix.tar.zst'))),
            current.runtimeArchive.sha256,
          );
      }
    }
    console.log(`Verified ${spec.packages.length} actual current runtime carriers`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const [operation, specFile, leaves] = Bun.argv.slice(2);
  assert(specFile && (operation === 'package' || operation === 'verify'));
  const spec = JSON.parse(readFileSync(specFile, 'utf8'));
  if (operation === 'verify') verifyRuntimeFinalPackages(spec);
  else {
    assert(leaves?.startsWith('--payload-files='));
    await packageRuntimeReleaseAsset({
      ...spec,
      payloadFiles: readFileSync(leaves.slice('--payload-files='.length), 'utf8')
        .trimEnd()
        .split(/\r?\n/u),
    });
  }
}
