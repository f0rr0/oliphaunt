import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { nativeCargoArtifactRows } from '../packaging/rust-native-targets.mts';
import { nativeHelperArtifactRows } from './release-artifact-targets.mts';
import {
  loadReleaseMetadata,
  renderReleaseMetadata,
  repositoryPath,
} from './bazel-release-metadata.mts';

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
