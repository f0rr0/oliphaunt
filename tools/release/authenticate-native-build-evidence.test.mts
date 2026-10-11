import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  assureReviewedNativeBuildProducer,
  authenticateNativeBuildEvidence,
  validateReviewedNativeProducerAssurance,
} from './authenticate-native-build-evidence.mts';
import {
  type NativeBuildEvidence,
  nativeBuildMetadata,
  validateNativeBuildEvidence,
} from './native-build-qualification.mts';

const expected = {
  source: { commit: 'a'.repeat(40), tree: 'b'.repeat(40) },
  github: {
    repository: 'f0rr0/oliphaunt',
    workflow: 'Native Bazel qualification',
    workflowPath: '.github/workflows/bazel.yml',
    runId: 77,
    runAttempt: 1,
    job: 'Linux runtime (x86_64)',
  },
  event: 'workflow_dispatch' as const,
  ref: 'refs/heads/main',
  artifactName: 'native-build-evidence-x86_64',
};

/** Synthetic protocol/transport data tests assurance policy; it does not qualify a real builder. */
function syntheticReviewedProducer(
  job = expected.github.job,
  artifactName = expected.artifactName,
) {
  const request: Parameters<typeof assureReviewedNativeBuildProducer>[1] = {
    expected: structuredClone(expected),
    reviewedSource: structuredClone(expected.source),
    bazelVersion: '8.8.1',
    requiredTests: [{ label: '//fixture:installed', configuration: 'c'.repeat(64) }],
  };
  request.expected.github.job = job;
  request.expected.artifactName = artifactName;
  const configuration = request.requiredTests[0].configuration;
  const output = 'bazel-out/k8-opt/bin/fixture/native.tgz';
  const manifest = 'bazel-out/k8-opt/bin/fixture/shipping.shipping.json';
  const executionRoot = path.join(tmpdir(), 'native-assurance-synthetic-execroot');
  const aqueryFile = path.join(tmpdir(), 'native-assurance-synthetic-aquery.json');
  const root = {
    label: '//fixture:shipping',
    package: {
      product: 'fixture-native',
      version: '1.0.0',
      ecosystem: 'github',
      name: 'native.tgz',
      configuration: 'linux-x64-gnu',
      role: 'github-release-asset',
      outputs: [{ path: output, owner: '//fixture:archive' }],
    },
  };
  const contents = `${JSON.stringify(root)}\n`;
  const identity = (bytes: string) => ({
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: Buffer.byteLength(bytes),
  });
  const outputIdentity = identity('synthetic public archive');
  const named = (id: string, file: string, bytes: string) => ({
    id: { namedSet: { id } },
    namedSetOfFiles: {
      files: [{ name: file, digest: identity(bytes).sha256, length: String(identity(bytes).size) }],
    },
  });
  const evidence: NativeBuildEvidence = {
    schema: 'oliphaunt-native-build-evidence-v1',
    source: request.expected.source,
    github: request.expected.github,
    cohorts: [
      {
        executionRoot,
        roots: [root],
        rootConfigurations: [{ label: root.label, configuration }],
        aquery: {
          pathFragments: [output, manifest].flatMap((file, index) =>
            file.split('/').map((label, part) => ({
              id: `${index}-${part}`,
              label,
              ...(part ? { parentId: `${index}-${part - 1}` } : {}),
            })),
          ),
          artifacts: [output, manifest].map((file, index) => ({
            id: index + 1,
            pathFragmentId: `${index}-${file.split('/').length - 1}`,
          })),
          targets: [
            { id: 1, label: '//fixture:archive' },
            { id: 2, label: root.label },
          ],
          configuration: [{ id: 1, checksum: configuration }],
          actions: [1, 2].map((id) => ({
            targetId: id,
            configurationId: 1,
            mnemonic: 'FileWrite',
            actionKey: `synthetic-file-${id}`,
            outputIds: [id],
            primaryOutputId: id,
          })),
        },
        buildEvents: [
          {
            id: { started: {} },
            started: { uuid: 'synthetic-invocation', buildToolVersion: '8.8.1' },
          },
          { id: { workspace: {} }, workspaceInfo: { localExecRoot: executionRoot } },
          { id: { configuration: { id: configuration } }, configuration: { mnemonic: 'k8-opt' } },
          named('outputs', output, 'synthetic public archive'),
          named('manifest', manifest, contents),
          {
            id: { targetCompleted: { label: root.label, configuration: { id: configuration } } },
            completed: {
              success: true,
              outputGroup: [
                { name: 'default', fileSets: [{ id: 'outputs' }] },
                { name: 'shipping_manifest', fileSets: [{ id: 'manifest' }] },
              ],
            },
          },
          {
            id: {
              targetCompleted: {
                label: '//fixture:installed',
                configuration: { id: configuration },
              },
            },
            completed: { success: true },
          },
          {
            id: {
              testResult: {
                label: '//fixture:installed',
                configuration: { id: configuration },
                run: 1,
                attempt: 1,
              },
            },
            testResult: { status: 'PASSED' },
          },
          {
            id: {
              testSummary: { label: '//fixture:installed', configuration: { id: configuration } },
            },
            testSummary: { overallStatus: 'PASSED', totalRunCount: 1 },
          },
          {
            id: { structuredCommandLine: { commandLineLabel: 'canonical' } },
            structuredCommandLine: {
              commandLineLabel: 'canonical',
              sections: [
                {
                  optionList: {
                    option: [
                      {
                        optionName: 'experimental_aquery_dump_after_build_format',
                        optionValue: 'jsonproto',
                      },
                      {
                        optionName: 'experimental_aquery_dump_after_build_output_file',
                        optionValue: aqueryFile,
                      },
                      { optionName: 'output_groups', optionValue: '+shipping_manifest' },
                    ],
                  },
                },
              ],
            },
          },
          {
            id: { buildMetadata: {} },
            buildMetadata: {
              metadata: nativeBuildMetadata(request.expected.source, request.expected.github),
            },
          },
          { id: { buildFinished: {} }, finished: { exitCode: { name: 'SUCCESS' } } },
          { id: { buildMetrics: {} }, buildMetrics: {}, lastMessage: true },
        ],
        inputs: [],
        outputs: [
          { path: output, members: [{ path: '', type: 'file', mode: 0o644, ...outputIdentity }] },
        ],
        producerCapture: { aqueryFile, shippingManifests: [{ path: manifest, contents }] },
      },
    ],
  };
  const origin = {
    github: structuredClone(request.expected.github),
    artifact: {
      id: 101,
      name: request.expected.artifactName,
      digest: `sha256:${'d'.repeat(64)}`,
      size: 1024,
    },
    evidenceDigest: `sha256:${identity(JSON.stringify(evidence)).sha256}`,
    evidence,
  };
  return { request, origin, authenticate: async () => origin };
}

async function fixture(run: (root: string) => Promise<void>, kind = '') {
  const root = mkdtempSync(path.join(tmpdir(), 'oliphaunt-native-auth-test-'));
  const keys = [
    'BUN_OPTIONS',
    'GH_TOKEN',
    'GH_REPO',
    'PATH',
    'FAKE_NATIVE_ORIGIN',
    'FAKE_NATIVE_CASE',
    'FAKE_ARTIFACT_ARCHIVE',
    'FAKE_GH_LOG',
    'FAKE_GH_STATE',
    'FAKE_MODE',
    'FAKE_RUN_CONCLUSION',
    'OLIPHAUNT_GITHUB_RUN_SNAPSHOT_DIR',
  ];
  const before = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    mkdirSync(path.join(root, 'evidence'));
    // Synthetic transport bytes exercise this boundary; they are not a qualified or live-authenticated build packet.
    writeFileSync(
      path.join(root, 'evidence/native-build-evidence.json'),
      JSON.stringify({ synthetic: true }),
    );
    execFileSync('zip', ['-q', path.join(root, 'artifact.zip'), 'native-build-evidence.json'], {
      cwd: path.join(root, 'evidence'),
    });
    mkdirSync(path.join(root, 'untrusted-cache'));
    writeFileSync(
      path.join(root, 'untrusted-cache/run-77.json'),
      '{"untrusted":"downloaded fixture metadata"}',
    );
    Object.assign(process.env, {
      BUN_OPTIONS: `--preload=${path.resolve(import.meta.dir, 'testdata/download-build-artifacts-github.mts')}`,
      GH_TOKEN: 'test-token',
      GH_REPO: 'ignored/by-adapter',
      PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}`,
      FAKE_NATIVE_ORIGIN: 'true',
      FAKE_NATIVE_CASE: kind,
      FAKE_ARTIFACT_ARCHIVE: path.join(root, 'artifact.zip'),
      FAKE_GH_LOG: path.join(root, 'api.log'),
      FAKE_GH_STATE: path.join(root, 'download-count'),
      FAKE_MODE: 'success',
      FAKE_RUN_CONCLUSION: 'failure',
      OLIPHAUNT_GITHUB_RUN_SNAPSHOT_DIR: path.join(root, 'untrusted-cache'),
    });
    await run(root);
  } finally {
    for (const key of keys) {
      if (before[key] === undefined) delete process.env[key];
      else process.env[key] = before[key];
    }
    rmSync(root, { recursive: true, force: true });
  }
}

test('reviewed main producer assurance preserves construction limits and accepts bound mandatory tests', async () => {
  for (const [job, artifact] of [
    ['Linux runtime (x86_64)', 'native-build-evidence-x86_64'],
    ['Linux runtime (aarch64)', 'native-build-evidence-aarch64'],
    ['Linux WASIX and installed browser', 'native-build-evidence-wasix-tools'],
    ['Linux WASIX and installed browser', 'native-build-evidence-wasix-pg-hashids'],
    ['Linux native postmaster lifecycle', 'native-build-evidence-postmaster-linux'],
    ['Native postmaster lifecycle (linux-arm64)', 'native-build-evidence-postmaster-linux-arm64'],
    ['Native postmaster lifecycle (macos-arm64)', 'native-build-evidence-postmaster-macos-arm64'],
    ['Portable packages (linux-x64)', 'native-build-evidence-napi-linux-x64'],
    ['Portable packages (linux-arm64)', 'native-build-evidence-napi-linux-arm64'],
    ['Portable packages (macos-arm64)', 'native-build-evidence-napi-macos-arm64'],
    ['Portable packages (windows-x64)', 'native-build-evidence-napi-windows-x64'],
    ['Linux runtime (x86_64)', 'native-build-evidence-mobile-android'],
    ['Portable packages (macos-arm64)', 'native-build-evidence-mobile-ios'],
  ]) {
    for (const event of ['push', 'workflow_dispatch'] as const) {
      const f = syntheticReviewedProducer(job, artifact);
      f.request.expected.event = event;
      const result = await assureReviewedNativeBuildProducer('synthetic', f.request, f);
      expect(result.assurance.scope).toBe('reviewed-producer-assurance');
      expect(result.assurance.reviewedSource).toEqual(f.request.reviewedSource);
      expect(result.assurance.event).toBe(f.request.expected.event);
      expect(result.assurance.ref).toBe('refs/heads/main');
      expect(result.assurance.artifact).toEqual(f.origin.artifact);
      expect(result.assurance.shippingAnalysis).toBe('bound');
      expect(result.assurance.testQualification).toBe('passed');
      expect(result.assurance.requiredTests).toMatchObject(f.request.requiredTests);
      expect(result.assurance.acceptedExecutionAssumptions).toHaveLength(2);
      expect('releaseDecision' in result.assurance).toBe(false);
      expect('baselineAdmission' in result.assurance).toBe(false);
      expect(result.qualification.scope).toBe('construction');
      expect(result.qualification.releaseDecision).toBe('unverified');
      expect(result.qualification.unverified).toContain(
        'immutable input lifetime from the producing build through content capture',
      );
      expect(result.qualification.unverified).toContain(
        'native action-graph dump bytes authenticated by the producing invocation',
      );
    }
  }
});

test('reviewed producer rejects unreviewed sources, PR origins and noncanonical roles before transport', async () => {
  const cases: [string, (f: ReturnType<typeof syntheticReviewedProducer>) => void][] = [
    [
      'repository',
      (f) => {
        f.request.expected.github.repository = 'attacker/oliphaunt';
      },
    ],
    [
      'source commit',
      (f) => {
        f.request.reviewedSource.commit = 'e'.repeat(40);
      },
    ],
    [
      'source tree',
      (f) => {
        f.request.reviewedSource.tree = 'e'.repeat(40);
      },
    ],
    [
      'PR',
      (f) => {
        f.request.expected.event = 'pull_request';
        f.request.expected.ref = 'refs/pull/1/merge';
      },
    ],
    [
      'branch',
      (f) => {
        f.request.expected.ref = 'refs/heads/release';
      },
    ],
    [
      'workflow',
      (f) => {
        f.request.expected.github.workflow = 'Unreviewed builder';
      },
    ],
    [
      'workflow path',
      (f) => {
        f.request.expected.github.workflowPath = '.github/workflows/unreviewed.yml';
      },
    ],
    [
      'job',
      (f) => {
        f.request.expected.github.job = 'Portable packages (windows-x64)';
      },
    ],
    [
      'artifact',
      (f) => {
        f.request.expected.artifactName = 'native-build-evidence-aarch64';
      },
    ],
    [
      'unknown job with missing artifact',
      (f) => {
        f.request.expected.github.job = 'Unreviewed builder';
        Reflect.deleteProperty(f.request.expected, 'artifactName');
      },
    ],
    [
      'missing tests',
      (f) => {
        Reflect.deleteProperty(f.request, 'requiredTests');
      },
    ],
    [
      'empty tests',
      (f) => {
        f.request.requiredTests = [];
      },
    ],
  ];
  for (const [name, mutate] of cases) {
    const f = syntheticReviewedProducer();
    mutate(f);
    let calls = 0;
    await expect(
      assureReviewedNativeBuildProducer('synthetic', f.request, {
        authenticate: async () => {
          calls += 1;
          return f.origin;
        },
      }),
    ).rejects.toThrow();
    expect(calls, name).toBe(0);
  }
});

test('retained assurance rejects unknown jobs even when the artifact name is absent', async () => {
  const f = syntheticReviewedProducer();
  const { assurance } = await assureReviewedNativeBuildProducer('synthetic', f.request, f);
  expect(
    validateReviewedNativeProducerAssurance(assurance, { source: f.request.reviewedSource }),
  ).toBe(assurance);
  for (const job of ['Unreviewed builder', expected.github.job]) {
    const malformed = structuredClone(assurance);
    malformed.github.job = job;
    Reflect.deleteProperty(malformed.artifact, 'name');
    expect(() =>
      validateReviewedNativeProducerAssurance(malformed, {
        source: f.request.reviewedSource,
      }),
    ).toThrow('assurance identity is invalid');
  }
});

test('reviewed producer rejects substituted authenticated origin and immutable artifact identities', async () => {
  const cases: [string, (f: ReturnType<typeof syntheticReviewedProducer>) => void][] = [
    [
      'repository',
      (f) => {
        f.origin.github.repository = 'attacker/oliphaunt';
      },
    ],
    [
      'run',
      (f) => {
        f.origin.github.runId += 1;
      },
    ],
    [
      'attempt',
      (f) => {
        f.origin.github.runAttempt += 1;
      },
    ],
    [
      'job',
      (f) => {
        f.origin.github.job = 'Linux runtime (aarch64)';
      },
    ],
    [
      'artifact name',
      (f) => {
        f.origin.artifact.name = 'native-build-evidence-aarch64';
      },
    ],
    [
      'artifact id',
      (f) => {
        f.origin.artifact.id = 0;
      },
    ],
    [
      'artifact digest',
      (f) => {
        f.origin.artifact.digest = 'invalid';
      },
    ],
    [
      'artifact size',
      (f) => {
        f.origin.artifact.size = 0;
      },
    ],
    [
      'evidence digest',
      (f) => {
        f.origin.evidenceDigest = 'invalid';
      },
    ],
  ];
  for (const [name, mutate] of cases) {
    const f = syntheticReviewedProducer();
    mutate(f);
    await expect(
      assureReviewedNativeBuildProducer('synthetic', f.request, f),
      name,
    ).rejects.toThrow();
  }
});

test('reviewed producer requires producing-analysis shipping and complete successful configured tests', async () => {
  const cases: [string, (f: ReturnType<typeof syntheticReviewedProducer>) => void][] = [
    [
      'evidence source',
      (f) => {
        f.origin.evidence.source = { ...f.request.reviewedSource, commit: 'e'.repeat(40) };
      },
    ],
    [
      'legacy analysis',
      (f) => {
        delete f.origin.evidence.cohorts[0].producerCapture;
      },
    ],
    [
      'missing test',
      (f) => {
        f.request.requiredTests[0].label = '//fixture:missing';
      },
    ],
    [
      'wrong configuration',
      (f) => {
        f.request.requiredTests[0].configuration = 'e'.repeat(64);
      },
    ],
    [
      'missing result',
      (f) => {
        f.origin.evidence.cohorts[0].buildEvents = f.origin.evidence.cohorts[0].buildEvents.filter(
          (event) => !event.testResult,
        );
      },
    ],
    [
      'failed result',
      (f) => {
        const event = f.origin.evidence.cohorts[0].buildEvents.find((event) => event.testResult);
        if (!event) throw new Error('synthetic fixture requires its test result');
        event.testResult.status = 'FAILED';
      },
    ],
    [
      'failed summary',
      (f) => {
        const event = f.origin.evidence.cohorts[0].buildEvents.find((event) => event.testSummary);
        if (!event) throw new Error('synthetic fixture requires its test summary');
        event.testSummary.overallStatus = 'FAILED';
      },
    ],
  ];
  for (const [name, mutate] of cases) {
    const f = syntheticReviewedProducer();
    mutate(f);
    await expect(
      assureReviewedNativeBuildProducer('synthetic', f.request, f),
      name,
    ).rejects.toThrow();
  }
});

test('native origin uses the existing exact-ID/digest transport and selected successful job, ignoring inherited fixture caches', async () => {
  await fixture(async (root) => {
    const origin = await authenticateNativeBuildEvidence(path.join(root, 'evidence'), expected);
    expect(origin.github).toEqual(expected.github);
    expect(origin.artifact).toMatchObject({ id: 101, name: expected.artifactName });
    expect(origin.artifact.digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(origin.evidence).toEqual({ synthetic: true });
    expect(origin.evidenceDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    writeFileSync(
      path.join(root, 'evidence/native-build-evidence.json'),
      JSON.stringify({ changedAfterAuthentication: true }),
    );
    expect(origin.evidence).toEqual({ synthetic: true });
    const endpoints: string[] = readFileSync(path.join(root, 'api.log'), 'utf8')
      .trim()
      .split('\n')
      .map(JSON.parse);
    expect(endpoints.some((url) => url.endsWith('/actions/artifacts/101/zip'))).toBe(true);
    expect(endpoints.some((url) => url.endsWith(`/git/commits/${expected.source.commit}`))).toBe(
      true,
    );
    expect(readFileSync(path.join(root, 'untrusted-cache/run-77.json'), 'utf8')).toContain(
      'untrusted',
    );
  });
});

test('native origin rejects stale source/tree/attempt/job, wrong workflow/event/ref and cross-attempt artifacts', async () => {
  for (const kind of [
    'source',
    'tree',
    'attempt',
    'job-attempt',
    'job-failure',
    'workflow',
    'run-workflow',
    'event',
    'ref',
    'stale-artifact',
    'artifact-source',
    'artifact-missing',
    'artifact-ambiguous',
    'artifact-window-missing',
    'artifact-head-missing',
    'job-window-missing',
  ]) {
    await fixture(async (root) => {
      await expect(
        authenticateNativeBuildEvidence(path.join(root, 'evidence'), expected),
      ).rejects.toThrow();
      expect(existsSync(path.join(root, 'download-count'))).toBe(false);
    }, kind);
  }
});

test('authentication CLI emits bounded origin metadata and digest without the large parsed packet', async () => {
  await fixture(async (root) => {
    const context = path.join(root, 'github.json');
    writeFileSync(context, JSON.stringify(expected.github));
    const script = path.resolve(import.meta.dir, 'authenticate-native-build-evidence.mts');
    const output = execFileSync(
      process.execPath,
      [
        script,
        '--source-commit',
        expected.source.commit,
        '--source-tree',
        expected.source.tree,
        '--github-json',
        context,
        '--event',
        expected.event,
        '--ref',
        expected.ref,
        '--artifact-name',
        expected.artifactName,
        '--evidence-root',
        path.join(root, 'evidence'),
      ],
      { encoding: 'utf8', env: process.env },
    );
    const origin = JSON.parse(output);
    expect(Object.keys(origin).sort()).toEqual(['artifact', 'evidenceDigest', 'github']);
    expect(origin.github).toEqual(expected.github);
    expect(origin.artifact.id).toBe(101);
    expect(() =>
      execFileSync(process.execPath, [script, '--evidence-root', path.join(root, 'evidence')], {
        env: process.env,
        stdio: 'pipe',
      }),
    ).toThrow();
  });
});

test('native origin rejects tampered downloaded archives and local evidence bytes', async () => {
  await fixture(async (root) => {
    await expect(
      authenticateNativeBuildEvidence(path.join(root, 'evidence'), expected),
    ).rejects.toThrow(/ZIP identity mismatch/);
    expect(readFileSync(path.join(root, 'download-count'), 'utf8')).toBe('2');
  }, 'digest');
  await fixture(async (root) => {
    writeFileSync(
      path.join(root, 'evidence/native-build-evidence.json'),
      JSON.stringify({ tampered: true }),
    );
    await expect(
      authenticateNativeBuildEvidence(path.join(root, 'evidence'), expected),
    ).rejects.toThrow(/bytes differ/);
  });
});

test('controller authenticates transported final bytes from the exact artifact and rejects local or supplier substitution', async () => {
  await fixture(async (root) => {
    const f = syntheticReviewedProducer();
    const evidenceRoot = path.join(root, 'evidence');
    const output = f.origin.evidence.cohorts[0].outputs[0].path;
    const transported = path.join(evidenceRoot, 'files/0', output);
    mkdirSync(path.dirname(transported), { recursive: true });
    writeFileSync(transported, 'synthetic public archive');
    writeFileSync(
      path.join(evidenceRoot, 'native-build-evidence.json'),
      JSON.stringify(f.origin.evidence),
    );
    const archive = () => {
      rmSync(path.join(root, 'artifact.zip'));
      execFileSync(
        'zip',
        ['-qr', path.join(root, 'artifact.zip'), 'native-build-evidence.json', 'files'],
        { cwd: evidenceRoot },
      );
    };
    archive();
    const origin = await authenticateNativeBuildEvidence(evidenceRoot, expected);
    expect(origin.finalFiles?.scope).toBe('construction');
    expect(origin.finalFiles?.files).toEqual([
      {
        cohort: 0,
        path: output,
        size: Buffer.byteLength('synthetic public archive'),
        sha256: createHash('sha256').update('synthetic public archive').digest('hex'),
      },
    ]);
    expect(origin.finalFiles?.artifactRoots).toEqual([transported]);
    writeFileSync(transported, 'local substitution');
    await expect(authenticateNativeBuildEvidence(evidenceRoot, expected)).rejects.toThrow(
      'native final transport bytes',
    );
    // Authenticating the ZIP does not authorize bytes that contradict its evidence.
    archive();
    await expect(authenticateNativeBuildEvidence(evidenceRoot, expected)).rejects.toThrow(
      'native final transport bytes',
    );
    writeFileSync(transported, 'synthetic public archive');
    archive();
    rmSync(path.join(evidenceRoot, 'files'), { recursive: true });
    await expect(authenticateNativeBuildEvidence(evidenceRoot, expected)).rejects.toThrow(
      'final file transport differ',
    );
  });
});

test('historical producer transport uses its authenticated version while current qualification retains its explicit pin', async () => {
  await fixture(async (root) => {
    const f = syntheticReviewedProducer();
    const current = readFileSync(new URL('../../.bazelversion', import.meta.url), 'utf8').trim();
    const historical = current === '8.7.0' ? '8.6.0' : '8.7.0';
    const started = f.origin.evidence.cohorts[0].buildEvents.find(
      (event: any) => event.started,
    ) as any;
    started.started.buildToolVersion = historical;
    const directory = path.join(root, 'evidence');
    const output = f.origin.evidence.cohorts[0].outputs[0].path;
    const file = path.join(directory, 'files/0', output);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, 'synthetic public archive');
    writeFileSync(
      path.join(directory, 'native-build-evidence.json'),
      JSON.stringify(f.origin.evidence),
    );
    rmSync(path.join(root, 'artifact.zip'));
    execFileSync(
      'zip',
      ['-qr', path.join(root, 'artifact.zip'), 'native-build-evidence.json', 'files'],
      { cwd: directory },
    );
    const origin = await authenticateNativeBuildEvidence(directory, expected);
    expect(origin.finalFiles?.artifactRoots).toEqual([file]);
    expect(() =>
      validateNativeBuildEvidence(origin.evidence, { ...expected, bazelVersion: historical }),
    ).not.toThrow();
    expect(() =>
      validateNativeBuildEvidence(origin.evidence, { ...expected, bazelVersion: current }),
    ).toThrow('native BEP Bazel version mismatch');
  });
});
