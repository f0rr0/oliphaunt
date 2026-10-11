import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { stageCargoCarrierInputs } from '../../../tools/packaging/frozen-cargo.mts';
import { readFileOnlyTarGzipEntries } from '../../../tools/packaging/portable-archive.mts';
import { type CargoLinkConfiguration, cargoLinkEnvironment } from '../cargo-environment.mts';

export function cargoCandidate(file: string) {
  const entries = readFileOnlyTarGzipEntries(file);
  const manifests = [...entries].filter(([name]) => name.endsWith('/Cargo.toml'));
  assert.equal(manifests.length, 1, 'candidate envelope must have one conventional manifest');
  const entry = manifests[0];
  assert(entry);
  const manifest = Bun.TOML.parse(Buffer.from(entry[1].data()).toString('utf8'));
  assert.equal(typeof manifest.package?.name, 'string');
  assert.equal(typeof manifest.package?.version, 'string');
  return {
    file,
    name: manifest.package.name,
    version: manifest.package.version,
    sha256: createHash('sha256').update(readFileSync(file)).digest('hex'),
    manifest,
  };
}

export function candidateConsumerManifest(
  template: string,
  candidates: ReturnType<typeof cargoCandidate>[],
) {
  const sdk = candidates.find((candidate) => candidate.name === 'oliphaunt');
  const helper = candidates.find((candidate) => candidate.name === 'oliphaunt-build');
  assert(sdk && helper);
  let text = template;
  for (const candidate of [sdk, helper]) {
    const expression = new RegExp(`^${candidate.name}\\s*=\\s*"[^"]*"`, 'mu');
    assert(expression.test(text), `missing fixture candidate requirement: ${candidate.name}`);
    text = text.replace(expression, `${candidate.name} = "=${candidate.version}"`);
  }
  const runtime = sdk.manifest.package.metadata.oliphaunt['native-version'];
  assert.equal(typeof runtime, 'string');
  text = text.replace(
    /^liboliphaunt-native-linux-x64-gnu\s*=\s*"[^"]*"/mu,
    `liboliphaunt-native-linux-x64-gnu = "=${runtime}"`,
  );
  text = text.replace(/^runtime-version\s*=\s*"[^"]*"/mu, `runtime-version = "${runtime}"`);
  return text;
}

async function main(args: string[]) {
  const [specification, runfiles] = args;
  assert(specification && runfiles && process.env.TEST_TMPDIR);
  const spec = JSON.parse(readFileSync(specification, 'utf8'));
  const file = (name: string) => path.join(runfiles, name);
  const root = path.join(process.env.TEST_TMPDIR, 'installed-cargo');
  const consumer = path.join(root, 'consumer');
  const cargoHome = path.join(root, 'cargo-home');
  mkdirSync(path.join(consumer, 'src'), { recursive: true });
  for (const [input, destination] of Object.entries(spec.cargoHome) as [string, string][]) {
    const output = path.join(cargoHome, 'registry', destination);
    mkdirSync(path.dirname(output), { recursive: true });
    copyFileSync(file(input), output);
  }
  const archiveDirectory = path.join(root, 'archives');
  mkdirSync(archiveDirectory);
  const candidates = spec.archives.map((archive: string, index: number) => {
    // Runfiles are declared projections; strict archive validation operates on
    // ordinary private copies, preserving its non-symlink filesystem contract.
    const copied = path.join(archiveDirectory, `${index}-${path.basename(archive)}`);
    copyFileSync(file(archive), copied);
    return cargoCandidate(copied);
  });
  const config = stageCargoCarrierInputs(candidates, root);
  writeFileSync(
    path.join(consumer, 'Cargo.toml'),
    candidateConsumerManifest(readFileSync(file(spec.manifest), 'utf8'), candidates),
  );
  copyFileSync(file(spec.lock), path.join(consumer, 'Cargo.lock'));
  copyFileSync(file(spec.source), path.join(consumer, 'src/main.rs'));
  copyFileSync(file(spec.buildScript), path.join(consumer, 'build.rs'));
  const storage = path.join(root, 'database-storage');
  const env: Record<string, string> = {
    ...cargoLinkEnvironment(
      JSON.parse(readFileSync(file(spec.compiler), 'utf8')) as CargoLinkConfiguration,
      runfiles,
    ),
    CARGO_HOME: cargoHome,
    CARGO_TARGET_DIR: path.join(root, 'target'),
    CARGO_NET_OFFLINE: 'true',
    RUSTC: file(spec.rustc),
    RUSTDOC: file(spec.rustdoc),
    PATH: path.dirname(file(spec.rustc)),
    HOME: root,
    TMPDIR: root,
    OLIPHAUNT_INSTALLED_STORAGE: storage,
  };
  const cargo = (command: string[]) => {
    const result = Bun.spawnSync(
      [
        file(spec.cargo),
        '--config',
        config,
        ...command,
        '--offline',
        '--manifest-path',
        path.join(consumer, 'Cargo.toml'),
      ],
      { cwd: consumer, env, stdout: 'inherit', stderr: 'inherit' },
    );
    assert.equal(result.exitCode, 0, `installed Cargo qualification failed: ${command.join(' ')}`);
  };
  // Genuine Cargo reconciles candidate versions using the closed registry context.
  // This is qualification/preflight, never construction or a publication baseline.
  cargo(['generate-lockfile']);
  const lock = Bun.TOML.parse(readFileSync(path.join(consumer, 'Cargo.lock'), 'utf8'));
  for (const candidate of candidates) {
    const selected = lock.package.find((pkg: any) => pkg.name === candidate.name && !pkg.source);
    if (['oliphaunt', 'oliphaunt-build'].includes(candidate.name))
      assert(selected, `consumer root candidate not selected: ${candidate.name}`);
    if (selected)
      assert.equal(
        selected.version,
        candidate.version,
        `candidate identity differs: ${candidate.name}`,
      );
  }
  cargo(['run', '--locked', '--jobs', '2']);
  rmSync(storage, { recursive: true });
  writeFileSync(
    path.join(root, 'qualification.json'),
    `${JSON.stringify(
      {
        scope: 'checkout-composition-installed-consumer',
        status: 'passed',
        cases: ['direct-sql-reopen', 'broker-sql-reopen'],
        candidates: candidates.map(({ name, version, sha256 }) => ({
          name,
          version,
          sha256,
          selected: lock.package.some(
            (pkg: any) => pkg.name === name && pkg.version === version && !pkg.source,
          ),
        })),
        cargoLockSha256: createHash('sha256')
          .update(readFileSync(path.join(consumer, 'Cargo.lock')))
          .digest('hex'),
      },
      null,
      2,
    )}\n`,
  );
}

if (import.meta.main) await main(process.argv.slice(2));
