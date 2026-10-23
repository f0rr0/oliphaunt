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
  assertAuthenticatedNativeBuildOrigin,
  authenticateNativeBuildEvidence,
} from './authenticate-native-build-evidence.mts';
import {
  buildShippingInputView,
  configuredAqueryTargetInputs,
  createConfiguredAqueryTargetInputResolver,
} from './bazel-shipping-inputs.mts';
import {
  assertNativeFinalShippingPhase,
  type NativeBuildEvidence,
  nativeAnalysisInputBindings,
  nativeBuildMetadata,
  nativeQualificationInputBindings,
  nativeRequiredCaptureInputs,
  validateNativeBuildEvidence,
  validateNativeSeedConstructions,
} from './native-build-qualification.mts';
import { captureNativeOutputMembers } from './native-publication-staging.mts';

test('source WASIX host probes cannot replace prepared exact-host final qualification', () => {
  const product = 'oliphaunt-extension-pg-textsearch';
  const pkg = {
    product,
    name: 'pg_textsearch-wasix-pre-version-link',
    ecosystem: 'internal',
    role: 'extension-release-link-input',
  };
  const qualification = { cohorts: [{ roots: [{ package: pkg }] }] } as any;
  expect(() => assertNativeFinalShippingPhase(qualification, [])).not.toThrow();
  expect(() => assertNativeFinalShippingPhase(qualification, [product])).toThrow(
    'prepared exact-host',
  );
  pkg.name = 'pg_textsearch-wasix-final-link';
  expect(() => assertNativeFinalShippingPhase(qualification, [product])).not.toThrow();
  pkg.ecosystem = 'npm';
  expect(() => assertNativeFinalShippingPhase(qualification, [product])).toThrow(
    'prepared exact-host',
  );
});

test('selected SDK and Broker final sources require minimum proof, without a helper-only or held trigger', () => {
  const common = '//build_defs/languages/installed:consumer_test';
  const minimum = '//build_defs/languages/installed:consumer_minimum_test';
  const descriptors = [
    ['//src/native/sdks/rust:shipping_package', 'oliphaunt-rust', 'oliphaunt'],
    [
      '//src/native/sdks/rust/crates/oliphaunt-build:shipping_package',
      'oliphaunt-rust',
      'oliphaunt-build',
    ],
    ['//src/native/broker:shipping_package', 'oliphaunt-broker', 'oliphaunt-broker'],
  ];
  const qualification = {
    cohorts: [
      {
        roots: descriptors.map(([label, product, name]) => ({
          label,
          package: { product, name, ecosystem: 'cargo' },
        })),
        qualificationPolicy: {
          policies: descriptors.map(([label]) => ({
            roots: [label],
            requiredTests: [{ label: common }],
          })),
        },
      },
    ],
  } as any;
  expect(() =>
    assertNativeFinalShippingPhase(qualification, ['liboliphaunt-native-bindings']),
  ).not.toThrow();
  expect(() => assertNativeFinalShippingPhase(qualification, ['oliphaunt-rust'])).toThrow(
    'declared-minimum',
  );
  expect(() => assertNativeFinalShippingPhase(qualification, ['oliphaunt-broker'])).toThrow(
    'declared-minimum',
  );
  qualification.cohorts[0].qualificationPolicy.policies[0].requiredTests.push({ label: minimum });
  expect(() => assertNativeFinalShippingPhase(qualification, ['oliphaunt-rust'])).not.toThrow();
  expect(() =>
    assertNativeFinalShippingPhase(qualification, ['oliphaunt-rust', 'oliphaunt-broker']),
  ).toThrow('declared-minimum');
  qualification.cohorts[0].qualificationPolicy.policies[2].requiredTests.push({ label: minimum });
  expect(() =>
    assertNativeFinalShippingPhase(qualification, ['oliphaunt-rust', 'oliphaunt-broker']),
  ).not.toThrow();
  qualification.cohorts[0].qualificationPolicy.policies[2].requiredTests[1].label = `${minimum}_fixture`;
  expect(() => assertNativeFinalShippingPhase(qualification, ['oliphaunt-broker'])).toThrow(
    'declared-minimum',
  );
});

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
        inputs: [],
        outputs: [capture(output)],
      },
    ],
  };
  evidence.cohorts[0].inputs = nativeRequiredCaptureInputs(
    buildShippingInputView(
      {
        schema: 'oliphaunt-bazel-shipping-v1',
        scope: 'construction',
        packages: evidence.cohorts[0].roots.map((root) => root.package),
      },
      aquery,
    ),
  ).map(capture);
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

// Real stock Bazel 8.8.1 NAPI capture had distinct external source-root Cargo.toml
// Files with no pathPrefix in observation_inputs. ShippingInfo outputs are the
// package's DefaultInfo, so input-only observations must not collide with finals.
test('shipping default outputs remain bound with real observation source-name collisions', () => {
  const f = fixture();
  try {
    const cohort = f.evidence.cohorts[0];
    const observations = [
      {
        name: 'Cargo.toml',
        uri: 'file:///diagnostic-output/external/registry-package-0/Cargo.toml',
        digest: 'c4f4ae997dce02e055a1ce5df6f5dc289d7297702ef54e39a32d61f9d27d4fe6',
        length: '7483',
      },
      {
        name: 'Cargo.toml',
        uri: 'file:///diagnostic-output/external/registry-package-1/Cargo.toml',
        digest: 'e17cb588cdea3490bc7cde3a145426e6097075b82879e0cb9eca0e0c8b735b90',
        length: '11202',
      },
    ];
    cohort.buildEvents.splice(3, 0, {
      id: { namedSet: { id: 'observation' } },
      namedSetOfFiles: { files: observations },
    });
    const completed = (cohort.buildEvents as any[]).find((event) => event.id?.targetCompleted);
    completed.completed.outputGroup.push({
      name: 'observation_inputs',
      fileSets: [{ id: 'observation' }],
    });
    const result = validateNativeBuildEvidence(f.evidence, f.expected);
    expect(result.cohorts[0].roots[0].outputs).toEqual(cohort.outputs);
  } finally {
    f.cleanup();
  }
});

test('shipping default outputs reject conflicting repeated final identities', () => {
  const f = fixture();
  try {
    const cohort = f.evidence.cohorts[0];
    const output = (cohort.buildEvents as any[]).find(
      (event) => event.id?.namedSet?.id === 'nested',
    );
    output.namedSetOfFiles.files.push({
      ...output.namedSetOfFiles.files[0],
      digest: 'f'.repeat(64),
    });
    expect(() => validateNativeBuildEvidence(f.evidence, f.expected)).toThrow(
      'native BEP duplicate file mismatch',
    );
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

test('source and tool content changes alter input diagnostics while identical delivered bytes stay identical', () => {
  const f = fixture();
  try {
    const before = validateNativeBuildEvidence(f.evidence, f.expected);
    for (const file of [f.source, f.tool]) {
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

test('input capture requires exact frontier membership and safe file trees', () => {
  const f = fixture();
  try {
    for (const change of [
      (value: NativeBuildEvidence) => {
        value.cohorts[0].inputs.shift();
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

test('native transport authenticates the same immutable buffer and configured tests without granting publication', async () => {
  const f = fixture();
  const environment = {
    PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}`,
    BUN_OPTIONS: `--preload=${path.resolve(import.meta.dir, 'testdata/download-build-artifacts-github.mts')}`,
    GH_TOKEN: 'test-token',
    GH_REPO: 'ignored/by-adapter',
    OLIPHAUNT_GITHUB_READ_DEADLINE_MS: '1000',
    OLIPHAUNT_GITHUB_READ_MAX_ATTEMPTS: '1',
    OLIPHAUNT_GITHUB_READ_BASE_DELAY_MS: '0',
    OLIPHAUNT_GITHUB_READ_MAX_DELAY_MS: '0',
    FAKE_NATIVE_ORIGIN: 'true',
    FAKE_NATIVE_CASE: '',
    FAKE_NATIVE_SOURCE_COMMIT: '',
    FAKE_NATIVE_SOURCE_TREE: '',
    FAKE_NATIVE_MUTATE_LOCAL_PACKET: '',
    FAKE_ARTIFACT_ARCHIVE: path.join(f.executionRoot, 'artifact.zip'),
    FAKE_GH_LOG: path.join(f.executionRoot, 'api.log'),
    FAKE_GH_STATE: path.join(f.executionRoot, 'download-count'),
    FAKE_MODE: 'success',
    FAKE_RUN_CONCLUSION: 'failure',
  };
  const before = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
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
    execFileSync('zip', ['-q', environment.FAKE_ARTIFACT_ARCHIVE, 'native-build-evidence.json'], {
      cwd: evidenceRoot,
    });
    // Expectations constrain the real HTTP/ZIP acquisition. Synthetic transport
    // exercises the boundary; it is not a live authenticated builder result.
    const context = {
      source: f.evidence.source,
      github: f.evidence.github,
      event: 'workflow_dispatch' as const,
      ref: 'refs/heads/main',
      artifactName: 'native-build-evidence-x86_64',
    };
    const requiredTests = [{ label: '//package:consumer_test', configuration: 'c'.repeat(64) }];
    Object.assign(process.env, environment, {
      FAKE_NATIVE_SOURCE_COMMIT: commit,
      FAKE_NATIVE_SOURCE_TREE: tree,
      FAKE_NATIVE_MUTATE_LOCAL_PACKET: packet,
    });
    const origin = await authenticateNativeBuildEvidence(evidenceRoot, context);
    expect(JSON.parse(readFileSync(packet, 'utf8'))).toEqual({
      changedAfterAuthenticatedRead: true,
    });
    expect(origin.evidenceDigest).toBe(
      `sha256:${createHash('sha256').update(packetBytes).digest('hex')}`,
    );
    expect(origin.evidence).toEqual(JSON.parse(packetBytes.toString('utf8')));
    expect(origin.github).toEqual(context.github);
    expect(origin.artifact.id).toBe(101);
    expect(origin.artifact.name).toBe(context.artifactName);
    expect(assertAuthenticatedNativeBuildOrigin(origin)).toBe(origin);
    expect(Object.isFrozen(origin)).toBe(true);
    expect(Object.isFrozen(origin.evidence)).toBe(true);
    expect(Object.isFrozen((origin.evidence as NativeBuildEvidence).cohorts[0].buildEvents)).toBe(
      true,
    );
    expect(() => {
      (origin.evidence as NativeBuildEvidence).source.commit = 'f'.repeat(40);
    }).toThrow();
    for (const detached of [
      structuredClone(origin),
      JSON.parse(JSON.stringify(origin)),
      { github: context.github, artifact: origin.artifact },
    ])
      expect(() => assertAuthenticatedNativeBuildOrigin(detached)).toThrow(
        /authenticated producer transport/,
      );

    const expected = {
      source: context.source,
      github: context.github,
      bazelVersion: f.expected.bazelVersion,
      requiredTests,
    };
    const qualified = validateNativeBuildEvidence(origin.evidence, expected);
    expect(qualified.scope).toBe('construction');
    expect(qualified.releaseDecision).toBe('unverified');
    expect(qualified.testQualification).toBe('passed');
    expect(qualified.requiredTests).toEqual([
      { ...requiredTests[0], invocationId: 'actual-invocation' },
    ]);
    // Content validation stays diagnostic without declared tests, even when its
    // immutable bytes came from an authenticated artifact. It grants no release.
    const diagnostic = validateNativeBuildEvidence(origin.evidence, {
      ...expected,
      requiredTests: undefined,
    });
    expect(diagnostic.testQualification).toBe('unverified');
    expect(diagnostic.releaseDecision).toBe('unverified');
    expect(diagnostic.unverified).toContain(
      'declared mandatory test roots and successful BEP results',
    );
    for (const tests of [[], [{ ...requiredTests[0], configuration: 'd'.repeat(64) }]])
      expect(() =>
        validateNativeBuildEvidence(origin.evidence, { ...expected, requiredTests: tests }),
      ).toThrow();
    expect(qualified.unverified).toContain(
      'complete canonical product qualification and completed-baseline admission',
    );
    expect(Object.hasOwn(origin, 'releaseDecision')).toBe(false);
    expect(Object.hasOwn(origin, 'baselineAdmission')).toBe(false);
    writeFileSync(packet, packetBytes);
    delete process.env.FAKE_NATIVE_MUTATE_LOCAL_PACKET;

    const again = await authenticateNativeBuildEvidence(evidenceRoot, context);
    expect(again.evidenceDigest).toBe(origin.evidenceDigest);
    expect(validateNativeBuildEvidence(again.evidence, expected)).toEqual(qualified);
    for (const changed of [
      { ...context, source: { ...context.source, commit: 'f'.repeat(40) } },
      { ...context, source: { ...context.source, tree: 'f'.repeat(40) } },
      { ...context, github: { ...context.github, runId: 78 } },
      { ...context, github: { ...context.github, runAttempt: 2 } },
      { ...context, github: { ...context.github, job: 'Other producer' } },
      { ...context, artifactName: 'other-artifact' },
    ])
      await expect(authenticateNativeBuildEvidence(evidenceRoot, changed)).rejects.toThrow();
    for (const kind of ['job-failure', 'stale-artifact', 'digest']) {
      process.env.FAKE_NATIVE_CASE = kind;
      await expect(authenticateNativeBuildEvidence(evidenceRoot, context)).rejects.toThrow();
    }
    process.env.FAKE_NATIVE_CASE = '';
    writeFileSync(packet, '{"tampered":true}');
    await expect(authenticateNativeBuildEvidence(evidenceRoot, context)).rejects.toThrow(
      /bytes differ/,
    );
    // An already acquired buffer is immutable and independent of later path mutation.
    expect(assertAuthenticatedNativeBuildOrigin(origin)).toBe(origin);
    expect(validateNativeBuildEvidence(origin.evidence, expected)).toEqual(qualified);
  } finally {
    for (const key of Object.keys(environment)) {
      if (before[key] === undefined) delete process.env[key];
      else process.env[key] = before[key];
    }
    f.cleanup();
  }
});

test('exact frontier rejects extra intermediate captures and requires every leaf and consumed supplier', () => {
  const f = fixture();
  try {
    const before = validateNativeBuildEvidence(f.evidence, f.expected);
    const extra = structuredClone(f.evidence);
    extra.cohorts[0].inputs.push(f.capture(f.generated));
    expect(() => validateNativeBuildEvidence(extra, f.expected)).toThrow(
      'native input content coverage',
    );
    rmSync(path.join(f.executionRoot, f.generated));
    const current = validateNativeBuildEvidence(f.evidence, f.expected);
    expect(current.cohorts[0].actionDefinitionsDigest).toBe(
      before.cohorts[0].actionDefinitionsDigest,
    );
    expect(current.cohorts[0].inputContentsDigest).toBe(before.cohorts[0].inputContentsDigest);
    for (const file of [f.source, f.tool]) {
      const missing = structuredClone(f.evidence);
      missing.cohorts[0].inputs = missing.cohorts[0].inputs.filter((input) => input.path !== file);
      expect(() => validateNativeBuildEvidence(missing, f.expected)).toThrow(
        'native input content coverage',
      );
    }
    const supplied = structuredClone(f.evidence);
    (supplied.cohorts[0].roots[0].package as any).supplierInputs = [
      {
        product: 'supplier',
        version: '1.0.0',
        configuration: 'linux-x64',
        binding: 'abi-contract',
        origin: { kind: 'current-source' },
        files: [{ path: f.generated }],
      },
    ];
    expect(() => validateNativeBuildEvidence(supplied, f.expected)).toThrow(
      'native input content coverage',
    );
    writeFileSync(path.join(f.executionRoot, f.generated), 'actual declared supplier File');
    supplied.cohorts[0].inputs.push(f.capture(f.generated));
    expect(validateNativeBuildEvidence(supplied, f.expected).scope).toBe('construction');
    const unrelated = structuredClone(f.evidence);
    unrelated.cohorts[0].inputs.push({
      path: 'unrelated',
      members: unrelated.cohorts[0].inputs[0].members,
    });
    expect(() => validateNativeBuildEvidence(unrelated, f.expected)).toThrow(
      'native input content coverage',
    );
  } finally {
    f.cleanup();
  }
});

test('configured qualification follows TestRunner producer edges and rejects missing or cyclic closure', () => {
  const f = fixture();
  try {
    const graph = f.evidence.cohorts[0].aquery as any;
    graph.actions[1].mnemonic = 'TestRunner';
    const observed = configuredAqueryTargetInputs(graph, '//package:archive', 'c'.repeat(64));
    expect([...observed.inputs].sort()).toEqual([f.source, f.tool, f.generated].sort());
    expect(() => configuredAqueryTargetInputs(graph, '//package:archive', 'd'.repeat(64))).toThrow(
      /configured TestRunner/,
    );
    expect(() =>
      configuredAqueryTargetInputs(graph, '//package:generated', 'c'.repeat(64)),
    ).toThrow(/configured TestRunner/);
    const conflicting = structuredClone(graph);
    conflicting.actions.push({ ...conflicting.actions[0], actionKey: 'other-producer' });
    expect(() => createConfiguredAqueryTargetInputResolver(conflicting)).toThrow(
      /conflicting aquery producers/,
    );
    const missing = structuredClone(graph);
    missing.depSetOfFiles[1].directArtifactIds.push(999);
    const resolveMissing = createConfiguredAqueryTargetInputResolver(missing);
    for (let attempt = 0; attempt < 2; attempt++)
      expect(() => resolveMissing('//package:archive', 'c'.repeat(64))).toThrow(
        /incomplete aquery graph/,
      );
    graph.actions[0].mnemonic = 'Middleman';
    graph.depSetOfFiles[0].directArtifactIds.push(3);
    const resolveCyclic = createConfiguredAqueryTargetInputResolver(graph);
    for (let attempt = 0; attempt < 2; attempt++)
      expect(() => resolveCyclic('//package:archive', 'c'.repeat(64))).toThrow(/cycle/);
  } finally {
    f.cleanup();
  }
});

test('one qualification graph keeps configured test inputs and specifications independent', () => {
  const files = ['first.spec', 'second.spec', 'derived.spec', 'payload', 'runfiles'].map(
    (name) => `bazel-out/${name}`,
  );
  const graph = {
    pathFragments: [
      { id: 'root', label: 'bazel-out' },
      ...files.map((file, id) => ({ id, label: file.split('/')[1], parentId: 'root' })),
    ],
    artifacts: files.map((_, id) => ({ id, pathFragmentId: id })),
    targets: [
      { id: 1, label: '@@//package:first' },
      { id: 2, label: '//package:second' },
    ],
    configuration: [
      { id: 1, checksum: 'first' },
      { id: 2, checksum: 'second' },
    ],
    depSetOfFiles: [
      { id: 1, directArtifactIds: [0, 2, 4] },
      { id: 2, directArtifactIds: [1, 4] },
      { id: 3, directArtifactIds: [0, 4] },
      { id: 4, directArtifactIds: [3] },
    ],
    actions: [
      { targetId: 1, configurationId: 1, mnemonic: 'FileWrite', outputIds: [0] },
      { targetId: 1, configurationId: 2, mnemonic: 'FileWrite', outputIds: [1] },
      {
        targetId: 1,
        configurationId: 1,
        mnemonic: 'FileWrite',
        inputDepSetIds: [4],
        outputIds: [2],
      },
      {
        targetId: 2,
        configurationId: 1,
        mnemonic: 'Middleman',
        inputDepSetIds: [4],
        outputIds: [4],
      },
      { targetId: 1, configurationId: 1, mnemonic: 'TestRunner', inputDepSetIds: [1] },
      { targetId: 1, configurationId: 2, mnemonic: 'TestRunner', inputDepSetIds: [2] },
      { targetId: 2, configurationId: 1, mnemonic: 'TestRunner', inputDepSetIds: [3] },
    ],
  };
  const resolve = createConfiguredAqueryTargetInputResolver(graph);
  const first = resolve('//package:first', 'first');
  expect(first.inputs).toEqual(new Set([files[0], files[2], files[4], files[3]]));
  expect(first.written).toEqual(new Set([files[0]]));
  const second = resolve('@//package:first', 'second');
  expect(second.inputs).toEqual(new Set([files[1], files[4], files[3]]));
  expect(second.written).toEqual(new Set([files[1]]));
  const sibling = resolve('//package:second', 'first');
  expect(sibling.inputs).toEqual(new Set([files[0], files[4], files[3]]));
  expect(sibling.written.size).toBe(0);
  expect(() => resolve('//package:second', 'second')).toThrow(/configured TestRunner/);
  first.inputs.clear();
  first.written.clear();
  expect(resolve('//package:first', 'first')).toEqual(
    configuredAqueryTargetInputs(graph, '//package:first', 'first'),
  );

  const requiredTests = ['first', 'second'].map((configuration) => ({
    label: '//package:first',
    configuration,
  }));
  const completed = requiredTests.map((test, index) => ({
    ...test,
    value: {
      success: true,
      outputGroup: [{ name: 'observation_inputs' }],
      files: new Map([files[index], files[3], files[4]].map((file) => [file, {}])),
    },
  }));
  const bep = { completed, filesOf: (target: any) => target.files } as any;
  const policy = { requiredTests } as any;
  expect(
    nativeQualificationInputBindings(graph, bep, policy).map((row) => row.specification),
  ).toEqual(files.slice(0, 2));
  completed[1].value.files = new Map([files[0], files[3], files[4]].map((file) => [file, {}]));
  expect(() => nativeQualificationInputBindings(graph, bep, policy)).toThrow(/not consumed/);
  for (const target of completed) target.value.outputGroup = [];
  expect(nativeQualificationInputBindings(null, bep, policy)).toEqual([]);
});

test('batched graph digests preserve canonical JSON bytes across boundaries and seeded values', () => {
  const canonical = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value !== null && typeof value === 'object')
      return `{${Object.keys(value)
        .sort()
        .map(
          (key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
        )
        .join(',')}}`;
    return JSON.stringify(value);
  };
  const f = fixture();
  try {
    const graph = f.evidence.cohorts[0].aquery as Record<string, unknown>;
    const values: unknown[] = [
      {},
      [],
      null,
      true,
      false,
      0,
      -0,
      1e30,
      -1e-30,
      { '2': 'two', '10': 'ten' },
      { empty: '', escaped: 'quote" slash\\ line\n tab\t', unicode: 'é中文𝄞\ud800\udfff' },
      { z: [], a: {}, b: [null, { beta: false, alpha: true }] },
      'é中文𝄞'.repeat(16_000),
      Array.from({ length: 32_768 }, (_, i) => i),
    ];
    let state = 0x9e3779b9;
    const random = (bound: number) => {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return (state >>> 0) % bound;
    };
    const generated = (depth: number): unknown => {
      const leaves: unknown[] = [null, true, false, '', 'é\n𝄞\ud800', random(10_000) - 5000];
      if (!depth || random(3) === 0) return leaves[random(leaves.length)];
      if (random(2) === 0) return Array.from({ length: random(6) }, () => generated(depth - 1));
      return Object.fromEntries(
        Array.from({ length: random(6) }, (_, i) => [
          `key-${random(100)}-${i}`,
          generated(depth - 1),
        ]),
      );
    };
    for (let i = 0; i < 128; i++) values.push(generated(4));
    for (const value of values) {
      graph.digestFixture = value;
      const expected = `sha256:${createHash('sha256').update(canonical(graph)).digest('hex')}`;
      expect(validateNativeBuildEvidence(f.evidence, f.expected).cohorts[0].aqueryDigest).toBe(
        expected,
      );
    }
    delete graph.digestFixture;
    const expected = `sha256:${createHash('sha256').update(canonical(graph)).digest('hex')}`;
    expect(validateNativeBuildEvidence(f.evidence, f.expected).cohorts[0].aqueryDigest).toBe(
      expected,
    );
  } finally {
    f.cleanup();
  }
});
