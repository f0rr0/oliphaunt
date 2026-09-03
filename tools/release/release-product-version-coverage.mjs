import { buildPlan } from "./release-graph.mjs";

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Prove that every version moved by Release Please is owned by the matching
 * Moon product. Dependencies remain independently versioned release products.
 */
export function releaseProductVersionCoverage(graph, versionedProducts, prefix = "release-product-version-coverage") {
  if (!Array.isArray(versionedProducts) || versionedProducts.some((product) => typeof product !== "string" || product.length === 0)) {
    throw new Error(`${prefix}: versioned products must be a string list`);
  }
  const selected = [...new Set(versionedProducts)].sort(compareText);
  if (selected.length !== versionedProducts.length) {
    throw new Error(`${prefix}: versioned products must not contain duplicates`);
  }
  const unknownProducts = selected.filter((product) => !(product in graph.products));
  if (unknownProducts.length > 0) {
    throw new Error(`${prefix}: versioned products are absent from the release graph: ${unknownProducts.join(", ")}`);
  }
  const canonicalVersionFiles = selected.map((product) => {
    const file = graph.products[product]?.version_files?.[0];
    if (typeof file !== "string" || file.length === 0) {
      throw new Error(`${prefix}: ${product} is missing canonical version file metadata`);
    }
    return file;
  });
  const moonRequiredProducts = buildPlan(graph, canonicalVersionFiles, prefix).releaseProducts;
  const versioned = new Set(selected);
  const unselectedProducts = selected.filter((product) => !moonRequiredProducts.includes(product));
  if (unselectedProducts.length > 0) {
    throw new Error(
      `${prefix}: manifest-bumped product(s) are not selected by their canonical version files in the Moon graph: ` +
      unselectedProducts.join(", "),
    );
  }
  const unexpectedProducts = moonRequiredProducts.filter((product) => !versioned.has(product));
  if (unexpectedProducts.length > 0) {
    throw new Error(
      `${prefix}: canonical version files selected unexpected product(s): ` +
      unexpectedProducts.join(", "),
    );
  }
  return {
    missingProducts: [],
    requiredProducts: moonRequiredProducts,
    versionedProducts: selected,
  };
}
