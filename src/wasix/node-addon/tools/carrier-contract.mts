import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { inspectPlatformBinaryEntries } from '../../../../tools/packaging/platform-binary-contract.mts';
import {
  WINDOWS_VC_RUNTIME_DLLS,
  WINDOWS_VC_RUNTIME_RECEIPT,
} from '../../../../tools/packaging/windows-vc-runtime-closure.mts';
import {
  AOT_PACKAGES,
  AOT_TARGET_TRIPLES,
  EXTENSION_AOT_PACKAGE_SUFFIXES,
} from '../../runtime/tools/wasix-cargo-artifact-contract.mts';

const BINARY = 'oliphaunt_wasix_napi.node';
export const WASIX_NAPI_SOURCE_PATCH_MEMBER =
  'source-patches/held-wasix-relocatable-includes.patch';
const compareText = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

export type WasixNapiRuntimeContract = {
  runtimeProduct: string;
  runtimeVersion: string;
  addonAbiVersion: number;
  nodeApiVersion: number;
  qualificationOnly?: boolean;
  packageLicense: string;
};
export type WasixNapiTarget = {
  target: string;
  triple?: string;
  npmPackage: string;
  npmOs: string;
  npmCpu: string;
  npmLibc?: string;
};
export type WasixNapiConstructionContract = {
  targetTriple: string;
  runtimeVersion: string;
  sdkVersion: string;
  sqlNames: readonly string[];
  sourcePatch: { path: string; sha256: string; size: number };
};

/** Conventional Cargo feature expansion supplies the release member expectation. */
export function wasixNapiReleaseSqlNames(manifest: any, sqlNames: readonly string[]) {
  const enabled = new Set([
    'release',
    ...(Object.hasOwn(manifest.features ?? {}, 'default') ? ['default'] : []),
  ]);
  for (const feature of enabled) {
    const members = manifest.features?.[feature];
    assert(
      members || manifest.dependencies?.[feature]?.optional === true,
      `unknown addon Cargo feature ${feature}`,
    );
    for (const member of members ?? [])
      if (!member.includes('/') && !member.startsWith('dep:')) enabled.add(member);
  }
  const names = [...enabled]
    .filter((feature) => feature.startsWith('extension-'))
    .map((feature) => {
      const matches = sqlNames.filter(
        (name) => `extension-${name.replaceAll('_', '-')}` === feature,
      );
      assert.equal(matches.length, 1, 'release Cargo feature has no unique canonical SQL member');
      return matches[0];
    })
    .sort();
  assert(names.length > 0 && new Set(names).size === names.length);
  return names;
}

/** Source/run authentication is supplied by native build evidence, not a moving Git stamp. */
export function assertWasixNapiConstructionData(
  value: any,
  target: string,
  binarySha256: string,
  contract: WasixNapiConstructionContract,
) {
  assert.equal(value.schema, 'oliphaunt-wasix-napi-construction-data-v2');
  assert(!Object.hasOwn(value, 'scope'), 'construction data does not authorize release');
  assert.equal(value.product, 'oliphaunt-wasix-napi');
  assert.equal(value.target, target);
  assert(
    !Object.hasOwn(value, 'sourceSha') && !Object.hasOwn(value, 'artifactSourceSha'),
    'construction cannot invent Git source authentication',
  );
  const inputs = value.buildInputs;
  assert.equal(inputs.schema, 'oliphaunt-wasix-napi-build-inputs-v2');
  assert.equal(inputs.target, target);
  assert(Object.hasOwn(AOT_TARGET_TRIPLES, target), 'unsupported addon construction target');
  assert.equal(inputs.targetTriple, AOT_TARGET_TRIPLES[target]);
  assert.equal(inputs.targetTriple, contract.targetTriple);
  assert.deepEqual(value.build, {
    cargoProfile: 'release',
    incremental: false,
    codegenUnits: 1,
    lto: 'thin',
    strip: 'symbols',
    features: ['release'],
    targetTriple: inputs.targetTriple,
  });
  assert.equal(value.binary.filename, BINARY);
  assert.equal(value.binary.sha256, binarySha256);
  assert(!Object.hasOwn(value, 'binaries'), 'construction binds one addon binary');
  assert.match(binarySha256, /^[0-9a-f]{64}$/u);
  assert(
    Array.isArray(inputs.dependencies) && inputs.dependencies.length > 0,
    'construction requires exact compiled registry origins',
  );
  const files = new Map<string, any>();
  const names = new Set<string>();
  for (const dependency of inputs.dependencies) {
    assert(!names.has(dependency.name), 'duplicate compiled registry origin');
    names.add(dependency.name);
    assert.match(dependency.name, /^[a-zA-Z0-9_-]+$/u);
    assert.match(
      dependency.version,
      /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:[-+][0-9A-Za-z.-]+)?$/u,
    );
    assert.equal(dependency.source, 'registry+https://github.com/rust-lang/crates.io-index');
    assert.match(dependency.checksum, /^[0-9a-f]{64}$/u);
    assert(Array.isArray(dependency.files) && dependency.files.length > 0);
    for (const file of dependency.files) {
      assert(!files.has(file.path), 'duplicate compiled registry file');
      assert(file.path.startsWith(`registry/${dependency.name}-${dependency.version}/`));
      assert(
        !file.path.includes('\\') &&
          file.path.split('/').every((part: string) => part && part !== '.' && part !== '..'),
      );
      assert.match(file.sha256, /^[0-9a-f]{64}$/u);
      assert(Number.isSafeInteger(file.size) && file.size > 0);
      files.set(file.path, file);
    }
    assert(
      files.has(`registry/${dependency.name}-${dependency.version}/Cargo.toml`),
      'compiled registry origin has no conventional manifest',
    );
  }
  const portableName = 'liboliphaunt-wasix-portable';
  const coreName = AOT_PACKAGES[target];
  const contribName = 'oliphaunt-extension-contrib-pg18-wasix';
  const contribAotName = `oliphaunt-extension-contrib-pg18-aot-${EXTENSION_AOT_PACKAGE_SUFFIXES[contract.targetTriple]}`;
  assert.deepEqual(
    [...names].sort(),
    ['oliphaunt-wasix', portableName, coreName, contribName, contribAotName].sort(),
    'construction requires its exact compiled SDK, runtime and contrib origins',
  );
  const origin = (name: string) => inputs.dependencies.find((row: any) => row.name === name);
  assert.equal(contract.sourcePatch.path, WASIX_NAPI_SOURCE_PATCH_MEMBER);
  assert.match(contract.sourcePatch.sha256, /^[0-9a-f]{64}$/u);
  assert(Number.isSafeInteger(contract.sourcePatch.size) && contract.sourcePatch.size > 0);
  for (const dependency of inputs.dependencies) {
    if (dependency.name === portableName || dependency.name === coreName) {
      assert.deepEqual(
        dependency.patches,
        [contract.sourcePatch],
        'compiled source patch differs from the declared recipe',
      );
      assert(
        files.has(`registry/${dependency.name}-${dependency.version}/build-support.rs`),
        'compiled patched registry source is missing',
      );
    } else
      assert(
        !Object.hasOwn(dependency, 'patches'),
        'unpatched compiled registry origin claims a patch',
      );
  }
  assert.equal(origin('oliphaunt-wasix').version, contract.sdkVersion);
  assert.equal(origin(portableName).version, contract.runtimeVersion);
  assert.equal(origin(coreName).version, contract.runtimeVersion);
  const bound = (file: any) => {
    assert(file && files.has(file.path), 'construction input is outside compiled registry origins');
    const { sqlName: _sqlName, targetTriple: _targetTriple, ...identity } = file;
    assert.deepEqual(
      identity,
      files.get(file.path),
      'construction input differs from compiled registry file',
    );
  };
  bound(inputs.inputs.portableManifest);
  bound(inputs.inputs.runtimeArchive);
  bound(inputs.inputs.runtimeAotManifest);
  assert.equal(
    inputs.inputs.portableManifest.path,
    `registry/${portableName}-${contract.runtimeVersion}/payload/manifest.json`,
  );
  assert(
    inputs.inputs.runtimeArchive.path.startsWith(
      `registry/${portableName}-${contract.runtimeVersion}/payload/`,
    ),
  );
  assert.equal(
    inputs.inputs.runtimeAotManifest.path,
    `registry/${coreName}-${contract.runtimeVersion}/artifacts/manifest.json`,
  );
  assert.equal(inputs.inputs.runtimeAotManifest.targetTriple, inputs.targetTriple);
  assert.equal(inputs.inputs.extensionArtifacts.length, 1);
  const contrib = inputs.inputs.extensionArtifacts[0];
  assert.equal(contrib.product, 'oliphaunt-extension-contrib-pg18');
  const portableNames = contrib.portableArchives.map((row: any) => row.sqlName).sort();
  const aotNames = contrib.aotManifests.map((row: any) => row.sqlName).sort();
  assert(portableNames.length > 0 && new Set(portableNames).size === portableNames.length);
  assert.deepEqual(
    portableNames,
    [...contract.sqlNames].sort(),
    'construction differs from the release Cargo extension closure',
  );
  assert.deepEqual(aotNames, portableNames, 'construction portable and AOT member sets differ');
  for (const row of contrib.portableArchives) {
    bound(row);
    assert.equal(
      row.path,
      `registry/${contribName}-${origin(contribName).version}/payload/files/extensions/${row.sqlName}/extension.tar.zst`,
    );
  }
  for (const row of contrib.aotManifests) {
    assert.equal(row.targetTriple, inputs.targetTriple);
    bound(row);
    assert.equal(
      row.path,
      `registry/${contribAotName}-${origin(contribAotName).version}/manifests/${row.sqlName}.json`,
    );
  }
  assert.equal(inputs.cargoLock.path, 'Cargo.lock');
  assert.match(inputs.cargoLock.sha256, /^[0-9a-f]{64}$/u);
  assert(Number.isSafeInteger(inputs.cargoLock.size) && inputs.cargoLock.size > 0);
  return value;
}

/** The expected runtime is the selected consumer pin, independent of current producer versions. */
export function assertWasixNapiCarrierManifest(
  manifest: any,
  target: WasixNapiTarget,
  version: string,
  label: string,
  contract: WasixNapiRuntimeContract,
) {
  if (manifest.name !== target.npmPackage || manifest.version !== version)
    throw new Error(`${label} must identify ${target.npmPackage}@${version}`);
  if (manifest.license !== contract.packageLicense)
    throw new Error(
      `${label} package license must be ${contract.packageLicense}, got ${JSON.stringify(manifest.license)}`,
    );
  if (
    manifest.oliphaunt?.target !== target.target ||
    manifest.oliphaunt?.runtimeProduct !== contract.runtimeProduct ||
    manifest.oliphaunt?.runtimeVersion !== contract.runtimeVersion ||
    manifest.oliphaunt?.qualificationOnly !== contract.qualificationOnly ||
    manifest.oliphaunt?.addonAbiVersion !== contract.addonAbiVersion ||
    manifest.oliphaunt?.nodeApiVersion !== contract.nodeApiVersion ||
    JSON.stringify(manifest.oliphaunt?.profiles) !== JSON.stringify(['standard', 'icu'])
  )
    throw new Error(`${label} has incompatible WASIX Node-API target/runtime/ABI/profile metadata`);
  if (
    JSON.stringify(manifest.os) !== JSON.stringify([target.npmOs]) ||
    JSON.stringify(manifest.cpu) !== JSON.stringify([target.npmCpu]) ||
    (target.npmLibc === undefined
      ? Object.hasOwn(manifest, 'libc')
      : JSON.stringify(manifest.libc) !== JSON.stringify([target.npmLibc])) ||
    manifest.optional !== true ||
    manifest.type !== 'commonjs' ||
    Object.hasOwn(manifest, 'scripts')
  )
    throw new Error(`${label} has incompatible npm platform or lifecycle metadata`);
  if (
    JSON.stringify(manifest.files) !==
    JSON.stringify([
      'prebuilds',
      'artifact-provenance.json',
      'README.md',
      'LICENSE',
      'THIRD_PARTY_NOTICES.md',
      'THIRD_PARTY_NOTICES.oliphaunt-wasix.md',
      'THIRD_PARTY_LICENSES',
    ])
  )
    throw new Error(`${label} must declare the exact one-addon package file surface`);
  if (
    manifest.exports?.[`./${BINARY}`] !== `./prebuilds/${BINARY}` ||
    JSON.stringify(Object.keys(manifest.exports ?? {})) !==
      JSON.stringify([`./${BINARY}`, './artifact-provenance.json', './package.json'])
  )
    throw new Error(`${label} must expose exactly one stable addon binary subpath`);
  return manifest;
}

export function assertSingleWasixNapiAddonMember(entries, binaryMember, label = 'carrier') {
  const nativeMembers = [...entries.keys()].filter((name) => name.endsWith('.node'));
  if (JSON.stringify(nativeMembers) !== JSON.stringify([binaryMember]))
    throw new Error(
      `${label} must contain exactly one native addon member ${binaryMember}; got ${nativeMembers.join(', ')}`,
    );
}

export function assertWasixNapiPlatformEntries(
  entries,
  { target, label = 'carrier', prefix = '', binaryDirectory = '' },
) {
  inspectPlatformBinaryEntries(
    [...entries].map(([name, entry]) => ({ name, ...entry })),
    { target, rootLabel: label },
  );
  if (target !== 'windows-x64-msvc') return;
  const sibling = (name) => [prefix, binaryDirectory, name].filter(Boolean).join('/');
  const runtimeNames = new Set(WINDOWS_VC_RUNTIME_DLLS);
  const actualRuntimeMembers = [...entries]
    .filter(
      ([name, entry]) => entry?.isFile && runtimeNames.has(path.posix.basename(name).toLowerCase()),
    )
    .map(([name]) => name)
    .sort(compareText);
  const expectedRuntimeMembers = WINDOWS_VC_RUNTIME_DLLS.filter((name) =>
    entries.has(sibling(name)),
  )
    .map((name) => sibling(name))
    .sort(compareText);
  if (JSON.stringify(actualRuntimeMembers) !== JSON.stringify(expectedRuntimeMembers))
    throw new Error(
      `${label} must place its exact app-local VC runtime closure beside ${sibling(BINARY)}`,
    );
  const expectedReceiptMember = sibling(WINDOWS_VC_RUNTIME_RECEIPT);
  const actualReceiptMembers = [...entries.keys()]
    .filter((name) => path.posix.basename(name).toLowerCase() === WINDOWS_VC_RUNTIME_RECEIPT)
    .sort(compareText);
  if (
    JSON.stringify(actualReceiptMembers) !==
    JSON.stringify(expectedRuntimeMembers.length > 0 ? [expectedReceiptMember] : [])
  )
    throw new Error(`${label} must carry one VC runtime receipt beside its app-local closure`);
  if (expectedRuntimeMembers.length === 0) return;
  const receipt = entries.get(expectedReceiptMember);
  if (!receipt?.isFile || receipt.isSymbolicLink)
    throw new Error(`${label} is missing regular member ${expectedReceiptMember}`);
  const expectedReceipt = expectedRuntimeMembers
    .map((member) => {
      const digest = createHash('sha256')
        .update(Buffer.from(entries.get(member).data()))
        .digest('hex');
      return `${digest}  ${path.posix.basename(member)}\n`;
    })
    .join('');
  if (Buffer.from(receipt.data()).toString('utf8') !== expectedReceipt)
    throw new Error(`${label} ${expectedReceiptMember} does not bind its exact VC runtime bytes`);
}

export const WASIX_NAPI_PLATFORM_PACKAGES = Object.freeze([
  '@oliphaunt/wasix-napi-darwin-arm64',
  '@oliphaunt/wasix-napi-linux-arm64-gnu',
  '@oliphaunt/wasix-napi-linux-x64-gnu',
  '@oliphaunt/wasix-napi-win32-x64-msvc',
]);

export function assertWasixTypescriptNativeCarrier(manifest, carrier) {
  const sdk = manifest.oliphaunt;
  const native = carrier.oliphaunt;
  if (
    manifest.name !== '@oliphaunt/wasix-ts' ||
    sdk?.runtimeProduct !== 'liboliphaunt-wasix' ||
    sdk?.wasixNapiProduct !== 'oliphaunt-wasix-napi' ||
    !/^\d+\.\d+\.\d+$/u.test(sdk?.runtimeVersion ?? '') ||
    !/^\d+\.\d+\.\d+$/u.test(sdk?.wasixNapiVersion ?? '') ||
    !Number.isSafeInteger(sdk?.wasixAddonAbiVersion) ||
    sdk.wasixAddonAbiVersion < 1 ||
    !Number.isSafeInteger(sdk?.nodeApiVersion) ||
    sdk.nodeApiVersion < 1 ||
    Object.hasOwn(sdk, 'qualificationOnly') ||
    Object.hasOwn(native ?? {}, 'qualificationOnly') ||
    !WASIX_NAPI_PLATFORM_PACKAGES.includes(carrier.name) ||
    carrier.version !== sdk?.wasixNapiVersion ||
    manifest.optionalDependencies?.[carrier.name] !== carrier.version ||
    native?.runtimeProduct !== sdk?.runtimeProduct ||
    native?.runtimeVersion !== sdk?.runtimeVersion ||
    native?.addonAbiVersion !== sdk?.wasixAddonAbiVersion ||
    native?.nodeApiVersion !== sdk?.nodeApiVersion ||
    JSON.stringify(native?.profiles) !== JSON.stringify(['standard', 'icu'])
  ) {
    throw new Error(
      `wasix-typescript-package.mts: ${carrier.name}@${carrier.version} is incompatible with @oliphaunt/wasix-ts@${manifest.version}: SDK requires N-API ${sdk?.wasixNapiVersion} embedding runtime ${sdk?.runtimeVersion}, carrier embeds runtime ${native?.runtimeVersion}`,
    );
  }
}
