import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  canonicalWasixCargoToolchainVersions,
  canonicalWasixEngineSourcePackages,
  validateWasixConsumerDependencyPins,
  WASIX_ENGINE_SOURCES_PATH,
  WASIX_TOOLCHAIN_PATH,
} from './wasix-cargo-toolchain-policy.mts';

const toolchainVersions = { wasmer: '7.5.0', wasmerWasix: '0.705.0', webc: '12.0.1' };
const engineSourcePackages = ['wasmer', 'wasmer-wasix', 'wasmer-wasix-types', 'wasmer-journal'];
const nonWindows = 'cfg(not(windows))';
const windows = 'cfg(windows)';

function manifest() {
  return Bun.TOML.parse(`
[package]
name = "oliphaunt-wasix"
version = "1.2.3"
[dependencies]
serde = "1"
[target.'cfg(not(windows))'.dependencies]
wasmer = { version = "=7.5.0", default-features = false, features = ["sys", "headless", "compiler", "wasmer-artifact-load"] }
wasmer-types = "=7.5.0"
wasmer-config = { version = "=0.705.0", default-features = false }
wasmer-journal = { version = "=0.705.0", default-features = false }
wasmer-package = { version = "=0.705.0", default-features = false }
wasmer-wasix = { version = "=0.705.0", default-features = false, features = ["sys-minimal", "sys-poll", "host-vnet", "time"] }
wasmer-wasix-types = { version = "=0.705.0", default-features = false }
virtual-fs = { version = "=0.705.0", default-features = false }
virtual-mio = { version = "=0.705.0", default-features = false }
virtual-net = { version = "=0.705.0", default-features = false }
webc = "=12.0.1"
[target.'cfg(windows)'.dependencies]
wasmer = { package = "oliphaunt-wasmer", version = "=1.2.3", default-features = false, features = ["v8", "headless"] }
wasmer-types = "=7.5.0"
wasmer-config = { version = "=0.705.0", default-features = false }
wasmer-journal = { package = "oliphaunt-wasmer-journal", version = "=1.2.3", default-features = false }
wasmer-package = { version = "=0.705.0", default-features = false }
wasmer-wasix = { package = "oliphaunt-wasmer-wasix", version = "=1.2.3", default-features = false, features = ["sys-minimal", "sys-poll", "host-vnet", "time", "v8"] }
wasmer-wasix-types = { package = "oliphaunt-wasmer-wasix-types", version = "=1.2.3", default-features = false }
virtual-fs = { version = "=0.705.0", default-features = false }
virtual-mio = { version = "=0.705.0", default-features = false }
virtual-net = { version = "=0.705.0", default-features = false }
webc = "=12.0.1"
`);
}

function validate(value, options = {}) {
  return validateWasixConsumerDependencyPins(value, {
    manifestPath: 'fixture.toml',
    toolchainVersions,
    engineSourcePackages,
    ...options,
  });
}

test('accepts coherent target-specific families and ordinary unrelated dependencies', () => {
  const value = manifest();
  value.target['cfg(target_arch = "x86_64")'] = {
    dependencies: { 'liboliphaunt-wasix-aot-x86_64-pc-windows-msvc': '=9.8.7' },
  };
  expect(validate(value)).toEqual([]);
});

test('resolves explicit workspace context and rejects unresolved published requirements', () => {
  const value = manifest();
  const inherited = value.target[windows].dependencies.wasmer;
  value.target[windows].dependencies.wasmer = { workspace: true, features: ['v8', 'headless'] };
  const failures = validate(value).join('\n');
  expect(failures).toContain('must pin oliphaunt-wasmer exactly to =1.2.3, got null');
  expect(failures).toContain('without source selectors, found workspace');
  expect(validate(value, { workspace: { dependencies: { wasmer: inherited } } })).toEqual([]);
});

test('requires all four renamed Windows packages at the SDK version with canonical aliases', () => {
  for (const name of engineSourcePackages) {
    const value = manifest();
    const dependencies = value.target[windows].dependencies;
    dependencies[name].version = '=7.5.0';
    expect(validate(value)).toContain(
      `fixture.toml target.${windows}.dependencies.${name} must pin oliphaunt-${name} exactly to =1.2.3, got "=7.5.0"`,
    );
    dependencies[name].version = '=1.2.3';
    delete dependencies[name].package;
    expect(validate(value)).toContain(
      `fixture.toml target.${windows}.dependencies.${name} must use alias ${name} for package oliphaunt-${name}`,
    );
  }
});

test('rejects missing, ranged, optional and source-substituted family pins on either target', () => {
  for (const selector of [nonWindows, windows]) {
    const value = manifest();
    const dependencies = value.target[selector].dependencies;
    const version = '0.705.0';
    delete dependencies['virtual-fs'];
    dependencies['virtual-mio'].version = version;
    dependencies['virtual-net'].optional = true;
    dependencies['wasmer-config']['default-features'] = true;
    dependencies['wasmer-package'].path = '../../substituted';
    dependencies.webc = { version: '^12.0.0', git: 'https://example.invalid/webc' };
    const failures = validate(value).join('\n');
    expect(failures).toContain('must declare non-optional virtual-fs exactly once, found 0');
    expect(failures).toContain(`must pin virtual-mio exactly to =${version}, got "${version}"`);
    expect(failures).toContain('must keep virtual-net non-optional');
    expect(failures).toContain('must set default-features = false for wasmer-config');
    expect(failures).toContain('without source selectors, found path');
    expect(failures).toContain('must pin webc exactly to =12.0.');
    expect(failures).toContain('without source selectors, found git');
  }
});

test('keeps Wasmer types in one stock generation across both targets', () => {
  for (const selector of [nonWindows, windows]) {
    const value = manifest();
    value.target[selector].dependencies['wasmer-types'] = '=7.2.1';
    expect(validate(value)).toContain(
      `fixture.toml target.${selector}.dependencies.wasmer-types must pin wasmer-types exactly to =7.5.0, got "=7.2.1"`,
    );
  }
});

test('requires backend features and rejects accidental Windows native compilers', () => {
  for (const [selector, name, feature] of [
    [windows, 'wasmer', 'v8'],
    [windows, 'wasmer', 'headless'],
    [windows, 'wasmer-wasix', 'v8'],
    [windows, 'wasmer-wasix', 'sys-minimal'],
    [nonWindows, 'wasmer', 'wasmer-artifact-load'],
  ]) {
    const value = manifest();
    const dependency = value.target[selector].dependencies[name];
    dependency.features = dependency.features.filter((value) => value !== feature);
    expect(validate(value).join('\n')).toContain(`must enable features ${feature} for `);
  }
  const value = manifest();
  value.target[windows].dependencies.wasmer.features.push('compiler');
  value.target[nonWindows].dependencies.wasmer.features.push('v8');
  const failures = validate(value).join('\n');
  expect(failures).toContain('must not enable features compiler for oliphaunt-wasmer');
  expect(failures).toContain('must not enable features v8 for wasmer');
});

test('rejects overlapping, renamed and additional target-specific dependency overrides', () => {
  const value = manifest();
  value.dependencies['wasmer-config'] = { version: '=0.705.0', 'default-features': false };
  value.target[windows].dependencies.extra = {
    package: 'oliphaunt-wasmer',
    version: '=1.2.3',
  };
  value.target['cfg(target_arch = "x86_64")'] = {
    dependencies: { 'virtual-fs': '=0.705.0' },
  };
  const failures = validate(value).join('\n');
  expect(failures).toContain('must declare non-optional wasmer-config exactly once, found 2');
  expect(failures).toContain('must declare non-optional wasmer exactly once, found 2');
  expect(failures).toContain('must declare toolchain pins in cfg(windows) or cfg(not(windows))');
});

test('checks source provenance against the single canonical stock generation', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'oliphaunt-toolchain-policy-'));
  try {
    mkdirSync(path.dirname(path.join(root, WASIX_ENGINE_SOURCES_PATH)), { recursive: true });
    writeFileSync(
      path.join(root, WASIX_TOOLCHAIN_PATH),
      '[toolchain]\nwasmer = "8.1.0"\nwasmer-wasix = "0.801.0"\nwebc = "13.1.0"\n',
    );
    writeFileSync(
      path.join(root, WASIX_ENGINE_SOURCES_PATH),
      JSON.stringify({
        crates: { wasmer: { version: '8.1.0' }, 'wasmer-wasix': { version: '0.801.0' } },
      }),
    );
    expect(canonicalWasixCargoToolchainVersions(root)).toEqual({
      wasmer: '8.1.0',
      wasmerWasix: '0.801.0',
      webc: '13.1.0',
    });
    expect(canonicalWasixEngineSourcePackages(root)).toEqual(['wasmer', 'wasmer-wasix']);
    writeFileSync(
      path.join(root, WASIX_ENGINE_SOURCES_PATH),
      JSON.stringify({ crates: { wasmer: { version: '7.2.1' } } }),
    );
    expect(() => canonicalWasixEngineSourcePackages(root)).toThrow(
      'crates.wasmer.version must match src/wasix/runtime/toolchain.toml',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
