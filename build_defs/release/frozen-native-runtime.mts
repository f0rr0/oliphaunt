import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { compatibilityVersionFromText } from '../../tools/release/compatibility-version-parser.mts';
import {
  extractPortableArchiveTree,
  readPortableArchiveEntries,
} from '../../tools/packaging/portable-archive.mts';

const product = 'liboliphaunt-native';
const fullSha = /^[a-f0-9]{40}$/u;
const digest = /^[a-f0-9]{64}$/u;
const stableVersion = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;
const targets = new Map([
  ['linux-x64-gnu', 'lib/liboliphaunt.so'],
  ['linux-arm64-gnu', 'lib/liboliphaunt.so'],
  ['macos-arm64', 'lib/liboliphaunt.dylib'],
  ['android-arm64-v8a', 'lib/liboliphaunt.so'],
  ['android-x86_64', 'lib/liboliphaunt.so'],
]);

function exactKeys(value, keys, context) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())
  )
    throw new Error(`${context} requires exact immutable fact fields`);
}

/** Import existing captured GitHub/completion facts, bound to the consumer's authored pin. */
export function frozenNativeRuntimeInputs({
  releases,
  completion,
  descriptor,
  compatibilityText,
  compatibilityPath,
  selectedTargets,
}) {
  const matches = Object.entries(descriptor.compatibility_versions ?? {}).filter(
    ([, entry]) => entry.source_product === product && entry.path === compatibilityPath,
  );
  if (matches.length !== 1)
    throw new Error('native runtime acquisition requires one declared compatibility owner/source');
  const [id, entry] = matches[0];
  const version = compatibilityVersionFromText({ id, ...entry }, compatibilityText);
  if (!stableVersion.test(version))
    throw new Error('native runtime requires one stable compatibility pin');
  exactKeys(
    completion,
    ['product', 'version', 'tagName', 'publicationSha', 'publicationTree', 'releaseSha'],
    'completed publication',
  );
  if (
    completion.product !== product ||
    completion.version !== version ||
    completion.tagName !== `${product}-v${version}` ||
    ![completion.publicationSha, completion.publicationTree, completion.releaseSha].every((sha) =>
      fullSha.test(sha),
    )
  )
    throw new Error('completed publication does not match the declared native compatibility pin');
  if (!Array.isArray(releases) || releases.length !== 1)
    throw new Error('native acquisition requires one captured published release');
  const release = releases[0];
  exactKeys(
    release,
    [
      'product',
      'version',
      'tag',
      'releaseId',
      'releaseName',
      'targetCommitish',
      'draft',
      'prerelease',
      'assets',
    ],
    'GitHub release snapshot',
  );
  if (
    release.product !== product ||
    release.version !== version ||
    release.tag !== completion.tagName ||
    release.releaseName !== `${product} v${version}` ||
    release.targetCommitish !== completion.publicationSha ||
    release.draft !== false ||
    release.prerelease !== false ||
    !Number.isSafeInteger(release.releaseId) ||
    release.releaseId <= 0 ||
    !Array.isArray(release.assets) ||
    release.assets.length === 0
  )
    throw new Error('GitHub release snapshot differs from the completed native publication');
  const names = new Set();
  const ids = new Set();
  for (const asset of release.assets) {
    exactKeys(asset, ['assetId', 'name', 'sha256', 'size'], 'GitHub release asset');
    if (
      !Number.isSafeInteger(asset.assetId) ||
      asset.assetId <= 0 ||
      ids.has(asset.assetId) ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(asset.name) ||
      names.has(asset.name) ||
      !digest.test(asset.sha256) ||
      !Number.isSafeInteger(asset.size) ||
      asset.size <= 0
    )
      throw new Error('GitHub release snapshot has an invalid or duplicate immutable asset');
    names.add(asset.name);
    ids.add(asset.assetId);
  }
  if (
    !Array.isArray(selectedTargets) ||
    selectedTargets.length === 0 ||
    new Set(selectedTargets).size !== selectedTargets.length
  )
    throw new Error('native acquisition requires a unique nonempty target set');
  return selectedTargets.map((target) => {
    const library = targets.get(target);
    if (!library) throw new Error(`unsupported frozen native runtime target: ${target}`);
    const name = `liboliphaunt-${version}-${target}.tar.gz`;
    const asset = release.assets.find((row) => row.name === name);
    if (!asset) throw new Error(`completed native publication is missing ${name}`);
    return {
      ...asset,
      target,
      library,
      version,
      publicationSha: completion.publicationSha,
      publicationTree: completion.publicationTree,
      url: `https://github.com/f0rr0/oliphaunt/releases/download/${release.tag}/${name}`,
    };
  });
}

/** Check physical immutable bytes and extract through the retained safe archive reader. */
export function extractFrozenNativeRuntime(input, archive, destination) {
  const bytes = readFileSync(archive);
  if (
    bytes.length !== input.size ||
    createHash('sha256').update(bytes).digest('hex') !== input.sha256
  )
    throw new Error(
      `frozen native runtime archive differs from captured publication: ${input.name}`,
    );
  const entries = readPortableArchiveEntries(archive);
  for (const member of [
    input.library,
    'include/oliphaunt.h',
    'LICENSE',
    'THIRD_PARTY_NOTICES.md',
    'THIRD_PARTY_LICENSES/PostgreSQL-COPYRIGHT',
    'THIRD_PARTY_LICENSES/ICU-LICENSE',
  ])
    if (!entries.get(member)?.isFile)
      throw new Error(`frozen native runtime is missing regular member ${member}`);
  extractPortableArchiveTree(archive, destination);
}

if (import.meta.main) {
  const [
    releasesFile,
    completionFile,
    descriptorFile,
    compatibilityFile,
    compatibilityPath,
    targetsJson,
    output,
    archiveDirectory,
  ] = process.argv.slice(2);
  if (!output || process.argv.length > 10)
    throw new Error(
      'usage: frozen-native-runtime.mts RELEASES COMPLETION DESCRIPTOR COMPATIBILITY PATH TARGETS_JSON OUTPUT [ARCHIVE_DIRECTORY]',
    );
  const inputs = frozenNativeRuntimeInputs({
    releases: JSON.parse(readFileSync(releasesFile, 'utf8')),
    completion: JSON.parse(readFileSync(completionFile, 'utf8')),
    descriptor: Bun.TOML.parse(readFileSync(descriptorFile, 'utf8')),
    compatibilityText: readFileSync(compatibilityFile, 'utf8'),
    compatibilityPath,
    selectedTargets: JSON.parse(targetsJson),
  });
  if (archiveDirectory)
    for (const input of inputs)
      extractFrozenNativeRuntime(
        input,
        path.join(archiveDirectory, input.name),
        path.join(archiveDirectory, input.target),
      );
  writeFileSync(output, JSON.stringify(inputs));
}
