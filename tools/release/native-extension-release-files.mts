/** Rebase frozen extension documents through their declared original public Files. */
import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { readPortableArchiveEntries } from '../packaging/portable-archive.mts';
import { fileIdentity, safeRelative } from './native-file-identity.mts';

type Asset = {
  name: string;
  path: string;
  sha256: string;
  bytes: number;
  carrierAsset?: string;
  carrierRoot?: string;
  memberPath?: string;
  [key: string]: any;
};
type Member = { sqlName: string; assets: Asset[]; [key: string]: any };
type Frozen = {
  extensions?: Member[];
  carrierAssets?: Asset[];
  assets?: Asset[];
  [key: string]: any;
};

export function extensionReleaseDocumentRows(frozen: Frozen) {
  const members: Member[] = frozen.extensions ?? [frozen as Member];
  const directAssets: Asset[] = frozen.carrierAssets ?? members[0]?.assets;
  assert.ok(Array.isArray(members) && members.length > 0, 'extension manifest lacks members');
  assert.ok(
    Array.isArray(directAssets) && directAssets.length > 0,
    'extension manifest lacks direct assets',
  );
  return { members, directAssets };
}

/** Path fields are private locators, never permission to read an ambient producer path.
 * Public archives stay byte exact; a bundle's original nested archives are copied out. */
export function stageDeclaredExtensionReleaseFiles(
  frozen: Frozen,
  files: readonly string[],
  productRoot: string,
  root: string,
  copy: (source: string, destination: string) => { size: number; sha256: string } = fileIdentity,
) {
  const { members, directAssets: assets } = extensionReleaseDocumentRows(frozen);
  const physical = new Map(files.map((file) => [path.basename(file), realpathSync(file)]));
  assert.equal(physical.size, files.length, 'repeated imported GitHub File');
  const relative = (file: string) => path.relative(root, file).split(path.sep).join('/');
  const directAssets = assets.map((asset) => {
    const source = physical.get(asset.name);
    assert(source, 'extension asset lacks its declared original GitHub File');
    const destination = path.join(productRoot, 'release-assets', safeRelative(asset.name));
    mkdirSync(path.dirname(destination), { recursive: true });
    const expected = { size: asset.bytes, sha256: asset.sha256 };
    const identity = copy(source, destination);
    assert.deepEqual(
      { size: identity.size, sha256: identity.sha256 },
      expected,
      'declared extension asset bytes differ',
    );
    return { ...asset, path: relative(destination) };
  });
  const bundles = new Map<string, ReturnType<typeof readPortableArchiveEntries>>();
  const staged = members.map((member) => ({
    ...member,
    assets: member.assets.map((asset) => {
      if (!asset.carrierAsset) {
        const direct = directAssets.find((row) => row.name === asset.name);
        assert(direct, 'extension member lacks its declared direct asset');
        assert.equal(direct.sha256, asset.sha256, 'extension direct member digest differs');
        assert.equal(direct.bytes, asset.bytes, 'extension direct member size differs');
        return { ...asset, path: direct.path };
      }
      const outer = physical.get(asset.carrierAsset);
      assert(outer, 'nested member lacks its actual closed bundle File');
      if (!bundles.has(outer)) bundles.set(outer, readPortableArchiveEntries(outer));
      const entry = `${safeRelative(asset.carrierRoot!)}/${safeRelative(asset.memberPath!)}`;
      const bytes = bundles.get(outer)!.get(entry)?.data();
      assert(bytes, 'nested member is absent from the original closed bundle');
      const destination = path.join(
        productRoot,
        'member-assets',
        safeRelative(member.sqlName),
        safeRelative(asset.name),
      );
      mkdirSync(path.dirname(destination), { recursive: true });
      writeFileSync(destination, bytes);
      const identity = fileIdentity(destination);
      assert.equal(identity.sha256, asset.sha256, 'nested extension member digest differs');
      assert.equal(identity.size, asset.bytes, 'nested extension member size differs');
      return { ...asset, path: relative(destination) };
    }),
  }));
  const manifest = frozen.extensions
    ? {
        ...frozen,
        extensions: staged,
        ...(frozen.carrierAssets ? { carrierAssets: directAssets } : {}),
      }
    : { ...frozen, assets: staged[0].assets };
  return { manifest, members: staged, directAssets, productRoot };
}
