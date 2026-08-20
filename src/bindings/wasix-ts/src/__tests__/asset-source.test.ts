import { describe, expect, it, vi } from 'vitest';

import { installPackageAssetReader, readPackageAsset } from '../asset-source.js';

describe('WASIX package asset reader', () => {
  it('accepts only file URLs after the active host installs one reader', async () => {
    await expect(readPackageAsset('file:///runtime.tar.zst', 'runtime archive')).rejects.toThrow(
      'cannot read package-relative runtime archive URL',
    );

    const reader = vi.fn(async (source: URL) => new TextEncoder().encode(source.pathname));
    installPackageAssetReader(reader);
    await expect(readPackageAsset('file:///runtime.tar.zst', 'runtime archive')).resolves.toEqual(
      new TextEncoder().encode('/runtime.tar.zst'),
    );
    expect(reader).toHaveBeenCalledOnce();
    await expect(
      readPackageAsset('https://example.test/runtime', 'runtime archive'),
    ).rejects.toThrow('cannot read package-relative runtime archive URL');
    expect(() => installPackageAssetReader(reader)).toThrow('already installed');
  });
});
