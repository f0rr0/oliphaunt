export const EXTENSION_VERSIONING_BY_CLASS = {
  contrib: 'runtime-bound',
  external: 'upstream-bound',
  'first-party': 'repo-bound',
};

/** Stable ownership only; dependency lists and versions come from delivered members. */
export type ExtensionOwnerMetadata = Record<
  string,
  {
    product: string;
    versioning: 'runtime-bound' | 'upstream-bound' | 'repo-bound';
    native: string;
    wasix: string;
  }
>;

export function declaredExtensionOwner(
  sqlName: string,
  family: 'native' | 'wasix',
  owners: ExtensionOwnerMetadata,
) {
  const owner = owners?.[sqlName];
  if (!owner || !Object.values(EXTENSION_VERSIONING_BY_CLASS).includes(owner.versioning))
    throw new Error(`extension SQL name ${sqlName} has no declared release owner`);
  return {
    product: string(owner.product, `${sqlName} artifact product`),
    releaseProduct: string(owner[family], `${sqlName} ${family} release owner`),
    versioning: owner.versioning,
  };
}

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

export function extensionManifestMembers(manifest) {
  if (manifest?.schema === 'oliphaunt-extension-ci-artifacts-v1') {
    return typeof manifest.sqlName === 'string' && manifest.sqlName ? [manifest] : [];
  }
  if (manifest?.schema === 'oliphaunt-extension-ci-artifacts-v2') {
    return Array.isArray(manifest.extensions) ? manifest.extensions : [];
  }
  return [];
}

/** Project frozen member requirements onto conventional package owners. */
export function frozenExtensionOwnerRequirements({
  product,
  releaseProduct,
  members,
  runtimeProduct,
  runtimeVersion,
  ownerForSqlName,
}) {
  const provided = new Set(members.map((member) => member.sqlName));
  const requirements = new Map();
  for (const member of members) {
    if (!Array.isArray(member.dependencies))
      throw new Error(`${product} ${member.sqlName} must declare frozen dependencies`);
    for (const sqlName of member.dependencies) {
      // PostgreSQL supplies this language without an extension carrier.
      if (sqlName === 'plpgsql' || provided.has(sqlName)) continue;
      const owner = ownerForSqlName(sqlName);
      if (owner.releaseProduct === releaseProduct) continue;
      if (owner.releaseProduct !== runtimeProduct || owner.versioning !== 'runtime-bound')
        throw new Error(
          `${product} dependency ${sqlName} requires an explicit frozen version for independent release owner ${owner.releaseProduct}`,
        );
      const requirement = {
        product: string(owner.product, `${product} dependency ${sqlName} product`),
        version: string(runtimeVersion, `${product} frozen runtime version`),
      };
      const previous = requirements.get(owner.releaseProduct);
      if (previous && previous.product !== requirement.product)
        throw new Error(
          `${product} dependency owner ${owner.releaseProduct} maps to multiple carriers`,
        );
      requirements.set(owner.releaseProduct, requirement);
    }
  }
  return [...requirements.values()].sort((left, right) =>
    left.product < right.product ? -1 : left.product > right.product ? 1 : 0,
  );
}
