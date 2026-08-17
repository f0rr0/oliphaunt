import { describe, expect, test } from "bun:test";

import { PLATFORM_COMPATIBILITY_POLICY } from "./platform-compatibility-policy.mjs";
import {
  allArtifactTargets,
  extensionArtifactTargets,
} from "./release-artifact-targets.mjs";

const BINARY_ARTIFACT_KINDS = new Set([
  "native-runtime",
  "native-tools",
  "broker-helper",
  "node-direct-addon",
]);

const artifacts = allArtifactTargets().filter((target) =>
  BINARY_ARTIFACT_KINDS.has(target.kind),
);
const extensions = extensionArtifactTargets({ family: "native" });

function validateCoverage(policy, artifacts, extensions) {
  const uses = new Map();
  const addUse = (target, label, boundContract) => {
    const contract = policy[target];
    if (contract === undefined) {
      throw new Error(`${label} uses ${target} without a platform compatibility contract`);
    }
    if (boundContract !== contract) {
      throw new Error(`${label} does not consume the authoritative ${target} contract`);
    }
    const labels = uses.get(target) ?? [];
    labels.push(label);
    uses.set(target, labels);
  };

  for (const artifact of artifacts) {
    addUse(artifact.target, artifact.id, artifact.binaryCompatibility);
  }
  for (const extension of extensions) {
    addUse(
      extension.target,
      `${extension.product}/${extension.family}/${extension.kind}`,
      extension.binaryCompatibility,
    );
  }

  const unused = Object.keys(policy).filter((target) => !uses.has(target)).sort();
  if (unused.length > 0) {
    throw new Error(`platform compatibility contract(s) are not used by a carrier: ${unused.join(", ")}`);
  }
  return uses;
}

describe("platform compatibility policy", () => {
  test("is an exact bidirectional map of native, broker, Node, and extension carriers", () => {
    const uses = validateCoverage(
      PLATFORM_COMPATIBILITY_POLICY,
      artifacts,
      extensions,
    );
    expect([...uses.keys()].sort()).toEqual(Object.keys(PLATFORM_COMPATIBILITY_POLICY).sort());
  });

  test("rejects both an uncovered target and an unused contract", () => {
    const missing = { ...PLATFORM_COMPATIBILITY_POLICY };
    delete missing["linux-x64-gnu"];
    expect(() => validateCoverage(missing, artifacts, extensions)).toThrow(
      /uses linux-x64-gnu without a platform compatibility contract/u,
    );

    const unused = {
      ...PLATFORM_COMPATIBILITY_POLICY,
      "unused-test-target": PLATFORM_COMPATIBILITY_POLICY["linux-x64-gnu"],
    };
    expect(() => validateCoverage(unused, artifacts, extensions)).toThrow(
      /not used by a carrier: unused-test-target/u,
    );
  });

  test("owns the release compatibility floors and ABI ceilings", () => {
    expect(
      PLATFORM_COMPATIBILITY_POLICY["macos-arm64"].apple.platforms.macos.maximumMinimumOs,
    ).toEqual([11, 0, 0]);
    expect(
      PLATFORM_COMPATIBILITY_POLICY["ios-xcframework"].apple.platforms.macos.maximumMinimumOs,
    ).toEqual([14, 0, 0]);
    expect(
      PLATFORM_COMPATIBILITY_POLICY["ios-xcframework"].apple.platforms.ios.maximumMinimumOs,
    ).toEqual([17, 0, 0]);
    expect(PLATFORM_COMPATIBILITY_POLICY["android-arm64-v8a"].elf.androidApiLevel).toBe(24);
    expect(
      PLATFORM_COMPATIBILITY_POLICY["linux-x64-gnu"].elf.maximumRequiredVersions.GLIBC,
    ).toEqual([2, 38, 0]);
    expect(
      PLATFORM_COMPATIBILITY_POLICY["linux-x64-gnu"].elf.maximumRequiredVersions.GLIBCXX,
    ).toEqual([3, 4, 30]);
  });

});
