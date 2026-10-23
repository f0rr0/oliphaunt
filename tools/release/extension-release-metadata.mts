export const EXTENSION_VERSIONING_BY_CLASS = {
  contrib: 'runtime-bound',
  external: 'upstream-bound',
  'first-party': 'repo-bound',
};

function string(value, context) {
  if (typeof value !== 'string' || !value) throw new Error(`${context} must be a nonempty string`);
  return value;
}

export function extensionNpmPackageForProduct(product) {
  if (typeof product !== 'string' || !product.startsWith('oliphaunt-extension-'))
    throw new TypeError(
      `extension product must start with oliphaunt-extension-: ${JSON.stringify(product)}`,
    );
  return `@oliphaunt/${product.slice('oliphaunt-'.length)}`;
}

export function extensionCompatibilityMetadata(compatibility) {
  return Object.fromEntries(
    [
      ['postgresMajor', 'postgres_major'],
      ['extensionRuntimeContract', 'extension_runtime_contract'],
      ['nativeRuntimeProduct', 'native_runtime_product'],
      ['nativeRuntimeVersion', 'native_runtime_version'],
      ['wasixRuntimeProduct', 'wasix_runtime_product'],
      ['wasixRuntimeVersion', 'wasix_runtime_version'],
    ].map(([key, authored]) => [
      key,
      string(compatibility?.[authored], `extension.compatibility.${authored}`),
    ]),
  );
}

export function declaredExtensionMetadata(product, extension) {
  const sqlName = string(extension.sql_name, `${product}.extension.sql_name`);
  if (EXTENSION_VERSIONING_BY_CLASS[extension.class] !== extension.versioning)
    throw new Error(`${product} has inconsistent extension class/versioning`);
  return {
    sqlName,
    sqlNames: [sqlName],
    artifactProduct: product,
    class: extension.class,
    versioning: extension.versioning,
    sourcePath: string(extension.source?.path, `${product}.extension.source.path`),
    compatibility: extensionCompatibilityMetadata(extension.compatibility),
  };
}

export function contribExtensionMetadata({ artifactProduct, sourcePath, sqlNames, compatibility }) {
  return {
    sqlName: undefined,
    sqlNames,
    class: 'contrib',
    versioning: 'runtime-bound',
    sourcePath,
    artifactProduct,
    compatibility,
  };
}

export function extensionSourceMetadata(product, metadata, source, version = undefined) {
  if (metadata.class === 'contrib')
    return {
      kind: 'postgres-contrib',
      name: 'postgresql',
      ...Object.fromEntries(
        ['version', 'url', 'sha256'].map((key) => [
          key,
          string(source.postgresql?.[key], `${metadata.sourcePath}.postgresql.${key}`),
        ]),
      ),
    };
  if (metadata.class === 'external')
    return {
      kind: 'external',
      ...Object.fromEntries(
        ['name', 'url', 'branch', 'commit'].map((key) => [
          key,
          string(source[key], `${metadata.sourcePath}.${key}`),
        ]),
      ),
    };
  if (metadata.class === 'first-party')
    return {
      kind: 'repo',
      name: metadata.sqlName ?? product,
      path: metadata.sourcePath,
      version: string(version, `${product} release version`),
    };
  throw new Error(`${product} has unsupported extension source class ${metadata.class}`);
}

export function extensionPublicationMetadataRows(product, metadata, sourceIdentity, memberPath) {
  return metadata.sqlNames.map((sqlName) => ({
    product,
    cargoPackage: product,
    npmPackage: extensionNpmPackageForProduct(product),
    mavenGroup: 'dev.oliphaunt.extensions',
    mavenArtifact: product,
    ...metadata,
    sqlName,
    memberPath: memberPath(sqlName),
    sourceIdentity,
  }));
}
