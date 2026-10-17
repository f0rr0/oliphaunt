import { expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  NATIVE_AQUERY_FLAGS,
  nativeAqueryExpression,
} from '../release/native-build-qualification.mts';

const runner = fileURLToPath(new URL('./run-configured-request.mts', import.meta.url));
const metadata = fileURLToPath(
  new URL('../release/native-build-qualification.mts', import.meta.url),
);
const labels = fileURLToPath(new URL('../release/bazel-shipping-inputs.mts', import.meta.url));
const source = fileURLToPath(new URL('../release/with-source.mts', import.meta.url));
const wrapper = fileURLToPath(new URL('../release/with-source.sh', import.meta.url));

function fixture(mode: string, integrated = false) {
  const root = mkdtempSync(path.join(tmpdir(), 'configured-ci-request-'));
  for (const directory of ['tools/ci', 'tools/dev', 'tools/release', 'tools/packaging'])
    mkdirSync(path.join(root, directory), { recursive: true });
  copyFileSync(runner, path.join(root, 'tools/ci/run-configured-request.mts'));
  copyFileSync(wrapper, path.join(root, 'tools/release/with-source.sh'));
  copyFileSync(
    new URL('../packaging/release-directory-safety.mts', import.meta.url),
    path.join(root, 'tools/packaging/release-directory-safety.mts'),
  );
  copyFileSync(
    new URL('../release/qualified-release-replay.sh', import.meta.url),
    path.join(root, 'tools/release/qualified-release-replay.sh'),
  );
  writeFileSync(path.join(root, '.bazelversion'), '8.8.1\n');
  writeFileSync(
    path.join(root, 'MODULE.bazel.lock'),
    '{"lockFileVersion":28,"moduleExtensions":{}}',
  );
  mkdirSync(path.join(root, 'fixture'));
  writeFileSync(path.join(root, 'fixture/BUILD'), '# actual suite recipe');
  writeFileSync(path.join(root, 'fixture/input.rs'), 'pub fn input() {}');
  writeFileSync(path.join(root, '.gitignore'), 'output/\ncalls.jsonl\nexecroot/\n');
  for (const [name, real] of [
    ['native-build-qualification', metadata],
    ['bazel-shipping-inputs', labels],
    ['with-source', source],
  ])
    writeFileSync(
      path.join(root, `tools/release/${name}.mts`),
      `export * from ${JSON.stringify(real)};\n`,
    );
  writeFileSync(
    path.join(root, 'tools/ci/configured-scope.mts'),
    integrated
      ? `export * from ${JSON.stringify(fileURLToPath(new URL('./configured-scope.mts', import.meta.url)))};\n`
      : `import{writeFileSync}from'node:fs';import path from'node:path';
export function assertConfiguredCiSource() {}
export function writeConfiguredCiSuccessReceipt(context){writeFileSync(path.join(context.outputDirectory,'ci-request.json'),JSON.stringify({...context,schema:'oliphaunt-ci-request-v1',mode:'source',status:'success'}));}
export function captureConfiguredCiRequest(context){writeFileSync(path.join(context.outputDirectory,'ci-request.json'),JSON.stringify({...context,schema:'oliphaunt-ci-request-v1',mode:'full',status:'success'}));}
`,
  );
  const configuration = [
    '-c',
    'opt',
    '--jobs=2',
    '--config=macos-sandbox',
    '--platforms=//fixture:platform',
    '--repo_env=SOURCE_DIR=/fixture/path with spaces',
    '--test_env=VALUE=two words',
    '--test_env=RUST_TEST_THREADS=1',
  ];
  const startup = ['--output_base=/fixture/short base', '--host_jvm_args=-Xmx3g'];
  const targets = [
    mode.endsWith('external-root')
      ? '@icu//:windows_icu_smoke_test'
      : mode === 'alias-root'
        ? '//fixture:test_alias'
        : '//fixture:suite',
    '//fixture:archive',
  ];
  const output = path.join(root, 'output');
  mkdirSync(output);
  for (const [name, value] of Object.entries({
    configuration,
    startup,
    targets,
    requires: ['inputs/linux'],
  }))
    writeFileSync(path.join(root, `${name}.json`), JSON.stringify(value));
  writeFileSync(
    path.join(root, 'tools/dev/bazel.sh'),
    `#!/usr/bin/env bash\nexec '${process.execPath.replaceAll("'", "'\\''")}' tools/dev/bazel-fixture.mts "$@"\n`,
  );
  writeFileSync(
    path.join(root, 'tools/dev/bazel-fixture.mts'),
    `import{appendFileSync,writeFileSync}from'node:fs';import path from'node:path';
const args=process.argv.slice(2);appendFileSync('calls.jsonl',JSON.stringify(args)+'\\n');
const command=args.find(arg=>['test','build','cquery','query','aquery'].includes(arg));
const mode=${JSON.stringify(mode)};
if(command==='aquery') {
 if(mode==='failed-build-query-failure')process.exit(2);
 writeFileSync(args.find(arg=>arg.startsWith('--output_file=')).slice(14),'{"actions":[]}');process.exit(0);
}
if(command==='cquery') {console.log(JSON.stringify({configurations:[{id:1,checksum:'c'.repeat(64)}],results:['//fixture:archive','//fixture:executed_test'].map(name=>({configurationId:1,target:{rule:{name,configuredRuleInput:[{label:'//fixture:input.rs'}]}}})).concat([{target:{sourceFile:{name:'//fixture:input.rs'}}}])}));process.exit(0);}
if(command==='query') {console.log('//fixture:BUILD');process.exit(0);}
if(mode.startsWith('failed-build'))process.exit(1);
const bep=args.find(arg=>arg.startsWith('--build_event_json_file='));if(bep){
 const configuration=mode==='opaque'?'opaque-configuration-id':'c'.repeat(64);
 const testLabel=mode==='external-root'?'@icu+//:windows_icu_smoke_test':mode==='alias-root'?'//fixture:test_alias':'//fixture:executed_test';
 const summaryLabel=mode==='alias-root'?'//fixture:underlying_test':testLabel;
 const tested=args.includes('test');
 const builtOnly=mode==='built-only-test';
 const skipped=mode==='incompatible'||mode.startsWith('invalid-skip-');
 const skippedLabel='//fixture:incompatible_test';
 const completedId=label=>({targetCompleted:{label,configuration:{id:configuration}}});
 const summaryId={testSummary:{label:summaryLabel,configuration:{id:configuration}}};
 const resultId={testResult:{label:summaryLabel,configuration:{id:configuration},run:1,shard:1,attempt:1}};
 const metadata=Object.fromEntries(args.filter(arg=>arg.startsWith('--build_metadata=')).map(arg=>{const value=arg.slice(17);const split=value.indexOf('=');return[value.slice(0,split),value.slice(split+1)];}));
 const events=[{started:{uuid:'fixture-build',buildToolVersion:'8.8.1'}},{workspaceInfo:{localExecRoot:path.join(process.cwd(),'execroot/_main')}},{buildMetadata:{metadata}},
 {id:{pattern:{pattern:${JSON.stringify(targets)}}},children:[{targetConfigured:{label:testLabel}},{targetConfigured:{label:'//fixture:archive'}},...(builtOnly?[{targetConfigured:{label:'//fixture:built_only_test'}}]:[]),...(skipped?[{targetConfigured:{label:skippedLabel}}]:[])],expanded:{testSuiteExpansions:[{suiteLabel:'//fixture:suite',testLabels:[testLabel,'//fixture:filtered_test']}]}},
 {id:{configuration:{id:configuration}},configuration:{mnemonic:'fixture'}},
 {id:{targetConfigured:{label:testLabel}},children:[completedId(testLabel)],configured:mode==='alias-root'?{targetKind:'alias rule'}:{testSize:'SMALL'}},
 {id:{targetConfigured:{label:'//fixture:archive'}},children:[completedId('//fixture:archive')],configured:{targetKind:'archive rule'}},
 {id:completedId(testLabel),children:tested?[summaryId,resultId]:[],completed:{success:mode!=='failed-completion'}},
 {id:completedId('//fixture:archive'),completed:{success:true}},
 ...(builtOnly?[{id:{targetConfigured:{label:'//fixture:built_only_test'}},children:[completedId('//fixture:built_only_test')],configured:{testSize:'SMALL'}},{id:completedId('//fixture:built_only_test'),completed:{success:true}}]:[]),
 ...(skipped?[{id:{targetConfigured:{label:skippedLabel}},children:[completedId(skippedLabel)],configured:{testSize:'SMALL'}},{id:completedId(skippedLabel),aborted:{reason:'SKIPPED',description:'Target '+skippedLabel+' build was skipped.'}}]:[]),
 ...(tested?[{id:summaryId,testSummary:{overallStatus:mode==='failed-test'?'FAILED':'PASSED',totalRunCount:1}},{id:resultId,testResult:{status:'PASSED'}}]:[]),
 {finished:{exitCode:{name:'SUCCESS',code:0}}},{buildMetrics:{},lastMessage:true}];
 const captured=events.filter(event=>!(
  mode==='missing-completion'&&event.id?.targetCompleted?.label===testLabel||
  mode==='missing-configured'&&event.id?.targetConfigured?.label===testLabel||
  mode==='missing-build-root'&&event.id?.targetCompleted?.label==='//fixture:archive'||
  mode==='missing-summary'&&event.id?.testSummary||
  mode==='missing-result'&&event.id?.testResult||
  mode==='missing-expansion'&&event.expanded));
 if(mode==='wrong-pattern')captured.find(event=>event.expanded).id.pattern.pattern=['//fixture:other'];
 if(skipped){
  const skippedEvent=captured.find(event=>event.id?.targetCompleted?.label===skippedLabel);
  const skippedConfigured=captured.find(event=>event.id?.targetConfigured?.label===skippedLabel);
  if(mode==='invalid-skip-missing-abort')delete skippedEvent.aborted;
  if(mode==='invalid-skip-reason')skippedEvent.aborted.reason='ANALYSIS_FAILURE';
  if(mode==='invalid-skip-missing-reason')delete skippedEvent.aborted.reason;
  if(mode==='invalid-skip-failed-completion')skippedEvent.completed={success:false};
  if(mode==='invalid-skip-missing-config')delete skippedConfigured.children[0].targetCompleted.configuration;
  if(mode==='invalid-skip-wrong-config')skippedEvent.id.targetCompleted.configuration.id='d'.repeat(64);
  if(mode==='invalid-skip-child')skippedEvent.children=[summaryId];
  if(mode==='invalid-skip-test-evidence')captured.push({id:{testSummary:{label:skippedLabel,configuration:{id:configuration}}},testSummary:{overallStatus:'FAILED',totalRunCount:1}},{id:{testResult:{label:skippedLabel,configuration:{id:configuration},run:1,shard:1,attempt:1}},testResult:{status:'FAILED'}});
  if(mode==='invalid-skip-missing-completion')captured.splice(captured.indexOf(skippedEvent),1);
 }
 writeFileSync(bep.slice(24),captured.map(event=>JSON.stringify(event)).join('\\n')+'\\n');
}
`,
  );
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-q');
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
  return {
    root,
    configuration,
    startup,
    targets,
    output,
    run: (executionMode: string, command = 'test') =>
      spawnSync(
        'bash',
        [
          'tools/release/with-source.sh',
          'HEAD',
          process.execPath,
          'tools/ci/run-configured-request.mts',
          '--id',
          'portable/macos/plain',
          '--job',
          'portable/macos',
          '--mode',
          executionMode,
          '--command',
          command,
          '--output-directory',
          output,
          '--startup-json',
          'startup.json',
          '--configuration-json',
          'configuration.json',
          '--targets-json',
          'targets.json',
          '--requires-json',
          'requires.json',
        ],
        {
          cwd: root,
          encoding: 'utf8',
          env: {
            ...process.env,
            GITHUB_REPOSITORY: 'f0rr0/oliphaunt',
            GITHUB_WORKFLOW: 'Native Bazel qualification',
            GITHUB_JOB: 'portable',
            GITHUB_RUN_ID: '123',
            GITHUB_RUN_ATTEMPT: '1',
          },
        },
      ),
    calls: () =>
      existsSync(path.join(root, 'calls.jsonl'))
        ? readFileSync(path.join(root, 'calls.jsonl'), 'utf8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line))
        : [],
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test('ordinary source request retains exact arrays and executes once without BEP or queries', () => {
  const f = fixture('success');
  try {
    const result = f.run('source');
    expect(result.status).toBe(0);
    expect(f.calls()).toEqual([[...f.startup, 'test', ...f.targets, ...f.configuration]]);
    const receipt = JSON.parse(readFileSync(path.join(f.output, 'ci-request.json'), 'utf8'));
    expect(receipt).toMatchObject({
      id: 'portable/macos/plain',
      job: 'portable/macos',
      mode: 'source',
      github: { job: 'portable' },
      requires: ['inputs/linux'],
    });
    expect(receipt.projection).toBeUndefined();
    expect(receipt.workspaceRoot).toBe(f.root);
  } finally {
    f.cleanup();
  }
});

test('plain full and ordinary requests use the real shared capture, source guard and recorded reader', () => {
  for (const [scenario, mode] of [
    ['success', 'full'],
    ['incompatible', 'full'],
    ['success', 'source'],
  ]) {
    const f = fixture(scenario, true);
    try {
      const result = f.run(mode);
      expect(result.status, result.stderr).toBe(0);
      const receipt = JSON.parse(readFileSync(path.join(f.output, 'ci-request.json'), 'utf8'));
      expect(receipt.mode).toBe(mode);
      expect(f.calls().filter((args) => args.includes('test'))).toHaveLength(1);
      if (mode === 'full') {
        expect(f.calls()).toHaveLength(3);
        expect(receipt.projection.files).toEqual(['fixture/input.rs']);
        expect(receipt.projection.analysisInputs).toEqual(['fixture/BUILD']);
        expect(receipt.projection.roots.map((row) => row.label)).toEqual([
          '//fixture:archive',
          '//fixture:executed_test',
        ]);
      } else {
        expect(f.calls()).toHaveLength(1);
        expect(receipt.projection).toBeUndefined();
      }
    } finally {
      f.cleanup();
    }
  }
});

test('complete request captures actual successful suite leaves and authored suite recipes once', () => {
  const f = fixture('success');
  try {
    const result = f.run('full');
    expect(result.status).toBe(0);
    const calls = f.calls();
    expect(calls).toHaveLength(1);
    expect(
      calls[0].slice(0, f.startup.length + 1 + f.targets.length + f.configuration.length),
    ).toEqual([...f.startup, 'test', ...f.targets, ...f.configuration]);
    const receipt = JSON.parse(readFileSync(path.join(f.output, 'ci-request.json'), 'utf8'));
    expect(receipt.completedRoots).toEqual([
      { label: '//fixture:archive', configuration: 'c'.repeat(64) },
      { label: '//fixture:executed_test', configuration: 'c'.repeat(64) },
    ]);
    expect(receipt.requestedTargets).toEqual(f.targets);
    expect(receipt.configuration).toEqual(f.configuration);
    expect(receipt.startup).toEqual(f.startup);
    const privateBep = calls[0].find((arg) => arg.startsWith('--build_event_json_file=')).slice(24);
    expect(existsSync(privateBep)).toBe(false);
    expect(privateBep.startsWith(f.output)).toBe(false);
  } finally {
    f.cleanup();
  }
});

for (const [mode, executionMode] of [
  ['failed-build', 'full'],
  ['failed-build', 'source'],
  ['failed-test', 'full'],
  ['missing-summary', 'full'],
  ['missing-completion', 'full'],
  ['missing-configured', 'full'],
  ['failed-completion', 'full'],
  ['missing-build-root', 'full'],
  ['missing-result', 'full'],
  ['missing-expansion', 'full'],
  ['wrong-pattern', 'full'],
  ['opaque', 'full'],
  ['invalid-skip-missing-abort', 'full'],
  ['invalid-skip-reason', 'full'],
  ['invalid-skip-missing-reason', 'full'],
  ['invalid-skip-failed-completion', 'full'],
  ['invalid-skip-missing-config', 'full'],
  ['invalid-skip-wrong-config', 'full'],
  ['invalid-skip-child', 'full'],
  ['invalid-skip-test-evidence', 'full'],
  ['invalid-skip-missing-completion', 'full'],
])
  test(`failed/incomplete ${executionMode} ${mode} request never produces success or projection`, () => {
    const f = fixture(mode);
    try {
      const result = f.run(executionMode);
      expect(result.status).toBe(1);
      expect(f.calls()).toHaveLength(mode === 'failed-build' ? 2 : 1);
      expect(existsSync(path.join(f.output, 'ci-request.json'))).toBe(false);
      const bep = f.calls()[0].find((arg) => arg.startsWith('--build_event_json_file='));
      if (executionMode === 'full') expect(existsSync(bep.slice(24))).toBe(false);
      else expect(bep).toBeUndefined();
    } finally {
      f.cleanup();
    }
  });

test('plain build request keeps its command rather than silently running test', () => {
  const f = fixture('success');
  try {
    expect(f.run('source', 'build').status).toBe(0);
    expect(f.calls()[0]).toEqual([...f.startup, 'build', ...f.targets, ...f.configuration]);
  } finally {
    f.cleanup();
  }
});

for (const mode of ['failed-build', 'failed-build-query-failure', 'failed-build-external-root'])
  test(`${mode} preserves the build error and keeps its action graph diagnostic`, () => {
    const f = fixture(mode);
    try {
      const result = f.run('full', 'build');
      expect(result.status).toBe(1);
      expect(result.stderr.toString()).toContain('CI build failed (1)');
      const calls = f.calls();
      expect(calls).toHaveLength(mode === 'failed-build-external-root' ? 1 : 2);
      if (mode !== 'failed-build-external-root')
        expect(calls[1]).toEqual([
          ...f.startup,
          'aquery',
          nativeAqueryExpression(f.targets),
          ...f.configuration,
          ...NATIVE_AQUERY_FLAGS,
          `--output_file=${path.join(f.output, 'diagnostics/failed-aquery.json')}`,
        ]);
      expect(existsSync(path.join(f.output, 'diagnostics/failed-aquery.json'))).toBe(
        mode === 'failed-build',
      );
      expect(existsSync(path.join(f.output, 'ci-request.json'))).toBe(false);
      expect(existsSync(path.join(f.output, 'analysis-deps.query'))).toBe(false);
      expect(existsSync(path.join(f.output, 'evidence'))).toBe(false);
    } finally {
      f.cleanup();
    }
  });

for (const [mode, command] of [
  ['built-only-test', 'test'],
  ['success', 'build'],
  ['external-root', 'test'],
  ['alias-root', 'test'],
  ['incompatible', 'test'],
])
  test(`complete ${mode} ${command} request captures every built leaf and only scheduled test evidence`, () => {
    const f = fixture(mode);
    try {
      expect(f.run('full', command).status).toBe(0);
      expect(f.calls()).toHaveLength(1);
      const receipt = JSON.parse(readFileSync(path.join(f.output, 'ci-request.json'), 'utf8'));
      expect(receipt.requestedTargets).toEqual(f.targets);
      expect(receipt.completedRoots.map((root: { label: string }) => root.label).sort()).toEqual(
        [
          mode === 'external-root'
            ? '@icu+//:windows_icu_smoke_test'
            : mode === 'alias-root'
              ? '//fixture:test_alias'
              : '//fixture:executed_test',
          '//fixture:archive',
          ...(mode === 'built-only-test' ? ['//fixture:built_only_test'] : []),
        ].sort(),
      );
    } finally {
      f.cleanup();
    }
  });
