import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  cpSync,
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
import { packagedCargoManifestText } from '../../../../../tools/packaging/cargo-source-package.mts';
import {
  currentProductVersionSync,
  extensionMetadata,
  extensionPublicDependencySqlNames,
  extensionRegistryPackageTargetSets,
  extensionReleaseProduct,
  extensionReleaseVersion,
  extensionSqlNames,
} from '../../../../../tools/release/release-artifact-targets.mts';
import {
  expectedExtensionAotTargets,
  wasixExtensionAotPackageName,
  wasixExtensionPackageName,
} from '../../../../wasix/runtime/tools/wasix-cargo-artifact-contract.mts';
import { nativeExtensionCargoPackageName } from './extension-registry-packages.mts';
import {
  packageExtensionCargoFacades,
  renderUnsupportedNativeGuard,
  writeFacadeSource,
} from './package-extension-cargo-facades.mts';

const directories = [];
const api = Bun.TOML.parse(readFileSync(new URL('../Cargo.toml', import.meta.url), 'utf8'));

function installFixture(sqlName, { dependencies = [], compiled = false, startupConfig = [] } = {}) {
  const modulePath = `lib/postgresql/${sqlName}.so`;
  return {
    schema: 'oliphaunt-wasix-extension-install-v1',
    name: sqlName,
    nativeModule: compiled ? `${sqlName}.so` : null,
    nativeModules: compiled
      ? [
          {
            name: sqlName,
            path: modulePath,
            sha256: 'a'.repeat(64),
            moduleSha256: 'b'.repeat(64),
            size: 1,
          },
        ]
      : [],
    dependencies,
    coreExportsRequired: [],
    loadOrder: [],
    lifecycle: {
      createExtension: true,
      createSchema: null,
      loadSql: [],
      postCreateSql: [],
      startupConfig,
      preloadRequired: false,
      restartRequired: false,
      sharedMemoryRequired: false,
    },
    installedFiles: [
      ...(compiled ? [modulePath] : []),
      `share/postgresql/extension/${sqlName}.control`,
    ],
    unresolvedImports: [],
  };
}

function facadeMetadata(product) {
  const sqlNames = extensionSqlNames(product);
  const nativeOwner = extensionReleaseProduct(product, 'native');
  const wasixOwner = extensionReleaseProduct(product, 'wasix');
  const targets = extensionRegistryPackageTargetSets(product);
  return {
    nativeOwner,
    wasixOwner,
    version: extensionReleaseVersion(product, 'native'),
    sqlNames,
    targets,
    compatibility: extensionMetadata(product).compatibility,
    memberContracts: sqlNames.map((sqlName) => {
      const dependencies = extensionPublicDependencySqlNames(sqlName);
      return {
        sqlName,
        dependencies,
        wasixInstall: installFixture(sqlName, { dependencies, compiled: targets.includeWasixAot }),
      };
    }),
    wasixDependencies:
      product === 'oliphaunt-extension-postgis'
        ? [
            {
              product: 'oliphaunt-extension-contrib-pg18',
              version: extensionMetadata(product).compatibility.wasixRuntimeVersion,
              members: ['fuzzystrmatch', 'hstore'].map((sqlName) => ({
                sqlName,
                wasixInstall: installFixture(sqlName, { compiled: true }),
              })),
            },
          ]
        : [],
  };
}

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
    const products = [
      'oliphaunt-extension-contrib-pg18',
      'oliphaunt-extension-vector',
      'oliphaunt-extension-postgis',
    ];
    const helperSource = path.resolve(
      import.meta.dir,
      '../../../../native/sdks/rust/crates/oliphaunt-build',
    );
    const helper = path.join(root, 'build-helper');
    cpSync(helperSource, helper, { recursive: true });
    const sourceVersion = (requirement) => requirement.replace(/^\^/u, '');
    writeFileSync(
      path.join(helper, 'Cargo.toml'),
      packagedCargoManifestText(readFileSync(path.join(helper, 'Cargo.toml'), 'utf8')).replace(
        /^version = "[^"]+"/mu,
        `version = "${sourceVersion(api['build-dependencies']['oliphaunt-build'])}"`,
      ),
    );
    // Source-only API compilation uses the real implementation with test-only
    // version metadata; final consumers resolve the original published crates.
    const bindings = path.join(root, 'bindings');
    cpSync(path.resolve(import.meta.dir, '../../../../native/rust-bindings'), bindings, {
      recursive: true,
    });
    writeFileSync(
      path.join(bindings, 'Cargo.toml'),
      packagedCargoManifestText(
        readFileSync(path.join(bindings, 'Cargo.toml'), 'utf8').replace(
          /^version = "[^"]+"/mu,
          `version = "${sourceVersion(api.dependencies['liboliphaunt-native-bindings'])}"`,
        ),
        readFileSync(new URL('../../../../../Cargo.toml', import.meta.url), 'utf8'),
      ),
    );
    const dependencyPaths = {
      'liboliphaunt-native-bindings': bindings,
      'oliphaunt-build': helper,
    };
    // The native consumer does not enable WASIX, but Cargo resolves optional coordinates.
    const wasixStub = path.join(root, 'wasix-sdk');
    mkdirSync(path.join(wasixStub, 'src'), { recursive: true });
    writeFileSync(
      path.join(wasixStub, 'Cargo.toml'),
      `[package]\nname = "oliphaunt-wasix"\nversion = "${sourceVersion(api.dependencies['oliphaunt-wasix'])}"\nedition = "2024"\n[features]\nextensions = []\n[workspace]\n`,
    );
    const wasixSources = path.resolve(import.meta.dir, '../../../../wasix/sdks/rust/src/oliphaunt');
    writeFileSync(
      path.join(wasixStub, 'src/lib.rs'),
      `
extern crate self as liboliphaunt_wasix_portable;
pub const PACKAGE_VERSION: &str = ${JSON.stringify(extensionMetadata('oliphaunt-extension-postgis').compatibility.wasixRuntimeVersion)};
pub mod error { pub fn invalid_configuration(message: impl Into<String>) -> anyhow::Error { anyhow::Error::msg(message.into()) } }
pub mod oliphaunt {
    #[path = ${JSON.stringify(path.join(wasixSources, 'config.rs'))}] pub mod config;
    #[path = ${JSON.stringify(path.join(wasixSources, 'extensions.rs'))}] pub mod extensions;
    pub mod base { pub fn extension_archive(_: &[u8]) -> anyhow::Result<tar::Archive<Box<dyn std::io::Read + '_>>> { anyhow::bail!("legacy decoder is covered by SDK tests") } }
    pub mod aot { pub fn package_module_identities(_: &str) -> anyhow::Result<Vec<(String, String)>> { anyhow::bail!("legacy AOT parser is covered by SDK tests") } }
}
pub use oliphaunt::extensions::{Extension, ExtensionPackage};
pub fn inspect(extension: Extension) -> anyhow::Result<Vec<(String, String, String)>> {
    oliphaunt::extensions::resolve_extension_set(&[extension])?.into_iter().map(|extension| {
        let package = extension.package().expect("package binding");
        Ok((extension.sql_name().to_owned(), package.product().to_owned(), package.version().to_owned()))
    }).collect()
}
`,
    );
    writeFileSync(
      path.join(wasixStub, 'Cargo.toml'),
      readFileSync(path.join(wasixStub, 'Cargo.toml'), 'utf8').replace(
        '[workspace]',
        '[dependencies]\nanyhow = "1"\nsha2 = "0.10"\ntar = "0.4"\n[workspace]',
      ),
    );
    dependencyPaths['oliphaunt-wasix'] = wasixStub;
    const contribProduct = 'oliphaunt-extension-contrib-pg18';
    const contribVersion = extensionMetadata('oliphaunt-extension-postgis').compatibility
      .wasixRuntimeVersion;
    for (const [name, target] of [
      [wasixExtensionPackageName(contribProduct), 'portable'],
      ...expectedExtensionAotTargets().map((target) => [
        wasixExtensionAotPackageName(contribProduct, target),
        target,
      ]),
    ]) {
      const directory = path.join(leaves, name);
      mkdirSync(path.join(directory, 'src'), { recursive: true });
      writeFileSync(
        path.join(directory, 'Cargo.toml'),
        `[package]\nname = ${JSON.stringify(name)}\nversion = ${JSON.stringify(contribVersion)}\nedition = "2024"\n[workspace]\n`,
      );
      writeFileSync(
        path.join(directory, 'src/lib.rs'),
        target === 'portable'
          ? 'pub const ARCHIVES: &[(&str, &[u8], &str)] = &[("fuzzystrmatch", b"inert fixture", "fixture")];\n'
          : 'pub const FUZZYSTRMATCH_MANIFEST: &str = ""; pub const ARTIFACTS: &[(&str, &[u8])] = &[];\n',
      );
      dependencyPaths[name] = directory;
    }
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
          ? ['cube', 'fuzzystrmatch', 'hstore', 'pg_trgm'].map((extension) => ({
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
                    relative: `share/postgresql/extension/${product.endsWith('-postgis') ? 'postgis' : 'vector'}.control`,
                    contents: 'singleton fixture',
                  },
                ],
              },
            ];
        const header = bundled
          ? `schema = "oliphaunt-artifact-manifest-v2"\nproduct = ${JSON.stringify(product)}\nversion = ${JSON.stringify(productVersion)}\nkind = "extension"\ntarget = ${JSON.stringify(target)}\nruntime-product = "liboliphaunt-native"\nruntime-version = ${JSON.stringify(nativeRuntimeVersion)}`
          : `schema = "oliphaunt-artifact-manifest-v1"\nproduct = ${JSON.stringify(product)}\nversion = ${JSON.stringify(productVersion)}\nkind = "extension"\ntarget = ${JSON.stringify(target)}\nruntime-product = "liboliphaunt-native"\nruntime-version = ${JSON.stringify(nativeRuntimeVersion)}\nextension = ${JSON.stringify(product.endsWith('-postgis') ? 'postgis' : 'vector')}\ndependencies = ${JSON.stringify(product.endsWith('-postgis') ? ['fuzzystrmatch'] : [])}`;
        dependencyPaths[name] = fakeCarrier(leaves, {
          name,
          version: productVersion,
          header,
          members,
        });
        if (target === 'portable')
          writeFileSync(
            path.join(dependencyPaths[name], 'src/lib.rs'),
            `pub const ARCHIVES: &[(&str, &[u8], &str)] = &[(${JSON.stringify(product.endsWith('-postgis') ? 'postgis' : 'vector')}, b"inert fixture", "fixture")];\n`,
          );
        else if (
          !targets.nativeCargoTargets.some(
            (nativeTarget) => targetTriples[nativeTarget] === target,
          ) ||
          name.includes('-aot-')
        )
          writeFileSync(
            path.join(dependencyPaths[name], 'src/lib.rs'),
            `pub const ${product.endsWith('-postgis') ? 'POSTGIS' : 'VECTOR'}_MANIFEST: &str = ""; pub const ARTIFACTS: &[(&str, &[u8])] = &[];\n`,
          );
      }
      const source = writeFacadeSource(product, generated, {
        dependencyPaths,
        metadata: facadeMetadata(product),
      });
      dependencyPaths[product] = source.sourceDir;
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
    writeFileSync(
      path.join(app, 'src/main.rs'),
      `#![forbid(unsafe_code)]
fn main() {
    let postgis = postgis::native::POSTGIS;
    let own = postgis.package().expect("PostGIS package binding");
    assert!(own.resources.iter().all(|(path, _, _, _)| path.starts_with("extension/oliphaunt-extension-postgis/")));
    assert!(own.resources.iter().any(|(path, _, _, _)| path.ends_with("/postgis.control")));
    let resolved = liboliphaunt_native_bindings::extension::resolve_extensions(&[postgis]).expect("automatic native dependency closure");
    assert_eq!(resolved.iter().map(|extension| extension.sql_name()).collect::<Vec<_>>(), ["fuzzystrmatch", "postgis"]);
    let dependency = resolved[0].package().expect("actual contrib package binding");
    assert_eq!(dependency.product, "oliphaunt-extension-contrib-pg18");
    assert!(dependency.resources.iter().any(|(path, _, _, _)| path.ends_with("/fuzzystrmatch.control")));
}\n`,
    );
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
extensions = ["cube", "pg_trgm", "postgis", "vector"]

[dependencies]
vector = { package = "oliphaunt-extension-vector", path = ${JSON.stringify(path.join(generated, 'sources/oliphaunt-extension-vector'))} }
postgis = { package = "oliphaunt-extension-postgis", path = ${JSON.stringify(path.join(generated, 'sources/oliphaunt-extension-postgis'))} }
liboliphaunt-native-bindings = { path = ${JSON.stringify(dependencyPaths['liboliphaunt-native-bindings'])} }
fixture-native-runtime = { path = ${JSON.stringify(runtime)} }
fixture-native-tools = { path = ${JSON.stringify(tools)} }
fixture-broker = { path = ${JSON.stringify(broker)} }

[build-dependencies]
oliphaunt-build = { path = ${JSON.stringify(helper)} }

[workspace]
`,
    );
    const wasixApp = path.join(root, 'wasix-app');
    mkdirSync(path.join(wasixApp, 'src'), { recursive: true });
    writeFileSync(
      path.join(wasixApp, 'Cargo.toml'),
      `[package]\nname = "wasix-facade-fixture"\nversion = "0.0.0"\nedition = "2024"\n[dependencies]\npostgis = { package = "oliphaunt-extension-postgis", path = ${JSON.stringify(dependencyPaths['oliphaunt-extension-postgis'])}, default-features = false, features = ["wasix"] }\noliphaunt-wasix = { path = ${JSON.stringify(wasixStub)} }\n[workspace]\n`,
    );
    writeFileSync(
      path.join(wasixApp, 'src/main.rs'),
      `fn main() {
    let resolved = oliphaunt_wasix::inspect(postgis::wasix::POSTGIS).expect("captured WASIX closure");
    assert_eq!(resolved, vec![("fuzzystrmatch".to_owned(), "oliphaunt-extension-contrib-pg18".to_owned(), ${JSON.stringify(contribVersion)}.to_owned()), ("postgis".to_owned(), "oliphaunt-extension-postgis".to_owned(), ${JSON.stringify(extensionReleaseVersion('oliphaunt-extension-postgis', 'native'))}.to_owned())]);
}\n`,
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
    expect(text).toContain('extension = "postgis"');
    expect(text).toContain('extension = "fuzzystrmatch"');
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
  test('packages supplied metadata without consulting the product graph', () => {
    const output = mkdtempSync(path.join(tmpdir(), 'declared-extension-facade-test-'));
    directories.push(output);
    const product = 'oliphaunt-extension-declared-fixture';
    const metadata = {
      nativeOwner: product,
      wasixOwner: product,
      version: '9.1.0',
      sqlNames: ['fixture'],
      targets: {
        nativeCargoTargets: ['linux-arm64-gnu', 'linux-x64-gnu', 'macos-arm64', 'windows-x64-msvc'],
        includeWasixAot: true,
      },
      compatibility: { nativeRuntimeVersion: '7.1.0', wasixRuntimeVersion: '7.2.0' },
      memberContracts: [
        {
          sqlName: 'fixture',
          dependencies: [],
          wasixInstall: installFixture('fixture', { compiled: true }),
        },
      ],
    };
    const [pkg] = packageExtensionCargoFacades([product], output, {
      metadataByProduct: { [product]: metadata },
    });
    const manifest = Bun.TOML.parse(readFileSync(pkg.manifestPath, 'utf8'));
    expect(pkg.version).toBe(metadata.version);
    expect(Object.keys(manifest.target)).toHaveLength(4);
    expect(manifest.dependencies['liboliphaunt-native-bindings'].version).toBe('^0.2.1');
    expect(manifest['build-dependencies']['oliphaunt-build'].version).toBe('^0.3.3');
    expect(manifest.dependencies['oliphaunt-wasix'].version).toBe('^0.3.3');
    expect(manifest.features.wasix).toContain(`dep:${product}-wasix`);
    expect(manifest.features.wasix).toHaveLength(6);
    const source = readFileSync(path.join(path.dirname(pkg.manifestPath), 'src/lib.rs'), 'utf8');
    expect(source).toContain('runtime_version: "7.1.0"');
    expect(source).toContain('PRODUCT, VERSION, "7.2.0"');

    // Neither SQL name nor artifact product exists in the checkout's graph.
    // A declared writer must use this stable projection and captured install.
    metadata.ownerMetadata = {
      fixture_dependency: {
        product: 'oliphaunt-extension-declared-foreign',
        versioning: 'runtime-bound',
        native: 'liboliphaunt-native',
        wasix: 'liboliphaunt-wasix',
      },
    };
    metadata.memberContracts[0].dependencies = ['fixture_dependency'];
    metadata.memberContracts[0].wasixInstall.dependencies = ['fixture_dependency'];
    metadata.wasixDependencies = [
      {
        product: 'oliphaunt-extension-declared-foreign',
        version: '7.2.0',
        members: [
          { sqlName: 'fixture_dependency', wasixInstall: installFixture('fixture_dependency') },
        ],
      },
    ];
    const declared = writeFacadeSource(product, output, { metadata });
    const declaredManifest = Bun.TOML.parse(
      readFileSync(path.join(declared.sourceDir, 'Cargo.toml'), 'utf8'),
    );
    expect(declaredManifest.dependencies['oliphaunt-extension-declared-foreign'].version).toBe(
      '=7.1.0',
    );
    expect(
      declaredManifest.dependencies['oliphaunt-extension-declared-foreign-wasix'].version,
    ).toBe('=7.2.0');

    metadata.targets.includeWasixAot = false;
    expect(() => writeFacadeSource(product, output, { metadata })).toThrow(
      'declared WASIX AOT targets differ from its frozen native modules',
    );
    metadata.targets.includeWasixAot = true;
    metadata.wasixOwner = 'liboliphaunt-wasix';
    metadata.wasixDependencies = [];
    const native = writeFacadeSource(product, output, { metadata });
    const nativeManifest = Bun.TOML.parse(
      readFileSync(path.join(native.sourceDir, 'Cargo.toml'), 'utf8'),
    );
    expect(nativeManifest.features.wasix).toBeUndefined();
    expect(nativeManifest.dependencies['oliphaunt-wasix']).toBeUndefined();
    metadata.targets.nativeCargoTargets = ['ios-xcframework'];
    expect(() => writeFacadeSource(product, output, { metadata })).toThrow(
      'unsupported native Cargo target',
    );
  });

  test('supplied metadata cannot silently fall back to missing product facts', () => {
    const output = mkdtempSync(path.join(tmpdir(), 'declared-extension-facade-missing-test-'));
    directories.push(output);
    expect(() =>
      packageExtensionCargoFacades(['oliphaunt-extension-pgtap'], output, {
        metadataByProduct: {},
      }),
    ).toThrow('exactly match the selected products');
    expect(() =>
      packageExtensionCargoFacades(['oliphaunt-extension-pgtap'], output, {
        metadataByProduct: { 'oliphaunt-extension-pgtap': undefined },
      }),
    ).toThrow('exactly match the selected products');
  });

  test('packages explicit native and WASIX feature selections', () => {
    const output = mkdtempSync(path.join(tmpdir(), 'extension-facade-test-'));
    directories.push(output);
    const product = 'oliphaunt-extension-pgtap';
    const [pkg] = packageExtensionCargoFacades([product], output, {
      metadataByProduct: { [product]: facadeMetadata(product) },
    });
    const manifest = Bun.TOML.parse(readFileSync(pkg.manifestPath, 'utf8'));
    expect(manifest.features.default).toEqual(['native']);
    expect(manifest.features.wasix).toEqual([
      'dep:oliphaunt-wasix',
      'dep:oliphaunt-extension-pgtap-wasix',
    ]);
    expect(pkg.cratePath.endsWith('.crate')).toBe(true);
    expect(manifest.dependencies['oliphaunt-wasix'].version).toBe(
      api.dependencies['oliphaunt-wasix'],
    );
    expect(manifest.dependencies['liboliphaunt-native-bindings'].version).toBe(
      api.dependencies['liboliphaunt-native-bindings'],
    );
    expect(manifest['build-dependencies']['oliphaunt-build'].version).toBe(
      api['build-dependencies']['oliphaunt-build'],
    );
    expect(manifest.dependencies['oliphaunt-extension-pgtap-wasix'].version).toBe(
      `=${pkg.version}`,
    );
  });

  test('the native-owned contrib facade has no WASIX carrier dependency', () => {
    const output = mkdtempSync(path.join(tmpdir(), 'extension-facade-bundle-test-'));
    directories.push(output);
    const product = 'oliphaunt-extension-contrib-pg18';
    const [pkg] = packageExtensionCargoFacades([product], output, {
      metadataByProduct: { [product]: facadeMetadata(product) },
    });
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
    expect(Object.keys(manifest.dependencies ?? {})).toEqual(['liboliphaunt-native-bindings']);
  });

  test('captured native and WASIX hosts acquire and bind their actual foreign descriptors', () => {
    const output = mkdtempSync(path.join(tmpdir(), 'frozen-postgis-facade-'));
    directories.push(output);
    const product = 'oliphaunt-extension-postgis';
    const metadata = facadeMetadata(product);
    metadata.ownerMetadata = {
      fuzzystrmatch: {
        product: 'oliphaunt-extension-contrib-pg18',
        versioning: 'runtime-bound',
        native: 'liboliphaunt-native',
        wasix: 'liboliphaunt-wasix',
      },
    };
    metadata.compatibility = {
      ...metadata.compatibility,
      nativeRuntimeVersion: '6.1.0',
      wasixRuntimeVersion: '6.2.0',
    };
    metadata.wasixDependencies[0].version = '6.2.0';
    const source = writeFacadeSource(product, output, { metadata });
    const cargo = Bun.TOML.parse(readFileSync(path.join(source.sourceDir, 'Cargo.toml'), 'utf8'));
    expect(cargo.features.default).toEqual(['native']);
    expect(cargo.dependencies['oliphaunt-extension-contrib-pg18']).toMatchObject({
      version: '=6.1.0',
      optional: true,
      'default-features': false,
      features: ['native'],
    });
    expect(cargo.dependencies['oliphaunt-extension-contrib-pg18-wasix'].version).toBe('=6.2.0');
    expect(cargo.features.native).toContain('dep:oliphaunt-extension-contrib-pg18');
    expect(cargo.features.wasix).not.toContain('dep:oliphaunt-extension-contrib-pg18');
    for (const table of Object.values(cargo.target) as any[]) {
      const foreign = Object.entries(table.dependencies).filter(([name]) =>
        name.startsWith('oliphaunt-extension-contrib-pg18-aot-'),
      );
      expect(foreign).toHaveLength(1);
      expect(foreign[0][1]).toMatchObject({ version: '=6.2.0', optional: true });
    }
    const rust = readFileSync(path.join(source.sourceDir, 'src/lib.rs'), 'utf8');
    expect(rust).toContain(
      '.with_dependencies(&[oliphaunt_extension_contrib_pg18::native::FUZZYSTRMATCH])',
    );
    expect(rust).toContain('"oliphaunt-extension-contrib-pg18", "6.2.0", "6.2.0"');
    expect(rust).toContain('DEPENDENCY_FUZZYSTRMATCH.as_dependency("fuzzystrmatch")');
    expect(rust).toContain('.with_install(&["fuzzystrmatch"]');
    expect(rust).not.toContain('HSTORE');
    expect(rust).not.toContain('postgis_raster');
    const ownerMetadata = metadata.ownerMetadata;
    metadata.ownerMetadata = {};
    expect(() => writeFacadeSource(product, output, { metadata })).toThrow(
      'has no declared release owner',
    );
    metadata.ownerMetadata = ownerMetadata;
    metadata.wasixDependencies = [];
    expect(() => writeFacadeSource(product, output, { metadata })).toThrow(
      'exact captured WASIX dependency owner documents',
    );
    metadata.wasixDependencies = facadeMetadata(product).wasixDependencies;
    metadata.wasixDependencies[0].version = '6.2.0';
    metadata.wasixDependencies[0].members[0].wasixInstall = undefined;
    expect(() => writeFacadeSource(product, output, { metadata })).toThrow(
      'frozen WASIX dependency install',
    );
  });

  test('frozen facade requirements keep builtins local and reject an unpinned independent owner', () => {
    const output = mkdtempSync(path.join(tmpdir(), 'frozen-facade-requirements-'));
    directories.push(output);
    const product = 'oliphaunt-extension-pgtap';
    const metadata = facadeMetadata(product);
    metadata.memberContracts[0].dependencies = ['plpgsql'];
    metadata.memberContracts[0].wasixInstall.dependencies = ['plpgsql'];
    const source = writeFacadeSource(product, output, { metadata });
    expect(readFileSync(path.join(source.sourceDir, 'Cargo.toml'), 'utf8')).not.toContain(
      'contrib',
    );
    metadata.memberContracts[0].dependencies = ['vector'];
    expect(() => writeFacadeSource(product, output, { metadata })).toThrow(
      'explicit frozen version for independent release owner',
    );
  });
});
