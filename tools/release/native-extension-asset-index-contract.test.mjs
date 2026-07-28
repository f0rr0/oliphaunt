import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
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
const PRODUCER = path.join(
  ROOT,
  "src/extensions/artifacts/native/tools/package-release-assets.sh",
);

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

test("the shell producer obtains its header and runtime kind from the canonical contract", () => {
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

  const producer = readFileSync(PRODUCER, "utf8");
  expect(producer).toContain(
    'native_asset_index_contract="tools/release/native-extension-asset-index-contract.mjs"',
  );
  expect(producer).toContain(
    'native_extension_runtime_kind="$(bun "$native_asset_index_contract" runtime-kind)"',
  );
  expect(producer).toContain('bun "$native_asset_index_contract" header >"$native_asset_index"');
  expect(
    producer.match(
      /append_native_asset_index_row "\$sql_name" "\$native_extension_runtime_kind" "\$runtime_artifact"/gu,
    ) ?? [],
  ).toHaveLength(3);
  expect(producer).not.toContain(
    'append_native_asset_index_row "$sql_name" runtime "$runtime_artifact"',
  );
  expect(producer).not.toContain(
    "printf 'sql_name\\ttarget\\tkind\\tidentity\\tartifact\\tartifact_bytes\\tregistration_artifact",
  );
});

test("the desktop producer requires and forwards the native-direct module profile", () => {
  const producer = readFileSync(PRODUCER, "utf8");
  expect(producer).toContain("host_extension_embedded_modules_root()");
  expect(producer).toContain(
    'embedded_modules="$(host_extension_embedded_modules_root)"',
  );
  expect(producer).toContain(
    'require_dir "$embedded_modules" "$target_id embedded extension modules"',
  );
  expect(producer).toContain('--embedded-module-root "$embedded_modules"');
  expect(producer).toContain(
    '${profile_args[@]+"${profile_args[@]}"}',
  );
  expect(producer).not.toContain('\n      "${profile_args[@]}"\n');
});
