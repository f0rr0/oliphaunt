import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createDeterministicTar } from '../../../tools/packaging/archive-directory.mts';
import { canonicalGzipSync } from '../../../tools/packaging/portable-archive.mts';
import { archive } from '../../query/package.mts';
import { candidateConsumerManifest, cargoCandidate, resolvedSdkRuntime } from './consumer.mts';

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

test('canonical Cargo directories are accepted while mode and package boundaries stay strict', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'oliphaunt-cargo-directories-'));
  try {
    const root = join(directory, `${sdkManifest.package.name}-${sdkManifest.package.version}`);
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(
      join(root, 'Cargo.toml'),
      readFileSync(new URL('../../../src/native/sdks/rust/Cargo.toml', import.meta.url)),
    );
    writeFileSync(join(root, 'src/lib.rs'), 'pub fn source() {}\n', { mode: 0o644 });
    const file = join(directory, 'canonical.crate');
    writeFileSync(
      file,
      canonicalGzipSync(await createDeterministicTar(root, { keepParent: true })),
    );
    expect(cargoCandidate(file).name).toBe(sdkManifest.package.name);
    writeFileSync(
      file,
      archive({
        [`${sdkManifest.package.name}-${sdkManifest.package.version}/Cargo.toml`]: readFileSync(
          join(root, 'Cargo.toml'),
        ),
        'outside.rs': Buffer.from('outside'),
      }),
    );
    expect(() => cargoCandidate(file)).toThrow('outside declared package');
    const executable = join(root, 'src/executable.rs');
    writeFileSync(executable, 'pub fn source() {}\n', { mode: 0o755 });
    writeFileSync(
      file,
      canonicalGzipSync(
        await createDeterministicTar(root, {
          keepParent: true,
          modes: { [`${basename(root)}/src/executable.rs`]: 0o755 },
        }),
      ),
    );
    expect(() => cargoCandidate(file)).toThrow('0644');
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
  expect(
    candidateConsumerManifest(
      template,
      candidates('0.3.2', '0.3.2', '0.3.2').filter(
        (candidate) => candidate.name === 'oliphaunt-broker',
      ),
    ),
  ).toBe(template);
  expect(candidateConsumerManifest(template, [])).toBe(template);
});

test('selected SDK/helper roots change only their own authored consumer constraints', () => {
  const selectedSdk = candidates('0.3.3').filter((candidate) => candidate.name === 'oliphaunt');
  const sdkOnly = Bun.TOML.parse(candidateConsumerManifest(template, selectedSdk));
  expect(sdkOnly.dependencies.oliphaunt).toBe('=0.3.3');
  expect(sdkOnly['build-dependencies']['oliphaunt-build']).toBe('=0.3.2');
  const helperOnly = Bun.TOML.parse(
    candidateConsumerManifest(
      template,
      candidates('0.3.2', '0.3.4').filter((candidate) => candidate.name === 'oliphaunt-build'),
    ),
  );
  expect(helperOnly.dependencies.oliphaunt).toBe('=0.3.2');
  expect(helperOnly['build-dependencies']['oliphaunt-build']).toBe('=0.3.4');
});

test('held SDK runtime comes from the checksum-authenticated resolved archive', () => {
  const directory = mkdtempSync(join(tmpdir(), 'oliphaunt-held-sdk-test-'));
  try {
    const file = join(
      directory,
      'registry/cache/index.crates.io-1949cf8c6b5b557f/oliphaunt-0.3.2.crate',
    );
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      archive({
        'oliphaunt-0.3.2/Cargo.toml': Buffer.from(
          `[package]\nname="oliphaunt"\nversion="0.3.2"\n[package.metadata.oliphaunt]\nnative-version="${heldRuntime}"\n`,
        ),
      }),
    );
    const selected = cargoCandidate(file);
    const lock = `[[package]]\nname="oliphaunt"\nversion="0.3.2"\nsource="registry+https://github.com/rust-lang/crates.io-index"\nchecksum="${selected.sha256}"\n`;
    expect(resolvedSdkRuntime(template, lock, [], directory)).toBe(heldRuntime);
    expect(() =>
      resolvedSdkRuntime(template, lock.replace(selected.sha256, '0'.repeat(64)), [], directory),
    ).toThrow('held SDK archive differs');
    expect(() =>
      resolvedSdkRuntime(
        template.replace(`runtime-version = "${heldRuntime}"`, 'runtime-version = "9.0.0"'),
        lock,
        [],
        directory,
      ),
    ).toThrow();
    expect(() =>
      resolvedSdkRuntime(
        template,
        '[[package]]\nname="oliphaunt"\nversion="0.3.2"\n',
        [],
        directory,
      ),
    ).toThrow('explicitly selected candidate');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
