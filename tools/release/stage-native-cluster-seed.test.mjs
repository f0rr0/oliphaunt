import { expect, test } from "bun:test";

import {
  nativeClusterSeedProducerArgs,
  nativeClusterSeedProducerEnvironment,
} from "./stage-native-cluster-seed.mjs";

test("native cluster seeds use the ordinary PostgreSQL server bootstrap closure", () => {
  const standard = nativeClusterSeedProducerArgs("/tmp/out", "standard");
  expect(standard).toContain("native-server");
  expect(standard).not.toContain("native-direct");
  expect(standard).not.toContain("--runtime-feature");

  const icu = nativeClusterSeedProducerArgs("/tmp/out", "icu");
  expect(icu.slice(-2)).toEqual(["--runtime-feature", "icu"]);
});

test("suppresses release-runner locale discovery for every distributed seed", () => {
  expect(nativeClusterSeedProducerEnvironment("ios-datum64", "standard")).toEqual({
    skipSystemCollationDiscovery: true,
    skipIcuCollationDiscovery: true,
  });
  expect(nativeClusterSeedProducerEnvironment("android-datum64", "icu")).toEqual({
    skipSystemCollationDiscovery: true,
    skipIcuCollationDiscovery: false,
  });
  expect(nativeClusterSeedProducerEnvironment("linux-x64-gnu", "standard").skipSystemCollationDiscovery).toBe(true);
  expect(nativeClusterSeedProducerEnvironment("windows-x64-msvc", "icu").skipSystemCollationDiscovery).toBe(true);
  expect(() => nativeClusterSeedProducerEnvironment("mobile", "standard")).toThrow(/unsupported/u);
  expect(() => nativeClusterSeedProducerEnvironment("ios-datum64", "other")).toThrow(/profile/u);
});
