import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  nativeIcuDataManifest,
  nativeIcuDataManifestFromRows,
  validateNativeIcuDataManifest,
} from "./native-icu-data-contract.mjs";

test("binds the data-only native ICU carrier to its logical tree", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-native-icu-contract-"));
  try {
    mkdirSync(path.join(root, "icudt76l"));
    writeFileSync(path.join(root, "icudt76l/root.res"), "root\n");
    const manifest = nativeIcuDataManifest(root);
    expect(manifest.toString("utf8")).toMatch(
      /^schema=oliphaunt-icu-data-v1\nartifactRole=icu-data\nicuDataVersion=76[.]1\nicuDataForm=files-le\nicuDataTreeSha256=[0-9a-f]{64}\n$/u,
    );
    expect(validateNativeIcuDataManifest(manifest, root).icuDataTreeSha256).toHaveLength(64);
    writeFileSync(path.join(root, "icudt76l/root.res"), "changed\n");
    expect(() => validateNativeIcuDataManifest(manifest, root)).toThrow(/icuDataTreeSha256/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects an empty ICU data identity", () => {
  expect(() => nativeIcuDataManifestFromRows([])).toThrow(/tree is empty/u);
});
