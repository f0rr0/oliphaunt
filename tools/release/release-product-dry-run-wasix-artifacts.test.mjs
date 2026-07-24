import { afterAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import {
  expectedWasixExtensionPackageInventory,
  isExpectedWasixExtensionPackage,
  validateWasixExtensionArtifactInventory,
} from "./wasix-extension-cargo-artifact-inventory.mjs";
import {
  validateWasixCargoArtifacts,
} from "./release-product-dry-run.mjs";
import {
  AOT_PACKAGES,
  ICU_PACKAGE,
  RUNTIME_PACKAGE,
  TOOLS_AOT_PACKAGES,
  TOOLS_PACKAGE,
} from "./wasix-cargo-artifact-contract.mjs";

const TOOL = "release-product-dry-run-wasix-artifacts.test.mjs";
const ROOT = path.resolve(import.meta.dir, "../..");
const directories = [];

afterAll(() => {
  for (const directory of directories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function configuredInventory(expected) {
  return [...expected].map(([name, kind]) => ({ name, kind }));
}

describe("WASIX extension Cargo artifact inventory", () => {
  const inventory = expectedWasixExtensionPackageInventory(TOOL);
  const expected = inventory.expectedPackageKinds;
  const contribAot = "oliphaunt-extension-contrib-pg18-aot-macos-arm64";
  const postgisAot = "oliphaunt-extension-postgis-aot-linux-x64";
  const pgtapAot = "oliphaunt-extension-pgtap-aot-macos-arm64";

  test("derives the exact portable and AOT base identities from the public catalog", () => {
    expect(expected.get("oliphaunt-extension-contrib-pg18-wasix"))
      .toBe("wasix-extension");
    expect(expected.get(contribAot)).toBe("wasix-extension-aot");
    expect(expected.get(postgisAot)).toBe("wasix-extension-aot");
    expect(expected.has(pgtapAot)).toBe(false);
  });

  test("accepts configured bases and PostGIS dynamic parts with matching kinds", () => {
    const packages = configuredInventory(expected);
    packages.push(
      { name: `${postgisAot}-part-001`, kind: "wasix-extension-aot" },
      { name: `${postgisAot}-part-002`, kind: "wasix-extension-aot" },
    );
    expect(() => validateWasixExtensionArtifactInventory(packages, inventory))
      .not.toThrow();
    expect(isExpectedWasixExtensionPackage(
      `${postgisAot}-part-001`,
      "wasix-extension-aot",
      inventory,
    )).toBe(true);
  });

  test("rejects the stale wasix-aot identity form and pgtap AOT", () => {
    for (const name of [
      "oliphaunt-extension-contrib-pg18-wasix-aot-aarch64-apple-darwin",
      pgtapAot,
    ]) {
      expect(() => validateWasixExtensionArtifactInventory([
        ...configuredInventory(expected),
        { name, kind: "wasix-extension-aot" },
      ], inventory)).toThrow(/artifact identity cargo:/u);
    }
  });

  test("rejects malformed dynamic part numbers", () => {
    for (const suffix of ["000", "01", "1000"]) {
      expect(() => validateWasixExtensionArtifactInventory([
        ...configuredInventory(expected),
        { name: `${postgisAot}-part-${suffix}`, kind: "wasix-extension-aot" },
      ], inventory)).toThrow(/Cargo payload part|is not a Cargo payload part/u);
    }
  });

  test("rejects non-contiguous dynamic payload parts", () => {
    expect(() => validateWasixExtensionArtifactInventory([
      ...configuredInventory(expected),
      { name: `${postgisAot}-part-001`, kind: "wasix-extension-aot" },
      { name: `${postgisAot}-part-003`, kind: "wasix-extension-aot" },
    ], inventory)).toThrow(/must be contiguous from part-001; found 001, 003/u);
  });

  test("rejects a missing configured extension base", () => {
    expect(() => validateWasixExtensionArtifactInventory(
      configuredInventory(expected).filter(({ name }) => name !== contribAot),
      inventory,
    )).toThrow(new RegExp(`missing configured extension base crates: ${contribAot}`, "u"));
  });

  test("rejects a configured extension identity with the wrong kind", () => {
    expect(() => validateWasixExtensionArtifactInventory(
      configuredInventory(expected).map((item) =>
        item.name === contribAot ? { ...item, kind: "wasix-extension" } : item
      ),
      inventory,
    )).toThrow(new RegExp(`${contribAot} has kind wasix-extension; expected wasix-extension-aot`, "u"));
  });

  test("the release-product dry-run validates a complete synthetic Cargo artifact manifest", () => {
    const output = mkdtempSync(path.join(ROOT, "target/wasix-dry-run-inventory-test-"));
    directories.push(output);
    const runtimeKinds = new Map([
      [ICU_PACKAGE, "icu-data"],
      [RUNTIME_PACKAGE, "wasix-runtime"],
      [TOOLS_PACKAGE, "wasix-tools"],
      ...Object.values(AOT_PACKAGES).map((name) => [name, "wasix-aot"]),
      ...Object.values(TOOLS_AOT_PACKAGES).map((name) => [name, "wasix-tools-aot"]),
    ]);
    const identities = [
      ...runtimeKinds,
      ...expected,
      [`${postgisAot}-part-001`, "wasix-extension-aot"],
      [`${postgisAot}-part-002`, "wasix-extension-aot"],
    ];
    const packages = identities.map(([name, kind]) => {
      const source = path.join(output, "sources", name, "Cargo.toml");
      const crate = path.join(output, `${name}-0.1.0.crate`);
      mkdirSync(path.dirname(source), { recursive: true });
      writeFileSync(source, `[package]\nname = ${JSON.stringify(name)}\nversion = "0.1.0"\n`);
      writeFileSync(crate, `synthetic crate: ${name}\n`);
      return {
        name,
        role: "artifact",
        kind,
        manifestPath: path.relative(ROOT, source),
        cratePath: path.relative(ROOT, crate),
      };
    });
    writeFileSync(path.join(output, "packages.json"), `${JSON.stringify({
      schema: "oliphaunt-liboliphaunt-wasix-cargo-artifacts-v2",
      product: "liboliphaunt-wasix",
      packages,
    }, null, 2)}\n`);

    const validated = validateWasixCargoArtifacts(output);
    expect(validated.map(({ name }) => name).sort())
      .toEqual(identities.map(([name]) => name).sort());
  });
});
