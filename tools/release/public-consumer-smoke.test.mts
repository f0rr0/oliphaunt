import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

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

test('clean Cargo consumers retain only the exact installed Rust toolchain context', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'oliphaunt-public-cargo-toolchain-test-'));
  try {
    const consumerHome = path.join(root, 'consumer-home');
    const cargoHome = path.join(root, 'cargo-home');
    mkdirSync(consumerHome, { recursive: true });
    mkdirSync(cargoHome, { recursive: true });
    const env = publicCargoEnvironment(root, {
      ...process.env,
      CARGO_REGISTRY_TOKEN: 'must-not-survive',
      CARGO_SOURCE_CRATES_IO_REPLACE_WITH: 'must-not-survive',
      RUSTUP_TOOLCHAIN: 'nightly',
    });
    assert.equal(env.CARGO_HOME, cargoHome);
    assert.equal(env.HOME, path.join(root, 'cargo-user-home'));
    assert.equal(env.RUSTUP_TOOLCHAIN, '1.93.1');
    assert.notEqual(env.RUSTUP_HOME, path.join(env.HOME, '.rustup'));
    assert.equal(env.CARGO_REGISTRY_TOKEN, undefined);
    assert.equal(env.CARGO_SOURCE_CRATES_IO_REPLACE_WITH, undefined);
    writeFileSync(
      path.join(root, 'Cargo.toml'),
      '[package]\nname = "clean-cargo-toolchain-probe"\nversion = "0.0.0"\nedition = "2021"\n',
    );
    mkdirSync(path.join(root, 'src'));
    writeFileSync(path.join(root, 'src', 'lib.rs'), '');
    execFileSync('cargo', ['generate-lockfile'], {
      cwd: root,
      env,
      timeout: 30_000,
      encoding: 'utf8',
    });
    assert.equal(existsSync(path.join(root, 'Cargo.lock')), true);
    const version = execFileSync('cargo', ['--version'], {
      cwd: root,
      env,
      timeout: 30_000,
      encoding: 'utf8',
    });
    assert.match(version, /^cargo 1\.93\.1\b/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
    writeFileSync(path.join(root, 'rust-toolchain.toml'), '[toolchain]\nchannel = "1.93.1"\n');
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
      mode: 'anonymous-public-independent-entry-host-install-and-lock-resolution',
      carrierIds: ['npm:@example/alpha'],
      dependencyScopes: ['optional', 'peer', 'runtime'],
      entryCarrierIds: ['npm:@example/alpha'],
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
        mode: 'anonymous-public-independent-entry-host-install-and-lock-resolution',
        carrierIds: ['npm:@example/alpha', 'npm:@example/leaf'],
        dependencyScopes: ['optional', 'peer', 'runtime'],
        entryCarrierIds: ['npm:@example/alpha'],
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

test('Shell public npm consumer sanitizes credentials, validates installs, and bounds failures and descendants', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'oliphaunt-public-shell-test-'));
  try {
    const bin = path.join(root, 'bin');
    mkdirSync(bin);
    writeFileSync(
      path.join(bin, 'npm'),
      `#!/usr/bin/env bun
import {mkdirSync,readFileSync,writeFileSync,appendFileSync} from 'node:fs';
if(process.env.SENSITIVE_TOKEN || process.env.CARGO_REGISTRY_TOKEN) throw Error('credentials leaked');
appendFileSync(process.env.PUBLIC_PROBE_COUNTER, 'attempt\\n');
if(process.env.FAIL_PUBLIC_PROBE) process.exit(7);
if(process.env.HANG_PUBLIC_PROBE) { const child=Bun.spawn(['sleep','30']); writeFileSync(process.env.PUBLIC_PROBE_CHILD, String(child.pid)); await child.exited; }
const manifest=JSON.parse(readFileSync('package.json','utf8'));
const [[name,version]]=Object.entries(manifest.dependencies);
mkdirSync('node_modules/'+name,{recursive:true});
writeFileSync('node_modules/'+name+'/package.json',JSON.stringify({name,version}));
writeFileSync('package-lock.json',JSON.stringify({lockfileVersion:3,packages:{['node_modules/'+name]:{version,resolved:'https://registry.npmjs.org/'+name+'/-/sdk.tgz',integrity:'sha512-smoke'}}}));
`,
      { mode: 0o755 },
    );
    const products = [product('sdk', ['npm'])];
    const frozen = lock(products, [carrier('npm:@example/sdk', 'sdk', 0)]);
    const plan = publicConsumerPlan(frozen, ['sdk'], graph(products));
    const counter = path.join(root, 'attempts');
    const env = {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      SENSITIVE_TOKEN: 'must-not-survive',
      CARGO_REGISTRY_TOKEN: 'must-not-survive',
      PUBLIC_PROBE_COUNTER: counter,
    };
    for (const mode of ['success', 'fail', 'timeout']) {
      const scratch = path.join(root, mode);
      mkdirSync(scratch);
      writeFileSync(
        path.join(scratch, 'context.json'),
        JSON.stringify({
          lock: frozen,
          plan,
          deadlineMilliseconds: Date.now() + (mode === 'timeout' ? 2000 : 30_000),
        }),
      );
      const run = () =>
        execFileSync(
          'bash',
          ['tools/release/public-consumer-smoke.sh', '--surface', scratch, 'npm'],
          {
            env: {
              ...env,
              ...(mode === 'fail' ? { FAIL_PUBLIC_PROBE: '1' } : {}),
              ...(mode === 'timeout'
                ? { HANG_PUBLIC_PROBE: '1', PUBLIC_PROBE_CHILD: path.join(root, 'child-pid') }
                : {}),
            },
            timeout: 30_000,
            stdio: 'pipe',
          },
        );
      if (mode !== 'success') {
        assert.throws(run, (cause) => cause.status === (mode === 'timeout' ? 124 : 7));
        assert.equal(existsSync(path.join(scratch, 'npm.json')), false);
      } else {
        run();
        const result = JSON.parse(readFileSync(path.join(scratch, 'npm.json'), 'utf8'));
        assert.deepEqual(result.installedCarrierIds, ['npm:@example/sdk']);
        assert.deepEqual(
          result.resolved.map(({ id }) => id),
          ['npm:@example/sdk'],
        );
      }
    }
    assert.equal(readFileSync(counter, 'utf8'), 'attempt\nattempt\nattempt\n');
    const pid = readFileSync(path.join(root, 'child-pid'), 'utf8');
    try {
      const state = execFileSync('ps', ['-o', 'stat=', '-p', pid], { encoding: 'utf8' }).trim();
      assert.match(state, /^Z|^$/);
    } catch (cause) {
      if (cause.status !== 1) throw cause;
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
