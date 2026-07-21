import { buildPlan } from "./release-graph.mjs";
import { dependentReleaseClosure } from "./release-dependent-candidates.mjs";

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Compute the release closure required by the identities that actually moved
 * in the Release Please manifest. Canonical version files prove Moon ownership;
 * the dependent closure additionally requires every directed compatibility
 * sink to acquire its own release identity and dependency changelog.
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
  const closure = dependentReleaseClosure(graph, selected, { prefix });
  const requiredProducts = closure.requiredProducts;
  const versioned = new Set(selected);
  const required = new Set(requiredProducts);
  const unselectedProducts = selected.filter((product) => !moonRequiredProducts.includes(product));
  if (unselectedProducts.length > 0) {
    throw new Error(
      `${prefix}: manifest-bumped product(s) are not selected by their canonical version files in the Moon graph: ` +
      unselectedProducts.join(", "),
    );
  }
  const moonProductsMissingFromClosure = moonRequiredProducts.filter((product) => !required.has(product));
  if (moonProductsMissingFromClosure.length > 0) {
    throw new Error(
      `${prefix}: dependent release closure omitted Moon-selected product(s): ` +
      moonProductsMissingFromClosure.join(", "),
    );
  }
  return {
    missingProducts: requiredProducts.filter((product) => !versioned.has(product)),
    requiredProducts,
    versionedProducts: selected,
  };
}
