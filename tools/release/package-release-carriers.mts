#!/usr/bin/env bun
import {
  LIBOLIPHAUNT_NATIVE_PRODUCT,
  packageLiboliphauntNativeCarriers,
} from '../../src/runtimes/liboliphaunt/native/tools/package-carriers.mts';
import {
  BROKER_PRODUCT,
  packageBrokerCarriers,
} from '../../src/runtimes/broker/tools/package-carriers.mts';
import {
  WASIX_PRODUCT,
  packageWasixRuntimeCarriers,
} from '../../src/runtimes/liboliphaunt/wasix/tools/package-carriers.mts';
import {
  NODE_DIRECT_PRODUCT,
  packageNodeDirectCarriers,
} from '../../src/runtimes/node-direct/tools/check-carriers.mts';
import {
  WASIX_NAPI_PRODUCT,
  packageWasixNapiCarriers,
} from '../../src/runtimes/wasix-napi/tools/check-carriers.mts';
import { exactExtensionReleaseProducts } from '../../src/shared/product-metadata/release-artifact-targets.mts';
import { TOOL, fail } from '../../src/shared/artifact-packaging/release-carrier.mts';
import { packageExtensionCarriers } from '../../src/extensions/artifacts/packages/tools/package-carriers.mts';

async function packageReleaseCarriers(products) {
  const selected = new Set(products);
  if (selected.has(LIBOLIPHAUNT_NATIVE_PRODUCT)) {
    await packageLiboliphauntNativeCarriers();
  }
  if (selected.has(BROKER_PRODUCT)) {
    await packageBrokerCarriers();
  }
  if (selected.has(WASIX_PRODUCT)) {
    await packageWasixRuntimeCarriers();
  }
  if (selected.has(NODE_DIRECT_PRODUCT)) {
    await packageNodeDirectCarriers();
  }
  if (selected.has(WASIX_NAPI_PRODUCT)) {
    await packageWasixNapiCarriers();
  }
  for (const product of exactExtensionReleaseProducts(TOOL)) {
    if (selected.has(product)) {
      await packageExtensionCarriers(product);
    }
  }
}

function parseProducts(argv) {
  const index = argv.indexOf('--products-json');
  if (index < 0 || !argv[index + 1]) {
    fail('usage: package-release-carriers.mts --products-json JSON', 2);
  }
  let products;
  try {
    products = JSON.parse(argv[index + 1]);
  } catch (error) {
    fail(`--products-json must be valid JSON: ${error.message}`, 2);
  }
  if (!Array.isArray(products) || !products.every((product) => typeof product === 'string')) {
    fail('--products-json must be a JSON string array', 2);
  }
  return products;
}

if (import.meta.main) {
  await packageReleaseCarriers(parseProducts(Bun.argv.slice(2)));
}
