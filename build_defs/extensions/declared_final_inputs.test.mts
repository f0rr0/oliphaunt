/** Document/File transport fixtures; these never claim foreign package or runtime qualification. */
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  composeExtensionReleaseDocuments,
  writeReleaseControls,
} from '../../src/extensions/artifacts/packages/tools/build-extension-ci-artifacts.mts';
import { archiveDirectory } from '../../tools/packaging/archive-directory.mts';
import { releaseNoticeDeclaration } from '../../tools/packaging/release-notices.mts';
import type { ExtensionFinalInput } from '../../tools/release/native-extension-final-inputs.mts';
import { fileIdentity } from '../../tools/release/native-file-identity.mts';
import {
  declaredNativeAppleBaseManifest,
  validateDeclaredExtensionFinalInput,
  validateDeclaredNativeAppleBase,
} from './declared_final_inputs.mts';
import {
  mergeNativeFinalMembers,
  type NativeOwnerSpec,
  ownerFamilyCompleteness,
  stageDeclaredFinalLeaf,
} from './owner_carriers.mts';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
const product = 'oliphaunt-extension-pgtap';
const compatibility = {
  nativeRuntimeProduct: 'liboliphaunt-native',
  nativeRuntimeVersion: '1.2.3',
  wasixRuntimeProduct: 'liboliphaunt-wasix',
  wasixRuntimeVersion: '4.5.6',
};
const sourceIdentity = { type: 'git', commit: 'a'.repeat(40) };

test('original Apple base stays selection-neutral and pins the actual conventional runtime', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'declared-original-apple-base-'));
  directories.push(directory);
  const source = path.join(directory, 'ios.json');
  writeFileSync(
    source,
    readFileSync(path.resolve(import.meta.dir, '../release/testdata/swift-0.8.2-carrier.json')),
  );
  const identity = fileIdentity(source);
  const input = {
    owner: 'liboliphaunt-native' as const,
    version: '0.3.3',
    file: {
      path: source,
      size: identity.size,
      sha256: identity.sha256,
      producer: {
        evidenceDigest: `sha256:${'1'.repeat(64)}`,
        invocationId: 'document-fixture',
        root: '//src/native/runtime:apple_ios_manifest_shipping',
        configuration: '2'.repeat(64),
        output: 'bazel-out/config/bin/apple_release_assets/ios.json',
      },
    },
  };
  expect(validateDeclaredNativeAppleBase(input, '0.3.3')).toBe(input);
  expect(() => validateDeclaredNativeAppleBase(input, '0.3.4')).toThrow();
  expect(() =>
    validateDeclaredNativeAppleBase(
      { ...input, file: { ...input.file, sha256: '0'.repeat(64) } },
      '0.3.3',
    ),
  ).toThrow();
  const changed = JSON.parse(readFileSync(source, 'utf8'));
  changed.extensions.push({ sqlName: 'invented' });
  writeFileSync(source, JSON.stringify(changed));
  const changedIdentity = fileIdentity(source);
  expect(() =>
    validateDeclaredNativeAppleBase(
      {
        ...input,
        file: { ...input.file, size: changedIdentity.size, sha256: changedIdentity.sha256 },
      },
      '0.3.3',
    ),
  ).toThrow(/selection-neutral/);
});
const canonical = {
  owner: product,
  version: '7.8.9',
  sqlNames: ['pgtap'],
  sourceIdentity,
  compatibility,
  extensionClass: 'external',
  versioning: 'upstream-bound',
  targets: ['linux-x64-gnu', 'ios-xcframework', 'wasix-portable'],
};
function fixture(family: 'native' | 'wasix' = 'native') {
  const root = mkdtempSync(path.join(tmpdir(), 'declared-extension-contract-'));
  directories.push(root);
  const target = family === 'native' ? 'linux-x64-gnu' : 'wasix-portable';
  const file = (name: string, contents: string) => {
    const destination = path.join(root, name);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, contents);
    const identity = fileIdentity(destination);
    return {
      path: destination,
      size: identity.size,
      sha256: identity.sha256,
      producer: {
        evidenceDigest: `sha256:${'1'.repeat(64)}`,
        invocationId: 'document-fixture',
        root: '//fixture:shipping',
        configuration: '2'.repeat(64),
        output: `bazel-out/config/bin/fixture/${name}`,
      },
    };
  };
  const github = file(
    `${product}-7.8.9-${family === 'native' ? 'native-linux-x64-gnu-runtime.tar.gz' : 'wasix-portable.tar.zst'}`,
    'metadata fixture; no binary qualification',
  );
  const member = {
    sqlName: 'pgtap',
    dependencies: [],
    dataFiles: [],
    extensionSqlFileNames: [],
    extensionSqlFilePrefixes: [],
    createsExtension: true,
    nativeModuleStem: null,
    iosNativeDependencies: [],
    iosRegistration: null,
    wasixInstall:
      family === 'wasix'
        ? { schema: 'installed-contract-fixture', installedFiles: ['pgtap.control'] }
        : null,
    sharedPreloadLibraries: [],
    assets: [
      {
        name: path.basename(github.path),
        family,
        target,
        kind: family === 'native' ? 'runtime' : 'wasix-runtime',
        identity: null,
        bytes: github.size,
        sha256: github.sha256,
      },
    ],
  };
  const documents = composeExtensionReleaseDocuments({
    product,
    releaseProduct: product,
    family: family === 'native' ? 'native' : null,
    version: '7.8.9',
    members: [member],
    directAssets: member.assets,
    releaseMetadata: {
      class: 'external',
      versioning: 'upstream-bound',
      sourceIdentity,
      compatibility,
    },
  });
  const input: ExtensionFinalInput = {
    product,
    owner: product,
    version: '7.8.9',
    family,
    target,
    github: [github],
    npm: [file('candidate.tgz', 'npm document fixture')],
    cargo: [file('candidate.crate', 'cargo document fixture')],
    manifest: file('selected-manifest.json', JSON.stringify(documents.releaseData)),
    frozen: file('extension-artifacts.json', JSON.stringify(documents.manifest)),
  };
  const originalFiles = path.join(root, 'original-files.json');
  writeFileSync(originalFiles, JSON.stringify(input));
  const leaf = {
    ...input,
    github: input.github.map((value) => value.path),
    npm: input.npm.map((value) => value.path),
    cargo: input.cargo.map((value) => value.path),
    manifest: input.manifest.path,
    frozen: input.frozen.path,
    originalFiles,
  };
  const spec = {
    product,
    owner: product,
    version: '7.8.9',
    members: [{ sqlName: 'pgtap' }],
    profiles: [{ target: 'linux-x64-gnu' }, { target: 'ios-xcframework' }],
    ownerFamilies: ['native', 'wasix'],
  } as NativeOwnerSpec;
  return { root, input, documents, member, leaf, spec };
}
function replaceDocument(
  input: ExtensionFinalInput,
  which: 'manifest' | 'frozen',
  mutate: (value: any) => void,
) {
  const value = JSON.parse(readFileSync(input[which].path, 'utf8'));
  mutate(value);
  writeFileSync(input[which].path, JSON.stringify(value));
  const identity = fileIdentity(input[which].path);
  input[which].size = identity.size;
  input[which].sha256 = identity.sha256;
}

test('checks original bytes and canonical documents without treating fixtures as runtime proof', () => {
  for (const family of ['native', 'wasix'] as const) {
    const { input } = fixture(family);
    expect(validateDeclaredExtensionFinalInput(input, canonical)).toBe(input);
    writeFileSync(input.github[0].path, 'changed original bytes');
    expect(() => validateDeclaredExtensionFinalInput(input, canonical)).toThrow(
      'original File bytes differ',
    );
  }
});
test('rejects changed Apple/WASIX/member fields even when document hashes are freshly captured', () => {
  for (const field of [
    'iosRegistration',
    'wasixInstall',
    'dependencies',
    'extensionClass',
    'sourceIdentity',
  ]) {
    const { input } = fixture();
    replaceDocument(input, 'manifest', (document) => {
      document[field] = { changed: field };
    });
    expect(() => validateDeclaredExtensionFinalInput(input, canonical)).toThrow();
  }
  const { input } = fixture();
  replaceDocument(input, 'frozen', (document) => {
    document.assets[0].target = 'made-up-platform';
  });
  replaceDocument(input, 'manifest', (document) => {
    document.assets[0].target = 'made-up-platform';
  });
  expect(() => validateDeclaredExtensionFinalInput(input, canonical)).toThrow(
    'target is undeclared',
  );
  const wrongFamily = fixture();
  replaceDocument(wrongFamily.input, 'frozen', (document) => {
    document.family = 'wasix';
  });
  replaceDocument(wrongFamily.input, 'manifest', (document) => {
    document.family = 'wasix';
  });
  expect(() => validateDeclaredExtensionFinalInput(wrongFamily.input, canonical)).toThrow(
    'another family',
  );
});
test('rejects missing, repeated and substituted physical GH Files independently of labels', () => {
  for (const alter of [
    (input: ExtensionFinalInput) => {
      input.github = [];
    },
    (input: ExtensionFinalInput) => {
      input.github.push(input.github[0]);
    },
    (input: ExtensionFinalInput) => {
      input.github = [input.npm[0]];
    },
  ]) {
    const { input } = fixture();
    alter(input);
    expect(() => validateDeclaredExtensionFinalInput(input, canonical)).toThrow();
  }
});
test('stages only the original File map and rejects a path relabeling', () => {
  const { leaf, spec, root, input } = fixture();
  validateDeclaredExtensionFinalInput(input, canonical);
  const staged = stageDeclaredFinalLeaf(spec, leaf, path.join(root, 'stage'));
  expect(
    readFileSync(path.join(path.dirname(staged.productRoot), staged.directAssets[0].path)),
  ).toEqual(readFileSync(leaf.github[0]));
  expect(staged.members[0].sqlName).toBe('pgtap');
  expect(() =>
    stageDeclaredFinalLeaf(spec, { ...leaf, github: leaf.npm }, path.join(root, 'other')),
  ).toThrow();
});
test('complete external owner requires all native targets plus the genuine WASIX cohort', () => {
  const native = fixture(),
    wasix = fixture('wasix');
  expect(ownerFamilyCompleteness(native.spec, [native.leaf]).missingNativeTargets).toEqual([
    'ios-xcframework',
  ]);
  const ios = { ...native.leaf, target: 'ios-xcframework' };
  expect(ownerFamilyCompleteness(native.spec, [native.leaf, ios]).missingOwnerFamilies).toEqual([
    'wasix',
  ]);
  expect(
    ownerFamilyCompleteness(native.spec, [native.leaf, ios, wasix.leaf])
      .completeExtensionDistribution,
  ).toBe(true);
  expect(() => ownerFamilyCompleteness(native.spec, [native.leaf, native.leaf])).toThrow(
    'repeated',
  );
  expect(() =>
    ownerFamilyCompleteness(native.spec, [{ ...wasix.leaf, target: 'wasix-aot-made-up' }]),
  ).toThrow('portable constructor');
  expect(() =>
    ownerFamilyCompleteness({ ...native.spec, ownerFamilies: ['native'] }, [
      native.leaf,
      ios,
      wasix.leaf,
    ]),
  ).toThrow('undeclared');
});
test('merge keeps distinct genuine Apple and WASIX contracts and rejects common SQL disagreement', () => {
  const native = fixture(),
    wasix = fixture('wasix');
  const ios = {
    ...native.member,
    iosRegistration: { symbolPrefix: 'pgtap' },
    assets: native.member.assets.map((asset) => ({ ...asset, target: 'ios-xcframework' })),
  };
  const cohorts = [{ members: [native.member] }, { members: [ios] }, { members: [wasix.member] }];
  const merged = mergeNativeFinalMembers(native.spec, cohorts);
  expect(merged[0].iosRegistration).toEqual(ios.iosRegistration);
  expect(merged[0].wasixInstall).toEqual(wasix.member.wasixInstall);
  expect(merged[0].assets).toHaveLength(3);
  expect(() =>
    mergeNativeFinalMembers(native.spec, [...cohorts, { members: [wasix.member] }]),
  ).toThrow();
  wasix.member.dependencies = ['different'] as never[];
  expect(() => mergeNativeFinalMembers(native.spec, cohorts)).toThrow('differs across original');
});

test('final single and bundle controls supply absent Apple fields without changing frozen cohorts', () => {
  const native = fixture(),
    wasix = fixture('wasix');
  const compact = ({ iosNativeDependencies, iosRegistration, ...member }: typeof native.member) =>
    member;
  const ios = {
    ...native.member,
    iosNativeDependencies: ['actual-link-unit'],
    iosRegistration: { symbolPrefix: 'pgtap' },
    assets: native.member.assets.map((asset) => ({ ...asset, target: 'ios-xcframework' })),
  };
  for (const count of [1, 2]) {
    for (const rows of [
      [compact(native.member)],
      [compact(wasix.member)],
      [compact(native.member), compact(wasix.member)],
      [compact(native.member), ios, compact(wasix.member)],
    ]) {
      const cohorts = rows.map((row) => ({
        members: Array.from({ length: count }, (_, index) => ({
          ...row,
          sqlName: `member${index}`,
        })),
      }));
      const before = structuredClone(cohorts);
      const members = mergeNativeFinalMembers(
        {
          ...native.spec,
          members: cohorts[0].members.map(({ sqlName }) => ({ sqlName })),
        } as NativeOwnerSpec,
        cohorts,
      );
      const hasIos = rows.includes(ios);
      for (const member of members) {
        expect(member.iosNativeDependencies).toEqual(hasIos ? ios.iosNativeDependencies : []);
        expect(member.iosRegistration).toEqual(hasIos ? ios.iosRegistration : null);
        expect(member.wasixInstall).toEqual(
          rows.length === 1 && rows[0].wasixInstall === null ? null : wasix.member.wasixInstall,
        );
      }
      const inputs = {
        product: count === 1 ? product : 'oliphaunt-extension-contrib-pg18',
        releaseProduct:
          count === 1
            ? product
            : rows[0].assets[0].family === 'wasix'
              ? 'liboliphaunt-wasix'
              : 'liboliphaunt-native',
        family: rows.length === 1 ? rows[0].assets[0].family : null,
        version: native.spec.version,
        members,
        directAssets: [],
        releaseMetadata: {
          class: count === 1 ? 'external' : 'contrib',
          versioning: count === 1 ? 'upstream-bound' : 'runtime-bound',
          sourceIdentity,
          compatibility,
        },
      };
      const productRoot = path.join(native.root, `controls-${count}-${rows.length}-${hasIos}`);
      mkdirSync(path.join(productRoot, 'release-assets'), { recursive: true });
      const controls = writeReleaseControls({
        ...inputs,
        ...composeExtensionReleaseDocuments(inputs),
        productRoot,
        root: native.root,
      });
      const release = JSON.parse(readFileSync(controls.releaseManifest, 'utf8'));
      for (const member of release.extensions ?? [release]) {
        expect(member.iosNativeDependencies).toEqual(hasIos ? ios.iosNativeDependencies : []);
        expect(member.iosRegistration).toEqual(hasIos ? ios.iosRegistration : null);
      }
      expect(readFileSync(controls.propertiesManifest, 'utf8')).toContain(
        `iosNativeDependencies=${hasIos ? 'actual-link-unit' : ''}\n`,
      );
      expect(cohorts).toEqual(before);
    }
  }
});

test('completed Apple archive factory accepts its actual empty document record and rejects malformed original documents', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'completed-apple-base-factory-'));
  directories.push(root);
  const version = '9.0.0';
  const archives: Record<string, { path: string; size: number; sha256: string }> = {};
  for (const [role, name, profile, member] of [
    [
      'base-xcframework',
      'liboliphaunt-' + version + '-apple-spm-xcframework.zip',
      'native-runtime',
      'liboliphaunt.xcframework',
    ],
    [
      'runtime-resources',
      'liboliphaunt-' + version + '-runtime-resources-ios-datum64.tar.gz',
      'native-runtime-resources',
      'oliphaunt',
    ],
  ]) {
    const stage = path.join(root, role);
    const leaf = path.join(stage, member);
    mkdirSync(leaf, { recursive: true });
    writeFileSync(
      path.join(leaf, 'fixture.txt'),
      'archive contract fixture; no runtime qualification',
    );
    const notices = role === 'runtime-resources' ? stage : leaf;
    for (const member of releaseNoticeDeclaration(profile).members) {
      const file = path.join(notices, member);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, 'controlled notice fixture: ' + member + '\n');
    }
    const file = path.join(root, name);
    await archiveDirectory(role === 'runtime-resources' ? stage : leaf, file, {
      keepParent: role === 'base-xcframework',
    });
    const { size, sha256 } = fileIdentity(file);
    archives[role] = { path: file, size, sha256 };
  }
  const result = declaredNativeAppleBaseManifest({}, version, archives);
  expect(result.base.version).toBe(version);
  for (const role of ['base-xcframework', 'runtime-resources'])
    expect(result.base.assets.find((row: any) => row.role === role).sha256).toBe(
      archives[role].sha256,
    );
  const aliases = path.join(root, 'declared-inputs');
  mkdirSync(aliases);
  const aliasedArchives = Object.fromEntries(
    Object.entries(archives).map(([role, file]) => {
      const alias = path.join(aliases, path.basename(file.path));
      symlinkSync(file.path, alias);
      return [role, { ...file, path: alias }];
    }),
  );
  expect(declaredNativeAppleBaseManifest({}, version, aliasedArchives)).toEqual(result);
  expect(
    declaredNativeAppleBaseManifest(
      { owner: 'liboliphaunt-native', version },
      version,
      aliasedArchives,
      true,
    ),
  ).toEqual(result);
  const document = path.join(root, 'ios.json');
  writeFileSync(document, JSON.stringify(result));
  const documentAlias = path.join(aliases, 'ios.json');
  symlinkSync(document, documentAlias);
  const documentIdentity = fileIdentity(document);
  const original = {
    owner: 'liboliphaunt-native',
    version,
    file: {
      path: documentAlias,
      size: documentIdentity.size,
      sha256: documentIdentity.sha256,
      producer: {
        evidenceDigest: 'sha256:' + '1'.repeat(64),
        invocationId: 'document-fixture',
        root: '//src/native/runtime:apple_ios_manifest_shipping',
        configuration: '2'.repeat(64),
        output: 'bazel-out/config/bin/apple_release_assets/ios.json',
      },
    },
  };
  expect(declaredNativeAppleBaseManifest(original, version, aliasedArchives)).toEqual(result);
  expect(() =>
    declaredNativeAppleBaseManifest(
      { ...original, file: { ...original.file, sha256: '0'.repeat(64) } },
      version,
      aliasedArchives,
    ),
  ).toThrow('original File bytes differ');
  expect(() =>
    declaredNativeAppleBaseManifest({}, version, {
      ...aliasedArchives,
      'runtime-resources': { ...aliasedArchives['runtime-resources'], sha256: '0'.repeat(64) },
    }),
  ).toThrow('archive identity differs');
  expect(() =>
    declaredNativeAppleBaseManifest({ file: { path: 'invented.json' } }, version, archives),
  ).toThrow();
  expect(() =>
    declaredNativeAppleBaseManifest({ owner: 'liboliphaunt-native', version }, version, archives),
  ).toThrow();
  expect(() =>
    declaredNativeAppleBaseManifest({}, version, {
      'base-xcframework': archives['base-xcframework'],
    }),
  ).toThrow();
  expect(() =>
    declaredNativeAppleBaseManifest({}, version, {
      ...archives,
      'runtime-resources': { ...archives['runtime-resources'], sha256: '0'.repeat(64) },
    }),
  ).toThrow();
});

test('nested closed bundle follows only its declared outer File alias and retains original identities', async () => {
  const { root, input, member, spec, leaf } = fixture();
  const prefix = 'closed-bundle';
  const nested = readFileSync(input.github[0].path);
  const members = ['pgtap', 'second-document-fixture'].map((sqlName) => ({
    ...member,
    sqlName,
    assets: member.assets.map((asset) => ({
      ...asset,
      carrierAsset: 'closed-bundle.tar.gz',
      carrierRoot: prefix,
      memberPath: `${sqlName}/${asset.name}`,
    })),
  }));
  const stage = path.join(root, prefix);
  for (const member of members) {
    const file = path.join(stage, member.assets[0].memberPath);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, nested);
  }
  const archive = path.join(root, 'closed-bundle.tar.gz');
  await archiveDirectory(stage, archive, { keepParent: true });
  const alias = path.join(root, 'runfiles', path.basename(archive));
  mkdirSync(path.dirname(alias), { recursive: true });
  symlinkSync(archive, alias);
  const { size, sha256 } = fileIdentity(archive);
  input.github = [{ ...input.github[0], path: alias, size, sha256 }];
  const documents = composeExtensionReleaseDocuments({
    product,
    releaseProduct: product,
    family: 'native',
    version: input.version,
    members,
    directAssets: [{ ...member.assets[0], name: path.basename(alias), bytes: size, sha256 }],
    releaseMetadata: {
      class: 'external',
      versioning: 'upstream-bound',
      sourceIdentity,
      compatibility,
    },
  });
  replaceDocument(input, 'manifest', (value) => {
    for (const key of Object.keys(value)) delete value[key];
    Object.assign(value, documents.releaseData);
  });
  replaceDocument(input, 'frozen', (value) => {
    for (const key of Object.keys(value)) delete value[key];
    Object.assign(value, documents.manifest);
  });
  leaf.github = [alias];
  writeFileSync(leaf.originalFiles, JSON.stringify(input));
  validateDeclaredExtensionFinalInput(input, {
    ...canonical,
    sqlNames: members.map((m) => m.sqlName),
  });
  const staged = stageDeclaredFinalLeaf(spec, leaf, path.join(root, 'staged-alias'));
  expect(staged.leaf).toBe(leaf);
  expect(staged.leaf.github).toEqual([alias]);
  for (const member of staged.members)
    expect(
      readFileSync(path.join(path.dirname(staged.productRoot), member.assets[0].path)),
    ).toEqual(nested);
  expect(staged.inventory.find((row) => row.path === 'github/closed-bundle.tar.gz')).toMatchObject({
    bytes: size,
    sha256,
  });
  expect(() =>
    stageDeclaredFinalLeaf(spec, { ...leaf, github: [archive] }, path.join(root, 'relabel')),
  ).toThrow();
});
