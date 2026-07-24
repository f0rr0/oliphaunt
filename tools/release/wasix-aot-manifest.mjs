import { readFileSync } from "node:fs";
import path from "node:path";

import { ROOT } from "./release-artifact-targets.mjs";

export const WASIX_TOOLCHAIN_PATH = "src/sources/toolchains/wasix.toml";
export const STABLE_WASIX_SOURCE_LANE = "stable";
export const WASIX_AOT_ENGINE = "llvm-opta";

function requiredString(value, context) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${context} must be a non-empty string`);
  }
  return value;
}

export function canonicalWasixAotMetadata(root = ROOT) {
  const file = path.join(root, WASIX_TOOLCHAIN_PATH);
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    throw new Error(`cannot read ${WASIX_TOOLCHAIN_PATH}: ${error.message}`);
  }
  let data;
  try {
    data = Bun.TOML.parse(text);
  } catch (error) {
    throw new Error(`${WASIX_TOOLCHAIN_PATH} is not valid TOML: ${error.message}`);
  }
  const toolchain = data?.toolchain;
  if (toolchain === null || typeof toolchain !== "object" || Array.isArray(toolchain)) {
    throw new Error(`${WASIX_TOOLCHAIN_PATH} is missing [toolchain]`);
  }
  return {
    sourceLane: STABLE_WASIX_SOURCE_LANE,
    engine: WASIX_AOT_ENGINE,
    wasmerVersion: requiredString(
      toolchain.wasmer,
      `${WASIX_TOOLCHAIN_PATH} toolchain.wasmer`,
    ),
    wasmerWasixVersion: requiredString(
      toolchain["wasmer-wasix"],
      `${WASIX_TOOLCHAIN_PATH} toolchain.wasmer-wasix`,
    ),
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
