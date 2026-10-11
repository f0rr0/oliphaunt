import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { candidateConsumerManifest } from './consumer.mts';

const template = readFileSync(`${import.meta.dir}/fixture/Cargo.toml`, 'utf8');
function candidates(sdk = '0.3.2', helper = '0.3.2', broker = '0.3.1') {
  return [
    {
      name: 'oliphaunt',
      version: sdk,
      manifest: { package: { metadata: { oliphaunt: { 'runtime-version': '0.3.2' } } } },
    },
    { name: 'oliphaunt-build', version: helper },
    { name: 'oliphaunt-broker', version: broker },
  ] as Parameters<typeof candidateConsumerManifest>[1];
}

test('candidate SDK/helper bumps update their consumer constraints and hold runtime', () => {
  const manifest = Bun.TOML.parse(
    candidateConsumerManifest(template, candidates('0.3.3', '0.3.4')),
  );
  expect(manifest.dependencies.oliphaunt).toBe('=0.3.3');
  expect(manifest['build-dependencies']['oliphaunt-build']).toBe('=0.3.4');
  expect(manifest.dependencies['liboliphaunt-native-linux-x64-gnu']).toBe('=0.3.2');
  expect(manifest.package.metadata.oliphaunt['runtime-version']).toBe('0.3.2');
});

test('broker-only candidate version changes do not retarget SDK or its runtime', () => {
  expect(candidateConsumerManifest(template, candidates('0.3.2', '0.3.2', '0.3.2'))).toBe(template);
});

test('a missing packaged SDK/helper identity cannot silently use the checkout', () => {
  expect(() =>
    candidateConsumerManifest(
      template,
      candidates().filter((candidate) => candidate.name !== 'oliphaunt'),
    ),
  ).toThrow();
});
