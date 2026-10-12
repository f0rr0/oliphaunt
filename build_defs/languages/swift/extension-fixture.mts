/** The selected consumer fixture uses original source/carrier Files, offline. */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { renderExtensionProducts } from '../../../src/native/sdks/swift/tools/render-extension-products.mts';
import { extractVerifiedZipArchive } from '../../../src/native/sdks/swift/tools/swift-carrier-resolver.mts';
import { extensionReleaseConsumerInputs } from '../../../src/native/sdks/swift/tools/swift-extension-release-consumer-inputs.mts';
import { fileIdentity } from '../../../tools/release/native-file-identity.mts';

type Input = { path: string; size: number; sha256: string };
export type SwiftExtensionFixtureSpec = {
  version: string;
  selectedProducts: string[];
  sourceArchive: Input;
  sourceCarrier: Input;
  ownerCatalog: Input;
  carriers: { product: string; version: string; file: Input }[];
  assets: Input[];
  baseArchives?: Record<string, Input>;
};

const physical = (input: Input) => {
  const file = realpathSync(path.resolve(input.path));
  const observed = fileIdentity(file);
  assert.deepEqual(
    { size: observed.size, sha256: observed.sha256 },
    { size: input.size, sha256: input.sha256 },
    'declared Swift fixture input bytes differ',
  );
  return file;
};

export async function buildSwiftExtensionFixture(output: string, spec: SwiftExtensionFixtureSpec) {
  assert.ok(
    spec.selectedProducts.includes('oliphaunt-swift'),
    'Swift fixture requires the selected source product',
  );
  assert.ok(spec.carriers.length > 0, 'Swift fixture requires selected independent Apple carriers');
  assert.equal(
    new Set(spec.selectedProducts).size,
    spec.selectedProducts.length,
    'Swift fixture selection repeats',
  );
  assert.equal(
    new Set(spec.carriers.map(({ product }) => product)).size,
    spec.carriers.length,
    'Swift fixture carrier owner repeats',
  );
  const files = [
    spec.sourceArchive,
    spec.sourceCarrier,
    spec.ownerCatalog,
    ...spec.carriers.map(({ file }) => file),
    ...spec.assets,
    ...Object.values(spec.baseArchives ?? {}),
  ];
  const sourceArchive = physical(spec.sourceArchive);
  const sourceCarrier = physical(spec.sourceCarrier);
  const ownerCatalog = physical(spec.ownerCatalog);
  const carriers = spec.carriers.map(({ product, version, file }) => {
    assert.ok(
      spec.selectedProducts.includes(product),
      'Swift fixture cannot include an unselected carrier owner',
    );
    const carrier = physical(file);
    const document = JSON.parse(readFileSync(carrier, 'utf8'));
    assert.equal(document.release?.product, product, 'Swift fixture carrier owner differs');
    assert.equal(document.release?.version, version, 'Swift fixture carrier version differs');
    return carrier;
  });
  const destination = path.resolve(output);
  await mkdir(path.dirname(destination), { recursive: true });
  const scratch = mkdtempSync(path.join(path.dirname(destination), '.swift-extension-fixture-'));
  try {
    const source = path.join(scratch, 'source');
    await extractVerifiedZipArchive({ archive: sourceArchive, destination: source });
    const sdk = path.join(source, 'package');
    assert.equal(
      readFileSync(path.join(sdk, 'VERSION'), 'utf8').trim(),
      spec.version,
      'Swift fixture cannot restamp another source package version',
    );
    const base = JSON.parse(readFileSync(sourceCarrier, 'utf8')).base;
    assert.equal(
      readFileSync(path.join(sdk, 'LIBOLIPHAUNT_VERSION'), 'utf8').trim(),
      base.version,
      'Swift fixture must preserve the source package native compatibility pin',
    );
    const plan = extensionReleaseConsumerInputs({
      sourceCarrierFile: sourceCarrier,
      extensionCarrierFiles: carriers,
      nativeBaseArchiveInputs: spec.baseArchives,
    });
    const cache = path.join(scratch, 'cache');
    await mkdir(path.join(cache, 'objects'), { recursive: true });
    const envelopes = new Map<string, { name: string; sha256: string; bytes: number }>();
    for (const carrier of carriers)
      for (const envelope of JSON.parse(readFileSync(carrier, 'utf8')).carriers) {
        const previous = envelopes.get(envelope.name);
        if (previous)
          assert.deepEqual(previous, envelope, 'Swift fixture carrier envelope conflicts');
        else envelopes.set(envelope.name, envelope);
      }
    for (const envelope of envelopes.values()) {
      const matches = spec.assets.filter(
        (input) =>
          path.basename(input.path) === envelope.name &&
          input.sha256 === envelope.sha256 &&
          input.size === envelope.bytes,
      );
      assert.equal(
        matches.length,
        1,
        'Swift fixture requires the exact declared public carrier archive',
      );
      fileIdentity(
        physical(matches[0]),
        path.join(cache, 'objects', `${envelope.sha256}-${envelope.name}`),
      );
    }
    await renderExtensionProducts([
      '--carrier',
      sourceCarrier,
      ...carriers.flatMap((carrier) => ['--extension-carrier', carrier]),
      '--extensions',
      plan.extensionsCsv,
      '--base-package-version',
      spec.version,
      '--owner-catalog',
      ownerCatalog,
      '--cache-dir',
      cache,
      '--offline',
      '--local-binary-targets',
      '--output-dir',
      destination,
    ]);
    const generated = JSON.parse(
      readFileSync(path.join(destination, 'extension-products.json'), 'utf8'),
    );
    assert.deepEqual(
      generated.selected.map(({ sqlName }) => sqlName).sort(),
      plan.extensions,
      'Swift fixture generated a different extension selection',
    );
    for (const input of files) physical(input);
    return generated;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  assert.equal(process.argv.length, 4, 'Swift fixture needs declared output and input spec');
  const spec = JSON.parse(readFileSync(process.argv[3], 'utf8'));
  // Newly constructed control Files have a declared Bazel producer rather
  // than prior archive digests; capture their identities at this action edge.
  spec.carriers = spec.carriers.map((row) => {
    const file = fileIdentity(realpathSync(row.file.path));
    return { ...row, file: { path: row.file.path, size: file.size, sha256: file.sha256 } };
  });
  await buildSwiftExtensionFixture(process.argv[2], spec);
}
