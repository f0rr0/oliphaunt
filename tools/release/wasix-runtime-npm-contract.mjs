export const WASIX_RUNTIME_PRODUCT = "liboliphaunt-wasix";
export const WASIX_RUNTIME_NPM_PACKAGE = "@oliphaunt/liboliphaunt-wasix";
export const WASIX_RUNTIME_NPM_DESCRIPTOR_SCHEMA = "oliphaunt-wasix-runtime-v1";
export const WASIX_RUNTIME_NPM_TARGET = "portable";

export const WASIX_RUNTIME_ARCHIVE_PATH = "oliphaunt.wasix.tar.zst";
export const WASIX_PGDATA_ARCHIVE_PATH = "prepopulated/pgdata-template.tar.zst";

const RELEASE_ASSET_ROOT = "target/oliphaunt-wasix/assets";

export const WASIX_PORTABLE_RELEASE_MEMBERS = Object.freeze({
  runtimeArchive: `${RELEASE_ASSET_ROOT}/${WASIX_RUNTIME_ARCHIVE_PATH}`,
  pgdataArchive: `${RELEASE_ASSET_ROOT}/${WASIX_PGDATA_ARCHIVE_PATH}`,
  manifest: `${RELEASE_ASSET_ROOT}/manifest.json`,
});

export const WASIX_RUNTIME_NPM_ASSET_PATHS = Object.freeze({
  runtimeArchive: "assets/oliphaunt.wasix.tar.zst",
  pgdataArchive: "assets/pgdata-template.tar.zst",
  manifest: "assets/manifest.json",
});
