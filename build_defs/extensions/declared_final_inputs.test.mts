/** Document/File transport fixtures; these never claim foreign package or runtime qualification. */
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { composeExtensionReleaseDocuments } from '../../src/extensions/artifacts/packages/tools/build-extension-ci-artifacts.mts';
import type { ExtensionFinalInput } from '../../tools/release/native-extension-final-inputs.mts';
import { fileIdentity } from '../../tools/release/native-file-identity.mts';
import {
  validateDeclaredExtensionFinalInput,
  validateDeclaredNativeAppleBase,
} from './declared_final_inputs.mts';
import {
  mergeNativeFinalMembers,
  ownerFamilyCompleteness,
  stageDeclaredFinalLeaf,
  type NativeOwnerSpec,
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
