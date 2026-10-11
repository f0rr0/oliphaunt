import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import {
  assertSwiftSourceDeliveryParity,
  readSwiftSourceTagMembers,
} from '../../build_defs/languages/swift/source-delivery-contract.mts';
import { fixture as swiftInputs } from '../../build_defs/languages/swift/source-package.fixture.mts';
import { packageSwiftSource } from '../../build_defs/languages/swift/source-package.mts';
import { createPublishedNativeLegalSourceBasis } from '../../src/native/sdks/swift/tools/native-legal-source-basis.mts';
import { createDeterministicZip } from '../packaging/archive-directory.mts';
import { extractPortableArchiveTree } from '../packaging/portable-archive.mts';
import {
  captureCompletedSwiftSourceTag,
  currentSwiftSourceTagMembers,
} from './completed-swift-source-delivery.mts';
import { compareNativeCompletedPhysicalDelivery } from './native-completed-delivery.mts';
import { differentNativeDeliveredMembers } from './native-publication-delivery.mts';
import { buildPublicationCandidate, expectedProductArtifactRows } from './publication-lock.mts';
import { ROOT } from './release-graph.mts';

const repository = 'repos/f0rr0/oliphaunt';
const prefix = 'src/sdks/swift';
const carrierPath = `${prefix}/Carriers/oliphaunt-react-native-ios-carriers.json`;
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const gitHash = (kind, bytes) =>
  createHash('sha1').update(`${kind} ${bytes.length}\0`).update(bytes).digest('hex');
const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
const captured = JSON.parse(
  readFileSync(path.join(ROOT, 'build_defs/release/swift-0.8.2-publication-source.json'), 'utf8'),
);
const native = JSON.parse(
  readFileSync(
    path.join(ROOT, 'build_defs/release/native-0.3.3-completed-publication.json'),
    'utf8',
  ),
);
const descriptor = Bun.TOML.parse(
  git(
    'show',
    `${captured.publication.publicationSha}:src/native/sdks/swift/release.toml`,
  ).toString(),
);
const blob = (bytes, member?) => ({
  sha: gitHash('blob', bytes),
  size: bytes.length,
  encoding: 'base64',
  content: bytes.toString('base64'),
  ...(member ? { path: member, type: 'file' } : {}),
});

/** Controlled API transports retain real Git object hashes; they do not authenticate a fixture publication. */
function transport(source, contents, treeReader, blobReader, carrier) {
  const nativeId = 31;
  const swiftId = 82;
  const readJson = async (endpoint) => {
    if (endpoint === `${repository}/releases/tags/${native.tagName}`)
      return {
        id: nativeId,
        tag_name: native.tagName,
        target_commitish: native.publicationSha,
        draft: false,
        prerelease: false,
      };
    if (endpoint === `${repository}/releases/tags/${source.publication.tagName}`)
      return {
        id: swiftId,
        tag_name: source.publication.tagName,
        target_commitish: source.publication.publicationSha,
        draft: false,
        prerelease: false,
      };
    if (endpoint === `${repository}/git/ref/tags/${source.publication.version}`)
      return source.reference;
    if (endpoint === `${repository}/git/commits/${source.reference.object.sha}`)
      return source.commit;
    if (endpoint === `${repository}/contents/${carrierPath}?ref=${source.commit.sha}`)
      return contents(carrierPath);
    if (
      endpoint ===
      `${repository}/contents/src/native/sdks/swift/LIBOLIPHAUNT_VERSION?ref=${source.publication.publicationSha}`
    )
      return blob(Buffer.from(`${native.version}\n`), 'src/native/sdks/swift/LIBOLIPHAUNT_VERSION');
    if (
      endpoint ===
      `${repository}/contents/src/native/sdks/swift/release.toml?ref=${source.publication.publicationSha}`
    )
      return blob(
        Buffer.from(
          git('show', `${captured.publication.publicationSha}:src/native/sdks/swift/release.toml`),
        ),
        'src/native/sdks/swift/release.toml',
      );
    if (endpoint.startsWith(`${repository}/git/trees/`))
      return treeReader(endpoint.split('/').at(-1));
    if (endpoint.startsWith(`${repository}/git/blobs/`))
      return blobReader(endpoint.split('/').at(-1));
    throw new Error(`unexpected fixture API read: ${endpoint}`);
  };
  const readPages = async (endpoint) => {
    if (endpoint !== `${repository}/releases/${nativeId}/assets`)
      throw new Error(`unexpected asset read ${endpoint}`);
    return carrier.base.assets.map((asset, index) => ({
      id: index + 1,
      name: asset.name,
      browser_download_url: asset.url,
      digest: `sha256:${asset.sha256}`,
      size: asset.bytes,
    }));
  };
  const assertCompletedPublication = async (identity) => {
    const expected = identity.product === native.product ? native : source.publication;
    for (const key of ['product', 'version', 'tagName', 'publicationSha'])
      expect(identity[key]).toBe(expected[key]);
    return structuredClone(expected);
  };
  return { readJson, readPages, assertCompletedPublication };
}
function genuine() {
  const contents = (member) => blob(git('show', `${captured.commit.sha}:${member}`), member);
  const treeReader = (sha) => ({
    sha,
    truncated: false,
    tree: git('ls-tree', '-z', sha)
      .toString()
      .split('\0')
      .filter(Boolean)
      .map((line) => {
        const [header, name] = line.split('\t');
        const [mode, type, sha] = header.split(' ');
        return { path: name, mode, type, sha };
      }),
  });
  const options = transport(
    captured,
    contents,
    treeReader,
    (sha) => blob(git('cat-file', 'blob', sha)),
    JSON.parse(
      contents(carrierPath).content
        ? Buffer.from(contents(carrierPath).content, 'base64').toString()
        : '',
    ),
  );
  const manifest = git('show', `${captured.commit.sha}:Package.swift`).toString();
  const checksum = manifest.match(
    /name: "OliphauntNativeBindingsFFI",[\s\S]*?checksum: "([0-9a-f]{64})"/u,
  )[1];
  return {
    options,
    input: {
      publication: captured.publication,
      descriptor,
      bindings: { name: 'oliphaunt-swift-0.8.2-bindings.xcframework.zip', sha256: checksum },
    },
  };
}

test('genuine immutable Swift tag has its own commit/tree and retains the actual legacy version-file absence', async () => {
  const { input, options } = genuine();
  const result = await captureCompletedSwiftSourceTag(input, options);
  expect(result.source.commit).toBe(captured.commit.sha);
  expect(result.source.commit).not.toBe(result.publication.publicationSha);
  expect(result.source.tree).toBe(captured.commit.tree.sha);
  expect(result.members.filter(({ type }) => type === 'file')).toHaveLength(29);
  expect(result.members.some(({ path }) => path === `${prefix}/VERSION`)).toBe(false);
  expect(result.members.some(({ path }) => path.startsWith('src/native/'))).toBe(false);
  const swift = result.members.find(
    ({ path }) => path === `${prefix}/Sources/Oliphaunt/Oliphaunt.swift`,
  );
  expect(swift.sha256).toBe(hash(git('show', `${captured.commit.sha}:${swift.path}`)));
  expect(result.scope).toBe('construction');
  expect(result).not.toHaveProperty('releaseDecision');
});

test('caller mutation during immutable acquisition cannot relabel the captured publication or supplier', async () => {
  const fixture = genuine();
  const input = structuredClone(fixture.input);
  const original = fixture.options.readJson;
  const readJson = async (endpoint) => {
    if (endpoint.includes('/contents/') && endpoint.includes('LIBOLIPHAUNT_VERSION')) {
      input.publication.version = '0.8.1';
      input.descriptor.compatibility_versions['oliphaunt-swift-liboliphaunt'].path = '../outside';
      input.bindings.sha256 = 'f'.repeat(64);
    }
    return original(endpoint);
  };
  const result = await captureCompletedSwiftSourceTag(input, { ...fixture.options, readJson });
  expect(result.publication).toEqual(captured.publication);
  expect(result.source.tree).toBe(captured.commit.tree.sha);
});

for (const fault of [
  'wrong-tag',
  'wrong-parent',
  'wrong-tree',
  'missing',
  'extra',
  'duplicate',
  'mode',
  'truncated',
  'blob',
  'pin',
  'bindings',
])
  test(`immutable Swift source-tag acquisition rejects ${fault} substitution`, async () => {
    const { input, options } = genuine();
    const original = options.readJson;
    const readJson = async (endpoint) => {
      const value = structuredClone(await original(endpoint));
      if (fault === 'wrong-tag' && endpoint.includes('/git/ref/')) value.ref = 'refs/tags/0.8.1';
      if (endpoint.includes('/git/commits/')) {
        if (fault === 'wrong-parent') value.parents[0].sha = 'f'.repeat(40);
        if (fault === 'wrong-tree') value.tree.sha = 'f'.repeat(40);
      }
      if (endpoint === `${repository}/git/trees/${captured.commit.tree.sha}`) {
        if (fault === 'missing') value.tree.pop();
        if (fault === 'extra') value.tree.push({ ...value.tree[0], path: 'extra' });
        if (fault === 'duplicate') value.tree.push(value.tree[0]);
        if (fault === 'mode') value.tree.find(({ path }) => path === 'LICENSE').mode = '100755';
        if (fault === 'truncated') value.truncated = true;
      }
      if (fault === 'blob' && endpoint.includes('/git/blobs/'))
        value.content = Buffer.from('substituted').toString('base64');
      if (
        fault === 'pin' &&
        endpoint.includes('/contents/') &&
        endpoint.includes('LIBOLIPHAUNT_VERSION')
      )
        value.content = Buffer.from('0.3.2\n').toString('base64');
      return value;
    };
    if (fault === 'bindings') input.bindings.sha256 = 'f'.repeat(64);
    await expect(captureCompletedSwiftSourceTag(input, { ...options, readJson })).rejects.toThrow();
  });

function gitObjects(files) {
  const trees = new Map(),
    blobs = new Map();
  const root = {};
  for (const [member, record] of files) {
    const parts = member.split('/');
    let node = root;
    for (const name of parts.slice(0, -1)) node = node[name] ??= {};
    node[parts.at(-1)] = record;
  }
  const visit = (node) => {
    const rows = Object.entries(node)
      .map(([name, value]: [string, any]) => {
        if (value.bytes !== undefined) {
          const sha = gitHash('blob', value.bytes);
          blobs.set(sha, blob(value.bytes));
          return { path: name, type: 'blob', mode: value.mode ?? '100644', sha };
        }
        return { path: name, type: 'tree', mode: '040000', sha: visit(value) };
      })
      .sort((a, b) =>
        Buffer.compare(
          Buffer.from(a.path + (a.type === 'tree' ? '/' : '')),
          Buffer.from(b.path + (b.type === 'tree' ? '/' : '')),
        ),
      );
    const bytes = Buffer.concat(
      rows.flatMap((row) => [
        Buffer.from(`${row.mode.replace(/^0/u, '')} ${row.path}\0`),
        Buffer.from(row.sha, 'hex'),
      ]),
    );
    const sha = gitHash('tree', bytes);
    trees.set(sha, { sha, tree: rows, truncated: false });
    return sha;
  };
  return { tree: visit(root), trees, blobs };
}
async function writerFixture(run) {
  mkdirSync(path.join(ROOT, 'target'), { recursive: true });
  const directory = mkdtempSync(path.join(ROOT, 'target/completed-swift-delivery-'));
  try {
    const inputs = path.join(directory, 'inputs');
    mkdirSync(inputs);
    const spec = await swiftInputs(inputs);
    spec.version = '0.8.2';
    writeFileSync(spec.sources.VERSION, `${spec.version}\n`);
    const bindings = path.join(inputs, `oliphaunt-swift-${spec.version}-bindings.xcframework.zip`);
    copyFileSync(spec.bindingsArchive, bindings);
    spec.bindingsArchive = bindings;
    const output = path.join(directory, 'source_package');
    await packageSwiftSource(output, spec);
    const tree = path.join(output, 'release-tree');
    const files = new Map(
      readSwiftSourceTagMembers(tree)
        .filter(({ type }) => type === 'file')
        .map((row) => [
          row.path,
          {
            bytes: readFileSync(path.join(tree, row.path)),
            mode: row.mode === 0o755 ? '100755' : '100644',
          },
        ]),
    );
    const objects = gitObjects(files);
    const source = {
      ...structuredClone(captured),
      commit: { ...structuredClone(captured.commit), tree: { sha: objects.tree } },
    };
    const contents = (member) => blob(files.get(member).bytes, member);
    const options = transport(
      source,
      contents,
      (sha) => objects.trees.get(sha),
      (sha) => objects.blobs.get(sha),
      JSON.parse(readFileSync(spec.carrier, 'utf8')),
    );
    const basis = await createPublishedNativeLegalSourceBasis({
      nativeVersion: spec.nativeVersion,
      swiftVersion: spec.version,
      ...options,
    });
    const assets = path.join(directory, 'release-assets');
    mkdirSync(assets);
    copyFileSync(bindings, path.join(assets, path.basename(bindings)));
    writeFileSync(
      path.join(assets, `oliphaunt-swift-${spec.version}-release-assets.sha256`),
      `${hash(readFileSync(bindings))}  ./${path.basename(bindings)}\n`,
    );
    const candidate = () => ({
      ...buildPublicationCandidate({
        products: ['oliphaunt-swift'],
        artifactRoots: [output, assets],
        nativeSourceBasis: basis,
      }),
      scope: 'construction',
    });
    await run({
      directory,
      spec,
      tree,
      files,
      objects,
      source,
      options,
      candidate,
      input: {
        publication: source.publication,
        descriptor,
        bindings: { name: path.basename(bindings), sha256: hash(readFileSync(bindings)) },
      },
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('actual source writer and existing comparison bind the complete physical tree to the installed ZIP', async () =>
  writerFixture(async (f) => {
    const candidate = f.candidate();
    const before = await captureCompletedSwiftSourceTag(f.input, f.options);
    expect(
      differentNativeDeliveredMembers(before.members, currentSwiftSourceTagMembers(candidate)),
    ).toEqual([]);
    const product = candidate.products[0];
    const publicRows = expectedProductArtifactRows([product]).filter(
      ({ role }) => role === 'github-release-asset',
    );
    const publishedFiles = Object.fromEntries(
      publicRows.map((row) => [
        row.id,
        candidate.productArtifacts.find(({ id }) => id === row.id).path,
      ]),
    );
    const pages = async (endpoint) =>
      endpoint.endsWith('/releases/82/assets')
        ? publicRows.map((row, index) => {
            const file = candidate.productArtifacts.find(({ id }) => id === row.id);
            return {
              id: 100 + index,
              name: row.name,
              url: `https://api.github.com/repos/f0rr0/oliphaunt/releases/assets/${100 + index}`,
              state: 'uploaded',
              digest: `sha256:${file.sha256}`,
              size: file.size,
            };
          })
        : f.options.readPages(endpoint);
    const result = await compareNativeCompletedPhysicalDelivery(
      candidate,
      [{ publication: f.source.publication, carriers: {}, productArtifacts: publishedFiles }],
      { ...f.options, readPages: pages },
    );
    expect(result.products[0].unknowns).toEqual([]);
    expect(result.products[0].deliveryStatus).toBe('identical');
    expect(result.products[0].comparisons.some(({ kind }) => kind === 'swiftpm-release-tree')).toBe(
      true,
    );
    expect(result.releaseDecision).toBe('unverified');
    const sourceFile = path.join(f.tree, `${prefix}/Sources/Oliphaunt/Oliphaunt.swift`);
    let changed = false;
    const readJson = async (endpoint) => {
      if (endpoint.includes('/git/trees/') && !changed) {
        changed = true;
        writeFileSync(sourceFile, '// source changed during immutable historical API acquisition');
      }
      return f.options.readJson(endpoint);
    };
    await expect(
      compareNativeCompletedPhysicalDelivery(
        candidate,
        [{ publication: f.source.publication, carriers: {}, productArtifacts: publishedFiles }],
        { ...f.options, readPages: pages, readJson },
      ),
    ).rejects.toThrow('frozen artifact bytes');
  }));

for (const fault of ['removed', 'extra', 'changed', 'mode', 'symlink', 'version', 'supplier'])
  test(`current physical Swift tree rejects ${fault} without treating the ZIP consumer as source-tag proof`, async () =>
    writerFixture(async (f) => {
      const source = path.join(f.tree, `${prefix}/Sources/Oliphaunt/Oliphaunt.swift`);
      if (fault === 'removed') rmSync(source);
      if (fault === 'extra')
        writeFileSync(path.join(path.dirname(source), 'extra.swift'), '// extra delivered source');
      if (fault === 'changed') writeFileSync(source, '// tree-only changed source');
      if (fault === 'mode') chmodSync(source, 0o755);
      if (fault === 'symlink') {
        rmSync(source);
        symlinkSync(f.spec.generatedSwift, source);
      }
      if (fault === 'version') writeFileSync(path.join(f.tree, `${prefix}/VERSION`), '0.8.1\n');
      if (fault === 'supplier')
        writeFileSync(path.join(f.tree, `${prefix}/LIBOLIPHAUNT_VERSION`), '0.3.2\n');
      expect(() => currentSwiftSourceTagMembers(f.candidate())).toThrow();
    }));

test('matching executable ZIP/tree members still require an actual source publisher mode contract', async () =>
  writerFixture(async (f) => {
    const member = 'Sources/Oliphaunt/Oliphaunt.swift';
    const packed = path.join(f.directory, 'extracted/package');
    const archive = path.join(f.directory, 'source_package/Oliphaunt-source.zip');
    extractPortableArchiveTree(archive, packed, 'package');
    chmodSync(path.join(packed, member), 0o755);
    chmodSync(path.join(f.tree, prefix, member), 0o755);
    writeFileSync(archive, await createDeterministicZip(packed, { keepParent: true }));
    // The maintained parity contract accepts exact shared modes. The existing
    // publisher still writes Git100644, so this separate mapping stays fail closed.
    assertSwiftSourceDeliveryParity(
      archive,
      readSwiftSourceTagMembers(f.tree),
      readFileSync(path.join(f.tree, 'Package.swift')),
    );
    expect(() => currentSwiftSourceTagMembers(f.candidate())).toThrow('publisher mode contract');
  }));

test('authentic Git symlink and changed delivered members cannot be erased by source-directory guessing', async () =>
  writerFixture(async (f) => {
    const target = `${prefix}/Sources/Oliphaunt/Oliphaunt.swift`;
    f.files.set(target, { bytes: Buffer.from('authentic tree source edit\n'), mode: '100644' });
    let objects = gitObjects(f.files);
    const source = structuredClone(f.source);
    source.commit.tree.sha = objects.tree;
    const options = transport(
      source,
      (member) => blob(f.files.get(member).bytes, member),
      (sha) => objects.trees.get(sha),
      (sha) => objects.blobs.get(sha),
      JSON.parse(readFileSync(f.spec.carrier, 'utf8')),
    );
    const changed = await captureCompletedSwiftSourceTag(
      { ...f.input, publication: source.publication },
      options,
    );
    expect(
      differentNativeDeliveredMembers(changed.members, currentSwiftSourceTagMembers(f.candidate())),
    ).toEqual([target]);
    const originalSource = readFileSync(path.join(f.tree, target));
    f.files.set(target, { bytes: originalSource, mode: '100755' });
    objects = gitObjects(f.files);
    source.commit.tree.sha = objects.tree;
    const changedMode = await captureCompletedSwiftSourceTag(f.input, options);
    expect(
      differentNativeDeliveredMembers(
        changedMode.members,
        currentSwiftSourceTagMembers(f.candidate()),
      ),
    ).toEqual([target]);
    f.files.set(target, { bytes: originalSource, mode: '100644' });
    const extra = `${prefix}/Sources/Oliphaunt/retired.swift`;
    f.files.set(extra, {
      bytes: Buffer.from('actual historical delivered member\n'),
      mode: '100644',
    });
    objects = gitObjects(f.files);
    source.commit.tree.sha = objects.tree;
    const retired = await captureCompletedSwiftSourceTag(f.input, options);
    expect(
      differentNativeDeliveredMembers(retired.members, currentSwiftSourceTagMembers(f.candidate())),
    ).toEqual([extra]);
    f.files.set(target, { bytes: Buffer.from('../outside'), mode: '120000' });
    objects = gitObjects(f.files);
    source.commit.tree.sha = objects.tree;
    await expect(captureCompletedSwiftSourceTag(f.input, options)).rejects.toThrow(
      'regular member',
    );
  }));
