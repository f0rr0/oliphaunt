import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  packageExtensionCargoFacades,
  renderUnsupportedNativeGuard,
} from "./package-extension-cargo-facades.mjs";

const directories = [];

afterEach(() => {
  while (directories.length > 0) rmSync(directories.pop(), { recursive: true, force: true });
});

describe("exact extension Cargo facade", () => {
  test("fails closed for unsupported default-native targets while WASIX opt-out compiles", () => {
    const output = mkdtempSync(path.join(import.meta.dir, "../../target/extension-facade-test-"));
    directories.push(output);
    const [pkg] = packageExtensionCargoFacades(["oliphaunt-extension-pgtap"], output);
    const source = path.join(output, "sources/oliphaunt-extension-pgtap/src/lib.rs");
    const text = readFileSync(source, "utf8");
    expect(text).toContain("compile_error!");
    expect(text).toContain("default-features = false");
    expect(text).toContain('feature = "native"');
    expect(text).toContain('target_env = "gnu"');
    expect(text).toContain('target_env = "msvc"');

    const forcedUnsupportedSource = path.join(output, "forced-unsupported.rs");
    writeFileSync(forcedUnsupportedSource, `#![forbid(unsafe_code)]
${renderUnsupportedNativeGuard("fixture-extension", ["fixture-unsupported"], ["any()"]) }
pub const FIXTURE: bool = true;
`);
    const unsupported = spawnSync("rustc", [
      "--crate-name", "oliphaunt_extension_pgtap",
      "--crate-type", "lib",
      "--edition", "2024",
      "--cfg", 'feature="native"',
      forcedUnsupportedSource,
    ], { encoding: "utf8" });
    expect(unsupported.status).not.toBe(0);
    expect(unsupported.stderr).toContain("default native feature supports only");

    const wasixOnly = spawnSync("rustc", [
      "--crate-name", "oliphaunt_extension_pgtap",
      "--crate-type", "lib",
      "--edition", "2024",
      "--cfg", 'feature="wasix"',
      "--emit", "metadata",
      "-o", path.join(output, "wasix-only.rmeta"),
      forcedUnsupportedSource,
    ], { encoding: "utf8" });
    expect(wasixOnly.status).toBe(0);

    const manifest = Bun.TOML.parse(readFileSync(pkg.manifestPath, "utf8"));
    expect(manifest.features.default).toEqual(["native"]);
    expect(manifest.features.wasix).toEqual([`dep:oliphaunt-extension-pgtap-wasix`]);
    expect(pkg.cratePath.endsWith(".crate")).toBe(true);
  });
});
