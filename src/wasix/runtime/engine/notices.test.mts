import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { type EngineNotice, renderEngineNotices } from './notices.mts';

function sha(bytes: Uint8Array) {
  return createHash('sha256').update(bytes).digest('hex');
}

function notice(id: string, bytes: Uint8Array, fields: Partial<EngineNotice> = {}): EngineNotice {
  return { id, name: id, url: `https://example.com/${id}`, sha256: sha(bytes), ...fields };
}

test('preserves full license texts and verified embedded notices without fetching', () => {
  const raw = Buffer.from('Copyright example.\nPermission and conditions.\n');
  const encoded = Buffer.from(raw.toString('base64'));
  const source = Buffer.from('source header\nCopyright retained.\nPermission retained.\ncode\n');
  const excerpt = Buffer.from('Copyright retained.\nPermission retained.\n');
  const files = { raw, encoded, source };
  const notices = [
    notice('raw', raw),
    notice('encoded', encoded, { encoding: 'gitiles-base64', text_sha256: sha(raw) }),
    notice('source', source, { lines: [2, 3], text_sha256: sha(excerpt) }),
  ];
  const rendered = renderEngineNotices(notices, (id) => files[id as keyof typeof files]);
  assert.equal(rendered.split(raw.toString()).length - 1, 2);
  assert(rendered.includes(excerpt.toString()));
  assert(!rendered.includes('source header'));
  assert(!rendered.includes('\ncode\n'));
  assert.equal(
    rendered,
    renderEngineNotices(notices, (id) => files[id as keyof typeof files]),
  );
});

test('rejects missing, changed, truncated, or substituted notice bytes', () => {
  const original = Buffer.from('Complete license.\n');
  const row = notice('license', original);
  assert.throws(
    () =>
      renderEngineNotices([row], () => {
        throw Error('missing input');
      }),
    /missing input/,
  );
  for (const changed of [Buffer.from('Complete'), Buffer.from('Different license.\n')]) {
    assert.throws(() => renderEngineNotices([row], () => changed), /digest differs/);
  }
  assert.throws(
    () =>
      renderEngineNotices(
        [notice('license', original, { lines: [1, 1], text_sha256: sha(Buffer.from('Wrong.\n')) })],
        () => original,
      ),
    /digest differs/,
  );
});

test('rejects ambiguous identities and invalid embedded notice ranges', () => {
  const bytes = Buffer.from('License.\n');
  const row = notice('license', bytes);
  assert.throws(() => renderEngineNotices([row, row], () => bytes), /duplicate/);
  assert.throws(() => renderEngineNotices([notice('../escape', bytes)], () => bytes), /Invalid/);
  for (const lines of [
    [0, 1],
    [2, 1],
    [1, 3],
  ] as const) {
    assert.throws(
      () => renderEngineNotices([notice('license', bytes, { lines })], () => bytes),
      /line range/,
    );
  }
  assert.throws(() => renderEngineNotices([], () => bytes), /must not be empty/);
});

test('notice provenance matches the admitted V8 binary and Wasmer source', () => {
  const pins = JSON.parse(readFileSync(new URL('./notices.json', import.meta.url), 'utf8'));
  const sources = JSON.parse(readFileSync(new URL('./sources.json', import.meta.url), 'utf8'));
  assert.equal(pins.source.v8_commit, sources.wee8.v8.commit);
  assert.equal(pins.source.wee8_library_sha256, sources.wee8.library.sha256);
  const wasmer = pins.notices.find((row: EngineNotice) => row.id === 'wasmer');
  assert(wasmer.url.includes(`/${pins.source.wasmer_commit}/LICENSE`));
});
