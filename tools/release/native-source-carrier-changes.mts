/** Compare completed delivery bytes; this cannot determine release necessity. */
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPortableArchiveEntries } from '../packaging/portable-archive.mts';
import {
  createCompletedPublicationChecker,
  type CompletedPublication,
} from './completed-release-publication.mts';
import { requestGithubRepositoryJson } from './github-read.mts';
import { validatePublicationCandidate } from './publication-lock.mts';
import { verifyRegistryCarrierIntegrity } from './registry-integrity.mts';
import { syncTomlStringPath } from './sync-release-pr.mts';

const ownVersion = '0.0.0';
const fullSha = /^[0-9a-f]{40}$/u;
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const stable = (value: any): string =>
  value && typeof value === 'object'
    ? Array.isArray(value)
      ? `[${value.map(stable).join(',')}]`
      : `{${Object.keys(value)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
          .join(',')}}`
    : JSON.stringify(value);

export type CompletedSourceBaseline = {
  version: string;
  tagName: string;
  publicationSha: string;
  archives: Record<string, string>;
};

function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`native source comparison: ${message}`);
}

function cargoOwnVersion(text: string, name: string, version: string, label: string) {
  const manifest = Bun.TOML.parse(text) as any;
  requireValue(manifest.package?.name === name, `${label} package name differs`);
  if (manifest.package.version?.workspace === true) return text;
  requireValue(manifest.package.version === version, `${label} package version differs`);
  return syncTomlStringPath(text, 'package.version', ownVersion, label).text;
}

function cargoLockOwnVersion(text: string, name: string, version: string) {
  const lock = Bun.TOML.parse(text) as any;
  requireValue(
    [3, 4].includes(lock.version) && Array.isArray(lock.package),
    'shipped Cargo.lock has no conventional package records',
  );
  let own = 0;
  const result = text
    .split(/(?=^\[\[package\]\]\s*$)/mu)
    .map((block) => {
      if (!block.startsWith('[[package]]')) return block;
      const row = (Bun.TOML.parse(block) as any).package[0];
      if (row.name !== name || row.source !== undefined) return block;
      requireValue(row.version === version, 'shipped Cargo.lock own package version differs');
      own++;
      // Reuse the bounded string writer on this one authenticated package table.
      const table = block.replace('[[package]]', '[package]');
      return syncTomlStringPath(
        table,
        'package.version',
        ownVersion,
        'Cargo.lock own package',
      ).text.replace('[package]', '[[package]]');
    })
    .join('');
  requireValue(own === 1, 'shipped Cargo.lock must contain exactly one own package');
  return result;
}

function npmOwnVersion(text: string, version: string) {
  // Token positions preserve every other byte, including nested dependency versions.
  const tokens = [...text.matchAll(/"(?:\\.|[^"\\])*"|[{}\[\]:,]/gu)];
  let depth = 0;
  const own = [];
  for (const [index, token] of tokens.entries()) {
    if (token[0] === '{' || token[0] === '[') depth++;
    else if (token[0] === '}' || token[0] === ']') depth--;
    else if (
      depth === 1 &&
      token[0].startsWith('"') &&
      JSON.parse(token[0]) === 'version' &&
      ['{', ','].includes(tokens[index - 1]?.[0]) &&
      tokens[index + 1]?.[0] === ':'
    ) {
      const value = tokens[index + 2];
      requireValue(value && JSON.parse(value[0]) === version, 'npm own package version differs');
      own.push(value);
    }
  }
  requireValue(own.length === 1, 'npm manifest must contain exactly one own version field');
  const value = own[0];
  return (
    text.slice(0, value.index) +
    JSON.stringify(ownVersion) +
    text.slice(value.index + value[0].length)
  );
}

/** Compare all shipped members, with only typed own package identities neutralized. */
export function sourceCarrierMembers(
  file: string,
  carrier: { ecosystem: string; name: string; version: string },
) {
  const entries = readPortableArchiveEntries(file);
  const prefix = carrier.ecosystem === 'cargo' ? `${carrier.name}-${carrier.version}/` : 'package/';
  const manifestName = carrier.ecosystem === 'cargo' ? 'Cargo.toml' : 'package.json';
  requireValue(['cargo', 'npm'].includes(carrier.ecosystem), 'unsupported source ecosystem');
  const manifestEntry = entries.get(prefix + manifestName);
  requireValue(manifestEntry?.isFile, `missing packed ${manifestName}`);
  const manifest =
    carrier.ecosystem === 'cargo'
      ? (Bun.TOML.parse(utf8.decode(manifestEntry.data())) as any).package
      : JSON.parse(utf8.decode(manifestEntry.data()));
  requireValue(
    manifest?.name === carrier.name && manifest.version === carrier.version,
    'packed candidate name or own version differs from its independent carrier identity',
  );
  requireValue(
    !Object.hasOwn(
      carrier.ecosystem === 'cargo'
        ? ((Bun.TOML.parse(utf8.decode(manifestEntry.data())) as any).package?.metadata
            ?.oliphaunt ?? {})
        : (manifest.oliphaunt ?? {}),
      'qualificationOnly',
    ),
    'qualification-only carrier cannot establish delivery equivalence',
  );
  return [...entries.values()]
    .map((entry) => {
      const packageRoot = entry.isDirectory && entry.name === prefix.slice(0, -1);
      requireValue(
        packageRoot || entry.name.startsWith(prefix),
        `packed member escapes own package: ${entry.name}`,
      );
      const member = packageRoot ? '.' : entry.name.slice(prefix.length);
      let bytes = entry.isFile ? entry.data() : Buffer.alloc(0);
      if (entry.isFile && carrier.ecosystem === 'cargo') {
        if (member === 'Cargo.toml' || member === 'Cargo.toml.orig')
          bytes = Buffer.from(
            cargoOwnVersion(utf8.decode(bytes), carrier.name, carrier.version, member),
          );
        else if (member === 'Cargo.lock')
          bytes = Buffer.from(
            cargoLockOwnVersion(utf8.decode(bytes), carrier.name, carrier.version),
          );
      } else if (entry.isFile && member === 'package.json') {
        bytes = Buffer.from(npmOwnVersion(utf8.decode(bytes), carrier.version));
      }
      return { member, file: entry.isFile, mode: entry.mode, sha256: hash(bytes) };
    })
    .sort((left, right) => left.member.localeCompare(right.member, 'en'));
}

function artifactFile(artifact: any) {
  const file = path.resolve(fileURLToPath(new URL('../..', import.meta.url)), artifact.path);
  const stat = statSync(file);
  requireValue(stat.isFile() && stat.size === artifact.size, 'candidate artifact size differs');
  requireValue(hash(readFileSync(file)) === artifact.sha256, 'candidate artifact bytes differ');
  return file;
}

/**
 * This is a delivery comparison of an existing physical construction candidate.
 * It supplies no execution/cache, qualification or historical Bazel provenance.
 * A different delivery may contain only a provenance stamp from an unrelated
 * commit. Different does not mean needs-release; identical does not qualify a
 * changed producer. Release causality remains unverified, including recipe and
 * toolchain changes. Callers cannot use this report to select or freeze releases.
 */
export async function compareNativeCompletedSourceDelivery(
  candidate: any,
  baselines: Record<string, CompletedSourceBaseline>,
  {
    repository = 'f0rr0/oliphaunt',
    readJson = requestGithubRepositoryJson,
    assertCompletedPublication = createCompletedPublicationChecker({ repository }),
    registryOptions = {},
  } = {},
) {
  requireValue(
    candidate.scope === 'construction',
    'requires a native physical construction candidate',
  );
  requireValue(
    fullSha.test(candidate.source?.commit) && fullSha.test(candidate.source?.tree),
    'candidate has no exact source commit/tree',
  );
  requireValue(
    Array.isArray(candidate.missing) && !candidate.missing.length,
    'candidate inventory is incomplete',
  );
  validatePublicationCandidate(candidate);
  const products = [];
  for (const product of candidate.products) {
    const baseline = baselines[product.id];
    if (!baseline) {
      products.push({
        product: product.id,
        deliveryStatus: 'unknown',
        reason: 'missing-completed-publication',
      });
      continue;
    }
    const origin: CompletedPublication = await assertCompletedPublication({
      product: product.id,
      ...baseline,
    });
    requireValue(
      origin.product === product.id &&
        origin.version === baseline.version &&
        origin.publicationSha === baseline.publicationSha &&
        origin.tagName === baseline.tagName &&
        fullSha.test(origin.publicationTree) &&
        fullSha.test(origin.releaseSha),
      'completed origin differs from requested product publication',
    );
    const sourceText = async (file: string) => {
      requireValue(
        !file.startsWith('/') &&
          !file.split('/').some((part) => !part || part === '.' || part === '..'),
        'unsafe historical source path',
      );
      const value = await readJson(
        `repos/${repository}/contents/${file}?ref=${origin.publicationSha}`,
      );
      requireValue(
        value.encoding === 'base64' &&
          typeof value.content === 'string' &&
          value.type === 'file' &&
          value.path === file &&
          fullSha.test(value.sha),
        `missing historical ${file}`,
      );
      const bytes = Buffer.from(value.content, 'base64');
      requireValue(
        createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') ===
          value.sha,
        `historical ${file} Git blob differs`,
      );
      return utf8.decode(bytes);
    };
    const descriptor = Bun.TOML.parse(await sourceText(`${product.path}/release.toml`)) as any;
    requireValue(descriptor.id === product.id, 'historical descriptor has a different owner');
    const sourceOnly =
      Array.isArray(descriptor.release_artifacts) &&
      descriptor.release_artifacts.length &&
      descriptor.release_artifacts.every((kind) => ['cargo-crate', 'npm-package'].includes(kind));
    if (
      !sourceOnly ||
      candidate.productArtifacts.some((artifact) => artifact.product === product.id)
    ) {
      products.push({
        product: product.id,
        origin,
        deliveryStatus: 'unknown',
        reason: 'first-native-producer-baseline-required',
      });
      continue;
    }
    const carriers = candidate.carriers.filter((carrier) => carrier.product === product.id);
    requireValue(carriers.length > 0, 'source product has no physical carriers');
    requireValue(
      stable(
        carriers
          .map(({ ecosystem, name }) => `${ecosystem === 'cargo' ? 'crates' : ecosystem}:${name}`)
          .sort(),
      ) === stable([...(descriptor.registry_packages ?? [])].sort()),
      'historical source carrier inventory differs; explicit native baseline required',
    );
    const changes = [];
    for (const current of carriers) {
      requireValue(
        ['cargo', 'npm'].includes(current.ecosystem) && current.artifacts.length === 1,
        'source product has an unsupported physical carrier',
      );
      const raw = `${current.ecosystem === 'cargo' ? 'crates' : 'npm'}:${current.name}`;
      requireValue(
        descriptor.registry_packages?.includes(raw),
        'historical descriptor does not own this carrier',
      );
      requireValue(
        current.version === product.version,
        'candidate carrier version differs from owner',
      );
      const manifestFile = `${product.path}/${current.ecosystem === 'cargo' ? 'Cargo.toml' : 'package.json'}`;
      const manifestText = await sourceText(manifestFile);
      const sourceManifest =
        current.ecosystem === 'cargo'
          ? (Bun.TOML.parse(manifestText) as any).package
          : JSON.parse(manifestText);
      requireValue(
        sourceManifest?.name === current.name && sourceManifest.version === origin.version,
        'published conventional manifest differs from completed carrier identity',
      );
      const publishedFile = baseline.archives[current.id];
      requireValue(
        typeof publishedFile === 'string',
        `missing authenticated published archive for ${current.id}`,
      );
      const published = {
        ...current,
        version: origin.version,
        artifacts: [
          {
            path: publishedFile,
            size: statSync(publishedFile).size,
            sha256: hash(readFileSync(publishedFile)),
          },
        ],
      };
      const before = sourceCarrierMembers(publishedFile, published);
      const after = sourceCarrierMembers(artifactFile(current.artifacts[0]), current);
      const registryProof = await verifyRegistryCarrierIntegrity(published, registryOptions);
      const beforeByMember = new Map(before.map((row) => [row.member, stable(row)]));
      const afterByMember = new Map(after.map((row) => [row.member, stable(row)]));
      const differentMembers = [...new Set([...beforeByMember.keys(), ...afterByMember.keys()])]
        .filter((member) => beforeByMember.get(member) !== afterByMember.get(member))
        .sort();
      changes.push({ carrier: current.id, differentMembers, registryProof });
    }
    products.push({
      product: product.id,
      origin,
      deliveryStatus: changes.some(({ differentMembers }) => differentMembers.length)
        ? 'different'
        : 'identical',
      carriers: changes,
    });
  }
  return {
    scope: 'construction' as const,
    releaseDecision: 'unverified' as const,
    source: candidate.source,
    products,
    unverified: [
      'native producer execution/cache and qualification',
      'completed native configured producer/input provenance',
    ],
  };
}

if (import.meta.main) {
  const [candidate, baselines] = process.argv.slice(2);
  requireValue(
    process.argv.length === 4,
    'usage: native-source-carrier-changes.mts candidate.json baselines.json',
  );
  console.log(
    JSON.stringify(
      await compareNativeCompletedSourceDelivery(
        JSON.parse(readFileSync(candidate, 'utf8')),
        JSON.parse(readFileSync(baselines, 'utf8')),
      ),
      null,
      2,
    ),
  );
}
