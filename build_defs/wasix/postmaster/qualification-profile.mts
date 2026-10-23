import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';

export function qualificationProfile(contents: string) {
  const clauses = [...contents.matchAll(/^ {4}release-o3\)\n([\s\S]*?)^ {6};;$/gmu)];
  assert.equal(clauses.length, 1, 'expected one canonical release-o3 clause');
  const get = (key: string) => {
    const values = [...clauses[0][1].matchAll(new RegExp(`^      ${key}="([0-9]+)"$`, 'gmu'))];
    assert.equal(values.length, 1, `expected one canonical ${key} assignment`);
    const value = Number(values[0][1]);
    assert(Number.isSafeInteger(value) && value >= 4, 'invalid canonical fence count');
    return value;
  };
  return {
    profile: 'release-o3',
    expected_seed_fences: get('FRESH_WASIX_CORE_PROFILE_EXPECTED_ATOMIC_FENCE_TOTAL'),
    expected_final_fences: get('FRESH_WASIX_CORE_PROFILE_EXPECTED_FINAL_ATOMIC_FENCE_TOTAL'),
  };
}

if (import.meta.main) {
  assert.equal(process.argv.length, 4, 'usage: qualification-profile.mts COMMON OUTPUT');
  writeFileSync(
    process.argv[3],
    `${JSON.stringify(qualificationProfile(readFileSync(process.argv[2], 'utf8')))}\n`,
  );
}
