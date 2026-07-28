import { expect, test } from "bun:test";

import { productRegistryPackages } from "./check_registry_publication.mjs";
import { exactExtensionProducts } from "./release-artifact-targets.mjs";

test("no-lock exact-extension registry inventory is explicit, complete, and unique", async () => {
  expect(process.env.OLIPHAUNT_PUBLICATION_LOCK).toBeUndefined();
  for (const product of exactExtensionProducts("check-registry-publication-products.test")) {
    const packages = await productRegistryPackages(product);
    const identities = packages.map(({ kind, name }) => `${kind}:${name}`);
    expect(new Set(identities).size).toBe(identities.length);
    expect(identities.filter((identity) => identity === `crates:${product}`)).toHaveLength(1);
  }
});
