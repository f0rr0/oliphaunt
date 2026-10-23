#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { readPortableArchiveEntries } from '../packaging/portable-archive.mts';
import { canonicalShippingLabel } from '../release/bazel-shipping-inputs.mts';
import {
  boundedResponseBytes,
  latestGithubJob,
  requestGithubDownload,
  requestGithubPages,
  requestGithubRepositoryJson,
} from '../release/github-read.mts';
import {
  assertNativeBuildGithub,
  type NativeBuildEvidence,
  type NativeBuildGithub,
  type NativeBuildSource,
  nativeBuildEventIndex as indexNativeBep,
  nativeBuildMetadata,
} from '../release/native-build-qualification.mts';
import { configuredRecipeGraph } from '../release/native-configured-inputs.mts';
import { collectBazelRecordedSourceInputs } from './bazel-recorded-inputs.mts';
import {
  type NativeImportedRoot,
  createNativeImportProjection,
  isNativeImportSourceLabel,
} from './native-import-projection.mts';

type NativeOutputProjection = NativeImportedRoot & {
  files: string[];
  importedRoots?: NativeImportedRoot[];
};
export type ConfiguredCiProjection = {
  roots: { label: string; configuration: string }[];
  files: string[];
  trees: string[];
  directories: string[];
  analysisInputs: string[];
  importedRoots?: NativeImportedRoot[];
  nativeOutputs?: NativeOutputProjection[];
};
export type ConfiguredCiRequest = {
  schema: 'oliphaunt-ci-request-v1';
  id: string;
  job: string;
  mode: 'full' | 'source';
  status: 'success';
  source: NativeBuildSource;
  github: NativeBuildGithub;
  requires: string[];
  fullOnly?: boolean;
  projection?: ConfiguredCiProjection;
};
export type ConfiguredCiBasis = {
  schema: 'oliphaunt-ci-basis-v1';
  source: NativeBuildSource;
  github: NativeBuildGithub;
  controllerInputs: string[];
  requests: ConfiguredCiRequest[];
};
export type ConfiguredCiPlan = {
  schema: 'oliphaunt-ci-plan-v1';
  mode: 'full' | 'source';
  source: NativeBuildSource;
  basisSource?: NativeBuildSource;
  basisDigest?: string;
  selected_requests: string[];
  selected_jobs: string[];
  capture_requests: string[];
};
type RequestIdentity = { id: string; job: string; requires: string[]; fullOnly?: boolean };
type SourceChange = { path: string; kind: string; oldMode?: string; newMode?: string };
const WORKFLOW = '.github/workflows/bazel.yml';
const SHA = /^[a-f0-9]{40}$/u;
const CONFIG = /^[a-f0-9]{64}$/u;
const ordered = (values: Iterable<string>) => [...new Set(values)].sort();
const json = (file: string) => JSON.parse(readFileSync(file, 'utf8'));
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const importedRootKey = (value: NativeImportedRoot) =>
  JSON.stringify([
    value.root,
    value.configuration,
    value.evidenceDigest,
    value.invocationId,
    value.output,
  ]);
const orderedImportedRoots = <T extends NativeImportedRoot>(values: T[]): T[] =>
  [...new Map(values.map((value) => [importedRootKey(value), value])).entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, value]) => value);
const requestIdentity = ({ id, job, requires, fullOnly }: RequestIdentity) => ({
  id,
  job,
  requires,
  fullOnly: fullOnly === true,
});

function fullOnlyAnnotation(value: unknown) {
  assert(
    value === undefined || value === 'true' || value === 'false',
    'CI full-only annotation is invalid',
  );
  return value === 'true';
}

function identity(value: string) {
  assert(
    typeof value === 'string' && /^[a-z0-9][a-z0-9_./-]*$/u.test(value),
    'CI request identity is invalid',
  );
  assert(
    !value.split('/').some((part) => !part || part === '.' || part === '..'),
    'CI request identity escapes',
  );
  return value;
}
function sourcePath(value: string, root = false) {
  assert(typeof value === 'string' && (root || value.length > 0), 'CI source path is missing');
  assert(
    !path.posix.isAbsolute(value) && !/[\\\u0000-\u001f\u007f]/u.test(value),
    'CI source path is invalid',
  );
  assert(
    value === '' || !value.split('/').some((part) => !part || part === '.' || part === '..'),
    'CI source path escapes',
  );
  return value;
}
function workspacePath(label: string) {
  label = canonicalShippingLabel(label);
  if (!label.startsWith('//')) return undefined;
  const separator = label.indexOf(':');
  assert(separator >= 2, 'CI source label is not explicit');
  return sourcePath(
    [label.slice(2, separator), label.slice(separator + 1)].filter(Boolean).join('/'),
  );
}
function explicitTarget(value: string) {
  value = canonicalShippingLabel(value);
  assert(/^(?:@@?[^/]+)?\/\/[^\s:]*:[^\s]+$/u.test(value), 'CI target is not an explicit label');
  return value;
}
function repository(label: string) {
  if (label.startsWith('//')) return undefined;
  const match = /^@@([^/]+)\/\//u.exec(label);
  assert(match, 'CI acquisition requires canonical external labels');
  return match[1];
}
function git(root: string, ...args: string[]) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
}
function currentSource(root: string): NativeBuildSource {
  return {
    commit: git(root, 'rev-parse', 'HEAD^{commit}').trim(),
    tree: git(root, 'rev-parse', 'HEAD^{tree}').trim(),
  };
}
function validSource(source: NativeBuildSource) {
  assert(SHA.test(source?.commit) && SHA.test(source?.tree), 'CI source identity is invalid');
}

/** Reuse the existing source replay guard, including index suppression checks. */
export function assertConfiguredCiSource(workspaceRoot: string, source: NativeBuildSource) {
  validSource(source);
  execFileSync(
    'bash',
    ['tools/release/qualified-release-replay.sh', source.commit, source.commit],
    {
      cwd: workspaceRoot,
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  );
  assert.deepEqual(currentSource(workspaceRoot), source, 'CI source changed during execution');
}

type CiSuccess = {
  id: string;
  job: string;
  source: NativeBuildSource;
  github: NativeBuildGithub;
  requires?: string[];
  fullOnly?: boolean;
  outputDirectory: string;
  workspaceRoot?: string;
};
function successRecord(request: CiSuccess, mode: 'full' | 'source'): ConfiguredCiRequest {
  validSource(request.source);
  assertNativeBuildGithub(request.github);
  const fullOnly = request.fullOnly ?? fullOnlyAnnotation(process.env.CI_FULL_ONLY);
  assert(!fullOnly || mode === 'full', 'full-only CI request cannot emit a source receipt');
  return {
    schema: 'oliphaunt-ci-request-v1',
    id: identity(request.id),
    job: identity(request.job),
    mode,
    status: 'success',
    source: request.source,
    github: request.github,
    requires: ordered((request.requires ?? []).map(identity)),
    ...(fullOnly ? { fullOnly: true } : {}),
  };
}
function writeReceipt(request: CiSuccess, record: ConfiguredCiRequest) {
  assertConfiguredCiSource(request.workspaceRoot ?? process.cwd(), request.source);
  mkdirSync(request.outputDirectory, { recursive: true });
  const file = path.join(request.outputDirectory, 'ci-request.json');
  writeFileSync(file, `${JSON.stringify(record)}\n`, { flag: 'wx', mode: 0o600 });
  return file;
}
export function writeConfiguredCiSuccessReceipt(request: CiSuccess) {
  return writeReceipt(request, successRecord(request, 'source'));
}

type RecipeQuery = { packages: string[]; labels: string[] };
export type ConfiguredCiCapture = CiSuccess & {
  configuration: string[];
  startup: string[];
  requestedTargets: string[];
  completedRoots: { label: string; configuration: string }[];
  executionRoot: string;
  /** Existing qualifier supplies the same post-build query after update-mode persistence. */
  configuredGraph?: unknown;
  recipeQueries?: RecipeQuery[];
  /** Original serialized shipping packet produced by this qualifier invocation. */
  nativeEvidence?: string;
};

/** Complete source-only projection; no action command lines or environments are serialized. */
export async function captureConfiguredCiRequest(
  request: ConfiguredCiCapture,
  execution?: {
    bazel(args: string[], stdout: string): Promise<void>;
    assertRunning(): void;
  },
) {
  execution?.assertRunning();
  const root = request.workspaceRoot ?? process.cwd();
  assertConfiguredCiSource(root, request.source);
  const roots = request.completedRoots.map((value) => {
    assert(CONFIG.test(value.configuration), 'CI completion lacks a pinned configuration checksum');
    // Pinned BEP Label.toString uses canonical single-@; consistent cquery uses @@.
    const label = explicitTarget(value.label).replace(/^@(?=[^@])/u, '@@');
    return { label, configuration: value.configuration };
  });
  assert(
    roots.length &&
      new Set(roots.map((value) => `${value.label}\0${value.configuration}`)).size === roots.length,
    'CI actual completions are missing or duplicated',
  );
  const output = path.resolve(request.outputDirectory);
  mkdirSync(output, { recursive: true });
  const sourceLock = readFileSync(path.join(root, 'MODULE.bazel.lock'));
  const run = async (args: string[]) => {
    execution?.assertRunning();
    const temporary = mkdtempSync(path.join(output, '.query-'));
    const stdout = path.join(temporary, 'stdout');
    let descriptor: number | undefined;
    try {
      if (execution) await execution.bazel(args, stdout);
      else {
        descriptor = openSync(stdout, 'wx', 0o600);
        const result = spawnSync('bash', ['tools/dev/bazel.sh', ...request.startup, ...args], {
          cwd: root,
          stdio: ['ignore', descriptor, 'inherit'],
        });
        if (result.error) throw result.error;
        if (result.status !== 0)
          throw new Error(`CI ${args[0]} failed (${result.signal ?? result.status})`);
      }
      execution?.assertRunning();
      return readFileSync(stdout, 'utf8');
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      rmSync(temporary, { recursive: true, force: true });
    }
  };
  const expression = (names: string[]) =>
    `set(${ordered(names)
      .map((name) => JSON.stringify(name))
      .join(' ')})`;
  const queryFile = (name: string, value: string) => {
    const file = path.join(output, name);
    writeFileSync(file, value, { flag: 'wx' });
    return `--query_file=${file}`;
  };
  const raw =
    request.configuredGraph ??
    JSON.parse(
      await run([
        'cquery',
        queryFile('analysis-deps.query', `deps(${expression(roots.map((value) => value.label))})`),
        ...request.configuration,
        '--lockfile_mode=update',
        '--output=jsonproto',
        '--consistent_labels',
        '--transitions=lite',
        '--proto:include_configurations',
        '--proto:output_rule_attrs=',
      ]),
    );
  assert(
    sourceLock.equals(readFileSync(path.join(root, 'MODULE.bazel.lock'))),
    'CI projection changed the tracked module lock',
  );
  const graph = configuredRecipeGraph(
    raw,
    roots,
    true,
    request.nativeEvidence
      ? (name) => name.startsWith('//') || isNativeImportSourceLabel(name)
      : undefined,
  );
  const sources = new Set<string>();
  const sourceLabels: string[] = [];
  const reachable = new Set(graph.labels);
  for (const entry of (raw as { results: any[] }).results) {
    const name = entry.target?.sourceFile?.name;
    if (typeof name !== 'string' || !reachable.has(canonicalShippingLabel(name))) continue;
    if (isNativeImportSourceLabel(name)) sourceLabels.push(canonicalShippingLabel(name));
    const file = workspacePath(name);
    if (file !== undefined) sources.add(file);
  }
  const loaded = ordered((request.recipeQueries ?? []).flatMap((query) => query.labels));
  const coveredPackages = new Set((request.recipeQueries ?? []).flatMap((query) => query.packages));
  const representatives = graph.packages
    .filter((row) => !coveredPackages.has(row.package))
    .map((row) => row.label);
  for (const target of request.requestedTargets) {
    const name = explicitTarget(target);
    const pkg = name.slice(0, name.indexOf(':'));
    if (!coveredPackages.has(pkg)) representatives.push(name);
  }
  if (representatives.length) {
    const loading = request.configuration.filter((flag) =>
      /^--(?:lockfile_mode|enable_bzlmod|repo_env|override_repository|repository_cache|registry)(?:=|$)/u.test(
        flag,
      ),
    );
    loaded.push(
      ...(
        await run([
          'query',
          queryFile('analysis-buildfiles.query', `buildfiles(${expression(representatives)})`),
          ...loading,
          '--consistent_labels',
          '--output=label',
        ])
      )
        .split(/\r?\n/u)
        .filter(Boolean),
    );
  }
  const recipes = ordered(loaded.map(canonicalShippingLabel));
  for (const row of graph.packages.filter((row) => row.package.startsWith('//'))) {
    assert(
      recipes.filter(
        (name) => name === `${row.package}:BUILD` || name === `${row.package}:BUILD.bazel`,
      ).length === 1,
      'CI package BUILD source is missing or ambiguous',
    );
  }
  const analysisInputs = ordered(
    recipes.flatMap((name) => {
      const file = workspacePath(name);
      return file === undefined ? [] : [file];
    }),
  );
  assert(analysisInputs.length, 'CI loaded recipe inputs are missing');
  const repositories = ordered(
    [...graph.labels, ...recipes].flatMap((name) => {
      const repo = repository(name);
      return repo === undefined ? [] : [repo];
    }),
  );
  const executionRoot = path.resolve(request.executionRoot);
  assert(
    path.basename(path.dirname(executionRoot)) === 'execroot',
    'CI execution root has no pinned output-base layout',
  );
  const outputBase = path.dirname(path.dirname(executionRoot));
  const recorded = await collectBazelRecordedSourceInputs({
    workspaceRoot: root,
    outputBase,
    repositories,
  });
  execution?.assertRunning();
  const snapshotFile = process.env.OLIPHAUNT_NATIVE_PUBLICATION_INPUTS;
  const wasixCargoInputs = request.configuration
    .filter((flag) => flag.startsWith('--repo_env=OLIPHAUNT_WASIX_CARGO_INPUTS='))
    .map((flag) => flag.slice('--repo_env=OLIPHAUNT_WASIX_CARGO_INPUTS='.length));
  assert(wasixCargoInputs.length <= 1, 'CI WASIX Cargo input configuration is ambiguous');
  const snapshot = snapshotFile ? json(snapshotFile) : { source: request.source };
  const projectImports = createNativeImportProjection({
    snapshot,
    source: request.source,
    executionRoot,
    wasixCargoInputs: wasixCargoInputs[0],
  });
  const importScopes = new Map<string, NativeImportedRoot[]>();
  const importsOf = (labels: string[]) => {
    const external = ordered(labels.filter(isNativeImportSourceLabel));
    const key = JSON.stringify(external);
    if (!importScopes.has(key)) importScopes.set(key, projectImports(external));
    return importScopes.get(key)!;
  };
  const importedRoots = graph.sourceRoots
    ? orderedImportedRoots(graph.sourceRoots.flatMap((scope) => importsOf(scope.labels)))
    : importsOf(sourceLabels);
  const nativeOutputs: NativeOutputProjection[] = [];
  if (request.nativeEvidence) {
    const bytes = readFileSync(request.nativeEvidence);
    const evidenceDigest = `sha256:${digest(bytes)}`;
    const evidence = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    ) as NativeBuildEvidence;
    assert(
      evidence.schema === 'oliphaunt-native-build-evidence-v1' &&
        Array.isArray(evidence.cohorts) &&
        evidence.cohorts.length,
      'CI original native evidence schema differs',
    );
    assert.deepEqual(evidence.source, request.source, 'CI original native evidence source differs');
    assert.deepEqual(
      evidence.github,
      request.github,
      'CI original native evidence context differs',
    );
    const bazelVersion = readFileSync(path.join(root, '.bazelversion'), 'utf8').trim();
    const metadata = nativeBuildMetadata(request.source, request.github);
    for (const cohort of evidence.cohorts) {
      const bep = indexNativeBep(cohort, bazelVersion, metadata);
      for (const producingRoot of cohort.roots) {
        const label = explicitTarget(producingRoot.label);
        const configurations = cohort.rootConfigurations.filter(
          (value) => explicitTarget(value.label) === label,
        );
        assert.equal(
          configurations.length,
          1,
          'CI original native root configuration is ambiguous',
        );
        const configuration = configurations[0].configuration;
        assert(
          CONFIG.test(configuration) && bep.configs.has(configuration),
          'CI original native root configuration is missing',
        );
        const completed = bep.completed.filter(
          (value) =>
            explicitTarget(value.label) === label &&
            value.configuration === configuration &&
            value.value.success === true,
        );
        assert.equal(completed.length, 1, 'CI original native root did not complete successfully');
        const completedFiles = bep.filesOf(completed[0].value, 'default');
        let completedFileCount = 0;
        for (const output of producingRoot.package.outputs) {
          assert(
            roots.some((value) => value.label === label && value.configuration === configuration),
            'CI original native evidence root is outside this request',
          );
          const scopes = graph.sourceRoots!.filter(
            (scope) => scope.label === label && scope.configuration === configuration,
          );
          assert.equal(
            scopes.length,
            1,
            'CI original native evidence lacks its configured source scope',
          );
          sourcePath(output.path);
          const captures = cohort.outputs.filter((value) => value.path === output.path);
          assert.equal(
            captures.length,
            1,
            'CI original native output capture is missing or ambiguous',
          );
          const members = captures[0].members.filter((member) => member.type === 'file');
          if (!members.length) continue;
          for (const member of members) {
            const file = member.path ? `${output.path}/${sourcePath(member.path)}` : output.path;
            assert(
              /^[a-f0-9]{64}$/u.test(member.sha256) &&
                Number.isSafeInteger(member.size) &&
                member.size >= 0,
              'CI original native output File identity is invalid',
            );
            assert.deepEqual(
              completedFiles.get(file),
              { size: member.size, sha256: member.sha256 },
              'CI original native output File is absent from its completion',
            );
          }
          completedFileCount += members.length;
          const imports = importsOf(scopes[0].labels);
          nativeOutputs.push({
            root: label,
            configuration,
            evidenceDigest,
            invocationId: bep.invocationId,
            output: output.path,
            files: ordered([
              ...recorded.files,
              ...scopes[0].labels.flatMap((name) => {
                const file = workspacePath(name);
                return file === undefined ? [] : [file];
              }),
            ]),
            ...(imports.length ? { importedRoots: imports } : {}),
          });
        }
        assert(
          completedFileCount,
          `CI original native root ${label} (${configuration}) has no completed File: ${producingRoot.package.outputs.map((output) => output.path).join(', ')}`,
        );
      }
    }
  }
  const record = successRecord(request, 'full');
  record.projection = {
    roots,
    files: ordered([...sources, ...recorded.files]),
    trees: recorded.trees,
    directories: recorded.directories,
    analysisInputs,
    ...(importedRoots.length ? { importedRoots } : {}),
    ...(nativeOutputs.length ? { nativeOutputs: orderedImportedRoots(nativeOutputs) } : {}),
  };
  execution?.assertRunning();
  return writeReceipt(request, record);
}

function validateRequest(record: ConfiguredCiRequest, full: boolean) {
  assert(
    record?.schema === 'oliphaunt-ci-request-v1' &&
      record.status === 'success' &&
      ['full', 'source'].includes(record.mode),
    'CI request did not complete successfully',
  );
  identity(record.id);
  identity(record.job);
  assert(
    record.fullOnly === undefined || typeof record.fullOnly === 'boolean',
    'CI full-only policy is invalid',
  );
  validSource(record.source);
  assertNativeBuildGithub(record.github);
  assert(
    Array.isArray(record.requires) &&
      JSON.stringify(record.requires) === JSON.stringify(ordered(record.requires.map(identity))),
    'CI transport prerequisites are ambiguous',
  );
  if (!full) return;
  assert(record.mode === 'full' && record.projection, 'full CI request has no complete projection');
  for (const field of ['files', 'analysisInputs', 'trees', 'directories'] as const) {
    const values = record.projection[field];
    assert(
      Array.isArray(values) &&
        JSON.stringify(values) ===
          JSON.stringify(
            ordered(
              values.map((name) => sourcePath(name, field === 'trees' || field === 'directories')),
            ),
          ),
      'CI projection input set is malformed',
    );
  }
  assert(
    record.projection.roots.length &&
      record.projection.roots.every(
        (row) => CONFIG.test(row.configuration) && explicitTarget(row.label),
      ),
    'CI projection roots are missing',
  );
  const validateRoots = (values: NativeImportedRoot[]) => {
    assert(Array.isArray(values), 'CI native source lineage is malformed');
    for (const value of values) {
      assert.deepEqual(Object.keys(value).sort(), [
        'configuration',
        'evidenceDigest',
        'invocationId',
        'output',
        'root',
      ]);
      explicitTarget(value.root);
      assert(CONFIG.test(value.configuration), 'CI native source lineage configuration is invalid');
      assert(
        /^sha256:[a-f0-9]{64}$/u.test(value.evidenceDigest),
        'CI native source lineage evidence is invalid',
      );
      assert(
        typeof value.invocationId === 'string' &&
          value.invocationId.length &&
          !/[\u0000-\u001f\u007f]/u.test(value.invocationId),
        'CI native source lineage invocation is invalid',
      );
      sourcePath(value.output);
    }
    assert.deepEqual(values, orderedImportedRoots(values), 'CI native source lineage is ambiguous');
  };
  for (const field of ['importedRoots', 'nativeOutputs'] as const) {
    const values = record.projection[field];
    if (values === undefined) continue;
    assert(Array.isArray(values), 'CI native source lineage is malformed');
    if (field === 'importedRoots') validateRoots(values);
    else
      for (const value of record.projection.nativeOutputs!) {
        const { files, importedRoots, ...proof } = value;
        validateRoots([proof]);
        assert(Array.isArray(files), 'CI native producer source scope is missing');
        assert.deepEqual(
          files,
          ordered(files.map((file) => sourcePath(file))),
          'CI native producer source scope is malformed',
        );
        if (importedRoots !== undefined) validateRoots(importedRoots);
        assert(
          record.projection.roots.some(
            (root) => root.label === value.root && root.configuration === value.configuration,
          ),
          'CI native producer proof root is outside this request',
        );
      }
    assert.deepEqual(values, orderedImportedRoots(values), 'CI native source lineage is ambiguous');
  }
}

/** Join semantic source inputs through exact original producer proofs, never transport prerequisites. */
export function joinConfiguredCiProjections(
  records: ConfiguredCiRequest[],
  source: NativeBuildSource,
) {
  const producers = new Map<
    string,
    { record: ConfiguredCiRequest; output: NativeOutputProjection }[]
  >();
  for (const record of records) {
    validateRequest(record, true);
    assert.deepEqual(record.source, source, 'CI native source lineage producer source differs');
    for (const proof of record.projection!.nativeOutputs ?? []) {
      const key = importedRootKey(proof);
      producers.set(key, [...(producers.get(key) ?? []), { record, output: proof }]);
    }
  }
  type Inputs = Pick<ConfiguredCiProjection, 'files' | 'trees' | 'directories' | 'analysisInputs'>;
  const resolved = new Map<object, Inputs>();
  const active = new Set<object>();
  const visit = (record: ConfiguredCiRequest, output?: NativeOutputProjection): Inputs => {
    const projection = record.projection!;
    const scope = output ?? projection;
    if (resolved.has(scope)) return resolved.get(scope)!;
    assert(!active.has(scope), 'cycle in CI native source lineage');
    active.add(scope);
    const inherited = (scope.importedRoots ?? []).map((proof) => {
      const matches = producers.get(importedRootKey(proof)) ?? [];
      assert.equal(matches.length, 1, 'CI native source lineage lacks one exact original producer');
      return visit(matches[0].record, matches[0].output);
    });
    const joined: Inputs = { ...projection, files: scope.files };
    for (const field of ['files', 'trees', 'directories', 'analysisInputs'] as const)
      joined[field] = ordered([joined, ...inherited].flatMap((value) => value[field]));
    active.delete(scope);
    resolved.set(scope, joined);
    return joined;
  };
  return records.map((record) => ({
    ...record,
    projection: { ...record.projection!, ...visit(record) },
  }));
}
function requestClosure(requests: RequestIdentity[], selected: Iterable<string>) {
  const byId = new Map(requests.map((value) => [identity(value.id), value]));
  assert(byId.size === requests.length, 'CI request inventory contains duplicate IDs');
  const complete = new Set<string>();
  const active = new Set<string>();
  const capture = new Set<string>();
  const visit = (id: string) => {
    assert(byId.has(id), 'CI transport prerequisite is missing');
    assert(!active.has(id), 'cycle in CI transport prerequisites');
    if (complete.has(id)) return;
    active.add(id);
    for (const dep of byId.get(id)!.requires) {
      capture.add(dep);
      visit(dep);
    }
    active.delete(id);
    complete.add(id);
  };
  for (const request of requests) {
    visit(request.id);
  }
  complete.clear();
  capture.clear();
  for (const id of selected) visit(id);
  return { selected: ordered(complete), capture: ordered(capture) };
}
function structural(file: string) {
  const name = path.posix.basename(file);
  return (
    file.startsWith('.github/') ||
    /(?:^|\/)BUILD(?:\.bazel)?$/u.test(file) ||
    file.endsWith('.bzl') ||
    /^(?:MODULE\.bazel(?:\.lock)?|WORKSPACE(?:\.bazel)?|\.bazel(?:rc|version|ignore)|\.git(?:attributes|ignore|modules)|Cargo\.lock|bun\.lock|package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/u.test(
      name,
    )
  );
}
/** Baseline is acquired/authenticated separately; this function never grants publication authority. */
export function selectConfiguredCiRequests(args: {
  source: NativeBuildSource;
  requests: RequestIdentity[];
  changes: SourceChange[];
  basis?: ConfiguredCiBasis;
  full?: boolean;
}): ConfiguredCiPlan {
  validSource(args.source);
  const inventory = args.requests;
  const full = () => {
    const closed = requestClosure(
      inventory,
      inventory.map((request) => request.id),
    );
    return {
      schema: 'oliphaunt-ci-plan-v1' as const,
      mode: 'full' as const,
      source: args.source,
      selected_requests: closed.selected,
      selected_jobs: ordered(inventory.map((value) => value.job)),
      capture_requests: closed.capture,
    };
  };
  if (args.full || !args.basis) return full();
  const basis = args.basis;
  if (
    args.changes.some(
      (change) =>
        change.kind !== 'modified' ||
        change.oldMode !== change.newMode ||
        !['100644', '100755'].includes(change.oldMode ?? '') ||
        structural(change.path),
    )
  )
    return full();
  let projections: ConfiguredCiRequest[];
  try {
    assert(basis.schema === 'oliphaunt-ci-basis-v1', 'CI basis schema differs');
    validSource(basis.source);
    assert(Array.isArray(basis.controllerInputs), 'CI basis controller context is missing');
    assert.deepEqual(
      basis.requests.map(requestIdentity).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
      inventory.map(requestIdentity).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
      'CI basis request inventory differs',
    );
    projections = joinConfiguredCiProjections(basis.requests, basis.source);
  } catch {
    return full();
  }
  if (args.changes.some((change) => basis.controllerInputs.includes(change.path))) return full();
  const changed = args.changes.map((value) => sourcePath(value.path));
  const selected = projections
    .filter((request) => !request.fullOnly)
    .filter((request) => {
      const scope = request.projection!;
      const files = new Set([...scope.files, ...scope.analysisInputs]);
      return changed.some(
        (file) =>
          files.has(file) ||
          scope.trees.some((tree) => tree === '' || file === tree || file.startsWith(`${tree}/`)),
      );
    })
    .map((value) => value.id);
  const closed = requestClosure(inventory, selected);
  if (inventory.some((request) => request.fullOnly && closed.selected.includes(request.id)))
    return full();
  const selectedSet = new Set(closed.selected);
  return {
    schema: 'oliphaunt-ci-plan-v1',
    mode: 'source',
    source: args.source,
    basisSource: basis.source,
    selected_requests: closed.selected,
    selected_jobs: ordered(
      inventory.filter((request) => selectedSet.has(request.id)).map((value) => value.job),
    ),
    capture_requests: closed.capture,
  };
}

/** Inventory annotations belong to existing executable workflow steps, not product ownership. */
export function configuredCiWorkflowInventory(workflow: any) {
  const matrices = JSON.parse(workflow.env.CI_FULL_MATRICES ?? '{}');
  const requests: RequestIdentity[] = [];
  for (const [job, value] of Object.entries(workflow.jobs) as [string, any][]) {
    for (const matrix of matrices[job] ?? [{}]) {
      const substitute = (text: string) =>
        text.replace(/\$\{\{\s*matrix\.([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/gu, (_all, key) => {
          assert(typeof matrix[key] === 'string', 'CI matrix field is missing');
          return matrix[key];
        });
      const matrixValue = matrix.platform ?? matrix.arch;
      const jobKey = matrixValue === undefined ? job : `${job}/${matrixValue}`;
      for (const step of value.steps ?? []) {
        const annotation =
          step.env?.CI_REQUEST_IDS ??
          (step.env?.CI_REQUEST_ID ? JSON.stringify([step.env.CI_REQUEST_ID]) : undefined);
        if (annotation === undefined) continue;
        const declared = JSON.parse(substitute(annotation));
        const ids = Array.isArray(declared) ? declared : (declared[matrixValue] ?? []);
        const requires = JSON.parse(substitute(step.env?.CI_REQUIRES ?? '[]'));
        const fullOnly = fullOnlyAnnotation(step.env?.CI_FULL_ONLY);
        assert(
          Array.isArray(ids) && Array.isArray(requires),
          'CI workflow request annotation is missing',
        );
        for (const id of ids)
          requests.push({
            id: identity(id),
            job: identity(jobKey),
            requires: ordered(requires.map(identity)),
            ...(fullOnly ? { fullOnly: true } : {}),
          });
      }
    }
  }
  requests.sort((a, b) => a.id.localeCompare(b.id));
  assert(requests.length, 'CI workflow request inventory is missing');
  requestClosure(requests, []);
  return { requests, matrices };
}

export function verifyConfiguredCiResults(
  plan: ConfiguredCiPlan,
  records: ConfiguredCiRequest[],
  requiredResult: string,
  github: NativeBuildGithub,
  inventory: RequestIdentity[],
) {
  validSource(plan.source);
  assertNativeBuildGithub(github);
  assert(plan.schema === 'oliphaunt-ci-plan-v1', 'CI plan schema differs');
  if (plan.mode === 'full')
    assert(requiredResult === 'success', 'complete Required qualification did not pass');
  const ids = records.map((record) => record.id).sort();
  assert.deepEqual(
    ids,
    [...plan.selected_requests].sort(),
    'selected CI request receipts are missing or duplicated',
  );
  for (const record of records) {
    validateRequest(record, plan.mode === 'full');
    const declared = inventory.find((request) => request.id === record.id);
    assert(declared && declared.job === record.job, 'CI request receipt job differs');
    assert.deepEqual(
      record.requires,
      declared.requires,
      'CI request receipt transport prerequisites differ',
    );
    assert.equal(
      record.fullOnly === true,
      declared.fullOnly === true,
      'CI request receipt full-only policy differs',
    );
    assert(plan.mode === 'full' || !declared.fullOnly, 'source CI selected a full-only request');
    assert.deepEqual(record.source, plan.source, 'CI request receipt source differs');
    for (const key of ['repository', 'workflow', 'workflowPath', 'runId'] as const)
      assert(record.github[key] === github[key], 'CI request receipt producer context differs');
    assert(
      record.github.runAttempt <= github.runAttempt,
      'CI request receipt producer attempt is newer than the observer',
    );
  }
  if (plan.mode === 'full') joinConfiguredCiProjections(records, plan.source);
}

/** Recompute selected work and every omission from the same transported admitted basis. */
export function verifyConfiguredCiDecision(
  plan: ConfiguredCiPlan,
  args: {
    source: NativeBuildSource;
    requests: RequestIdentity[];
    changes: SourceChange[];
    basis?: ConfiguredCiBasis;
  },
) {
  assert(['full', 'source'].includes(plan.mode), 'CI plan mode is invalid');
  assert.deepEqual(plan.source, args.source, 'CI plan source differs');
  const expected = selectConfiguredCiRequests({ ...args, full: plan.mode === 'full' });
  assert.deepEqual(
    { ...plan, basisDigest: undefined },
    { ...expected, basisDigest: undefined },
    'CI selected requests or omissions differ from the admitted decision',
  );
}

function controllerInputs(root: string) {
  const pending = [
    'tools/ci/configured-scope.mts',
    'tools/ci/run-configured-request.mts',
    'tools/release/qualify-native-shipping.mts',
    'tools/bazel/tests/conformance.mts',
    'build_defs/host/sdk-tree-conformance.mts',
    'src/docs/tools/verify-live.mts',
    'tools/release/native-release-inputs.mts',
    'tools/release/native-release-preparation.mts',
    'build_defs/wasix/browser/chrome-receipt.mts',
  ];
  const files = new Set<string>([
    WORKFLOW,
    '.bazelversion',
    '.bazelrc',
    'tools/dev/bazel.sh',
    '.prototools',
    'src/database-resources/contracts/contract.json',
    'tools/dev/bazel-checksums.tsv',
    'tools/dev/acquisition.sh',
    'tools/dev/bun.sh',
    'tools/dev/bun.toml',
    'tools/dev/install-pinned-js-runtime.sh',
    'tools/dev/extract-pinned-binary.sh',
    'tools/dev/curl-platform-flags.sh',
    'tools/release/with-source.sh',
    'tools/release/qualified-release-replay.sh',
  ]);
  const scanner = new Bun.Transpiler({ loader: 'ts' });
  while (pending.length) {
    const file = pending.pop()!;
    if (files.has(file)) continue;
    files.add(sourcePath(file));
    const source = readFileSync(path.join(root, file), 'utf8').replace(
      /^#![^\r\n]*(?:\r?\n|$)/u,
      '\n',
    );
    for (const entry of scanner.scanImports(source)) {
      if (!entry.path.startsWith('.')) continue; // Tool/package bytes have pinned acquisition context.
      pending.push(
        sourcePath(path.posix.normalize(path.posix.join(path.posix.dirname(file), entry.path))),
      );
    }
  }
  return ordered(files);
}
export function configuredCiSourceChanges(
  root: string,
  from: NativeBuildSource,
  to: NativeBuildSource,
): SourceChange[] {
  validSource(from);
  validSource(to);
  const fields = git(root, 'diff', '--raw', '-z', '--no-renames', from.tree, to.tree).split('\0');
  if (fields.at(-1) === '') fields.pop();
  assert(fields.length % 2 === 0, 'CI Git delta is incomplete');
  const changes: SourceChange[] = [];
  for (let index = 0; index < fields.length; index += 2) {
    const match = /^:([0-9]{6}) ([0-9]{6}) [a-f0-9]+ [a-f0-9]+ ([A-Z])$/u.exec(fields[index]);
    assert(match, 'CI Git delta has an unsupported shape');
    changes.push({
      path: fields[index + 1],
      oldMode: match[1],
      newMode: match[2],
      kind: match[3] === 'M' ? 'modified' : match[3],
    });
  }
  return changes;
}
function basisIdentity(basis: ConfiguredCiBasis, run: any, jobs: any[], root: string) {
  assert(basis.schema === 'oliphaunt-ci-basis-v1', 'CI basis schema differs');
  validSource(basis.source);
  assertNativeBuildGithub(basis.github);
  assert(
    run.status === 'completed' &&
      run.conclusion === 'success' &&
      ['push', 'workflow_dispatch'].includes(run.event) &&
      run.head_branch === 'main' &&
      run.path === WORKFLOW,
    'CI basis did not come from a completed main workflow',
  );
  const required = latestGithubJob({ runAttempt: run.run_attempt, jobs }, 'Required');
  assert(
    required?.status === 'completed' &&
      required.conclusion === 'success' &&
      required.run_attempt === run.run_attempt,
    'CI basis has no successful complete Required gate',
  );
  assert(
    basis.source.commit === run.head_sha &&
      basis.github.runId === run.id &&
      basis.github.runAttempt === run.run_attempt &&
      basis.github.workflowPath === WORKFLOW &&
      basis.github.workflow === 'Native Bazel qualification',
    'CI basis run/source identity differs',
  );
  assert(
    git(root, 'rev-parse', `${basis.source.commit}^{tree}`).trim() === basis.source.tree,
    'CI basis Git tree differs',
  );
  assert(
    Array.isArray(basis.controllerInputs) &&
      basis.controllerInputs.length &&
      JSON.stringify(basis.controllerInputs) ===
        JSON.stringify(ordered(basis.controllerInputs.map((name) => sourcePath(name)))),
    'CI basis controller inputs are incomplete',
  );
  assert(
    Array.isArray(basis.requests) && basis.requests.length,
    'CI basis request inventory is missing',
  );
  for (const request of basis.requests) {
    validateRequest(request, true);
    assert.deepEqual(request.source, basis.source, 'CI basis request source differs');
    for (const key of ['repository', 'workflow', 'workflowPath', 'runId'] as const)
      assert(request.github[key] === basis.github[key], 'CI basis request origin differs');
    assert(
      request.github.runAttempt <= basis.github.runAttempt,
      'CI basis request producer attempt is newer than the basis',
    );
  }
  requestClosure(basis.requests, []);
  joinConfiguredCiProjections(basis.requests, basis.source);
}

/** Only the immutable artifact of an authenticated successful full main run is a basis. */
export async function acquireConfiguredCiBasis(
  root: string,
  repositoryName: string,
  io = {
    read: requestGithubRepositoryJson,
    pages: requestGithubPages,
    download: requestGithubDownload,
  },
) {
  assert(
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repositoryName),
    'CI repository name is invalid',
  );
  const api = `repos/${repositoryName}/actions`;
  // Named artifact lookup does not lose the baseline after many scoped successes.
  const artifacts = await io.pages(`${api}/artifacts?name=native-ci-basis`, {
    itemsField: 'artifacts',
  });
  for (const artifact of artifacts
    .filter(
      (value) =>
        value.name === 'native-ci-basis' &&
        value.expired === false &&
        value.workflow_run?.head_branch === 'main',
    )
    .sort((a, b) => b.id - a.id)) {
    assert(
      Number.isSafeInteger(artifact.workflow_run.id) && artifact.workflow_run.id > 0,
      'CI basis producing run is missing',
    );
    const run = await io.read(`${api}/runs/${artifact.workflow_run.id}`);
    if (
      run.status !== 'completed' ||
      run.conclusion !== 'success' ||
      !['push', 'workflow_dispatch'].includes(run.event) ||
      run.path !== WORKFLOW
    )
      continue;
    assert(
      Number.isSafeInteger(artifact.id) &&
        artifact.id > 0 &&
        Number.isSafeInteger(artifact.size_in_bytes) &&
        artifact.size_in_bytes > 0 &&
        artifact.size_in_bytes <= 16 * 1024 * 1024 &&
        /^sha256:[a-f0-9]{64}$/u.test(artifact.digest),
      'CI basis artifact metadata is invalid',
    );
    const jobs = await io.pages(`${api}/runs/${run.id}/attempts/${run.run_attempt}/jobs`, {
      itemsField: 'jobs',
    });
    const response = await io.download(
      `https://api.github.com/${api}/artifacts/${artifact.id}/zip`,
    );
    const bytes = await boundedResponseBytes(response, artifact.size_in_bytes, 'CI basis artifact');
    assert(
      bytes.length === artifact.size_in_bytes && `sha256:${digest(bytes)}` === artifact.digest,
      'CI basis artifact digest differs',
    );
    const temporary = mkdtempSync(path.join(tmpdir(), 'oliphaunt-ci-basis-'));
    try {
      const zip = path.join(temporary, 'basis.zip');
      writeFileSync(zip, bytes, { mode: 0o600 });
      const entries = [
        ...readPortableArchiveEntries(zip, {
          maxArchiveBytes: 16 * 1024 * 1024,
          maxEntries: 1,
          maxEntryBytes: 64 * 1024 * 1024,
          maxExpandedBytes: 64 * 1024 * 1024,
        }).values(),
      ];
      assert(
        entries.length === 1 && entries[0].name === 'basis.json' && entries[0].type === 'file',
        'CI basis artifact payload differs',
      );
      const data = typeof entries[0].data === 'function' ? entries[0].data() : entries[0].data;
      const basis = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(data),
      ) as ConfiguredCiBasis;
      assert(basis.github.repository === repositoryName, 'CI basis repository differs');
      basisIdentity(basis, run, jobs, root);
      return basis;
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }
  return undefined;
}

function receipts(directory: string): ConfiguredCiRequest[] {
  const files: string[] = [];
  const visit = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      assert(!entry.isSymbolicLink(), 'CI receipt transport cannot contain links');
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) visit(file);
      else {
        assert(
          entry.isFile() && entry.name === 'ci-request.json',
          'CI receipt transport contains an unexpected file',
        );
        files.push(file);
      }
    }
  };
  if (existsSync(directory)) visit(directory);
  return files.sort().map(json);
}
function githubContext(): NativeBuildGithub {
  const result = {
    repository: process.env.GITHUB_REPOSITORY ?? '',
    workflow: 'Native Bazel qualification',
    workflowPath: WORKFLOW,
    runId: Number(process.env.GITHUB_RUN_ID),
    runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT),
    job: process.env.GITHUB_JOB ?? '',
  };
  assertNativeBuildGithub(result);
  return result;
}
function outputs(plan: ConfiguredCiPlan, matrices: Record<string, any[]>) {
  const result: Record<string, string> = {
    ci_mode: plan.mode,
    ci_selected_requests: JSON.stringify(plan.selected_requests),
    ci_selected_jobs: JSON.stringify(plan.selected_jobs),
    ci_capture_requests: JSON.stringify(plan.capture_requests),
  };
  for (const [job, rows] of Object.entries(matrices)) {
    const include = rows.filter((row) =>
      plan.selected_jobs.includes(`${job}/${row.platform ?? row.arch}`),
    );
    result[`${job.replaceAll('-', '_')}_matrix`] = JSON.stringify({ include });
  }
  return result;
}
async function main() {
  const { values, positionals } = parseArgs({
    options: {
      output: { type: 'string' },
      full: { type: 'boolean', default: false },
      plan: { type: 'string' },
      'requests-dir': { type: 'string' },
      'required-result': { type: 'string' },
      'basis-output': { type: 'string' },
    },
    allowPositionals: true,
    strict: true,
  });
  const root = process.cwd();
  const source = currentSource(root);
  assertConfiguredCiSource(root, source);
  const workflow = Bun.YAML.parse(readFileSync(path.join(root, WORKFLOW), 'utf8'));
  const { requests, matrices } = configuredCiWorkflowInventory(workflow);
  if (positionals[0] === 'plan') {
    assert(positionals.length === 1 && values.output, 'CI plan requires one output file');
    let basis: ConfiguredCiBasis | undefined;
    const forced = values.full || process.env.GITHUB_EVENT_NAME === 'workflow_dispatch';
    if (!forced) {
      try {
        basis = await acquireConfiguredCiBasis(root, githubContext().repository);
      } catch {
        console.error('CI basis unavailable; running complete qualification');
      }
    }
    const changes = basis ? configuredCiSourceChanges(root, basis.source, source) : [];
    const plan = selectConfiguredCiRequests({ source, requests, changes, basis, full: forced });
    if (plan.mode === 'source') {
      const bytes = Buffer.from(`${JSON.stringify(basis)}\n`);
      plan.basisDigest = digest(bytes);
      writeFileSync(`${values.output}.basis.json`, bytes, { flag: 'wx', mode: 0o600 });
    }
    writeFileSync(values.output, `${JSON.stringify(plan)}\n`, { flag: 'wx', mode: 0o600 });
    if (process.env.GITHUB_OUTPUT)
      appendFileSync(
        process.env.GITHUB_OUTPUT,
        Object.entries(outputs(plan, matrices))
          .map(([key, value]) => `${key}=${value}\n`)
          .join(''),
      );
  } else if (positionals[0] === 'verify') {
    assert(
      positionals.length === 1 &&
        values.plan &&
        values['requests-dir'] &&
        values['required-result'],
      'CI verification requires plan, receipts and Required result',
    );
    const plan = json(values.plan) as ConfiguredCiPlan;
    assert.deepEqual(plan.source, source, 'CI plan source differs');
    let basis: ConfiguredCiBasis | undefined;
    if (plan.mode === 'source') {
      const bytes = readFileSync(`${values.plan}.basis.json`);
      assert(plan.basisDigest === digest(bytes), 'CI decision basis transport digest differs');
      basis = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    }
    verifyConfiguredCiDecision(plan, {
      source,
      requests,
      basis,
      changes: basis ? configuredCiSourceChanges(root, basis.source, source) : [],
    });
    const records = receipts(values['requests-dir']);
    verifyConfiguredCiResults(plan, records, values['required-result'], githubContext(), requests);
    if (plan.mode === 'full') {
      assert.deepEqual(
        [...plan.selected_requests].sort(),
        requests.map((request) => request.id).sort(),
        'full CI plan omitted a declared request',
      );
      assert(values['basis-output'], 'complete CI requires a basis output');
      const basis: ConfiguredCiBasis = {
        schema: 'oliphaunt-ci-basis-v1',
        source,
        github: githubContext(),
        controllerInputs: controllerInputs(root),
        requests: records.sort((a, b) => a.id.localeCompare(b.id)),
      };
      mkdirSync(path.dirname(values['basis-output']), { recursive: true });
      writeFileSync(values['basis-output'], `${JSON.stringify(basis)}\n`, {
        flag: 'wx',
        mode: 0o600,
      });
    }
  } else throw new Error('configured-scope requires plan or verify');
  assertConfiguredCiSource(root, source);
}
if (import.meta.main) await main();
