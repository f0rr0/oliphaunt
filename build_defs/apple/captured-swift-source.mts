/** Construction from the existing authenticated Swift source delivery and supplier Files. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { parseSwiftReleaseBinaryTarget } from '../../src/native/sdks/swift/tools/prepare-swift-release-consumer.mts';
import { validateFrozenNativeCarrierIdentity } from '../../src/native/sdks/swift/tools/swift-native-carrier-contract.mts';
import { readPortableArchiveEntries } from '../../tools/packaging/portable-archive.mts';
import { type FileIdentity, verifyCapturedFile } from './captured-file.mts';

export { verifyCapturedFile } from './captured-file.mts';
export type SourceDelivery = {
  publication: { product: string; version: string };
  source: { commit: string; tree: string; member: string; blob: string };
  file: FileIdentity;
};
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function carrierConstruction(
  bytes: Uint8Array,
  construction: ReturnType<typeof swiftPackageConstruction>,
  swiftVersion: string,
) {
  const carrier = validateFrozenNativeCarrierIdentity({
    carrier: JSON.parse(Buffer.from(bytes).toString('utf8')),
    expectedNativeVersion: construction.nativeVersion,
  });
  assert.equal(
    carrier.base.assets.find((asset) => asset.role === 'base-xcframework').sha256,
    construction.nativeChecksum,
    'Actual Swift carrier and Package.swift require different native Files',
  );
  return { ...construction, swiftVersion, carrierFile: { size: bytes.length, sha256: sha(bytes) } };
}
export function swiftPackageConstruction(manifest: string, swiftVersion: string) {
  const native = parseSwiftReleaseBinaryTarget(manifest, 'genuine captured Package.swift');
  const nativeVersion =
    /^https:\/\/github\.com\/f0rr0\/oliphaunt\/releases\/download\/liboliphaunt-native-v(\d+\.\d+\.\d+)\/liboliphaunt-\1-apple-spm-xcframework\.zip$/u.exec(
      native.url,
    )?.[1];
  assert(nativeVersion, 'Swift native requirement must be its canonical exact public target');
  const bindings = [
    ...manifest.matchAll(
      /\.binaryTarget\(\s*name:\s*"OliphauntNativeBindingsFFI"\s*,\s*url:\s*"([^"]+)"\s*,\s*checksum:\s*"([0-9a-f]{64})"\s*\)/gmu,
    ),
  ];
  assert.equal(bindings.length, 1, 'Swift package must declare its genuine bindings target once');
  assert.equal(
    bindings[0][1],
    `https://github.com/f0rr0/oliphaunt/releases/download/oliphaunt-swift-v${swiftVersion}/oliphaunt-swift-${swiftVersion}-bindings.xcframework.zip`,
  );
  assert.equal(
    [...manifest.matchAll(/\.binaryTarget\(/gu)].length,
    2,
    'Unexpected additional binary target',
  );
  const sourceTargets = [
    ...manifest.matchAll(
      /\.target\(\s*name:\s*"([^"]+)"\s*,\s*dependencies:\s*\[([^\]]*)\]\s*,\s*path:\s*"([^"]+)"(?:\s*,\s*publicHeadersPath:\s*"([^"]+)"\s*,\s*cSettings:\s*\[\.define\("([^"]+)"\)\])?\s*\)/gmu,
    ),
  ];
  assert.equal(
    sourceTargets.length,
    [...manifest.matchAll(/\.target\(/gu)].length,
    'Unsupported source-target expression in captured Package.swift',
  );
  assert(sourceTargets.length > 0, 'Swift package has no source targets');
  const targets: Record<
    string,
    { path: string; dependencies: string[]; publicHeaders?: string; define?: string }
  > = {};
  for (const [, name, dependencyText, sourcePath, publicHeaders, define] of sourceTargets) {
    assert(!targets[name], 'Duplicate conventional Swift target: ' + name);
    const dependencies = [...dependencyText.matchAll(/"([A-Za-z][A-Za-z0-9_]*)"/gu)].map(
      (match) => match[1],
    );
    assert.equal(
      dependencyText.replace(/"[A-Za-z][A-Za-z0-9_]*"|[\s,]/gu, ''),
      '',
      'Unsupported Swift dependency expression',
    );
    assert(
      /^[A-Za-z][A-Za-z0-9_]*$/u.test(name) &&
        /^[A-Za-z0-9_./-]+$/u.test(sourcePath) &&
        !sourcePath.split('/').includes('..'),
      'Unsafe Swift source target',
    );
    if (publicHeaders) assert.equal(publicHeaders, 'include', 'Unsupported C public header layout');
    targets[name] = {
      path: sourcePath,
      dependencies,
      ...(publicHeaders ? { publicHeaders, define } : {}),
    };
  }
  for (const target of Object.values(targets))
    for (const dependency of target.dependencies)
      assert(
        targets[dependency] || ['liboliphaunt', 'OliphauntNativeBindingsFFI'].includes(dependency),
        'Missing conventional Swift dependency: ' + dependency,
      );
  const languageVersion = /^\/\/ swift-tools-version: (\d+)\.\d+$/mu.exec(manifest)?.[1];
  assert(languageVersion, 'Captured package has no declared Swift tools floor');
  return {
    nativeVersion,
    nativeChecksum: native.checksum,
    bindingsChecksum: bindings[0][2],
    targets,
    languageVersion,
  };
}

export function verifyCapturedSwiftSource(archive: string, delivery: SourceDelivery) {
  assert.equal(delivery.publication.product, 'oliphaunt-swift');
  for (const value of [delivery.source.commit, delivery.source.tree])
    assert.match(value, /^[0-9a-f]{40}$/u);
  const physical = verifyCapturedFile(archive, delivery.file);
  const entries = readPortableArchiveEntries(physical, { format: 'tar.gz' });
  for (const [name, entry] of entries) {
    // Acquisition has already authenticated the complete Git inventory before
    // retaining this SHA-bound archive. Construction adds no second authority.
    assert(
      !entry.isSymbolicLink && (entry.isFile || entry.isDirectory),
      'Captured source archive must expose genuine regular Files: ' + name,
    );
  }
  const manifest = entries.get('Package.swift');
  assert(manifest?.isFile, 'Genuine source delivery must include root Package.swift');
  const bytes = typeof manifest.data === 'function' ? manifest.data() : manifest.data;
  const construction = swiftPackageConstruction(
    bytes.toString('utf8'),
    delivery.publication.version,
  );
  for (const [name, target] of Object.entries(construction.targets)) {
    assert(
      [...entries.keys()].some(
        (member) =>
          member.startsWith(target.path + '/') &&
          (target.publicHeaders ? member.endsWith('.c') : member.endsWith('.swift')),
      ),
      'Missing genuine source Files for ' + name,
    );
  }
  const carrier = entries.get(delivery.source.member);
  assert(carrier?.isFile, 'Genuine source delivery lacks its original carrier member');
  const carrierBytes = carrier.data();
  assert.equal(
    createHash('sha1')
      .update(Buffer.from(`blob ${carrierBytes.length}\0`))
      .update(carrierBytes)
      .digest('hex'),
    delivery.source.blob,
    'Original carrier Git blob differs',
  );
  return {
    ...carrierConstruction(carrierBytes, construction, delivery.publication.version),
    carrierMember: delivery.source.member,
  };
}

export function verifyCurrentSwiftSource(
  archive: string,
  input: {
    owner: string;
    version: string;
    archive: FileIdentity;
    carrier: FileIdentity & { path: string };
  },
) {
  assert.equal(input.owner, 'oliphaunt-swift');
  const physical = verifyCapturedFile(archive, input.archive);
  const entries = readPortableArchiveEntries(physical, { format: 'zip' });
  const version = entries.get('package/VERSION'),
    manifest = entries.get('package/Package.swift');
  assert(
    version?.isFile && manifest?.isFile,
    'Current Swift producer must deliver its original standalone package',
  );
  assert.equal(
    version.data().toString().trim(),
    input.version,
    'Current source archive version cannot be relabelled',
  );
  const carrier = verifyCapturedFile(input.carrier.path, input.carrier);
  return {
    ...carrierConstruction(
      readFileSync(carrier),
      swiftPackageConstruction(manifest.data().toString('utf8'), input.version),
      input.version,
    ),
    carrierMember: 'carrier.json',
  };
}

if (import.meta.main) {
  const [operation, file, descriptor, output] = process.argv.slice(2);
  const identity = JSON.parse(readFileSync(descriptor, 'utf8'));
  const result =
    operation === 'source'
      ? verifyCapturedSwiftSource(file, identity)
      : operation === 'current-source'
        ? verifyCurrentSwiftSource(file, identity)
        : operation === 'file'
          ? verifyCapturedFile(file, identity.file)
          : assert.fail('Unknown captured Swift operation');
  if (output) writeFileSync(output, JSON.stringify(result) + '\n');
}
