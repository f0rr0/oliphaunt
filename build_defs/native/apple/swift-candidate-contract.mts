import assert from 'node:assert/strict';
import path from 'node:path';
import { parseSwiftReleaseBinaryTarget } from '../../../src/native/sdks/swift/tools/prepare-swift-release-consumer.mts';

/** Compose a temporary candidate test without retargeting the SDK's held native pin. */
export function composeSwiftCandidateManifest(
  manifest: string,
  authoredNativeVersion: string,
  candidateName: string,
  candidateChecksum: string,
) {
  const version = authoredNativeVersion.trim();
  assert.match(version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u);
  assert.equal(candidateName, path.basename(candidateName), 'candidate asset must be a basename');
  assert.equal(
    candidateName,
    `liboliphaunt-${version}-apple-spm-xcframework.zip`,
    'candidate cannot change the authored Swift native requirement',
  );
  assert.match(candidateChecksum, /^[0-9a-f]{64}$/u);
  const target = parseSwiftReleaseBinaryTarget(manifest);
  assert.equal(
    target.url,
    `https://github.com/f0rr0/oliphaunt/releases/download/liboliphaunt-native-v${version}/${candidateName}`,
    'candidate must retain the authored canonical native release URL',
  );
  return {
    manifest:
      manifest.slice(0, target.index) +
      manifest
        .slice(target.index, target.end)
        .replace(`"${target.checksum}"`, `"${candidateChecksum}"`) +
      manifest.slice(target.end),
    nativeVersion: version,
    heldChecksum: target.checksum,
    candidateChecksum,
    publicUrl: target.url,
  };
}
