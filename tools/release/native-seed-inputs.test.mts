import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { projectNativeSeedInputs } from './native-seed-inputs.mts';

const publication = {
  product: 'database-resources',
  version: '0.2.2',
  tagName: 'database-resources-v0.2.2',
  publicationSha: 'a'.repeat(40),
  publicationTree: 'b'.repeat(40),
  releaseSha: 'c'.repeat(40),
};
const source = { commit: 'd'.repeat(40), tree: 'e'.repeat(40) };
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'seed-input-projection-'));
  const file = (name: string, contents: string) => {
    const destination = path.join(root, name);
    writeFileSync(destination, contents);
    const bytes = readFileSync(destination);
    return {
      path: destination,
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  };
  const archive = file('seed.tar.zst', 'opaque verified archive File fixture');
  const manifest = file('seed.json', 'opaque verified descriptor File fixture');
  const metadata = file('construction.json', 'opaque verified completed metadata File fixture');
  return { root, archive, manifest, metadata };
}

test('empty native input snapshot preserves construction defaults and grants no public origin', () => {
  expect(projectNativeSeedInputs([])).toEqual({ controls: {}, files: [] });
});

test('one per-run completed snapshot projects exact File identities and deduplicates shared metadata', () => {
  const f = fixture();
  try {
    const reuse = {
      operation: 'reuse' as const,
      publication,
      archive: f.archive,
      manifest: f.manifest,
      metadata: f.metadata,
    };
    const rows = [
      { family: 'native' as const, target: 'linux-x64-gnu', profile: 'standard' as const, reuse },
      { family: 'wasix' as const, target: 'portable', profile: 'icu' as const, reuse },
    ];
    const projected = projectNativeSeedInputs(rows, source);
    expect(Object.keys(projected.controls)).toEqual([
      'native/linux-x64-gnu/standard',
      'wasix/portable/icu',
    ]);
    expect(projected.files).toHaveLength(3);
    expect(projected.controls['native/linux-x64-gnu/standard'].completed_metadata).toBe(
      projected.controls['wasix/portable/icu'].completed_metadata,
    );
    expect(projected.controls['native/linux-x64-gnu/standard']).not.toHaveProperty('ready');
    expect(JSON.parse(projected.controls['native/linux-x64-gnu/standard'].reuse_control)).toEqual(
      reuse,
    );
    expect(() => projectNativeSeedInputs([rows[0], rows[0]], source)).toThrow(
      'duplicate native seed control slot',
    );
    expect(() => projectNativeSeedInputs([{ ...rows[0], ready: true }], source)).toThrow(
      'fields differ',
    );
    writeFileSync(f.archive.path, 'altered mutable transport');
    expect(() => projectNativeSeedInputs(rows, source)).toThrow('snapshot File bytes differ');
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('qualified seed projection binds exact final source and preserves original evidence', () => {
  const f = fixture();
  try {
    const promotion = {
      source: { commit: '1'.repeat(40), tree: '2'.repeat(40) },
      evidenceDigest: `sha256:${'3'.repeat(64)}`,
      invocationId: 'original-invocation',
      frozen: f.archive,
      receipt: f.metadata,
      transition: { source, updatesSha256: '4'.repeat(64) },
    };
    const row = { family: 'native', target: 'linux-x64-gnu', profile: 'standard', promotion };
    const projected = projectNativeSeedInputs([row], source);
    const attrs = projected.controls['native/linux-x64-gnu/standard'];
    expect(JSON.parse(attrs.promotion_control)).toEqual(promotion);
    expect(attrs).not.toHaveProperty('completed_archive');
    expect(projected.files).toHaveLength(2);
    expect(() => projectNativeSeedInputs([row], { ...source, commit: '5'.repeat(40) })).toThrow(
      'target source differs',
    );
    expect(() =>
      projectNativeSeedInputs(
        [{ ...row, promotion: { ...promotion, evidenceDigest: 'unverified' } }],
        source,
      ),
    ).toThrow();
    expect(() =>
      projectNativeSeedInputs(
        [
          {
            ...row,
            promotion: { ...promotion, frozen: { ...promotion.frozen, path: 'relative.tar' } },
          },
        ],
        source,
      ),
    ).toThrow('absolute frozen File');
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
