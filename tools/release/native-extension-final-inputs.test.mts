import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  type ExtensionFinalInput,
  projectNativeAppleBaseInput,
  projectNativeCurrentArtifacts,
  projectNativeExtensionFinalInputs,
  projectNativeSwiftSourceInput,
} from './native-extension-final-inputs.mts';

function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), 'extension-original-files-'));
  const file = (name: string) => {
    const bytes = Buffer.from(`original fixture ${name}`);
    const source = path.join(directory, name);
    mkdirSync(path.dirname(source), { recursive: true });
    writeFileSync(source, bytes);
    return {
      path: source,
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      producer: {
        evidenceDigest: `sha256:${'3'.repeat(64)}`,
        invocationId: 'original-qualified-invocation',
        root: '//src/extensions/external/pgtap:native_frozen_shipping',
        configuration: '4'.repeat(64),
        output: `bazel-out/k8-opt/bin/${name}`,
      },
    };
  };
  const leaf: ExtensionFinalInput = {
    product: 'oliphaunt-extension-pgtap',
    owner: 'oliphaunt-extension-pgtap',
    version: '0.1.1',
    family: 'native',
    target: 'linux-x64-gnu',
    github: [file('pgtap.tar.gz')],
    npm: [file('pgtap.tgz')],
    cargo: [{ ...file('cargo/pgtap.crate'), member: 'pgtap.crate' }],
    manifest: file('manifest.json'),
    frozen: file('extension-artifacts.json'),
  };
  return { directory, leaf, file };
}

test('Swift source tuple retains the genuine binding producer and rejects version/cohort substitutions', () => {
  const { directory, file } = fixture();
  try {
    const carrier = file('oliphaunt-react-native-ios-carriers.json');
    const document = Buffer.from(
      JSON.stringify({
        schema: 'oliphaunt-react-native-ios-carrier-v1',
        base: {
          product: 'liboliphaunt-native',
          version: '0.3.3',
          tag: 'liboliphaunt-native-v0.3.3',
        },
        extensions: [],
        carriers: [],
      }),
    );
    writeFileSync(carrier.path, document);
    carrier.size = document.length;
    carrier.sha256 = createHash('sha256').update(document).digest('hex');
    const bindingsArchive = file('oliphaunt-swift-0.8.3-bindings.xcframework.zip');
    bindingsArchive.producer.root = '//src/native/sdks/swift:shipping_bindings';
    const input = {
      owner: 'oliphaunt-swift',
      version: '0.8.3',
      archive: file('Oliphaunt-source.zip'),
      carrier,
      ownerCatalog: file('extension-owner-catalog.json'),
      bindingsArchive,
    };
    const projected = projectNativeSwiftSourceInput(input);
    expect(projected.files).toHaveLength(4);
    expect(projected.input.bindingsArchive.producer).toEqual(bindingsArchive.producer);
    expect(projected.input.bindingsArchive.path).toStartWith(
      '@oliphaunt_metadata//:native-swift-source/bindingsArchive/',
    );
    for (const change of [
      (value) => delete value.bindingsArchive,
      (value) => (value.version = '0.8.4'),
      (value) => (value.bindingsArchive.member = 'binding.zip'),
      (value) => (value.bindingsArchive.producer.root = '//wrong:bindings'),
      (value) => (value.bindingsArchive.producer.invocationId = 'different-candidate-run'),
      (value) => (value.bindingsArchive.producer.evidenceDigest = `sha256:${'a'.repeat(64)}`),
      (value) => (value.bindingsArchive.sha256 = '0'.repeat(64)),
    ]) {
      const changed = structuredClone(input);
      change(changed);
      expect(() => projectNativeSwiftSourceInput(changed)).toThrow();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Apple base preserves the final manifest/archive tuple and rejects stale versions and mixed producer runs', () => {
  const { directory, leaf, file: original } = fixture();
  try {
    const source = path.join(directory, 'ios.json');
    const bytes = Buffer.from('actual original base manifest fixture');
    writeFileSync(source, bytes);
    const file = {
      ...leaf.manifest,
      path: source,
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      producer: {
        ...leaf.manifest.producer,
        root: '//src/native/runtime:apple_ios_manifest_shipping',
        output: 'bazel-out/config/bin/apple_release_assets/ios.json',
      },
    };
    const framework = original('liboliphaunt-0.3.3-apple-spm-xcframework.zip');
    framework.producer.root = '//src/native/runtime:apple_swiftpm_shipping';
    const resources = original('liboliphaunt-0.3.3-runtime-resources-ios-datum64.tar.gz');
    resources.producer.root = '//src/native/runtime:apple_resources_shipping';
    const input = { owner: 'liboliphaunt-native', version: '0.3.3', file, framework, resources };
    const projected = projectNativeAppleBaseInput(input);
    expect(projected.input.file.path).toStartWith('@oliphaunt_metadata//:native-apple-base/');
    expect(projected.input.file.producer).toEqual(file.producer);
    expect(projected.files).toHaveLength(3);
    for (const changed of [
      { ...input, owner: 'liboliphaunt-wasix' },
      { ...input, authenticated: true },
      { ...input, file: { ...file, member: 'ios.json' } },
      { ...input, file: { ...file, sha256: '0'.repeat(64) } },
      { ...input, version: '0.3.4' },
      { ...input, framework: undefined },
      {
        ...input,
        framework: { ...framework, producer: { ...framework.producer, root: '//wrong:archive' } },
      },
      {
        ...input,
        resources: {
          ...resources,
          producer: { ...resources.producer, invocationId: 'pre-version-run' },
        },
      },
    ])
      expect(() => projectNativeAppleBaseInput(changed)).toThrow();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('projects each actual File once and retains original configured producer references', () => {
  const { directory, leaf } = fixture();
  try {
    const projected = projectNativeExtensionFinalInputs([leaf]);
    expect(projected.files).toHaveLength(5);
    const saved = projected.leaves['oliphaunt-extension-pgtap/native/linux-x64-gnu'];
    expect(saved.cargo[0].member).toBe('pgtap.crate');
    expect(saved.cargo[0].producer).toEqual(leaf.cargo[0].producer);
    expect(saved.cargo[0].path).toStartWith('@oliphaunt_metadata//:extension-final-inputs/');
    expect(projected.files.map((file) => file.source).sort()).toEqual(
      [...leaf.github, ...leaf.npm, ...leaf.cargo, leaf.manifest, leaf.frozen]
        .map((file) => file.path)
        .sort(),
    );
    saved.cargo[0].producer.root = '//wrong:root';
    expect(leaf.cargo[0].producer.root).toBe(
      '//src/extensions/external/pgtap:native_frozen_shipping',
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('rejects unknown fields, duplicate constructor slots and repeated original File ownership', () => {
  const { directory, leaf } = fixture();
  try {
    expect(() => projectNativeExtensionFinalInputs([{ ...leaf, qualified: true }])).toThrow();
    expect(() => projectNativeExtensionFinalInputs([leaf, leaf])).toThrow(/duplicate/);
    expect(() => projectNativeExtensionFinalInputs([{ ...leaf, npm: leaf.github }])).toThrow(
      /repeats/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('rejects corrupt bytes, path traversal and incomplete original producer references', () => {
  const { directory, leaf } = fixture();
  try {
    for (const changed of [
      { ...leaf.frozen, sha256: '0'.repeat(64) },
      { ...leaf.frozen, member: '../extension-artifacts.json' },
      { ...leaf.frozen, producer: { ...leaf.frozen.producer, output: '../output' } },
      { ...leaf.frozen, producer: { ...leaf.frozen.producer, root: '//wrong/../path:root' } },
      { ...leaf.frozen, producer: { ...leaf.frozen.producer, configuration: 'unknown' } },
    ])
      expect(() => projectNativeExtensionFinalInputs([{ ...leaf, frozen: changed }])).toThrow();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('requires GH Files for mobile and all registry groups for desktop/WASIX', () => {
  const { directory, leaf } = fixture();
  try {
    expect(() => projectNativeExtensionFinalInputs([{ ...leaf, npm: [] }])).toThrow();
    expect(() =>
      projectNativeExtensionFinalInputs([
        { ...leaf, family: 'wasix', target: 'wasix-portable', cargo: [] },
      ]),
    ).toThrow();
    expect(() =>
      projectNativeExtensionFinalInputs([
        { ...leaf, target: 'android-arm64-v8a', github: [], npm: [], cargo: [] },
      ]),
    ).toThrow();
    expect(
      projectNativeExtensionFinalInputs([
        { ...leaf, target: 'android-arm64-v8a', npm: [], cargo: [] },
      ]).files,
    ).toHaveLength(3);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('current payload aliases retain exact source/File tuples and reject invalid carriers, source and bytes', () => {
  const { directory, file } = fixture();
  try {
    const source = { commit: 'a'.repeat(40), tree: 'b'.repeat(40) };
    const row = {
      product: 'liboliphaunt-native',
      version: '0.3.3',
      artifact: 'cargo:liboliphaunt-native-linux-x64-gnu',
      configuration: 'linux-x64-gnu',
      source,
      file: {
        ...file('native_cargo_export.crate'),
        member: 'native_cargo_export.crate',
      },
    };
    const projected = projectNativeCurrentArtifacts([row], source);
    const key = `${row.product}/${row.version}/${row.artifact}`;
    expect(projected.artifacts[key].file.producer).toEqual(row.file.producer);
    expect(projected.artifacts[key].file.member).toBe(row.file.member);
    expect(projected.artifacts[key].file.path).toStartWith(
      '@oliphaunt_metadata//:native-current-artifacts/',
    );
    expect(projected.files[0].source).toBe(row.file.path);
    expect(projected.artifacts[key].file.path).toEndWith('/native_cargo_export.crate');
    expect(projectNativeCurrentArtifacts([], source).artifacts).toEqual({});
    for (const change of [
      (value) => (value.source.commit = 'c'.repeat(40)),
      (value) => (value.version = 'not-a-version'),
      (value) => (value.artifact = 'cargo:invalid/name'),
      (value) => (value.file.path = value.file.path.replace(/\.crate$/u, '.tgz')),
      (value) => (value.file.sha256 = '0'.repeat(64)),
      (value) => (value.file.producer.output = '../output'),
      (value) => (value.authenticated = true),
    ]) {
      const changed = structuredClone(row);
      change(changed);
      expect(() => projectNativeCurrentArtifacts([changed], source)).toThrow();
    }
    expect(() => projectNativeCurrentArtifacts([row, row], source)).toThrow('repeats');
    expect(() =>
      projectNativeCurrentArtifacts([{ ...row, artifact: 'github-release:other.crate' }], source),
    ).toThrow('filename differs');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
