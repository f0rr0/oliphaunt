#!/usr/bin/env bun
import { packageBrokerCargoArtifacts } from '../../src/native/broker/tools/package_broker_cargo_artifacts.mts';
import {
  BROKER_PRODUCT,
  packageBrokerCarriers,
} from '../../src/native/broker/tools/package-carriers.mts';
import { packageDatabaseResourceCarriers } from '../../src/database-resources/tools/package-carriers.mts';
import { packageExtensionCarriers } from '../../src/extensions/artifacts/packages/tools/package-carriers.mts';
import { packageNativeToolsCarriers } from '../../src/native/postgres-tools/tools/package-carriers.mts';
import { packageWasixToolsCarriers } from '../../src/wasix/postgres-tools/tools/package-carriers.mts';
import {
  LIBOLIPHAUNT_NATIVE_PRODUCT,
  packageLiboliphauntNativeCarriers,
} from '../../src/native/runtime/tools/package-carriers.mts';
import {
  packageWasixRuntimeCarriers,
  WASIX_PRODUCT,
} from '../../src/wasix/runtime/tools/package-carriers.mts';
import {
  NODE_DIRECT_PRODUCT,
  packageNodeDirectCarriers,
} from '../../src/native/node-addon/tools/check-carriers.mts';
import {
  packageWasixNapiCarriers,
  WASIX_NAPI_PRODUCT,
} from '../../src/wasix/node-addon/tools/check-carriers.mts';
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
