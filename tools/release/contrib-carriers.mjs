import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export const CONTRIB_CARRIERS_PATH = "src/extensions/contrib/carriers.toml";

function fail(prefix, message) {
  throw new Error(`${prefix}: ${message}`);
}

function toml(root, relativePath, prefix) {
  const file = path.join(root, relativePath);
  if (!existsSync(file)) fail(prefix, `missing ${relativePath}`);
  const value = Bun.TOML.parse(readFileSync(file, "utf8"));
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    fail(prefix, `${relativePath} must contain a TOML table`);
  }
  return value;
}

function string(value, context, prefix) {
  if (typeof value !== "string" || value.length === 0) fail(prefix, `${context} must be a non-empty string`);
  return value;
}

export function loadContribCarriers(root, prefix = "contrib-carriers") {
  const descriptor = toml(root, CONTRIB_CARRIERS_PATH, prefix);
  const artifactProduct = string(descriptor.logical_product, "logical_product", prefix);
  const memberManifest = string(descriptor.member_manifest, "member_manifest", prefix);
  const source = string(descriptor.source, "source", prefix);
  const contract = string(descriptor.contract, "contract", prefix);
  const nativeOwner = string(descriptor.native_owner, "native_owner", prefix);
  const wasixOwner = string(descriptor.wasix_owner, "wasix_owner", prefix);
  const members = toml(root, memberManifest, prefix).extensions;
  if (!Array.isArray(members) || members.some((member) =>
    member === null || Array.isArray(member) || typeof member !== "object" || typeof member.id !== "string"
  )) {
    fail(prefix, `${memberManifest}.extensions must name contrib member ids`);
  }
  const ids = members.map(({ id }) => id);
  if (new Set(ids).size !== ids.length) fail(prefix, `${memberManifest}.extensions ids must be unique`);
  const inputFiles = [
    CONTRIB_CARRIERS_PATH,
    memberManifest,
    "tools/release/extension-target-profiles.toml",
    source,
    contract,
  ];
  for (const file of inputFiles) {
    if (!existsSync(path.join(root, file))) fail(prefix, `missing contrib carrier input ${file}`);
  }
  return {
    artifactProduct,
    contract,
    inputFiles,
    memberManifest,
    members,
    nativeOwner,
    source,
    wasixOwner,
  };
}
