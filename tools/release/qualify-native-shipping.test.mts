import { expect, spyOn, test } from 'bun:test';
import * as childProcess from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
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
import * as shippingInputs from './bazel-shipping-inputs.mts';
import {
  nativeAqueryExpression,
  validateNativeBuildEvidence,
} from './native-build-qualification.mts';
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
      const conflict = structuredClone(f.query.results[0]);
      conflict.target.rule.configuredRuleInput.push({
        label: '//right:implementation',
        configurationId: 2,
      });
      f.query.results.push(conflict);
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

test('repeated configured nodes preserve typed topology and loaded source closure', () => {
  const f = recipeFixture();
  const graph = nativeConfiguredRecipeGraph(f.query, f.roots);
  const paths = nativeRecipeInputPaths(graph, queriedRecipes(graph, f.files));
  for (const reverse of [false, true]) {
    const repeated = structuredClone(f.query);
    for (const row of structuredClone(repeated.results)) {
      const inputs = row.target.rule?.configuredRuleInput;
      if (inputs?.length) {
        inputs.reverse();
        inputs.push(inputs[0]);
      }
      repeated.results.push(row);
    }
    if (reverse) repeated.results.reverse();
    const actual = nativeConfiguredRecipeGraph(repeated, f.roots);
    expect(actual).toEqual(graph);
    expect(nativeRecipeInputPaths(actual, queriedRecipes(actual, f.files))).toEqual(paths);
  }
});

test('repeated generated files and package groups must retain their actual dependency definition', () => {
  const f = recipeFixture();
  f.query.results[0].target.rule.configuredRuleInput.push(
    { label: '//generated:header.h', configurationId: 1 },
    { label: '//visibility:group' },
  );
  f.query.results.push(
    {
      configurationId: 1,
      target: {
        generatedFile: { name: '//generated:header.h', generatingRule: '//left:implementation' },
      },
    } as any,
    {
      target: {
        packageGroup: { name: '//visibility:group', includedPackageGroup: ['//visibility:leaf'] },
      },
    } as any,
    { target: { packageGroup: { name: '//visibility:leaf', includedPackageGroup: [] } } } as any,
  );
  const graph = nativeConfiguredRecipeGraph(f.query, f.roots);
  const repeated = structuredClone(f.query);
  repeated.results.push(...structuredClone(f.query.results.slice(-3)));
  expect(nativeConfiguredRecipeGraph(repeated, f.roots)).toEqual(graph);
  for (const [index, mutate] of [
    [
      0,
      (row: any) => {
        row.target.rule.ruleClass = 'different_rule';
      },
    ],
    [
      7,
      (row: any) => {
        row.target = { rule: { name: '//common:header.h', configuredRuleInput: [] } };
      },
    ],
    [
      9,
      (row: any) => {
        row.target.generatedFile.generatingRule = '//right:implementation';
      },
    ],
    [
      10,
      (row: any) => {
        row.target.packageGroup.includedPackageGroup = [];
      },
    ],
  ] as const) {
    const conflict = structuredClone(f.query);
    const row = structuredClone(conflict.results[index]);
    mutate(row);
    conflict.results.push(row);
    expect(() => nativeConfiguredRecipeGraph(conflict, f.roots)).toThrow(
      'conflicting configured recipe target',
    );
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
  const executionRoot = path.join(directory, 'bazel/execroot/_main');
  const outputDirectory = path.join(directory, 'capture');
  const stateFile = path.join(directory, 'state.json');
  const callsFile = path.join(directory, 'calls.jsonl');
  const countsFile = path.join(directory, 'capture-counts.json');
  for (const name of ['src', 'tools/dev', 'tools/release'])
    mkdirSync(path.join(workspace, name), { recursive: true });
  mkdirSync(path.join(executionRoot, 'bazel-out/k8-fastbuild/bin'), { recursive: true });
  writeFileSync(path.join(workspace, 'src/input.mts'), 'declared source');
  writeFileSync(path.join(workspace, '.bazelversion'), '8.8.1\n');
  writeFileSync(
    path.join(workspace, 'MODULE.bazel.lock'),
    '{"lockFileVersion":28,"moduleExtensions":{}}',
  );
  writeFileSync(
    path.join(directory, 'bazel/MODULE.bazel.lock'),
    '{"lockFileVersion":28,"moduleExtensions":{}}',
  );
  mkdirSync(path.join(directory, 'bazel/external'));
  writeFileSync(path.join(directory, 'bazel/external/@registry.marker'), `${'a'.repeat(64)}\n`);
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
  if (mode === 'capture-count')
    writeFileSync(
      path.join(workspace, 'tools/release/capture-counter.mts'),
      `import {spyOn} from 'bun:test';
import {writeFileSync} from 'node:fs';
import * as graph from ${JSON.stringify(fileURLToPath(new URL('./bazel-shipping-inputs.mts', import.meta.url)))};
const views=spyOn(graph,'buildShippingInputView');
process.on('exit',()=>writeFileSync(${JSON.stringify(countsFile)},JSON.stringify({views:views.mock.calls.length})));
`,
    );
  writeFileSync(
    path.join(workspace, 'tools/release/capture-native-build-evidence.mts'),
    `import {spawnSync} from 'node:child_process';\nimport {readFileSync,writeFileSync} from 'node:fs';\nconst state=JSON.parse(readFileSync(${JSON.stringify(stateFile)},'utf8'));\nif(state.mode==='capture-race') writeFileSync('src/input.mts','changed during capture');\nconst preload=state.mode==='capture-count'?['--preload',${JSON.stringify(path.join(workspace, 'tools/release/capture-counter.mts'))}]:[];\nconst result=spawnSync(process.execPath,[...preload,${JSON.stringify(realCapture)},...process.argv.slice(2)],{stdio:'inherit'});\nif(state.mode==='capture-output-race' && result.status===0) writeFileSync(state.output,'changed after capture');\nprocess.exit(result.status??1);\n`,
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
const args=invocation.slice(invocation.findIndex((arg:string)=>['test','build','cquery','query','aquery','info'].includes(arg)));
const profile=args.find((arg:string)=>arg.startsWith('--profile='));
if(profile) writeFileSync(profile.slice(10),'fixture profile');
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
  if(state.mode==='raw-metadata-mismatch') metadata.fixture_observation='build-value';
  if(state.mode==='manifest-tamper') writeFileSync(state.manifest,JSON.stringify({...state.root,package:{...state.root.package,version:'1.0.1'}})+'\\n');
  if(state.policy) {
    const policy={...state.policy,qualification:(state.qualification.results??[]).map((result:any)=>result.target.rule.name.replace(/^@@?\\/\\//,'//'))};
    const contents=JSON.stringify(policy)+'\\n';
    writeFileSync(state.policyFile,contents);
    const file=state.events.find((event:any)=>event.id?.namedSet?.id==='shipping-policy').namedSetOfFiles.files[0];
    file.digest=createHash('sha256').update(contents).digest('hex');file.length=String(Buffer.byteLength(contents));
  }
  const options=args.filter((arg:string)=>arg.startsWith('--')).map((arg:string)=>{const split=arg.indexOf('=');return {optionName:arg.slice(2,split<0?undefined:split),optionValue:split<0?'':arg.slice(split+1)};});
  const canonical={id:{structuredCommandLine:{commandLineLabel:'canonical'}},structuredCommandLine:{commandLineLabel:'canonical',sections:[{sectionLabel:'command',chunkList:{chunk:['test']}},{sectionLabel:'command options',optionList:{option:options}},{sectionLabel:'residual',chunkList:{chunk:args.filter((arg:string)=>arg.startsWith('//'))}}]}};
  const events=[...state.events,...state.testEvents,canonical,{id:{buildMetadata:{}},buildMetadata:{metadata}},{id:{buildFinished:{}},finished:{exitCode:{name:'SUCCESS'}}},{id:{buildMetrics:{}},buildMetrics:{},lastMessage:true}];
  const bep=args.find((arg:string)=>arg.startsWith('--build_event_json_file='));
  if(bep) writeFileSync(bep.slice(24),events.map((event:unknown)=>JSON.stringify(event)).join('\\n')+'\\n');
} else if(args[0]==='aquery') {
  if(state.mode==='aquery-failure') process.exit(1);
  if(state.mode==='aquery-hang' || state.mode==='aquery-ignore-term') {
    if(state.mode==='aquery-ignore-term') process.on('SIGTERM',()=>{});
    writeFileSync(args.find((arg:string)=>arg.startsWith('--output_file=')).slice(14),'partial output');
    setInterval(()=>{},1000);
    await new Promise(()=>{});
  }
  if(state.mode==='aquery-race') writeFileSync('src/input.mts','changed during analysis');
  const metadata=Object.fromEntries(args.filter((arg:string)=>arg.startsWith('--build_metadata=')).map((arg:string)=>{const value=arg.slice(17);const split=value.indexOf('=');return [value.slice(0,split),value.slice(split+1)];}));
  if(state.mode==='raw-metadata-mismatch') metadata.fixture_observation='query-value';
  const options=args.filter((arg:string)=>arg.startsWith('--')).map((arg:string)=>{const split=arg.indexOf('=');const value=split<0?'':arg.slice(split+1);return {optionName:arg.slice(2,split<0?undefined:split),optionValue:value};});
  const canonical={id:{structuredCommandLine:{commandLineLabel:'canonical'}},structuredCommandLine:{commandLineLabel:'canonical',sections:[{sectionLabel:'command',chunkList:{chunk:['aquery']}},{sectionLabel:'command options',optionList:{option:[...options,{optionName:'client_env',optionValue:'PRIVATE=not-for-retention'}]}},{sectionLabel:'residual',chunkList:{chunk:[expression]}}]}};
  const prefix=structuredClone(state.events.filter((event:any)=>event.started||event.workspaceInfo||event.configuration));
  prefix.find((event:any)=>event.started).started.uuid='fixture-aquery';
  const events=[...prefix,canonical,{id:{progress:{}},progress:{stdout:'private-query-diagnostic'}},{id:{buildMetadata:{}},buildMetadata:{metadata}},{id:{buildFinished:{}},finished:{exitCode:{name:'SUCCESS'}}},{id:{buildMetrics:{}},buildMetrics:{},lastMessage:true}];
  writeFileSync(args.find((arg:string)=>arg.startsWith('--build_event_json_file=')).slice(24),events.map((event:unknown)=>JSON.stringify(event)).join('\\n')+'\\n');
  if(state.mode!=='dump-missing') writeFileSync(args.find((arg:string)=>arg.startsWith('--output_file=')).slice(14),JSON.stringify(state.aquery)+'\\n');
} else if(args[0]==='build') {
  if(args.at(-1)!=='--nobuild') throw new Error('failure diagnosis must not construct targets');
  if(state.mode==='incompatible-owner') {
    console.error('Target //fixture:shipping_export is incompatible because dependency //fixture:host_library is incompatible');
    process.exit(1);
  }
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
  if(!expression.startsWith('deps(') && !expression.startsWith('set(')) {
    if(state.mode==='incompatible-owner') process.exit(0);
    if(state.mode==='malformed-owner') { console.log('{invalid'); process.exit(0); }
  }
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
        id: index * 100 + part + 1,
        label: name,
        ...(part ? { parentId: index * 100 + part } : {}),
      })),
    ),
    artifacts: paths.map((file, index) => ({
      id: index + 1,
      pathFragmentId: index * 100 + file.split('/').length,
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
    countsFile,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

test('Mac capture CPU diagnostics preserve evidence, collector failures and source freeze', async () => {
  const platform = process.platform;
  const originalSpawn = childProcess.spawnSync;
  const captures: string[][] = [];
  const calls = spyOn(childProcess, 'spawnSync').mockImplementation(((
    command: string,
    args: string[],
    options: any,
  ) => {
    if (command === '/usr/bin/time') captures.push(args);
    return originalSpawn(command, args, options);
  }) as typeof childProcess.spawnSync);
  try {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    for (const mode of ['success', 'manifest-tamper', 'capture-race']) {
      const f = fixture(mode);
      try {
        if (mode === 'success') {
          const output = await qualifyNativeShipping(f.request, f.workspace);
          const evidence = JSON.parse(readFileSync(output, 'utf8'));
          expect(evidence.github).toEqual(f.request.github);
          expect(evidence.cohorts[0].roots[0].label).toBe('//fixture:shipping');
          expect(JSON.stringify(evidence)).not.toContain('--cpu-prof');
        } else {
          await expect(qualifyNativeShipping(f.request, f.workspace)).rejects.toThrow(
            mode === 'manifest-tamper' ? /failed/u : /clean checkout/u,
          );
          expect(
            existsSync(path.join(f.outputDirectory, 'evidence/native-build-evidence.json')),
          ).toBe(false);
        }
        const command = captures.at(-1);
        expect(command?.slice(0, 6)).toEqual([
          '-p',
          'bash',
          'tools/release/with-source.sh',
          'HEAD',
          'bash',
          'tools/dev/bun.sh',
        ]);
        expect(command?.slice(6, 11)).toEqual([
          '--cpu-prof',
          '--cpu-prof-interval=10000',
          `--cpu-prof-dir=${path.join(f.outputDirectory, 'diagnostics')}`,
          '--cpu-prof-name=capture.cpuprofile',
          'tools/release/capture-native-build-evidence.mts',
        ]);
        const profile = JSON.parse(
          readFileSync(path.join(f.outputDirectory, 'diagnostics/capture.cpuprofile'), 'utf8'),
        );
        expect(Object.keys(profile).sort()).toEqual([
          'endTime',
          'nodes',
          'samples',
          'startTime',
          'timeDeltas',
        ]);
        expect(
          f
            .calls()
            .flat()
            .some((argument) => argument.startsWith('--cpu-prof')),
        ).toBe(false);
      } finally {
        f.cleanup();
      }
    }
    expect(captures).toHaveLength(3);
  } finally {
    Object.defineProperty(process, 'platform', { value: platform });
    calls.mockRestore();
  }
});

for (const selection of ['explicit', 'export'])
  test(`qualifies ${selection} roots with one request and the real evidence collector`, async () => {
    const f = fixture();
    try {
      if (selection === 'export') f.request.shipping = { export: '//fixture:shipping_export' };
      const output = await qualifyNativeShipping(f.request, f.workspace);
      const evidence = JSON.parse(readFileSync(output, 'utf8'));
      expect(evidence.cohorts[0].roots[0].label).toBe('//fixture:shipping');
      expect(evidence.github).toEqual(f.request.github);
      const calls = f.calls();
      const builds = calls.filter((call) => call[0] === 'test');
      expect(builds).toHaveLength(1);
      expect(builds[0]).toContain(
        `--profile=${path.join(f.outputDirectory, 'diagnostics/build-profile.json.gz')}`,
      );
      expect(builds[0]).toContain('//fixture:shipping');
      expect(builds[0]).toContain('//fixture:consumer');
      expect(builds[0]).toContain(
        '--output_groups=+shipping_manifest,+shipping_policy,+observation_inputs',
      );
      expect(builds[0].some((flag) => flag.startsWith('--experimental_aquery_dump_'))).toBe(false);
      const queries = calls.filter((call) => call[0] === 'aquery');
      expect(queries).toHaveLength(1);
      expect(queries[0]).toContain(
        `--profile=${path.join(f.outputDirectory, 'diagnostics/aquery-profile.json.gz')}`,
      );
      expect(queries[0]).toContain('--include_pruned_inputs=true');
      expect(queries[0]).toContain('--include_artifacts=true');
      expect(queries[0]).toContain('--include_aspects=true');
      expect(queries[0]).toContain('--include_commandline=false');
      expect(queries[0]).toContain('--output=jsonproto');
      expect(queries[0]).toContain(`--output_file=${path.join(f.outputDirectory, 'aquery.json')}`);
      expect(queries[0][1]).toBe(
        nativeAqueryExpression(builds[0].filter((arg) => arg.startsWith('//'))),
      );
      expect(calls.map((call) => call[0])).toEqual(
        selection === 'export'
          ? ['cquery', 'cquery', 'test', 'aquery', 'info', 'cquery', 'query']
          : ['test', 'aquery', 'info', 'cquery', 'query'],
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

test('scoped action capture binds full requested scope, output, source and configured identity', async () => {
  const f = fixture();
  try {
    f.request.shipping = { export: '//fixture:shipping_export' };
    f.request.targets = ['//fixture:consumer', '//fixture:consumer', '//fixture:mandatory_test'];
    const output = await qualifyNativeShipping(f.request, f.workspace);
    const evidence = JSON.parse(readFileSync(output, 'utf8'));
    const build = f.calls().find((call) => call[0] === 'test');
    expect(JSON.stringify(evidence)).not.toContain('not-for-retention');
    expect(JSON.stringify(evidence)).not.toContain('private-query-diagnostic');
    expect(build?.filter((arg) => arg === '//fixture:consumer')).toHaveLength(1);
    expect(build?.filter((arg) => arg === '//fixture:mandatory_test')).toHaveLength(1);
    const queryEvents = (packet: any) => packet.cohorts[0].producerCapture.aqueryBuildEvents;
    const command = (packet: any) =>
      queryEvents(packet).find((event: any) => event.structuredCommandLine)?.structuredCommandLine;
    const option = (packet: any, name: string) =>
      command(packet)
        .sections.flatMap((section: any) => section.optionList?.option ?? [])
        .find((option: any) => option.optionName === name);
    const checks = {
      source: evidence.source,
      github: evidence.github,
      bazelVersion: '8.8.1',
      requireShippingAnalysis: true,
    };
    expect(validateNativeBuildEvidence(evidence, checks).shippingAnalysis).toBe('bound');
    expect(option(evidence, 'include_commandline').optionValue).toBe('false');
    expect(option(evidence, 'include_artifacts').optionValue).toBe('true');
    expect(option(evidence, 'include_pruned_inputs').optionValue).toBe('true');
    for (const mutate of [
      (packet: any) => {
        delete packet.cohorts[0].producerCapture.aqueryBuildEvents;
      },
      (packet: any) => {
        queryEvents(packet).at(-1).lastMessage = false;
      },
      (packet: any) => {
        queryEvents(packet).find((event: any) => event.started).started.uuid = 'fixture-build';
      },
      (packet: any) => {
        queryEvents(packet).find((event: any) => event.workspaceInfo).workspaceInfo.localExecRoot +=
          '-other';
      },
      (packet: any) => {
        queryEvents(packet).find(
          (event: any) => event.buildMetadata,
        ).buildMetadata.metadata.oliphaunt_source_commit = 'd'.repeat(40);
      },
      (packet: any) => {
        queryEvents(packet).find(
          (event: any) => event.buildMetadata,
        ).buildMetadata.metadata.oliphaunt_run_attempt = '99';
      },
      (packet: any) => {
        queryEvents(packet).find((event: any) => event.id?.configuration).id.configuration.id =
          'd'.repeat(64);
      },
      (packet: any) => {
        command(packet).sections.find(
          (section: any) => section.sectionLabel === 'command',
        ).chunkList.chunk = ['build'];
      },
      (packet: any) => {
        command(packet).sections.find(
          (section: any) => section.sectionLabel === 'residual',
        ).chunkList.chunk = [nativeAqueryExpression(['//fixture:shipping'])];
      },
      (packet: any) => {
        option(packet, 'output_file').optionValue += '.other';
      },
      (packet: any) => {
        option(packet, 'include_pruned_inputs').optionValue = 'false';
      },
      (packet: any) => {
        option(packet, 'include_commandline').optionValue = 'true';
      },
      (packet: any) => {
        option(packet, 'include_artifacts').optionValue = 'false';
      },
      (packet: any) => {
        option(packet, 'include_aspects').optionValue = 'false';
      },
    ]) {
      const tampered = structuredClone(evidence);
      mutate(tampered);
      expect(() => validateNativeBuildEvidence(tampered, checks)).toThrow();
    }
  } finally {
    f.cleanup();
  }
});

test('ordinary shipping checks run once and keep existing policy discovery without publication export', async () => {
  for (const owner of [false, true]) {
    const f = fixture();
    try {
      if (owner) f.request.shipping = { export: '//fixture:shipping_export' };
      f.request.ci = {
        id: 'portable/linux/napi',
        job: 'portable/linux',
        mode: 'source',
        requires: [],
      };
      const output = await qualifyNativeShipping(f.request, f.workspace);
      const receipt = JSON.parse(readFileSync(output, 'utf8'));
      expect(receipt.mode).toBe('source');
      expect(receipt.projection).toBeUndefined();
      expect(f.calls().map((call) => call[0])).toEqual(owner ? ['cquery', 'test'] : ['test']);
      expect(f.calls().find((call) => call[0] === 'test')).toContain('//fixture:consumer');
      if (owner)
        expect(f.calls().find((call) => call[0] === 'test')).toContain('//fixture:mandatory_test');
      expect(existsSync(path.join(f.outputDirectory, 'aquery.json'))).toBe(false);
      expect(existsSync(path.join(f.outputDirectory, 'evidence'))).toBe(false);
      expect(
        f
          .calls()
          .find((call) => call[0] === 'test')!
          .some((flag) => flag.startsWith('--output_groups=')),
      ).toBe(false);
    } finally {
      f.cleanup();
    }
  }
});

test('source requests preserve physical handoff capture and never receipt a failed producer', async () => {
  for (const failed of [false, true]) {
    const f = fixture(failed ? 'build-failure' : 'success');
    try {
      f.request.ci = {
        id: 'wasix/producer',
        job: 'wasix',
        mode: 'source',
        requires: [],
        handoff: true,
      };
      if (failed) {
        await expect(qualifyNativeShipping(f.request, f.workspace)).rejects.toThrow();
        expect(existsSync(path.join(f.outputDirectory, 'ci-request.json'))).toBe(false);
      } else {
        const output = await qualifyNativeShipping(f.request, f.workspace);
        expect(JSON.parse(readFileSync(output, 'utf8')).schema).toBe(
          'oliphaunt-native-build-evidence-v1',
        );
        expect(
          JSON.parse(readFileSync(path.join(f.outputDirectory, 'ci-request.json'), 'utf8')).mode,
        ).toBe('source');
        expect(f.calls().map((call) => call[0])).toEqual([
          'test',
          'aquery',
          'info',
          'cquery',
          'query',
        ]);
      }
    } finally {
      f.cleanup();
    }
  }
});

test('ordinary source receipt guard rejects a tracked source mutation during the producer', async () => {
  const f = fixture('build-race');
  try {
    f.request.ci = {
      id: 'portable/linux/napi',
      job: 'portable/linux',
      mode: 'source',
      requires: [],
    };
    await expect(qualifyNativeShipping(f.request, f.workspace)).rejects.toThrow();
    expect(f.calls().map((call) => call[0])).toEqual(['test']);
    expect(existsSync(path.join(f.outputDirectory, 'ci-request.json'))).toBe(false);
  } finally {
    f.cleanup();
  }
});

test('large configured graphs keep query expressions out of OS-limited argv', async () => {
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
    await qualifyNativeShipping(f.request, f.workspace);
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
  test(`source-owned manual tests remain mandatory with ${targets ? 'empty' : 'omitted'} caller targets`, async () => {
    const f = fixture();
    try {
      f.request.shipping = { export: '//fixture:shipping_export' };
      f.request.targets = targets;
      const output = await qualifyNativeShipping(f.request, f.workspace);
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

test('one exact serialized qualification replaces the raw and parent replay without trusting a cached view', async () => {
  const f = fixture('capture-count');
  const parentViews = spyOn(shippingInputs, 'buildShippingInputView');
  try {
    f.request.shipping = { export: '//fixture:shipping_export' };
    f.request.targets = [];
    const output = await qualifyNativeShipping(f.request, f.workspace);
    const evidence = JSON.parse(readFileSync(output, 'utf8'));
    expect(JSON.parse(readFileSync(f.countsFile, 'utf8')).views).toBe(2);
    expect(parentViews.mock.calls).toHaveLength(0);
    expect(
      JSON.parse(readFileSync(path.join(f.outputDirectory, 'expected-qualification.json'), 'utf8')),
    ).toEqual({
      source: evidence.source,
      github: f.request.github,
      bazelVersion: '8.8.1',
      requiredTests: [{ label: '//fixture:mandatory_test', configuration: 'c'.repeat(64) }],
      requireShippingAnalysis: true,
    });
    expect(
      evidence.cohorts[0].buildEvents.find((event: any) => event.testSummary).testSummary
        .overallStatus,
    ).toBe('PASSED');
    expect(
      readFileSync(
        path.join(f.outputDirectory, 'evidence/files/0', evidence.cohorts[0].outputs[0].path),
      ),
    ).toEqual(Buffer.from('final archive'));
  } finally {
    parentViews.mockRestore();
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

for (const failure of [
  'missing-summary',
  'failed-result',
  'configuration-mismatch',
  'raw-metadata-mismatch',
])
  test(`removes evidence when source-owned configured qualification has ${failure}`, async () => {
    const f = fixture();
    try {
      f.request.shipping = { export: '//fixture:shipping_export' };
      f.request.targets = [];
      f.update((state) => {
        if (failure === 'missing-summary')
          state.testEvents = state.testEvents.filter((event: any) => !event.testSummary);
        else if (failure === 'failed-result')
          state.testEvents.find((event: any) => event.testResult).testResult.status = 'FAILED';
        else if (failure === 'configuration-mismatch')
          state.qualification.configurations[0].checksum = 'd'.repeat(64);
        else state.mode = failure;
      });
      await expect(qualifyNativeShipping(f.request, f.workspace)).rejects.toThrow(
        /with-source.sh failed/,
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
  test(`rejects ${ruleClass} policy nodes before construction`, async () => {
    const f = fixture();
    try {
      f.request.shipping = { export: '//fixture:shipping_export' };
      f.update((state) => {
        state.qualification.results[0].target.rule.ruleClass = ruleClass;
      });
      await expect(qualifyNativeShipping(f.request, f.workspace)).rejects.toThrow(
        'configured actual test rules',
      );
      expect(f.calls().map((call) => call[0])).toEqual(['cquery', 'cquery']);
    } finally {
      f.cleanup();
    }
  });

for (const mode of ['incompatible-owner', 'malformed-owner'])
  test(`diagnoses ${mode} configured export output without construction`, async () => {
    const f = fixture(mode);
    try {
      f.request.shipping = { export: '//fixture:shipping_export' };
      await expect(qualifyNativeShipping(f.request, f.workspace)).rejects.toThrow(
        mode === 'incompatible-owner'
          ? 'Bazel configuration analysis failed'
          : 'readable configured export provider',
      );
      const calls = f.calls();
      expect(calls.map((call) => call[0])).toEqual(['cquery', 'build']);
      expect(calls[1].at(-1)).toBe('--nobuild');
      expect(calls[1]).toContain('//fixture:shipping_export');
      expect(calls[1].slice(2, -1)).toEqual(f.request.configuration ?? []);
      expect(existsSync(path.join(f.outputDirectory, 'build-events.jsonl'))).toBe(false);
      expect(existsSync(path.join(f.outputDirectory, 'evidence'))).toBe(false);
    } finally {
      f.cleanup();
    }
  });

test('an incompatible declared mandatory test fails policy analysis before construction', async () => {
  const f = fixture('incompatible-policy');
  try {
    f.request.shipping = { export: '//fixture:shipping_export' };
    await expect(qualifyNativeShipping(f.request, f.workspace)).rejects.toThrow('failed');
    expect(f.calls().map((call) => call[0])).toEqual(['cquery', 'cquery']);
    expect(existsSync(path.join(f.outputDirectory, 'evidence/native-build-evidence.json'))).toBe(
      false,
    );
  } finally {
    f.cleanup();
  }
});

test('an explicitly empty owner policy retains construction-only compatibility', async () => {
  const f = fixture();
  try {
    f.request.shipping = { export: '//fixture:shipping_export' };
    delete f.request.targets;
    f.update((state) => {
      state.qualification = {};
      state.testEvents = [];
    });
    const output = await qualifyNativeShipping(f.request, f.workspace);
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

test('complete-family validation rejects bytes changed after successful evidence capture', async () => {
  const f = fixture('capture-output-race');
  try {
    f.request.completeProducts = ['fixture'];
    await expect(qualifyNativeShipping(f.request, f.workspace)).rejects.toThrow(
      'native complete-family output differs from build evidence',
    );
    expect(existsSync(path.join(f.outputDirectory, 'evidence/native-build-evidence.json'))).toBe(
      false,
    );
    expect(existsSync(path.join(f.outputDirectory, 'evidence/files'))).toBe(false);
    expect(f.calls().map((call) => call[0])).toEqual(['test', 'aquery', 'info', 'cquery', 'query']);
  } finally {
    f.cleanup();
  }
});

test('caller query substitution is rejected before any process even beyond OS argv limits', async () => {
  const f = fixture();
  try {
    f.request.configuration.push(`--query_file=${'x'.repeat(130 * 1024)}`);
    await expect(qualifyNativeShipping(f.request, f.workspace)).rejects.toThrow('cannot override');
    expect(f.calls()).toEqual([]);
    expect(existsSync(f.outputDirectory)).toBe(false);
    f.request.configuration.pop();
    f.request.configuration.push('--output_file=/tmp/substituted-query.json');
    await expect(qualifyNativeShipping(f.request, f.workspace)).rejects.toThrow('cannot override');
    expect(f.calls()).toEqual([]);
  } finally {
    f.cleanup();
  }
});

test('rejects dirty source before any Bazel request', async () => {
  const f = fixture();
  try {
    writeFileSync(path.join(f.workspace, 'src/input.mts'), 'dirty');
    await expect(qualifyNativeShipping(f.request, f.workspace)).rejects.toThrow('clean checkout');
    expect(f.calls()).toEqual([]);
  } finally {
    f.cleanup();
  }
});

for (const flag of ['--assume-unchanged', '--skip-worktree'])
  test(`rejects ${flag} when git status hides a modified tracked input`, async () => {
    const f = fixture();
    try {
      execFileSync('git', ['update-index', flag, 'src/input.mts'], { cwd: f.workspace });
      writeFileSync(path.join(f.workspace, 'src/input.mts'), 'hidden changed source');
      expect(
        execFileSync('git', ['status', '--porcelain'], { cwd: f.workspace, encoding: 'utf8' }),
      ).toBe('');
      await expect(qualifyNativeShipping(f.request, f.workspace)).rejects.toThrow(
        'index suppression flags',
      );
      expect(f.calls()).toEqual([]);
    } finally {
      f.cleanup();
    }
  });

test('preserves startup argv before every command and configuration afterward', async () => {
  const f = fixture();
  try {
    const startup = ['--output_base=/tmp/approved base', '--host_jvm_args=-Xmx2g'];
    f.request.startup = startup;
    f.request.shipping = { export: '//fixture:shipping_export' };
    await qualifyNativeShipping(f.request, f.workspace);
    const calls = f.calls();
    expect(calls.filter((call) => call[2] === 'test')).toHaveLength(1);
    for (const call of calls) {
      expect(call.slice(0, 2)).toEqual(startup);
      expect(['test', 'aquery', 'cquery', 'query', 'info']).toContain(call[2]);
      if (call[2] !== 'query')
        for (const flag of f.request.configuration) expect(call.indexOf(flag)).toBeGreaterThan(2);
    }
  } finally {
    f.cleanup();
  }
});

for (const product of ['unknown-product', 'postgres-tools-wasix'])
  test(`removes its packet when canonical complete-family coverage fails for ${product}`, async () => {
    const f = fixture();
    try {
      f.request.completeProducts = [product];
      await expect(qualifyNativeShipping(f.request, f.workspace)).rejects.toThrow(
        product === 'unknown-product'
          ? 'unknown selected product'
          : 'incomplete native shipping coverage',
      );
      expect(f.calls().map((call) => call[0])).toEqual([
        'test',
        'aquery',
        'info',
        'cquery',
        'query',
      ]);
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
  'aquery-failure',
  'aquery-race',
  'manifest-tamper',
])
  test(`does not return evidence after ${mode}`, async () => {
    const f = fixture(mode);
    try {
      if (mode === 'discovery-failure')
        f.request.shipping = { export: '//fixture:shipping_export' };
      await expect(qualifyNativeShipping(f.request, f.workspace)).rejects.toThrow();
      expect(existsSync(path.join(f.outputDirectory, 'evidence/native-build-evidence.json'))).toBe(
        false,
      );
      if (mode.startsWith('build-') || mode === 'head-race')
        expect(f.calls().map((call) => call[0])).toEqual(['test']);
    } finally {
      f.cleanup();
    }
  });

for (const mode of ['aquery-hang', 'aquery-ignore-term'])
  test(`a stalled query (${mode}) is terminated without retry or downstream capture`, async () => {
    const f = fixture(mode);
    const base = path.join(path.dirname(f.outputDirectory), 'bazel-base');
    const server = path.join(base, 'server');
    mkdirSync(server, { recursive: true });
    writeFileSync(path.join(server, 'server.pid.txt'), String(process.pid));
    const log = path.join(server, 'jvm.out');
    writeFileSync(log, 'historical action diagnostic must stay private\n');
    f.request.startup = [`--output_base=${base}`];
    const execute = childProcess.execFileSync;
    const commands = spyOn(childProcess, 'execFileSync').mockImplementation(((
      command: string,
      args: string[],
      options: any,
    ) =>
      command === 'ps' && args[0] === '-p'
        ? 'java\n'
        : execute(command, args, options)) as typeof execFileSync);
    const start = childProcess.spawn;
    const terminated: string[] = [];
    const children = spyOn(childProcess, 'spawn').mockImplementation(((...args: any[]) => {
      const child = start(...(args as Parameters<typeof childProcess.spawn>));
      const kill = child.kill;
      spyOn(child, 'kill').mockImplementation((kind) => {
        terminated.push(String(kind));
        return kill.call(child, kind);
      });
      return child;
    }) as typeof childProcess.spawn);
    const signal = process.kill;
    const signals = spyOn(process, 'kill').mockImplementation((pid, kind) => {
      if (pid === process.pid && kind === 'SIGQUIT') {
        appendFileSync(log, 'new JVM thread snapshot\n');
        return true;
      }
      return signal(pid, kind);
    });
    const schedule = globalThis.setTimeout;
    const deadlines: number[] = [];
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const cleared = spyOn(globalThis, 'clearTimeout');
    const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((
      callback: (...args: any[]) => void,
      delay?: number,
      ...args: any[]
    ) => {
      deadlines.push(delay ?? 0);
      const scheduled = schedule(
        callback,
        delay === 300000 ? 500 : delay === 2000 ? 0 : delay === 5000 ? 100 : delay,
        ...args,
      );
      if (delay === 5000) escalation = scheduled;
      return scheduled;
    }) as typeof setTimeout);
    try {
      await expect(qualifyNativeShipping(f.request, f.workspace)).rejects.toThrow(
        'five-minute limit',
      );
      expect(deadlines).toEqual([300000, 2000, 5000]);
      expect(cleared).toHaveBeenCalledWith(escalation);
      expect(terminated).toEqual(
        mode === 'aquery-ignore-term' ? ['SIGTERM', 'SIGKILL'] : ['SIGTERM'],
      );
      expect(f.calls().map((call) => call[1])).toEqual(['test', 'aquery']);
      expect(signals).toHaveBeenCalledWith(process.pid, 'SIGQUIT');
      expect(readFileSync(path.join(f.outputDirectory, 'diagnostics/aquery-jvm.log'), 'utf8')).toBe(
        'new JVM thread snapshot\n',
      );
      expect(readFileSync(path.join(f.outputDirectory, 'aquery.json'), 'utf8')).toBe(
        'partial output',
      );
      expect(existsSync(path.join(f.outputDirectory, 'diagnostics/disk.txt'))).toBe(true);
      expect(existsSync(path.join(f.outputDirectory, 'diagnostics/processes.txt'))).toBe(true);
      expect(existsSync(path.join(f.outputDirectory, 'evidence'))).toBe(false);
    } finally {
      timer.mockRestore();
      cleared.mockRestore();
      signals.mockRestore();
      commands.mockRestore();
      children.mockRestore();
      f.cleanup();
    }
  });
