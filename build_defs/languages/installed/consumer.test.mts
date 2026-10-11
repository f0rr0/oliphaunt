import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { archive } from '../../query/package.mts';
import { candidateConsumerManifest, cargoCandidate } from './consumer.mts';

const template = readFileSync(`${import.meta.dir}/fixture/Cargo.toml`, 'utf8');
const sdkManifest = Bun.TOML.parse(
  readFileSync(new URL('../../../src/native/sdks/rust/Cargo.toml', import.meta.url), 'utf8'),
);
const heldRuntime = sdkManifest.package.metadata.oliphaunt['native-version'];
function candidates(sdk = '0.3.2', helper = '0.3.2', broker = '0.3.1') {
  return [
    {
      name: 'oliphaunt',
      version: sdk,
      manifest: sdkManifest,
    },
    { name: 'oliphaunt-build', version: helper },
    { name: 'oliphaunt-broker', version: broker },
  ] as Parameters<typeof candidateConsumerManifest>[1];
}

test('candidate identity comes from the final archive manifest bytes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'oliphaunt-candidate-test-'));
  try {
    const file = join(directory, 'candidate.crate');
    writeFileSync(
      file,
      archive({
        [`${sdkManifest.package.name}-${sdkManifest.package.version}/Cargo.toml`]: Buffer.from(
          readFileSync(new URL('../../../src/native/sdks/rust/Cargo.toml', import.meta.url)),
        ),
      }),
    );
    const candidate = cargoCandidate(file);
    expect(candidate.name).toBe(sdkManifest.package.name);
    expect(candidate.version).toBe(sdkManifest.package.version);
    expect(candidate.manifest.package.metadata.oliphaunt['native-version']).toBe(heldRuntime);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('candidate SDK/helper bumps update their consumer constraints and hold runtime', () => {
  const manifest = Bun.TOML.parse(
    candidateConsumerManifest(template, candidates('0.3.3', '0.3.4')),
  );
  expect(manifest.dependencies.oliphaunt).toBe('=0.3.3');
  expect(manifest['build-dependencies']['oliphaunt-build']).toBe('=0.3.4');
  expect(manifest.dependencies['liboliphaunt-native-linux-x64-gnu']).toBe(`=${heldRuntime}`);
  expect(manifest.package.metadata.oliphaunt['runtime-version']).toBe(heldRuntime);
});

test('broker-only candidate version changes do not retarget SDK or its runtime', () => {
  expect(candidateConsumerManifest(template, candidates('0.3.2', '0.3.2', '0.3.2'))).toBe(
    candidateConsumerManifest(template, candidates()),
  );
});

test('a missing packaged SDK/helper identity cannot silently use the checkout', () => {
  expect(() =>
    candidateConsumerManifest(
      template,
      candidates().filter((candidate) => candidate.name !== 'oliphaunt'),
    ),
  ).toThrow();
});
