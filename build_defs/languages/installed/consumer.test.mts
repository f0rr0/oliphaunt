import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createDeterministicTar } from '../../../tools/packaging/archive-directory.mts';
import { assertCargoSourceArtifacts } from '../../../tools/packaging/frozen-cargo.mts';
import { canonicalGzipSync } from '../../../tools/packaging/portable-archive.mts';
import { archive } from '../../query/package.mts';
import {
  assertInstalledCargoMinimum,
  candidateConsumerManifest,
  candidateDependencyInputs,
  cargoCandidate,
  cargoPayloadInputs,
  cargoPayloadPool,
  installedConsumerCases,
  resolvedSdkRuntime,
} from './consumer.mts';

const template = readFileSync(`${import.meta.dir}/fixture/Cargo.toml`, 'utf8');
const sdkManifest = Bun.TOML.parse(
  readFileSync(new URL('../../../src/native/sdks/rust/Cargo.toml', import.meta.url), 'utf8'),
);
const heldRuntime = sdkManifest.package.metadata.oliphaunt['native-version'];

test('exact payload composition prefers completed bytes and materializes only requested archives', () => {
  const directory = mkdtempSync(join(tmpdir(), 'oliphaunt-payload-pool-'));
  try {
    const make = (name: string, version: string, source: string, dependencies = {}) => {
      const file = join(directory, `${name}-${version}-${source}.crate`);
      writeFileSync(
        file,
        archive({
          [`${name}-${version}/Cargo.toml`]: Buffer.from(
            `[package]\nname="${name}"\nversion="${version}"\n[dependencies]\n${Object.entries(
              dependencies,
            )
              .map(([name, version]) => `${name}="${version}"`)
              .join('\n')}\n`,
          ),
          [`${name}-${version}/src/lib.rs`]: Buffer.from(`pub fn ${source}() {}\n`),
        }),
      );
      return cargoCandidate(file);
    };
    const root = make('fixture-sdk', '1.1.0', 'sdk', { 'fixture-payload': '=2.1.0' });
    const held = make('fixture-payload', '2.1.0', 'held');
    const current = make(held.name, held.version, 'current');
    const row = (candidate: typeof held) => ({
      product: 'runtime',
      version: candidate.version,
      artifact: `cargo:${candidate.name}`,
      file: {
        path: candidate.file,
        size: readFileSync(candidate.file).length,
        sha256: candidate.sha256,
      },
    });
    const copied = join(directory, 'copied');
    mkdirSync(copied);
    const sourceOwners = { [root.name]: { product: 'sdk', version: root.version } };
    const pool = cargoPayloadPool(
      {
        completed: [row(held)],
        current: [
          row(current),
          {
            ...row(current),
            artifact: 'cargo:unused',
            file: { path: '/deliberately-unavailable-unused.crate' },
          },
        ],
        owners: { [held.name]: { product: 'runtime', version: held.version } },
      },
      sourceOwners,
      (name) => name,
      copied,
    );
    const options = { currentSources: [root], sourceOwners, selectedProducts: ['sdk', 'runtime'] };
    expect(cargoPayloadInputs([root], pool, options)[0].sha256).toBe(held.sha256);
    const currentOnly = cargoPayloadPool(
      { completed: [], current: [row(current)], owners: pool.owners },
      sourceOwners,
      (name) => name,
      copied,
    );
    expect(cargoPayloadInputs([root], currentOnly, options)[0].sha256).toBe(current.sha256);
    const aliasRoot = {
      ...root,
      manifest: {
        ...root.manifest,
        dependencies: { payload_alias: { package: held.name, version: '= 2.1.0' } },
      },
    };
    expect(
      cargoPayloadInputs([aliasRoot], currentOnly, { ...options, currentSources: [aliasRoot] })[0]
        .sha256,
    ).toBe(current.sha256);
    for (const selectedProducts of [[], ['sdk'], ['runtime']])
      expect(() =>
        cargoPayloadInputs([root], currentOnly, { ...options, selectedProducts }),
      ).toThrow('Missing actual exact payload');
    expect(() =>
      cargoPayloadInputs([root], currentOnly, { ...options, currentSources: [] }),
    ).toThrow('Missing actual exact payload');
    expect(() =>
      cargoPayloadInputs([root], currentOnly, {
        ...options,
        sourceOwners: { [root.name]: { product: 'sdk', version: '1.2.0' } },
      }),
    ).toThrow('Missing actual exact payload');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('payload aliases, all target pins and original part requirements reject missing or conflicting inputs', () => {
  const directory = mkdtempSync(join(tmpdir(), 'oliphaunt-payload-targets-'));
  try {
    const make = (name: string, version: string, manifest = '') => {
      const file = join(directory, `${name}-${version}.crate`);
      writeFileSync(
        file,
        archive({
          [`${name}-${version}/Cargo.toml`]: Buffer.from(
            `[package]\nname="${name}"\nversion="${version}"\n${manifest}`,
          ),
          [`${name}-${version}/src/lib.rs`]: Buffer.from('pub fn payload() {}\n'),
        }),
      );
      return cargoCandidate(file);
    };
    const part = make('fixture-part', '2.1.0');
    const payload = make(
      'fixture-payload',
      '2.1.0',
      '[build-dependencies]\nfixture-part="=2.1.0"\n',
    );
    const root = make(
      'fixture-sdk',
      '1.1.0',
      `[target.'cfg(unix)'.dependencies]\nleft={package="${payload.name}",version="=2.1.0"}\n[target.'cfg(windows)'.dependencies]\nright={package="${part.name}",version="=2.1.0"}\n`,
    );
    const row = (candidate: typeof part) => ({
      product: 'runtime',
      version: candidate.version,
      artifact: `github-release:${candidate.name}-${candidate.version}.crate`,
      file: {
        path: candidate.file,
        size: readFileSync(candidate.file).length,
        sha256: candidate.sha256,
      },
    });
    const sourceOwners = { [root.name]: { product: 'sdk', version: root.version } };
    const owners = {
      [payload.name]: { product: 'runtime', version: payload.version },
      [part.name]: { product: 'runtime', version: part.version },
    };
    const options = { currentSources: [root], sourceOwners, selectedProducts: ['sdk', 'runtime'] };
    let count = 0;
    const pool = (completed: any[], current: any[]) => {
      const copied = join(directory, `copied-${count++}`);
      mkdirSync(copied);
      return cargoPayloadPool({ completed, current, owners }, sourceOwners, (name) => name, copied);
    };
    expect(
      cargoPayloadInputs([root], pool([], [row(payload), row(part)]), options)
        .map((value) => value.name)
        .sort(),
    ).toEqual([part.name, payload.name]);
    expect(() => cargoPayloadInputs([root], pool([], [row(payload)]), options)).toThrow(
      'Missing actual exact payload archive: fixture-part',
    );
    expect(() => cargoPayloadInputs([root], pool([row(payload)], [row(part)]), options)).toThrow(
      'Held source cannot consume current payload bytes: fixture-part',
    );
    const higher = make(part.name, '2.2.0');
    expect(() =>
      cargoPayloadInputs([root], pool([row(payload), row(higher)], []), options),
    ).toThrow('Missing actual exact payload archive: fixture-part');
    expect(() => pool([], [{ ...row(payload), product: 'wrong' }])).toThrow(
      'Payload owner differs',
    );
    expect(() =>
      cargoPayloadInputs(
        [root],
        pool(
          [],
          [{ ...row(payload), file: { ...row(payload).file, sha256: '0'.repeat(64) } }, row(part)],
        ),
        options,
      ),
    ).toThrow('Payload archive SHA differs');
    expect(() =>
      cargoPayloadInputs(
        [root],
        pool([], [{ ...row(payload), artifact: 'cargo:fixture-part' }]),
        options,
      ),
    ).toThrow();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('ordinary current source consumes its own exact-version generated carrier family without release selection', () => {
  const directory = mkdtempSync(join(tmpdir(), 'oliphaunt-owned-carriers-'));
  try {
    const make = (name: string, manifest = '') => {
      const file = join(directory, `${name}.crate`);
      writeFileSync(
        file,
        archive({
          [`${name}-0.3.2/Cargo.toml`]: Buffer.from(
            `[package]\nname="${name}"\nversion="0.3.2"\n${manifest}`,
          ),
          [`${name}-0.3.2/src/lib.rs`]: Buffer.from('pub fn original() {}\n'),
        }),
      );
      return cargoCandidate(file);
    };
    const part = make('fixture-owned-part');
    const facade = make('fixture-owned-facade', `[dependencies]\n${part.name}="=0.3.2"\n`);
    const sdk = make(
      'fixture-owning-sdk',
      `[target.'cfg(windows)'.dependencies]\nengine={package="${facade.name}",version="=0.3.2"}\n`,
    );
    const sourceOwners = { [sdk.name]: { product: 'sdk', version: sdk.version } };
    const owners = Object.fromEntries(
      [part, facade].map(({ name, version }) => [name, { product: 'sdk', version }]),
    );
    const rows = [part, facade].map((candidate) => ({
      product: 'sdk',
      version: candidate.version,
      artifact: `cargo:${candidate.name}`,
      file: {
        path: candidate.file,
        size: readFileSync(candidate.file).length,
        sha256: candidate.sha256,
      },
    }));
    const options = { currentSources: [sdk], sourceOwners, selectedProducts: [] };
    let count = 0;
    const pool = (completed: typeof rows = [], current = rows) => {
      const destination = join(directory, `read-${count++}`);
      mkdirSync(destination);
      return cargoPayloadPool(
        { completed, current, owners },
        sourceOwners,
        (name) => name,
        destination,
      );
    };
    expect(
      cargoPayloadInputs([sdk], pool(), options)
        .map(({ name }) => name)
        .sort(),
    ).toEqual([part.name, facade.name].sort());
    expect(() => cargoPayloadInputs([sdk], pool(), { ...options, currentSources: [] })).toThrow(
      'Missing actual exact payload',
    );
    expect(() =>
      cargoPayloadInputs([sdk], pool(), {
        ...options,
        sourceOwners: { [sdk.name]: { product: 'other-sdk', version: sdk.version } },
      }),
    ).toThrow('Missing actual exact payload');
    expect(() => cargoPayloadInputs([sdk], pool([rows[1]], [rows[0]]), options)).toThrow(
      'Missing actual exact payload',
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Cargo compiler artifacts join staged manifests without parsing opaque package IDs', () => {
  const directory = mkdtempSync(join(tmpdir(), 'oliphaunt-cargo-artifacts-'));
  try {
    const sources = ['broker', 'core', 'inactive'].map((name) => {
      const manifestPath = join(directory, name, 'Cargo.toml');
      mkdirSync(dirname(manifestPath), { recursive: true });
      writeFileSync(manifestPath, `[package]\nname="${name}"\nversion="0.2.1"\n`);
      return { name, version: '0.2.1', manifestPath };
    });
    const messages = sources
      .slice(0, 2)
      .map((source) =>
        JSON.stringify({
          reason: 'compiler-artifact',
          manifest_path: source.manifestPath,
          package_id: 'opaque and deliberately not a package spec',
          fresh: true,
        }),
      )
      .join('\n');
    expect(assertCargoSourceArtifacts(messages, sources, ['broker'])).toEqual(sources.slice(0, 2));
    const ancestorAlias = join(directory, 'ancestor-alias');
    symlinkSync(directory, ancestorAlias, 'dir');
    expect(
      assertCargoSourceArtifacts(
        JSON.stringify({
          reason: 'compiler-artifact',
          manifest_path: join(ancestorAlias, 'core', 'Cargo.toml'),
        }),
        sources,
        ['core'],
      ),
    ).toEqual([sources[1]]);
    expect(() => assertCargoSourceArtifacts(messages, sources, ['inactive'])).toThrow(
      'Cargo source was not compiled: inactive',
    );
    const alias = join(directory, 'alias.toml');
    writeFileSync(alias, readFileSync(sources[1].manifestPath));
    expect(() =>
      assertCargoSourceArtifacts(
        JSON.stringify({ reason: 'compiler-artifact', manifest_path: alias }),
        sources,
      ),
    ).toThrow('Cargo compiled source differs: core@0.2.1');
    writeFileSync(alias, '[package]\nname="core"\nversion="0.2.2"\n');
    expect(() =>
      assertCargoSourceArtifacts(
        JSON.stringify({ reason: 'compiler-artifact', manifest_path: alias }),
        sources,
      ),
    ).toThrow('Cargo compiled source differs: core@0.2.1');
    expect(() =>
      assertCargoSourceArtifacts(
        JSON.stringify({ reason: 'compiler-artifact', manifest_path: 'Cargo.toml' }),
        sources,
      ),
    ).toThrow('absolute manifest path');
    expect(() => assertCargoSourceArtifacts(messages, [sources[0], sources[0]])).toThrow(
      'names are duplicated',
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
function candidates(sdk = '0.3.2', helper = '0.3.2', broker = '0.3.1') {
  return [
    {
      name: 'oliphaunt',
      version: sdk,
      manifest: sdkManifest,
    },
    { name: 'oliphaunt-build', version: helper },
    { name: 'oliphaunt-broker', version: broker },
  ] as Parameters<typeof candidateConsumerManifest>[1];
}

test('candidate identity comes from the final archive manifest bytes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'oliphaunt-candidate-test-'));
  try {
    const file = join(directory, 'candidate.crate');
    writeFileSync(
      file,
      archive({
        [`${sdkManifest.package.name}-${sdkManifest.package.version}/Cargo.toml`]: Buffer.from(
          readFileSync(new URL('../../../src/native/sdks/rust/Cargo.toml', import.meta.url)),
        ),
      }),
    );
    const candidate = cargoCandidate(file);
    expect(candidate.name).toBe(sdkManifest.package.name);
    expect(candidate.version).toBe(sdkManifest.package.version);
    expect(candidate.manifest.package.metadata.oliphaunt['native-version']).toBe(heldRuntime);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('canonical Cargo directories are accepted while mode and package boundaries stay strict', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'oliphaunt-cargo-directories-'));
  try {
    const root = join(directory, `${sdkManifest.package.name}-${sdkManifest.package.version}`);
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(
      join(root, 'Cargo.toml'),
      readFileSync(new URL('../../../src/native/sdks/rust/Cargo.toml', import.meta.url)),
    );
    writeFileSync(join(root, 'src/lib.rs'), 'pub fn source() {}\n', { mode: 0o644 });
    const file = join(directory, 'canonical.crate');
    writeFileSync(
      file,
      canonicalGzipSync(await createDeterministicTar(root, { keepParent: true })),
    );
    expect(cargoCandidate(file).name).toBe(sdkManifest.package.name);
    writeFileSync(
      file,
      archive({
        [`${sdkManifest.package.name}-${sdkManifest.package.version}/Cargo.toml`]: readFileSync(
          join(root, 'Cargo.toml'),
        ),
        'outside.rs': Buffer.from('outside'),
      }),
    );
    expect(() => cargoCandidate(file)).toThrow('outside declared package');
    const executable = join(root, 'src/executable.rs');
    writeFileSync(executable, 'pub fn source() {}\n', { mode: 0o755 });
    writeFileSync(
      file,
      canonicalGzipSync(
        await createDeterministicTar(root, {
          keepParent: true,
          modes: { [`${basename(root)}/src/executable.rs`]: 0o755 },
        }),
      ),
    );
    expect(() => cargoCandidate(file)).toThrow('0644');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('candidate SDK/helper bumps update their consumer constraints and hold runtime', () => {
  const manifest = Bun.TOML.parse(
    candidateConsumerManifest(template, candidates('0.3.3', '0.3.4')),
  );
  expect(manifest.dependencies.oliphaunt).toBe('=0.3.3');
  expect(manifest['build-dependencies']['oliphaunt-build']).toBe('=0.3.4');
  expect(manifest.dependencies['liboliphaunt-native-linux-x64-gnu']).toBe(`=${heldRuntime}`);
  expect(manifest.package.metadata.oliphaunt['runtime-version']).toBe(heldRuntime);
});

test('broker-only candidate version changes do not retarget SDK or its runtime', () => {
  expect(
    candidateConsumerManifest(
      template,
      candidates('0.3.2', '0.3.2', '0.3.2').filter(
        (candidate) => candidate.name === 'oliphaunt-broker',
      ),
    ),
  ).toBe(template);
  expect(candidateConsumerManifest(template, [])).toBe(template);
});

test('selected SDK/helper roots change only their own authored consumer constraints', () => {
  const selectedSdk = candidates('0.3.3').filter((candidate) => candidate.name === 'oliphaunt');
  const sdkOnly = Bun.TOML.parse(candidateConsumerManifest(template, selectedSdk));
  expect(sdkOnly.dependencies.oliphaunt).toBe('=0.3.3');
  expect(sdkOnly['build-dependencies']['oliphaunt-build']).toBe('=0.3.2');
  const helperOnly = Bun.TOML.parse(
    candidateConsumerManifest(
      template,
      candidates('0.3.2', '0.3.4').filter((candidate) => candidate.name === 'oliphaunt-build'),
    ),
  );
  expect(helperOnly.dependencies.oliphaunt).toBe('=0.3.2');
  expect(helperOnly['build-dependencies']['oliphaunt-build']).toBe('=0.3.4');
});

test('held SDK runtime comes from the checksum-authenticated resolved archive', () => {
  const directory = mkdtempSync(join(tmpdir(), 'oliphaunt-held-sdk-test-'));
  try {
    const file = join(
      directory,
      'registry/cache/index.crates.io-1949cf8c6b5b557f/oliphaunt-0.3.2.crate',
    );
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      archive({
        'oliphaunt-0.3.2/Cargo.toml': Buffer.from(
          `[package]\nname="oliphaunt"\nversion="0.3.2"\n[package.metadata.oliphaunt]\nnative-version="${heldRuntime}"\n`,
        ),
      }),
    );
    const selected = cargoCandidate(file);
    const lock = `[[package]]\nname="oliphaunt"\nversion="0.3.2"\nsource="registry+https://github.com/rust-lang/crates.io-index"\nchecksum="${selected.sha256}"\n`;
    expect(resolvedSdkRuntime(template, lock, [], directory)).toBe(heldRuntime);
    expect(() =>
      resolvedSdkRuntime(template, lock.replace(selected.sha256, '0'.repeat(64)), [], directory),
    ).toThrow('held SDK archive differs');
    expect(() =>
      resolvedSdkRuntime(
        template.replace(`runtime-version = "${heldRuntime}"`, 'runtime-version = "9.0.0"'),
        lock,
        [],
        directory,
      ),
    ).toThrow();
    expect(() =>
      resolvedSdkRuntime(
        template,
        '[[package]]\nname="oliphaunt"\nversion="0.3.2"\n',
        [],
        directory,
      ),
    ).toThrow('explicitly selected candidate');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('installed candidate staging follows declared future-major dependencies and retains compatible minimums', () => {
  const candidate = (name: string, version: string, dependencies = {}) =>
    ({ name, version, manifest: { dependencies } }) as ReturnType<typeof cargoCandidate>;
  const oldCore = 'liboliphaunt-native-bindings';
  const core = candidate(oldCore, '0.3.0');
  const broker = candidate('oliphaunt-broker', '0.4.0', { [oldCore]: '0.3.0' });
  const sdk = candidate('oliphaunt', '0.4.0', { [oldCore]: '0.3.0', 'oliphaunt-broker': '0.4.0' });
  const unrelated = candidate('oliphaunt-query', '1.0.0');
  const lock = `version=4\n[[package]]\nname="${oldCore}"\nversion="0.2.0"\nsource="registry+https://github.com/rust-lang/crates.io-index"\n[[package]]\nname="oliphaunt-broker"\nversion="0.3.1"\nsource="registry+https://github.com/rust-lang/crates.io-index"\n`;
  expect(
    candidateDependencyInputs([sdk], [sdk, core, broker, unrelated], lock, true).map(
      (row) => row.name,
    ),
  ).toEqual(['oliphaunt', oldCore, 'oliphaunt-broker']);
  expect(
    candidateDependencyInputs([broker], [sdk, core, broker, unrelated], lock, true).map(
      (row) => row.name,
    ),
  ).toEqual(['oliphaunt-broker', oldCore]);
  const patch = candidate(oldCore, '0.2.1');
  const compatibleSdk = candidate('oliphaunt', '0.3.3', { [oldCore]: '0.2.0' });
  expect(candidateDependencyInputs([compatibleSdk], [compatibleSdk, patch], lock, true)).toEqual([
    compatibleSdk,
  ]);
  expect(candidateDependencyInputs([compatibleSdk], [compatibleSdk, patch], lock)).toEqual([
    compatibleSdk,
    patch,
  ]);
});

test('Core-only public consumer is independent of the held SDK requirement', () => {
  const core = { name: 'liboliphaunt-native-bindings', version: '0.3.0' } as ReturnType<
    typeof cargoCandidate
  >;
  const manifest = Bun.TOML.parse(candidateConsumerManifest(template, [core]));
  expect(manifest.package.build).toBe('core-build.rs');
  expect(manifest.dependencies.oliphaunt).toBeUndefined();
  expect(manifest.dependencies['oliphaunt-broker']).toBeUndefined();
  expect(manifest.dependencies[core.name]).toBe('=0.3.0');
  expect(manifest.dependencies['liboliphaunt-native-linux-x64-gnu']).toBe(`=${heldRuntime}`);
  expect(manifest['build-dependencies']['oliphaunt-build']).toBe('=0.3.2');
  expect(manifest.package.metadata.oliphaunt['runtime-version']).toBe(heldRuntime);
  expect(candidateConsumerManifest(template, [])).toBe(template);
});

test('preparation keeps common and genuine held cases; final adds only the declared SDK minimum', () => {
  const core = {
    name: 'liboliphaunt-native-bindings',
    version: '0.2.0',
    manifest: { dependencies: {} },
  } as ReturnType<typeof cargoCandidate>;
  const pool = [
    ...candidates().map((row) => ({
      ...row,
      manifest: {
        dependencies: row.name === 'oliphaunt' ? { 'liboliphaunt-native-bindings': '0.2.0' } : {},
      },
    })),
    core,
  ];
  const lock =
    'version=4\n[[package]]\nname="liboliphaunt-native-bindings"\nversion="0.2.0"\nsource="registry+https://github.com/rust-lang/crates.io-index"\nchecksum="' +
    'b'.repeat(64) +
    '"\n';
  expect(installedConsumerCases(pool, lock, [], false).map(([name]) => name)).toEqual([
    'checkout',
    'liboliphaunt-native-bindings',
    'helper-held-sdk',
  ]);
  expect(() => installedConsumerCases(pool, lock, [], true)).toThrow('prepared selected owner');
  expect(() => installedConsumerCases(pool, lock, ['liboliphaunt-native-bindings'], true)).toThrow(
    'prepared selected owner',
  );
  expect(
    installedConsumerCases(pool, lock, ['oliphaunt-rust'], true, {
      archives: [sourceArchive(core.name, core.version, {}, {}, 'b'.repeat(64))],
      owners: {
        oliphaunt: 'oliphaunt-rust',
        'liboliphaunt-native-bindings': 'liboliphaunt-native-bindings',
      },
    }).map(([name]) => name),
  ).toEqual(['sdk']);
});

const sourceOwners = {
  oliphaunt: 'oliphaunt-rust',
  'oliphaunt-build': 'oliphaunt-rust',
  'liboliphaunt-native-bindings': 'liboliphaunt-native-bindings',
  'oliphaunt-broker': 'oliphaunt-broker',
  'oliphaunt-query': 'oliphaunt-query',
};
const sourceArchive = (
  name: string,
  version: string,
  dependencies = {},
  buildDependencies = {},
  sha256 = 'a'.repeat(64),
) =>
  ({
    name,
    version,
    sha256,
    manifest: {
      dependencies,
      'build-dependencies': buildDependencies,
      package: { metadata: { oliphaunt: { 'native-version': heldRuntime } } },
    },
  }) as ReturnType<typeof cargoCandidate>;
const heldCoreLock =
  'version=4\n[[package]]\nname="liboliphaunt-native-bindings"\nversion="0.2.0"\nsource="registry+https://github.com/rust-lang/crates.io-index"\nchecksum="' +
  'b'.repeat(64) +
  '"\n';

test('minimum cannot substitute a compatible higher unselected Core or omit actual floor facts', () => {
  const sdk = sourceArchive('oliphaunt', '0.3.3', { 'liboliphaunt-native-bindings': '^0.2.1' });
  const core = sourceArchive('liboliphaunt-native-bindings', '0.2.2');
  const helper = sourceArchive('oliphaunt-build', '0.3.4');
  const pool = [sdk, core, helper];
  expect(() => installedConsumerCases(pool, heldCoreLock, ['oliphaunt-rust'], true)).toThrow(
    'actual completed floor inputs',
  );
  expect(() =>
    installedConsumerCases(pool, heldCoreLock, ['oliphaunt-rust'], true, {
      archives: [sourceArchive(core.name, '0.2.0', {}, {}, 'b'.repeat(64))],
      owners: sourceOwners,
    }),
  ).toThrow('Missing exact source dependency floor archive: liboliphaunt-native-bindings@0.2.1');
});

test('minimum stages exact retained Core and the SDK declared build-helper floor with separate origin facts', () => {
  const sdk = sourceArchive(
    'oliphaunt',
    '0.3.3',
    { 'liboliphaunt-native-bindings': '^0.2.1', serde: '^1' },
    { 'oliphaunt-build': '^0.3.2' },
  );
  const core = sourceArchive('liboliphaunt-native-bindings', '0.2.2');
  const helper = sourceArchive('oliphaunt-build', '0.3.4');
  const held = [
    sourceArchive(core.name, '0.2.1', {}, {}, 'c'.repeat(64)),
    sourceArchive(helper.name, '0.3.2', {}, {}, 'd'.repeat(64)),
  ];
  const [name, inputs, minimum] = installedConsumerCases(
    [sdk, core, helper],
    heldCoreLock,
    ['oliphaunt-rust'],
    true,
    {
      archives: held,
      owners: sourceOwners,
    },
  )[0];
  expect(name).toBe('sdk');
  expect(inputs).toEqual([sdk, ...held]);
  expect(minimum!.heldInputs).toEqual(held);
  expect(minimum!.floors).toEqual(held.map(({ name, version }) => ({ name, version })));
  const manifest = Bun.TOML.parse(candidateConsumerManifest(template, inputs));
  expect(manifest['build-dependencies']['oliphaunt-build']).toBe('=0.3.2');
  expect(manifest.dependencies.oliphaunt).toBe('=0.3.3');
});

test('SDK direct floors govern weaker actual downstream requirements and reject stronger conflicts', () => {
  const sdk = sourceArchive('oliphaunt', '0.3.3', {
    core: { package: 'liboliphaunt-native-bindings', version: '^0.2.1' },
    'oliphaunt-broker': '^0.3.1',
    'oliphaunt-query': '^0.1.1',
  });
  const core = sourceArchive('liboliphaunt-native-bindings', '0.2.2');
  const helper = sourceArchive('oliphaunt-build', '0.3.4');
  const floors = [
    sourceArchive(core.name, '0.2.1', {}, {}, 'c'.repeat(64)),
    sourceArchive('oliphaunt-broker', '0.3.1', {
      [core.name]: '^0.2.0',
      'oliphaunt-query': '^0.1.1',
    }),
    sourceArchive('oliphaunt-query', '0.1.1'),
  ];
  const cases = installedConsumerCases(
    [sdk, core, helper],
    heldCoreLock,
    ['oliphaunt-rust'],
    true,
    {
      archives: floors,
      owners: sourceOwners,
    },
  );
  expect(cases[0][1]).toEqual([sdk, ...floors]);
  const conflicting = structuredClone(floors);
  conflicting[1].manifest.dependencies[core.name] = '^0.2.2';
  expect(() =>
    installedConsumerCases([sdk, core, helper], heldCoreLock, ['oliphaunt-rust'], true, {
      archives: conflicting,
      owners: sourceOwners,
    }),
  ).toThrow('Source floor conflicts with downstream requirement');
});

test('exact current Core is allowed only for its selected source owner and never overwrites retained bytes', () => {
  const sdk = sourceArchive('oliphaunt', '0.3.3', { 'liboliphaunt-native-bindings': '^0.2.1' });
  const core = sourceArchive('liboliphaunt-native-bindings', '0.2.1');
  const helper = sourceArchive('oliphaunt-build', '0.3.4');
  const pool = [sdk, core, helper];
  expect(() =>
    installedConsumerCases(pool, heldCoreLock, ['oliphaunt-rust'], true, {
      archives: [],
      owners: sourceOwners,
    }),
  ).toThrow('Missing exact source dependency floor archive');
  const current = installedConsumerCases(pool, heldCoreLock, ['oliphaunt-rust', core.name], true, {
    archives: [],
    owners: sourceOwners,
  })[0];
  expect(current[1]).toEqual([sdk, core]);
  expect(current[2]!.heldInputs).toEqual([]);
  const retained = sourceArchive(core.name, core.version, {}, {}, 'c'.repeat(64));
  const completed = installedConsumerCases(
    pool,
    heldCoreLock,
    ['oliphaunt-rust', core.name],
    true,
    {
      archives: [retained],
      owners: sourceOwners,
    },
  )[0];
  expect(completed[1]).toEqual([sdk, retained]);
  expect(completed[2]!.heldInputs).toEqual([retained]);
});

test('completed floor identities reject lock checksum conflicts and duplicate archive byte claims', () => {
  const sdk = sourceArchive('oliphaunt', '0.3.3', { 'liboliphaunt-native-bindings': '^0.2.0' });
  const core = sourceArchive('liboliphaunt-native-bindings', '0.2.2');
  const helper = sourceArchive('oliphaunt-build', '0.3.4');
  const retained = sourceArchive(core.name, '0.2.0', {}, {}, 'c'.repeat(64));
  expect(() =>
    installedConsumerCases([sdk, core, helper], heldCoreLock, ['oliphaunt-rust'], true, {
      archives: [retained],
      owners: sourceOwners,
    }),
  ).toThrow('Completed floor differs from fixture lock');
  expect(() =>
    installedConsumerCases([sdk, core, helper], heldCoreLock, ['oliphaunt-rust'], true, {
      archives: [retained, { ...retained, sha256: 'd'.repeat(64) }],
      owners: sourceOwners,
    }),
  ).toThrow('Conflicting completed floor archive');
});

test('the final minimum lock rejects higher versions, ambiguous rows and lost archive patch identity', () => {
  const sdk = sourceArchive('oliphaunt', '0.3.3');
  const held = sourceArchive('liboliphaunt-native-bindings', '0.2.1', {}, {}, 'c'.repeat(64));
  const minimum = { floors: [{ name: held.name, version: held.version }], heldInputs: [held] };
  const lock = 'version=4\n[[package]]\nname="' + held.name + '"\nversion="0.2.1"\n';
  expect(() => assertInstalledCargoMinimum(lock, [sdk, held], minimum)).not.toThrow();
  expect(() =>
    assertInstalledCargoMinimum(lock.replace('0.2.1', '0.2.2'), [sdk, held], minimum),
  ).toThrow('not its exact floor');
  expect(() =>
    assertInstalledCargoMinimum(lock + lock.replace('version=4\n', ''), [sdk, held], minimum),
  ).toThrow('Ambiguous resolved source floor');
  expect(() =>
    assertInstalledCargoMinimum(
      lock + 'source="registry+https://github.com/rust-lang/crates.io-index"\n',
      [sdk, held],
      minimum,
    ),
  ).toThrow('explicit archive patch');
  expect(() =>
    assertInstalledCargoMinimum(lock, [sdk, { ...held, sha256: 'd'.repeat(64) }], minimum),
  ).toThrow('Staged completed floor identity differs');
});

test('the third common case qualifies current helper against the unchanged genuine held SDK requirement', () => {
  const sdk = sourceArchive('oliphaunt', '0.4.0');
  const core = sourceArchive('liboliphaunt-native-bindings', '0.2.2');
  const helper = sourceArchive('oliphaunt-build', '0.4.0');
  const cases = installedConsumerCases([sdk, core, helper], heldCoreLock, [], false);
  expect(cases).toHaveLength(3);
  expect(cases[2]).toEqual(['helper-held-sdk', [helper]]);
  const manifest = Bun.TOML.parse(candidateConsumerManifest(template, cases[2][1]));
  expect(manifest.dependencies.oliphaunt).toBe('=0.3.2');
  expect(manifest['build-dependencies']['oliphaunt-build']).toBe('=0.4.0');
  expect(manifest.dependencies['liboliphaunt-native-linux-x64-gnu']).toBe('=' + heldRuntime);
});

test('Broker-only minimum uses its own Core/query floors and original source envelope independently of SDK', () => {
  const sdk = sourceArchive('oliphaunt', '0.3.3', { 'liboliphaunt-native-bindings': '^0.2.2' });
  const core = sourceArchive('liboliphaunt-native-bindings', '0.2.2');
  const helper = sourceArchive('oliphaunt-build', '0.3.4');
  const broker = sourceArchive('oliphaunt-broker', '0.3.1', {
    [core.name]: '^0.2.1',
    'oliphaunt-query': '^0.1.1',
  });
  broker.manifest['dev-dependencies'] = { [core.name]: '^0.2.2' };
  const floors = [
    sourceArchive(core.name, '0.2.1', {}, {}, 'c'.repeat(64)),
    sourceArchive('oliphaunt-query', '0.1.1'),
  ];
  const pool = [sdk, core, helper, broker];
  const cases = installedConsumerCases(pool, heldCoreLock, ['oliphaunt-broker'], true, {
    archives: floors,
    owners: sourceOwners,
  });
  expect(cases).toHaveLength(1);
  expect(cases[0][0]).toBe('broker');
  expect(cases[0][1]).toEqual([broker, ...floors]);
  expect(cases[0][2]!.source).toBe(broker);
  expect(cases[0][1]).not.toContain(sdk);
  expect(cases[0][1]).not.toContain(helper);
  expect(() =>
    installedConsumerCases(pool, heldCoreLock, ['oliphaunt-broker'], true, {
      archives: floors.slice(1),
      owners: sourceOwners,
    }),
  ).toThrow('Missing exact source dependency floor archive');
  expect(() =>
    installedConsumerCases(pool, heldCoreLock, ['oliphaunt-query'], true, {
      archives: floors,
      owners: sourceOwners,
    }),
  ).toThrow('prepared selected owner');
});

test('selected SDK and Broker qualify their own distinct direct Core floors in separate cases', () => {
  const core = sourceArchive('liboliphaunt-native-bindings', '0.2.2');
  const sdk = sourceArchive('oliphaunt', '0.3.3', { [core.name]: '^0.2.2' });
  const helper = sourceArchive('oliphaunt-build', '0.3.4');
  const broker = sourceArchive('oliphaunt-broker', '0.3.1', { [core.name]: '^0.2.1' });
  const floors = [
    sourceArchive(core.name, '0.2.2', {}, {}, 'c'.repeat(64)),
    sourceArchive(core.name, '0.2.1', {}, {}, 'd'.repeat(64)),
  ];
  const cases = installedConsumerCases(
    [sdk, helper, core, broker],
    heldCoreLock,
    ['oliphaunt-rust', 'oliphaunt-broker'],
    true,
    { archives: floors, owners: sourceOwners },
  );
  expect(cases.map(([name]) => name)).toEqual(['sdk', 'broker']);
  expect(cases[0][1]).toEqual([sdk, floors[0]]);
  expect(cases[1][1]).toEqual([broker, floors[1]]);
  expect(cases[0][2]!.source).toBeUndefined();
  expect(cases[1][2]!.source).toBe(broker);
});

test('grouped normal and build Core requirements choose the shared exact floor in either order', () => {
  const core = sourceArchive('liboliphaunt-native-bindings', '0.2.2');
  const helper = sourceArchive('oliphaunt-build', '0.3.4');
  const held = sourceArchive(core.name, '0.2.1', {}, {}, 'c'.repeat(64));
  for (const [normal, build] of [
    ['^0.2.0', '^0.2.1'],
    ['^0.2.1', '^0.2.0'],
  ]) {
    const sdk = sourceArchive(
      'oliphaunt',
      '0.3.3',
      { [core.name]: normal },
      { [core.name]: build },
    );
    const cases = installedConsumerCases(
      [sdk, helper, core],
      heldCoreLock,
      ['oliphaunt-rust'],
      true,
      { archives: [held], owners: sourceOwners },
    );
    expect(cases[0][1]).toEqual([sdk, held]);
    expect(cases[0][2]!.floors).toEqual([{ name: core.name, version: '0.2.1' }]);
  }
});

test('normal build and target aliases group by the original dependency package identity', () => {
  const core = sourceArchive('liboliphaunt-native-bindings', '0.2.2');
  const helper = sourceArchive('oliphaunt-build', '0.3.4');
  const held = sourceArchive(core.name, '0.2.1', {}, {}, 'c'.repeat(64));
  const sdk = sourceArchive(
    'oliphaunt',
    '0.3.3',
    { normal_core: { package: core.name, version: '^0.2.0' } },
    { build_core: { package: core.name, version: '^0.2.1' } },
  );
  sdk.manifest.target = {
    'cfg(unix)': { dependencies: { target_core: { package: core.name, version: '~0.2.1' } } },
  };
  const cases = installedConsumerCases(
    [sdk, helper, core],
    heldCoreLock,
    ['oliphaunt-rust'],
    true,
    { archives: [held], owners: sourceOwners },
  );
  expect(cases[0][1]).toEqual([sdk, held]);
  expect(cases[0][2]!.floors).toEqual([{ name: core.name, version: '0.2.1' }]);
});

test('grouped direct exact and range requirements reject an empty intersection', () => {
  const core = sourceArchive('liboliphaunt-native-bindings', '0.2.2');
  const helper = sourceArchive('oliphaunt-build', '0.3.4');
  const floors = [
    sourceArchive(core.name, '0.2.0', {}, {}, 'b'.repeat(64)),
    sourceArchive(core.name, '0.2.1', {}, {}, 'c'.repeat(64)),
  ];
  for (const [normal, build] of [
    ['=0.2.0', '^0.2.1'],
    ['^0.2.1', '=0.2.0'],
  ]) {
    const sdk = sourceArchive(
      'oliphaunt',
      '0.3.3',
      { [core.name]: normal },
      { [core.name]: build },
    );
    expect(() =>
      installedConsumerCases([sdk, helper, core], heldCoreLock, ['oliphaunt-rust'], true, {
        archives: floors,
        owners: sourceOwners,
      }),
    ).toThrow();
  }
});
