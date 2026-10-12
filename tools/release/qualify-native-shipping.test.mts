import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
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
import { fileURLToPath } from 'node:url';
import { validateNativeBuildEvidence } from './native-build-qualification.mts';
import {
  type NativeShippingRequest,
  nativeConfiguredRecipeGraph,
  nativeRecipeInputPaths,
  qualifyNativeShipping,
} from './qualify-native-shipping.mts';

const realCapture = fileURLToPath(new URL('./capture-native-build-evidence.mts', import.meta.url));
const withSource = fileURLToPath(new URL('./with-source.sh', import.meta.url));
const qualifiedReplay = fileURLToPath(new URL('./qualified-release-replay.sh', import.meta.url));

function recipeFixture() {
  const one = '1'.repeat(64),
    two = '2'.repeat(64),
    tool = '3'.repeat(64);
  const rule = (name: string, config: number, deps: [string, number][]) => ({
    configurationId: config,
    target: {
      rule: {
        name,
        configuredRuleInput: deps.map(([label, configurationId]) => ({
          label,
          ...(configurationId ? { configurationId } : {}),
        })),
      },
    },
  });
  const query = {
    configurations: [
      { id: 1, checksum: one },
      { id: 2, checksum: two },
      { id: 3, checksum: tool },
    ],
    results: [
      rule('//a:shipping', 1, [['//lib:adapter', 1]]),
      rule('//b:shipping', 2, [['//lib:adapter', 2]]),
      rule('//lib:adapter', 1, [
        ['//left:implementation', 1],
        ['//common:tool', 3],
      ]),
      rule('//lib:adapter', 2, [
        ['//right:implementation', 2],
        ['//common:tool', 3],
      ]),
      rule('//left:implementation', 1, []),
      rule('//right:implementation', 2, []),
      rule('//common:tool', 3, [['//common:header.h', 0]]),
      {
        configuration: { checksum: 'null' },
        target: { sourceFile: { name: '//common:header.h' } },
      },
      rule('//unrelated:qualification_only', 2, []),
    ],
  };
  const roots = [
    { label: '//a:shipping', configuration: one },
    { label: '//b:shipping', configuration: two },
  ];
  const files = ['a', 'b', 'lib', 'left', 'right', 'common', 'unrelated'].map((pkg) => ({
    package: `//${pkg}`,
    labels: [
      `//${pkg}:BUILD.bazel`,
      `//recipes:${pkg}.bzl`,
      '//recipes:shared.bzl',
      '@@external//:helper.bzl',
    ],
  }));
  return { query, roots, files };
}

function queriedRecipes(graph, files) {
  const sets = new Map<string, { packages: string[]; labels: string[] }>();
  for (const root of graph.roots) {
    sets.set(JSON.stringify(root.packages), {
      packages: root.packages,
      labels: root.packages.flatMap((pkg) =>
        files.filter((row) => row.package === pkg).flatMap((row) => row.labels),
      ),
    });
  }
  return [...sets.values()].map((row) => ({ ...row, labels: [...new Set(row.labels)] }));
}

test('one configured recipe graph preserves shared loads, disconnected targets and transitions', () => {
  const f = recipeFixture();
  const graph = nativeConfiguredRecipeGraph(f.query, f.roots);
  expect(graph.labels).not.toContain('//unrelated:qualification_only');
  expect(graph.packages).toEqual(
    ['a', 'b', 'common', 'left', 'lib', 'right'].map((pkg) => ({
      package: `//${pkg}`,
      label:
        pkg === 'a' || pkg === 'b'
          ? `//${pkg}:shipping`
          : pkg === 'common'
            ? '//common:header.h'
            : pkg === 'lib'
              ? '//lib:adapter'
              : `//${pkg}:implementation`,
    })),
  );
  const rows = nativeRecipeInputPaths(graph, queriedRecipes(graph, f.files));
  expect(rows[0].paths).toEqual([
    'a/BUILD.bazel',
    'common/BUILD.bazel',
    'left/BUILD.bazel',
    'lib/BUILD.bazel',
    'recipes/a.bzl',
    'recipes/common.bzl',
    'recipes/left.bzl',
    'recipes/lib.bzl',
    'recipes/shared.bzl',
  ]);
  expect(rows[1].paths).toEqual([
    'b/BUILD.bazel',
    'common/BUILD.bazel',
    'lib/BUILD.bazel',
    'recipes/b.bzl',
    'recipes/common.bzl',
    'recipes/lib.bzl',
    'recipes/right.bzl',
    'recipes/shared.bzl',
    'right/BUILD.bazel',
  ]);
});

test('generated Files follow their actual configured generating rule', () => {
  const f = recipeFixture();
  f.query.results[0].target.rule.configuredRuleInput = [
    { label: '//generated:header.h', configurationId: 1 },
  ];
  f.query.results.push({
    configurationId: 1,
    target: {
      generatedFile: { name: '//generated:header.h', generatingRule: '//left:implementation' },
    },
  } as any);
  const graph = nativeConfiguredRecipeGraph(f.query, f.roots.slice(0, 1));
  expect(graph.labels).toContain('//left:implementation');
  expect(graph.labels).not.toContain('//right:implementation');
});

test('missing, substituted and cyclic configured recipes or loads reject', () => {
  for (const mutate of [
    (f) => {
      f.roots[0].configuration = '4'.repeat(64);
    },
    (f) => {
      f.query.results[0].target.rule.configuredRuleInput[0].configurationId = 999;
    },
    (f) => {
      f.query.results[0].target.rule.configuredRuleInput[0].configurationChecksum = '4'.repeat(64);
    },
    (f) => {
      f.query.results[0].target.rule.configuredRuleInput[0].label = '//missing:rule';
    },
    (f) => {
      f.query.results[4].target.rule.configuredRuleInput = [
        { label: '//a:shipping', configurationId: 1 },
      ];
    },
    (f) => {
      f.query.results.push(f.query.results[0]);
    },
    (f) => {
      f.files = f.files.filter((row) => row.package !== '//common');
    },
    (f) => {
      const common = f.files.find((row) => row.package === '//common');
      if (!common) throw new Error('missing common fixture');
      common.labels = ['//recipes:shared.bzl'];
    },
    (f) => {
      f.files[0].labels.push('//recipes:../outside.bzl');
    },
    (f) => {
      f.files[0].labels.push('//a:BUILD');
    },
  ]) {
    const f = recipeFixture();
    mutate(f);
    expect(() =>
      nativeRecipeInputPaths(
        nativeConfiguredRecipeGraph(f.query, f.roots),
        queriedRecipes(nativeConfiguredRecipeGraph(f.query, f.roots), f.files),
      ),
    ).toThrow();
  }
});

test('external configured packages retain workspace loads and equal package sets share one result', () => {
  const f = recipeFixture();
  f.query.results[6].target.rule.configuredRuleInput.push({
    label: '@@original//native:library',
    configurationId: 3,
  });
  f.query.results.push({
    configurationId: 3,
    target: { rule: { name: '@@original//native:library', configuredRuleInput: [] } },
  } as any);
  f.files.push({
    package: '@@original//native',
    labels: ['@original//native:BUILD.bazel', '//private:original-runtime-contract.bzl'],
  });
  const graph = nativeConfiguredRecipeGraph(f.query, f.roots);
  const queries = queriedRecipes(graph, f.files);
  const result = nativeRecipeInputPaths(graph, queries);
  expect(result.every((row) => row.paths.includes('private/original-runtime-contract.bzl'))).toBe(
    true,
  );
  const same = nativeConfiguredRecipeGraph(f.query, [f.roots[0]]);
  same.roots.push({ ...same.roots[0], label: '//alias:shipping' });
  const shared = queriedRecipes(same, f.files);
  expect(shared).toHaveLength(1);
  expect(nativeRecipeInputPaths(same, shared)[1].paths).toEqual(
    nativeRecipeInputPaths(same, shared)[0].paths,
  );
  for (const value of [
    [],
    [...queries, queries[0]],
    [...queries, { packages: ['//injected'], labels: ['//injected:BUILD.bazel'] }],
    queries.map((row) => ({ ...row, labels: [...row.labels, row.labels[0]] })),
  ])
    expect(() => nativeRecipeInputPaths(graph, value)).toThrow();
});

function fixture(mode = 'success') {
  const directory = mkdtempSync(path.join(tmpdir(), 'qualify-native-shipping-'));
  const workspace = path.join(directory, 'workspace');
  const executionRoot = path.join(directory, 'execroot');
  const outputDirectory = path.join(directory, 'capture');
  const stateFile = path.join(directory, 'state.json');
  const callsFile = path.join(directory, 'calls.jsonl');
  for (const name of ['src', 'tools/dev', 'tools/release'])
    mkdirSync(path.join(workspace, name), { recursive: true });
  mkdirSync(path.join(executionRoot, 'bazel-out/k8-fastbuild/bin'), { recursive: true });
  writeFileSync(path.join(workspace, 'src/input.mts'), 'declared source');
  mkdirSync(path.join(workspace, 'fixture'));
  writeFileSync(path.join(workspace, 'fixture/BUILD.bazel'), 'declared shipping recipe');
  writeFileSync(path.join(workspace, 'fixture/macro1.bzl'), 'load(":macro2.bzl", "macro2")');
  writeFileSync(path.join(workspace, 'fixture/macro2.bzl'), 'def macro2(): pass');
  symlinkSync(path.join(workspace, 'src'), path.join(executionRoot, 'src'), 'dir');
  const output = 'bazel-out/k8-fastbuild/bin/native.tar.gz';
  const outputBytes = Buffer.from('final archive');
  writeFileSync(path.join(executionRoot, output), outputBytes);
  const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  writeFileSync(
    path.join(workspace, 'tools/dev/bun.sh'),
    `#!/usr/bin/env bash\nexec ${shellQuote(process.execPath)} "$@"\n`,
  );
  copyFileSync(withSource, path.join(workspace, 'tools/release/with-source.sh'));
  copyFileSync(qualifiedReplay, path.join(workspace, 'tools/release/qualified-release-replay.sh'));
  writeFileSync(
    path.join(workspace, 'tools/release/capture-native-build-evidence.mts'),
    `import {spawnSync} from 'node:child_process';\nimport {readFileSync,writeFileSync} from 'node:fs';\nconst state=JSON.parse(readFileSync(${JSON.stringify(stateFile)},'utf8'));\nif(state.mode==='capture-race') writeFileSync('src/input.mts','changed during capture');\nconst result=spawnSync(process.execPath,[${JSON.stringify(realCapture)},...process.argv.slice(2)],{stdio:'inherit'});\nif(state.mode==='capture-output-race' && result.status===0) writeFileSync(state.output,'changed after capture');\nprocess.exit(result.status??1);\n`,
  );
  writeFileSync(
    path.join(workspace, 'tools/dev/bazel.sh'),
    `#!/usr/bin/env bash\nexec ${shellQuote(process.execPath)} tools/dev/bazel-fixture.mts "$@"\n`,
  );
  writeFileSync(
    path.join(workspace, 'tools/dev/bazel-fixture.mts'),
    `import {appendFileSync,readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const state=JSON.parse(readFileSync(${JSON.stringify(stateFile)},'utf8'));
const invocation=process.argv.slice(2);
appendFileSync(${JSON.stringify(callsFile)},JSON.stringify(invocation)+'\\n');
const args=invocation.slice(invocation.findIndex((arg:string)=>['test','cquery','query','info'].includes(arg)));
const expression=args[1]?.startsWith('--query_file=')?readFileSync(args[1].slice(13),'utf8'):args[1];
if(args[0]==='test') {
  if(state.mode==='build-failure') process.exit(1);
  if(state.mode==='build-race') writeFileSync('src/input.mts','changed during build');
  if(state.mode==='head-race') {
    writeFileSync('src/input.mts','new committed source');
    execFileSync('git',['add','src/input.mts']);
    execFileSync('git',['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','changed source']);
  }
  const metadata=Object.fromEntries(args.filter((arg:string)=>arg.startsWith('--build_metadata=')).map((arg:string)=>{const value=arg.slice(17);const split=value.indexOf('=');return [value.slice(0,split),value.slice(split+1)];}));
  const aquery=args.find((arg:string)=>arg.startsWith('--experimental_aquery_dump_after_build_output_file=')).split('=').slice(1).join('=');
  if(state.mode!=='dump-missing') writeFileSync(aquery,JSON.stringify(state.aquery));
  if(state.mode==='manifest-tamper') writeFileSync(state.manifest,JSON.stringify({...state.root,package:{...state.root.package,version:'1.0.1'}})+'\\n');
  if(state.policy) {
    const policy={...state.policy,qualification:(state.qualification.results??[]).map((result:any)=>result.target.rule.name.replace(/^@@?\\/\\//,'//'))};
    const contents=JSON.stringify(policy)+'\\n';
    writeFileSync(state.policyFile,contents);
    const file=state.events.find((event:any)=>event.id?.namedSet?.id==='shipping-policy').namedSetOfFiles.files[0];
    file.digest=createHash('sha256').update(contents).digest('hex');file.length=String(Buffer.byteLength(contents));
  }
  const options=args.filter((arg:string)=>arg.startsWith('--')).map((arg:string)=>{const split=arg.indexOf('=');return {optionName:arg.slice(2,split<0?undefined:split),optionValue:split<0?'':arg.slice(split+1)};});
  const canonical={id:{structuredCommandLine:{commandLineLabel:'canonical'}},structuredCommandLine:{commandLineLabel:'canonical',sections:[{sectionLabel:'command options',optionList:{option:options}}]}};
  const events=[...state.events,...state.testEvents,canonical,{id:{buildMetadata:{}},buildMetadata:{metadata}},{id:{buildFinished:{}},finished:{exitCode:{name:'SUCCESS'}}},{id:{buildMetrics:{}},buildMetrics:{},lastMessage:true}];
  writeFileSync(args.find((arg:string)=>arg.startsWith('--build_event_json_file=')).slice(24),events.map((event:unknown)=>JSON.stringify(event)).join('\\n')+'\\n');
} else if(args[0]==='info') console.log(state.executionRoot);
else if(args[0]==='query') {
  if(state.mode==='analysis-failure' || state.mode==='deleted-load') process.exit(1);
  if(!expression.startsWith('buildfiles(set("//fixture:')) throw new Error('configured package label must be quoted');
  console.log('//fixture:BUILD.bazel');
  console.log('//fixture:macro1.bzl');
  console.log('//fixture:macro2.bzl');
  console.log('@@registry//:helper.bzl');
}
else {
  if(state.mode==='discovery-failure') process.exit(1);
  if(expression.startsWith('deps(')) {
    console.log(JSON.stringify(state.recipeGraph));
  } else if(expression.startsWith('set(')) {
    if(state.mode==='incompatible-policy') process.exit(1);
    console.log(JSON.stringify(state.qualification));
  } else console.log(JSON.stringify({roots:['@@//fixture:shipping'],qualification:(state.qualification.results??[]).map((result:any)=>result.target.rule.name)}));
}
`,
  );
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: workspace, encoding: 'utf8' }).trim();
  git('init', '--quiet');
  git('add', '.');
  git(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-qm',
    'fixture',
  );
  const configuration = 'c'.repeat(64);
  const root = {
    label: '//fixture:shipping',
    package: {
      product: 'fixture',
      version: '1.0.0',
      ecosystem: 'github',
      name: 'native.tar.gz',
      configuration: 'linux-x64-gnu',
      role: 'github-release-asset',
      outputs: [{ path: output, owner: '//fixture:package' }],
    },
  };
  const manifest = 'bazel-out/k8-fastbuild/bin/shipping.shipping.json';
  const manifestBytes = Buffer.from(`${JSON.stringify(root)}\n`);
  writeFileSync(path.join(executionRoot, manifest), manifestBytes);
  const policyFile = 'bazel-out/k8-fastbuild/bin/shipping_export.json';
  const policy = {
    schema: 'oliphaunt-bazel-shipping-v1',
    scope: 'construction',
    owner: '//fixture:shipping_export',
    roots: [root.label],
    packages: [root.package],
    qualification: ['//fixture:mandatory_test'],
  };
  const policyBytes = Buffer.from(`${JSON.stringify(policy)}\n`);
  writeFileSync(path.join(executionRoot, policyFile), policyBytes);
  const paths = ['src/input.mts', output, manifest, policyFile];
  const aquery = {
    pathFragments: paths.flatMap((file, index) =>
      file.split('/').map((name, part) => ({
        id: `${index}-${part}`,
        label: name,
        ...(part ? { parentId: `${index}-${part - 1}` } : {}),
      })),
    ),
    artifacts: paths.map((file, index) => ({
      id: index + 1,
      pathFragmentId: `${index}-${file.split('/').length - 1}`,
    })),
    targets: [
      { id: 1, label: '//fixture:package' },
      { id: 2, label: root.label },
      { id: 3, label: '//fixture:shipping_export' },
    ],
    configuration: [{ id: 1, checksum: configuration }],
    depSetOfFiles: [{ id: 1, directArtifactIds: [1] }],
    actions: [
      {
        targetId: 1,
        configurationId: 1,
        actionKey: 'declared-package',
        mnemonic: 'Package',
        inputDepSetIds: [1],
        outputIds: [2],
        primaryOutputId: 2,
      },
      {
        targetId: 2,
        configurationId: 1,
        actionKey: 'declared-shipping-manifest',
        mnemonic: 'FileWrite',
        outputIds: [3],
        primaryOutputId: 3,
      },
      {
        targetId: 3,
        configurationId: 1,
        actionKey: 'declared-owner-policy',
        mnemonic: 'FileWrite',
        outputIds: [4],
        primaryOutputId: 4,
      },
    ],
  };
  const events = [
    { id: { started: {} }, started: { uuid: 'fixture-build', buildToolVersion: '8.8.1' } },
    { id: { workspace: {} }, workspaceInfo: { localExecRoot: executionRoot } },
    { id: { configuration: { id: configuration } }, configuration: { mnemonic: 'fixture' } },
    {
      id: { namedSet: { id: 'outputs' } },
      namedSetOfFiles: {
        files: [
          {
            name: output,
            digest: createHash('sha256').update(outputBytes).digest('hex'),
            length: String(outputBytes.length),
          },
        ],
      },
    },
    {
      id: { namedSet: { id: 'shipping-manifest' } },
      namedSetOfFiles: {
        files: [
          {
            name: manifest,
            digest: createHash('sha256').update(manifestBytes).digest('hex'),
            length: String(manifestBytes.length),
          },
        ],
      },
    },
    {
      id: { targetCompleted: { label: root.label, configuration: { id: configuration } } },
      completed: {
        success: true,
        outputGroup: [
          { name: 'default', fileSets: [{ id: 'outputs' }] },
          { name: 'shipping_manifest', fileSets: [{ id: 'shipping-manifest' }] },
        ],
      },
    },
  ];
  events.push(
    {
      id: { namedSet: { id: 'shipping-policy' } },
      namedSetOfFiles: {
        files: [
          {
            name: policyFile,
            digest: createHash('sha256').update(policyBytes).digest('hex'),
            length: String(policyBytes.length),
          },
        ],
      },
    },
    {
      id: {
        targetCompleted: {
          label: '//fixture:shipping_export',
          configuration: { id: configuration },
        },
      },
      completed: {
        success: true,
        outputGroup: [{ name: 'shipping_policy', fileSets: [{ id: 'shipping-policy' }] }],
      },
    },
  );
  const identity = {
    label: '//fixture:mandatory_test',
    configuration: { id: configuration },
  };
  const testEvents = [
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
  const qualification = {
    configurations: [{ id: 1, checksum: configuration }],
    results: [
      {
        configurationId: 1,
        target: {
          rule: {
            name: '@@//fixture:mandatory_test',
            ruleClass: '_installed_test',
            attribute: [{ name: 'tags', stringListValue: ['manual'] }],
          },
        },
      },
    ],
  };
  writeFileSync(
    stateFile,
    JSON.stringify({
      mode,
      executionRoot,
      output: path.join(executionRoot, output),
      root,
      manifest: path.join(executionRoot, manifest),
      aquery,
      events,
      testEvents,
      qualification,
      recipeGraph: {
        configurations: [{ id: 1, checksum: configuration }],
        results: [
          {
            configurationId: 1,
            target: {
              rule: {
                name: root.label,
                configuredRuleInput: [{ label: '@@registry//:LICENSE (Apache)' }],
              },
            },
          },
          {
            configuration: { checksum: 'null' },
            target: { sourceFile: { name: '@@registry//:LICENSE (Apache)' } },
          },
        ],
      },
      policy,
      policyFile: path.join(executionRoot, policyFile),
    }),
  );
  const request: NativeShippingRequest = {
    github: {
      repository: 'f0rr0/oliphaunt',
      workflow: 'Native Bazel qualification',
      workflowPath: '.github/workflows/bazel.yml',
      runId: 123,
      runAttempt: 1,
      job: 'Linux runtime (x86_64)',
    },
    configuration: [
      '--config=wasix-aot',
      '--platforms=//fixture:platform',
      '--test_env=VALUE=two words',
      '--jobs=1',
    ],
    shipping: { roots: [root.label] },
    targets: ['//fixture:consumer'],
    outputDirectory,
  };
  return {
    workspace,
    request,
    outputDirectory,
    calls: () =>
      existsSync(callsFile)
        ? readFileSync(callsFile, 'utf8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line) as string[])
        : [],
    update: (change: (state: any) => void) => {
      const state = JSON.parse(readFileSync(stateFile, 'utf8'));
      change(state);
      writeFileSync(stateFile, JSON.stringify(state));
    },
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

for (const selection of ['explicit', 'export'])
  test(`qualifies ${selection} roots with one request and the real evidence collector`, () => {
    const f = fixture();
    try {
      if (selection === 'export') f.request.shipping = { export: '//fixture:shipping_export' };
      const output = qualifyNativeShipping(f.request, f.workspace);
      const evidence = JSON.parse(readFileSync(output, 'utf8'));
      expect(evidence.cohorts[0].roots[0].label).toBe('//fixture:shipping');
      expect(evidence.github).toEqual(f.request.github);
      const calls = f.calls();
      const builds = calls.filter((call) => call[0] === 'test');
      expect(builds).toHaveLength(1);
      expect(builds[0]).toContain('//fixture:shipping');
      expect(builds[0]).toContain('//fixture:consumer');
      expect(builds[0]).toContain('--output_groups=+shipping_manifest,+shipping_policy');
      expect(builds[0]).toContain('--experimental_aquery_dump_after_build_format=jsonproto');
      expect(builds[0]).toContain(
        `--experimental_aquery_dump_after_build_output_file=${path.join(f.outputDirectory, 'aquery.json')}`,
      );
      expect(calls.map((call) => call[0])).toEqual(
        selection === 'export'
          ? ['cquery', 'cquery', 'test', 'info', 'cquery', 'query']
          : ['test', 'info', 'cquery', 'query'],
      );
      expect(
        calls.filter((call) => call[0] === 'cquery' && call[1].startsWith('--query_file=')),
      ).toHaveLength(1);
      expect(calls.filter((call) => call[0] === 'query')).toHaveLength(1);
      for (const call of calls.filter((call) => call[0] !== 'query'))
        for (const flag of f.request.configuration) expect(call).toContain(flag);
      expect(calls.find((call) => call[0] === 'query')).not.toContain(
        '--platforms=//fixture:platform',
      );
      expect(evidence.cohorts[0].rootAnalysisInputPaths).toEqual([
        {
          label: '//fixture:shipping',
          paths: ['fixture/BUILD.bazel', 'fixture/macro1.bzl', 'fixture/macro2.bzl'],
        },
      ]);
      expect(evidence.cohorts[0].analysisInputs[0].members[0].sha256).toBe(
        createHash('sha256').update('declared shipping recipe').digest('hex'),
      );
      expect(existsSync(path.join(f.outputDirectory, 'build-events.jsonl'))).toBe(true);
      expect(existsSync(path.join(f.outputDirectory, 'cquery.json'))).toBe(false);
      expect(existsSync(path.join(f.outputDirectory, 'roots.jsonl'))).toBe(false);
      expect(existsSync(path.join(f.outputDirectory, 'aquery.json'))).toBe(true);
      expect(evidence.cohorts[0].producerCapture.aqueryFile).toBe(
        path.join(f.outputDirectory, 'aquery.json'),
      );
      const transferred = path.join(
        f.outputDirectory,
        'evidence/files/0',
        evidence.cohorts[0].outputs[0].path,
      );
      expect(readFileSync(transferred)).toEqual(Buffer.from('final archive'));
      expect(existsSync(path.join(f.outputDirectory, 'evidence/files/0/src/input.mts'))).toBe(
        false,
      );
    } finally {
      f.cleanup();
    }
  });

test('large configured graphs keep query expressions out of OS-limited argv', () => {
  const f = fixture();
  try {
    f.update((state) => {
      for (let i = 0; i < 1500; i++) {
        const name = `@@registry//:${i}-${'x'.repeat(100)}`;
        state.recipeGraph.results[0].target.rule.configuredRuleInput.push({ label: name });
        state.recipeGraph.results.push({ target: { sourceFile: { name } } });
      }
      const representative = `//fixture:a-${'x'.repeat(130 * 1024)}`;
      state.recipeGraph.results[0].target.rule.configuredRuleInput.push({ label: representative });
      state.recipeGraph.results.push({ target: { sourceFile: { name: representative } } });
    });
    qualifyNativeShipping(f.request, f.workspace);
    const query = readFileSync(path.join(f.outputDirectory, 'analysis-buildfiles-0.query'), 'utf8');
    expect(Buffer.byteLength(query)).toBeGreaterThan(128 * 1024);
    expect(query).toStartWith('buildfiles(set("//fixture:a-');
    expect(readFileSync(path.join(f.outputDirectory, 'analysis-deps.json')).length).toBeGreaterThan(
      128 * 1024,
    );
    const calls = f.calls();
    expect(calls.find((call) => call[0] === 'query')?.[1]).toBe(
      `--query_file=${path.join(f.outputDirectory, 'analysis-buildfiles-0.query')}`,
    );
    expect(calls.every((call) => call.every((arg) => Buffer.byteLength(arg) < 128 * 1024))).toBe(
      true,
    );
  } finally {
    f.cleanup();
  }
});

for (const targets of [[], undefined])
  test(`source-owned manual tests remain mandatory with ${targets ? 'empty' : 'omitted'} caller targets`, () => {
    const f = fixture();
    try {
      f.request.shipping = { export: '//fixture:shipping_export' };
      f.request.targets = targets;
      const output = qualifyNativeShipping(f.request, f.workspace);
      const evidence = JSON.parse(readFileSync(output, 'utf8'));
      const requiredTests = [{ label: '//fixture:mandatory_test', configuration: 'c'.repeat(64) }];
      const result = validateNativeBuildEvidence(evidence, {
        source: evidence.source,
        github: f.request.github,
        bazelVersion: '8.8.1',
        requiredTests,
        requireShippingAnalysis: true,
      });
      expect(result.testQualification).toBe('passed');
      expect(result.qualificationPolicy).toBe('bound');
      expect(result.requiredTests).toEqual([
        { ...requiredTests[0], invocationId: 'fixture-build' },
      ]);
      const calls = f.calls();
      expect(calls[1]).toContain('set(//fixture:mandatory_test)');
      expect(calls[1]).toContain('--universe_scope=//fixture:shipping_export');
      expect(calls[1]).toContain('--output=jsonproto');
      expect(calls.find((call) => call[0] === 'test')).toContain('//fixture:mandatory_test');
      expect(calls.find((call) => call[0] === 'test')).toContain('//fixture:shipping_export');
      const events = readFileSync(path.join(f.outputDirectory, 'build-events.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(events.find((event: any) => event.testResult)?.testResult.cachedLocally).toBe(true);
    } finally {
      f.cleanup();
    }
  });

test('the existing CLI accepts omitted additional targets and still runs owner policy', () => {
  const f = fixture();
  try {
    const input = path.dirname(f.outputDirectory);
    const github = path.join(input, 'github.json');
    const configuration = path.join(input, 'configuration.json');
    writeFileSync(github, JSON.stringify(f.request.github));
    writeFileSync(configuration, JSON.stringify(f.request.configuration));
    execFileSync(
      process.execPath,
      [
        fileURLToPath(new URL('./qualify-native-shipping.mts', import.meta.url)),
        '--github-json',
        github,
        '--configuration-json',
        configuration,
        '--shipping-export',
        '//fixture:shipping_export',
        '--output-directory',
        f.outputDirectory,
      ],
      { cwd: f.workspace, stdio: 'pipe' },
    );
    expect(f.calls().find((call) => call[0] === 'test')).toContain('//fixture:mandatory_test');
    expect(existsSync(path.join(f.outputDirectory, 'evidence/native-build-evidence.json'))).toBe(
      true,
    );
  } finally {
    f.cleanup();
  }
});

for (const failure of ['missing-summary', 'failed-result', 'configuration-mismatch'])
  test(`removes evidence when source-owned configured qualification has ${failure}`, () => {
    const f = fixture();
    try {
      f.request.shipping = { export: '//fixture:shipping_export' };
      f.request.targets = [];
      f.update((state) => {
        if (failure === 'missing-summary')
          state.testEvents = state.testEvents.filter((event: any) => !event.testSummary);
        else if (failure === 'failed-result')
          state.testEvents.find((event: any) => event.testResult).testResult.status = 'FAILED';
        else state.qualification.configurations[0].checksum = 'd'.repeat(64);
      });
      expect(() => qualifyNativeShipping(f.request, f.workspace)).toThrow(
        failure === 'configuration-mismatch'
          ? /mandatory configured test/
          : /with-source.sh failed/,
      );
      expect(existsSync(path.join(f.outputDirectory, 'evidence/native-build-evidence.json'))).toBe(
        false,
      );
      expect(existsSync(path.join(f.outputDirectory, 'evidence/files'))).toBe(false);
      expect(existsSync(path.join(f.outputDirectory, 'build-events.jsonl'))).toBe(true);
    } finally {
      f.cleanup();
    }
  });

for (const ruleClass of ['filegroup', 'test_suite'])
  test(`rejects ${ruleClass} policy nodes before construction`, () => {
    const f = fixture();
    try {
      f.request.shipping = { export: '//fixture:shipping_export' };
      f.update((state) => {
        state.qualification.results[0].target.rule.ruleClass = ruleClass;
      });
      expect(() => qualifyNativeShipping(f.request, f.workspace)).toThrow(
        'configured actual test rules',
      );
      expect(f.calls().map((call) => call[0])).toEqual(['cquery', 'cquery']);
    } finally {
      f.cleanup();
    }
  });

test('an incompatible declared mandatory test fails policy analysis before construction', () => {
  const f = fixture('incompatible-policy');
  try {
    f.request.shipping = { export: '//fixture:shipping_export' };
    expect(() => qualifyNativeShipping(f.request, f.workspace)).toThrow('failed');
    expect(f.calls().map((call) => call[0])).toEqual(['cquery', 'cquery']);
    expect(existsSync(path.join(f.outputDirectory, 'evidence/native-build-evidence.json'))).toBe(
      false,
    );
  } finally {
    f.cleanup();
  }
});

test('an explicitly empty owner policy retains construction-only compatibility', () => {
  const f = fixture();
  try {
    f.request.shipping = { export: '//fixture:shipping_export' };
    delete f.request.targets;
    f.update((state) => {
      state.qualification = {};
      state.testEvents = [];
    });
    const output = qualifyNativeShipping(f.request, f.workspace);
    const evidence = JSON.parse(readFileSync(output, 'utf8'));
    const result = validateNativeBuildEvidence(evidence, {
      source: evidence.source,
      github: f.request.github,
      bazelVersion: '8.8.1',
    });
    expect(result.testQualification).toBe('unverified');
    expect(result.releaseDecision).toBe('unverified');
    expect(f.calls().find((call) => call[0] === 'test')).not.toContain('//fixture:mandatory_test');
  } finally {
    f.cleanup();
  }
});

test('complete-family validation rejects bytes changed after successful evidence capture', () => {
  const f = fixture('capture-output-race');
  try {
    f.request.completeProducts = ['fixture'];
    expect(() => qualifyNativeShipping(f.request, f.workspace)).toThrow(
      'native complete-family output differs from build evidence',
    );
    expect(existsSync(path.join(f.outputDirectory, 'evidence/native-build-evidence.json'))).toBe(
      false,
    );
    expect(existsSync(path.join(f.outputDirectory, 'evidence/files'))).toBe(false);
    expect(f.calls().map((call) => call[0])).toEqual(['test', 'info', 'cquery', 'query']);
  } finally {
    f.cleanup();
  }
});

test('caller query substitution is rejected before any process even beyond OS argv limits', () => {
  const f = fixture();
  try {
    f.request.configuration.push(`--query_file=${'x'.repeat(130 * 1024)}`);
    expect(() => qualifyNativeShipping(f.request, f.workspace)).toThrow('cannot override');
    expect(f.calls()).toEqual([]);
    expect(existsSync(f.outputDirectory)).toBe(false);
  } finally {
    f.cleanup();
  }
});

test('rejects dirty source before any Bazel request', () => {
  const f = fixture();
  try {
    writeFileSync(path.join(f.workspace, 'src/input.mts'), 'dirty');
    expect(() => qualifyNativeShipping(f.request, f.workspace)).toThrow('clean checkout');
    expect(f.calls()).toEqual([]);
  } finally {
    f.cleanup();
  }
});

for (const flag of ['--assume-unchanged', '--skip-worktree'])
  test(`rejects ${flag} when git status hides a modified tracked input`, () => {
    const f = fixture();
    try {
      execFileSync('git', ['update-index', flag, 'src/input.mts'], { cwd: f.workspace });
      writeFileSync(path.join(f.workspace, 'src/input.mts'), 'hidden changed source');
      expect(
        execFileSync('git', ['status', '--porcelain'], { cwd: f.workspace, encoding: 'utf8' }),
      ).toBe('');
      expect(() => qualifyNativeShipping(f.request, f.workspace)).toThrow(
        'index suppression flags',
      );
      expect(f.calls()).toEqual([]);
    } finally {
      f.cleanup();
    }
  });

test('preserves startup argv before every command and configuration afterward', () => {
  const f = fixture();
  try {
    const startup = ['--output_base=/tmp/approved base', '--host_jvm_args=-Xmx2g'];
    f.request.startup = startup;
    f.request.shipping = { export: '//fixture:shipping_export' };
    qualifyNativeShipping(f.request, f.workspace);
    const calls = f.calls();
    expect(calls.filter((call) => call[2] === 'test')).toHaveLength(1);
    for (const call of calls) {
      expect(call.slice(0, 2)).toEqual(startup);
      expect(['test', 'cquery', 'query', 'info']).toContain(call[2]);
      if (call[2] !== 'query')
        for (const flag of f.request.configuration) expect(call.indexOf(flag)).toBeGreaterThan(2);
    }
  } finally {
    f.cleanup();
  }
});

for (const product of ['unknown-product', 'postgres-tools-wasix'])
  test(`removes its packet when canonical complete-family coverage fails for ${product}`, () => {
    const f = fixture();
    try {
      f.request.completeProducts = [product];
      expect(() => qualifyNativeShipping(f.request, f.workspace)).toThrow(
        product === 'unknown-product'
          ? 'unknown selected product'
          : 'incomplete native shipping coverage',
      );
      expect(f.calls().map((call) => call[0])).toEqual(['test', 'info', 'cquery', 'query']);
      expect(existsSync(path.join(f.outputDirectory, 'evidence/native-build-evidence.json'))).toBe(
        false,
      );
      expect(existsSync(path.join(f.outputDirectory, 'build-events.jsonl'))).toBe(true);
    } finally {
      f.cleanup();
    }
  });

for (const mode of [
  'build-race',
  'head-race',
  'build-failure',
  'discovery-failure',
  'analysis-failure',
  'deleted-load',
  'capture-race',
  'dump-missing',
  'manifest-tamper',
])
  test(`does not return evidence after ${mode}`, () => {
    const f = fixture(mode);
    try {
      if (mode === 'discovery-failure')
        f.request.shipping = { export: '//fixture:shipping_export' };
      expect(() => qualifyNativeShipping(f.request, f.workspace)).toThrow();
      expect(existsSync(path.join(f.outputDirectory, 'evidence/native-build-evidence.json'))).toBe(
        false,
      );
      if (mode.startsWith('build-') || mode === 'head-race')
        expect(f.calls().map((call) => call[0])).toEqual(['test']);
    } finally {
      f.cleanup();
    }
  });
