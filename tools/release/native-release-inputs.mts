/** Transport the existing constructor snapshot through the reviewed Prepare producer. */
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { validateSeedConstructionReceipt } from '../../build_defs/resources/seed_construction.mts';
import { requireSafeDirectoryChain } from '../packaging/release-directory-safety.mts';
import type { CompletedPublication } from './completed-release-publication.mts';
import { requestGithubPages, requestGithubRepositoryJson } from './github-read.mts';
import type { NativeBuildSource } from './native-build-qualification.mts';
import {
  type ExtensionFinalInput,
  type ExtensionFinalInputFile,
  type NativeAppleBaseInput,
  type NativeCurrentArtifact,
  type NativeSwiftSourceInput,
  projectNativeAppleBaseInput,
  projectNativeCurrentArtifacts,
  projectNativeExtensionFinalInputs,
  projectNativeSwiftSourceInput,
} from './native-extension-final-inputs.mts';
import { fileIdentity } from './native-file-identity.mts';
import { type NativeSeedInputControl, projectNativeSeedInputs } from './native-seed-inputs.mts';
import {
  type NativeSupplierArtifact,
  validateNativeSupplierArtifacts,
} from './native-supplier-artifacts.mts';
import {
  assertNativeVersionSourceTransition,
  type NativeVersionSourceBridge,
  validateNativeVersionSourceBridge,
} from './native-version-source.mts';
import { sourceIdentity } from './publication-lock.mts';
import { resolveBuildBoundCompatibilityProducts } from './release-dependency-plan.mts';
import { loadProducts, ROOT } from './release-graph.mts';
import { releaseProductsFromManifests } from './verify-release-commit.mts';

const execute = promisify(execFile);
const acquiredPreparedInputs = new WeakMap<
  object,
  { digest: string; file: { size: number; sha256: string } }
>();
const preparedDigest = (value: Awaited<ReturnType<typeof acquirePreparedNativeReleaseInputs>>) =>
  createHash('sha256')
    .update(
      JSON.stringify({
        record: value.record,
        origin: value.origin,
        buildBound: [...value.buildBound].map(([id, suppliers]) => [id, [...suppliers]]),
      }),
    )
    .digest('hex');
/** A parsed record carries facts; only actual canonical Prepare acquisition carries origin. */
export function assertAcquiredPreparedNativeReleaseInputs(value: unknown) {
  if (!value || typeof value !== 'object' || !acquiredPreparedInputs.has(value))
    throw new Error('prepared native inputs lack their authenticated Prepare producer');
  const result = value as Awaited<ReturnType<typeof acquirePreparedNativeReleaseInputs>>;
  const proof = acquiredPreparedInputs.get(result);
  assert.ok(proof);
  assert.equal(preparedDigest(result), proof.digest, 'acquired native Prepare facts changed');
  const actual = fileIdentity(result.snapshotFile);
  assert.deepEqual(
    { size: actual.size, sha256: actual.sha256 },
    proof.file,
    'acquired native Prepare snapshot changed',
  );
  const snapshot = readJson(result.snapshotFile);
  projectNativeSeedInputs(snapshot.seedControls, snapshot.source);
  assertSupplierFiles(snapshot.supplierArtifacts ?? [], snapshot.supplierPublications);
  assertFinalInputFiles(snapshot);
  return result;
}
const repository = 'f0rr0/oliphaunt';
export const nativeReleaseInputsArtifact = 'native-release-inputs';
export type NativeReleaseInputRecord = {
  bridge: NativeVersionSourceBridge;
  selectedProducts: string[];
  preparedSource: NativeBuildSource;
  buildBound: [string, string[]][];
};
export type NativeReleaseFinalInputs = {
  extensionFinalInputs?: ExtensionFinalInput[];
  nativeAppleBase?: NativeAppleBaseInput;
  nativeSwiftSource?: NativeSwiftSourceInput;
  nativeCurrentArtifacts?: NativeCurrentArtifact[];
};
const finalInputFields = (value: NativeReleaseFinalInputs) =>
  ['extensionFinalInputs', 'nativeAppleBase', 'nativeSwiftSource', 'nativeCurrentArtifacts'].filter(
    (name) => Object.hasOwn(value, name),
  );
const fields = (value: unknown, names: string[]) => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  assert.deepEqual(
    Object.keys(value).sort(),
    [...names].sort(),
    'native release input fields differ',
  );
};
const source = (value: NativeBuildSource) => {
  fields(value, ['commit', 'tree']);
  for (const sha of [value.commit, value.tree]) assert.match(sha, /^[a-f0-9]{40}$/u);
};
const readJson = (file: string) => JSON.parse(readFileSync(file, 'utf8'));
const writeJson = (file: string, value: unknown) =>
  writeFileSync(file, `${JSON.stringify(value)}\n`, { flag: 'wx' });

/** Resolve an exact producer request, never the latest branch run. Unchanged
 * main commits and ordinary PRs need no prepared-release input acquisition.
 */
export async function resolveNativeReleaseInputContext(
  {
    source: currentSource,
    pullNumber,
    event = process.env.GITHUB_EVENT_NAME,
  }: { source: NativeBuildSource; pullNumber?: number; event?: string },
  { read = requestGithubRepositoryJson, pages = requestGithubPages, gitDirectory = ROOT } = {},
): Promise<
  | {
      pullNumber: number;
      prepareSourceCommit: string;
      sourcePolicy?: { subject: string; base: string; head: string; branch: string };
    }
  | undefined
> {
  source(currentSource);
  let pull;
  if (pullNumber !== undefined) {
    assert.ok(Number.isSafeInteger(pullNumber) && pullNumber > 0);
    pull = await read(`repos/${repository}/pulls/${pullNumber}`);
    assert.equal(pull.number, pullNumber);
    if (pull.head?.ref !== 'release-please--branches--main') return undefined;
  } else {
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: gitDirectory, encoding: 'utf8' }).trim();
    assert.equal(
      git('rev-parse', `${currentSource.commit}^{tree}`),
      currentSource.tree,
      'native input context source tree differs',
    );
    const parents = git('rev-list', '--parents', '-n', '1', currentSource.commit)
      .split(/\s+/u)
      .slice(1);
    if (
      event !== 'merge_group' &&
      (!parents.length ||
        !git(
          'diff',
          '--name-only',
          parents[0],
          currentSource.commit,
          '--',
          '.release-please-manifest.json',
        ))
    )
      return undefined;
    const matches = (
      await pages(`repos/${repository}/commits/${currentSource.commit}/pulls`)
    ).filter(
      (row) =>
        (event === 'merge_group'
          ? row.state === 'open' && !row.merged_at
          : row.merged_at && row.merge_commit_sha === currentSource.commit) &&
        row.head?.ref === 'release-please--branches--main',
    );
    if (
      event === 'merge_group' &&
      matches.length === 0 &&
      parents.length > 0 &&
      !git(
        'diff',
        '--name-only',
        parents[0],
        currentSource.commit,
        '--',
        '.release-please-manifest.json',
      )
    )
      return undefined; // Ordinary queues use the source-bound public input path.
    assert.equal(
      matches.length,
      1,
      event === 'merge_group'
        ? 'queued source requires one canonical open release PR'
        : 'versioned main source requires one canonical merged release PR',
    );
    pull = matches[0];
  }
  assert.ok(
    pull.base?.ref === 'main' &&
      pull.base?.repo?.full_name === repository &&
      pull.head?.repo?.full_name === repository,
    'native input context requires the canonical release PR',
  );
  const commit = await read(`repos/${repository}/git/commits/${pull.head.sha}`);
  assert.equal(commit.sha, pull.head.sha);
  const preparedSource = { commit: commit.sha, tree: commit.tree?.sha };
  source(preparedSource);
  assert.equal(
    preparedSource.tree,
    currentSource.tree,
    event === 'merge_group'
      ? 'mixed merge queue source differs from the release PR tree; refresh the release PR against the queue base'
      : 'native release input context differs from the PR tree',
  );
  assert.ok(
    Array.isArray(commit.parents) && commit.parents.length === 1,
    'native prepared PR requires one exact source parent',
  );
  assert.match(commit.parents[0].sha, /^[a-f0-9]{40}$/u);
  const result = { pullNumber: pull.number, prepareSourceCommit: commit.parents[0].sha };
  if (event !== 'merge_group') return result;
  const subject = commit.message?.split(/\r?\n/u)[0];
  assert.ok(
    typeof subject === 'string' && subject && !/[\u0000-\u001f\u007f]/u.test(subject),
    'queued release commit requires an exact safe source policy subject',
  );
  return {
    ...result,
    sourcePolicy: {
      subject,
      base: commit.parents[0].sha,
      head: preparedSource.commit,
      branch: pull.head.ref,
    },
  };
}

/** Structural parsing alone grants neither supplier nor producer authority. */
export function parseNativeReleaseInputRecord(value: NativeReleaseInputRecord) {
  fields(value, ['bridge', 'selectedProducts', 'preparedSource', 'buildBound']);
  validateNativeVersionSourceBridge(value.bridge);
  source(value.preparedSource);
  const products = loadProducts();
  assert.ok(Array.isArray(value.selectedProducts) && value.selectedProducts.length > 0);
  assert.deepEqual(value.selectedProducts, [...new Set(value.selectedProducts)].sort());
  for (const product of value.selectedProducts) assert.ok(Object.hasOwn(products, product));
  assert.ok(Array.isArray(value.buildBound));
  const buildBound = new Map<string, Set<string>>();
  for (const row of value.buildBound) {
    assert.ok(
      Array.isArray(row) && row.length === 2 && typeof row[0] === 'string' && Array.isArray(row[1]),
    );
    assert.deepEqual(row[1], [...new Set(row[1])].sort());
    assert.ok(!buildBound.has(row[0]), 'native supplier transport repeats an owner');
    buildBound.set(row[0], new Set(row[1]));
  }
  resolveBuildBoundCompatibilityProducts(products, { buildBound });
  assert.deepEqual(
    value.buildBound.map(([id]) => id),
    Object.keys(products).sort(),
  );
  return { record: structuredClone(value), buildBound };
}

const relativeFile = (file: { path: string; size: number; sha256: string }) => {
  assert.match(file.sha256, /^[a-f0-9]{64}$/u);
  const name = path.basename(file.path);
  assert.match(name, /^[A-Za-z0-9][A-Za-z0-9._-]*$/u);
  return path.join('files', file.sha256, name);
};
function mapSeedFiles(
  controls: NativeSeedInputControl[],
  map: (file: { path: string; size: number; sha256: string }) => {
    path: string;
    size: number;
    sha256: string;
  },
) {
  return controls.map((row) => {
    if (row.promotion)
      return {
        ...row,
        promotion: {
          ...row.promotion,
          frozen: map(row.promotion.frozen),
          receipt: map(row.promotion.receipt),
        },
      };
    assert.ok(row.reuse);
    return {
      ...row,
      reuse: {
        ...row.reuse,
        archive: map(row.reuse.archive),
        manifest: map(row.reuse.manifest),
        ...(row.reuse.metadata ? { metadata: map(row.reuse.metadata) } : {}),
        ...(row.reuse.anchor ? { anchor: map(row.reuse.anchor) } : {}),
      },
    };
  });
}

function copyInputFile(file: { path: string; size: number; sha256: string }, destination: string) {
  const before = fileIdentity(file.path);
  assert.deepEqual(
    { size: before.size, sha256: before.sha256 },
    { size: file.size, sha256: file.sha256 },
    'native input File changed before transport',
  );
  const output = path.join(destination, relativeFile(file));
  mkdirSync(path.dirname(output), { recursive: true });
  if (!existsSync(output)) copyFileSync(file.path, output);
  const actual = fileIdentity(output);
  assert.deepEqual(
    { size: actual.size, sha256: actual.sha256 },
    { size: file.size, sha256: file.sha256 },
    'transported native seed File differs',
  );
  return { ...file, path: output };
}
function copySeedFiles(controls: NativeSeedInputControl[], destination: string) {
  return mapSeedFiles(controls, (file) => copyInputFile(file, destination));
}
function mapSupplierFiles(
  rows: NativeSupplierArtifact[],
  map: (file: NativeSupplierArtifact['file']) => NativeSupplierArtifact['file'],
) {
  return validateNativeSupplierArtifacts(rows).map((row) => ({ ...row, file: map(row.file) }));
}
function assertSupplierFiles(value: unknown, publications: CompletedPublication[]) {
  const rows = validateNativeSupplierArtifacts(value);
  for (const row of rows) {
    const matches = publications.filter(
      (publication) =>
        publication.product === row.publication.product &&
        publication.version === row.publication.version,
    );
    assert.equal(matches.length, 1, 'retained supplier lacks its unique completed origin');
    assert.deepEqual(row.publication, matches[0], 'retained supplier origin differs');
    const file = fileIdentity(row.file.path);
    assert.deepEqual(
      { size: file.size, sha256: file.sha256 },
      { size: row.file.size, sha256: row.file.sha256 },
      'retained supplier File bytes differ',
    );
  }
  return rows;
}

function assertFinalInputFiles(inputs: NativeReleaseFinalInputs & { source?: NativeBuildSource }) {
  if (inputs.nativeCurrentArtifacts !== undefined) {
    const source = inputs.source ?? inputs.nativeCurrentArtifacts[0]?.source;
    projectNativeCurrentArtifacts(inputs.nativeCurrentArtifacts, source);
  }
  if (inputs.extensionFinalInputs !== undefined)
    projectNativeExtensionFinalInputs(inputs.extensionFinalInputs);
  if (inputs.nativeAppleBase !== undefined) projectNativeAppleBaseInput(inputs.nativeAppleBase);
  if (inputs.nativeSwiftSource !== undefined)
    projectNativeSwiftSourceInput(inputs.nativeSwiftSource);
}
function mapFinalInputFiles(
  inputs: NativeReleaseFinalInputs,
  map: (file: ExtensionFinalInputFile) => ExtensionFinalInputFile,
): NativeReleaseFinalInputs {
  return {
    ...(inputs.nativeCurrentArtifacts === undefined
      ? {}
      : {
          nativeCurrentArtifacts: inputs.nativeCurrentArtifacts.map((row) => ({
            ...row,
            file: map(row.file),
          })),
        }),
    ...(inputs.extensionFinalInputs === undefined
      ? {}
      : {
          extensionFinalInputs: inputs.extensionFinalInputs.map((row) => ({
            ...row,
            github: row.github.map(map),
            npm: row.npm.map(map),
            cargo: row.cargo.map(map),
            manifest: map(row.manifest),
            frozen: map(row.frozen),
          })),
        }),
    ...(inputs.nativeAppleBase === undefined
      ? {}
      : {
          nativeAppleBase: {
            ...inputs.nativeAppleBase,
            file: map(inputs.nativeAppleBase.file),
            framework: map(inputs.nativeAppleBase.framework),
            resources: map(inputs.nativeAppleBase.resources),
          },
        }),
    ...(inputs.nativeSwiftSource === undefined
      ? {}
      : {
          nativeSwiftSource: {
            ...inputs.nativeSwiftSource,
            archive: map(inputs.nativeSwiftSource.archive),
            carrier: map(inputs.nativeSwiftSource.carrier),
            ownerCatalog: map(inputs.nativeSwiftSource.ownerCatalog),
            bindingsArchive: map(inputs.nativeSwiftSource.bindingsArchive),
          },
        }),
  };
}

/** Public input snapshots transport facts, never current producer or version authority. */
function publicInputSnapshot(file: string, currentSource: NativeBuildSource) {
  const snapshot = readJson(file);
  fields(snapshot, [
    'source',
    'seedControls',
    'supplierPublications',
    ...(Object.hasOwn(snapshot, 'supplierArtifacts') ? ['supplierArtifacts'] : []),
    ...(Object.hasOwn(snapshot, 'selectedProducts') ? ['selectedProducts'] : []),
    ...finalInputFields(snapshot),
  ]);
  source(snapshot.source);
  assert.deepEqual(snapshot.source, currentSource, 'public native inputs source differs');
  assert.ok(Array.isArray(snapshot.seedControls) && Array.isArray(snapshot.supplierPublications));
  assert.ok(
    snapshot.seedControls.every((row: NativeSeedInputControl) => row.reuse && !row.promotion),
    'public native inputs cannot promote a current construction',
  );
  const products = loadProducts();
  if (Object.hasOwn(snapshot, 'selectedProducts')) {
    assert.ok(Array.isArray(snapshot.selectedProducts));
    assert.deepEqual(snapshot.selectedProducts, [...new Set(snapshot.selectedProducts)].sort());
    for (const product of snapshot.selectedProducts) assert.ok(Object.hasOwn(products, product));
  }
  const seen = new Set<string>();
  for (const publication of snapshot.supplierPublications as CompletedPublication[]) {
    fields(publication, [
      'product',
      'version',
      'tagName',
      'publicationSha',
      'publicationTree',
      'releaseSha',
    ]);
    assert.ok(Object.hasOwn(products, publication.product), 'public input supplier owner differs');
    assert.match(publication.version, /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u);
    assert.equal(publication.tagName, `${publication.product}-v${publication.version}`);
    for (const value of [
      publication.publicationSha,
      publication.publicationTree,
      publication.releaseSha,
    ])
      assert.match(value, /^[a-f0-9]{40}$/u);
    const key = `${publication.product}@${publication.version}`;
    assert.ok(!seen.has(key), 'public input supplier origin is duplicated');
    seen.add(key);
  }
  validateNativeSupplierArtifacts(snapshot.supplierArtifacts ?? []);
  return snapshot;
}

/** One acquisition can supply isolated jobs through the existing SHA-addressed File pool. */
export function transportPublicNativePublicationInputs(
  file: string,
  directory: string,
  currentSource: NativeBuildSource,
) {
  source(currentSource);
  const snapshot = publicInputSnapshot(file, currentSource);
  projectNativeSeedInputs(snapshot.seedControls, currentSource);
  const suppliers = assertSupplierFiles(
    snapshot.supplierArtifacts ?? [],
    snapshot.supplierPublications,
  );
  assertFinalInputFiles(snapshot);
  const destination = path.resolve(directory);
  requireSafeDirectoryChain(path.dirname(destination), {
    create: true,
    label: 'public native input transport',
  });
  assert.ok(!existsSync(destination), 'public native input transport needs an owned directory');
  mkdirSync(destination);
  try {
    const seedControls = copySeedFiles(snapshot.seedControls, destination);
    const supplierArtifacts = mapSupplierFiles(suppliers, (file) =>
      copyInputFile(file, destination),
    );
    const finalInputs = mapFinalInputFiles(snapshot, (file) => ({
      ...file,
      ...copyInputFile(file, destination),
    }));
    projectNativeSeedInputs(seedControls, currentSource);
    assertFinalInputFiles(finalInputs);
    const result = path.join(destination, 'native-publication-inputs.json');
    writeJson(result, {
      ...snapshot,
      seedControls,
      ...(Object.hasOwn(snapshot, 'supplierArtifacts') ? { supplierArtifacts } : {}),
      ...finalInputs,
    });
    return result;
  } catch (error) {
    rmSync(destination, { recursive: true, force: true });
    throw error;
  }
}

/** Same-source relocation derives local paths from File identity, ignoring producer paths. */
export function importPublicNativePublicationInputs(
  directory: string,
  currentSource: NativeBuildSource,
) {
  source(currentSource);
  const snapshot = publicInputSnapshot(
    path.join(directory, 'native-publication-inputs.json'),
    currentSource,
  );
  const seedControls = mapSeedFiles(snapshot.seedControls, (file) => ({
    ...file,
    path: path.join(path.resolve(directory), relativeFile(file)),
  }));
  projectNativeSeedInputs(seedControls, currentSource);
  const supplierArtifacts = mapSupplierFiles(snapshot.supplierArtifacts ?? [], (file) => ({
    ...file,
    path: path.join(path.resolve(directory), relativeFile(file)),
  }));
  assertSupplierFiles(supplierArtifacts, snapshot.supplierPublications);
  const finalInputs = mapFinalInputFiles(snapshot, (file) => ({
    ...file,
    path: path.join(path.resolve(directory), relativeFile(file)),
  }));
  assertFinalInputFiles(finalInputs);
  const output = path.join(directory, 'native-publication-inputs-current.json');
  writeJson(output, {
    ...snapshot,
    seedControls,
    ...(Object.hasOwn(snapshot, 'supplierArtifacts') ? { supplierArtifacts } : {}),
    ...finalInputs,
  });
  return output;
}
function assertPromotedReceipt(row: NativeSeedInputControl) {
  assert.ok(row.promotion, 'prepared seed inputs must retain a qualified construction');
  const receipt = validateSeedConstructionReceipt(readJson(row.promotion.receipt.path));
  assert.deepEqual(receipt.frozen, {
    size: row.promotion.frozen.size,
    sha256: row.promotion.frozen.sha256,
  });
  assert.equal(receipt.intent.family, row.family);
  assert.equal(receipt.intent.target, row.target);
  assert.equal(receipt.intent.profile, row.profile);
}

/** Retain original source-specific Files while their authenticated origins still live in the coordinator. */
export function writeNativeReleaseInputs(
  directory: string,
  record: NativeReleaseInputRecord,
  seedControls: NativeSeedInputControl[],
  supplierPublications: CompletedPublication[],
  supplierArtifacts: NativeSupplierArtifact[] = [],
  finalInputs: NativeReleaseFinalInputs = {},
) {
  parseNativeReleaseInputRecord(record);
  projectNativeSeedInputs(seedControls, record.preparedSource);
  assertSupplierFiles(supplierArtifacts, supplierPublications);
  fields(finalInputs, finalInputFields(finalInputs));
  assertFinalInputFiles(finalInputs);
  for (const row of seedControls) {
    assertPromotedReceipt(row);
    assert.deepEqual(row.promotion?.source, record.bridge.source);
    assert.deepEqual(row.promotion?.transition, {
      source: record.preparedSource,
      updatesSha256: record.bridge.updatesSha256,
    });
  }
  const destination = path.resolve(directory);
  requireSafeDirectoryChain(path.dirname(destination), {
    create: true,
    label: 'native release inputs',
  });
  assert.ok(!existsSync(destination), 'native release inputs need a new owned directory');
  mkdirSync(destination);
  try {
    const controls = copySeedFiles(seedControls, destination);
    const retainedFinalInputs = mapFinalInputFiles(finalInputs, (file) => ({
      ...file,
      ...copyInputFile(file, destination),
    }));
    projectNativeSeedInputs(controls, record.preparedSource);
    assertFinalInputFiles(retainedFinalInputs);
    writeJson(path.join(destination, 'native-version-source.json'), record);
    writeJson(path.join(destination, 'native-publication-inputs.json'), {
      source: record.preparedSource,
      selectedProducts: record.selectedProducts,
      seedControls: controls,
      supplierPublications,
      ...retainedFinalInputs,
      ...(supplierArtifacts.length
        ? {
            supplierArtifacts: mapSupplierFiles(supplierArtifacts, (file) =>
              copyInputFile(file, destination),
            ),
          }
        : {}),
    });
    return path.join(destination, 'native-publication-inputs.json');
  } catch (error) {
    rmSync(destination, { recursive: true, force: true });
    throw error;
  }
}

/** Exact authenticated packet bytes are relocated; original absolute paths never locate Files. */
export function relocateNativeReleaseInputs(
  directory: string,
  record: NativeReleaseInputRecord,
  currentSource = record.preparedSource,
) {
  const snapshot = readJson(path.join(directory, 'native-publication-inputs.json'));
  fields(snapshot, [
    'source',
    'selectedProducts',
    'seedControls',
    'supplierPublications',
    ...(Object.hasOwn(snapshot, 'supplierArtifacts') ? ['supplierArtifacts'] : []),
    ...finalInputFields(snapshot),
  ]);
  assert.deepEqual(snapshot.source, record.preparedSource, 'prepared importer source differs');
  assert.deepEqual(
    snapshot.selectedProducts,
    record.selectedProducts,
    'prepared importer selected products differ',
  );
  assert.ok(Array.isArray(snapshot.seedControls) && Array.isArray(snapshot.supplierPublications));
  const controls = mapSeedFiles(snapshot.seedControls, (file) => ({
    ...file,
    path: path.join(directory, relativeFile(file)),
  }));
  const supplierArtifacts = mapSupplierFiles(snapshot.supplierArtifacts ?? [], (file) => ({
    ...file,
    path: path.join(directory, relativeFile(file)),
  }));
  assertSupplierFiles(supplierArtifacts, snapshot.supplierPublications);
  const finalInputs = mapFinalInputFiles(snapshot, (file) => ({
    ...file,
    path: path.join(path.resolve(directory), relativeFile(file)),
  }));
  assertFinalInputFiles(finalInputs);
  projectNativeSeedInputs(controls, record.preparedSource);
  for (const row of controls) {
    assertPromotedReceipt(row);
    assert.deepEqual(
      row.promotion?.source,
      record.bridge.source,
      'promoted constructor source differs',
    );
    assert.deepEqual(row.promotion?.transition, {
      source: record.preparedSource,
      updatesSha256: record.bridge.updatesSha256,
    });
    if (row.promotion) row.promotion.transition.source = structuredClone(currentSource);
  }
  projectNativeSeedInputs(controls, currentSource);
  return {
    ...snapshot,
    source: structuredClone(currentSource),
    seedControls: controls,
    ...(Object.hasOwn(snapshot, 'supplierArtifacts') ? { supplierArtifacts } : {}),
    ...finalInputs,
  };
}

/** Only the canonical reviewed-main Prepare job and independently read PR head supply authority. */
export async function acquirePreparedNativeReleaseInputs(
  {
    runId,
    pullNumber,
    source: currentSource,
    directory,
  }: { runId: number; pullNumber: number; source: NativeBuildSource; directory: string },
  { read = requestGithubRepositoryJson, download = execute, gitDirectory = ROOT } = {},
) {
  for (const id of [runId, pullNumber]) assert.ok(Number.isSafeInteger(id) && id > 0);
  source(currentSource);
  const [run, pull] = await Promise.all([
    read(`repos/${repository}/actions/runs/${runId}`),
    read(`repos/${repository}/pulls/${pullNumber}`),
  ]);
  assert.ok(
    run.id === runId &&
      run.event === 'workflow_dispatch' &&
      run.head_branch === 'main' &&
      Number.isSafeInteger(run.run_attempt) &&
      run.run_attempt > 0,
    'native prepared inputs require the canonical main dispatch',
  );
  assert.ok(
    pull.number === pullNumber &&
      pull.base?.ref === 'main' &&
      pull.base?.repo?.full_name === repository &&
      pull.head?.repo?.full_name === repository &&
      pull.head?.ref === 'release-please--branches--main',
    'native prepared inputs require the canonical release PR',
  );
  const commits = await Promise.all(
    [run.head_sha, pull.head.sha].map((sha) => read(`repos/${repository}/git/commits/${sha}`)),
  );
  const [codeSource, preparedSource] = commits.map((commit, index) => {
    assert.equal(commit.sha, index === 0 ? run.head_sha : pull.head.sha);
    const value = { commit: commit.sha, tree: commit.tree?.sha };
    source(value);
    return value;
  });
  assert.deepEqual(
    commits[1].parents?.map((parent) => parent.sha),
    [codeSource.commit],
    'native prepared release PR must have the exact source as its sole parent',
  );
  const destination = path.resolve(directory);
  requireSafeDirectoryChain(path.dirname(destination), {
    create: true,
    label: 'prepared native input acquisition',
  });
  assert.ok(!existsSync(destination), 'prepared native inputs need a new owned directory');
  const scratch = mkdtempSync(path.join(tmpdir(), 'native-prepared-origin-'));
  try {
    const snapshots = path.join(scratch, 'snapshots');
    await download(
      'bash',
      [
        path.join(ROOT, '.github/scripts/download-build-artifacts.sh'),
        'Release',
        codeSource.commit,
        destination,
        '--run-id',
        String(runId),
        '--job',
        'Prepare release PR',
        '--job-success-only',
        '--workflow-path',
        '.github/workflows/release.yml',
        '--event',
        'workflow_dispatch',
        '--ref',
        'refs/heads/main',
        '--run-attempt',
        String(run.run_attempt),
        '--source-tree',
        codeSource.tree,
        '--artifact',
        nativeReleaseInputsArtifact,
      ],
      {
        cwd: ROOT,
        env: { ...process.env, GH_REPO: repository, OLIPHAUNT_GITHUB_RUN_SNAPSHOT_DIR: snapshots },
        maxBuffer: 1024 * 1024,
      },
    );
    const origin = readJson(path.join(snapshots, `run-${runId}.json`));
    assert.equal(origin.repo, repository);
    assert.equal(String(origin.runId), String(runId));
    assert.equal(origin.headSha, codeSource.commit);
    assert.equal(origin.headTree, codeSource.tree);
    assert.equal(origin.workflowName, 'Release');
    assert.equal(origin.workflowPath, '.github/workflows/release.yml');
    assert.equal(origin.runAttempt, run.run_attempt);
    assert.equal(origin.event, 'workflow_dispatch');
    assert.equal(origin.headBranch, 'main');
    const jobs = origin.jobs.filter((row) => row.name === 'Prepare release PR');
    assert.equal(jobs.length, 1);
    assert.ok(
      jobs[0].status === 'completed' && jobs[0].conclusion === 'success',
      'native Prepare producer did not complete successfully',
    );
    const artifacts = origin.artifacts.filter(
      (row) => row.name === nativeReleaseInputsArtifact && row.expired === false,
    );
    assert.equal(artifacts.length, 1);
    assert.ok(
      Number.isSafeInteger(artifacts[0].id) &&
        artifacts[0].id > 0 &&
        Number.isSafeInteger(artifacts[0].size_in_bytes) &&
        artifacts[0].size_in_bytes > 0,
    );
    assert.match(artifacts[0].digest, /^sha256:[a-f0-9]{64}$/u);
    const { record, buildBound } = parseNativeReleaseInputRecord(
      readJson(path.join(destination, 'native-version-source.json')),
    );
    assert.deepEqual(record.bridge.source, codeSource, 'native Prepare code source differs');
    // The existing publisher preserves an old head on a no-op rerun. Its exact
    // tree and parent, rather than a local commit timestamp, identify the output.
    assert.equal(
      record.preparedSource.tree,
      preparedSource.tree,
      'native Prepare release PR tree differs',
    );
    assertNativeVersionSourceTransition(record.bridge, currentSource, gitDirectory);
    assert.equal(
      currentSource.tree,
      preparedSource.tree,
      'native prepared candidate tree differs from the qualified release PR',
    );
    const gitJson = (tree: string, file: string) =>
      JSON.parse(
        execFileSync('git', ['show', `${tree}:${file}`], {
          cwd: gitDirectory,
          encoding: 'utf8',
          maxBuffer: 64 * 1024 * 1024,
        }),
      );
    assert.deepEqual(
      record.selectedProducts,
      releaseProductsFromManifests(
        gitJson(currentSource.tree, 'release-please-config.json'),
        gitJson(record.bridge.source.tree, '.release-please-manifest.json'),
        gitJson(currentSource.tree, '.release-please-manifest.json'),
      ),
      'authenticated prepared product set differs from committed versions',
    );
    const snapshot = relocateNativeReleaseInputs(destination, record, currentSource);
    const snapshotFile = path.join(destination, 'native-publication-inputs-current.json');
    writeJson(snapshotFile, snapshot);
    const result = {
      snapshotFile,
      record,
      buildBound,
      origin: {
        runId,
        runAttempt: run.run_attempt,
        artifact: artifacts[0],
        codeSource,
        preparedSource,
      },
    };
    // Controlled transport fixtures cannot mint production admission capability.
    if (download === execute && read === requestGithubRepositoryJson) {
      Object.freeze(result.record);
      Object.freeze(result.origin);
      Object.freeze(result);
      const file = fileIdentity(snapshotFile);
      acquiredPreparedInputs.set(result, {
        digest: preparedDigest(result),
        file: { size: file.size, sha256: file.sha256 },
      });
    }
    return result;
  } catch (error) {
    rmSync(destination, { recursive: true, force: true });
    throw error;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      'run-id': { type: 'string' },
      'pull-number': { type: 'string' },
      'output-directory': { type: 'string' },
      'resolve-context': { type: 'boolean' },
      'transport-public-inputs': { type: 'string' },
      'import-public-inputs': { type: 'string' },
    },
    strict: true,
  });
  if (values['transport-public-inputs'] || values['import-public-inputs']) {
    assert.ok(
      !values['resolve-context'] &&
        !values['run-id'] &&
        !values['pull-number'] &&
        Boolean(values['transport-public-inputs']) !== Boolean(values['import-public-inputs']) &&
        Boolean(values['output-directory']) === Boolean(values['transport-public-inputs']),
      'public input transport needs exactly one export or import operation',
    );
    const currentSource = sourceIdentity('HEAD');
    console.log(
      values['transport-public-inputs']
        ? transportPublicNativePublicationInputs(
            values['transport-public-inputs'],
            values['output-directory']!,
            currentSource,
          )
        : importPublicNativePublicationInputs(values['import-public-inputs']!, currentSource),
    );
  } else if (values['resolve-context']) {
    assert.ok(
      values['run-id'] === undefined &&
        values['output-directory'] === undefined &&
        (values['pull-number'] === undefined || /^[1-9][0-9]*$/u.test(values['pull-number'])),
      'native context lookup accepts only an optional pull number',
    );
    const context = await resolveNativeReleaseInputContext({
      source: sourceIdentity('HEAD'),
      ...(values['pull-number'] === undefined ? {} : { pullNumber: Number(values['pull-number']) }),
    });
    const output = [
      `native_inputs=${Boolean(context)}`,
      ...(context
        ? [`pull_number=${context.pullNumber}`, `prepare_source_sha=${context.prepareSourceCommit}`]
        : []),
      ...(context?.sourcePolicy
        ? Object.entries(context.sourcePolicy).map(
            ([key, value]) => `source_policy_${key}=${value}`,
          )
        : []),
      '',
    ].join('\n');
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, output);
    else process.stdout.write(output);
  } else {
    assert.ok(
      values['output-directory'] &&
        /^[1-9][0-9]*$/u.test(values['run-id'] ?? '') &&
        /^[1-9][0-9]*$/u.test(values['pull-number'] ?? ''),
      'usage: native-release-inputs.mts --run-id ID --pull-number NUMBER --output-directory DIR',
    );
    const result = await acquirePreparedNativeReleaseInputs({
      runId: Number(values['run-id']),
      pullNumber: Number(values['pull-number']),
      source: sourceIdentity('HEAD'),
      directory: values['output-directory'],
    });
    console.log(result.snapshotFile);
  }
}
