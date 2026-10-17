import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stageCargoCarrierInputs } from '../../../tools/packaging/frozen-cargo.mts';
import { candidateConsumerManifest, cargoCandidate, resolvedSdkRuntime } from './consumer.mts';
import { type RegistryContext, validateRegistryContext } from './context.mts';

const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
export function capturedRegistryContext(
  lockText: string,
  metadata: any,
  cargoHome: string,
  cargo: string,
  target: string,
  candidates: { name: string; version: string }[],
  acquiredArchives?: { name: string; version: string }[],
) {
  const lock = Bun.TOML.parse(lockText);
  const repository = 'index.crates.io-1949cf8c6b5b557f';
  // Cargo fetch acquires its genuine lock closure, including optional packages.
  // Record those real files rather than inventing a second
  // dependency selection from compile-feature metadata.
  const archives =
    acquiredArchives ??
    lock.package
      .filter(
        (pkg: any) =>
          pkg.source &&
          existsSync(
            path.join(cargoHome, 'registry/cache', repository, `${pkg.name}-${pkg.version}.crate`),
          ),
      )
      .map((pkg: any) => ({ name: pkg.name, version: pkg.version }))
      .sort((a: any, b: any) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`));
  const selected = new Set(archives.map((pkg: any) => `${pkg.name}@${pkg.version}`));
  for (const pkg of metadata.packages.filter((pkg: any) => pkg.source))
    assert(
      selected.has(`${pkg.name}@${pkg.version}`),
      `Actual Cargo metadata references an uncaptured archive: ${pkg.name}@${pkg.version}`,
    );
  const index = path.join(cargoHome, 'registry/index', repository);
  const groups = new Map<string, RegistryContext['indexes'][number]>();
  for (const pkg of lock.package) {
    if (!pkg.source) {
      assert(
        candidates.some(
          (candidate) => candidate.name === pkg.name && candidate.version === pkg.version,
        ),
        `Unexpected captured local package: ${pkg.name}@${pkg.version}`,
      );
      continue;
    }
    assert.equal(pkg.source, 'registry+https://github.com/rust-lang/crates.io-index');
    if (selected.has(`${pkg.name}@${pkg.version}`))
      assert.equal(
        digest(
          readFileSync(
            path.join(cargoHome, 'registry/cache', repository, `${pkg.name}-${pkg.version}.crate`),
          ),
        ),
        pkg.checksum,
      );
    const name = pkg.name.toLowerCase();
    const key =
      name.length === 1
        ? `1/${name}`
        : name.length === 2
          ? `2/${name}`
          : name.length === 3
            ? `3/${name[0]}/${name}`
            : `${name.slice(0, 2)}/${name.slice(2, 4)}/${name}`;
    const bytes = readFileSync(path.join(index, '.cache', key));
    const records = bytes
      .toString('utf8')
      .split('\0')
      .filter((row) => row.startsWith('{'))
      .map((row) => JSON.parse(row));
    const record = records.find((row) => row.name === pkg.name && row.vers === pkg.version);
    assert.equal(
      record?.cksum,
      pkg.checksum,
      `Sparse index differs from genuine lock: ${pkg.name}@${pkg.version}`,
    );
    if (!groups.has(key))
      groups.set(key, {
        path: key,
        header: bytes.subarray(0, bytes.indexOf(0, 5) + 1).toString('base64'),
        records: [],
      });
    const group = groups.get(key);
    assert(group);
    group.records.push(record);
  }
  const configFile = path.join(index, 'config.json');
  if (!existsSync(configFile))
    assert.equal(groups.size, 0, 'A resolved registry context is missing its actual configuration');
  const context: RegistryContext = {
    schema: 'oliphaunt-installed-cargo-fixture-v1',
    cargo,
    repository,
    target,
    archives,
    config: existsSync(configFile) ? JSON.parse(readFileSync(configFile, 'utf8')) : {},
    indexes: [...groups.values()].sort((a, b) => a.path.localeCompare(b.path)),
  };
  validateRegistryContext(lockText, context);
  return context;
}
/** Explicit network-enabled qualification preflight; Cargo is the only resolver. */
export async function captureCargoContext(
  cargo: string,
  rustc: string,
  archives: string[],
  output: string,
) {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'oliphaunt-cargo-capture-'));
  const candidates = archives.map(cargoCandidate);
  const config = stageCargoCarrierInputs(candidates, scratch);
  const fixture = path.join(import.meta.dir, 'fixture');
  const consumer = path.join(scratch, 'consumer');
  const cargoHome = path.join(scratch, 'cargo-home');
  mkdirSync(path.join(consumer, 'src'), { recursive: true });
  writeFileSync(
    path.join(consumer, 'Cargo.toml'),
    candidateConsumerManifest(readFileSync(path.join(fixture, 'Cargo.toml'), 'utf8'), candidates),
  );
  copyFileSync(path.join(fixture, 'Cargo.lock'), path.join(consumer, 'Cargo.lock'));
  copyFileSync(path.join(fixture, 'main.rs'), path.join(consumer, 'src/main.rs'));
  copyFileSync(path.join(fixture, 'build.rs'), path.join(consumer, 'build.rs'));
  const env = { PATH: path.dirname(cargo), HOME: scratch, CARGO_HOME: cargoHome, RUSTC: rustc };
  const target = 'x86_64-unknown-linux-gnu';
  for (const command of [['generate-lockfile'], ['fetch', '--locked', '--target', target]]) {
    const result = Bun.spawnSync(
      [cargo, '--config', config, ...command, '--manifest-path', path.join(consumer, 'Cargo.toml')],
      { cwd: consumer, env, stdout: 'inherit', stderr: 'inherit' },
    );
    assert.equal(result.exitCode, 0, `real Cargo preflight failed: ${command.join(' ')}`);
  }
  const lockText = readFileSync(path.join(consumer, 'Cargo.lock'), 'utf8');
  resolvedSdkRuntime(
    readFileSync(path.join(consumer, 'Cargo.toml'), 'utf8'),
    lockText,
    candidates,
    cargoHome,
  );
  const metadata = Bun.spawnSync(
    [
      cargo,
      '--config',
      config,
      'metadata',
      '--locked',
      '--offline',
      '--filter-platform',
      target,
      '--format-version',
      '1',
      '--manifest-path',
      path.join(consumer, 'Cargo.toml'),
    ],
    { cwd: consumer, env, stderr: 'inherit' },
  );
  assert.equal(metadata.exitCode, 0, 'real Cargo selected-platform metadata failed');
  const acquiredArchives = JSON.parse(metadata.stdout.toString('utf8'))
    .packages.filter((pkg: any) => pkg.source)
    .map((pkg: any) => ({ name: pkg.name, version: pkg.version }))
    .sort((a: any, b: any) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`));
  const version = Bun.spawnSync([cargo, '--version'], { env });
  assert.equal(version.exitCode, 0);
  const context = capturedRegistryContext(
    lockText,
    JSON.parse(metadata.stdout.toString('utf8')),
    cargoHome,
    version.stdout.toString('utf8').trim().split(' ')[1] ?? '',
    target,
    [
      ...candidates,
      Bun.TOML.parse(readFileSync(path.join(consumer, 'Cargo.toml'), 'utf8')).package,
    ],
    acquiredArchives,
  );
  mkdirSync(output, { recursive: true });
  writeFileSync(path.join(output, 'Cargo.lock'), lockText);
  writeFileSync(path.join(output, 'registry-index.json'), `${JSON.stringify(context, null, 2)}\n`);
  return {
    scratch,
    packages: Bun.TOML.parse(lockText).package.length,
    registryPackages: context.indexes.reduce((total, entry) => total + entry.records.length, 0),
  };
}

export async function captureSourceCargoContext(spec: {
  cargo: string;
  rustc: string;
  archives: string[];
  flags: string[];
  output: string;
}) {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'oliphaunt-source-cargo-capture-'));
  const archiveDirectory = path.join(scratch, 'archives');
  mkdirSync(archiveDirectory);
  const candidates = spec.archives.map((archive, index) => {
    const copied = path.join(archiveDirectory, `${index}-${path.basename(archive)}`);
    copyFileSync(archive, copied);
    return cargoCandidate(copied);
  });
  assert(candidates.length > 0);
  const config = stageCargoCarrierInputs(candidates, scratch);
  const candidate = candidates[0];
  const directory = path.join(scratch, 'crates', `${candidate.name}-${candidate.version}`);
  const manifest = path.join(directory, 'Cargo.toml');
  const cargoHome = path.join(scratch, 'cargo-home');
  const env = {
    PATH: path.dirname(spec.rustc),
    HOME: scratch,
    CARGO_HOME: cargoHome,
    RUSTC: spec.rustc,
  };
  const target = 'x86_64-unknown-linux-gnu';
  async function command(name: string, args: string[]) {
    const stdout = path.join(scratch, `${name}.stdout`),
      stderr = path.join(scratch, `${name}.stderr`);
    const child = Bun.spawn(
      [spec.cargo, '--config', config, ...args, '--manifest-path', manifest],
      { cwd: directory, env, stdin: 'ignore', stdout: Bun.file(stdout), stderr: Bun.file(stderr) },
    );
    assert.equal(await child.exited, 0, `Actual source capture ${name} failed; ${stderr}`);
    return readFileSync(stdout, 'utf8');
  }
  await command('generate-lockfile', ['generate-lockfile']);
  // Cargo's test preparation reads cross-target locked package manifests too.
  // Let Cargo acquire its complete lock closure; compilation stays on target.
  await command('fetch', ['fetch', '--locked']);
  const metadata = JSON.parse(
    await command('metadata', [
      'metadata',
      '--locked',
      '--offline',
      '--filter-platform',
      target,
      '--format-version',
      '1',
      ...spec.flags,
    ]),
  );
  const selected = metadata.packages.find((pkg: any) => pkg.id === metadata.resolve.root);
  assert.equal(selected.name, candidate.name);
  assert.equal(selected.version, candidate.version);
  assert.equal(selected.source, null);
  const version = Bun.spawnSync([spec.cargo, '--version'], { env });
  assert.equal(version.exitCode, 0);
  const lockText = readFileSync(path.join(directory, 'Cargo.lock'), 'utf8');
  const context = capturedRegistryContext(
    lockText,
    metadata,
    cargoHome,
    version.stdout.toString().trim().split(' ')[1],
    target,
    candidates,
  );
  mkdirSync(spec.output, { recursive: true });
  writeFileSync(path.join(spec.output, 'Cargo.lock'), lockText);
  writeFileSync(
    path.join(spec.output, 'registry-index.json'),
    `${JSON.stringify(context, null, 2)}\n`,
  );
  const receipt = {
    scratch,
    cargoHome,
    name: candidate.name,
    version: candidate.version,
    candidates: candidates.map(({ name, version, sha256 }) => ({ name, version, sha256 })),
    cargoLockSha256: digest(lockText),
    registryIndexSha256: digest(readFileSync(path.join(spec.output, 'registry-index.json'))),
    registryPackages: context.indexes.reduce((count, index) => count + index.records.length, 0),
    acquiredArchives: context.archives.length,
  };
  writeFileSync(path.join(spec.output, 'capture.json'), `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}
if (import.meta.main) {
  const [cargo, rustc, output, ...archives] = process.argv.slice(2);
  if (cargo === '--source') {
    assert(rustc && !output);
    console.log(
      JSON.stringify(await captureSourceCargoContext(JSON.parse(readFileSync(rustc, 'utf8')))),
    );
  } else {
    assert(cargo && rustc && output);
    console.log(JSON.stringify(await captureCargoContext(cargo, rustc, archives, output)));
  }
}
