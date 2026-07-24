import { describe, expect, test } from "bun:test";

import {
  isReleaseCriticalProductionPath,
  localeSensitiveOrderingViolations,
} from "./assert-ordinal-release-ordering.mjs";

const forbiddenComparison = ["locale", "Compare"].join("");
const forbiddenCollator = ["Intl", "Collator"].join(".");

describe("release-critical ordinal ordering boundary", () => {
  test("covers release, policy, workflow, runtime, extension, and SDK packaging production", () => {
    for (const file of [
      ".github/scripts/merge-checksum-manifest.mjs",
      ".github/actions/setup-moon/install-pinned-node.sh",
      ".github/workflows/release.yml",
      "tools/graph/ci_plan.mjs",
      "tools/release/publication-lock.mjs",
      "tools/policy/fetch-sources.mjs",
      "src/extensions/artifacts/native/tools/extension-artifact-packager.mjs",
      "src/runtimes/liboliphaunt/native/tools/check-patch-stack.mjs",
      "src/sdks/react-native/tools/verify-ios-package.mjs",
      "src/sdks/react-native/app.plugin.js",
      "src/sdks/react-native/src/mobileExtensionProof.ts",
      "src/sdks/js/src/native/assets-node.ts",
      "src/shared/contracts/tools/check-test-matrix.mjs",
    ]) {
      expect(isReleaseCriticalProductionPath(file), file).toBe(true);
    }
  });

  test("does not turn tests, fixtures, generated output, or application UI into release policy", () => {
    for (const file of [
      "tools/release/publication-lock.test.mjs",
      "tools/release/fixtures/example.mjs",
      "src/extensions/generated/catalog.mjs",
      "src/target/generated.mjs",
      "src/sdks/react-native/app/index.tsx",
      "docs/example.mjs",
    ]) {
      expect(isReleaseCriticalProductionPath(file), file).toBe(false);
    }
  });

  test("reports both locale-sensitive ordering mechanisms with stable locations", () => {
    const violations = localeSensitiveOrderingViolations([
      {
        file: "tools/release/zeta.mjs",
        text: `rows.sort((left, right) => left.${forbiddenComparison}(right));`,
      },
      {
        file: "tools/release/alpha.mjs",
        text: `const collator = new ${forbiddenCollator}("en");`,
      },
      {
        file: "tools/release/ordinal.mjs",
        text: "rows.sort((left, right) => left < right ? -1 : left > right ? 1 : 0);",
      },
    ]);
    expect(violations).toEqual([
      { file: "tools/release/alpha.mjs", line: 1, kind: "locale-dependent collator" },
      { file: "tools/release/zeta.mjs", line: 1, kind: "locale-dependent string comparison" },
    ]);
  });
});
