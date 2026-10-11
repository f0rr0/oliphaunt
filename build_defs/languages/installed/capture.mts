import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stageCargoCarrierInputs } from '../../../tools/packaging/frozen-cargo.mts';
import { candidateConsumerManifest, cargoCandidate, resolvedSdkRuntime } from './consumer.mts';
import { type RegistryContext, validateRegistryContext } from './context.mts';

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
  const lock = Bun.TOML.parse(lockText);
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
  const selected = new Set(acquiredArchives.map((pkg: any) => `${pkg.name}@${pkg.version}`));
  const repository = 'index.crates.io-1949cf8c6b5b557f';
  const index = path.join(cargoHome, 'registry/index', repository);
  const groups = new Map<string, RegistryContext['indexes'][number]>();
  for (const pkg of lock.package) {
    if (!pkg.source) {
      if (pkg.name !== 'frozen-consumer')
        assert(
          candidates.some(
            (candidate) => candidate.name === pkg.name && candidate.version === pkg.version,
          ),
          `unexpected local preflight identity: ${pkg.name}`,
        );
      continue;
    }
    assert.equal(pkg.source, 'registry+https://github.com/rust-lang/crates.io-index');
    const archive = path.join(
      cargoHome,
      'registry/cache',
      repository,
      `${pkg.name}-${pkg.version}.crate`,
    );
    if (selected.has(`${pkg.name}@${pkg.version}`))
      assert.equal(createHash('sha256').update(readFileSync(archive)).digest('hex'), pkg.checksum);
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
    assert.equal(record?.cksum, pkg.checksum);
    if (!groups.has(key))
      groups.set(key, {
        path: key,
        header: bytes.subarray(0, bytes.indexOf(0, 5) + 1).toString('base64'),
        records: [],
      });
    groups.get(key)?.records.push(record);
  }
  const version = Bun.spawnSync([cargo, '--version'], { env });
  assert.equal(version.exitCode, 0);
  const context: RegistryContext = {
    schema: 'oliphaunt-installed-cargo-fixture-v1',
    cargo: version.stdout.toString('utf8').trim().split(' ')[1] ?? '',
    repository,
    target,
    archives: acquiredArchives,
    config: JSON.parse(readFileSync(path.join(index, 'config.json'), 'utf8')),
    indexes: [...groups.values()].sort((a, b) => a.path.localeCompare(b.path)),
  };
  validateRegistryContext(lockText, context);
  mkdirSync(output, { recursive: true });
  writeFileSync(path.join(output, 'Cargo.lock'), lockText);
  writeFileSync(path.join(output, 'registry-index.json'), `${JSON.stringify(context, null, 2)}\n`);
  return {
    scratch,
    packages: lock.package.length,
    registryPackages: context.indexes.reduce((total, entry) => total + entry.records.length, 0),
  };
}

if (import.meta.main) {
  const [cargo, rustc, output, ...archives] = process.argv.slice(2);
  assert(cargo && rustc && output);
  console.log(JSON.stringify(await captureCargoContext(cargo, rustc, archives, output)));
}
