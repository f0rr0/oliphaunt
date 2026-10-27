import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { cargoDependencyMinimum } from '../../../tools/packaging/cargo-manifest.mts';
import {
  assertCargoSourceArtifacts,
  stageCargoCarrierInputs,
} from '../../../tools/packaging/frozen-cargo.mts';
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

type CargoCandidate = ReturnType<typeof cargoCandidate>;
export type CargoOwner = { product: string; version: string };
export type CargoPayloadRow = {
  product: string;
  version: string;
  artifact: string;
  file: { path: string; size?: number; sha256?: string };
};
export type CargoPayloadPool = {
  completed: CargoPayloadInput[];
  current: CargoPayloadInput[];
  owners: Record<string, CargoOwner>;
  read: (input: CargoPayloadInput) => CargoCandidate & { product: string };
};
type CargoPayloadInput = {
  name: string;
  version: string;
  product: string;
  sha256?: string;
  rows: CargoPayloadRow[];
  destination: string;
};

/** Read original declared Files; imported rows retain their authenticated byte identity. */
export function cargoPayloadPool(
  specification: {
    completed: CargoPayloadRow[];
    current: CargoPayloadRow[];
    owners: Record<string, CargoOwner>;
  },
  sourceOwners: Record<string, CargoOwner>,
  file: (name: string) => string,
  directory: string,
): CargoPayloadPool {
  const index = (rows: CargoPayloadRow[], phase: string) => {
    const inputs = new Map<string, CargoPayloadInput>();
    for (const [index, row] of rows.entries()) {
      assert(
        /^[0-9A-Za-z][0-9A-Za-z.+-]*$/u.test(row.version),
        'Payload package version is unsafe',
      );
      assert(
        row.artifact.startsWith('cargo:') ||
          (row.artifact.startsWith('github-release:') && row.artifact.endsWith('.crate')),
        'Payload input is not an original Cargo archive',
      );
      const suffix = `-${row.version}.crate`;
      if (row.artifact.startsWith('github-release:'))
        assert(row.artifact.endsWith(suffix), 'Payload asset version differs');
      const name = row.artifact.startsWith('cargo:')
        ? row.artifact.slice('cargo:'.length)
        : row.artifact.slice('github-release:'.length, -suffix.length);
      assert(/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(name), 'Payload package name is unsafe');
      if (Object.hasOwn(sourceOwners, name)) continue;
      const owner = specification.owners[name];
      if (owner) {
        assert.equal(row.product, owner.product, 'Payload owner differs');
        if (phase === 'current')
          assert.equal(row.version, owner.version, 'Current payload version differs');
      }
      const key = `${name}@${row.version}`;
      const previous = inputs.get(key);
      assert(
        !previous ||
          (previous.product === row.product &&
            (!previous.sha256 || !row.file.sha256 || previous.sha256 === row.file.sha256)),
        'Conflicting original payload archive: ' + key,
      );
      if (previous) previous.rows.push(row);
      else
        inputs.set(key, {
          name,
          version: row.version,
          product: row.product,
          sha256: row.file.sha256,
          rows: [row],
          destination: path.join(directory, `${phase}-${index}-${name}-${row.version}.crate`),
        });
    }
    return [...inputs.values()];
  };
  const loaded = new Map<CargoPayloadInput, CargoCandidate & { product: string }>();
  return {
    completed: index(specification.completed, 'completed'),
    current: index(specification.current, 'current'),
    owners: specification.owners,
    read(input) {
      const previous = loaded.get(input);
      if (previous) return previous;
      let candidate: CargoCandidate | undefined;
      for (const [index, row] of input.rows.entries()) {
        const copied = index ? `${input.destination}.alias-${index}` : input.destination;
        copyFileSync(file(row.file.path), copied);
        assert(lstatSync(copied).isFile(), 'Payload input is not a regular File');
        const actual = cargoArchiveIdentity(copied, readPortableArchiveEntries(copied));
        assert.equal(actual.name, input.name, 'Payload package name differs');
        assert.equal(actual.version, input.version, 'Payload package version differs');
        if (row.file.size !== undefined)
          assert.equal(readFileSync(copied).length, row.file.size, 'Payload archive size differs');
        if (row.file.sha256 !== undefined)
          assert.equal(actual.sha256, row.file.sha256, 'Payload archive SHA differs');
        if (candidate)
          assert.equal(actual.sha256, candidate.sha256, 'Conflicting original payload alias bytes');
        else candidate = actual;
        if (index) rmSync(copied);
      }
      assert(candidate);
      const result = { ...candidate, product: input.product };
      loaded.set(input, result);
      return result;
    },
  };
}

/** Compose exact payload requirements from original manifests; Cargo remains the resolver. */
export function cargoPayloadInputs(
  roots: CargoCandidate[],
  pool: CargoPayloadPool,
  {
    currentSources,
    sourceOwners,
    selectedProducts,
    includeDev = true,
    consumer,
  }: {
    currentSources: CargoCandidate[];
    sourceOwners: Record<string, CargoOwner>;
    selectedProducts: string[];
    includeDev?: boolean;
    consumer?: { manifest: any; source: CargoCandidate };
  },
) {
  const currentSource = (source: CargoCandidate) => {
    const owner = sourceOwners[source.name];
    return currentSources.includes(source) && owner?.version === source.version;
  };
  const adoptsCurrent = (source: CargoCandidate | undefined, input: CargoPayloadInput) => {
    if (!source) return false;
    const owner = sourceOwners[source.name];
    return (
      (owner.product === input.product && source.version === input.version) ||
      (selectedProducts.includes(owner.product) && selectedProducts.includes(input.product))
    );
  };
  const known = new Set([
    ...Object.keys(pool.owners),
    ...pool.completed.map((row) => row.name),
    ...pool.current.map((row) => row.name),
  ]);
  const selected = new Map<string, CargoCandidate>();
  const selectedInputs = new Map<string, CargoPayloadInput>();
  const pending = roots.map((candidate) => ({
    manifest: candidate.manifest,
    source: currentSource(candidate) ? candidate : undefined,
  }));
  if (consumer)
    pending.push({
      manifest: consumer.manifest,
      source: currentSource(consumer.source) ? consumer.source : undefined,
    });
  for (const { manifest, source } of pending) {
    for (const table of [manifest, ...Object.values(manifest.target ?? {})] as any[]) {
      for (const section of [
        'dependencies',
        'build-dependencies',
        ...(includeDev ? ['dev-dependencies'] : []),
      ]) {
        for (const [alias, raw] of Object.entries(table[section] ?? {}) as [string, any][]) {
          const requirement = typeof raw === 'string' ? { version: raw } : raw;
          const name = requirement.package ?? alias;
          if (!known.has(name)) continue;
          assert(
            typeof requirement.version === 'string' &&
              /^=\s*[0-9]/u.test(requirement.version) &&
              !requirement.path &&
              !requirement.git &&
              !requirement.workspace &&
              !requirement.registry,
            'Payload requirement is not an exact conventional registry pin: ' + name,
          );
          const version = requirement.version.slice(1).trim();
          const previous = selected.get(name);
          if (previous) {
            assert.equal(
              previous.version,
              version,
              'Conflicting exact payload requirement: ' + name,
            );
            const selectedInput = selectedInputs.get(name);
            assert(selectedInput);
            assert(
              pool.completed.includes(selectedInput) || adoptsCurrent(source, selectedInput),
              'Held source cannot consume current payload bytes: ' + name,
            );
            continue;
          }
          const held = pool.completed.filter((row) => row.name === name && row.version === version);
          assert(held.length <= 1, 'Ambiguous completed payload: ' + name);
          const current = pool.current.filter(
            (row) => row.name === name && row.version === version,
          );
          assert(current.length <= 1, 'Ambiguous current payload: ' + name);
          const input =
            held[0] ?? (current[0] && adoptsCurrent(source, current[0]) ? current[0] : undefined);
          assert(input, 'Missing actual exact payload archive: ' + name + '@' + version);
          const candidate = pool.read(input);
          selected.set(name, candidate);
          selectedInputs.set(name, input);
          // A held wrapper requires its original completed parts even when a
          // same-version current producer happens to be selected independently.
          pending.push({ manifest: candidate.manifest, source: held.length ? undefined : source });
        }
      }
    }
  }
  return [...selected.values()];
}

function heldSdkCandidate(lockText: string, cargoHome: string) {
  const rows = Bun.TOML.parse(lockText).package.filter((row: any) => row.name === 'oliphaunt');
  assert.equal(rows.length, 1, 'Held consumer needs one genuine SDK identity');
  const row = rows[0];
  assert.equal(row.source, 'registry+https://github.com/rust-lang/crates.io-index');
  const file = path.join(
    cargoHome,
    'registry/cache/index.crates.io-1949cf8c6b5b557f',
    `oliphaunt-${row.version}.crate`,
  );
  const candidate = cargoArchiveIdentity(file, readPortableArchiveEntries(file));
  assert.equal(candidate.sha256, row.checksum, 'Held SDK archive differs from genuine Cargo lock');
  return candidate;
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

export type InstalledCargoFloorPool = {
  archives: ReturnType<typeof cargoCandidate>[];
  owners: Record<string, string>;
};
export type InstalledCargoMinimum = {
  floors: { name: string; version: string }[];
  heldInputs: ReturnType<typeof cargoCandidate>[];
  /** Broker minimum compiles its original source envelope; installed SQL is separate. */
  source?: ReturnType<typeof cargoCandidate>;
};
export type InstalledConsumerCase = [
  name: string,
  inputs: ReturnType<typeof cargoCandidate>[],
  minimum?: InstalledCargoMinimum,
];

function minimumSourceCase(
  source: ReturnType<typeof cargoCandidate>,
  candidates: ReturnType<typeof cargoCandidate>[],
  fixtureLock: string,
  selectedProducts: string[],
  floorPool: InstalledCargoFloorPool,
): InstalledConsumerCase {
  assert(
    selectedProducts.includes(floorPool.owners[source.name]),
    'Minimum needs its selected source owner',
  );
  const locked = Bun.TOML.parse(fixtureLock).package;
  const held = new Map<string, ReturnType<typeof cargoCandidate>>();
  for (const row of floorPool.archives) {
    const key = row.name + '@' + row.version;
    const previous = held.get(key);
    assert(
      !previous || previous.sha256 === row.sha256,
      'Conflicting completed floor archive: ' + key,
    );
    held.set(key, row);
  }
  const dependencies = (row: ReturnType<typeof cargoCandidate>) =>
    [row.manifest, ...Object.values(row.manifest.target ?? {})].flatMap((table: any) =>
      ['dependencies', 'build-dependencies'].flatMap((section) =>
        Object.entries(table[section] ?? {}).flatMap(([alias, raw]: [string, any]) => {
          const declaration = typeof raw === 'string' ? { version: raw } : raw;
          const name = declaration.package ?? alias;
          if (!Object.hasOwn(floorPool.owners, name)) return [];
          assert(
            typeof declaration.version === 'string' &&
              !declaration.path &&
              !declaration.git &&
              !declaration.workspace &&
              !declaration.registry,
            'Source floor dependency is not a conventional registry requirement: ' + name,
          );
          return [{ name, requirement: declaration.version as string }];
        }),
      ),
    );
  const selected = new Map([[source.name, source]]);
  const heldInputs = new Set<ReturnType<typeof cargoCandidate>>();
  const currentExact = (name: string, version: string) => {
    if (!selectedProducts.includes(floorPool.owners[name])) return undefined;
    const matches = candidates.filter((row) => row.name === name && row.version === version);
    assert(matches.length <= 1, 'Ambiguous current floor archive: ' + name + '@' + version);
    return matches[0];
  };
  const retain = (name: string, version: string) => {
    const row = held.get(name + '@' + version);
    if (!row) return undefined;
    for (const lock of locked.filter((item: any) => item.name === name && item.version === version))
      if (lock.source) {
        assert.equal(lock.source, 'registry+https://github.com/rust-lang/crates.io-index');
        assert.equal(
          lock.checksum,
          row.sha256,
          'Completed floor differs from fixture lock: ' + name,
        );
      }
    heldInputs.add(row);
    return row;
  };
  // Fix every direct source floor before visiting weaker transitive requirements.
  const directRequirements = new Map<string, string[]>();
  for (const { name, requirement } of dependencies(source)) {
    directRequirements.set(name, [...(directRequirements.get(name) ?? []), requirement]);
  }
  for (const [name, requirements] of directRequirements) {
    const version = cargoDependencyMinimum(requirements);
    const row = retain(name, version) ?? currentExact(name, version);
    assert(row, 'Missing exact source dependency floor archive: ' + name + '@' + version);
    selected.set(name, row);
  }
  const pending = [...selected.values()];
  for (const row of pending)
    for (const { name, requirement } of dependencies(row)) {
      const chosen = selected.get(name);
      if (chosen) {
        assert(
          cargoSatisfies(chosen.version, requirement),
          'Source floor conflicts with downstream requirement: ' + name + ' ' + requirement,
        );
        continue;
      }
      const retained = locked.filter(
        (item: any) =>
          item.name === name &&
          item.source === 'registry+https://github.com/rust-lang/crates.io-index' &&
          cargoSatisfies(item.version, requirement) &&
          held.has(name + '@' + item.version),
      );
      assert(retained.length <= 1, 'Ambiguous held source dependency: ' + name);
      const dependency = retained.length
        ? retain(name, retained[0].version)
        : currentExact(name, cargoDependencyMinimum(requirement));
      assert(
        dependency,
        'Missing actual held or selected exact source dependency: ' + name + ' ' + requirement,
      );
      selected.set(name, dependency);
      pending.push(dependency);
    }
  const inputs = [...selected.values()];
  return [
    source.name === 'oliphaunt' ? 'sdk' : 'broker',
    inputs,
    {
      floors: inputs
        .filter((row) => row.name !== source.name)
        .map(({ name, version }) => ({ name, version })),
      heldInputs: [...heldInputs],
      ...(source.name === 'oliphaunt-broker' ? { source } : {}),
    },
  ];
}

/** Verify all exact archive patches after Cargo has completed every precise update. */
export function assertInstalledCargoMinimum(
  lockText: string,
  inputs: ReturnType<typeof cargoCandidate>[],
  minimum: InstalledCargoMinimum,
) {
  const lock = Bun.TOML.parse(lockText).package;
  for (const floor of minimum.floors) {
    const archive = inputs.filter(
      (row) => row.name === floor.name && row.version === floor.version,
    );
    assert.equal(archive.length, 1, 'Missing staged source floor identity: ' + floor.name);
    const resolved = lock.filter((row: any) => row.name === floor.name);
    assert.equal(resolved.length, 1, 'Ambiguous resolved source floor: ' + floor.name);
    assert.equal(
      resolved[0].version,
      floor.version,
      'Resolved source dependency is not its exact floor: ' + floor.name,
    );
    assert.equal(
      resolved[0].source,
      undefined,
      'Source floor did not use its explicit archive patch: ' + floor.name,
    );
    for (const held of minimum.heldInputs.filter((row) => row.name === floor.name))
      assert.equal(
        archive[0].sha256,
        held.sha256,
        'Staged completed floor identity differs: ' + floor.name,
      );
  }
}

export function installedConsumerCases(
  candidates: ReturnType<typeof cargoCandidate>[],
  fixtureLock: string,
  selectedProducts: string[],
  minimum: boolean,
  floorPool?: InstalledCargoFloorPool,
): InstalledConsumerCase[] {
  const sdkRoots = candidates.filter((candidate) =>
    ['oliphaunt', 'oliphaunt-build'].includes(candidate.name),
  );
  const core = candidates.filter((candidate) => candidate.name === 'liboliphaunt-native-bindings');
  assert.equal(core.length, 1, 'installed Core consumer needs one actual candidate envelope');
  if (minimum) {
    const roots = [
      ['oliphaunt', 'oliphaunt-rust'],
      ['oliphaunt-broker', 'oliphaunt-broker'],
    ].filter(([, owner]) => selectedProducts.includes(owner));
    assert(roots.length, 'declared minimum qualification requires its prepared selected owner');
    assert(floorPool, 'Source minimum requires actual completed floor inputs and source owners');
    return roots.flatMap(([name, owner]) => {
      const source = candidates.filter((row) => row.name === name);
      assert.equal(source.length, 1, 'Minimum needs one current source archive: ' + name);
      assert.equal(floorPool.owners[name], owner, 'Minimum source owner differs: ' + name);
      const result = minimumSourceCase(
        source[0],
        candidates,
        fixtureLock,
        selectedProducts,
        floorPool,
      );
      return result[2]!.floors.length ? [result] : [];
    });
  }
  const helper = candidates.filter((row) => row.name === 'oliphaunt-build');
  assert.equal(helper.length, 1, 'Installed helper consumer needs one current helper archive');
  const helperInputs = candidateDependencyInputs(helper, candidates, fixtureLock, true);
  assert(
    !helperInputs.some((row) => row.name === 'oliphaunt'),
    'Helper consumer must retain its genuine held SDK',
  );
  return [
    ['checkout', candidateDependencyInputs(sdkRoots, candidates, fixtureLock)],
    [
      'liboliphaunt-native-bindings',
      candidateDependencyInputs(core, candidates, fixtureLock, true),
    ],
    ['helper-held-sdk', helperInputs],
  ];
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
  const floorPool: InstalledCargoFloorPool | undefined = spec.floorPool && {
    owners: spec.floorPool.owners,
    archives: spec.floorPool.archives.map(
      (
        row: { file: string; name: string; version: string; size: number; sha256: string },
        index: number,
      ) => {
        const copied = path.join(
          archiveDirectory,
          'held-floor-' + index + '-' + path.basename(row.file),
        );
        copyFileSync(file(row.file), copied);
        const held = cargoArchiveIdentity(copied, readPortableArchiveEntries(copied));
        assert.equal(readFileSync(copied).length, row.size, 'Completed floor archive size differs');
        assert.equal(held.name, row.name, 'Completed floor package name differs');
        assert.equal(held.version, row.version, 'Completed floor package version differs');
        assert.equal(held.sha256, row.sha256, 'Completed floor archive checksum differs');
        return held;
      },
    ),
  };
  const payloadPool = cargoPayloadPool(
    spec.payloadPool ?? { completed: [], current: [], owners: {} },
    spec.sourceOwners ?? {},
    file,
    archiveDirectory,
  );
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
    floorPool,
  );
  const receipts = [];
  for (const [name, selectedCandidates, minimum] of cases) {
    const directory = path.join(root, name);
    const consumer = minimum?.source
      ? path.join(directory, 'crates', minimum.source.name + '-' + minimum.source.version)
      : path.join(directory, 'consumer');
    const storage = path.join(directory, 'database-storage');
    if (!minimum?.source) mkdirSync(path.join(consumer, 'src'), { recursive: true });
    const sourceManifest =
      minimum?.source &&
      readPortableArchiveEntries(minimum.source.file).get(
        `${minimum.source.name}-${minimum.source.version}/Cargo.toml`,
      );
    if (minimum?.source) assert(sourceManifest?.isFile, 'Original source manifest is missing');
    const manifest = sourceManifest
      ? Buffer.from(sourceManifest.data()).toString('utf8')
      : candidateConsumerManifest(readFileSync(file(spec.manifest), 'utf8'), selectedCandidates);
    const sdk =
      name === 'helper-held-sdk'
        ? heldSdkCandidate(fixtureLock, cargoHome)
        : selectedCandidates.find((row) => row.name === 'oliphaunt');
    const source =
      minimum?.source ??
      sdk ??
      selectedCandidates.find((row) => row.name === 'liboliphaunt-native-bindings');
    assert(source, 'Installed case has no actual source owner');
    const payloadInputs = cargoPayloadInputs(
      sdk && !selectedCandidates.includes(sdk) ? [...selectedCandidates, sdk] : selectedCandidates,
      payloadPool,
      {
        currentSources: candidates,
        sourceOwners: spec.sourceOwners ?? {},
        selectedProducts: spec.selectedProducts,
        includeDev: !minimum,
        ...(minimum?.source ? {} : { consumer: { manifest: Bun.TOML.parse(manifest), source } }),
      },
    );
    const stagedCandidates = [...selectedCandidates, ...payloadInputs];
    const config = stageCargoCarrierInputs(stagedCandidates, directory);
    const origin = (candidate: CargoCandidate) =>
      payloadPool.completed.some(
        (row) =>
          row.name === candidate.name &&
          row.version === candidate.version &&
          row.sha256 === candidate.sha256,
      )
        ? 'completed-payload'
        : payloadInputs.includes(candidate)
          ? 'current-payload'
          : minimum?.heldInputs.includes(candidate)
            ? 'completed-floor'
            : 'current-source';
    if (!minimum?.source) writeFileSync(path.join(consumer, 'Cargo.toml'), manifest);
    if (!minimum?.source) {
      copyFileSync(file(spec.lock), path.join(consumer, 'Cargo.lock'));
      copyFileSync(
        file(name === 'liboliphaunt-native-bindings' ? spec.coreSource : spec.source),
        path.join(consumer, 'src/main.rs'),
      );
      if (name === 'liboliphaunt-native-bindings')
        copyFileSync(file(spec.coreBuildScript), path.join(consumer, 'core-build.rs'));
      else copyFileSync(file(spec.buildScript), path.join(consumer, 'build.rs'));
    }
    const cargo = (command: string[], captureMessages = false) => {
      const result = Bun.spawnSync(
        [
          file(spec.cargo),
          '--config',
          config,
          ...command,
          '--offline',
          ...(command[0] === 'install'
            ? []
            : ['--manifest-path', path.join(consumer, 'Cargo.toml')]),
        ],
        {
          cwd: consumer,
          env: { ...env, OLIPHAUNT_INSTALLED_STORAGE: storage },
          stdout: captureMessages ? 'pipe' : 'inherit',
          stderr: 'inherit',
        },
      );
      assert.equal(
        result.exitCode,
        0,
        `installed Cargo qualification failed: ${command.join(' ')}`,
      );
      return captureMessages ? result.stdout.toString('utf8') : '';
    };
    if (minimum?.source) {
      // Stock install compiles the original binary package's production graph.
      // It ignores the packaged root/dev lock without rewriting authored inputs.
      const messages = cargo(
        [
          'install',
          '--path',
          consumer,
          '--root',
          path.join(directory, 'installed'),
          '--debug',
          '--jobs',
          '2',
          '--message-format',
          'json',
        ],
        true,
      );
      const compiled = assertCargoSourceArtifacts(
        messages,
        stagedCandidates.map((candidate) => ({
          name: candidate.name,
          version: candidate.version,
          manifestPath: path.join(
            directory,
            'crates',
            candidate.name + '-' + candidate.version,
            'Cargo.toml',
          ),
        })),
        [minimum.source.name],
      );
      receipts.push({
        case: name,
        candidates: stagedCandidates.map((candidate) => ({
          name: candidate.name,
          version: candidate.version,
          sha256: candidate.sha256,
          origin: origin(candidate),
          selected: compiled.some((source) => source.name === candidate.name),
        })),
        compiled,
      });
      continue;
    }
    // Genuine Cargo reconciles candidate versions using the closed registry context.
    // This is qualification/preflight, never construction or a publication baseline.
    cargo(['generate-lockfile']);
    for (const floor of minimum?.floors ?? [])
      cargo(['update', '-p', floor.name, '--precise', floor.version]);
    const lockText = readFileSync(path.join(consumer, 'Cargo.lock'), 'utf8');
    if (minimum) assertInstalledCargoMinimum(lockText, selectedCandidates, minimum);
    const lock = Bun.TOML.parse(lockText);
    const runtime =
      name === 'liboliphaunt-native-bindings'
        ? Bun.TOML.parse(manifest).package.metadata.oliphaunt['runtime-version']
        : resolvedSdkRuntime(manifest, lockText, selectedCandidates, cargoHome);
    for (const pkg of lock.package) {
      if (pkg.source || pkg.name === 'frozen-consumer') continue;
      assert(
        stagedCandidates.some(
          (candidate) => candidate.name === pkg.name && candidate.version === pkg.version,
        ),
        `unselected package was resolved from local source: ${pkg.name}@${pkg.version}`,
      );
    }
    for (const candidate of selectedCandidates) {
      if (minimum?.heldInputs.includes(candidate)) continue;
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
      candidates: stagedCandidates.map((candidate) => ({
        name: candidate.name,
        version: candidate.version,
        sha256: candidate.sha256,
        origin: origin(candidate),
        selected: lock.package.some(
          (pkg: any) =>
            pkg.name === candidate.name && pkg.version === candidate.version && !pkg.source,
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
          ? cases.map(([name]) =>
              name === 'broker' ? 'broker-declared-floor-source-compile' : 'sdk-declared-minimum',
            )
          : ['direct-sql-reopen', 'broker-sql-reopen', 'core-direct-sql-reopen'],
        compositions: receipts,
      },
      null,
      2,
    )}\n`,
  );
}

if (import.meta.main) await main(process.argv.slice(2));
