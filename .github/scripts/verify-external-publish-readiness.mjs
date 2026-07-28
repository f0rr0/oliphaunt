#!/usr/bin/env bun
import process from "node:process";

import { loadPublicationCatalog } from "../../tools/release/publication-catalog.mjs";
import { mavenCentralAuthorization } from "../../tools/release/maven-central-auth.mjs";

const JSR_API_BASE = "https://api.jsr.io";
const MAVEN_CENTRAL_API_BASE = "https://central.sonatype.com";
const MAX_READINESS_RESPONSE_BYTES = 1024 * 1024;

function fail(message) {
  console.error(`verify-external-publish-readiness: ${message}`);
  process.exit(1);
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    fail(`${name} is required`);
  }
  return value;
}

function productsFromEnvironment() {
  let products;
  try {
    products = JSON.parse(requiredEnv("PRODUCTS_JSON"));
  } catch (error) {
    fail(`PRODUCTS_JSON must be strict JSON: ${error.message}`);
  }
  if (
    !Array.isArray(products)
    || products.length === 0
    || products.some((product) => typeof product !== "string" || product.length === 0)
  ) {
    fail("PRODUCTS_JSON must be a non-empty product string list");
  }
  return products;
}

function safeResponseMessage(body) {
  return body.replace(/[\r\n\t]+/gu, " ").trim().slice(0, 300);
}

async function boundedResponseText(response, context) {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const declared = Number(contentLength);
    if (!Number.isSafeInteger(declared) || declared < 0) {
      await response.body?.cancel?.().catch(() => {});
      throw new Error(`${context} returned an invalid Content-Length`);
    }
    if (declared > MAX_READINESS_RESPONSE_BYTES) {
      await response.body?.cancel?.().catch(() => {});
      throw new Error(`${context} response exceeded ${MAX_READINESS_RESPONSE_BYTES} bytes`);
    }
  }
  const reader = response.body?.getReader?.();
  if (reader === undefined) {
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_READINESS_RESPONSE_BYTES) {
      throw new Error(`${context} response exceeded ${MAX_READINESS_RESPONSE_BYTES} bytes`);
    }
    return text;
  }
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_READINESS_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error(`${context} response exceeded ${MAX_READINESS_RESPONSE_BYTES} bytes`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size).toString("utf8");
}

async function requestJson(url, { authorization = undefined, context }) {
  let lastFailure;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const headers = {
        Accept: "application/json",
        "User-Agent": "oliphaunt-release-readiness/1; https://github.com/f0rr0/oliphaunt",
      };
      if (authorization !== undefined) {
        headers.Authorization = authorization;
      }
      const response = await fetch(url, {
        headers,
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
      const body = await boundedResponseText(response, context);
      if (!response.ok) {
        const detail = safeResponseMessage(body);
        const failure = `${context} returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`;
        if (response.status !== 429 && response.status < 500) {
          fail(failure);
        }
        lastFailure = failure;
      } else {
        try {
          return JSON.parse(body);
        } catch (error) {
          fail(`${context} returned invalid JSON: ${error.message}`);
        }
      }
    } catch (error) {
      lastFailure = `${context} request failed: ${error.message}`;
    }
    if (attempt < 3) {
      await Bun.sleep(attempt * 500);
    }
  }
  fail(lastFailure ?? `${context} request failed`);
}

function parseJsrIdentity(identity) {
  const match = identity.match(/^@([a-z][a-z0-9-]*)\/([a-z][a-z0-9-]*)$/u);
  if (match === null) {
    fail(`invalid JSR identity in publication catalog: ${identity}`);
  }
  return { scope: match[1], packageName: match[2] };
}

async function verifyJsrIdentity(identity, expectedRepository) {
  const { scope, packageName } = parseJsrIdentity(identity);
  const url = `${JSR_API_BASE}/scopes/${encodeURIComponent(scope)}/packages/${encodeURIComponent(packageName)}`;
  const pkg = await requestJson(url, { context: `JSR package ${identity}` });
  if (pkg?.scope !== scope || pkg?.name !== packageName) {
    fail(`JSR package ${identity} returned mismatched identity metadata`);
  }
  const linkedRepository = pkg?.githubRepository;
  const actualRepository = linkedRepository === null || linkedRepository === undefined
    ? null
    : `${linkedRepository.owner}/${linkedRepository.name}`;
  if (actualRepository !== expectedRepository) {
    fail(
      `JSR package ${identity} must exist and link to ${expectedRepository}; got ${actualRepository ?? "no linked repository"}. `
      + "Create/link it in JSR package settings before normal publication.",
    );
  }
  console.log(`JSR readiness passed: ${identity} is linked to ${expectedRepository}`);
}

function mavenNamespaces(catalog, expectedNamespace) {
  const groups = new Set();
  for (const carrier of catalog.carriers.filter(({ ecosystem }) => ecosystem === "maven")) {
    const separator = carrier.name.indexOf(":");
    if (separator <= 0 || separator === carrier.name.length - 1) {
      fail(`invalid Maven identity in publication catalog: ${carrier.name}`);
    }
    const group = carrier.name.slice(0, separator);
    if (group !== expectedNamespace && !group.startsWith(`${expectedNamespace}.`)) {
      fail(`Maven group ${group} is outside verified namespace ${expectedNamespace}`);
    }
    groups.add(group);
  }
  return [...groups].sort();
}

async function verifyMavenNamespace(catalog) {
  const expectedNamespace = requiredEnv("MAVEN_CENTRAL_NAMESPACE");
  const groups = mavenNamespaces(catalog, expectedNamespace);
  if (groups.length === 0) {
    return;
  }
  const username = requiredEnv("ORG_GRADLE_PROJECT_mavenCentralUsername");
  const password = requiredEnv("ORG_GRADLE_PROJECT_mavenCentralPassword");
  const authorization = mavenCentralAuthorization(username, password);
  const url = new URL("/api/v1/publisher/deployments", MAVEN_CENTRAL_API_BASE);
  url.searchParams.set("namespace", expectedNamespace);
  url.searchParams.set("page", "0");
  url.searchParams.set("size", "1");
  const result = await requestJson(url, {
    authorization,
    context: `Maven Central namespace ${expectedNamespace}`,
  });
  if (
    !Array.isArray(result?.deployments)
    || !Number.isInteger(result?.page)
    || !Number.isInteger(result?.pageSize)
    || !Number.isInteger(result?.pageCount)
    || !Number.isInteger(result?.totalResultCount)
  ) {
    fail(`Maven Central namespace ${expectedNamespace} returned an unexpected response shape`);
  }
  console.log(
    `Maven Central readiness passed: credentials can access ${expectedNamespace}; selected groups: ${groups.join(", ")}`,
  );
}

const products = productsFromEnvironment();
const catalog = loadPublicationCatalog("verify-external-publish-readiness", { products });
const expectedRepository = requiredEnv("CANONICAL_RELEASE_REPOSITORY");
const jsrIdentities = [
  ...new Set(catalog.carriers.filter(({ ecosystem }) => ecosystem === "jsr").map(({ name }) => name)),
].sort();

for (const identity of jsrIdentities) {
  await verifyJsrIdentity(identity, expectedRepository);
}
await verifyMavenNamespace(catalog);

if (jsrIdentities.length === 0 && !catalog.carriers.some(({ ecosystem }) => ecosystem === "maven")) {
  console.log("selected products do not require JSR or Maven Central external readiness checks");
}
