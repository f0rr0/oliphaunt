import { expect, test } from "bun:test";

import { validateExtensionTargetProfiles } from "./extension-target-profiles.mjs";

function fixture() {
  return {
    schema: "oliphaunt-extension-artifact-target-profiles-v1",
    profiles: [{
      id: "native-v1",
      targets: [{ target: "linux-x64-gnu", family: "native", kind: "native-dynamic" }],
    }],
  };
}

test("normalizes the minimal target identity contract", () => {
  expect(validateExtensionTargetProfiles(fixture()).targets).toEqual([{
    profileId: "native-v1",
    target: "linux-x64-gnu",
    family: "native",
    kind: "native-dynamic",
  }]);
});

test("rejects intermediate state fields", () => {
  const raw = fixture();
  raw.profiles[0].targets[0].status = "supported";
  expect(() => validateExtensionTargetProfiles(raw)).toThrow(/fields must be exactly family, kind, target/u);
});

test("rejects a target declared by more than one profile", () => {
  const raw = fixture();
  raw.profiles.push({ ...raw.profiles[0], id: "duplicate-v1" });
  expect(() => validateExtensionTargetProfiles(raw)).toThrow(/duplicate target linux-x64-gnu/u);
});
