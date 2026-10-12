/** Execute the existing installed-app assertions on the final Bazel APK. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  accessSync,
  chmodSync,
  constants,
  copyFileSync,
  createReadStream,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { assertCandidateCheckout } from '../apple/installed-app.mts';
import { verifyAndroidEmulator } from '../languages/jvm/android-sdk-metadata.mts';

const digest = (file: string) =>
  createHash('sha256')
    .update(readFileSync(realpathSync(file)))
    .digest('hex');
const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

export function assertKvmAvailable(device = '/dev/kvm') {
  try {
    assert(lstatSync(device).isCharacterDevice());
    accessSync(device, constants.R_OK | constants.W_OK);
  } catch {
    throw new Error(
      'Installed Android qualification requires readable/writable /dev/kvm; provision runner KVM access. No device test was executed.',
    );
  }
}

export function assertInstalledApk(apk: string, proofFile: string, extensions: string[]) {
  const proof = JSON.parse(readFileSync(proofFile, 'utf8'));
  assert.equal(proof.schema, 'oliphaunt-expo-android-apk-proof-v1');
  assert.equal(proof.abi, 'x86_64', 'Installed APK must target its actual emulator ABI');
  assert.equal(proof.applicationId, 'dev.oliphaunt.reactnative.example');
  assert.deepEqual(proof.selectedExtensions, [...extensions].sort());
  assert.equal(
    proof.apkSha256,
    digest(apk),
    'Installed APK differs from the exact final signed/verified File',
  );
  return proof;
}

export function stageSdkFiles(
  root: string,
  rows: { relative: string; index: number }[],
  files: string[],
) {
  const names = new Set<string>();
  for (const row of rows) {
    assert(
      row.relative &&
        !path.isAbsolute(row.relative) &&
        !row.relative.includes('\\') &&
        row.relative.split('/').every((part) => part && part !== '.' && part !== '..'),
      'Unsafe declared Android SDK path',
    );
    assert(!names.has(row.relative), 'Repeated declared Android SDK File');
    names.add(row.relative);
    const source = realpathSync(files[row.index]);
    assert(lstatSync(source).isFile(), 'Declared Android SDK input must resolve to a regular File');
    const destination = path.join(root, row.relative);
    mkdirSync(path.dirname(destination), { recursive: true });
    // The launcher discovers its SDK through its own path; image/tool bytes stay read-only aliases.
    if (row.relative.endsWith('/bin/avdmanager')) {
      copyFileSync(source, destination);
      chmodSync(destination, 0o755);
    } else symlinkSync(source, destination);
  }
}

export function emulatorArguments(name: string, port: number, sdk: string) {
  assert(/^oliphaunt-bazel-[a-f0-9-]+$/u.test(name));
  assert(Number.isInteger(port) && port >= 5554 && port <= 5680 && port % 2 === 0);
  return [
    '-avd',
    name,
    '-port',
    String(port),
    '-no-window',
    '-no-audio',
    '-no-boot-anim',
    '-no-snapshot',
    '-no-snapshot-load',
    '-no-snapshot-save',
    '-wipe-data',
    '-no-cache',
    '-no-metrics',
    '-accel',
    'on',
    '-gpu',
    'software',
    '-partition-size',
    '6144',
    '-sysdir',
    path.join(sdk, 'system-images/android-35/google_atd/x86_64'),
  ];
}

export function assertLifecycleReceipt(log: string) {
  for (const stage of ['lifecycle:ready', 'lifecycle:sql:done'])
    assert(
      new RegExp(`OLIPHAUNT_EXPO_SMOKE_STAGE.*"stage":"${stage}"`, 'u').test(log),
      `Installed smoke omitted actual ${stage}`,
    );
  assert(
    /OLIPHAUNT_EXPO_SMOKE_STAGE.*"stage":"lifecycle:state".*"state":"(?:background|inactive)"/u.test(
      log,
    ),
    'Installed smoke omitted actual background transition',
  );
}

async function unusedPort(port = 0) {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert(address && typeof address !== 'string');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function emulatorPort() {
  for (let port = 5554; port <= 5680; port += 2) {
    try {
      await unusedPort(port);
      await unusedPort(port + 1);
      return port;
    } catch {
      /* Try the next owned console/ADB pair. */
    }
  }
  throw new Error('No private emulator console/ADB port pair is available');
}

function command(
  binary: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  input?: string,
  timeout = 30_000,
) {
  const result = Bun.spawnSync([binary, ...args], {
    cwd,
    env,
    stdin: input ? new TextEncoder().encode(input) : 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    timeout,
    killSignal: 'SIGKILL',
  });
  assert.equal(
    result.exitCode,
    0,
    `${path.basename(binary)} ${args.join(' ')}:\n${result.stdout}\n${result.stderr}`,
  );
  return result.stdout.toString().trim();
}

async function fileDigest(file: string) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(realpathSync(file))) hash.update(bytes);
  return hash.digest('hex');
}

export async function runInstalledAndroid(args: string[]) {
  assert.equal(process.platform, 'linux');
  assert.equal(process.arch, 'x64');
  assertKvmAvailable();
  const [specFile, apkFile, proofFile, sdkPackage, node, metadataFile, adbFile, ...files] = args;
  const spec = JSON.parse(readFileSync(specFile, 'utf8'));
  const metadata = JSON.parse(readFileSync(metadataFile, 'utf8'));
  const apk = realpathSync(apkFile);
  const proof = assertInstalledApk(apk, proofFile, spec.extensions);
  const helpers = spec.helpers.map((helper: any) => ({
    relative: helper.relative,
    file: files[helper.index],
  }));
  const checkout = process.env.OLIPHAUNT_MOBILE_CANDIDATE_CHECKOUT ?? '';
  const sha = process.env.OLIPHAUNT_MOBILE_CANDIDATE_SHA ?? '';
  const tree = process.env.OLIPHAUNT_MOBILE_CANDIDATE_TREE ?? '';
  assertCandidateCheckout(checkout, sha, tree, helpers);
  assert.equal(metadata.api, 35);
  assert.equal(metadata.tag, 'google_atd');
  assert.equal(metadata.abi, 'x86_64');
  assert(
    Number.isInteger(spec.timeoutSeconds) &&
      spec.timeoutSeconds >= 60 &&
      spec.timeoutSeconds <= 800,
  );
  const scratch = mkdtempSync(
    path.join(process.env.TEST_TMPDIR ?? '/tmp', 'oliphaunt-android-installed-'),
  );
  try {
    const output = process.env.TEST_UNDECLARED_OUTPUTS_DIR ?? path.join(scratch, 'evidence');
    mkdirSync(output, { recursive: true });
    const sdk = path.join(scratch, 'sdk'),
      home = path.join(scratch, 'home'),
      bin = path.join(scratch, 'bin');
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const name of Object.keys(env))
      if (/^(?:OLIPHAUNT_|EXPO_PUBLIC_|NODE_|BUN_|ANDROID_|ADB_|JAVA_|JDK_|LD_)/u.test(name))
        delete env[name];
    mkdirSync(home);
    mkdirSync(bin);
    mkdirSync(path.join(scratch, 'tmp'));
    mkdirSync(path.join(home, 'avd'));
    stageSdkFiles(sdk, spec.sdkFiles, files);
    verifyAndroidEmulator(sdk, metadata);
    symlinkSync(realpathSync(node), path.join(bin, 'node'));
    symlinkSync(process.execPath, path.join(bin, 'bun'));
    const adb = realpathSync(adbFile),
      serverPort = await unusedPort(),
      port = await emulatorPort();
    const serial = `127.0.0.1:${port + 1}`;
    const adbWrapper = path.join(sdk, 'platform-tools/adb');
    rmSync(adbWrapper);
    writeFileSync(
      adbWrapper,
      `#!/bin/sh\nexec ${shellQuote(adb)} -P ${shellQuote(String(serverPort))} "$@"\n`,
      { mode: 0o755 },
    );
    Object.assign(env, {
      HOME: home,
      TMPDIR: path.join(scratch, 'tmp'),
      PATH: bin + ':/usr/bin:/bin:/usr/sbin:/sbin',
      JAVA_HOME: path.dirname(path.dirname(realpathSync(files[spec.java]))),
      JAVA_TOOL_OPTIONS:
        '-Dhttp.proxyHost=127.0.0.1 -Dhttp.proxyPort=9 -Dhttps.proxyHost=127.0.0.1 -Dhttps.proxyPort=9',
      ANDROID_HOME: sdk,
      ANDROID_SDK_ROOT: sdk,
      ANDROID_USER_HOME: home,
      ANDROID_EMULATOR_HOME: home,
      ANDROID_AVD_HOME: path.join(home, 'avd'),
      ANDROID_SERIAL: serial,
      ADB_SERVER_SOCKET: `tcp:127.0.0.1:${serverPort}`,
      ANDROID_ADB_SERVER_PORT: String(serverPort),
    });
    const avd = 'oliphaunt-bazel-' + randomUUID();
    const emulator = path.join(sdk, 'emulator/emulator');
    let processHandle: ReturnType<typeof Bun.spawn> | undefined;
    const deadline = Date.now() + spec.timeoutSeconds * 1000;
    const remaining = () => {
      const value = deadline - Date.now();
      assert(value > 0, 'Installed Android qualification exceeded its bounded budget');
      return value;
    };
    try {
      command(
        path.join(sdk, 'cmdline-tools/latest/bin/avdmanager'),
        [
          'create',
          'avd',
          '--name',
          avd,
          '--package',
          `system-images;android-${metadata.api};${metadata.tag};${metadata.abi}`,
          '--path',
          path.join(env.ANDROID_AVD_HOME!, avd + '.avd'),
          '--force',
          '--device',
          'pixel_2',
        ],
        checkout,
        env,
        'no\n',
        Math.min(120_000, remaining()),
      );
      command(adb, ['-P', String(serverPort), 'start-server'], checkout, env);
      const emulatorLog = Bun.file(path.join(output, 'emulator.log'));
      processHandle = Bun.spawn([emulator, ...emulatorArguments(avd, port, sdk)], {
        cwd: scratch,
        env,
        stdout: emulatorLog,
        stderr: emulatorLog,
      });
      let booted = false;
      while (Date.now() < deadline) {
        assert(
          processHandle.exitCode === null,
          'Pinned emulator exited before boot; inspect emulator.log',
        );
        Bun.spawnSync([adb, '-P', String(serverPort), 'connect', serial], {
          cwd: scratch,
          env,
          stdout: 'ignore',
          stderr: 'ignore',
          timeout: Math.min(10_000, remaining()),
          killSignal: 'SIGKILL',
        });
        const boot = Bun.spawnSync(
          [adb, '-P', String(serverPort), '-s', serial, 'shell', 'getprop', 'sys.boot_completed'],
          {
            cwd: scratch,
            env,
            stdout: 'pipe',
            stderr: 'ignore',
            timeout: Math.min(10_000, remaining()),
            killSignal: 'SIGKILL',
          },
        );
        if (boot.exitCode === 0 && boot.stdout.toString().trim() === '1') {
          booted = true;
          break;
        }
        await Bun.sleep(2000);
      }
      assert(booted, 'Pinned Android emulator failed to boot within the bounded budget');
      const actualAbi = command(
        adb,
        ['-P', String(serverPort), '-s', serial, 'shell', 'getprop', 'ro.product.cpu.abi'],
        checkout,
        env,
      );
      const actualApi = command(
        adb,
        ['-P', String(serverPort), '-s', serial, 'shell', 'getprop', 'ro.build.version.sdk'],
        checkout,
        env,
      );
      assert.equal(actualAbi, metadata.abi);
      assert.equal(actualApi, String(metadata.api));
      const pack = path.join(scratch, 'pack');
      mkdirSync(pack);
      const packageManifest = JSON.parse(
        readFileSync(path.join(checkout, 'src/native/sdks/react-native/package.json'), 'utf8'),
      );
      symlinkSync(
        realpathSync(sdkPackage),
        path.join(
          pack,
          packageManifest.name.replace(/^@/u, '').replace('/', '-') +
            '-' +
            packageManifest.version +
            '.tgz',
        ),
      );
      Object.assign(env, {
        CI_HEAD_SHA: sha,
        OLIPHAUNT_MOBILE_E2E_CANDIDATE_SHA: sha,
        OLIPHAUNT_EXPO_ANDROID_APK: apk,
        OLIPHAUNT_EXPO_ANDROID_BUILD_TYPE: 'release',
        OLIPHAUNT_EXPO_ANDROID_RUNNER: 'smoke',
        OLIPHAUNT_EXPO_ANDROID_EXTENSIONS: spec.extensions.join(','),
        OLIPHAUNT_EXPO_ANDROID_LIFECYCLE_SMOKE: '1',
        OLIPHAUNT_EXPO_ANDROID_SCRATCH: output,
        OLIPHAUNT_EXPO_ANDROID_PACK_DIR: pack,
        OLIPHAUNT_EXPO_ANDROID_TIMEOUT_SECONDS: String(spec.timeoutSeconds),
      });
      const child = Bun.spawn(
        [
          '/bin/bash',
          path.join(checkout, 'src/native/sdks/react-native/tools/mobile-e2e.sh'),
          'android',
        ],
        {
          cwd: checkout,
          env,
          stdout: 'inherit',
          stderr: 'inherit',
          timeout: remaining(),
          killSignal: 'SIGKILL',
        },
      );
      assert.equal(
        await child.exited,
        0,
        'Original installed Android SQL/reopen/lifecycle qualification failed',
      );
      assertLifecycleReceipt(readFileSync(path.join(output, 'logs/smoke-logcat.log'), 'utf8'));
      assertInstalledApk(apk, proofFile, spec.extensions);
      assertCandidateCheckout(checkout, sha, tree, helpers);
      const identities = await Promise.all(
        [
          'emulator/emulator',
          'emulator/qemu/linux-x86_64/qemu-system-x86_64-headless',
          `${metadata.imagePath}/system.img`,
          `${metadata.imagePath}/vendor.img`,
          `${metadata.imagePath}/kernel-ranchu`,
          `${metadata.imagePath}/ramdisk.img`,
        ].map(async (relative) => ({
          relative,
          sha256: await fileDigest(path.join(sdk, relative)),
        })),
      );
      writeFileSync(
        path.join(output, 'installed-apk.json'),
        JSON.stringify(
          {
            schema: 'oliphaunt-native-installed-android-apk-v1',
            source: { commit: sha, tree },
            apkSha256: proof.apkSha256,
            adbSha256: digest(adb),
            acquisition: metadata,
            actualDevice: { serial, abi: actualAbi, api: Number(actualApi) },
            files: identities,
            lifecycle: true,
            extensionReceipt: JSON.parse(
              readFileSync(path.join(output, 'reports/smoke-extension-receipt.json'), 'utf8'),
            ),
          },
          null,
          2,
        ) + '\n',
      );
    } finally {
      Bun.spawnSync([adb, '-P', String(serverPort), '-s', `emulator-${port}`, 'emu', 'kill'], {
        cwd: scratch,
        env,
        stdout: 'ignore',
        stderr: 'ignore',
        timeout: 5000,
        killSignal: 'SIGKILL',
      });
      if (processHandle && processHandle.exitCode === null) {
        processHandle.kill();
        await Promise.race([processHandle.exited, Bun.sleep(5000)]);
        if (processHandle.exitCode === null) {
          processHandle.kill('SIGKILL');
          await processHandle.exited;
        }
      }
      Bun.spawnSync([adb, '-P', String(serverPort), 'kill-server'], {
        cwd: scratch,
        env,
        stdout: 'ignore',
        stderr: 'ignore',
        timeout: 5000,
        killSignal: 'SIGKILL',
      });
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) await runInstalledAndroid(process.argv.slice(2));
