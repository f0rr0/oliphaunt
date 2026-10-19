import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isolatedGitHubTestEnvironment as mutationTestEnvironment } from './testdata/isolated-github-test-environment.mts';

test('release mutation tests cannot consume a live publish request journal', () => {
  assert.deepEqual(
    mutationTestEnvironment(
      {},
      {
        GITHUB_ACTIONS: 'true',
        GITHUB_REPOSITORY: 'f0rr0/oliphaunt',
        GITHUB_RUN_ID: '30593859032',
        KEEP_ME: 'preserved',
        OLIPHAUNT_GITHUB_CORE_REQUEST_JOURNAL_PATH: '/live/journal.json',
        OLIPHAUNT_REQUIRE_GITHUB_CORE_REQUEST_JOURNAL: 'true',
        RELEASE_HEAD_SHA: 'a'.repeat(40),
      },
    ),
    { KEEP_ME: 'preserved' },
  );
});
