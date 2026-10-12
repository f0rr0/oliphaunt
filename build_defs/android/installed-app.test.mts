import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'bun:test';
import {
  assertInstalledApk,
  assertKvmAvailable,
  assertLifecycleReceipt,
  emulatorArguments,
  stageSdkFiles,
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
  const stages = ['lifecycle:ready', 'lifecycle:state', 'lifecycle:sql:done']
    .map((stage) => 'OLIPHAUNT_EXPO_SMOKE_STAGE ' + JSON.stringify({ stage, state: 'background' }))
    .join('\n');
  assertLifecycleReceipt(stages);
  assert.throws(() => assertLifecycleReceipt('OLIPHAUNT_EXPO_SMOKE_PASS {}'), /omitted/u);
  assert.throws(
    () => assertLifecycleReceipt(stages.replaceAll('background', 'active')),
    /background/u,
  );
});
