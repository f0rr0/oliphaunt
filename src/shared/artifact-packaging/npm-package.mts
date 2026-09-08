import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { createDeterministicTar } from './cargo-source-package.mts';
import { validateNpmTrustedPublishingManifest } from './npm-trusted-publishing.mts';
import { canonicalGzipSync, portableMemberName } from './portable-archive.mts';

import { fail, isFile, rel } from './staging.mts';

function pnpmPackManifest(envelope) {
  const manifests = Array.isArray(envelope) ? envelope : [envelope];
  if (manifests.length !== 1) {
    return null;
  }
  const [manifest] = manifests;
  if (
    !manifest ||
    typeof manifest !== 'object' ||
    typeof manifest.filename !== 'string' ||
    !manifest.filename.endsWith('.tgz')
  ) {
    return null;
  }
  return manifest;
}

function lineStartOffsets(text) {
  const offsets = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n' && index + 1 < text.length) {
      offsets.push(index + 1);
    }
  }
  return offsets;
}

function parsePackEnvelope(text) {
  try {
    const envelope = JSON.parse(text);
    const manifest = pnpmPackManifest(envelope);
    return manifest ? { envelope, manifest } : null;
  } catch {
    return null;
  }
}

function prefixContainsPackEnvelope(prefix) {
  const starts = lineStartOffsets(prefix);
  const ends = [...starts.slice(1).map((offset) => offset - 1), prefix.length];
  for (const start of starts) {
    for (const end of ends) {
      if (end <= start) {
        continue;
      }
      const candidate = prefix.slice(start, end).trim();
      if (
        (candidate.startsWith('{') || candidate.startsWith('[')) &&
        parsePackEnvelope(candidate)
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Parse the final machine-readable envelope from `pnpm pack --json` output.
 * Lifecycle scripts are allowed to log before the envelope, but a second pack
 * envelope is rejected so a stale or substituted filename cannot be selected.
 */
export function parsePnpmPackOutput(output) {
  const text = String(output ?? '').trim();
  if (!text) {
    throw new Error('pnpm pack produced no output');
  }

  const candidates = [];
  for (const offset of lineStartOffsets(text)) {
    const candidate = text.slice(offset).trimStart();
    if (!candidate.startsWith('{') && !candidate.startsWith('[')) {
      continue;
    }
    const parsed = parsePackEnvelope(candidate);
    if (parsed) {
      candidates.push({ ...parsed, offset: text.length - candidate.length });
    }
  }
  const uniqueCandidates = [
    ...new Map(candidates.map((candidate) => [candidate.offset, candidate])).values(),
  ];
  if (uniqueCandidates.length !== 1) {
    throw new Error(
      `pnpm pack output must end with exactly one JSON envelope containing one .tgz filename; found ${uniqueCandidates.length}`,
    );
  }

  const [selected] = uniqueCandidates;
  if (prefixContainsPackEnvelope(text.slice(0, selected.offset))) {
    throw new Error('pnpm pack output contained more than one JSON package envelope');
  }
  return { envelope: selected.envelope, manifest: selected.manifest };
}

export function finishNpmWorkspacePack(destination) {
  const packJson = readFileSync(path.join(destination, 'pnpm-pack.json'), 'utf8');
  let parsed;
  try {
    parsed = parsePnpmPackOutput(packJson);
  } catch (error) {
    fail(`pnpm pack did not report an unambiguous JSON envelope: ${error.message}`);
  }
  const { envelope, manifest } = parsed;
  writeFileSync(path.join(destination, 'pnpm-pack.json'), `${JSON.stringify(envelope, null, 2)}\n`);
  const packFile = path.isAbsolute(manifest.filename)
    ? manifest.filename
    : path.join(destination, manifest.filename);
  if (!isFile(packFile)) {
    fail(`pnpm pack did not create ${rel(packFile)}`);
  }
  return packFile;
}

if (import.meta.main) {
  if (process.argv.length !== 3) throw new Error('usage: npm-package.mts <artifact-root>');
  console.log(finishNpmWorkspacePack(path.resolve(process.argv[2])));
}

function safeNpmPackageFilenamePrefix(name) {
  return name.replace(/^@/u, '').replaceAll('/', '-');
}
function reject(message) {
  throw new Error(message);
}

export function packGeneratedNpmCarrier(packageDir, tarballRoot) {
  const manifest = JSON.parse(readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
  validateNpmTrustedPublishingManifest(manifest, `${packageDir}/package.json`);
  if (Object.keys(manifest.scripts ?? {}).length > 0)
    reject('staged npm carriers must not contain lifecycle scripts');
  const packDir = path.join(tarballRoot, safeNpmPackageFilenamePrefix(manifest.name));
  const filename = `${safeNpmPackageFilenamePrefix(manifest.name)}-${manifest.version}.tgz`;
  portableMemberName(filename, 'file', packageDir);
  for (const member of manifest.publishConfig?.executableFiles ?? []) {
    chmodSync(path.join(packageDir, portableMemberName(member, 'file', packageDir)), 0o755);
  }
  for (const entry of readdirSync(packageDir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    chmodSync(file, statSync(file).mode & 0o100 ? 0o755 : 0o644);
  }
  rmSync(packDir, { recursive: true, force: true });
  mkdirSync(packDir, { recursive: true });
  const tarball = path.join(packDir, filename);
  writeFileSync(
    tarball,
    canonicalGzipSync(createDeterministicTar(packageDir, 'package', { fail: reject })),
  );
  return tarball;
}
