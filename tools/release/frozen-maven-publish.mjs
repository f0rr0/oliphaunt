import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { captureCommandOutput } from "../dev/capture-command-output.mjs";
import { mavenCentralAuthorization } from "./maven-central-auth.mjs";
import { lockedCarrierFiles, lockedCarriers } from "./publication-lock.mjs";
import { ROOT } from "./release-cli-utils.mjs";
import { validateMavenCentralPublication } from "./maven-central-contract.mjs";

const CENTRAL_API = "https://central.sonatype.com/api/v1/publisher";
const TERMINAL_STATES = new Set(["PUBLISHED", "FAILED"]);
const DEPLOYMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const DROP_VISIBILITY_ATTEMPTS = 30;
const DROP_VISIBILITY_INTERVAL_MS = 1_000;
const MAX_CENTRAL_RESPONSE_BYTES = 1024 * 1024;
export const MAX_CENTRAL_BUNDLE_BYTES = 1_000_000_000;
const CENTRAL_REQUEST_TIMEOUT_MS = 60_000;
const DEADLINE_RESERVE_MS = 5_000;

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function error(message) {
  return new Error(`frozen-maven-publish: ${message}`);
}

function deadlineMilliseconds(deadlineEpochSeconds) {
  if (!Number.isSafeInteger(deadlineEpochSeconds) || deadlineEpochSeconds < 1) {
    throw error("registry mutation deadline must be a positive Unix timestamp");
  }
  return deadlineEpochSeconds * 1000;
}

function remainingBeforeReserve({ deadlineEpochSeconds, nowImpl, context }) {
  const remaining = deadlineMilliseconds(deadlineEpochSeconds) - nowImpl() - DEADLINE_RESERVE_MS;
  if (remaining <= 0) {
    throw error(`${context} refused because the shared registry mutation deadline has been reached`);
  }
  return remaining;
}

async function boundedSleep(milliseconds, {
  deadlineEpochSeconds,
  nowImpl,
  sleep,
  context,
}) {
  const remaining = remainingBeforeReserve({ deadlineEpochSeconds, nowImpl, context });
  if (!Number.isFinite(milliseconds) || milliseconds < 0 || milliseconds >= remaining) {
    throw error(`${context} cannot wait ${Math.ceil(milliseconds / 1000)}s before the shared registry mutation deadline`);
  }
  await sleep(milliseconds);
}

function safeCoordinate(value, context) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.-]+$/u.test(value)) {
    throw error(`${context} is not a safe Maven coordinate segment: ${JSON.stringify(value)}`);
  }
  return value;
}

function coordinate(carrier) {
  const separator = carrier.name.lastIndexOf(":");
  if (separator <= 0 || separator === carrier.name.length - 1) {
    throw error(`${carrier.id} has invalid Maven coordinates`);
  }
  const group = safeCoordinate(carrier.name.slice(0, separator), `${carrier.id} group`);
  const artifact = safeCoordinate(carrier.name.slice(separator + 1), `${carrier.id} artifact`);
  const version = safeCoordinate(carrier.version, `${carrier.id} version`);
  return { group, artifact, version };
}

function remoteFilename(carrier, artifactPath, artifactName) {
  const localName = path.basename(artifactPath);
  const prefix = `${artifactName}-${carrier.version}`;
  if (localName.startsWith(prefix) && localName.length > prefix.length) {
    return localName;
  }
  const compound = [".tar.gz", ".tar.zst"].find((suffix) => localName.endsWith(suffix));
  const suffix = compound ?? path.extname(localName);
  if (suffix.length === 0) {
    throw error(`${carrier.id} cannot map ${localName} to a Maven filename`);
  }
  return `${prefix}${suffix}`;
}

function digestFile(file, algorithm) {
  return createHash(algorithm).update(readFileSync(file)).digest("hex");
}

function run(args, { cwd = ROOT, input = undefined, context }) {
  const result = captureCommandOutput(args[0], args.slice(1), {
    cwd,
    input,
    label: context,
    maxOutputBytes: 10 * 1024 * 1024,
  });
  if (result.error !== undefined || result.status !== 0) {
    const detail = (result.stderr || result.error?.message || "").trim();
    throw error(`${context} failed${detail ? `: ${detail}` : ""}`);
  }
  return result.stdout;
}

function normalizedGpgKeyId(keyId) {
  if (typeof keyId !== "string") {
    throw error("Maven signing key ID must be a hexadecimal OpenPGP key ID or fingerprint");
  }
  const normalized = keyId.trim().replace(/^0x/iu, "").toUpperCase();
  if (!/^[0-9A-F]{8,64}$/u.test(normalized)) {
    throw error("Maven signing key ID must be 8-64 hexadecimal characters, optionally prefixed by 0x");
  }
  return normalized;
}

export function createGpgSigner({ privateKey, keyId, passphrase, home, runImpl = run }) {
  if (![privateKey, keyId, passphrase].every((value) => typeof value === "string" && value.length > 0)) {
    throw error("Maven signing key, key ID, and passphrase are required");
  }
  const signingKeyId = normalizedGpgKeyId(keyId);
  mkdirSync(home, { recursive: true });
  chmodSync(home, 0o700);
  runImpl(["gpg", "--batch", "--homedir", home, "--import"], {
    input: privateKey,
    context: "import Maven signing key",
  });
  return (file, signature) => {
    runImpl([
      "gpg",
      "--batch",
      "--yes",
      "--no-tty",
      "--pinentry-mode",
      "loopback",
      "--passphrase-fd",
      "0",
      "--homedir",
      home,
      "--local-user",
      signingKeyId,
      "--armor",
      "--detach-sign",
      "--output",
      signature,
      file,
    ], { input: `${passphrase}\n`, context: `sign ${path.basename(file)}` });
  };
}

export function verifyGpgSigningCredentials({ privateKey, keyId, passphrase, home, runImpl = run }) {
  const signingKeyId = normalizedGpgKeyId(keyId);
  const payload = path.join(home, "oliphaunt-maven-signing-preflight.txt");
  const signature = `${payload}.asc`;
  const signFile = createGpgSigner({ privateKey, keyId: signingKeyId, passphrase, home, runImpl });
  writeFileSync(payload, "oliphaunt Maven signing readiness preflight\n", { mode: 0o600 });
  signFile(payload, signature);
  const status = runImpl([
    "gpg",
    "--batch",
    "--no-auto-key-retrieve",
    "--homedir",
    home,
    "--status-fd",
    "1",
    "--verify",
    signature,
    payload,
  ], { context: "verify Maven signing preflight signature" });
  const validSignatures = status
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("[GNUPG:] VALIDSIG "));
  if (validSignatures.length !== 1) {
    throw error(`Maven signing preflight expected one valid signature, got ${validSignatures.length}`);
  }
  const fingerprints = validSignatures[0]
    .trim()
    .split(/\s+/u)
    .filter((field) => /^(?:[0-9A-F]{40}|[0-9A-F]{64})$/iu.test(field))
    .map((field) => field.toUpperCase());
  if (fingerprints.length === 0) {
    throw error("Maven signing preflight did not report a valid signature fingerprint");
  }
  const signerFingerprint = fingerprints[0];
  const primaryFingerprint = fingerprints.length > 1 ? fingerprints.at(-1) : signerFingerprint;
  if (signerFingerprint !== primaryFingerprint) {
    throw error("Maven Central requires artifacts to be signed by the primary OpenPGP key, not a signing subkey");
  }
  if (!primaryFingerprint.endsWith(signingKeyId)) {
    throw error("configured Maven signing key ID does not match the verified signature fingerprint");
  }
  return {
    signerFingerprint,
    primaryFingerprint,
  };
}

export function inspectArmoredPublicKeyFingerprints({ armoredKey, home, runImpl = run }) {
  if (typeof armoredKey !== "string" || armoredKey.length === 0) {
    throw error("published Maven signing public key must be nonempty armored OpenPGP data");
  }
  const listing = runImpl([
    "gpg",
    "--batch",
    "--homedir",
    home,
    "--with-colons",
    "--import-options",
    "show-only",
    "--import",
  ], { input: armoredKey, context: "inspect published Maven signing public key" });
  const primaryFingerprints = [];
  let awaitingPrimaryFingerprint = false;
  for (const line of listing.split(/\r?\n/u)) {
    const fields = line.split(":");
    if (fields[0] === "pub") {
      awaitingPrimaryFingerprint = true;
      continue;
    }
    if (fields[0] === "sub") {
      awaitingPrimaryFingerprint = false;
      continue;
    }
    if (fields[0] === "fpr" && awaitingPrimaryFingerprint) {
      const fingerprint = fields[9]?.toUpperCase() ?? "";
      if (!/^(?:[0-9A-F]{40}|[0-9A-F]{64})$/u.test(fingerprint)) {
        throw error("published Maven signing key reported an invalid primary fingerprint");
      }
      primaryFingerprints.push(fingerprint);
      awaitingPrimaryFingerprint = false;
    }
  }
  if (primaryFingerprints.length === 0) {
    throw error("published Maven signing key did not contain a primary OpenPGP fingerprint");
  }
  return primaryFingerprints;
}

export function prepareFrozenMavenBundle({ lock, products, outputRoot, signFile }) {
  if (typeof signFile !== "function") {
    throw error("signFile callback is required");
  }
  const carriers = lockedCarriers(lock, { products, ecosystem: "maven" })
    .sort((left, right) => left.publishOrder - right.publishOrder || compareText(left.id, right.id));
  if (carriers.length === 0) {
    throw error(`publication lock contains no Maven carriers for ${products.join(",")}`);
  }
  const layout = path.join(outputRoot, "layout");
  const bundle = path.join(outputRoot, "central-bundle.zip");
  rmSync(layout, { recursive: true, force: true });
  rmSync(bundle, { force: true });
  mkdirSync(layout, { recursive: true });
  const payloads = [];
  for (const carrier of carriers) {
    const { group, artifact, version } = coordinate(carrier);
    const frozen = lockedCarrierFiles(lock, "maven", carrier.name);
    const destination = path.join(layout, ...group.split("."), artifact, version);
    mkdirSync(destination, { recursive: true });
    const names = new Set();
    for (const { artifact: envelope, file } of frozen.files) {
      if (/\.(?:asc|md5|sha1|sha256|sha512)$/u.test(file)) {
        throw error(`${carrier.id} lock must freeze primary Maven payloads, not generated signature/checksum ${envelope.path}`);
      }
      const name = remoteFilename(carrier, file, artifact);
      if (names.has(name)) {
        throw error(`${carrier.id} maps multiple frozen artifacts to ${name}`);
      }
      names.add(name);
      const staged = path.join(destination, name);
      copyFileSync(file, staged);
      payloads.push({ carrier: carrier.id, frozenPath: envelope.path, staged, sha256: digestFile(staged, "sha256") });
    }
    if (![...names].some((name) => name === `${artifact}-${version}.pom`)) {
      throw error(`${carrier.id} must freeze its generated POM before publication`);
    }
    const pom = path.join(destination, `${artifact}-${version}.pom`);
    validateMavenCentralPublication({
      pomText: readFileSync(pom, "utf8"),
      files: [...names].map((name) => ({ name, size: statSync(path.join(destination, name)).size })),
      context: carrier.id,
    });
  }
  for (const payload of payloads) {
    signFile(payload.staged, `${payload.staged}.asc`);
    writeFileSync(`${payload.staged}.md5`, digestFile(payload.staged, "md5"));
    writeFileSync(`${payload.staged}.sha1`, digestFile(payload.staged, "sha1"));
  }
  run(["zip", "-q", "-X", "-r", bundle, "."], { cwd: layout, context: "create Maven Central deployment bundle" });
  const bundleSize = statSync(bundle).size;
  assertMavenCentralBundleSize(bundleSize);
  return { bundle, bundleSize, carriers, layout, payloads };
}

export function assertMavenCentralBundleSize(size, maximum = MAX_CENTRAL_BUNDLE_BYTES) {
  if (!Number.isSafeInteger(size) || size < 1) {
    throw error(`Maven Central deployment bundle size must be a positive integer, got ${size}`);
  }
  if (!Number.isSafeInteger(maximum) || maximum < 1) {
    throw error(`Maven Central deployment bundle maximum must be a positive integer, got ${maximum}`);
  }
  if (size >= maximum) {
    throw error(`Maven Central deployment bundle is ${size} bytes; the portal requires bundles smaller than ${maximum} bytes`);
  }
}

function boundedDetail(body) {
  return body.replace(/[\r\n\t]+/gu, " ").trim().slice(0, 500);
}

async function boundedResponseText(response) {
  const contentLength = response.headers?.get?.("content-length");
  if (contentLength !== null && contentLength !== undefined) {
    const declared = Number(contentLength);
    if (!Number.isSafeInteger(declared) || declared < 0) {
      await response.body?.cancel?.().catch(() => {});
      throw error("Maven Central returned an invalid Content-Length");
    }
    if (declared > MAX_CENTRAL_RESPONSE_BYTES) {
      await response.body?.cancel?.().catch(() => {});
      throw error(`Maven Central response exceeds ${MAX_CENTRAL_RESPONSE_BYTES} bytes`);
    }
  }

  const reader = response.body?.getReader?.();
  if (reader === undefined) {
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_CENTRAL_RESPONSE_BYTES) {
      throw error(`Maven Central response exceeds ${MAX_CENTRAL_RESPONSE_BYTES} bytes`);
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
      if (size > MAX_CENTRAL_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        throw error(`Maven Central response exceeds ${MAX_CENTRAL_RESPONSE_BYTES} bytes`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size).toString("utf8");
}

async function centralRequest(url, {
  authorization,
  deadlineEpochSeconds,
  nowImpl,
  method = "GET",
  body = undefined,
  fetchImpl = fetch,
}) {
  const timeoutMs = Math.min(
    CENTRAL_REQUEST_TIMEOUT_MS,
    remainingBeforeReserve({
      deadlineEpochSeconds,
      nowImpl,
      context: `Maven Central ${method} ${url}`,
    }),
  );
  const response = await fetchImpl(url, {
    method,
    headers: {
      Accept: "application/json",
      Authorization: authorization,
    },
    body,
    redirect: "error",
    signal: AbortSignal.timeout(Math.max(1, timeoutMs)),
  });
  const text = await boundedResponseText(response);
  if (!response.ok) {
    throw error(`Maven Central request returned HTTP ${response.status}${text ? `: ${boundedDetail(text)}` : ""}`);
  }
  return text;
}

async function findDeployment({
  authorization,
  deadlineEpochSeconds,
  deploymentName,
  namespace,
  apiBase,
  fetchImpl,
  nowImpl,
}) {
  const url = new URL(`${apiBase.replace(/\/+$/u, "")}/deployments`);
  url.searchParams.set("namespace", namespace);
  url.searchParams.set("page", "0");
  url.searchParams.set("size", "100");
  const text = await centralRequest(url, {
    authorization,
    deadlineEpochSeconds,
    fetchImpl,
    nowImpl,
  });
  let value;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    throw error(`Maven Central deployments response is invalid JSON: ${cause.message}`);
  }
  const matches = value?.deployments?.filter((deployment) => deployment?.deploymentName === deploymentName) ?? [];
  if (matches.length > 1) {
    throw error(`Maven Central contains multiple deployments named ${deploymentName}`);
  }
  return matches[0] ?? null;
}

async function uploadBundle({
  bundle,
  authorization,
  deploymentName,
  namespace,
  apiBase,
  deadlineEpochSeconds,
  fetchImpl,
  nowImpl,
  sleep,
}) {
  const request = { authorization, deadlineEpochSeconds, fetchImpl, nowImpl };
  const existing = await findDeployment({
    ...request,
    deploymentName,
    namespace,
    apiBase,
  });
  if (existing !== null) {
    const id = existing.deploymentId;
    if (typeof id !== "string" || !DEPLOYMENT_ID.test(id)) {
      throw error(`Maven Central deployment ${deploymentName} has invalid deployment ID ${JSON.stringify(id)}`);
    }
    // A list response that already identifies a deployment as anything other
    // than FAILED is never eligible for deletion. This preserves the existing
    // VALIDATED promotion path and makes PUBLISHING/PUBLISHED fail-safe even
    // if a subsequent status response were inconsistent.
    if (existing.deploymentState !== undefined && existing.deploymentState !== "FAILED") {
      return id;
    }
    const status = await deploymentStatus({ id, apiBase, ...request });
    if (status?.deploymentState !== "FAILED") {
      return id;
    }
    if (status.deploymentId !== id) {
      throw error(
        `refusing to drop failed Maven Central deployment ${id}: status returned deployment ID ${JSON.stringify(status.deploymentId)}`,
      );
    }
    if (status.deploymentName !== undefined && status.deploymentName !== deploymentName) {
      throw error(
        `refusing to drop failed Maven Central deployment ${id}: status returned name ${JSON.stringify(status.deploymentName)}`,
      );
    }
    await centralRequest(`${apiBase.replace(/\/+$/u, "")}/deployment/${encodeURIComponent(id)}`, {
      ...request,
      method: "DELETE",
    });
    for (let attempt = 0; attempt < DROP_VISIBILITY_ATTEMPTS; attempt += 1) {
      const retained = await findDeployment({
        ...request,
        deploymentName,
        namespace,
        apiBase,
      });
      if (retained === null) {
        break;
      }
      if (retained.deploymentId !== id) {
        throw error(
          `Maven Central deployment name ${deploymentName} was reused by ${JSON.stringify(retained.deploymentId)} while dropping ${id}`,
        );
      }
      if (attempt === DROP_VISIBILITY_ATTEMPTS - 1) {
        throw error(`Maven Central failed deployment ${id} remained visible after it was dropped`);
      }
      await boundedSleep(DROP_VISIBILITY_INTERVAL_MS, {
        deadlineEpochSeconds,
        nowImpl,
        sleep,
        context: `Maven Central failed-deployment removal for ${id}`,
      });
    }
  }
  const url = new URL(`${apiBase.replace(/\/+$/u, "")}/upload`);
  url.searchParams.set("name", deploymentName);
  url.searchParams.set("publishingType", "USER_MANAGED");
  const form = new FormData();
  form.set("bundle", new Blob([readFileSync(bundle)], { type: "application/octet-stream" }), path.basename(bundle));
  try {
    const text = await centralRequest(url, {
      ...request,
      method: "POST",
      body: form,
    });
    const id = text.trim();
    if (!DEPLOYMENT_ID.test(id)) {
      throw error(`Maven Central upload returned invalid deployment ID ${JSON.stringify(id)}`);
    }
    return id;
  } catch (cause) {
    // Never retry an ambiguous upload. Reconcile by its lock-derived unique
    // name; if the server did not retain it, the caller can safely rerun.
    const reconciled = await findDeployment({
      ...request,
      deploymentName,
      namespace,
      apiBase,
    });
    if (reconciled !== null) {
      return reconciled.deploymentId;
    }
    throw cause;
  }
}

async function deploymentStatus({
  id,
  authorization,
  deadlineEpochSeconds,
  apiBase,
  fetchImpl,
  nowImpl,
}) {
  const url = new URL(`${apiBase.replace(/\/+$/u, "")}/status`);
  url.searchParams.set("id", id);
  const text = await centralRequest(url, {
    authorization,
    deadlineEpochSeconds,
    method: "POST",
    fetchImpl,
    nowImpl,
  });
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw error(`Maven Central status response is invalid JSON: ${cause.message}`);
  }
}

async function waitForDeployment({
  id,
  authorization,
  deadlineEpochSeconds,
  apiBase,
  fetchImpl,
  nowImpl,
  sleep,
  acceptable,
}) {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const status = await deploymentStatus({
      id,
      authorization,
      deadlineEpochSeconds,
      apiBase,
      fetchImpl,
      nowImpl,
    });
    if (status?.deploymentState === "FAILED") {
      throw error(`Maven Central deployment ${id} failed: ${boundedDetail(JSON.stringify(status.errors ?? status))}`);
    }
    if (acceptable.has(status?.deploymentState)) {
      return status;
    }
    if (TERMINAL_STATES.has(status?.deploymentState)) {
      throw error(`Maven Central deployment ${id} reached unexpected state ${status.deploymentState}`);
    }
    await boundedSleep(10_000, {
      deadlineEpochSeconds,
      nowImpl,
      sleep,
      context: `Maven Central deployment ${id} visibility wait`,
    });
  }
  throw error(`Maven Central deployment ${id} did not reach ${[...acceptable].join(" or ")} within 15 minutes`);
}

export async function publishFrozenMavenBundle({
  bundle,
  lockDigest,
  deploymentScope,
  namespace,
  username,
  password,
  deadlineEpochSeconds,
  apiBase = CENTRAL_API,
  fetchImpl = fetch,
  nowImpl = () => Date.now(),
  sleep = Bun.sleep,
}) {
  const authorization = mavenCentralAuthorization(username, password);
  if (typeof deploymentScope !== "string" || deploymentScope.length === 0) {
    throw error("deploymentScope is required to distinguish product subsets from one publication lock");
  }
  const scopeDigest = createHash("sha256").update(deploymentScope).digest("hex").slice(0, 12);
  const deploymentName = `oliphaunt-${lockDigest.slice(0, 16)}-${scopeDigest}`;
  const id = await uploadBundle({
    bundle,
    authorization,
    deploymentName,
    namespace,
    apiBase,
    deadlineEpochSeconds,
    fetchImpl,
    nowImpl,
    sleep,
  });
  const validated = await waitForDeployment({
    id,
    authorization,
    deadlineEpochSeconds,
    apiBase,
    fetchImpl,
    nowImpl,
    sleep,
    acceptable: new Set(["VALIDATED", "PUBLISHING", "PUBLISHED"]),
  });
  if (validated.deploymentState === "VALIDATED") {
    await centralRequest(`${apiBase.replace(/\/+$/u, "")}/deployment/${encodeURIComponent(id)}`, {
      authorization,
      deadlineEpochSeconds,
      method: "POST",
      fetchImpl,
      nowImpl,
    });
  }
  const published = validated.deploymentState === "PUBLISHED"
    ? validated
    : await waitForDeployment({
      id,
      authorization,
      deadlineEpochSeconds,
      apiBase,
      fetchImpl,
      nowImpl,
      sleep,
      acceptable: new Set(["PUBLISHED"]),
    });
  return { deploymentId: id, deploymentName, status: published };
}
