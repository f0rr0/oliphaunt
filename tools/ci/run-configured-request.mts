#!/usr/bin/env bun
/** Execute one authored CI request; only a full baseline captures its configured scope. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { canonicalShippingLabel } from '../release/bazel-shipping-inputs.mts';
import {
  type NativeBuildGithub,
  type NativeRequiredTest,
  nativeBuildEventIndex,
  nativeBuildMetadata,
} from '../release/native-build-qualification.mts';
import { sourceIdentity } from '../release/with-source.mts';
import {
  assertConfiguredCiSource,
  captureConfiguredCiRequest,
  writeConfiguredCiSuccessReceipt,
} from './configured-scope.mts';

export type ConfiguredRequest = {
  id: string;
  job: string;
  mode: 'full' | 'source';
  command: 'test' | 'build';
  targets: string[];
  configuration: string[];
  startup?: string[];
  requires?: string[];
  outputDirectory: string;
  github: NativeBuildGithub;
};

/** Authoritative executed leaves, including expanded suites and mixed build roots. */
export function completedCiRequestRoots(
  index: ReturnType<typeof nativeBuildEventIndex>,
  requestedTargets: string[],
): NativeRequiredTest[] {
  const patterns = index.events.filter((event) => event.expanded && event.id?.pattern);
  assert(patterns.length === 1, 'complete CI baseline requires its producing target expansion');
  assert.deepEqual(
    patterns[0].id.pattern.pattern,
    requestedTargets,
    'CI target expansion differs from its authored request',
  );
  const expected = (patterns[0].children ?? []).flatMap((child: any) =>
    child.targetConfigured ? [canonicalShippingLabel(child.targetConfigured.label)] : [],
  );
  assert(
    expected.length > 0 && new Set(expected).size === expected.length,
    'CI expanded leaves are missing or duplicated',
  );
  assert.deepEqual(
    index.events
      .filter((event) => event.id?.targetConfigured)
      .map((event) => canonicalShippingLabel(event.id.targetConfigured.label))
      .sort(),
    [...expected].sort(),
    'CI configured leaves differ from the producing expansion',
  );
  const roots = new Map<string, NativeRequiredTest>();
  const admittedTests = new Set<string>();
  for (const label of expected) {
    const configured = index.events.filter(
      (event) =>
        event.id?.targetConfigured &&
        canonicalShippingLabel(event.id.targetConfigured.label) === label,
    );
    assert(
      configured.length === 1 && configured[0].configured,
      'CI expanded leaf lacks its configured event',
    );
    const advertised = (configured[0].children ?? []).filter((child: any) => child.targetCompleted);
    assert(
      advertised.length === 1 &&
        canonicalShippingLabel(advertised[0].targetCompleted.label) === label,
      'CI configured leaf lacks its producing completion ID',
    );
    const configuration = advertised[0].targetCompleted.configuration?.id;
    assert(
      /^[0-9a-f]{64}$/u.test(configuration) && index.configs.has(configuration),
      'complete CI baseline requires a producing configured checksum',
    );
    const completed = index.events.filter(
      (event) =>
        event.id?.targetCompleted &&
        canonicalShippingLabel(event.id.targetCompleted.label) === label &&
        event.id.targetCompleted.configuration?.id === configuration,
    );
    assert(
      completed.length === 1 && completed[0].completed?.success === true,
      'CI configured leaf lacks its successful producing completion',
    );
    const key = `${label}\0${configuration}`;
    assert(!roots.has(key), 'duplicate completed CI root');
    const scheduled = (completed[0].children ?? []).filter((child: any) => child.testSummary);
    if (scheduled.length) {
      assert(scheduled.length === 1, 'CI test summary ID is ambiguous');
      const summaryId = scheduled[0].testSummary;
      admittedTests.add(`${canonicalShippingLabel(summaryId.label)}\0${configuration}`);
      const matches = (event: (typeof index.events)[number], field: 'testSummary' | 'testResult') =>
        event.id?.[field] &&
        canonicalShippingLabel(event.id[field].label) === canonicalShippingLabel(summaryId.label) &&
        event.id[field].configuration?.id === configuration;
      const summaries = index.events.filter((event) => matches(event, 'testSummary'));
      const results = index.events.filter((event) => matches(event, 'testResult'));
      const resultKey = (id: any) => `${id.run ?? 0}:${id.shard ?? 0}:${id.attempt ?? 0}`;
      const resultIds = new Set(results.map((event) => resultKey(event.id.testResult)));
      const announced = (completed[0].children ?? []).filter((child: any) => child.testResult);
      assert(
        summaryId.configuration?.id === configuration &&
          summaries.length === 1 &&
          summaries[0].testSummary?.overallStatus === 'PASSED' &&
          Number(summaries[0].testSummary.totalRunCount) > 0 &&
          Number(summaries[0].testSummary.totalRunCount) === results.length &&
          results.every((event) => event.testResult?.status === 'PASSED') &&
          resultIds.size === results.length &&
          announced.length > 0 &&
          announced.every(
            (child: any) =>
              canonicalShippingLabel(child.testResult.label) ===
                canonicalShippingLabel(summaryId.label) &&
              child.testResult.configuration?.id === configuration &&
              resultIds.has(resultKey(child.testResult)),
          ),
        'complete CI baseline requires successful actual test summaries and results',
      );
    }
    roots.set(key, { label, configuration });
  }
  assert.deepEqual(
    index.completed
      .map((target) => `${canonicalShippingLabel(target.label)}\0${target.configuration}`)
      .sort(),
    [...roots.keys()].sort(),
    'CI producing completions differ from the expanded configured leaves',
  );
  for (const event of index.events)
    for (const field of ['testSummary', 'testResult'] as const)
      if (event.id?.[field])
        assert(
          admittedTests.has(
            `${canonicalShippingLabel(event.id[field].label)}\0${event.id[field].configuration?.id}`,
          ),
          'CI test evidence lacks its scheduled producing completion',
        );
  return [...roots.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, root]) => root);
}

export async function runConfiguredRequest(request: ConfiguredRequest, workspace = process.cwd()) {
  assert(['full', 'source'].includes(request.mode), 'CI request mode must be full or source');
  assert(['build', 'test'].includes(request.command), 'CI request command must be build or test');
  assert(request.targets.length > 0, 'CI request must retain its authored targets');
  const source = sourceIdentity('HEAD');
  await assertConfiguredCiSource(workspace, source);
  const startup = request.startup ?? [];
  const privateDirectory =
    request.mode === 'full' ? mkdtempSync(path.join(tmpdir(), 'oliphaunt-ci-request-')) : undefined;
  try {
    const metadata =
      request.mode === 'full'
        ? { ...nativeBuildMetadata(source, request.github), oliphaunt_ci_request_id: request.id }
        : undefined;
    const bepFile = privateDirectory && path.join(privateDirectory, 'build-events.jsonl');
    const args = [
      ...startup,
      request.command,
      ...request.targets,
      ...request.configuration,
      ...(bepFile ? [`--build_event_json_file=${bepFile}`] : []),
      ...Object.entries(metadata ?? {}).map(([key, value]) => `--build_metadata=${key}=${value}`),
    ];
    const result = spawnSync('bash', ['tools/dev/bazel.sh', ...args], {
      cwd: workspace,
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    if (result.error) throw result.error;
    if (result.status !== 0)
      throw new Error(`CI ${request.command} failed (${result.signal ?? result.status})`);
    const context = {
      id: request.id,
      job: request.job,
      source,
      github: request.github,
      requires: request.requires ?? [],
      outputDirectory: request.outputDirectory,
      workspaceRoot: workspace,
    };
    if (request.mode === 'source') {
      await writeConfiguredCiSuccessReceipt(context);
    } else {
      const events = readFileSync(bepFile!, 'utf8')
        .split(/\r?\n/u)
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      const roots = events.filter((event) => event.workspaceInfo !== undefined);
      assert(
        roots.length === 1 && path.isAbsolute(roots[0].workspaceInfo.localExecRoot),
        'CI producer must report one absolute execution root',
      );
      const executionRoot = roots[0].workspaceInfo.localExecRoot;
      const index = nativeBuildEventIndex(
        { executionRoot, buildEvents: events },
        readFileSync(path.join(workspace, '.bazelversion'), 'utf8').trim(),
        metadata!,
      );
      await captureConfiguredCiRequest({
        ...context,
        startup,
        configuration: request.configuration,
        requestedTargets: request.targets,
        completedRoots: completedCiRequestRoots(index, request.targets),
        executionRoot,
      });
    }
    return path.join(request.outputDirectory, 'ci-request.json');
  } finally {
    if (privateDirectory) rmSync(privateDirectory, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    const { values } = parseArgs({
      options: {
        id: { type: 'string' },
        job: { type: 'string' },
        mode: { type: 'string' },
        command: { type: 'string' },
        'output-directory': { type: 'string' },
        'startup-json': { type: 'string' },
        'configuration-json': { type: 'string' },
        'targets-json': { type: 'string' },
        'requires-json': { type: 'string' },
      },
    });
    for (const key of [
      'id',
      'job',
      'mode',
      'command',
      'output-directory',
      'configuration-json',
      'targets-json',
    ] as const)
      assert(values[key], `CI request requires --${key}`);
    const strings = (file: string) => {
      const value = JSON.parse(readFileSync(file, 'utf8'));
      assert(
        Array.isArray(value) && value.every((item) => typeof item === 'string'),
        'CI request JSON must be a string array',
      );
      return value;
    };
    const github = {
      repository: process.env.GITHUB_REPOSITORY!,
      workflow: process.env.GITHUB_WORKFLOW!,
      workflowPath: '.github/workflows/bazel.yml',
      runId: Number(process.env.GITHUB_RUN_ID),
      runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT),
      job: process.env.GITHUB_JOB!,
    };
    console.log(
      await runConfiguredRequest({
        id: values.id!,
        job: values.job!,
        mode: values.mode as ConfiguredRequest['mode'],
        command: values.command as ConfiguredRequest['command'],
        outputDirectory: values['output-directory']!,
        github,
        startup: values['startup-json'] ? strings(values['startup-json']) : [],
        configuration: strings(values['configuration-json']!),
        targets: strings(values['targets-json']!),
        requires: values['requires-json'] ? strings(values['requires-json']) : [],
      }),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
