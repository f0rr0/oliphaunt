import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  CONTINUATION_DISPATCH_REQUEST_TIMEOUT_MS,
  MAX_CONTINUATION_DISPATCH_DELAY_SECONDS,
  buildDispatchRequest,
  continuationDelaySeconds,
  parseDispatchResponse,
  validateDispatchResponse,
} from "../../.github/scripts/dispatch-release-continuation.mjs";
import { releaseTransportTagName } from "../../.github/scripts/release-transport-ref.mjs";
import {
  RELEASE_CONTINUATION_DISPATCH_DELAY_DEADLINE_MS,
  RELEASE_CONTINUATION_DISPATCH_METADATA_READ_COUNT,
  RELEASE_CONTINUATION_DISPATCH_REQUEST_DEADLINE_MS,
  RELEASE_CONTINUATION_DISPATCH_RETRY_ENVELOPE_MS,
  RELEASE_CONTINUATION_DISPATCH_STEP_TIMEOUT_MINUTES,
} from "./release-continuation-read-budget.mjs";

const DISPATCH_SOURCE = readFileSync(
  new URL("../../.github/scripts/dispatch-release-continuation.mjs", import.meta.url),
  "utf8",
);

test("dispatch delay is bounded and honors a past not-before time", () => {
  assert.equal(
    MAX_CONTINUATION_DISPATCH_DELAY_SECONDS * 1000,
    RELEASE_CONTINUATION_DISPATCH_DELAY_DEADLINE_MS,
  );
  assert.equal(
    CONTINUATION_DISPATCH_REQUEST_TIMEOUT_MS,
    RELEASE_CONTINUATION_DISPATCH_REQUEST_DEADLINE_MS,
  );
  assert.ok(
    RELEASE_CONTINUATION_DISPATCH_STEP_TIMEOUT_MINUTES * 60_000
      > RELEASE_CONTINUATION_DISPATCH_RETRY_ENVELOPE_MS,
  );
  assert.equal(continuationDelaySeconds(100, 101), 0);
  assert.equal(continuationDelaySeconds(200, 100), 100);
  assert.throws(
    () => continuationDelaySeconds(100 + MAX_CONTINUATION_DISPATCH_DELAY_SECONDS + 1, 100),
    /maximum automatic dispatch delay/u,
  );
});

test("dispatch metadata reads remain inside the declared shared retry envelope", () => {
  const ghJsonCallSites = [...DISPATCH_SOURCE.matchAll(/\bghJson\s*\(/gu)].length - 1;
  const transportRefCalls = [...DISPATCH_SOURCE.matchAll(/\brequireReleaseTransportRef\s*\(/gu)].length - 1;
  const runtimeMetadataReads = ghJsonCallSites - 1 + transportRefCalls;
  assert.equal(
    runtimeMetadataReads,
    RELEASE_CONTINUATION_DISPATCH_METADATA_READ_COUNT,
    "count direct reads plus both calls through the immutable-transport helper",
  );
  assert.match(
    DISPATCH_SOURCE,
    /deadlineMs:\s*RELEASE_CONTINUATION_METADATA_READ_DEADLINE_MS/u,
  );
});

test("documented dispatch response binds the exact child run and repository", () => {
  const value = validateDispatchResponse({
    workflow_run_id: 456,
    run_url: "https://api.github.com/repos/f0rr0/oliphaunt/actions/runs/456",
    html_url: "https://github.com/f0rr0/oliphaunt/actions/runs/456",
  }, { repo: "f0rr0/oliphaunt", parentRunId: 123 });
  assert.equal(value.childRunId, 456);
  assert.throws(
    () => validateDispatchResponse({
      workflow_run_id: 123,
      run_url: "https://api.github.com/repos/f0rr0/oliphaunt/actions/runs/123",
      html_url: "https://github.com/f0rr0/oliphaunt/actions/runs/123",
    }, { repo: "f0rr0/oliphaunt", parentRunId: 123 }),
    /parent run id/u,
  );
  assert.throws(
    () => validateDispatchResponse({
      workflow_run_id: 456,
      run_url: "https://api.github.com/repos/evil/repo/actions/runs/456",
      html_url: "https://github.com/f0rr0/oliphaunt/actions/runs/456",
    }, { repo: "f0rr0/oliphaunt", parentRunId: 123 }),
    /do not bind/u,
  );
});

test("dispatch transport requires the documented HTTP 200 response", () => {
  assert.deepEqual(
    parseDispatchResponse(
      "HTTP/2.0 200 OK\r\ncontent-type: application/json\r\n\r\n"
        + '{"workflow_run_id":456,"run_url":"api","html_url":"html"}',
    ),
    { workflow_run_id: 456, run_url: "api", html_url: "html" },
  );
  assert.throws(
    () => parseDispatchResponse("HTTP/2.0 202 Accepted\ncontent-type: application/json\n\n{}"),
    /must be HTTP 200/u,
  );
  assert.throws(
    () => parseDispatchResponse("{}"),
    /did not include one HTTP header block/u,
  );
});

test("dispatch opts into the 2026 Actions response contract and one canonical pointer input", () => {
  const pointer = {
    operation: "publish",
    releaseCommit: "a".repeat(40),
    pointerDigest: "b".repeat(64),
  };
  const request = buildDispatchRequest("f0rr0/oliphaunt", pointer);
  assert.ok(request.args.includes("--include"));
  assert.ok(request.args.includes("X-GitHub-Api-Version: 2026-03-10"));
  assert.equal(request.args.includes("X-GitHub-Api-Version: 2022-11-28"), false);
  assert.deepEqual(JSON.parse(request.payload), {
    ref: releaseTransportTagName(pointer.releaseCommit),
    return_run_details: true,
    inputs: {
      operation: "publish",
      release_commit: "a".repeat(40),
      continuation_pointer: JSON.stringify(pointer),
    },
  });
  assert.doesNotMatch(DISPATCH_SOURCE, /git\/ref\/heads\/main|ref:\s*["']main["']/u);
  assert.match(DISPATCH_SOURCE, /validateReleaseTransportRef\(ref, releaseCommit\)/u);
});
