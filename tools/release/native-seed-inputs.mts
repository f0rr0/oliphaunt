/** One-way File projection from the controller's already authenticated input snapshot. */
import assert from 'node:assert/strict';
import path from 'node:path';
import type {
  QualifiedSeedControl,
  SeedReuseControl,
} from '../../build_defs/resources/seed_construction.mts';
import { fileIdentity } from './native-file-identity.mts';

type Slot = { family: 'native' | 'wasix'; target: string; profile: 'standard' | 'icu' };
export type NativeSeedInputControl = Slot &
  (
    | { reuse: SeedReuseControl; promotion?: never }
    | { promotion: QualifiedSeedControl; reuse?: never }
  );
const fields = (value: unknown, names: string[], context: string) => {
  assert.ok(
    value && typeof value === 'object' && !Array.isArray(value),
    `${context} needs an object`,
  );
  assert.deepEqual(Object.keys(value).sort(), [...names].sort(), `${context} fields differ`);
};
const source = (value: { commit: string; tree: string }) => {
  fields(value, ['commit', 'tree'], 'seed input source');
  for (const sha of [value.commit, value.tree]) assert.match(sha, /^[a-f0-9]{40}$/u);
};

/** Source provenance remains a controller check; names never grant readiness. */
export function projectNativeSeedInputs(
  value: unknown,
  currentSource?: { commit: string; tree: string },
) {
  assert.ok(Array.isArray(value), 'native seed controls need an array');
  if (currentSource) source(currentSource);
  const controls: Record<string, Record<string, string>> = {};
  const files = new Map<string, { source: string; path: string; size: number; sha256: string }>();
  for (const raw of value as NativeSeedInputControl[]) {
    const operation = raw.promotion ? 'promotion' : 'reuse';
    fields(raw, ['family', 'target', 'profile', operation], 'native seed control');
    assert.ok(['native', 'wasix'].includes(raw.family));
    assert.ok(['standard', 'icu'].includes(raw.profile));
    assert.match(raw.target, /^[a-z0-9][a-z0-9_-]*$/u);
    assert.ok(
      raw.family !== 'wasix' || raw.target === 'portable',
      'WASIX seed target must be portable',
    );
    const key = `${raw.family}/${raw.target}/${raw.profile}`;
    assert.ok(!controls[key], 'duplicate native seed control slot');
    const attributes: Record<string, string> = {};
    const alias = (file: { path: string; size: number; sha256: string }) => {
      fields(file, ['path', 'size', 'sha256'], 'native seed File');
      assert.ok(
        path.isAbsolute(file.path),
        'native seed snapshot must name an absolute frozen File',
      );
      const actual = fileIdentity(file.path);
      assert.deepEqual(
        { size: actual.size, sha256: actual.sha256 },
        { size: file.size, sha256: file.sha256 },
        'native seed snapshot File bytes differ',
      );
      assert.match(
        path.basename(file.path),
        /^[A-Za-z0-9][A-Za-z0-9._-]*$/u,
        'seed File basename is unsafe',
      );
      const output = `seed-inputs/${file.sha256}/${path.basename(file.path)}`;
      const prior = files.get(output);
      if (prior)
        assert.deepEqual(
          prior,
          { source: file.path, path: output, size: file.size, sha256: file.sha256 },
          'seed File alias is ambiguous',
        );
      else
        files.set(output, {
          source: file.path,
          path: output,
          size: file.size,
          sha256: file.sha256,
        });
      return `@oliphaunt_metadata//:${output}`;
    };
    if (operation === 'promotion') {
      const promotion = raw.promotion;
      assert.ok(promotion);
      fields(
        promotion,
        ['source', 'evidenceDigest', 'invocationId', 'frozen', 'receipt', 'transition'],
        'qualified seed control',
      );
      source(promotion.source);
      fields(promotion.transition, ['source', 'updatesSha256'], 'seed version transition');
      source(promotion.transition.source);
      if (currentSource)
        assert.deepEqual(
          promotion.transition.source,
          currentSource,
          'seed promotion target source differs',
        );
      assert.match(promotion.evidenceDigest, /^sha256:[a-f0-9]{64}$/u);
      assert.ok(typeof promotion.invocationId === 'string' && promotion.invocationId.length > 0);
      assert.match(promotion.transition.updatesSha256, /^[a-f0-9]{64}$/u);
      attributes.qualified_frozen = alias(promotion.frozen);
      attributes.qualified_receipt = alias(promotion.receipt);
      attributes.promotion_control = JSON.stringify(promotion);
    } else {
      const reuse = raw.reuse;
      assert.ok(reuse);
      fields(
        reuse,
        [
          'operation',
          'publication',
          'archive',
          'manifest',
          ...(reuse.metadata ? ['metadata'] : []),
          ...(reuse.anchor ? ['anchor'] : []),
        ],
        'completed seed control',
      );
      assert.ok(['reuse', 'adopt'].includes(reuse.operation));
      const publication = reuse.publication;
      fields(
        publication,
        ['product', 'version', 'tagName', 'publicationSha', 'publicationTree', 'releaseSha'],
        'completed seed publication',
      );
      assert.equal(publication.product, 'database-resources');
      assert.match(publication.version, /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u);
      assert.equal(publication.tagName, `${publication.product}-v${publication.version}`);
      for (const sha of [
        publication.publicationSha,
        publication.publicationTree,
        publication.releaseSha,
      ])
        assert.match(sha, /^[a-f0-9]{40}$/u);
      attributes.completed_archive = alias(reuse.archive);
      attributes.completed_manifest = alias(reuse.manifest);
      if (reuse.metadata) attributes.completed_metadata = alias(reuse.metadata);
      if (reuse.anchor) attributes.completed_anchor = alias(reuse.anchor);
      attributes.reuse_control = JSON.stringify(reuse);
    }
    controls[key] = attributes;
  }
  return {
    controls,
    files: [...files.values()].sort((left, right) => left.path.localeCompare(right.path)),
  };
}
