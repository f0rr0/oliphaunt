import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  GITHUB_CORE_REQUEST_ROLLING_CEILING,
  GITHUB_CORE_REQUEST_ROLLING_WINDOW_MS,
  readGitHubCoreRequestJournal,
  reserveGitHubCoreRequestSync,
} from "./github-core-request-journal.mjs";
import { runGitHubReadSync } from "./github-read.mjs";

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-core-request-journal-"));
  const environment = {
    GITHUB_ACTIONS: "true",
    GITHUB_REPOSITORY: "f0rr0/oliphaunt",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_RUN_ID: "123",
    GITHUB_SHA: "a".repeat(40),
    OLIPHAUNT_GITHUB_CORE_REQUEST_JOURNAL_PATH: path.join(root, "journal.json"),
  };
  return { environment, root };
}

test("durable core-request journal refuses the operational ceiling before attempt 901", () => {
  const { environment, root } = fixture();
  let nowMs = 10_000;
  try {
    for (let index = 0; index < GITHUB_CORE_REQUEST_ROLLING_CEILING; index += 1) {
      const result = reserveGitHubCoreRequestSync({
        environment,
        label: `attempt ${index + 1}`,
        now: () => nowMs,
      });
      expect(result.sequence).toBe(index + 1);
    }
    expect(readGitHubCoreRequestJournal({ environment, now: () => nowMs }).rollingCount).toBe(900);
    expect(() => reserveGitHubCoreRequestSync({
      environment,
      label: "attempt 901",
      now: () => nowMs,
    })).toThrow(/900 attempts already occupy the 60-minute safety window/u);

    nowMs += GITHUB_CORE_REQUEST_ROLLING_WINDOW_MS + 1;
    const admitted = reserveGitHubCoreRequestSync({
      environment,
      label: "new rolling window",
      now: () => nowMs,
    });
    expect(admitted.sequence).toBe(901);
    expect(admitted.rollingCount).toBe(1);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("every retried GitHub read attempt is durably reserved", () => {
  const { environment, root } = fixture();
  let calls = 0;
  try {
    const output = runGitHubReadSync(
      ["api", "repos/f0rr0/oliphaunt/releases/1"],
      {
        baseDelayMs: 0,
        coreJournalOptions: { now: () => 20_000 },
        environment,
        maxAttempts: 3,
        maxDelayMs: 0,
        now: () => 20_000,
        spawn: () => {
          calls += 1;
          return calls < 3
            ? { status: 1, stderr: "temporary failure", stdout: "" }
            : { status: 0, stderr: "", stdout: "{}" };
        },
      },
    );
    expect(output).toBe("{}");
    expect(calls).toBe(3);
    expect(readGitHubCoreRequestJournal({ environment, now: () => 20_000 })).toMatchObject({
      rollingCount: 3,
      sequence: 3,
    });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("core-request journal follows verified root lineage and rejects replacement", () => {
  const { environment, root } = fixture();
  try {
    reserveGitHubCoreRequestSync({ environment, label: "first", now: () => 30_000 });
    expect(readGitHubCoreRequestJournal({
      environment: {
        ...environment,
        GITHUB_RUN_ATTEMPT: "2",
        GITHUB_RUN_ID: "456",
        OLIPHAUNT_RELEASE_ROOT_RUN_ID: "123",
      },
      now: () => 30_000,
    }).sequence).toBe(1);
    expect(() => readGitHubCoreRequestJournal({
      environment: {
        ...environment,
        GITHUB_RUN_ATTEMPT: "2",
        GITHUB_RUN_ID: "456",
        OLIPHAUNT_RELEASE_ROOT_RUN_ID: "122",
      },
      now: () => 30_000,
    })).toThrow(/rootRunId does not match the current release lineage/u);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
