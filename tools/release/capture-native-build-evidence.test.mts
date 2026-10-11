import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  captureNativeBuildEvidence,
  nativeRootConfigurations,
  writeNativeBuildEvidence,
} from './capture-native-build-evidence.mts';
import { nativeBuildMetadata, validateNativeBuildEvidence } from './native-build-qualification.mts';

function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), 'native-build-capture-'));
  const executionRoot = path.join(directory, 'execroot');
  const workspace = path.join(directory, 'workspace');
  const external = path.join(directory, 'repositories');
  const source = 'src/main.mts';
  const tool = 'external/compiler/bin/compiler';
  const generated = 'bazel-out/k8-opt/bin/generated';
  const output = 'bazel-out/k8-opt/bin/public/native.tar.gz';
  mkdirSync(path.join(workspace, 'src'), { recursive: true });
  mkdirSync(path.join(external, 'compiler/bin'), { recursive: true });
  mkdirSync(path.join(executionRoot, generated, 'empty'), { recursive: true });
  mkdirSync(path.dirname(path.join(executionRoot, output)), { recursive: true });
  writeFileSync(path.join(workspace, source), 'actual source input');
  writeFileSync(path.join(external, 'compiler/bin/compiler'), 'actual compiler input');
  chmodSync(path.join(external, 'compiler/bin/compiler'), 0o755);
  writeFileSync(path.join(executionRoot, generated, 'config.h'), '#define CONFIG 1\n');
  writeFileSync(path.join(executionRoot, output), 'actual archive bytes');
  symlinkSync(path.join(workspace, 'src'), path.join(executionRoot, 'src'), 'dir');
  symlinkSync(external, path.join(executionRoot, 'external'), 'dir');
  const paths = [source, tool, generated, output];
  const aquery = {
    pathFragments: paths.flatMap((file, index) =>
      file.split('/').map((label, part) => ({
        id: `${index}-${part}`,
        label,
        ...(part ? { parentId: `${index}-${part - 1}` } : {}),
      })),
    ),
    artifacts: paths.map((file, index) => ({
      id: index + 1,
      pathFragmentId: `${index}-${file.split('/').length - 1}`,
    })),
    targets: [
      { id: 1, label: '//src:generate' },
      { id: 2, label: '//src:package' },
    ],
    configuration: [{ id: 1, checksum: 'e'.repeat(64), isTool: true }],
    depSetOfFiles: [
      { id: 1, directArtifactIds: [1] },
      { id: 2, directArtifactIds: [1, 2, 3] },
    ],
    actions: [
      {
        targetId: 1,
        configurationId: 1,
        actionKey: 'generator-definition',
        mnemonic: 'Generate',
        inputDepSetIds: [1],
        outputIds: [3],
        primaryOutputId: 3,
      },
      {
        targetId: 2,
        configurationId: 1,
        actionKey: 'package-definition',
        mnemonic: 'Package',
        inputDepSetIds: [2],
        outputIds: [4],
        primaryOutputId: 4,
      },
    ],
  };
  const root = {
    label: '//src:shipping',
    package: {
      product: 'fixture',
      version: '1.0.0',
      ecosystem: 'github',
      name: 'native.tar.gz',
      configuration: 'linux-x64-gnu',
      role: 'github-release-asset',
      outputs: [{ path: output, owner: '//src:package' }],
    },
  };
  // Actual CqueryResult JSON-proto field shape; these IDs are unrelated to aquery IDs.
  const cquery = {
    results: [
      { target: { rule: { name: root.label } }, configurationId: 17 },
      { target: { sourceFile: { name: '//src:main.mts' } } },
    ],
    configurations: [{ id: 17, checksum: 'c'.repeat(64), mnemonic: 'k8-opt' }],
  };
  const runGit = (...args: string[]) =>
    execFileSync('git', args, { cwd: workspace, encoding: 'utf8' }).trim();
  runGit('init', '--quiet');
  runGit('add', '.');
  runGit(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-qm',
    'fixture',
  );
  const sourceIdentity = {
    commit: runGit('rev-parse', 'HEAD'),
    tree: runGit('rev-parse', 'HEAD^{tree}'),
  };
  const github = {
    repository: 'f0rr0/oliphaunt',
    workflow: 'Native Bazel qualification',
    workflowPath: '.github/workflows/bazel.yml',
    runId: 456,
    runAttempt: 2,
    job: 'Linux runtime (x86_64)',
  };
  const outputBytes = readFileSync(path.join(executionRoot, output));
  const events = [
    { id: { started: {} }, started: { uuid: 'fixture-invocation', buildToolVersion: '8.8.1' } },
    { id: { workspace: {} }, workspaceInfo: { localExecRoot: executionRoot } },
    { id: { configuration: { id: 'c'.repeat(64) } }, configuration: { mnemonic: 'k8-opt' } },
    {
      id: { namedSet: { id: 'outputs' } },
      namedSetOfFiles: {
        files: [
          {
            pathPrefix: ['bazel-out', 'k8-opt', 'bin'],
            name: 'public/native.tar.gz',
            digest: createHash('sha256').update(outputBytes).digest('hex'),
            length: String(outputBytes.length),
          },
        ],
      },
    },
    {
      id: { targetCompleted: { label: root.label, configuration: { id: 'c'.repeat(64) } } },
      completed: {
        success: true,
        outputGroup: [{ name: 'default', fileSets: [{ id: 'outputs' }] }],
      },
    },
    {
      id: { buildMetadata: {} },
      buildMetadata: { metadata: nativeBuildMetadata(sourceIdentity, github) },
    },
    { id: { buildFinished: {} }, finished: { exitCode: { name: 'SUCCESS' } } },
    { id: { buildMetrics: {} }, buildMetrics: {}, lastMessage: true },
  ];
  const cohort = { executionRoot, roots: [root], cquery, aquery, buildEvents: events };
  const options = { source: sourceIdentity, github, cohorts: [cohort], bazelVersion: '8.8.1' };
  return {
    directory,
    executionRoot,
    workspace,
    external,
    source,
    tool,
    generated,
    output,
    cohort,
    options,
    capture: () => captureNativeBuildEvidence(options),
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

test('collector reads declared source/repository links and generated trees after cache-backed success', () => {
  const f = fixture();
  try {
    const capture = f.capture();
    expect(capture.evidence.cohorts[0].rootConfigurations).toEqual([
      { label: '//src:shipping', configuration: 'c'.repeat(64) },
    ]);
    expect(capture.evidence.cohorts[0].inputs.map(({ path }) => path)).toEqual(
      [f.generated, f.tool, f.source].sort(),
    );
    const tree = capture.evidence.cohorts[0].inputs.find(({ path }) => path === f.generated)!;
    expect(tree.members.map(({ path }) => path)).toEqual(['', 'config.h', 'empty']);
    expect(
      capture.evidence.cohorts[0].inputs.find(({ path }) => path === f.tool)!.members[0].mode,
    ).toBe(0o755);
    expect(capture.qualification.releaseDecision).toBe('unverified');
    expect(capture.qualification.unverified).toContain(
      'immutable input lifetime from the producing build through content capture',
    );
    const output = writeNativeBuildEvidence(capture, path.join(f.directory, 'evidence'));
    const packet = JSON.parse(readFileSync(output, 'utf8'));
    expect(validateNativeBuildEvidence(packet, f.options).scope).toBe('construction');
    const original = readFileSync(output);
    expect(() => writeNativeBuildEvidence(capture, path.dirname(output))).toThrow();
    expect(readFileSync(output)).toEqual(original);
  } finally {
    f.cleanup();
  }
});

test('cquery checksum resolution rejects ambiguous, missing, null and substituted root configurations', () => {
  const f = fixture();
  try {
    for (const mutate of [
      (query: any) => {
        query.results = [];
      },
      (query: any) => {
        query.results.push(query.results[0]);
      },
      (query: any) => {
        query.results[0].configurationId = 0;
      },
      (query: any) => {
        query.results[0].configurationId = 99;
      },
      (query: any) => {
        query.configurations.push(query.configurations[0]);
      },
      (query: any) => {
        query.configurations[0].checksum = '';
      },
    ]) {
      const query = structuredClone(f.cohort.cquery);
      mutate(query);
      expect(() => nativeRootConfigurations(f.cohort.roots, query)).toThrow();
    }
    f.cohort.cquery.configurations[0].checksum = 'd'.repeat(64);
    expect(f.capture).toThrow('shipping configuration mismatch');
  } finally {
    f.cleanup();
  }
});

test('actual main-repository label spellings agree without conflating external repositories', () => {
  const f = fixture();
  try {
    // Starlark str(Label) uses @@//; CqueryResult and BEP use // for the main repository.
    f.cohort.roots[0].label = '@@//src:shipping';
    f.cohort.roots[0].package.outputs[0].owner = '@@//src:package';
    const capture = f.capture();
    expect(capture.evidence.cohorts[0].roots[0].label).toBe('@@//src:shipping');
    expect(capture.evidence.cohorts[0].rootConfigurations[0].label).toBe('@@//src:shipping');
    expect(capture.qualification.cohorts[0].roots[0].label).toBe('@@//src:shipping');
    f.cohort.roots[0].label = '@@foreign//src:shipping';
    expect(f.capture).toThrow(/one configured rule/);
  } finally {
    f.cleanup();
  }
});

test('virtual runfiles Middleman retains its real input closure without requiring a synthetic file', () => {
  const f = fixture();
  try {
    const virtual = 'bazel-out/k8-opt/internal/_middlemen/compiler-runfiles';
    const parts = virtual.split('/');
    const graph = f.cohort.aquery;
    graph.pathFragments.push(
      ...parts.map((label, part) => ({
        id: `middleman-${part}`,
        label,
        ...(part ? { parentId: `middleman-${part - 1}` } : {}),
      })),
    );
    graph.artifacts.push({ id: 5, pathFragmentId: `middleman-${parts.length - 1}` });
    graph.depSetOfFiles.push({ id: 3, directArtifactIds: [1, 2] });
    graph.depSetOfFiles[1].directArtifactIds.push(5);
    const connector = {
      targetId: 1,
      configurationId: 1,
      actionKey: 'virtual-runfiles-connector',
      mnemonic: 'Middleman',
      inputDepSetIds: [3],
      outputIds: [5],
      primaryOutputId: 5,
    };
    graph.actions.push(connector);
    const capture = f.capture();
    expect(capture.evidence.cohorts[0].inputs.map(({ path }) => path)).toEqual(
      [f.generated, f.tool, f.source].sort(),
    );
    expect(capture.evidence.cohorts[0].aquery).toEqual(graph);
    expect(existsSync(path.join(f.executionRoot, virtual))).toBe(false);
    // The output's producer type is the evidence; its path alone cannot excuse a missing file.
    connector.mnemonic = 'FileWrite';
    expect(f.capture).toThrow(/ENOENT/);
    connector.mnemonic = 'Middleman';
    rmSync(path.join(f.external, 'compiler/bin/compiler'));
    expect(f.capture).toThrow(/compiler\/bin\/compiler/);
  } finally {
    f.cleanup();
  }
});

test('missing physical inputs and changed bytes, modes, links or generated membership prevent publication of capture', () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) =>
      writeFileSync(path.join(f.workspace, f.source), 'changed source'),
    (f: ReturnType<typeof fixture>) =>
      chmodSync(path.join(f.external, 'compiler/bin/compiler'), 0o644),
    (f: ReturnType<typeof fixture>) =>
      writeFileSync(path.join(f.executionRoot, f.generated, 'extra'), 'extra'),
    (f: ReturnType<typeof fixture>) => {
      const replacement = path.join(f.directory, 'replacement');
      mkdirSync(replacement);
      writeFileSync(path.join(replacement, 'main.mts'), 'actual source input');
      rmSync(path.join(f.executionRoot, 'src'));
      symlinkSync(replacement, path.join(f.executionRoot, 'src'), 'dir');
    },
  ]) {
    const f = fixture();
    try {
      const capture = f.capture();
      mutate(f);
      const output = path.join(f.directory, 'evidence');
      expect(() => writeNativeBuildEvidence(capture, output)).toThrow(/changed after capture/);
      expect(existsSync(path.join(output, 'native-build-evidence.json'))).toBe(false);
    } finally {
      f.cleanup();
    }
  }
  const f = fixture();
  try {
    rmSync(path.join(f.executionRoot, f.generated, 'config.h'));
    symlinkSync(
      path.join(f.workspace, f.source),
      path.join(f.executionRoot, f.generated, 'config.h'),
    );
    expect(f.capture).toThrow(/regular file or directory/);
    rmSync(path.join(f.external, 'compiler/bin/compiler'));
    expect(f.capture).toThrow();
  } finally {
    f.cleanup();
  }
});

test('collector CLI consumes captured protocol files, exact Git snapshot context and validates before writing', () => {
  const f = fixture();
  try {
    const file = (name: string, value: unknown, lines = false) => {
      const target = path.join(f.directory, name);
      writeFileSync(
        target,
        lines
          ? (value as unknown[]).map((row) => JSON.stringify(row)).join('\n')
          : JSON.stringify(value),
      );
      return target;
    };
    const args = [
      '--github-json',
      file('github.json', f.options.github),
      '--cohort',
      file('roots.jsonl', f.cohort.roots, true),
      file('cquery.json', f.cohort.cquery),
      file('aquery.json', f.cohort.aquery),
      file('bep.jsonl', f.cohort.buildEvents, true),
      f.executionRoot,
      '--output-directory',
      path.join(f.directory, 'evidence'),
    ];
    const cli = path.resolve(import.meta.dir, 'capture-native-build-evidence.mts');
    const env = {
      ...process.env,
      OLIPHAUNT_GIT_SOURCE_JSON: JSON.stringify({
        ...f.options.source,
        ref: 'HEAD',
        checkout: f.options.source.commit,
      }),
    };
    const run = (environment = env) =>
      execFileSync(process.execPath, [cli, ...args], {
        cwd: f.workspace,
        env: environment,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    expect(() => run({ ...env, OLIPHAUNT_GIT_SOURCE_JSON: '{}' })).toThrow();
    expect(existsSync(path.join(f.directory, 'evidence/native-build-evidence.json'))).toBe(false);
    const failed = structuredClone(f.cohort.buildEvents);
    (failed[6] as any).finished.exitCode.name = 'FAILURE';
    file('bep.jsonl', failed, true);
    expect(() => run()).toThrow();
    expect(existsSync(path.join(f.directory, 'evidence/native-build-evidence.json'))).toBe(false);
    file('bep.jsonl', f.cohort.buildEvents, true);
    const output = run().trim();
    expect(JSON.parse(readFileSync(output, 'utf8')).source).toEqual(f.options.source);
    expect(() => run()).toThrow();
  } finally {
    f.cleanup();
  }
});

test('build metadata CLI prints the shared validated flags with spaces and rejects incomplete context', () => {
  const f = fixture();
  try {
    const github = path.join(f.directory, 'github.json');
    writeFileSync(github, JSON.stringify(f.options.github));
    const cli = path.resolve(import.meta.dir, 'capture-native-build-evidence.mts');
    const args = [cli, '--build-metadata', '--github-json', github];
    const environment = {
      ...process.env,
      OLIPHAUNT_GIT_SOURCE_JSON: JSON.stringify({
        ...f.options.source,
        ref: 'HEAD',
        checkout: f.options.source.commit,
      }),
    };
    const run = () =>
      execFileSync(process.execPath, args, {
        env: environment,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    expect(run().trim().split('\n')).toEqual(
      Object.entries(nativeBuildMetadata(f.options.source, f.options.github)).map(
        ([key, value]) => `--build_metadata=${key}=${value}`,
      ),
    );
    expect(run()).toContain('--build_metadata=oliphaunt_job=Linux runtime (x86_64)\n');
    writeFileSync(github, JSON.stringify({ ...f.options.github, runAttempt: 0 }));
    expect(run).toThrow();
    writeFileSync(github, JSON.stringify(f.options.github));
    environment.OLIPHAUNT_GIT_SOURCE_JSON = '{}';
    expect(run).toThrow();
  } finally {
    f.cleanup();
  }
});
