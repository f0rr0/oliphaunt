import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDeterministicTar } from '../../../tools/packaging/archive-directory.mts';
import { canonicalGzipSync } from '../../../tools/packaging/portable-archive.mts';
import { macosStaticArchive, stageAppleStaticLeaf } from './static-carrier-consumer.mts';

// Fixtures qualify relocation/admission only; their bytes are not native binaries.
function fixture(root: string, bundle = false) {
  const bytes = Buffer.from('original packaged fixture bytes');
  const row = {
    name: 'fixture.zip',
    path: 'old/constructor/fixture.zip',
    family: 'native',
    target: 'ios-xcframework',
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
  };
  const frozen = {
    schema: 'oliphaunt-extension-ci-artifacts-v1',
    product: 'fixture-product',
    releaseProduct: 'fixture-owner',
    version: '1.2.3',
    compatibility: { nativeRuntimeVersion: '4.5.6' },
    sqlName: 'fixture',
    assets: [row],
  };
  mkdirSync(path.join(root, 'github'), { recursive: true });
  writeFileSync(path.join(root, 'github', row.name), bytes);
  const leaf = {
    product: frozen.product,
    owner: frozen.releaseProduct,
    version: frozen.version,
    runtimeVersion: '4.5.6',
    sqlNames: ['fixture'],
    github: [path.join(root, 'github')],
    frozen: path.join(root, 'frozen.json'),
  };
  const write = (value: any = frozen) => writeFileSync(leaf.frozen, JSON.stringify(value));
  if (!bundle) write();
  return { bytes, row, frozen, leaf, write };
}

test('singleton relocates exact original archive bytes without rewriting held identity fields', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'apple-static-single-'));
  try {
    const input = fixture(root);
    const staged = stageAppleStaticLeaf(input.leaf, path.join(root, 'staged'), '4.5.6');
    const output = JSON.parse(readFileSync(staged.output, 'utf8'));
    assert.deepEqual({ ...output, assets: input.frozen.assets }, input.frozen);
    assert.deepEqual(readFileSync(output.assets[0].path), input.bytes);
    writeFileSync(path.join(root, 'github', input.row.name), 'corrupt');
    assert.throws(
      () => stageAppleStaticLeaf(input.leaf, path.join(root, 'corrupt'), '4.5.6'),
      /frozen size differs/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('independently held core, changed cohort and unexpected physical archive fail closed', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'apple-static-admission-'));
  try {
    const input = fixture(root);
    assert.throws(
      () => stageAppleStaticLeaf(input.leaf, path.join(root, 'wrong-core'), '4.5.7'),
      /different native core/,
    );
    input.write({ ...input.frozen, compatibility: { nativeRuntimeVersion: '4.5.5' } });
    assert.throws(() =>
      stageAppleStaticLeaf(input.leaf, path.join(root, 'wrong-frozen-core'), '4.5.6'),
    );
    input.write();
    assert.throws(() =>
      stageAppleStaticLeaf(
        { ...input.leaf, sqlNames: ['another'] },
        path.join(root, 'wrong-cohort'),
        '4.5.6',
      ),
    );
    writeFileSync(path.join(root, 'github', 'undeclared.zip'), 'extra');
    assert.throws(
      () => stageAppleStaticLeaf(input.leaf, path.join(root, 'extra'), '4.5.6'),
      /must match frozen direct assets/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('bundle relocation preserves original nested bytes and rejects a falsified nested digest', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'apple-static-bundle-'));
  try {
    const input = fixture(root, true);
    const nested = path.join(root, 'bundle', 'extensions', 'fixture', input.row.name);
    mkdirSync(path.dirname(nested), { recursive: true });
    writeFileSync(nested, input.bytes);
    const outer = canonicalGzipSync(
      await createDeterministicTar(path.join(root, 'bundle'), { keepParent: true }),
    );
    rmSync(path.join(root, 'github', input.row.name));
    writeFileSync(path.join(root, 'github', 'bundle.tar.gz'), outer);
    const direct = {
      ...input.row,
      name: 'bundle.tar.gz',
      path: 'old/bundle.tar.gz',
      bytes: outer.length,
      sha256: createHash('sha256').update(outer).digest('hex'),
    };
    const member = {
      ...input.frozen,
      assets: [
        {
          ...input.row,
          carrierAsset: direct.name,
          carrierRoot: 'bundle',
          memberPath: `extensions/fixture/${input.row.name}`,
        },
      ],
    };
    const frozen = {
      ...input.frozen,
      schema: 'oliphaunt-extension-ci-artifacts-v2',
      extensions: [member],
      carrierAssets: [direct],
    };
    input.write(frozen);
    const staged = stageAppleStaticLeaf(input.leaf, path.join(root, 'staged'), '4.5.6');
    const output = JSON.parse(readFileSync(staged.output, 'utf8'));
    assert.deepEqual(readFileSync(output.extensions[0].assets[0].path), input.bytes);
    assert.equal(output.extensions[0].assets[0].carrierAsset, direct.name);
    const asset = member.assets[0];
    assert.ok(asset);
    asset.sha256 = '0'.repeat(64);
    input.write(frozen);
    assert.throws(
      () => stageAppleStaticLeaf(input.leaf, path.join(root, 'bad-digest'), '4.5.6'),
      /frozen SHA-256 differs/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('macOS archive selection accepts framework-wrapped ar bytes and rejects absent or duplicate libraries', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'apple-static-library-'));
  try {
    const macos = path.join(root, 'macos-arm64', 'fixture.framework');
    mkdirSync(path.join(macos, 'Headers'), { recursive: true });
    writeFileSync(path.join(macos, 'Headers', 'fixture.h'), 'header fixture');
    assert.throws(() => macosStaticArchive(root), /exactly one ar library/);
    const archive = path.join(macos, 'fixture');
    writeFileSync(archive, '!<arch>\nfixture');
    assert.equal(macosStaticArchive(root), archive);
    writeFileSync(path.join(macos, 'duplicate.a'), '!<arch>\nother');
    assert.throws(() => macosStaticArchive(root), /exactly one ar library/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
