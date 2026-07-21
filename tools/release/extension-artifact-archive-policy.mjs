import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");
export const EXTENSION_ARTIFACT_ARCHIVE_POLICY_PATH =
  "src/sdks/rust/extension-artifact-archive-policy.properties";

const EXPECTED_SCHEMA = "oliphaunt-extension-artifact-archive-policy-v1";
const EXPECTED_KEYS = Object.freeze([
  "schema",
  "maxCompressedBytes",
  "maxExpandedBytes",
  "maxMemberBytes",
  "maxMembers",
]);

function fail(message) {
  throw new Error(`extension artifact archive policy: ${message}`);
}

function parseCanonicalProperties(text) {
  if (
    text.includes("\r")
    || !text.endsWith("\n")
    || text.endsWith("\n\n")
    || text !== text.normalize("NFC")
  ) {
    fail("must use canonical NFC UTF-8 key=value text with LF lines and one final newline");
  }
  const values = new Map();
  for (const [index, line] of text.slice(0, -1).split("\n").entries()) {
    const separator = line.indexOf("=");
    if (separator <= 0 || separator === line.length - 1) {
      fail(`line ${index + 1} must be a non-empty key=value pair`);
    }
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    if (values.has(key)) fail(`repeats property ${key}`);
    values.set(key, value);
  }
  if (JSON.stringify([...values.keys()]) !== JSON.stringify(EXPECTED_KEYS)) {
    fail(`property keys must be exactly ${EXPECTED_KEYS.join(",")}`);
  }
  if (values.get("schema") !== EXPECTED_SCHEMA) {
    fail(`schema must be ${EXPECTED_SCHEMA}`);
  }
  const positiveInteger = (key) => {
    const value = Number(values.get(key));
    if (!Number.isSafeInteger(value) || value <= 0 || String(value) !== values.get(key)) {
      fail(`${key} must be a canonical positive safe integer`);
    }
    return value;
  };
  const policy = {
    maxCompressedBytes: positiveInteger("maxCompressedBytes"),
    maxExpandedBytes: positiveInteger("maxExpandedBytes"),
    maxMemberBytes: positiveInteger("maxMemberBytes"),
    maxMembers: positiveInteger("maxMembers"),
  };
  if (policy.maxMemberBytes > policy.maxExpandedBytes) {
    fail("maxMemberBytes must not exceed maxExpandedBytes");
  }
  return Object.freeze(policy);
}

export const EXTENSION_ARTIFACT_ARCHIVE_POLICY = parseCanonicalProperties(
  readFileSync(path.join(ROOT, EXTENSION_ARTIFACT_ARCHIVE_POLICY_PATH), "utf8"),
);

export function validateExtensionArtifactArchivePlan(members, label = "extension artifact") {
  if (!Array.isArray(members) || members.length === 0) {
    fail(`${label} must contain at least one regular member`);
  }
  if (members.length > EXTENSION_ARTIFACT_ARCHIVE_POLICY.maxMembers) {
    fail(`${label} contains more than ${EXTENSION_ARTIFACT_ARCHIVE_POLICY.maxMembers} members`);
  }
  let expandedBytes = 1024;
  for (const [index, member] of members.entries()) {
    const bytes = member?.bytes;
    const name = typeof member?.name === "string" && member.name.length > 0
      ? member.name
      : `member ${index}`;
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      fail(`${label} ${name} has an invalid byte count`);
    }
    if (bytes > EXTENSION_ARTIFACT_ARCHIVE_POLICY.maxMemberBytes) {
      fail(
        `${label} member ${name} exceeds ${EXTENSION_ARTIFACT_ARCHIVE_POLICY.maxMemberBytes} bytes`,
      );
    }
    const padded = Math.ceil(bytes / 512) * 512;
    expandedBytes += 512 + padded;
    if (!Number.isSafeInteger(expandedBytes)) {
      fail(`${label} expanded size overflows a safe integer`);
    }
    if (expandedBytes > EXTENSION_ARTIFACT_ARCHIVE_POLICY.maxExpandedBytes) {
      fail(
        `${label} expands beyond ${EXTENSION_ARTIFACT_ARCHIVE_POLICY.maxExpandedBytes} bytes`,
      );
    }
  }
  return expandedBytes;
}

export function validateExtensionArtifactCompressedBytes(bytes, label = "extension artifact") {
  if (
    !Number.isSafeInteger(bytes)
    || bytes <= 0
    || bytes > EXTENSION_ARTIFACT_ARCHIVE_POLICY.maxCompressedBytes
  ) {
    fail(
      `${label} compressed bytes must be between 1 and ${EXTENSION_ARTIFACT_ARCHIVE_POLICY.maxCompressedBytes}`,
    );
  }
  return bytes;
}
