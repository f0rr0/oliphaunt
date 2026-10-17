import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkRuntimePinPolicy } from './runtime-pin-policy.mts';

const sourceRoot = path.resolve(import.meta.dir, '../..');
const script = path.join(import.meta.dir, 'runtime-pin-policy.mts');
const inputs = [
  '.prototools',
  '.bazelversion',
  'tools/dev/bun.toml',
  'tools/dev/deno.toml',
  'tools/dev/node-runtime.toml',
  'tools/dev/bazel-checksums.tsv',
  'tools/dev/winflexbison.toml',
];
const temporaryRoots: string[] = [];

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'runtime-pin-policy-'));
  temporaryRoots.push(root);
  mkdirSync(path.join(root, 'tools/dev'), { recursive: true });
  for (const input of inputs)
    writeFileSync(path.join(root, input), readFileSync(path.join(sourceRoot, input)), {
      flag: 'wx',
      mode: 0o644,
    });
  return root;
}

function mutate(root: string, file: string, change: (text: string) => string) {
  const target = path.join(root, file);
  const original = readFileSync(target, 'utf8');
  const modified = change(original);
  expect(modified).not.toBe(original);
  writeFileSync(target, modified);
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('accepts all actual source pins from an explicit root', () => {
  expect(checkRuntimePinPolicy(fixture())).toEqual({
    runtimeAssets: 15,
    bazelAssets: 5,
    winflexbisonAssets: 1,
  });
});

test.each(['bun', 'deno', 'node'])('rejects a malformed %s version', (tool) => {
  const root = fixture();
  mutate(root, '.prototools', (text) =>
    text.replace(new RegExp(`^${tool} = .*`, 'mu'), `${tool} = "latest"`),
  );
  expect(() => checkRuntimePinPolicy(root)).toThrow(
    `.prototools.${tool} must pin a stable version`,
  );
});

test('uses the authored versions rather than a second maintained version list', () => {
  const root = fixture();
  mutate(root, '.prototools', (text) => text.replace(/(bun|deno|node) = "/gu, '$1 = "v'));
  expect(checkRuntimePinPolicy(root).runtimeAssets).toBe(15);
  mutate(root, '.prototools', (text) =>
    text.replace(
      /(bun = "v[0-9]+\.[0-9]+\.)([0-9]+)/u,
      (_, prefix, patch) => `${prefix}${Number(patch) + 1}`,
    ),
  );
  expect(() => checkRuntimePinPolicy(root)).toThrow('bun.toml.assets.darwin-aarch64.url must be');
});

test.each([
  '.bazelversion',
  'tools/dev/winflexbison.toml',
])('rejects a malformed version in %s', (file) => {
  const root = fixture();
  mutate(root, file, (text) =>
    file === '.bazelversion' ? 'latest\n' : text.replace(/^version = .*$/mu, 'version = "2.5"'),
  );
  expect(() => checkRuntimePinPolicy(root)).toThrow('must pin a stable version');
});

test.each([
  ['tools/dev/bun.toml', 'sha256'],
  ['tools/dev/bun.toml', 'binary_sha256'],
  ['tools/dev/deno.toml', 'sha256'],
  ['tools/dev/deno.toml', 'binary_sha256'],
  ['tools/dev/node-runtime.toml', 'sha256'],
  ['tools/dev/node-runtime.toml', 'binary_sha256'],
  ['tools/dev/winflexbison.toml', 'sha256'],
  ['tools/dev/winflexbison.toml', 'tree_sha256'],
  ['tools/dev/winflexbison.toml', 'flex_sha256'],
  ['tools/dev/winflexbison.toml', 'bison_sha256'],
])('rejects malformed %s %s', (file, key) => {
  const root = fixture();
  mutate(root, file, (text) =>
    text.replace(new RegExp(`^${key} = .*`, 'mu'), `${key} = "${'A'.repeat(64)}"`),
  );
  expect(() => checkRuntimePinPolicy(root)).toThrow('64 lowercase hexadecimal');
});

test.each([
  ['tools/dev/bun.toml', 'https://github.com/oven-sh/bun', 'https://example.com/oven-sh/bun'],
  ['tools/dev/deno.toml', 'https://github.com/denoland/deno', 'http://github.com/denoland/deno'],
  ['tools/dev/deno.toml', 'https://dl.deno.land', 'https://example.com'],
  ['tools/dev/node-runtime.toml', 'https://nodejs.org', 'https://nodejs.org.evil.invalid'],
  ['tools/dev/winflexbison.toml', 'lexxmark/winflexbison', 'other/winflexbison'],
])('rejects a changed pinned origin in %s', (file, original, replacement) => {
  const root = fixture();
  mutate(root, file, (text) => text.replace(original, replacement));
  expect(() => checkRuntimePinPolicy(root)).toThrow('must be');
});

test.each([
  'tools/dev/bun.toml',
  'tools/dev/deno.toml',
  'tools/dev/node-runtime.toml',
])('rejects a changed archive member in %s', (file) => {
  const root = fixture();
  mutate(root, file, (text) => text.replace('binary_path = "', 'binary_path = "../'));
  expect(() => checkRuntimePinPolicy(root)).toThrow('binary_path must be');
});

test('rejects absent targets, duplicate TOML pins and unsupported mirror URLs', () => {
  const missing = fixture();
  mutate(missing, 'tools/dev/bun.toml', (text) => text.split('[assets.windows-x64]')[0]);
  expect(() => checkRuntimePinPolicy(missing)).toThrow('exactly the supported targets');
  const duplicate = fixture();
  mutate(duplicate, '.prototools', (text) => {
    const bunPin = text.match(/^bun = .*$/mu)?.[0];
    if (!bunPin) throw new Error('fixture is missing its Bun pin');
    return `${text}\n${bunPin}\n`;
  });
  expect(() => checkRuntimePinPolicy(duplicate)).toThrow('cannot parse .prototools');
  const mirror = fixture();
  mutate(mirror, 'tools/dev/bun.toml', (text) =>
    text.replace(/^(url = .*\n)/mu, '$1mirror_url = "https://example.com/bun.zip"\n'),
  );
  expect(() => checkRuntimePinPolicy(mirror)).toThrow('mirror_url must be absent');
});

test('rejects archive format, count and byte bounds the installers cannot accept', () => {
  const cases: [string, string, string, string][] = [
    ['tools/dev/node-runtime.toml', 'format = "tar.gz"', 'format = "zip"', 'format must be'],
    ['tools/dev/node-runtime.toml', 'bytes', '0', '.bytes must be'],
    ['tools/dev/node-runtime.toml', 'binary_bytes', '250000001', '.binary_bytes must be'],
    ['tools/dev/bun.toml', 'entry_count', '4097', '.entry_count must be'],
    ['tools/dev/deno.toml', 'entry_count', '0', '.entry_count must be'],
    ['tools/dev/winflexbison.toml', 'bytes', '2000001', '.bytes must be'],
    ['tools/dev/winflexbison.toml', 'entry_count', '257', '.entry_count must be'],
    ['tools/dev/winflexbison.toml', 'file_count', '256', '.file_count must be'],
    ['tools/dev/winflexbison.toml', 'expanded_bytes', '10000001', '.expanded_bytes must be'],
    ['tools/dev/winflexbison.toml', 'flex_path', '../win_flex.exe', '.flex_path must be'],
    ['tools/dev/winflexbison.toml', 'bison_path', 'other.exe', '.bison_path must be'],
  ];
  for (const [file, key, value, error] of cases) {
    const root = fixture();
    mutate(root, file, (text) =>
      key.includes(' = ')
        ? text.replace(key, value)
        : text.replace(new RegExp(`^${key} = .*`, 'mu'), `${key} = "${value}"`),
    );
    expect(() => checkRuntimePinPolicy(root)).toThrow(error);
  }
});

test('rejects duplicate, missing, malformed and stale Bazel checksum rows', () => {
  const changes = [
    (text: string) => `${text}${text.split('\n').find((line) => line && !line.startsWith('#'))}\n`,
    (text: string) => text.replace(/^[^#\n].*\n/mu, ''),
    (text: string) => text.replace(/\t[0-9a-f]{64}/u, '\tbad'),
    (text: string) =>
      text.replace(
        /^(\d+\.\d+\.)(\d+)\t/mu,
        (_, prefix, patch) => `${prefix}${Number(patch) + 1}\t`,
      ),
    (text: string) => text.replace('-linux-x86_64', '-unsupported'),
    (text: string) => text.replace(/^(\d+\.\d+\.\d+)\t/mu, '$1 '),
  ];
  for (const change of changes) {
    const root = fixture();
    mutate(root, 'tools/dev/bazel-checksums.tsv', change);
    expect(() => checkRuntimePinPolicy(root)).toThrow('bazel-checksums.tsv');
  }
});

test('CLI supports help and an explicit valid root and rejects invalid roots and arguments', () => {
  const root = fixture();
  const run = (args: string[]) =>
    spawnSync(process.execPath, [script, ...args], { cwd: tmpdir(), encoding: 'utf8' });
  const help = run(['--help']);
  expect(help.status).toBe(0);
  expect(help.stdout).toContain('--root CHECKOUT_ROOT');
  const valid = run(['--root', root]);
  expect(valid.status).toBe(0);
  expect(valid.stdout).toContain('15 runtime, 5 Bazel, 1 winflexbison assets');
  for (const args of [
    [],
    ['--root'],
    ['--unknown'],
    ['--root', root, 'extra'],
    ['--help', '--root', root],
    ['--root', path.join(root, 'absent')],
  ]) {
    const invalid = run(args);
    expect(invalid.status).not.toBe(0);
    expect(invalid.stderr).toContain('runtime pin policy:');
  }
  mutate(root, 'tools/dev/bun.toml', (text) =>
    text.replace(/^sha256 = .*$/mu, 'sha256 = "invalid"'),
  );
  expect(run(['--root', root]).status).toBe(1);
});
