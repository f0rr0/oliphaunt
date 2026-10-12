import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  captureSeedConstructionIntent,
  writeSeedConstructionReceipt,
} from '../../build_defs/resources/seed_construction.mts';
import {
  type NativeBuildEvidence,
  nativeAnalysisInputBindings,
  nativeBuildMetadata,
  validateNativeBuildEvidence,
  validateNativeSeedConstructions,
} from './native-build-qualification.mts';
import { captureNativeOutputMembers } from './native-publication-staging.mts';

// BEP fields follow an actual Bazel 8.8.1 capture, including omitted proto zeroes.
function fixture() {
  const executionRoot = mkdtempSync(path.join(tmpdir(), 'oliphaunt-native-build-'));
  const output = 'bazel-out/k8-opt/bin/package/native.tgz';
  const generated = 'bazel-out/k8-opt/bin/package/config.h';
  const source = 'package/source.mts';
  const tool = 'external/bun/bun';
  for (const [file, content] of [
    [output, 'packed public bytes'],
    [generated, '#define VALUE 1\n'],
    [source, 'source'],
    [tool, 'compiler'],
  ]) {
    mkdirSync(path.dirname(path.join(executionRoot, file)), { recursive: true });
    writeFileSync(path.join(executionRoot, file), content);
  }
  const capture = (file: string) => ({
    path: file,
    members: file.startsWith('bazel-out/')
      ? captureNativeOutputMembers(executionRoot, file).members
      : [
          {
            path: '',
            type: 'file' as const,
            mode: 0o644,
            size: readFileSync(path.join(executionRoot, file)).length,
            sha256: createHash('sha256')
              .update(readFileSync(path.join(executionRoot, file)))
              .digest('hex'),
          },
        ],
  });
  const files = [source, tool, generated, output];
  const aquery = {
    pathFragments: files.flatMap((file, index) => {
      const parts = file.split('/');
      return parts.map((label, segment) => ({
        id: `${index}-${segment}`,
        label,
        ...(segment ? { parentId: `${index}-${segment - 1}` } : {}),
      }));
    }),
    artifacts: files.map((file, index) => ({
      id: index + 1,
      pathFragmentId: `${index}-${file.split('/').length - 1}`,
    })),
    targets: [
      { id: 1, label: '//package:generated' },
      { id: 2, label: '//package:archive' },
    ],
    configuration: [{ id: 1, checksum: 'c'.repeat(64) }],
    depSetOfFiles: [
      { id: 1, directArtifactIds: [1] },
      { id: 2, directArtifactIds: [1, 2, 3] },
    ],
    actions: [
      {
        targetId: 1,
        configurationId: 1,
        mnemonic: 'FileWrite',
        actionKey: 'declaration-key-1',
        inputDepSetIds: [1],
        outputIds: [3],
        primaryOutputId: 3,
        fileContents: '#define VALUE 1\n',
      },
      {
        targetId: 2,
        configurationId: 1,
        mnemonic: 'Package',
        actionKey: 'declaration-key-2',
        arguments: ['bun', 'source.mts'],
        inputDepSetIds: [2],
        outputIds: [4],
        primaryOutputId: 4,
      },
    ],
  };
  const expected = {
    source: { commit: 'a'.repeat(40), tree: 'b'.repeat(40) },
    github: {
      repository: 'f0rr0/oliphaunt',
      workflow: 'Native Bazel qualification',
      workflowPath: '.github/workflows/bazel.yml',
      runId: 456,
      runAttempt: 2,
      job: 'Linux runtime (x86_64)',
    },
    bazelVersion: '8.8.1',
  };
  const out = capture(output).members[0];
  if (out.type !== 'file') throw new Error('fixture output must be a regular file');
  const events = [
    {
      id: { started: {} },
      started: { uuid: 'actual-invocation', buildToolVersion: '8.8.1', command: 'build' },
    },
    { id: { workspace: {} }, workspaceInfo: { localExecRoot: executionRoot } },
    {
      id: { configuration: { id: 'c'.repeat(64) } },
      configuration: { mnemonic: 'k8-opt', cpu: 'k8' },
    },
    {
      id: { namedSet: { id: 'nested' } },
      namedSetOfFiles: {
        files: [
          {
            pathPrefix: ['bazel-out', 'k8-opt', 'bin'],
            name: 'package/native.tgz',
            digest: out.sha256,
            length: String(out.size),
          },
        ],
      },
    },
    { id: { namedSet: { id: 'default' } }, namedSetOfFiles: { fileSets: [{ id: 'nested' }] } },
    {
      id: { targetCompleted: { label: '//package:ship', configuration: { id: 'c'.repeat(64) } } },
      completed: {
        success: true,
        outputGroup: [{ name: 'default', fileSets: [{ id: 'default' }] }],
      },
    },
    {
      id: { buildFinished: {} },
      finished: { overallSuccess: true, exitCode: { name: 'SUCCESS' } },
    },
    {
      id: { buildMetadata: {} },
      buildMetadata: { metadata: nativeBuildMetadata(expected.source, expected.github) },
    },
    { id: { buildMetrics: {} }, lastMessage: true, buildMetrics: {} },
  ];
  const evidence: NativeBuildEvidence = {
    schema: 'oliphaunt-native-build-evidence-v1',
    source: expected.source,
    github: expected.github,
    cohorts: [
      {
        executionRoot,
        rootConfigurations: [{ label: '//package:ship', configuration: 'c'.repeat(64) }],
        roots: [
          {
            label: '//package:ship',
            package: {
              product: 'fixture-native',
              version: '1.0.0',
              ecosystem: 'github',
              name: 'native.tgz',
              configuration: 'linux-x64-gnu',
              role: 'github-release-asset',
              outputs: [{ path: output, owner: '//package:archive' }],
            },
          },
        ],
        aquery,
        buildEvents: events,
        inputs: [source, tool, generated].map(capture),
        outputs: [capture(output)],
      },
    ],
  };
  return {
    evidence,
    expected,
    executionRoot,
    output,
    generated,
    source,
    tool,
    capture,
    cleanup: () => rmSync(executionRoot, { recursive: true, force: true }),
  };
}

test('successful cache-backed target binds configured output bytes and all current input contents', () => {
  const f = fixture();
  try {
    const result = validateNativeBuildEvidence(f.evidence, f.expected);
    expect(result.scope).toBe('construction');
    expect(result.releaseDecision).toBe('unverified');
    expect(result.testQualification).toBe('unverified');
    expect(result.github.runId).toBe(456);
    expect(result.cohorts[0].roots[0].configuration).toBe('c'.repeat(64));
    expect(result.cohorts[0].roots[0].package.configuration).toBe('linux-x64-gnu');
    expect(result.cohorts[0].inputContentsDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.unverified).toContain(
      'authenticated producing workflow, attempt, job and immutable artifact',
    );
    // No execution log exists or is needed: successful Bazel cache reuse is valid.
    expect(Object.hasOwn(result, 'executionLog')).toBe(false);
  } finally {
    f.cleanup();
  }
});

test('loaded-source facts bind each shipping root and remain optional for old diagnostic packets', () => {
  const f = fixture();
  try {
    const cohort = f.evidence.cohorts[0];
    expect(nativeAnalysisInputBindings(cohort)).toBeUndefined();
    cohort.analysisInputs = [f.capture(f.source)];
    cohort.rootAnalysisInputPaths = [{ label: cohort.roots[0].label, paths: [f.source] }];
    const result = validateNativeBuildEvidence(f.evidence, f.expected);
    expect(result.cohorts[0].rootAnalysisInputPaths).toEqual(cohort.rootAnalysisInputPaths);
    expect(result.cohorts[0].analysisInputsDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(result.releaseDecision).toBe('unverified');
    for (const fault of [
      'missing-capture',
      'missing-map',
      'foreign-root',
      'duplicate-root',
      'foreign-path',
      'generated',
      'empty',
      'directory',
    ]) {
      const changed = structuredClone(cohort);
      if (fault === 'missing-capture') delete changed.analysisInputs;
      if (fault === 'missing-map') delete changed.rootAnalysisInputPaths;
      if (fault === 'foreign-root') changed.rootAnalysisInputPaths![0].label = '//foreign:shipping';
      if (fault === 'duplicate-root')
        changed.rootAnalysisInputPaths!.push(changed.rootAnalysisInputPaths![0]);
      if (fault === 'foreign-path')
        changed.rootAnalysisInputPaths![0].paths = ['other/BUILD.bazel'];
      if (fault === 'generated')
        changed.rootAnalysisInputPaths![0].paths = ['bazel-out/k8-opt/bin/BUILD.bazel'];
      if (fault === 'empty') changed.rootAnalysisInputPaths![0].paths = [];
      if (fault === 'directory')
        changed.analysisInputs![0].members = [{ path: '', type: 'directory', mode: 0o755 }];
      expect(() => nativeAnalysisInputBindings(changed), fault).toThrow();
    }
  } finally {
    f.cleanup();
  }
});

test('reached seed constructor JSON binds its own captured File and same-action frozen TAR', () => {
  const f = fixture();
  try {
    const stem = 'bazel-out/k8-opt/bin/package/seed';
    const frozen = `${stem}.tar`;
    const receiptPath = `${stem}.seed-construction.json`;
    writeFileSync(path.join(f.executionRoot, frozen), 'immutable frozen PGDATA fixture');
    const pgdata = path.join(f.executionRoot, 'pgdata');
    const contract = JSON.parse(
      readFileSync(
        new URL('../../src/database-resources/contracts/contract.json', import.meta.url),
        'utf8',
      ),
    );
    for (const name of contract.pgdataDirectories)
      mkdirSync(path.join(pgdata, name), { recursive: true });
    writeFileSync(path.join(pgdata, 'PG_VERSION'), '18\n');
    const intent = captureSeedConstructionIntent(
      { family: 'native', target: 'linux-x64-gnu', profile: 'standard' },
      { command: 'fixture-initdb' },
      { constructor: path.join(f.executionRoot, f.source) },
    );
    writeSeedConstructionReceipt(
      path.join(f.executionRoot, receiptPath),
      intent,
      path.join(f.executionRoot, frozen),
      pgdata,
    );
    const rows = [
      {
        path: receiptPath,
        contents: readFileSync(path.join(f.executionRoot, receiptPath), 'utf8'),
      },
    ];
    const inputs = [f.capture(receiptPath), f.capture(frozen)];
    const action = { mnemonic: 'PostgresClusterSeed', outputs: [frozen, receiptPath] };
    expect(validateNativeSeedConstructions(rows, inputs, [JSON.stringify(action)])).toEqual(rows);
    for (const failure of [
      'missing',
      'duplicate',
      'contents',
      'frozen',
      'action',
      'family',
      'split-output',
    ] as const) {
      const current = structuredClone(rows);
      const files = structuredClone(inputs);
      const producer = structuredClone(action);
      if (failure === 'missing') current.length = 0;
      else if (failure === 'duplicate') current.push(current[0]);
      else if (failure === 'contents') current[0].contents += ' ';
      else if (failure === 'frozen') files[1].members[0].sha256 = 'f'.repeat(64);
      else if (failure === 'action') producer.mnemonic = 'FileWrite';
      else if (failure === 'family') producer.mnemonic = 'WasixClusterSeed';
      else producer.outputs = [receiptPath];
      expect(() =>
        validateNativeSeedConstructions(current, files, [JSON.stringify(producer)]),
      ).toThrow();
    }
  } finally {
    f.cleanup();
  }
});

function requiredTestEvents() {
  const identity = { label: '//package:consumer_test', configuration: { id: 'c'.repeat(64) } };
  return [
    { id: { targetCompleted: identity }, completed: { success: true } },
    {
      id: { testResult: { ...identity, run: 1, shard: 1, attempt: 1 } },
      testResult: { status: 'PASSED', cachedLocally: true },
    },
    {
      id: { testSummary: identity },
      testSummary: { overallStatus: 'PASSED', totalRunCount: 1, totalNumCached: 1 },
    },
  ];
}

test('explicit mandatory configured tests require actual successful BEP summaries and accept cache reuse', () => {
  const f = fixture();
  try {
    const expected = {
      ...f.expected,
      requiredTests: [{ label: '@@//package:consumer_test', configuration: 'c'.repeat(64) }],
    };
    expect(() => validateNativeBuildEvidence(f.evidence, expected)).toThrow(
      /mandatory configured test/,
    );
    f.evidence.cohorts[0].buildEvents.splice(-1, 0, ...requiredTestEvents());
    const result = validateNativeBuildEvidence(f.evidence, expected);
    expect(result.testQualification).toBe('passed');
    expect(result.requiredTests).toEqual([
      {
        label: '//package:consumer_test',
        configuration: 'c'.repeat(64),
        invocationId: 'actual-invocation',
      },
    ]);
    expect(result.releaseDecision).toBe('unverified');
    expect(() =>
      validateNativeBuildEvidence(f.evidence, { ...expected, requiredTests: [] }),
    ).toThrow(/nonempty unique/);
    expect(() =>
      validateNativeBuildEvidence(f.evidence, {
        ...expected,
        requiredTests: [
          ...expected.requiredTests,
          { label: '//package:consumer_test', configuration: 'c'.repeat(64) },
        ],
      }),
    ).toThrow(/nonempty unique/);
    expect(() =>
      validateNativeBuildEvidence(f.evidence, {
        ...expected,
        requiredTests: [{ label: '//package:consumer_test', configuration: 'different' }],
      }),
    ).toThrow(/mandatory configured test/);
  } finally {
    f.cleanup();
  }
});

test('missing, failed, skipped, incomplete or ambiguous mandatory tests fail closed', () => {
  const f = fixture();
  try {
    const expected = {
      ...f.expected,
      requiredTests: [{ label: '//package:consumer_test', configuration: 'c'.repeat(64) }],
    };
    for (const change of [
      (events: any[]) => events.pop(),
      (events: any[]) => {
        events[2].testSummary.overallStatus = 'FAILED';
      },
      (events: any[]) => {
        events[2].testSummary.overallStatus = 'FLAKY';
      },
      (events: any[]) => {
        events[2].testSummary.totalRunCount = 0;
      },
      (events: any[]) => {
        events[2].testSummary.totalRunCount = 2;
      },
      (events: any[]) => {
        delete events[2].testSummary;
        events[2].aborted = { reason: 'SKIPPED' };
      },
      (events: any[]) => {
        events[0].completed.success = false;
      },
      (events: any[]) => {
        events.splice(0, 1);
      },
      (events: any[]) => {
        events.splice(1, 1);
      },
      (events: any[]) => {
        events[1].testResult.status = 'FAILED';
      },
      (events: any[]) => {
        events.push(structuredClone(events[2]));
      },
      (events: any[]) => {
        events.push(structuredClone(events[1]));
      },
      (events: any[]) => {
        events[2].id.testSummary.configuration.id = 'other';
      },
    ]) {
      const evidence = structuredClone(f.evidence);
      const events = requiredTestEvents();
      change(events);
      evidence.cohorts[0].buildEvents.splice(-1, 0, ...events);
      expect(() => validateNativeBuildEvidence(evidence, expected)).toThrow(
        /mandatory configured test|complete successful test/,
      );
    }
    const evidence = structuredClone(f.evidence);
    evidence.cohorts[0].buildEvents.splice(-1, 0, ...requiredTestEvents());
    const duplicate = structuredClone(evidence.cohorts[0]);
    (duplicate.buildEvents[0] as any).started.uuid = 'second-invocation';
    evidence.cohorts.push(duplicate);
    expect(() => validateNativeBuildEvidence(evidence, expected)).toThrow(
      /mandatory configured test.*found 2/,
    );
  } finally {
    f.cleanup();
  }
});

test('tool/generated/source content changes alter input diagnostics while identical delivered bytes stay identical', () => {
  const f = fixture();
  try {
    const before = validateNativeBuildEvidence(f.evidence, f.expected);
    for (const file of [f.source, f.tool, f.generated]) {
      writeFileSync(path.join(f.executionRoot, file), `changed ${file}`);
      f.evidence.cohorts[0].inputs = f.evidence.cohorts[0].inputs.map((row) =>
        row.path === file ? f.capture(file) : row,
      );
      const after = validateNativeBuildEvidence(f.evidence, f.expected);
      expect(after.cohorts[0].inputContentsDigest).not.toBe(before.cohorts[0].inputContentsDigest);
      expect(after.cohorts[0].roots[0].outputs).toEqual(before.cohorts[0].roots[0].outputs);
      expect(after.releaseDecision).toBe('unverified');
    }
  } finally {
    f.cleanup();
  }
});

test('declaration fingerprints ignore input-set factoring while raw graph evidence and real edge changes remain bound', () => {
  const f = fixture();
  try {
    const before = validateNativeBuildEvidence(f.evidence, f.expected).cohorts[0];
    const graph = f.evidence.cohorts[0].aquery as any;
    graph.depSetOfFiles[1] = { id: 2, transitiveDepSetIds: [1, 3] };
    graph.depSetOfFiles.push({ id: 3, directArtifactIds: [3, 2] });
    const factored = validateNativeBuildEvidence(f.evidence, f.expected).cohorts[0];
    expect(factored.actionDefinitionsDigest).toBe(before.actionDefinitionsDigest);
    expect(factored.inputContentsDigest).toBe(before.inputContentsDigest);
    expect(factored.aqueryDigest).not.toBe(before.aqueryDigest);
    graph.depSetOfFiles[0].directArtifactIds = [2];
    graph.depSetOfFiles[2].directArtifactIds = [3, 1];
    const swapped = validateNativeBuildEvidence(f.evidence, f.expected).cohorts[0];
    expect(swapped.inputContentsDigest).toBe(before.inputContentsDigest);
    expect(swapped.actionDefinitionsDigest).not.toBe(before.actionDefinitionsDigest);
    graph.actions[1].arguments.push('--changed-command');
    const command = validateNativeBuildEvidence(f.evidence, f.expected).cohorts[0];
    expect(command.actionDefinitionsDigest).not.toBe(swapped.actionDefinitionsDigest);
  } finally {
    f.cleanup();
  }
});

test('input capture requires generated content, exact closure membership and safe file trees', () => {
  const f = fixture();
  try {
    for (const change of [
      (value: NativeBuildEvidence) => {
        value.cohorts[0].inputs.pop();
      },
      (value: NativeBuildEvidence) => {
        value.cohorts[0].inputs.push({
          path: 'unconsumed.txt',
          members: value.cohorts[0].inputs[0].members,
        });
      },
      (value: NativeBuildEvidence) => {
        value.cohorts[0].inputs[0].members[0].path = '../escape';
      },
      (value: NativeBuildEvidence) => {
        (value.cohorts[0].inputs[0].members[0] as any).sha256 = 'not a hash';
      },
      (value: NativeBuildEvidence) => {
        value.cohorts[0].inputs.push(value.cohorts[0].inputs[0]);
      },
    ]) {
      const changed = structuredClone(f.evidence);
      change(changed);
      expect(() => validateNativeBuildEvidence(changed, f.expected)).toThrow();
    }
    const tree = structuredClone(f.evidence);
    tree.cohorts[0].inputs[0].members = [
      { path: '', type: 'directory', mode: 0o755 },
      { path: 'module.mts', type: 'file', mode: 0o644, size: 3, sha256: 'd'.repeat(64) },
    ];
    expect(() => validateNativeBuildEvidence(tree, f.expected)).not.toThrow();
    tree.cohorts[0].inputs[0].members[1].path = 'missing/module.mts';
    expect(() => validateNativeBuildEvidence(tree, f.expected)).toThrow(/directory parent/);
  } finally {
    f.cleanup();
  }
});

test('failed, skipped, missing, incomplete and ambiguous configurations cannot bind an output', () => {
  const f = fixture();
  try {
    for (const change of [
      (events: any[]) => {
        events[6].finished.exitCode = { name: 'BUILD_FAILURE', code: 1 };
      },
      (events: any[]) => {
        events[5].completed.success = false;
      },
      (events: any[]) => {
        delete events[5].completed;
        events[5].aborted = { reason: 'SKIPPED' };
      },
      (events: any[]) => {
        events.splice(5, 1);
      },
      (events: any[]) => {
        events[5].completed.outputGroup[0].incomplete = true;
      },
      (events: any[]) => {
        events[4].namedSetOfFiles.fileSets = [{ id: 'missing' }];
      },
      (events: any[]) => {
        events[4].namedSetOfFiles.fileSets = [{ id: 'default' }];
      },
      (events: any[]) => {
        events.pop();
      },
      (events: any[]) => {
        events[5].id.targetCompleted.configuration.id = 'e'.repeat(64);
      },
      (events: any[]) => {
        const another = structuredClone(events[5]);
        another.id.targetCompleted.configuration.id = 'e'.repeat(64);
        events.splice(6, 0, another);
      },
    ]) {
      const changed = structuredClone(f.evidence);
      change(changed.cohorts[0].buildEvents);
      expect(() => validateNativeBuildEvidence(changed, f.expected)).toThrow();
    }
    const mixed = structuredClone(f.evidence);
    const other: any = structuredClone(mixed.cohorts[0].buildEvents[5]);
    other.id.targetCompleted.configuration.id = 'e'.repeat(64);
    other.completed.success = false;
    mixed.cohorts[0].buildEvents.splice(6, 0, other);
    expect(() => validateNativeBuildEvidence(mixed, f.expected)).not.toThrow();
  } finally {
    f.cleanup();
  }
});

test('source, producing run/attempt/job, execroot and digest substitutions fail closed', () => {
  const f = fixture();
  try {
    for (const change of [
      (value: NativeBuildEvidence) => {
        value.source.commit = 'f'.repeat(40);
      },
      (value: NativeBuildEvidence) => {
        value.source.tree = 'f'.repeat(40);
      },
      (value: NativeBuildEvidence) => {
        value.github.runId = 123;
      },
      (value: NativeBuildEvidence) => {
        value.github.runAttempt = 3;
      },
      (value: NativeBuildEvidence) => {
        value.github.job = 'Qualified';
      },
      (value: NativeBuildEvidence) => {
        value.github.workflow = 'CI';
      },
      (value: NativeBuildEvidence) => {
        value.cohorts[0].executionRoot = '/tmp/another-execroot';
      },
      (value: NativeBuildEvidence) => {
        (value.cohorts[0].buildEvents[3] as any).namedSetOfFiles.files[0].digest = 'f'.repeat(64);
      },
      (value: NativeBuildEvidence) => {
        (value.cohorts[0].buildEvents[3] as any).namedSetOfFiles.files[0].length = '999';
      },
      (value: NativeBuildEvidence) => {
        (value.cohorts[0].buildEvents[0] as any).started.buildToolVersion = 'other';
      },
      (value: NativeBuildEvidence) => {
        (value.github as any).authenticated = true;
      },
      (value: NativeBuildEvidence) => {
        (value.cohorts[0].buildEvents[7] as any).buildMetadata.metadata.oliphaunt_run_id = '123';
      },
      (value: NativeBuildEvidence) => {
        (value.cohorts[0].buildEvents[7] as any).buildMetadata.metadata.oliphaunt_source_commit =
          'f'.repeat(40);
      },
    ]) {
      const changed = structuredClone(f.evidence);
      change(changed);
      expect(() => validateNativeBuildEvidence(changed, f.expected)).toThrow();
    }
  } finally {
    f.cleanup();
  }
});

test('multiple successful cohorts retain their actual distinct configuration and foreign execroot', () => {
  const f = fixture();
  try {
    const another = structuredClone(f.evidence.cohorts[0]);
    another.executionRoot = 'C:/bazel/execroot/_main';
    (another.buildEvents[0] as any).started.uuid = 'windows-invocation';
    (another.buildEvents[1] as any).workspaceInfo.localExecRoot = another.executionRoot;
    (another.buildEvents[2] as any).id.configuration.id = 'e'.repeat(64);
    (another.buildEvents[2] as any).configuration = {
      mnemonic: 'x64_windows-opt',
      cpu: 'x64_windows',
    };
    (another.buildEvents[5] as any).id.targetCompleted.configuration.id = 'e'.repeat(64);
    (another.aquery as any).configuration[0].checksum = 'e'.repeat(64);
    another.rootConfigurations[0].configuration = 'e'.repeat(64);
    another.roots[0].package.configuration = 'windows-x64';
    f.evidence.cohorts.push(another);
    const result = validateNativeBuildEvidence(f.evidence, f.expected);
    expect(result.cohorts.map((cohort) => cohort.roots[0].configuration)).toEqual([
      'c'.repeat(64),
      'e'.repeat(64),
    ]);
    expect(result.cohorts[1].roots[0].configurationDetails.cpu).toBe('x64_windows');
  } finally {
    f.cleanup();
  }
});

test('BEP configuration identifiers are opaque and unrelated null/source configurations remain valid', () => {
  const f = fixture();
  try {
    f.evidence.cohorts[0].buildEvents.splice(3, 0, {
      id: { configuration: { id: 'none' } },
      configuration: {},
    });
    expect(() => validateNativeBuildEvidence(f.evidence, f.expected)).not.toThrow();
    (f.evidence.cohorts[0].buildEvents[2] as any).id.configuration.id =
      'opaque-build-configuration';
    (f.evidence.cohorts[0].buildEvents[6] as any).id.targetCompleted.configuration.id =
      'opaque-build-configuration';
    (f.evidence.cohorts[0].aquery as any).configuration[0].checksum = 'opaque-build-configuration';
    f.evidence.cohorts[0].rootConfigurations[0].configuration = 'opaque-build-configuration';
    expect(
      validateNativeBuildEvidence(f.evidence, f.expected).cohorts[0].roots[0].configuration,
    ).toBe('opaque-build-configuration');
  } finally {
    f.cleanup();
  }
});

test('cquery roots and successful BEP must match while actual producer transitions remain valid', () => {
  const f = fixture();
  try {
    const mismatched = structuredClone(f.evidence);
    mismatched.cohorts[0].rootConfigurations[0].configuration = 'd'.repeat(64);
    expect(() => validateNativeBuildEvidence(mismatched, f.expected)).toThrow(
      /shipping configuration mismatch/,
    );
    const missingRoot = structuredClone(f.evidence);
    missingRoot.cohorts[0].rootConfigurations = [];
    expect(() => validateNativeBuildEvidence(missingRoot, f.expected)).toThrow(/root coverage/);
    const duplicateRoot = structuredClone(f.evidence);
    duplicateRoot.cohorts[0].rootConfigurations.push(
      duplicateRoot.cohorts[0].rootConfigurations[0],
    );
    expect(() => validateNativeBuildEvidence(duplicateRoot, f.expected)).toThrow(/duplicate.*root/);
    const missing = structuredClone(f.evidence);
    (missing.cohorts[0].aquery as any).configuration = [];
    (missing.cohorts[0].aquery as any).actions[0].configurationId = 999;
    expect(() => validateNativeBuildEvidence(missing, f.expected)).toThrow(
      /configuration is missing/,
    );
    const transitioned = structuredClone(f.evidence);
    (transitioned.cohorts[0].aquery as any).configuration.push({
      id: 2,
      checksum: 'e'.repeat(64),
      isTool: true,
    });
    (transitioned.cohorts[0].aquery as any).actions[0].configurationId = 2;
    expect(() => validateNativeBuildEvidence(transitioned, f.expected)).not.toThrow();
    // A ShippingInfo wrapper need not own actions; its configured producers may transition.
    (transitioned.cohorts[0].aquery as any).actions[1].configurationId = 2;
    (transitioned.cohorts[0].aquery as any).configuration.shift();
    expect(() => validateNativeBuildEvidence(transitioned, f.expected)).not.toThrow();
  } finally {
    f.cleanup();
  }
});

test('canonical main-repository roots bind BEP labels while external repositories remain distinct', () => {
  const f = fixture();
  try {
    const cohort = f.evidence.cohorts[0];
    cohort.roots[0].label = '@@//package:ship';
    cohort.rootConfigurations[0].label = '@@//package:ship';
    cohort.roots[0].package.outputs[0].owner = '@@//package:archive';
    expect(validateNativeBuildEvidence(f.evidence, f.expected).cohorts[0].roots[0].label).toBe(
      '@@//package:ship',
    );
    cohort.roots[0].label = '@@foreign//package:ship';
    cohort.rootConfigurations[0].label = '@@foreign//package:ship';
    expect(() => validateNativeBuildEvidence(f.evidence, f.expected)).toThrow(
      /one successful configured shipping root/,
    );
  } finally {
    f.cleanup();
  }
});

test('candidate exporter/verifier authenticate transport, require tests and bind the same buffer without granting admission', () => {
  const f = fixture();
  try {
    const runGit = (...args: string[]) =>
      execFileSync('git', args, { cwd: f.executionRoot, encoding: 'utf8' }).trim();
    runGit('init', '--quiet');
    runGit(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '--quiet',
      '--allow-empty',
      '-m',
      'fixture',
    );
    const commit = runGit('rev-parse', 'HEAD');
    const tree = runGit('rev-parse', 'HEAD^{tree}');
    f.evidence.source = { commit, tree };
    f.evidence.github = { ...f.evidence.github, runId: 77, runAttempt: 1 };
    (f.evidence.cohorts[0].buildEvents[7] as any).buildMetadata.metadata = nativeBuildMetadata(
      f.evidence.source,
      f.evidence.github,
    );
    f.evidence.cohorts[0].buildEvents.splice(-1, 0, ...requiredTestEvents());
    const evidenceRoot = path.join(f.executionRoot, 'evidence');
    mkdirSync(evidenceRoot);
    const packet = path.join(evidenceRoot, 'native-build-evidence.json');
    writeFileSync(packet, `${JSON.stringify(f.evidence)}\n`);
    const packetBytes = readFileSync(packet);
    const archive = path.join(f.executionRoot, 'artifact.zip');
    execFileSync('zip', ['-q', archive, 'native-build-evidence.json'], { cwd: evidenceRoot });
    const plan = path.join(f.executionRoot, 'plan.json');
    const candidate = path.join(f.executionRoot, 'candidate.json');
    writeFileSync(
      plan,
      JSON.stringify({ projects: [], jobs: ['affected'], extension_package_products: [] }),
    );
    // Controller expectations are constraints. Synthetic HTTP responses below
    // exercise the real transport; this fixture is not live GitHub evidence.
    const context = {
      github: f.evidence.github,
      event: 'workflow_dispatch',
      ref: 'refs/heads/main',
      artifactName: 'native-build-evidence-x86_64',
      requiredTests: [{ label: '//package:consumer_test', configuration: 'c'.repeat(64) }],
    };
    const script = path.resolve(import.meta.dir, '../../.github/scripts/release-candidate.sh');
    const environment = {
      ...process.env,
      PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}`,
      CI_HEAD_SHA: commit,
      RELEASE_HEAD_SHA: commit,
      CI_PLAN_PATH: plan,
      CI_QUALIFICATION_MODE: 'full-payload',
      WASIX_RELEASE_REGRESSION_REQUIRED: 'false',
      GITHUB_REPOSITORY: 'f0rr0/oliphaunt',
      GITHUB_WORKFLOW: 'CI',
      GITHUB_WORKFLOW_REF: 'f0rr0/oliphaunt/.github/workflows/ci.yml@refs/heads/main',
      GITHUB_RUN_ID: '123',
      CI_RUN_ID: '123',
      GITHUB_RUN_ATTEMPT: '1',
      GITHUB_EVENT_NAME: 'push',
      GITHUB_REF: 'refs/heads/main',
      NATIVE_BUILD_EVIDENCE_ROOT: evidenceRoot,
      NATIVE_BUILD_CONTEXT_JSON: JSON.stringify(context),
      BUN_OPTIONS: `--preload=${path.resolve(import.meta.dir, 'testdata/download-build-artifacts-github.mts')}`,
      GH_TOKEN: 'test-token',
      FAKE_NATIVE_ORIGIN: 'true',
      FAKE_NATIVE_CASE: '',
      FAKE_NATIVE_SOURCE_COMMIT: commit,
      FAKE_NATIVE_SOURCE_TREE: tree,
      FAKE_ARTIFACT_ARCHIVE: archive,
      FAKE_GH_LOG: path.join(f.executionRoot, 'api.log'),
      FAKE_GH_STATE: path.join(f.executionRoot, 'download-count'),
      FAKE_MODE: 'success',
      FAKE_RUN_CONCLUSION: 'failure',
    };
    const run = (args: string[], env = environment) =>
      execFileSync('bash', [script, ...args], {
        cwd: f.executionRoot,
        env,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    run(['write', candidate], { ...environment, FAKE_NATIVE_MUTATE_LOCAL_PACKET: packet });
    const record = JSON.parse(readFileSync(candidate, 'utf8'));
    expect(JSON.parse(readFileSync(packet, 'utf8'))).toEqual({
      changedAfterAuthenticatedRead: true,
    });
    expect(record.evidence.nativeBuild.digest).toBe(
      `sha256:${createHash('sha256').update(packetBytes).digest('hex')}`,
    );
    writeFileSync(packet, packetBytes);
    expect(record.runId).toBe('123');
    expect(record.evidence.nativeBuild.github.runId).toBe(77);
    expect(record.evidence.nativeBuild.github.runAttempt).toBe(1);
    expect(record.evidence.nativeBuild.artifact.id).toBe(101);
    expect(record.evidence.nativeBuild.scope).toBe('construction');
    expect(record.evidence.nativeBuild.releaseDecision).toBe('unverified');
    expect(record.evidence.nativeBuild.testQualification).toBe('passed');
    expect(record.evidence.nativeBuild.requiredTests).toEqual([
      { ...context.requiredTests[0], invocationId: 'actual-invocation' },
    ]);
    expect(record.evidence.nativeBuild.unverified).not.toContain(
      'authenticated producing workflow, attempt, job and immutable artifact',
    );
    const verify = ['verify', candidate, '--plan', plan, '--wasix-evidence-required', 'false'];
    const native = [
      '--native-build-evidence-root',
      evidenceRoot,
      '--native-build-context-json',
      JSON.stringify(context),
    ];
    expect(() => run([...verify, ...native])).not.toThrow();
    expect(() => run(verify)).toThrow();
    expect(() => run([...verify, '--native-build-evidence-root', evidenceRoot])).toThrow();
    expect(() =>
      run([
        ...verify,
        ...native.slice(0, 3),
        JSON.stringify({ ...context, github: { ...context.github, runAttempt: 2 } }),
      ]),
    ).toThrow();
    expect(() =>
      run(['write', candidate], { ...environment, NATIVE_BUILD_EVIDENCE_ROOT: '' }),
    ).toThrow();
    for (const requiredTests of [
      undefined,
      [],
      [{ ...context.requiredTests[0], configuration: 'd'.repeat(64) }],
    ]) {
      expect(() =>
        run(['write', candidate], {
          ...environment,
          NATIVE_BUILD_CONTEXT_JSON: JSON.stringify({ ...context, requiredTests }),
        }),
      ).toThrow();
    }
    expect(() =>
      run(['write', candidate], {
        ...environment,
        NATIVE_BUILD_ORIGIN_JSON: JSON.stringify({ github: context.github, artifact: {} }),
      }),
    ).toThrow();
    expect(() =>
      run([
        ...verify,
        '--native-build-evidence-root',
        evidenceRoot,
        '--native-build-origin-json',
        JSON.stringify({ github: context.github, artifact: {} }),
      ]),
    ).toThrow();
    for (const kind of ['job-failure', 'stale-artifact', 'digest'])
      expect(() =>
        run([...verify, ...native], { ...environment, FAKE_NATIVE_CASE: kind }),
      ).toThrow();
    writeFileSync(packet, '{"tampered":true}');
    expect(() => run([...verify, ...native])).toThrow();
  } finally {
    f.cleanup();
  }
});
