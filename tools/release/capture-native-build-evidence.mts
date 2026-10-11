#!/usr/bin/env bun
import { createHash } from 'node:crypto';
/** Collect current configured contents after a successful build; this grants no release authority. */
import { linkSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { requireSafeDirectoryChain } from '../packaging/release-directory-safety.mts';
import { buildShippingInputView, canonicalShippingLabel } from './bazel-shipping-inputs.mts';
import {
  type NativeBuildEvidence,
  type NativeBuildGithub,
  type NativeBuildSource,
  nativeBuildEventIndex,
  nativeBuildMetadata,
  nativeShippingManifestBindings,
  validateNativeBuildEvidence,
} from './native-build-qualification.mts';
import { type NativeRoot, nativeOutputPath } from './native-publication-artifacts.mts';
import {
  captureNativeInputMembers,
  captureNativeOutputMembers,
} from './native-publication-staging.mts';
import { sourceIdentity } from './publication-lock.mts';

export type NativeBuildCaptureCohort = {
  executionRoot: string;
  aquery: unknown;
  buildEvents: unknown[];
} & ({ roots: NativeRoot[]; cquery: unknown } | { shippingRoots: string[]; aqueryFile: string });

function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('native capture requires an object');
  return value as Record<string, any>;
}
function array(value: unknown): any[] {
  if (!Array.isArray(value)) throw new Error('native capture requires a list');
  return value;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value || /[\u0000-\u001f\u007f]/u.test(value))
    throw new Error('native capture requires a nonempty identity');
  return value;
}
function configurationId(value: unknown) {
  if (!Number.isSafeInteger(value) || Number(value) <= 0 || Number(value) > 0xffffffff)
    throw new Error('native cquery configuration ID is invalid or null');
  return Number(value);
}

/** CqueryResult IDs are dump-local; BEP identifies the configuration by its checksum. */
export function nativeRootConfigurations(roots: NativeRoot[], raw: unknown) {
  const query = object(raw);
  const configurations = new Map<number, string>();
  for (const item of array(query.configurations)) {
    const row = object(item);
    const id = configurationId(row.id);
    if (configurations.has(id)) throw new Error('duplicate native cquery configuration');
    configurations.set(id, text(row.checksum));
  }
  const results = array(query.results).map(object);
  return roots.map((root) => {
    const matches = results.filter(
      (result) =>
        result.target?.rule?.name !== undefined &&
        canonicalShippingLabel(result.target.rule.name) === canonicalShippingLabel(root.label),
    );
    if (matches.length !== 1)
      throw new Error(`native cquery requires one configured rule for ${root.label}`);
    const configuration = configurations.get(configurationId(matches[0].configurationId));
    if (!configuration) throw new Error('native cquery root configuration is missing');
    return { label: root.label, configuration };
  });
}

/** The producing job must freeze inputs across build and capture; this observes current contents. */
export function captureNativeBuildEvidence({
  source,
  github,
  cohorts,
  bazelVersion,
}: {
  source: NativeBuildSource;
  github: NativeBuildGithub;
  cohorts: NativeBuildCaptureCohort[];
  bazelVersion: string;
}) {
  const captures: ReturnType<typeof captureNativeInputMembers>[] = [];
  const evidence: NativeBuildEvidence = {
    schema: 'oliphaunt-native-build-evidence-v1',
    source,
    github,
    cohorts: cohorts.map((cohort) => {
      let roots: NativeRoot[];
      let rootConfigurations: { label: string; configuration: string }[];
      let producerCapture: NativeBuildEvidence['cohorts'][number]['producerCapture'];
      if ('shippingRoots' in cohort) {
        const labels = array(cohort.shippingRoots).map((label) =>
          canonicalShippingLabel(text(label)),
        );
        if (!labels.length || new Set(labels).size !== labels.length)
          throw new Error('native producer requires unique selected shipping roots');
        const bep = nativeBuildEventIndex(
          cohort,
          bazelVersion,
          nativeBuildMetadata(source, github),
        );
        const shippingManifests = labels.map((label) => {
          const targets = bep.completed.filter(
            (target) => canonicalShippingLabel(target.label) === label,
          );
          if (targets.length !== 1 || targets[0].value.success !== true)
            throw new Error(
              `native producer requires one successful configured shipping root: ${label}`,
            );
          const files = bep.filesOf(targets[0].value, 'shipping_manifest');
          if (files.size !== 1)
            throw new Error(`native producer requires one shipping_manifest file: ${label}`);
          const file = [...files.keys()][0];
          const capture = captureNativeOutputMembers(cohort.executionRoot, file);
          captures.push(capture);
          const contents = readFileSync(nativeOutputPath(cohort.executionRoot, file), 'utf8');
          const bytes = Buffer.from(contents, 'utf8');
          const member = capture.members[0];
          if (
            capture.members.length !== 1 ||
            member.type !== 'file' ||
            member.size !== bytes.length ||
            member.sha256 !== createHash('sha256').update(bytes).digest('hex')
          )
            throw new Error('native shipping manifest physical contents changed during capture');
          capture.assertUnchanged();
          return { path: file, contents };
        });
        producerCapture = { aqueryFile: cohort.aqueryFile, shippingManifests };
        const bindings = nativeShippingManifestBindings(producerCapture, bep);
        if (
          JSON.stringify(bindings.map(({ root }) => canonicalShippingLabel(root.label)).sort()) !==
          JSON.stringify([...labels].sort())
        )
          throw new Error('native selected/analysis shipping root coverage mismatch');
        roots = bindings.map(({ root }) => root);
        rootConfigurations = bindings.map(({ root, configuration }) => ({
          label: root.label,
          configuration,
        }));
      } else {
        roots = cohort.roots;
        rootConfigurations = nativeRootConfigurations(roots, cohort.cquery);
      }
      const view = buildShippingInputView(
        {
          schema: 'oliphaunt-bazel-shipping-v1',
          scope: 'construction',
          packages: roots.map((root) => root.package),
        },
        cohort.aquery,
      );
      const inputs = view.physicalInputs;
      const outputs = [
        ...new Set(roots.flatMap((root) => root.package.outputs.map((output) => output.path))),
      ].sort();
      const capture = (file: string, output: boolean) => {
        const value = output
          ? captureNativeOutputMembers(cohort.executionRoot, file)
          : captureNativeInputMembers(cohort.executionRoot, file);
        captures.push(value);
        return { path: file, members: value.members };
      };
      return {
        executionRoot: cohort.executionRoot,
        roots,
        rootConfigurations,
        aquery: cohort.aquery,
        buildEvents: cohort.buildEvents,
        inputs: inputs.map((file) => capture(file, false)),
        outputs: outputs.map((file) => capture(file, true)),
        ...(producerCapture === undefined ? {} : { producerCapture }),
      };
    }),
  };
  const qualification = validateNativeBuildEvidence(evidence, { source, github, bazelVersion });
  return {
    evidence,
    qualification,
    assertUnchanged() {
      for (const capture of captures) capture.assertUnchanged();
    },
  };
}

/** Retain the native event index's protocol, excluding ambient invocation options and logs. */
function retainedBuildEvents(evidence: NativeBuildEvidence, events: unknown[]) {
  const pick = (raw: unknown, fields: string[]) => {
    const value = object(raw);
    return Object.fromEntries(
      fields.filter((field) => value[field] !== undefined).map((field) => [field, value[field]]),
    );
  };
  const identity = (raw: unknown) => {
    const value = { ...object(raw) };
    // Fetch URLs are unused by qualification and can contain credentials.
    if (value.fetch !== undefined) value.fetch = pick(value.fetch, []);
    return value;
  };
  const files = (raw: unknown) =>
    array(raw ?? []).map((file) =>
      pick(file, ['pathPrefix', 'name', 'digest', 'length', 'symlinkTargetPath']),
    );
  const sets = (raw: unknown) => array(raw ?? []).map((set) => pick(set, ['id']));
  const metadataKeys = new Set(Object.keys(nativeBuildMetadata(evidence.source, evidence.github)));
  const nativeOptions = new Set([
    'experimental_aquery_dump_after_build_format',
    'experimental_aquery_dump_after_build_output_file',
    'output_groups',
  ]);
  return events.map((raw) => {
    const event = object(raw);
    const retained: Record<string, any> = pick(event, ['lastMessage']);
    if (event.id !== undefined) retained.id = identity(event.id);
    if (event.children !== undefined) retained.children = array(event.children).map(identity);
    if (event.started !== undefined)
      retained.started = pick(event.started, ['uuid', 'buildToolVersion']);
    if (event.workspaceInfo !== undefined)
      retained.workspaceInfo = pick(event.workspaceInfo, ['localExecRoot']);
    if (event.configuration !== undefined)
      retained.configuration = pick(event.configuration, [
        'mnemonic',
        'platformName',
        'cpu',
        'isTool',
      ]);
    if (event.buildMetadata !== undefined)
      retained.buildMetadata = {
        metadata: Object.fromEntries(
          Object.entries(object(event.buildMetadata.metadata)).filter(([key]) =>
            metadataKeys.has(key),
          ),
        ),
      };
    if (event.finished !== undefined)
      retained.finished = {
        ...pick(event.finished, ['overallSuccess']),
        exitCode: pick(event.finished.exitCode, ['name', 'code']),
      };
    if (event.namedSetOfFiles !== undefined)
      retained.namedSetOfFiles = {
        files: files(event.namedSetOfFiles.files),
        fileSets: sets(event.namedSetOfFiles.fileSets),
      };
    if (event.completed !== undefined)
      retained.completed = {
        ...pick(event.completed, ['success']),
        outputGroup: array(event.completed.outputGroup ?? []).map((group) => ({
          ...pick(group, ['name', 'incomplete']),
          fileSets: sets(group.fileSets),
          inlineFiles: files(group.inlineFiles),
        })),
      };
    if (event.aborted !== undefined) retained.aborted = pick(event.aborted, ['reason']);
    if (event.testSummary !== undefined)
      retained.testSummary = pick(event.testSummary, ['overallStatus', 'totalRunCount']);
    if (event.testResult !== undefined) retained.testResult = pick(event.testResult, ['status']);
    if (event.structuredCommandLine?.commandLineLabel === 'canonical')
      retained.structuredCommandLine = {
        commandLineLabel: 'canonical',
        sections: [
          {
            sectionLabel: 'command options',
            optionList: {
              option: array(event.structuredCommandLine.sections).flatMap((section) =>
                array(section.optionList?.option ?? [])
                  .filter((option) => nativeOptions.has(option.optionName))
                  .map((option) => pick(option, ['optionName', 'optionValue'])),
              ),
            },
          },
        ],
      };
    return retained;
  });
}

/** Publish one validated packet without replacing a previous capture. */
export function writeNativeBuildEvidence(
  captured: ReturnType<typeof captureNativeBuildEvidence>,
  directory: string,
) {
  const parent = requireSafeDirectoryChain(directory, { create: true, label: 'native evidence' });
  const temporary = mkdtempSync(path.join(parent, '.native-evidence-'));
  const output = path.join(parent, 'native-build-evidence.json');
  try {
    captured.assertUnchanged();
    const file = path.join(temporary, 'evidence.json');
    const evidence = {
      ...captured.evidence,
      cohorts: captured.evidence.cohorts.map((cohort) => ({
        ...cohort,
        buildEvents: retainedBuildEvents(captured.evidence, cohort.buildEvents),
      })),
    };
    writeFileSync(file, `${JSON.stringify(evidence)}\n`, { flag: 'wx', mode: 0o600 });
    captured.assertUnchanged();
    linkSync(file, output);
    return output;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function json(file: string) {
  return JSON.parse(readFileSync(file, 'utf8'));
}
function jsonLines(file: string) {
  return readFileSync(file, 'utf8')
    .split(/\r?\n/u)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function main() {
  const args = process.argv.slice(2);
  const cohorts: NativeBuildCaptureCohort[] = [];
  let githubFile: string | undefined;
  let output: string | undefined;
  let ref: string | undefined;
  let metadata = false;
  const value = () => {
    const value = args.shift();
    if (!value || value.startsWith('--')) throw new Error('native capture argument is missing');
    return value;
  };
  while (args.length) {
    const option = args.shift();
    if (option === '--github-json' && githubFile === undefined) githubFile = value();
    else if (option === '--output-directory' && output === undefined) output = value();
    else if (option === '--source-ref' && ref === undefined) ref = value();
    else if (option === '--build-metadata' && !metadata) metadata = true;
    else if (option === '--cohort') {
      const roots = value();
      const cquery = value();
      const aquery = value();
      const buildEvents = value();
      const executionRoot = value();
      cohorts.push({
        roots: jsonLines(roots),
        cquery: json(cquery),
        aquery: json(aquery),
        buildEvents: jsonLines(buildEvents),
        executionRoot,
      });
    } else if (option === '--producer-cohort') {
      const roots = value();
      const aquery = value();
      const buildEvents = value();
      const executionRoot = value();
      cohorts.push({
        shippingRoots: json(roots),
        aqueryFile: path.resolve(aquery),
        aquery: json(aquery),
        buildEvents: jsonLines(buildEvents),
        executionRoot,
      });
    } else throw new Error(`unknown or repeated native capture argument: ${option}`);
  }
  if (metadata) {
    if (!githubFile || output || cohorts.length)
      throw new Error('--build-metadata requires --github-json and no capture outputs/cohorts');
    for (const [key, value] of Object.entries(
      nativeBuildMetadata(sourceIdentity(ref ?? 'HEAD'), json(githubFile)),
    ))
      console.log(`--build_metadata=${key}=${value}`);
    return;
  }
  if (!githubFile || !output || !cohorts.length)
    throw new Error(
      'usage: capture-native-build-evidence.mts --github-json FILE --producer-cohort ROOT_LABELS.json AQUERY.json BEP.jsonl EXECROOT [--producer-cohort ...] --output-directory DIR [--source-ref REF]',
    );
  const captured = captureNativeBuildEvidence({
    source: sourceIdentity(ref ?? 'HEAD'),
    github: json(githubFile),
    cohorts,
    bazelVersion: readFileSync(new URL('../../.bazelversion', import.meta.url), 'utf8').trim(),
  });
  console.log(writeNativeBuildEvidence(captured, output));
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
