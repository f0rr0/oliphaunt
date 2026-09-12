import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  expectedExtensionAotTargets,
  wasixExtensionAotPackageName,
  wasixExtensionPackageName,
} from '../../../../runtimes/liboliphaunt-wasix/tools/wasix-cargo-artifact-contract.mts';
import {
  currentProductVersionSync,
  extensionRegistryPackageTargetSets,
  extensionReleaseVersion,
} from '../../../../tools/release/release-artifact-targets.mts';
import { nativeExtensionCargoPackageName } from './extension-registry-packages.mts';
import {
  packageExtensionCargoFacades,
  renderUnsupportedNativeGuard,
  writeFacadeSource,
} from './package-extension-cargo-facades.mts';

const directories = [];

if (['prepare-compiler', 'verify-compiler'].includes(process.argv[2])) {
  if (process.argv[2] === 'prepare-compiler') {
    const root = process.argv[3];
    const leaves = path.join(root, 'leaves');
    const generated = path.join(root, 'generated');
    mkdirSync(leaves, { recursive: true });
    const host = process.argv[4];
    expect(host).toMatch(/^[A-Za-z0-9_+.]+(?:-[A-Za-z0-9_+.]+){2,3}$/u);
    const targetTriples = {
      'linux-arm64-gnu': 'aarch64-unknown-linux-gnu',
      'linux-x64-gnu': 'x86_64-unknown-linux-gnu',
      'macos-arm64': 'aarch64-apple-darwin',
      'windows-x64-msvc': 'x86_64-pc-windows-msvc',
    };
    const nativeRuntimeVersion = currentProductVersionSync(
      'liboliphaunt-native',
      'package-extension-cargo-facades.test',
    );
    const products = ['oliphaunt-extension-contrib-pg18', 'oliphaunt-extension-vector'];
    const dependencyPaths = {};
    for (const product of products) {
      const productVersion = extensionReleaseVersion(
        product,
        'native',
        'package-extension-cargo-facades.test',
      );
      const targets = extensionRegistryPackageTargetSets(product, 'extension-facade-integration');
      const nativeNames = targets.nativeCargoTargets.map((target) => [
        nativeExtensionCargoPackageName(product, target),
        targetTriples[target],
      ]);
      const wasixNames =
        product === 'oliphaunt-extension-contrib-pg18'
          ? []
          : [
              [wasixExtensionPackageName(product), 'portable'],
              ...expectedExtensionAotTargets().map((target) => [
                wasixExtensionAotPackageName(product, target),
                target,
              ]),
            ];
      for (const [name, target] of [...nativeNames, ...wasixNames]) {
        const bundled = product === 'oliphaunt-extension-contrib-pg18';
        const members = bundled
          ? ['cube', 'hstore', 'pg_trgm'].map((extension) => ({
              extension,
              dependencies: [],
              files: [
                {
                  relative: `share/postgresql/extension/${extension}.control`,
                  contents: `${extension} fixture`,
                },
              ],
            }))
          : [
              {
                files: [
                  {
                    relative: 'share/postgresql/extension/vector.control',
                    contents: 'vector fixture',
                  },
                ],
              },
            ];
        const header = bundled
          ? `schema = "oliphaunt-artifact-manifest-v2"\nproduct = ${JSON.stringify(product)}\nversion = ${JSON.stringify(productVersion)}\nkind = "extension"\ntarget = ${JSON.stringify(target)}\nruntime-product = "liboliphaunt-native"\nruntime-version = ${JSON.stringify(nativeRuntimeVersion)}`
          : `schema = "oliphaunt-artifact-manifest-v1"\nproduct = ${JSON.stringify(product)}\nversion = ${JSON.stringify(productVersion)}\nkind = "extension"\ntarget = ${JSON.stringify(target)}\nruntime-product = "liboliphaunt-native"\nruntime-version = ${JSON.stringify(nativeRuntimeVersion)}\nextension = "vector"\ndependencies = []`;
        dependencyPaths[name] = fakeCarrier(leaves, {
          name,
          version: productVersion,
          header,
          members,
        });
      }
      writeFacadeSource(product, generated, { dependencyPaths });
    }

    const genericCarrier = (name, product, version, kind, files) =>
      fakeCarrier(leaves, {
        name,
        version,
        header: `schema = "oliphaunt-artifact-manifest-v1"\nproduct = ${JSON.stringify(product)}\nversion = ${JSON.stringify(version)}\nkind = ${JSON.stringify(kind)}\ntarget = ${JSON.stringify(host)}`,
        members: [
          { files: files.map((relative) => ({ relative, contents: `${name}:${relative}` })) },
        ],
      });
    const runtime = genericCarrier(
      'fixture-native-runtime',
      'liboliphaunt-native',
      nativeRuntimeVersion,
      'native-runtime',
      ['runtime/bin/postgres', 'runtime/bin/initdb', 'runtime/bin/pg_ctl'],
    );
    const tools = genericCarrier(
      'fixture-native-tools',
      'oliphaunt-tools',
      currentProductVersionSync('postgres-tools-native', 'package-extension-cargo-facades.test'),
      'native-tools',
      ['runtime/bin/pg_basebackup', 'runtime/bin/pg_dump', 'runtime/bin/psql'],
    );
    const broker = genericCarrier(
      'fixture-broker',
      'oliphaunt-broker',
      currentProductVersionSync('oliphaunt-broker', 'package-extension-cargo-facades.test'),
      'broker-helper',
      ['bin/oliphaunt-broker'],
    );
    const app = path.join(root, 'app');
    mkdirSync(path.join(app, 'src'), { recursive: true });
    writeFileSync(path.join(app, 'src/lib.rs'), '#![forbid(unsafe_code)]\n');
    writeFileSync(path.join(app, 'build.rs'), 'fn main() { oliphaunt_build::configure(); }\n');
    writeFileSync(
      path.join(app, 'Cargo.toml'),
      `[package]
name = "facade-app"
version = "0.0.0"
edition = "2024"
build = "build.rs"

[package.metadata.oliphaunt]
runtime = "liboliphaunt-native"
runtime-version = ${JSON.stringify(nativeRuntimeVersion)}
extensions = ["cube", "pg_trgm", "vector"]

[dependencies]
contrib = { package = "oliphaunt-extension-contrib-pg18", path = ${JSON.stringify(path.join(generated, 'sources/oliphaunt-extension-contrib-pg18'))} }
vector = { package = "oliphaunt-extension-vector", path = ${JSON.stringify(path.join(generated, 'sources/oliphaunt-extension-vector'))} }
fixture-native-runtime = { path = ${JSON.stringify(runtime)} }
fixture-native-tools = { path = ${JSON.stringify(tools)} }
fixture-broker = { path = ${JSON.stringify(broker)} }

[build-dependencies]
oliphaunt-build = { path = ${JSON.stringify(path.resolve(import.meta.dir, '../../../../sdks/rust/sdk/crates/oliphaunt-build'))} }

[workspace]
`,
    );

    const output = root;
    const forcedUnsupportedSource = path.join(output, 'forced-unsupported.rs');
    writeFileSync(
      forcedUnsupportedSource,
      `#![forbid(unsafe_code)]
${renderUnsupportedNativeGuard('fixture-extension', ['fixture-unsupported'], ['any()'])}
pub const FIXTURE: bool = true;
`,
    );
  } else {
    const root = process.argv[3];
    const lock = findFile(path.join(root, 'cargo-target'), 'oliphaunt-assets.lock');
    expect(lock).not.toBeNull();
    const text = readFileSync(lock, 'utf8');
    expect(text).toContain('extension = "cube"');
    expect(text).toContain('extension = "pg_trgm"');
    expect(text).toContain('extension = "vector"');
    expect(text).not.toContain('extension = "hstore"');
  }
  process.exit(0);
}
afterEach(() => {
  while (directories.length > 0) rmSync(directories.pop(), { recursive: true, force: true });
});

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function fakeCarrier(root, { name, version, header, members }) {
  const directory = path.join(root, name);
  mkdirSync(path.join(directory, 'src'), { recursive: true });
  const links = `oliphaunt_artifact_fixture_${name.replaceAll('-', '_')}`;
  writeFileSync(
    path.join(directory, 'Cargo.toml'),
    `[package]
name = ${JSON.stringify(name)}
version = ${JSON.stringify(version)}
edition = "2024"
links = ${JSON.stringify(links)}
build = "build.rs"

[lib]
path = "src/lib.rs"

[workspace]
`,
  );
  writeFileSync(path.join(directory, 'src/lib.rs'), '#![forbid(unsafe_code)]\n');
  const lines = [
    'use std::env;',
    'use std::fs;',
    'use std::path::PathBuf;',
    'fn main() {',
    '  let out = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR"));',
    `  let mut manifest = ${JSON.stringify(`${header}\n`)}.to_owned();`,
  ];
  for (const [memberIndex, member] of members.entries()) {
    if (member.extension !== undefined) {
      lines.push(
        `  manifest.push_str(${JSON.stringify(`\n[[extensions]]\nextension = ${JSON.stringify(member.extension)}\ndependencies = ${JSON.stringify(member.dependencies ?? [])}\n`)});`,
      );
    }
    for (const [fileIndex, file] of member.files.entries()) {
      const variable = `file_${memberIndex}_${fileIndex}`;
      lines.push(
        `  let ${variable} = out.join(${JSON.stringify(`payload/${member.extension ?? 'root'}/${file.relative}`)});`,
        `  fs::create_dir_all(${variable}.parent().expect("parent")).expect("mkdir");`,
        `  fs::write(&${variable}, ${JSON.stringify(file.contents)}).expect("write payload");`,
        `  manifest.push_str(&format!(${JSON.stringify(`\n${member.extension === undefined ? '[[files]]' : '[[extensions.files]]'}\nsource = {:?}\nrelative = ${JSON.stringify(file.relative)}\nsha256 = ${JSON.stringify(sha256(file.contents))}\nexecutable = false\n`)}, ${variable}.display().to_string()));`,
      );
    }
  }
  lines.push(
    '  let path = out.join("oliphaunt-artifact.toml");',
    '  fs::write(&path, manifest).expect("write manifest");',
    '  println!("cargo::metadata=manifest={}", path.display());',
    '}',
  );
  writeFileSync(path.join(directory, 'build.rs'), `${lines.join('\n')}\n`);
  return directory;
}

function findFile(root, basename) {
  for (const entry of readdirSync(root)) {
    const candidate = path.join(root, entry);
    if (statSync(candidate).isDirectory()) {
      const found = findFile(candidate, basename);
      if (found !== null) return found;
    } else if (entry === basename) {
      return candidate;
    }
  }
  return null;
}

describe('exact extension Cargo facade', () => {
  test('packages explicit native and WASIX feature selections', () => {
    const output = mkdtempSync(path.join(tmpdir(), 'extension-facade-test-'));
    directories.push(output);
    const [pkg] = packageExtensionCargoFacades(['oliphaunt-extension-pgtap'], output);
    const manifest = Bun.TOML.parse(readFileSync(pkg.manifestPath, 'utf8'));
    expect(manifest.features.default).toEqual(['native']);
    expect(manifest.features.wasix).toEqual([`dep:oliphaunt-extension-pgtap-wasix`]);
    expect(pkg.cratePath.endsWith('.crate')).toBe(true);
  });

  test('the native-owned contrib facade has no WASIX carrier dependency', () => {
    const output = mkdtempSync(path.join(tmpdir(), 'extension-facade-bundle-test-'));
    directories.push(output);
    const [pkg] = packageExtensionCargoFacades(['oliphaunt-extension-contrib-pg18'], output);
    const manifest = Bun.TOML.parse(readFileSync(pkg.manifestPath, 'utf8'));
    expect(manifest.package.version).toBe(
      extensionReleaseVersion(
        'oliphaunt-extension-contrib-pg18',
        'native',
        'package-extension-cargo-facades.test',
      ),
    );
    expect(manifest.features.default).toEqual(['native']);
    expect(manifest.features.wasix).toBeUndefined();
    expect(Object.keys(manifest.dependencies ?? {})).toHaveLength(0);
  });
});
