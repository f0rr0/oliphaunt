/** Run the existing installed Expo smoke on a real source checkout and stock app archive. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import path from 'node:path';
import { extractPortableArchiveTree } from '../../tools/packaging/portable-archive.mts';

type Helper = { relative: string; file: string };
function command(binary: string, args: string[], cwd: string, env = process.env) {
  const result = Bun.spawnSync([binary, ...args], { cwd, env, stdout: 'pipe', stderr: 'pipe' });
  assert.equal(
    result.exitCode,
    0,
    `${path.basename(binary)} ${args.join(' ')}:\n${result.stdout}\n${result.stderr}`,
  );
  return result.stdout.toString().trim();
}
const digest = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
export function extractInstalledAppArchive(archive: string, output: string) {
  extractPortableArchiveTree(realpathSync(archive), output, '', { format: 'zip' });
  const roots = [output, path.join(output, 'Payload')];
  const apps = roots.flatMap((root) => {
    try {
      return readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name.endsWith('.app'))
        .map((entry) => path.join(root, entry.name));
    } catch {
      return [];
    }
  });
  assert.equal(
    apps.length,
    1,
    'Stock application archive must contain exactly one actual app bundle',
  );
  return apps[0];
}
export function assertCandidateCheckout(
  root: string,
  sha: string,
  tree: string,
  helpers: Helper[],
  git = '/usr/bin/git',
) {
  assert(
    path.isAbsolute(root),
    'Installed app test requires an explicit actual candidate checkout',
  );
  for (const value of [sha, tree])
    assert.match(value, /^[0-9a-f]{40}$/u, 'Installed app test requires exact candidate SHA/tree');
  assert.equal(
    realpathSync(command(git, ['rev-parse', '--show-toplevel'], root)),
    realpathSync(root),
    'Candidate path must be the real checkout root',
  );
  assert.equal(
    command(git, ['rev-parse', 'HEAD'], root),
    sha,
    'Installed app checkout commit differs',
  );
  assert.equal(
    command(git, ['rev-parse', 'HEAD^{tree}'], root),
    tree,
    'Installed app checkout tree differs',
  );
  assert.equal(
    command(git, ['status', '--porcelain', '--untracked-files=no'], root),
    '',
    'Installed app candidate checkout has tracked modifications',
  );
  for (const helper of helpers) {
    assert(
      helper.relative &&
        !path.isAbsolute(helper.relative) &&
        !helper.relative.split('/').includes('..'),
      'Unsafe declared mobile helper path',
    );
    assert.equal(
      digest(path.join(root, helper.relative)),
      digest(helper.file),
      'Actual candidate helper differs from its declared File: ' + helper.relative,
    );
  }
}

export function simulatorTemplate(value: any) {
  assert(value && typeof value.devices === 'object', 'simctl must return actual device inventory');
  const choices = Object.entries(value.devices)
    .filter(([runtime]) => runtime.startsWith('com.apple.CoreSimulator.SimRuntime.iOS-'))
    .flatMap(([runtime, devices]) =>
      (devices as any[])
        .filter(
          (device) =>
            device.isAvailable === true &&
            typeof device.deviceTypeIdentifier === 'string' &&
            device.deviceTypeIdentifier.startsWith('com.apple.CoreSimulator.SimDeviceType.iPhone-'),
        )
        .map((device) => ({ runtime, type: device.deviceTypeIdentifier })),
    );
  choices.sort(
    (left, right) =>
      right.runtime.localeCompare(left.runtime, 'en', { numeric: true }) ||
      left.type.localeCompare(right.type),
  );
  assert(
    choices.length,
    'Selected Xcode must have an available real iPhone simulator runtime/device type',
  );
  return choices[0];
}

/** The same captured launch must finish background/resume SQL before its PASS. */
export function assertLifecycleReceipt(log: string) {
  const stages = [
    /OLIPHAUNT_EXPO_SMOKE_STAGE.*"stage":"lifecycle:ready"/u,
    /OLIPHAUNT_EXPO_SMOKE_STAGE.*"stage":"lifecycle:state".*"state":"background"/u,
    /OLIPHAUNT_EXPO_SMOKE_STAGE.*"stage":"lifecycle:state".*"state":"active"/u,
    /OLIPHAUNT_EXPO_SMOKE_STAGE.*"stage":"lifecycle:sql:done"/u,
    /OLIPHAUNT_EXPO_SMOKE_PASS/u,
  ];
  let next = 0;
  for (const line of log.split('\n')) {
    if (stages[next]?.test(line)) next++;
  }
  assert.equal(
    next,
    stages.length,
    'Installed smoke omitted ordered background/resume SQL before PASS',
  );
}

async function installedApp(args: string[]) {
  assert.equal(process.platform, 'darwin', 'Actual iOS installed test requires the Mac host');
  const [specFile, archive, sdk, node, receiptFile, ...files] = args;
  const spec = JSON.parse(readFileSync(specFile, 'utf8'));
  const receipt = JSON.parse(readFileSync(receiptFile, 'utf8'));
  const helpers = spec.helpers.map((helper: any) => ({
    relative: helper.relative,
    file: files[helper.index],
  }));
  const checkout = process.env.OLIPHAUNT_MOBILE_CANDIDATE_CHECKOUT ?? '';
  const sha = process.env.OLIPHAUNT_MOBILE_CANDIDATE_SHA ?? '';
  const tree = process.env.OLIPHAUNT_MOBILE_CANDIDATE_TREE ?? '';
  assertCandidateCheckout(checkout, sha, tree, helpers);
  assert(
    receipt.developerDirectory && path.isAbsolute(receipt.developerDirectory),
    'Declared Apple SDK must retain its selected Developer directory',
  );
  const scratch = mkdtempSync(
    path.join(process.env.TEST_TMPDIR ?? '/tmp', 'oliphaunt-ios-installed-'),
  );
  const output = process.env.TEST_UNDECLARED_OUTPUTS_DIR ?? path.join(scratch, 'evidence');
  const env: NodeJS.ProcessEnv = { ...process.env, DEVELOPER_DIR: receipt.developerDirectory };
  for (const name of Object.keys(env))
    if (/^(?:OLIPHAUNT_|EXPO_PUBLIC_|NODE_|BUN_|DYLD_)/u.test(name)) delete env[name];
  const bin = path.join(scratch, 'bin');
  mkdirSync(bin);
  symlinkSync(node, path.join(bin, 'node'));
  symlinkSync(process.execPath, path.join(bin, 'bun'));
  for (const [name, index] of Object.entries(spec.tools))
    symlinkSync(files[index as number], path.join(bin, name));
  env.PATH = bin + ':/usr/bin:/bin:/usr/sbin:/sbin';
  env.TMPDIR = scratch;
  const xcrun = path.join(bin, 'xcrun');
  const simctl = receipt.components.find((component: any) => component.name === 'tools/simctl');
  assert(simctl, 'Selected Apple capture must declare its actual simulator tool');
  const selectedSimctl = command(xcrun, ['--find', 'simctl'], checkout, env);
  assert.equal(
    realpathSync(selectedSimctl),
    simctl.resolvedPath,
    'Installed smoke must execute the captured selected Xcode simulator tool',
  );
  assert.equal(
    digest(selectedSimctl),
    receipt.observations.simctl_sha256,
    'Selected simulator tool bytes changed after capture',
  );
  let simulator = '';
  try {
    const template = simulatorTemplate(
      JSON.parse(command(xcrun, ['simctl', 'list', 'devices', 'available', '-j'], checkout, env)),
    );
    simulator = command(
      xcrun,
      ['simctl', 'create', 'Oliphaunt-Bazel-' + randomUUID(), template.type, template.runtime],
      checkout,
      env,
    );
    assert.match(
      simulator,
      /^[0-9A-Fa-f-]{36}$/u,
      'simctl create must return the actual owned simulator',
    );
    console.log(`Installed iOS simulator ${simulator}: ${template.type} (${template.runtime})`);
    const extracted = path.join(scratch, 'app');
    const app = extractInstalledAppArchive(archive, extracted);
    const pack = path.join(scratch, 'pack');
    mkdirSync(pack);
    // Original metrics uses the SDK's actual package name/version to find this
    // genuine archive. Preserve its bytes and conventional manifest unchanged.
    const packageManifest = JSON.parse(
      readFileSync(path.join(checkout, 'src/native/sdks/react-native/package.json'), 'utf8'),
    );
    symlinkSync(
      sdk,
      path.join(
        pack,
        packageManifest.name.replace(/^@/u, '').replace('/', '-') +
          '-' +
          packageManifest.version +
          '.tgz',
      ),
    );
    Object.assign(env, {
      OLIPHAUNT_EXPO_IOS_APP: app,
      OLIPHAUNT_EXPO_IOS_CONFIGURATION: 'Release',
      OLIPHAUNT_EXPO_IOS_SDK: 'iphonesimulator',
      OLIPHAUNT_EXPO_IOS_RUNNER: 'smoke',
      OLIPHAUNT_EXPO_IOS_EXTENSIONS: spec.extensions.join(','),
      OLIPHAUNT_EXPO_IOS_SIMULATOR_UDID: simulator,
      OLIPHAUNT_EXPO_IOS_LIFECYCLE_SMOKE: '1',
      OLIPHAUNT_EXPO_IOS_CLEAN_INSTALL: '1',
      OLIPHAUNT_EXPO_IOS_SCRATCH: output,
      OLIPHAUNT_EXPO_IOS_PACK_DIR: pack,
      OLIPHAUNT_MOBILE_E2E_CANDIDATE_SHA: sha,
    });
    const child = Bun.spawn(
      ['/bin/bash', path.join(checkout, 'src/native/sdks/react-native/tools/mobile-e2e.sh'), 'ios'],
      { cwd: checkout, env, stdout: 'inherit', stderr: 'inherit' },
    );
    assert.equal(
      await child.exited,
      0,
      'Original actual installed app lifecycle/SQL/receipt qualification failed',
    );
    assertLifecycleReceipt(
      readFileSync(path.join(output, 'logs/smoke-simulator-unified.log'), 'utf8'),
    );
    assertCandidateCheckout(checkout, sha, tree, helpers);
  } finally {
    if (simulator) {
      Bun.spawnSync([xcrun, 'simctl', 'shutdown', simulator], {
        cwd: checkout,
        env,
        stdout: 'ignore',
        stderr: 'inherit',
      });
      command(xcrun, ['simctl', 'delete', simulator], checkout, env);
    }
    rmSync(scratch, { recursive: true, force: true });
  }
}
if (import.meta.main) await installedApp(process.argv.slice(2));
