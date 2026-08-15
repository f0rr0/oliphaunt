#!/usr/bin/env bun
import process from "node:process";

import { loadPublicationCatalog } from "../../tools/release/publication-catalog.mjs";
import { mavenCentralAuthorization } from "../../tools/release/maven-central-auth.mjs";

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
await verifyMavenNamespace(catalog);

if (!catalog.carriers.some(({ ecosystem }) => ecosystem === "maven")) {
  console.log("selected products do not require Maven Central external readiness checks");
}
