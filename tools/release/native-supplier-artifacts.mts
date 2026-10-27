/** Retained completed carrier Files in the existing per-run metadata snapshot.
 * Authentication remains with the controller's completed-publication readers. */
import assert from 'node:assert/strict';
import path from 'node:path';
import { validateNativeSupplierPublications } from './bazel-shipping-inputs.mts';
import type { CompletedPublication } from './completed-release-publication.mts';
import { fileIdentity, safeRelative } from './native-file-identity.mts';

export type NativeSupplierArtifact = {
  publication: CompletedPublication;
  artifact: string;
  /** Git-delivered Swift source; the carrier blob is an anchor, not the full-tree proof. */
  source?: { commit: string; tree: string; member: string; blob: string };
  file: { path: string; size: number; sha256: string };
};

function fields(value: unknown, names: string[], label: string) {
  assert.ok(
    value && typeof value === 'object' && !Array.isArray(value),
    `${label} needs an object`,
  );
  assert.deepEqual(Object.keys(value).sort(), names.sort(), `${label} fields differ`);
}

/** Structural facts only; public identity and bytes are verified by their consumers. */
export function validateNativeSupplierArtifacts(value: unknown): NativeSupplierArtifact[] {
  assert.ok(Array.isArray(value), 'completed supplier artifacts need an array');
  const publications = new Map<string, CompletedPublication>();
  const keys = new Set<string>();
  return (value as NativeSupplierArtifact[]).map((raw) => {
    const sourceTag =
      typeof raw?.artifact === 'string' && raw.artifact.startsWith('swift-source-tag:');
    fields(
      raw,
      ['publication', 'artifact', 'file', ...(sourceTag ? ['source'] : [])],
      'completed supplier artifact',
    );
    const publication = validateNativeSupplierPublications([raw.publication])[0];
    assert.match(publication.product, /^[a-z][a-z0-9-]*$/u);
    assert.match(publication.version, /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/u);
    const owner = `${publication.product}@${publication.version}`;
    if (publications.has(owner))
      assert.deepEqual(publication, publications.get(owner), 'completed supplier source differs');
    publications.set(owner, publication);
    if (sourceTag) {
      assert.equal(publication.product, 'oliphaunt-swift', 'source-tag supplier owner differs');
      assert.equal(
        raw.artifact,
        `swift-source-tag:${publication.version}`,
        'source-tag supplier version differs',
      );
      assert.ok(raw.source, 'completed source-tag origin is missing');
      fields(raw.source, ['commit', 'tree', 'member', 'blob'], 'completed source-tag origin');
      for (const value of [raw.source.commit, raw.source.tree, raw.source.blob])
        assert.match(value, /^[a-f0-9]{40}$/u);
      safeRelative(raw.source.member);
    } else {
      assert.match(raw.artifact, /^(?:cargo|npm|maven|github-release):[^\u0000-\u001f\u007f]+$/u);
      safeRelative(raw.artifact.slice(raw.artifact.indexOf(':') + 1));
    }
    const key = `${publication.product}/${publication.version}/${raw.artifact}`;
    assert.ok(!keys.has(key), 'duplicate completed supplier artifact');
    keys.add(key);
    fields(raw.file, ['path', 'size', 'sha256'], 'completed supplier File');
    assert.ok(path.isAbsolute(raw.file.path), 'completed supplier needs an absolute retained File');
    assert.ok(Number.isSafeInteger(raw.file.size) && raw.file.size >= 0);
    assert.match(raw.file.sha256, /^[a-f0-9]{64}$/u);
    assert.match(path.basename(raw.file.path), /^[A-Za-z0-9][A-Za-z0-9._-]*$/u);
    return {
      publication,
      artifact: raw.artifact,
      ...(sourceTag ? { source: structuredClone(raw.source) } : {}),
      file: structuredClone(raw.file),
    };
  });
}

/** Safe File aliases are construction facts, never completed-publication authentication. */
export function projectNativeSupplierArtifacts(value: unknown) {
  const rows = validateNativeSupplierArtifacts(value);
  const artifacts: Record<string, NativeSupplierArtifact> = {};
  const files: { source: string; path: string; size: number; sha256: string }[] = [];
  const aliases = new Set<string>();
  for (const raw of rows) {
    const publication = raw.publication;
    const key = `${publication.product}/${publication.version}/${raw.artifact}`;
    const basename = path.basename(raw.file.path);
    if (raw.artifact.startsWith('github-release:'))
      assert.equal(
        basename,
        raw.artifact.slice('github-release:'.length),
        'completed asset filename differs',
      );
    const actual = fileIdentity(raw.file.path);
    assert.deepEqual(
      { size: actual.size, sha256: actual.sha256 },
      { size: raw.file.size, sha256: raw.file.sha256 },
      'completed supplier File bytes differ',
    );
    const alias = safeRelative(
      `supplier-artifacts/${publication.product}/${publication.version}/${raw.file.sha256}/${basename}`,
    );
    assert.ok(!aliases.has(alias), 'completed supplier File alias repeats');
    aliases.add(alias);
    artifacts[key] = {
      publication,
      artifact: raw.artifact,
      ...(raw.source ? { source: structuredClone(raw.source) } : {}),
      file: { ...raw.file, path: `@oliphaunt_metadata//:${alias}` },
    };
    files.push({
      source: raw.file.path,
      path: alias,
      size: raw.file.size,
      sha256: raw.file.sha256,
    });
  }
  return { artifacts, files };
}
