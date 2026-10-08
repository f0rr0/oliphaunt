import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DESKTOP_TARGETS } from './release-artifact-targets.mts';

import {
  cargoEntryFeatureNames,
  PUBLIC_CONSUMER_EVIDENCE_SCHEMA,
  publicCargoEnvironment,
  publicConsumerEvidence,
  publicConsumerPlan,
  sanitizedPublicEnvironment,
  validateCargoResolution,
  validateMavenResolution,
  validateNpmResolution,
  validatePublicConsumerEvidence,
  writeImmutablePublicConsumerEvidence,
} from './public-consumer-smoke.mts';

const digest = (value) => createHash('sha256').update(value).digest('hex');

function product(id, publishTargets, version = '1.2.3') {
  return { id, version, publishTargets, dependencies: [], kind: 'sdk', path: `src/${id}` };
}

function carrier(id, productId, publishOrder, dependencies = []) {
  const separator = id.indexOf(':');
  return {
    id,
    product: productId,
    ecosystem: id.slice(0, separator),
    name: id.slice(separator + 1),
    version: '1.2.3',
    publishOrder,
    dependencies,
  };
}

function lock(products, carriers) {
  return {
    lockDigest: 'a'.repeat(64),
    source: { commit: 'b'.repeat(40), tree: 'c'.repeat(40) },
    products,
    carriers,
  };
}

function graph(products) {
  return {
    products: Object.fromEntries(
      products.map((row) => [
        row.id,
        {
          tag_prefix: `${row.id}-v`,
          version: row.version,
        },
      ]),
    ),
  };
}

const npmPlatformFixtures = [
  { target: null, platform: null },
  { target: 'portable', platform: null },
  { target: 'linux-arm64-gnu', platform: { os: 'linux', cpu: 'arm64', libc: 'glibc' } },
  { target: 'linux-x64-gnu', platform: { os: 'linux', cpu: 'x64', libc: 'glibc' } },
  { target: 'macos-arm64', platform: { os: 'darwin', cpu: 'arm64' } },
  { target: 'darwin-arm64', platform: { os: 'darwin', cpu: 'arm64' } },
  { target: 'windows-x64-msvc', platform: { os: 'win32', cpu: 'x64' } },
  { target: 'win32-x64-msvc', platform: { os: 'win32', cpu: 'x64' } },
  { target: 'wasix-portable', platform: null },
];

const [fixtureMode, fixtureRoot, scenario] = process.argv.slice(2);
if (fixtureMode === 'prepare-cargo') {
  const environment = publicCargoEnvironment(fixtureRoot, {
    ...process.env,
    CARGO_REGISTRY_TOKEN: 'must-not-survive',
    CARGO_SOURCE_CRATES_IO_REPLACE_WITH: 'must-not-survive',
    RUSTUP_TOOLCHAIN: 'nightly',
  });
  assert.equal(environment.CARGO_HOME, path.join(fixtureRoot, 'cargo-home'));
  assert.equal(environment.HOME, path.join(fixtureRoot, 'cargo-user-home'));
  assert.equal(
    environment.RUSTUP_TOOLCHAIN,
    Bun.TOML.parse(readFileSync('rust-toolchain.toml', 'utf8')).toolchain.channel,
  );
  assert.notEqual(environment.RUSTUP_HOME, path.join(environment.HOME, '.rustup'));
  assert.equal(environment.CARGO_REGISTRY_TOKEN, undefined);
  assert.equal(environment.CARGO_SOURCE_CRATES_IO_REPLACE_WITH, undefined);
  writeFileSync(
    path.join(fixtureRoot, 'environment'),
    Object.entries(environment)
      .map(([key, value]) => `${key}=${value}\0`)
      .join(''),
  );
  writeFileSync(
    path.join(fixtureRoot, 'Cargo.toml'),
    '[package]\nname="clean-cargo-toolchain-probe"\nversion="0.0.0"\nedition="2021"\n',
  );
  mkdirSync(path.join(fixtureRoot, 'src'));
  writeFileSync(path.join(fixtureRoot, 'src/lib.rs'), '');
  process.exit(0);
}
if (fixtureMode === 'prepare-npm') {
  const products = [product('sdk', ['npm'])];
  const carriers =
    scenario === 'platforms'
      ? npmPlatformFixtures.map(({ target }, index) => ({
          ...carrier(`npm:@example/platform-${index}`, 'sdk', index),
          target,
        }))
      : scenario === 'missing-entry'
        ? [{ ...carrier('npm:@example/platform-5', 'sdk', 0), target: 'darwin-arm64' }]
        : [
            carrier(
              scenario.startsWith('peers') ? 'npm:@oliphaunt/wasix-tools' : 'npm:@example/sdk',
              'sdk',
              0,
            ),
          ];
  if (scenario === 'unknown-platform') carriers[0].target = 'unknown-platform';
  const frozen = lock(products, carriers);
  writeFileSync(
    path.join(fixtureRoot, 'context.json'),
    JSON.stringify({
      lock: frozen,
      plan: publicConsumerPlan(frozen, ['sdk'], graph(products)),
      deadlineMilliseconds: scenario === 'expired' ? 0 : Date.now() + 60000,
    }),
  );
  process.exit(0);
}
if (fixtureMode === 'install-npm') {
  const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
  const [[name, version]] = Object.entries(manifest.dependencies ?? manifest.optionalDependencies);
  if (name.startsWith('@example/platform-')) {
    const { platform } = npmPlatformFixtures[Number(name.split('-').at(-1))];
    assert.equal(manifest.optionalDependencies !== undefined, platform !== null);
    if (platform === null) assert.equal(existsSync('.npmrc'), false);
    else
      assert.equal(
        readFileSync('.npmrc', 'utf8'),
        Object.entries(platform)
          .map(([key, value]) => `${key}=${value}\n`)
          .join(''),
      );
  }
  if (!process.env.OMIT_PUBLIC_PROBE) {
    mkdirSync(`node_modules/${name}`, { recursive: true });
    writeFileSync(`node_modules/${name}/package.json`, JSON.stringify({ name, version }));
  }
  const packages = {
    [`node_modules/${name}`]: {
      version,
      resolved: `https://registry.npmjs.org/${name}/-/sdk.tgz`,
      integrity: 'sha512-smoke',
    },
  };
  if (name === '@oliphaunt/wasix-tools') {
    const sdk = JSON.parse(
      readFileSync(path.join(import.meta.dir, '../../src/wasix/sdks/ts/package.json'), 'utf8'),
    );
    packages['node_modules/@oliphaunt/wasix-ts'] = {
      version: sdk.version,
      resolved: `https://registry.npmjs.org/@oliphaunt/wasix-ts/-/wasix-ts-${sdk.version}.tgz`,
      integrity: 'sha512-peer',
      peer: true,
    };
    // npm resolves omitted peers into the lockfile without installing them.
    if (!process.argv.slice(3).includes('--omit=peer')) {
      const target = Object.values(DESKTOP_TARGETS).find(
        ({ npmOs, npmCpu }) => npmOs === process.platform && npmCpu === process.arch,
      );
      const nativeName = target.wasixNapiPackage;
      sdk.dependencies['@oliphaunt/liboliphaunt-wasix'] = sdk.oliphaunt.runtimeVersion;
      sdk.optionalDependencies = Object.fromEntries(
        Object.keys(sdk.optionalDependencies).map((name) => [name, sdk.oliphaunt.wasixNapiVersion]),
      );
      mkdirSync('node_modules/@oliphaunt/wasix-ts', { recursive: true });
      writeFileSync('node_modules/@oliphaunt/wasix-ts/package.json', JSON.stringify(sdk));
      mkdirSync(`node_modules/${nativeName}`, { recursive: true });
      writeFileSync(
        `node_modules/${nativeName}/package.json`,
        JSON.stringify({
          name: nativeName,
          version: sdk.oliphaunt.wasixNapiVersion,
          exports: { './package.json': './package.json' },
          oliphaunt: {
            runtimeProduct: sdk.oliphaunt.runtimeProduct,
            runtimeVersion: process.env.PUBLIC_PROBE_BAD_RUNTIME
              ? '0.0.0'
              : sdk.oliphaunt.runtimeVersion,
            addonAbiVersion: sdk.oliphaunt.wasixAddonAbiVersion,
            nodeApiVersion: sdk.oliphaunt.nodeApiVersion,
            profiles: ['standard', 'icu'],
          },
        }),
      );
    }
  }
  writeFileSync('package-lock.json', JSON.stringify({ lockfileVersion: 3, packages }));
  process.exit(0);
}
if (fixtureMode === 'assert-npm') {
  if (scenario === 'success' || scenario === 'peers' || scenario === 'platforms') {
    const result = JSON.parse(readFileSync(path.join(fixtureRoot, 'npm.json'), 'utf8'));
    const context = JSON.parse(readFileSync(path.join(fixtureRoot, 'context.json'), 'utf8'));
    const ids = context.lock.carriers.map(({ id }) => id);
    assert.equal(
      result.mode,
      'anonymous-public-independent-entry-platform-install-and-lock-resolution',
    );
    assert.deepEqual(result.installedCarrierIds, ids);
    assert.deepEqual(
      result.resolved.map(({ id }) => id),
      ids,
    );
    assert.deepEqual(
      result.entryPlatforms,
      ids.map((entryCarrierId, index) => ({
        entryCarrierId,
        platform: scenario === 'platforms' ? npmPlatformFixtures[index].platform : null,
      })),
    );
    const evidence = publicConsumerEvidence({
      ...context,
      registryReceiptSha256: 'e'.repeat(64),
      githubReceiptDigest: 'f'.repeat(64),
      surfaces: [
        result,
        { surface: 'github', productTags: context.plan.github.productTags, swift: null },
      ],
    });
    validatePublicConsumerEvidence(evidence, context.lock, context.plan);
    evidence.surfaces.find(({ surface }) => surface === 'npm').entryPlatforms[0].platform = {
      os: 'linux',
      cpu: 'x64',
    };
    assert.throws(
      () => validatePublicConsumerEvidence(evidence, context.lock, context.plan),
      /npm entry platforms differ from the frozen carrier targets/u,
    );
  } else assert.equal(existsSync(path.join(fixtureRoot, 'npm.json')), false);
  process.exit(0);
}

test('derives every registry surface and graph-root entry from the exact selected lock', () => {
  const products = [
    product('runtime', ['crates-io', 'maven-central', 'npm']),
    product('sdk', ['crates-io', 'maven-central', 'npm']),
  ];
  const frozen = lock(products, [
    carrier('cargo:runtime-leaf', 'runtime', 0),
    carrier('npm:@example/runtime-leaf', 'runtime', 1),
    carrier('maven:dev.example:runtime', 'runtime', 2),
    carrier('cargo:sdk', 'sdk', 3, ['cargo:runtime-leaf']),
    carrier('npm:@example/sdk', 'sdk', 4, ['npm:@example/runtime-leaf']),
    carrier('maven:dev.example:sdk', 'sdk', 5, ['maven:dev.example:runtime']),
  ]);
  const plan = publicConsumerPlan(frozen, ['runtime', 'sdk'], graph(products));
  assert.deepEqual(
    plan.surfaces.map(({ ecosystem }) => ecosystem),
    ['cargo', 'maven', 'npm'],
  );
  assert.deepEqual(plan.surfaces.find(({ ecosystem }) => ecosystem === 'cargo').entryCarrierIds, [
    'cargo:sdk',
  ]);
  assert.deepEqual(plan.surfaces.find(({ ecosystem }) => ecosystem === 'cargo').entryClosures, [
    {
      entryCarrierId: 'cargo:sdk',
      carrierIds: ['cargo:runtime-leaf', 'cargo:sdk'],
    },
  ]);
  assert.deepEqual(plan.surfaces.find(({ ecosystem }) => ecosystem === 'npm').entryCarrierIds, [
    'npm:@example/sdk',
  ]);
  assert.deepEqual(plan.surfaces.find(({ ecosystem }) => ecosystem === 'maven').entryCarrierIds, [
    'maven:dev.example:sdk',
  ]);
  assert.deepEqual(plan.github.productTags, [
    { product: 'runtime', tag: 'runtime-v1.2.3', commit: 'b'.repeat(40) },
    { product: 'sdk', tag: 'sdk-v1.2.3', commit: 'b'.repeat(40) },
  ]);
});

test('probes public entry roles independently across registries even when they are dependencies', () => {
  const products = [product('alpha', ['crates-io', 'maven-central', 'npm'])];
  const carriers = ['cargo', 'maven', 'npm'].flatMap((ecosystem, index) => {
    const rows = ['resource', 'facade', 'plugin', 'tool-facade'].map((role, offset) => ({
      ...carrier(`${ecosystem}:entry-${offset}`, 'alpha', index * 5 + offset),
      role,
    }));
    return [
      ...rows,
      carrier(
        `${ecosystem}:root`,
        'alpha',
        index * 5 + 4,
        rows.map(({ id }) => id),
      ),
    ];
  });
  const plan = publicConsumerPlan(lock(products, carriers), ['alpha'], graph(products));
  for (const surface of plan.surfaces)
    assert.deepEqual(surface.entryCarrierIds, surface.carrierIds);
});

test('Cargo entries respect transitive opt-ins while combined resolution stays exhaustive', () => {
  const products = [product('alpha', ['crates-io'])];
  const frozen = lock(products, [
    carrier('cargo:opt-in-payload', 'alpha', 0),
    { ...carrier('cargo:runtime', 'alpha', 1, ['cargo:opt-in-payload']), role: 'facade' },
    { ...carrier('cargo:extension', 'alpha', 2, ['cargo:runtime']), role: 'facade' },
  ]);
  const plan = publicConsumerPlan(frozen, ['alpha'], graph(products));
  const surface = plan.surfaces[0];
  assert.deepEqual(surface.entryCarrierIds, ['cargo:extension', 'cargo:runtime']);
  const observed = {
    surface: 'cargo',
    mode: 'anonymous-public-independent-entry-all-feature-resolution-no-compile',
    carrierIds: surface.carrierIds,
    dependencyScopes: surface.dependencyScopes,
    entryCarrierIds: surface.entryCarrierIds,
    plannedEntryClosures: surface.entryClosures,
    entries: [
      {
        entryCarrierId: 'cargo:extension',
        resolvedCarrierIds: ['cargo:extension', 'cargo:runtime'],
      },
      {
        entryCarrierId: 'cargo:runtime',
        resolvedCarrierIds: ['cargo:opt-in-payload', 'cargo:runtime'],
      },
    ],
    resolved: surface.carrierIds.map((id) => ({ id, version: '1.2.3' })),
    receiptCoveredWithoutPayloadFetchCarrierIds: surface.carrierIds,
  };
  const evidence = () =>
    publicConsumerEvidence({
      lock: frozen,
      plan,
      registryReceiptSha256: 'e'.repeat(64),
      githubReceiptDigest: 'f'.repeat(64),
      surfaces: [
        observed,
        {
          surface: 'github',
          mode: 'anonymous-public-exact-tag-resolution',
          productTags: plan.github.productTags,
          swift: null,
        },
      ],
    });
  validatePublicConsumerEvidence(evidence(), frozen, plan);
  observed.entries[1].resolvedCarrierIds.push('cargo:extension');
  assert.throws(
    () => validatePublicConsumerEvidence(evidence(), frozen, plan),
    /outside its frozen dependency closure/u,
  );
  observed.entries[1].resolvedCarrierIds = ['cargo:runtime'];
  observed.resolved = observed.resolved.filter(({ id }) => id !== 'cargo:opt-in-payload');
  assert.throws(
    () => validatePublicConsumerEvidence(evidence(), frozen, plan),
    /exhaustive frozen carrier set/u,
  );
});

test('supports source-only selections and records the exact Swift source tag separately', () => {
  const products = [
    product('oliphaunt-swift', ['github-release', 'swift-package-source-tag'], '0.6.0'),
  ];
  const plan = publicConsumerPlan(lock(products, []), ['oliphaunt-swift'], graph(products));
  assert.deepEqual(plan.surfaces, []);
  assert.deepEqual(plan.github.swift, {
    product: 'oliphaunt-swift',
    version: '0.6.0',
    tag: '0.6.0',
    parentCommit: 'b'.repeat(40),
  });
});

test('derives consumer closures from package-manager scopes instead of publication-only dev edges', () => {
  const products = [product('alpha', ['crates-io'])];
  const leaf = carrier('cargo:leaf', 'alpha', 0);
  leaf.packageDependencies = [];
  const facade = carrier('cargo:facade', 'alpha', 1, ['cargo:leaf']);
  facade.packageDependencies = [
    { ecosystem: 'cargo', name: 'leaf', requirement: '=1.2.3', scope: 'development' },
  ];
  const developmentPlan = publicConsumerPlan(
    lock(products, [leaf, facade]),
    ['alpha'],
    graph(products),
  );
  assert.deepEqual(developmentPlan.surfaces[0].entryClosures, [
    { entryCarrierId: 'cargo:facade', carrierIds: ['cargo:facade'] },
    { entryCarrierId: 'cargo:leaf', carrierIds: ['cargo:leaf'] },
  ]);

  facade.packageDependencies[0].scope = 'runtime';
  const runtimePlan = publicConsumerPlan(
    lock(products, [leaf, facade]),
    ['alpha'],
    graph(products),
  );
  assert.deepEqual(runtimePlan.surfaces[0].entryClosures, [
    {
      entryCarrierId: 'cargo:facade',
      carrierIds: ['cargo:facade', 'cargo:leaf'],
    },
  ]);
});

test('projects cross-registry publication edges out of each public consumer closure', () => {
  const products = [product('sdk', ['maven-central', 'npm'])];
  const frozen = lock(products, [
    carrier('npm:@example/sdk', 'sdk', 0),
    carrier('maven:dev.example:sdk', 'sdk', 1, ['npm:@example/sdk']),
  ]);
  const plan = publicConsumerPlan(frozen, ['sdk'], graph(products));
  assert.deepEqual(plan.surfaces.find(({ ecosystem }) => ecosystem === 'npm').entryClosures, [
    { entryCarrierId: 'npm:@example/sdk', carrierIds: ['npm:@example/sdk'] },
  ]);
  assert.deepEqual(plan.surfaces.find(({ ecosystem }) => ecosystem === 'maven').entryClosures, [
    { entryCarrierId: 'maven:dev.example:sdk', carrierIds: ['maven:dev.example:sdk'] },
  ]);
});

test('fails closed on product, target, carrier, and dependency-closure omissions', () => {
  const products = [product('alpha', ['npm']), product('beta', ['npm'])];
  const frozen = lock(products, [
    carrier('npm:@example/alpha', 'alpha', 0),
    carrier('npm:@example/beta', 'beta', 1, ['npm:@example/alpha']),
  ]);
  assert.throws(
    () => publicConsumerPlan(frozen, ['beta'], graph(products)),
    /exactly match the frozen publication lock/u,
  );

  const unsupported = [product('alpha', ['invented-registry'])];
  assert.throws(
    () => publicConsumerPlan(lock(unsupported, []), ['alpha'], graph(unsupported)),
    /unsupported public consumer targets/u,
  );

  const mismatch = [product('alpha', ['npm'])];
  assert.throws(
    () => publicConsumerPlan(lock(mismatch, []), ['alpha'], graph(mismatch)),
    /publish targets and frozen carrier products disagree/u,
  );

  const omitted = lock(products, [carrier('npm:@example/beta', 'beta', 0, ['npm:@example/alpha'])]);
  assert.throws(
    () => publicConsumerPlan(omitted, ['alpha', 'beta'], graph(products)),
    /publish targets and frozen carrier products disagree|omits locked dependencies/u,
  );

  const cycleProducts = [product('cycle', ['npm'])];
  const cycle = lock(cycleProducts, [
    carrier('npm:a', 'cycle', 0, ['npm:b']),
    carrier('npm:b', 'cycle', 1, ['npm:a']),
  ]);
  assert.throws(
    () => publicConsumerPlan(cycle, ['cycle'], graph(cycleProducts)),
    /no public consumer entry root/u,
  );
});

test('clean WASIX SDK installs reject older N-API runtimes outside the selected publication lock', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'oliphaunt-public-wasix-test-'));
  try {
    const target = Object.values(DESKTOP_TARGETS).find(
      ({ npmOs, npmCpu }) => npmOs === process.platform && npmCpu === process.arch,
    );
    const name = target.wasixNapiPackage;
    const sdk = {
      ...JSON.parse(readFileSync('src/wasix/sdks/ts/package.json', 'utf8')),
      version: '0.2.1',
      oliphaunt: {
        runtimeProduct: 'liboliphaunt-wasix',
        runtimeVersion: '0.3.1',
        wasixNapiProduct: 'oliphaunt-wasix-napi',
        wasixNapiVersion: '0.2.0',
        wasixAddonAbiVersion: 3,
        nodeApiVersion: 8,
        browserHost: 'wasmer-js-patched',
        serverHost: 'wasix-rust-napi',
      },
    };
    delete sdk.scripts;
    delete sdk.devDependencies;
    sdk.dependencies['@oliphaunt/liboliphaunt-wasix'] = '0.3.1';
    sdk.optionalDependencies = Object.fromEntries(
      Object.keys(sdk.optionalDependencies).map((name) => [name, '0.2.0']),
    );
    const sdkRoot = path.join(root, 'node_modules/@oliphaunt/wasix-ts');
    // npm may nest the carrier under the SDK rather than hoisting it.
    const nativeRoot = path.join(sdkRoot, 'node_modules', name);
    mkdirSync(nativeRoot, { recursive: true });
    writeFileSync(path.join(sdkRoot, 'package.json'), JSON.stringify(sdk));
    const native = {
      name,
      version: '0.2.0',
      exports: { './package.json': './package.json' },
      oliphaunt: {
        runtimeProduct: 'liboliphaunt-wasix',
        runtimeVersion: '0.3.0',
        addonAbiVersion: 3,
        nodeApiVersion: 8,
        profiles: ['standard', 'icu'],
      },
    };
    const nativeFile = path.join(nativeRoot, 'package.json');
    writeFileSync(nativeFile, JSON.stringify(native));
    const entry = {
      ...carrier('npm:@oliphaunt/wasix-ts', 'oliphaunt-wasix-ts', 0),
      version: sdk.version,
    };
    const packageLock = {
      lockfileVersion: 3,
      packages: {
        'node_modules/@oliphaunt/wasix-ts': {
          version: sdk.version,
          resolved: 'https://registry.npmjs.org/@oliphaunt/wasix-ts/-/wasix-ts-0.2.1.tgz',
          integrity: 'sha512-exact',
        },
      },
    };
    const validate = () => validateNpmResolution(packageLock, [entry], [entry.id], root);
    assert.throws(
      validate,
      /SDK requires N-API 0\.2\.0 embedding runtime 0\.3\.1, carrier embeds runtime 0\.3\.0/u,
    );
    const tools = carrier('npm:@oliphaunt/wasix-tools', 'postgres-tools-wasix', 0);
    const toolsRoot = path.join(root, 'node_modules', '@oliphaunt', 'wasix-tools');
    mkdirSync(toolsRoot, { recursive: true });
    writeFileSync(
      path.join(toolsRoot, 'package.json'),
      JSON.stringify({ name: tools.name, version: tools.version }),
    );
    packageLock.packages['node_modules/@oliphaunt/wasix-tools'] = {
      version: tools.version,
      resolved: 'https://registry.npmjs.org/@oliphaunt/wasix-tools/-/wasix-tools.tgz',
      integrity: 'sha512-exact',
    };
    const validateTools = () => validateNpmResolution(packageLock, [tools], [tools.id], root);
    assert.throws(validateTools, /carrier embeds runtime 0\.3\.0/u);
    native.oliphaunt.runtimeVersion = '0.3.1';
    writeFileSync(nativeFile, JSON.stringify(native));
    assert.doesNotThrow(validate);
    assert.doesNotThrow(validateTools);
    native.version = '0.2.2';
    writeFileSync(nativeFile, JSON.stringify(native));
    assert.throws(validate, /incompatible with @oliphaunt\/wasix-ts@0\.2\.1/u);
    rmSync(nativeFile);
    assert.throws(validate, /Cannot find module|ModuleNotFound|ENOENT/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('validates exact public Cargo, npm, and Maven resolution records', () => {
  const cargo = [carrier('cargo:alpha', 'alpha', 0)];
  assert.deepEqual(
    validateCargoResolution(
      `version = 4

[[package]]
name = "alpha"
version = "1.2.3"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "${'d'.repeat(64)}"
`,
      cargo,
    ),
    [{ id: 'cargo:alpha', version: '1.2.3', checksum: 'd'.repeat(64) }],
  );
  assert.throws(
    () =>
      validateCargoResolution(
        `version = 4
[[package]]
name = "alpha"
version = "1.2.3"
source = "path+file:///workspace"
checksum = "${'d'.repeat(64)}"
`,
        cargo,
      ),
    /non-public or substituted Cargo source/u,
  );
  assert.throws(
    () =>
      validateCargoResolution(
        `version = 4
[[package]]
name = "alpha"
version = "1.2.3"
source = "registry+https://github.com/rust-lang/crates.io-index-substitute"
checksum = "${'d'.repeat(64)}"
`,
        cargo,
      ),
    /non-public or substituted Cargo source/u,
  );

  const root = mkdtempSync(path.join(tmpdir(), 'oliphaunt-public-consumer-test-'));
  try {
    const packageRoot = path.join(root, 'node_modules', '@example', 'alpha');
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(
      path.join(packageRoot, 'package.json'),
      '{"name":"@example/alpha","version":"1.2.3"}\n',
    );
    const npmCarrier = [carrier('npm:@example/alpha', 'alpha', 0)];
    const npm = validateNpmResolution(
      {
        lockfileVersion: 3,
        packages: {
          '': { name: 'consumer', version: '0.0.0' },
          'node_modules/@example/alpha': {
            version: '1.2.3',
            resolved: 'https://registry.npmjs.org/@example/alpha/-/alpha-1.2.3.tgz',
            integrity: 'sha512-exact',
          },
        },
      },
      npmCarrier,
      ['npm:@example/alpha'],
      root,
    );
    assert.deepEqual(npm.installedCarrierIds, ['npm:@example/alpha']);
    assert.throws(
      () =>
        validateNpmResolution(
          {
            lockfileVersion: 3,
            packages: {
              'node_modules/@example/alpha': {
                version: '1.2.3',
                resolved: 'file:../alpha',
                integrity: 'sha512-exact',
              },
            },
          },
          npmCarrier,
          ['npm:@example/alpha'],
          root,
        ),
      /non-public, linked, or integrity-free/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  const mavenCarrier = [carrier('maven:dev.example:alpha', 'alpha', 0)];
  assert.deepEqual(
    validateMavenResolution(
      'OLIPHAUNT_PUBLIC_COMPONENT\tmaven:dev.example:alpha\tdev.example\talpha\t1.2.3\n',
      mavenCarrier,
    ),
    {
      entries: [
        {
          entryCarrierId: 'maven:dev.example:alpha',
          resolvedCarrierIds: ['maven:dev.example:alpha'],
        },
      ],
      resolved: [{ id: 'maven:dev.example:alpha', version: '1.2.3' }],
    },
  );
  assert.throws(
    () => validateMavenResolution('', mavenCarrier),
    /omitted from its independent clean Maven Central resolution/u,
  );
});

test('selects every opt-in Cargo entry feature for exhaustive carrier resolution', () => {
  const entry = carrier('cargo:facade', 'alpha', 1);
  entry.artifacts = [
    {
      path: 'target/cargo/facade-1.2.3.crate',
      sha256: 'd'.repeat(64),
      size: 1,
    },
  ];
  assert.deepEqual(
    cargoEntryFeatureNames(
      {
        version: {
          crate: 'facade',
          num: '1.2.3',
          checksum: 'd'.repeat(64),
          crate_size: 1,
          yanked: false,
          features: {
            wasix: ['dep:facade-wasix'],
            default: ['native'],
            native: ['dep:facade-linux'],
          },
          features2: {
            'wasix-aot-x86_64-unknown-linux-gnu': ['dep:facade-wasix', 'dep:facade-aot-linux'],
          },
        },
      },
      entry,
    ),
    ['native', 'wasix', 'wasix-aot-x86_64-unknown-linux-gnu'],
  );
  assert.throws(
    () =>
      cargoEntryFeatureNames(
        {
          version: {
            crate: 'facade',
            num: '9.9.9',
            checksum: 'd'.repeat(64),
            crate_size: 1,
            yanked: false,
            features: {},
          },
        },
        entry,
      ),
    /metadata does not match/u,
  );
  assert.throws(
    () =>
      cargoEntryFeatureNames(
        {
          version: {
            crate: 'facade',
            num: '1.2.3',
            checksum: 'd'.repeat(64),
            crate_size: 1,
            yanked: false,
            features: { broken: [null] },
          },
        },
        entry,
      ),
    /invalid Cargo feature declaration/u,
  );
  assert.throws(
    () =>
      cargoEntryFeatureNames(
        {
          version: {
            crate: 'facade',
            num: '1.2.3',
            checksum: 'd'.repeat(64),
            crate_size: 2,
            yanked: false,
            features: {},
          },
        },
        entry,
      ),
    /metadata does not match/u,
  );
  assert.throws(
    () =>
      cargoEntryFeatureNames(
        {
          version: {
            crate: 'facade',
            num: '1.2.3',
            checksum: 'd'.repeat(64),
            crate_size: 1,
            yanked: true,
            features: {},
          },
        },
        entry,
      ),
    /metadata does not match/u,
  );
  assert.throws(
    () =>
      cargoEntryFeatureNames(
        {
          version: {
            crate: 'facade',
            num: '1.2.3',
            checksum: 'd'.repeat(64),
            crate_size: 1,
            yanked: false,
            features: { wasix: ['dep:facade-wasix'] },
            features2: { wasix: ['dep:substituted'] },
          },
        },
        entry,
      ),
    /features and features2 disagree/u,
  );
});

test('public probes discard inherited credentials and package-manager substitution settings', () => {
  const env = sanitizedPublicEnvironment(
    {
      NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org/',
    },
    {
      PATH: '/usr/bin',
      CARGO_SOURCE_CRATES_IO_REPLACE_WITH: 'local-mirror',
      CARGO_TARGET_DIR: '/workspace/target',
      CARGO_BUILD_RUSTC_WRAPPER: '/workspace/wrapper',
      RUSTFLAGS: '--cfg local_only',
      RUSTC_WRAPPER: '/workspace/wrapper',
      OLIPHAUNT_NATIVE_ARTIFACT_DIR: '/workspace/target/native',
      LIBOLIPHAUNT_RUNTIME_DIR: '/workspace/target/runtime',
      NODE_OPTIONS: '--require=/workspace/substitute.cjs',
      NODE_PATH: '/workspace/node_modules',
      LD_LIBRARY_PATH: '/workspace/lib',
      DYLD_LIBRARY_PATH: '/workspace/lib',
      DENO_CONFIG: '/workspace/deno.json',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'url.file:///workspace/.insteadOf',
      GIT_CONFIG_VALUE_0: 'https://github.com/',
      GRADLE_OPTS: '-I /workspace/substitute.gradle',
      NPM_CONFIG_REGISTRY: 'https://private.invalid/',
      npm_config_userconfig: '/workspace/.npmrc',
      ORG_GRADLE_PROJECT_repositoryPassword: 'secret',
      RELEASE_TOKEN: 'secret',
    },
  );
  assert.deepEqual(env, {
    PATH: '/usr/bin',
    NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org/',
  });
});

test('Cargo consumer toolchain context fails closed on unpinned or unavailable inputs', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'oliphaunt-public-cargo-toolchain-policy-test-'));
  try {
    const rustupHome = path.join(root, 'rustup');
    mkdirSync(rustupHome, { recursive: true });
    writeFileSync(path.join(root, 'rust-toolchain.toml'), '[toolchain]\nchannel = "stable"\n');
    assert.throws(
      () =>
        publicCargoEnvironment(
          path.join(root, 'consumer'),
          { RUSTUP_HOME: rustupHome },
          { repositoryRoot: root },
        ),
      /must pin an exact stable Rust toolchain/u,
    );
    writeFileSync(path.join(root, 'rust-toolchain.toml'), '[toolchain]\nchannel = "1.96.0"\n');
    assert.throws(
      () =>
        publicCargoEnvironment(
          path.join(root, 'consumer'),
          { RUSTUP_HOME: path.join(root, 'missing') },
          { repositoryRoot: root },
        ),
      /RUSTUP_HOME is unavailable/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('builds canonical lock/receipt-bound evidence and writes it immutably', () => {
  const products = [product('alpha', ['npm'])];
  const frozen = lock(products, [carrier('npm:@example/alpha', 'alpha', 0)]);
  const plan = publicConsumerPlan(frozen, ['alpha'], graph(products));
  const surfaces = [
    {
      surface: 'npm',
      mode: 'anonymous-public-independent-entry-platform-install-and-lock-resolution',
      carrierIds: ['npm:@example/alpha'],
      dependencyScopes: ['optional', 'peer', 'runtime'],
      entryCarrierIds: ['npm:@example/alpha'],
      entryPlatforms: [{ entryCarrierId: 'npm:@example/alpha', platform: null }],
      plannedEntryClosures: [
        { entryCarrierId: 'npm:@example/alpha', carrierIds: ['npm:@example/alpha'] },
      ],
      entries: [
        { entryCarrierId: 'npm:@example/alpha', resolvedCarrierIds: ['npm:@example/alpha'] },
      ],
      installedCarrierIds: ['npm:@example/alpha'],
      resolved: [{ id: 'npm:@example/alpha', version: '1.2.3', integrity: 'sha512-exact' }],
      receiptCoveredNotHostInstalledCarrierIds: [],
    },
    {
      surface: 'github',
      mode: 'anonymous-public-exact-tag-resolution',
      productTags: plan.github.productTags,
      swift: null,
    },
  ];
  const evidence = publicConsumerEvidence({
    lock: frozen,
    plan,
    registryReceiptSha256: 'e'.repeat(64),
    githubReceiptDigest: 'f'.repeat(64),
    surfaces,
  });
  assert.equal(evidence.schema, PUBLIC_CONSUMER_EVIDENCE_SCHEMA);
  assert.equal(validatePublicConsumerEvidence(evidence, frozen, plan), evidence);
  const changed = structuredClone(evidence);
  changed.surfaces.find(({ surface }) => surface === 'github').productTags = [];
  assert.throws(
    () => validatePublicConsumerEvidence(changed, frozen, plan),
    /every exact product tag/u,
  );

  const root = mkdtempSync(path.join(tmpdir(), 'oliphaunt-public-evidence-test-'));
  try {
    const file = path.join(root, 'evidence.json');
    writeImmutablePublicConsumerEvidence(file, evidence);
    writeImmutablePublicConsumerEvidence(file, evidence);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).evidenceDigest, evidence.evidenceDigest);
    const conflict = { ...evidence, evidenceDigest: digest('different') };
    assert.throws(
      () => writeImmutablePublicConsumerEvidence(file, conflict),
      /non-identical immutable/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('cannot silently relabel a frozen entry dependency as receipt-only', () => {
  const products = [product('alpha', ['npm'])];
  const frozen = lock(products, [
    carrier('npm:@example/leaf', 'alpha', 0),
    carrier('npm:@example/alpha', 'alpha', 1, ['npm:@example/leaf']),
  ]);
  const plan = publicConsumerPlan(frozen, ['alpha'], graph(products));
  const evidence = publicConsumerEvidence({
    lock: frozen,
    plan,
    registryReceiptSha256: 'e'.repeat(64),
    githubReceiptDigest: 'f'.repeat(64),
    surfaces: [
      {
        surface: 'npm',
        mode: 'anonymous-public-independent-entry-platform-install-and-lock-resolution',
        carrierIds: ['npm:@example/alpha', 'npm:@example/leaf'],
        dependencyScopes: ['optional', 'peer', 'runtime'],
        entryCarrierIds: ['npm:@example/alpha'],
        entryPlatforms: [{ entryCarrierId: 'npm:@example/alpha', platform: null }],
        plannedEntryClosures: [
          {
            entryCarrierId: 'npm:@example/alpha',
            carrierIds: ['npm:@example/alpha', 'npm:@example/leaf'],
          },
        ],
        entries: [
          { entryCarrierId: 'npm:@example/alpha', resolvedCarrierIds: ['npm:@example/alpha'] },
        ],
        installedCarrierIds: ['npm:@example/alpha'],
        receiptCoveredNotHostInstalledCarrierIds: ['npm:@example/leaf'],
        resolved: [{ id: 'npm:@example/alpha', version: '1.2.3', integrity: 'sha512-exact' }],
      },
      {
        surface: 'github',
        mode: 'anonymous-public-exact-tag-resolution',
        productTags: plan.github.productTags,
        swift: null,
      },
    ],
  });
  assert.throws(
    () => validatePublicConsumerEvidence(evidence, frozen, plan),
    /omitted frozen platform-independent lock dependencies/u,
  );
});
