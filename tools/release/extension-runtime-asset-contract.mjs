const EXTENSION_RUNTIME_ASSET_CONTRACT_FIELDS = Object.freeze([
  "name",
  "family",
  "target",
  "kind",
  "identity",
  "sha256",
  "bytes",
  "carrierAsset",
  "carrierRoot",
  "memberPath",
  "memberCount",
]);

export function extensionRuntimeAssetContract(asset) {
  const result = {};
  for (const key of EXTENSION_RUNTIME_ASSET_CONTRACT_FIELDS) {
    if (Object.hasOwn(asset, key)) result[key] = asset[key];
  }
  return result;
}
