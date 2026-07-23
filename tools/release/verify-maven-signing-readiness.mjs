#!/usr/bin/env bun

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  inspectArmoredPublicKeyFingerprints,
  verifyGpgSigningCredentials,
} from "./frozen-maven-publish.mjs";

const TOOL = "verify-maven-signing-readiness";
const MAX_PUBLIC_KEY_BYTES = 1024 * 1024;
const SUPPORTED_KEY_SERVERS = [
  {
    name: "keyserver.ubuntu.com",
    url: (fingerprint) => `https://keyserver.ubuntu.com/pks/lookup?op=get&options=mr&search=0x${fingerprint}`,
  },
  {
    name: "keys.openpgp.org",
    url: (fingerprint) => `https://keys.openpgp.org/vks/v1/by-fingerprint/${fingerprint}`,
  },
  {
    name: "pgp.mit.edu",
    url: (fingerprint) => `https://pgp.mit.edu/pks/lookup?op=get&options=mr&search=0x${fingerprint}`,
  },
];

function requiredEnvironment(name) {
  const value = process.env[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

async function boundedResponseText(response, context) {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_PUBLIC_KEY_BYTES) {
      await response.body?.cancel?.().catch(() => {});
      throw new Error(`${context} returned an invalid or oversized Content-Length`);
    }
  }
  const reader = response.body?.getReader?.();
  if (reader === undefined) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > MAX_PUBLIC_KEY_BYTES) {
      throw new Error(`${context} exceeded ${MAX_PUBLIC_KEY_BYTES} bytes`);
    }
    return bytes.toString("utf8");
  }
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_PUBLIC_KEY_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error(`${context} exceeded ${MAX_PUBLIC_KEY_BYTES} bytes`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size).toString("utf8");
}

export async function verifyPublishedMavenSigningKey(
  fingerprint,
  {
    fetchImpl = fetch,
    inspectImpl,
    keyServers = SUPPORTED_KEY_SERVERS,
  } = {},
) {
  const normalized = String(fingerprint).toUpperCase();
  if (!/^(?:[0-9A-F]{40}|[0-9A-F]{64})$/u.test(normalized)) {
    throw new Error("primary Maven signing fingerprint must be 40 or 64 hexadecimal characters");
  }
  if (typeof inspectImpl !== "function") {
    throw new TypeError("inspectImpl is required");
  }
  const failures = [];
  for (const server of keyServers) {
    try {
      const response = await fetchImpl(server.url(normalized), {
        headers: {
          Accept: "application/pgp-keys, application/octet-stream;q=0.9, text/plain;q=0.8",
          "User-Agent": "oliphaunt-maven-signing-readiness/1; https://github.com/f0rr0/oliphaunt",
        },
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        await response.body?.cancel?.().catch(() => {});
        throw new Error(`HTTP ${response.status}`);
      }
      const armoredKey = await boundedResponseText(response, server.name);
      const publishedFingerprints = inspectImpl(armoredKey);
      if (!publishedFingerprints.includes(normalized)) {
        throw new Error(`response did not contain primary fingerprint ${normalized}`);
      }
      return { fingerprint: normalized, server: server.name };
    } catch (error) {
      failures.push(`${server.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(
    `primary Maven signing key ${normalized} is not verifiably published on a Central-supported keyserver (${failures.join("; ")})`,
  );
}

async function main() {
  const temporaryRoot = process.env.RUNNER_TEMP || tmpdir();
  const home = mkdtempSync(path.join(temporaryRoot, "oliphaunt-maven-signing-preflight-"));
  try {
    const result = verifyGpgSigningCredentials({
      privateKey: requiredEnvironment("ORG_GRADLE_PROJECT_signingInMemoryKey"),
      keyId: requiredEnvironment("ORG_GRADLE_PROJECT_signingInMemoryKeyId"),
      passphrase: requiredEnvironment("ORG_GRADLE_PROJECT_signingInMemoryKeyPassword"),
      home,
    });
    const publication = await verifyPublishedMavenSigningKey(result.primaryFingerprint, {
      inspectImpl: (armoredKey) => inspectArmoredPublicKeyFingerprints({ armoredKey, home }),
    });
    console.log(
      `${TOOL}: imported, primary-key signed, locally verified, and found OpenPGP fingerprint ${result.primaryFingerprint} on ${publication.server}`,
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(`${TOOL}: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
