#!/usr/bin/env bun

import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeJwtPayload,
  expectedOidcIdentity,
  oidcRequestUrl,
  readBoundedOidcResponse,
  verifyGithubOidcIdentity,
  verifyOidcClaims,
} from "../../.github/scripts/verify-github-oidc-identity.mjs";
import { releaseTransportFullRef } from "../../.github/scripts/release-transport-ref.mjs";

const SHA = "0123456789abcdef0123456789abcdef01234567";

function environment(operation = "publish") {
  return {
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
    ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.actions.githubusercontent.com/example?api-version=2.0",
    CANONICAL_RELEASE_REPOSITORY: "f0rr0/oliphaunt",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REF: "refs/heads/main",
    GITHUB_SHA: SHA,
    RELEASE_CONTINUATION_POINTER: "",
    RELEASE_OPERATION: operation,
  };
}

function jwt(payload) {
  return [
    Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "signature",
  ].join(".");
}

test("models the direct release workflow identity", () => {
  const publish = expectedOidcIdentity(environment("publish"));
  assert.equal(
    publish.workflow_ref,
    `f0rr0/oliphaunt/.github/workflows/release.yml@refs/heads/main`,
  );
  assert.equal(Object.hasOwn(publish, "job_workflow_ref"), false);
  assert.equal(Object.hasOwn(publish, "job_workflow_sha"), false);
  assert.equal(publish.environment, "release-publish");
  assert.equal(expectedOidcIdentity(environment("publish-bootstrap")).environment, "release-bootstrap");
});

test("models continuations only on the exact SHA-derived transport tag", () => {
  for (const operation of ["publish", "publish-bootstrap"]) {
    const continuation = expectedOidcIdentity({
      ...environment(operation),
      GITHUB_REF: releaseTransportFullRef(SHA),
      RELEASE_CONTINUATION_POINTER: "sealed-pointer",
    });
    assert.equal(continuation.ref, releaseTransportFullRef(SHA));
    assert.equal(continuation.ref_type, "tag");
    assert.equal(
      continuation.workflow_ref,
      `f0rr0/oliphaunt/.github/workflows/release.yml@${releaseTransportFullRef(SHA)}`,
    );
  }

  assert.throws(
    () => expectedOidcIdentity({
      ...environment(),
      RELEASE_CONTINUATION_POINTER: "sealed-pointer",
    }),
    /trusted publication ref mismatch/u,
  );
  assert.throws(
    () => expectedOidcIdentity({
      ...environment(),
      GITHUB_REF: releaseTransportFullRef(SHA),
    }),
    /trusted publication ref mismatch/u,
  );
  assert.throws(
    () => expectedOidcIdentity({
      ...environment(),
      GITHUB_REF: releaseTransportFullRef("f".repeat(40)),
      RELEASE_CONTINUATION_POINTER: "sealed-pointer",
    }),
    /trusted publication ref mismatch/u,
  );
});

test("requires the exact direct workflow, environment, SHA, and hosted runner claims", () => {
  const expected = expectedOidcIdentity(environment());
  assert.doesNotThrow(() => verifyOidcClaims({ ...expected }, expected));

  for (const [claim, value] of [
    ["workflow_ref", `f0rr0/oliphaunt/.github/workflows/other.yml@refs/heads/main`],
    ["environment", "release-bootstrap"],
    ["sha", "f".repeat(40)],
    ["workflow_sha", "f".repeat(40)],
    ["runner_environment", "self-hosted"],
  ]) {
    assert.throws(
      () => verifyOidcClaims({ ...expected, [claim]: value }, expected),
      new RegExp(`claim ${claim} mismatch`, "u"),
    );
  }
});

test("rejects reusable-workflow-only claims", () => {
  const expected = expectedOidcIdentity(environment());
  for (const [claim, value] of [
    ["job_workflow_ref", `f0rr0/oliphaunt/.github/workflows/ci.yml@refs/heads/main`],
    ["job_workflow_sha", SHA],
  ]) {
    assert.throws(
      () => verifyOidcClaims({ ...expected, [claim]: value }, expected),
      new RegExp(`claim ${claim} is forbidden for a direct release workflow`, "u"),
    );
  }
});

test("rejects unsupported events, refs, operations, and malformed SHAs", () => {
  assert.throws(
    () => expectedOidcIdentity({ ...environment(), GITHUB_EVENT_NAME: "push" }),
    /must originate from workflow_dispatch/u,
  );
  assert.throws(
    () => expectedOidcIdentity({ ...environment(), GITHUB_REF: "refs/heads/release" }),
    /trusted publication ref mismatch/u,
  );
  assert.throws(
    () => expectedOidcIdentity({ ...environment(), RELEASE_OPERATION: "publish-dry-run" }),
    /must be publish-bootstrap or publish/u,
  );
  assert.throws(
    () => expectedOidcIdentity({ ...environment(), GITHUB_SHA: "HEAD" }),
    /must be a lowercase full commit SHA/u,
  );
});

test("constructs a bounded HTTPS OIDC request without losing GitHub query parameters", () => {
  const url = oidcRequestUrl(environment().ACTIONS_ID_TOKEN_REQUEST_URL);
  assert.equal(url.protocol, "https:");
  assert.equal(url.searchParams.get("api-version"), "2.0");
  assert.equal(url.searchParams.get("audience"), "oliphaunt-release-identity-preflight");
  assert.throws(() => oidcRequestUrl("http://token.actions.example/request"), /must use HTTPS/u);
});

test("decodes only a bounded three-part JWT object", () => {
  const payload = { repository: "f0rr0/oliphaunt" };
  assert.deepEqual(decodeJwtPayload(jwt(payload)), payload);
  assert.throws(() => decodeJwtPayload("not-a-jwt"), /three-part JWT/u);
  assert.throws(() => decodeJwtPayload(`a.${Buffer.from("[]").toString("base64url")}.c`), /must be an object/u);
});

test("requests and validates the live-token response without exposing it", async () => {
  const env = environment();
  const expected = expectedOidcIdentity(env);
  let request;
  const fetchImpl = async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({ value: jwt(expected) }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  assert.deepEqual(await verifyGithubOidcIdentity(env, fetchImpl), expected);
  assert.equal(request.url.searchParams.get("audience"), "oliphaunt-release-identity-preflight");
  assert.equal(request.options.headers.Authorization, "Bearer request-token");
  assert.equal(request.options.redirect, "error");
});

test("rejects oversized OIDC responses before JSON or JWT parsing", async () => {
  const oversized = "x".repeat(128 * 1024 + 1);
  await assert.rejects(
    () => readBoundedOidcResponse(new Response(oversized)),
    /response exceeded the byte limit/u,
  );
  await assert.rejects(
    () =>
      readBoundedOidcResponse(
        new Response("{}", { headers: { "content-length": String(128 * 1024 + 1) } }),
      ),
    /response exceeded the byte limit/u,
  );
});
