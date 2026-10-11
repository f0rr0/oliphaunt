const EXTENSION_RUNTIME_ASSET_CONTRACT_FIELDS = Object.freeze([
  'name',
  'family',
  'target',
  'kind',
  'identity',
  'sha256',
  'bytes',
  'carrierAsset',
  'carrierRoot',
  'memberPath',
  'memberCount',
  'nativeDependencyModules',
  'nativeConstructionLicenseFiles',
]);

export function extensionRuntimeAssetContract(asset) {
  const result = {};
  for (const key of EXTENSION_RUNTIME_ASSET_CONTRACT_FIELDS) {
    if (Object.hasOwn(asset, key)) result[key] = asset[key];
  }
  return result;
}

/** Select the existing member inventory for one actual native runtime asset.
 * Old manifests retain their member-global defaults. New joined manifests bind
 * construction receipts and required modules to the asset that carries them.
 */
export function projectNativeRuntimeAssetMember(member, asset) {
  const result = { ...member };
  for (const field of ['nativeDependencyModules', 'nativeConstructionLicenseFiles']) {
    if (!Object.hasOwn(asset, field)) continue;
    if (asset.family !== 'native' || asset.kind !== 'runtime') {
      throw new Error(`${field} is only valid on a native runtime asset`);
    }
    if (!Array.isArray(asset[field])) throw new Error(`${field} must be an array`);
    if (asset[field].length === 0) delete result[field];
    else result[field] = asset[field];
  }
  return result;
}

/** Exact public member roles from the canonical target profiles and built iOS facts. */
export function expectedExtensionRoles(member, targets) {
  const roles = [];
  const nativeStem =
    typeof member.nativeModuleStem === 'string' && member.nativeModuleStem
      ? member.nativeModuleStem
      : null;
  for (const target of [...targets].sort()) {
    if (target === 'wasix-portable') {
      roles.push(`wasix:${target}:wasix-runtime:`);
      continue;
    }
    roles.push(`native:${target}:runtime:`);
    if (target === 'ios-xcframework' && nativeStem !== null) {
      roles.push(`native:${target}:ios-xcframework:${nativeStem}`);
      for (const dependency of member.iosNativeDependencies) {
        roles.push(`native:${target}:ios-dependency-xcframework:${dependency}`);
      }
    }
  }
  return roles.sort();
}
