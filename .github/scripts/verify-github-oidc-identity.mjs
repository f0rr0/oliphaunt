#!/usr/bin/env bun

import process from "node:process";

const TOOL = "verify-github-oidc-identity";
const OIDC_ISSUER = "https://token.actions.githubusercontent.com";
const OIDC_AUDIENCE = "oliphaunt-release-identity-preflight";
const MAX_OIDC_RESPONSE_BYTES = 128 * 1024;
const CALLER_WORKFLOW = "release.yml";
const REUSABLE_WORKFLOW_ONLY_CLAIMS = Object.freeze([
  "job_workflow_ref",
  "job_workflow_sha",
]);
const ENVIRONMENT_BY_OPERATION = Object.freeze({
  "publish-bootstrap": "release-bootstrap",
  publish: "release-publish",
});

function required(environment, name) {
  const value = environment[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function requireFullSha(value, name) {
  if (!/^[0-9a-f]{40}$/u.test(value)) {
    throw new Error(`${name} must be a lowercase full commit SHA; got ${value}`);
  }
  return value;
}

export function expectedOidcIdentity(environment = process.env) {
  const operation = required(environment, "RELEASE_OPERATION");
  const releaseEnvironment = ENVIRONMENT_BY_OPERATION[operation];
  if (releaseEnvironment === undefined) {
    throw new Error(`RELEASE_OPERATION must be publish-bootstrap or publish; got ${operation}`);
  }

  const repository = required(environment, "CANONICAL_RELEASE_REPOSITORY");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
    throw new Error(`CANONICAL_RELEASE_REPOSITORY must be owner/repository; got ${repository}`);
  }
  const ref = required(environment, "GITHUB_REF");
  if (ref !== "refs/heads/main") {
    throw new Error(`trusted publication must run from refs/heads/main; got ${ref}`);
  }
  const sha = requireFullSha(required(environment, "GITHUB_SHA"), "GITHUB_SHA");
  const eventName = required(environment, "GITHUB_EVENT_NAME");
  if (eventName !== "workflow_dispatch") {
    throw new Error(`trusted publication must originate from workflow_dispatch; got ${eventName}`);
  }

  return Object.freeze({
    aud: OIDC_AUDIENCE,
    environment: releaseEnvironment,
    event_name: eventName,
    iss: OIDC_ISSUER,
    ref,
    ref_type: "branch",
    repository,
    runner_environment: "github-hosted",
    sha,
    workflow_ref: `${repository}/.github/workflows/${CALLER_WORKFLOW}@${ref}`,
    workflow_sha: sha,
  });
}

function printable(value) {
  return typeof value === "string" ? JSON.stringify(value) : JSON.stringify(value ?? null);
}

export function verifyOidcClaims(claims, expected) {
  if (claims === null || typeof claims !== "object" || Array.isArray(claims)) {
    throw new Error("GitHub OIDC token payload must be an object");
  }
  for (const claim of REUSABLE_WORKFLOW_ONLY_CLAIMS) {
    if (Object.hasOwn(claims, claim)) {
      throw new Error(
        `GitHub OIDC claim ${claim} is forbidden for a direct release workflow; got ${printable(claims[claim])}`,
      );
    }
  }
  for (const [claim, value] of Object.entries(expected)) {
    if (claims[claim] !== value) {
      throw new Error(
        `GitHub OIDC claim ${claim} mismatch: expected ${printable(value)}, got ${printable(claims[claim])}`,
      );
    }
  }
  return claims;
}

export function decodeJwtPayload(token) {
  if (typeof token !== "string" || token.length === 0 || token.length > 100_000) {
    throw new Error("GitHub OIDC response did not contain a bounded JWT");
  }
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    throw new Error("GitHub OIDC response was not a three-part JWT");
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch (error) {
    throw new Error(`GitHub OIDC JWT payload is invalid: ${error.message}`);
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("GitHub OIDC JWT payload must be an object");
  }
  return payload;
}

export function oidcRequestUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch (error) {
    throw new Error(`ACTIONS_ID_TOKEN_REQUEST_URL is invalid: ${error.message}`);
  }
  if (url.protocol !== "https:") {
    throw new Error("ACTIONS_ID_TOKEN_REQUEST_URL must use HTTPS");
  }
  url.searchParams.set("audience", OIDC_AUDIENCE);
  return url;
}

export async function readBoundedOidcResponse(response) {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const declaredLength = Number(contentLength);
    if (!Number.isSafeInteger(declaredLength) || declaredLength < 0) {
      throw new Error("GitHub OIDC endpoint returned an invalid Content-Length");
    }
    if (declaredLength > MAX_OIDC_RESPONSE_BYTES) {
      throw new Error("GitHub OIDC endpoint response exceeded the byte limit");
    }
  }

  if (response.body === null) {
    return "";
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_OIDC_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("GitHub OIDC endpoint response exceeded the byte limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

async function requestOidcToken(environment = process.env, fetchImpl = fetch) {
  const url = oidcRequestUrl(required(environment, "ACTIONS_ID_TOKEN_REQUEST_URL"));
  const requestToken = required(environment, "ACTIONS_ID_TOKEN_REQUEST_TOKEN");
  const response = await fetchImpl(url, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${requestToken}`,
    },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  const body = await readBoundedOidcResponse(response);
  if (!response.ok) {
    throw new Error(`GitHub OIDC endpoint returned HTTP ${response.status}`);
  }
  let result;
  try {
    result = JSON.parse(body);
  } catch (error) {
    throw new Error(`GitHub OIDC endpoint returned invalid JSON: ${error.message}`);
  }
  if (typeof result?.value !== "string" || result.value.length === 0) {
    throw new Error("GitHub OIDC endpoint response did not contain a token value");
  }
  return result.value;
}

export async function verifyGithubOidcIdentity(environment = process.env, fetchImpl = fetch) {
  const expected = expectedOidcIdentity(environment);
  const token = await requestOidcToken(environment, fetchImpl);
  const claims = decodeJwtPayload(token);
  verifyOidcClaims(claims, expected);
  return expected;
}

async function main() {
  try {
    const expected = await verifyGithubOidcIdentity();
    console.log(
      `GitHub OIDC identity passed: workflow=${expected.workflow_ref}, environment=${expected.environment}`,
    );
  } catch (error) {
    console.error(`${TOOL}: ${error.message}`);
    process.exit(1);
  }
}

if (import.meta.main) {
  await main();
}
