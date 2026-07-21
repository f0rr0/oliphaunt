import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { RegistryPublicationDeferredError } from "./registry-publication-deferral.mjs";
import { retryAfterSeconds } from "./registry-http-retry.mjs";

const DEFAULT_CRATES_IO_API = "https://crates.io/api/v1";
const MAX_U32 = 0xffff_ffff;
const UPLOAD_TIMEOUT_MS = 60_000;
const MAX_RATE_LIMIT_RETRIES = 3;
// Keep a nonempty interval between bounded in-process waits and the 15-minute
// continuation dispatcher ceiling. A normal crates.io 10-minute new-name
// refill is checkpointed instead of occupying a runner and still fits the
// authorized child dispatch delay including clock skew.
const MAX_RATE_LIMIT_WAIT_SECONDS = 9 * 60;
const MAX_RESPONSE_BYTES = 64 * 1024;
const RATE_LIMIT_CLOCK_SKEW_MS = 2_000;
const DEADLINE_RESERVE_MS = 5_000;

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function error(message) {
  return new Error(`frozen-cargo-publish: ${message}`);
}

function commandOutput(args, context) {
  const result = spawnSync(args[0], args.slice(1), {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error !== undefined || result.status !== 0) {
    const detail = (result.stderr || result.error?.message || "").trim();
    throw error(`${context} failed${detail ? `: ${detail}` : ""}`);
  }
  return result.stdout;
}

function checkedArchiveMember(rawMember, cratePath) {
  const directory = rawMember.endsWith("/");
  const member = directory ? rawMember.slice(0, -1) : rawMember;
  if (
    member.length === 0
    || member.includes("\\")
    || member.includes("\0")
    || member.startsWith("/")
    || /^[A-Za-z]:/u.test(member)
  ) {
    throw error(`${cratePath} contains unsafe archive member ${JSON.stringify(rawMember)}`);
  }
  const parts = member.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) {
    throw error(`${cratePath} contains unsafe archive member ${JSON.stringify(rawMember)}`);
  }
  return { directory, member: parts.join("/"), parts };
}

function crateArchiveLayout(cratePath) {
  const rawMembers = commandOutput(["tar", "-tzf", cratePath], `list ${cratePath}`)
    .split(/\r?\n/u)
    .filter(Boolean);
  if (rawMembers.length === 0) {
    throw error(`${cratePath} is empty`);
  }
  const members = rawMembers.map((member) => checkedArchiveMember(member, cratePath));
  const seen = new Set();
  for (const { member } of members) {
    if (seen.has(member)) {
      throw error(`${cratePath} repeats archive member ${member}`);
    }
    seen.add(member);
  }
  const roots = [...new Set(members.map(({ parts }) => parts[0]))];
  if (roots.length !== 1) {
    throw error(`${cratePath} must contain exactly one top-level crate root, found ${roots.length}`);
  }
  const manifestMembers = members.filter(({ directory, parts }) =>
    !directory && parts.length === 2 && parts[1] === "Cargo.toml");
  if (manifestMembers.length !== 1) {
    throw error(
      `${cratePath} must contain exactly one top-level crate Cargo.toml, found ${manifestMembers.length}`,
    );
  }
  return {
    root: roots[0],
    manifestMember: manifestMembers[0].member,
    files: new Set(members.filter(({ directory }) => !directory).map(({ member }) => member)),
  };
}

function archiveMemberText(cratePath, member) {
  return commandOutput(["tar", "-xOzf", cratePath, "--", member], `read ${member} from ${cratePath}`);
}

function relativeArchivePath(value, context) {
  if (
    value.length === 0
    || value.includes("\\")
    || value.includes("\0")
    || value.startsWith("/")
    || /^[A-Za-z]:/u.test(value)
  ) {
    throw error(`${context} must be a portable relative path inside the crate: ${value}`);
  }
  const parts = value.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) {
    throw error(`${context} must be a portable relative path inside the crate: ${value}`);
  }
  return parts.join("/");
}

function optionalString(value, context) {
  if (value === undefined || value === null || value === false) {
    return null;
  }
  if (typeof value !== "string") {
    throw error(`${context} must be a string when present`);
  }
  return value;
}

function stringList(value, context) {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw error(`${context} must be a string list`);
  }
  return value;
}

function dependencyRows(table, { kind, target }) {
  if (table === undefined) {
    return [];
  }
  if (table === null || Array.isArray(table) || typeof table !== "object") {
    throw error(`${target ?? "root"} ${kind} dependencies must be a table`);
  }
  return Object.entries(table).map(([alias, value]) => {
    const dependency = typeof value === "string" ? { version: value } : value;
    if (dependency === null || Array.isArray(dependency) || typeof dependency !== "object") {
      throw error(`dependency ${alias} must be a version string or table`);
    }
    if (typeof dependency.version !== "string" || dependency.version.length === 0) {
      throw error(`dependency ${alias} in a packaged crate must have a registry version`);
    }
    for (const forbidden of ["git", "path", "registry", "registry-index"]) {
      if (dependency[forbidden] !== undefined) {
        throw error(`dependency ${alias} retains forbidden ${forbidden} source metadata`);
      }
    }
    const renamedPackage = optionalString(dependency.package, `dependency ${alias}.package`);
    const artifactValue = dependency.artifact;
    const artifact = artifactValue === undefined
      ? undefined
      : stringList(Array.isArray(artifactValue) ? artifactValue : [artifactValue], `dependency ${alias}.artifact`);
    const bindepTarget = optionalString(dependency.target, `dependency ${alias}.target`);
    return {
      optional: dependency.optional === true,
      default_features: dependency["default-features"] !== false,
      name: renamedPackage ?? alias,
      features: stringList(dependency.features, `dependency ${alias}.features`),
      version_req: dependency.version,
      target,
      kind,
      ...(renamedPackage === null ? {} : { explicit_name_in_toml: alias }),
      ...(artifact === undefined ? {} : { artifact }),
      ...(bindepTarget === null ? {} : { bindep_target: bindepTarget }),
      ...(dependency.lib === true ? { lib: true } : {}),
    };
  });
}

function packageDependencies(manifest) {
  const dependencies = [
    ...dependencyRows(manifest.dependencies, { kind: "normal", target: null }),
    ...dependencyRows(manifest["build-dependencies"], { kind: "build", target: null }),
    ...dependencyRows(manifest["dev-dependencies"], { kind: "dev", target: null }),
  ];
  const targets = manifest.target ?? {};
  if (targets === null || Array.isArray(targets) || typeof targets !== "object") {
    throw error("target dependencies must be a table");
  }
  for (const [target, tables] of Object.entries(targets)) {
    if (tables === null || Array.isArray(tables) || typeof tables !== "object") {
      throw error(`target ${target} must be a table`);
    }
    dependencies.push(
      ...dependencyRows(tables.dependencies, { kind: "normal", target }),
      ...dependencyRows(tables["build-dependencies"], { kind: "build", target }),
      ...dependencyRows(tables["dev-dependencies"], { kind: "dev", target }),
    );
  }
  return dependencies.sort((left, right) =>
    compareText(
      `${left.target ?? ""}:${left.kind}:${left.name}:${left.explicit_name_in_toml ?? ""}`,
      `${right.target ?? ""}:${right.kind}:${right.name}:${right.explicit_name_in_toml ?? ""}`,
    ));
}

function stringMapOfLists(value, context) {
  if (value === undefined) {
    return {};
  }
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw error(`${context} must be a table`);
  }
  return Object.fromEntries(Object.entries(value).map(([name, members]) => [
    name,
    stringList(members, `${context}.${name}`),
  ]));
}

function badges(value) {
  if (value === undefined) {
    return {};
  }
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw error("badges must be a table");
  }
  return Object.fromEntries(Object.entries(value).map(([name, fields]) => {
    if (fields === null || Array.isArray(fields) || typeof fields !== "object") {
      throw error(`badge ${name} must be a table`);
    }
    const entries = Object.entries(fields);
    if (entries.some(([, field]) => typeof field !== "string")) {
      throw error(`badge ${name} fields must be strings`);
    }
    return [name, Object.fromEntries(entries)];
  }));
}

export function cargoPublishMetadataFromCrate(cratePath) {
  const layout = crateArchiveLayout(cratePath);
  const manifestMember = layout.manifestMember;
  let manifest;
  try {
    manifest = Bun.TOML.parse(archiveMemberText(cratePath, manifestMember));
  } catch (cause) {
    throw error(`cannot parse packaged Cargo.toml from ${cratePath}: ${cause.message}`);
  }
  const pkg = manifest.package;
  if (pkg === null || Array.isArray(pkg) || typeof pkg !== "object") {
    throw error(`${cratePath} packaged Cargo.toml must contain [package]`);
  }
  if (typeof pkg.name !== "string" || typeof pkg.version !== "string") {
    throw error(`${cratePath} packaged Cargo.toml must define package name and version`);
  }
  const expectedRoot = `${pkg.name}-${pkg.version}`;
  if (layout.root !== expectedRoot) {
    throw error(
      `${cratePath} top-level crate root must be ${expectedRoot}, found ${layout.root}`,
    );
  }
  const readmeFile = optionalString(pkg.readme, "package.readme");
  let readme = null;
  if (readmeFile !== null) {
    const readmeMember = `${layout.root}/${relativeArchivePath(readmeFile, "package.readme")}`;
    if (!layout.files.has(readmeMember)) {
      throw error(`${cratePath} does not contain declared README ${readmeFile}`);
    }
    readme = archiveMemberText(cratePath, readmeMember);
  }
  return {
    name: pkg.name,
    vers: pkg.version,
    deps: packageDependencies(manifest),
    features: stringMapOfLists(manifest.features, "features"),
    authors: stringList(pkg.authors, "package.authors"),
    description: optionalString(pkg.description, "package.description"),
    documentation: optionalString(pkg.documentation, "package.documentation"),
    homepage: optionalString(pkg.homepage, "package.homepage"),
    readme,
    readme_file: readmeFile,
    keywords: stringList(pkg.keywords, "package.keywords"),
    categories: stringList(pkg.categories, "package.categories"),
    license: optionalString(pkg.license, "package.license"),
    license_file: optionalString(pkg["license-file"], "package.license-file"),
    repository: optionalString(pkg.repository, "package.repository"),
    badges: badges(manifest.badges),
    links: optionalString(pkg.links, "package.links"),
    rust_version: optionalString(pkg["rust-version"], "package.rust-version"),
  };
}

export function encodeCargoPublishRequest(metadata, crateBytes) {
  const json = Buffer.from(JSON.stringify(metadata), "utf8");
  const bytes = Buffer.from(crateBytes);
  if (json.length > MAX_U32 || bytes.length > MAX_U32) {
    throw error("publish metadata or crate exceeds the registry protocol u32 length limit");
  }
  const jsonLength = Buffer.allocUnsafe(4);
  jsonLength.writeUInt32LE(json.length);
  const crateLength = Buffer.allocUnsafe(4);
  crateLength.writeUInt32LE(bytes.length);
  return Buffer.concat([jsonLength, json, crateLength, bytes]);
}

function responseDetail(body) {
  try {
    const parsed = JSON.parse(body);
    const details = parsed?.errors?.map?.((item) => item?.detail).filter((item) => typeof item === "string");
    if (details?.length > 0) {
      return details.join("; ").slice(0, 500);
    }
  } catch {
    // Fall through to the bounded plain-text diagnostic.
  }
  return body.replace(/[\r\n\t]+/gu, " ").trim().slice(0, 500);
}

function cargoPublishResponse(body, identity) {
  if (body.length === 0) {
    return { warnings: { invalid_categories: [], invalid_badges: [], other: [] } };
  }
  let value;
  try {
    value = JSON.parse(body);
  } catch (cause) {
    throw error(`registry upload returned invalid JSON: ${cause.message}`);
  }
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw error("registry upload success response must be a JSON object");
  }
  if (Object.hasOwn(value, "errors")) {
    const details = Array.isArray(value.errors)
      ? value.errors.map((item) => item?.detail).filter((item) => typeof item === "string" && item.length > 0)
      : [];
    throw error(
      `registry rejected ${identity} despite HTTP success${details.length > 0 ? `: ${details.join("; ").slice(0, 500)}` : ": malformed errors response"}`,
    );
  }
  const warnings = value.warnings ?? {};
  if (warnings === null || Array.isArray(warnings) || typeof warnings !== "object") {
    throw error("registry upload warnings must be an object when present");
  }
  const normalized = {};
  for (const field of ["invalid_categories", "invalid_badges", "other"]) {
    const messages = warnings[field] ?? [];
    if (!Array.isArray(messages) || messages.some((message) => typeof message !== "string")) {
      throw error(`registry upload warnings.${field} must be a string list`);
    }
    normalized[field] = messages;
  }
  for (const category of normalized.invalid_categories) {
    console.warn(`crates.io ignored invalid category for ${identity}: ${category}`);
  }
  for (const badge of normalized.invalid_badges) {
    console.warn(`crates.io ignored invalid badge for ${identity}: ${badge}`);
  }
  for (const warning of normalized.other) {
    console.warn(`crates.io warning for ${identity}: ${warning}`);
  }
  return { ...value, warnings: normalized };
}

async function boundedResponseText(response, identity) {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const declared = Number(contentLength);
    if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
      await response.body?.cancel?.().catch(() => {});
      throw error(`registry response for ${identity} exceeds ${MAX_RESPONSE_BYTES} bytes`);
    }
  }
  if (response.body?.getReader === undefined) {
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) {
      throw error(`registry response for ${identity} exceeds ${MAX_RESPONSE_BYTES} bytes`);
    }
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {});
      throw error(`registry response for ${identity} exceeds ${MAX_RESPONSE_BYTES} bytes`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function publishFrozenCargoCrate({
  cratePath,
  expectedName,
  expectedVersion,
  token,
  apiBase = process.env.CRATES_IO_API ?? DEFAULT_CRATES_IO_API,
  fetchImpl = fetch,
  sleepImpl = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  nowImpl = Date.now,
  deadlineEpochMs = undefined,
  maxRateLimitRetries = MAX_RATE_LIMIT_RETRIES,
}) {
  if (typeof token !== "string" || token.length === 0) {
    throw error("CARGO_REGISTRY_TOKEN is required");
  }
  if (
    deadlineEpochMs !== undefined
    && (!Number.isSafeInteger(deadlineEpochMs) || deadlineEpochMs <= 0)
  ) {
    throw error("registry mutation deadline must be a positive Unix timestamp in milliseconds");
  }
  if (!Number.isSafeInteger(maxRateLimitRetries) || maxRateLimitRetries < 0 || maxRateLimitRetries > 10) {
    throw error("maxRateLimitRetries must be an integer from 0 through 10");
  }
  const metadata = cargoPublishMetadataFromCrate(cratePath);
  if (metadata.name !== expectedName || metadata.vers !== expectedVersion) {
    throw error(
      `${cratePath} identifies ${metadata.name}@${metadata.vers}, expected ${expectedName}@${expectedVersion}`,
    );
  }
  const body = encodeCargoPublishRequest(metadata, readFileSync(cratePath));
  const url = `${apiBase.replace(/\/+$/u, "")}/crates/new`;
  const identity = `${metadata.name}@${metadata.vers}`;
  for (let rateLimitAttempt = 0; ; rateLimitAttempt += 1) {
    const now = nowImpl();
    if (deadlineEpochMs !== undefined && now + DEADLINE_RESERVE_MS >= deadlineEpochMs) {
      throw new RegistryPublicationDeferredError({
        reason: "deadline",
        notBeforeEpochSeconds: Math.floor(now / 1000) + 1,
        context: `registry mutation deadline expired before uploading ${identity}`,
      });
    }
    const timeoutMs = deadlineEpochMs === undefined
      ? UPLOAD_TIMEOUT_MS
      : Math.min(UPLOAD_TIMEOUT_MS, Math.max(1, deadlineEpochMs - now - DEADLINE_RESERVE_MS));
    const response = await fetchImpl(url, {
      method: "PUT",
      headers: {
        Accept: "application/json",
        Authorization: token,
        "Content-Type": "application/octet-stream",
        "User-Agent": "oliphaunt-frozen-publisher/1; https://github.com/f0rr0/oliphaunt",
      },
      body,
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const responseBody = await boundedResponseText(response, identity);
    if (response.ok) {
      return cargoPublishResponse(responseBody, identity);
    }
    const detail = responseDetail(responseBody);
    if (response.status !== 429) {
      throw error(`registry upload for ${identity} returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
    }

    // crates.io checks its leaky bucket before storing a rejected upload and
    // returns the next permitted time in Retry-After. That explicit 429 is the
    // only failed mutation response that is safe to replay automatically. All
    // transport and other HTTP failures remain ambiguous and return to the
    // caller for an immutable-version registry check.
    const retryAfter = retryAfterSeconds(response.headers, now);
    if (retryAfter === null || !Number.isFinite(retryAfter)) {
      throw error(`registry rate limited ${identity} without a valid Retry-After header${detail ? `: ${detail}` : ""}`);
    }
    const delayMs = Math.ceil(retryAfter * 1000) + RATE_LIMIT_CLOCK_SKEW_MS;
    if (rateLimitAttempt >= maxRateLimitRetries) {
      throw new RegistryPublicationDeferredError({
        reason: "rate-limit",
        notBeforeEpochSeconds: Math.ceil((now + delayMs) / 1000),
        context: `crates.io rejected ${identity} ${rateLimitAttempt + 1} times with valid Retry-After headers`,
      });
    }
    if (retryAfter > MAX_RATE_LIMIT_WAIT_SECONDS) {
      throw new RegistryPublicationDeferredError({
        reason: "rate-limit",
        notBeforeEpochSeconds: Math.ceil((now + delayMs) / 1000),
        context: `crates.io rejected ${identity} with a valid Retry-After beyond the bounded in-process wait`,
      });
    }
    if (deadlineEpochMs !== undefined && now + delayMs + DEADLINE_RESERVE_MS >= deadlineEpochMs) {
      throw new RegistryPublicationDeferredError({
        reason: "rate-limit",
        notBeforeEpochSeconds: Math.ceil((now + delayMs) / 1000),
        context: `crates.io rejected ${identity} and its valid Retry-After cannot clear before the bounded registry mutation deadline`,
      });
    }
    console.warn(
      `crates.io rate limited ${identity}; retrying the exact frozen bytes after ${Math.ceil(delayMs / 1000)}s`,
    );
    await sleepImpl(delayMs);
  }
}
