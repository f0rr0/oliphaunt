import { describe, expect, test } from "bun:test";

import { assertCanonicalVersionContract } from "./check-package-metadata.mjs";

function candidate(overrides = {}) {
  return {
    npmVersion: "1.2.3",
    cargoVersion: "1.2.3",
    carrierVersions: {
      darwin: "1.2.3",
      linuxArm64: "1.2.3",
      linuxX64: "1.2.3",
      windows: "1.2.3",
    },
    changelogBytes: Buffer.from("# Changelog\n\n## 1.2.3\n"),
    ...overrides,
  };
}

describe("WASIX Node-API product version metadata", () => {
  test("accepts a stable generated first-release candidate", () => {
    expect(assertCanonicalVersionContract(candidate({
      npmVersion: "0.1.0",
      cargoVersion: "0.1.0",
      carrierVersions: { a: "0.1.0", b: "0.1.0" },
      changelogBytes: Buffer.from("# Changelog\n\n## 0.1.0\n"),
    }))).toBe("0.1.0");
  });

  test("accepts only an empty changelog for the unreleased 0.0.0 state", () => {
    expect(assertCanonicalVersionContract(candidate({
      npmVersion: "0.0.0",
      cargoVersion: "0.0.0",
      carrierVersions: { a: "0.0.0" },
      changelogBytes: Buffer.alloc(0),
    }))).toBe("0.0.0");
    expect(() => assertCanonicalVersionContract(candidate({
      npmVersion: "0.0.0",
      cargoVersion: "0.0.0",
      carrierVersions: { a: "0.0.0" },
    }))).toThrow(/must remain byte-empty/u);
    expect(() => assertCanonicalVersionContract(candidate({ changelogBytes: Buffer.alloc(0) })))
      .toThrow(/must not remain byte-empty/u);
  });

  test("rejects unstable or divergent canonical and carrier versions", () => {
    expect(() => assertCanonicalVersionContract(candidate({ npmVersion: "1.2.3-rc.1" })))
      .toThrow(/stable SemVer/u);
    expect(() => assertCanonicalVersionContract(candidate({ cargoVersion: "1.2.4" })))
      .toThrow(/npm and Cargo package versions must match/u);
    expect(() => assertCanonicalVersionContract(candidate({
      carrierVersions: { darwin: "1.2.3", linux: "1.2.4" },
    }))).toThrow(/linux must match the canonical product version/u);
  });
});
