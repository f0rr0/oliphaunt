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
import { type NativeShippingRequest, qualifyNativeShipping } from './qualify-native-shipping.mts';

const realCapture = fileURLToPath(new URL('./capture-native-build-evidence.mts', import.meta.url));
const withSource = fileURLToPath(new URL('./with-source.sh', import.meta.url));

function fixture(mode = 'success') {
  const directory = mkdtempSync(path.join(tmpdir(), 'qualify-native-shipping-'));
  const workspace = path.join(directory, 'workspace');
  const executionRoot = path.join(directory, 'execroot');
  const outputDirectory = path.join(directory, 'capture');
  const stateFile = path.join(directory, 'state.json');
  const callsFile = path.join(directory, 'calls.jsonl');
  for (const name of ['src', 'tools/dev', 'tools/release'])
    mkdirSync(path.join(workspace, name), { recursive: true });
  mkdirSync(path.join(executionRoot, 'bazel-out/bin'), { recursive: true });
  writeFileSync(path.join(workspace, 'src/input.mts'), 'declared source');
  symlinkSync(path.join(workspace, 'src'), path.join(executionRoot, 'src'), 'dir');
  const output = 'bazel-out/bin/native.tar.gz';
  const outputBytes = Buffer.from('final archive');
  writeFileSync(path.join(executionRoot, output), outputBytes);
  const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  writeFileSync(
    path.join(workspace, 'tools/dev/bun.sh'),
    `#!/usr/bin/env bash\nexec ${shellQuote(process.execPath)} "$@"\n`,
  );
  copyFileSync(withSource, path.join(workspace, 'tools/release/with-source.sh'));
  writeFileSync(
    path.join(workspace, 'tools/release/capture-native-build-evidence.mts'),
    `import {spawnSync} from 'node:child_process';\nimport {readFileSync,writeFileSync} from 'node:fs';\nconst state=JSON.parse(readFileSync(${JSON.stringify(stateFile)},'utf8'));\nif(state.mode==='capture-race') writeFileSync('src/input.mts','changed during capture');\nconst result=spawnSync(process.execPath,[${JSON.stringify(realCapture)},...process.argv.slice(2)],{stdio:'inherit'});\nprocess.exit(result.status??1);\n`,
  );
  writeFileSync(
    path.join(workspace, 'tools/dev/bazel.sh'),
    `#!/usr/bin/env bash\nexec ${shellQuote(process.execPath)} tools/dev/bazel-fixture.mts "$@"\n`,
  );
  writeFileSync(
    path.join(workspace, 'tools/dev/bazel-fixture.mts'),
    `import {appendFileSync,readFileSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
const state=JSON.parse(readFileSync(${JSON.stringify(stateFile)},'utf8'));
const invocation=process.argv.slice(2);
appendFileSync(${JSON.stringify(callsFile)},JSON.stringify(invocation)+'\\n');
const args=invocation.slice(invocation.findIndex((arg:string)=>['test','cquery','aquery','info'].includes(arg)));
if(args[0]==='test') {
  if(state.mode==='build-failure') process.exit(1);
  if(state.mode==='build-race') writeFileSync('src/input.mts','changed during build');
  if(state.mode==='head-race') {
    writeFileSync('src/input.mts','new committed source');
    execFileSync('git',['add','src/input.mts']);
    execFileSync('git',['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','changed source']);
  }
  const metadata=Object.fromEntries(args.filter((arg:string)=>arg.startsWith('--build_metadata=')).map((arg:string)=>{const value=arg.slice(17);const split=value.indexOf('=');return [value.slice(0,split),value.slice(split+1)];}));
  const events=[...state.events,{id:{buildMetadata:{}},buildMetadata:{metadata}},{id:{buildFinished:{}},finished:{exitCode:{name:'SUCCESS'}}},{id:{buildMetrics:{}},buildMetrics:{},lastMessage:true}];
  writeFileSync(args.find((arg:string)=>arg.startsWith('--build_event_json_file=')).slice(24),events.map((event:unknown)=>JSON.stringify(event)).join('\\n')+'\\n');
} else if(args[0]==='info') console.log(state.executionRoot);
else if(args[0]==='aquery') console.log(JSON.stringify(state.aquery));
else if(args.some((arg:string)=>arg==='--starlark:expr=str(target.label)')) console.log('@@//fixture:shipping');
else if(args.some((arg:string)=>arg==='--output=jsonproto')) console.log(JSON.stringify(state.cquery));
else {
  if(state.mode==='query-failure') process.exit(1);
  console.log(JSON.stringify(state.root));
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
  const paths = ['src/input.mts', output];
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
    targets: [{ id: 1, label: '//fixture:package' }],
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
      id: { targetCompleted: { label: root.label, configuration: { id: configuration } } },
      completed: {
        success: true,
        outputGroup: [{ name: 'default', fileSets: [{ id: 'outputs' }] }],
      },
    },
  ];
  writeFileSync(
    stateFile,
    JSON.stringify({
      mode,
      executionRoot,
      root,
      aquery,
      events,
      cquery: {
        results: [{ target: { rule: { name: root.label } }, configurationId: 1 }],
        configurations: [{ id: 1, checksum: configuration }],
      },
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
      for (const call of calls)
        for (const flag of f.request.configuration) expect(call).toContain(flag);
      expect(existsSync(path.join(f.outputDirectory, 'build-events.jsonl'))).toBe(true);
      expect(existsSync(path.join(f.outputDirectory, 'cquery.json'))).toBe(true);
      expect(existsSync(path.join(f.outputDirectory, 'aquery.json'))).toBe(true);
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
      expect(['test', 'cquery', 'aquery', 'info']).toContain(call[2]);
      for (const flag of f.request.configuration) expect(call.indexOf(flag)).toBeGreaterThan(2);
    }
  } finally {
    f.cleanup();
  }
});

for (const mode of ['build-race', 'head-race', 'build-failure', 'query-failure', 'capture-race'])
  test(`does not return evidence after ${mode}`, () => {
    const f = fixture(mode);
    try {
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
