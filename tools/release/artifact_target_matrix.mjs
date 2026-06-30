#!/usr/bin/env bun
import { appendFileSync } from "node:fs";

import {
  allArtifactTargets,
  compareText,
  exactExtensionProducts,
  extensionArtifactTargets,
  fail,
  liboliphauntAndroidAbi,
  liboliphauntNativeBuildRoot,
  liboliphauntNativeCiArtifactRoot,
  publishedExtensionTargetIds,
} from "./release-artifact-targets.mjs";

const PREFIX = "artifact_target_matrix.mjs";

function sortedValue(value) {
  if (Array.isArray(value)) {
    return value.map(sortedValue);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort(compareText)
        .map((key) => [key, sortedValue(value[key])]),
    );
  }
  return value;
}

function printJson(value, { compact = false } = {}) {
  console.log(JSON.stringify(sortedValue(value), null, compact ? 0 : 2));
}

function parseJsonFlag(argv, name) {
  const raw = stringFlag(argv, name);
  if (raw === undefined || raw === "") {
    return undefined;
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    fail(PREFIX, `--${name} must be valid JSON: ${error.message}`);
  }
}

function stringFlag(argv, name) {
  const flag = `--${name}`;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === flag) {
      if (index + 1 >= argv.length) {
        fail(PREFIX, `${flag} requires a value`);
      }
      return argv[index + 1];
    }
    if (value.startsWith(`${flag}=`)) {
      return value.slice(flag.length + 1);
    }
  }
  return undefined;
}

function parseOptions(argv) {
  const options = {
    githubOutput: false,
    nativeTarget: stringFlag(argv, "native-target") ?? "all",
    wasmTarget: stringFlag(argv, "wasm-target") ?? "all",
    selectedTargets: stringSet(parseJsonFlag(argv, "selected-targets-json"), "--selected-targets-json"),
    selectedProducts: stringSet(parseJsonFlag(argv, "selected-products-json"), "--selected-products-json"),
  };
  const knownFlags = new Set([
    "--github-output",
    "--native-target",
    "--wasm-target",
    "--selected-targets-json",
    "--selected-products-json",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    const name = value.includes("=") ? value.slice(0, value.indexOf("=")) : value;
    if (name === "--github-output") {
      options.githubOutput = true;
      continue;
    }
    if (knownFlags.has(name)) {
      if (!value.includes("=")) {
        index += 1;
      }
      continue;
    }
    fail(PREFIX, `unknown argument ${value}`);
  }
  return options;
}

function stringSet(value, label) {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    fail(PREFIX, `${label} must be a JSON string list`);
  }
  return new Set(value);
}

function filterRuntimeMatrix(predicate, { nativeTarget = "all", selectedTargets = undefined, label }) {
  let include = liboliphauntNativeRuntimeMatrix().include.filter((item) => predicate(item.target));
  if (nativeTarget !== "all") {
    include = include.filter((item) => item.target === nativeTarget);
  }
  if (selectedTargets !== undefined) {
    include = include.filter((item) => selectedTargets.has(item.target));
  }
  if (include.length === 0) {
    fail(PREFIX, `no published liboliphaunt-native ${label} targets matched the selected CI plan`);
  }
  return { include };
}

export function liboliphauntNativeRuntimeMatrix() {
  const include = allArtifactTargets(
    {
      product: "liboliphaunt-native",
      kind: "native-runtime",
      publishedOnly: true,
    },
    PREFIX,
  ).map((target) => {
    if (!target.runner) {
      fail(PREFIX, `${target.id} must declare runner`);
    }
    return {
      target: target.target,
      runner: target.runner,
      "build-root": liboliphauntNativeBuildRoot(target.target),
      "ci-artifact-root": liboliphauntNativeCiArtifactRoot(target.target),
    };
  });
  if (include.length === 0) {
    fail(PREFIX, "no published liboliphaunt-native native-runtime targets");
  }
  return { include };
}

export function liboliphauntNativeDesktopRuntimeMatrix(nativeTarget = "all", selectedTargets = undefined) {
  return filterRuntimeMatrix((target) => /^(linux|macos|windows)-/u.test(target), {
    nativeTarget,
    selectedTargets,
    label: "desktop",
  });
}

export function liboliphauntNativeAndroidRuntimeMatrix(nativeTarget = "all", selectedTargets = undefined) {
  return filterRuntimeMatrix((target) => target.startsWith("android-"), {
    nativeTarget,
    selectedTargets,
    label: "Android",
  });
}

export function liboliphauntNativeIosRuntimeMatrix(nativeTarget = "all", selectedTargets = undefined) {
  return filterRuntimeMatrix((target) => target === "ios-xcframework", {
    nativeTarget,
    selectedTargets,
    label: "iOS",
  });
}

export function liboliphauntNativeRuntimeTargetsForSurface(surface) {
  const targets = allArtifactTargets(
    {
      product: "liboliphaunt-native",
      kind: "native-runtime",
      surface,
      publishedOnly: true,
    },
    PREFIX,
  ).map((target) => target.target);
  if (targets.length === 0) {
    fail(PREFIX, `no published liboliphaunt-native native-runtime targets for surface ${surface}`);
  }
  return targets.sort(compareText);
}

export function reactNativeAndroidMobileAppMatrix(nativeTarget = "all", selectedTargets = undefined) {
  const include = [];
  for (const target of allArtifactTargets(
    {
      product: "liboliphaunt-native",
      kind: "native-runtime",
      surface: "react-native-android",
      publishedOnly: true,
    },
    PREFIX,
  )) {
    if (nativeTarget !== "all" && target.target !== nativeTarget) {
      continue;
    }
    if (selectedTargets !== undefined && !selectedTargets.has(target.target)) {
      continue;
    }
    include.push({
      target: target.target,
      abi: liboliphauntAndroidAbi(target.target),
      "build-root": liboliphauntNativeBuildRoot(target.target),
    });
  }
  if (include.length === 0) {
    const validTargets = liboliphauntNativeRuntimeTargetsForSurface("react-native-android").join(", ");
    fail(PREFIX, `no React Native Android app targets matched; expected one of: all, ${validTargets}`);
  }
  include.sort((left, right) => compareText(left.target, right.target));
  return { include };
}

export function extensionArtifactsNativeMatrix(
  nativeTarget = "all",
  selectedTargets = undefined,
  selectedProducts = undefined,
) {
  const runtimeTargets = new Map(
    allArtifactTargets(
      {
        product: "liboliphaunt-native",
        kind: "native-runtime",
        publishedOnly: true,
      },
      PREFIX,
    )
      .filter((target) => target.extensionArtifacts)
      .map((target) => [target.target, target]),
  );
  const byTarget = new Map();
  for (const extensionTarget of extensionArtifactTargets({ family: "native", publishedOnly: true }, PREFIX)) {
    if (selectedProducts !== undefined && !selectedProducts.has(extensionTarget.product)) {
      continue;
    }
    if (nativeTarget !== "all" && extensionTarget.target !== nativeTarget) {
      continue;
    }
    if (selectedTargets !== undefined && !selectedTargets.has(extensionTarget.target)) {
      continue;
    }
    const runtimeTarget = runtimeTargets.get(extensionTarget.target);
    if (!runtimeTarget) {
      fail(
        PREFIX,
        `${extensionTarget.product} declares native extension target ${extensionTarget.target}, but liboliphaunt-native does not publish it`,
      );
    }
    if (!runtimeTarget.runner) {
      fail(PREFIX, `${runtimeTarget.id} must declare runner`);
    }
    const group =
      byTarget.get(extensionTarget.target) ??
      {
        target: extensionTarget.target,
        runner: runtimeTarget.runner,
        buildRoot: liboliphauntNativeBuildRoot(extensionTarget.target),
        ciArtifactRoot: liboliphauntNativeCiArtifactRoot(extensionTarget.target),
        extensions: new Set(),
        sqlNames: new Set(),
      };
    group.extensions.add(extensionTarget.product);
    group.sqlNames.add(extensionTarget.sqlName);
    byTarget.set(extensionTarget.target, group);
  }
  const include = [...byTarget.values()].map((group) => {
    const extensions = [...group.extensions].sort(compareText);
    const sqlNames = [...group.sqlNames].sort(compareText);
    return {
      extensions_csv: extensions.join(","),
      sql_names_csv: sqlNames.join(","),
      extension_count: String(extensions.length),
      target: group.target,
      runner: group.runner,
      "build-root": group.buildRoot,
      "ci-artifact-root": group.ciArtifactRoot,
    };
  });
  if (include.length === 0) {
    const validTargets = publishedExtensionTargetIds({ family: "native" }, PREFIX).join(", ");
    fail(PREFIX, `unknown native extension artifact target ${nativeTarget}; expected one of: all, ${validTargets}`);
  }
  include.sort((left, right) => compareText(left.target, right.target));
  return { include };
}

export function extensionArtifactsWasixMatrix(wasmTarget = "all", selectedProducts = undefined) {
  const byTarget = new Map();
  const extensionTargets = extensionArtifactTargets({ family: "wasix", publishedOnly: true }, PREFIX);
  for (const target of allArtifactTargets(
    {
      product: "liboliphaunt-wasix",
      publishedOnly: true,
    },
    PREFIX,
  )) {
    if (target.kind !== "wasix-runtime") {
      continue;
    }
    const extensionTargetId = target.target === "portable" ? "wasix-portable" : target.target;
    if (wasmTarget !== "all" && target.target !== wasmTarget) {
      continue;
    }
    for (const declared of extensionTargets) {
      if (selectedProducts !== undefined && !selectedProducts.has(declared.product)) {
        continue;
      }
      if (declared.target !== extensionTargetId) {
        continue;
      }
      const group =
        byTarget.get(declared.target) ??
        {
          target: declared.target,
          runner: target.runner ?? "ubuntu-latest",
          runtimeKind: target.kind,
          triple: target.triple ?? "",
          extensions: new Set(),
          sqlNames: new Set(),
        };
      group.extensions.add(declared.product);
      group.sqlNames.add(declared.sqlName);
      byTarget.set(declared.target, group);
    }
  }
  const include = [...byTarget.values()].map((group) => {
    const extensions = [...group.extensions].sort(compareText);
    const sqlNames = [...group.sqlNames].sort(compareText);
    return {
      extensions_csv: extensions.join(","),
      sql_names_csv: sqlNames.join(","),
      extension_count: String(extensions.length),
      target: group.target,
      runner: group.runner,
      "runtime-kind": group.runtimeKind,
      triple: group.triple,
    };
  });
  if (include.length === 0) {
    const validTargets = allArtifactTargets(
      {
        product: "liboliphaunt-wasix",
        publishedOnly: true,
      },
      PREFIX,
    )
      .filter((target) => target.kind === "wasix-runtime")
      .map((target) => target.target)
      .join(", ");
    fail(PREFIX, `unknown WASIX extension artifact target ${wasmTarget}; expected one of: all, ${validTargets}`);
  }
  include.sort((left, right) => compareText(left.target, right.target));
  return { include };
}

export function liboliphauntWasixAotRuntimeMatrix(wasmTarget = "all") {
  const include = [];
  for (const target of allArtifactTargets(
    {
      product: "liboliphaunt-wasix",
      kind: "wasix-aot-runtime",
      publishedOnly: true,
    },
    PREFIX,
  )) {
    if (wasmTarget !== "all" && !new Set([target.target, target.triple]).has(wasmTarget)) {
      continue;
    }
    if (!target.runner) {
      fail(PREFIX, `${target.id} must declare runner`);
    }
    if (!target.triple) {
      fail(PREFIX, `${target.id} must declare triple`);
    }
    if (!target.llvmUrl) {
      fail(PREFIX, `${target.id} must declare llvm_url`);
    }
    include.push({
      os: target.runner,
      target: target.triple,
      target_id: target.target,
      package: `liboliphaunt-wasix-aot-${target.triple}`,
      artifact: `liboliphaunt-wasix-runtime-aot-${target.target}`,
      llvm_url: target.llvmUrl,
    });
  }
  if (include.length === 0) {
    const validTargets = allArtifactTargets(
      {
        product: "liboliphaunt-wasix",
        kind: "wasix-aot-runtime",
        publishedOnly: true,
      },
      PREFIX,
    )
      .map((target) => target.target)
      .join(", ");
    fail(PREFIX, `unknown WASIX AOT runtime target ${wasmTarget}; expected one of: all, ${validTargets}`);
  }
  include.sort((left, right) => compareText(left.target_id, right.target_id));
  return { include };
}

export function brokerRuntimeMatrix(nativeTarget = "all") {
  const matrix = {
    include: allArtifactTargets(
      {
        product: "oliphaunt-broker",
        kind: "broker-helper",
        publishedOnly: true,
      },
      PREFIX,
    ).map((target) => {
      if (!target.runner) {
        fail(PREFIX, `${target.id} must declare runner`);
      }
      return {
        target: target.target,
        runner: target.runner,
      };
    }),
  };
  return filterDesktopRuntimeMatrix(matrix, nativeTarget, "broker");
}

export function nodeDirectRuntimeMatrix(nativeTarget = "all") {
  const matrix = {
    include: allArtifactTargets(
      {
        product: "oliphaunt-node-direct",
        kind: "node-direct-addon",
        publishedOnly: true,
      },
      PREFIX,
    ).map((target) => {
      if (!target.runner) {
        fail(PREFIX, `${target.id} must declare runner`);
      }
      return {
        target: target.target,
        runner: target.runner,
      };
    }),
  };
  return filterDesktopRuntimeMatrix(matrix, nativeTarget, "Node direct");
}

function filterDesktopRuntimeMatrix(matrix, nativeTarget, label) {
  if (matrix.include.length === 0) {
    fail(PREFIX, `no published ${label} targets`);
  }
  if (nativeTarget === "all") {
    return matrix;
  }
  const include = matrix.include.filter((target) => target.target === nativeTarget);
  if (include.length === 0) {
    const validTargets = matrix.include.map((target) => target.target).join(", ");
    fail(PREFIX, `unknown ${label} target ${nativeTarget}; expected one of: all, ${validTargets}`);
  }
  return { include };
}

function matrixByName(name, options) {
  switch (name) {
    case "liboliphaunt-native-runtime":
      return liboliphauntNativeRuntimeMatrix();
    case "liboliphaunt-native-desktop-runtime":
      return liboliphauntNativeDesktopRuntimeMatrix(options.nativeTarget, options.selectedTargets);
    case "liboliphaunt-native-android-runtime":
      return liboliphauntNativeAndroidRuntimeMatrix(options.nativeTarget, options.selectedTargets);
    case "liboliphaunt-native-ios-runtime":
      return liboliphauntNativeIosRuntimeMatrix(options.nativeTarget, options.selectedTargets);
    case "react-native-android-mobile-app":
      return reactNativeAndroidMobileAppMatrix(options.nativeTarget, options.selectedTargets);
    case "extension-artifacts-native":
      return extensionArtifactsNativeMatrix(options.nativeTarget, options.selectedTargets, options.selectedProducts);
    case "extension-artifacts-wasix":
      return extensionArtifactsWasixMatrix(options.wasmTarget, options.selectedProducts);
    case "liboliphaunt-wasix-aot-runtime":
      return liboliphauntWasixAotRuntimeMatrix(options.wasmTarget);
    case "broker-runtime":
      return brokerRuntimeMatrix(options.nativeTarget);
    case "node-direct-runtime":
      return nodeDirectRuntimeMatrix(options.nativeTarget);
    default:
      fail(PREFIX, `unknown matrix ${name}`);
  }
}

function emitGithubOutput(name, value) {
  const rendered = JSON.stringify(sortedValue(value));
  const outputPath = process.env.GITHUB_OUTPUT;
  if (outputPath) {
    appendFileSync(outputPath, `${name}=${rendered}\n`, "utf8");
  }
  console.log(`${name}=${rendered}`);
}

function usage() {
  return `usage: tools/release/artifact_target_matrix.mjs <matrix|exact-extension-products|runtime-targets-for-surface> [options]

Matrices:
  liboliphaunt-native-runtime
  liboliphaunt-native-desktop-runtime
  liboliphaunt-native-android-runtime
  liboliphaunt-native-ios-runtime
  react-native-android-mobile-app
  extension-artifacts-native
  extension-artifacts-wasix
  liboliphaunt-wasix-aot-runtime
  broker-runtime
  node-direct-runtime

Options:
  --github-output
  --native-target TARGET
  --wasm-target TARGET
  --selected-targets-json JSON
  --selected-products-json JSON
  --surface SURFACE
`;
}

function main(argv) {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h") {
    console.log(usage());
    return;
  }
  if (command === "exact-extension-products") {
    printJson(exactExtensionProducts(PREFIX));
    return;
  }
  if (command === "runtime-targets-for-surface") {
    const surface = stringFlag(rest, "surface");
    if (!surface) {
      fail(PREFIX, "runtime-targets-for-surface requires --surface");
    }
    printJson(liboliphauntNativeRuntimeTargetsForSurface(surface));
    return;
  }
  const options = parseOptions(rest);
  const matrix = matrixByName(command, options);
  if (options.githubOutput) {
    emitGithubOutput("matrix", matrix);
  } else {
    printJson(matrix);
  }
}

if (import.meta.main) {
  main(Bun.argv.slice(2));
}
