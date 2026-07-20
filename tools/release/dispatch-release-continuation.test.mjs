import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_CONTINUATION_DISPATCH_DELAY_SECONDS,
  buildDispatchRequest,
  continuationDelaySeconds,
  parseDispatchResponse,
  validateDispatchResponse,
} from "../../.github/scripts/dispatch-release-continuation.mjs";

test("dispatch delay is bounded and honors a past not-before time", () => {
  assert.equal(continuationDelaySeconds(100, 101), 0);
  assert.equal(continuationDelaySeconds(200, 100), 100);
  assert.throws(
    () => continuationDelaySeconds(100 + MAX_CONTINUATION_DISPATCH_DELAY_SECONDS + 1, 100),
    /maximum automatic dispatch delay/u,
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
    ref: "main",
    inputs: {
      operation: "publish",
      release_commit: "a".repeat(40),
      continuation_pointer: JSON.stringify(pointer),
    },
  });
});
