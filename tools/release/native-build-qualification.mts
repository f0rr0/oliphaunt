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
export type NativeProducerCapture = {
  aqueryFile: string;
  shippingManifests: { path: string; contents: string }[];
  /** The existing owner export, delivered by the same producing invocation. */
  qualificationManifest?: { path: string; contents: string };
};
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
  const filesOf = (target: Row, groupName?: string) => {
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
      if (groupName !== undefined && group.name !== groupName) continue;
      if (group.incomplete === true) throw new Error('native BEP output group is incomplete');
      for (const set of list(group.fileSets ?? [])) visit(text(set.id));
      for (const file of list(group.inlineFiles ?? [])) visitFile(file);
    }
    return files;
  };
  return { invocationId, configs, completed, filesOf, events };
}

/** Native metadata is content-bound by BEP; the separate action dump has no native digest receipt. */
export function nativeShippingManifestBindings(
  raw: NativeProducerCapture,
  bep: ReturnType<typeof nativeBuildEventIndex>,
) {
  const capture = object(raw) as NativeProducerCapture;
  exactFields(
    capture,
    [
      'aqueryFile',
      'shippingManifests',
      ...(capture.qualificationManifest ? ['qualificationManifest'] : []),
    ],
    'native producer capture',
  );
  if (
    !path.posix.isAbsolute(text(capture.aqueryFile)) &&
    !path.win32.isAbsolute(capture.aqueryFile)
  )
    throw new Error('native producer requires an absolute after-build aquery file');
  const commands = bep.events.filter(
    (event) => event.structuredCommandLine?.commandLineLabel === 'canonical',
  );
  if (commands.length !== 1) throw new Error('native producer requires one canonical command line');
  const options = list(commands[0].structuredCommandLine.sections).flatMap((section) =>
    list(object(section).optionList?.option ?? []),
  );
  for (const [name, value] of [
    ['experimental_aquery_dump_after_build_format', 'jsonproto'],
    ['experimental_aquery_dump_after_build_output_file', capture.aqueryFile],
  ]) {
    const matches = options.filter((option) => option.optionName === name);
    if (matches.length !== 1 || matches[0].optionValue !== value)
      throw new Error(`native producer command line requires ${name}=${value}`);
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
    const declaredInputs = view.physicalInputs.map(relative);
    const inputs = captures(cohort.inputs, declaredInputs, 'native input content');
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
      ...(qualificationPolicy ? { qualificationPolicy } : {}),
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
