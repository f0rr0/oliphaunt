import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { RELEASE_PLEASE_BOOTSTRAP_SHA } from './release-please-bootstrap.mts';
import {
  deriveReleaseProducts,
  latestVerifiedReleaseCommit,
  verifyReleaseCommit,
} from './verify-release-commit.mts';

const [phase, repo, family, scenario, headRef, releaseRef] = process.argv.slice(2);
const broker = 'oliphaunt-broker';
const native = 'liboliphaunt-native';
const nativePath = 'src/native/runtime';
const exampleManifest = 'src/examples/native/tauri/src-tauri/Cargo.toml';
function write(file, contents) {
  const target = path.join(repo, file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents);
}
function json(file, data) {
  write(file, JSON.stringify(data) + '\n');
}
function simple(component) {
  return {
    'release-type': 'simple',
    component,
    'version-file': 'VERSION',
    'changelog-path': 'CHANGELOG.md',
  };
}
function changelog(folder, version) {
  write(`${folder}/CHANGELOG.md`, `# Changelog\n\n## ${version} (2026-07-14)\n`);
}
function cargo(name, version) {
  return `[package]\nname = "${name}"\nversion = "${version}"\n`;
}
function prepareBasic(base) {
  const bootstrap = family === 'bootstrap';
  const config = { packages: { 'packages/alpha': simple(broker) } };
  if (bootstrap && base) config['bootstrap-sha'] = RELEASE_PLEASE_BOOTSTRAP_SHA;
  if (bootstrap && scenario === 'mutated')
    config['bootstrap-sha'] = '1111111111111111111111111111111111111111';
  if (!bootstrap)
    config.packages['packages/beta'] = {
      'release-type': 'node',
      component: 'beta',
      'changelog-path': 'CHANGELOG.md',
    };
  json('release-please-config.json', config);
  const alpha =
    base || ['downgrade', 'hidden-version-config'].includes(scenario) ? '0.0.0' : '0.1.0';
  const beta = scenario === 'hidden-version-config' ? '0.1.0' : '0.0.0';
  json('.release-please-manifest.json', {
    'packages/alpha': alpha,
    ...(!bootstrap ? { 'packages/beta': beta } : {}),
  });
  write('packages/alpha/VERSION', `${alpha}\n`);
  if (base) write('packages/alpha/CHANGELOG.md', '# Changelog\n');
  else if (scenario !== 'hidden-version-config') changelog('packages/alpha', alpha);
  if (bootstrap) return;
  json('packages/beta/package.json', {
    name: 'beta',
    version: beta,
    ...(scenario === 'hidden-version-config' ? { scripts: { postinstall: 'hidden-code' } } : {}),
  });
  if (base) {
    write('packages/beta/CHANGELOG.md', '# Changelog\n');
    write('src/removable.rs', 'pub fn must_not_disappear() {}\n');
    write('src/future-version.txt', '0.1.0\n');
  } else if (scenario === 'hidden-version-config') changelog('packages/beta', beta);
  for (const sdk of ['kotlin', 'swift']) {
    if (base || scenario === `${sdk}-readme`)
      write(
        `src/native/sdks/${sdk}/README.md`,
        base ? 'See the canonical installation guide.\n' : 'Unexpected release edit.\n',
      );
  }
  if (
    base ||
    ['hidden-derived-config', 'derived-version-only', 'unrelated-derived-dependency'].includes(
      scenario,
    )
  )
    json('src/native/sdks/ts/package.json', {
      name: 'shadow-derived',
      oliphaunt: { brokerVersion: scenario === 'derived-version-only' ? '0.1.0' : '0.0.0' },
      optionalDependencies: {
        '@oliphaunt/broker-linux-x64-gnu': 'workspace:*',
        '@oliphaunt/unrelated':
          scenario === 'unrelated-derived-dependency' ? 'workspace:0.1.0' : 'workspace:*',
      },
      dangerous: scenario === 'hidden-derived-config',
    });
  if (scenario === 'tainted') write('src/fix.rs', 'pub fn hidden_fix() {}\n');
}
function prepareCargo(base) {
  json('release-please-config.json', {
    packages: {
      'src/native/broker': {
        'release-type': 'rust',
        component: broker,
        'changelog-path': 'CHANGELOG.md',
        'extra-files': [
          { type: 'json', path: 'packages/darwin-arm64/package.json', jsonpath: '$.version' },
        ],
      },
      'src/native/sdks/rust': { 'release-type': 'rust', component: 'oliphaunt-rust' },
    },
  });
  const version = base ? '0.0.0' : '0.1.0';
  json('.release-please-manifest.json', {
    'src/native/broker': version,
    'src/native/sdks/rust': version,
  });
  write('src/native/broker/Cargo.toml', cargo(broker, version));
  const carrier = 'src/native/broker/packages/darwin-arm64';
  json(`${carrier}/package.json`, { name: '@oliphaunt/broker-darwin-arm64', version });
  json('bun.lock', {
    lockfileVersion: 2,
    workspaces: {
      [carrier]: {
        name: '@oliphaunt/broker-darwin-arm64',
        version: scenario === 'wrong-workspace-version' ? '0.2.0' : version,
        os: [scenario === 'workspace-metadata' ? 'linux' : 'darwin'],
      },
      unrelated: { version: scenario === 'unrelated-workspace-version' ? version : '0.0.0' },
    },
  });
  if (base) {
    write('src/native/broker/CHANGELOG.md', '# Changelog\n');
    write('src/shared/unrelated/Cargo.toml', cargo('unrelated', '0.0.0'));
    write('src/native/sdks/rust/CHANGELOG.md', '# Changelog\n');
  } else {
    changelog('src/native/broker', version);
    changelog('src/native/sdks/rust', version);
  }
  write(
    'src/native/sdks/rust/Cargo.toml',
    cargo('oliphaunt', scenario === 'unrelated-package' ? '0.2.0' : version) +
      `\n[dependencies]\noliphaunt-broker = { path = "../../broker", version = "${version}" }\nunrelated = { path = "../../../../src/shared/unrelated", version = "${scenario === 'unrelated-pin' ? '0.1.0' : '0.0.0'}" }\n`,
  );
  if (base || ['exact', 'unrelated-lock'].includes(scenario))
    write(
      'Cargo.lock',
      `version = 4\n\n[[package]]\nname = "oliphaunt-broker"\nversion = "${version}"\n\n[[package]]\nname = "unrelated"\nversion = "${scenario === 'unrelated-lock' ? '0.1.0' : '0.0.0'}"\n`,
    );
}
function prepareWildcard(base) {
  json('release-please-config.json', {
    packages: { 'src/native/broker': { 'release-type': 'rust', component: broker } },
  });
  const version = base ? '0.1.0' : '0.2.0';
  json('.release-please-manifest.json', { 'src/native/broker': version });
  let entry = 'oliphaunt = { path = "../sdks/rust", version = "*", features = [] }';
  if (!base && scenario !== 'workspace-wildcard') {
    entry = entry.replace('"*"', scenario === 'wrong-version' ? '"0.3.0"' : '"0.2.0"');
    if (scenario === 'changed-path') entry = entry.replace('../sdks/rust', '../sdks/other');
    if (scenario === 'removed-path') entry = entry.replace('path = "../sdks/rust", ', '');
    if (scenario === 'changed-features')
      entry = entry.replace('features = []', 'features = ["extra"]');
  }
  write(
    'src/native/broker/Cargo.toml',
    cargo(broker, version) +
      ['dependencies', 'dev-dependencies', 'build-dependencies']
        .flatMap((table) => [
          `\n[${table}]\n${entry}\n`,
          `\n[target.'cfg(unix)'.${table}]\n${entry}\n`,
        ])
        .join(''),
  );
  if (base) {
    write('src/native/broker/CHANGELOG.md', '# Changelog\n');
    write('src/native/sdks/rust/Cargo.toml', cargo('oliphaunt', '0.2.0'));
  } else changelog('src/native/broker', version);
}
function prepareWasix(base) {
  const runtime = 'src/wasix/runtime',
    sdk = 'src/wasix/sdks/ts',
    tools = 'src/wasix/postgres-tools/ts';
  const version = base ? '0.1.0' : '0.2.0';
  json('release-please-config.json', {
    packages: {
      [runtime]: simple('liboliphaunt-wasix'),
      [sdk]: {
        'release-type': 'node',
        component: 'oliphaunt-wasix-ts',
        'changelog-path': 'CHANGELOG.md',
      },
    },
  });
  json('.release-please-manifest.json', { [runtime]: version, [sdk]: version });
  write(`${runtime}/VERSION`, `${version}\n`);
  changelog(runtime, version);
  json(`${sdk}/package.json`, { name: '@oliphaunt/wasix-ts', version });
  changelog(sdk, version);
  const dependencies = { '@oliphaunt/liboliphaunt-wasix-tools': 'workspace:*' },
    devDependencies = { '@oliphaunt/wasix-ts': 'workspace:*' };
  json(`${tools}/package.json`, {
    dependencies,
    peerDependencies: devDependencies,
    devDependencies,
  });
  json('bun.lock', {
    lockfileVersion: 2,
    workspaces: {
      [sdk]: { name: '@oliphaunt/wasix-ts', version },
      [tools]: { dependencies, devDependencies },
    },
  });
}
function prepareExample(base) {
  const sdk = 'src/native/sdks/rust';
  json('release-please-config.json', {
    packages: {
      [nativePath]: simple(native),
      'src/native/broker': simple(broker),
      [sdk]: { 'release-type': 'rust', component: 'oliphaunt-rust' },
    },
  });
  const missing = scenario === 'missing-native-transition';
  const nativeVersion = base || missing ? '0.3.1' : '0.3.2',
    brokerVersion = !base && missing ? '0.1.1' : '0.1.0';
  const sdkVersion = base || missing ? '0.2.0' : '0.2.1';
  json('.release-please-manifest.json', {
    [nativePath]: nativeVersion,
    'src/native/broker': brokerVersion,
    [sdk]: sdkVersion,
  });
  write(`${nativePath}/VERSION`, `${nativeVersion}\n`);
  write('src/native/broker/VERSION', `${brokerVersion}\n`);
  write(
    `${sdk}/Cargo.toml`,
    cargo('oliphaunt', sdkVersion) +
      `\n[package.metadata.oliphaunt]\nnative-version = "${nativeVersion}"\n`,
  );
  changelog(sdk, sdkVersion);
  if (base) {
    write(`${nativePath}/CHANGELOG.md`, '# Changelog\n');
    write('src/native/broker/CHANGELOG.md', '# Changelog\n');
  } else
    changelog(missing ? 'src/native/broker' : nativePath, missing ? brokerVersion : nativeVersion);
  const carrierVersion = base ? '0.3.1' : scenario === 'wrong-registry-version' ? '0.3.3' : '0.3.2';
  const runtimeVersion = base ? '0.3.1' : scenario === 'wrong-runtime-version' ? '0.3.3' : '0.3.2';
  const unrelatedVersion = scenario === 'unrelated-registry-version' ? '9.0.1' : '9.0.0';
  write(
    exampleManifest,
    `[package]\nname = "release-example"\nversion = "0.0.0"\n\n[package.metadata.oliphaunt]\nruntime = "liboliphaunt-native"\nruntime-version = "${runtimeVersion}"\n\n[target.'cfg(all(target_os = "linux", target_arch = "x86_64", target_env = "gnu"))'.dependencies]\nliboliphaunt-native-linux-x64-gnu = { version = "=${carrierVersion}" }\nunrelated = { version = "${unrelatedVersion}" }\n`,
  );
}
function prepareCompatibility(base) {
  const consumers = {
    'src/extensions/external/pg_hashids': simple('oliphaunt-extension-pg-hashids'),
    'src/native/sdks/ts': { 'release-type': 'node', component: 'oliphaunt-js' },
    'src/native/sdks/rust': { 'release-type': 'rust', component: 'oliphaunt-rust' },
    'src/native/sdks/swift': simple('oliphaunt-swift'),
  };
  const producers = { [nativePath]: simple(native), 'src/native/broker': simple(broker) };
  json('release-please-config.json', { packages: { ...producers, ...consumers } });
  const producerVersion = base || scenario === 'consumer-only' ? '0.3.1' : '0.3.2';
  const consumerVersion = base || scenario === 'unselected-consumer' ? '0.1.0' : '0.2.0';
  const pin = base ? '0.3.0' : producerVersion;
  const consumerPin = scenario === 'consumer-only' ? '0.3.0' : pin;
  json('.release-please-manifest.json', {
    ...Object.fromEntries(Object.keys(producers).map((folder) => [folder, producerVersion])),
    ...Object.fromEntries(Object.keys(consumers).map((folder) => [folder, consumerVersion])),
  });
  for (const folder of Object.keys(producers)) {
    write(`${folder}/VERSION`, `${producerVersion}\n`);
    changelog(folder, producerVersion);
  }
  for (const folder of Object.keys(consumers)) changelog(folder, consumerVersion);
  write('src/extensions/external/pg_hashids/VERSION', `${consumerVersion}\n`);
  write(
    'src/extensions/external/pg_hashids/release.toml',
    `[extension.compatibility]\npostgres_major = "${scenario === 'non-version-edit' ? '19' : '18'}"\nnative_runtime_version = "${scenario === 'wrong-toml-pin' ? '0.4.0' : pin}"\nwasix_runtime_version = "0.3.0"\n`,
  );
  json('src/native/sdks/ts/package.json', {
    name: '@oliphaunt/ts',
    version: consumerVersion,
    oliphaunt: {
      liboliphauntVersion: scenario === 'wrong-json-pin' ? '0.4.0' : consumerPin,
      brokerVersion: consumerPin,
    },
  });
  write(
    'src/native/sdks/rust/Cargo.toml',
    cargo('oliphaunt', consumerVersion) +
      `\n[package.metadata.oliphaunt]\nnative-version = "${consumerPin}"\nbroker-version = "${consumerPin}"\n`,
  );
  write(
    'src/native/sdks/rust/src/broker.rs',
    `const BROKER_RELEASE_VERSION: &str = "${scenario === 'wrong-rust-const' ? '0.4.0' : consumerPin}";\n`,
  );
  write('src/native/sdks/swift/VERSION', `${consumerVersion}\n`);
  write(
    'src/native/sdks/swift/LIBOLIPHAUNT_VERSION',
    `${scenario === 'wrong-raw-pin' ? '0.4.0' : consumerPin}\n`,
  );
}
function preparePublicSupport(base) {
  const owner = 'src/extensions/external/vector';
  const version =
    base || scenario === 'authored' ? '0.1.0' : scenario === 'authored-patch' ? '0.1.1' : '0.2.0';
  json('release-please-config.json', {
    packages: { [owner]: simple('oliphaunt-extension-vector') },
  });
  json('.release-please-manifest.json', { [owner]: version });
  write(`${owner}/VERSION`, `${version}\n`);
  changelog(owner, version);
  write(
    `${owner}/release.toml`,
    `[extension.compatibility]\nnative_runtime_version = "${base ? '0.3.2' : '0.3.3'}"\nwasix_runtime_version = "0.3.2"\n`,
  );
}
if (phase === 'write') {
  if (scenario === 'later-fix') write('fix.txt', 'post-release fix\n');
  else {
    const prepare = {
      bootstrap: prepareBasic,
      basic: prepareBasic,
      cargo: prepareCargo,
      wildcard: prepareWildcard,
      wasix: prepareWasix,
      example: prepareExample,
      compatibility: prepareCompatibility,
      'public-support': preparePublicSupport,
    }[family];
    if (!prepare) throw new Error('unknown release fixture family');
    prepare(scenario === 'base');
  }
} else if (phase === 'assert') {
  const products =
    family === 'public-support'
      ? ['oliphaunt-extension-vector']
      : family === 'compatibility'
        ? [
            ...(scenario === 'consumer-only' ? [] : [native, broker]),
            ...(scenario === 'unselected-consumer'
              ? []
              : [
                  'oliphaunt-extension-pg-hashids',
                  'oliphaunt-js',
                  'oliphaunt-rust',
                  'oliphaunt-swift',
                ]),
          ].sort()
        : family === 'cargo'
          ? [broker, 'oliphaunt-rust'].sort()
          : family === 'wasix'
            ? ['liboliphaunt-wasix', 'oliphaunt-wasix-ts']
            : family === 'example' && scenario !== 'missing-native-transition'
              ? [native, 'oliphaunt-rust']
              : scenario === 'hidden-version-config'
                ? ['beta']
                : [broker];
  const verify = () => verifyReleaseCommit({ repo, headRef, products });
  if (scenario === 'base') assert.equal(latestVerifiedReleaseCommit({ repo, headRef }), null);
  else if (scenario === 'later-fix') {
    assert.equal(latestVerifiedReleaseCommit({ repo, headRef }).commit, releaseRef);
    assert.throws(verify, /subject must start/u);
  } else {
    const rejected =
      {
        mutated: /release-please-config[.]json contains a non-version semantic change/u,
        'authored-patch': /must satisfy.*breaking-version policy/u,
        downgrade: /must advance to a semver version/u,
        tainted: /non-release-derived path.*src\/fix[.]rs/u,
        'kotlin-readme': /non-release-derived path.*kotlin\/README[.]md/u,
        'swift-readme': /non-release-derived path.*swift\/README[.]md/u,
        deletion: /non-release-derived path.*src\/removable[.]rs/u,
        rename: /non-release-derived path.*src\/future-version[.]txt/u,
        'hidden-version-config': /canonical version file.*non-version semantic change/u,
        'hidden-derived-config': /derived file.*non-version semantic change/u,
        'derived-version-only': /derived file.*oliphaunt[.]brokerVersion/u,
        'unrelated-derived-dependency':
          /derived file.*optionalDependencies[.]@oliphaunt\/unrelated/u,
        'unrelated-pin': /canonical version file.*dependencies[.]unrelated[.]version/u,
        'unrelated-package': /canonical version file.*Cargo[.]toml contains/u,
        'unrelated-lock': /derived file.*package[.]1[.]version/u,
        'wrong-workspace-version': /workspace lock version.*non-version semantic change/u,
        'unrelated-workspace-version': /derived file.*workspaces[.]unrelated[.]version/u,
        'workspace-metadata': /derived file.*workspaces[.].*[.]os[.]0/u,
        'wrong-registry-version': /derived file.*liboliphaunt-native-linux-x64-gnu[.]version/u,
        'wrong-runtime-version': /derived file.*runtime-version/u,
        'unrelated-registry-version': /derived file.*unrelated[.]version/u,
        'missing-native-transition':
          /derived file src\/examples\/native\/tauri\/src-tauri\/Cargo[.]toml contains a non-version semantic change/u,
        'unselected-consumer': /derived file.*extension[.]compatibility[.]native_runtime_version/u,
        'wrong-toml-pin': /derived file.*extension[.]compatibility[.]native_runtime_version/u,
        'wrong-json-pin': /canonical version file.*oliphaunt[.]liboliphauntVersion/u,
        'wrong-raw-pin': /derived file.*LIBOLIPHAUNT_VERSION.*non-version semantic change/u,
        'wrong-rust-const': /derived file.*broker[.]rs.*non-version semantic change/u,
        'non-version-edit': /derived file.*extension[.]compatibility[.]postgres_major/u,
      }[scenario] ??
      (family === 'wildcard' && scenario !== 'workspace-wildcard'
        ? /canonical version file.*non-version semantic change/u
        : undefined);
    if (rejected) assert.throws(verify, rejected);
    else {
      const result = verify();
      assert.deepEqual(result.products, products);
      if (family === 'basic' && scenario === 'clean') {
        assert.deepEqual(deriveReleaseProducts({ repo, headRef }).products, [broker]);
        assert.equal(result.versions[broker], '0.1.0');
        assert.throws(
          () => verifyReleaseCommit({ repo, headRef, products: [broker, 'beta'] }),
          /do not exactly match/u,
        );
      }
    }
  }
  console.log(`release commit ${family}/${scenario}: passed`);
} else throw new Error('run through verify-release-commit.test.sh');
