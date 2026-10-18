export type PackageAssetReader = (
  source: URL,
  options?: { signal?: AbortSignal },
) => Promise<Uint8Array>;

let packageAssetReader: PackageAssetReader | undefined;

/** @internal Installed by the active Node host realm for package-relative file URLs. */
export function installPackageAssetReader(reader: PackageAssetReader): void {
  if (packageAssetReader !== undefined) {
    throw new Error('Oliphaunt WASIX package asset reader is already installed');
  }
  packageAssetReader = reader;
}

export async function readPackageAsset(
  source: string,
  label: string,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  signal?.throwIfAborted();
  const url = new URL(source);
  if (url.protocol !== 'file:' || packageAssetReader === undefined) {
    throw new Error(`cannot read package-relative ${label} URL ${JSON.stringify(source)}`);
  }
  return signal === undefined ? packageAssetReader(url) : packageAssetReader(url, { signal });
}
