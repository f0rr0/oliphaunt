#!/usr/bin/env bun
import { IOS_CARRIER_FILENAME } from '../../../shared/artifact-packaging/ios-carrier-manifest.mts';
import {
  PREFIX,
  archiveTarNames,
  fail,
  inspectSdkProduct,
  isFile,
  rejectSdkRuntimePayload,
  rel,
  tarReadBytes,
} from '../../../shared/artifact-packaging/release-carrier.mts';
import { validateSelectionNeutralSwiftCarrierIdentity } from '../../swift/tools/swift-source-carrier-contract.mts';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { compareText } from '../../../shared/product-metadata/release-artifact-targets.mts';
import {
  SOURCE_ONLY_NPM_PROFILES,
  assertSourceOnlyNpmArchive,
} from '../../../shared/artifact-packaging/source-only-sdk-package.mts';
import { productCompatibilityVersion } from '../../../shared/product-metadata/release-graph.mts';

/**
 * Prove that the selection-neutral Apple carrier users receive in the React
 * Native npm package is the exact carrier staged as release evidence.
 */
export function validateReactNativePackagedCarrier({
  artifact,
  evidence,
  expectedNativeVersion,
  memberBytes,
  names,
}) {
  const member = `package/${IOS_CARRIER_FILENAME}`;
  const matches = names.filter((name) => name === member);
  if (matches.length !== 1) {
    throw new Error(`${rel(artifact)} must contain exactly one ${member}; found ${matches.length}`);
  }
  if (!Buffer.isBuffer(memberBytes) || !Buffer.isBuffer(evidence)) {
    throw new TypeError('React Native carrier inputs must be byte buffers');
  }
  if (!memberBytes.equals(evidence)) {
    throw new Error(
      `${rel(artifact)} ${member} must byte-for-byte match its staged carrier evidence`,
    );
  }
  let carrier;
  try {
    carrier = JSON.parse(memberBytes.toString('utf8'));
  } catch (error) {
    throw new Error(`${rel(artifact)} ${member} is not valid JSON: ${error.message}`);
  }
  return validateSelectionNeutralSwiftCarrierIdentity({
    carrier,
    expectedNativeVersion,
    label: `${rel(artifact)} packaged React Native Apple carrier`,
  });
}

export async function checkReactNativePackage(root) {
  const product = 'oliphaunt-react-native';
  let checked = false;

  const tarballs = readdirSync(root)
    .filter((name) => name.endsWith('.tgz'))
    .map((name) => path.join(root, name))
    .sort(compareText);
  if (tarballs.length === 0) {
    fail(`${product} must stage an npm tarball under ${rel(root)}`);
  }
  for (const tarball of tarballs) {
    const names = archiveTarNames(tarball);
    rejectSdkRuntimePayload(product, tarball, names);
    try {
      assertSourceOnlyNpmArchive(tarball, SOURCE_ONLY_NPM_PROFILES['react-native']);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
    {
      const carrierEvidence = path.join(root, 'ios-carriers', IOS_CARRIER_FILENAME);
      const carrierMember = `package/${IOS_CARRIER_FILENAME}`;
      if (!isFile(carrierEvidence)) {
        fail(`${product} must stage selection-neutral carrier evidence at ${rel(carrierEvidence)}`);
      }
      if (names.filter((name) => name === carrierMember).length !== 1) {
        fail(
          `${rel(tarball)} must contain exactly one ${carrierMember}; found ` +
            names.filter((name) => name === carrierMember).length,
        );
      }
      try {
        validateReactNativePackagedCarrier({
          artifact: tarball,
          evidence: readFileSync(carrierEvidence),
          expectedNativeVersion: productCompatibilityVersion(
            'oliphaunt-swift',
            'liboliphaunt-native',
            PREFIX,
          ),
          memberBytes: tarReadBytes(tarball, carrierMember),
          names,
        });
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error));
      }
    }
    checked = true;
  }

  return checked;
}

if (import.meta.main) await inspectSdkProduct('oliphaunt-react-native', checkReactNativePackage);
