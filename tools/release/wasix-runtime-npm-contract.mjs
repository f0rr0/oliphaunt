export const WASIX_RUNTIME_PRODUCT = "liboliphaunt-wasix";
export const WASIX_RUNTIME_NPM_PACKAGE = "@oliphaunt/liboliphaunt-wasix";
export const WASIX_RUNTIME_NPM_DESCRIPTOR_SCHEMA = "oliphaunt-wasix-runtime-v2";
export const WASIX_RUNTIME_NPM_TARGET = "portable";

export const WASIX_RUNTIME_ARCHIVE_PATH = "oliphaunt.wasix.tar.zst";
export const WASIX_STANDARD_SEED_ARCHIVE_PATH = "cluster-seeds/standard.tar.zst";
export const WASIX_STANDARD_SEED_MANIFEST_PATH = "cluster-seeds/standard.json";

const RELEASE_ASSET_ROOT = "target/oliphaunt-wasix/assets";

export const WASIX_PORTABLE_RELEASE_MEMBERS = Object.freeze({
  runtimeArchive: `${RELEASE_ASSET_ROOT}/${WASIX_RUNTIME_ARCHIVE_PATH}`,
  standardSeedArchive: `${RELEASE_ASSET_ROOT}/${WASIX_STANDARD_SEED_ARCHIVE_PATH}`,
  standardSeedManifest: `${RELEASE_ASSET_ROOT}/${WASIX_STANDARD_SEED_MANIFEST_PATH}`,
  icuSeedArchive: `${RELEASE_ASSET_ROOT}/cluster-seeds/icu.tar.zst`,
  icuSeedManifest: `${RELEASE_ASSET_ROOT}/cluster-seeds/icu.json`,
  manifest: `${RELEASE_ASSET_ROOT}/manifest.json`,
});

export const WASIX_RUNTIME_NPM_ASSET_PATHS = Object.freeze({
  runtimeArchive: "assets/oliphaunt.wasix.tar.zst",
  standardSeedArchive: "assets/cluster-seed-standard.tar.zst",
  standardSeedManifest: "assets/cluster-seed-standard.json",
  manifest: "assets/manifest.json",
});
