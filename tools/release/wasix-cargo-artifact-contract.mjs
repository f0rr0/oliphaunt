import { compareText } from "./release-graph.mjs";

export const WASIX_CARGO_ARTIFACT_SCHEMA = "oliphaunt-liboliphaunt-wasix-cargo-artifacts-v2";
export const RUNTIME_PACKAGE = "liboliphaunt-wasix-portable";
export const TOOLS_PACKAGE = "oliphaunt-wasix-tools";
export const ICU_PACKAGE = "oliphaunt-icu";
export const ICU_PAYLOAD_ARCHIVE = "icu-data.tar.zst";

export const TOOLS_PAYLOAD_FILES = [
  "bin/pg_dump.wasix.wasm",
  "bin/psql.wasix.wasm",
];

export const CORE_RUNTIME_ARCHIVE_FILES = [
  "oliphaunt/bin/initdb",
  "oliphaunt/bin/postgres",
];

export const FORBIDDEN_RUNTIME_ARCHIVE_TOOL_FILES = [
  "oliphaunt/bin/pg_ctl",
  "oliphaunt/bin/pg_dump",
  "oliphaunt/bin/psql",
];

export const TOOLS_AOT_ARTIFACTS = [
  "tool:pg_dump",
  "tool:psql",
];

export const AOT_PACKAGES = {
  "macos-arm64": "liboliphaunt-wasix-aot-aarch64-apple-darwin",
  "linux-arm64-gnu": "liboliphaunt-wasix-aot-aarch64-unknown-linux-gnu",
  "linux-x64-gnu": "liboliphaunt-wasix-aot-x86_64-unknown-linux-gnu",
  "windows-x64-msvc": "liboliphaunt-wasix-aot-x86_64-pc-windows-msvc",
};

export const TOOLS_AOT_PACKAGES = {
  "macos-arm64": "oliphaunt-wasix-tools-aot-aarch64-apple-darwin",
  "linux-arm64-gnu": "oliphaunt-wasix-tools-aot-aarch64-unknown-linux-gnu",
  "linux-x64-gnu": "oliphaunt-wasix-tools-aot-x86_64-unknown-linux-gnu",
  "windows-x64-msvc": "oliphaunt-wasix-tools-aot-x86_64-pc-windows-msvc",
};

export const AOT_TARGET_TRIPLES = {
  "macos-arm64": "aarch64-apple-darwin",
  "linux-arm64-gnu": "aarch64-unknown-linux-gnu",
  "linux-x64-gnu": "x86_64-unknown-linux-gnu",
  "windows-x64-msvc": "x86_64-pc-windows-msvc",
};

export const AOT_TARGET_CFGS = {
  "aarch64-apple-darwin": 'cfg(all(target_os = "macos", target_arch = "aarch64"))',
  "aarch64-unknown-linux-gnu": 'cfg(all(target_os = "linux", target_arch = "aarch64", target_env = "gnu"))',
  "x86_64-unknown-linux-gnu": 'cfg(all(target_os = "linux", target_arch = "x86_64", target_env = "gnu"))',
  "x86_64-pc-windows-msvc": 'cfg(all(target_os = "windows", target_arch = "x86_64", target_env = "msvc"))',
};

export function publicCargoPackageNames() {
  return [
    ICU_PACKAGE,
    RUNTIME_PACKAGE,
    TOOLS_PACKAGE,
    ...Object.values(AOT_PACKAGES),
    ...Object.values(TOOLS_AOT_PACKAGES),
  ].sort(compareText);
}

export function publicAotCargoDependencies() {
  return Object.fromEntries(
    Object.keys(AOT_PACKAGES)
      .sort(compareText)
      .map((target) => [
        AOT_TARGET_CFGS[AOT_TARGET_TRIPLES[target]],
        AOT_PACKAGES[target],
      ]),
  );
}

export function publicToolsAotCargoDependencies() {
  return Object.fromEntries(
    Object.keys(TOOLS_AOT_PACKAGES)
      .sort(compareText)
      .map((target) => [
        AOT_TARGET_CFGS[AOT_TARGET_TRIPLES[target]],
        TOOLS_AOT_PACKAGES[target],
      ]),
  );
}

export function publicToolsFeatureDependencies() {
  return [
    `dep:${TOOLS_PACKAGE}`,
    ...Object.values(TOOLS_AOT_PACKAGES).map((name) => `dep:${name}`),
  ].sort(compareText);
}

export function wasixExtensionPackageName(product) {
  return `${product}-wasix`;
}

export function wasixExtensionAotPackageName(product, target) {
  return `${product}-wasix-aot-${target}`;
}

export function expectedExtensionAotTargets() {
  return [...new Set(Object.values(AOT_TARGET_TRIPLES))].sort(compareText);
}

export function wasixCargoArtifactContract() {
  return {
    schema: WASIX_CARGO_ARTIFACT_SCHEMA,
    runtimePackage: RUNTIME_PACKAGE,
    toolsPackage: TOOLS_PACKAGE,
    icuPackage: ICU_PACKAGE,
    icuPayloadArchive: ICU_PAYLOAD_ARCHIVE,
    coreRuntimeArchiveFiles: [...CORE_RUNTIME_ARCHIVE_FILES],
    toolsPayloadFiles: [...TOOLS_PAYLOAD_FILES],
    forbiddenRuntimeArchiveToolFiles: [...FORBIDDEN_RUNTIME_ARCHIVE_TOOL_FILES],
    toolsAotArtifacts: [...TOOLS_AOT_ARTIFACTS],
    aotPackages: { ...AOT_PACKAGES },
    toolsAotPackages: { ...TOOLS_AOT_PACKAGES },
    aotTargetTriples: { ...AOT_TARGET_TRIPLES },
    aotTargetCfgs: { ...AOT_TARGET_CFGS },
    expectedExtensionAotTargets: expectedExtensionAotTargets(),
    publicCargoPackageNames: publicCargoPackageNames(),
    publicAotCargoDependencies: publicAotCargoDependencies(),
    publicToolsAotCargoDependencies: publicToolsAotCargoDependencies(),
    publicToolsFeatureDependencies: publicToolsFeatureDependencies(),
  };
}
