import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import type { NativeCurrentArtifact } from '../../tools/release/native-extension-final-inputs.mts';

export type ConstructorPhase = 'source' | 'windows-v8' | 'package';
export type ConstructorKind = 'module' | 'aot';

const escapes: Record<string, string> = { _: '_u', '/': '_s', ':': '_c', '+': '_p' };
const unescapes = Object.fromEntries(Object.entries(escapes).map(([key, value]) => [value, key]));

function sourceLabel(value: string) {
  assert.match(
    value,
    /^\/\/[A-Za-z0-9_./+-]*:[A-Za-z0-9_.+-]+$/u,
    'Expected source constructor label',
  );
  const directory = value.slice(2, value.indexOf(':'));
  assert.ok(
    !directory || directory.split('/').every((part) => part && part !== '.' && part !== '..'),
    'Constructor label needs a canonical package',
  );
  return value;
}

/** Safe, injective Cargo-independent private identity derived from its actual source label. */
export function constructorName(kind: ConstructorKind, label: string): string {
  return `wasix-${kind}-${sourceLabel(label)
    .slice(2)
    .replace(/[_/:+]/gu, (char) => escapes[char])}`;
}

/**
 * Routing only. The existing metadata importer has already authenticated the
 * snapshot's source/producer and verified each whole original File's hash.
 */
export function projectConstructorInputs(
  phase: string,
  current: Record<string, NativeCurrentArtifact> | null,
) {
  assert.ok(['source', 'windows-v8', 'package'].includes(phase), 'Unknown WASIX constructor phase');
  if (phase !== 'source')
    assert.ok(current, 'WASIX constructor imports need the current-source snapshot');
  const modules: Record<string, NativeCurrentArtifact> = {};
  const aotImages: Record<string, NativeCurrentArtifact> = {};
  for (const row of Object.values(current ?? {})) {
    if (!row.artifact.startsWith('constructor:wasix-')) continue;
    const match = row.artifact.match(/^constructor:wasix-(module|aot)-([A-Za-z0-9._-]+)$/u);
    assert.ok(match, 'Unknown WASIX constructor identity');
    const kind = match[1] as ConstructorKind;
    const label = sourceLabel(
      `//${match[2].replace(/_[uscp]/gu, (encoded) => unescapes[encoded])}`,
    );
    assert.equal(
      row.artifact,
      `constructor:${constructorName(kind, label)}`,
      'Noncanonical constructor identity',
    );
    assert.equal(row.file.member, undefined, 'Constructor import requires the whole original File');
    assert.ok(
      row.file.path.startsWith('@oliphaunt_metadata//:native-current-artifacts/'),
      'Constructor import requires the verified metadata File alias',
    );
    if (kind === 'module')
      assert.equal(row.configuration, 'portable', 'Portable constructor configuration differs');
    const selected = kind === 'module' ? modules : aotImages;
    assert.ok(!Object.hasOwn(selected, label), `Constructor source repeats: ${label}`);
    selected[label] = row;
  }
  return { phase: phase as ConstructorPhase, modules, aotImages };
}

if (import.meta.main) {
  const [phase, input, output] = process.argv.slice(2);
  assert.ok(phase && input && output, 'Expected phase, current artifact projection and output');
  writeFileSync(
    output,
    JSON.stringify(projectConstructorInputs(phase, JSON.parse(readFileSync(input, 'utf8')))),
  );
}
