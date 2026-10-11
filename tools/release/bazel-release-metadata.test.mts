import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateExtensionTargetProfiles } from '../../src/extensions/contracts/extension-target-profiles.mts';
import {
  resolveNativeComponentClosure,
  validateNativeComponentContract,
} from '../../src/extensions/tools/native-component-contract.mts';
import { nativeCargoArtifactRows } from '../packaging/rust-native-targets.mts';
import {
  extensionGithubArtifactInputs,
  loadReleaseMetadata,
  nativeMobileComponentInputs,
  nativeMobileMemberAliasInputs,
  renderReleaseMetadata,
  repositoryPath,
} from './bazel-release-metadata.mts';
import {
  databaseResourceArtifactRows,
  nativeHelperArtifactRows,
  nativeRuntimeArtifactRows,
  validateExtensionCatalogRows,
  wasixArtifactRows,
} from './release-artifact-targets.mts';

function fixture(run: (root: string, write: (name: string, content: string) => void) => void) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'oliphaunt-domain-metadata-'));
  const write = (name: string, content: string) => {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    writeFileSync(path.join(root, name), content);
  };
  write(
    'release-please-config.json',
    JSON.stringify({
      packages: {
        'src/native/runtime': { component: 'native' },
        'src/wasix/runtime': { component: 'wasix' },
        'src/extensions/external/example': { component: 'oliphaunt-extension-example' },
      },
    }),
  );
  write(
    '.release-please-manifest.json',
    JSON.stringify({
      'src/native/runtime': '1.2.3',
      'src/wasix/runtime': '2.3.4',
      'src/extensions/external/example': '3.4.5',
    }),
  );
  write(
    'src/native/runtime/release.toml',
    'id="native"\n[artifact_targets]\npreset="liboliphaunt-native"\ntargets=["linux-x64-gnu","android-arm64-v8a"]\n',
  );
  write(
    'src/wasix/runtime/release.toml',
    'id="wasix"\n[artifact_targets]\npreset="liboliphaunt-wasix"\ntargets=["portable"]\n',
  );
  write(
    'src/extensions/external/example/release.toml',
    'id="oliphaunt-extension-example"\nregistry_packages=["crates:example","npm:@oliphaunt/example"]\npublish_targets=["crates-io","npm"]\n[extension]\nclass="external"\nversioning="upstream-bound"\nsql_name="example"\n[extension.compatibility]\npostgres_major="18"\nextension_runtime_contract="src/extensions/contracts/contract.toml"\nnative_runtime_product="native"\nnative_runtime_version="1.0.0"\nwasix_runtime_product="wasix"\nwasix_runtime_version="2.0.0"\n[extension.source]\npath="src/extensions/external/example/source.toml"\n[compatibility_versions.native_runtime]\nsource_product="native"\npath="src/extensions/external/example/native-version"\nparser="raw"\n',
  );
  write('src/extensions/external/example/native-version', '1.0.0\n');
  write(
    'src/extensions/external/example/source.toml',
    `name="example"\nurl="https://example.invalid/example.git"\nbranch="0.8.2"\ncommit="${'a'.repeat(40)}"\nversion="0.8.2"\n`,
  );
  write(
    'src/extensions/contrib/carriers.toml',
    'logical_product="oliphaunt-extension-contrib-pg18"\nnative_owner="native"\nwasix_owner="wasix"\nmember_manifest="src/extensions/contrib/postgres18.toml"\nsource="src/third-party/postgres/source.toml"\ncontract="src/extensions/contracts/contract.toml"\n',
  );
  write(
    'src/extensions/contrib/postgres18.toml',
    '[[extensions]]\nid="member"\n"sql-name"="member"\npath="src/extensions/contrib/member"\n',
  );
  write(
    'src/third-party/postgres/source.toml',
    `[postgresql]\nversion="18.4"\nurl="https://example.invalid/postgres.tar.gz"\nsha256="${'a'.repeat(64)}"\n`,
  );
  write('src/extensions/contracts/contract.toml', 'postgres_major="18"\n');
  write(
    'src/extensions/catalog/native-components.toml',
    'schema="oliphaunt-native-components-v1"\nrequirements=[]\n[[components]]\nid="fixture"\nsource="fixture"\ndepends-on=[]\nruntime-files=[]\n[[components.link-units]]\nid="fixture"\narchive-candidates=["fixture/libfixture.a"]\n',
  );
  write(
    'src/extensions/contracts/extension-target-profiles.toml',
    `schema="oliphaunt-extension-artifact-target-profiles-v1"
[[profiles]]
id="fixture"
[[profiles.targets]]
target="linux-x64-gnu"
family="native"
kind="native-dynamic"
[[profiles.targets]]
target="android-arm64-v8a"
family="native"
kind="native-static-registry"
[[profiles.targets]]
target="wasix-portable"
family="wasix"
kind="wasix-runtime"
`,
  );
  write(
    'src/extensions/catalog/extensions.source.json',
    JSON.stringify({ extensions: [{ id: 'member' }, { id: 'example' }] }),
  );
  write(
    'src/extensions/generated/extensions.catalog.json',
    JSON.stringify({
      'format-version': 1,
      extensions: [
        { 'sql-name': 'member', 'native-module-file': 'member.so' },
        { 'sql-name': 'example' },
      ],
    }),
  );
  try {
    run(root, write);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('native component projection preserves the parsed canonical source and watches its bytes', () => {
  const file = 'src/extensions/catalog/native-components.toml';
  fixture((root) => {
    const text = readFileSync(path.join(root, file), 'utf8');
    const metadata = loadReleaseMetadata(root);
    expect(metadata.nativeComponents).toEqual(Bun.TOML.parse(text));
    expect(metadata.inputs[file]).toBe(text);
    expect(renderReleaseMetadata(metadata, '@test//build_defs/release:identity.bzl').bzl).toContain(
      'NATIVE_COMPONENTS =',
    );
  });
});

test('all canonical 39 mobile members use the existing component resolver for all three targets', () => {
  const root = path.resolve(import.meta.dirname, '../..');
  const raw = Bun.TOML.parse(
    readFileSync(path.join(root, 'src/extensions/catalog/native-components.toml'), 'utf8'),
  );
  const catalog = JSON.parse(
    readFileSync(path.join(root, 'src/extensions/generated/extensions.catalog.json'), 'utf8'),
  );
  const sqlNames = catalog.extensions.map((row) => row['sql-name']);
  const profiles = validateExtensionTargetProfiles(
    Bun.TOML.parse(
      readFileSync(
        path.join(root, 'src/extensions/contracts/extension-target-profiles.toml'),
        'utf8',
      ),
    ),
  ).targets;
  const projected = nativeMobileComponentInputs(raw, sqlNames, profiles);
  const descriptors = validateExtensionCatalogRows(catalog);
  const aliases = nativeMobileMemberAliasInputs(descriptors);
  expect(Object.keys(aliases)).toHaveLength(39);
  const contract = validateNativeComponentContract(raw, {
    checkSourcePaths: false,
    knownExtensions: new Set(sqlNames),
    targetProfiles: new Map(profiles.map((row) => [row.target, `${row.family}\0${row.kind}`])),
  });
  expect(Object.keys(projected)).toHaveLength(39);
  for (const sqlName of sqlNames) {
    expect(Object.keys(projected[sqlName])).toHaveLength(3);
    for (const target of Object.keys(projected[sqlName])) {
      expect(aliases[sqlName], `${sqlName}/${target}`).toEqual(
        sqlName === 'postgis'
          ? {
              difference: 'oliphaunt_static_postgis_3_difference',
              pg_finfo_difference: 'pg_finfo_oliphaunt_static_postgis_3_difference',
            }
          : {},
      );
    }
    const assets = extensionGithubArtifactInputs(
      { artifactProduct: 'fixture', owner: 'native', version: '1.2.3', sqlNames: [sqlName] },
      profiles,
      descriptors,
      projected,
    );
    for (const [target, actual] of Object.entries(projected[sqlName])) {
      const expected = resolveNativeComponentClosure(contract, {
        extension: sqlName,
        family: 'native',
        kind: 'native-static-registry',
        target,
      });
      expect(actual).toEqual({
        linkUnits: expected.linkUnits,
        runtimeFiles: expected.runtimeFiles,
      });
      const targetAssets = assets.filter((row) => row.target === target);
      expect(targetAssets.filter((row) => row.kind === 'runtime')).toHaveLength(1);
      const module = descriptors.get(sqlName)?.['native-module-file'];
      expect(targetAssets.filter((row) => row.kind === 'ios-xcframework')).toHaveLength(
        target === 'ios-xcframework' && typeof module === 'string' ? 1 : 0,
      );
      expect(
        targetAssets
          .filter((row) => row.kind === 'ios-dependency-xcframework')
          .map((row) => row.identity),
      ).toEqual(
        target === 'ios-xcframework' && module !== undefined ? [...expected.linkUnits].sort() : [],
      );
    }
  }
});

test('canonical extension GitHub projection uses only supplied root metadata and owner versions', () => {
  fixture((root, write) => {
    const profiles = 'src/extensions/contracts/extension-target-profiles.toml';
    write(
      'src/native/runtime/release.toml',
      'id="native"\n[artifact_targets]\npreset="liboliphaunt-native"\ntargets=["linux-x64-gnu","android-arm64-v8a","android-x86_64","ios-xcframework"]\n',
    );
    write(
      profiles,
      `${readFileSync(path.join(root, profiles), 'utf8')}
[[profiles.targets]]
target="android-x86_64"
family="native"
kind="native-static-registry"
[[profiles.targets]]
target="ios-xcframework"
family="native"
kind="native-static-registry"
`,
    );
    const components = 'src/extensions/catalog/native-components.toml';
    write(
      components,
      `${readFileSync(path.join(root, components), 'utf8').replace('requirements=[]\n', '')}
[[requirements]]
extension="example"
family="native"
kind="native-static-registry"
targets=["ios-xcframework"]
roots=["fixture"]
`,
    );
    write(
      'src/extensions/generated/extensions.catalog.json',
      JSON.stringify({
        'format-version': 1,
        extensions: [
          { 'sql-name': 'member', 'native-module-file': 'member.so' },
          { 'sql-name': 'example', 'native-module-file': 'different-stem.so' },
        ],
      }),
    );
    const metadata = loadReleaseMetadata(root);
    const external = metadata.extensionGithubArtifacts.filter(
      (row) => row.artifactProduct === 'oliphaunt-extension-example',
    );
    expect(external.map((row) => row.name)).toEqual([
      'oliphaunt-extension-example-3.4.5-native-android-arm64-v8a-runtime.tar.gz',
      'oliphaunt-extension-example-3.4.5-native-android-x86_64-runtime.tar.gz',
      'oliphaunt-extension-example-3.4.5-native-ios-dependency-fixture-xcframework.zip',
      'oliphaunt-extension-example-3.4.5-native-ios-xcframework.zip',
      'oliphaunt-extension-example-3.4.5-native-ios-runtime.tar.gz',
      'oliphaunt-extension-example-3.4.5-native-linux-x64-gnu-runtime.tar.gz',
    ]);
    expect(external.every((row) => row.owner === 'oliphaunt-extension-example')).toBe(true);
    expect(external.find((row) => row.kind === 'ios-xcframework')?.identity).toBe('different-stem');
    const contrib = metadata.extensionGithubArtifacts.filter(
      (row) => row.artifactProduct === 'oliphaunt-extension-contrib-pg18',
    );
    expect(contrib.every((row) => row.owner === 'native' && row.version === '1.2.3')).toBe(true);
    expect(contrib.every((row) => row.name.includes('-1.2.3-'))).toBe(true);
    expect(renderReleaseMetadata(metadata, '@test//build_defs/release:identity.bzl').bzl).toContain(
      'EXTENSION_GITHUB_ARTIFACTS =',
    );
    expect(
      renderReleaseMetadata(metadata, '@test//build_defs/release:identity.bzl').extensionSourcesBzl,
    ).not.toContain('EXTENSION_GITHUB_ARTIFACTS');
    const descriptors = new Map([['example', { 'native-module-file': 'example.so' }]]);
    expect(() =>
      extensionGithubArtifactInputs(
        { artifactProduct: 'example', owner: 'example', version: '1.2.3', sqlNames: ['example'] },
        [{ target: 'ios-xcframework', family: 'native', kind: 'native-static-registry' }],
        descriptors,
        {},
      ),
    ).toThrow('missing example/ios-xcframework');
  });
});

test('native component acquisition projection watches canonical source bytes', () => {
  fixture((root, write) => {
    const component = 'src/extensions/catalog/native-components.toml';
    write(
      component,
      readFileSync(path.join(root, component), 'utf8').replaceAll('fixture', 'openssl'),
    );
    const sourcePath = 'src/third-party/openssl/source.toml';
    const text = `name="openssl"\nurl="https://example.invalid/openssl.git"\ncommit="${'d'.repeat(40)}"\n`;
    write(sourcePath, text);
    const metadata = loadReleaseMetadata(root);
    expect(metadata.nativeComponentSources).toEqual({ openssl: Bun.TOML.parse(text) });
    expect(metadata.inputs[sourcePath]).toBe(text);
    expect(renderReleaseMetadata(metadata, '@test//build_defs/release:identity.bzl').bzl).toContain(
      'NATIVE_COMPONENT_SOURCES =',
    );
  });
});

test('WASIX artifact projection follows explicit release targets without loading another source tree', () => {
  fixture((root, write) => {
    const config = JSON.parse(readFileSync(path.join(root, 'release-please-config.json'), 'utf8'));
    const manifest = JSON.parse(
      readFileSync(path.join(root, '.release-please-manifest.json'), 'utf8'),
    );
    config.packages['src/wasix/postgres-tools'] = { component: 'postgres-tools-wasix' };
    manifest['src/wasix/postgres-tools'] = '4.5.6';
    write('release-please-config.json', JSON.stringify(config));
    write('.release-please-manifest.json', JSON.stringify(manifest));
    write(
      'src/wasix/postgres-tools/release.toml',
      'id="postgres-tools-wasix"\n[artifact_targets]\npreset="postgres-tools-wasix"\ntargets=["portable","macos-arm64"]\n',
    );
    const metadata = loadReleaseMetadata(root);
    expect(metadata.wasixArtifacts).toEqual(
      wasixArtifactRows('postgres-tools-wasix', ['portable', 'macos-arm64']),
    );
    expect(
      metadata.wasixArtifacts
        .filter((row) => row.kind !== 'checksums')
        .map((row) => row.target)
        .sort(),
    ).toEqual(['macos-arm64', 'portable']);
    expect(renderReleaseMetadata(metadata, '@test//build_defs/release:identity.bzl').bzl).toContain(
      'WASIX_ARTIFACTS =',
    );
    write(
      'src/wasix/postgres-tools/release.toml',
      'id="postgres-tools-wasix"\n[artifact_targets]\npreset="postgres-tools-wasix"\ntargets=["android-x86_64"]\n',
    );
    const rejected = Bun.spawnSync([
      process.execPath,
      '--eval',
      `import { loadReleaseMetadata } from ${JSON.stringify(import.meta.filename.replace('.test.mts', '.mts'))}; loadReleaseMetadata(${JSON.stringify(root)});`,
    ]);
    expect(rejected.exitCode).toBe(1);
    expect(rejected.stderr.toString()).toContain('unknown artifact target(s): android-x86_64');
  });
});

test('native helper projection uses canonical artifact rows and explicit descriptor targets', () => {
  fixture((root, write) => {
    const config = JSON.parse(readFileSync(path.join(root, 'release-please-config.json'), 'utf8'));
    const manifest = JSON.parse(
      readFileSync(path.join(root, '.release-please-manifest.json'), 'utf8'),
    );
    config.packages['src/native/broker'] = { component: 'oliphaunt-broker' };
    manifest['src/native/broker'] = '4.5.6';
    write('release-please-config.json', JSON.stringify(config));
    write('.release-please-manifest.json', JSON.stringify(manifest));
    write(
      'src/native/broker/release.toml',
      'id="oliphaunt-broker"\nregistry_packages=["crates:oliphaunt-broker-linux-x64-gnu"]\n[artifact_targets]\npreset="oliphaunt-broker"\ntargets=["linux-x64-gnu"]\n',
    );
    const metadata = loadReleaseMetadata(root);
    expect(metadata.nativeHelperArtifacts).toEqual(
      nativeHelperArtifactRows('oliphaunt-broker', ['linux-x64-gnu']),
    );
    expect(
      metadata.nativeHelperArtifacts.find((row) => row.kind === 'broker-helper'),
    ).toMatchObject({
      target: 'linux-x64-gnu',
      executable_relative_path: 'bin/oliphaunt-broker',
    });
    const rendered = renderReleaseMetadata(metadata, '@//build_defs/release:identity.bzl');
    expect(rendered.bzl).toContain('NATIVE_HELPER_ARTIFACTS');
    expect(rendered.extensionSourcesBzl).not.toContain('NATIVE_HELPER_ARTIFACTS');
    const apple = renderReleaseMetadata(
      {
        ...metadata,
        nativeHelperArtifacts: nativeHelperArtifactRows('oliphaunt-broker', ['macos-arm64']),
      },
      '@//build_defs/release:identity.bzl',
    );
    expect(apple.bzl).toContain('"npm_libc": None');
    expect(apple.bzl).not.toContain('undefined');
    write(
      'src/native/broker/release.toml',
      'id="oliphaunt-broker"\nregistry_packages=["crates:oliphaunt-broker-linux-x64-gnu"]\n',
    );
    expect(() => loadReleaseMetadata(root)).toThrow('has no canonical artifact targets');
  });
});

test('runtime and resource construction reuse canonical artifact rows and captured contracts', () => {
  fixture((root, write) => {
    const config = JSON.parse(readFileSync(path.join(root, 'release-please-config.json'), 'utf8'));
    const manifest = JSON.parse(
      readFileSync(path.join(root, '.release-please-manifest.json'), 'utf8'),
    );
    config.packages['src/native/postgres-tools'] = { component: 'postgres-tools-native' };
    config.packages['src/database-resources'] = { component: 'database-resources' };
    manifest['src/native/postgres-tools'] = '4.5.6';
    manifest['src/database-resources'] = '5.6.7';
    write('release-please-config.json', JSON.stringify(config));
    write('.release-please-manifest.json', JSON.stringify(manifest));
    write(
      'src/native/postgres-tools/release.toml',
      'id="postgres-tools-native"\nregistry_packages=["npm:@oliphaunt/tools-linux-x64-gnu"]\n[artifact_targets]\npreset="postgres-tools-native"\ntargets=["linux-x64-gnu"]\n',
    );
    write(
      'src/database-resources/release.toml',
      'id="database-resources"\nregistry_packages=["npm:@oliphaunt/icu"]\n',
    );
    const profiles: Record<string, Record<string, unknown>> = { standard: {} };
    const contract = {
      profiles,
      compatibilityKeys: { native: { 'linux-x64-gnu': 'fixture' } },
    };
    const contractPath = 'src/database-resources/contracts/contract.json';
    write(contractPath, JSON.stringify(contract));
    const metadata = loadReleaseMetadata(root);
    expect(metadata.nativeRuntimeArtifacts).toEqual(
      nativeRuntimeArtifactRows('postgres-tools-native', ['linux-x64-gnu']),
    );
    expect(metadata.databaseResourceContract).toEqual(contract);
    expect(metadata.inputs[contractPath]).toBe(JSON.stringify(contract));
    expect(metadata.databaseResourceArtifacts).toEqual(databaseResourceArtifactRows(contract));
    expect(metadata.databaseResourceArtifacts).toHaveLength(7);
    const rendered = renderReleaseMetadata(metadata, '@//build_defs/release:identity.bzl');
    expect(rendered.bzl).toContain('NATIVE_RUNTIME_ARTIFACTS');
    expect(rendered.bzl).toContain('DATABASE_RESOURCE_CONTRACT');
    expect(rendered.bzl).toContain('DATABASE_RESOURCE_ARTIFACTS');
    expect(rendered.extensionSourcesBzl).not.toContain('DATABASE_RESOURCE_ARTIFACTS');
    contract.profiles.icu = {};
    write(contractPath, JSON.stringify(contract));
    const changed = loadReleaseMetadata(root);
    expect(changed.databaseResourceArtifacts).toHaveLength(11);
    expect(
      renderReleaseMetadata(changed, '@//build_defs/release:identity.bzl').extensionSourcesBzl,
    ).toBe(rendered.extensionSourcesBzl);
    for (const [product, targets, diagnostic] of [
      ['postgres-tools-native', ['unsupported'], 'unknown artifact target'],
      ['native', ['linux-x64-gnu'], 'not a native runtime product'],
    ] as const) {
      const rejected = Bun.spawnSync([
        process.execPath,
        '--eval',
        `import { nativeRuntimeArtifactRows } from ${JSON.stringify(path.join(import.meta.dir, 'release-artifact-targets.mts'))}; nativeRuntimeArtifactRows(${JSON.stringify(product)}, ${JSON.stringify(targets)});`,
      ]);
      expect(rejected.exitCode).toBe(1);
      expect(rejected.stderr.toString()).toContain(diagnostic);
    }
  });
});

test('publication versions, upstream versions and contrib ownership stay independent', () => {
  fixture((root, write) => {
    const initial = loadReleaseMetadata(root);
    expect(initial.products['oliphaunt-extension-example'].version).toBe('3.4.5');
    expect(initial.extensionSources.example.version).toBe('0.8.2');
    expect(initial.contribOwners).toEqual({ native: 'native', wasix: 'wasix' });
    expect(initial.products.native.artifact_targets).toEqual({
      preset: 'liboliphaunt-native',
      targets: ['linux-x64-gnu', 'android-arm64-v8a'],
    });
    expect(initial.products.wasix.artifact_targets).toEqual({
      preset: 'liboliphaunt-wasix',
      targets: ['portable'],
    });
    expect(initial.products['oliphaunt-extension-example'].compatibility_versions).toEqual({
      native: '1.0.0',
    });
    expect(initial.inputs['src/extensions/external/example/native-version']).toBe('1.0.0\n');
    expect(initial.inputs['src/extensions/external/example/recipe.toml']).toBeNull();
    expect(initial.products['oliphaunt-extension-example'].registry_packages).toEqual([
      'crates:example',
      'npm:@oliphaunt/example',
    ]);
    expect(initial.products['oliphaunt-extension-example'].publish_targets).toEqual([
      'crates-io',
      'npm',
    ]);
    expect(initial.extensionCompatibility.example).toEqual({
      postgres_major: '18',
      extension_runtime_contract: 'src/extensions/contracts/contract.toml',
      native_runtime_product: 'native',
      native_runtime_version: '1.0.0',
      wasix_runtime_product: 'wasix',
      wasix_runtime_version: '2.0.0',
    });
    const external = initial.extensionReleaseMetadata.find((row) => row.sqlName === 'example');
    expect(external.compatibility).toMatchObject({
      nativeRuntimeVersion: '1.0.0',
      wasixRuntimeVersion: '2.0.0',
    });
    expect(external.sourceIdentity).toMatchObject({
      kind: 'external',
      branch: '0.8.2',
      commit: 'a'.repeat(40),
    });
    const member = initial.extensionReleaseMetadata.find((row) => row.sqlName === 'member');
    expect(member.compatibility).toMatchObject({
      nativeRuntimeVersion: '1.2.3',
      wasixRuntimeVersion: '2.3.4',
    });
    expect(member.memberPath).toBe('src/extensions/contrib');
    const rendered = renderReleaseMetadata(initial, '@//build_defs/release:identity.bzl');
    expect(rendered.bzl).toContain('EXTENSION_RELEASE_METADATA');
    expect(rendered.extensionSourcesBzl).not.toContain('EXTENSION_RELEASE_METADATA');
    write(
      'src/extensions/external/example/recipe.toml',
      'sql_name="example"\n[artifacts]\ndata_files=["data.txt"]\n',
    );
    expect(loadReleaseMetadata(root).extensionRecipes.example.artifacts).toEqual({
      data_files: ['data.txt'],
    });
    write('src/extensions/external/example/recipe.toml', 'sql_name="wrong"\n');
    expect(() => loadReleaseMetadata(root)).toThrow('recipe disagrees');
  });
});

test('dependency acquisition records exact pins and directory membership without publication policy', () => {
  fixture((root, write) => {
    const directory = 'src/extensions/external/example/dependencies';
    expect(loadReleaseMetadata(root).directories[directory]).toBeNull();
    const file = `${directory}/dependency/source.toml`;
    const source =
      'name="dependency"\nkind="archive"\nurl="https://example.invalid/dependency.tar.gz"\nsha256="' +
      'a'.repeat(64) +
      '"\nstrip_prefix="dependency-1.0"\nmirror_url="https://mirror.invalid/dependency.tar.gz"\n';
    write(file, source);
    const metadata = loadReleaseMetadata(root);
    expect(metadata.directories[directory]).toEqual(['dependency']);
    expect(metadata.inputs[file]).toBe(source);
    expect(metadata.extensionDependencies.example.dependency).toEqual(Bun.TOML.parse(source));
    const rendered = renderReleaseMetadata(metadata, '@//build_defs/release:identity.bzl');
    expect(rendered.extensionSourcesBzl).toContain('EXTENSION_DEPENDENCIES');
    expect(rendered.extensionSourcesBzl).toContain('mirror_url');
    const retargeted = structuredClone(metadata);
    retargeted.products['oliphaunt-extension-example'].version = '3.5.0';
    retargeted.products['oliphaunt-extension-example'].registry_packages.push(
      'npm:@oliphaunt/example-other',
    );
    retargeted.extensionCompatibility.example.native_runtime_version = '1.2.3';
    retargeted.products['oliphaunt-extension-example'].compatibility_versions.native = '1.2.3';
    expect(
      renderReleaseMetadata(retargeted, '@//build_defs/release:identity.bzl').extensionSourcesBzl,
    ).toBe(rendered.extensionSourcesBzl);
    retargeted.extensionDependencies.example.dependency.sha256 = 'b'.repeat(64);
    expect(
      renderReleaseMetadata(retargeted, '@//build_defs/release:identity.bzl').extensionSourcesBzl,
    ).not.toBe(rendered.extensionSourcesBzl);
    mkdirSync(path.join(root, directory, 'missing-pin'));
    expect(() => loadReleaseMetadata(root)).toThrow('source.toml');
  });
});

test('final carrier projection expands contrib through canonical ownership and declared targets', () => {
  fixture((root, write) => {
    const initial = loadReleaseMetadata(root);
    expect(initial.products.native.registry_packages).toEqual([]);
    const name = '@oliphaunt/extension-contrib-pg18-linux-x64-gnu';
    expect(initial.publicationCarriers.find((row) => row.name === name)).toEqual({
      product: 'native',
      ecosystem: 'npm',
      name,
      version: '1.2.3',
      target: 'linux-x64-gnu',
      role: 'platform-leaf',
    });
    expect(initial.inputs['src/extensions/generated/extensions.catalog.json']).toContain(
      'member.so',
    );
    expect(
      renderReleaseMetadata(initial, '@//build_defs/release:identity.bzl').extensionSourcesBzl,
    ).not.toContain('PUBLICATION_CARRIERS');
    write(
      '.release-please-manifest.json',
      JSON.stringify({
        'src/native/runtime': '1.2.4',
        'src/wasix/runtime': '2.3.4',
        'src/extensions/external/example': '3.4.5',
      }),
    );
    const bumped = loadReleaseMetadata(root);
    expect(bumped.publicationCarriers.find((row) => row.name === name)?.version).toBe('1.2.4');
    expect(
      bumped.publicationCarriers.find((row) => row.name === '@oliphaunt/example')?.version,
    ).toBe('3.4.5');
    const profiles = 'src/extensions/contracts/extension-target-profiles.toml';
    write(
      profiles,
      readFileSync(path.join(root, profiles), 'utf8').replace('linux-x64-gnu', 'macos-arm64'),
    );
    expect(() => loadReleaseMetadata(root)).toThrow('not backed by runtime artifact metadata');
  });
});

test('invalid or ambiguous metadata fails instead of producing partial identities', () => {
  fixture((root, write) => {
    const carrier = readFileSync(path.join(root, 'src/extensions/contrib/carriers.toml'), 'utf8');
    write(
      'src/extensions/contrib/carriers.toml',
      carrier.replace('native_owner="native"', 'native_owner="unknown"'),
    );
    expect(() => loadReleaseMetadata(root)).toThrow('unknown contrib release owner');
    write(
      'src/extensions/contrib/carriers.toml',
      carrier.replace('wasix_owner="wasix"', 'wasix_owner="native"'),
    );
    expect(() => loadReleaseMetadata(root)).toThrow('distinct release owners');
    write('src/extensions/contrib/carriers.toml', carrier);
    write(
      'src/extensions/contrib/postgres18.toml',
      '[[extensions]]\nid="member"\n[[extensions]]\nid="member"\n',
    );
    expect(() => loadReleaseMetadata(root)).toThrow('duplicate contrib member');
  });
  fixture((root, write) => {
    write('src/native/runtime/release.toml', 'id="different"\n');
    expect(() => loadReleaseMetadata(root)).toThrow('disagrees');
    write(
      'src/native/runtime/release.toml',
      'id="native"\n[artifact_targets]\npreset="liboliphaunt-native"\ntargets=["linux-x64-gnu","android-arm64-v8a"]\n',
    );
    write(
      '.release-please-manifest.json',
      JSON.stringify({
        'src/native/runtime': '01.2.3',
        'src/wasix/runtime': '2.3.4',
        'src/extensions/external/example': '3.4.5',
      }),
    );
    expect(() => loadReleaseMetadata(root)).toThrow('stable release version');
  });
});

test('native Cargo rows retain only declared supported Rust carriers', () => {
  const product = 'liboliphaunt-native';
  const targets = ['linux-x64-gnu', 'android-arm64-v8a', 'macos-arm64'];
  const packages = [
    'crates:liboliphaunt-native-linux-x64-gnu',
    'crates:liboliphaunt-native-macos-arm64',
    'npm:@oliphaunt/liboliphaunt-linux-x64-gnu',
  ];
  expect(nativeCargoArtifactRows(product, targets, packages)).toEqual([
    {
      sourceProduct: product,
      target: 'linux-x64-gnu',
      packageKind: 'crates',
      packageName: 'liboliphaunt-native-linux-x64-gnu',
    },
    {
      sourceProduct: product,
      target: 'macos-arm64',
      packageKind: 'crates',
      packageName: 'liboliphaunt-native-macos-arm64',
    },
  ]);
  expect(() => nativeCargoArtifactRows(product, targets, packages.slice(1))).toThrow(
    'missing declared Cargo artifact liboliphaunt-native-linux-x64-gnu',
  );
  expect(() =>
    nativeCargoArtifactRows(product, targets, [
      ...packages,
      'crates:liboliphaunt-native-android-arm64-v8a',
    ]),
  ).toThrow('unsupported native Cargo target');
});

test('authored compatibility mirrors must resolve to one installed requirement', () => {
  fixture((root, write) => {
    const descriptor = 'src/extensions/external/example/release.toml';
    const original = readFileSync(path.join(root, descriptor), 'utf8');
    write(
      descriptor,
      `${original}
[compatibility_versions.native_mirror]
source_product="native"
path="src/extensions/external/example/mirror-version"
parser="json:version"
`,
    );
    write('src/extensions/external/example/mirror-version', '{"version":"1.0.0"}');
    expect(
      loadReleaseMetadata(root).products['oliphaunt-extension-example'].compatibility_versions,
    ).toEqual({ native: '1.0.0' });
    write('src/extensions/external/example/mirror-version', '{"version":"1.1.0"}');
    expect(() => loadReleaseMetadata(root)).toThrow(
      'conflicting compatibility versions for native',
    );
    write(descriptor, original.replace('source_product="native"', 'source_product="missing"'));
    expect(() => loadReleaseMetadata(root)).toThrow('unknown compatibility product missing');
  });
});

test('metadata paths cannot escape; rendered identities have no construction dependencies', () => {
  for (const value of ['', '../elsewhere', '/absolute', 'a/../b', 'a//b', 'a\\b', 'a\0b']) {
    expect(() => repositoryPath(value)).toThrow('inside the repository');
  }
  fixture((root) => {
    const metadata = loadReleaseMetadata(root);
    const rendered = renderReleaseMetadata(metadata, '@//build_defs/release:identity.bzl');
    const reversed = {
      ...metadata,
      products: Object.fromEntries(Object.entries(metadata.products).reverse()),
    };
    expect(renderReleaseMetadata(reversed, '@//build_defs/release:identity.bzl')).toEqual(rendered);
    expect(rendered.build).not.toContain('deps');
    expect(rendered.bzl).toContain('CONTRIB_OWNERS');
    const bumped = structuredClone(metadata);
    bumped.products.native.version = '1.2.4';
    const next = renderReleaseMetadata(bumped, '@//build_defs/release:identity.bzl');
    expect(next.bzl).not.toBe(rendered.bzl);
    expect(next.extensionSourcesBzl).toBe(rendered.extensionSourcesBzl);
    bumped.extensionSources.example.product = 'other-owner';
    bumped.extensionSources.example.branch = 'other-branch';
    bumped.extensionSources.example['extension-control'] = { 'default-version': '0.8.3' };
    const ownershipChanged = renderReleaseMetadata(bumped, '@//build_defs/release:identity.bzl');
    expect(ownershipChanged.bzl).not.toBe(next.bzl);
    expect(ownershipChanged.extensionSourcesBzl).toBe(rendered.extensionSourcesBzl);
    bumped.extensionSources.example.commit = 'b'.repeat(40);
    expect(
      renderReleaseMetadata(bumped, '@//build_defs/release:identity.bzl').extensionSourcesBzl,
    ).not.toBe(rendered.extensionSourcesBzl);
    expect(() => renderReleaseMetadata(metadata, '//build_defs/release:identity.bzl')).toThrow(
      'repository-qualified',
    );
  });
});
