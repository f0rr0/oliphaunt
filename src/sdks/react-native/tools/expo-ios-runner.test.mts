import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function run(command, ...args) {
  return spawnSync(
    process.execPath,
    [path.join(import.meta.dirname, 'expo-ios-runner.mts'), command, ...args],
    { encoding: 'utf8' },
  );
}

test('CocoaPods lock binds the app-owned payload locally and excludes a duplicate ICU pod', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'expo-pod-source-'));
  try {
    const lock = path.join(root, 'Podfile.lock');
    const valid = 'EXTERNAL SOURCES:\n  OliphauntReactNativePayload:\n    :path: oliphaunt\n';
    writeFileSync(lock, valid);
    const check = () => run('validate-pod-source', lock, path.join(root, 'oliphaunt'), '1');
    expect(check().status).toBe(0);
    for (const value of [
      valid.replace(':path: oliphaunt', ':path: ../elsewhere'),
      valid + '    :git: https://example.invalid/payload.git\n',
      valid + 'PODS:\n  - OliphauntICU (1.0)\n',
      valid + 'SPEC CHECKSUMS:\n  OliphauntICU: abc\n',
    ]) {
      writeFileSync(lock, value);
      expect(check().status).not.toBe(0);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Swift 6.2 adaptation is recursive and idempotent without changing ordinary references', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'expo-swift-weak-'));
  try {
    mkdirSync(path.join(root, 'nested'));
    const file = path.join(root, 'nested', 'Refs.swift');
    writeFileSync(
      file,
      'weak let first: Object?\nnonisolated(unsafe) weak var second: Object?\nlet third: Object?\n',
    );
    for (let index = 0; index < 2; index += 1)
      expect(run('patch-weak-references', root).status).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe(
      'nonisolated(unsafe) weak var first: Object?\nnonisolated(unsafe) weak var second: Object?\nlet third: Object?\n',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
