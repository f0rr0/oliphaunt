import { expect, test } from "bun:test";

import {
  bindNativeRuntimeResourceManifest,
  nativeRuntimeCarrierManifest,
} from "./native-runtime-carrier-contract.mjs";
import { nativeRuntimeResourceManifestFixture } from "../test/native-runtime-fixture.mjs";

test("renders the minimal single-target native runtime carrier receipt", () => {
  expect(nativeRuntimeCarrierManifest("linux-x64-gnu").toString("utf8")).toBe(
    "schema=oliphaunt-native-runtime-carrier-v1\n"
      + "clusterSeedTarget=linux-x64-gnu\n"
      + "clusterSeedRelativePath=cluster-seed\n"
      + "icuClusterSeedRelativePath=cluster-seed-icu\n",
  );
});

test("binds only the exact native-direct runtime resource contract", () => {
  const bound = bindNativeRuntimeResourceManifest(nativeRuntimeResourceManifestFixture(), "android-datum64");
  expect(bound.toString("utf8")).toContain("clusterSeedTarget=android-datum64\n");
  expect(() => bindNativeRuntimeResourceManifest(
    nativeRuntimeResourceManifestFixture({ extra: { legacy: "value" } }),
    "android-datum64",
  )).toThrow(/exact canonical field set/u);
  expect(() => bindNativeRuntimeResourceManifest(
    nativeRuntimeResourceManifestFixture({ overrides: { cacheKey: ".." } }),
    "android-datum64",
  )).toThrow(/native-direct contract/u);
  expect(() => bindNativeRuntimeResourceManifest(
    nativeRuntimeResourceManifestFixture({ overrides: { mode: "native-server" } }),
    "android-datum64",
  )).toThrow(/native-direct contract/u);
});
