import { ROOT } from "./release-artifact-targets.mjs";
import {
  WASIX_TOOLCHAIN_PATH,
  canonicalWasixCargoToolchainVersions,
} from "./wasix-cargo-toolchain-policy.mjs";

export { WASIX_TOOLCHAIN_PATH };
export const STABLE_WASIX_SOURCE_LANE = "stable";
export const WASIX_AOT_ENGINE = "llvm-opta";

function requiredString(value, context) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${context} must be a non-empty string`);
  }
  return value;
}

export function canonicalWasixAotMetadata(root = ROOT) {
  const toolchain = canonicalWasixCargoToolchainVersions(root);
  return {
    sourceLane: STABLE_WASIX_SOURCE_LANE,
    engine: WASIX_AOT_ENGINE,
    wasmerVersion: toolchain.wasmer,
    wasmerWasixVersion: toolchain.wasmerWasix,
  };
}

export function assertCanonicalWasixAotManifest(
  manifest,
  {
    context = "WASIX AOT manifest",
    expectedTarget,
    canonical = canonicalWasixAotMetadata(),
  } = {},
) {
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error(`${context} must be a JSON object`);
  }
  const expected = [
    ["format-version", 1],
    ["source-lane", canonical.sourceLane],
    ["engine", canonical.engine],
    ["wasmer-version", canonical.wasmerVersion],
    ["wasmer-wasix-version", canonical.wasmerWasixVersion],
  ];
  if (expectedTarget !== undefined) {
    expected.push(["target-triple", requiredString(expectedTarget, `${context} expected target`)]);
  }
  for (const [field, expectedValue] of expected) {
    const actualValue = manifest[field];
    if (actualValue !== expectedValue) {
      throw new Error(
        `${context} ${field} must match canonical WASIX metadata: ` +
          `expected ${JSON.stringify(expectedValue)}, got ${JSON.stringify(actualValue)}`,
      );
    }
  }
}
