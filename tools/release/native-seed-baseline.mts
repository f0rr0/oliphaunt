/** One reviewed source adoption contract closes missing legacy constructor history. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  assertSeedPublicData,
  SEED_CONSTRUCTION_ANCHOR_SCHEMA,
  SEED_CONSTRUCTION_RECEIPT_SUFFIX,
  type SeedConstructionAnchor,
  validateSeedConstructionAnchor,
  validateSeedConstructionReceipt,
  seedConstructionIntentSha256,
} from '../../build_defs/resources/seed_construction.mts';
import { assertAuthenticatedNativeBuildOrigin } from './authenticate-native-build-evidence.mts';
import { buildShippingInputView } from './bazel-shipping-inputs.mts';
import {
  nativeShippingRootsHaveQualification,
  type NativeBuildSource,
} from './native-build-qualification.mts';
import { fileIdentity } from './native-file-identity.mts';
import { type NativeSeedInputControl } from './native-seed-inputs.mts';
import { ROOT } from './release-graph.mts';
import { loadPublicationCatalog } from './publication-catalog.mts';
import { expectedProductArtifactRows } from './publication-lock.mts';
import { assertAuthenticatedNativePublicBaseline } from './native-publication-metadata.mts';
import type { CompletedPublication } from './completed-release-publication.mts';
import type { observeNativePublicationConstruction } from './native-publication-observation.mts';

export const seedConstructionAnchorPath = 'src/database-resources/seeds/construction-anchor.json';
export type NativeSeedConstructionBaseline =
  | NonNullable<ReturnType<typeof readDeclaredSeedConstructionAnchor>>
  | {
      metadata: ReturnType<typeof assertAuthenticatedNativePublicBaseline>;
      files: Record<string, string>;
    };
const identity = (file: string) => {
  const actual = fileIdentity(file);
  return { size: actual.size, sha256: actual.sha256 };
};
const declaredAnchors = new WeakMap<
  object,
  { source: NativeBuildSource; directory: string; sha256: string }
>();

/** An immutable committed contract is a source declaration, never producer assurance. */
export function readDeclaredSeedConstructionAnchor(source: NativeBuildSource, directory = ROOT) {
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();
  assert.equal(
    git('rev-parse', `${source.commit}^{tree}`),
    source.tree,
    'seed baseline source tree differs',
  );
  const file = path.join(directory, seedConstructionAnchorPath);
  if (!git('ls-tree', '--name-only', source.commit, '--', seedConstructionAnchorPath)) {
    assert.ok(
      !git('log', '--format=%H', source.commit, '--', seedConstructionAnchorPath),
      'seed adoption contract was removed from source',
    );
    assert.ok(!existsSync(file), 'seed adoption contract must be committed in the current source');
    return undefined;
  }
  assert.match(
    git('ls-tree', source.commit, '--', seedConstructionAnchorPath),
    /^100644 blob [a-f0-9]{40}\tsrc\/database-resources\/seeds\/construction-anchor\.json$/u,
    'seed adoption contract must be a regular source file',
  );
  const blob = execFileSync('git', ['show', `${source.commit}:${seedConstructionAnchorPath}`], {
    cwd: directory,
  });
  assert.deepEqual(
    readFileSync(file),
    blob,
    'seed adoption contract differs from committed source',
  );
  const changes = git(
    'log',
    '--reverse',
    '--format=%H',
    source.commit,
    '--',
    seedConstructionAnchorPath,
  )
    .split('\n')
    .filter(Boolean);
  assert.ok(changes.length, 'seed adoption contract has no introduction');
  const original = execFileSync('git', ['show', `${changes[0]}:${seedConstructionAnchorPath}`], {
    cwd: directory,
  });
  assert.deepEqual(
    blob,
    original,
    'seed adoption contract changed after its original introduction',
  );
  const anchor = validateSeedConstructionAnchor(JSON.parse(blob.toString('utf8')));
  const value = { anchor, file: { path: file, ...identity(file) } };
  declaredAnchors.set(value, {
    source: structuredClone(source),
    directory,
    sha256: value.file.sha256,
  });
  return value;
}

export function assertDeclaredSeedConstructionAnchor(value: unknown, source: NativeBuildSource) {
  assert.ok(
    value && typeof value === 'object' && declaredAnchors.has(value),
    'seed baseline requires its actual immutable source declaration',
  );
  const proof = declaredAnchors.get(value)!;
  assert.deepEqual(proof.source, source, 'seed baseline observation source differs');
  const fresh = readDeclaredSeedConstructionAnchor(source, proof.directory);
  assert.ok(fresh);
  assert.equal(fresh.file.sha256, proof.sha256, 'seed baseline declaration changed');
  assert.deepEqual(value, fresh, 'seed baseline facts changed');
  return value as NonNullable<ReturnType<typeof readDeclaredSeedConstructionAnchor>>;
}

/** Published constructor facts replace the one-time adoption contract after release. */
export function assertSeedConstructionBaseline(
  value: NativeSeedConstructionBaseline,
  source: NativeBuildSource,
) {
  if ('anchor' in value) return assertDeclaredSeedConstructionAnchor(value, source);
  assertAuthenticatedNativePublicBaseline(value.metadata);
  assert.equal(value.metadata.publication.product, 'database-resources');
  return value;
}

/** Diagnostic PR captures may propose this contract; main review grants source policy. */
export function proposeSeedConstructionAnchor({
  source,
  origins,
  seedControls,
}: {
  source: NativeBuildSource;
  origins: Map<string, ReturnType<typeof assertAuthenticatedNativeBuildOrigin>>;
  seedControls: NativeSeedInputControl[];
}) {
  assert.ok(seedControls.length, 'seed adoption needs complete public slots');
  const publication = seedControls[0].reuse?.publication;
  assert.ok(publication);
  const resource = loadPublicationCatalog('seed adoption source contract').products.find(
    (product) => product.id === publication.product,
  )!;
  const expected = expectedProductArtifactRows([{ ...resource, version: publication.version }])
    .filter(
      (row) => ['native-seeds', 'wasix-seeds'].includes(row.kind) && row.name.endsWith('.json'),
    )
    .map((row) => row.name)
    .sort();
  assert.deepEqual(
    seedControls.map((row) => path.basename(row.reuse!.manifest.path)).sort(),
    expected,
    'seed adoption requires every canonical public slot',
  );
  const seeds: SeedConstructionAnchor['seeds'] = [];
  for (const control of seedControls) {
    assert.ok(
      control.reuse && control.reuse.operation === 'adopt' && !control.promotion,
      'seed adoption requires explicitly acquired legacy public data',
    );
    assert.deepEqual(control.reuse.publication, publication, 'seed adoption public origin differs');
    const matches: SeedConstructionAnchor['seeds'] = [];
    for (const [directory, raw] of origins) {
      const origin = assertAuthenticatedNativeBuildOrigin(raw);
      assert.deepEqual(origin.evidence.source, source, 'seed adoption producer source differs');
      assert.ok(origin.finalFiles?.qualification);
      const qualification = origin.finalFiles.qualification;
      assert.equal(qualification.shippingAnalysis, 'bound');
      assert.equal(qualification.testQualification, 'passed');
      for (const [index, cohort] of origin.evidence.cohorts.entries()) {
        const roots = cohort.roots.filter(
          (root) =>
            root.package.product === publication.product &&
            root.package.name === path.basename(control.reuse!.archive.path) &&
            root.package.configuration === control.target,
        );
        if (!roots.length) continue;
        assert.equal(roots.length, 1, 'seed adoption shipping owner is ambiguous');
        assert.ok(
          nativeShippingRootsHaveQualification(
            qualification.cohorts[index].qualificationPolicy,
            roots,
          ),
          'seed adoption requires its actual source-owned mandatory qualification',
        );
        const view = buildShippingInputView(
          {
            schema: 'oliphaunt-bazel-shipping-v1',
            scope: 'construction',
            packages: roots.map((root) => root.package),
          },
          cohort.aquery,
        );
        const reached = new Set(view.physicalInputs);
        const rows = (cohort.seedConstructions ?? []).filter(
          (row) =>
            reached.has(row.path) &&
            ['family', 'target', 'profile'].every(
              (key) =>
                validateSeedConstructionReceipt(JSON.parse(row.contents)).intent[key] ===
                control[key],
            ),
        );
        assert.equal(
          rows.length,
          1,
          'seed adoption requires its unique reached constructor receipt',
        );
        const row = rows[0];
        const receipt = validateSeedConstructionReceipt(JSON.parse(row.contents));
        const receiptPath = path.join(directory, 'files', String(index), row.path);
        assert.equal(
          readFileSync(receiptPath, 'utf8'),
          row.contents,
          'seed adoption original receipt File differs',
        );
        const frozenPath = path.join(
          directory,
          'files',
          String(index),
          `${row.path.slice(0, -SEED_CONSTRUCTION_RECEIPT_SUFFIX.length)}.tar`,
        );
        assert.deepEqual(
          identity(frozenPath),
          receipt.frozen,
          'seed adoption original frozen File differs',
        );
        assertSeedPublicData(control.reuse.archive.path, receipt);
        matches.push({
          family: control.family,
          target: control.target,
          profile: control.profile,
          archive: identity(control.reuse.archive.path),
          manifest: identity(control.reuse.manifest.path),
          receipt: { ...identity(receiptPath), contents: row.contents },
          producer: {
            evidenceDigest: origin.evidenceDigest,
            invocationId: qualification.cohorts[index].invocationId,
            root: roots[0].label,
            configuration: qualification.cohorts[index].roots.find(
              (row) => row.label === roots[0].label,
            )!.configuration,
            output: row.path,
          },
        });
      }
      origin.finalFiles.assertUnchanged();
    }
    assert.equal(
      matches.length,
      1,
      'seed adoption requires one independently authenticated producer per public slot',
    );
    seeds.push(matches[0]);
  }
  seeds.sort((left, right) =>
    `${left.family}/${left.target}/${left.profile}`.localeCompare(
      `${right.family}/${right.target}/${right.profile}`,
    ),
  );
  return validateSeedConstructionAnchor({
    schema: SEED_CONSTRUCTION_ANCHOR_SCHEMA,
    source: structuredClone(source),
    publication,
    seeds,
  });
}

export function writeSeedConstructionAnchorProposal(file: string, anchor: SeedConstructionAnchor) {
  assert.ok(!existsSync(file), 'seed adoption is one immutable source contract');
  writeFileSync(file, `${JSON.stringify(validateSeedConstructionAnchor(anchor), null, 2)}\n`, {
    flag: 'wx',
  });
}

/** Causal input changes justify a fresh seed only after joining its exact public PGDATA. */
export function seedArchiveHasChangedDeclaredContents({
  declaration,
  source,
  publication,
  observation,
  artifactId,
}: {
  declaration: NativeSeedConstructionBaseline;
  source: NativeBuildSource;
  publication: CompletedPublication;
  observation: Awaited<ReturnType<typeof observeNativePublicationConstruction>>;
  artifactId: string;
}) {
  const baseline = assertSeedConstructionBaseline(declaration, source);
  assert.deepEqual(
    'anchor' in baseline ? baseline.anchor.publication : baseline.metadata.publication,
    publication,
    'seed causal baseline completed origin differs',
  );
  const product = observation.products.find(({ product }) => product.id === publication.product);
  assert.ok(product, 'seed causal comparison lacks the observed resource owner');
  const archive = product.productArtifacts.find(
    (row) =>
      row.id === artifactId &&
      ['native-seeds', 'wasix-seeds'].includes(row.kind) &&
      row.name.endsWith('.tar.zst'),
  );
  assert.ok(archive, 'seed causal comparison needs its canonical public archive');
  const descriptors = product.productArtifacts.filter(
    (row) =>
      row.kind === archive.kind && row.target === archive.target && row.name.endsWith('.json'),
  );
  const descriptorFiles = descriptors
    .map((row) => {
      assert.equal(row.qualifiedFiles.length, 1);
      const file = row.qualifiedFiles[0];
      assert.deepEqual(
        identity(file.frozenPath),
        { size: file.size, sha256: file.sha256 },
        'seed causal descriptor File changed',
      );
      return JSON.parse(readFileSync(file.frozenPath, 'utf8'));
    })
    .filter((descriptor) => descriptor.archive?.path === archive.name);
  assert.equal(descriptorFiles.length, 1, 'seed causal descriptor slot is ambiguous');
  const descriptor = descriptorFiles[0];
  const slot = {
    family: archive.kind === 'native-seeds' ? 'native' : 'wasix',
    target: archive.target,
    profile: descriptor.catalogProfile,
  };
  assert.equal(archive.qualifiedFiles.length, 1);
  const archiveFile = archive.qualifiedFiles[0];
  assert.deepEqual(
    identity(archiveFile.frozenPath),
    { size: archiveFile.size, sha256: archiveFile.sha256 },
    'seed causal public File changed',
  );
  const rows = product.construction.flatMap((construction) => {
    if (!construction.roots.some((root) => root.label === archiveFile.label)) return [];
    return (construction.seedConstructions ?? [])
      .map(({ contents }) => validateSeedConstructionReceipt(JSON.parse(contents)))
      .filter((receipt) =>
        ['family', 'target', 'profile'].every((key) => receipt.intent[key] === slot[key]),
      );
  });
  assert.equal(rows.length, 1, 'seed causal comparison needs its unique actual constructor');
  const current = rows[0];
  assertSeedPublicData(archiveFile.frozenPath, current);
  let previous: ReturnType<typeof validateSeedConstructionReceipt>;
  if ('anchor' in baseline) {
    const seed = baseline.anchor.seeds.find((seed) =>
      ['family', 'target', 'profile'].every((key) => seed[key] === slot[key]),
    );
    assert.ok(seed, 'seed causal baseline slot is absent');
    previous = validateSeedConstructionReceipt(JSON.parse(seed.receipt.contents));
  } else {
    const metadata = baseline.metadata.metadata;
    const oldArchives = metadata.productArtifacts.filter(
      (row) =>
        row.kind === archive.kind && row.target === archive.target && row.name.endsWith('.tar.zst'),
    );
    const matches = oldArchives.flatMap((row) => {
      const receipts = metadata.construction.flatMap((construction) => {
        if (!construction.roots.some((root) => root.package.name === row.name)) return [];
        return (construction.seedConstructions ?? [])
          .map(({ contents }) => validateSeedConstructionReceipt(JSON.parse(contents)))
          .filter((receipt) =>
            ['family', 'target', 'profile'].every((key) => receipt.intent[key] === slot[key]),
          );
      });
      return receipts.map((receipt) => ({ row, receipt }));
    });
    assert.equal(matches.length, 1, 'signed seed baseline needs its unique original constructor');
    const { row, receipt } = matches[0];
    const file = baseline.files[row.id];
    assert.ok(file, 'signed seed baseline lacks its retained public archive');
    assert.equal(row.qualifiedFiles.length, 1, 'signed seed baseline public File is ambiguous');
    assert.deepEqual(
      identity(file),
      { size: row.qualifiedFiles[0].size, sha256: row.qualifiedFiles[0].sha256 },
      'signed seed baseline differs from its original public File',
    );
    assertSeedPublicData(file, receipt);
    previous = receipt;
  }
  const oldContent = previous.qualificationContentIntent ?? previous.contentIntent;
  const newContent = current.qualificationContentIntent ?? current.contentIntent;
  return (
    !!oldContent &&
    !!newContent &&
    current.origin.kind === 'constructed' &&
    seedConstructionIntentSha256(oldContent) !== seedConstructionIntentSha256(newContent)
  );
}
