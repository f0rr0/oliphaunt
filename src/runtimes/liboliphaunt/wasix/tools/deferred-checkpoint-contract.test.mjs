import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const patchUrl = new URL(
  '../assets/build/postgres/patches/0027-oliphaunt-wasix-defer-xlog-size-checkpoint-requests.patch',
  import.meta.url,
);
const topologyPatchUrl = new URL(
  '../assets/build/postgres/patches/0029-oliphaunt-wasix-model-trusted-embedded-session.patch',
  import.meta.url,
);
const seriesUrl = new URL('../assets/build/postgres/patches/series', import.meta.url);

function assertOrdered(text, markers) {
  let cursor = -1;
  for (const marker of markers) {
    const next = text.indexOf(marker, cursor + 1);
    assert.notEqual(next, -1, `missing ordered marker ${JSON.stringify(marker)}`);
    assert.ok(next > cursor, `${JSON.stringify(marker)} is out of order`);
    cursor = next;
  }
}

function diffSection(patch, relativePath) {
  const marker = `diff --git a/${relativePath} b/${relativePath}`;
  const start = patch.indexOf(marker);
  assert.notEqual(start, -1, `missing diff for ${relativePath}`);
  const end = patch.indexOf('\ndiff --git ', start + marker.length);
  return patch.slice(start, end === -1 ? undefined : end);
}

test('XLogWrite records pressure and the safe point owns checkpoint execution', async () => {
  const patch = await readFile(patchUrl, 'utf8');
  const xlog = diffSection(patch, 'src/backend/access/transam/xlog.c');
  const postgres = diffSection(patch, 'src/backend/tcop/postgres.c');

  assert.match(patch, /Subject: \[PATCH\] oliphaunt-wasix: defer XLog-size checkpoint requests/u);
  assertOrdered(xlog, [
    'static bool oliphaunt_wasix_checkpoint_deferred = false;',
    'OliphauntWasixPerformDeferredCheckpoint(void)',
    'if (!oliphaunt_wasix_checkpoint_deferred)',
    'return;',
    'RequestCheckpoint(CHECKPOINT_CAUSE_XLOG);',
    'oliphaunt_wasix_checkpoint_deferred = false;',
  ]);
  assertOrdered(xlog, [
    'if (XLogCheckpointNeeded(openLogSegNo))',
    '(void) GetRedoRecPtr();',
    'if (XLogCheckpointNeeded(openLogSegNo))',
    'oliphaunt_wasix_checkpoint_deferred = true;',
  ]);
  assertOrdered(postgres, [
    'PostgresSendReadyForQueryIfNecessary(void)',
    'else',
    'long\t\tstats_timeout;',
    'OliphauntWasixPerformDeferredCheckpoint();',
    'Process incoming notifies',
  ]);

  assert.equal(
    (postgres.match(/^\+.*OliphauntWasixPerformDeferredCheckpoint\(\);/gmu) ?? []).length,
    1,
  );
});

test('checkpoint failure remains pending for PostgreSQL recovery to retry', async () => {
  const patch = await readFile(patchUrl, 'utf8');
  const xlog = diffSection(patch, 'src/backend/access/transam/xlog.c');
  const functionStart = xlog.indexOf('OliphauntWasixPerformDeferredCheckpoint(void)');
  const request = xlog.indexOf('RequestCheckpoint(CHECKPOINT_CAUSE_XLOG);');
  const clear = xlog.indexOf('oliphaunt_wasix_checkpoint_deferred = false;', request);

  assert.notEqual(functionStart, -1);
  assert.notEqual(request, -1);
  assert.ok(clear > request, 'the pending flag must clear only after RequestCheckpoint returns');
  assert.doesNotMatch(
    xlog.slice(functionStart, request),
    /oliphaunt_wasix_checkpoint_deferred = false;/u,
  );
});

test('truthful standalone topology provides the local RequestCheckpoint branch', async () => {
  const [patch, topologyPatch, series] = await Promise.all([
    readFile(patchUrl, 'utf8'),
    readFile(topologyPatchUrl, 'utf8'),
    readFile(seriesUrl, 'utf8'),
  ]);

  assert.doesNotMatch(patch, /diff --git a\/src\/backend\/postmaster\/checkpointer\.c/u);
  assert.match(patch, /upstream\nRequestCheckpoint already performs the requested checkpoint locally/u);
  assert.match(topologyPatch, /Keep IsPostmasterEnvironment and IsUnderPostmaster truthful/u);
  assert.doesNotMatch(topologyPatch, /IsPostmasterEnvironment\s*=\s*true/u);
  assert.doesNotMatch(topologyPatch, /IsUnderPostmaster\s*=\s*true/u);

  const checkpointIndex = series.indexOf(
    '0027-oliphaunt-wasix-defer-xlog-size-checkpoint-requests.patch',
  );
  const topologyIndex = series.indexOf(
    '0029-oliphaunt-wasix-model-trusted-embedded-session.patch',
  );
  assert.ok(checkpointIndex >= 0 && topologyIndex > checkpointIndex);
});
