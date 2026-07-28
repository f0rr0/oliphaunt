import { describe, expect, test } from "bun:test";

import { liboliphauntWasixAotRuntimeMatrix } from "./artifact_target_matrix.mjs";

const expected = new Map([
  ["macos-arm64", {
    archive: "llvm-darwin-aarch64.tar.xz",
    sha256: "f64460f6c8a28876737402542fc5b28bb1f4262cef85f799b65ce2a7ee6f8847",
    bytes: 479103872,
  }],
  ["linux-x64-gnu", {
    archive: "llvm-linux-amd64.tar.xz",
    sha256: "5fb1c687c5e895d517a23e7aabea9ec3557e3a3e33f8a8d3a8d21395157b3906",
    bytes: 741670068,
  }],
  ["linux-arm64-gnu", {
    archive: "llvm-linux-aarch64.tar.xz",
    sha256: "1fddcf5b30f9d3e073eb161509220b4136ea8e2f114f23084bdec33e40fa87c1",
    bytes: 668873496,
  }],
  ["windows-x64-msvc", {
    archive: "llvm-windows-amd64.tar.xz",
    sha256: "19ff22b0cf74b53dad2fc717db2209f8162b768fc6dede9e2caa6a83c724496e",
    bytes: 757929860,
  }],
]);

describe("Wasmer LLVM AOT matrix", () => {
  test("binds every supported host archive to its reviewed digest and exact size", () => {
    const matrix = liboliphauntWasixAotRuntimeMatrix();
    expect(matrix.include).toHaveLength(expected.size);
    for (const row of matrix.include) {
      const pin = expected.get(row.target_id);
      expect(pin, row.target_id).toBeDefined();
      expect(row.llvm_url).toBe(
        `https://github.com/wasmerio/llvm-custom-builds/releases/download/22.x/${pin.archive}`,
      );
      expect(row.llvm_sha256).toBe(pin.sha256);
      expect(row.llvm_bytes).toBe(pin.bytes);
      expect(row.llvm_sha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(row.llvm_bytes).toBeGreaterThan(0);
      expect(row.llvm_bytes).toBeLessThanOrEqual(2 * 1024 * 1024 * 1024);
    }
  });
});
