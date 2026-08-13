import { expect, test } from "bun:test";

import {
  productRegistryPackages,
  productRegistryPackagesFromLock,
} from "./check_registry_publication.mjs";
import {
  contribCarrierDescriptor,
  exactExtensionReleaseProducts,
} from "./release-artifact-targets.mjs";

test("no-lock exact-extension registry inventory is explicit, complete, and unique", async () => {
  expect(process.env.OLIPHAUNT_PUBLICATION_LOCK).toBeUndefined();
  for (const product of exactExtensionReleaseProducts("check-registry-publication-products.test")) {
    const packages = await productRegistryPackages(product);
    const identities = packages.map(({ kind, name }) => `${kind}:${name}`);
    expect(new Set(identities).size).toBe(identities.length);
    expect(identities.filter((identity) => identity === `crates:${product}`)).toHaveLength(1);
  }
});

test("runtime owners expose their complete contrib registry inventory", async () => {
  const descriptor = contribCarrierDescriptor("check-registry-publication-products.test");
  const contribPackages = async (owner) => (await productRegistryPackages(owner))
    .filter(({ name }) => name.includes("contrib-pg18"));
  expect(await contribPackages(descriptor.nativeOwner)).toHaveLength(12);
  expect(await contribPackages(descriptor.wasixOwner)).toHaveLength(6);
});

test("publication-lock inventory includes dynamic Cargo payload-part carriers", () => {
  const product = "fixture-native";
  const version = "1.2.3";
  const publicationLock = {
    products: [{ id: product, version }],
    carriers: [
      {
        ecosystem: "cargo",
        name: "fixture-native-linux-x64-gnu-part-001",
        product,
        role: "payload-part",
        version,
      },
      {
        ecosystem: "cargo",
        name: "fixture-native-linux-x64-gnu",
        product,
        role: "platform-leaf",
        version,
      },
      {
        ecosystem: "npm",
        name: "@fixture/native-linux-x64-gnu",
        product,
        role: "platform-leaf",
        version,
      },
    ],
  };

  expect(productRegistryPackagesFromLock(publicationLock, product)).toEqual([
    {
      kind: "crates",
      name: "fixture-native-linux-x64-gnu-part-001",
      version,
    },
    {
      kind: "crates",
      name: "fixture-native-linux-x64-gnu",
      version,
    },
    {
      kind: "npm",
      name: "@fixture/native-linux-x64-gnu",
      version,
    },
  ]);
  expect(productRegistryPackagesFromLock(publicationLock, product, {
    registryKind: "crates",
  }).map(({ name }) => name)).toEqual([
    "fixture-native-linux-x64-gnu-part-001",
    "fixture-native-linux-x64-gnu",
  ]);
});
