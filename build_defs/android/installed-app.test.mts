import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assertLifecycleReceipt } from '../apple/installed-app.mts';
import {
  assertInstalledApk,
  assertKvmAvailable,
  captureInstalledAndroidFailure,
  emulatorArguments,
  stageSdkFiles,
  unusedPort,
} from './installed-app.mts';

test('installed test binds the exact final signed APK, selected extensions and emulator ABI', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'android-installed-contract-'));
  try {
    const apk = path.join(root, 'final.apk'),
      file = path.join(root, 'proof.json');
    writeFileSync(apk, 'real File fixture, not a device execution claim');
    const proof = {
      schema: 'oliphaunt-expo-android-apk-proof-v1',
      abi: 'x86_64',
      applicationId: 'dev.oliphaunt.reactnative.example',
      selectedExtensions: ['vector'],
      apkSha256: createHash('sha256').update(readFileSync(apk)).digest('hex'),
    };
    writeFileSync(file, JSON.stringify(proof));
    assert.equal(assertInstalledApk(apk, file, ['vector']).apkSha256, proof.apkSha256);
    assert.throws(() => assertInstalledApk(apk, file, []));
    writeFileSync(file, JSON.stringify({ ...proof, abi: 'arm64-v8a' }));
    assert.throws(() => assertInstalledApk(apk, file, ['vector']), /emulator ABI/u);
    writeFileSync(file, JSON.stringify(proof));
    writeFileSync(apk, 'substituted APK');
    assert.throws(() => assertInstalledApk(apk, file, ['vector']), /exact final/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('read-only SDK inputs retain declared paths while only the avdmanager launcher is copied', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'android-sdk-transport-'));
  try {
    const file = path.join(root, 'original');
    writeFileSync(file, 'original declared bytes');
    const output = path.join(root, 'sdk');
    stageSdkFiles(
      output,
      [
        { relative: 'cmdline-tools/latest/bin/avdmanager', index: 0 },
        { relative: 'system-images/android-35/google_atd/x86_64/system.img', index: 0 },
      ],
      [file],
    );
    assert.equal(
      readFileSync(path.join(output, 'cmdline-tools/latest/bin/avdmanager'), 'utf8'),
      readFileSync(file, 'utf8'),
    );
    assert.equal(
      readFileSync(
        path.join(output, 'system-images/android-35/google_atd/x86_64/system.img'),
        'utf8',
      ),
      readFileSync(file, 'utf8'),
    );
    assert.throws(
      () => stageSdkFiles(path.join(root, 'escape'), [{ relative: '../escape', index: 0 }], [file]),
      /Unsafe/u,
    );
    assert.throws(
      () =>
        stageSdkFiles(
          path.join(root, 'duplicate'),
          [
            { relative: 'file', index: 0 },
            { relative: 'file', index: 0 },
          ],
          [file],
        ),
      /Repeated/u,
    );
    const directory = path.join(root, 'directory');
    mkdirSync(directory);
    assert.throws(
      () => stageSdkFiles(path.join(root, 'dir'), [{ relative: 'file', index: 0 }], [directory]),
      /regular/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('private emulator launch always uses KVM and requires actual lifecycle receipt stages', () => {
  const args = emulatorArguments('oliphaunt-bazel-1234abcd', 5554, '/private/sdk');
  assert(args.includes('-wipe-data'));
  assert(args.includes('-no-snapshot'));
  assert.equal(args[args.indexOf('-accel') + 1], 'on');
  assert.equal(args[args.indexOf('-port') + 1], '5554');
  for (const port of [5555, 0, 5682])
    assert.throws(() => emulatorArguments('oliphaunt-bazel-1234abcd', port, '/sdk'));
  assert.throws(
    () => assertKvmAvailable('/definitely-absent-oliphaunt-kvm'),
    /No device test was executed/u,
  );
  const events = [
    { stage: 'lifecycle:ready', state: 'active' },
    { stage: 'lifecycle:state', state: 'background' },
    { stage: 'lifecycle:state', state: 'active' },
    { stage: 'lifecycle:sql:done' },
  ];
  const lines = events.map((event) => 'OLIPHAUNT_EXPO_SMOKE_STAGE ' + JSON.stringify(event));
  lines.push('OLIPHAUNT_EXPO_SMOKE_PASS {"lifecycleResume":true}');
  const stages = lines.join('\n');
  assertLifecycleReceipt(stages);
  assert.throws(() => assertLifecycleReceipt('OLIPHAUNT_EXPO_SMOKE_PASS {}'), /omitted/u);
  assert.throws(
    () => assertLifecycleReceipt(stages.replaceAll('background', 'active')),
    /background/u,
  );
  assert.throws(
    () => assertLifecycleReceipt(stages.replaceAll('background', 'inactive')),
    /background/u,
  );
  for (let omitted = 0; omitted < lines.length; omitted++)
    assert.throws(
      () => assertLifecycleReceipt(lines.filter((_, index) => index !== omitted).join('\n')),
      /ordered/u,
    );
  for (let index = 0; index < lines.length - 1; index++) {
    const reordered = [...lines];
    [reordered[index], reordered[index + 1]] = [reordered[index + 1], reordered[index]];
    assert.throws(() => assertLifecycleReceipt(reordered.join('\n')), /ordered/u);
  }
});

test.skipIf(process.platform !== 'linux')(
  'private ADB ports exclude services on either localhost address family',
  async () => {
    for (const host of ['127.0.0.1', '::1']) {
      const occupied = net.createServer();
      await new Promise<void>((resolve, reject) => {
        occupied.once('error', reject);
        occupied.listen({ host, port: 0, ipv6Only: host === '::1' }, resolve);
      });
      const address = occupied.address();
      assert(address && typeof address !== 'string');
      try {
        await assert.rejects(unusedPort(address.port), { code: 'EADDRINUSE' });
        assert.notEqual(await unusedPort(), address.port);
      } finally {
        await new Promise<void>((resolve) => occupied.close(() => resolve()));
      }
    }
  },
);

test.skipIf(process.platform !== 'linux')(
  'failure diagnostics retain bounded Linux device output from a failed adb',
  () => {
    const root = mkdtempSync(path.join(tmpdir(), 'android-installed-failure-'));
    try {
      const adb = path.join(root, 'fixture-adb');
      writeFileSync(adb, '#!/bin/sh\nprintf "%s\\n" "$ADB_SERVER_SOCKET" "$*"\nexit 7\n');
      chmodSync(adb, 0o755);
      captureInstalledAndroidFailure(adb, '127.0.0.1:5555', root, root, {
        ADB_SERVER_SOCKET: 'tcp:localhost:56789',
      });
      assert.equal(
        readFileSync(path.join(root, 'failure-logcat.log'), 'utf8'),
        'tcp:localhost:56789\n-s 127.0.0.1:5555 logcat -d -v threadtime -t 2000\n',
      );
      assert.equal(
        readFileSync(path.join(root, 'failure-activity.txt'), 'utf8'),
        'tcp:localhost:56789\n-s 127.0.0.1:5555 shell dumpsys activity top\n',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test('failure diagnostics retain a missing adb error on every host', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'android-installed-missing-adb-'));
  try {
    captureInstalledAndroidFailure(path.join(root, 'missing-adb'), 'fixture', root, root, {});
    for (const file of ['failure-logcat.log', 'failure-activity.txt'])
      assert(readFileSync(path.join(root, file), 'utf8').includes('ENOENT'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
