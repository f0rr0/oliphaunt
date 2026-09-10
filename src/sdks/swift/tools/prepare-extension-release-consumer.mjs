import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export function prepareExtensionReleaseConsumer({ plan, productsFile, releasePackage, carrier, extensionCarriers, cache, output }) {
  const products = JSON.parse(readFileSync(productsFile, "utf8"));
  const selected = products.selected;
  assert(Array.isArray(selected) && selected.length > 0, "consumer requires selected extensions");
  assert.deepEqual(selected.map(row => row.sqlName).sort(), plan.extensions);
  assert.deepEqual([...new Set(selected.map(row => row.product))].sort(), plan.extensionProducts);
  assert.equal(products.nativeRuntime.product, plan.finalLink.runtimeProduct);
  assert.equal(products.nativeRuntime.version, plan.finalLink.runtimeVersion);
  if (plan.finalLink.kind === "native-extension") {
    const native = selected.find(row => row.sqlName === plan.finalLink.nativeExtension);
    assert(native && native.nativeModuleStem === plan.finalLink.nativeModuleStem, "missing planned native extension");
  } else {
    assert.equal(plan.finalLink.kind, "base-runtime");
    assert(selected.every(row => row.nativeModuleStem === null), "SQL-only proof contains a native extension");
  }
  const carriers = extensionCarriers.map(file => ({ file, document: JSON.parse(readFileSync(file, "utf8")) }));
  const byName = new Map(selected.map(row => [row.sqlName, row]));
  const packageDependencies = [`.package(name: "oliphaunt", path: ${JSON.stringify(releasePackage)})`];
  const targetDependencies = [`.product(name: "Oliphaunt", package: "oliphaunt")`];
  const imports = ["import Foundation", "import Oliphaunt"];
  const descriptors = [];
  const sqlNames = [];
  for (const row of selected) {
    assert.match(row.sqlName, /^[A-Za-z0-9_-]+$/u);
    assert.match(row.product, /^oliphaunt-extension-[A-Za-z0-9-]+$/u);
    assert.match(row.swiftProduct, /^OliphauntExtension[A-Za-z0-9]+$/u);
    assert.equal(typeof row.createsExtension, "boolean");
    if (row.product === "oliphaunt-extension-contrib-pg18") {
      const stem = row.swiftProduct.slice("OliphauntExtension".length);
      descriptors.push(`OliphauntExtensions.${stem[0].toLowerCase()}${stem.slice(1)}`);
    } else {
      const required = new Set();
      const visit = name => {
        if (required.has(name)) return;
        required.add(name);
        for (const dependency of byName.get(name).dependencies) visit(dependency);
      };
      visit(row.sqlName);
      const selectedCarriers = carriers.filter(({ document }) => document.entries.some(entry => required.has(entry.sqlName)));
      const directory = path.join(output, "packages", row.product);
      const result = spawnSync(process.execPath, [
        path.join(import.meta.dirname, "render-extension-products.mjs"),
        "--carrier", carrier,
        ...selectedCarriers.flatMap(({ file }) => ["--extension-carrier", file]),
        "--extensions", row.sqlName, "--release-product", row.product,
        "--base-package-path", releasePackage,
        "--base-package-version", products.basePackage.version,
        "--cache-dir", cache, "--offline", "--allow-file-urls", "--local-binary-targets", "--output-dir", directory,
      ], { stdio: "inherit" });
      assert.equal(result.status, 0, `generate independent package ${row.product}: ${result.error ?? result.signal ?? result.status}`);
      packageDependencies.push(`.package(name: ${JSON.stringify(row.product)}, path: ${JSON.stringify(directory)})`);
      targetDependencies.push(`.product(name: ${JSON.stringify(row.swiftProduct)}, package: ${JSON.stringify(row.product)})`);
      imports.push(`import ${row.swiftProduct}`);
      descriptors.push(`${row.swiftProduct}.descriptor`);
    }
    if (row.createsExtension) sqlNames.push(row.sqlName);
  }
  // Always exercise a bundled contrib descriptor alongside standalone packages.
  if (!selected.some(row => row.sqlName === "hstore")) {
    descriptors.push("OliphauntExtensions.hstore");
    sqlNames.push("hstore");
  }
  const source = path.join(output, "Sources", "OliphauntExtensionReleaseConsumer");
  mkdirSync(source, { recursive: true });
  writeFileSync(path.join(output, "Package.swift"), `// swift-tools-version: 6.0
import PackageDescription
let package = Package(name: "OliphauntExtensionReleaseConsumer", platforms: [.macOS(.v14)],
    dependencies: [${packageDependencies.join(",\n        ")}],
    targets: [.executableTarget(name: "OliphauntExtensionReleaseConsumer", dependencies: [${targetDependencies.join(", ")}])])
`);
  const migration = sqlNames.map(name => `CREATE EXTENSION IF NOT EXISTS "${name}" CASCADE;`).join(" ");
  writeFileSync(path.join(source, "main.swift"), `${imports.join("\n")}
let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
defer { try? FileManager.default.removeItem(at: root) }
let configuration = OliphauntConfiguration(storage: .directory(root), extensions: [${descriptors.join(", ")}])
for attempt in 0..<2 {
    let database = try await OliphauntDatabase.open(configuration: configuration)
    do {
        if attempt == 0 { try await database.exec(${JSON.stringify(migration)}) }
        let installed = try await database.query("SELECT extname::text AS name FROM pg_extension")
        let names = try Set(installed.rows.map { row -> String in
            guard let name: String = try row.value(named: "name") else { fatalError("null extension name") }
            return name
        })
        precondition(Set(${JSON.stringify(sqlNames)}).isSubset(of: names), "extension migrations did not survive reopen")
        try await database.close()
    } catch {
        try? await database.close()
        throw error
    }
}
print("OLIPHAUNT_SWIFT_EXTENSION_DATABASE_PASS checks=independent-packages,descriptors,contrib,migrations,reopen,close")
`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  prepareExtensionReleaseConsumer(JSON.parse(readFileSync(process.argv[2], "utf8")));
}
