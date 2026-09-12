#!/usr/bin/env bun
import { packageBrokerCargoArtifacts } from '../../broker/tools/package_broker_cargo_artifacts.mts';
import { BROKER_PRODUCT, packageBrokerCarriers } from '../../broker/tools/package-carriers.mts';
import { packageDatabaseResourceCarriers } from '../../database-resources/tools/package-carriers.mts';
import { packageExtensionCarriers } from '../../extensions/artifacts/packages/tools/package-carriers.mts';
import { packageNativeToolsCarriers } from '../../postgres-tools/native/tools/package-carriers.mts';
import { packageWasixToolsCarriers } from '../../postgres-tools/wasix/tools/package-carriers.mts';
import {
  LIBOLIPHAUNT_NATIVE_PRODUCT,
  packageLiboliphauntNativeCarriers,
} from '../../runtimes/liboliphaunt-native/tools/package-carriers.mts';
import {
  packageWasixRuntimeCarriers,
  WASIX_PRODUCT,
} from '../../runtimes/liboliphaunt-wasix/tools/package-carriers.mts';
import {
  NODE_DIRECT_PRODUCT,
  packageNodeDirectCarriers,
} from '../../sdks/ts/node-addon/tools/check-carriers.mts';
import {
  packageWasixNapiCarriers,
  WASIX_NAPI_PRODUCT,
} from '../../sdks/ts-wasix/node-addon/tools/check-carriers.mts';
import { fail, TOOL } from '../packaging/release-carrier.mts';
import { exactExtensionReleaseProducts } from './release-artifact-targets.mts';

async function packageReleaseCarriers(products) {
  const selected = new Set(products);
  if (selected.has('database-resources')) {
    await packageDatabaseResourceCarriers();
  }
  if (selected.has('postgres-tools-native')) {
    await packageNativeToolsCarriers();
  }
  if (selected.has('postgres-tools-wasix')) {
    await packageWasixToolsCarriers();
  }
  if (selected.has(LIBOLIPHAUNT_NATIVE_PRODUCT)) {
    await packageLiboliphauntNativeCarriers();
  }
  if (selected.has(BROKER_PRODUCT)) {
    await packageBrokerCarriers();
    await packageBrokerCargoArtifacts();
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
