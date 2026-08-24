import { decompressIfNeeded, extractTar, layoutRuntimeSupport, loadAsset } from './archive.js';
import {
  assertRuntimeDescriptorMatchesManifest,
  assertSha256,
  parseWasixAssetManifest,
} from './extensions.js';
import type { Directory } from './host/index.mjs';
import type { SerializedRuntimeDescriptor } from './rpc.js';
import { materializeWasixSupportMounts } from './wasix-runtime.js';

export type WasixToolAsset = Readonly<{
  name: 'pg_dump' | 'psql';
  module: Uint8Array;
  sha256: string;
  size: number;
}>;

/** @internal Verify and materialize only the runtime files needed by frontend tools. */
export async function prepareWasixToolMounts(
  DirectoryConstructor: typeof Directory,
  descriptor: SerializedRuntimeDescriptor,
): Promise<Record<string, Directory>> {
  const [manifestBytes, runtimeBytes] = await Promise.all([
    loadAsset(descriptor.manifest.source, 'WASIX asset manifest'),
    loadAsset(descriptor.runtimeArchive.source, 'WASIX runtime archive'),
  ]);
  if (manifestBytes.length !== descriptor.manifest.size) {
    throw new Error('WASIX asset manifest size mismatch');
  }
  if (runtimeBytes.length !== descriptor.runtimeArchive.size) {
    throw new Error('WASIX runtime archive size mismatch');
  }
  await Promise.all([
    assertSha256(manifestBytes, descriptor.manifest.sha256, 'WASIX asset manifest'),
    assertSha256(runtimeBytes, descriptor.runtimeArchive.sha256, 'WASIX runtime archive'),
  ]);
  const manifest = parseWasixAssetManifest(manifestBytes);
  assertRuntimeDescriptorMatchesManifest(descriptor, manifest);
  const layout = layoutRuntimeSupport(extractTar(decompressIfNeeded(runtimeBytes)));
  await assertSha256(layout.module, manifest.runtime['module-sha256'], 'WASIX runtime module');
  return materializeWasixSupportMounts(DirectoryConstructor, layout);
}

export async function verifyWasixToolAsset(asset: WasixToolAsset): Promise<void> {
  if (asset.module.length !== asset.size) {
    throw new Error(`WASIX ${asset.name} module size mismatch`);
  }
  await assertSha256(asset.module, asset.sha256, `WASIX ${asset.name} module`);
}
