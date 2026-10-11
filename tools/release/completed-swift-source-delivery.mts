/** The published Swift source tag is a delivered envelope, never an old Bazel graph. */
import { deepStrictEqual } from 'node:assert';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  assertSwiftSourceDeliveryParity,
  readSwiftSourceTagMembers,
} from '../../build_defs/languages/swift/source-delivery-contract.mts';
import {
  createPublishedNativeLegalSourceBasis,
  publishedNativeBaseForSource,
} from '../../src/native/sdks/swift/tools/native-legal-source-basis.mts';
import {
  IOS_CARRIER_FILENAME,
  validateFrozenNativeCarrierIdentity,
} from '../../src/native/sdks/swift/tools/swift-native-carrier-contract.mts';
import { renderSwiftReleaseManifest } from '../../src/native/sdks/swift/tools/swift-release-manifest.mts';
import {
  type CompletedPublication,
  createCompletedPublicationChecker,
} from './completed-release-publication.mts';
import { requestGithubPages, requestGithubRepositoryJson } from './github-read.mts';
import { fileIdentity, safeRelative } from './native-file-identity.mts';
import { lockedPublicationFiles } from './publication-lock.mts';

const repository = 'f0rr0/oliphaunt';
const prefix = 'src/sdks/swift';
const carrierMember = `${prefix}/Carriers/${IOS_CARRIER_FILENAME}`;
const sha40 = /^[0-9a-f]{40}$/u;
const stableVersion = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;
const text = (bytes: Uint8Array) =>
  new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
const gitSha = (kind: string, bytes: Uint8Array) =>
  createHash('sha1').update(`${kind} ${bytes.length}\0`).update(bytes).digest('hex');
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function requireValue(value: unknown, message: string) {
  if (!value) throw new Error(`completed Swift source delivery: ${message}`);
}

/** Canonical Git objects prove complete membership without reading the unrelated repository tree. */
export async function captureCompletedSwiftSourceTag(
  {
    publication,
    descriptor,
    bindings,
  }: {
    publication: CompletedPublication;
    descriptor: any;
    /** Already authenticated through the completed public-asset reader. */
    bindings: { name: string; sha256: string };
  },
  {
    assertCompletedPublication = createCompletedPublicationChecker({ repository }),
    readJson = requestGithubRepositoryJson,
    readPages = requestGithubPages,
  } = {},
) {
  publication = structuredClone(publication);
  descriptor = structuredClone(descriptor);
  bindings = structuredClone(bindings);
  requireValue(
    publication.product === 'oliphaunt-swift' && descriptor.id === publication.product,
    'source publisher owner differs',
  );
  deepStrictEqual(await assertCompletedPublication(publication), publication);
  const reads = new Map<string, Promise<any>>();
  const read = (endpoint: string) => {
    let result = reads.get(endpoint);
    if (!result) {
      result = Promise.resolve(readJson(endpoint)).then((value) => structuredClone(value));
      reads.set(endpoint, result);
    }
    return result;
  };
  const pins = Object.values(descriptor.compatibility_versions ?? {}).filter(
    (row: any) => row.source_product === 'liboliphaunt-native',
  ) as any[];
  requireValue(pins.length === 1 && pins[0].parser === 'raw', 'native supplier needs one raw pin');
  const pinPath = safeRelative(pins[0].path);
  const pin = await read(
    `repos/${repository}/contents/${pinPath}?ref=${publication.publicationSha}`,
  );
  requireValue(
    pin.type === 'file' &&
      pin.path === pinPath &&
      pin.encoding === 'base64' &&
      typeof pin.content === 'string' &&
      sha40.test(pin.sha),
    'completed native supplier pin is missing',
  );
  const pinBytes = Buffer.from(pin.content, 'base64');
  requireValue(gitSha('blob', pinBytes) === pin.sha, 'native supplier pin blob differs');
  const nativeVersion = text(pinBytes).trim();
  requireValue(stableVersion.test(nativeVersion), 'native supplier pin is not exact');
  const basis = await createPublishedNativeLegalSourceBasis({
    nativeVersion,
    swiftVersion: publication.version,
    readJson: read,
    readPages,
    assertCompletedPublication,
  });
  deepStrictEqual(basis.sourcePublication, publication);
  const base = publishedNativeBaseForSource(basis);
  const baseArchive = base.assets.find(({ role }) => role === 'base-xcframework');
  requireValue(
    bindings.name === `oliphaunt-swift-${publication.version}-bindings.xcframework.zip` &&
      /^[0-9a-f]{64}$/u.test(bindings.sha256),
    'owned bindings archive differs from the completed owner',
  );
  const manifest = Buffer.from(
    renderSwiftReleaseManifest(
      baseArchive.url.slice(0, baseArchive.url.lastIndexOf('/')),
      nativeVersion,
      baseArchive.sha256,
      `https://github.com/${repository}/releases/download/${publication.tagName}/${bindings.name}`,
      bindings.sha256,
    ),
  );
  const trees = new Map<string, Promise<any[]>>();
  const tree = (sha: string): Promise<any[]> => {
    let result = trees.get(sha);
    if (!result) {
      result = (async () => {
        const value = await read(`repos/${repository}/git/trees/${sha}`);
        requireValue(
          value.sha === sha && value.truncated !== true && Array.isArray(value.tree),
          'Git tree is missing or truncated',
        );
        const names = new Set<string>();
        for (const row of value.tree) {
          safeRelative(row.path);
          requireValue(
            !row.path.includes('/') && !names.has(row.path) && sha40.test(row.sha),
            'Git tree member is unsafe or duplicated',
          );
          names.add(row.path);
          requireValue(
            (row.type === 'tree' && row.mode === '040000') ||
              (row.type === 'blob' && ['100644', '100755', '120000'].includes(row.mode)) ||
              (row.type === 'commit' && row.mode === '160000'),
            'Git tree member type/mode differs',
          );
        }
        const sorted = [...value.tree].sort((left, right) =>
          Buffer.compare(
            Buffer.from(left.path + (left.type === 'tree' ? '/' : '')),
            Buffer.from(right.path + (right.type === 'tree' ? '/' : '')),
          ),
        );
        const bytes = Buffer.concat(
          sorted.flatMap((row) => [
            Buffer.from(`${row.mode.replace(/^0/u, '')} ${row.path}\0`),
            Buffer.from(row.sha, 'hex'),
          ]),
        );
        requireValue(
          gitSha('tree', bytes) === sha,
          'Git tree bytes differ from their immutable object',
        );
        return value.tree;
      })();
      trees.set(sha, result);
    }
    return result;
  };
  const members: any[] = [{ path: '', type: 'directory', mode: 0o755 }];
  const bytesByPath = new Map<string, Buffer>();
  let bytesRead = 0;
  const file = async (row, member: string) => {
    requireValue(
      row.type === 'blob' && ['100644', '100755'].includes(row.mode),
      `source tag requires a regular member: ${member}`,
    );
    const value = await read(`repos/${repository}/git/blobs/${row.sha}`);
    requireValue(
      value.sha === row.sha && value.encoding === 'base64' && typeof value.content === 'string',
      'Git blob identity differs',
    );
    const bytes = Buffer.from(value.content, 'base64');
    bytesRead += bytes.length;
    requireValue(
      bytes.length === value.size &&
        bytes.length <= 16 * 1024 * 1024 &&
        bytesRead <= 64 * 1024 * 1024 &&
        gitSha('blob', bytes) === row.sha,
      'Git blob bytes or size differ',
    );
    bytesByPath.set(member, bytes);
    members.push({
      path: member,
      type: 'file',
      mode: Number.parseInt(row.mode, 8) & 0o777,
      size: bytes.length,
      sha256: digest(bytes),
    });
  };
  const walk = async (sha: string, parent: string) => {
    for (const row of await tree(sha)) {
      requireValue(row.path !== '.git', 'source tag cannot contain Git internals');
      const member = `${parent}/${row.path}`;
      requireValue(members.length < 10000, 'source tag member limit exceeded');
      if (row.type === 'tree') {
        members.push({ path: member, type: 'directory', mode: 0o755 });
        await walk(row.sha, member);
      } else await file(row, member);
    }
  };
  const root = await tree(basis.source.tree);
  for (const name of ['Package.swift', 'LICENSE', 'THIRD_PARTY_NOTICES.md']) {
    const row = root.find(({ path }) => path === name);
    requireValue(row, `source tag lacks ${name}`);
    await file(row, name);
  }
  let ancestor = root;
  let parent = '';
  for (const name of prefix.split('/')) {
    const row = ancestor.find(({ path }) => path === name);
    requireValue(row?.type === 'tree' && row.mode === '040000', `source tag lacks ${prefix}`);
    parent = parent ? `${parent}/${name}` : name;
    members.push({ path: parent, type: 'directory', mode: 0o755 });
    ancestor = await tree(row.sha);
  }
  for (const required of ['Sources', 'Templates', 'Carriers'])
    requireValue(
      ancestor.some(({ path, type }) => path === required && type === 'tree'),
      `source tag lacks ${required}`,
    );
  // Reuse the already validated direct SDK rows without inventing any missing legacy version files.
  for (const row of ancestor) {
    const member = `${prefix}/${row.path}`;
    requireValue(row.path !== '.git', 'source tag cannot contain Git internals');
    if (row.type === 'tree') {
      members.push({ path: member, type: 'directory', mode: 0o755 });
      await walk(row.sha, member);
    } else await file(row, member);
  }
  requireValue(
    bytesByPath.get('Package.swift')?.equals(manifest),
    'source tag manifest differs from completed supplier/bindings contracts',
  );
  requireValue(
    gitSha('blob', bytesByPath.get(carrierMember) ?? Buffer.alloc(0)) === basis.source.blob,
    'source tag carrier differs from the authenticated supplier',
  );
  for (const [name, version] of [
    ['VERSION', publication.version],
    ['LIBOLIPHAUNT_VERSION', nativeVersion],
  ]) {
    const bytes = bytesByPath.get(`${prefix}/${name}`);
    if (bytes) requireValue(text(bytes).trim() === version, `source tag ${name} differs`);
  }
  return {
    scope: 'construction' as const,
    publication,
    source: basis.source,
    nativePublication: basis.publication,
    members: members.sort((a, b) => a.path.localeCompare(b.path)),
  };
}

/** Current physical files remain bound to the existing candidate and installed ZIP parity. */
export function currentSwiftSourceTagMembers(candidate: any) {
  const product = candidate.products.find(({ id }) => id === 'oliphaunt-swift');
  requireValue(product, 'candidate source publisher is missing');
  const artifacts = candidate.productArtifacts.filter(({ product: id }) => id === product.id);
  const select = (kind: string) => {
    const matches = artifacts.filter((row) => row.kind === kind);
    requireValue(matches.length === 1, `candidate needs exactly one ${kind}`);
    return matches[0];
  };
  const tree = select('swiftpm-release-tree');
  const archive = select('swiftpm-source-archive');
  const separateManifest = select('swiftpm-release-manifest');
  const carrier = select('swiftpm-ios-carrier-manifest');
  const bindings = select('swift-bindings');
  const root = path.resolve(import.meta.dir, '../..');
  const absolute = (row) => path.resolve(root, safeRelative(row.path));
  requireValue(
    lstatSync(absolute(tree)).isDirectory() && !lstatSync(absolute(tree)).isSymbolicLink(),
    'candidate source tag must be a regular directory',
  );
  const envelope = { products: [product], carriers: [], productArtifacts: artifacts };
  const before = lockedPublicationFiles(envelope);
  const members = readSwiftSourceTagMembers(absolute(tree));
  // The existing publisher overlays generated files as Git100644. A future
  // executable source needs a matching publisher contract, not raw-mode inference.
  requireValue(
    members.every((member) => member.type !== 'file' || member.mode === 0o644),
    'candidate executable source-tag member has no matching publisher mode contract',
  );
  const orderedFiles = (rows) => rows.sort((left, right) => left.path.localeCompare(right.path));
  deepStrictEqual(
    orderedFiles(
      members
        .filter((member) => member.type === 'file')
        .map(({ path, size, sha256 }) => ({ path, size, sha256 })),
    ),
    orderedFiles(
      before
        .filter(({ path: name }) => name.startsWith(`${tree.path}/`))
        .map(({ path: name, size, sha256 }) => ({
          path: name.slice(tree.path.length + 1),
          size,
          sha256,
        })),
    ),
    'candidate source tag members exceed its frozen physical file inventory',
  );
  const read = (name) => readFileSync(path.join(absolute(tree), name));
  requireValue(
    text(read(`${prefix}/VERSION`)).trim() === product.version,
    'candidate VERSION differs',
  );
  const nativeVersion = text(read(`${prefix}/LIBOLIPHAUNT_VERSION`)).trim();
  const value = validateFrozenNativeCarrierIdentity({
    carrier: JSON.parse(text(read(carrierMember))),
    expectedNativeVersion: nativeVersion,
  });
  requireValue(
    path.resolve(absolute(carrier)) === path.join(absolute(tree), carrierMember),
    'candidate carrier does not belong to its source tag',
  );
  const asset = value.base.assets.find(({ role }) => role === 'base-xcframework');
  const manifest = Buffer.from(
    renderSwiftReleaseManifest(
      asset.url.slice(0, asset.url.lastIndexOf('/')),
      nativeVersion,
      asset.sha256,
      `https://github.com/${repository}/releases/download/oliphaunt-swift-v${product.version}/${bindings.name}`,
      fileIdentity(absolute(bindings)).sha256,
    ),
  );
  requireValue(
    read('Package.swift').equals(manifest) &&
      readFileSync(absolute(separateManifest)).equals(manifest),
    'candidate source manifest differs from its supplier/bindings contracts',
  );
  assertSwiftSourceDeliveryParity(absolute(archive), members, manifest);
  deepStrictEqual(
    readSwiftSourceTagMembers(absolute(tree)),
    members,
    'candidate source tag changed during comparison',
  );
  deepStrictEqual(
    lockedPublicationFiles(envelope),
    before,
    'candidate source files changed during comparison',
  );
  // The publisher records Git file modes, not filesystem directory modes.
  // Keep every regular-file mode exact; both trees use the installed directory contract.
  return members.map((member) =>
    member.type === 'directory' ? { ...member, mode: 0o755 } : member,
  );
}
