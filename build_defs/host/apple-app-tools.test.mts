import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { APPLE_APP_TOOL_NAMES, captureAppleAppTools } from './apple-app-tools.mts';

function fixture(run: (root: string, developer: string, files: Record<string, string>) => void) {
  const root = mkdtempSync(path.join(tmpdir(), 'apple-app-tools-'));
  try {
    const developer = path.join(root, 'Xcode/Contents/Developer');
    const files: Record<string, string> = {};
    for (const name of APPLE_APP_TOOL_NAMES) {
      const directory = name === 'codesign' || name === 'ditto' ? root : developer;
      mkdirSync(directory, { recursive: true });
      files[name] = path.join(directory, name);
      writeFileSync(files[name], 'original ' + name);
    }
    run(root, developer, files);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('captures exact original application tools as inputs without adding them to C/Swift compiler closure', () => {
  fixture((_root, developer, files) => {
    const captured = captureAppleAppTools(developer, (name) => files[name]);
    expect(captured.components).toHaveLength(APPLE_APP_TOOL_NAMES.length);
    expect(captured.components.every((row) => !row.directory && row.roles.length === 0)).toBeTrue();
    expect(captured.observations.actool_sha256).toBe(
      createHash('sha256').update('original actool').digest('hex'),
    );
    writeFileSync(files.actool, 'different tool bytes');
    expect(
      captureAppleAppTools(developer, (name) => files[name]).observations.actool_sha256,
    ).not.toBe(captured.observations.actool_sha256);
  });
});
test('rejects a compiler from another Xcode even through a symlink inside the selected developer tree', () => {
  fixture((root, developer, files) => {
    const outside = path.join(root, 'other-actool');
    writeFileSync(outside, 'other Xcode');
    rmSync(files.actool);
    symlinkSync(outside, files.actool);
    expect(() => captureAppleAppTools(developer, (name) => files[name])).toThrow(/selected Xcode/);
  });
});
test('rejects directories and missing actual executables', () => {
  fixture((_root, developer, files) => {
    expect(() =>
      captureAppleAppTools(developer, (name) => (name === 'actool' ? developer : files[name])),
    ).toThrow(/must be a file/);
    rmSync(files.actool);
    expect(() => captureAppleAppTools(developer, (name) => files[name])).toThrow();
  });
});
