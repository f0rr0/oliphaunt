#!/usr/bin/env bun
/** Collect current configured contents after a successful build; this grants no release authority. */
import { linkSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { requireSafeDirectoryChain } from '../packaging/release-directory-safety.mts';
import { buildShippingInputView, canonicalShippingLabel } from './bazel-shipping-inputs.mts';
import {
  type NativeBuildEvidence,
  type NativeBuildGithub,
  type NativeBuildSource,
  nativeBuildMetadata,
  validateNativeBuildEvidence,
} from './native-build-qualification.mts';
import type { NativeRoot } from './native-publication-artifacts.mts';
import {
  captureNativeInputMembers,
  captureNativeOutputMembers,
} from './native-publication-staging.mts';
import { sourceIdentity } from './publication-lock.mts';

export type NativeBuildCaptureCohort = {
  executionRoot: string;
  roots: NativeRoot[];
  cquery: unknown;
  aquery: unknown;
  buildEvents: unknown[];
};

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
      const view = buildShippingInputView(
        {
          schema: 'oliphaunt-bazel-shipping-v1',
          scope: 'construction',
          packages: cohort.roots.map((root) => root.package),
        },
        cohort.aquery,
      );
      const inputs = view.physicalInputs;
      const outputs = [
        ...new Set(
          cohort.roots.flatMap((root) => root.package.outputs.map((output) => output.path)),
        ),
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
        roots: cohort.roots,
        rootConfigurations: nativeRootConfigurations(cohort.roots, cohort.cquery),
        aquery: cohort.aquery,
        buildEvents: cohort.buildEvents,
        inputs: inputs.map((file) => capture(file, false)),
        outputs: outputs.map((file) => capture(file, true)),
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
    writeFileSync(file, `${JSON.stringify(captured.evidence)}\n`, { flag: 'wx', mode: 0o600 });
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
      'usage: capture-native-build-evidence.mts --github-json FILE --cohort ROOTS.jsonl CQUERY.json AQUERY.json BEP.jsonl EXECROOT [--cohort ...] --output-directory DIR [--source-ref REF]',
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
