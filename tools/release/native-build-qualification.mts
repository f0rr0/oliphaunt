/** Content binding inside qualification evidence; authentication and release admission remain external. */
import { createHash } from 'node:crypto';
import path from 'node:path';
import { buildShippingInputView, canonicalShippingLabel } from './bazel-shipping-inputs.mts';
import type { NativeRoot } from './native-publication-artifacts.mts';
import type { NativeOutputMember } from './native-publication-staging.mts';

type Row = Record<string, any>;
export type NativeBuildSource = { commit: string; tree: string };
export type NativeBuildGithub = {
  repository: string;
  workflow: string;
  workflowPath: string;
  runId: number;
  runAttempt: number;
  job: string;
};
export type NativeBuildFileCapture = { path: string; members: NativeOutputMember[] };
export type NativeBuildCohortEvidence = {
  executionRoot: string;
  roots: NativeRoot[];
  rootConfigurations: { label: string; configuration: string }[];
  aquery: unknown;
  buildEvents: unknown[];
  inputs: NativeBuildFileCapture[];
  outputs: NativeBuildFileCapture[];
};
export type NativeBuildEvidence = {
  schema: 'oliphaunt-native-build-evidence-v1';
  source: NativeBuildSource;
  github: NativeBuildGithub;
  cohorts: NativeBuildCohortEvidence[];
};

function object(value: unknown): Row {
  if (!value || Array.isArray(value) || typeof value !== 'object')
    throw new Error('native build evidence requires an object');
  return value as Row;
}
function list(value: unknown): any[] {
  if (!Array.isArray(value)) throw new Error('native build evidence requires a list');
  return value;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value || /[\u0000-\u001f\u007f]/u.test(value))
    throw new Error('native build evidence requires a nonempty identity');
  return value;
}
function relative(value: unknown) {
  const name = text(value);
  if (
    name.startsWith('/') ||
    name.includes('\\') ||
    name.normalize('NFC') !== name ||
    name.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new Error(`unsafe native build path: ${name}`);
  return name;
}
function size(value: unknown): number {
  if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/u.test(value)) value = Number(value);
  if (!Number.isSafeInteger(value) || Number(value) < 0)
    throw new Error('native build file size must be a nonnegative safe integer');
  return Number(value);
}
function hash(value: unknown) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value))
    throw new Error('native build content requires SHA-256');
  return value;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
function digest(value: unknown) {
  const hash = createHash('sha256');
  const update = (value: unknown) => {
    if (Array.isArray(value)) {
      hash.update('[');
      for (let index = 0; index < value.length; index++) {
        if (index) hash.update(',');
        update(value[index]);
      }
      hash.update(']');
    } else if (value && typeof value === 'object') {
      hash.update('{');
      let index = 0;
      for (const [key, item] of Object.entries(value).sort(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0,
      )) {
        if (index++) hash.update(',');
        hash.update(`${JSON.stringify(key)}:`);
        update(item);
      }
      hash.update('}');
    } else hash.update(JSON.stringify(value));
  };
  update(value);
  return `sha256:${hash.digest('hex')}`;
}
function equal(actual: unknown, expected: unknown, context: string) {
  if (canonical(actual) !== canonical(expected)) throw new Error(`${context} mismatch`);
}
function exactFields(value: Row, fields: string[], context: string) {
  equal(Object.keys(value).sort(), fields.sort(), `${context} fields`);
}
function source(value: NativeBuildSource) {
  exactFields(object(value), ['commit', 'tree'], 'native build source');
  if (![value.commit, value.tree].every((sha) => /^[0-9a-f]{40}$/u.test(sha ?? '')))
    throw new Error('native build requires exact source commit and tree');
}
export function assertNativeBuildGithub(value: NativeBuildGithub) {
  exactFields(
    object(value),
    ['repository', 'workflow', 'workflowPath', 'runId', 'runAttempt', 'job'],
    'native build GitHub',
  );
  for (const key of ['repository', 'workflow', 'workflowPath', 'job']) text(value[key]);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(value.repository))
    throw new Error('native build repository is invalid');
  if (!/^\.github\/workflows\/[^/]+\.ya?ml$/u.test(value.workflowPath))
    throw new Error('native build workflow path is invalid');
  for (const key of ['runId', 'runAttempt'])
    if (!Number.isSafeInteger(value[key]) || value[key] <= 0)
      throw new Error('native build producing run and attempt must be positive integers');
}

/** Pass each entry to the real build as --build_metadata=KEY=VALUE. */
export function nativeBuildMetadata(sourceIdentity: NativeBuildSource, github: NativeBuildGithub) {
  source(sourceIdentity);
  assertNativeBuildGithub(github);
  return {
    oliphaunt_source_commit: sourceIdentity.commit,
    oliphaunt_source_tree: sourceIdentity.tree,
    oliphaunt_repository: github.repository,
    oliphaunt_workflow: github.workflow,
    oliphaunt_workflow_path: github.workflowPath,
    oliphaunt_run_id: String(github.runId),
    oliphaunt_run_attempt: String(github.runAttempt),
    oliphaunt_job: github.job,
  };
}

function captures(value: unknown, expected: string[], context: string) {
  const result = new Map<string, NativeBuildFileCapture>();
  for (const raw of list(value)) {
    const capture = object(raw) as NativeBuildFileCapture;
    exactFields(capture, ['path', 'members'], context);
    const name = relative(capture.path);
    if (result.has(name)) throw new Error(`duplicate ${context}: ${name}`);
    const members = list(capture.members);
    if (!members.length || members[0].path !== '')
      throw new Error(`${context} requires its captured root member: ${name}`);
    const seen = new Map<string, string>();
    for (const member of members) {
      const row = object(member);
      const memberPath = row.path === '' ? '' : relative(row.path);
      if (seen.has(memberPath)) throw new Error(`duplicate ${context} member`);
      if (!Number.isInteger(row.mode) || row.mode < 0 || row.mode > 0o777)
        throw new Error(`${context} mode is invalid`);
      if (row.type === 'file') {
        exactFields(row, ['path', 'type', 'mode', 'size', 'sha256'], context);
        size(row.size);
        hash(row.sha256);
      } else if (row.type === 'directory') exactFields(row, ['path', 'type', 'mode'], context);
      else throw new Error(`${context} member must be a regular file or directory`);
      if (
        memberPath &&
        seen.get(path.posix.dirname(memberPath) === '.' ? '' : path.posix.dirname(memberPath)) !==
          'directory'
      )
        throw new Error(`${context} member has no captured directory parent`);
      seen.set(memberPath, row.type);
    }
    equal([...seen.keys()], [...seen.keys()].sort(), `${context} member order`);
    result.set(name, capture);
  }
  equal([...result.keys()].sort(), [...new Set(expected)].sort(), `${context} coverage`);
  return result;
}

function buildEvents(
  cohort: NativeBuildCohortEvidence,
  bazelVersion: string,
  metadata: Record<string, string>,
) {
  const events = list(cohort.buildEvents).map(object);
  if (!events.length || events.at(-1)?.lastMessage !== true)
    throw new Error('native BEP stream is incomplete');
  const one = (field: string) => {
    const matches = events.filter((event) => event[field] !== undefined);
    if (matches.length !== 1) throw new Error(`native BEP must contain one ${field} event`);
    return object(matches[0][field]);
  };
  const started = one('started');
  equal(started.buildToolVersion, bazelVersion, 'native BEP Bazel version');
  const invocationId = text(started.uuid);
  const observedMetadata = object(one('buildMetadata').metadata);
  for (const [key, value] of Object.entries(metadata))
    equal(observedMetadata[key], value, `native BEP ${key}`);
  equal(one('workspaceInfo').localExecRoot, cohort.executionRoot, 'native BEP execution root');
  const finished = one('finished');
  if (
    finished.overallSuccess === false ||
    finished.exitCode?.name !== 'SUCCESS' ||
    size(finished.exitCode?.code ?? 0) !== 0
  )
    throw new Error('native BEP build did not succeed');
  const configs = new Map<string, Row>();
  const named = new Map<string, Row>();
  const completed: { label: string; configuration: string; value: Row }[] = [];
  for (const event of events) {
    if (event.configuration !== undefined) {
      const key = text(event.id?.configuration?.id);
      if (configs.has(key)) throw new Error('duplicate native BEP configuration');
      configs.set(key, object(event.configuration));
    }
    if (event.namedSetOfFiles !== undefined) {
      const key = text(event.id?.namedSet?.id);
      if (named.has(key)) throw new Error('duplicate native BEP named set');
      named.set(key, object(event.namedSetOfFiles));
    }
    if (event.id?.targetCompleted !== undefined) {
      completed.push({
        label: text(event.id.targetCompleted.label),
        configuration: text(event.id.targetCompleted.configuration?.id),
        value: object(event.completed ?? event.aborted),
      });
    }
  }
  const filesOf = (target: Row) => {
    const files = new Map<string, { sha256: string; size: number }>();
    const visitFile = (raw: unknown) => {
      const file = object(raw);
      const name = relative([...(file.pathPrefix ?? []), text(file.name)].join('/'));
      const identity = { sha256: hash(file.digest), size: size(file.length ?? 0) };
      if (file.symlinkTargetPath) throw new Error('native BEP output is an unresolved symlink');
      if (files.has(name)) equal(files.get(name), identity, 'native BEP duplicate file');
      files.set(name, identity);
    };
    const visited = new Set<string>();
    const visit = (key: string, stack = new Set<string>()) => {
      if (stack.has(key)) throw new Error('cycle in native BEP named sets');
      if (visited.has(key)) return;
      const set = named.get(key);
      if (!set) throw new Error('missing native BEP named set');
      for (const file of list(set.files ?? [])) visitFile(file);
      for (const child of list(set.fileSets ?? [])) visit(text(child.id), new Set(stack).add(key));
      visited.add(key);
    };
    for (const group of list(target.outputGroup ?? [])) {
      if (group.incomplete === true) throw new Error('native BEP output group is incomplete');
      for (const set of list(group.fileSets ?? [])) visit(text(set.id));
      for (const file of list(group.inlineFiles ?? [])) visitFile(file);
    }
    return files;
  };
  return { invocationId, configs, completed, filesOf };
}

/** Validate content reported by the actual qualifying builder, including cache-backed success. */
export function validateNativeBuildEvidence(
  raw: unknown,
  expected: { source: NativeBuildSource; github: NativeBuildGithub; bazelVersion: string },
) {
  source(expected.source);
  assertNativeBuildGithub(expected.github);
  text(expected.bazelVersion);
  const evidence = object(raw) as NativeBuildEvidence;
  exactFields(evidence, ['schema', 'source', 'github', 'cohorts'], 'native build evidence');
  if (evidence.schema !== 'oliphaunt-native-build-evidence-v1')
    throw new Error('unsupported native build evidence');
  source(evidence.source);
  assertNativeBuildGithub(evidence.github);
  equal(evidence.source, expected.source, 'native build source');
  equal(evidence.github, expected.github, 'native build producing workflow/run/attempt/job');
  if (!list(evidence.cohorts).length)
    throw new Error('native build evidence requires configured cohorts');
  const invocations = new Set<string>();
  const cohorts = evidence.cohorts.map((cohort) => {
    exactFields(
      object(cohort),
      [
        'executionRoot',
        'roots',
        'rootConfigurations',
        'aquery',
        'buildEvents',
        'inputs',
        'outputs',
      ],
      'native build cohort',
    );
    if (
      !path.posix.isAbsolute(text(cohort.executionRoot)) &&
      !path.win32.isAbsolute(cohort.executionRoot)
    )
      throw new Error('native build requires its absolute execution root');
    if (!list(cohort.roots).length) throw new Error('native build requires actual shipping roots');
    const rootConfigurations = new Map<string, string>();
    for (const raw of list(cohort.rootConfigurations)) {
      const row = object(raw);
      exactFields(row, ['label', 'configuration'], 'native configured root');
      const label = text(row.label);
      if (rootConfigurations.has(label)) throw new Error('duplicate native configured root');
      rootConfigurations.set(label, text(row.configuration));
    }
    equal(
      [...rootConfigurations.keys()].sort(),
      cohort.roots.map((root) => text(root.label)).sort(),
      'native configured root coverage',
    );
    const view = buildShippingInputView(
      {
        schema: 'oliphaunt-bazel-shipping-v1',
        scope: 'construction',
        packages: cohort.roots.map((root) => root.package),
      },
      cohort.aquery,
    );
    const graph = object(cohort.aquery);
    const configurationIds = new Map(
      list(graph.configuration).map((row) => [String(row.id), text(row.checksum)]),
    );
    for (const action of list(graph.actions))
      if (!configurationIds.has(String(action.configurationId)))
        throw new Error('native aquery action configuration is missing');
    const actions = [
      ...new Set(Object.values(view.products).flatMap((product) => product.actions)),
    ].sort();
    const declaredInputs = view.physicalInputs.map(relative);
    const inputs = captures(cohort.inputs, declaredInputs, 'native input content');
    const outputs = captures(
      cohort.outputs,
      cohort.roots.flatMap((root) => root.package.outputs.map((output) => relative(output.path))),
      'native output content',
    );
    const bep = buildEvents(
      cohort,
      expected.bazelVersion,
      nativeBuildMetadata(expected.source, expected.github),
    );
    if (invocations.has(bep.invocationId))
      throw new Error('native evidence repeats a build invocation');
    invocations.add(bep.invocationId);
    const roots = cohort.roots.map((root) => {
      const expectedFiles = root.package.outputs.flatMap((output) =>
        outputs
          .get(output.path)!
          .members.filter((member) => member.type === 'file')
          .map((member) => ({
            path: member.path ? `${output.path}/${member.path}` : output.path,
            sha256: member.sha256,
            size: member.size,
          })),
      );
      if (!expectedFiles.length)
        throw new Error('native shipping root has no delivered file digests');
      const matches = bep.completed
        .filter(
          (target) =>
            canonicalShippingLabel(target.label) === canonicalShippingLabel(root.label) &&
            target.value.success === true,
        )
        .filter((target) => {
          const files = bep.filesOf(target.value);
          return expectedFiles.every((file) => files.has(file.path));
        });
      if (matches.length !== 1)
        throw new Error(
          `native BEP requires one successful configured shipping root: ${root.label}`,
        );
      const target = matches[0];
      const configuration = bep.configs.get(target.configuration);
      if (!configuration) throw new Error('native BEP target configuration is missing');
      equal(
        target.configuration,
        rootConfigurations.get(root.label),
        'native BEP/cquery shipping configuration',
      );
      const files = bep.filesOf(target.value);
      for (const { path: file, ...identity } of expectedFiles)
        equal(files.get(file), identity, 'native BEP/physical output digest');
      return {
        label: root.label,
        configuration: target.configuration,
        configurationDetails: configuration,
        package: root.package,
        outputs: root.package.outputs.map((output) => outputs.get(output.path)),
      };
    });
    return {
      invocationId: bep.invocationId,
      roots,
      inputContentsDigest: digest(
        [...inputs.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
      ),
      actionDefinitionsDigest: digest({ schema: view.schema, actions }),
      // The raw evidence retains actual configured actions and every input member.
      aqueryDigest: digest(cohort.aquery),
      buildEventsDigest: digest(cohort.buildEvents),
    };
  });
  return {
    scope: 'construction' as const,
    source: evidence.source,
    github: evidence.github,
    cohorts,
    releaseDecision: 'unverified' as const,
    unverified: [
      'authenticated producing workflow, attempt, job and immutable artifact',
      'immutable input lifetime from the producing build through content capture',
      'complete canonical product qualification and completed-baseline admission',
    ],
  };
}
