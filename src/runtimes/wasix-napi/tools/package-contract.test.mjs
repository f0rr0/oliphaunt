import { createHash } from "node:crypto";

import { describe, expect, test } from "bun:test";

import {
  assertSingleWasixNapiAddonMember,
  assertWasixNapiCarrierManifest,
  assertWasixNapiPlatformEntries,
} from "../../../../tools/release/check-wasix-napi-release-assets.mjs";
import { windowsPeFixture } from "../../../../tools/test/release-fixture-utils.mjs";

const target = Object.freeze({
  npmPackage: "@oliphaunt/wasix-napi-linux-x64-gnu",
  target: "linux-x64-gnu",
  npmOs: "linux",
  npmCpu: "x64",
  npmLibc: "glibc",
});

function manifest() {
  return {
    name: target.npmPackage,
    version: "1.2.3",
    license: "MIT AND PostgreSQL AND Unicode-3.0 AND Apache-2.0",
    type: "commonjs",
    os: ["linux"],
    cpu: ["x64"],
    libc: ["glibc"],
    optional: true,
    oliphaunt: {
      target: target.target,
      runtimeProduct: "liboliphaunt-wasix",
      runtimeVersion: "0.1.1",
      addonAbiVersion: 1,
      nodeApiVersion: 8,
      profiles: ["standard", "icu"],
    },
    exports: {
      "./oliphaunt_wasix_napi.node": "./prebuilds/oliphaunt_wasix_napi.node",
      "./artifact-provenance.json": "./artifact-provenance.json",
      "./package.json": "./package.json",
    },
    files: [
      "prebuilds",
      "artifact-provenance.json",
      "README.md",
      "LICENSE",
      "THIRD_PARTY_NOTICES.md",
      "THIRD_PARTY_NOTICES.oliphaunt-wasix.md",
      "THIRD_PARTY_LICENSES",
    ],
  };
}

function archiveEntry(data) {
  return {
    data: () => data,
    isFile: true,
    isSymbolicLink: false,
    size: data.length,
  };
}

describe("WASIX Node-API carrier fail-closed package contract", () => {
  test("accepts the one-binary, two-profile carrier", () => {
    expect(() => assertWasixNapiCarrierManifest(manifest(), target, "1.2.3"))
      .not.toThrow();
  });

  test("rejects a wrong target, addon ABI, or profile inventory", () => {
    for (const mutate of [
      (candidate) => { candidate.oliphaunt.target = "linux-arm64-gnu"; },
      (candidate) => { candidate.oliphaunt.addonAbiVersion = 2; },
      (candidate) => { candidate.oliphaunt.profiles = ["standard"]; },
    ]) {
      const candidate = manifest();
      mutate(candidate);
      expect(() => assertWasixNapiCarrierManifest(candidate, target, "1.2.3"))
        .toThrow("target/runtime/ABI/profile metadata");
    }
  });

  test("rejects a second native binary export", () => {
    const candidate = manifest();
    candidate.exports["./oliphaunt_wasix_napi_icu.node"] =
      "./prebuilds/oliphaunt_wasix_napi_icu.node";
    expect(() => assertWasixNapiCarrierManifest(candidate, target, "1.2.3"))
      .toThrow("exactly one stable addon binary");
  });

  test("rejects a hidden second native binary archive member", () => {
    const binary = "package/prebuilds/oliphaunt_wasix_napi.node";
    expect(() => assertSingleWasixNapiAddonMember(new Map([[binary, {}]]), binary))
      .not.toThrow();
    expect(() => assertSingleWasixNapiAddonMember(new Map([
      [binary, {}],
      ["package/prebuilds/oliphaunt_wasix_napi_icu.node", {}],
    ]), binary)).toThrow("exactly one native addon member");
  });

  test("rejects incompatible npm platform, lifecycle, or file metadata", () => {
    for (const mutate of [
      (candidate) => { candidate.cpu = ["arm64"]; },
      (candidate) => { candidate.libc = ["musl"]; },
      (candidate) => { candidate.scripts = { install: "node install.js" }; },
      (candidate) => { candidate.files.push("install.js"); },
    ]) {
      const candidate = manifest();
      mutate(candidate);
      expect(() => assertWasixNapiCarrierManifest(candidate, target, "1.2.3"))
        .toThrow();
    }
  });

  test("requires the exact Windows VC runtime closure beside the npm addon", () => {
    const binary = windowsPeFixture({ imports: ["VCRUNTIME140.dll"] });
    const runtime = windowsPeFixture();
    const digest = createHash("sha256").update(runtime).digest("hex");
    const entries = new Map([
      ["package/prebuilds/oliphaunt_wasix_napi.node", archiveEntry(binary)],
      ["package/prebuilds/vcruntime140.dll", archiveEntry(runtime)],
      [
        "package/prebuilds/windows-vc-runtime.sha256",
        archiveEntry(Buffer.from(`${digest}  vcruntime140.dll\n`)),
      ],
    ]);
    const options = {
      target: "windows-x64-msvc",
      prefix: "package",
      binaryDirectory: "prebuilds",
    };
    expect(() => assertWasixNapiPlatformEntries(entries, options)).not.toThrow();

    entries.delete("package/prebuilds/windows-vc-runtime.sha256");
    expect(() => assertWasixNapiPlatformEntries(entries, options)).toThrow(/VC runtime receipt/u);

    entries.set(
      "package/prebuilds/windows-vc-runtime.sha256",
      archiveEntry(Buffer.from(`${digest}  vcruntime140.dll\n`)),
    );
    entries.set("package/vcruntime140.dll", entries.get("package/prebuilds/vcruntime140.dll"));
    entries.delete("package/prebuilds/vcruntime140.dll");
    expect(() => assertWasixNapiPlatformEntries(entries, options)).toThrow(/beside/u);
  });
});
