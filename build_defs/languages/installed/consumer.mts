import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { stageCargoCarrierInputs } from '../../../tools/packaging/frozen-cargo.mts';
import { readPortableArchiveEntries } from '../../../tools/packaging/portable-archive.mts';
import { type CargoLinkConfiguration, cargoLinkEnvironment } from '../cargo-environment.mts';
import { cargoSatisfies } from '../cargo-metadata.mts';

export function cargoCandidate(file: string) {
  const entries = readPortableArchiveEntries(file);
  for (const entry of entries.values())
    assert(
      (entry.isFile && entry.mode === 0o644) || (entry.isDirectory && entry.mode === 0o755),
      `candidate member ${entry.name} must be a regular 0644 file or 0755 directory`,
    );
  return cargoArchiveIdentity(file, entries);
}

function cargoArchiveIdentity(
  file: string,
  entries: ReturnType<typeof readPortableArchiveEntries>,
) {
  const manifests = [...entries].filter(([name]) => name.endsWith('/Cargo.toml'));
  assert.equal(manifests.length, 1, 'candidate envelope must have one conventional manifest');
  const entry = manifests[0];
  assert(entry?.[1].isFile, 'Cargo manifest must be a regular archive member');
  const manifest = Bun.TOML.parse(Buffer.from(entry[1].data()).toString('utf8'));
  assert.equal(typeof manifest.package?.name, 'string');
  assert.equal(typeof manifest.package?.version, 'string');
  const root = `${manifest.package.name}-${manifest.package.version}`;
  for (const [name, entry] of entries)
    assert(
      (name === root && entry.isDirectory) || name.startsWith(`${root}/`),
      `Cargo archive member ${name} is outside declared package ${root}`,
    );
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
  const core = candidates.find((candidate) => candidate.name === 'liboliphaunt-native-bindings');
  let text = template;
  for (const candidate of [sdk, helper].filter((value) => value !== undefined)) {
    const expression = new RegExp(`^${candidate.name}\\s*=\\s*"[^"]*"`, 'mu');
    assert(expression.test(text), `missing fixture candidate requirement: ${candidate.name}`);
    text = text.replace(expression, `${candidate.name} = "=${candidate.version}"`);
  }
  // Unselected roots retain the fixture's explicit published requirements. Their
  // authentic resolved SDK manifest is checked after Cargo generates the lock.
  if (!sdk) {
    if (core) {
      text = text.replace(/^oliphaunt\s*=\s*"[^"]*"/mu, `${core.name} = "=${core.version}"`);
      text = text.replace(/^\[package\]$/mu, '[package]\nbuild = "core-build.rs"');
    }
    return text;
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

/** Stage only declared candidate dependencies; Cargo still resolves the actual composition. */
export function candidateDependencyInputs(
  roots: ReturnType<typeof cargoCandidate>[],
  pool: ReturnType<typeof cargoCandidate>[],
  lockText: string,
  preferHeld = false,
) {
  const held = Bun.TOML.parse(lockText).package;
  const selected = new Map(roots.map((candidate) => [candidate.name, candidate]));
  const pending = [...roots];
  for (const candidate of pending)
    for (const table of [
      candidate.manifest,
      ...Object.values(candidate.manifest.target ?? {}),
    ] as any[])
      for (const section of ['dependencies', 'build-dependencies'])
        for (const [alias, declaration] of Object.entries(table[section] ?? {})) {
          const dependency =
            typeof declaration === 'string' ? { version: declaration } : (declaration as any);
          const name = dependency.package ?? alias;
          if (selected.has(name)) continue;
          const current = pool.find((row) => row.name === name);
          if (!current) continue;
          assert.equal(
            typeof dependency.version,
            'string',
            `candidate dependency needs its conventional requirement: ${name}`,
          );
          const compatibleHeld = held.some(
            (row: any) =>
              row.name === name && row.source && cargoSatisfies(row.version, dependency.version),
          );
          if (preferHeld && compatibleHeld) continue;
          if (!cargoSatisfies(current.version, dependency.version)) {
            assert(
              compatibleHeld,
              `candidate dependency lacks a compatible declared input: ${name}`,
            );
            continue;
          }
          selected.set(name, current);
          pending.push(current);
        }
  return [...selected.values()];
}

export function installedConsumerCases(
  candidates: ReturnType<typeof cargoCandidate>[],
  fixtureLock: string,
  selectedProducts: string[],
  minimum: boolean,
) {
  const sdkRoots = candidates.filter((candidate) =>
    ['oliphaunt', 'oliphaunt-build'].includes(candidate.name),
  );
  const core = candidates.filter((candidate) => candidate.name === 'liboliphaunt-native-bindings');
  assert.equal(core.length, 1, 'installed Core consumer needs one actual candidate envelope');
  if (minimum) {
    assert(
      selectedProducts.includes('oliphaunt-rust'),
      'declared SDK minimum qualification requires its prepared selected owner',
    );
    return [['sdk', candidateDependencyInputs(sdkRoots, candidates, fixtureLock, true)]] as [
      string,
      ReturnType<typeof cargoCandidate>[],
    ][];
  }
  return [
    ['checkout', candidateDependencyInputs(sdkRoots, candidates, fixtureLock)],
    [
      'liboliphaunt-native-bindings',
      candidateDependencyInputs(core, candidates, fixtureLock, true),
    ],
    ['held', []],
  ] as [string, ReturnType<typeof cargoCandidate>[]][];
}

export function resolvedSdkRuntime(
  consumerText: string,
  lockText: string,
  candidates: ReturnType<typeof cargoCandidate>[],
  cargoHome: string,
) {
  const consumer = Bun.TOML.parse(consumerText);
  const lock = Bun.TOML.parse(lockText);
  const rows = lock.package.filter((pkg: any) => pkg.name === 'oliphaunt');
  assert.equal(rows.length, 1, 'consumer must resolve one SDK identity');
  const sdk = rows[0];
  let archive;
  if (sdk.source) {
    assert.equal(sdk.source, 'registry+https://github.com/rust-lang/crates.io-index');
    const file = path.join(
      cargoHome,
      'registry/cache/index.crates.io-1949cf8c6b5b557f',
      `oliphaunt-${sdk.version}.crate`,
    );
    // Genuine registry and canonical candidate archives both permit safe
    // directory entries inside their conventional package root.
    archive = cargoArchiveIdentity(file, readPortableArchiveEntries(file));
    assert.equal(archive.sha256, sdk.checksum, 'held SDK archive differs from genuine Cargo lock');
  } else {
    archive = candidates.find(
      (candidate) => candidate.name === sdk.name && candidate.version === sdk.version,
    );
    assert(archive, 'resolved local SDK is not an explicitly selected candidate');
  }
  const runtime = archive.manifest.package.metadata.oliphaunt['native-version'];
  assert.equal(typeof runtime, 'string');
  assert.equal(consumer.package.metadata.oliphaunt['runtime-version'], runtime);
  assert.equal(consumer.dependencies['liboliphaunt-native-linux-x64-gnu'], `=${runtime}`);
  return runtime;
}

async function main(args: string[]) {
  const [specification, runfiles] = args;
  assert(specification && runfiles && process.env.TEST_TMPDIR);
  const spec = JSON.parse(readFileSync(specification, 'utf8'));
  const file = (name: string) => path.join(runfiles, name);
  const root = path.join(process.env.TEST_TMPDIR, 'installed-cargo');
  const cargoHome = path.join(root, 'cargo-home');
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
  };
  const fixtureLock = readFileSync(file(spec.lock), 'utf8');
  const cases = installedConsumerCases(
    candidates,
    fixtureLock,
    spec.selectedProducts,
    spec.minimum,
  );
  const receipts = [];
  for (const [name, selectedCandidates] of cases) {
    const directory = path.join(root, name);
    const consumer = path.join(directory, 'consumer');
    const storage = path.join(directory, 'database-storage');
    mkdirSync(path.join(consumer, 'src'), { recursive: true });
    const config = stageCargoCarrierInputs(selectedCandidates, directory);
    const manifest = candidateConsumerManifest(
      readFileSync(file(spec.manifest), 'utf8'),
      selectedCandidates,
    );
    writeFileSync(path.join(consumer, 'Cargo.toml'), manifest);
    copyFileSync(file(spec.lock), path.join(consumer, 'Cargo.lock'));
    copyFileSync(
      file(name === 'liboliphaunt-native-bindings' ? spec.coreSource : spec.source),
      path.join(consumer, 'src/main.rs'),
    );
    if (name === 'liboliphaunt-native-bindings')
      copyFileSync(file(spec.coreBuildScript), path.join(consumer, 'core-build.rs'));
    else copyFileSync(file(spec.buildScript), path.join(consumer, 'build.rs'));
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
        {
          cwd: consumer,
          env: { ...env, OLIPHAUNT_INSTALLED_STORAGE: storage },
          stdout: 'inherit',
          stderr: 'inherit',
        },
      );
      assert.equal(
        result.exitCode,
        0,
        `installed Cargo qualification failed: ${command.join(' ')}`,
      );
    };
    // Genuine Cargo reconciles candidate versions using the closed registry context.
    // This is qualification/preflight, never construction or a publication baseline.
    cargo(['generate-lockfile']);
    const lockText = readFileSync(path.join(consumer, 'Cargo.lock'), 'utf8');
    const lock = Bun.TOML.parse(lockText);
    const runtime =
      name === 'liboliphaunt-native-bindings'
        ? Bun.TOML.parse(manifest).package.metadata.oliphaunt['runtime-version']
        : resolvedSdkRuntime(manifest, lockText, selectedCandidates, cargoHome);
    for (const pkg of lock.package) {
      if (pkg.source || pkg.name === 'frozen-consumer') continue;
      assert(
        selectedCandidates.some(
          (candidate) => candidate.name === pkg.name && candidate.version === pkg.version,
        ),
        `unselected package was resolved from local source: ${pkg.name}@${pkg.version}`,
      );
    }
    for (const candidate of selectedCandidates) {
      const selected = lock.package.find((pkg: any) => pkg.name === candidate.name && !pkg.source);
      if (['oliphaunt', 'oliphaunt-build'].includes(candidate.name))
        assert(selected, `consumer root candidate not selected: ${candidate.name}`);
      if (name === 'liboliphaunt-native-bindings')
        assert(selected, `Core-only consumer did not select candidate: ${candidate.name}`);
      if (selected)
        assert.equal(
          selected.version,
          candidate.version,
          `candidate identity differs: ${candidate.name}`,
        );
    }
    cargo(['run', '--locked', '--jobs', '2']);
    rmSync(storage, { recursive: true });
    receipts.push({
      case: name,
      runtime,
      candidates: selectedCandidates.map(({ name, version, sha256 }) => ({
        name,
        version,
        sha256,
        selected: lock.package.some(
          (pkg: any) => pkg.name === name && pkg.version === version && !pkg.source,
        ),
      })),
      cargoLockSha256: createHash('sha256').update(lockText).digest('hex'),
    });
  }
  writeFileSync(
    path.join(root, 'qualification.json'),
    `${JSON.stringify(
      {
        scope: 'checkout-composition-installed-consumer',
        status: 'passed',
        cases: spec.minimum
          ? ['sdk-declared-minimum']
          : ['direct-sql-reopen', 'broker-sql-reopen', 'core-direct-sql-reopen'],
        compositions: receipts,
      },
      null,
      2,
    )}\n`,
  );
}

if (import.meta.main) await main(process.argv.slice(2));
