import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

const SOURCE = '8b1bb482f28d7617c274f69c44196599fa092014';
const TREE = '015b85f99137b832a619ff62cd77fda39b842771';
const PATCH = 'e9bb6ff1c8940e884dcb070efde0d0de61c9f4703108bafc487f7e863648c527';
const CHANGES = [
  [
    'build_defs/host/cc-profiles.bzl',
    '5f853c63c3abfa8304ff4eb6cc82e2f0d88da6330435590a93f000cd17b248a7',
    'd3048591f18047a434dadb405c49baee241c2c97f0b277393607320b8a477a7b',
  ],
  [
    'build_defs/host/profile-test.bzl',
    '3c65faf7f70b1c2a871fcc95e63e95601266d43ecce4435ac6ffedcbc47a0605',
    '211885b74bdd9dc20f2b52a2b5816f53ae3f1164ec0b9c230530b5931fc53974',
  ],
] as const;
const PACKAGE = '_apple_compile_input_control';
const PROFILES = [
  'native_macos_arm64',
  'apple_package_macos_arm64',
  'ios_device_arm64',
  'ios_simulator_arm64',
];
const LABELS = ['//' + PACKAGE + ':stable48', '//' + PACKAGE + ':mixed12'];
const MNEMONICS = new Set(['CppCompile', 'CppLink', 'CppArchive']);
const PHASES = new Set([
  'Action.execute',
  'subprocess.run',
  'sandbox.createFileSystem',
  'sandbox.populateInputsAndDirsToCreate',
  'sandbox.filterInputsAndDirsToCreate',
  'sandbox.createDirectories',
  'sandbox.createInputs',
  'Launch Blaze',
]);
const CATEGORIES = new Set([
  'action processing',
  'gc notification',
  'action dependency checking',
  'local action execution',
]);
const ENV_KEYS = new Set([
  'DEVELOPER_DIR',
  'SDKROOT',
  'XCODE_VERSION_OVERRIDE',
  'APPLE_SDK_VERSION_OVERRIDE',
  'APPLE_SDK_PLATFORM',
  'OLIPHAUNT_APPLE_DEVELOPER_DIRECTORY',
  'OLIPHAUNT_APPLE_SDKROOT',
  'OLIPHAUNT_APPLE_TOOL_DIRECTORY',
  'ZERO_AR_DATE',
]);
const MATCHING_FIELDS = [
  'owner',
  'mnemonic',
  'configuration',
  'profile',
  'output',
  'outputSha256',
  'argumentsSha256',
  'selectedEnvironmentSha256',
];
const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const json = (file: string) => JSON.parse(readFileSync(file, 'utf8'));
const save = (file: string, value: unknown) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
};
const [mode, destination] = process.argv.slice(2);
assert((mode === 'run' || mode === 'finalize') && destination);
const raw = join(destination, 'private');
const safe = join(destination, 'evidence');
mkdirSync(raw, { recursive: true, mode: 0o700 });
mkdirSync(safe, { recursive: true, mode: 0o700 });
const workspace = process.cwd();
const git = (args: string[], cwd = workspace) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const environment = { ...process.env };
for (const key of Object.keys(environment))
  if (/TOKEN|SECRET|PASSWORD|CREDENTIAL/iu.test(key)) delete environment[key];
let stage = 'source-guard';
let activeCase: string | undefined;
function safeFailure(error: unknown) {
  const value = error as { message?: string; stack?: string; actual?: unknown; expected?: unknown };
  const scalar = (item: unknown) =>
    (typeof item === 'number' && Number.isFinite(item)) ||
    (typeof item === 'string' && /^[a-f0-9]{64}$/u.test(item))
      ? item
      : undefined;
  const known = new Set([
    'fixture build failed',
    'fixture action query failed',
    'configured fixture compile count differs from48',
    'fresh fixture compile execution count differs from48',
    'profile fixture compile count differs from48',
    'profile configuration does not match configured action',
    'captured SDK receipt changed between cases',
    'candidate SDK source union differs across profiles',
    'compile SDK inputs shrank',
    'compile SDK input is not in candidate union',
    'link SDK source inputs changed',
    'profile projection failed',
  ]);
  for (const key of MATCHING_FIELDS) known.add('control changed ' + key);
  const location = /apple-compile-input-control\.mts:(\d+):(\d+)/u.exec(value.stack ?? '');
  return {
    stage,
    case: activeCase,
    message: known.has(value.message ?? '') ? value.message : undefined,
    messageSha256: hash(String(error)),
    actual: scalar(value.actual),
    expected: scalar(value.expected),
    line: location ? Number(location[1]) : undefined,
    column: location ? Number(location[2]) : undefined,
  };
}
function run(command: string, args: string[], cwd: string, log: string, timeout?: number) {
  const output = openSync(log, 'w', 0o600);
  const start = Date.now();
  try {
    const result = spawnSync(command, args, {
      cwd,
      env: environment,
      stdio: ['ignore', output, output],
      timeout,
      killSignal: 'SIGTERM',
    });
    return {
      exitCode: result.status,
      signal: result.signal,
      elapsedMs: Date.now() - start,
      errorCode: (result.error as NodeJS.ErrnoException | undefined)?.code,
    };
  } finally {
    closeSync(output);
  }
}
function fixture(directory: string) {
  const files: Record<string, string> = {};
  for (let index = 0; index < 48; index++) {
    const number = String(index).padStart(2, '0');
    files['p' + number + '.c'] =
      '#include <stddef.h>\n#include <stdint.h>\nuint64_t probe_' +
      number +
      '(uint64_t value) { return value + (uint64_t) sizeof(size_t) + ' +
      index +
      '; }\n' +
      (index === 0 ? 'int main(void) { (void) probe_00(0); return 0; }\n' : '');
  }
  files['fork.bzl'] = [
    '_PROFILES = ' +
      JSON.stringify(
        Object.fromEntries(PROFILES.map((profile) => [profile, '//build_defs/host:' + profile])),
      ),
    'def _fork_impl(settings, attr):',
    '    return {name: {"//command_line_option:platforms": [str(Label(platform))]} for name, platform in _PROFILES.items()}',
    '_fork = transition(implementation = _fork_impl, inputs = [], outputs = ["//command_line_option:platforms"])',
    'def _all_impl(ctx):',
    '    return [DefaultInfo(files = depset(transitive = [target[DefaultInfo].files for target in ctx.split_attr.binary.values()]))]',
    'mixed = rule(implementation = _all_impl, attrs = {"binary": attr.label(mandatory = True, cfg = _fork), "_allowlist_function_transition": attr.label(default = "@bazel_tools//tools/allowlists/function_transition_allowlist")})',
    '',
  ].join('\n');
  files['BUILD.bazel'] = [
    'load("@rules_cc//cc:cc_binary.bzl", "cc_binary")',
    'load(":fork.bzl", "mixed")',
    'package(default_visibility = ["//visibility:public"])',
    'cc_binary(name = "mixed12", srcs = ' +
      JSON.stringify(
        Object.keys(files)
          .filter((name) => name.endsWith('.c'))
          .slice(0, 12),
      ) +
      ')',
    'cc_binary(name = "stable48", srcs = ' +
      JSON.stringify(Object.keys(files).filter((name) => name.endsWith('.c'))) +
      ')',
    'mixed(name = "mixed", binary = ":mixed12")',
    '',
  ].join('\n');
  const directoryRoot = join(directory, PACKAGE);
  assert(!existsSync(directoryRoot), 'fixture must be fresh');
  mkdirSync(directoryRoot);
  for (const [name, bytes] of Object.entries(files))
    writeFileSync(join(directoryRoot, name), bytes);
  return hash(JSON.stringify(files));
}
const configuration = [
  '-c',
  'opt',
  '--config=macos-sandbox',
  '--platforms=//build_defs/host:apple_package_macos_arm64',
  '--host_platform=//build_defs/host:native_macos_arm64',
  '--jobs=2',
  '--lockfile_mode=error',
  '--reuse_sandbox_directories=true',
  '--experimental_inmemory_sandbox_stashes=true',
  '--sandbox_debug=false',
  '--remote_cache=',
  '--remote_executor=',
];
const profileFlags = [
  '--experimental_profile_include_primary_output=true',
  '--experimental_profile_include_target_label=true',
  '--experimental_profile_include_target_configuration=true',
  '--slim_profile=false',
];
type Case = {
  stem: string;
  arm: string;
  kind: string;
  source: string;
  base: string;
  cache: string;
  target: string;
};
const startup = (sample: Case) => [
  'tools/dev/bazel.sh',
  '--nohome_rc',
  '--nosystem_rc',
  '--output_base=' + sample.base,
  '--host_jvm_args=-Xmx3g',
  '--server_jvm_out=' + join(raw, sample.stem + '.server.log'),
];
function stop(samples: Case[]) {
  for (const sample of samples) {
    const receipt = join(safe, sample.stem + '.shutdown.json');
    if (existsSync(receipt) && json(receipt).exitCode === 0) continue;
    if (!existsSync(join(sample.base, 'server', 'server.pid.txt'))) continue;
    const result = run(
      'bash',
      [...startup(sample), 'shutdown'],
      sample.source,
      join(raw, sample.stem + '.shutdown.log'),
      60_000,
    );
    save(receipt, result);
  }
}
function failure(log: string) {
  if (!existsSync(log)) return undefined;
  const text = readFileSync(log, 'utf8');
  const categories = new Set<string>();
  for (const line of text.split('\n')) {
    if (/file not found|No such file/u.test(line)) categories.add('missing-file');
    if (/undeclared inclusion|missing dependency declaration/u.test(line))
      categories.add('undeclared-input');
    if (/Undefined symbols|undefined reference|linker command failed/u.test(line))
      categories.add('link-error');
    if (/fatal error:| error:|^error:/u.test(line)) categories.add('compiler-error');
    if (/^ERROR:|FAILED/u.test(line)) categories.add('bazel-error');
  }
  return { logSha256: hash(text), categories: [...categories].sort() };
}
function failureTail(log: string) {
  console.error(readFileSync(log, 'utf8').trimEnd().split(/\r?\n/u).slice(-40).join('\n'));
}
function graphRows(sample: Case) {
  stage = 'configured-action-inputs';
  const graph = json(join(raw, sample.stem + '.aquery.json'));
  const index = (rows: any[]) => new Map((rows ?? []).map((row) => [String(row.id), row]));
  const fragments = index(graph.pathFragments),
    artifacts = index(graph.artifacts),
    sets = index(graph.depSetOfFiles),
    targets = index(graph.targets),
    configurations = index(graph.configuration);
  const paths = new Map<string, string>();
  function file(id: string): string {
    if (paths.has(id)) return paths.get(id)!;
    const part = fragments.get(id);
    assert(part);
    const result = part.parentId ? file(String(part.parentId)) + '/' + part.label : part.label;
    paths.set(id, result);
    return result;
  }
  const artifactPath = (id: string) => {
    const artifact = artifacts.get(id);
    assert(artifact);
    return file(String(artifact.pathFragmentId));
  };
  const sdk = (path: string) => /^external\/[^/]*native_apple_sdk\/(.+)$/u.exec(path)?.[1];
  const receipt = [...artifacts.values()].find(
    (row) => sdk(artifactPath(String(row.id))) === 'receipt.json',
  );
  assert(receipt);
  const executionRoot = join(sample.base, 'execroot', '_main');
  const receiptSha256 = hash(readFileSync(join(executionRoot, artifactPath(String(receipt.id)))));
  function inputs(ids: any[]): Set<string> {
    const result = new Set<string>(),
      visited = new Set<string>();
    const visit = (id: string) => {
      if (visited.has(id)) return;
      visited.add(id);
      const row = sets.get(id);
      assert(row);
      for (const child of row.transitiveDepSetIds ?? []) visit(String(child));
      for (const artifact of row.directArtifactIds ?? []) result.add(String(artifact));
    };
    for (const id of ids) visit(String(id));
    return result;
  }
  const sdkSets = new Map<string, Set<string>>();
  const rows = (graph.actions ?? [])
    .filter((action: any) => MNEMONICS.has(action.mnemonic))
    .flatMap((action: any) => {
      const label = targets.get(String(action.targetId))?.label;
      const owner = LABELS.find((value) => label?.endsWith(value));
      if (!owner) return [];
      const config = configurations.get(String(action.configurationId));
      assert(config && /^[a-f0-9]{64}$/u.test(config.checksum));
      const output = artifactPath(String(action.primaryOutputId ?? action.outputIds?.[0]));
      assert(
        /^[A-Za-z0-9_+./-]+$/u.test(output) &&
          !output.split('/').includes('..') &&
          output.includes('/bin/' + PACKAGE + '/'),
      );
      const ids = inputs(action.inputDepSetIds ?? []);
      const sdkFiles = [...ids]
        .flatMap((id) => {
          const value = sdk(artifactPath(id));
          if (!value) return [];
          assert(!artifacts.get(id).isTreeArtifact);
          return [value];
        })
        .sort();
      const sdkSetSha256 = hash(JSON.stringify(sdkFiles));
      if (!sdkSets.has(sdkSetSha256)) sdkSets.set(sdkSetSha256, new Set(sdkFiles));
      const selectedEnv = (action.environmentVariables ?? [])
        .filter((row: any) => ENV_KEYS.has(row.key))
        .map((row: any) => [row.key, row.value])
        .sort();
      const sdkroot = selectedEnv.find(
        (row: string[]) => row[0] === 'OLIPHAUNT_APPLE_SDKROOT',
      )?.[1];
      const profile =
        sdkroot === undefined
          ? PROFILES[0]
          : sdkroot.endsWith('/sdk_macosx')
            ? PROFILES[1]
            : sdkroot.endsWith('/sdk_iphoneos')
              ? PROFILES[2]
              : sdkroot.endsWith('/sdk_iphonesimulator')
                ? PROFILES[3]
                : undefined;
      assert(profile, 'unknown declared SDK selection');
      return [
        {
          owner,
          mnemonic: action.mnemonic,
          configuration: config.checksum,
          profile,
          output,
          outputSha256: hash(readFileSync(join(executionRoot, output))),
          sdkFiles: sdkFiles.length,
          sdkSetSha256,
          argumentsSha256: hash(JSON.stringify(action.arguments ?? [])),
          selectedEnvironmentKeys: selectedEnv.map((row: string[]) => row[0]),
          selectedEnvironmentSha256: hash(JSON.stringify(selectedEnv)),
        },
      ];
    })
    .sort((a: any, b: any) => a.output.localeCompare(b.output));
  const compiles = rows.filter((row: any) => row.mnemonic === 'CppCompile');
  assert.equal(compiles.length, 48, 'configured fixture compile count differs from48');
  assert.equal(new Set(compiles.map((row: any) => row.output)).size, 48);
  const expected =
    sample.kind === 'stable'
      ? { [PROFILES[1]]: 48 }
      : Object.fromEntries(PROFILES.map((profile) => [profile, 12]));
  for (const [profile, count] of Object.entries(expected))
    assert.equal(compiles.filter((row: any) => row.profile === profile).length, count);
  const events = readFileSync(join(raw, sample.stem + '.bep.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const executed = events.filter(
    (event) =>
      event.action?.type === 'CppCompile' &&
      LABELS.some((label) =>
        String(event.id?.actionCompleted?.label ?? event.action?.label).endsWith(label),
      ),
  );
  assert.equal(executed.length, 48, 'fresh fixture compile execution count differs from48');
  assert(executed.every((event) => event.action.success === true));
  const supportActionCounts = Object.fromEntries(
    [...MNEMONICS].map((mnemonic) => [
      mnemonic,
      (graph.actions ?? []).filter(
        (action: any) =>
          action.mnemonic === mnemonic &&
          !LABELS.some((label) =>
            String(targets.get(String(action.targetId))?.label).endsWith(label),
          ),
      ).length,
    ]),
  );
  return {
    rows,
    sdkSets,
    sdkReceiptSha256: receiptSha256,
    executedCompiles: executed.length,
    supportActionCounts,
  };
}
function sanitizeProfile(sample: Case, rows: any[] = []) {
  stage = 'profile-finalization';
  const input = join(raw, sample.stem + '.profile.json.gz');
  if (!existsSync(input)) return { present: false };
  const bytes = readFileSync(input);
  let original: any;
  let readerStage = 'gzip-test';
  let gzipCheck: { status: number | null; signal: string | null; errorCode?: string } | undefined;
  try {
    const checked = spawnSync('/usr/bin/gzip', ['-t', input], { stdio: 'ignore' });
    gzipCheck = {
      status: checked.status,
      signal: checked.signal,
      errorCode: (checked.error as NodeJS.ErrnoException | undefined)?.code,
    };
    assert.equal(checked.status, 0);
    readerStage = 'decompress';
    const decoded = gunzipSync(bytes).toString('utf8');
    readerStage = 'json';
    original = JSON.parse(decoded);
    readerStage = 'shape';
    assert(Array.isArray(original.traceEvents));
  } catch (error) {
    const value = error as { name?: string; code?: string };
    return {
      present: true,
      strictComplete: false,
      originalSha256: hash(bytes),
      compressedBytes: bytes.length,
      readerStage,
      gzipCheck,
      errorName: ['AssertionError', 'SyntaxError', 'RangeError', 'TypeError', 'Error'].includes(
        value.name ?? '',
      )
        ? value.name
        : undefined,
      errorCode: [
        'ERR_ASSERTION',
        'Z_DATA_ERROR',
        'Z_BUF_ERROR',
        'ERR_BUFFER_TOO_LARGE',
        'ERR_STRING_TOO_LONG',
      ].includes(value.code ?? '')
        ? value.code
        : undefined,
      sanitizedUploaded: false,
    };
  }
  try {
    const byOutput = new Map(rows.map((row) => [row.output, row]));
    let fixtureCompiles = 0;
    const traceEvents = original.traceEvents.map((event: any) => {
      const first = typeof event.name === 'string' ? event.name.split(' ')[0] : undefined;
      const mnemonic = MNEMONICS.has(event.args?.mnemonic)
        ? event.args.mnemonic
        : MNEMONICS.has(first)
          ? first
          : undefined;
      const result: Record<string, any> = {
        name: PHASES.has(event.name) ? event.name : (mnemonic ?? 'other'),
        cat: CATEGORIES.has(event.cat) ? event.cat : 'other',
        ph: typeof event.ph === 'string' && /^[A-Za-z]$/u.test(event.ph) ? event.ph : 'i',
      };
      for (const key of ['ts', 'dur', 'pid', 'tid', 'tts', 'tdur', 'id', 'bind_id'])
        if (typeof event[key] === 'number' && Number.isFinite(event[key])) result[key] = event[key];
      const row = typeof event.out === 'string' ? byOutput.get(event.out) : undefined;
      if (row && event.args?.target?.endsWith(row.owner)) {
        if (mnemonic) assert.equal(mnemonic, row.mnemonic);
        assert(
          typeof event.args.configuration === 'string',
          'profile omitted configured action identity',
        );
        assert.equal(
          event.args.configuration,
          row.configuration,
          'profile configuration does not match configured action',
        );
        result.out = row.output;
        result.args = {
          mnemonic: row.mnemonic,
          profile: row.profile,
          configuration: row.configuration,
        };
        if (event.cat === 'action processing' && event.ph === 'X' && row.mnemonic === 'CppCompile')
          fixtureCompiles++;
      }
      return result;
    });
    if (rows.length)
      assert.equal(fixtureCompiles, 48, 'profile fixture compile count differs from48');
    const sanitized = gzipSync(JSON.stringify({ displayTimeUnit: 'ms', traceEvents }));
    writeFileSync(join(safe, sample.stem + '.profile.json.gz'), sanitized);
    return {
      present: true,
      strictComplete: true,
      projectionValid: true,
      originalSha256: hash(bytes),
      sanitizedSha256: hash(sanitized),
      events: traceEvents.length,
      fixtureCompiles,
      removed: [
        'raw environment',
        'arguments',
        'otherData',
        'arbitrary event names',
        'unknown outputs/labels/configurations',
      ],
    };
  } catch (error) {
    return {
      present: true,
      strictComplete: true,
      projectionValid: false,
      originalSha256: hash(bytes),
      projectionFailure: safeFailure(error),
      sanitizedUploaded: false,
    };
  }
}
function collect(sample: Case) {
  let graph: ReturnType<typeof graphRows> | undefined;
  if (existsSync(join(raw, sample.stem + '.aquery.json'))) graph = graphRows(sample);
  const profile = sanitizeProfile(sample, graph?.rows);
  const publicGraph = graph && {
    rows: graph.rows,
    sdkReceiptSha256: graph.sdkReceiptSha256,
    executedCompiles: graph.executedCompiles,
    supportActionCounts: graph.supportActionCounts,
  };
  save(join(safe, sample.stem + '.summary.json'), {
    ...sample,
    source: undefined,
    base: undefined,
    cache: undefined,
    sourceCommit: SOURCE,
    sourceTree: TREE,
    candidatePatchSha256: sample.arm === 'union' ? PATCH : undefined,
    ...publicGraph,
    profile,
    failure: failure(join(raw, sample.stem + '.build.log')),
  });
  return { graph, profile };
}
const planPath = join(raw, 'plan.json');
try {
  if (mode === 'finalize') {
    if (existsSync(planPath)) {
      const samples = json(planPath) as Case[];
      stop(samples);
      for (const sample of samples) {
        const summary = join(safe, sample.stem + '.summary.json');
        if (existsSync(summary)) {
          const completed = json(summary);
          if (
            completed.executedCompiles === 48 &&
            completed.profile?.strictComplete === true &&
            completed.profile?.projectionValid === true
          )
            continue;
        }
        activeCase = sample.stem;
        try {
          collect(sample);
        } catch {
          save(join(safe, sample.stem + '.collection-failure.json'), {
            collectionComplete: false,
            failure: failure(join(raw, sample.stem + '.build.log')),
          });
        }
      }
    }
  } else {
    assert.equal(git(['rev-parse', SOURCE + '^{tree}']), TREE);
    const patch = readFileSync(join(import.meta.dir, 'apple-compile-union.patch'));
    assert.equal(hash(patch), PATCH);
    const samples: Case[] = [];
    let fixtureSha256: string | undefined;
    for (const arm of ['current', 'union']) {
      stage = 'source-guard';
      const source = join(raw, 'source-' + arm);
      assert(!existsSync(source));
      execFileSync('git', ['worktree', 'add', '--detach', source, SOURCE], { stdio: 'ignore' });
      assert.equal(git(['rev-parse', 'HEAD^{tree}'], source), TREE);
      for (const [path, before] of CHANGES)
        assert.equal(hash(readFileSync(join(source, path))), before);
      if (arm === 'union') {
        execFileSync(
          'git',
          ['apply', '--check', join(import.meta.dir, 'apple-compile-union.patch')],
          { cwd: source, stdio: 'ignore' },
        );
        execFileSync('git', ['apply', join(import.meta.dir, 'apple-compile-union.patch')], {
          cwd: source,
          stdio: 'ignore',
        });
        for (const [path, , after] of CHANGES)
          assert.equal(hash(readFileSync(join(source, path))), after);
        assert.deepEqual(
          git(['diff', '--name-only'], source).split('\n').sort(),
          CHANGES.map((row) => row[0]).sort(),
        );
      } else assert.equal(git(['diff', '--name-only'], source), '');
      stage = 'fixture';
      const digest = fixture(source);
      if (fixtureSha256) assert.equal(digest, fixtureSha256);
      else fixtureSha256 = digest;
      for (const kind of ['stable', 'mixed']) {
        const stem = arm + '-' + kind,
          base = join(raw, 'base-' + stem),
          cache = join(raw, 'cache-' + stem);
        assert(!existsSync(base) && !existsSync(cache));
        mkdirSync(cache);
        samples.push({
          stem,
          arm,
          kind,
          source,
          base,
          cache,
          target: '//' + PACKAGE + ':' + (kind === 'stable' ? 'stable48' : 'mixed'),
        });
      }
    }
    save(planPath, samples);
    save(join(safe, 'control.json'), {
      sourceCommit: SOURCE,
      sourceTree: TREE,
      candidatePatchSha256: PATCH,
      fixtureSha256,
      configuration,
      profileFlags,
      cases: samples.map(({ stem, arm, kind, target }) => ({ stem, arm, kind, target })),
      limitations: [
        'One current-then-union pair; page/physical SDK caches are shared.',
        'Four mixed links versus one stable link are a separate measured confound.',
        'Diagnostic fixture construction only; no package qualification or production adoption.',
      ],
    });
    const results: any[] = [];
    try {
      for (const sample of samples) {
        activeCase = sample.stem;
        stage = 'build';
        const result = run(
          'bash',
          [
            ...startup(sample),
            'build',
            sample.target,
            ...configuration,
            '--disk_cache=' + sample.cache,
            ...profileFlags,
            '--build_event_publish_all_actions=true',
            '--build_event_json_file=' + join(raw, sample.stem + '.bep.jsonl'),
            '--profile=' + join(raw, sample.stem + '.profile.json.gz'),
          ],
          sample.source,
          join(raw, sample.stem + '.build.log'),
        );
        if (result.exitCode !== 0) failureTail(join(raw, sample.stem + '.build.log'));
        save(join(safe, sample.stem + '.result.json'), result);
        assert.equal(result.exitCode, 0, 'fixture build failed');
        stage = 'aquery';
        const query = run(
          'bash',
          [
            ...startup(sample),
            'aquery',
            'mnemonic("CppCompile|CppLink|CppArchive", deps(' + sample.target + '))',
            ...configuration,
            '--disk_cache=' + sample.cache,
            '--output=jsonproto',
            '--include_commandline=true',
            '--include_param_files=false',
            '--include_file_write_contents=false',
            '--include_artifacts=true',
            '--include_pruned_inputs=true',
            '--output_file=' + join(raw, sample.stem + '.aquery.json'),
          ],
          sample.source,
          join(raw, sample.stem + '.aquery.log'),
        );
        if (query.exitCode !== 0) failureTail(join(raw, sample.stem + '.aquery.log'));
        assert.equal(query.exitCode, 0, 'fixture action query failed');
        stop([sample]);
        const collected = collect(sample);
        assert(
          collected.profile.strictComplete && collected.profile.projectionValid && collected.graph,
          'profile projection failed',
        );
        results.push({ sample, ...collected });
      }
      stage = 'comparison';
      activeCase = undefined;
      for (const arm of ['current', 'union']) {
        const source = join(raw, 'source-' + arm);
        for (const [path, before, after] of CHANGES)
          assert.equal(hash(readFileSync(join(source, path))), arm === 'union' ? after : before);
        assert.deepEqual(
          git(['diff', '--name-only'], source).split('\n').filter(Boolean).sort(),
          arm === 'union' ? CHANGES.map((row) => row[0]).sort() : [],
        );
      }
      assert.equal(
        new Set(results.map((result) => result.graph.sdkReceiptSha256)).size,
        1,
        'captured SDK receipt changed between cases',
      );
      const candidateCompiles = results
        .filter((result) => result.sample.arm === 'union')
        .flatMap((result) => result.graph.rows.filter((row: any) => row.mnemonic === 'CppCompile'));
      assert.equal(
        new Set(candidateCompiles.map((row: any) => row.sdkSetSha256)).size,
        1,
        'candidate SDK source union differs across profiles',
      );
      for (const kind of ['stable', 'mixed']) {
        const before = results.find(
          (result) => result.sample.arm === 'current' && result.sample.kind === kind,
        )!.graph.rows;
        const after = results.find(
          (result) => result.sample.arm === 'union' && result.sample.kind === kind,
        )!.graph.rows;
        assert.equal(after.length, before.length);
        for (let index = 0; index < before.length; index++) {
          for (const key of MATCHING_FIELDS)
            assert.deepEqual(after[index][key], before[index][key], 'control changed ' + key);
          if (before[index].mnemonic === 'CppCompile') {
            assert.equal(
              Math.min(after[index].sdkFiles, before[index].sdkFiles),
              before[index].sdkFiles,
              'compile SDK inputs shrank',
            );
            const current = results
              .find((result) => result.sample.arm === 'current' && result.sample.kind === kind)!
              .graph.sdkSets.get(before[index].sdkSetSha256)!;
            const candidate = results
              .find((result) => result.sample.arm === 'union' && result.sample.kind === kind)!
              .graph.sdkSets.get(after[index].sdkSetSha256)!;
            assert.equal(
              [...current].filter((path) => !candidate.has(path)).length,
              0,
              'compile SDK input is not in candidate union',
            );
          } else
            assert.equal(
              after[index].sdkSetSha256,
              before[index].sdkSetSha256,
              'link SDK source inputs changed',
            );
        }
      }
      save(join(safe, 'comparison.json'), {
        complete: true,
        matchingFixtureCompilesPerCase: 48,
        identicalOutputsArgumentsEnvironmentAndConfigurations: true,
        identicalSdkReceipt: true,
        candidateCommonSourceSdkUnionAcrossFourProfiles: true,
        currentCompileSdkSetsAreSubsets: true,
        compileSdkCountsNeverShrink: true,
        linkSdkSetsUnchanged: true,
        rawSdkPathsSerialized: false,
        notProductionAdoption: true,
      });
    } catch (error) {
      save(join(safe, 'control-failure.json'), {
        complete: false,
        ...safeFailure(error),
        notAdmission: true,
      });
      process.exitCode = 1;
    } finally {
      stop(samples);
    }
  }
} catch (error) {
  if (!existsSync(join(safe, 'control-failure.json')))
    save(join(safe, 'control-failure.json'), {
      complete: false,
      ...safeFailure(error),
      notAdmission: true,
    });
  process.exitCode = 1;
}
