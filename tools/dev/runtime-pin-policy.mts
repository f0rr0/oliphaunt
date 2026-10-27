import { readFileSync } from 'node:fs';
import path from 'node:path';

type Table = Record<string, unknown>;

const HOSTS = [
  ['aarch64-apple-darwin', 'darwin-aarch64', 'darwin-arm64', 'tar.gz'],
  ['x86_64-apple-darwin', 'darwin-x64', 'darwin-x64', 'tar.gz'],
  ['aarch64-unknown-linux-gnu', 'linux-aarch64', 'linux-arm64', 'tar.xz'],
  ['x86_64-unknown-linux-gnu', 'linux-x64', 'linux-x64', 'tar.xz'],
  ['x86_64-pc-windows-msvc', 'windows-x64', 'win-x64', 'zip'],
] as const;
const BAZEL_HOSTS = [
  'linux-x86_64',
  'linux-arm64',
  'darwin-x86_64',
  'darwin-arm64',
  'windows-x86_64.exe',
];

function require(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`runtime pin policy: ${message}`);
}

function table(value: unknown, label: string): Table {
  require(value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value), `${label} must be a TOML table`);
  return value as Table;
}

function string(value: unknown, label: string): string {
  require(typeof value === 'string' && value.length > 0, `${label} must be a quoted string`);
  return value;
}

function version(value: unknown, label: string, allowV = false): string {
  const pinned = string(value, label);
  const normalized = allowV ? pinned.replace(/^v/u, '') : pinned;
  require(/^[0-9]+\.[0-9]+\.[0-9]+$/u.test(normalized), `${label} must pin a stable version`);
  return normalized;
}

function digest(value: unknown, label: string) {
  require(typeof value === 'string' &&
    /^[0-9a-f]{64}$/u.test(value), `${label} must contain 64 lowercase hexadecimal characters`);
}

function integer(value: unknown, label: string, min = 1, max = Number.MAX_SAFE_INTEGER): number {
  require(typeof value === 'string' && /^[0-9]+$/u.test(value), `${label} must be numeric`);
  const count = Number(value);
  require(Number.isSafeInteger(count) &&
    count >= min &&
    count <= max, `${label} must be ${min}..${max}`);
  return count;
}

function equal(value: unknown, expected: string | number, label: string) {
  require(value === expected, `${label} must be ${expected}`);
}

function read(root: string, file: string): string {
  try {
    return readFileSync(path.join(root, file), 'utf8');
  } catch (cause) {
    throw new Error(`runtime pin policy: cannot read ${file}: ${(cause as Error).message}`);
  }
}

function toml(root: string, file: string): Table {
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(read(root, file));
  } catch (cause) {
    throw new Error(`runtime pin policy: cannot parse ${file}: ${(cause as Error).message}`);
  }
  return table(parsed, file);
}

function assets(manifest: Table, targets: string[], file: string): Table {
  const entries = table(manifest.assets, `${file}.assets`);
  require(Object.keys(entries).sort().join(',') ===
    [...targets]
      .sort()
      .join(
        ',',
      ), `${file}.assets must contain exactly the supported targets: ${targets.join(', ')}`);
  return entries;
}

/** Validate the checked source pins without downloading or executing any pinned tool. */
export function checkRuntimePinPolicy(root: string) {
  require(typeof root === 'string' && root.length > 0, 'an explicit checkout root is required');
  const proto = toml(root, '.prototools');
  for (const tool of ['bun', 'deno', 'node'] as const) {
    const pinned = version(proto[tool], `.prototools.${tool}`, true);
    const file = `tools/dev/${tool === 'node' ? 'node-runtime' : tool}.toml`;
    const entries = assets(
      toml(root, file),
      HOSTS.map((host) => (tool === 'bun' ? host[1] : host[0])),
      file,
    );
    for (const [target, bunTarget, nodeTarget, format] of HOSTS) {
      const label = `${file}.assets.${tool === 'bun' ? bunTarget : target}`;
      const entry = table(entries[tool === 'bun' ? bunTarget : target], label);
      const executable = `${tool}${format === 'zip' ? '.exe' : ''}`;
      digest(entry.sha256, `${label}.sha256`);
      digest(entry.binary_sha256, `${label}.binary_sha256`);
      if (tool === 'node') {
        const prefix = `node-v${pinned}-${nodeTarget}`;
        equal(
          entry.url,
          `https://nodejs.org/download/release/v${pinned}/${prefix}.${format}`,
          `${label}.url`,
        );
        equal(entry.format, format, `${label}.format`);
        equal(
          entry.binary_path,
          `${prefix}/${format === 'zip' ? '' : 'bin/'}${executable}`,
          `${label}.binary_path`,
        );
        integer(entry.bytes, `${label}.bytes`);
        integer(entry.binary_bytes, `${label}.binary_bytes`, 1, 250_000_000);
      } else if (tool === 'bun') {
        equal(
          entry.url,
          `https://github.com/oven-sh/bun/releases/download/bun-v${pinned}/bun-${bunTarget}.zip`,
          `${label}.url`,
        );
        equal(entry.binary_path, `bun-${bunTarget}/${executable}`, `${label}.binary_path`);
        require(entry.mirror_url === undefined, `${label}.mirror_url must be absent`);
        integer(entry.entry_count, `${label}.entry_count`, 1, 4096);
      } else {
        const asset = `deno-${target}.zip`;
        equal(
          entry.url,
          `https://github.com/denoland/deno/releases/download/v${pinned}/${asset}`,
          `${label}.url`,
        );
        equal(
          entry.mirror_url,
          `https://dl.deno.land/release/v${pinned}/${asset}`,
          `${label}.mirror_url`,
        );
        equal(entry.binary_path, executable, `${label}.binary_path`);
        integer(entry.entry_count, `${label}.entry_count`, 1, 4096);
      }
    }
  }

  const bazelVersion = version(read(root, '.bazelversion').trim(), '.bazelversion');
  const bazelAssets = new Set(BAZEL_HOSTS.map((host) => `bazel-${bazelVersion}-${host}`));
  const seen = new Set<string>();
  for (const [index, line] of read(root, 'tools/dev/bazel-checksums.tsv')
    .split(/\r?\n/u)
    .entries()) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const label = `tools/dev/bazel-checksums.tsv:${index + 1}`;
    const fields = line.split('\t');
    require(fields.length === 3, `${label} must contain version, asset and digest columns`);
    const [pinned, asset, sha256] = fields;
    equal(pinned, bazelVersion, `${label} version`);
    require(bazelAssets.has(asset), `${label} has an unsupported Bazel asset: ${asset}`);
    require(!seen.has(asset), `${label} duplicates Bazel asset: ${asset}`);
    digest(sha256, `${label} digest`);
    seen.add(asset);
  }
  require(seen.size ===
    bazelAssets.size, 'tools/dev/bazel-checksums.tsv must pin every supported Bazel asset');

  const winFile = 'tools/dev/winflexbison.toml';
  const winManifest = toml(root, winFile);
  const toolchain = table(winManifest.toolchain, `${winFile}.toolchain`);
  const winVersion = version(toolchain.version, `${winFile}.toolchain.version`);
  equal(toolchain.repository, 'lexxmark/winflexbison', `${winFile}.toolchain.repository`);
  const win = table(
    assets(winManifest, ['windows-x64'], winFile)['windows-x64'],
    `${winFile}.assets.windows-x64`,
  );
  equal(
    win.url,
    `https://github.com/lexxmark/winflexbison/releases/download/v${winVersion}/win_flex_bison-${winVersion}.zip`,
    `${winFile}.url`,
  );
  equal(win.flex_path, 'win_flex.exe', `${winFile}.flex_path`);
  equal(win.bison_path, 'win_bison.exe', `${winFile}.bison_path`);
  for (const key of ['sha256', 'tree_sha256', 'flex_sha256', 'bison_sha256'])
    digest(win[key], `${winFile}.${key}`);
  integer(win.bytes, `${winFile}.bytes`, 1, 2_000_000);
  const entryCount = integer(win.entry_count, `${winFile}.entry_count`, 2, 256);
  integer(win.file_count, `${winFile}.file_count`, 2, entryCount);
  integer(win.expanded_bytes, `${winFile}.expanded_bytes`, 1, 10_000_000);
  return { runtimeAssets: HOSTS.length * 3, bazelAssets: seen.size, winflexbisonAssets: 1 };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  try {
    if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
      console.log('usage: runtime-pin-policy.mts --root CHECKOUT_ROOT');
    } else {
      require(args.length === 2 &&
        args[0] === '--root' &&
        args[1].length > 0, 'usage: runtime-pin-policy.mts --root CHECKOUT_ROOT');
      const result = checkRuntimePinPolicy(path.resolve(args[1]));
      console.log(
        `runtime pin policy passed (${result.runtimeAssets} runtime, ${result.bazelAssets} Bazel, ${result.winflexbisonAssets} winflexbison assets)`,
      );
    }
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exitCode = 1;
  }
}
