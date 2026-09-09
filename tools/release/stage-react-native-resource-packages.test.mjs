import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { stageReactNativeResourcePackages } from "./stage-react-native-resource-packages.mjs";
import { extensionSqlNames } from "./release-artifact-targets.mjs";

test("mobile source qualification stages installed package ownership independently of database selection", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mobile-resource-packages-"));
  try {
    const contrib = "oliphaunt-extension-contrib-pg18";
    const vector = "oliphaunt-extension-vector";
    const rows = product => extensionSqlNames(product).map(sqlName => ({ product, sqlName, version: "0.2.0" }));
    const carrier = {
      base: { version: "0.2.0" }, extensions: [...rows(contrib), ...rows(vector)],
      carriers: [{ product: contrib }, { product: vector }],
      legal: { extensions: [...rows(contrib), ...rows(vector)] },
    };
    const project = path.join(root, "app");
    mkdirSync(project);
    const workspace = path.join(root, "pnpm-workspace.yaml");
    writeFileSync(workspace, 'packages: ["app"]\n');
    writeFileSync(path.join(project, "package.json"), JSON.stringify({ dependencies: { react: "19.0.0", "@oliphaunt/extension-pgtap": "0.1.0" } }));
    const args = { carrier, selected: ["vector"], icu: false, outputDir: path.join(root, "packages"), project, workspace };
    const dependencies = stageReactNativeResourcePackages(args);
    expect(Object.keys(dependencies).sort()).toEqual(["@oliphaunt/extension-contrib-pg18", "@oliphaunt/extension-vector"]);
    const manifest = JSON.parse(readFileSync(path.join(project, "package.json"), "utf8"));
    expect(manifest.dependencies.react).toBe("19.0.0");
    expect(manifest.dependencies["@oliphaunt/extension-pgtap"]).toBeUndefined();
    expect(Bun.YAML.parse(readFileSync(workspace, "utf8")).overrides).toEqual(dependencies);
    const vectorPackage = JSON.parse(readFileSync(path.join(root, "packages", vector, "package.json"), "utf8"));
    expect(vectorPackage.oliphaunt.members).toEqual(["vector"]);
    expect(vectorPackage.exports["."]["react-native"]).toBeDefined();
    const installed = JSON.parse(readFileSync(path.join(root, "packages", contrib, "package.json"), "utf8"));
    expect(installed.oliphaunt.members).toEqual(extensionSqlNames(contrib).sort());
    expect(Object.keys(stageReactNativeResourcePackages({ ...args, selected: [] }))).toEqual(["@oliphaunt/extension-contrib-pg18"]);
    stageReactNativeResourcePackages({ ...args, carrier: undefined, platform: "android" });
    const androidPackage = JSON.parse(readFileSync(path.join(root, "packages", vector, "package.json"), "utf8"));
    expect(androidPackage.exports["."]["react-native"]).toBeDefined();
    expect(androidPackage.exports["./ios-carriers"]).toBeUndefined();
    expect(() => stageReactNativeResourcePackages({ ...args, selected: ["missing"] })).toThrow("missing selected carrier");
    expect(() => stageReactNativeResourcePackages({ ...args, carrier: { ...carrier, extensions: rows(vector) } })).toThrow("missing the base contrib");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
