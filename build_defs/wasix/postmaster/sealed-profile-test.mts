import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { verifyReceipt } from '../../../src/wasix/postmaster/wasmer/bin/verify-postmaster-concurrency-contract.mts';
import { parseStrictJson } from '../../../tools/packaging/strict-json.mts';

assert.equal(process.argv.length, 5, 'usage: sealed-profile-test.mts SEED SEALED_TREE PROFILE');
const [seed, sealed, projection] = process.argv.slice(2);
const profile = parseStrictJson(readFileSync(projection, 'utf8'));
assert.deepEqual(Object.keys(profile).sort(), [
  'expected_final_fences',
  'expected_seed_fences',
  'profile',
]);
assert.equal(profile.profile, 'release-o3');
for (const field of ['expected_seed_fences', 'expected_final_fences'])
  assert(Number.isSafeInteger(profile[field]) && profile[field] >= 4);
verifyReceipt(
  readFileSync(
    join(sealed, 'share/postgresql/wasix-postmaster.sealed-export.concurrency.seed.receipt'),
    'utf8',
  ),
  readFileSync(seed),
  profile.expected_seed_fences,
);
verifyReceipt(
  readFileSync(join(sealed, 'share/postgresql/wasix-postmaster.concurrency.receipt'), 'utf8'),
  readFileSync(join(sealed, 'bin/postgres')),
  profile.expected_final_fences,
);
console.log(
  `Canonical release-o3 fence counts verified: seed=${profile.expected_seed_fences}, sealed=${profile.expected_final_fences}`,
);
