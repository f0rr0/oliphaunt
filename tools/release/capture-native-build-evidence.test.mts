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

function producerFixture() {
  const f = fixture();
  const manifest = 'bazel-out/k8-opt/bin/src/shipping.shipping.json';
  const aqueryFile = path.join(f.directory, 'native-after-build.json');
  const graph = f.cohort.aquery;
  const parts = manifest.split('/');
  graph.pathFragments.push(
    ...parts.map((label, part) => ({
      id: `manifest-${part}`,
      label,
      ...(part ? { parentId: `manifest-${part - 1}` } : {}),
    })),
  );
  graph.artifacts.push({ id: 5, pathFragmentId: `manifest-${parts.length - 1}` });
  graph.targets.push({ id: 3, label: '//src:shipping' });
  graph.configuration.push({ id: 2, checksum: 'c'.repeat(64), isTool: false });
  const manifestAction = {
    targetId: 3,
    configurationId: 2,
    actionKey: 'manifest-definition',
    mnemonic: 'FileWrite',
    inputDepSetIds: [],
    outputIds: [5],
    primaryOutputId: 5,
  };
  graph.actions.push(manifestAction);
  mkdirSync(path.dirname(path.join(f.executionRoot, manifest)), { recursive: true });
  const contents = `${JSON.stringify({
    ...f.cohort.roots[0],
    label: '@@//src:shipping',
  })}\n`;
  writeFileSync(path.join(f.executionRoot, manifest), contents);
  const events: any[] = structuredClone(f.cohort.buildEvents);
  events.splice(3, 0, {
    id: { namedSet: { id: 'manifest' } },
    namedSetOfFiles: {
      files: [
        {
          pathPrefix: ['bazel-out', 'k8-opt', 'bin', 'src'],
          name: 'shipping.shipping.json',
          digest: createHash('sha256').update(contents).digest('hex'),
          length: String(Buffer.byteLength(contents)),
        },
      ],
    },
  });
  events
    .find((event) => event.completed)
    .completed.outputGroup.push({
      name: 'shipping_manifest',
      fileSets: [{ id: 'manifest' }],
    });
  events.splice(1, 0, {
    id: { structuredCommandLine: { commandLineLabel: 'canonical' } },
    structuredCommandLine: {
      commandLineLabel: 'canonical',
      sections: [
        {
          sectionLabel: 'command options',
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
            ],
          },
        },
      ],
    },
  });
  const cohort = {
    executionRoot: f.executionRoot,
    aquery: f.cohort.aquery,
    buildEvents: events,
    shippingRoots: ['//src:shipping'],
    aqueryFile,
  };
  const options = { ...f.options, cohorts: [cohort] };
  return {
    ...f,
    manifest,
    manifestAction,
    contents,
    events,
    options,
    capture: () => captureNativeBuildEvidence(options),
  };
}

test('native producer derives exact roots from BEP manifests without a later query', () => {
  const f = producerFixture();
  try {
    const captured = f.capture();
    const cohort = captured.evidence.cohorts[0];
    expect(cohort.roots).toEqual([{ ...f.cohort.roots[0], label: '@@//src:shipping' }]);
    expect(cohort.rootConfigurations).toEqual([
      { label: '@@//src:shipping', configuration: 'c'.repeat(64) },
    ]);
    expect(cohort.producerCapture?.shippingManifests).toEqual([
      { path: f.manifest, contents: f.contents },
    ]);
    expect(captured.qualification.shippingAnalysis).toBe('bound');
    expect(captured.qualification.releaseDecision).toBe('unverified');
    expect(captured.qualification.unverified).toContain(
      'native action-graph dump bytes authenticated by the producing invocation',
    );
    expect(
      validateNativeBuildEvidence(captured.evidence, {
        ...f.options,
        requireShippingAnalysis: true,
      }).shippingAnalysis,
    ).toBe('bound');
    writeFileSync(path.join(f.executionRoot, f.manifest), `${f.contents} `);
    expect(() => captured.assertUnchanged()).toThrow(/changed after capture/);
    expect(() => writeNativeBuildEvidence(captured, path.join(f.directory, 'evidence'))).toThrow();
  } finally {
    f.cleanup();
  }
});

test('old query-based evidence remains diagnostic and cannot satisfy native analysis policy', () => {
  const f = fixture();
  try {
    const captured = f.capture();
    expect(captured.qualification.shippingAnalysis).toBe('unverified');
    expect(() =>
      validateNativeBuildEvidence(captured.evidence, {
        ...f.options,
        requireShippingAnalysis: true,
      }),
    ).toThrow(/producing-analysis shipping manifests/);
  } finally {
    f.cleanup();
  }
});

test('serialized native evidence excludes ambient options and logs while retaining qualification facts', () => {
  const f = producerFixture();
  const secret = 'sentinel-invocation-secret';
  const configuration = 'c'.repeat(64);
  const consumer = '//src:consumer';
  try {
    f.events.find((event) => event.started).started.optionsDescription =
      `--repo_env=TOKEN=${secret}`;
    f.events.find((event) => event.configuration).configuration.makeVariable = { TOKEN: secret };
    f.events.find((event) => event.buildMetadata).buildMetadata.metadata.UNUSED_TOKEN = secret;
    const command = f.events.find((event) => event.structuredCommandLine).structuredCommandLine;
    command.sections[0].optionList.option[0].combinedForm = secret;
    command.sections[0].optionList.option.push(
      { optionName: 'client_env', optionValue: `TOKEN=${secret}` },
      { optionName: 'output_groups', optionValue: 'default,shipping_manifest' },
    );
    command.sections.push({ sectionLabel: 'executable', chunkList: { chunk: [secret] } });
    const unused = [
      { id: { unstructuredCommandLine: {} }, unstructuredCommandLine: { args: [secret] } },
      { id: { optionsParsed: {} }, optionsParsed: { cmdLine: [secret] } },
      {
        id: { structuredCommandLine: { commandLineLabel: 'original' } },
        structuredCommandLine: {
          commandLineLabel: 'original',
          sections: [{ chunkList: { chunk: [secret] } }],
        },
      },
      { id: { progress: { opaqueCount: 1 } }, progress: { stdout: secret, stderr: secret } },
      { id: { workspaceStatus: {} }, workspaceStatus: { item: [{ key: 'TOKEN', value: secret }] } },
      {
        id: { buildToolLogs: {} },
        buildToolLogs: { log: [{ name: 'command', contents: secret, uri: secret }] },
      },
      {
        id: { actionCompleted: { primaryOutput: 'unused' } },
        action: { commandLine: [secret], strategyDetails: secret },
      },
      {
        id: { execRequest: {} },
        execRequest: { argv: [secret], environmentVariable: [{ name: 'TOKEN', value: secret }] },
      },
      {
        id: { fetch: { url: `https://example.invalid/${secret}` } },
        children: [{ fetch: { url: `https://example.invalid/${secret}` } }],
      },
    ];
    const testEvents = [
      {
        id: { targetCompleted: { label: consumer, configuration: { id: configuration } } },
        completed: { success: true },
      },
      {
        id: {
          testResult: {
            label: consumer,
            configuration: { id: configuration },
            run: 1,
            shard: 0,
            attempt: 1,
          },
        },
        testResult: { status: 'PASSED', testActionOutput: [{ contents: secret, uri: secret }] },
      },
      {
        id: { testSummary: { label: consumer, configuration: { id: configuration } } },
        testSummary: {
          overallStatus: 'PASSED',
          totalRunCount: 1,
          passed: [{ contents: secret, uri: secret }],
        },
      },
    ];
    const named = f.events.find((event) => event.namedSetOfFiles);
    named.namedSetOfFiles.files[0].uri = secret;
    named.namedSetOfFiles.files[0].contents = secret;
    f.events.splice(-1, 0, ...unused, ...testEvents);
    const captured = f.capture();
    const output = writeNativeBuildEvidence(captured, path.join(f.directory, 'evidence'));
    const contents = readFileSync(output, 'utf8');
    expect(contents).not.toContain(secret);
    const packet = JSON.parse(contents);
    const retained = packet.cohorts[0].buildEvents;
    expect(retained.map((event: any) => event.id)).toEqual(
      f.events.map((event) => ({ ...event.id, ...(event.id.fetch ? { fetch: {} } : {}) })),
    );
    expect(retained.at(-1).lastMessage).toBe(true);
    expect(retained.find((event: any) => event.children).children).toEqual([{ fetch: {} }]);
    expect(retained.find((event: any) => event.buildMetadata).buildMetadata.metadata).toEqual(
      nativeBuildMetadata(f.options.source, f.options.github),
    );
    expect(
      retained
        .find((event: any) => event.structuredCommandLine)
        .structuredCommandLine.sections[0].optionList.option.map(
          (option: any) => option.optionName,
        ),
    ).toEqual([
      'experimental_aquery_dump_after_build_format',
      'experimental_aquery_dump_after_build_output_file',
      'output_groups',
    ]);
    const result = validateNativeBuildEvidence(packet, {
      ...f.options,
      requireShippingAnalysis: true,
      requiredTests: [{ label: consumer, configuration }],
    });
    expect(result.shippingAnalysis).toBe('bound');
    expect(result.releaseDecision).toBe('unverified');
  } finally {
    f.cleanup();
  }
});

test('native producer rejects missing, cross-configured, corrupt and misrouted manifest receipts', () => {
  for (const mutate of [
    (f: ReturnType<typeof producerFixture>) => {
      f.options.cohorts[0].shippingRoots.push('//src:shipping');
    },
    (f: ReturnType<typeof producerFixture>) => {
      f.options.cohorts[0].shippingRoots[0] = '//src:other';
    },
    (f: ReturnType<typeof producerFixture>) => {
      f.events.find((e) => e.completed).completed.outputGroup.pop();
    },
    (f: ReturnType<typeof producerFixture>) => {
      f.events.find(
        (e) => e.namedSetOfFiles?.files[0]?.name === 'shipping.shipping.json',
      ).namedSetOfFiles.files[0].digest = 'f'.repeat(64);
    },
    (f: ReturnType<typeof producerFixture>) => {
      f.events.find((e) => e.completed).id.targetCompleted.configuration.id = 'missing';
    },
    (f: ReturnType<typeof producerFixture>) => {
      f.events.splice(-1, 0, structuredClone(f.events.find((e) => e.completed)));
    },
    (f: ReturnType<typeof producerFixture>) => {
      f.events
        .find((e) => e.structuredCommandLine)
        .structuredCommandLine.sections[0].optionList.option.pop();
    },
    (f: ReturnType<typeof producerFixture>) => {
      f.events.find(
        (e) => e.structuredCommandLine,
      ).structuredCommandLine.sections[0].optionList.option[0].optionValue = 'textproto';
    },
    (f: ReturnType<typeof producerFixture>) => {
      writeFileSync(path.join(f.executionRoot, f.manifest), f.contents.replace('1.0.0', '2.0.0'));
    },
    (f: ReturnType<typeof producerFixture>) => {
      f.manifestAction.configurationId = 1;
    },
    (f: ReturnType<typeof producerFixture>) => {
      f.manifestAction.targetId = 2;
    },
    (f: ReturnType<typeof producerFixture>) => {
      f.manifestAction.mnemonic = 'ForeignWrite';
    },
  ]) {
    const f = producerFixture();
    try {
      mutate(f);
      expect(f.capture).toThrow();
    } finally {
      f.cleanup();
    }
  }
});

test('packet validation independently rejects substituted root inventory and manifest contents', () => {
  const f = producerFixture();
  try {
    const captured = f.capture();
    for (const mutate of [
      (packet: any) => {
        packet.cohorts[0].roots[0].package.version = '9.0.0';
      },
      (packet: any) => {
        packet.cohorts[0].rootConfigurations[0].configuration = 'wrong';
      },
      (packet: any) => {
        packet.cohorts[0].producerCapture.shippingManifests[0].contents += ' ';
      },
      (packet: any) => {
        packet.cohorts[0].producerCapture.shippingManifests.push(
          packet.cohorts[0].producerCapture.shippingManifests[0],
        );
      },
      (packet: any) => {
        packet.cohorts[0].producerCapture.aqueryFile += '.other';
      },
    ]) {
      const packet = structuredClone(captured.evidence);
      mutate(packet);
      expect(() => validateNativeBuildEvidence(packet, f.options)).toThrow();
    }
  } finally {
    f.cleanup();
  }
});

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
