import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from '../../../../tools/release/release-artifact-targets.mts';
import {
  canonicalWasixCargoToolchainVersions,
  WASIX_ENGINE_SOURCES_PATH,
  WASIX_TOOLCHAIN_PATH,
} from './wasix-cargo-toolchain-policy.mts';

export { WASIX_TOOLCHAIN_PATH };
export const STABLE_WASIX_SOURCE_LANE = 'stable';

function requiredString(value, context) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${context} must be a non-empty string`);
  }
  return value;
}

export function canonicalWasixAotMetadata(root = ROOT, target?: string) {
  if (target === 'x86_64-pc-windows-msvc') {
    const sources = JSON.parse(readFileSync(path.join(root, WASIX_ENGINE_SOURCES_PATH), 'utf8'));
    return {
      sourceLane: STABLE_WASIX_SOURCE_LANE,
      engine: 'v8',
      wasmerVersion: requiredString(
        sources.crates?.wasmer?.version,
        `${WASIX_ENGINE_SOURCES_PATH} crates.wasmer.version`,
      ),
      wasmerWasixVersion: requiredString(
        sources.crates?.['wasmer-wasix']?.version,
        `${WASIX_ENGINE_SOURCES_PATH} crates.wasmer-wasix.version`,
      ),
    };
  }
  const toolchain = canonicalWasixCargoToolchainVersions(root);
  return {
    sourceLane: STABLE_WASIX_SOURCE_LANE,
    engine: 'llvm-opta',
    wasmerVersion: toolchain.wasmer,
    wasmerWasixVersion: toolchain.wasmerWasix,
  };
}

export function assertCanonicalWasixAotManifest(
  manifest,
  {
    context = 'WASIX AOT manifest',
    expectedTarget,
    canonical = canonicalWasixAotMetadata(ROOT, expectedTarget ?? manifest?.['target-triple']),
  } = {},
) {
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error(`${context} must be a JSON object`);
  }
  const expected = [
    ['format-version', 1],
    ['source-lane', canonical.sourceLane],
    ['engine', canonical.engine],
    ['wasmer-version', canonical.wasmerVersion],
    ['wasmer-wasix-version', canonical.wasmerWasixVersion],
  ];
  if (expectedTarget !== undefined) {
    expected.push(['target-triple', requiredString(expectedTarget, `${context} expected target`)]);
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
