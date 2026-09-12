import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  deriveReleaseProducts,
  latestVerifiedReleaseCommit,
  verifyReleaseCommit,
} from './verify-release-commit.mts';
import { RELEASE_PLEASE_BOOTSTRAP_SHA } from './release-please-bootstrap.mts';
const [phase, repo, family, scenario, headRef, releaseRef] = process.argv.slice(2);
const broker = 'oliphaunt-broker';
const native = 'liboliphaunt-native';
const nativePath = 'runtimes/liboliphaunt-native';
const exampleManifest = 'examples/tauri/src-tauri/Cargo.toml';
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
  if (
    base ||
    ['hidden-derived-config', 'derived-version-only', 'unrelated-derived-dependency'].includes(
      scenario,
    )
  )
    json('sdks/ts/sdk/package.json', {
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
      broker: { 'release-type': 'rust', component: broker, 'changelog-path': 'CHANGELOG.md' },
    },
  });
  const version = base ? '0.0.0' : '0.1.0';
  json('.release-please-manifest.json', { broker: version });
  write('broker/Cargo.toml', cargo(broker, version));
  if (base) {
    write('broker/CHANGELOG.md', '# Changelog\n');
    write('src/shared/unrelated/Cargo.toml', cargo('unrelated', '0.0.0'));
  } else changelog('broker', version);
  if (base || scenario !== 'unrelated-lock')
    write(
      'sdks/rust/sdk/Cargo.toml',
      cargo('shadow-sdk', scenario === 'unrelated-package' ? '0.1.0' : '0.0.0') +
        `\n[dependencies]\noliphaunt-broker = { path = "../../../broker", version = "${version}" }\nunrelated = { path = "../../../src/shared/unrelated", version = "${scenario === 'unrelated-pin' ? '0.1.0' : '0.0.0'}" }\n`,
    );
  if (base || ['exact', 'unrelated-lock'].includes(scenario))
    write(
      'Cargo.lock',
      `version = 4\n\n[[package]]\nname = "oliphaunt-broker"\nversion = "${version}"\n\n[[package]]\nname = "unrelated"\nversion = "${scenario === 'unrelated-lock' ? '0.1.0' : '0.0.0'}"\n`,
    );
}
function prepareWildcard(base) {
  json('release-please-config.json', {
    packages: { broker: { 'release-type': 'rust', component: broker } },
  });
  const version = base ? '0.1.0' : '0.2.0';
  json('.release-please-manifest.json', { broker: version });
  let entry = 'oliphaunt = { path = "../../sdks/rust", version = "*", features = [] }';
  if (!base && scenario !== 'workspace-wildcard') {
    entry = entry.replace('"*"', scenario === 'wrong-version' ? '"0.3.0"' : '"0.2.0"');
    if (scenario === 'changed-path') entry = entry.replace('../../sdks/rust', '../../sdks/other');
    if (scenario === 'removed-path') entry = entry.replace('path = "../../sdks/rust", ', '');
    if (scenario === 'changed-features')
      entry = entry.replace('features = []', 'features = ["extra"]');
  }
  write(
    'broker/Cargo.toml',
    cargo(broker, version) +
      ['dependencies', 'dev-dependencies', 'build-dependencies']
        .flatMap((table) => [
          `\n[${table}]\n${entry}\n`,
          `\n[target.'cfg(unix)'.${table}]\n${entry}\n`,
        ])
        .join(''),
  );
  if (base) {
    write('broker/CHANGELOG.md', '# Changelog\n');
    write('sdks/rust/sdk/Cargo.toml', cargo('oliphaunt', '0.2.0'));
  } else changelog('broker', version);
}
function prepareWasix(base) {
  const runtime = 'runtimes/liboliphaunt-wasix',
    sdk = 'sdks/ts-wasix/sdk',
    tools = 'postgres-tools/wasix/ts';
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
  json('release-please-config.json', {
    packages: { [nativePath]: simple(native), broker: simple(broker) },
  });
  const missing = scenario === 'missing-native-transition';
  const nativeVersion = base || missing ? '0.1.0' : '0.1.1',
    brokerVersion = !base && missing ? '0.1.1' : '0.1.0';
  json('.release-please-manifest.json', { [nativePath]: nativeVersion, broker: brokerVersion });
  write(`${nativePath}/VERSION`, `${nativeVersion}\n`);
  write('broker/VERSION', `${brokerVersion}\n`);
  if (base) {
    write(`${nativePath}/CHANGELOG.md`, '# Changelog\n');
    write('broker/CHANGELOG.md', '# Changelog\n');
  } else changelog(missing ? 'broker' : nativePath, missing ? brokerVersion : nativeVersion);
  const carrierVersion = base ? '0.1.0' : scenario === 'wrong-registry-version' ? '0.1.2' : '0.1.1';
  const runtimeVersion = base ? '0.1.0' : scenario === 'wrong-runtime-version' ? '0.1.2' : '0.1.1';
  const unrelatedVersion = scenario === 'unrelated-registry-version' ? '9.0.1' : '9.0.0';
  write(
    exampleManifest,
    `[package]\nname = "release-example"\nversion = "0.0.0"\n\n[package.metadata.oliphaunt]\nruntime = "liboliphaunt-native"\nruntime-version = "${runtimeVersion}"\n\n[target.'cfg(all(target_os = "linux", target_arch = "x86_64", target_env = "gnu"))'.dependencies]\nliboliphaunt-native-linux-x64-gnu = { version = "=${carrierVersion}" }\nunrelated = { version = "${unrelatedVersion}" }\n`,
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
    }[family];
    if (!prepare) throw new Error('unknown release fixture family');
    prepare(scenario === 'base');
  }
} else if (phase === 'assert') {
  const products =
    family === 'wasix'
      ? ['liboliphaunt-wasix', 'oliphaunt-wasix-ts']
      : family === 'example' && scenario !== 'missing-native-transition'
        ? [native]
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
        downgrade: /must advance to a semver version/u,
        tainted: /non-release-derived path.*src\/fix[.]rs/u,
        deletion: /non-release-derived path.*src\/removable[.]rs/u,
        rename: /non-release-derived path.*src\/future-version[.]txt/u,
        'hidden-version-config': /canonical version file.*non-version semantic change/u,
        'hidden-derived-config': /derived file.*non-version semantic change/u,
        'unrelated-derived-dependency':
          /derived file.*optionalDependencies[.]@oliphaunt\/unrelated/u,
        'unrelated-pin': /derived file.*dependencies[.]unrelated[.]version/u,
        'unrelated-package': /derived file.*package[.]version/u,
        'unrelated-lock': /derived file.*package[.]1[.]version/u,
        'wrong-registry-version': /derived file.*liboliphaunt-native-linux-x64-gnu[.]version/u,
        'wrong-runtime-version': /derived file.*runtime-version/u,
        'unrelated-registry-version': /derived file.*unrelated[.]version/u,
        'missing-native-transition':
          /derived file examples\/tauri\/src-tauri\/Cargo[.]toml contains a non-version semantic change/u,
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
