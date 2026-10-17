import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { WASIX_PORTABLE_RELEASE_MEMBERS } from '../../src/wasix/runtime/tools/wasix-runtime-npm-contract.mts';
import { wasixRuntimeNpmPayloadInputs } from '../../src/wasix/runtime/tools/wasix-runtime-npm-payload.mts';
import {
  extractPortableArchiveTree,
  readPortableArchiveEntries,
} from '../../tools/packaging/portable-archive.mts';
import { materializeArchive } from './shared.mts';

export type WasixBootstrapRecipe = {
  schema: 'oliphaunt-wasix-bootstrap-recipe-v1';
  profile: 'standard' | 'icu';
  command: string;
  workingDirectory: string;
  arguments: string[];
  environment: [string, string][];
};

/** The declared runner describes the same guest recipe it actually executes. */
export function parseWasixBootstrapRecipe(text: string, profile: 'standard' | 'icu') {
  assert.ok(Buffer.byteLength(text) <= 64 * 1024, 'WASIX bootstrap recipe is not bounded');
  const recipe = JSON.parse(text);
  assert.ok(
    recipe && typeof recipe === 'object' && !Array.isArray(recipe),
    'invalid WASIX bootstrap recipe',
  );
  assert.deepEqual(
    Object.keys(recipe).sort(),
    ['schema', 'profile', 'command', 'workingDirectory', 'arguments', 'environment'].sort(),
    'WASIX bootstrap recipe fields differ',
  );
  assert.equal(
    recipe.schema,
    'oliphaunt-wasix-bootstrap-recipe-v1',
    'unsupported WASIX bootstrap recipe',
  );
  assert.equal(recipe.profile, profile, 'WASIX bootstrap recipe profile differs');
  const string = (value: unknown): value is string =>
    typeof value === 'string' && !/[\u0000-\u001f\u007f]/u.test(value);
  assert.ok(string(recipe.command) && recipe.command, 'WASIX bootstrap recipe needs its command');
  assert.ok(
    string(recipe.workingDirectory) &&
      recipe.workingDirectory.startsWith('/') &&
      !recipe.workingDirectory.split('/').some((part: string) => part === '.' || part === '..'),
    'WASIX bootstrap recipe needs its guest working directory',
  );
  assert.ok(
    Array.isArray(recipe.arguments) && recipe.arguments.length && recipe.arguments.every(string),
    'invalid WASIX bootstrap arguments',
  );
  assert.ok(
    Array.isArray(recipe.environment) && recipe.environment.length,
    'invalid WASIX bootstrap environment',
  );
  const names = new Set<string>();
  for (const row of recipe.environment) {
    assert.ok(
      Array.isArray(row) &&
        row.length === 2 &&
        string(row[0]) &&
        /^[A-Za-z_][A-Za-z_0-9]*$/u.test(row[0]) &&
        string(row[1]),
      'invalid WASIX bootstrap environment entry',
    );
    assert.ok(!names.has(row[0]), 'duplicate WASIX bootstrap environment entry');
    names.add(row[0]);
  }
  return recipe as WasixBootstrapRecipe;
}

/** Project the actual completed archive; current payload directories remain unchanged. */
export function wasixRuntimeInputs(source: string, work: string): string {
  if (!statSync(source).isFile()) return source;
  const entries = readPortableArchiveEntries(realpathSync(source));
  const output = path.join(work, 'admitted-runtime');
  mkdirSync(output, { recursive: true });
  for (const [name, member] of Object.entries(WASIX_PORTABLE_RELEASE_MEMBERS)) {
    const file = entries.get(member);
    assert.ok(file?.isFile, `admitted WASIX runtime needs regular ${member}`);
    writeFileSync(
      path.join(output, name === 'manifest' ? 'manifest.json' : 'oliphaunt.wasix.tar.zst'),
      file.data(),
    );
  }
  return output;
}

/** Consume the existing canonical core archive/manifest, never walk its tree aliases. */
export function extractWasixRuntime(source: string, work: string): string {
  source = wasixRuntimeInputs(source, work);
  const archive = path.join(source, 'oliphaunt.wasix.tar.zst');
  wasixRuntimeNpmPayloadInputs({
    manifestBytes: readFileSync(path.join(source, 'manifest.json')),
    runtimeBytes: readFileSync(archive),
    label: 'declared WASIX seed runtime',
  });
  const destination = path.join(work, 'runtime');
  extractPortableArchiveTree(materializeArchive(archive, path.join(work, 'inputs')), destination);
  return path.join(destination, 'oliphaunt');
}
