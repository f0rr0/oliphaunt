import { afterAll, expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDeterministicTar } from '../../../tools/packaging/archive-directory.mts';
import { renderCargoToml } from '../../../tools/packaging/cargo-manifest.mts';
import { stageCargoCarrierInputs } from '../../../tools/packaging/frozen-cargo.mts';
import { canonicalGzipSync } from '../../../tools/packaging/portable-archive.mts';
import { cargoCandidate } from './consumer.mts';
import { writeRegistryIndex } from './context.mts';
import {
  currentPathDependencies,
  sourceCandidates,
  sourceCompile,
  sourceLock,
} from './source-compile.mts';

const directory = mkdtempSync(path.join(tmpdir(), 'source-lock-selection-'));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
async function archive(
  name: string,
  version: string,
  dependencies: Record<string, string> = {},
  source = '',
) {
  const tree = path.join(
    directory,
    `${name}-${version}-${Math.random().toString(16).slice(2)}`,
    `${name}-${version}`,
  );
  mkdirSync(path.join(tree, 'src'), { recursive: true });
  writeFileSync(
    path.join(tree, 'Cargo.toml'),
    renderCargoToml({ package: { name, version, edition: '2021' }, dependencies }),
  );
  writeFileSync(path.join(tree, 'src/lib.rs'), source);
  const file = `${tree}.crate`;
  writeFileSync(file, canonicalGzipSync(await createDeterministicTar(tree, { keepParent: true })));
  return cargoCandidate(file);
}
const child = await archive('fixture-child', '0.1.0');
const childNext = await archive('fixture-child', '0.1.1');
const parent = await archive('fixture-parent', '0.2.0', { 'fixture-child': '=0.1.0' });
const parentNext = await archive('fixture-parent', '0.2.1', { 'fixture-child': '=0.1.0' });
const parentAdopts = await archive('fixture-parent', '0.2.1', { 'fixture-child': '=0.1.1' });
const parentRaisesFloor = await archive('fixture-parent', '0.2.1', { 'fixture-child': '^0.1.1' });
const parentRange = await archive('fixture-parent', '0.2.1', { 'fixture-child': '^0.1.0' });
const server = await archive('fixture-server', '0.3.0', {
  'fixture-parent': '0.2.0',
  'fixture-child': '0.1.0',
});
const serverNext = await archive('fixture-server', '0.3.1', {
  'fixture-parent': '0.2.0',
  'fixture-child': '0.1.0',
});
const serverAdopts = await archive('fixture-server', '0.3.1', {
  'fixture-parent': '=0.2.1',
  'fixture-child': '=0.1.1',
});
const registry = {
  name: 'fixture-registry',
  version: '1.0.0',
  source: 'registry+https://github.com/rust-lang/crates.io-index',
  checksum: 'a'.repeat(64),
};
const lock = (packages: (typeof child)[]) =>
  renderCargoToml({
    version: 4,
    package: [...packages.map((row) => ({ name: row.name, version: row.version })), registry],
  });
const parentLock = lock([parent, child]);
const serverLock = lock([server, parent, child]);
const identities = (rows: (typeof child)[]) =>
  rows.map((row) => `${row.name}@${row.version}`).sort();
const minimumCandidates = (
  root: typeof child,
  pool: (typeof child)[],
  captured: string,
  held: (typeof child)[] = [],
) => sourceCandidates(root, pool, captured, held, { minimum: true, includeDev: false });

test('query-only own version retargets one local row and preserves registry resolution', () => {
  const original = lock([child]);
  const result = Bun.TOML.parse(sourceLock(original, sourceCandidates(childNext, [], original)));
  expect(result.package).toEqual([{ name: child.name, version: childNext.version }, registry]);
});
test('captured generated carriers remain payload inputs while every source-cohort archive stays explicit', async () => {
  const engine = await archive('fixture-owned-engine', '0.2.0');
  const sdk = await archive('fixture-owning-sdk', '0.2.0', {
    [child.name]: '=0.1.0',
    [engine.name]: '=0.2.0',
  });
  const captured = lock([sdk, child, engine]);
  expect(() => sourceCandidates(sdk, [child], captured, [child])).toThrow(
    'Missing actual held local archive: fixture-owned-engine',
  );
  expect(
    identities(
      sourceCandidates(sdk, [child], captured, [child], {
        payloadNames: new Set([engine.name]),
      }),
    ),
  ).toEqual([`${child.name}@${child.version}`, `${sdk.name}@${sdk.version}`].sort());
  expect(() =>
    sourceCandidates(sdk, [], captured, [], {
      payloadNames: new Set([engine.name]),
    }),
  ).toThrow('Missing actual held local archive: fixture-child');
  const overlapping = renderCargoToml({
    version: 4,
    package: [
      ...Bun.TOML.parse(captured).package,
      { ...registry, name: engine.name, version: engine.version },
    ],
  });
  expect(() =>
    sourceCandidates(sdk, [child], overlapping, [child], {
      payloadNames: new Set([engine.name]),
    }),
  ).toThrow('Captured local/registry identity overlaps');
});
test('SDK-only bump retains exact query even when a newer candidate is present', () => {
  expect(identities(sourceCandidates(parentNext, [childNext, child], parentLock, [child]))).toEqual(
    ['fixture-child@0.1.0', 'fixture-parent@0.2.1'],
  );
});
test('server-only bump retains SDK and query through conventional caret requirements', () => {
  expect(
    identities(
      sourceCandidates(serverNext, [parentNext, childNext, parent, child], serverLock, [
        parent,
        child,
      ]),
    ),
  ).toEqual(['fixture-child@0.1.0', 'fixture-parent@0.2.0', 'fixture-server@0.3.1']);
});
test('coordinated adoption selects new query only after packaged requirement changes', () => {
  expect(identities(sourceCandidates(parentAdopts, [childNext, child], parentLock))).toEqual([
    'fixture-child@0.1.1',
    'fixture-parent@0.2.1',
  ]);
  expect(
    identities(
      sourceCandidates(serverAdopts, [parentAdopts, childNext, parent, child], serverLock),
    ),
  ).toEqual(['fixture-child@0.1.1', 'fixture-parent@0.2.1', 'fixture-server@0.3.1']);
});
test('same-version completed bytes win over unselected current source bytes', async () => {
  const changed = await archive(child.name, child.version, {}, '// current unpublished source\n');
  const selected = sourceCandidates(parentNext, [changed], parentLock, [child]);
  expect(selected.find((row) => row.name === child.name)?.sha256).toBe(child.sha256);
});
test('authored current path adoption selects actual current bytes before version calculation', async () => {
  const changed = await archive(child.name, child.version, {}, 'pub fn new_api() {}\n');
  const currentPaths = { [parentNext.name]: [child.name] };
  const selected = sourceCandidates(parentNext, [changed], parentLock, [child], { currentPaths });
  expect(selected.find((row) => row.name === child.name)?.sha256).toBe(changed.sha256);
  expect(
    minimumCandidates(parentNext, [changed], parentLock, [child]).find(
      (row) => row.name === child.name,
    )?.sha256,
  ).toBe(child.sha256);
});
test('current path intent verifies the original manifest and explicit dependency archive', () => {
  const root = mkdtempSync(path.join(directory, 'path-intent-'));
  const parentDirectory = path.join(root, 'parent'),
    childDirectory = path.join(root, 'query');
  mkdirSync(parentDirectory);
  mkdirSync(childDirectory);
  const workspace = path.join(root, 'Cargo.toml');
  writeFileSync(
    workspace,
    renderCargoToml({
      workspace: {
        dependencies: { query: { package: child.name, version: '^0.1.0', path: 'query' } },
      },
    }),
  );
  const parentManifest = path.join(parentDirectory, 'Cargo.toml'),
    childManifest = path.join(childDirectory, 'Cargo.toml');
  writeFileSync(
    childManifest,
    renderCargoToml({ package: { name: child.name, version: child.version } }),
  );
  const sources = {
    [parent.name]: { manifest: parentManifest, workspace },
    [child.name]: { manifest: childManifest, workspace },
  };
  for (const dependency of [
    { package: child.name, version: '^0.1.0', path: '../query' },
    { workspace: true },
  ]) {
    writeFileSync(
      parentManifest,
      renderCargoToml({
        package: { name: parent.name, version: parent.version },
        dependencies: { query: dependency },
      }),
    );
    expect(currentPathDependencies(sources)[parent.name]).toEqual([child.name]);
  }
  expect(() =>
    currentPathDependencies(
      { [parent.name]: sources[parent.name] },
      new Set([parent.name, child.name]),
    ),
  ).toThrow('Missing explicit current path archive');
  writeFileSync(
    parentManifest,
    renderCargoToml({
      package: { name: parent.name, version: parent.version },
      dependencies: { query: { package: child.name, version: '^0.1.0', path: '.' } },
    }),
  );
  expect(() => currentPathDependencies(sources)).toThrow('Current path does not identify');
});
test('current workspace path intent never retargets an unchanged held source dependency', async () => {
  const changed = await archive(child.name, child.version, {}, 'pub fn new_api() {}\n');
  const selected = sourceCandidates(serverNext, [parent, changed], serverLock, [parent, child], {
    currentPaths: { [parent.name]: [child.name] },
  });
  expect(selected.find((row) => row.name === child.name)?.sha256).toBe(child.sha256);
});
test('missing exact held identity fails instead of adopting a compatible newer version', () => {
  expect(() => sourceCandidates(serverNext, [parentNext, childNext], serverLock)).toThrow(
    'Missing actual held',
  );
});
test('same-version current bytes never stand in for missing completed dependency bytes', () => {
  expect(() => sourceCandidates(parentNext, [child], parentLock)).toThrow('Missing actual held');
  expect(() => sourceCandidates(serverNext, [parent, child], serverLock)).toThrow(
    'Missing actual held',
  );
});
test('missing adopted candidate and conflicting identities fail closed', () => {
  expect(() => sourceCandidates(parentAdopts, [child], parentLock)).toThrow('Missing or ambiguous');
  expect(() =>
    sourceCandidates(parentNext, [child, { ...child, sha256: '0'.repeat(64) }], parentLock),
  ).toThrow('Conflicting actual');
  expect(() =>
    sourceCandidates(parentNext, [child, { ...child, name: 'undeclared' }], parentLock),
  ).toThrow('Undeclared local');
});
test('newly authored floor uses the exact completed source instead of a compatible newer candidate', async () => {
  const childHigher = await archive(child.name, '0.1.2');
  const selected = minimumCandidates(parentRaisesFloor, [childHigher], parentLock, [childNext]);
  expect(identities(selected)).toEqual(['fixture-child@0.1.1', 'fixture-parent@0.2.1']);
  expect(selected.find((row) => row.name === child.name)?.sha256).toBe(childNext.sha256);
});
test('a compatible held identity above the declared floor does not replace the actual floor', () => {
  expect(
    identities(
      minimumCandidates(parentRange, [childNext], lock([parent, childNext]), [child, childNext]),
    ),
  ).toEqual(['fixture-child@0.1.0', 'fixture-parent@0.2.1']);
});
test('missing authored floor rejects a compatible higher source before Cargo runs', async () => {
  const childHigher = await archive(child.name, '0.1.2');
  expect(() => minimumCandidates(parentRaisesFloor, [childHigher], parentLock)).toThrow(
    'Missing actual local dependency minimum: fixture-child@0.1.1',
  );
});
test('first source floor permits only its exact prepared selected constructed producer', () => {
  const options = {
    minimum: true,
    includeDev: false,
    sourceOwners: { [child.name]: { product: 'query', version: child.version } },
    selectedProducts: ['query'],
  };
  expect(identities(sourceCandidates(parentNext, [child], parentLock, [], options))).toEqual([
    'fixture-child@0.1.0',
    'fixture-parent@0.2.1',
  ]);
  expect(() =>
    sourceCandidates(parentNext, [child], parentLock, [], { ...options, selectedProducts: [] }),
  ).toThrow('Missing actual local dependency minimum');
  expect(() =>
    sourceCandidates(parentNext, [child], parentLock, [], {
      ...options,
      sourceOwners: { [child.name]: { product: 'query', version: '0.1.1' } },
    }),
  ).toThrow('Missing actual local dependency minimum');
});
test('a stronger root floor still satisfies a compatible lower transitive requirement', async () => {
  const compatibleParent = await archive(parent.name, parent.version, { [child.name]: '^0.1.0' });
  const serverConflicts = {
    ...serverNext,
    manifest: {
      ...serverNext.manifest,
      dependencies: { 'fixture-parent': '0.2.0', 'fixture-child': '0.1.1' },
    },
  };
  expect(
    identities(
      minimumCandidates(serverConflicts, [compatibleParent, childNext], serverLock, [
        compatibleParent,
        child,
        childNext,
      ]),
    ),
  ).toEqual(['fixture-child@0.1.1', 'fixture-parent@0.2.0', 'fixture-server@0.3.1']);
  expect(() =>
    minimumCandidates(serverConflicts, [parent, childNext], serverLock, [parent, child, childNext]),
  ).toThrow('Conflicting packaged local requirement');
});
test('target build and development local source requirements retain their captured floor closure', () => {
  for (const section of ['build-dependencies', 'dev-dependencies']) {
    const manifest = {
      ...parentNext.manifest,
      dependencies: {},
      target: { 'cfg(unix)': { [section]: { query: { package: child.name, version: '^0.1.0' } } } },
    };
    expect(
      identities(sourceCandidates({ ...parentNext, manifest }, [childNext], parentLock, [child])),
    ).toEqual(['fixture-child@0.1.0', 'fixture-parent@0.2.1']);
  }
});
test('normal and build requirements on the same package use their effective floor regardless of section order', async () => {
  for (const [normal, build] of [
    ['^0.1.0', '^0.1.1'],
    ['^0.1.1', '^0.1.0'],
  ]) {
    const root = await archive(parent.name, parentNext.version, { [child.name]: normal });
    root.manifest['build-dependencies'] = { query: { package: child.name, version: build } };
    expect(
      identities(minimumCandidates(root, [child], lock([parent, childNext]), [childNext])),
    ).toEqual(['fixture-child@0.1.1', 'fixture-parent@0.2.1']);
  }
});
test('registry identities and missing captured local rows cannot be retargeted', () => {
  expect(() => sourceLock(parentLock, [{ ...child, name: registry.name }])).toThrow(
    'Registry package cannot',
  );
  expect(() => sourceLock(parentLock, [{ ...child, name: 'absent' }])).toThrow('ambiguous');
});
test('qualified local references follow own versions without touching registry references', () => {
  const original = renderCargoToml({
    version: 4,
    package: [
      {
        name: parent.name,
        version: parent.version,
        dependencies: [`${child.name} ${child.version}`, registry.name],
      },
      { name: child.name, version: child.version },
      registry,
    ],
  });
  const result = Bun.TOML.parse(sourceLock(original, [parentAdopts, childNext]));
  expect(result.package[0].dependencies).toEqual([
    `${child.name} ${childNext.version}`,
    registry.name,
  ]);
  expect(result.package[2]).toEqual(registry);
});
test('unchanged candidate identities preserve the original Cargo lock bytes', () => {
  expect(sourceLock(parentLock, [parent, child])).toBe(parentLock);
  expect(readFileSync(child.file).length).toBeGreaterThan(0);
});
test('failure removes only owned work and retains diagnostics outside it', async () => {
  const scratch = mkdtempSync(path.join(directory, 'cleanup-'));
  const specification = path.join(scratch, 'spec.json');
  writeFileSync(specification, JSON.stringify({ archives: [] }));
  const previousTemporary = process.env.TEST_TMPDIR;
  const previousDiagnostics = process.env.TEST_UNDECLARED_OUTPUTS_DIR;
  process.env.TEST_TMPDIR = scratch;
  delete process.env.TEST_UNDECLARED_OUTPUTS_DIR;
  try {
    await expect(sourceCompile(specification, scratch)).rejects.toThrow();
    const members = readdirSync(scratch);
    expect(members.some((name) => name.startsWith('installed-source-compile-'))).toBe(false);
    expect(members.some((name) => name.startsWith('installed-source-diagnostics-'))).toBe(true);
    expect(readFileSync(specification, 'utf8')).toBe('{"archives":[]}');
  } finally {
    if (previousTemporary === undefined) delete process.env.TEST_TMPDIR;
    else process.env.TEST_TMPDIR = previousTemporary;
    if (previousDiagnostics === undefined) delete process.env.TEST_UNDECLARED_OUTPUTS_DIR;
    else process.env.TEST_UNDECLARED_OUTPUTS_DIR = previousDiagnostics;
  }
});

async function qualifyOfflineCargoScenarios() {
  const runfiles = process.env.RUNFILES_DIR ?? process.env.TEST_SRCDIR;
  assert(
    runfiles && process.env.OLIPHAUNT_SOURCE_COMPILE_TEST_TOOLS && process.env.TEST_TMPDIR,
    'Run the configured source_compile_selection_test with its declared Cargo/Rust/compiler inputs',
  );
  const relative = (file: string) => path.relative(runfiles, file);
  const tools = JSON.parse(
    readFileSync(path.join(runfiles, process.env.OLIPHAUNT_SOURCE_COMPILE_TEST_TOOLS), 'utf8'),
  );
  const tool = (name: string) => path.join(runfiles, tools[name]);
  const scratch = mkdtempSync(path.join(process.env.TEST_TMPDIR, 'source-phase-cases-'));
  const query = await archive('fixture-query', '0.1.1', {}, 'pub fn stable() -> u32 { 11 }\n');
  const sdk = await archive(
    'fixture-sdk',
    '0.3.3',
    { [query.name]: '0.1.1' },
    'pub fn value() -> u32 { fixture_query::stable() }\n',
  );
  const captured = path.join(scratch, 'captured');
  mkdirSync(captured);
  const config = stageCargoCarrierInputs([sdk, query], captured);
  const manifest = path.join(captured, 'crates', `${sdk.name}-${sdk.version}`, 'Cargo.toml');
  const generated = Bun.spawnSync(
    [
      tool('cargo'),
      '--config',
      config,
      'generate-lockfile',
      '--offline',
      '--manifest-path',
      manifest,
    ],
    {
      env: {
        PATH: path.dirname(tool('rustc')),
        RUSTC: tool('rustc'),
        CARGO_HOME: path.join(captured, 'cargo-home'),
        HOME: captured,
        CARGO_NET_OFFLINE: 'true',
      },
    },
  );
  expect(generated.exitCode).toBe(0);
  const cargoVersion = Bun.spawnSync([tool('cargo'), '--version']);
  expect(cargoVersion.exitCode).toBe(0);
  const capturedLock = path.join(captured, 'Cargo.lock');
  writeFileSync(capturedLock, readFileSync(path.join(path.dirname(manifest), 'Cargo.lock')));
  const registryConfig = {
    dl: 'https://static.crates.io/crates/{crate}/{crate}-{version}.crate',
    api: 'https://crates.io',
  };
  const configFile = path.join(captured, 'config.json');
  writeFileSync(configFile, `${JSON.stringify(registryConfig)}\n`);
  const index = path.join(captured, 'registry-index.json');
  writeFileSync(
    index,
    JSON.stringify({
      schema: 'oliphaunt-installed-cargo-fixture-v1',
      cargo: cargoVersion.stdout.toString().trim().split(' ')[1],
      repository: 'index.crates.io-1949cf8c6b5b557f',
      target: 'x86_64-unknown-linux-gnu',
      archives: [],
      indexes: [],
      config: registryConfig,
    }),
  );
  let count = 0;
  async function qualify(
    root: typeof sdk,
    dependency: typeof query,
    held: (typeof query)[],
    minimum: boolean,
    expectedSuccess: boolean,
    sources: Record<string, { manifest: string; workspace: string }> = {},
    payloadFixture?: {
      lock: string;
      index: string;
      cargoHome: Record<string, string>;
      payloadPool: any;
      sourceOwners: any;
      selectedProducts: string[];
      expectedError?: RegExp;
    },
  ) {
    const directory = path.join(scratch, `case-${count++}`);
    const started = performance.now();
    console.error(
      `Offline Cargo ${path.basename(directory)}: ${root.name}@${root.version} minimum=${minimum} expectedSuccess=${expectedSuccess}`,
    );
    mkdirSync(directory);
    const diagnostics = path.join(directory, 'diagnostics');
    mkdirSync(diagnostics);
    const spec = path.join(directory, 'spec.json');
    writeFileSync(
      spec,
      JSON.stringify({
        ...tools,
        archives: [root.file, dependency.file].map(relative),
        sources: Object.fromEntries(
          Object.entries(sources).map(([archive, source]) => [
            relative(archive),
            { manifest: relative(source.manifest), workspace: relative(source.workspace) },
          ]),
        ),
        held: held.map((row) => ({
          file: relative(row.file),
          name: row.name,
          version: row.version,
          size: readFileSync(row.file).length,
          sha256: row.sha256,
        })),
        lock: relative(payloadFixture?.lock ?? capturedLock),
        index: relative(payloadFixture?.index ?? index),
        cargoHome: payloadFixture?.cargoHome ?? {
          [relative(configFile)]: 'index/index.crates.io-1949cf8c6b5b557f/config.json',
        },
        ...(payloadFixture
          ? {
              payloadPool: payloadFixture.payloadPool,
              sourceOwners: payloadFixture.sourceOwners,
              selectedProducts: payloadFixture.selectedProducts,
            }
          : {}),
        flags: [],
        minimum,
      }),
    );
    const previous = process.env.TEST_UNDECLARED_OUTPUTS_DIR;
    process.env.TEST_UNDECLARED_OUTPUTS_DIR = diagnostics;
    try {
      if (expectedSuccess) await sourceCompile(spec, runfiles);
      else
        await expect(sourceCompile(spec, runfiles)).rejects.toThrow(
          payloadFixture?.expectedError ?? /minimum-(build|install) failed/,
        );
      if (!expectedSuccess && payloadFixture?.expectedError) return {};
      const ordinary = JSON.parse(
        readFileSync(path.join(diagnostics, 'source-compile-result.json'), 'utf8'),
      );
      let floor;
      if (expectedSuccess && minimum)
        floor = JSON.parse(
          readFileSync(path.join(diagnostics, 'source-minimum-result.json'), 'utf8'),
        );
      return { ordinary, floor };
    } finally {
      console.error(
        `Offline Cargo ${path.basename(directory)} elapsed ${Math.round(performance.now() - started)}ms`,
      );
      if (previous === undefined) delete process.env.TEST_UNDECLARED_OUTPUTS_DIR;
      else process.env.TEST_UNDECLARED_OUTPUTS_DIR = previous;
    }
  }
  const floor = await archive(query.name, '0.1.2', {}, 'pub fn stable() -> u32 { 12 }\n');
  const higher = await archive(
    query.name,
    '0.1.3',
    {},
    'pub fn stable() -> u32 { 13 }\npub fn new_api() -> u32 { 13 }\n',
  );
  const devTree = path.join(scratch, 'dev-sdk', `${sdk.name}-0.3.4`);
  mkdirSync(path.join(devTree, 'src'), { recursive: true });
  writeFileSync(
    path.join(devTree, 'Cargo.toml'),
    renderCargoToml({
      package: { name: sdk.name, version: '0.3.4', edition: '2021' },
      dependencies: { [query.name]: '0.1.2' },
      'dev-dependencies': { [query.name]: '0.1.3' },
    }),
  );
  writeFileSync(
    path.join(devTree, 'src/lib.rs'),
    'pub fn value() -> u32 { fixture_query::new_api() }\n',
  );
  const devArchive = `${devTree}.crate`;
  writeFileSync(
    devArchive,
    canonicalGzipSync(await createDeterministicTar(devTree, { keepParent: true })),
  );
  const devRoot = cargoCandidate(devArchive);
  const ordinary = await qualify(devRoot, higher, [floor], false, true);
  expect(
    ordinary.ordinary.selectedCandidates.find((row: any) => row.name === query.name).version,
  ).toBe('0.1.3');
  await qualify(devRoot, higher, [floor], true, false);
  // A dependency consumer proves the library; a shipping binary must also
  // compile from its original source without dev requirements raising its floor.
  writeFileSync(
    path.join(devTree, 'src/lib.rs'),
    'pub fn value() -> u32 { fixture_query::stable() }\n',
  );
  writeFileSync(
    path.join(devTree, 'src/main.rs'),
    'fn main() { println!("{}", fixture_query::new_api()); }\n',
  );
  const binaryArchive = path.join(scratch, 'binary.crate');
  writeFileSync(
    binaryArchive,
    canonicalGzipSync(await createDeterministicTar(devTree, { keepParent: true })),
  );
  await qualify(cargoCandidate(binaryArchive), higher, [floor], true, false);
  writeFileSync(
    path.join(devTree, 'src/main.rs'),
    'fn main() { println!("{}", fixture_query::stable()); }\n',
  );
  const compatibleBinaryArchive = path.join(scratch, 'compatible-binary.crate');
  writeFileSync(
    compatibleBinaryArchive,
    canonicalGzipSync(await createDeterministicTar(devTree, { keepParent: true })),
  );
  const binary = await qualify(
    cargoCandidate(compatibleBinaryArchive),
    higher,
    [floor],
    true,
    true,
  );
  expect(binary.floor.level).toBe('offline-production-install');
  expect(binary.floor.selectedCandidates.find((row: any) => row.name === query.name).version).toBe(
    '0.1.2',
  );
  writeFileSync(
    path.join(devTree, 'Cargo.toml'),
    renderCargoToml({
      package: { name: sdk.name, version: '0.3.4', edition: '2021' },
      dependencies: { [query.name]: '0.1.2' },
      'dev-dependencies': { [query.name]: '0.1.3' },
      features: { inactive: [] },
      bin: [{ name: sdk.name, path: 'src/main.rs', 'required-features': ['inactive'] }],
    }),
  );
  writeFileSync(
    path.join(devTree, 'src/main.rs'),
    'fn main() { println!("{}", fixture_query::new_api()); }\n',
  );
  const inactiveArchive = path.join(scratch, 'inactive-binary.crate');
  writeFileSync(
    inactiveArchive,
    canonicalGzipSync(await createDeterministicTar(devTree, { keepParent: true })),
  );
  const inactive = await qualify(cargoCandidate(inactiveArchive), higher, [floor], true, true);
  expect(inactive.floor.level).toBe('locked-offline-dependent-compilation');
  const compatible = await archive(
    sdk.name,
    '0.3.4',
    { [query.name]: '0.1.2' },
    'pub fn value() -> u32 { fixture_query::stable() }\n',
  );
  const selected = await qualify(compatible, higher, [floor], true, true);
  expect(
    selected.floor.selectedCandidates.find((row: any) => row.name === query.name).version,
  ).toBe('0.1.2');
  const current = await archive(query.name, query.version, {}, 'pub fn new_api() -> u32 { 13 }\n');
  const coordinated = await archive(
    sdk.name,
    sdk.version,
    { [query.name]: query.version },
    'pub fn value() -> u32 { fixture_query::new_api() }\n',
  );
  const originalDirectory = path.join(scratch, 'original');
  mkdirSync(path.join(originalDirectory, 'sdk'), { recursive: true });
  mkdirSync(path.join(originalDirectory, 'query'));
  const workspace = path.join(originalDirectory, 'Cargo.toml');
  writeFileSync(workspace, '[workspace]\n');
  const originalSdk = path.join(originalDirectory, 'sdk/Cargo.toml'),
    originalQuery = path.join(originalDirectory, 'query/Cargo.toml');
  writeFileSync(
    originalSdk,
    renderCargoToml({
      package: { name: sdk.name, version: sdk.version },
      dependencies: { [query.name]: { version: query.version, path: '../query' } },
    }),
  );
  writeFileSync(
    originalQuery,
    renderCargoToml({ package: { name: query.name, version: query.version } }),
  );
  const sources = {
    [coordinated.file]: { manifest: originalSdk, workspace },
    [current.file]: { manifest: originalQuery, workspace },
  };
  const beforeVersions = await qualify(coordinated, current, [query], false, true, sources);
  expect(
    beforeVersions.ordinary.selectedCandidates.find((row: any) => row.name === query.name).sha256,
  ).toBe(current.sha256);
  await qualify(coordinated, current, [query], true, false, sources);
  // These tiny archives model historical captured registry inputs and actual
  // current constructor outputs. They make no publication authentication claim.
  const payloadNames = [
    'fixture-portable',
    'fixture-linux-x64',
    'fixture-linux-arm64',
    'fixture-macos',
    'fixture-windows',
    'fixture-part',
  ];
  async function payloadArchive(name: string, version: string) {
    if (name !== payloadNames[0])
      return archive(name, version, {}, 'pub fn stable() -> u32 { 21 }\n');
    const tree = path.join(scratch, `payload-${version}`, `${name}-${version}`);
    mkdirSync(path.join(tree, 'src'), { recursive: true });
    writeFileSync(
      path.join(tree, 'Cargo.toml'),
      renderCargoToml({
        package: { name, version, edition: '2021' },
        'build-dependencies': { [payloadNames[5]]: `=${version}` },
      }),
    );
    writeFileSync(
      path.join(tree, 'build.rs'),
      'fn main() { println!("cargo:rustc-env=VALUE={}", fixture_part::stable()); }\n',
    );
    writeFileSync(
      path.join(tree, 'src/lib.rs'),
      'pub fn stable() -> u32 { env!("VALUE").parse().unwrap() }\n',
    );
    const file = tree + '.crate';
    writeFileSync(
      file,
      canonicalGzipSync(await createDeterministicTar(tree, { keepParent: true })),
    );
    return cargoCandidate(file);
  }
  const heldPayloads = await Promise.all(payloadNames.map((name) => payloadArchive(name, '2.1.0')));
  const currentPayloads = await Promise.all(
    payloadNames.map((name) => payloadArchive(name, '2.2.0')),
  );
  const payloadContext = {
    schema: 'oliphaunt-installed-cargo-fixture-v1',
    cargo: cargoVersion.stdout.toString().trim().split(' ')[1],
    repository: 'index.crates.io-1949cf8c6b5b557f',
    target: 'x86_64-unknown-linux-gnu',
    config: registryConfig,
    archives: heldPayloads.map(({ name, version }) => ({ name, version })),
    indexes: heldPayloads.map((row) => ({
      path: `${row.name.slice(0, 2)}/${row.name.slice(2, 4)}/${row.name}`,
      header: Buffer.from([3, 2, 0, 0, 0, 0]).toString('base64'),
      records: [
        {
          name: row.name,
          vers: row.version,
          deps: Object.entries(row.manifest['build-dependencies'] ?? {}).map(([name, req]) => ({
            name,
            req,
            features: [],
            optional: false,
            default_features: true,
            target: null,
            kind: 'build',
            registry: null,
          })),
          cksum: row.sha256,
          features: {},
          yanked: false,
        },
      ],
    })),
  };
  const payloadHome = path.join(scratch, 'historical-payload-home');
  writeRegistryIndex(payloadContext, payloadHome);
  const payloadIndex = path.join(scratch, 'historical-payload-index.json');
  writeFileSync(payloadIndex, JSON.stringify(payloadContext));
  const payloadLock = path.join(scratch, 'historical-payload-lock.toml');
  writeFileSync(
    payloadLock,
    renderCargoToml({
      version: 4,
      package: [
        { name: sdk.name, version: sdk.version },
        { name: query.name, version: query.version },
        ...heldPayloads.map((row) => ({
          name: row.name,
          version: row.version,
          source: 'registry+https://github.com/rust-lang/crates.io-index',
          checksum: row.sha256,
        })),
      ],
    }),
  );
  const payloadCargoHome: Record<string, string> = {};
  const registryDirectory = path.join(payloadHome, 'registry');
  const captureFiles = (directory: string, prefix = '') => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const name = path.posix.join(prefix, entry.name);
      if (entry.isDirectory()) captureFiles(path.join(directory, entry.name), name);
      else payloadCargoHome[relative(path.join(directory, entry.name))] = name;
    }
  };
  captureFiles(registryDirectory);
  for (const row of heldPayloads)
    payloadCargoHome[relative(row.file)] =
      `cache/${payloadContext.repository}/${row.name}-${row.version}.crate`;
  const payloadRow = (row: typeof query) => ({
    product: 'runtime',
    version: row.version,
    artifact:
      row.name === payloadNames[5]
        ? `github-release:${row.name}-${row.version}.crate`
        : `cargo:${row.name}`,
    file: { path: relative(row.file), size: readFileSync(row.file).length, sha256: row.sha256 },
  });
  const payloadSdk = async (version: string) => {
    const source = await archive(
      sdk.name,
      '0.3.5',
      { [query.name]: query.version, [payloadNames[0]]: `=${version}` },
      'pub fn value() -> u32 { fixture_portable::stable() }\n',
    );
    const tree = path.join(scratch, 'payload-root-' + version, source.name + '-' + source.version);
    mkdirSync(path.join(tree, 'src'), { recursive: true });
    writeFileSync(
      path.join(tree, 'src/lib.rs'),
      'pub fn value() -> u32 { fixture_portable::stable() }\n',
    );
    const targets = [
      'cfg(all(target_os = "linux", target_arch = "x86_64"))',
      'cfg(all(target_os = "linux", target_arch = "aarch64"))',
      'cfg(target_os = "macos")',
      'cfg(target_os = "windows")',
    ];
    writeFileSync(
      path.join(tree, 'Cargo.toml'),
      renderCargoToml({
        ...source.manifest,
        target: Object.fromEntries(
          payloadNames
            .slice(1, 5)
            .map((name, index) => [
              targets[index],
              { dependencies: { [name]: { version: `=${version}` } } },
            ]),
        ),
      }),
    );
    const file = tree + '.crate';
    writeFileSync(
      file,
      canonicalGzipSync(await createDeterministicTar(tree, { keepParent: true })),
    );
    return cargoCandidate(file);
  };
  const heldRoot = await payloadSdk('2.1.0'),
    currentRoot = await payloadSdk('2.2.0');
  const fixture = (
    completed: (typeof query)[],
    actual: (typeof query)[],
    selectedProducts: string[],
  ) => ({
    lock: payloadLock,
    index: payloadIndex,
    cargoHome: payloadCargoHome,
    payloadPool: {
      completed: completed.map(payloadRow),
      current: actual.map(payloadRow),
      owners: Object.fromEntries(
        payloadNames.slice(0, 5).map((name) => [name, { product: 'runtime', version: '2.2.0' }]),
      ),
    },
    sourceOwners: {
      [sdk.name]: { product: 'sdk', version: currentRoot.version },
      [query.name]: { product: 'query', version: query.version },
    },
    selectedProducts,
  });
  const heldCase = await qualify(
    heldRoot,
    query,
    [query],
    false,
    true,
    {},
    fixture(heldPayloads, currentPayloads, []),
  );
  expect(
    heldCase.ordinary.selectedCandidates
      .filter((row: any) => payloadNames.includes(row.name))
      .every((row: any) => row.version === '2.1.0'),
  ).toBe(true);
  const publishedCase = await qualify(
    currentRoot,
    query,
    [query],
    false,
    true,
    {},
    fixture(currentPayloads, [], []),
  );
  expect(
    publishedCase.ordinary.selectedCandidates
      .filter((row: any) => payloadNames.includes(row.name))
      .map((row: any) => row.name)
      .sort(),
  ).toEqual([payloadNames[0], payloadNames[1], payloadNames[5]].toSorted());
  const currentCase = await qualify(
    currentRoot,
    query,
    [query],
    true,
    true,
    {},
    fixture([], currentPayloads, ['sdk', 'runtime']),
  );
  expect(
    currentCase.floor.selectedCandidates.find((row: any) => row.name === payloadNames[0]).version,
  ).toBe('2.2.0');
  await qualify(
    currentRoot,
    query,
    [query],
    false,
    false,
    {},
    {
      ...fixture(
        [],
        currentPayloads.filter((row) => row.name !== payloadNames[4]),
        ['sdk', 'runtime'],
      ),
      expectedError: /Missing actual exact payload archive: fixture-windows/,
    },
  );
  await qualify(
    currentRoot,
    query,
    [query],
    false,
    false,
    {},
    {
      ...fixture(
        [],
        currentPayloads.filter((row) => row.name !== payloadNames[5]),
        ['sdk', 'runtime'],
      ),
      expectedError: /generate-lock failed/,
    },
  );
}

test(
  'real offline Cargo distinguishes current path preparation, source tests and selected production floors',
  qualifyOfflineCargoScenarios,
  Number(process.env.TEST_TIMEOUT ?? 180) * 1_000,
);
