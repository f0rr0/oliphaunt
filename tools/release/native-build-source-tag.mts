/** Bind the declared Swift source-tag inputs; this is transport, never source admission. */
import { deepStrictEqual } from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { assertSwiftSourceDeliveryParity } from '../../build_defs/languages/swift/source-delivery-contract.mts';
import {
  IOS_CARRIER_FILENAME,
  validateFrozenNativeCarrierIdentity,
} from '../../src/native/sdks/swift/tools/swift-native-carrier-contract.mts';
import { renderSwiftReleaseManifest } from '../../src/native/sdks/swift/tools/swift-release-manifest.mts';
import type { NativeBuildEvidence } from './native-build-qualification.mts';
import { expectedProductArtifactRows } from './publication-lock.mts';

/** Only the canonical source publisher's complete declared inventory admits a tree. */
export function nativeSwiftSourceTagRoots(cohort: NativeBuildEvidence['cohorts'][number]) {
  const roots = cohort.roots.filter(
    ({ package: pkg }) => pkg.product === 'oliphaunt-swift' && pkg.ecosystem === 'github',
  );
  if (!roots.some(({ package: pkg }) => pkg.role === 'release-input')) return [];
  const version = roots[0].package.version;
  const rows = expectedProductArtifactRows([{ id: 'oliphaunt-swift', kind: 'sdk', version }]);
  deepStrictEqual(
    roots.map(({ package: pkg }) => pkg.name).sort(),
    rows.map(({ name }) => name).sort(),
    'Swift source-tag transport requires its complete canonical input and asset inventory',
  );
  for (const root of roots) {
    const pkg = root.package;
    const row = rows.find(({ name }) => name === pkg.name);
    if (
      !row ||
      pkg.version !== version ||
      pkg.role !== row.role ||
      pkg.configuration !== row.target ||
      pkg.outputs.length !== 1
    )
      throw new Error('Swift source-tag root identity or configuration differs from its contract');
  }
  const tree = roots.find(({ package: pkg }) => pkg.name === 'release-tree').package.outputs[0];
  const carrier = roots.find(({ package: pkg }) => pkg.name === IOS_CARRIER_FILENAME).package
    .outputs[0];
  deepStrictEqual(carrier, tree, 'Swift carrier must belong to the declared source-tag tree');
  for (const root of roots) {
    const output = root.package.outputs[0].path;
    const expectedName =
      root.package.name === IOS_CARRIER_FILENAME ? 'release-tree' : root.package.name;
    if (path.posix.basename(output) !== expectedName)
      throw new Error('Swift source-tag output does not have its canonical filename');
    const captured = cohort.outputs.find(({ path: name }) => name === output);
    if (!captured || captured.members[0].type !== (output === tree.path ? 'directory' : 'file'))
      throw new Error('Swift source-tag output has the wrong physical file type');
    if (captured.members.some(({ path: name }) => name.split('/').includes('.git')))
      throw new Error('Swift source-tag tree cannot contain Git internals');
  }
  return roots;
}

/** The existing Swift source publisher writes Git100644; Bazel materialization modes are evidence only. */
export function nativeSwiftSourceTagPublication(cohort: NativeBuildEvidence['cohorts'][number]) {
  const tree = nativeSwiftSourceTagRoots(cohort).find(
    ({ package: pkg }) => pkg.name === 'release-tree',
  )?.package.outputs[0].path;
  if (tree === undefined) return cohort;
  return {
    ...cohort,
    outputs: cohort.outputs.map((output) =>
      output.path === tree
        ? {
            ...output,
            members: output.members.map((member) => ({
              ...member,
              mode: member.type === 'file' ? 0o644 : 0o755,
            })),
          }
        : output,
    ),
  };
}

/** Current and held legal/source admission stays in the existing source-basis contract. */
export function validateNativeSwiftSourceTagFiles(
  evidence: NativeBuildEvidence,
  resolve: (cohort: number, output: string) => string,
) {
  for (const [index, captured] of evidence.cohorts.entries()) {
    const cohort = nativeSwiftSourceTagPublication(captured);
    const roots = nativeSwiftSourceTagRoots(cohort);
    if (!roots.length) continue;
    const output = (name: string) =>
      roots.find(({ package: pkg }) => pkg.name === name).package.outputs[0].path;
    const tree = output('release-tree');
    const file = (member: string) => resolve(index, `${tree}/${member}`);
    const text = (name: string) =>
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readFileSync(name));
    const version = roots[0].package.version;
    if (text(file('src/sdks/swift/VERSION')).trim() !== version)
      throw new Error('Swift source-tag VERSION differs from its qualified owner version');
    const carrier = validateFrozenNativeCarrierIdentity({
      carrier: JSON.parse(text(file(`src/sdks/swift/Carriers/${IOS_CARRIER_FILENAME}`))),
      expectedNativeVersion: text(file('src/sdks/swift/LIBOLIPHAUNT_VERSION')).trim(),
      label: 'native Swift source-tag transport',
    });
    const asset = carrier.base.assets.find(({ role }) => role === 'base-xcframework');
    const bindingsName = `oliphaunt-swift-${version}-bindings.xcframework.zip`;
    const bindingsPath = output(bindingsName);
    const bindings = cohort.outputs.find(({ path: name }) => name === bindingsPath).members[0];
    if (bindings.type !== 'file') throw new Error('Swift bindings archive must be a regular file');
    const canonical = renderSwiftReleaseManifest(
      asset.url.slice(0, asset.url.lastIndexOf('/')),
      carrier.base.version,
      asset.sha256,
      `https://github.com/f0rr0/oliphaunt/releases/download/oliphaunt-swift-v${version}/${bindingsName}`,
      bindings.sha256,
    );
    for (const manifest of [file('Package.swift'), resolve(index, output('Package.swift.release'))])
      if (!readFileSync(manifest).equals(Buffer.from(canonical)))
        throw new Error(
          'Swift source-tag manifest differs from its qualified version and supplier contracts',
        );
    for (const required of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) readFileSync(file(required));
    assertSwiftSourceDeliveryParity(
      resolve(index, output('Oliphaunt-source.zip')),
      cohort.outputs.find(({ path: name }) => name === tree).members,
      Buffer.from(canonical),
    );
  }
}
