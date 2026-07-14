import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { mavenCentralAuthorization } from "./maven-central-auth.mjs";
import { lockedCarrierFiles, lockedCarriers } from "./publication-lock.mjs";
import { ROOT } from "./release-cli-utils.mjs";

const CENTRAL_API = "https://central.sonatype.com/api/v1/publisher";
const TERMINAL_STATES = new Set(["PUBLISHED", "FAILED"]);
const DEPLOYMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const DROP_VISIBILITY_ATTEMPTS = 30;
const DROP_VISIBILITY_INTERVAL_MS = 1_000;
const MAX_CENTRAL_RESPONSE_BYTES = 1024 * 1024;

function error(message) {
  return new Error(`frozen-maven-publish: ${message}`);
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
  const result = spawnSync(args[0], args.slice(1), {
    cwd,
    encoding: "utf8",
    input,
    maxBuffer: 10 * 1024 * 1024,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
  if (result.error !== undefined || result.status !== 0) {
    const detail = (result.stderr || result.error?.message || "").trim();
    throw error(`${context} failed${detail ? `: ${detail}` : ""}`);
  }
  return result.stdout;
}

export function createGpgSigner({ privateKey, keyId, passphrase, home }) {
  if (![privateKey, keyId, passphrase].every((value) => typeof value === "string" && value.length > 0)) {
    throw error("Maven signing key, key ID, and passphrase are required");
  }
  mkdirSync(home, { recursive: true });
  chmodSync(home, 0o700);
  run(["gpg", "--batch", "--homedir", home, "--import"], {
    input: privateKey,
    context: "import Maven signing key",
  });
  return (file, signature) => {
    run([
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
      keyId,
      "--armor",
      "--detach-sign",
      "--output",
      signature,
      file,
    ], { input: `${passphrase}\n`, context: `sign ${path.basename(file)}` });
  };
}

export function prepareFrozenMavenBundle({ lock, products, outputRoot, signFile }) {
  if (typeof signFile !== "function") {
    throw error("signFile callback is required");
  }
  const carriers = lockedCarriers(lock, { products, ecosystem: "maven" })
    .sort((left, right) => left.publishOrder - right.publishOrder || left.id.localeCompare(right.id));
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
  }
  for (const payload of payloads) {
    signFile(payload.staged, `${payload.staged}.asc`);
    writeFileSync(`${payload.staged}.md5`, digestFile(payload.staged, "md5"));
    writeFileSync(`${payload.staged}.sha1`, digestFile(payload.staged, "sha1"));
  }
  run(["zip", "-q", "-X", "-r", bundle, "."], { cwd: layout, context: "create Maven Central deployment bundle" });
  return { bundle, carriers, layout, payloads };
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

async function centralRequest(url, { authorization, method = "GET", body = undefined, fetchImpl = fetch }) {
  const response = await fetchImpl(url, {
    method,
    headers: {
      Accept: "application/json",
      Authorization: authorization,
    },
    body,
    redirect: "error",
    signal: AbortSignal.timeout(60_000),
  });
  const text = await boundedResponseText(response);
  if (!response.ok) {
    throw error(`Maven Central request returned HTTP ${response.status}${text ? `: ${boundedDetail(text)}` : ""}`);
  }
  return text;
}

async function findDeployment({ authorization, deploymentName, namespace, apiBase, fetchImpl }) {
  const url = new URL(`${apiBase.replace(/\/+$/u, "")}/deployments`);
  url.searchParams.set("namespace", namespace);
  url.searchParams.set("page", "0");
  url.searchParams.set("size", "100");
  const text = await centralRequest(url, { authorization, fetchImpl });
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
  fetchImpl,
  sleep,
}) {
  const existing = await findDeployment({ authorization, deploymentName, namespace, apiBase, fetchImpl });
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
    const status = await deploymentStatus({ id, authorization, apiBase, fetchImpl });
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
      authorization,
      method: "DELETE",
      fetchImpl,
    });
    for (let attempt = 0; attempt < DROP_VISIBILITY_ATTEMPTS; attempt += 1) {
      const retained = await findDeployment({ authorization, deploymentName, namespace, apiBase, fetchImpl });
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
      await sleep(DROP_VISIBILITY_INTERVAL_MS);
    }
  }
  const url = new URL(`${apiBase.replace(/\/+$/u, "")}/upload`);
  url.searchParams.set("name", deploymentName);
  url.searchParams.set("publishingType", "USER_MANAGED");
  const form = new FormData();
  form.set("bundle", new Blob([readFileSync(bundle)], { type: "application/octet-stream" }), path.basename(bundle));
  try {
    const text = await centralRequest(url, {
      authorization,
      method: "POST",
      body: form,
      fetchImpl,
    });
    const id = text.trim();
    if (!DEPLOYMENT_ID.test(id)) {
      throw error(`Maven Central upload returned invalid deployment ID ${JSON.stringify(id)}`);
    }
    return id;
  } catch (cause) {
    // Never retry an ambiguous upload. Reconcile by its lock-derived unique
    // name; if the server did not retain it, the caller can safely rerun.
    const reconciled = await findDeployment({ authorization, deploymentName, namespace, apiBase, fetchImpl });
    if (reconciled !== null) {
      return reconciled.deploymentId;
    }
    throw cause;
  }
}

async function deploymentStatus({ id, authorization, apiBase, fetchImpl }) {
  const url = new URL(`${apiBase.replace(/\/+$/u, "")}/status`);
  url.searchParams.set("id", id);
  const text = await centralRequest(url, { authorization, method: "POST", fetchImpl });
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw error(`Maven Central status response is invalid JSON: ${cause.message}`);
  }
}

async function waitForDeployment({ id, authorization, apiBase, fetchImpl, sleep, acceptable }) {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const status = await deploymentStatus({ id, authorization, apiBase, fetchImpl });
    if (status?.deploymentState === "FAILED") {
      throw error(`Maven Central deployment ${id} failed: ${boundedDetail(JSON.stringify(status.errors ?? status))}`);
    }
    if (acceptable.has(status?.deploymentState)) {
      return status;
    }
    if (TERMINAL_STATES.has(status?.deploymentState)) {
      throw error(`Maven Central deployment ${id} reached unexpected state ${status.deploymentState}`);
    }
    await sleep(10_000);
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
  apiBase = CENTRAL_API,
  fetchImpl = fetch,
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
    fetchImpl,
    sleep,
  });
  const validated = await waitForDeployment({
    id,
    authorization,
    apiBase,
    fetchImpl,
    sleep,
    acceptable: new Set(["VALIDATED", "PUBLISHING", "PUBLISHED"]),
  });
  if (validated.deploymentState === "VALIDATED") {
    await centralRequest(`${apiBase.replace(/\/+$/u, "")}/deployment/${encodeURIComponent(id)}`, {
      authorization,
      method: "POST",
      fetchImpl,
    });
  }
  const published = validated.deploymentState === "PUBLISHED"
    ? validated
    : await waitForDeployment({
      id,
      authorization,
      apiBase,
      fetchImpl,
      sleep,
      acceptable: new Set(["PUBLISHED"]),
    });
  return { deploymentId: id, deploymentName, status: published };
}
