#!/usr/bin/env bun
// Source qualification uses the same descriptor package writer as publication.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { nativeExtensionCarrierLegal, writeExtensionMetaPackage } from "./package-extension-release-carriers.mjs";
import { currentProductVersionSync } from "./release-artifact-targets.mjs";
import { stageLiboliphauntIcuNpmPayload } from "./package-release-carriers.mjs";

export function stageReactNativeResourcePackages({ carrier, selected, icu, outputDir, project, workspace, platform = "ios" }) {
  if (platform !== "ios" && platform !== "android") throw new Error(`unsupported mobile platform: ${platform}`);
  if (platform === "android") {
    const metadata = JSON.parse(readFileSync(new URL("../../src/extensions/generated/sdk/extensions.json", import.meta.url), "utf8"));
    carrier = {
      base: { version: currentProductVersionSync("liboliphaunt-native", "mobile source qualification") },
      extensions: metadata.extensions.map(row => ({
        product: row["artifact-product"], sqlName: row["sql-name"],
        version: currentProductVersionSync(row["release-product"], "mobile source qualification"),
      })),
    };
  }
  const wanted = new Set(selected);
  const products = new Map();
  for (const row of carrier.extensions) {
    if (!wanted.has(row.sqlName) && row.product !== "oliphaunt-extension-contrib-pg18") continue;
    const rows = products.get(row.product) ?? [];
    rows.push(row);
    products.set(row.product, rows);
  }
  for (const name of wanted) {
    if (!carrier.extensions.some(row => row.sqlName === name)) throw new Error(`missing selected carrier: ${name}`);
  }
  if (!products.has("oliphaunt-extension-contrib-pg18")) throw new Error("source carrier is missing the base contrib bundle");
  const dependencies = {};
  for (const [product, rows] of products) {
    // Bundle packages must retain every member, regardless of per-database selection.
    const members = carrier.extensions.filter(row => row.product === product);
    if (new Set(members.map(row => row.version)).size !== 1) throw new Error(`conflicting versions of ${product}`);
    const version = rows[0].version;
    const sqlNames = members.map(row => row.sqlName).sort();
    const directory = path.join(outputDir, product);
    writeExtensionMetaPackage(directory, {
      product, version, members: sqlNames,
      // Mobile payloads come from the same candidate through Gradle or SwiftPM.
      targets: [],
      iosCarrier: platform === "android" ? undefined : {
        ...carrier, extensions: members,
        carriers: carrier.carriers.filter(row => row.product === product),
        legal: { ...carrier.legal, extensions: carrier.legal.extensions.filter(row => sqlNames.includes(row.sqlName)) },
      },
      liboliphauntVersion: carrier.base.version,
      runtimeBound: product === "oliphaunt-extension-contrib-pg18",
      legal: nativeExtensionCarrierLegal(product, sqlNames, { carriesPayload: false }),
    });
    dependencies[`@oliphaunt/${product.slice("oliphaunt-".length)}`] = `file:${directory}`;
  }
  if (icu) dependencies["@oliphaunt/icu"] = `file:${stageLiboliphauntIcuNpmPayload(carrier.base.version, { seedTargets: [`${platform}-datum64`] })}`;
  const file = path.join(project, "package.json");
  const manifest = JSON.parse(readFileSync(file, "utf8"));
  // Remove resource dependencies from a previous smoke selection in this scratch app.
  for (const name of Object.keys(manifest.dependencies ?? {})) {
    if (name.startsWith("@oliphaunt/extension-") || name === "@oliphaunt/icu") delete manifest.dependencies[name];
  }
  manifest.dependencies = { ...manifest.dependencies, ...dependencies };
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
  const settings = Bun.YAML.parse(readFileSync(workspace, "utf8"));
  for (const name of Object.keys(settings.overrides ?? {})) {
    if (name.startsWith("@oliphaunt/extension-") || name === "@oliphaunt/icu") delete settings.overrides[name];
  }
  settings.overrides = { ...settings.overrides, ...dependencies };
  writeFileSync(workspace, Bun.YAML.stringify(settings));
  return dependencies;
}

if (import.meta.main) {
  const [carrierFile, selection, icu, outputDir, project, workspace] = process.argv.slice(2);
  if (!workspace) throw new Error("usage: stage-react-native-resource-packages.mjs CARRIER EXTENSIONS ICU OUTPUT PROJECT WORKSPACE_YAML");
  stageReactNativeResourcePackages({
    carrier: carrierFile === "android" ? undefined : JSON.parse(readFileSync(carrierFile, "utf8")),
    platform: carrierFile === "android" ? "android" : "ios",
    selected: selection.split(",").filter(Boolean), icu: ["1", "true", "yes", "on"].includes(icu.toLowerCase()),
    outputDir: path.resolve(outputDir), project: path.resolve(project), workspace: path.resolve(workspace),
  });
}
