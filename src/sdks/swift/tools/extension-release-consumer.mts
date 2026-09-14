import path from 'node:path';
const [command, input] = Bun.argv.slice(2);
if (command === 'write-consumer') {
  const plan = JSON.parse(process.env.OLIPHAUNT_CARRIER_PLAN);
  const products = JSON.parse(await Bun.file(process.env.OLIPHAUNT_EXTENSION_PRODUCTS).text());
  if (!Array.isArray(products.selected) || products.selected.length === 0) {
    throw new Error('generated extension package selected no products');
  }
  const selected = products.selected.map((row, index) => {
    const swiftProduct = row?.swiftProduct;
    if (typeof swiftProduct !== 'string' || !/^[A-Za-z][A-Za-z0-9]*$/u.test(swiftProduct)) {
      throw new Error(
        `generated extension package selected[${index}] has an invalid Swift product name`,
      );
    }
    if (typeof row.sqlName !== 'string' || !/^[A-Za-z0-9._-]+$/u.test(row.sqlName)) {
      throw new Error(`generated extension package selected[${index}] has an invalid SQL name`);
    }
    if (
      typeof row.product !== 'string' ||
      !/^oliphaunt-extension-[A-Za-z0-9._-]+$/u.test(row.product)
    ) {
      throw new Error(
        `generated extension package selected[${index}] has an invalid release product`,
      );
    }
    if (
      row.nativeModuleStem !== null &&
      (typeof row.nativeModuleStem !== 'string' || !/^[A-Za-z0-9._-]+$/u.test(row.nativeModuleStem))
    ) {
      throw new Error(
        `generated extension package selected[${index}] has an invalid native module stem`,
      );
    }
    return {
      nativeModuleStem: row.nativeModuleStem,
      product: row.product,
      sqlName: row.sqlName,
      swiftProduct,
    };
  });
  if (new Set(selected.map(({ swiftProduct }) => swiftProduct)).size !== selected.length) {
    throw new Error('generated extension package repeats a Swift product name');
  }
  if (new Set(selected.map(({ sqlName }) => sqlName)).size !== selected.length) {
    throw new Error('generated extension package repeats an extension SQL name');
  }
  const actualExtensions = selected.map(({ sqlName }) => sqlName).sort();
  if (JSON.stringify(actualExtensions) !== JSON.stringify(plan.extensions)) {
    throw new Error(
      'generated extension package does not exactly cover the carrier-planned extension set',
    );
  }
  const actualProducts = [...new Set(selected.map(({ product }) => product))].sort();
  if (JSON.stringify(actualProducts) !== JSON.stringify(plan.extensionProducts)) {
    throw new Error(
      'generated extension package does not exactly cover the carrier-planned release products',
    );
  }
  if (
    products.nativeRuntime?.product !== plan.finalLink.runtimeProduct ||
    products.nativeRuntime?.version !== plan.finalLink.runtimeVersion
  ) {
    throw new Error(
      'generated extension package native runtime identity differs from the final-link plan',
    );
  }
  let finalLink = null;
  if (plan.finalLink.kind === 'native-extension') {
    finalLink = selected.find(({ sqlName }) => sqlName === plan.finalLink.nativeExtension) ?? null;
    if (finalLink === null || finalLink.nativeModuleStem !== plan.finalLink.nativeModuleStem) {
      throw new Error(
        `generated extension package is missing the planned native final-link extension ${plan.finalLink.nativeExtension}/${plan.finalLink.nativeModuleStem}`,
      );
    }
  } else if (plan.finalLink.kind === 'base-runtime') {
    if (
      plan.finalLink.nativeExtension !== null ||
      plan.finalLink.nativeModuleStem !== null ||
      selected.some(({ nativeModuleStem }) => nativeModuleStem !== null)
    ) {
      throw new Error(
        'base-runtime final-link proof requires an entirely SQL-only extension selection',
      );
    }
  } else {
    throw new Error(`unknown final-link proof kind ${plan.finalLink.kind}`);
  }
  const packagePath = JSON.stringify(path.resolve(process.env.OLIPHAUNT_SELECTED_PACKAGE));
  const releasePackagePath = JSON.stringify(path.resolve(process.env.OLIPHAUNT_RELEASE_PACKAGE));
  const dependencies = [
    `.product(name: "COliphaunt", package: "oliphaunt")`,
    ...selected.map(
      ({ swiftProduct }) =>
        `.product(name: ${JSON.stringify(swiftProduct)}, package: "selectedExtensions")`,
    ),
  ].join(', ');
  const packageFile =
    `// swift-tools-version: 6.0\n\n` +
    `import PackageDescription\n\n` +
    `let package = Package(\n` +
    `    name: "OliphauntExtensionReleaseConsumer",\n` +
    `    platforms: [.macOS(.v14)],\n` +
    `    dependencies: [\n` +
    `        .package(name: "oliphaunt", path: ${releasePackagePath}),\n` +
    `        .package(name: "selectedExtensions", path: ${packagePath})\n` +
    `    ],\n` +
    `    targets: [\n` +
    `        .executableTarget(\n` +
    `            name: "OliphauntExtensionReleaseConsumer",\n` +
    `            dependencies: [${dependencies}]\n` +
    `        )\n` +
    `    ]\n` +
    `)\n`;
  const runtimeVersion = JSON.stringify(plan.finalLink.runtimeVersion);
  const nativeAssertion =
    finalLink === null
      ? `print("OLIPHAUNT_SWIFT_BASE_RUNTIME_LINK_PASS runtime=\\(linkedNativeRuntimeVersion!) products=${selected.length}")\n`
      : `precondition(${finalLink.swiftProduct}.sqlName == ${JSON.stringify(finalLink.sqlName)} && ${finalLink.swiftProduct}.product == ${JSON.stringify(finalLink.product)}, "planned native extension identity mismatch")\n` +
        `print("OLIPHAUNT_SWIFT_NATIVE_EXTENSION_LINK_PASS extension=${finalLink.sqlName} native_module=${finalLink.nativeModuleStem} runtime=\\(linkedNativeRuntimeVersion!) products=${selected.length}")\n`;
  const main =
    `import COliphaunt\n${selected.map(({ swiftProduct }) => `import ${swiftProduct}`).join('\n')}\n\n` +
    `${selected.map(({ swiftProduct }) => `try ${swiftProduct}.register()`).join('\n')}\n` +
    `let linkedNativeRuntimeVersion = oliphaunt_version().map { String(cString: $0) }\n` +
    `precondition(linkedNativeRuntimeVersion == ${runtimeVersion}, "linked liboliphaunt runtime version mismatch")\n` +
    nativeAssertion;
  await Bun.write(
    path.join(process.env.OLIPHAUNT_EXTENSION_CONSUMER, 'Package.swift'),
    packageFile,
  );
  await Bun.write(
    path.join(
      process.env.OLIPHAUNT_EXTENSION_CONSUMER,
      'Sources',
      'OliphauntExtensionReleaseConsumer',
      'main.swift',
    ),
    main,
  );
} else {
  const plan = JSON.parse(input);
  const value = {
    extensions: plan.extensionsCsv,
    extension: plan.finalLink.nativeExtension ?? '',
    kind: plan.finalLink.kind,
    version: plan.finalLink.runtimeVersion,
  }[command];
  if (typeof value !== 'string') throw Error('unknown Swift release consumer command');
  process.stdout.write(value);
}
