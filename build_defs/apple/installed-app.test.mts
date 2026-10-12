import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDeterministicZip } from '../../tools/packaging/archive-directory.mts';
import {
  assertCandidateCheckout,
  extractInstalledAppArchive,
  simulatorTemplate,
} from './installed-app.mts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ios-real-checkout-'));
  roots.push(root);
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(['/usr/bin/git', ...args], {
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (result.exitCode) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  };
  git('init', '-q');
  writeFileSync(path.join(root, 'runner.sh'), '# original candidate helper\n');
  git('add', 'runner.sh');
  git(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-qm',
    'fixture',
  );
  const declared = path.join(root, 'declared.sh');
  writeFileSync(declared, readFileSync(path.join(root, 'runner.sh')));
  return {
    root,
    sha: git('rev-parse', 'HEAD'),
    tree: git('rev-parse', 'HEAD^{tree}'),
    helpers: [{ relative: 'runner.sh', file: declared }],
  };
}
describe('actual installed app qualification boundary', () => {
  test('extracts a stock app archive through its declared runfiles File alias', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'installed-app-alias-'));
    roots.push(root);
    const bundle = path.join(root, 'bundle/Payload/Smoke.app');
    mkdirSync(bundle, { recursive: true });
    writeFileSync(path.join(bundle, 'Smoke'), 'fixture executable');
    const archive = path.join(root, 'archive-output');
    writeFileSync(archive, await createDeterministicZip(path.join(root, 'bundle')));
    const alias = path.join(root, 'runfiles-app.ipa');
    symlinkSync(archive, alias);
    const output = path.join(root, 'extracted');
    const app = extractInstalledAppArchive(alias, output);
    expect(app).toBe(path.join(output, 'Payload/Smoke.app'));
    expect(readFileSync(path.join(app, 'Smoke'), 'utf8')).toBe('fixture executable');
  });
  test('accepts the real clean candidate and identical declared helper Files', () => {
    const f = fixture();
    assertCandidateCheckout(f.root, f.sha, f.tree, f.helpers);
  });
  test('rejects a different commit and a different source tree', () => {
    const f = fixture();
    expect(() => assertCandidateCheckout(f.root, '0'.repeat(40), f.tree, f.helpers)).toThrow(
      /commit differs/,
    );
    expect(() => assertCandidateCheckout(f.root, f.sha, '0'.repeat(40), f.helpers)).toThrow(
      /tree differs/,
    );
  });
  test('does not accept a package subdirectory as candidate root', () => {
    const f = fixture();
    const child = path.join(f.root, 'subdirectory');
    mkdirSync(child);
    expect(() => assertCandidateCheckout(child, f.sha, f.tree, f.helpers)).toThrow(
      /real checkout root/,
    );
  });
  test('detects source modifications after the initial guard', () => {
    const f = fixture();
    assertCandidateCheckout(f.root, f.sha, f.tree, f.helpers);
    writeFileSync(path.join(f.root, 'runner.sh'), '# changed during smoke\n');
    expect(() => assertCandidateCheckout(f.root, f.sha, f.tree, f.helpers)).toThrow(
      /tracked modifications/,
    );
  });
  test('rejects a declared helper from a different candidate even when checkout is clean', () => {
    const f = fixture();
    writeFileSync(f.helpers[0].file, '# different compiler input\n');
    expect(() => assertCandidateCheckout(f.root, f.sha, f.tree, f.helpers)).toThrow(
      /declared File/,
    );
  });
  test('uses a genuinely available iOS runtime/type and excludes other platforms', () => {
    const rows = {
      'com.apple.CoreSimulator.SimRuntime.visionOS-99-0': [
        { isAvailable: true, deviceTypeIdentifier: 'vision' },
      ],
      'com.apple.CoreSimulator.SimRuntime.iOS-26-3': [
        { isAvailable: true, deviceTypeIdentifier: 'iphone' },
      ],
      'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [
        { isAvailable: false, deviceTypeIdentifier: 'newer-unavailable' },
      ],
      'com.apple.CoreSimulator.SimRuntime.iOS-26-4': [
        { isAvailable: true, deviceTypeIdentifier: 'iphone' },
      ],
    };
    expect(simulatorTemplate({ devices: rows })).toEqual({
      runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-26-4',
      type: 'iphone',
    });
    expect(
      simulatorTemplate({ devices: Object.fromEntries(Object.entries(rows).reverse()) }),
    ).toEqual(simulatorTemplate({ devices: rows }));
    expect(() => simulatorTemplate({ devices: {} })).toThrow(/available real iOS/);
  });
});
