import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { WASIX_NAPI_SOURCE_PATCH_MEMBER } from '../../src/wasix/node-addon/tools/carrier-contract.mts';
import { assertCanonicalWasixAotManifest } from '../../src/wasix/runtime/tools/wasix-aot-manifest.mts';
import {
  AOT_PACKAGES,
  CORE_AOT_ARTIFACTS,
  EXTENSION_AOT_PACKAGE_SUFFIXES,
} from '../../src/wasix/runtime/tools/wasix-cargo-artifact-contract.mts';
import { copyNativeInputFile } from '../../tools/release/native-file-identity.mts';

export type WasixNapiRegistryInput = { name: string; files: Record<string, string> };
export type WasixNapiInputsSpec = {
  target: string;
  targetTriple: string;
  cargoLock: string;
  sourcePatch: string;
  sqlNames: string[];
  dependencies: WasixNapiRegistryInput[];
  output: string;
};
type FileIdentity = { path: string; sha256: string; size: number };
const canonicalMember = (member: string) => {
  assert(
    member &&
      !member.includes('\\') &&
      !path.posix.isAbsolute(member) &&
      member.split('/').every((part) => part && part !== '.' && part !== '..'),
    'noncanonical declared registry member',
  );
  return member;
};
const copyDeclared = (input: string, destination: string) => {
  const absolute = path.resolve(input);
  const root = path.parse(absolute).root;
  return copyNativeInputFile(
    root,
    path.relative(root, absolute).split(path.sep).join('/'),
    destination,
  );
};

/** Copy exact locked repositories, using the same bounded reader as publication receipts. */
export function stageWasixNapiInputs(spec: WasixNapiInputsSpec) {
  const lock = Bun.TOML.parse(readFileSync(spec.cargoLock, 'utf8'));
  assert.equal(lock.version, 4, 'WASIX addon requires its conventional Cargo lock');
  const source = 'registry+https://github.com/rust-lang/crates.io-index';
  const names = [...spec.sqlNames].sort();
  assert(names.length > 0, 'WASIX release requires its declared contrib members');
  assert.equal(new Set(names).size, names.length, 'duplicate release contrib member');
  const copied = new Map<string, Map<string, FileIdentity>>();
  const patchIdentity = copyDeclared(
    spec.sourcePatch,
    path.join(spec.output, WASIX_NAPI_SOURCE_PATCH_MEMBER),
  );
  const sourcePatch = {
    path: WASIX_NAPI_SOURCE_PATCH_MEMBER,
    sha256: patchIdentity.sha256,
    size: patchIdentity.size,
  };
  const origins = [];
  for (const dependency of [...spec.dependencies].sort((a, b) => a.name.localeCompare(b.name))) {
    assert(!copied.has(dependency.name), 'duplicate declared registry dependency');
    const selected = lock.package.filter((row: any) => row.name === dependency.name);
    assert.equal(
      selected.length,
      1,
      `ambiguous or missing locked WASIX dependency ${dependency.name}`,
    );
    const pin = selected[0];
    assert.equal(pin.source, source, 'WASIX dependency must retain its registry origin');
    assert.match(pin.checksum, /^[0-9a-f]{64}$/u, 'WASIX dependency has no registry checksum');
    assert(
      dependency.files['Cargo.toml'],
      'declared registry dependency has no conventional manifest',
    );
    const files = new Map<string, FileIdentity>();
    const root = `registry/${pin.name}-${pin.version}`;
    for (const [member, input] of Object.entries(dependency.files).sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      canonicalMember(member);
      const destination = `${root}/${member}`;
      const identity = copyDeclared(input, path.join(spec.output, destination));
      assert(identity.size > 0, 'registry payload contains an empty file');
      files.set(member, { path: destination, sha256: identity.sha256, size: identity.size });
    }
    const manifest = Bun.TOML.parse(
      readFileSync(path.join(spec.output, files.get('Cargo.toml')!.path), 'utf8'),
    );
    assert.equal(
      manifest.package.name,
      pin.name,
      'declared registry package name differs from lock',
    );
    assert.equal(
      manifest.package.version,
      pin.version,
      'declared registry package version differs from lock',
    );
    assert(
      !Object.hasOwn(manifest.package.metadata?.oliphaunt ?? {}, 'qualificationOnly'),
      'dependency is a qualification package',
    );
    copied.set(pin.name, files);
    origins.push({
      name: pin.name,
      version: pin.version,
      source: pin.source,
      checksum: pin.checksum,
      files: [...files.values()],
      ...(pin.name === 'liboliphaunt-wasix-portable' ||
      pin.name.startsWith('liboliphaunt-wasix-aot-')
        ? { patches: [sourcePatch] }
        : {}),
    });
  }
  const file = (name: string, member: string) => {
    const record = copied.get(name)?.get(member);
    assert(record, `missing declared registry payload ${name}/${member}`);
    return record;
  };
  const json = (record: FileIdentity) =>
    JSON.parse(readFileSync(path.join(spec.output, record.path), 'utf8'));
  const portableName = 'liboliphaunt-wasix-portable';
  const coreName = AOT_PACKAGES[spec.target];
  assert(coreName, 'unsupported WASIX addon target');
  const contribName = 'oliphaunt-extension-contrib-pg18-wasix';
  const suffix = EXTENSION_AOT_PACKAGE_SUFFIXES[spec.targetTriple];
  assert(suffix, 'unsupported WASIX addon target triple');
  const contribAotName = `oliphaunt-extension-contrib-pg18-aot-${suffix}`;
  assert.deepEqual(
    [...copied.keys()].sort(),
    ['oliphaunt-wasix', portableName, coreName, contribName, contribAotName].sort(),
    'WASIX addon dependency payload scope differs',
  );
  file(portableName, 'build-support.rs');
  file(coreName, 'build-support.rs');
  const sdk = Bun.TOML.parse(
    readFileSync(path.join(spec.output, file('oliphaunt-wasix', 'Cargo.toml').path), 'utf8'),
  );
  const runtimeVersion = sdk.package.metadata.oliphaunt['runtime-version'];
  assert.equal(
    origins.find((row) => row.name === portableName)!.version,
    runtimeVersion,
    'held SDK runtime pin differs from compiled portable carrier',
  );
  assert.equal(
    origins.find((row) => row.name === coreName)!.version,
    runtimeVersion,
    'held SDK runtime pin differs from compiled core AOT',
  );
  const portableManifest = file(portableName, 'payload/manifest.json');
  const portable = json(portableManifest);
  assert.equal(portable['format-version'], 2, 'portable registry manifest format differs');
  assert.equal(typeof portable['source-fingerprint'], 'string');
  assert(portable['source-fingerprint'].length > 0);
  const runtimeArchive = file(portableName, `payload/${canonicalMember(portable.runtime.archive)}`);
  assert.equal(
    runtimeArchive.sha256,
    portable.runtime.sha256,
    'portable runtime archive differs from compiled manifest',
  );
  file(portableName, 'payload/bin/initdb.wasix.wasm');
  const aot = (
    record: FileIdentity,
    expectedNames: (name: string) => boolean,
    resolve: (member: string) => FileIdentity,
  ) => {
    const manifest = json(record);
    assertCanonicalWasixAotManifest(manifest, {
      context: record.path,
      expectedTarget: spec.targetTriple,
    });
    assert.equal(
      manifest['source-fingerprint'],
      portable['source-fingerprint'],
      'AOT and portable registry source fingerprints differ',
    );
    assert(manifest.artifacts.length > 0, 'compiled AOT manifest is empty');
    const members = manifest.artifacts.map((artifact: any) => {
      assert(expectedNames(artifact.name), 'compiled AOT manifest includes a foreign artifact');
      const payload = resolve(canonicalMember(artifact.path));
      assert.equal(payload.sha256, artifact.sha256, 'compiled AOT payload differs from manifest');
      return artifact.name;
    });
    assert.equal(new Set(members).size, members.length, 'duplicate compiled AOT artifact');
    return members;
  };
  const runtimeAotManifest = file(coreName, 'artifacts/manifest.json');
  const coreMembers = aot(
    runtimeAotManifest,
    (name) => CORE_AOT_ARTIFACTS.includes(name),
    (member) => file(coreName, `artifacts/${member}`),
  );
  assert.deepEqual(
    [...coreMembers].sort(),
    [...CORE_AOT_ARTIFACTS].sort(),
    'compiled core AOT inventory differs',
  );
  const portableArchives = names.map((sqlName) => ({
    sqlName,
    ...file(contribName, `payload/files/extensions/${sqlName}/extension.tar.zst`),
  }));
  const aotManifests = names.map((sqlName) => {
    const record = file(contribAotName, `manifests/${sqlName}.json`);
    aot(
      record,
      (name) => name === `extension:${sqlName}` || name.startsWith(`extension:${sqlName}:`),
      (member) => file(contribAotName, `payload/files/extensions/${sqlName}/${member}`),
    );
    return { sqlName, targetTriple: spec.targetTriple, ...record };
  });
  const lockIdentity = copyDeclared(spec.cargoLock, path.join(spec.output, 'Cargo.lock'));
  const inventory = {
    schema: 'oliphaunt-wasix-napi-build-inputs-v2',
    target: spec.target,
    targetTriple: spec.targetTriple,
    cargoLock: { path: 'Cargo.lock', sha256: lockIdentity.sha256, size: lockIdentity.size },
    dependencies: origins,
    inputs: {
      portableManifest,
      runtimeArchive,
      runtimeAotManifest: { targetTriple: spec.targetTriple, ...runtimeAotManifest },
      extensionArtifacts: [
        { product: 'oliphaunt-extension-contrib-pg18', portableArchives, aotManifests },
      ],
    },
  };
  mkdirSync(spec.output, { recursive: true });
  writeFileSync(
    path.join(spec.output, 'build-inputs.json'),
    `${JSON.stringify(inventory, null, 2)}\n`,
  );
  // The conventional addon build script accepts a target-named AOT directory.
  // Only its small validation manifest is projected: the SDK still compiles the
  // original checksum-locked registry payloads, all bound above.
  const aotRoot = `aot/${spec.targetTriple}`;
  mkdirSync(path.join(spec.output, aotRoot), { recursive: true });
  copyFileSync(
    path.join(spec.output, runtimeAotManifest.path),
    path.join(spec.output, aotRoot, 'manifest.json'),
  );
  const layout = {
    runtimeVersion,
    portableRoot: path.dirname(portableManifest.path),
    aotRoot,
    extensionRoot: `registry/${contribName}-${origins.find((row) => row.name === contribName)!.version}`,
  };
  writeFileSync(path.join(spec.output, 'layout.json'), `${JSON.stringify(layout, null, 2)}\n`);
  return { inventory, ...layout };
}

if (import.meta.main) {
  const [spec] = process.argv.slice(2);
  stageWasixNapiInputs(JSON.parse(readFileSync(spec, 'utf8')));
}
