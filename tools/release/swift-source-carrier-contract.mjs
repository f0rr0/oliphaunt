import { readFileSync } from "node:fs";
import path from "node:path";

import { IOS_CARRIER_SCHEMA } from "./ios-carrier-manifest.mjs";
import { parseSwiftReleaseBinaryTarget } from "./prepare-swift-release-consumer.mjs";

const STABLE_SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;
const CANONICAL_REPOSITORY = "https://github.com/f0rr0/oliphaunt";

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function error(label, message) {
  return new Error(`${label}: ${message}`);
}

function exactKeys(value, expected, label) {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw error(label, "must be an object");
  }
  const actual = Object.keys(value).sort(compareText);
  const canonical = [...expected].sort(compareText);
  if (JSON.stringify(actual) !== JSON.stringify(canonical)) {
    throw error(
      label,
      `fields must be exactly ${canonical.join(",")}; got ${actual.join(",")}`,
    );
  }
  return value;
}

function safeArchiveMember(value, label) {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.includes("\\")
    || value.startsWith("/")
    || /^[A-Za-z]:/u.test(value)
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw error(label, "must be a safe POSIX archive path");
  }
  const parts = value.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) {
    throw error(label, "must be a safe POSIX archive path");
  }
  return value;
}

function portableFilename(value, label) {
  if (
    typeof value !== "string"
    || value.length === 0
    || path.posix.basename(value) !== value
    || /[<>:"/\\|?*\u0000-\u001f\u007f]/u.test(value)
    || /[ .]$/u.test(value)
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(value)
  ) {
    throw error(label, "must be a portable release asset filename");
  }
  return value;
}

/**
 * Validate the carrier embedded in an Oliphaunt Swift source tag.
 *
 * Source tags intentionally freeze only the compatible native base. Optional
 * extensions are supplied by their independently versioned release carriers,
 * so both carrier and extension inventories must remain empty here.
 */
export function validateSelectionNeutralSwiftSourceCarrier(
  document,
  label = "oliphaunt-swift source-tag carrier",
) {
  const root = exactKeys(
    document,
    ["base", "carriers", "extensions", "schema"],
    label,
  );
  if (root.schema !== IOS_CARRIER_SCHEMA) {
    throw error(label, `schema must be ${IOS_CARRIER_SCHEMA}`);
  }
  if (!Array.isArray(root.carriers) || root.carriers.length !== 0) {
    throw error(
      `${label}.carriers`,
      "must be an empty array; source tags do not own extension payload carriers",
    );
  }
  if (!Array.isArray(root.extensions) || root.extensions.length !== 0) {
    throw error(
      `${label}.extensions`,
      "must be an empty array; source tags are selection-neutral",
    );
  }

  const base = exactKeys(
    root.base,
    ["assets", "product", "tag", "version"],
    `${label}.base`,
  );
  if (base.product !== "liboliphaunt-native") {
    throw error(`${label}.base.product`, "must be liboliphaunt-native");
  }
  if (typeof base.version !== "string" || !STABLE_SEMVER.test(base.version)) {
    throw error(`${label}.base.version`, "must be a stable SemVer X.Y.Z version");
  }
  const expectedTag = `${base.product}-v${base.version}`;
  if (base.tag !== expectedTag) {
    throw error(`${label}.base.tag`, `must be ${expectedTag}`);
  }

  const assetContracts = [
    {
      format: "zip",
      member: "liboliphaunt.xcframework",
      name: `liboliphaunt-${base.version}-apple-spm-xcframework.zip`,
      role: "base-xcframework",
    },
    {
      format: "tar.gz",
      member: "oliphaunt",
      name: `liboliphaunt-${base.version}-runtime-resources.tar.gz`,
      role: "runtime-resources",
    },
    {
      format: "tar.gz",
      member: "share/icu",
      name: `liboliphaunt-${base.version}-icu-data.tar.gz`,
      role: "icu-data",
    },
  ];
  if (!Array.isArray(base.assets) || base.assets.length !== assetContracts.length) {
    throw error(
      `${label}.base.assets`,
      `must contain exactly ${assetContracts.length} native base assets`,
    );
  }
  for (const [index, contract] of assetContracts.entries()) {
    const assetLabel = `${label}.base.assets[${index}]`;
    const asset = exactKeys(
      base.assets[index],
      ["bytes", "format", "member", "name", "role", "sha256", "url"],
      assetLabel,
    );
    portableFilename(asset.name, `${assetLabel}.name`);
    safeArchiveMember(asset.member, `${assetLabel}.member`);
    for (const key of ["format", "member", "name", "role"]) {
      if (asset[key] !== contract[key]) {
        throw error(`${assetLabel}.${key}`, `must be ${contract[key]}`);
      }
    }
    if (!Number.isSafeInteger(asset.bytes) || asset.bytes <= 0) {
      throw error(`${assetLabel}.bytes`, "must be a positive safe integer");
    }
    if (typeof asset.sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(asset.sha256)) {
      throw error(`${assetLabel}.sha256`, "must be a lowercase SHA-256 digest");
    }
    let assetUrl;
    try {
      assetUrl = new URL(asset.url);
    } catch {
      throw error(`${assetLabel}.url`, "must be an absolute HTTPS URL");
    }
    let urlName;
    try {
      urlName = decodeURIComponent(path.posix.basename(assetUrl.pathname));
    } catch {
      throw error(`${assetLabel}.url`, "contains invalid percent encoding");
    }
    if (
      assetUrl.protocol !== "https:"
      || assetUrl.username !== ""
      || assetUrl.password !== ""
      || assetUrl.search !== ""
      || assetUrl.hash !== ""
      || urlName !== asset.name
    ) {
      throw error(
        `${assetLabel}.url`,
        `must be a credential-free HTTPS URL ending in ${asset.name}`,
      );
    }
    const urlParts = assetUrl.pathname.split("/").filter(Boolean).map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        throw error(`${assetLabel}.url`, "contains invalid percent encoding");
      }
    });
    if (
      urlParts.length < 4
      || JSON.stringify(urlParts.slice(-4))
        !== JSON.stringify(["releases", "download", expectedTag, asset.name])
    ) {
      throw error(
        `${assetLabel}.url`,
        `must address ${asset.name} under release tag ${expectedTag}`,
      );
    }
  }
  return root;
}

export function validateSelectionNeutralSwiftSourceCarrierFile(
  carrier,
  label = String(carrier),
) {
  let document;
  try {
    document = JSON.parse(readFileSync(carrier, "utf8"));
  } catch (cause) {
    throw error(label, `is not valid JSON: ${cause.message}`);
  }
  return validateSelectionNeutralSwiftSourceCarrier(document, label);
}

/**
 * Bind a selection-neutral Apple carrier to the public Oliphaunt release
 * namespace and, when supplied, the exact native version selected by the
 * release graph. This contract is shared by SwiftPM source tags and the
 * carrier embedded in the React Native npm package.
 */
export function validateSelectionNeutralSwiftCarrierIdentity({
  carrier,
  expectedNativeVersion,
  repository = CANONICAL_REPOSITORY,
  label = "selection-neutral Apple carrier",
}) {
  if (repository !== CANONICAL_REPOSITORY) {
    throw error(`${label}.repository`, `must be ${CANONICAL_REPOSITORY}`);
  }
  const validated = validateSelectionNeutralSwiftSourceCarrier(
    carrier,
    `${label}.carrier`,
  );
  if (
    expectedNativeVersion !== undefined
    && validated.base.version !== expectedNativeVersion
  ) {
    throw error(
      `${label}.carrier.base.version`,
      `must match liboliphaunt-native ${expectedNativeVersion}`,
    );
  }
  for (const asset of validated.base.assets) {
    const expectedUrl = `${repository}/releases/download/${validated.base.tag}/${asset.name}`;
    if (asset.url !== expectedUrl) {
      throw error(`${label}.carrier.base.assets.${asset.role}.url`, `must be ${expectedUrl}`);
    }
  }
  return validated;
}

export function validateSwiftSourceReleaseContract({
  carrier,
  manifestText,
  expectedNativeVersion,
  repository = CANONICAL_REPOSITORY,
  label = "oliphaunt-swift source release",
}) {
  const validated = validateSelectionNeutralSwiftCarrierIdentity({
    carrier,
    expectedNativeVersion,
    repository,
    label,
  });
  const binaryTarget = parseSwiftReleaseBinaryTarget(
    manifestText,
    `${label} Package.swift.release`,
  );
  const xcframework = validated.base.assets.find(({ role }) => role === "base-xcframework");
  if (binaryTarget.url !== xcframework.url) {
    throw error(
      `${label} Package.swift.release binary target URL`,
      `must match ${xcframework.url}`,
    );
  }
  if (binaryTarget.checksum !== xcframework.sha256) {
    throw error(
      `${label} Package.swift.release binary target checksum`,
      `must match carrier SHA-256 ${xcframework.sha256}`,
    );
  }
  return { binaryTarget, carrier: validated };
}
