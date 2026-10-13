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
  captureSeedConstructionIntent,
  writeSeedConstructionReceipt,
} from '../../build_defs/resources/seed_construction.mts';
import { buildShippingInputView } from './bazel-shipping-inputs.mts';
import {
  captureNativeBuildEvidence,
  nativeRootConfigurations,
  writeNativeBuildEvidence,
} from './capture-native-build-evidence.mts';
import { readNativeBuildFinalFiles } from './native-build-files.mts';
import {
  nativeBuildMetadata,
  nativeShippingRootsHaveQualification,
  validateNativeBuildEvidence,
} from './native-build-qualification.mts';
import { projectNativePublicationConstruction } from './native-publication-observation.mts';

function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), 'native-build-capture-'));
  const executionRoot = path.join(directory, 'execroot');
  const workspace = path.join(directory, 'workspace');
  const external = path.join(directory, 'repositories');
  const source = 'src/main.mts';
  const tool = 'external/compiler/bin/compiler';
  const generated = 'bazel-out/k8-opt/bin/generated';
  const inputTree = 'external/compiler/share';
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
  mkdirSync(path.join(external, 'compiler/share/empty'), { recursive: true });
  writeFileSync(path.join(external, 'compiler/share/config.h'), '#define CONFIG 1\n');
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
  aquery.pathFragments.push(
    ...inputTree.split('/').map((label, part) => ({
      id: `tree-${part}`,
      label,
      ...(part ? { parentId: `tree-${part - 1}` } : {}),
    })),
  );
  aquery.artifacts.push({ id: 10, pathFragmentId: `tree-${inputTree.split('/').length - 1}` });
  aquery.depSetOfFiles[1].directArtifactIds.push(10);
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
    inputTree,
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

function ownerPolicyFixture() {
  const f = producerFixture();
  const owner = '//src:shipping_export';
  const policyFile = 'bazel-out/k8-opt/bin/src/shipping_export.json';
  const configuration = 'c'.repeat(64);
  const test = '//src:installed_test';
  const policy = {
    schema: 'oliphaunt-bazel-shipping-v1',
    scope: 'construction',
    owner,
    roots: ['//src:shipping'],
    packages: f.cohort.roots.map((root) => root.package),
    qualification: [test],
  };
  const contents = `${JSON.stringify(policy)}\n`;
  mkdirSync(path.dirname(path.join(f.executionRoot, policyFile)), { recursive: true });
  writeFileSync(path.join(f.executionRoot, policyFile), contents);
  const graph = f.options.cohorts[0].aquery;
  const parts = policyFile.split('/');
  graph.pathFragments.push(
    ...parts.map((label, part) => ({
      id: `policy-${part}`,
      label,
      ...(part ? { parentId: `policy-${part - 1}` } : {}),
    })),
  );
  graph.artifacts.push({ id: 6, pathFragmentId: `policy-${parts.length - 1}` });
  graph.targets.push({ id: 4, label: owner });
  const action = {
    targetId: 4,
    configurationId: 2,
    actionKey: 'owner-policy-definition',
    mnemonic: 'FileWrite',
    inputDepSetIds: [],
    outputIds: [6],
    primaryOutputId: 6,
  };
  graph.actions.push(action);
  const fileSet = {
    id: { namedSet: { id: 'policy' } },
    namedSetOfFiles: {
      files: [
        {
          name: policyFile,
          digest: createHash('sha256').update(contents).digest('hex'),
          length: String(Buffer.byteLength(contents)),
        },
      ],
    },
  };
  const ownerEvent = {
    id: { targetCompleted: { label: owner, configuration: { id: configuration } } },
    completed: {
      success: true,
      outputGroup: [{ name: 'shipping_policy', fileSets: [{ id: 'policy' }] }],
    },
  };
  const testIdentity = { label: test, configuration: { id: configuration } };
  f.events.splice(
    -1,
    0,
    fileSet,
    ownerEvent,
    { id: { targetCompleted: testIdentity }, completed: { success: true } },
    {
      id: { testResult: { ...testIdentity, run: 1, shard: 1, attempt: 1 } },
      testResult: { status: 'PASSED' },
    },
    {
      id: { testSummary: testIdentity },
      testSummary: { overallStatus: 'PASSED', totalRunCount: 1 },
    },
  );
  const options = { ...f.options, cohorts: [{ ...f.options.cohorts[0], shippingExport: owner }] };
  return {
    ...f,
    policy,
    policyFile,
    action,
    ownerEvent,
    fileSet,
    options,
    rewrite() {
      const contents = `${JSON.stringify(policy)}\n`;
      writeFileSync(path.join(f.executionRoot, policyFile), contents);
      Object.assign(fileSet.namedSetOfFiles.files[0], {
        digest: createHash('sha256').update(contents).digest('hex'),
        length: String(Buffer.byteLength(contents)),
      });
    },
  };
}

function installedObserverFixture(platform: 'android' | 'ios') {
  const f = ownerPolicyFixture();
  const graph = f.options.cohorts[0].aquery;
  const specification = 'bazel-out/k8-opt/bin/src/installed.inputs.json';
  const replayFiles =
    platform === 'android'
      ? {
          apk: 'bazel-out/k8-opt/bin/app/signed.apk',
          proof: 'bazel-out/k8-opt/bin/app/proof.json',
          sdk: 'bazel-out/k8-opt/bin/sdk/mobile.tgz',
        }
      : {
          application: 'bazel-out/k8-opt/bin/app/app.zip',
          sdk: 'bazel-out/k8-opt/bin/sdk/mobile.tgz',
        };
  const files = [specification, ...Object.values(replayFiles)];
  const ids = files.map((_file, index) => 100 + index);
  for (const [index, file] of files.entries()) {
    const parts = file.split('/');
    graph.pathFragments.push(
      ...parts.map((label, part) => ({
        id: `observer-${index}-${part}`,
        label,
        ...(part ? { parentId: `observer-${index}-${part - 1}` } : {}),
      })),
    );
    graph.artifacts.push({
      id: ids[index],
      pathFragmentId: `observer-${index}-${parts.length - 1}`,
    });
    mkdirSync(path.dirname(path.join(f.executionRoot, file)), { recursive: true });
    writeFileSync(
      path.join(f.executionRoot, file),
      index === 0
        ? JSON.stringify({
            replay: {
              schema: 'oliphaunt-installed-mobile-replay-v1',
              platform,
              files: replayFiles,
            },
          })
        : `actual installed observer bytes ${index}`,
    );
  }
  graph.targets.push({ id: 100, label: '//src:installed_test' });
  graph.depSetOfFiles.push({ id: 100, directArtifactIds: ids });
  const runfilesManifest = 'bazel-out/k8-opt/bin/src/installed.runfiles_manifest';
  const manifestParts = runfilesManifest.split('/');
  graph.pathFragments.push(
    ...manifestParts.map((label, part) => ({
      id: `runfiles-${part}`,
      label,
      ...(part ? { parentId: `runfiles-${part - 1}` } : {}),
    })),
  );
  graph.artifacts.push({ id: 110, pathFragmentId: `runfiles-${manifestParts.length - 1}` });
  graph.depSetOfFiles.push({ id: 101, directArtifactIds: [110] });
  const specificationAction = {
    targetId: 100,
    configurationId: 2,
    actionKey: 'installed-specification',
    mnemonic: 'FileWrite',
    inputDepSetIds: [],
    outputIds: [ids[0]],
    primaryOutputId: ids[0],
  };
  const runfilesAction = {
    targetId: 100,
    configurationId: 2,
    actionKey: 'installed-runfiles',
    mnemonic: 'Middleman',
    inputDepSetIds: [100],
    outputIds: [110],
    primaryOutputId: 110,
  };
  const testAction = {
    targetId: 100,
    configurationId: 2,
    actionKey: 'installed-test',
    mnemonic: 'TestRunner',
    inputDepSetIds: [101],
    outputIds: [],
  };
  graph.actions.push(specificationAction, runfilesAction, testAction);
  const target = f.events.find(
    (event) => event.id?.targetCompleted?.label === '//src:installed_test',
  );
  const fileSet = {
    id: { namedSet: { id: 'observer' } },
    namedSetOfFiles: {
      files: files.map((file) => {
        const bytes = readFileSync(path.join(f.executionRoot, file));
        return {
          name: file,
          digest: createHash('sha256').update(bytes).digest('hex'),
          length: String(bytes.length),
        };
      }),
    },
  };
  target.completed.outputGroup = [{ name: 'observation_inputs', fileSets: [{ id: 'observer' }] }];
  f.events.splice(-1, 0, fileSet);
  return {
    ...f,
    files,
    specification,
    specificationAction,
    runfilesAction,
    testAction,
    target,
    fileSet,
    capture: () => captureNativeBuildEvidence(f.options),
  };
}

for (const platform of ['android', 'ios'] as const) {
  test(`exact ${platform} configured installed inputs survive the existing internal transport`, () => {
    const f = installedObserverFixture(platform);
    try {
      const captured = f.capture();
      const records = captured.evidence.cohorts[0].qualificationInputs ?? [];
      expect(records).toHaveLength(1);
      expect(records[0].specification).toBe(f.specification);
      expect(records[0].inputs.map(({ path }) => path).sort()).toEqual([...f.files].sort());
      expect(captured.qualification.testQualification).toBe('passed');
      const publicConstruction = buildShippingInputView(
        {
          schema: 'oliphaunt-bazel-shipping-v1',
          scope: 'construction',
          packages: captured.evidence.cohorts[0].roots.map(({ package: pkg }) => pkg),
        },
        captured.evidence.cohorts[0].aquery,
      );
      const directory = path.join(f.directory, 'observer-packet');
      const evidenceFile = writeNativeBuildEvidence(captured, directory);
      const evidence = JSON.parse(readFileSync(evidenceFile, 'utf8'));
      const packet = readNativeBuildFinalFiles(directory, evidence, f.options);
      expect(
        JSON.parse(readFileSync(packet.file(0, f.specification), 'utf8')).replay.platform,
      ).toBe(platform);
      expect(packet.files).toHaveLength(f.files.length + 1);
      expect(packet.artifactRoots).toHaveLength(1);
      expect(packet.artifactRoots[0]).toBe(path.join(directory, 'files/0', f.output));
      expect(packet.qualificationInputs).toEqual([{ cohort: 0, ...records[0] }]);
      expect(packet.file(0, f.specification)).toBe(
        path.join(directory, 'files/0', f.specification),
      );
      expect(() => packet.file(1, f.specification)).toThrow(/requested declared File/);
      expect(() => packet.file(0, '../substitution')).toThrow(/requested declared File/);
      for (const file of f.files)
        expect(readFileSync(path.join(directory, 'files/0', file))).toEqual(
          readFileSync(path.join(f.executionRoot, file)),
        );
      evidence.cohorts[0].qualificationInputs[0].specification = 'substituted.json';
      expect(packet.qualificationInputs[0].specification).toBe(f.specification);
      const changed = structuredClone(captured.evidence);
      const observer = (changed.cohorts[0].qualificationInputs ?? [])[0].inputs.find(
        ({ path }) => path !== f.specification,
      );
      if (!observer) throw new Error('missing observer fixture');
      observer.members[0].sha256 = 'f'.repeat(64);
      expect(() => validateNativeBuildEvidence(changed, f.options)).toThrow(/observer digest/);
      // Qualifier-only observations must not change any conventional publication view.
      expect(
        Object.values(publicConstruction.products)
          .flatMap((product) => product.inputs)
          .some((file) => f.files.includes(file)),
      ).toBe(false);
      writeFileSync(
        path.join(directory, 'files/0', f.specification),
        'changed in downloaded packet',
      );
      if (!packet.assertUnchanged) throw new Error('missing observed packet');
      expect(packet.assertUnchanged).toThrow(/changed after capture/);
      expect(() => readNativeBuildFinalFiles(directory, captured.evidence, f.options)).toThrow(
        /transport bytes/,
      );
    } finally {
      f.cleanup();
    }
  });
}

test('installed observation records reject injected labels, wrong configuration and incomplete typed coverage', () => {
  const f = installedObserverFixture('android');
  try {
    const captured = f.capture();
    for (const mutation of [
      (cohort) => {
        delete cohort.qualificationInputs;
      },
      (cohort) => {
        cohort.qualificationInputs.push(structuredClone(cohort.qualificationInputs[0]));
      },
      (cohort) => {
        cohort.qualificationInputs[0].label = '//src:injected_test';
      },
      (cohort) => {
        cohort.qualificationInputs[0].configuration = 'd'.repeat(64);
      },
      (cohort) => {
        cohort.qualificationInputs[0].specification = f.files[1];
      },
      (cohort) => {
        cohort.qualificationInputs[0].inputs.pop();
      },
      (cohort) => {
        cohort.qualificationInputs[0].inputs.push(cohort.outputs[0]);
      },
      (cohort) => {
        cohort.qualificationInputs[0].unknown = true;
      },
      (cohort) => {
        cohort.qualificationInputs[0].inputs[0].members[0].size++;
      },
      (cohort) => {
        cohort.qualificationInputs[0].inputs[0].members[0].type = 'directory';
      },
    ]) {
      const changed = structuredClone(captured.evidence);
      mutation(changed.cohorts[0]);
      expect(() => validateNativeBuildEvidence(changed, f.options)).toThrow(/qualification/);
    }
    const wrongSource = { ...f.options, source: { ...f.options.source, tree: 'f'.repeat(40) } };
    expect(() => validateNativeBuildEvidence(captured.evidence, wrongSource)).toThrow(/source/);
  } finally {
    f.cleanup();
  }
});

for (const fault of [
  'unconsumed',
  'unrelated-helper',
  'compiler-only-substitute',
  'source-path-substitute',
  'foreign-test',
  'foreign-producer',
  'foreign-configuration',
  'duplicate-specification',
  'missing-specification',
  'duplicate-group',
  'too-many-files',
  'failed-test',
] as const) {
  test(`actual installed input collector rejects ${fault}`, () => {
    const f = installedObserverFixture('android');
    try {
      if (fault === 'unconsumed')
        f.options.cohorts[0].aquery.depSetOfFiles
          .find(({ id }) => id === 100)
          ?.directArtifactIds.pop();
      if (fault === 'unrelated-helper') f.testAction.inputDepSetIds = [];
      if (fault === 'compiler-only-substitute') {
        const graph = f.options.cohorts[0].aquery;
        const compilerInput = 'bazel-out/k8-opt/bin/app/compiler-input.h';
        const parts = compilerInput.split('/');
        graph.pathFragments.push(
          ...parts.map((label, part) => ({
            id: `compiler-${part}`,
            label,
            ...(part ? { parentId: `compiler-${part - 1}` } : {}),
          })),
        );
        graph.artifacts.push({ id: 120, pathFragmentId: `compiler-${parts.length - 1}` });
        mkdirSync(path.dirname(path.join(f.executionRoot, compilerInput)), { recursive: true });
        writeFileSync(path.join(f.executionRoot, compilerInput), 'compiler-only generated input');
        graph.depSetOfFiles.push({ id: 120, directArtifactIds: [120] });
        graph.actions.push({
          targetId: 2,
          configurationId: 2,
          actionKey: 'apk-definition',
          mnemonic: 'ApkPackage',
          inputDepSetIds: [120],
          outputIds: [101],
          primaryOutputId: 101,
        });
        const bytes = readFileSync(path.join(f.executionRoot, compilerInput));
        Object.assign(f.fileSet.namedSetOfFiles.files[1], {
          name: compilerInput,
          digest: createHash('sha256').update(bytes).digest('hex'),
          length: String(bytes.length),
        });
      }
      if (fault === 'source-path-substitute') {
        const bytes = readFileSync(path.join(f.executionRoot, f.source));
        Object.assign(f.fileSet.namedSetOfFiles.files[1], {
          name: f.source,
          digest: createHash('sha256').update(bytes).digest('hex'),
          length: String(bytes.length),
        });
      }
      if (fault === 'foreign-test') f.testAction.configurationId = 1;
      if (fault === 'foreign-producer') f.specificationAction.targetId = 4;
      if (fault === 'foreign-configuration') f.specificationAction.configurationId = 1;
      if (fault === 'duplicate-specification') f.specificationAction.outputIds.push(101);
      if (fault === 'missing-specification') f.specificationAction.mnemonic = 'TemplateExpand';
      if (fault === 'duplicate-group')
        f.target.completed.outputGroup.push(f.target.completed.outputGroup[0]);
      if (fault === 'too-many-files')
        f.fileSet.namedSetOfFiles.files.push({
          name: f.output,
          ...(() => {
            const bytes = readFileSync(path.join(f.executionRoot, f.output));
            return {
              digest: createHash('sha256').update(bytes).digest('hex'),
              length: String(bytes.length),
            };
          })(),
        });
      if (fault === 'failed-test')
        Object.assign(f.events.find((event) => event.testResult)?.testResult ?? {}, {
          status: 'FAILED',
        });
      expect(f.capture).toThrow(/qualification|observer|specification|successful test/);
    } finally {
      f.cleanup();
    }
  });
}

test('old diagnostic evidence cannot inject qualification replay inputs', () => {
  const f = fixture();
  try {
    const captured = f.capture();
    captured.evidence.cohorts[0].qualificationInputs = [
      {
        label: '//src:injected_test',
        configuration: 'c'.repeat(64),
        specification: f.output,
        inputs: captured.evidence.cohorts[0].outputs,
      },
    ];
    expect(() => validateNativeBuildEvidence(captured.evidence, f.options)).toThrow(
      /source-owned observer/,
    );
  } finally {
    f.cleanup();
  }
});

test('one BEP-bound owner export proves exact root coverage and mandatory configured tests', () => {
  const f = ownerPolicyFixture();
  try {
    const captured = captureNativeBuildEvidence(f.options);
    expect(captured.qualification.qualificationPolicy).toBe('bound');
    expect(captured.qualification.testQualification).toBe('passed');
    expect(captured.qualification.requiredTests).toEqual([
      {
        label: '//src:installed_test',
        configuration: 'c'.repeat(64),
        invocationId: 'fixture-invocation',
      },
    ]);
    expect(captured.qualification.cohorts[0].qualificationPolicy?.roots).toEqual([
      '//src:shipping',
    ]);
    expect(() =>
      validateNativeBuildEvidence(captured.evidence, {
        ...f.options,
        requiredTests: [{ label: '//src:unrelated_test', configuration: 'c'.repeat(64) }],
      }),
    ).toThrow(/omits source-owned mandatory configured test/);
    writeFileSync(path.join(f.executionRoot, f.policyFile), 'substituted after capture');
    expect(() => captured.assertUnchanged()).toThrow(/changed after capture/);
  } finally {
    f.cleanup();
  }
});

test('configuration trimming binds shipping roots separately from their owner and mandatory tests', () => {
  const f = ownerPolicyFixture();
  try {
    const configuration = 'd'.repeat(64);
    f.events.splice(-1, 0, {
      id: { configuration: { id: configuration } },
      configuration: { mnemonic: 'trimmed-package' },
    });
    f.events.find(
      (event) => event.id?.targetCompleted?.label === '//src:shipping',
    ).id.targetCompleted.configuration.id = configuration;
    f.options.cohorts[0].aquery.configuration.push({
      id: 3,
      checksum: configuration,
      isTool: false,
    });
    f.manifestAction.configurationId = 3;
    const captured = captureNativeBuildEvidence(f.options);
    expect(captured.qualification.qualificationPolicy).toBe('bound');
    expect(captured.qualification.cohorts[0].qualificationPolicy?.configuration).toBe(
      'c'.repeat(64),
    );
    expect(captured.qualification.cohorts[0].qualificationPolicy?.rootConfigurations).toEqual([
      { label: '//src:shipping', configuration },
    ]);
    expect(captured.qualification.requiredTests[0].configuration).toBe('c'.repeat(64));
  } finally {
    f.cleanup();
  }
});

test('composed source owners retain their own root qualification rather than sharing a test union', () => {
  const f = ownerPolicyFixture();
  try {
    Object.assign(f.policy, {
      policies: [
        {
          owner: '//src:original_owner',
          roots: f.policy.roots,
          qualification: f.policy.qualification,
        },
      ],
    });
    f.rewrite();
    const policy = captureNativeBuildEvidence(f.options).qualification.cohorts[0]
      .qualificationPolicy;
    expect(policy?.policies[0].owner).toBe('//src:original_owner');
    expect(nativeShippingRootsHaveQualification(policy, [{ label: '//src:shipping' }])).toBe(true);
    const separate = {
      ...policy!,
      roots: ['//src:shipping', '//src:empty'],
      policies: [
        ...policy!.policies,
        { owner: '//src:empty_owner', roots: ['//src:empty'], requiredTests: [] },
      ],
    };
    expect(nativeShippingRootsHaveQualification(separate, [{ label: '//src:shipping' }])).toBe(
      true,
    );
    expect(nativeShippingRootsHaveQualification(separate, [{ label: '//src:empty' }])).toBe(false);
    expect(
      nativeShippingRootsHaveQualification(separate, [
        { label: '//src:shipping' },
        { label: '//src:empty' },
      ]),
    ).toBe(false);
    f.policy.policies.push({
      owner: '//src:other_owner',
      roots: f.policy.roots,
      qualification: [],
    });
    f.rewrite();
    expect(() => captureNativeBuildEvidence(f.options)).toThrow(
      /source owner policy root coverage/,
    );
  } finally {
    f.cleanup();
  }
});

for (const scenario of [
  'digest',
  'missing-root',
  'extra-root',
  'wrong-package',
  'duplicate-test',
  'foreign-configuration',
  'failed-test',
  'missing-test',
  'different-action',
] as const)
  test(`source-owned owner policy rejects ${scenario}`, () => {
    const f = ownerPolicyFixture();
    try {
      if (scenario === 'digest') f.fileSet.namedSetOfFiles.files[0].digest = 'f'.repeat(64);
      else if (scenario === 'missing-root') f.policy.roots = [];
      else if (scenario === 'extra-root') f.policy.roots.push('//src:foreign');
      else if (scenario === 'wrong-package') f.policy.packages[0].version = '9.9.9';
      else if (scenario === 'duplicate-test') f.policy.qualification.push('//src:installed_test');
      else if (scenario === 'foreign-configuration')
        f.ownerEvent.id.targetCompleted.configuration.id = 'f'.repeat(64);
      else if (scenario === 'failed-test')
        f.events.find((event) => event.testResult).testResult.status = 'FAILED';
      else if (scenario === 'missing-test')
        f.events.splice(
          f.events.findIndex((event) => event.testSummary),
          1,
        );
      else f.action.mnemonic = 'Package';
      if (scenario !== 'digest') f.rewrite();
      expect(() => captureNativeBuildEvidence(f.options)).toThrow();
    } finally {
      f.cleanup();
    }
  });

test('an empty source-owned policy stays unverified and old packets gain no qualification', () => {
  const f = ownerPolicyFixture();
  const old = producerFixture();
  try {
    f.policy.qualification = [];
    f.rewrite();
    expect(captureNativeBuildEvidence(f.options).qualification.qualificationPolicy).toBe(
      'unverified',
    );
    expect(captureNativeBuildEvidence(old.options).qualification.qualificationPolicy).toBe(
      'unverified',
    );
  } finally {
    f.cleanup();
    old.cleanup();
  }
});

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
    command.sections.push(
      { sectionLabel: 'command', chunkList: { chunk: ['build'] } },
      { sectionLabel: 'residual', chunkList: { chunk: [secret] } },
      {
        sectionLabel: 'command options',
        optionList: { option: [{ optionName: 'output_file', optionValue: secret }] },
      },
    );
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

test('collector reads declared source/repository links and source trees after cache-backed success', () => {
  const f = fixture();
  try {
    const capture = f.capture();
    expect(capture.evidence.cohorts[0].rootConfigurations).toEqual([
      { label: '//src:shipping', configuration: 'c'.repeat(64) },
    ]);
    expect(capture.evidence.cohorts[0].inputs.map(({ path }) => path)).toEqual(
      [f.inputTree, f.tool, f.source].sort(),
    );
    const tree = capture.evidence.cohorts[0].inputs.find(({ path }) => path === f.inputTree)!;
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
      [f.inputTree, f.tool, f.source].sort(),
    );
    expect(capture.evidence.cohorts[0].aquery).toEqual(graph);
    expect(existsSync(path.join(f.executionRoot, virtual))).toBe(false);
    // A generated intermediate need not be materialized after a cache hit.
    connector.mnemonic = 'FileWrite';
    expect(f.capture().evidence.cohorts[0].aquery).toEqual(graph);
    connector.mnemonic = 'Middleman';
    rmSync(path.join(f.external, 'compiler/bin/compiler'));
    expect(f.capture).toThrow(/compiler\/bin\/compiler/);
  } finally {
    f.cleanup();
  }
});

test('missing required inputs and changed bytes, modes, links or source tree membership prevent publication of capture', () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) =>
      writeFileSync(path.join(f.workspace, f.source), 'changed source'),
    (f: ReturnType<typeof fixture>) =>
      chmodSync(path.join(f.external, 'compiler/bin/compiler'), 0o644),
    (f: ReturnType<typeof fixture>) =>
      writeFileSync(path.join(f.executionRoot, f.inputTree, 'extra'), 'extra'),
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
    rmSync(path.join(f.executionRoot, f.inputTree, 'config.h'));
    symlinkSync(
      path.join(f.workspace, f.source),
      path.join(f.executionRoot, f.inputTree, 'config.h'),
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

function seedCompanions(f: ReturnType<typeof fixture>) {
  const stem = 'bazel-out/k8-opt/bin/seed';
  const frozen = `${stem}.tar`;
  const receipt = `${stem}.seed-construction.json`;
  const graph = f.cohort.aquery;
  for (const [index, file] of [frozen, receipt].entries()) {
    const parts = file.split('/');
    graph.pathFragments.push(
      ...parts.map((label, part) => ({
        id: `seed-${index}-${part}`,
        label,
        ...(part ? { parentId: `seed-${index}-${part - 1}` } : {}),
      })),
    );
    graph.artifacts.push({ id: 11 + index, pathFragmentId: `seed-${index}-${parts.length - 1}` });
    graph.actions[0].outputIds.push(11 + index);
  }
  graph.actions[0].mnemonic = 'PostgresClusterSeed';
  writeFileSync(path.join(f.executionRoot, frozen), 'frozen PGDATA fixture');
  const pgdata = path.join(f.directory, 'pgdata');
  const contract = JSON.parse(
    readFileSync(
      new URL('../../src/database-resources/contracts/contract.json', import.meta.url),
      'utf8',
    ),
  );
  for (const name of contract.pgdataDirectories)
    mkdirSync(path.join(pgdata, name), { recursive: true });
  writeFileSync(path.join(pgdata, 'PG_VERSION'), '18\n');
  writeSeedConstructionReceipt(
    path.join(f.executionRoot, receipt),
    captureSeedConstructionIntent(
      { family: 'native', target: 'linux-x64-gnu', profile: 'standard' },
      { command: 'fixture-initdb' },
      { source: path.join(f.workspace, f.source) },
    ),
    path.join(f.executionRoot, frozen),
    pgdata,
  );
  return { frozen, receipt };
}

test('cached absent intermediates preserve the full action graph and required supplier Files still fail closed', () => {
  const f = fixture();
  try {
    rmSync(path.join(f.executionRoot, f.generated), { recursive: true });
    const capture = f.capture();
    expect(capture.evidence.cohorts[0].aquery).toEqual(f.cohort.aquery);
    expect(capture.qualification.cohorts[0].actionDefinitionsDigest).toMatch(/^sha256:/);
    expect(capture.evidence.cohorts[0].inputs.map((input) => input.path)).not.toContain(
      f.generated,
    );
    (f.cohort.roots[0].package as any).supplierInputs = [
      {
        product: 'supplier',
        version: '1.0.0',
        configuration: 'linux-x64',
        binding: 'abi-contract',
        origin: { kind: 'current-source' },
        files: [{ path: f.generated }],
      },
    ];
    expect(f.capture).toThrow(/ENOENT/);
  } finally {
    f.cleanup();
  }
});

test('reached constructor sibling receipt and frozen TAR are captured, observed and both mandatory', () => {
  const f = fixture();
  try {
    const { receipt, frozen } = seedCompanions(f);
    const captured = f.capture();
    const cohort = captured.evidence.cohorts[0];
    expect(cohort.seedConstructions!.map((row) => row.path)).toEqual([receipt]);
    expect(cohort.inputs.map((row) => row.path)).toContain(frozen);
    const output = cohort.outputs[0].members[0];
    if (output.type !== 'file') throw new Error('fixture output is a File');
    const artifact = {
      id: 'github:native.tar.gz',
      product: 'fixture',
      name: 'native.tar.gz',
      target: 'linux-x64-gnu',
      role: 'github-release-asset',
      kind: 'fixture',
      path: f.output,
      size: output.size,
      sha256: output.sha256,
    };
    const observation = projectNativePublicationConstruction(
      {
        envelope: {
          catalogSchema: 'oliphaunt-publication-catalog-v1',
          products: [{ id: 'fixture', version: '1.0.0' }],
          carriers: [],
          productArtifacts: [artifact],
        },
        files: [{ path: f.output, size: output.size, sha256: output.sha256 }],
      },
      [
        {
          evidence: captured.evidence,
          qualification: captured.qualification,
          origin: { evidenceDigest: 'sha256:' + 'a'.repeat(64) },
        } as any,
      ],
    );
    expect(observation.products[0].construction[0].inputs.map((row) => row.path)).toContain(frozen);
    expect(observation.products[0].construction[0].seedConstructions).toEqual(
      cohort.seedConstructions,
    );
    for (const file of [receipt, frozen]) {
      const missing = structuredClone(captured.evidence);
      missing.cohorts[0].inputs = missing.cohorts[0].inputs.filter((row) => row.path !== file);
      expect(() => validateNativeBuildEvidence(missing, f.options)).toThrow(
        'native input content coverage',
      );
      const actual = path.join(f.executionRoot, file);
      const contents = readFileSync(actual);
      rmSync(actual);
      expect(f.capture).toThrow(/ENOENT/);
      writeFileSync(actual, contents);
    }
    f.cohort.aquery.actions[0].outputIds = [3, 12];
    expect(f.capture).toThrow('same-action frozen TAR');
  } finally {
    f.cleanup();
  }
});

test('mobile domain capture retains both original host and domain constructor pairs', () => {
  const f = fixture();
  try {
    const host = seedCompanions(f);
    const frozen = 'bazel-out/k8-opt/bin/mobile-seed.tar';
    const receipt = 'bazel-out/k8-opt/bin/mobile-seed.seed-construction.json';
    const graph = f.cohort.aquery;
    for (const [index, file] of [frozen, receipt].entries()) {
      const parts = file.split('/');
      graph.pathFragments.push(
        ...parts.map((label, part) => ({
          id: `domain-${index}-${part}`,
          label,
          ...(part ? { parentId: `domain-${index}-${part - 1}` } : {}),
        })),
      );
      graph.artifacts.push({
        id: 13 + index,
        pathFragmentId: `domain-${index}-${parts.length - 1}`,
      });
    }
    graph.depSetOfFiles.push({ id: 3, directArtifactIds: [11, 12] });
    graph.actions.push({
      targetId: 1,
      configurationId: 1,
      actionKey: 'domain-construction',
      mnemonic: 'NativeSeedDomainAdmission',
      inputDepSetIds: [3],
      outputIds: [13, 14],
      primaryOutputId: 13,
    });
    graph.depSetOfFiles[1].directArtifactIds.push(13);
    writeFileSync(path.join(f.executionRoot, frozen), 'domain frozen PGDATA fixture');
    writeSeedConstructionReceipt(
      path.join(f.executionRoot, receipt),
      captureSeedConstructionIntent(
        { family: 'native', target: 'android-datum64', profile: 'standard' },
        { command: 'fixture-domain' },
        { host: path.join(f.executionRoot, host.frozen) },
      ),
      path.join(f.executionRoot, frozen),
      path.join(f.directory, 'pgdata'),
    );
    const captured = f.capture();
    expect(captured.evidence.cohorts[0].seedConstructions!.map((row) => row.path)).toEqual(
      [receipt, host.receipt].sort(),
    );
    for (const file of [host.frozen, host.receipt, frozen, receipt]) {
      expect(captured.evidence.cohorts[0].inputs.map((row) => row.path)).toContain(file);
      const bytes = readFileSync(path.join(f.executionRoot, file));
      rmSync(path.join(f.executionRoot, file));
      expect(f.capture).toThrow(/ENOENT/);
      writeFileSync(path.join(f.executionRoot, file), bytes);
    }
  } finally {
    f.cleanup();
  }
});
