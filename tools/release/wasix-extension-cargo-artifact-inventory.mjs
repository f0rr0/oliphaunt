import { exactExtensionProducts } from "./release-artifact-targets.mjs";
import {
  declaredCarrierMap,
  loadPublicationCatalog,
  resolveActualCarrier,
} from "./publication-catalog.mjs";

const PORTABLE_KIND = "wasix-extension";
const AOT_KIND = "wasix-extension-aot";
const EXTENSION_KINDS = new Set([PORTABLE_KIND, AOT_KIND]);
const ROLE_KINDS = new Map([
  ["portable-leaf", PORTABLE_KIND],
  ["aot-leaf", AOT_KIND],
]);

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function expectedWasixExtensionPackageInventory(
  tool = "wasix-extension-cargo-artifact-inventory.mjs",
  products = exactExtensionProducts(tool),
) {
  const selectedProducts = [...new Set(products)].sort(compareText);
  const catalog = loadPublicationCatalog(tool, { products: selectedProducts });
  const expectedPackageKinds = new Map();
  const portableProducts = new Set();
  for (const carrier of catalog.carriers) {
    if (carrier.ecosystem !== "cargo") {
      continue;
    }
    const kind = ROLE_KINDS.get(carrier.role);
    if (kind === undefined) {
      continue;
    }
    expectedPackageKinds.set(carrier.name, kind);
    if (carrier.role === "portable-leaf") {
      portableProducts.add(carrier.product);
    }
  }
  const missingPortable = selectedProducts.filter((product) => !portableProducts.has(product));
  if (missingPortable.length > 0) {
    throw new Error(
      `public Cargo inventory is missing WASIX portable carriers for: ${missingPortable.join(", ")}`,
    );
  }
  return {
    catalog,
    declaredCarriers: declaredCarrierMap(catalog),
    expectedPackageKinds,
    products: selectedProducts,
  };
}

export function expectedWasixExtensionPackageKinds(
  tool = "wasix-extension-cargo-artifact-inventory.mjs",
  products = exactExtensionProducts(tool),
) {
  return expectedWasixExtensionPackageInventory(tool, products).expectedPackageKinds;
}

function expectedCarrier(inventory, name, prefix) {
  const carrier = resolveActualCarrier(inventory.catalog, "cargo", name, prefix);
  const base = carrier.role === "payload-part"
    ? inventory.declaredCarriers.get(carrier.parentCarrier)
    : carrier;
  const kind = ROLE_KINDS.get(base?.role);
  if (kind === undefined) {
    return null;
  }
  return { base, carrier, kind };
}

export function isExpectedWasixExtensionPackage(name, kind, inventory) {
  try {
    return expectedCarrier(inventory, name, "WASIX extension Cargo inventory")?.kind === kind;
  } catch {
    return false;
  }
}

export function validateWasixExtensionArtifactInventory(
  packages,
  inventory,
) {
  const generatedBases = new Set();
  const partsByParent = new Map();
  const seenNames = new Set();
  for (const item of packages) {
    if (item === null || Array.isArray(item) || typeof item !== "object") {
      throw new Error("WASIX Cargo artifact package entries must be objects");
    }
    const { name, kind } = item;
    if (typeof name !== "string" || name.length === 0 || typeof kind !== "string") {
      throw new Error(`WASIX Cargo artifact package entry has an invalid name/kind: ${JSON.stringify(item)}`);
    }
    if (seenNames.has(name)) {
      throw new Error(`duplicate WASIX Cargo artifact package ${name}`);
    }
    seenNames.add(name);

    let expected;
    try {
      expected = expectedCarrier(
        inventory,
        name,
        "WASIX extension Cargo artifact inventory",
      );
    } catch (error) {
      if (EXTENSION_KINDS.has(kind)) {
        throw error;
      }
      continue;
    }
    if (expected === null) {
      if (EXTENSION_KINDS.has(kind)) {
        throw new Error(`unexpected WASIX extension Cargo artifact package ${name}`);
      }
      continue;
    }
    if (kind !== expected.kind) {
      throw new Error(
        `WASIX extension Cargo artifact package ${name} has kind ${kind}; expected ${expected.kind}`,
      );
    }
    if (expected.carrier.role === "payload-part") {
      const parts = partsByParent.get(expected.carrier.parentCarrier) ?? [];
      parts.push(expected.carrier.part);
      partsByParent.set(expected.carrier.parentCarrier, parts);
    } else {
      generatedBases.add(expected.carrier.name);
    }
  }

  const missing = [...inventory.expectedPackageKinds.keys()]
    .filter((name) => !generatedBases.has(name))
    .sort(compareText);
  if (missing.length > 0) {
    throw new Error(
      `generated liboliphaunt-wasix Cargo artifacts are missing configured extension base crates: ${missing.join(", ")}`,
    );
  }

  for (const [parent, numbers] of [...partsByParent].sort(([left], [right]) => compareText(left, right))) {
    const parentName = parent.slice("cargo:".length);
    if (!generatedBases.has(parentName)) {
      throw new Error(`WASIX extension Cargo payload parts require their declared parent ${parent}`);
    }
    const actual = [...numbers].sort((left, right) => left - right);
    const expected = Array.from({ length: actual.length }, (_, index) => index + 1);
    if (
      actual.length !== expected.length
      || actual.some((part, index) => part !== expected[index])
    ) {
      throw new Error(
        `${parent} Cargo payload parts must be contiguous from part-001; found ${actual.map((part) => String(part).padStart(3, "0")).join(", ")}`,
      );
    }
  }
}
