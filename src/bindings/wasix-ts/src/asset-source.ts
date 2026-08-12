export type PackageAssetReader = (source: URL) => Promise<Uint8Array>;

let packageAssetReader: PackageAssetReader | undefined;

/** @internal Installed only by the Node worker for package-relative file URLs. */
export function installPackageAssetReader(reader: PackageAssetReader): void {
  if (packageAssetReader !== undefined) {
    throw new Error('Oliphaunt WASIX package asset reader is already installed');
  }
  packageAssetReader = reader;
}

export async function readPackageAsset(source: string, label: string): Promise<Uint8Array> {
  const url = new URL(source);
  if (url.protocol !== 'file:' || packageAssetReader === undefined) {
    throw new Error(`cannot read package-relative ${label} URL ${JSON.stringify(source)}`);
  }
  return packageAssetReader(url);
}
