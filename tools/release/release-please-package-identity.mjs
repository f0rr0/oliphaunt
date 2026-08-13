const NODE_RELEASE_TYPES = new Set(['expo', 'node']);

/**
 * Release Please's package-name is the public registry identity for Node
 * products, so it must not drift from the package manifest it versions.
 */
export function assertReleasePleasePackageIdentity(packagePath, packageConfig, packageManifest) {
  if (!NODE_RELEASE_TYPES.has(packageConfig['release-type'])) {
    return;
  }

  const configuredName = packageConfig['package-name'];
  if (typeof configuredName !== 'string' || configuredName.length === 0) {
    throw new Error(`${packagePath}.package-name must be a non-empty string for a Node product`);
  }

  const manifestName = packageManifest.name;
  if (typeof manifestName !== 'string' || manifestName.length === 0) {
    throw new Error(`${packagePath}/package.json must declare a non-empty name`);
  }
  if (configuredName !== manifestName) {
    throw new Error(
      `${packagePath}.package-name ${JSON.stringify(configuredName)} must match `
        + `${packagePath}/package.json name ${JSON.stringify(manifestName)}`,
    );
  }
}
