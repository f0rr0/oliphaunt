import {
  expectedExtensionAotTargets,
  wasixExtensionAotPackageName,
  wasixExtensionPackageName,
} from "./wasix-cargo-artifact-contract.mjs";

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

const REGISTRY_KIND_ORDER = new Map([
  ["crates", 0],
  ["npm", 1],
  ["maven", 2],
]);

export const EXTENSION_NATIVE_DESKTOP_TARGETS = Object.freeze([
  "linux-arm64-gnu",
  "linux-x64-gnu",
  "macos-arm64",
  "windows-x64-msvc",
]);

export const EXTENSION_NPM_TARGETS = EXTENSION_NATIVE_DESKTOP_TARGETS;
export const EXTENSION_NATIVE_CARGO_TARGETS = EXTENSION_NATIVE_DESKTOP_TARGETS;

export function extensionNpmPackage(sqlName) {
  return `@oliphaunt/extension-${sqlName.replaceAll("_", "-")}`;
}

export function extensionNpmTargetPackage(sqlName, target) {
  return `${extensionNpmPackage(sqlName)}-${target}`;
}

export function extensionNpmPayloadPackage(sqlName, target, index) {
  return `${extensionNpmTargetPackage(sqlName, target)}-payload-${index}`;
}

export function nativeExtensionCargoPackageName(product, target) {
  return `${product}-${target}`;
}

export function nativeExtensionCargoLinksName(product, target) {
  const stem = `extension_${product.replace(/^oliphaunt-extension-/u, "")}_${target}`;
  return `oliphaunt_artifact_${stem.replaceAll("-", "_")}`;
}

export function nativeExtensionCargoPartPackageName(product, target, index) {
  return `${nativeExtensionCargoPackageName(product, target)}-part-${String(index).padStart(3, "0")}`;
}

export function extensionStableNpmPackageNames(sqlName, targets = EXTENSION_NPM_TARGETS) {
  return [
    extensionNpmPackage(sqlName),
    ...targets.map((target) => extensionNpmTargetPackage(sqlName, target)),
  ].sort(compareText);
}

export function extensionNativeCargoPackageNames(product, targets = EXTENSION_NATIVE_CARGO_TARGETS) {
  return targets
    .map((target) => nativeExtensionCargoPackageName(product, target))
    .sort(compareText);
}

export function extensionWasixCargoPackageNames(
  product,
  { includeAot = true, aotTargets = expectedExtensionAotTargets() } = {},
) {
  return [
    wasixExtensionPackageName(product),
    ...(includeAot ? aotTargets.map((target) => wasixExtensionAotPackageName(product, target)) : []),
  ].sort(compareText);
}

export function extensionMavenPackageNames(product, androidTargets) {
  return androidTargets
    .map((target) => `dev.oliphaunt.extensions:${product}-${target}`)
    .sort(compareText);
}

export function extensionRegistryPackageEntries({
  product,
  sqlName,
  androidTargets,
  npmTargets = EXTENSION_NPM_TARGETS,
  nativeCargoTargets = EXTENSION_NATIVE_CARGO_TARGETS,
  includeWasixAot = true,
  wasixAotTargets = expectedExtensionAotTargets(),
}) {
  return [
    ...extensionNativeCargoPackageNames(product, nativeCargoTargets).map((name) => ({ kind: "crates", name })),
    ...extensionWasixCargoPackageNames(product, {
      includeAot: includeWasixAot,
      aotTargets: wasixAotTargets,
    }).map((name) => ({ kind: "crates", name })),
    ...extensionStableNpmPackageNames(sqlName, npmTargets).map((name) => ({ kind: "npm", name })),
    ...extensionMavenPackageNames(product, androidTargets).map((name) => ({ kind: "maven", name })),
  ].sort((left, right) =>
    (REGISTRY_KIND_ORDER.get(left.kind) ?? 99) - (REGISTRY_KIND_ORDER.get(right.kind) ?? 99)
    || compareText(left.name, right.name)
  );
}

export function extensionRegistryPackageStrings(options) {
  return extensionRegistryPackageEntries(options).map((entry) => `${entry.kind}:${entry.name}`);
}
