import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(import.meta.dir, "../..");

function read(relative) {
  return readFileSync(path.join(ROOT, relative), "utf8");
}

function workflowStep(name) {
  const workflow = read(".github/workflows/ci.yml");
  const marker = `      - name: ${name}\n`;
  const start = workflow.indexOf(marker);
  assert.notEqual(start, -1, `missing CI workflow step ${name}`);
  const end = workflow.indexOf("\n      - name: ", start + marker.length);
  return workflow.slice(start, end === -1 ? workflow.length : end);
}

test("hosted macOS validates the selection-neutral Swift source carrier with repeated independent releases", () => {
  const step = workflowStep("Run exact-extension Swift release consumer");
  assert.match(
    step,
    /source_carrier=target\/sdk-artifacts\/oliphaunt-swift\/release-tree\/src\/sdks\/swift\/Carriers\/oliphaunt-react-native-ios-carriers\.json/u,
  );
  assert.match(
    step,
    /cache_warm_carrier=target\/release\/ios-carriers\/oliphaunt-react-native-ios-carriers\.json/u,
  );
  assert.match(
    step,
    /react_native_source_carrier=target\/sdk-artifacts\/oliphaunt-react-native\/ios-carriers\/oliphaunt-react-native-ios-carriers\.json/u,
  );
  assert.match(step, /cmp -s "\$source_carrier" "\$react_native_source_carrier"/u);
  assert.match(step, /PLANNED_EXTENSION_PRODUCTS/u);
  assert.match(step, /target\/extension-artifacts\/\$product\/release-assets/u);
  assert.match(step, /consumer_args\+=\(--extension-carrier/u);
  assert.match(
    step,
    /check-extension-release-consumer\.sh "\$\{consumer_args\[@\]\}"/u,
  );
  assert.doesNotMatch(step, /OLIPHAUNT_SWIFT_EXTENSION_CARRIER/u);
});

test("the Swift consumer warms candidate bytes with the local aggregate then resolves public carrier metadata offline", () => {
  const consumer = read("src/sdks/swift/tools/check-extension-release-consumer.sh");
  const warm = consumer.indexOf('--carrier "$cache_warm_carrier"');
  const exact = consumer.indexOf('--carrier "$source_carrier"');
  assert.notEqual(warm, -1);
  assert.notEqual(exact, -1);
  assert.ok(warm < exact, "cache warming must precede independent-carrier resolution");
  const exactBlock = consumer.slice(exact, consumer.indexOf("\n\n", exact));
  assert.match(exactBlock, /"\$\{extension_carrier_args\[@\]\}"/u);
  assert.match(exactBlock, /--offline/u);
  assert.doesNotMatch(exactBlock, /--allow-file-urls/u);
});

test("the hosted Swift executable covers every product and conditionally proves native or SQL-only final linking", () => {
  const consumer = read("src/sdks/swift/tools/check-extension-release-consumer.sh");
  assert.match(consumer, /const selected = products\.selected\.map/u);
  assert.match(consumer, /new Set\(selected\.map\(\(\{ swiftProduct \}\) => swiftProduct\)\)\.size/u);
  assert.match(consumer, /plan\.finalLink\.kind === "native-extension"/u);
  assert.match(consumer, /plan\.finalLink\.kind === "base-runtime"/u);
  assert.match(consumer, /selected\.some\(\(\{ nativeModuleStem \}\) => nativeModuleStem !== null\)/u);
  assert.match(consumer, /dependencies: \[\$\{dependencies\}\]/u);
  assert.match(consumer, /\.product\(name: "COliphaunt", package: "oliphaunt"\)/u);
  assert.match(consumer, /`import COliphaunt\\n\$\{selected\.map/u);
  assert.match(consumer, /selected\.map\(\(\{ swiftProduct \}\) => `import \$\{swiftProduct\}`\)/u);
  assert.match(consumer, /selected\.map\(\(\{ swiftProduct \}\) => `try \$\{swiftProduct\}\.register\(\)`\)/u);
  assert.match(consumer, /oliphaunt_version\(\)\.map \{ String\(cString: \$0\) \}/u);
  assert.match(consumer, /OLIPHAUNT_SWIFT_BASE_RUNTIME_LINK_PASS/u);
  assert.match(consumer, /OLIPHAUNT_SWIFT_NATIVE_EXTENSION_LINK_PASS/u);
  assert.equal(
    (consumer.match(/`        \.executableTarget\(\\n`/gu) ?? []).length,
    1,
    "the generated consumer package must contain exactly one executable target",
  );
  assert.doesNotMatch(
    consumer,
    /products\.selected\.find\(\(row\).*\?\? products\.selected\.at\(-1\)/su,
  );
});

test("Swift and React Native package-artifact caches track carrier code, graph metadata, versions, and candidate bytes", () => {
  const requiredInputs = [
    "/.release-please-manifest.json",
    "/release-please-config.json",
    "/src/**/moon.yml",
    "/src/**/release.toml",
    "/src/runtimes/liboliphaunt/native/VERSION",
    "/target/liboliphaunt/release-assets/**/*",
    "/tools/dev/bun.sh",
    "/tools/release/build-sdk-ci-artifacts.mjs",
    "/tools/release/check-staged-artifacts.mjs",
    "/tools/release/ios-carrier-manifest.mjs",
    "/tools/release/platform-compatibility-policy.mjs",
    "/tools/release/prepare-swift-release-consumer.mjs",
    "/tools/release/product-version.mjs",
    "/tools/release/release-artifact-targets.mjs",
    "/tools/release/release-graph.mjs",
    "/tools/release/release-semantic-inputs.mjs",
    "/tools/release/release-semantic-inputs.toml",
    "/tools/release/swift-source-carrier-contract.mjs",
  ];
  for (const [product, file] of [
    ["Swift", "src/sdks/swift/moon.yml"],
    ["React Native", "src/sdks/react-native/moon.yml"],
  ]) {
    const project = Bun.YAML.parse(read(file));
    const task = project.tasks?.["package-artifacts"];
    assert.ok(task, `${product} must define package-artifacts`);
    const inputs = new Set(task.inputs ?? []);
    for (const input of requiredInputs) {
      assert.ok(inputs.has(input), `${product} package-artifacts must track ${input}`);
    }
  }
});

test("the iOS mobile task owns changes to the independent-carrier hosted proof", () => {
  const project = Bun.YAML.parse(read("src/sdks/react-native/moon.yml"));
  assert.ok(
    new Set(project.tasks?.["mobile-build-ios"]?.inputs ?? [])
      .has("/tools/release/swift-extension-release-consumer-inputs.mjs"),
    "the planner must rerun mobile-build-ios when its hosted Swift carrier proof changes",
  );
});
