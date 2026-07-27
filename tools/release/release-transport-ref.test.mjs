import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  RELEASE_TRANSPORT_MAX_RESPONSE_BYTES,
  RELEASE_TRANSPORT_TAG_PREFIX,
  ensureReleaseTransportRef,
  normalizeReleaseTransportCommit,
  releaseTransportFullRef,
  releaseTransportTagName,
  validateReleaseTransportRef,
  verifyReleaseTransportRef,
} from "../../.github/scripts/release-transport-ref.mjs";

const SHA = "84d90b9853530ab72e48a1aa6fb616aaed7a0dc6";
const OTHER_SHA = "1111111111111111111111111111111111111111";
const REPO = "f0rr0/oliphaunt";
const TOKEN = "test-token";
const FULL_REF = `refs/tags/${RELEASE_TRANSPORT_TAG_PREFIX}${SHA}`;
const SOURCE = readFileSync(
  new URL("../../.github/scripts/release-transport-ref.mjs", import.meta.url),
  "utf8",
);
const RELEASE_HEAD_RESOLVER_SOURCE = readFileSync(
  new URL("../../.github/scripts/resolve-release-head.sh", import.meta.url),
  "utf8",
);

function exactRef(sha = SHA) {
  return {
    ref: `refs/tags/${RELEASE_TRANSPORT_TAG_PREFIX}${sha}`,
    object: { sha, type: "commit", url: `https://api.github.com/repos/${REPO}/git/commits/${sha}` },
    url: `https://api.github.com/repos/${REPO}/git/refs/tags/${RELEASE_TRANSPORT_TAG_PREFIX}${sha}`,
  };
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
    status,
  });
}

function environment(overrides = {}) {
  return {
    GH_REPO: REPO,
    GH_TOKEN: TOKEN,
    ...overrides,
  };
}

function rootEnvironment(operation, runAttempt = 1, overrides = {}) {
  return environment({
    GITHUB_ACTIONS: "true",
    GITHUB_REF: "refs/heads/main",
    GITHUB_RUN_ATTEMPT: String(runAttempt),
    GITHUB_SHA: SHA,
    RELEASE_CONTINUATION_POINTER: "",
    RELEASE_OPERATION: operation,
    ...overrides,
  });
}

test("transport names normalize one exact full commit into an unambiguous lightweight-tag ref", () => {
  assert.equal(normalizeReleaseTransportCommit(SHA.toUpperCase()), SHA);
  assert.equal(releaseTransportTagName(SHA), `${RELEASE_TRANSPORT_TAG_PREFIX}${SHA}`);
  assert.equal(releaseTransportFullRef(SHA), FULL_REF);
  assert.deepEqual(validateReleaseTransportRef(exactRef(), SHA), {
    commit: SHA,
    fullRef: FULL_REF,
    tag: `${RELEASE_TRANSPORT_TAG_PREFIX}${SHA}`,
  });
  for (const invalid of [
    { ...exactRef(), ref: `${FULL_REF}-wrong` },
    { ...exactRef(), object: { sha: OTHER_SHA, type: "commit" } },
    { ...exactRef(), object: { sha: SHA, type: "tag" } },
  ]) {
    assert.throws(
      () => validateReleaseTransportRef(invalid, SHA),
      /does not point directly to exact release commit/u,
    );
  }
  for (const invalid of ["", "abc", `${SHA}0`, "z".repeat(40)]) {
    assert.throws(() => normalizeReleaseTransportCommit(invalid), /full lowercase-compatible 40-character SHA/u);
  }
});

test("the release-head resolver remains exact-SHA-only and has no moving-main dependency", () => {
  assert.match(RELEASE_HEAD_RESOLVER_SOURCE, /release_commit must equal the workflow commit exactly/u);
  assert.doesNotMatch(
    RELEASE_HEAD_RESOLVER_SOURCE,
    /require-current-main[.]sh|refs\/heads\/main|refs\/remotes\/origin\/main/u,
  );
});

test("an exact existing transport bypasses moving main only for genuine root reruns", async () => {
  for (const [contentWriteAdmission, operation] of [
    ["pre-reserved", "publish"],
    ["isolated-bootstrap", "publish-bootstrap"],
  ]) {
    let firstAttemptProofs = 0;
    const firstAttempt = await ensureReleaseTransportRef({
      commit: SHA,
      contentWriteAdmission,
      environment: rootEnvironment(operation),
      fetchImpl: async () => jsonResponse(exactRef()),
      proveCurrentMain: async () => { firstAttemptProofs += 1; },
    });
    assert.equal(firstAttempt.created, false);
    assert.equal(firstAttemptProofs, 1);

    const calls = [];
    const rerun = await ensureReleaseTransportRef({
      commit: SHA,
      contentWriteAdmission,
      environment: rootEnvironment(operation, 2),
      fetchImpl: async (url, init) => {
        calls.push({ init, url: String(url) });
        return jsonResponse(exactRef());
      },
      proveCurrentMain: async () => {
        throw new Error("a genuine exact rerun must not re-evaluate moving main");
      },
    });
    assert.deepEqual(rerun, {
      commit: SHA,
      created: false,
      fullRef: FULL_REF,
      tag: `${RELEASE_TRANSPORT_TAG_PREFIX}${SHA}`,
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].init.method, "GET");
    assert.match(calls[0].url, new RegExp(`/git/ref/tags/${RELEASE_TRANSPORT_TAG_PREFIX}${SHA}$`, "u"));
  }

  const firstAttemptMethods = [];
  await assert.rejects(
    () => ensureReleaseTransportRef({
      commit: SHA,
      contentWriteAdmission: "pre-reserved",
      environment: rootEnvironment("publish"),
      fetchImpl: async (_url, init) => {
        firstAttemptMethods.push(init.method);
        return jsonResponse(exactRef());
      },
      proveCurrentMain: async () => {
        throw new Error("first attempt observed stale main");
      },
    }),
    /first attempt observed stale main/u,
  );
  assert.deepEqual(firstAttemptMethods, ["GET"]);
});

test("ensure creates one exact lightweight tag after proving it absent", async () => {
  const calls = [];
  const events = [];
  const responses = [new Response("not found", { status: 404 }), jsonResponse(exactRef(), 201)];
  const result = await ensureReleaseTransportRef({
    commit: SHA.toUpperCase(),
    contentWriteAdmission: "pre-reserved",
    environment: rootEnvironment("publish"),
    fetchImpl: async (url, init) => {
      events.push(init.method);
      calls.push({ init, url: String(url) });
      return responses.shift();
    },
    proveCurrentMain: async ({ commit, environment: proofEnvironment }) => {
      events.push("PROVE_CURRENT_MAIN");
      assert.equal(commit, SHA);
      assert.equal(proofEnvironment.GITHUB_SHA, SHA);
    },
  });
  assert.equal(result.created, true);
  assert.deepEqual(calls.map(({ init }) => init.method), ["GET", "POST"]);
  assert.deepEqual(JSON.parse(calls[1].init.body), { ref: FULL_REF, sha: SHA });
  assert.equal(new Headers(calls[1].init.headers).get("authorization"), `Bearer ${TOKEN}`);
  assert.ok(calls.every(({ init }) => init.redirect === "error" && init.signal instanceof AbortSignal));
  assert.deepEqual(events, ["GET", "PROVE_CURRENT_MAIN", "POST"]);
});

test("an absent transport fails closed before POST when current-main proof fails", async () => {
  const methods = [];
  await assert.rejects(
    () => ensureReleaseTransportRef({
      commit: SHA,
      contentWriteAdmission: "pre-reserved",
      environment: rootEnvironment("publish", 3),
      fetchImpl: async (_url, init) => {
        methods.push(init.method);
        return new Response("missing", { status: 404 });
      },
      proveCurrentMain: async () => {
        throw new Error("main advanced");
      },
    }),
    /main advanced/u,
  );
  assert.deepEqual(methods, ["GET"]);
});

test("an ambiguous create response is reconciled by one exact read and never replayed", async () => {
  for (const ambiguous of [
    () => new Response("temporarily unavailable", { status: 503 }),
    () => { throw new TypeError("connection reset after upload"); },
  ]) {
    const methods = [];
    const fetchImpl = async (_url, init) => {
      methods.push(init.method);
      if (methods.length === 1) return new Response("missing", { status: 404 });
      if (methods.length === 2) return ambiguous();
      return jsonResponse(exactRef());
    };
    const result = await ensureReleaseTransportRef({
      commit: SHA,
      contentWriteAdmission: "pre-reserved",
      environment: rootEnvironment("publish"),
      fetchImpl,
      proveCurrentMain: async () => {},
    });
    assert.equal(result.created, true);
    assert.deepEqual(methods, ["GET", "POST", "GET"]);
  }
});

test("ensure rejects collisions and failed reconciliation without update, delete, or create replay", async () => {
  let calls = 0;
  let proofs = 0;
  for (const invalid of [
    { ...exactRef(), object: { sha: OTHER_SHA, type: "commit" } },
    { ...exactRef(), object: { sha: SHA, type: "tag" } },
  ]) {
    await assert.rejects(
      () => ensureReleaseTransportRef({
        commit: SHA,
        contentWriteAdmission: "pre-reserved",
        environment: rootEnvironment("publish", 2),
        fetchImpl: async () => {
          calls += 1;
          return jsonResponse(invalid);
        },
        proveCurrentMain: async () => { proofs += 1; },
      }),
      /does not point directly to exact release commit/u,
    );
  }
  assert.equal(calls, 2, "an occupied wrong or annotated ref must fail before mutation");
  assert.equal(proofs, 0, "an invalid existing ref must fail before any current-main bypass");

  const methods = [];
  await assert.rejects(
    () => ensureReleaseTransportRef({
      commit: SHA,
      contentWriteAdmission: "pre-reserved",
      environment: rootEnvironment("publish"),
      fetchImpl: async (_url, init) => {
        methods.push(init.method);
        return init.method === "POST"
          ? new Response("unavailable", { status: 503 })
          : new Response("missing", { status: 404 });
      },
      proveCurrentMain: async () => {},
    }),
    /create returned HTTP 503/u,
  );
  assert.deepEqual(methods, ["GET", "POST", "GET"]);
  assert.doesNotMatch(SOURCE, /method:\s*["'](?:PATCH|DELETE)["']/u);
});

test("verify accepts only an existing exact direct commit ref", async () => {
  assert.equal((await verifyReleaseTransportRef({
    commit: SHA,
    environment: environment(),
    fetchImpl: async () => jsonResponse(exactRef()),
  })).commit, SHA);
  await assert.rejects(
    () => verifyReleaseTransportRef({
      commit: SHA,
      environment: environment(),
      fetchImpl: async () => new Response("missing", { status: 404 }),
    }),
    /does not exist/u,
  );
});

test("pre-reserved and isolated-bootstrap admissions are exact root-run-only", async () => {
  for (const [contentWriteAdmission, operation, wrongOperation] of [
    ["pre-reserved", "publish", "publish-bootstrap"],
    ["isolated-bootstrap", "publish-bootstrap", "publish"],
  ]) {
    for (const overrides of [
      { GITHUB_ACTIONS: "false" },
      { GITHUB_REF: FULL_REF },
      { GITHUB_RUN_ATTEMPT: undefined },
      { GITHUB_RUN_ATTEMPT: "0" },
      { GITHUB_RUN_ATTEMPT: "01" },
      { GITHUB_RUN_ATTEMPT: "not-a-number" },
      { GITHUB_RUN_ATTEMPT: "9".repeat(100) },
      { GITHUB_SHA: OTHER_SHA },
      { RELEASE_CONTINUATION_POINTER: "pointer" },
      { RELEASE_OPERATION: wrongOperation },
    ]) {
      let fetchCalls = 0;
      await assert.rejects(
        () => ensureReleaseTransportRef({
          commit: SHA,
          contentWriteAdmission,
          environment: rootEnvironment(operation, 1, overrides),
          fetchImpl: async () => {
            fetchCalls += 1;
            return new Response("missing", { status: 404 });
          },
          proveCurrentMain: async () => {},
        }),
        new RegExp(`${contentWriteAdmission} admission requires the exact root ${operation} GitHub run`, "u"),
      );
      assert.equal(fetchCalls, 0);
    }
  }

  await assert.rejects(
    () => ensureReleaseTransportRef({
      commit: SHA,
      environment: rootEnvironment("publish"),
      fetchImpl: async () => new Response("missing", { status: 404 }),
      proveCurrentMain: async () => {},
    }),
    /OLIPHAUNT_GITHUB_CONTENT_WRITE_PACER_PATH is required/u,
  );
});

test("transport responses and credentials remain bounded and validated", async () => {
  await assert.rejects(
    () => verifyReleaseTransportRef({
      commit: SHA,
      environment: environment(),
      fetchImpl: async () => new Response("", {
        headers: { "Content-Length": String(RELEASE_TRANSPORT_MAX_RESPONSE_BYTES + 1) },
        status: 200,
      }),
    }),
    /oversized Content-Length/u,
  );
  for (const options of [
    { repo: "not-a-repository", token: TOKEN },
    { repo: REPO, token: "bad\ntoken" },
  ]) {
    await assert.rejects(
      () => verifyReleaseTransportRef({
        commit: SHA,
        environment: {},
        fetchImpl: async () => jsonResponse(exactRef()),
        ...options,
      }),
      /GH_(?:REPO|TOKEN)/u,
    );
  }
});
