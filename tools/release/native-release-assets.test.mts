import { expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assembleNativeReleaseAssets } from '../../build_defs/native/carriers/checksums.mts';
import { captureNativePublicationOutputs } from './native-publication-staging.mts';
import { loadPublicationCatalog } from './publication-catalog.mts';
import { discoverProductArtifacts, expectedProductArtifactRows } from './publication-lock.mts';

function fixture() {
  const scratch = mkdtempSync(path.join(tmpdir(), 'native-release-assets-'));
  const products = loadPublicationCatalog('native-release-assets-test', {
    products: ['postgres-tools-wasix'],
  }).products;
  const rows = expectedProductArtifactRows(products);
  const checksum = rows.find((row) => row.kind === 'checksums');
  if (!checksum) throw new Error('canonical tools checksum is missing');
  const expected = rows.filter((row) => row !== checksum).map((row) => row.name);
  const sources = path.join(scratch, 'sources');
  mkdirSync(sources);
  const files = expected.map((name, index) => {
    const file = path.join(sources, name);
    // This fixture tests final placement/checksums; actual archive and installed
    // payload behavior is qualified by the tools construction targets.
    writeFileSync(file, `independent producer ${index}\n`);
    return file;
  });
  const relative = 'bazel-out/fixture/bin/tools/release-assets';
  const directory = path.join(scratch, relative);
  return {
    scratch,
    products,
    rows,
    relative,
    directory,
    spec: {
      expected,
      files,
      copies: expected.map((name) => path.join(directory, name)),
      output: path.join(directory, checksum.name),
    },
  };
}

test('assembled product assets pass the canonical publication reader before and after frozen staging', () => {
  const value = fixture();
  const stageDirectory = `target/native-release-assets-test-${path.basename(value.scratch)}`;
  try {
    // The executor projects declared input leaves as symlinks; publication
    // staging must nevertheless observe only regular assembled output files.
    renameSync(value.spec.files[0], `${value.spec.files[0]}.producer`);
    symlinkSync(`${value.spec.files[0]}.producer`, value.spec.files[0]);
    assembleNativeReleaseAssets(value.spec);
    const expected = discoverProductArtifacts([value.directory], value.products);
    expect(expected).toHaveLength(value.rows.length);
    const roots = value.rows.map((row) => ({
      label: `//tools:${row.kind}-${row.target}`,
      package: {
        product: row.product,
        version: row.version,
        ecosystem: 'github',
        name: row.name,
        configuration: row.target,
        role: row.role,
        outputs: [
          { path: `${value.relative}/${row.name}`, owner: '//tools:assembled_release_assets' },
        ],
      },
    }));
    const capture = captureNativePublicationOutputs([{ executionRoot: value.scratch, roots }], {
      sourceCommit: 'a'.repeat(40),
      stageDirectory,
    });
    const staged = capture.stage();
    expect(capture.stage()).toEqual(staged);
    const observed = discoverProductArtifacts(staged, value.products);
    expect(observed.map(({ id, sha256, size }) => ({ id, sha256, size }))).toEqual(
      expected.map(({ id, sha256, size }) => ({ id, sha256, size })),
    );
    writeFileSync(
      value.spec.output,
      readFileSync(value.spec.output, 'utf8').replaceAll('  ./', '  '),
    );
    expect(() => discoverProductArtifacts([value.directory], value.products)).toThrow(
      'checksum line',
    );
    expect(() => capture.stage()).toThrow('changed');
  } finally {
    rmSync(value.scratch, { recursive: true, force: true });
    rmSync(path.resolve(import.meta.dir, '../..', stageDirectory), {
      recursive: true,
      force: true,
    });
  }
});

test('product assembly rejects incomplete, repeated and split-directory assets', () => {
  const value = fixture();
  try {
    expect(() =>
      assembleNativeReleaseAssets({ ...value.spec, files: value.spec.files.slice(1) }),
    ).toThrow('inventory');
    expect(() =>
      assembleNativeReleaseAssets({
        ...value.spec,
        files: [...value.spec.files, value.spec.files[0]],
      }),
    ).toThrow('repeat');
    expect(() =>
      assembleNativeReleaseAssets({ ...value.spec, copies: value.spec.copies.slice(1) }),
    ).toThrow('destinations');
    expect(() =>
      assembleNativeReleaseAssets({
        ...value.spec,
        output: path.join(value.scratch, 'elsewhere', path.basename(value.spec.output)),
      }),
    ).toThrow('one directory');
  } finally {
    rmSync(value.scratch, { recursive: true, force: true });
  }
});
