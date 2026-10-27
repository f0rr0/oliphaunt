import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertMissingHostRuntime,
  extractNativePayload,
  hostRuntimeEnvironment,
  missingHostModuleError,
  runHostBinary,
} from './host-runtime-test-helpers.mts';

const ambient = {
  PATH: '/bazel/native-sdk/bin',
  Path: 'C:\\native-sdk\\bin',
  SystemRoot: 'C:\\Windows',
  LD_LIBRARY_PATH: '/producer/lib',
  LD_PRELOAD: '/producer/inject.so',
  DYLD_LIBRARY_PATH: '/producer/lib',
  DYLD_FALLBACK_LIBRARY_PATH: '/producer/lib',
  DYLD_INSERT_LIBRARIES: '/producer/inject.dylib',
  INCLUDE: '/compiler/include',
  LIB: '/compiler/lib',
  PGHOST: 'ambient-host',
  PGDATA: '/ambient/data',
  OLIPHAUNT_POSTGRES: '/producer/postgres',
  OLIPHAUNT_ICU_DATA_DIR: '/ambient/icu',
  LIBOLIPHAUNT_PATH: '/producer/liboliphaunt',
  RUNFILES_DIR: '/bazel/runfiles',
  TEST_SRCDIR: '/bazel/runfiles',
  KEEP: 'unchanged',
};
for (const platform of ['linux', 'darwin', 'win32'] as const) {
  const env = hostRuntimeEnvironment(
    platform === 'win32' ? 'C:\\candidate' : '/candidate',
    platform === 'win32' ? 'C:\\test' : '/test',
    platform,
    ambient,
  );
  assert.equal(env.KEEP, 'unchanged');
  for (const key of [
    'Path',
    'LD_PRELOAD',
    'DYLD_INSERT_LIBRARIES',
    'INCLUDE',
    'LIB',
    'PGHOST',
    'PGDATA',
    'OLIPHAUNT_POSTGRES',
    'OLIPHAUNT_ICU_DATA_DIR',
    'LIBOLIPHAUNT_PATH',
    'RUNFILES_DIR',
    'TEST_SRCDIR',
  ])
    assert.equal(env[key], undefined, `${platform} retained ${key}`);
  if (platform === 'win32') {
    assert.equal(env.PATH, 'C:\\candidate\\bin;C:\\Windows\\System32;C:\\Windows');
    assert.equal(env.LD_LIBRARY_PATH, undefined);
    assert.equal(env.DYLD_LIBRARY_PATH, undefined);
    assert.equal(env.ICU_DATA, 'C:\\candidate\\share\\icu');
  } else {
    assert.equal(env.PATH, '/usr/bin:/bin:/usr/sbin:/sbin');
    assert.equal(
      env[platform === 'darwin' ? 'DYLD_LIBRARY_PATH' : 'LD_LIBRARY_PATH'],
      '/candidate/lib',
    );
    assert.equal(env[platform === 'darwin' ? 'LD_LIBRARY_PATH' : 'DYLD_LIBRARY_PATH'], undefined);
    assert.equal(env.ICU_DATA, '/candidate/share/icu');
    if (platform === 'darwin') assert.equal(env.DYLD_FALLBACK_LIBRARY_PATH, '');
  }
}
assert.throws(
  () => hostRuntimeEnvironment('C:\\candidate', 'C:\\test', 'win32', {}),
  /SystemRoot/u,
);
assert.throws(
  () => hostRuntimeEnvironment('/candidate', '/test', 'freebsd', ambient),
  /unsupported/u,
);
const result = (exitCode: number, stderr = '') => ({ exitCode, stderr: Buffer.from(stderr) });
assertMissingHostRuntime(
  result(127, 'liboliphaunt.so: cannot open shared object file'),
  'liboliphaunt.so',
  'linux',
);
assertMissingHostRuntime(
  result(134, 'dyld: Library not loaded: @rpath/liboliphaunt.dylib'),
  'liboliphaunt.dylib',
  'darwin',
);
assertMissingHostRuntime(result(0x35), 'oliphaunt.dll', 'win32');
for (const status of [0x34, 0x36])
  assert.throws(() => assertMissingHostRuntime(result(status), 'oliphaunt.dll', 'win32'));
for (const platform of ['linux', 'darwin', 'win32'] as const) {
  assert.throws(() => assertMissingHostRuntime(result(0), 'liboliphaunt', platform));
  assert.throws(() =>
    assertMissingHostRuntime(result(2, 'usage: profile_smoke'), 'liboliphaunt', platform),
  );
}
assert.throws(() =>
  assertMissingHostRuntime(result(127, 'different.so: missing'), 'liboliphaunt.so', 'linux'),
);
assert.throws(() =>
  assertMissingHostRuntime(
    result(134, 'unrelated crash in liboliphaunt.dylib'),
    'liboliphaunt.dylib',
    'darwin',
  ),
);

const ownerRoots = ['postgis-3.dll', 'postgis_raster-3.dll', 'postgis_topology-3.dll'];
const missingModuleCases: {
  name: string;
  platform: NodeJS.Platform;
  filename: string;
  response: string;
  expected: boolean;
  ownerRoots?: readonly string[];
}[] = [
  {
    name: 'Linux missing direct module',
    platform: 'linux',
    filename: 'postgis-3.so',
    response:
      'ERROR: could not load library "/tmp/path with spaces/postgis-3.so": No such file or directory',
    expected: true,
  },
  {
    name: 'Linux imported helper',
    platform: 'linux',
    filename: 'liboliphaunt_postgis_deps.so',
    response:
      'ERROR: could not load library "/tmp/postgis-3.so": liboliphaunt_postgis_deps.so: cannot open shared object file: No such file or directory',
    expected: true,
  },
  {
    name: 'PostgreSQL reports a canonical root without its suffix',
    platform: 'linux',
    filename: 'postgis-3.so',
    response: 'ERROR: could not access file "$libdir/postgis-3": No such file or directory',
    expected: true,
  },
  {
    name: 'Wrong root stem',
    platform: 'linux',
    filename: 'postgis-3.so',
    response: 'ERROR: could not access file "$libdir/postgis-30": No such file or directory',
    expected: false,
  },
  {
    name: 'Another module basename contains the expected name',
    platform: 'linux',
    filename: 'postgis-3.so',
    response: 'ERROR: could not load library "/tmp/other_postgis-3.so": No such file or directory',
    expected: false,
  },
  {
    name: 'Wrong module diagnostic with the intended name in echoed LOAD',
    platform: 'linux',
    filename: 'liboliphaunt_postgis_deps.so',
    response:
      'ERROR: could not load library "$libdir/unrelated.so": No such file or directory\nSTATEMENT: LOAD \'$libdir/liboliphaunt_postgis_deps.so\';',
    expected: false,
  },
  {
    name: 'Undefined symbol is not a missing module',
    platform: 'linux',
    filename: 'postgis-3.so',
    response: 'ERROR: could not load library "/tmp/postgis-3.so": undefined symbol: broken',
    expected: false,
  },
  {
    name: 'Missing reason occurs only in echoed SQL',
    platform: 'linux',
    filename: 'postgis-3.so',
    response:
      'ERROR: could not load library "/tmp/postgis-3.so": undefined symbol: broken\nSTATEMENT: SELECT \'No such file or directory\';',
    expected: false,
  },
  {
    name: 'Missing reason occurs only in an unrelated error',
    platform: 'linux',
    filename: 'postgis-3.so',
    response:
      'ERROR: could not load library "/tmp/postgis-3.so": undefined symbol: broken\nERROR: unrelated file: No such file or directory',
    expected: false,
  },
  {
    name: 'macOS direct module without its suffix',
    platform: 'darwin',
    filename: 'postgis-3.dylib',
    response: 'ERROR: could not access file "$libdir/postgis-3": No such file or directory',
    expected: true,
  },
  {
    name: 'macOS multiline imported helper diagnostic',
    platform: 'darwin',
    filename: 'liboliphaunt_postgis_deps.dylib',
    response:
      'ERROR: could not load library "/tmp/path with spaces/postgis-3.dylib": dlopen(/tmp/postgis-3.dylib, 0x0002): Library not loaded: @rpath/liboliphaunt_postgis_deps.dylib\n  Referenced from: /tmp/postgis-3.dylib\n  Reason: tried: /tmp/liboliphaunt_postgis_deps.dylib (no such file)',
    expected: true,
  },
  {
    name: 'macOS image not found continuation',
    platform: 'darwin',
    filename: 'liboliphaunt_postgis_deps.dylib',
    response:
      'ERROR: could not load library "/tmp/postgis-3.dylib": dlopen(/tmp/postgis-3.dylib, 2): Library not loaded: @loader_path/liboliphaunt_postgis_deps.dylib\n  Referenced from: /tmp/postgis-3.dylib\n  Reason: image not found',
    expected: true,
  },
  {
    name: 'Windows reports the selected importing root',
    platform: 'win32',
    filename: 'liboliphaunt_postgis_deps.dll',
    response:
      'ERROR: could not load library "C:\\tmp\\path with spaces\\postgis-3.dll": The specified module could not be found.',
    expected: true,
    ownerRoots,
  },
  {
    name: 'Windows reports the selected companion root',
    platform: 'win32',
    filename: 'liboliphaunt_postgis_deps.dll',
    response:
      'ERROR: could not load library "C:\\tmp\\postgis_raster-3.dll": The specified module could not be found.',
    expected: true,
    ownerRoots,
  },
  {
    name: 'Windows reports a different importing owner',
    platform: 'win32',
    filename: 'liboliphaunt_postgis_deps.dll',
    response:
      'ERROR: could not load library "C:\\tmp\\unrelated.dll": The specified module could not be found.',
    expected: false,
    ownerRoots,
  },
  {
    name: 'Windows wrong root stem',
    platform: 'win32',
    filename: 'postgis-3.dll',
    response:
      'ERROR: could not access file "$libdir/postgis-30": The specified module could not be found.',
    expected: false,
    ownerRoots,
  },
  {
    name: 'Windows missing procedure is not a missing module',
    platform: 'win32',
    filename: 'liboliphaunt_postgis_deps.dll',
    response:
      'ERROR: could not load library "C:\\tmp\\postgis-3.dll": The specified procedure could not be found.',
    expected: false,
    ownerRoots,
  },
  {
    name: 'Echoed LOAD without a loader diagnostic',
    platform: 'linux',
    filename: 'postgis-3.so',
    response: "STATEMENT: LOAD '$libdir/postgis-3.so';\nERROR: unrelated No such file or directory",
    expected: false,
  },
];
for (const test of missingModuleCases)
  assert.equal(
    missingHostModuleError(test.response, test.filename, test.platform, test.ownerRoots),
    test.expected,
    test.name,
  );

function tar(names: string[]): Buffer {
  const members: Buffer[] = [];
  for (const name of names) {
    const body = Buffer.from('candidate');
    const header = Buffer.alloc(512);
    header.write(name, 0, 'ascii');
    for (const offset of [100, 108, 116]) header.write('0000755\0', offset, 'ascii');
    header.write(body.length.toString(8).padStart(11, '0') + '\0', 124, 'ascii');
    header.write('00000000000\0', 136, 'ascii');
    header.fill(0x20, 148, 156);
    header[156] = 0x30;
    header.write('ustar\0', 257, 'ascii');
    header.write('00', 263, 'ascii');
    const sum = header.reduce((total, byte) => total + byte, 0);
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
    members.push(header, body, Buffer.alloc(512 - body.length));
  }
  return Buffer.concat([...members, Buffer.alloc(1024)]);
}

const root = mkdtempSync(join(tmpdir(), 'host-payload-helper-'));
try {
  assert.equal(
    runHostBinary(
      process.execPath,
      ['--no-env-file', '-e', 'console.log("captured stdout")'],
      process.env,
      root,
    ),
    'captured stdout\n',
  );
  assert.throws(
    () =>
      runHostBinary(
        process.execPath,
        [
          '--no-env-file',
          '-e',
          'console.log("captured stdout"); console.error("captured stderr"); process.exit(7)',
        ],
        process.env,
        root,
      ),
    /captured stderr\s+captured stdout/u,
  );
  const controller = join(root, 'controller.mts');
  writeFileSync(
    controller,
    `
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
const [mode, release, done, pidFile, exitCode] = process.argv.slice(2);
if (mode === 'descendant') {
  const finish = (reason) => { writeFileSync(done, reason); process.exit(0); };
  setTimeout(() => finish('deadline'), 10_000);
  setInterval(() => { if (existsSync(release)) finish('released'); }, 10);
} else {
  const descendant = spawn(process.execPath,
    ['--no-env-file', import.meta.path, 'descendant', release, done, pidFile],
    { cwd: tmpdir(), detached: true, stdio: ['ignore', 'inherit', 'inherit'] });
  descendant.unref();
  writeFileSync(pidFile, String(descendant.pid));
  process.exit(Number(exitCode));
}
`,
  );
  for (const exitCode of [0, 7]) {
    const release = join(root, `release-${exitCode}`);
    const done = join(root, `done-${exitCode}`);
    const pidFile = join(root, `pid-${exitCode}`);
    const runController = () =>
      runHostBinary(
        process.execPath,
        ['--no-env-file', controller, 'controller', release, done, pidFile, String(exitCode)],
        process.env,
        root,
        'inherit',
      );
    try {
      if (exitCode === 0) assert.equal(runController(), '');
      else
        assert.throws(
          runController,
          (error) => error instanceof assert.AssertionError && error.actual === exitCode,
        );
      const pid = Number(readFileSync(pidFile, 'utf8'));
      assert(Number.isSafeInteger(pid) && pid > 0);
      assert.doesNotThrow(() => process.kill(pid, 0), 'descendant must outlive its controller');
      assert(!existsSync(done), 'controller return must not wait for descendant output EOF');
    } finally {
      writeFileSync(release, 'release');
      const deadline = Date.now() + 10_000;
      while (!existsSync(done) && Date.now() < deadline) await Bun.sleep(10);
      assert(existsSync(done), 'detached descendant did not finish cleanup');
    }
    assert.equal(readFileSync(done, 'utf8'), 'released');
  }
  const archive = join(root, 'payload.tar');
  const destination = join(root, 'runtime');
  writeFileSync(archive, tar(['bin/probe']));
  await extractNativePayload(archive, destination);
  assert.equal(readFileSync(join(destination, 'bin', 'probe'), 'utf8'), 'candidate');
  writeFileSync(archive, tar(['bin/probe', '../escape']));
  await assert.rejects(extractNativePayload(archive, destination), /unsafe archive member/u);
  assert.equal(
    readFileSync(join(destination, 'bin', 'probe'), 'utf8'),
    'candidate',
    'invalid tar must not replace an existing tree',
  );
  assert(!existsSync(join(root, 'escape')));
  writeFileSync(archive, tar(['bin/probe']).subarray(0, 700));
  await assert.rejects(extractNativePayload(archive, destination), /truncated/u);
  await assert.rejects(extractNativePayload(root, destination), /bounded regular/u);
  console.log('Host payload extraction, loader isolation and missing-candidate oracles: PASS');
} finally {
  rmSync(root, { recursive: true, force: true });
}
