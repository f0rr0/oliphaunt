import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "../test/fd-backed-spawn-sync.mjs";
import test from "node:test";

const ROOT = path.resolve(import.meta.dir, "../..");

function workflowStep(name) {
  const workflow = readFileSync(path.join(ROOT, ".github/workflows/release.yml"), "utf8");
  const marker = `      - name: ${name}\n`;
  const start = workflow.indexOf(marker);
  assert.notEqual(start, -1, `missing workflow step ${name}`);
  const end = workflow.indexOf("\n      - name: ", start + marker.length);
  return workflow.slice(start, end === -1 ? workflow.length : end);
}

test("Swift staging creates a selection-neutral embedded carrier", () => {
  const builder = readFileSync(path.join(ROOT, "tools/release/build-sdk-ci-artifacts.mjs"), "utf8");
  const stageStart = builder.indexOf("function stageSwiftArtifacts(");
  const stageEnd = builder.indexOf("\nfunction ", stageStart + 1);
  assert.notEqual(stageStart, -1);
  const stageSwift = builder.slice(stageStart, stageEnd === -1 ? builder.length : stageEnd);
  assert.match(stageSwift, /buildIosCarrierManifest\(\{[\s\S]*?extensionManifests: \[\],/u);
});

test("the release workflow preserves the embedded carrier and validates independent extension carriers", () => {
  const step = workflowStep("Freeze canonical Apple extension carrier input");
  assert.doesNotMatch(step, /carrier_destination|\bcp\b/u);
  assert.match(
    step,
    /swift_source_carrier=target\/sdk-artifacts\/oliphaunt-swift\/release-tree\/src\/sdks\/swift\/Carriers\/oliphaunt-react-native-ios-carriers\.json/u,
  );
  assert.match(step, /--family extension-artifacts/u);
  assert.match(
    step,
    /product_root="target\/extension-artifacts\/\$product"[\s\S]*?find "\$product_root\/release-assets"[^\n]*\*-swift-extension-carrier\.json/u,
  );
  assert.doesNotMatch(step, /find target\/extension-artifacts/u);
  assert.match(step, /extension_carrier_args\+=\(--extension-carrier/u);
  assert.match(step, /cmp -s "\$swift_source_carrier" "\$react_native_source_carrier"/u);
  assert.match(
    step,
    /render-extension-products\.mjs[\s\S]*?--carrier "\$swift_source_carrier"[\s\S]*?"\$\{extension_carrier_args\[@\]\}"/u,
  );
});

test("the release workflow projects extension roots to the selected release products", () => {
  for (const name of ["Assemble exact candidate Cargo registry", "Freeze exhaustive publication lock"]) {
    const step = workflowStep(name);
    assert.match(step, /--family extension-artifacts/u);
    assert.match(step, /artifact_root="target\/extension-artifacts\/\$product"/u);
    assert.doesNotMatch(step, /^\s*target\/extension-artifacts\s*\\?$/mu);
  }

  const selected = [
    "oliphaunt-swift",
    "oliphaunt-extension-pgtap",
    "oliphaunt-extension-postgis",
  ];
  const result = spawnSync(process.execPath, [
    path.join(ROOT, "tools/release/release_graph_query.mjs"),
    "ci-products",
    "--family",
    "extension-artifacts",
    "--products-json",
    JSON.stringify(selected),
    "--format",
    "lines",
  ], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const projected = result.stdout.trim().split(/\r?\n/u).filter(Boolean);
  assert.deepEqual(new Set(projected), new Set(selected.filter((product) => product.includes("-extension-"))));
});
