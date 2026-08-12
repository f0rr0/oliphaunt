#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

import {
  loadSwiftExtensionInventoryCatalog,
  validateSwiftExtensionResourceArtifact,
} from "./extension-resource-inventory.mjs";
import {
  validateSelection,
  writeGenerated,
} from "./render-extension-products.mjs";

function fail(message) {
  throw new Error(`render-extension-products.test-driver.mjs: ${message}`);
}

function parseArgs(argv) {
  const args = { allowFileUrls: false, localBinaryTargets: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--allow-file-urls" || arg === "--local-binary-targets") {
      if (arg === "--allow-file-urls") args.allowFileUrls = true;
      else args.localBinaryTargets = true;
      continue;
    }
    if (!["--selection", "--output-dir", "--base-package-path"].includes(arg)) {
      fail(`unknown argument ${arg}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) fail(`${arg} requires a value`);
    index += 1;
    if (arg === "--selection") args.selection = path.resolve(value);
    if (arg === "--output-dir") args.outputDir = path.resolve(value);
    if (arg === "--base-package-path") args.basePackagePath = path.resolve(value);
  }
  if (!args.selection || !args.outputDir) fail("--selection and --output-dir are required");
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const input = JSON.parse(await fs.readFile(args.selection, "utf8"));
  const selection = validateSelection(input, path.dirname(args.selection), {
    allowFileUrls: args.allowFileUrls,
    localBinaryTargets: args.localBinaryTargets,
  });
  const catalog = await loadSwiftExtensionInventoryCatalog();
  if (args.basePackagePath !== undefined) {
    const manifest = path.join(args.basePackagePath, "Package.swift");
    if ((await fs.stat(manifest).catch(() => null))?.isFile() !== true) {
      fail(`--base-package-path does not contain Package.swift: ${args.basePackagePath}`);
    }
  }
  for (const extension of selection.extensions) {
    extension.resources = await validateSwiftExtensionResourceArtifact({
      extension,
      canonical: catalog.get(extension.sqlName),
      nativeRuntime: selection.nativeRuntime,
      label: `${extension.sqlName} resource artifact`,
      allowMobileCarrierArchives: false,
    });
  }
  await writeGenerated(
    selection,
    args.outputDir,
    args.basePackagePath,
    args.localBinaryTargets,
    [
      { label: "working directory", mode: "containment", path: process.cwd() },
      { label: "selection fixture", mode: "containment", path: args.selection },
      { label: "base package", mode: "disjoint", path: args.basePackagePath },
      ...selection.extensions.flatMap((extension) => [
        { label: `${extension.sqlName} resource root`, mode: "disjoint", path: extension.resourceRoot },
        { label: `${extension.sqlName} XCFramework`, mode: "disjoint", path: extension.asset?.localPath },
        ...extension.nativeDependencies.map((dependency) => ({
          label: `${dependency.name} XCFramework`,
          mode: "disjoint",
          path: dependency.asset.localPath,
        })),
      ]),
    ].filter(({ path: protectedPath }) => protectedPath !== undefined),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
