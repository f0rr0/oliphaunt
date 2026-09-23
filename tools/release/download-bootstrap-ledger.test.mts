import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { zipArchive } from '../packaging/testdata/zip-fixture.mts';
import {
  selectEarlierAttemptArtifact,
  validateAttemptMetadata,
} from '../../.github/scripts/download-bootstrap-ledger.mts';

const SHA = 'a'.repeat(40);
const cases = [
  'earlier',
  'wrong-sha',
  'current-only',
  'transient',
  'truncated',
  'identity-mismatch',
  'collision',
];
function checkpoint(sequence, fill) {
  return `checkpoint-${String(sequence).padStart(6, '0')}-${fill.repeat(64)}.json`;
}
function artifact(id, createdAt, updatedAt = createdAt, extra = {}) {
  return {
    digest: `sha256:${'a'.repeat(64)}`,
    id,
    name: 'oliphaunt-bootstrap-ledger',
    expired: false,
    size_in_bytes: 1,
    created_at: createdAt,
    updated_at: updatedAt,
    workflow_run: { id: 900 },
    ...extra,
  };
}
if (process.argv[2] === 'prepare') {
  const root = process.argv[3];
  for (const name of cases) {
    const directory = path.join(root, name);
    mkdirSync(directory, { recursive: true });
    const zips = {};
    function zip(id, sequence, fill) {
      const file = path.join(directory, `${id}.zip`);
      writeFileSync(
        file,
        zipArchive([{ name: checkpoint(sequence, fill), data: `remote-${id}\n` }]),
      );
      zips[id] = file;
    }
    let artifacts = [artifact(101, '2026-07-15T09:00:00Z')];
    zip(101, 7, 'a');
    if (name === 'earlier') {
      artifacts.push(artifact(202, '2026-07-15T10:00:01Z'));
      zip(202, 9, 'c');
    } else if (name === 'wrong-sha') {
      artifacts = [
        artifact(101, '2026-07-15T09:00:00Z', undefined, {
          workflow_run: { id: 900, head_sha: 'b'.repeat(40) },
        }),
      ];
    } else if (name === 'current-only') {
      artifacts = [artifact(202, '2026-07-15T10:00:01Z')];
      zip(202, 9, 'c');
    }
    if (['truncated', 'identity-mismatch', 'collision'].includes(name)) {
      mkdirSync(path.join(directory, 'destination'));
      writeFileSync(path.join(directory, 'destination', checkpoint(8, 'b')), 'durable\n');
      if (name === 'collision') zip(101, 8, 'b');
    }
    writeFileSync(path.join(directory, 'github-output'), '');
    const environment = {
      BOOTSTRAP_LEDGER_PATH: path.join(directory, 'destination'),
      FAKE_ARTIFACTS_BY_RUN: JSON.stringify({ 900: artifacts }),
      FAKE_ATTEMPT_METADATA: JSON.stringify({
        id: 900,
        run_attempt: 2,
        run_started_at: '2026-07-15T10:00:00Z',
        head_sha: SHA,
        event: 'workflow_dispatch',
      }),
      FAKE_CURRENT_RUN: JSON.stringify({
        id: 900,
        workflow_id: 42,
        head_sha: SHA,
        event: 'workflow_dispatch',
        created_at: '2026-07-15T10:00:00Z',
        status: 'in_progress',
      }),
      FAKE_DOWNLOAD_MODE: ['transient', 'truncated', 'identity-mismatch'].includes(name)
        ? name
        : 'success',
      FAKE_DOWNLOAD_STATE: path.join(directory, 'download-state'),
      FAKE_GH_LOG: path.join(directory, 'gh.log'),
      FAKE_ZIPS_BY_ARTIFACT: JSON.stringify(zips),
      GH_REPO: 'f0rr0/oliphaunt',
      GH_TOKEN: 'test-token',
      GITHUB_OUTPUT: path.join(directory, 'github-output'),
      GITHUB_REPOSITORY: 'f0rr0/oliphaunt',
      GITHUB_RUN_ATTEMPT: '2',
      GITHUB_RUN_ID: '900',
      GITHUB_SHA: SHA,
      RELEASE_HEAD_SHA: 'b'.repeat(40),
      OLIPHAUNT_GITHUB_READ_BASE_DELAY_MS: '0',
      OLIPHAUNT_GITHUB_READ_MAX_DELAY_MS: '0',
    };
    writeFileSync(
      path.join(directory, 'environment'),
      Object.entries(environment)
        .map(([key, value]) => `${key}=${value}\0`)
        .join(''),
    );
  }
  process.exit(0);
}

test('attempt boundary uses creation and update time and binds the release SHA', () => {
  const selected = selectEarlierAttemptArtifact(
    [
      artifact(101, '2026-07-15T09:00:00Z', '2026-07-15T09:30:00Z'),
      artifact(102, '2026-07-15T09:10:00Z', '2026-07-15T10:00:00Z'),
      artifact(103, '2026-07-15T09:20:00Z', '2026-07-15T09:40:00Z'),
    ],
    { runId: '900', currentAttemptStartedAt: '2026-07-15T10:00:00Z' },
  );
  assert.equal(selected.artifact.id, 103);
  assert.deepEqual(selected.excludedCurrentAttemptIds, ['102']);
  assert.throws(
    () =>
      selectEarlierAttemptArtifact([artifact(104, 'invalid')], {
        runId: '900',
        currentAttemptStartedAt: '2026-07-15T10:00:00Z',
      }),
    /created_at must be a UTC timestamp/u,
  );
  assert.throws(
    () =>
      validateAttemptMetadata(
        {
          id: 900,
          run_attempt: 2,
          run_started_at: '2026-07-15T10:00:00Z',
          head_sha: 'b'.repeat(40),
          event: 'workflow_dispatch',
        },
        { runId: '900', attempt: 2, sha: SHA },
      ),
    /wrong release SHA/u,
  );
});
for (const name of cases) {
  test(`bootstrap ledger CLI: ${name}`, () => {
    const root = process.env.OLIPHAUNT_LEDGER_TEST_ROOT;
    if (!root) throw new Error('Run bash tools/release/download-bootstrap-ledger.test.sh');
    const directory = path.join(root, name);
    const result = readFileSync(path.join(directory, 'result'), 'utf8');
    const status = Number(readFileSync(path.join(directory, 'status'), 'utf8'));
    const calls = readFileSync(path.join(directory, 'gh.log'), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const downloads = calls
      .map((url) => /\/artifacts\/([0-9]+)\/zip$/u.exec(url)?.[1])
      .filter(Boolean);
    const output = readFileSync(path.join(directory, 'github-output'), 'utf8');
    const destination = path.join(directory, 'destination');
    if (name === 'earlier' || name === 'transient') {
      assert.equal(status, 0, result);
      assert.deepEqual(downloads, name === 'transient' ? ['101', '101'] : ['101']);
      assert.deepEqual(readdirSync(destination), [checkpoint(7, 'a')]);
      assert.equal(
        readFileSync(path.join(destination, checkpoint(7, 'a')), 'utf8'),
        'remote-101\n',
      );
      assert.equal(output, 'found=true\nrun_id=900\n');
    } else {
      assert.equal(status, 1, result);
      assert.equal(output, '');
      if (name === 'wrong-sha' || name === 'current-only') {
        assert.deepEqual(downloads, []);
        assert.match(
          result,
          name === 'wrong-sha'
            ? /artifact disagrees with its exact-SHA binding/u
            : /no artifact can be proven to predate the attempt.*refusing genesis/u,
        );
      } else {
        assert.deepEqual(readdirSync(destination), [checkpoint(8, 'b')]);
        assert.equal(readFileSync(path.join(destination, checkpoint(8, 'b')), 'utf8'), 'durable\n');
        assert.match(
          result,
          name === 'collision' ? /prior checkpoint conflicts/u : /retry budget exhausted/u,
        );
        if (name === 'identity-mismatch') assert.match(result, /transport identity mismatch/u);
        if (name !== 'collision')
          assert.equal(readFileSync(path.join(directory, 'download-state'), 'utf8'), '4');
      }
    }
    assert.equal(
      readdirSync(directory).some((entry) => entry.startsWith('.destination.')),
      false,
    );
    assert.equal(existsSync(path.join(destination, '.artifact.zip')), false);
  });
}
