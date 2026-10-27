import { expect, test } from 'bun:test';
import { composeSwiftCandidateManifest } from './swift-candidate-contract.mts';

const heldChecksum = '1'.repeat(64);
const candidateChecksum = '2'.repeat(64);
const version = '1.2.3';
const name = `liboliphaunt-${version}-apple-spm-xcframework.zip`;
const target = `.binaryTarget(name: "liboliphaunt", url: "https://github.com/f0rr0/oliphaunt/releases/download/liboliphaunt-native-v${version}/${name}", checksum: "${heldChecksum}")`;

test('candidate composition changes only the native checksum and records the held requirement', () => {
  const manifest = `// checksum elsewhere: ${heldChecksum}\n${target}\n// retained source\n`;
  const result = composeSwiftCandidateManifest(manifest, `${version}\n`, name, candidateChecksum);
  expect(result.manifest).toBe(
    manifest.replace(target, target.replace(heldChecksum, candidateChecksum)),
  );
  expect(result.heldChecksum).toBe(heldChecksum);
  expect(result.candidateChecksum).toBe(candidateChecksum);
  expect(result.nativeVersion).toBe(version);
  expect(composeSwiftCandidateManifest(manifest, version, name, heldChecksum).manifest).toBe(
    manifest,
  );
});

test('candidate composition cannot substitute a newer runtime, noncanonical origin or ambiguous target', () => {
  expect(() => composeSwiftCandidateManifest(target, '1.2.4', name, candidateChecksum)).toThrow(
    /authored Swift native requirement/u,
  );
  expect(() =>
    composeSwiftCandidateManifest(target, version, `../${name}`, candidateChecksum),
  ).toThrow(/basename/u);
  expect(() =>
    composeSwiftCandidateManifest(
      target.replace('github.com', 'example.com'),
      version,
      name,
      candidateChecksum,
    ),
  ).toThrow(/canonical native release URL/u);
  expect(() =>
    composeSwiftCandidateManifest(`${target}\n${target}`, version, name, candidateChecksum),
  ).toThrow(/exactly one/u);
  expect(() => composeSwiftCandidateManifest(target, version, name, 'invalid')).toThrow();
});
