/** Content binding inside qualification evidence; authentication and release admission remain external. */
import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  SEED_CONSTRUCTION_RECEIPT_SUFFIX,
  validateSeedConstructionReceipt,
} from '../../build_defs/resources/seed_construction.mts';
import {
  buildShippingInputView,
  canonicalShippingLabel,
  configuredAqueryTargetInputs,
  type ShippingInputView,
  validateNativeShippingSuppliers,
} from './bazel-shipping-inputs.mts';
import type { NativeRoot } from './native-publication-artifacts.mts';
import type { NativeOutputMember } from './native-publication-staging.mts';

type Row = Record<string, any>;
export type NativeBuildSource = { commit: string; tree: string };
export type NativeRequiredTest = { label: string; configuration: string };
export type NativeBuildGithub = {
  repository: string;
  workflow: string;
  workflowPath: string;
  runId: number;
  runAttempt: number;
  job: string;
};
export type NativeBuildFileCapture = { path: string; members: NativeOutputMember[] };
export type NativeQualificationInputs = NativeRequiredTest & {
  /** The same configured test's own input-free FileWrite, consumed by its runfiles/actions. */
  specification: string;
  inputs: NativeBuildFileCapture[];
};
export type NativeProducerCapture = {
  aqueryFile: string;
  /** Successful scoped analysis in the same frozen producer window; no byte-authentication claim. */
  aqueryBuildEvents?: unknown[];
  shippingManifests: { path: string; contents: string }[];
  /** The existing owner export, delivered by the same producing invocation. */
  qualificationManifest?: { path: string; contents: string };
};

export const NATIVE_AQUERY_FLAGS = [
  '--output=jsonproto',
  '--include_commandline=false',
  '--include_artifacts=true',
  '--include_pruned_inputs=true',
  '--include_aspects=true',
  '--include_param_files=false',
  '--include_file_write_contents=false',
  '--tool_deps=true',
  '--implicit_deps=true',
  '--nodep_deps=true',
  '--skyframe_state=false',
] as const;

/** The complete requested configured closure, including owner policy and tests. */
export function nativeAqueryExpression(targets: string[]) {
  const labels = targets.map((value) => canonicalShippingLabel(text(value)));
  if (!labels.length || labels.some((label) => !/^\/\/[^\s]*:[^\s]+$/u.test(label)))
    throw new Error('native scoped aquery requires explicit workspace target labels');
  return `deps(set(${[...new Set(labels)]
    .sort()
    .map((label) => JSON.stringify(label))
    .join(' ')}))`;
}
export type NativeBuildCohortEvidence = {
  executionRoot: string;
  roots: NativeRoot[];
  rootConfigurations: { label: string; configuration: string }[];
  aquery: unknown;
  buildEvents: unknown[];
  inputs: NativeBuildFileCapture[];
  outputs: NativeBuildFileCapture[];
  /** Present only when shipping identities were emitted by the producing analysis. */
  producerCapture?: NativeProducerCapture;
  /** Reached internal constructor outputs; their JSON is bound to captured File bytes. */
  seedConstructions?: { path: string; contents: string }[];
  /** Actual configured-root buildfiles; repository acquisition provenance is separate. */
  analysisInputs?: NativeBuildFileCapture[];
  rootAnalysisInputPaths?: { label: string; paths: string[] }[];
  /** Exact source-owned mandatory-test inputs, retained only for qualification replay. */
  qualificationInputs?: NativeQualificationInputs[];
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

/** Require causal leaves, consumed supplier Files and reached constructor companion values. */
export function nativeRequiredCaptureInputs(view: ShippingInputView) {
  const files = new Set(view.captureInputs);
  const actions = new Set(Object.values(view.products).flatMap((product) => product.actions));
  for (const definition of actions) {
    const action = object(JSON.parse(definition));
    if (
      !['PostgresClusterSeed', 'WasixClusterSeed', 'NativeSeedDomainAdmission'].includes(
        action.mnemonic,
      )
    )
      continue;
    const outputs = list(action.outputs).map(relative);
    for (const receipt of outputs.filter((file) =>
      file.endsWith(SEED_CONSTRUCTION_RECEIPT_SUFFIX),
    )) {
      const frozen = receipt.slice(0, -SEED_CONSTRUCTION_RECEIPT_SUFFIX.length) + '.tar';
      if (!outputs.includes(frozen))
        throw new Error('native seed constructor receipt requires its same-action frozen TAR');
      files.add(receipt);
      files.add(frozen);
    }
  }
  return [...files].sort();
}

/** Join each reached receipt to its own constructor action and frozen TAR File. */
export function validateNativeSeedConstructions(
  raw: unknown,
  inputs: NativeBuildFileCapture[],
  actions: string[],
) {
  const expected = inputs
    .filter((input) => input.path.endsWith(SEED_CONSTRUCTION_RECEIPT_SUFFIX))
    .map((input) => input.path)
    .sort();
  const rows = raw === undefined ? [] : list(raw);
  const result = rows.map((value) => {
    const row = object(value);
    exactFields(row, ['path', 'contents'], 'native seed constructor contents');
    const file = relative(row.path);
    if (!file.startsWith('bazel-out/') || typeof row.contents !== 'string')
      throw new Error('native seed constructor requires a generated UTF-8 File');
    const bytes = Buffer.from(row.contents, 'utf8');
    const capture = inputs.find((input) => input.path === file);
    const member = capture?.members[0];
    if (capture?.members.length !== 1 || member?.type !== 'file')
      throw new Error('native seed constructor contents have no captured File');
    equal(
      { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') },
      { size: member.size, sha256: member.sha256 },
      'native seed constructor File digest',
    );
    const receipt = validateSeedConstructionReceipt(JSON.parse(row.contents));
    const frozen = file.slice(0, -SEED_CONSTRUCTION_RECEIPT_SUFFIX.length) + '.tar';
    const definitions = actions
      .map((action) => object(JSON.parse(action)))
      .filter((action) => list(action.outputs).includes(file));
    if (
      definitions.length !== 1 ||
      !['PostgresClusterSeed', 'WasixClusterSeed', 'NativeSeedDomainAdmission'].includes(
        definitions[0].mnemonic,
      ) ||
      !list(definitions[0].outputs).includes(frozen)
    )
      throw new Error(
        'native seed constructor receipt and frozen TAR need the same actual constructor action',
      );
    if (
      (definitions[0].mnemonic === 'WasixClusterSeed' ? 'wasix' : 'native') !==
      receipt.intent.family
    )
      throw new Error('native seed constructor family differs from its actual action');
    if (
      definitions[0].mnemonic === 'NativeSeedDomainAdmission' &&
      !['android-datum64', 'ios-datum64'].includes(receipt.intent.target)
    )
      throw new Error('native seed domain receipt needs its own mobile domain slot');
    const frozenCapture = inputs.find((input) => input.path === frozen);
    const frozenMember = frozenCapture?.members[0];
    if (frozenCapture?.members.length !== 1 || frozenMember?.type !== 'file')
      throw new Error('native seed constructor needs its captured frozen TAR File');
    equal(
      receipt.frozen,
      { size: frozenMember.size, sha256: frozenMember.sha256 },
      'native seed constructor frozen TAR identity',
    );
    return { path: file, contents: row.contents as string };
  });
  equal(result.map((row) => row.path).sort(), expected, 'native reached seed constructor coverage');
  return result;
}

/** Preserve direct loaded-file facts without claiming repository acquisition provenance. */
export function nativeAnalysisInputBindings(
  cohort: Pick<NativeBuildCohortEvidence, 'roots' | 'analysisInputs' | 'rootAnalysisInputPaths'>,
) {
  if (cohort.analysisInputs === undefined && cohort.rootAnalysisInputPaths === undefined)
    return undefined;
  const mappings = list(cohort.rootAnalysisInputPaths).map((raw) => {
    const row = object(raw);
    exactFields(row, ['label', 'paths'], 'native root analysis mapping');
    const label = canonicalShippingLabel(text(row.label));
    const paths = list(row.paths).map(relative);
    if (
      !paths.length ||
      paths.some((file) => file.startsWith('bazel-out/') || file.startsWith('external/'))
    )
      throw new Error('native analysis inputs must be concrete workspace files');
    equal(paths, [...new Set(paths)].sort(), 'native root analysis input order');
    return { label, paths };
  });
  equal(
    mappings.map((row) => row.label).sort(),
    cohort.roots.map((root) => canonicalShippingLabel(root.label)).sort(),
    'native root analysis coverage',
  );
  const expected = [...new Set(mappings.flatMap((row) => row.paths))].sort();
  const inputs = captures(cohort.analysisInputs, expected, 'native analysis input content');
  for (const input of inputs.values())
    if (input.members.length !== 1 || input.members[0].type !== 'file')
      throw new Error('native analysis inputs must be regular workspace Files');
  return { mappings, inputs: [...inputs.values()] };
}

export function nativeBuildEventIndex(
  cohort: Pick<NativeBuildCohortEvidence, 'executionRoot' | 'buildEvents'>,
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
  const filesOf = (target: Row, groupName: string) => {
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
      if (group.name !== groupName) continue;
      if (group.incomplete === true) throw new Error('native BEP output group is incomplete');
      for (const set of list(group.fileSets ?? [])) visit(text(set.id));
      for (const file of list(group.inlineFiles ?? [])) visitFile(file);
    }
    return files;
  };
  return { invocationId, configs, completed, filesOf, events };
}

/** Native metadata is content-bound by BEP; the separate action graph has no native digest receipt. */
export function nativeShippingManifestBindings(
  raw: NativeProducerCapture,
  bep: ReturnType<typeof nativeBuildEventIndex>,
) {
  const capture = object(raw) as NativeProducerCapture;
  exactFields(
    capture,
    [
      'aqueryFile',
      ...(capture.aqueryBuildEvents === undefined ? [] : ['aqueryBuildEvents']),
      'shippingManifests',
      ...(capture.qualificationManifest ? ['qualificationManifest'] : []),
    ],
    'native producer capture',
  );
  if (
    !path.posix.isAbsolute(text(capture.aqueryFile)) &&
    !path.win32.isAbsolute(capture.aqueryFile)
  )
    throw new Error('native producer requires an absolute aquery file');
  const commands = bep.events.filter(
    (event) => event.structuredCommandLine?.commandLineLabel === 'canonical',
  );
  if (commands.length !== 1) throw new Error('native producer requires one canonical command line');
  const options = list(commands[0].structuredCommandLine.sections).flatMap((section) =>
    list(object(section).optionList?.option ?? []),
  );
  let query: ReturnType<typeof nativeBuildEventIndex> | undefined;
  if (capture.aqueryBuildEvents === undefined) {
    // Historical immutable packets used Bazel's whole-server after-build dump.
    for (const [name, value] of [
      ['experimental_aquery_dump_after_build_format', 'jsonproto'],
      ['experimental_aquery_dump_after_build_output_file', capture.aqueryFile],
    ]) {
      const matches = options.filter((option) => option.optionName === name);
      if (matches.length !== 1 || matches[0].optionValue !== value)
        throw new Error(`native producer command line requires ${name}=${value}`);
    }
  } else {
    const event = (field: string) => {
      const matches = bep.events.filter((event) => event[field] !== undefined);
      if (matches.length !== 1) throw new Error(`native producing BEP requires one ${field}`);
      return object(matches[0][field]);
    };
    query = nativeBuildEventIndex(
      {
        executionRoot: text(event('workspaceInfo').localExecRoot),
        buildEvents: capture.aqueryBuildEvents,
      },
      text(event('started').buildToolVersion),
      object(event('buildMetadata').metadata),
    );
    if (query.invocationId === bep.invocationId)
      throw new Error('native scoped aquery requires its separate analysis invocation');
    const chunk = (command: Row, name: string) => {
      const matches = list(command.sections).filter((section) => section.sectionLabel === name);
      if (matches.length !== 1) throw new Error(`native command requires one ${name} section`);
      return list(object(matches[0]).chunkList?.chunk).map(text);
    };
    const queryCommands = query.events.filter(
      (event) => event.structuredCommandLine?.commandLineLabel === 'canonical',
    );
    if (queryCommands.length !== 1)
      throw new Error('native scoped aquery requires one canonical command');
    const producerCommand = object(commands[0].structuredCommandLine);
    const queryCommand = object(queryCommands[0].structuredCommandLine);
    equal(chunk(producerCommand, 'command'), ['test'], 'native producing command');
    equal(chunk(queryCommand, 'command'), ['aquery'], 'native scoped analysis command');
    equal(
      chunk(queryCommand, 'residual'),
      [nativeAqueryExpression(chunk(producerCommand, 'residual'))],
      'native scoped aquery requested closure',
    );
    const queryOptions = list(queryCommand.sections).flatMap((section) =>
      list(object(section).optionList?.option ?? []),
    );
    for (const flag of NATIVE_AQUERY_FLAGS) {
      const [name, literal] = flag.slice(2).split('=');
      const value = literal === 'true' ? '1' : literal === 'false' ? '0' : literal;
      const matches = queryOptions.filter((option) => option.optionName === name);
      if (matches.length !== 1 || matches[0].optionValue !== value)
        throw new Error(`native scoped aquery command requires ${name}=${value}`);
    }
    const outputs = queryOptions.filter((option) => option.optionName === 'output_file');
    if (outputs.length !== 1 || outputs[0].optionValue !== capture.aqueryFile)
      throw new Error('native scoped aquery output file differs from its captured graph');
  }
  const paths = new Set<string>();
  const labels = new Set<string>();
  const bindings = list(capture.shippingManifests).map((raw) => {
    const manifest = object(raw);
    exactFields(manifest, ['path', 'contents'], 'native shipping manifest');
    const file = relative(manifest.path);
    if (!file.startsWith('bazel-out/') || paths.has(file))
      throw new Error('native shipping manifest requires a unique generated file');
    paths.add(file);
    if (typeof manifest.contents !== 'string')
      throw new Error('native shipping manifest requires its exact UTF-8 contents');
    const bytes = Buffer.from(manifest.contents, 'utf8');
    const root = object(JSON.parse(manifest.contents)) as NativeRoot;
    exactFields(root, ['label', 'package'], 'native shipping root');
    const label = canonicalShippingLabel(text(root.label));
    if (labels.has(label)) throw new Error('duplicate native shipping manifest root');
    labels.add(label);
    const pkg = object(root.package);
    exactFields(
      pkg,
      [
        'product',
        'version',
        'ecosystem',
        'name',
        'configuration',
        'role',
        'outputs',
        ...(Object.hasOwn(pkg, 'supplierInputs') ? ['supplierInputs'] : []),
      ],
      'native shipping package',
    );
    for (const field of ['product', 'version', 'ecosystem', 'name', 'configuration', 'role'])
      text(pkg[field]);
    if (Object.hasOwn(pkg, 'supplierInputs')) validateNativeShippingSuppliers(pkg.supplierInputs);
    for (const output of list(pkg.outputs)) {
      exactFields(object(output), ['path', 'owner'], 'native shipping output');
      relative(output.path);
      text(output.owner);
    }
    const targets = bep.completed.filter(
      (target) => canonicalShippingLabel(target.label) === label,
    );
    if (targets.length !== 1 || targets[0].value.success !== true)
      throw new Error(`native manifest requires one successful configured shipping root: ${label}`);
    const target = targets[0];
    if (!bep.configs.has(target.configuration))
      throw new Error('native manifest target configuration is missing');
    const files = bep.filesOf(target.value, 'shipping_manifest');
    if (files.size !== 1 || !files.has(file))
      throw new Error(`native shipping_manifest output group mismatch: ${label}`);
    equal(
      files.get(file),
      { sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length },
      'native BEP/shipping manifest digest',
    );
    return { root, configuration: target.configuration, path: file };
  });
  if (!bindings.length) throw new Error('native producer requires shipping manifests');
  if (query)
    for (const binding of bindings)
      if (!query.configs.has(binding.configuration))
        throw new Error(
          'native scoped aquery shipping configuration differs from its producing build',
        );
  return bindings;
}

/** Bind source-owned mandatory tests to exactly the shipping roots they qualify. */
export function nativeShippingQualificationPolicy(
  capture: NativeProducerCapture,
  bep: ReturnType<typeof nativeBuildEventIndex>,
  roots: NativeRoot[],
) {
  if (capture.qualificationManifest === undefined) return undefined;
  const manifest = object(capture.qualificationManifest);
  exactFields(manifest, ['path', 'contents'], 'native owner qualification manifest');
  const file = relative(manifest.path);
  if (!file.startsWith('bazel-out/') || typeof manifest.contents !== 'string')
    throw new Error('native owner qualification requires a generated UTF-8 manifest');
  const owner = object(JSON.parse(manifest.contents));
  exactFields(
    owner,
    [
      'schema',
      'scope',
      'owner',
      'roots',
      'packages',
      'qualification',
      ...(Object.hasOwn(owner, 'policies') ? ['policies'] : []),
    ],
    'native owner qualification',
  );
  if (owner.schema !== 'oliphaunt-bazel-shipping-v1' || owner.scope !== 'construction')
    throw new Error('native owner qualification manifest has an unsupported schema');
  const label = canonicalShippingLabel(text(owner.owner));
  const labels = list(owner.roots).map((value) => canonicalShippingLabel(text(value)));
  const tests = list(owner.qualification).map((value) => canonicalShippingLabel(text(value)));
  for (const [values, context] of [
    [labels, 'roots'],
    [tests, 'tests'],
  ] as const)
    if (new Set(values).size !== values.length || values.some((value) => !value.startsWith('//')))
      throw new Error(`native owner qualification requires unique workspace ${context}`);
  const policies = (
    Object.hasOwn(owner, 'policies')
      ? list(owner.policies)
      : [{ owner: label, roots: labels, qualification: tests }]
  ).map((raw) => {
    const policy = object(raw);
    exactFields(policy, ['owner', 'roots', 'qualification'], 'native source owner policy');
    const owner = canonicalShippingLabel(text(policy.owner));
    const roots = list(policy.roots).map((value) => canonicalShippingLabel(text(value)));
    const qualification = list(policy.qualification).map((value) =>
      canonicalShippingLabel(text(value)),
    );
    if (
      !owner.startsWith('//') ||
      !roots.length ||
      [roots, qualification].some(
        (values) =>
          new Set(values).size !== values.length || values.some((value) => !value.startsWith('//')),
      )
    )
      throw new Error('native source owner policy requires unique workspace roots and tests');
    return { owner, roots, qualification };
  });
  if (new Set(policies.map((policy) => policy.owner)).size !== policies.length)
    throw new Error('native source owner policy repeats an owner');
  equal(
    policies.flatMap((policy) => policy.roots).sort(),
    [...labels].sort(),
    'native source owner policy root coverage',
  );
  equal(
    [...new Set(policies.flatMap((policy) => policy.qualification))].sort(),
    [...tests].sort(),
    'native source owner policy test coverage',
  );
  equal(
    [...labels].sort(),
    roots.map((root) => canonicalShippingLabel(root.label)).sort(),
    'native owner qualification root coverage',
  );
  equal(
    labels
      .map((label, index) => ({ label, package: list(owner.packages)[index] }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    roots
      .map((root) => ({ ...root, label: canonicalShippingLabel(root.label) }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    'native owner qualification package coverage',
  );
  if (list(owner.packages).length !== labels.length)
    throw new Error('native owner qualification has extra package declarations');
  const targets = bep.completed.filter((target) => canonicalShippingLabel(target.label) === label);
  if (targets.length !== 1 || targets[0].value.success !== true)
    throw new Error('native owner qualification requires one successful configured export');
  const target = targets[0];
  if (!bep.configs.has(target.configuration))
    throw new Error('native owner qualification configuration is missing');
  const files = bep.filesOf(target.value, 'shipping_policy');
  if (files.size !== 1 || !files.has(file))
    throw new Error('native owner qualification output group differs');
  const bytes = Buffer.from(manifest.contents, 'utf8');
  equal(
    files.get(file),
    { sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length },
    'native BEP/owner qualification digest',
  );
  const rootConfigurations = roots.map((root) => {
    const matching = bep.completed.filter(
      (candidate) => canonicalShippingLabel(candidate.label) === canonicalShippingLabel(root.label),
    );
    if (
      matching.length !== 1 ||
      matching[0].value.success !== true ||
      !bep.configs.has(matching[0].configuration)
    )
      throw new Error('native owner qualification has no unambiguous configured shipping root');
    return { label: canonicalShippingLabel(root.label), configuration: matching[0].configuration };
  });
  const requiredTests = tests.map((label) => {
    const matching = bep.completed.filter(
      (candidate) => canonicalShippingLabel(candidate.label) === label,
    );
    if (
      matching.length !== 1 ||
      matching[0].value.success !== true ||
      !bep.configs.has(matching[0].configuration)
    )
      throw new Error('native owner qualification has no unambiguous mandatory configured test');
    return { label, configuration: matching[0].configuration };
  });
  return {
    owner: label,
    configuration: target.configuration,
    roots: labels,
    rootConfigurations,
    requiredTests,
    policies: policies.map((policy) => ({
      owner: policy.owner,
      roots: policy.roots,
      requiredTests: requiredTests.filter((test) => policy.qualification.includes(test.label)),
    })),
  };
}

/** A test from another owner cannot qualify an owner with no declared policy. */
export function nativeShippingRootsHaveQualification(
  policy: ReturnType<typeof nativeShippingQualificationPolicy>,
  roots: Pick<NativeRoot, 'label'>[],
) {
  return (
    !!policy &&
    roots.length > 0 &&
    roots.every((root) =>
      (policy.policies ?? [policy]).some(
        (owner) =>
          owner.roots.includes(canonicalShippingLabel(root.label)) &&
          owner.requiredTests.length > 0,
      ),
    )
  );
}

/** Actual observer Files of source-owned mandatory configured tests; never shipping inputs. */
export function nativeQualificationInputBindings(
  aquery: unknown,
  bep: ReturnType<typeof nativeBuildEventIndex>,
  policy: ReturnType<typeof nativeShippingQualificationPolicy>,
) {
  return (policy?.requiredTests ?? []).flatMap((test) => {
    const targets = bep.completed.filter(
      (target) =>
        canonicalShippingLabel(target.label) === test.label &&
        target.configuration === test.configuration,
    );
    if (targets.length !== 1 || targets[0].value.success !== true)
      throw new Error('native qualification requires one successful source-owned configured test');
    const groups = list(targets[0].value.outputGroup ?? []).filter(
      (group) => group.name === 'observation_inputs',
    );
    if (!groups.length) return [];
    if (groups.length !== 1)
      throw new Error('native qualification requires one observation_inputs group');
    const files = bep.filesOf(targets[0].value, 'observation_inputs');
    if (![3, 4].includes(files.size))
      throw new Error(
        'native installed qualification requires its exact three or four observer Files',
      );
    for (const file of files.keys())
      if (!file.startsWith('bazel-out/'))
        throw new Error('native qualification observer requires a generated bazel-out File');
    const declared = configuredAqueryTargetInputs(aquery, test.label, test.configuration);
    for (const file of files.keys())
      if (!declared.inputs.has(file))
        throw new Error(
          'native qualification observer File was not consumed by its configured test',
        );
    const specifications = [...files.keys()].filter((file) => declared.written.has(file));
    if (specifications.length !== 1)
      throw new Error(
        'native qualification requires exactly one same-test configured specification FileWrite',
      );
    return [{ ...test, specification: specifications[0], files }];
  });
}

function validateNativeQualificationInputs(
  raw: unknown,
  bindings: ReturnType<typeof nativeQualificationInputBindings>,
) {
  const seen = new Set<string>();
  const result = (raw === undefined ? [] : list(raw)).map((value) => {
    const row = object(value);
    exactFields(
      row,
      ['label', 'configuration', 'specification', 'inputs'],
      'native qualification inputs',
    );
    const label = canonicalShippingLabel(row.label),
      configuration = text(row.configuration);
    const key = `${label}\0${configuration}`;
    if (seen.has(key)) throw new Error('duplicate native qualification inputs');
    seen.add(key);
    const binding = bindings.find(
      (test) => test.label === label && test.configuration === configuration,
    );
    if (!binding)
      throw new Error('native qualification inputs are not a source-owned observer test');
    equal(relative(row.specification), binding.specification, 'native qualification specification');
    const captured = captures(
      row.inputs,
      [...binding.files.keys()],
      'native qualification observer',
    );
    for (const [file, capture] of captured) {
      const member = capture.members[0];
      if (capture.members.length !== 1 || member.type !== 'file')
        throw new Error('native qualification observer requires a regular File');
      equal(
        { sha256: member.sha256, size: member.size },
        binding.files.get(file),
        'native qualification BEP/physical observer digest',
      );
    }
    return {
      label,
      configuration,
      specification: binding.specification,
      inputs: structuredClone([...captured.values()]),
    };
  });
  equal(
    [...seen].sort(),
    bindings.map((test) => `${test.label}\0${test.configuration}`).sort(),
    'native qualification inputs coverage',
  );
  return result;
}

/** Validate content reported by the actual qualifying builder, including cache-backed success. */
export function validateNativeBuildEvidence(
  raw: unknown,
  expected: {
    source: NativeBuildSource;
    github: NativeBuildGithub;
    bazelVersion: string;
    requiredTests?: NativeRequiredTest[];
    requireShippingAnalysis?: boolean;
  },
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
  const requiredTests =
    expected.requiredTests === undefined
      ? undefined
      : list(expected.requiredTests).map((raw) => {
          const row = object(raw);
          exactFields(row, ['label', 'configuration'], 'native required test');
          return {
            label: canonicalShippingLabel(row.label),
            configuration: text(row.configuration),
          };
        });
  if (
    requiredTests &&
    (!requiredTests.length ||
      new Set(requiredTests.map((test) => `${test.label}\0${test.configuration}`)).size !==
        requiredTests.length)
  )
    throw new Error('native required tests must be a nonempty unique configured root set');
  const testObservations = new Map<
    string,
    { label: string; configuration: string; invocationId: string }[]
  >();
  const policyTests = new Map<string, NativeRequiredTest>();
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
        ...(cohort.producerCapture === undefined ? [] : ['producerCapture']),
        ...(cohort.seedConstructions === undefined ? [] : ['seedConstructions']),
        ...(cohort.analysisInputs === undefined ? [] : ['analysisInputs']),
        ...(cohort.rootAnalysisInputPaths === undefined ? [] : ['rootAnalysisInputPaths']),
        ...(cohort.qualificationInputs === undefined ? [] : ['qualificationInputs']),
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
    const analysis = nativeAnalysisInputBindings(cohort);
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
    const inputs = captures(
      cohort.inputs,
      nativeRequiredCaptureInputs(view),
      'native input content',
    );
    const seedConstructions = validateNativeSeedConstructions(
      cohort.seedConstructions,
      [...inputs.values()],
      actions,
    );
    const outputs = captures(
      cohort.outputs,
      cohort.roots.flatMap((root) => root.package.outputs.map((output) => relative(output.path))),
      'native output content',
    );
    const bep = nativeBuildEventIndex(
      cohort,
      expected.bazelVersion,
      nativeBuildMetadata(expected.source, expected.github),
    );
    if (invocations.has(bep.invocationId))
      throw new Error('native evidence repeats a build invocation');
    invocations.add(bep.invocationId);
    if (cohort.producerCapture !== undefined) {
      const bindings = nativeShippingManifestBindings(cohort.producerCapture, bep);
      equal(
        bindings.map(({ root }) => root).sort((a, b) => a.label.localeCompare(b.label)),
        [...cohort.roots].sort((a, b) => a.label.localeCompare(b.label)),
        'native analysis shipping roots',
      );
      for (const { root, configuration } of bindings)
        equal(
          rootConfigurations.get(root.label),
          configuration,
          'native analysis shipping configuration',
        );
      const manifestView = buildShippingInputView(
        {
          schema: 'oliphaunt-bazel-shipping-v1',
          scope: 'construction',
          packages: bindings.map(({ root, path }) => ({
            ...root.package,
            outputs: [{ path, owner: root.label }],
          })),
        },
        cohort.aquery,
        {
          configurationByOutput: new Map(
            bindings.map(({ path, configuration }) => [path, configuration]),
          ),
        },
      );
      for (const product of Object.values(manifestView.products))
        for (const action of product.actions) {
          const definition = object(JSON.parse(action));
          if (definition.mnemonic !== 'FileWrite' || definition.inputs.count !== 0)
            throw new Error('native shipping manifest requires its configured FileWrite action');
        }
    } else if (expected.requireShippingAnalysis === true)
      throw new Error('native qualification requires producing-analysis shipping manifests');
    const qualificationPolicy =
      cohort.producerCapture === undefined
        ? undefined
        : nativeShippingQualificationPolicy(cohort.producerCapture, bep, cohort.roots);
    if (qualificationPolicy) {
      for (const test of qualificationPolicy.requiredTests)
        policyTests.set(`${test.label}\0${test.configuration}`, test);
      const policyView = buildShippingInputView(
        {
          schema: 'oliphaunt-bazel-shipping-v1',
          scope: 'construction',
          packages: [
            {
              ...cohort.roots[0].package,
              outputs: [
                {
                  path: cohort.producerCapture!.qualificationManifest!.path,
                  owner: qualificationPolicy.owner,
                },
              ],
            },
          ],
        },
        cohort.aquery,
        {
          configurationByOutput: new Map([
            [
              cohort.producerCapture!.qualificationManifest!.path,
              qualificationPolicy.configuration,
            ],
          ]),
        },
      );
      for (const product of Object.values(policyView.products))
        for (const action of product.actions) {
          const definition = object(JSON.parse(action));
          if (definition.mnemonic !== 'FileWrite' || definition.inputs.count !== 0)
            throw new Error('native owner qualification requires its configured FileWrite action');
        }
    }
    const qualificationInputs = validateNativeQualificationInputs(
      cohort.qualificationInputs,
      nativeQualificationInputBindings(cohort.aquery, bep, qualificationPolicy),
    );
    const cohortTests = new Map(
      (requiredTests ?? []).map((test) => [`${test.label}\0${test.configuration}`, test]),
    );
    for (const test of qualificationPolicy?.requiredTests ?? [])
      cohortTests.set(`${test.label}\0${test.configuration}`, test);
    for (const test of cohortTests.values()) {
      const matches = (event: Row, field: string) =>
        event.id?.[field] !== undefined &&
        canonicalShippingLabel(event.id[field].label) === test.label &&
        event.id[field].configuration?.id === test.configuration;
      const summaries = bep.events.filter((event) => matches(event, 'testSummary'));
      if (!summaries.length) {
        if (
          qualificationPolicy?.requiredTests.some(
            (required) =>
              required.label === test.label && required.configuration === test.configuration,
          )
        )
          throw new Error(
            `native owner policy is missing its mandatory configured test: ${test.label}`,
          );
        continue;
      }
      const targets = bep.completed.filter(
        (target) =>
          canonicalShippingLabel(target.label) === test.label &&
          target.configuration === test.configuration,
      );
      const results = bep.events.filter((event) => matches(event, 'testResult'));
      if (
        summaries.length !== 1 ||
        summaries[0].testSummary?.overallStatus !== 'PASSED' ||
        size(summaries[0].testSummary?.totalRunCount ?? 0) === 0 ||
        targets.length !== 1 ||
        targets[0].value.success !== true ||
        !bep.configs.has(test.configuration) ||
        !results.length ||
        results.some((event) => event.testResult?.status !== 'PASSED') ||
        size(summaries[0].testSummary.totalRunCount) !== results.length ||
        new Set(results.map((event) => canonical(event.id.testResult))).size !== results.length
      )
        throw new Error(
          `native BEP requires complete successful test results: ${test.label} (${test.configuration})`,
        );
      const key = `${test.label}\0${test.configuration}`;
      testObservations.set(key, [
        ...(testObservations.get(key) ?? []),
        { ...test, invocationId: bep.invocationId },
      ]);
    }
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
          const files = bep.filesOf(target.value, 'default');
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
      const files = bep.filesOf(target.value, 'default');
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
      ...(qualificationPolicy ? { qualificationPolicy } : {}),
      ...(qualificationInputs.length ? { qualificationInputs } : {}),
      ...(seedConstructions.length ? { seedConstructions } : {}),
      ...(analysis
        ? {
            rootAnalysisInputPaths: analysis.mappings,
            analysisInputsDigest: digest(analysis.inputs),
          }
        : {}),
    };
  });
  if (requiredTests && policyTests.size)
    for (const test of policyTests.values())
      if (
        !requiredTests.some(
          (required) =>
            required.label === test.label && required.configuration === test.configuration,
        )
      )
        throw new Error(
          `native required test plan omits source-owned mandatory configured test: ${test.label}`,
        );
  const testsToVerify = requiredTests ?? [...policyTests.values()];
  const tests = testsToVerify.map((test) => {
    const matches = testObservations.get(`${test.label}\0${test.configuration}`) ?? [];
    if (matches.length !== 1)
      throw new Error(
        `native BEP requires one mandatory configured test: ${test.label} (${test.configuration}); found ${matches.length}`,
      );
    return matches[0];
  });
  return {
    scope: 'construction' as const,
    source: evidence.source,
    github: evidence.github,
    cohorts,
    shippingAnalysis: evidence.cohorts.every((cohort) => cohort.producerCapture !== undefined)
      ? ('bound' as const)
      : ('unverified' as const),
    testQualification: testsToVerify.length ? ('passed' as const) : ('unverified' as const),
    requiredTests: tests,
    qualificationPolicy: cohorts.every((cohort) =>
      nativeShippingRootsHaveQualification(cohort.qualificationPolicy, cohort.roots),
    )
      ? ('bound' as const)
      : ('unverified' as const),
    releaseDecision: 'unverified' as const,
    unverified: [
      'authenticated producing workflow, attempt, job and immutable artifact',
      'immutable input lifetime from the producing build through content capture',
      'native action-graph dump bytes authenticated by the producing invocation',
      ...(evidence.cohorts.some((cohort) => cohort.producerCapture === undefined)
        ? ['shipping identities and configurations bound to the producing analysis']
        : []),
      ...(cohorts.some(
        (cohort) => !nativeShippingRootsHaveQualification(cohort.qualificationPolicy, cohort.roots),
      )
        ? ['source-owned mandatory qualification policy bound to every configured shipping root']
        : []),
      ...(!testsToVerify.length
        ? ['declared mandatory test roots and successful BEP results']
        : []),
      'complete canonical product qualification and completed-baseline admission',
    ],
  };
}

/** Preparation checks the checkout API; final selected Swift must also qualify
 * the exact prospective installed package under its final source-owned policy.
 * These are checks on captured configured facts, never producer authority. */
export function assertNativeSwiftShippingPhase(
  qualification: ReturnType<typeof validateNativeBuildEvidence>,
  phase: 'pre-version' | 'final',
) {
  const sourceOwners = [
    '//src/native/sdks/swift:preparation_shipping_export',
    '//src/native/sdks/swift:shipping_export',
  ];
  const sourceRoots = qualification.cohorts.flatMap((cohort) =>
    cohort.roots
      .filter(
        (root) =>
          root.package.product === 'oliphaunt-swift' &&
          ((root.package.ecosystem === 'github' &&
            root.package.role === 'release-input' &&
            root.package.name === 'Oliphaunt-source.zip') ||
            cohort.qualificationPolicy?.policies.some(
              (policy) =>
                sourceOwners.includes(policy.owner) &&
                policy.roots.includes(canonicalShippingLabel(root.label)),
            )),
      )
      .map((root) => ({ cohort, root })),
  );
  if (!sourceRoots.length) return;
  const owner =
    phase === 'pre-version'
      ? '//src/native/sdks/swift:preparation_shipping_export'
      : '//src/native/sdks/swift:shipping_export';
  for (const { cohort, root } of sourceRoots) {
    const policies = cohort.qualificationPolicy?.policies ?? [];
    const matches = policies.filter((policy) =>
      policy.roots.includes(canonicalShippingLabel(root.label)),
    );
    if (
      matches.length !== 1 ||
      (phase === 'final' ? matches[0].owner !== owner : !sourceOwners.includes(matches[0].owner))
    )
      throw new Error('Swift ' + phase + ' requires its source-owned ' + owner + ' policy');
    if (
      phase === 'final' &&
      !matches[0].requiredTests.some(
        (test) => test.label === '//src/native/sdks/swift:installed_consumer_test',
      )
    )
      throw new Error('final selected Swift requires its configured installed consumer test');
  }
}

/** Final selected source owners must carry their installed requirement proof. */
export function assertNativeFinalShippingPhase(
  qualification: ReturnType<typeof validateNativeBuildEvidence>,
  selectedProducts: readonly string[],
) {
  if (selectedProducts.includes('oliphaunt-swift'))
    assertNativeSwiftShippingPhase(qualification, 'final');
  for (const cohort of qualification.cohorts)
    for (const root of cohort.roots.filter(
      (root) =>
        selectedProducts.includes(root.package.product) &&
        root.package.ecosystem === 'cargo' &&
        ((root.package.product === 'oliphaunt-rust' && root.package.name === 'oliphaunt') ||
          (root.package.product === 'oliphaunt-broker' &&
            root.package.name === 'oliphaunt-broker')),
    )) {
      const policies = (cohort.qualificationPolicy?.policies ?? []).filter((policy) =>
        policy.roots.includes(canonicalShippingLabel(root.label)),
      );
      if (
        policies.length !== 1 ||
        !policies[0].requiredTests.some(
          (test) => test.label === '//build_defs/languages/installed:consumer_minimum_test',
        )
      )
        throw new Error(
          'final selected Cargo source requires its configured declared-minimum consumer test',
        );
    }
}
