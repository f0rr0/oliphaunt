import { readFileSync } from 'node:fs';
import { iosBaseLegalMetadata } from './ios-carrier-manifest.mts';
import { nativeBaseLegalForSource } from './native-legal-source-basis.mts';
import { parseSwiftReleaseBinaryTarget } from './prepare-swift-release-consumer.mts';
import {
  validateSelectionNeutralSwiftSourceCarrier as validateCarrier,
  validateFrozenNativeCarrierIdentity,
} from './swift-native-carrier-contract.mts';

const CANONICAL_REPOSITORY = 'https://github.com/f0rr0/oliphaunt';
function error(label, message) {
  return new Error(`${label}: ${message}`);
}

// Fresh source binds current legal bytes. Held source requires an independently
// authenticated publication basis; the incoming carrier cannot define its own
// expected legal metadata.
export function validateSelectionNeutralSwiftSourceCarrier(
  document,
  label = 'oliphaunt-swift source-tag carrier',
  { sourceBasis = undefined } = {},
) {
  return validateCarrier(document, label, {
    expectedBaseLegal: nativeBaseLegalForSource({
      base: document?.base,
      sourceBasis,
      currentLegal: iosBaseLegalMetadata,
    }),
  });
}

export function validateSelectionNeutralSwiftCarrierIdentity(options) {
  return validateFrozenNativeCarrierIdentity({
    ...options,
    expectedBaseLegal: nativeBaseLegalForSource({
      base: options.carrier?.base,
      sourceBasis: options.sourceBasis,
      currentLegal: iosBaseLegalMetadata,
    }),
  });
}

export function validateSelectionNeutralSwiftSourceCarrierFile(
  carrier,
  label = String(carrier),
  options = {},
) {
  let document;
  try {
    document = JSON.parse(readFileSync(carrier, 'utf8'));
  } catch (cause) {
    throw error(label, `is not valid JSON: ${cause.message}`);
  }
  return validateSelectionNeutralSwiftSourceCarrier(document, label, options);
}

/**
 * Bind a selection-neutral Apple carrier to the public Oliphaunt release
 * namespace and, when supplied, the exact native version selected by the
 * release graph. This contract is shared by SwiftPM source tags and the
 * carrier embedded in the React Native npm package.
 */
export function validateSwiftSourceReleaseContract({
  carrier,
  manifestText,
  expectedNativeVersion,
  repository = CANONICAL_REPOSITORY,
  label = 'oliphaunt-swift source release',
  sourceBasis = undefined,
}) {
  const validated = validateSelectionNeutralSwiftCarrierIdentity({
    carrier,
    expectedNativeVersion,
    repository,
    label,
    sourceBasis,
  });
  const binaryTarget = parseSwiftReleaseBinaryTarget(
    manifestText,
    `${label} Package.swift.release`,
  );
  const xcframework = validated.base.assets.find(({ role }) => role === 'base-xcframework');
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
