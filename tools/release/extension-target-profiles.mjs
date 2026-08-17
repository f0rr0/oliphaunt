import { readFileSync } from "node:fs";
import path from "node:path";

export const EXTENSION_TARGET_PROFILES_RELATIVE_PATH = "tools/release/extension-target-profiles.toml";
const ROOT = path.resolve(import.meta.dir, "../..");
const ID = /^[a-z][a-z0-9_-]*$/u;

function fail(message) {
  throw new Error(`extension target profiles: ${message}`);
}

function table(value, label) {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    fail(`${label} must be a table`);
  }
  return value;
}

function exactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    fail(`${label} fields must be exactly ${wanted.join(", ")}; got ${actual.join(", ")}`);
  }
}

function id(value, label) {
  if (typeof value !== "string" || !ID.test(value)) {
    fail(`${label} must match ${ID}`);
  }
  return value;
}

export function validateExtensionTargetProfiles(raw) {
  table(raw, "root");
  exactKeys(raw, ["profiles", "schema"], "root");
  if (raw.schema !== "oliphaunt-extension-artifact-target-profiles-v1") {
    fail("schema must be oliphaunt-extension-artifact-target-profiles-v1");
  }
  if (!Array.isArray(raw.profiles) || raw.profiles.length === 0) {
    fail("profiles must be a non-empty array");
  }

  const profileIds = new Set();
  const targets = new Set();
  const profiles = raw.profiles.map((rawProfile, profileIndex) => {
    const profile = table(rawProfile, `profiles[${profileIndex}]`);
    exactKeys(profile, ["id", "targets"], `profiles[${profileIndex}]`);
    const profileId = id(profile.id, `profiles[${profileIndex}].id`);
    if (profileIds.has(profileId)) fail(`duplicate profile ${profileId}`);
    profileIds.add(profileId);
    if (!Array.isArray(profile.targets) || profile.targets.length === 0) {
      fail(`profile ${profileId} must define a non-empty targets array`);
    }
    const rows = profile.targets.map((rawTarget, targetIndex) => {
      const target = table(rawTarget, `profile ${profileId} targets[${targetIndex}]`);
      exactKeys(target, ["family", "kind", "target"], `profile ${profileId} targets[${targetIndex}]`);
      const targetId = id(target.target, `profile ${profileId} targets[${targetIndex}].target`);
      if (targets.has(targetId)) fail(`duplicate target ${targetId}`);
      targets.add(targetId);
      return Object.freeze({
        profileId,
        target: targetId,
        family: id(target.family, `target ${targetId}.family`),
        kind: id(target.kind, `target ${targetId}.kind`),
      });
    });
    return Object.freeze({ id: profileId, targets: Object.freeze(rows) });
  });

  return Object.freeze({
    schema: raw.schema,
    profiles: Object.freeze(profiles),
    targets: Object.freeze(profiles.flatMap((profile) => profile.targets)),
  });
}

export function loadExtensionTargetProfiles({
  file = path.join(ROOT, EXTENSION_TARGET_PROFILES_RELATIVE_PATH),
} = {}) {
  try {
    return validateExtensionTargetProfiles(Bun.TOML.parse(readFileSync(file, "utf8")));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("extension target profiles:")) throw error;
    fail(`cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
