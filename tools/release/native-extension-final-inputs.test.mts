import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  type ExtensionFinalInput,
  projectNativeExtensionFinalInputs,
  projectNativeAppleBaseInput,
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
  return { directory, leaf };
}

test('Apple base uses the same whole regular File projection without archive or admission flags', () => {
  const { directory, leaf } = fixture();
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
    const input = { owner: 'liboliphaunt-native', version: '0.3.3', file };
    const projected = projectNativeAppleBaseInput(input);
    expect(projected.input.file.path).toStartWith('@oliphaunt_metadata//:native-apple-base/');
    expect(projected.input.file.producer).toEqual(file.producer);
    expect(projected.files).toHaveLength(1);
    for (const changed of [
      { ...input, owner: 'liboliphaunt-wasix' },
      { ...input, authenticated: true },
      { ...input, file: { ...file, member: 'ios.json' } },
      { ...input, file: { ...file, sha256: '0'.repeat(64) } },
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
