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

function stringTargetList(value, label) {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.length > 0)) {
    throw new TypeError(`${label} must be a string list`);
  }
  return [...value].sort(compareText);
}

export function extensionNpmPackage(sqlName) {
  return `@oliphaunt/extension-${sqlName.replaceAll("_", "-")}`;
}

export function extensionNpmTargetPackage(sqlName, target) {
  return `${extensionNpmPackage(sqlName)}-${target}`;
}

export function extensionNpmPackageForProduct(product) {
  if (typeof product !== "string" || !product.startsWith("oliphaunt-extension-")) {
    throw new TypeError(`extension product must start with oliphaunt-extension-: ${JSON.stringify(product)}`);
  }
  return `@oliphaunt/${product.slice("oliphaunt-".length)}`;
}

export function extensionNpmTargetPackageForProduct(product, target) {
  return `${extensionNpmPackageForProduct(product)}-${target}`;
}

export function nativeExtensionCargoPackageName(product, target) {
  return `${product}-${target}`;
}

export function nativeExtensionCargoLinksName(product, target) {
  const stem = `extension_${product.replace(/^oliphaunt-extension-/u, "")}_${target}`;
  return `oliphaunt_artifact_${stem.replaceAll("-", "_")}`;
}

export function nativeExtensionCargoPartPackageName(product, target, index) {
  if (!Number.isSafeInteger(index) || index < 1 || index > 999) {
    throw new TypeError(`native extension Cargo part number must be an integer from 1 through 999: ${JSON.stringify(index)}`);
  }
  return `${nativeExtensionCargoPackageName(product, target)}-part-${String(index).padStart(3, "0")}`;
}

export function assertCargoPackageName(name, { splittable = false, context = "Cargo package" } = {}) {
  if (typeof name !== "string" || name.length === 0) {
    throw new TypeError(`${context} name must be a non-empty string`);
  }
  if (name.length > 64) {
    throw new TypeError(`${context} ${JSON.stringify(name)} is ${name.length} characters; crates.io allows at most 64`);
  }
  if (splittable && `${name}-part-001`.length > 64) {
    throw new TypeError(`${context} ${JSON.stringify(name)} cannot be split: ${JSON.stringify(`${name}-part-001`)} exceeds crates.io's 64-character limit`);
  }
  return name;
}

export function extensionStableNpmPackageNames(sqlName, targets) {
  const targetList = stringTargetList(targets, "extension npm targets");
  return [
    extensionNpmPackage(sqlName),
    ...targetList.map((target) => extensionNpmTargetPackage(sqlName, target)),
  ].sort(compareText);
}

export function extensionStableNpmPackageNamesForProduct(product, targets) {
  const targetList = stringTargetList(targets, "extension npm targets");
  return [
    extensionNpmPackageForProduct(product),
    ...targetList.map((target) => extensionNpmTargetPackageForProduct(product, target)),
  ].sort(compareText);
}

export function extensionNativeCargoPackageNames(product, targets) {
  return stringTargetList(targets, "native extension Cargo targets")
    .map((target) => assertCargoPackageName(nativeExtensionCargoPackageName(product, target), {
      splittable: true,
      context: `${product} native carrier`,
    }))
    .sort(compareText);
}

export function extensionWasixCargoPackageNames(
  product,
  { includeAot = true, aotTargets = expectedExtensionAotTargets() } = {},
) {
  return [
    assertCargoPackageName(wasixExtensionPackageName(product), {
      splittable: true,
      context: `${product} portable WASIX carrier`,
    }),
    ...(includeAot ? aotTargets.map((target) => assertCargoPackageName(wasixExtensionAotPackageName(product, target), {
      splittable: true,
      context: `${product} WASIX AOT carrier`,
    })) : []),
  ].sort(compareText);
}

export function extensionMavenPackageNames(product, androidTargets) {
  return stringTargetList(androidTargets, "extension Android Maven targets")
    .map((target) => `dev.oliphaunt.extensions:${product}-${target}`)
    .sort(compareText);
}

export function extensionRegistryPackageEntries({
  product,
  androidTargets,
  npmTargets,
  nativeCargoTargets,
  includeWasixAot = true,
  wasixAotTargets = expectedExtensionAotTargets(),
}) {
  return [
    { kind: "crates", name: assertCargoPackageName(product, { context: `${product} facade` }) },
    ...extensionNativeCargoPackageNames(product, nativeCargoTargets).map((name) => ({ kind: "crates", name })),
    ...extensionWasixCargoPackageNames(product, {
      includeAot: includeWasixAot,
      aotTargets: wasixAotTargets,
    }).map((name) => ({ kind: "crates", name })),
    ...extensionStableNpmPackageNamesForProduct(product, npmTargets).map((name) => ({ kind: "npm", name })),
    ...extensionMavenPackageNames(product, androidTargets).map((name) => ({ kind: "maven", name })),
  ].sort((left, right) =>
    (REGISTRY_KIND_ORDER.get(left.kind) ?? 99) - (REGISTRY_KIND_ORDER.get(right.kind) ?? 99)
    || compareText(left.name, right.name)
  );
}

export function extensionRegistryPackageStrings(options) {
  return extensionRegistryPackageEntries(options).map((entry) => `${entry.kind}:${entry.name}`);
}
