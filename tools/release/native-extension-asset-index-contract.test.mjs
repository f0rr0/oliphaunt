import { expect, test } from "bun:test";
import path from "node:path";
import { spawnSync } from "../test/fd-backed-spawn-sync.mjs";

import {
  NATIVE_EXTENSION_ASSET_INDEX_HEADER,
  NATIVE_EXTENSION_RUNTIME_KIND,
  isCanonicalNativeExtensionRuntimeIndexRow,
  nativeExtensionAssetIndexHeaderTsv,
  nativeExtensionRuntimeKind,
} from "./native-extension-asset-index-contract.mjs";

const ROOT = path.resolve(import.meta.dir, "../..");
const CONTRACT = path.join(ROOT, "tools/release/native-extension-asset-index-contract.mjs");

test("the raw native extension index uses the canonical runtime carrier kind", () => {
  expect(NATIVE_EXTENSION_ASSET_INDEX_HEADER).toEqual([
    "sql_name",
    "target",
    "kind",
    "identity",
    "artifact",
    "artifact_bytes",
    "registration_artifact",
  ]);
  expect(NATIVE_EXTENSION_RUNTIME_KIND).toBe("runtime");
  const canonical = {
    sql_name: "amcheck",
    target: "linux-x64-gnu",
    kind: "runtime",
    identity: "-",
    artifact: "amcheck.tar.gz",
    artifact_bytes: "1",
    registration_artifact: "-",
  };
  expect(isCanonicalNativeExtensionRuntimeIndexRow(canonical, "linux-x64-gnu")).toBe(true);
  expect(isCanonicalNativeExtensionRuntimeIndexRow({
    ...canonical,
    kind: "runtime-extension",
  }, "linux-x64-gnu")).toBe(false);
});

test("the canonical contract exposes its header and runtime kind through the CLI", () => {
  expect(nativeExtensionAssetIndexHeaderTsv()).toBe(NATIVE_EXTENSION_ASSET_INDEX_HEADER.join("\t"));
  expect(nativeExtensionRuntimeKind()).toBe(NATIVE_EXTENSION_RUNTIME_KIND);

  for (const [command, expected] of [
    ["header", `${nativeExtensionAssetIndexHeaderTsv()}\n`],
    ["runtime-kind", `${nativeExtensionRuntimeKind()}\n`],
  ]) {
    const execution = spawnSync(process.execPath, [CONTRACT, command], { encoding: "utf8" });
    expect(execution.status).toBe(0);
    expect(execution.stderr).toBe("");
    expect(execution.stdout).toBe(expected);
  }
});
