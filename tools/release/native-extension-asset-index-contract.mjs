export const NATIVE_EXTENSION_ASSET_INDEX_HEADER = Object.freeze([
  "sql_name",
  "target",
  "kind",
  "identity",
  "artifact",
  "artifact_bytes",
  "registration_artifact",
]);

export const NATIVE_EXTENSION_RUNTIME_KIND = "runtime";

export function nativeExtensionAssetIndexHeaderTsv() {
  return NATIVE_EXTENSION_ASSET_INDEX_HEADER.join("\t");
}

export function nativeExtensionRuntimeKind() {
  return NATIVE_EXTENSION_RUNTIME_KIND;
}

export function isCanonicalNativeExtensionRuntimeIndexRow(row, target) {
  return row?.target === target
    && row.kind === NATIVE_EXTENSION_RUNTIME_KIND
    && row.identity === "-"
    && row.registration_artifact === "-";
}

function main(args) {
  const [command, ...rest] = args;
  if (rest.length !== 0) {
    throw new Error(`${command ?? "command"} does not accept arguments`);
  }
  switch (command) {
    case "header":
      process.stdout.write(`${nativeExtensionAssetIndexHeaderTsv()}\n`);
      return;
    case "runtime-kind":
      process.stdout.write(`${nativeExtensionRuntimeKind()}\n`);
      return;
    default:
      throw new Error("usage: native-extension-asset-index-contract.mjs <header|runtime-kind>");
  }
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exitCode = 1;
  }
}
