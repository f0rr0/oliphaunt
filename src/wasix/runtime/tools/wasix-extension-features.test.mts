#!/usr/bin/env bun

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { extensionFeatures, fullEvidenceFeatures } from './wasix-extension-features.mts';

const ROOT = path.resolve(import.meta.dirname, '../../../..');

test('every catalog extension has matching Rust asset, SDK, server, and Node-API features', () => {
  const manifest = JSON.parse(
    readFileSync(path.join(ROOT, 'src/extensions/generated/wasix/extensions.json'), 'utf8'),
  );
  const expected = extensionFeatures(manifest);

  for (const relative of [
    'src/wasix/runtime/crates/assets/Cargo.toml',
    'src/wasix/sdks/rust/Cargo.toml',
    'src/wasix/pgwire-server/Cargo.toml',
    'src/wasix/node-addon/Cargo.toml',
  ]) {
    const cargo = Bun.TOML.parse(readFileSync(path.join(ROOT, relative), 'utf8'));
    assert.deepEqual(
      Object.keys(cargo.features ?? {})
        .filter((feature) => feature.startsWith('extension-'))
        .sort(),
      expected,
      relative,
    );
    for (const extension of manifest.extensions) {
      const feature = `extension-${extension['sql-name'].replaceAll('_', '-')}`;
      // plpgsql ships in the core runtime rather than an extension carrier.
      const forwardsSdk = relative.includes('/pgwire-server/') || relative.includes('/node-addon/');
      const dependencies = (forwardsSdk ? [] : extension.dependencies)
        .filter((sqlName) => sqlName !== 'plpgsql')
        .map((sqlName) => `extension-${sqlName.replaceAll('_', '-')}`);
      const forwarding = forwardsSdk
        ? ['extensions', `oliphaunt-wasix/${feature}`]
        : relative.includes('/sdks/')
          ? ['extensions', `liboliphaunt-wasix-portable/${feature}`]
          : [];
      assert.deepEqual(
        cargo.features[feature].toSorted(),
        [...dependencies, ...forwarding].sort(),
        `${relative}: ${feature}`,
      );
    }
  }
});

test('the Node-API release embeds the complete contrib catalog', () => {
  const catalog = JSON.parse(
    readFileSync(path.join(ROOT, 'src/extensions/generated/extensions.catalog.json'), 'utf8'),
  );
  const cargo = Bun.TOML.parse(
    readFileSync(path.join(ROOT, 'src/wasix/node-addon/Cargo.toml'), 'utf8'),
  );
  const contrib = extensionFeatures({
    extensions: catalog.extensions.filter(
      (extension) => extension['source-kind'] === 'postgres-contrib',
    ),
  });
  assert.deepEqual(cargo.features.release.toSorted(), ['tools', ...contrib].sort());
});

test('full WASIX evidence enables every extension feature', () => {
  const manifest = {
    extensions: [{ 'sql-name': 'vector' }, { 'sql-name': 'pg_trgm' }],
  };

  assert.deepEqual(extensionFeatures(manifest), ['extension-pg-trgm', 'extension-vector']);
  assert.equal(
    fullEvidenceFeatures(manifest),
    'extensions,tools,extension-pg-trgm,extension-vector',
  );
});

test('full WASIX evidence rejects empty or ambiguous extension identities', () => {
  assert.throws(() => extensionFeatures({ extensions: [] }), /at least one extension/u);
  assert.throws(
    () =>
      extensionFeatures({
        extensions: [{ 'sql-name': 'vector' }, { 'sql-name': 'vector' }],
      }),
    /repeats extension vector/u,
  );
  assert.throws(
    () =>
      extensionFeatures({
        extensions: [{ 'sql-name': 'bad/name' }],
      }),
    /portable sql-name/u,
  );
});
