import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import test from "node:test";

const action = readFileSync(".github/actions/setup-msvc/action.yml", "utf8");
const script = readFileSync(".github/scripts/setup-msvc.ps1", "utf8");

const requiredActionTokens = [
  "run: .github/scripts/setup-msvc.ps1",
];

const requiredScriptTokens = [
  "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
  "-version '[18.0,19.0)'",
  "-format json",
  "installationVersion",
  'Require-MajorVersion "installationVersion" $installationVersion 18',
  "Launch-VsDevShell.ps1",
  "-Arch x64",
  "-HostArch x64",
  'Require-MajorVersion "VSCMD_VER" $env:VSCMD_VER 18',
  "VSCMD_ARG_HOST_ARCH",
  "VSCMD_ARG_TGT_ARCH",
  "VCToolsInstallDir",
  '$vcToolsVersionInfo = Require-MajorVersion "VCToolsVersion" $vcToolsVersion 14',
  "$vcToolsVersionInfo.Minor -lt 50 -or $vcToolsVersionInfo.Minor -ge 60",
  'Require-MajorVersion "WindowsSDKVersion" $windowsSdkVersion 10',
  "x64\\Microsoft.VC145.CRT",
  "msvcp140.dll",
  "vcruntime140.dll",
  "vcruntime140_1.dll",
  "bin\\HostX64\\x64",
  'Resolve-CommandPath "cl.exe"',
  'Resolve-CommandPath "link.exe"',
  'Require-FileVersion "cl.exe"',
  'Require-FileVersion "link.exe"',
  'Require-RunnerProvenance "ImageOS"',
  'Require-RunnerProvenance "ImageVersion"',
  "CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER",
  "GITHUB_STEP_SUMMARY",
];

function assertMsvcSetupContract(actionSource, scriptSource) {
  for (const token of requiredActionTokens) {
    assert.ok(actionSource.includes(token), `MSVC action must preserve ${token}`);
  }
  for (const token of requiredScriptTokens) {
    assert.ok(scriptSource.includes(token), `MSVC setup must preserve ${token}`);
  }
  assert.doesNotMatch(actionSource, /ilammy\/msvc-dev-cmd/u);
  assert.doesNotMatch(scriptSource, /Invoke-Expression|\biex\b/u);
  assert.doesNotMatch(scriptSource, /installationVersion\s+-ne\s+['"]18\.[0-9.]+/u);
}

test("MSVC setup selects and verifies the supported VS18 x64 toolchain", () => {
  assertMsvcSetupContract(action, script);
});

for (const token of requiredScriptTokens) {
  test(`MSVC contract rejects mutation of ${token}`, () => {
    const mutated = script.replaceAll(token, "<removed>");
    assert.notEqual(mutated, script, `test mutation must alter ${token}`);
    assert.throws(() => assertMsvcSetupContract(action, mutated));
  });
}

test("MSVC contract rejects replacement with the third-party setup action", () => {
  const mutated = action.replace(
    "run: .github/scripts/setup-msvc.ps1",
    "uses: ilammy/msvc-dev-cmd@latest",
  );
  assert.throws(() => assertMsvcSetupContract(mutated, script));
});
