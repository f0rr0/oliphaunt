import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import test from "node:test";

const action = readFileSync(".github/actions/setup-apple/action.yml", "utf8");

const requiredTokens = [
  'default: "26.5"',
  'SUPPORTED_XCODE_MINOR: "26.5"',
  '[[ "$REQUESTED_XCODE_MINOR" != "$SUPPORTED_XCODE_MINOR" ]]',
  '/Applications/Xcode_26.5.app/Contents/Developer',
  'export DEVELOPER_DIR="$developer_dir"',
  '[[ "$observed_xcode_version" != "$SUPPORTED_XCODE_MINOR" ]]',
  "Build version",
  "xcrun --sdk macosx --show-sdk-version",
  "xcrun --sdk iphoneos --show-sdk-version",
  "xcrun --sdk iphonesimulator --show-sdk-version",
  "ImageOS",
  "ImageVersion",
  "GITHUB_ENV",
  "GITHUB_STEP_SUMMARY",
];

function assertAppleSetupContract(source) {
  for (const token of requiredTokens) {
    assert.ok(source.includes(token), `Apple setup must preserve ${token}`);
  }
  assert.doesNotMatch(source, /\bxcode-select\s+(?:--switch|-s)\b/u);
  assert.doesNotMatch(source, /\/Applications\/Xcode\.app\/Contents\/Developer/u);
}

test("Apple setup selects and verifies exact Xcode 26.5 with observed provenance", () => {
  assertAppleSetupContract(action);
});

for (const token of requiredTokens) {
  test(`Apple contract rejects mutation of ${token}`, () => {
    const mutated = action.replaceAll(token, "<removed>");
    assert.notEqual(mutated, action, `test mutation must alter ${token}`);
    assert.throws(() => assertAppleSetupContract(mutated));
  });
}

test("Apple contract rejects mutable default Xcode selection", () => {
  const mutated = action.replace(
    "/Applications/Xcode_26.5.app/Contents/Developer",
    "/Applications/Xcode.app/Contents/Developer",
  );
  assert.throws(() => assertAppleSetupContract(mutated));
});
