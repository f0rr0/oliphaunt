import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { qualificationProfile } from './qualification-profile.mts';

const source = readFileSync(
  new URL('../../../src/wasix/postmaster/lib/common.sh', import.meta.url),
  'utf8',
);

test('projects only selected canonical expectations, ignoring unused driver text', () => {
  const observed = qualificationProfile(source);
  assert.equal(observed.profile, 'release-o3');
  assert.deepEqual(
    qualificationProfile(`# unrelated driver comment\n${source}\n# another comment\n`),
    observed,
  );
  const selected = source.match(/^ {4}release-o3\)\n([\s\S]*?)^ {6};;$/mu)[0];
  const expectations = [
    ...selected.matchAll(/EXPECTED_(?:FINAL_)?ATOMIC_FENCE_TOTAL="([0-9]+)"/gu),
  ].map((row) => Number(row[1]));
  assert.deepEqual([observed.expected_seed_fences, observed.expected_final_fences], expectations);
});

test('rejects missing, ambiguous and unpinned qualification clauses', () => {
  const selected = source.match(/^ {4}release-o3\)\n([\s\S]*?)^ {6};;$/mu)[0];
  assert.throws(() => qualificationProfile(source.replace(selected, '')));
  assert.throws(() => qualificationProfile(`${source}\n${selected}\n`));
  assert.throws(() =>
    qualificationProfile(
      source.replace(
        selected,
        selected.replace(/(EXPECTED_ATOMIC_FENCE_TOTAL=)"[0-9]+"/u, '$1"$override"'),
      ),
    ),
  );
  assert.throws(() =>
    qualificationProfile(
      source.replace(
        selected,
        selected.replace(
          /(^ {6}FRESH_WASIX_CORE_PROFILE_EXPECTED_ATOMIC_FENCE_TOTAL=.*)$/mu,
          '$1\n$1',
        ),
      ),
    ),
  );
});
