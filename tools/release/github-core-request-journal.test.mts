import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  GITHUB_CORE_REQUEST_ROLLING_CEILING,
  GITHUB_CORE_REQUEST_ROLLING_WINDOW_MS,
  readGitHubCoreRequestJournal,
  reserveGitHubCoreRequest,
} from './github-core-request-journal.mts';
import { requestGithubRepositoryJson } from './github-read.mts';

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'oliphaunt-core-request-journal-'));
  const environment = {
    GITHUB_ACTIONS: 'true',
    GITHUB_REPOSITORY: 'f0rr0/oliphaunt',
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_RUN_ID: '123',
    GITHUB_SHA: 'a'.repeat(40),
    OLIPHAUNT_GITHUB_CORE_REQUEST_JOURNAL_PATH: path.join(root, 'journal.json'),
  };
  return { environment, root };
}

test('durable core-request journal refuses the operational ceiling before attempt 901', async () => {
  const { environment, root } = fixture();
  let nowMs = 10_000;
  try {
    for (let index = 0; index < GITHUB_CORE_REQUEST_ROLLING_CEILING; index += 1) {
      const result = await reserveGitHubCoreRequest({
        environment,
        label: `attempt ${index + 1}`,
        now: () => nowMs,
      });
      expect(result.sequence).toBe(index + 1);
    }
    expect(readGitHubCoreRequestJournal({ environment, now: () => nowMs }).rollingCount).toBe(900);
    await expect(
      (async () =>
        await reserveGitHubCoreRequest({
          environment,
          label: 'attempt 901',
          now: () => nowMs,
        }))(),
    ).rejects.toThrow(/900 attempts already occupy the 60-minute safety window/u);

    nowMs += GITHUB_CORE_REQUEST_ROLLING_WINDOW_MS + 1;
    const admitted = await reserveGitHubCoreRequest({
      environment,
      label: 'new rolling window',
      now: () => nowMs,
    });
    expect(admitted.sequence).toBe(901);
    expect(admitted.rollingCount).toBe(1);
    const state = JSON.parse(
      readFileSync(environment.OLIPHAUNT_GITHUB_CORE_REQUEST_JOURNAL_PATH, 'utf8'),
    );
    expect(state.attempts).toEqual([nowMs]);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('rolling timestamps preserve the boundary and reject clock reversal or corrupt lineage', async () => {
  const { environment, root } = fixture();
  const file = environment.OLIPHAUNT_GITHUB_CORE_REQUEST_JOURNAL_PATH;
  try {
    await reserveGitHubCoreRequest({ environment, label: 'first', now: () => 1000 });
    const boundary = 1000 + GITHUB_CORE_REQUEST_ROLLING_WINDOW_MS;
    expect(readGitHubCoreRequestJournal({ environment, now: () => boundary }).rollingCount).toBe(1);
    expect(
      readGitHubCoreRequestJournal({ environment, now: () => boundary + 1 }).rollingCount,
    ).toBe(0);
    await expect(
      reserveGitHubCoreRequest({ environment, label: 'backwards', now: () => 999 }),
    ).rejects.toThrow('clock moved backwards');
    const valid = readFileSync(file, 'utf8');
    for (const change of [
      { headSha: 'b'.repeat(40) },
      { attempts: [-1] },
      { attempts: [1001, 1000], sequence: 2 },
      { attempts: [], sequence: 1 },
      { sequence: Number.MAX_SAFE_INTEGER },
    ]) {
      writeFileSync(file, JSON.stringify({ ...JSON.parse(valid), ...change }));
      const before = readFileSync(file, 'utf8');
      await expect(
        reserveGitHubCoreRequest({ environment, label: 'invalid', now: () => 2000 }),
      ).rejects.toThrow();
      expect(readFileSync(file, 'utf8')).toBe(before);
    }
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('every retried GitHub read attempt is durably reserved', async () => {
  const { environment, root } = fixture();
  let calls = 0;
  try {
    const output = await requestGithubRepositoryJson('repos/f0rr0/oliphaunt/releases/1', {
      baseDelayMs: 0,
      coreJournalOptions: { now: () => 20_000 },
      environment,
      maxAttempts: 3,
      maxDelayMs: 0,
      now: () => 20_000,
      sleep: () => {},
      fetchImpl: () => {
        calls += 1;
        return calls < 3 ? new Response('', { status: 503 }) : Response.json({});
      },
    });
    expect(output).toEqual({});
    expect(calls).toBe(3);
    expect(readGitHubCoreRequestJournal({ environment, now: () => 20_000 })).toMatchObject({
      rollingCount: 3,
      sequence: 3,
    });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
