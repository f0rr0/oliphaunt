// Explicit read-only capture, outside Bazel/repository actions. Version comes
// from the consumer's conventional compatibility declaration, never latest.
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { compatibilityVersionFromText } from '../../tools/release/compatibility-version-parser.mts';
import { createCompletedPublicationChecker } from '../../tools/release/completed-release-publication.mts';
import {
  requestGithubPages,
  requestGithubRepositoryJson,
} from '../../tools/release/github-read.mts';
import { readPortableArchiveEntries } from '../../tools/packaging/portable-archive.mts';
import { frozenNativeNpmInput, verifyFrozenNativeNpm } from './frozen-native-npm.mts';

async function json(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`capture GET ${url} failed: ${response.status}`);
  return response.json();
}

if (import.meta.main) {
  const [descriptorFile, compatibilityPath, name, target, destination] = process.argv.slice(2);
  if (!destination || process.argv.length !== 7)
    throw new Error(
      'usage: capture-native-npm.mts CONSUMER_RELEASE_TOML COMPATIBILITY_PATH NPM_PACKAGE TARGET NEW_OUTPUT_DIRECTORY',
    );
  const descriptor = Bun.TOML.parse(readFileSync(descriptorFile, 'utf8'));
  const compatibilityText = readFileSync(compatibilityPath, 'utf8');
  const matches = Object.entries(descriptor.compatibility_versions ?? {}).filter(
    ([, entry]) =>
      entry.source_product === 'liboliphaunt-native' && entry.path === compatibilityPath,
  );
  if (matches.length !== 1)
    throw new Error('capture requires one authored native compatibility pin');
  const [id, entry] = matches[0];
  const version = compatibilityVersionFromText({ id, ...entry }, compatibilityText);
  if (!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u.test(version))
    throw new Error('capture requires a stable exact native compatibility version');
  const tagName = `liboliphaunt-native-v${version}`;
  const release = await requestGithubRepositoryJson(
    `repos/f0rr0/oliphaunt/releases/tags/${tagName}`,
  );
  const completion = await createCompletedPublicationChecker({ repository: 'f0rr0/oliphaunt' })({
    product: 'liboliphaunt-native',
    version,
    publicationSha: release.target_commitish,
    tagName,
  });
  const assets = await requestGithubPages(
    `repos/f0rr0/oliphaunt/releases/${release.id}/assets?per_page=100`,
  );
  const releases = [
    {
      product: 'liboliphaunt-native',
      version,
      tag: tagName,
      releaseId: release.id,
      releaseName: release.name,
      targetCommitish: release.target_commitish,
      draft: release.draft,
      prerelease: release.prerelease,
      assets: assets.map((asset) => {
        if (!/^sha256:[0-9a-f]{64}$/u.test(asset.digest ?? ''))
          throw new Error(`capture requires GitHub's immutable digest for ${asset.name}`);
        return {
          assetId: asset.id,
          name: asset.name,
          sha256: asset.digest.slice(7),
          size: asset.size,
        };
      }),
    },
  ];
  const metadata = await json(`https://registry.npmjs.org/${encodeURIComponent(name)}/${version}`);
  if (metadata.name !== name)
    throw new Error('registry returned a different requested package identity');
  const attestationUrl = `https://registry.npmjs.org/-/npm/v1/attestations/${name.replace('/', '%2f')}@${version}`;
  if (metadata.dist?.attestations?.url !== attestationUrl)
    throw new Error('capture requires the exact canonical npm attestation endpoint');
  const rawAttestations = await json(attestationUrl);
  // Preserve standard signed bundles, omitting ephemeral signedAccessSignatureUrl.
  const attestations = {
    attestations: rawAttestations.attestations.map(({ predicateType, bundle }) => ({
      predicateType,
      bundle,
    })),
  };
  const ownerDescriptor = Bun.TOML.parse(readFileSync('src/native/runtime/release.toml', 'utf8'));
  const input = frozenNativeNpmInput({
    metadata,
    attestations,
    releases,
    completion,
    descriptor,
    compatibilityText,
    compatibilityPath,
    ownerDescriptor,
    target,
  });
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'oliphaunt-native-npm-capture-'));
  try {
    // npm verifies registry signatures and Sigstore attestations with its
    // maintained verifier. Offline import only binds these verified captures.
    writeFileSync(
      path.join(scratch, 'package.json'),
      JSON.stringify({ private: true, dependencies: { [name]: version } }),
    );
    const npm = (args) => {
      const result = spawnSync(
        'npm',
        [
          ...args,
          '--registry=https://registry.npmjs.org',
          '--userconfig=/dev/null',
          `--cache=${path.join(scratch, 'cache')}`,
        ],
        { cwd: scratch, encoding: 'utf8' },
      );
      if (result.error || result.status !== 0)
        throw new Error(`npm signature capture failed: ${result.error?.message ?? result.stderr}`);
      process.stdout.write(result.stdout);
    };
    npm(['install', '--ignore-scripts', '--no-audit', '--no-fund']);
    const lock = JSON.parse(readFileSync(path.join(scratch, 'package-lock.json'), 'utf8'));
    const installed = lock.packages?.[`node_modules/${name}`];
    if (
      installed?.version !== version ||
      installed.integrity !== input.integrity ||
      installed.resolved !== input.url
    )
      throw new Error('npm authenticated a different archive from the captured metadata');
    npm(['audit', 'signatures']);
    const archive = path.join(scratch, input.filename);
    const response = await fetch(input.url);
    if (!response.ok) throw new Error(`npm archive download failed: ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    writeFileSync(archive, bytes);
    verifyFrozenNativeNpm(input, archive);
    // The public GitHub archive supplies the independently completed native
    // payload. npm intentionally omits its source header; every runtime/legal
    // file must have identical bytes, rather than a renamed current build.
    const asset = releases[0].assets.find(
      (row) => row.name === `liboliphaunt-${version}-${target}.tar.gz`,
    );
    const nativeArchive = path.join(scratch, asset.name);
    const nativeResponse = await fetch(
      `https://github.com/f0rr0/oliphaunt/releases/download/${tagName}/${asset.name}`,
    );
    if (!nativeResponse.ok)
      throw new Error(`completed runtime download failed: ${nativeResponse.status}`);
    const nativeBytes = Buffer.from(await nativeResponse.arrayBuffer());
    if (
      nativeBytes.length !== asset.size ||
      createHash('sha256').update(nativeBytes).digest('hex') !== asset.sha256
    )
      throw new Error('completed GitHub runtime bytes differ from captured release');
    writeFileSync(nativeArchive, nativeBytes);
    const npmEntries = readPortableArchiveEntries(archive);
    for (const [member, file] of readPortableArchiveEntries(nativeArchive)) {
      if (!file.isFile || member === 'include/oliphaunt.h') continue;
      const published = npmEntries.get(`package/${member}`);
      const data = (entry) => (typeof entry.data === 'function' ? entry.data() : entry.data);
      if (!published?.isFile || !data(file).equals(data(published)))
        throw new Error(`npm runtime differs from completed native publication member ${member}`);
    }
    mkdirSync(destination); // Fail rather than overwrite an existing capture.
    const write = (suffix, value) =>
      writeFileSync(
        path.join(destination, `native-${version}-${suffix}.json`),
        `${JSON.stringify(value, null, 2)}\n`,
      );
    write('releases', releases);
    write('completed-publication', completion);
    write(`npm-${target}`, metadata);
    write(`npm-${target}-attestations`, attestations);
    console.log(
      `Captured ${name}@${version}, completed source ${input.publicationSha}, sha256 ${createHash('sha256').update(bytes).digest('hex')}`,
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
