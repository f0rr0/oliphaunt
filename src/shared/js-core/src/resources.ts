/** An explicitly selected native extension, supplied by its package or the SDK. */
export type NativeExtensionDescriptor = Readonly<{
  schema: 'oliphaunt-native-extension-v1';
  sqlName: string;
  product: string;
  packageName: string;
  /** Contrib follows the SDK runtime version; external packages own their version. */
  version?: string;
  /** Node entry points bind resolution to the imported package, including npm aliases. */
  packageJsonUrl?: string;
}>;

export type NativeIcuDescriptor = Readonly<{
  schema: 'oliphaunt-native-icu-v1';
  packageName: '@oliphaunt/icu';
  version: string;
  packageJsonUrl?: string;
}>;

const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export function snapshotNativeExtensions(
  values: readonly NativeExtensionDescriptor[],
): NativeExtensionDescriptor[] {
  if (!Array.isArray(values)) {
    throw new TypeError('extensions must be an array of imported extension descriptors');
  }
  const selected = new Map<string, NativeExtensionDescriptor>();
  for (const value of values) {
    if (
      value === null ||
      typeof value !== 'object' ||
      value.schema !== 'oliphaunt-native-extension-v1' ||
      typeof value.sqlName !== 'string' ||
      !/^[a-z0-9][a-z0-9_-]*$/.test(value.sqlName) ||
      typeof value.product !== 'string' ||
      !/^oliphaunt-extension-[a-z0-9-]+$/.test(value.product) ||
      value.packageName !== `@oliphaunt/${value.product.slice('oliphaunt-'.length)}`
    ) {
      throw new TypeError('extensions must contain imported native extension descriptors');
    }
    if (value.product !== 'oliphaunt-extension-contrib-pg18' || value.version !== undefined) {
      requireVersion(value.version);
    }
    requirePackageUrl(value.packageJsonUrl);
    const copy = Object.freeze({
      schema: value.schema,
      sqlName: value.sqlName,
      product: value.product,
      packageName: value.packageName,
      ...(value.version === undefined ? {} : { version: value.version }),
      ...(value.packageJsonUrl === undefined ? {} : { packageJsonUrl: value.packageJsonUrl }),
    });
    const previous = selected.get(copy.sqlName);
    if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(copy)) {
      throw new TypeError(`conflicting extension descriptors for '${copy.sqlName}'`);
    }
    selected.set(copy.sqlName, copy);
  }
  return [...selected.values()];
}

export function snapshotNativeIcu(
  value: NativeIcuDescriptor | undefined,
): NativeIcuDescriptor | undefined {
  if (value === undefined) return undefined;
  if (
    value === null ||
    typeof value !== 'object' ||
    value.schema !== 'oliphaunt-native-icu-v1' ||
    value.packageName !== '@oliphaunt/icu'
  ) {
    throw new TypeError('icu must be an imported native ICU descriptor');
  }
  requireVersion(value.version);
  requirePackageUrl(value.packageJsonUrl);
  return Object.freeze({
    schema: value.schema,
    packageName: value.packageName,
    version: value.version,
    ...(value.packageJsonUrl === undefined ? {} : { packageJsonUrl: value.packageJsonUrl }),
  });
}

function requireVersion(value: unknown): void {
  if (typeof value !== 'string' || !versionPattern.test(value)) {
    throw new TypeError('resource descriptor must declare its package version');
  }
}

function requirePackageUrl(value: unknown): void {
  if (value === undefined) return;
  if (typeof value !== 'string' || !value.startsWith('file:') || value.includes('\0')) {
    throw new TypeError('resource package location must be a local file URL');
  }
  const url = new URL(value);
  if (
    url.protocol !== 'file:' ||
    url.search ||
    url.hash ||
    !url.pathname.endsWith('/package.json')
  ) {
    throw new TypeError('resource package location must identify a package.json file');
  }
}
