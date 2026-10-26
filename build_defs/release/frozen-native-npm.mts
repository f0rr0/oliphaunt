import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inspectPlatformBinaryEntries } from '../../tools/packaging/platform-binary-contract.mts';
import {
  extractPortableArchiveTree,
  readPortableArchiveEntries,
} from '../../tools/packaging/portable-archive.mts';
import { verifyWindowsVcRuntimeClosure } from '../../tools/packaging/windows-vc-runtime-closure.mts';
import {
  frozenNativeRuntimeInputs,
  frozenWindowsVcRuntimeProfile,
} from './frozen-native-runtime.mts';

const provenance = 'https://slsa.dev/provenance/v1';
const publish = 'https://github.com/npm/attestation/tree/main/specs/publish/v0.1';
const repository = 'https://github.com/f0rr0/oliphaunt';
const platforms = new Map([
  ['linux-x64-gnu', { suffix: 'linux-x64-gnu', os: 'linux', cpu: 'x64', libc: ['glibc'] }],
  ['linux-arm64-gnu', { suffix: 'linux-arm64-gnu', os: 'linux', cpu: 'arm64', libc: ['glibc'] }],
  ['macos-arm64', { suffix: 'darwin-arm64', os: 'darwin', cpu: 'arm64' }],
  ['windows-x64-msvc', { suffix: 'win32-x64-msvc', os: 'win32', cpu: 'x64' }],
]);

function matchesPlatform(manifest, target) {
  const platform = platforms.get(target);
  return (
    platform &&
    manifest.name === `@oliphaunt/liboliphaunt-${platform.suffix}` &&
    JSON.stringify(manifest.os) === JSON.stringify([platform.os]) &&
    JSON.stringify(manifest.cpu) === JSON.stringify([platform.cpu]) &&
    JSON.stringify(manifest.libc) === JSON.stringify(platform.libc) &&
    manifest.optional === true
  );
}

/** Consume independently signature-verified registry captures; this is not a new authentication authority. */
export function frozenNativeNpmInput({
  metadata,
  attestations,
  ownerDescriptor,
  target,
  ...runtime
}) {
  const [native] = frozenNativeRuntimeInputs({ ...runtime, selectedTargets: [target] });
  const name = metadata.name;
  const version = native.version;
  if (
    ownerDescriptor.id !== 'liboliphaunt-native' ||
    !ownerDescriptor.registry_packages?.includes(`npm:${name}`) ||
    !matchesPlatform(metadata, target) ||
    metadata.version !== version ||
    metadata.oliphaunt?.target !== target ||
    metadata.oliphaunt.libraryRelativePath !== native.library ||
    metadata.oliphaunt.runtimeRelativePath !== 'runtime'
  )
    throw new Error(
      'frozen native npm identity differs from its declared owner or compatibility pin',
    );
  const filename = `${name.split('/').at(-1)}-${version}.tgz`;
  const url = `https://registry.npmjs.org/${name}/-/${filename}`;
  const integrity = metadata.dist?.integrity;
  if (
    metadata.dist?.tarball !== url ||
    !/^sha512-[A-Za-z0-9+/]{86}==$/u.test(integrity ?? '') ||
    !/^[0-9a-f]{40}$/u.test(metadata.dist?.shasum ?? '')
  )
    throw new Error(
      'frozen native npm requires canonical registry URL and immutable SHA-512 integrity',
    );
  const sha512 = Buffer.from(integrity.slice(7), 'base64').toString('hex');
  const subject = `pkg:npm/${name.replace('@', '%40')}@${version}`;
  for (const kind of [provenance, publish]) {
    const rows = attestations?.attestations?.filter((row) => row.predicateType === kind) ?? [];
    if (rows.length !== 1)
      throw new Error(
        'frozen native npm requires unique captured provenance and publish attestations',
      );
    const envelope = rows[0].bundle?.dsseEnvelope;
    if (envelope?.payloadType !== 'application/vnd.in-toto+json' || !envelope.signatures?.length)
      throw new Error('frozen native npm attestation is missing its signed statement');
    const statement = JSON.parse(Buffer.from(envelope.payload, 'base64').toString('utf8'));
    if (
      statement.predicateType !== kind ||
      statement.subject?.length !== 1 ||
      statement.subject[0].name !== subject ||
      statement.subject[0].digest?.sha512 !== sha512
    )
      throw new Error('frozen native npm attestation does not bind the exact registry archive');
    if (kind === provenance) {
      const definition = statement.predicate?.buildDefinition;
      const workflow = definition?.externalParameters?.workflow;
      const sources = definition?.resolvedDependencies ?? [];
      if (
        definition?.buildType !==
          'https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1' ||
        workflow?.repository !== repository ||
        workflow.ref !== 'refs/heads/main' ||
        workflow.path !== '.github/workflows/release.yml' ||
        sources.length !== 1 ||
        sources[0].uri !== `git+${repository}@refs/heads/main` ||
        sources[0].digest?.gitCommit !== native.publicationSha
      )
        throw new Error(
          'frozen native npm provenance differs from the completed native publication source',
        );
    } else if (
      statement.predicate?.name !== name ||
      statement.predicate.version !== version ||
      statement.predicate.registry !== 'https://registry.npmjs.org'
    )
      throw new Error('frozen native npm publish attestation differs from its registry identity');
  }
  return {
    name,
    version,
    target,
    filename,
    url,
    integrity,
    shasum: metadata.dist.shasum,
    library: native.library,
    publicationSha: native.publicationSha,
    publicationTree: native.publicationTree,
  };
}

export function verifyFrozenNativeNpm(input, archive) {
  const bytes = readFileSync(archive);
  if (
    `sha512-${createHash('sha512').update(bytes).digest('base64')}` !== input.integrity ||
    createHash('sha1').update(bytes).digest('hex') !== input.shasum
  )
    throw new Error('frozen native npm archive differs from captured registry integrity');
  const entries = readPortableArchiveEntries(archive);
  if ([...entries.keys()].some((name) => name !== 'package' && !name.startsWith('package/')))
    throw new Error('frozen native npm archive must contain only its package tree');
  const member = entries.get('package/package.json');
  if (!member?.isFile)
    throw new Error('frozen native npm archive is missing its regular package manifest');
  const manifest = JSON.parse(
    (typeof member.data === 'function' ? member.data() : member.data).toString('utf8'),
  );
  if (
    manifest.name !== input.name ||
    manifest.version !== input.version ||
    !matchesPlatform(manifest, input.target) ||
    manifest.oliphaunt?.target !== input.target ||
    manifest.oliphaunt.libraryRelativePath !== input.library ||
    manifest.oliphaunt.runtimeRelativePath !== 'runtime'
  )
    throw new Error('frozen native npm physical manifest differs from declared registry identity');
  for (const file of [
    input.library,
    `runtime/bin/initdb${input.target === 'windows-x64-msvc' ? '.exe' : ''}`,
    'runtime/share/postgresql/postgres.bki',
    'LICENSE',
    'THIRD_PARTY_NOTICES.md',
    'THIRD_PARTY_LICENSES/PostgreSQL-COPYRIGHT',
    'THIRD_PARTY_LICENSES/ICU-LICENSE',
  ])
    if (!entries.get(`package/${file}`)?.isFile || entries.get(`package/${file}`).size <= 0)
      throw new Error(`frozen native npm archive is missing regular runtime/legal member ${file}`);
  if (input.target === 'windows-x64-msvc') {
    const capturedRuntimeProfile = frozenWindowsVcRuntimeProfile(entries, 'package/');
    inspectPlatformBinaryEntries(
      [...entries].map(([name, entry]) => ({ ...entry, name: name.replace(/^package\//u, '') })),
      {
        target: input.target,
        rootLabel: input.filename,
        windowsVcRuntimeProfile: capturedRuntimeProfile,
      },
    );
    const root = mkdtempSync(path.join(tmpdir(), 'frozen-native-npm-'));
    try {
      extractPortableArchiveTree(archive, root, 'package');
      verifyWindowsVcRuntimeClosure({
        root,
        searchRoots: [path.join(root, 'bin'), path.join(root, 'runtime/bin')],
        profile: capturedRuntimeProfile,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
}

if (import.meta.main) {
  const [
    metadata,
    attestations,
    releases,
    completion,
    descriptor,
    compatibility,
    compatibilityPath,
    owner,
    target,
    output,
    archive,
  ] = process.argv.slice(2);
  if (!output || process.argv.length > 13)
    throw new Error(
      'usage: frozen-native-npm.mts METADATA ATTESTATIONS RELEASES COMPLETION DESCRIPTOR COMPATIBILITY PATH OWNER TARGET OUTPUT [ARCHIVE]',
    );
  const json = (file) => JSON.parse(readFileSync(file, 'utf8'));
  const input = frozenNativeNpmInput({
    metadata: json(metadata),
    attestations: json(attestations),
    releases: json(releases),
    completion: json(completion),
    descriptor: Bun.TOML.parse(readFileSync(descriptor, 'utf8')),
    compatibilityText: readFileSync(compatibility, 'utf8'),
    compatibilityPath,
    ownerDescriptor: Bun.TOML.parse(readFileSync(owner, 'utf8')),
    target,
  });
  if (archive) verifyFrozenNativeNpm(input, archive);
  writeFileSync(output, JSON.stringify(input));
}
