import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createBrokerDependencyLicenseContract } from '../../../src/native/broker/tools/broker-dependency-license-contract.mts';
import { createNodeDependencyLicenseContract } from '../../../src/native/node-addon/tools/dependency-license-contract.mts';
import { archiveDirectory } from '../../../tools/packaging/archive-directory.mts';
import { packageGeneratedCargoSource } from '../../../tools/packaging/cargo-source-package.mts';
import { validateNpmTrustedPublishingManifest } from '../../../tools/packaging/npm-trusted-publishing.mts';
import { createDeterministicTar } from '../../../tools/packaging/package-archive.mts';
import { inspectPlatformBinaryEntries } from '../../../tools/packaging/platform-binary-contract.mts';
import {
  canonicalGzipSync,
  readPortableArchiveEntries,
} from '../../../tools/packaging/portable-archive.mts';
import {
  assertReleaseNoticesInEntries,
  stageReleaseNotices,
} from '../../../tools/packaging/release-notices.mts';
import {
  renderWindowsVcRuntimeSourceReceipt,
  stageWindowsVcRuntime,
  WINDOWS_VC_RUNTIME_RECEIPT,
} from '../../../tools/packaging/windows-vc-runtime-closure.mts';

export interface CarrierRow {
  product: string;
  ecosystem: string;
  name: string;
  version: string;
  target: string | null;
  role: string;
}
export interface HelperArtifact {
  product: string;
  target: string;
  triple: string;
  asset: string;
  kind: string;
  library_relative_path?: string;
  executable_relative_path?: string;
  npm_package: string;
  npm_os: string;
  npm_cpu: string;
  npm_libc?: string | null;
}
export interface HelperPackageSpec {
  product: string;
  version: string;
  artifact: HelperArtifact;
  carriers: CarrierRow[];
  binary: string;
  sources: Record<string, string>;
  legal: Record<string, string>;
  windowsRuntime: Record<string, string>;
  outputs: { github: string; npm: string; cargo?: string };
}

function copy(source: string, destination: string, mode = 0o644): void {
  const physical = realpathSync(source);
  assert(statSync(physical).isFile(), `expected regular declared input ${source}`);
  mkdirSync(path.dirname(destination), { recursive: true });
  copyFileSync(physical, destination);
  chmodSync(destination, mode);
}
function member(root: string, name: string): string {
  assert(
    name &&
      !name.includes('\\') &&
      !path.posix.isAbsolute(name) &&
      name.split('/').every((part) => part && part !== '.' && part !== '..'),
    `unsafe carrier member ${name}`,
  );
  return path.join(root, ...name.split('/'));
}
const digest = (data: Buffer) => createHash('sha256').update(data).digest('hex');

export function validateHelperNpmManifest(
  manifest: Record<string, any>,
  spec: Pick<HelperPackageSpec, 'artifact' | 'carriers' | 'version' | 'product'>,
  payloadLicense: string,
): CarrierRow {
  const row = spec.carriers.find(
    (candidate) => candidate.ecosystem === 'npm' && candidate.name === spec.artifact.npm_package,
  );
  assert(row, `canonical npm carrier missing for ${spec.artifact.target}`);
  assert.equal(row.product, spec.product, 'npm product disagrees with canonical carrier');
  assert.equal(row.version, spec.version, 'npm version disagrees with canonical carrier');
  validateNpmTrustedPublishingManifest(manifest, row.name);
  assert.equal(manifest.name, row.name, 'npm identity disagrees with canonical carrier');
  assert.equal(
    manifest.version,
    row.version,
    'npm version disagrees with conventional product version',
  );
  assert.equal(
    manifest.license,
    payloadLicense,
    'npm payload license disagrees with audited dependency closure',
  );
  assert.equal(
    manifest.oliphaunt?.target,
    spec.artifact.target,
    'npm physical target disagrees with its constructed binary',
  );
  assert.deepEqual(manifest.os, [spec.artifact.npm_os]);
  assert.deepEqual(manifest.cpu, [spec.artifact.npm_cpu]);
  if (spec.artifact.npm_libc) assert.deepEqual(manifest.libc, [spec.artifact.npm_libc]);
  else assert.equal(manifest.libc, undefined);
  assert(
    Array.isArray(manifest.files) &&
      manifest.files.every((name: unknown) => typeof name === 'string' && name),
    'npm files allowlist is required',
  );
  assert.equal(
    new Set(manifest.files).size,
    manifest.files.length,
    'npm files allowlist repeats members',
  );
  for (const name of [
    'LICENSE',
    'THIRD_PARTY_NOTICES.md',
    'THIRD_PARTY_LICENSES',
    spec.artifact.kind === 'node-direct-addon' ? 'prebuilds' : 'bin',
  ])
    assert(manifest.files.includes(name), `npm files allowlist omits ${name}`);
  assert.equal(
    manifest.exports?.['./package.json'],
    './package.json',
    'SDK optional-package resolution requires the conventional package.json export',
  );
  if (spec.artifact.kind === 'node-direct-addon')
    assert.equal(manifest.exports?.['./oliphaunt_node.node'], './prebuilds/oliphaunt_node.node');
  else {
    assert.equal(manifest.oliphaunt?.brokerHelper, spec.product);
    assert.equal(
      manifest.oliphaunt?.executableRelativePath,
      spec.artifact.executable_relative_path,
    );
    assert.deepEqual(manifest.publishConfig?.executableFiles, [
      `./${spec.artifact.executable_relative_path}`,
    ]);
  }
  return row;
}

function legalContract(spec: HelperPackageSpec, sourceRoot: string) {
  const owner =
    spec.product === 'oliphaunt-node-direct' ? 'src/native/node-addon' : 'src/native/broker';
  const contract =
    spec.product === 'oliphaunt-node-direct'
      ? createNodeDependencyLicenseContract(sourceRoot)
      : createBrokerDependencyLicenseContract(sourceRoot);
  const required = [
    'LICENSE',
    'THIRD_PARTY_NOTICES.md',
    'Cargo.lock',
    `${owner}/dependency-licenses.json`,
  ];
  for (const name of required) assert(spec.legal[name], `missing declared legal source ${name}`);
  for (const [name, source] of Object.entries(spec.legal)) {
    assert(
      required.includes(name) || name.startsWith(`${owner}/dependency-license-blobs/`),
      `unexpected legal source ${name}`,
    );
    assert(
      contract.hasSafeRustSourceFilesystemMode(statSync(realpathSync(source)).mode),
      `unsafe legal source mode ${name}`,
    );
    copy(source, member(sourceRoot, name));
  }
  contract.loadRustDependencyLicenseContract({ auditLock: true });
  return contract;
}

function archiveEntries(file: string, prefix = '') {
  return new Map(
    [...readPortableArchiveEntries(file)].map(([name, entry]) => {
      assert(!prefix || name.startsWith(`${prefix}/`), `member outside ${prefix}: ${name}`);
      return [prefix ? name.slice(prefix.length + 1) : name, entry];
    }),
  );
}

/** One bounded envelope action: the caller has already constructed the binary. */
export async function packageNativeHelper(spec: HelperPackageSpec): Promise<void> {
  assert(
    ['oliphaunt-node-direct', 'oliphaunt-broker'].includes(spec.product),
    'unsupported native helper product',
  );
  assert.equal(spec.artifact.product, spec.product);
  assert(
    spec.artifact.asset.includes('{version}'),
    'canonical GitHub asset must carry the version placeholder',
  );
  const root = mkdtempSync(path.join(tmpdir(), 'native-helper-carrier-'));
  try {
    const sourceRoot = path.join(root, 'sources');
    const contract = legalContract(spec, sourceRoot);
    const profile = spec.artifact.kind === 'node-direct-addon' ? 'node-direct-addon' : 'broker';
    const notices = { profile, sourceRoot };
    const target = spec.artifact.target;
    const github = path.join(root, 'github');
    const binaryMember =
      spec.artifact.library_relative_path ?? spec.artifact.executable_relative_path;
    assert(binaryMember, 'canonical artifact omitted its binary member');
    copy(spec.binary, member(github, binaryMember), 0o755);
    const windows = target === 'windows-x64-msvc';
    assert(
      windows || Object.keys(spec.windowsRuntime).length === 0,
      'non-Windows helper cannot carry CRT files',
    );
    const windowsSource = path.join(root, 'crt-source');
    if (windows) {
      for (const [name, source] of Object.entries(spec.windowsRuntime)) {
        assert.equal(
          path.posix.basename(name),
          name,
          'declared CRT input must have a simple basename',
        );
        copy(source, member(windowsSource, name));
      }
      writeFileSync(
        member(windowsSource, WINDOWS_VC_RUNTIME_RECEIPT),
        renderWindowsVcRuntimeSourceReceipt({
          sourceDirectory: windowsSource,
          profile: 'provider',
        }),
      );
    }
    const stageCrt = (destination: string, binaryPath: string) =>
      windows &&
      stageWindowsVcRuntime({
        root: destination,
        sourceDirectory: windowsSource,
        destinations: [path.dirname(member(destination, binaryPath))],
      });
    const githubCrt = stageCrt(github, binaryMember);
    if (spec.artifact.kind === 'broker-helper')
      writeFileSync(
        member(github, 'manifest.properties'),
        [
          'schema=oliphaunt-broker-release-assets-v1',
          `product=${spec.product}`,
          `version=${spec.version}`,
          `target=${target}`,
          `binary=${binaryMember}`,
          ...(githubCrt && githubCrt.required.length
            ? [`windowsVcRuntimeDlls=${githubCrt.required.join(',')}`]
            : []),
          '',
        ].join('\n'),
        { mode: 0o644 },
      );
    const stageLegal = (destination: string) => {
      stageReleaseNotices(destination, notices);
      contract.stageRustDependencyLicenses(destination, target);
    };
    stageLegal(github);
    await archiveDirectory(github, spec.outputs.github);
    const validate = (file: string, prefix = '', payloadPrefix = '') => {
      const entries = archiveEntries(file, prefix);
      assertReleaseNoticesInEntries(
        new Map([...entries].filter(([name]) => !name.startsWith('THIRD_PARTY_LICENSES/rust'))),
        notices,
      );
      contract.assertRustDependencyLicensesInEntries(entries, { target });
      const binaries = [...entries].map(([name, entry]) => ({
        ...entry,
        name:
          payloadPrefix && name.startsWith(payloadPrefix) ? name.slice(payloadPrefix.length) : name,
      }));
      inspectPlatformBinaryEntries(binaries, { target, rootLabel: file });
      return entries;
    };
    validate(spec.outputs.github);
    const npm = path.join(root, 'npm');
    const manifest = JSON.parse(readFileSync(spec.sources['package.json'], 'utf8'));
    validateHelperNpmManifest(manifest, spec, contract.RUST_PAYLOAD_LICENSE);
    copy(spec.sources['package.json'], member(npm, 'package.json'));
    copy(spec.sources['README.md'], member(npm, 'README.md'));
    const npmBinary =
      spec.artifact.kind === 'node-direct-addon' ? `prebuilds/${binaryMember}` : binaryMember;
    copy(spec.binary, member(npm, npmBinary), 0o755);
    stageCrt(npm, npmBinary);
    stageLegal(npm);
    writeFileSync(spec.outputs.npm, canonicalGzipSync(createDeterministicTar(npm, 'package', {})));
    const npmEntries = validate(spec.outputs.npm, 'package');
    const packagedBinary = npmEntries.get(npmBinary);
    assert(packagedBinary?.isFile, 'npm envelope omitted its constructed binary');
    assert.equal(
      digest(packagedBinary.data()),
      digest(readFileSync(spec.binary)),
      'npm envelope changed constructed binary bytes',
    );
    if (spec.outputs.cargo) {
      const row = spec.carriers.find(
        (candidate) =>
          candidate.ecosystem === 'cargo' &&
          candidate.target === target &&
          candidate.role !== 'facade',
      );
      assert(row, `canonical Cargo helper carrier missing for ${target}`);
      for (const name of ['Cargo.toml', 'build.rs', 'src/lib.rs', 'README.md'])
        assert(spec.sources[`cargo/${name}`], `missing declared Cargo target source ${name}`);
      const cargo = path.join(root, 'cargo');
      for (const [name, source] of Object.entries(spec.sources))
        if (name.startsWith('cargo/')) copy(source, member(cargo, name.slice(6)));
      const cargoManifest = Bun.TOML.parse(readFileSync(member(cargo, 'Cargo.toml'), 'utf8'));
      assert.equal(cargoManifest.package?.name, row.name);
      assert.equal(cargoManifest.package?.version, row.version);
      assert.equal(cargoManifest.package?.license, contract.RUST_PAYLOAD_LICENSE);
      assert.equal(cargoManifest.package?.build, 'build.rs');
      assert.equal(
        cargoManifest.package?.readme,
        'README.md',
        'Cargo readme must name its declared source',
      );
      assert.equal(
        cargoManifest.lib?.path,
        'src/lib.rs',
        'Cargo lib.path must name its declared target source',
      );
      assert.equal(
        cargoManifest.package?.links,
        `oliphaunt_artifact_broker_${target.replaceAll('-', '_')}`,
      );
      const constants = Object.fromEntries(
        [
          ...readFileSync(member(cargo, 'src/lib.rs'), 'utf8').matchAll(
            /pub const ([A-Z_]+): &str = "([^"]+)";/gu,
          ),
        ].map((match) => [match[1], match[2]]),
      );
      for (const [key, value] of Object.entries({
        PRODUCT: spec.product,
        KIND: spec.artifact.kind,
        RELEASE_TARGET: target,
        CARGO_TARGET: spec.artifact.triple,
        EXECUTABLE_RELATIVE_PATH: binaryMember,
      }))
        assert.equal(constants[key], value, `Cargo ${key} disagrees with canonical artifact`);
      const payloadMembers = [...readPortableArchiveEntries(spec.outputs.github)]
        .filter(
          ([name, entry]) =>
            entry.isFile && (name === binaryMember || (windows && name.startsWith('bin/'))),
        )
        .map(([name]) => name)
        .sort();
      for (const name of payloadMembers)
        copy(
          member(github, name),
          member(cargo, `payload/${name}`),
          name === binaryMember ? 0o755 : 0o644,
        );
      writeFileSync(
        member(cargo, 'payload/sha256'),
        windows
          ? payloadMembers
              .map((name) => `${digest(readFileSync(member(cargo, `payload/${name}`)))}  ${name}\n`)
              .join('')
          : `${digest(readFileSync(spec.binary))}\n`,
      );
      stageLegal(cargo);
      const archive = packageGeneratedCargoSource(
        member(cargo, 'Cargo.toml'),
        path.join(root, 'cargo-output'),
      );
      copy(archive, spec.outputs.cargo);
      validate(spec.outputs.cargo, `${row.name}-${row.version}`, 'payload/');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  assert.equal(process.argv.length, 3, 'expected one declared envelope specification');
  const specification = process.argv[2];
  assert(specification);
  await packageNativeHelper(JSON.parse(readFileSync(specification, 'utf8')));
}
