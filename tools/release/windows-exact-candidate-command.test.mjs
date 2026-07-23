import { expect, test } from "bun:test";
import { spawnSync } from "../test/fd-backed-spawn-sync.mjs";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  WINDOWS_STANDARD_USER_CONTROL_READ_FILES,
  WINDOWS_STANDARD_USER_MODULE_LOAD_PROOF,
  exactCandidateCommandInvocation,
  windowsStandardUserControlReadSetSha256,
} from "./js-exact-candidate-consumer.mjs";

const ROOT = path.resolve(import.meta.dir, "../..");
const windowsTest = process.platform === "win32" ? test : test.skip;
const hostedExactNpmTest =
  process.platform === "win32"
    && process.env.OLIPHAUNT_WINDOWS_STANDARD_USER_EXACT_NPM_PROOF === "1"
    ? test
    : test.skip;
const standardUserLauncher = path.join(
  ROOT,
  "tools/release/run-windows-standard-user-exact-candidate.ps1",
);
const EXPECTED_WINDOWS_STANDARD_USER_CONTROL_READ_FILES = [
  "tools/release/js-exact-candidate-consumer.mjs",
  "tools/release/artifact_target_matrix.mjs",
  "tools/release/ios-carrier-manifest.mjs",
  "tools/release/extension-registry-packages.mjs",
  "tools/release/release-artifact-targets.mjs",
  "tools/release/native-extension-asset-index-contract.mjs",
  "tools/release/tar-command.mjs",
  "tools/release/extension-artifact-inventory.mjs",
  "tools/release/release-notices.mjs",
  "tools/release/extension-upstream-licenses.mjs",
  "tools/release/rust-build-script-sha256.mjs",
  "src/sdks/js/src/native/extension-contract.ts",
  "tools/release/fixtures/js-exact-candidate-runtime.mjs",
  "tools/release/fixtures/js-exact-candidate-procsignal.mjs",
  "tools/release/fixtures/js-exact-candidate-prepare-deno-runtime.mjs",
  "tools/release/fixtures/js-exact-candidate-jsr.mjs",
  "tools/release/build-extension-ci-artifacts.mjs",
  "tools/release/exact-candidate-command-watchdog.mjs",
  "tools/release/local-registry-publish.mjs",
];
const EXPECTED_WINDOWS_IMMUTABLE_INPUT_ROOTS = [
  "target/js-exact-candidate-input/native",
  "target/js-exact-candidate-input/broker",
  "target/js-exact-candidate-input/node",
  "target/js-exact-candidate-input/extensions",
  "target/js-exact-candidate-input/ios-extensions",
  "target/js-exact-candidate-input/js",
  "target/js-exact-candidate-input/ios",
];

test("the Windows standard-user preflight loads the real consumer contract", () => {
  const consumer = path.join(ROOT, "tools/release/js-exact-candidate-consumer.mjs");
  const result = spawnSync(
    process.execPath,
    [consumer, "--windows-standard-user-module-load-proof"],
    { encoding: "utf8", timeout: 30_000 },
  );
  expect(result.status, result.stderr || result.stdout).toBe(0);
  expect(result.stdout.trim()).toBe(
    `${WINDOWS_STANDARD_USER_MODULE_LOAD_PROOF}\t${windowsStandardUserControlReadSetSha256()}`,
  );
  expect(result.stderr).toBe("");
  expect(WINDOWS_STANDARD_USER_CONTROL_READ_FILES).toEqual(
    EXPECTED_WINDOWS_STANDARD_USER_CONTROL_READ_FILES,
  );
});

test("the PowerShell and JavaScript standard-user control read sets are identical", () => {
  const launcher = readFileSync(standardUserLauncher, "utf8");
  const match = launcher.match(
    /\$RepositoryConsumerControlReadRelativePaths = @\(\r?\n(?<body>[\s\S]*?)\r?\n\)/u,
  );
  expect(match).not.toBeNull();
  const powerShellReadFiles = match.groups.body.split(/\r?\n/u).map((line) => {
    const expression = line.trim().replace(/,$/u, "");
    if (expression === "$RepositoryConsumerRelativePath") {
      return "tools/release/js-exact-candidate-consumer.mjs";
    }
    const literal = expression.match(/^"(?<path>[^"]+)"$/u);
    if (!literal) throw new Error(`unexpected PowerShell read-set entry: ${expression}`);
    return literal.groups.path;
  });
  expect(powerShellReadFiles).toEqual(
    EXPECTED_WINDOWS_STANDARD_USER_CONTROL_READ_FILES,
  );
});

test("the Windows standard-user launcher proves immutable inputs and active nested discovery", () => {
  const launcher = readFileSync(standardUserLauncher, "utf8");
  const materializer = readFileSync(
    path.join(ROOT, "tools/release/extension-registry-carrier-materializer.mjs"),
    "utf8",
  );
  const discoveryProofTool = readFileSync(
    path.join(ROOT, "tools/release/extension-manifest-discovery-proof.mjs"),
    "utf8",
  );
  const rootList = launcher.match(
    /\$RepositoryImmutableInputRelativePaths = @\(\r?\n(?<body>[\s\S]*?)\r?\n\)/u,
  );
  expect(rootList).not.toBeNull();
  expect(
    rootList.groups.body.split(/\r?\n/u).map((line) =>
      line.trim().replace(/,$/u, "").match(/^"(?<path>[^"]+)"$/u)?.groups.path
    ),
  ).toEqual(EXPECTED_WINDOWS_IMMUTABLE_INPUT_ROOTS);

  const createFixture = launcher.indexOf(
    '$currentStage = "create immutable nested extension-discovery fixture"',
  );
  const installRepositoryAcl = launcher.indexOf(
    "Set-RepositoryEphemeralAclContract `",
    createFixture,
  );
  const launchChild = launcher.indexOf(
    "$childResult = Invoke-ChildProcess `",
    installRepositoryAcl,
  );
  expect(createFixture).toBeGreaterThan(-1);
  expect(installRepositoryAcl).toBeGreaterThan(createFixture);
  expect(launchChild).toBeGreaterThan(installRepositoryAcl);
  const parent = launcher.slice(createFixture, launchChild);
  expect(launcher).toContain(
    '$ExtensionManifestDiscoveryRelativePath =\n    "windows-x64-msvc/fixture/extension-artifacts.json"',
  );
  expect(parent).toContain("$selfTestExtensionManifestSha256 = Get-FileSha256 `");
  expect(parent).toContain("$selfTestExtensionMaterializerSha256 = Get-FileSha256 `");
  expect(parent).toContain("$selfTestExtensionDiscoveryProofToolSha256 = Get-FileSha256 `");
  expect(parent).toContain("$immutableInputRoots.Add($selfTestInputRoot)");
  expect(parent).toContain("immutableInputRoots = @($immutableInputRoots)");
  expect(parent).toContain("extensionManifestDiscovery = $extensionManifestDiscovery");
  expect(launcher).toContain("foreach ($relative in $RepositoryImmutableInputRelativePaths)");

  const childStart = launcher.indexOf("function Invoke-ChildMode(");
  const childEnd = launcher.indexOf("\nfunction Write-LauncherReceipt(", childStart);
  const child = launcher.slice(childStart, childEnd);
  expect(child).toContain("$manifest.immutableInputRoots -isnot [System.Array]");
  expect(child).toContain(
    'Fail "consumer manifest contains a self-test-only extension-discovery contract"',
  );
  expect(child).toContain("foreach ($relativeInputRoot in $RepositoryImmutableInputRelativePaths)");
  expect(child).toContain(
    "$manifestImmutableInputRoots.Count -ne $expectedImmutableInputRoots.Count",
  );
  expect(child).toContain("$expectedImmutableInputRoots[$index]");
  expect(child).toContain("Test-PathsOverlap $immutableInputRoot $writableRoot");
  expect(child).toContain("Test-PathsOverlap $immutableInputRoot $sandbox");
  expect(child).toContain("Test-PathsOverlap $immutableInputRoot $toolExecutionRoot");
  expect(child).toContain("Test-PathsOverlap $immutableInputRoot $previousImmutableInputRoot");
  expect(child).toContain("Assert-DirectoryCreateDenied $immutableInputRoot");
  expect(child).toContain("Assert-FileWriteOpenDenied $immutableFile");
  expect(child).toContain("Assert-FileAppendOpenDenied $immutableFile");
  expect(child).toContain('Fail "immutable input root $index contains no files to prove"');
  expect(child).toContain("$materializer = Resolve-File `");
  expect(child).toContain("$discoveryProofTool = Resolve-File `");
  expect(child).toContain("Assert-InheritedRepositoryMutationDeny `");
  expect(child).toContain("Assert-FileWriteOpenDenied $discoveryCode.path");
  expect(child).toContain("Assert-FileAppendOpenDenied $discoveryCode.path");
  expect(child).toContain("$manifest.extensionManifestDiscovery.proofToolSha256");
  expect(child).toContain("$ExtensionManifestDiscoveryProofArgument,");
  expect(child).toContain("$manifest.extensionManifestDiscovery.sha256");
  expect(child).toContain(
    "$discoveryResult.stdout.Trim() -cne $expectedDiscoveryOutput",
  );
  expect(child).toContain(
    'Fail "active extension-manifest discovery changed its immutable input contract"',
  );
  for (const evidence of [
    "immutableInputRootsBound",
    "immutableInputCreateDenied",
    "immutableInputFileWriteDenied",
    "immutableInputFileAppendDenied",
    "extensionManifestDiscoveryVerified",
  ]) {
    expect(child).toContain(`${evidence} = $`);
    expect(launcher.slice(launcher.indexOf("function Read-And-ValidateProof("), childStart))
      .toContain(`repositoryAccess.${evidence}`);
  }
  expect(child).toContain("extensionMaterializerSha256 = if (");
  expect(launcher.slice(launcher.indexOf("function Read-And-ValidateProof("), childStart))
    .toContain("repositoryAccess.extensionMaterializerSha256");
  expect(launcher.slice(launcher.indexOf("function Read-And-ValidateProof("), childStart))
    .toContain("repositoryAccess.extensionDiscoveryProofToolSha256");
  expect(child).not.toContain("local_registry_metadata.mjs");
  expect(launcher).not.toMatch(
    /Add-EphemeralAclGrant\s+`?\r?\n?\s*\$immutableInputRoot/gu,
  );

  expect(materializer).toContain(
    "for (const manifest of extensionManifestCandidates(root))",
  );
  expect(discoveryProofTool).toContain(
    'args[0] !== "--windows-standard-user-discovery-proof"',
  );
  expect(discoveryProofTool).toContain(
    'from "./extension-registry-carrier-materializer.mjs"',
  );
  expect(materializer).not.toContain("import.meta.main");
  expect(discoveryProofTool).toContain(
    'fail("Windows standard-user discovery proof manifest digest disagrees with its contract")',
  );
  expect(discoveryProofTool).toContain('relativeExpected.split(path.sep).join("/")');
  expect(discoveryProofTool).toContain(
    "discoverExtensionManifests([absoluteRoot])",
  );
  expect(materializer).not.toContain("WINDOWS_STANDARD_USER_EXTENSION_DISCOVERY_PROOF");
  expect(materializer).not.toContain("proveWindowsStandardUserExtensionDiscovery");
});

test("the required Windows node-direct producer runs the behavioral shim proof before native setup", () => {
  const workflow = readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8");
  const jobStart = workflow.indexOf("  node-direct:\n");
  const jobEnd = workflow.indexOf("\n  swift-sdk-package:\n", jobStart);
  expect(jobStart).toBeGreaterThan(-1);
  expect(jobEnd).toBeGreaterThan(jobStart);
  const job = workflow.slice(jobStart, jobEnd);
  const setupMoon = job.indexOf("      - name: Set up Moon\n");
  const setupExactNpm = job.indexOf(
    "      - name: Set up exact npm runtime for Windows standard-user proof\n",
    setupMoon,
  );
  const proof = job.indexOf("      - name: Verify Windows package-manager shim argument transport\n");
  const condition = job.indexOf("        if: ${{ runner.os == 'Windows' }}\n", proof);
  const hostedProofFlag = job.indexOf(
    '          OLIPHAUNT_WINDOWS_STANDARD_USER_EXACT_NPM_PROOF: "1"\n',
    condition,
  );
  const shimProof = job.indexOf(
    "        run: tools/dev/bun.sh test tools/release/windows-exact-candidate-command.test.mjs\n",
    hostedProofFlag,
  );
  const setupRust = job.indexOf("      - name: Set up Rust\n");
  expect(setupMoon).toBeGreaterThan(-1);
  expect(setupExactNpm).toBeGreaterThan(setupMoon);
  expect(proof).toBeGreaterThan(setupExactNpm);
  expect(condition).toBeGreaterThan(proof);
  expect(hostedProofFlag).toBeGreaterThan(condition);
  expect(shimProof).toBeGreaterThan(hostedProofFlag);
  expect(setupRust).toBeGreaterThan(shimProof);
  const npmSetup = job.slice(setupExactNpm, proof);
  expect(npmSetup).toContain("        if: ${{ runner.os == 'Windows' }}\n");
  expect(npmSetup).toContain("        uses: ./.github/actions/setup-npm-publisher\n");
  expect(npmSetup).toContain("          npm-version: ${{ env.NPM_VERSION }}\n");
  expect(job.match(/\.\/\.github\/actions\/setup-npm-publisher/gu)).toHaveLength(1);
  expect(job.match(/OLIPHAUNT_WINDOWS_STANDARD_USER_EXACT_NPM_PROOF/gu)).toHaveLength(1);
  expect(workflow.match(
    /tools\/dev\/bun\.sh test tools\/release\/windows-exact-candidate-command\.test\.mjs/gu,
  )).toHaveLength(1);

  const publisherManifest = readFileSync(
    path.join(ROOT, "src/sources/toolchains/npm-publisher.toml"),
    "utf8",
  );
  const manifestVersion = publisherManifest.match(
    /^\[toolchain\]\r?\nversion = "([0-9]+\.[0-9]+\.[0-9]+)"$/mu,
  )?.[1];
  const workflowVersion = workflow.match(
    /^  NPM_VERSION: "?([0-9]+\.[0-9]+\.[0-9]+)"?$/mu,
  )?.[1];
  expect(manifestVersion).toBe("11.18.0");
  expect(workflowVersion).toBe(manifestVersion);

  const consumerStart = workflow.indexOf("  js-sdk-exact-candidate-consumer:\n");
  const consumerEnd = workflow.indexOf("\n  wasix-rust-package:\n", consumerStart);
  expect(consumerStart).toBeGreaterThan(-1);
  expect(consumerEnd).toBeGreaterThan(consumerStart);
  expect(workflow.slice(consumerStart, consumerEnd)).not.toContain(
    "tools/dev/bun.sh test tools/release/windows-exact-candidate-command.test.mjs",
  );
});

test("the required Windows node-direct producer proves the exact consumer tool envelopes before Rust setup", () => {
  const workflow = readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8");
  const jobStart = workflow.indexOf("  node-direct:\n");
  const jobEnd = workflow.indexOf("\n  swift-sdk-package:\n", jobStart);
  expect(jobStart).toBeGreaterThan(-1);
  expect(jobEnd).toBeGreaterThan(jobStart);
  const job = workflow.slice(jobStart, jobEnd);
  const setupMoon = job.indexOf("      - name: Set up Moon\n");
  const setupContracts = [
    {
      name: "Set up exact Node and pnpm for Windows standard-user proof",
      id: "windows_exact_node_pnpm",
      action: "setup-node-pnpm",
    },
    {
      name: "Set up exact Bun for Windows standard-user proof",
      id: "windows_exact_bun",
      action: "setup-bun",
    },
    {
      name: "Set up exact npm runtime for Windows standard-user proof",
      id: "windows_exact_npm",
      action: "setup-npm-publisher",
    },
    {
      name: "Set up exact Deno for Windows standard-user proof",
      id: "windows_exact_deno",
      action: "setup-deno",
    },
  ];
  let previousSetup = setupMoon;
  for (const contract of setupContracts) {
    const setup = job.indexOf(`      - name: ${contract.name}\n`, previousSetup);
    const nextStep = job.indexOf("\n      - name:", setup + 1);
    expect(setup).toBeGreaterThan(previousSetup);
    expect(nextStep).toBeGreaterThan(setup);
    const step = job.slice(setup, nextStep);
    expect(step).toContain(`        id: ${contract.id}\n`);
    expect(step).toContain("        if: ${{ runner.os == 'Windows' }}\n");
    expect(step).toContain(`        uses: ./.github/actions/${contract.action}\n`);
    previousSetup = setup;
  }
  const transportProof = job.indexOf(
    "      - name: Verify Windows package-manager shim argument transport\n",
    previousSetup,
  );
  const earlyProof = job.indexOf(
    "      - name: Verify Windows exact-consumer tools under a standard-user token early\n",
    transportProof,
  );
  const windowsOnly = job.indexOf(
    "        if: ${{ runner.os == 'Windows' }}\n",
    earlyProof,
  );
  const resolveBun = job.indexOf(
    '          bun_path="$(cygpath -w "$(command -v bun)")"\n',
    windowsOnly,
  );
  const setupRust = job.indexOf("      - name: Set up Rust\n");
  expect(setupMoon).toBeGreaterThan(-1);
  expect(transportProof).toBeGreaterThan(previousSetup);
  expect(earlyProof).toBeGreaterThan(transportProof);
  expect(windowsOnly).toBeGreaterThan(earlyProof);
  expect(resolveBun).toBeGreaterThan(windowsOnly);
  expect(setupRust).toBeGreaterThan(resolveBun);

  const proofStep = job.slice(earlyProof, setupRust);
  const envelopeContracts = [
    [
      "BUN_EXECUTION_ENVELOPE",
      "steps.windows_exact_bun.outputs.execution-envelope",
      "BunEnvelope",
    ],
    [
      "DENO_EXECUTION_ENVELOPE",
      "steps.windows_exact_deno.outputs.execution-envelope",
      "DenoEnvelope",
    ],
    [
      "NPM_EXECUTION_ENVELOPE",
      "steps.windows_exact_npm.outputs.execution-envelope",
      "NpmEnvelope",
    ],
    [
      "NODE_EXECUTION_ENVELOPE",
      "steps.windows_exact_node_pnpm.outputs.node-execution-envelope",
      "NodeEnvelope",
    ],
    [
      "PNPM_EXECUTION_ENVELOPE",
      "steps.windows_exact_node_pnpm.outputs.pnpm-execution-envelope",
      "PnpmEnvelope",
    ],
  ];
  let previousArgument = proofStep.indexOf("            -BunPath \"$bun_path\" \\\n");
  expect(previousArgument).toBeGreaterThan(-1);
  for (const [environmentName, output, parameter] of envelopeContracts) {
    expect(proofStep).toContain(
      `          ${environmentName}: \${{ ${output} }}\n`,
    );
    const argument = proofStep.indexOf(
      `            -${parameter} \"$${environmentName}\"`,
      previousArgument,
    );
    expect(argument).toBeGreaterThan(previousArgument);
    previousArgument = argument;
  }
  const selfTest = proofStep.indexOf("            -SelfTest \\\n");
  expect(selfTest).toBeGreaterThan(-1);
  expect(selfTest).toBeLessThan(proofStep.indexOf("            -RepositoryRoot"));
  expect(job.slice(setupMoon, setupRust).match(/-SelfTest/gu)).toHaveLength(1);
  expect(job.slice(setupMoon, setupRust).match(/-BunPath/gu)).toHaveLength(1);
  for (const [, , parameter] of envelopeContracts) {
    expect(job.slice(setupMoon, setupRust).match(
      new RegExp(`-${parameter}\\b`, "gu"),
    )).toHaveLength(1);
  }
});

test("pinned setup actions expose their canonical verified execution envelopes", () => {
  const action = (name) => readFileSync(
    path.join(ROOT, `.github/actions/${name}/action.yml`),
    "utf8",
  );
  const nodeRuntime = action("setup-node-runtime");
  const nodePnpm = action("setup-node-pnpm");
  const bun = action("setup-bun");
  const deno = action("setup-deno");
  const npm = action("setup-npm-publisher");

  for (const source of [nodeRuntime, bun, deno, npm]) {
    expect(source).toContain("  execution-envelope:\n");
    expect(source).toContain("value: ${{ steps.install.outputs.execution-envelope }}");
    expect(source).toContain('echo "execution-envelope=$output_envelope"');
    expect(source).toContain('output_envelope="$(cygpath -w "$execution_envelope")"');
  }
  expect(nodeRuntime).toContain(
    'execution_envelope="$(cd "$export_dir/.." && pwd -P)"',
  );
  for (const source of [bun, deno]) {
    expect(source).toContain(
      'execution_envelope="$(cd "$binary_dir/.." && pwd -P)"',
    );
  }
  expect(npm).toContain(
    'execution_envelope="$(cd "$publisher_bin/.." && pwd -P)"',
  );

  expect(nodePnpm).toContain("  node-execution-envelope:\n");
  expect(nodePnpm).toContain(
    "value: ${{ steps.node_runtime.outputs.execution-envelope }}",
  );
  expect(nodePnpm).toContain("  pnpm-execution-envelope:\n");
  expect(nodePnpm).toContain(
    "value: ${{ steps.install.outputs.execution-envelope }}",
  );
  expect(nodePnpm).toContain("      id: node_runtime\n");
  expect(nodePnpm).toContain('output_envelope="$installation"');
  expect(nodePnpm).toContain('output_envelope="$(cygpath -w "$installation")"');
  expect(nodePnpm).toContain('echo "execution-envelope=$output_envelope"');
});

test("the Windows exact-candidate lane de-elevates the complete consumer", () => {
  const workflow = readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8");
  const jobStart = workflow.indexOf("  js-sdk-exact-candidate-consumer:\n");
  const jobEnd = workflow.indexOf("\n  wasix-rust-package:\n", jobStart);
  expect(jobStart).toBeGreaterThan(-1);
  expect(jobEnd).toBeGreaterThan(jobStart);
  const job = workflow.slice(jobStart, jobEnd);
  const consume = job.indexOf("      - name: Consume exact TypeScript candidate\n");
  const windowsBranch = job.indexOf(
    "          if [[ \"${RUNNER_OS:-}\" == \"Windows\" ]]; then\n",
    consume,
  );
  const launcher = job.indexOf(
    "            launcher=\"$(cygpath -w tools/release/run-windows-standard-user-exact-candidate.ps1)\"\n",
    windowsBranch,
  );
  const child = job.indexOf(
    "            MSYS2_ARG_CONV_EXCL='*' pwsh.exe \\\n",
    launcher,
  );
  const consumerEnvelopeContracts = [
    ["BUN_EXECUTION_ENVELOPE", "steps.exact_bun.outputs.execution-envelope", "BunEnvelope"],
    ["DENO_EXECUTION_ENVELOPE", "steps.exact_deno.outputs.execution-envelope", "DenoEnvelope"],
    ["NPM_EXECUTION_ENVELOPE", "steps.exact_npm.outputs.execution-envelope", "NpmEnvelope"],
    [
      "NODE_EXECUTION_ENVELOPE",
      "steps.exact_node_pnpm.outputs.node-execution-envelope",
      "NodeEnvelope",
    ],
    [
      "PNPM_EXECUTION_ENVELOPE",
      "steps.exact_node_pnpm.outputs.pnpm-execution-envelope",
      "PnpmEnvelope",
    ],
  ];
  const candidate = job.indexOf(
    "              -CandidateSha \"$CI_HEAD_SHA\" \\\n              -Target \"$CANDIDATE_TARGET\"\n",
    child,
  );
  const direct = job.indexOf(
    "            bun tools/release/js-exact-candidate-consumer.mjs \\\n",
    candidate,
  );
  expect(windowsBranch).toBeGreaterThan(consume);
  expect(launcher).toBeGreaterThan(windowsBranch);
  expect(child).toBeGreaterThan(launcher);
  expect(candidate).toBeGreaterThan(child);
  expect(direct).toBeGreaterThan(candidate);
  let previousEnvelopeArgument = child;
  for (const [environmentName, output, parameter] of consumerEnvelopeContracts) {
    expect(job.slice(consume, direct)).toContain(
      `          ${environmentName}: \${{ ${output} }}\n`,
    );
    const argument = job.indexOf(
      `              -${parameter} \"$${environmentName}\"`,
      previousEnvelopeArgument,
    );
    expect(argument).toBeGreaterThan(previousEnvelopeArgument);
    expect(argument).toBeLessThan(candidate);
    previousEnvelopeArgument = argument;
  }
});

test("the standard-user launcher strips credentials and binds proof, receipt, and cleanup", () => {
  const launcher = readFileSync(standardUserLauncher, "utf8");
  const runtimeFixture = readFileSync(
    path.join(ROOT, "tools/release/fixtures/js-exact-candidate-runtime.mjs"),
    "utf8",
  );
  expect(launcher).toContain("$startInfo.LoadUserProfile = $false");
  const childProcessStart = launcher.indexOf("function Invoke-ChildProcess(");
  const childProcessEnd = launcher.indexOf(
    "\nfunction Invoke-ChildMode",
    childProcessStart,
  );
  const childProcess = launcher.slice(childProcessStart, childProcessEnd);
  const environmentRead = childProcess.indexOf(
    "$explicitEnvironment = $startInfo.Environment",
  );
  const environmentClear = childProcess.indexOf("$explicitEnvironment.Clear()");
  const environmentWrite = childProcess.indexOf(
    "$explicitEnvironment[$name] = $value",
  );
  const canaryWrite = childProcess.indexOf('"must-not-cross"');
  expect(environmentRead).toBeGreaterThan(-1);
  expect(environmentClear).toBeGreaterThan(environmentRead);
  expect(environmentWrite).toBeGreaterThan(environmentClear);
  expect(canaryWrite).toBeGreaterThan(environmentWrite);
  expect(childProcess).not.toContain("$startInfo.EnvironmentVariables");
  expect(childProcess).not.toContain("Get-ChildItem Env:");
  expect(launcher).toContain("function New-ExplicitChildEnvironment(");
  expect(launcher).toContain('"PATH" = $toolPathDirectories -join');
  expect(launcher).toContain('"USERPROFILE" = $sandboxHome');
  expect(launcher).toContain('"RUNNER_TEMP" = Join-Path $sandbox "runner-temp"');
  expect(launcher).not.toContain('"PGPASSWORD" =');
  expect(launcher).toContain(
    '[Environment]::SetEnvironmentVariable(\n            $canaryName,\n            "must-not-cross",\n            [EnvironmentVariableTarget]::Process',
  );
  expect(launcher).toContain(
    '$ParentEnvironmentCanaryName = "OLIPHAUNT_STANDARD_USER_SECRET_CANARY"',
  );
  expect(launcher).toContain(
    'Fail "the parent process environment canary crossed the standard-user boundary"',
  );
  expect(launcher).toContain(
    '[Environment]::SetEnvironmentVariable(\n                $canaryName,\n                $previousCanary,\n                [EnvironmentVariableTarget]::Process',
  );
  expect(launcher).toContain(
    '$_.Name -match "(?i)(TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH)"',
  );
  for (const fileCommand of [
    "GITHUB_ENV",
    "GITHUB_OUTPUT",
    "GITHUB_PATH",
    "GITHUB_STEP_SUMMARY",
    "GITHUB_STATE",
  ]) {
    expect(launcher).toContain(`"${fileCommand}"`);
  }
  expect(launcher).toContain('schema = "oliphaunt-windows-standard-user-proof-v1"');
  expect(launcher).toContain('schema = "oliphaunt-windows-standard-user-launch-receipt-v1"');
  expect(launcher).toContain("candidateSha = $ReceiptCandidateSha");
  expect(launcher).toContain("target = $ReceiptTarget");
  expect(launcher).toContain("startedAtUtc = $StartedAtUtc");
  expect(launcher).toContain("deadlineUtc = $DeadlineUtc");
  expect(launcher).toContain("tokenProof = $Proof");
  expect(launcher).toContain("processCleanup = $ProcessCleanup");
  expect(launcher).toContain("accountRemoved = $AccountRemoved");
  expect(launcher).toContain("aclGrantsRemoved = $AclGrantsRemoved");
  expect(launcher).toContain("sandboxRemoved = $SandboxRemoved");
  expect(launcher).toContain("toolStaging = $ToolStaging");
  expect(launcher).toContain(
    "toolExecutionRootRemoved = $ToolExecutionRootRemoved",
  );
  expect(launcher).toContain(
    "postCleanupTrackedSourceIntegrityVerified =\n            $PostCleanupTrackedSourceIntegrityVerified",
  );
  expect(launcher).toContain(
    "(Format-ChildDiagnostics $ChildResult $SensitiveValue)",
  );
  expect(launcher).toContain(
    "(Format-ChildDiagnostics $childResult $passwordText)",
  );
  expect(launcher).toContain(
    "$proof.token.administrator -isnot [bool]",
  );
  expect(launcher).toContain(
    "$proof.environment.sensitiveNamesAbsent -isnot [bool]",
  );
  expect(launcher).toContain(
    "$proof.environment.githubFileCommandsAbsent -isnot [bool]",
  );
  expect(launcher).toContain(
    "$proof.toolAccess.stagingVerified -isnot [bool]",
  );
  expect(launcher).toContain(
    "$proof.toolAccess.bunExecuted -isnot [bool]",
  );
  expect(launcher).toContain(
    "$proof.toolAccess.toolRootWriteDenied -isnot [bool]",
  );
  expect(launcher).toContain(
    "$proof.toolAccess.sandboxWriteVerified -isnot [bool]",
  );
  expect(launcher).toContain(
    '$proof.candidate.tree -notmatch "^[0-9a-f]{40}$"',
  );
  expect(launcher).toContain(
    'Fail "standard-user self-test proof contains consumer-only identity"',
  );
  const removeAccount = launcher.indexOf("Remove-LocalUser -Name $userName -ErrorAction Stop");
  const writeReceipt = launcher.lastIndexOf("Write-LauncherReceipt `");
  const successMarker = launcher.indexOf(
    'Write-Output "OLIPHAUNT_WINDOWS_STANDARD_USER_SELF_TEST_OK"',
  );
  expect(removeAccount).toBeGreaterThan(-1);
  expect(writeReceipt).toBeGreaterThan(removeAccount);
  expect(successMarker).toBeGreaterThan(removeAccount);
  expect(runtimeFixture).toContain(
    'assert.equal(proof.schema, "oliphaunt-windows-standard-user-proof-v1");',
  );
  expect(runtimeFixture).toContain("assert.deepEqual(proof.candidate, candidate);");
  expect(runtimeFixture).toContain("assert.equal(proof.target, target);");
  expect(runtimeFixture).toContain("assert.equal(proof.token?.administrator, false);");
});

test("private hosted-runner tool trees are copied data-only with stable fingerprints", () => {
  const launcher = readFileSync(standardUserLauncher, "utf8");
  const privateRootStart = launcher.indexOf("function Get-PrivateToolRoot(");
  const fingerprintStart = launcher.indexOf(
    "function Get-ToolTreeFingerprint(",
    privateRootStart,
  );
  const equalityStart = launcher.indexOf(
    "function Assert-ToolTreeFingerprintEqual(",
    fingerprintStart,
  );
  const copyStart = launcher.indexOf(
    "function Copy-PrivateToolTree(",
    equalityStart,
  );
  const probeStart = launcher.indexOf(
    "function Get-ToolProbeSpecifications(",
    copyStart,
  );
  expect(privateRootStart).toBeGreaterThan(-1);
  expect(fingerprintStart).toBeGreaterThan(privateRootStart);
  expect(equalityStart).toBeGreaterThan(fingerprintStart);
  expect(copyStart).toBeGreaterThan(equalityStart);
  expect(probeStart).toBeGreaterThan(copyStart);
  const privateRoot = launcher.slice(privateRootStart, fingerprintStart);
  const fingerprint = launcher.slice(fingerprintStart, equalityStart);
  const equality = launcher.slice(equalityStart, copyStart);
  const copy = launcher.slice(copyStart, probeStart);

  expect(privateRoot).toContain("[string]$ExpectedEnvelope");
  expect(privateRoot).toContain(
    'Fail "$Name unexpectedly resolved to an undeclared private RUNNER_TEMP tool"',
  );
  expect(privateRoot).toContain(
    '$envelope = Resolve-Directory $ExpectedEnvelope "$Name private tool execution envelope"',
  );
  expect(privateRoot).toContain("Test-PathInside $RunnerTemp $envelope");
  expect(privateRoot).toContain("Test-PathInside $envelope $Executable");
  expect(privateRoot).toContain('(Join-Path $envelope "bin")');
  for (const command of ["bun.exe", "deno.exe", "node.exe", "npm.cmd", "pnpm.cmd"]) {
    expect(privateRoot).toContain(`{ "${command}" }`);
  }
  expect(privateRoot).toContain(
    '$receipt = Resolve-File (Join-Path $envelope "receipt")',
  );
  expect(privateRoot).toContain(
    'Fail "$Name private tool receipt must not be a reparse point"',
  );
  expect(privateRoot).toContain("return $null");
  expect(privateRoot).toContain("return $envelope");
  expect(privateRoot).not.toContain("Substring(");
  expect(privateRoot).not.toContain("relative.Split");
  expect(privateRoot).not.toContain("Join-Path $RunnerTemp $first");

  expect(fingerprint).toContain(
    "[System.Collections.Generic.SortedDictionary[string, object]]::new(\n        [System.StringComparer]::Ordinal",
  );
  expect(launcher).toContain("$ConservativeWindowsPathBudget = 260");
  const rootPathBudget = fingerprint.indexOf(
    "$rootPath.Length -ge $ConservativeWindowsPathBudget",
  );
  const inspectRootStreams = fingerprint.indexOf(
    "Get-Item -LiteralPath $rootPath -Stream * -Force -ErrorAction Stop",
  );
  const itemPathBudget = fingerprint.indexOf(
    "$item.FullName.Length -ge $ConservativeWindowsPathBudget",
  );
  const inspectItemStreams = fingerprint.indexOf(
    "Get-Item -LiteralPath $item.FullName -Stream * -Force -ErrorAction Stop",
  );
  expect(rootPathBudget).toBeGreaterThan(-1);
  expect(inspectRootStreams).toBeGreaterThan(rootPathBudget);
  expect(itemPathBudget).toBeGreaterThan(inspectRootStreams);
  expect(inspectItemStreams).toBeGreaterThan(itemPathBudget);
  expect(fingerprint).toContain(
    '"$Label root exceeds the conservative Windows path budget before inspection: "',
  );
  expect(fingerprint).toContain(
    '"$Label entry exceeds the conservative Windows path budget before inspection: "',
  );
  expect(fingerprint.match(/FileAttributes\]::ReparsePoint/gu)).toHaveLength(2);
  expect(fingerprint).toContain('Fail "$Label root must not be a reparse point: $rootPath"');
  expect(fingerprint).toContain('Fail "$Label contains a forbidden reparse point: $($item.FullName)"');
  expect(fingerprint.match(/-Stream \* -Force -ErrorAction Stop/gu)).toHaveLength(2);
  expect(fingerprint).toContain("$stream.Stream -cne ':$DATA'");
  expect(fingerprint).toContain("forbidden alternate data stream");
  expect(fingerprint).toContain(
    "[System.IO.Path]::GetRelativePath($rootPath, $item.FullName)",
  );
  expect(fingerprint).toContain('Fail "$Label inventory escaped its root: $($item.FullName)"');
  expect(fingerprint).toContain(
    "Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256",
  );
  expect(fingerprint).toContain(
    "$record.bytes.ToString([System.Globalization.CultureInfo]::InvariantCulture)",
  );
  expect(fingerprint).toContain("attributes = [long]$item.Attributes");
  expect(fingerprint).toContain(
    "$record.attributes.ToString(\n            [System.Globalization.CultureInfo]::InvariantCulture",
  );
  expect(fingerprint).toContain(
    "$aggregate.Append(\"R:\").Append($rootAttributes).Append(\"`n\")",
  );
  expect(fingerprint).toContain(
    "[Convert]::ToBase64String($Utf8NoBom.GetBytes($record.path))",
  );
  expect(fingerprint).toContain(
    "[System.Security.Cryptography.SHA256]::HashData($aggregateBytes)",
  );
  expect(fingerprint).toContain(
    "$maxRelativePathCharacters = [Math]::Max(",
  );
  expect(fingerprint).toContain(
    "maxRelativePathCharacters = $maxRelativePathCharacters",
  );
  for (const field of [
    "sha256",
    "rootAttributes",
    "files",
    "directories",
    "bytes",
    "maxRelativePathCharacters",
  ]) {
    expect(equality).toContain(`$Expected.${field}`);
    expect(equality).toContain(`$Actual.${field}`);
  }

  const copyFlags = [...copy.matchAll(/^\s+"(\/[^"]+)",?$/gmu)]
    .map((match) => match[1]);
  expect(copyFlags).toEqual([
    "/E",
    "/COPY:DAX",
    "/DCOPY:DAX",
    "/R:0",
    "/W:0",
    "/XJ",
    "/NFL",
    "/NDL",
    "/NJH",
    "/NJS",
    "/NP",
  ]);
  expect(copy).toContain('"/COPY:DAX"');
  expect(copy).toContain('"/DCOPY:DAX"');
  expect(copy).not.toMatch(/\/(?:COPYALL|SEC|SECFIX)\b|\/COPY:[^"\r\n]*[SOU]/iu);
  const sourceBefore = copy.indexOf(
    '$sourceBefore = Get-ToolTreeFingerprint $sourcePath "$Label source before copy"',
  );
  const destinationBudget = copy.indexOf(
    "$maxDestinationPathCharacters = if ($sourceBefore.maxRelativePathCharacters -eq 0)",
    sourceBefore,
  );
  const rejectLongDestination = copy.indexOf(
    "$maxDestinationPathCharacters -ge $ConservativeWindowsPathBudget",
    destinationBudget,
  );
  const invokeCopy = copy.indexOf("$copy = Invoke-BoundedNativeProcess `");
  const acceptedExitCode = copy.indexOf("$copy.exitCode -gt 7", invokeCopy);
  const sourceAfter = copy.indexOf(
    '$sourceAfter = Get-ToolTreeFingerprint $sourcePath "$Label source after copy"',
    invokeCopy,
  );
  const destination = copy.indexOf(
    "$destinationFingerprint = Get-ToolTreeFingerprint `",
    sourceAfter,
  );
  const sourceStable = copy.indexOf('"$Label source stability"', destination);
  const sourceMatchesDestination = copy.indexOf(
    '"$Label source/destination"',
    sourceStable,
  );
  expect(sourceBefore).toBeGreaterThan(-1);
  expect(destinationBudget).toBeGreaterThan(sourceBefore);
  expect(rejectLongDestination).toBeGreaterThan(destinationBudget);
  expect(copy.slice(rejectLongDestination, invokeCopy)).toContain(
    '"$Label destination exceeds the conservative Windows path budget: "',
  );
  expect(invokeCopy).toBeGreaterThan(rejectLongDestination);
  expect(acceptedExitCode).toBeGreaterThan(invokeCopy);
  expect(sourceAfter).toBeGreaterThan(acceptedExitCode);
  expect(destination).toBeGreaterThan(sourceAfter);
  expect(sourceStable).toBeGreaterThan(destination);
  expect(sourceMatchesDestination).toBeGreaterThan(sourceStable);
});

test("the Windows tool PATH preserves pinned package-manager precedence", () => {
  const launcher = readFileSync(standardUserLauncher, "utf8");
  const specificationsStart = launcher.indexOf(
    "function Get-ToolProbeSpecifications(",
  );
  const specificationsEnd = launcher.indexOf(
    "\nfunction New-RandomPassword(",
    specificationsStart,
  );
  expect(specificationsStart).toBeGreaterThan(-1);
  expect(specificationsEnd).toBeGreaterThan(specificationsStart);
  const specifications = launcher.slice(specificationsStart, specificationsEnd);
  expect(specifications).toContain(
    "$specifications = [System.Collections.Generic.List[object]]::new()",
  );
  expect(specifications).toContain(
    'name = "deno"\n        path = Get-CommandPath "deno"\n        arguments = @("--version")\n        envelope = $PrivateToolEnvelopes["deno"]',
  );
  expect(specifications).toContain('envelope = $PrivateToolEnvelopes["bun"]');
  expect(specifications).toContain("envelope = $PrivateToolEnvelopes[$name]");
  expect(specifications).not.toContain("$Consumer");
  const exactProbeOrder = [
    'name = "bun"',
    'name = "deno"',
    '@("npm", "npm.cmd", "--version")',
    '@("pnpm", "pnpm.cmd", "--version")',
    '@("node", "node", "--version")',
    '@("git", "git", "--version")',
    '@("tar", "tar", "--version")',
    '@("unzip", "unzip", "-v")',
    '@("bash", "bash", "--version")',
    '@("cmd", "cmd", "/d", "/c", "ver")',
    '@("taskkill", "taskkill", "/?")',
  ];
  let previousProbe = -1;
  for (const probe of exactProbeOrder) {
    const position = specifications.indexOf(probe);
    expect(position).toBeGreaterThan(previousProbe);
    previousProbe = position;
  }
  expect(specifications).not.toContain("Sort-Object");

  const parentStart = launcher.indexOf("function Invoke-ParentMode {");
  const parentEnd = launcher.indexOf(
    "\ntry {\n    if ($JsonContractSelfTest)",
    parentStart,
  );
  expect(parentStart).toBeGreaterThan(-1);
  expect(parentEnd).toBeGreaterThan(parentStart);
  const parent = launcher.slice(parentStart, parentEnd);
  expect(parent).toContain(
    "$childPathDirectories = [System.Collections.Generic.List[string]]::new()",
  );
  expect(parent).toContain(
    "$seenChildPathDirectories = [System.Collections.Generic.HashSet[string]]::new(\n        [System.StringComparer]::OrdinalIgnoreCase",
  );
  const specificationLoop = parent.indexOf(
    "foreach ($specification in $toolSpecifications)",
  );
  const addCommandDirectory = parent.indexOf(
    "if ($seenChildPathDirectories.Add($commandDirectory)) {\n                $childPathDirectories.Add($commandDirectory) | Out-Null\n            }",
    specificationLoop,
  );
  const addProbe = parent.indexOf(
    "$toolProbes.Add([pscustomobject][ordered]@{",
    addCommandDirectory,
  );
  const addPublicDirectories = parent.indexOf(
    "foreach ($publicDirectory in @(",
    addProbe,
  );
  const manifestStart = parent.indexOf("$manifest = [ordered]@{", addPublicDirectories);
  expect(specificationLoop).toBeGreaterThan(-1);
  expect(addCommandDirectory).toBeGreaterThan(specificationLoop);
  expect(addProbe).toBeGreaterThan(addCommandDirectory);
  expect(addPublicDirectories).toBeGreaterThan(addProbe);
  expect(manifestStart).toBeGreaterThan(addPublicDirectories);
  const publicDirectories = parent.slice(addPublicDirectories, manifestStart);
  const powerShellDirectory = publicDirectories.indexOf(
    '(Resolve-Directory (Split-Path -Parent $powerShellPath) "PowerShell directory")',
  );
  const system32Directory = publicDirectories.indexOf("$system32");
  expect(powerShellDirectory).toBeGreaterThan(-1);
  expect(system32Directory).toBeGreaterThan(powerShellDirectory);
  expect(publicDirectories).toContain(
    "if ($seenChildPathDirectories.Add($publicDirectory)) {\n                $childPathDirectories.Add($publicDirectory) | Out-Null\n            }",
  );
  expect(parent).toContain("toolProbes = @($toolProbes)");
  expect(parent).toContain("toolPathDirectories = @($childPathDirectories)");
  expect(parent.slice(specificationLoop, manifestStart)).not.toContain("Sort-Object");
  const writeManifest = parent.indexOf("Write-JsonFile $manifestPath $manifest", manifestStart);
  expect(writeManifest).toBeGreaterThan(manifestStart);
  expect(parent.slice(manifestStart, writeManifest)).not.toContain("Sort-Object");
  expect(parent).not.toContain(
    "toolPathDirectories = @($childPathDirectories | Sort-Object)",
  );

  const childStart = launcher.indexOf("function Invoke-ChildMode(");
  const childEnd = launcher.indexOf("\nfunction Write-LauncherReceipt", childStart);
  expect(childStart).toBeGreaterThan(-1);
  expect(childEnd).toBeGreaterThan(childStart);
  const child = launcher.slice(childStart, childEnd);
  const expectedNamesStart = child.indexOf("$expectedProbeNames = @(");
  const expectedPathsStart = child.indexOf(
    "$expectedToolPathDirectories = [System.Collections.Generic.List[string]]::new()",
    expectedNamesStart,
  );
  const deriveProbeDirectories = child.indexOf(
    "foreach ($probe in $manifestToolProbes)",
    expectedPathsStart,
  );
  const appendPublicDirectories = child.indexOf(
    "foreach ($publicDirectory in @(",
    deriveProbeDirectories,
  );
  const comparePathCount = child.indexOf(
    "if ($toolPathDirectories.Count -ne $expectedToolPathDirectories.Count)",
    appendPublicDirectories,
  );
  const compareEachPath = child.indexOf(
    "for ($index = 0; $index -lt $toolPathDirectories.Count; $index += 1)",
    comparePathCount,
  );
  const executeProbes = child.indexOf(
    "$toolProbeEvidence = [System.Collections.Generic.List[object]]::new()",
    compareEachPath,
  );
  expect(expectedNamesStart).toBeGreaterThan(-1);
  expect(expectedPathsStart).toBeGreaterThan(expectedNamesStart);
  expect(deriveProbeDirectories).toBeGreaterThan(expectedPathsStart);
  expect(appendPublicDirectories).toBeGreaterThan(deriveProbeDirectories);
  expect(comparePathCount).toBeGreaterThan(appendPublicDirectories);
  expect(compareEachPath).toBeGreaterThan(comparePathCount);
  expect(executeProbes).toBeGreaterThan(compareEachPath);
  const childPathContract = child.slice(expectedNamesStart, executeProbes);
  expect(child).toContain(
    "$toolPathDirectories = [System.Collections.Generic.List[string]]::new()",
  );
  expect(child).toContain(
    "$seenToolPathDirectories = [System.Collections.Generic.HashSet[string]]::new(\n        [System.StringComparer]::OrdinalIgnoreCase",
  );
  expect(childPathContract).toContain(
    '$expectedProbeNames = @(\n        "bun",\n        "deno",\n        "npm",\n        "pnpm",\n        "node",\n        "git",\n        "tar",\n        "unzip",\n        "bash",\n        "cmd",\n        "taskkill"\n    )',
  );
  expect(childPathContract).not.toContain(
    'if ($manifest.operation -eq "consumer")',
  );
  expect(childPathContract).toContain(
    "$seenExpectedToolPathDirectories = [System.Collections.Generic.HashSet[string]]::new(\n        [System.StringComparer]::OrdinalIgnoreCase",
  );
  expect(childPathContract).toContain(
    "$probePathForDirectory = Resolve-File `\n            $probe.path `",
  );
  expect(childPathContract).toContain(
    "if ($seenExpectedToolPathDirectories.Add($probeDirectory)) {\n            $expectedToolPathDirectories.Add($probeDirectory) | Out-Null\n        }",
  );
  expect(childPathContract).toContain(
    "if ($seenExpectedToolPathDirectories.Add($publicDirectory)) {\n            $expectedToolPathDirectories.Add($publicDirectory) | Out-Null\n        }",
  );
  expect(childPathContract).toContain(
    "[string]::Equals(\n                $toolPathDirectories[$index],\n                $expectedToolPathDirectories[$index],\n                [System.StringComparison]::OrdinalIgnoreCase",
  );
  expect(childPathContract).toContain(
    'Fail "child tool PATH precedence disagrees with the exact probe contract"',
  );
  expect(childPathContract).not.toContain("Sort-Object");

  const proofValidatorStart = launcher.indexOf("function Read-And-ValidateProof(");
  const proofValidatorEnd = launcher.indexOf(
    "\nfunction New-ExplicitChildEnvironment(",
    proofValidatorStart,
  );
  expect(proofValidatorStart).toBeGreaterThan(-1);
  expect(proofValidatorEnd).toBeGreaterThan(proofValidatorStart);
  const proofValidator = launcher.slice(proofValidatorStart, proofValidatorEnd);
  const proofNamesStart = proofValidator.indexOf("$manifestProbeNames = @(");
  const proofNamesEnd = proofValidator.indexOf(
    'if ($Manifest.operation -eq "consumer")',
    proofNamesStart,
  );
  expect(proofNamesStart).toBeGreaterThan(-1);
  expect(proofNamesEnd).toBeGreaterThan(proofNamesStart);
  const orderedProbeComparison = proofValidator.slice(proofNamesStart, proofNamesEnd);
  expect(orderedProbeComparison).toContain(
    "$Manifest.toolProbes | ForEach-Object { [string]$_.name }",
  );
  expect(orderedProbeComparison).toContain(
    "$proofProbes | ForEach-Object { [string]$_.name }",
  );
  expect(orderedProbeComparison).toContain(
    '[string]::Join("`n", $proofProbeNames) -cne\n            [string]::Join("`n", $manifestProbeNames)',
  );
  expect(orderedProbeComparison).not.toContain("Sort-Object");
});

test("private tools execute only from a disjoint read-only staging root", () => {
  const launcher = readFileSync(standardUserLauncher, "utf8");
  const parentStart = launcher.indexOf("function Invoke-ParentMode {");
  const parentEnd = launcher.indexOf(
    "\ntry {\n    if ($JsonContractSelfTest)",
    parentStart,
  );
  expect(parentStart).toBeGreaterThan(-1);
  expect(parentEnd).toBeGreaterThan(parentStart);
  const parent = launcher.slice(parentStart, parentEnd);

  expect(parent).toContain(
    '$sandbox = Join-Path $repository "target/windows-standard-user/$nonce"',
  );
  expect(parent).toContain(
    '$toolExecutionRoot = Join-Path $repository "target/windows-standard-user-tools/$nonce"',
  );
  expect(parent).toContain("Test-PathInside $sandbox $toolExecutionRoot");
  expect(parent).toContain("Test-PathInside $toolExecutionRoot $sandbox");
  expect(parent).toContain(
    'Fail "tool execution root and writable sandbox must be disjoint"',
  );
  expect(parent).toContain(
    "Add-EphemeralAclGrant `\n            $sandbox `\n            $sid `\n            ([System.Security.AccessControl.FileSystemRights]::Modify) `",
  );
  expect(parent).toContain(
    "Set-ReadOnlyToolExecutionAcl `\n            $toolExecutionRoot `\n            $sid `\n            $parentIdentity.Sid `\n            $grantedPaths",
  );
  expect(parent).not.toContain(
    "$toolExecutionRoot `\n            $sid `\n            ([System.Security.AccessControl.FileSystemRights]::Modify)",
  );
  expect(parent).not.toContain(
    "$sandbox `\n            $sid `\n            ([System.Security.AccessControl.FileSystemRights]::ReadAndExecute)",
  );
  expect(parent).not.toContain("Add-EphemeralAclGrant `\n            $runnerTemp");
  expect(parent).not.toContain(
    "Add-EphemeralAclGrant `\n            $toolExecutionRoot",
  );
  expect(parent).not.toContain("Get-ToolGrantRoot");
  expect(parent).toContain(
    'Fail "RUNNER_TEMP is required to stage private hosted-runner tools"',
  );
  expect(parent).toContain(
    "$privateToolEnvelopeInputs = [ordered]@{\n            bun = $BunEnvelope\n            deno = $DenoEnvelope\n            'npm' = $NpmEnvelope\n            node = $NodeEnvelope\n            pnpm = $PnpmEnvelope\n        }",
  );
  expect(parent).toContain(
    "$declaredEnvelope = Resolve-Directory `\n                $privateToolEnvelopeInputs[$toolName] `",
  );
  expect(parent).toContain(
    'Fail "$toolName declared private tool execution envelope escaped RUNNER_TEMP"',
  );
  expect(parent).toContain(
    "$privateToolRoot = Get-PrivateToolRoot `\n                $specification.name `\n                $sourceCommandPath `\n                $runnerTemp `\n                $specification.envelope",
  );
  expect(parent).toContain(
    "if (-not $privateToolRoots.ContainsKey($privateToolRoot))",
  );
  expect(parent).toContain(
    "$fingerprint = Copy-PrivateToolTree `\n                        $privateToolRoot `\n                        $destinationRoot `\n                        $toolId",
  );
  expect(parent).toContain(
    "$privateToolRoots.Add($privateToolRoot, $stagingEntry)",
  );
  expect(parent).toContain(
    "[System.IO.Path]::GetRelativePath(\n                    $privateToolRoot,\n                    $sourceCommandPath",
  );
  expect(parent).toContain(
    '(Join-Path $stagedRoot $relativeCommand) `\n                    "$($specification.name) staged command"',
  );
  expect(parent).toContain(
    'Fail "$($specification.name) child command still points into private RUNNER_TEMP"',
  );
  expect(parent).toContain(
    '$childPathDirectories.Add($commandDirectory) | Out-Null',
  );
  expect(parent).not.toContain("$childPathDirectories.Add($sourceCommandPath)");
  expect(parent).toContain(
    'Fail "Bun must execute from a data-only staged private tool tree"',
  );
  const createExecutionRoot = parent.indexOf(
    "New-Item -ItemType Directory -Force -Path $toolExecutionRoot | Out-Null",
  );
  const protectExecutionRoot = parent.indexOf(
    "Set-ReadOnlyToolExecutionAcl `",
    createExecutionRoot,
  );
  const firstPrivateCopy = parent.indexOf(
    "$fingerprint = Copy-PrivateToolTree `",
    protectExecutionRoot,
  );
  expect(createExecutionRoot).toBeGreaterThan(-1);
  expect(protectExecutionRoot).toBeGreaterThan(createExecutionRoot);
  expect(firstPrivateCopy).toBeGreaterThan(protectExecutionRoot);
  expect(parent).toContain("bunPath = $stagedBunPath");
  expect(parent).toContain("toolExecutionRoot = $toolExecutionRoot");
  expect(parent).toContain("toolStaging = @($toolStaging)");
  expect(parent).toContain("toolProbes = @($toolProbes)");
  expect(parent).toContain(
    "toolPathDirectories = @($childPathDirectories)",
  );
  expect(parent).not.toContain("toolPathDirectories = @($childPathDirectories | Sort-Object)");
  expect(parent).toContain(
    "Assert-NoForbiddenString `\n            $manifest `\n            $runnerTemp `\n            \"child manifest\"",
  );
  expect(parent).not.toContain("$manifestJson");
  const stagingEntryStart = parent.indexOf(
    "$stagingEntry = [pscustomobject][ordered]@{",
  );
  const stagingEntryEnd = parent.indexOf(
    "$privateToolRoots.Add($privateToolRoot, $stagingEntry)",
    stagingEntryStart,
  );
  expect(stagingEntryStart).toBeGreaterThan(-1);
  expect(stagingEntryEnd).toBeGreaterThan(stagingEntryStart);
  const stagingEntry = parent.slice(stagingEntryStart, stagingEntryEnd);
  expect(stagingEntry).toContain("destinationRoot =");
  expect(stagingEntry).toContain("fingerprint = $fingerprint");
  expect(stagingEntry).not.toContain("source");
  expect(parent).toContain('$pnpmStore = Join-Path $sandbox "pnpm-store"');
  expect(launcher).not.toMatch(/\bpnpm\s+store\s+path\b/iu);

  const readOnlyAclStart = launcher.indexOf(
    "function Set-ReadOnlyToolExecutionAcl(",
  );
  const manifestGuardStart = launcher.indexOf(
    "function Assert-NoForbiddenString(",
    readOnlyAclStart,
  );
  const manifestGuardEnd = launcher.indexOf(
    "\nfunction Add-CleanupFailure(",
    manifestGuardStart,
  );
  expect(readOnlyAclStart).toBeGreaterThan(-1);
  expect(manifestGuardStart).toBeGreaterThan(readOnlyAclStart);
  expect(manifestGuardEnd).toBeGreaterThan(manifestGuardStart);
  const readOnlyAcl = launcher.slice(readOnlyAclStart, manifestGuardStart);
  const manifestGuard = launcher.slice(manifestGuardStart, manifestGuardEnd);
  expect(readOnlyAcl).toContain("$acl.SetAccessRuleProtection($true, $false)");
  expect(readOnlyAcl).toContain("$acl.SetOwner($parentIdentity)");
  expect(readOnlyAcl).toContain(
    '$systemIdentity = [System.Security.Principal.SecurityIdentifier]::new("S-1-5-18")',
  );
  expect(readOnlyAcl).toContain(
    "[System.Security.AccessControl.FileSystemRights]::FullControl",
  );
  expect(readOnlyAcl).toContain(
    "[System.Security.AccessControl.FileSystemRights]::ReadAndExecute",
  );
  expect(readOnlyAcl).toContain("-not $observedAcl.AreAccessRulesProtected");
  expect(readOnlyAcl).toContain("$standardRules.Count -ne 1");
  expect(readOnlyAcl).toContain(
    "$standardRights -band [System.Security.AccessControl.FileSystemRights]::Write",
  );
  expect(readOnlyAcl).toContain(
    "$standardRights -band [System.Security.AccessControl.FileSystemRights]::Modify",
  );
  expect(manifestGuard).toContain(
    "$Value.IndexOf($Forbidden, [System.StringComparison]::OrdinalIgnoreCase)",
  );
  expect(manifestGuard).toContain("$Value -is [System.Collections.IDictionary]");
  expect(manifestGuard).toContain("Assert-NoForbiddenString $Value[$key]");
  expect(manifestGuard).toContain("$Value -is [System.Collections.IEnumerable]");
  expect(manifestGuard).toContain("Assert-NoForbiddenString $item");
  expect(manifestGuard).toContain(
    "$Value -is [System.Management.Automation.PSCustomObject]",
  );
  expect(manifestGuard).toContain(
    "Assert-NoForbiddenString $property.Value",
  );
});

test("the repository ACL grants Bun metadata compatibility without source-data mutation", () => {
  const launcher = readFileSync(standardUserLauncher, "utf8");
  const aclContractStart = launcher.indexOf(
    "function Assert-RepositoryAclContract(",
  );
  const aclContractEnd = launcher.indexOf(
    "\nfunction Remove-EphemeralAclGrant(",
    aclContractStart,
  );
  expect(aclContractStart).toBeGreaterThan(-1);
  expect(aclContractEnd).toBeGreaterThan(aclContractStart);
  const aclContract = launcher.slice(aclContractStart, aclContractEnd);
  expect(aclContract).toContain("-not $state.Acl.AreAccessRulesCanonical");
  expect(aclContract).toContain("$state.Rules.Count -ne 2");
  expect(aclContract).toContain("$denyRules.Count -ne 1");
  expect(aclContract).toContain("$allowRules.Count -ne 1");
  expect(aclContract).toContain(
    "$state.Rules[0].AccessControlType -ne\n            [System.Security.AccessControl.AccessControlType]::Deny",
  );
  expect(aclContract).toContain(
    "$state.Rules[1].AccessControlType -ne\n            [System.Security.AccessControl.AccessControlType]::Allow",
  );
  expect(aclContract).toContain(
    "[System.Security.AccessControl.FileSystemRights]::ReadAndExecute -bor\n        [System.Security.AccessControl.FileSystemRights]::WriteAttributes -bor\n        [System.Security.AccessControl.FileSystemRights]::Synchronize",
  );
  for (const forbidden of [
    "WriteData",
    "AppendData",
    "WriteExtendedAttributes",
    "DeleteSubdirectoriesAndFiles",
    "Delete",
    "ChangePermissions",
    "TakeOwnership",
  ]) {
    expect(aclContract).toContain(
      `[System.Security.AccessControl.FileSystemRights]::${forbidden}`,
    );
  }
  expect(aclContract).toContain(
    "$allowRules[0].FileSystemRights -ne $expectedAllow",
  );
  expect(aclContract).toContain(
    "$denyRules[0].FileSystemRights -ne $expectedDeny",
  );
  expect(aclContract).toContain(
    "$rule.InheritanceFlags -ne $expectedInheritance",
  );
  expect(aclContract).toContain(
    "$rule.PropagationFlags -ne [System.Security.AccessControl.PropagationFlags]::None",
  );
  expect(aclContract).toContain("$acl.AreAccessRulesProtected");
  expect(aclContract).toContain("$_.IsInherited");

  const parentStart = launcher.indexOf("function Invoke-ParentMode {");
  const parentEnd = launcher.indexOf(
    "\ntry {\n    if ($JsonContractSelfTest)",
    parentStart,
  );
  const parent = launcher.slice(parentStart, parentEnd);
  expect(parent).toContain(
    '"target/js-exact-candidate-consumer/windows-x64-msvc"',
  );
  expect(parent).toContain(
    'Fail "-OutputRoot must be the exact Windows candidate output root"',
  );
  expect(parent).not.toContain(
    'Fail "-OutputRoot must be a strict repository descendant"',
  );
  const grantStage = parent.indexOf(
    '$currentStage = "grant bounded standard-user filesystem access"',
  );
  const repositoryContract = parent.indexOf(
    "Set-RepositoryEphemeralAclContract `\n            $repository `",
    grantStage,
  );
  expect(grantStage).toBeGreaterThan(-1);
  expect(parent.slice(grantStage, repositoryContract)).toContain(
    "$repositoryReadRights =\n            [System.Security.AccessControl.FileSystemRights]::ReadAndExecute -bor\n            [System.Security.AccessControl.FileSystemRights]::WriteAttributes -bor\n            [System.Security.AccessControl.FileSystemRights]::Synchronize",
  );
  expect(parent.slice(grantStage, repositoryContract)).toContain(
    "$repositoryMutationRights =\n            [System.Security.AccessControl.FileSystemRights]::WriteData -bor",
  );
  expect(repositoryContract).toBeGreaterThan(grantStage);
  expect(parent.slice(repositoryContract)).toContain(
    "$repositoryReadRights `\n            $repositoryMutationRights `",
  );
  const atomicContractStart = launcher.indexOf(
    "function Set-RepositoryEphemeralAclContract(",
  );
  const atomicContractEnd = launcher.indexOf(
    "\nfunction Assert-RepositoryAclContract(",
    atomicContractStart,
  );
  const atomicContract = launcher.slice(atomicContractStart, atomicContractEnd);
  expect(atomicContractStart).toBeGreaterThan(-1);
  expect(atomicContractEnd).toBeGreaterThan(atomicContractStart);
  expect(atomicContract.match(/Set-Acl -LiteralPath/gu)).toHaveLength(1);
  const denyRule = atomicContract.indexOf(
    "[System.Security.AccessControl.AccessControlType]::Deny",
  );
  const allowRule = atomicContract.indexOf(
    "[System.Security.AccessControl.AccessControlType]::Allow",
  );
  const trackRoot = atomicContract.indexOf("$GrantedPaths.Add($PathValue)");
  const persist = atomicContract.indexOf("Set-Acl -LiteralPath");
  const verify = atomicContract.indexOf("Assert-RepositoryAclContract");
  expect(denyRule).toBeGreaterThan(-1);
  expect(allowRule).toBeGreaterThan(denyRule);
  expect(trackRoot).toBeGreaterThan(allowRule);
  expect(persist).toBeGreaterThan(trackRoot);
  expect(verify).toBeGreaterThan(persist);
  const verdaccioGrant = parent.indexOf(
    "Add-EphemeralAclGrant `\n                    $writable `",
    repositoryContract,
  );
  const trackedInputDeny = parent.indexOf(
    "Add-EphemeralAclDeny `\n                    $protectedInput `",
    verdaccioGrant,
  );
  expect(verdaccioGrant).toBeGreaterThan(repositoryContract);
  expect(trackedInputDeny).toBeGreaterThan(verdaccioGrant);
  expect(parent.slice(trackedInputDeny)).toContain("$false `");
  expect(parent).toContain('"tools/release/verdaccio-runtime/package.json"');
  expect(parent).toContain('"tools/release/verdaccio-runtime/pnpm-lock.yaml"');
});

test("consumer control integrity and inherited ACL cleanup fail closed", () => {
  const launcher = readFileSync(standardUserLauncher, "utf8");
  const trackedTreeProofStart = launcher.indexOf(
    "function Assert-CleanTrackedCandidateTree(",
  );
  const trackedTreeProofEnd = launcher.indexOf(
    "\nfunction Test-PathInside(",
    trackedTreeProofStart,
  );
  expect(trackedTreeProofStart).toBeGreaterThan(-1);
  expect(trackedTreeProofEnd).toBeGreaterThan(trackedTreeProofStart);
  const trackedTreeProof = launcher.slice(
    trackedTreeProofStart,
    trackedTreeProofEnd,
  );
  expect(trackedTreeProof).toContain(
    "git -C $Repository diff --quiet --no-ext-diff HEAD --",
  );
  expect(trackedTreeProof).toContain(
    "git -C $Repository diff --cached --quiet --no-ext-diff HEAD --",
  );
  expect(trackedTreeProof).toContain("if ($worktreeStatus -ne 0)");
  expect(trackedTreeProof).toContain("if ($indexStatus -ne 0)");

  const inheritedProofStart = launcher.indexOf("function Assert-NoAclRulesForSid(");
  const inheritedProofEnd = launcher.indexOf(
    "\nfunction Add-EphemeralAclGrant(",
    inheritedProofStart,
  );
  expect(inheritedProofStart).toBeGreaterThan(-1);
  expect(inheritedProofEnd).toBeGreaterThan(inheritedProofStart);
  const inheritedProof = launcher.slice(inheritedProofStart, inheritedProofEnd);
  expect(inheritedProof).toContain(
    "$acl.GetAccessRules(\n            $true,\n            $true,",
  );
  expect(inheritedProof).toContain(
    'Fail "$Label retains explicit or inherited standard-user ACL rules"',
  );

  const childStart = launcher.indexOf("function Invoke-ChildMode(");
  const childEnd = launcher.indexOf("\nfunction Write-LauncherReceipt", childStart);
  const child = launcher.slice(childStart, childEnd);
  const preflightTrackedTree = child.indexOf(
    '"before staged Bun consumer module-load proof"',
  );
  const moduleLoad = child.indexOf(
    "$consumerModuleLoadResult = Invoke-BoundedToolProbe `",
    preflightTrackedTree,
  );
  const postPreflightTrackedTree = child.indexOf(
    '"after staged Bun consumer module-load proof"',
    moduleLoad,
  );
  const runConsumer = child.indexOf("& $bunPath @arguments");
  const captureConsumerExit = child.indexOf("$consumerExitCode = $LASTEXITCODE", runConsumer);
  const postConsumerClosure = child.indexOf(
    "(Get-RepositoryControlReadSetSha256 $repository) -cne",
    captureConsumerExit,
  );
  const postConsumerTrackedTree = child.indexOf(
    '"after exact-candidate consumer"',
    postConsumerClosure,
  );
  const handleConsumerExit = child.indexOf(
    "if ($consumerExitCode -ne 0)",
    postConsumerTrackedTree,
  );
  expect(preflightTrackedTree).toBeGreaterThan(-1);
  expect(moduleLoad).toBeGreaterThan(preflightTrackedTree);
  expect(postPreflightTrackedTree).toBeGreaterThan(moduleLoad);
  expect(runConsumer).toBeGreaterThan(-1);
  expect(captureConsumerExit).toBeGreaterThan(runConsumer);
  expect(postConsumerClosure).toBeGreaterThan(captureConsumerExit);
  expect(postConsumerTrackedTree).toBeGreaterThan(postConsumerClosure);
  expect(handleConsumerExit).toBeGreaterThan(postConsumerTrackedTree);

  const parentStart = launcher.indexOf("function Invoke-ParentMode {");
  const parentEnd = launcher.indexOf(
    "\ntry {\n    if ($JsonContractSelfTest)",
    parentStart,
  );
  const parent = launcher.slice(parentStart, parentEnd);
  const invokeChild = parent.indexOf("$childResult = Invoke-ChildProcess `");
  const parentIntegrity = parent.indexOf(
    '$currentStage = "validate parent-side consumer entrypoint integrity"',
    invokeChild,
  );
  const validateProof = parent.indexOf(
    '$currentStage = "validate standard-user child proof"',
    parentIntegrity,
  );
  expect(parentIntegrity).toBeGreaterThan(invokeChild);
  expect(parent.slice(parentIntegrity, validateProof)).toContain(
    "Get-RepositoryControlReadSetSha256 $repository",
  );
  expect(parent.slice(parentIntegrity, validateProof)).toContain(
    '"after standard-user child"',
  );
  expect(validateProof).toBeGreaterThan(parentIntegrity);
  expect(parent).toContain(
    "protectedWritableInputs = @($protectedWritableInputs)",
  );

  const processCleanup = parent.indexOf("Stop-And-ProveNoAccountProcesses");
  const finalIntegrity = parent.indexOf(
    'Add-CleanupFailure $cleanupErrors "consumer entrypoint integrity proof"',
    processCleanup,
  );
  const firstAclRemoval = parent.indexOf(
    "for ($index = $uniqueGrantedPaths.Count - 1; $index -ge 0; $index -= 1)",
    finalIntegrity,
  );
  const removeAccount = parent.indexOf(
    "Remove-LocalUser -Name $userName",
    firstAclRemoval,
  );
  const removeRepositoryAcl = parent.indexOf(
    "Remove-EphemeralAclGrant $repository $user.SID.Value",
    removeAccount,
  );
  const firstInheritedAbsence = parent.indexOf(
    '"repository consumer entrypoint after ACL cleanup"',
    removeRepositoryAcl,
  );
  const idempotentRemoval = parent.indexOf(
    "foreach ($grantedPath in $uniqueGrantedPaths)",
    firstInheritedAbsence,
  );
  const secondInheritedAbsence = parent.indexOf(
    '"repository consumer entrypoint after idempotent ACL cleanup"',
    idempotentRemoval,
  );
  expect(processCleanup).toBeGreaterThan(-1);
  expect(finalIntegrity).toBeGreaterThan(processCleanup);
  expect(parent.slice(processCleanup, finalIntegrity)).toContain(
    '"during standard-user failure cleanup"',
  );
  expect(firstAclRemoval).toBeGreaterThan(finalIntegrity);
  expect(removeAccount).toBeGreaterThan(firstAclRemoval);
  expect(removeRepositoryAcl).toBeGreaterThan(removeAccount);
  expect(firstInheritedAbsence).toBeGreaterThan(removeRepositoryAcl);
  expect(idempotentRemoval).toBeGreaterThan(firstInheritedAbsence);
  expect(secondInheritedAbsence).toBeGreaterThan(idempotentRemoval);
});

test("the alternate-token child verifies staged trees and executes real tool probes before success", () => {
  const launcher = readFileSync(standardUserLauncher, "utf8");
  const childStart = launcher.indexOf("function Invoke-ChildMode(");
  const childEnd = launcher.indexOf("\nfunction Write-LauncherReceipt", childStart);
  expect(childStart).toBeGreaterThan(-1);
  expect(childEnd).toBeGreaterThan(childStart);
  const child = launcher.slice(childStart, childEnd);

  expect(child).toContain(
    '$toolExecutionRoot = Resolve-Directory `\n        $manifest.toolExecutionRoot `\n        "child tool execution root"',
  );
  expect(child).toContain("Test-PathInside $repository $toolExecutionRoot");
  expect(child).toContain("Test-PathInside $sandbox $toolExecutionRoot");
  expect(child).toContain("Test-PathInside $toolExecutionRoot $sandbox");
  expect(child).toContain(
    'Fail "child repository, sandbox, and tool execution roots violate containment"',
  );
  expect(child).toContain("$manifestToolStaging = @($manifest.toolStaging)");
  expect(child).toContain(
    '-not (Test-PathInside $toolExecutionRoot $stagedRoot)',
  );
  expect(child).toContain(
    "$observedFingerprint = Get-ToolTreeFingerprint `",
  );
  expect(child).toContain(
    "Assert-ToolTreeFingerprintEqual `\n            $staging.fingerprint `\n            $observedFingerprint `",
  );
  expect(child).toContain(
    "$manifestToolPathDirectories = @($manifest.toolPathDirectories)",
  );
  expect(child).toContain(
    "-not [System.IO.Path]::IsPathFullyQualified($pathValue)",
  );
  expect(child).toContain(
    "$pathValue.Contains([string][System.IO.Path]::PathSeparator)",
  );
  expect(child).toContain(
    "$env:PATH = [string]::Join(\n        [System.IO.Path]::PathSeparator,\n        $toolPathDirectories",
  );
  const setPath = child.indexOf("$env:PATH = [string]::Join(");
  const bindPnpmStore = child.indexOf(
    '$pnpmStore = Resolve-Directory $manifest.pnpmStore "child pnpm store"',
    setPath,
  );
  const rejectExternalPnpmStore = child.indexOf(
    "-not (Test-PathInside $sandbox $pnpmStore)",
    bindPnpmStore,
  );
  const denyToolRootWrite = child.indexOf(
    "Assert-DirectoryCreateDenied `",
    rejectExternalPnpmStore,
  );
  const proveSandboxWrite = child.indexOf(
    "Assert-DirectoryWriteRoundTrip `",
    denyToolRootWrite,
  );
  const validateBun = child.indexOf(
    '$bunPath = Resolve-File $manifest.bunPath "child staged Bun"',
    proveSandboxWrite,
  );
  const consumerReadProof = child.indexOf(
    "$consumerEntrypoint = Resolve-File `",
    validateBun,
  );
  const consumerModuleLoadProof = child.indexOf(
    "$consumerModuleLoadResult = Invoke-BoundedToolProbe `",
    consumerReadProof,
  );
  const expectedProbes = child.indexOf(
    "$expectedProbeNames = @(",
    consumerModuleLoadProof,
  );
  const executeProbe = child.indexOf(
    "$probeResult = Invoke-BoundedToolProbe `",
    expectedProbes,
  );
  const bunEvidence = child.indexOf(
    '$bunProbe = @($toolProbeEvidence | Where-Object { $_.name -ceq "bun" })',
    executeProbe,
  );
  const gitProof = child.indexOf(
    "$head = (& git -C $repository rev-parse HEAD).Trim()",
    bunEvidence,
  );
  const proofObject = child.indexOf("$proof = [ordered]@{", bunEvidence);
  const proof = child.indexOf("toolAccess = [ordered]@{", bunEvidence);
  const writeProof = child.indexOf("Write-JsonFile $manifest.proofPath $proof", proof);
  const selfTestSuccess = child.indexOf(
    'Write-Output "OLIPHAUNT_WINDOWS_STANDARD_USER_CHILD_OK"',
    writeProof,
  );
  expect(setPath).toBeGreaterThan(-1);
  expect(bindPnpmStore).toBeGreaterThan(setPath);
  expect(rejectExternalPnpmStore).toBeGreaterThan(bindPnpmStore);
  expect(child).toContain(
    'Fail "child pnpm store is not inside the writable sandbox"',
  );
  expect(denyToolRootWrite).toBeGreaterThan(rejectExternalPnpmStore);
  expect(child.slice(denyToolRootWrite, proveSandboxWrite)).toContain(
    '$toolExecutionRoot `\n        "staged tool execution root"',
  );
  expect(proveSandboxWrite).toBeGreaterThan(denyToolRootWrite);
  expect(child.slice(proveSandboxWrite, validateBun)).toContain(
    '$pnpmStore `\n        "sandbox-local pnpm store"',
  );
  expect(child.slice(proveSandboxWrite, validateBun)).toContain(
    "$manifestWritableRoots = @($manifest.writableRoots)",
  );
  expect(child.slice(proveSandboxWrite, validateBun)).toContain(
    "Assert-DirectoryWriteRoundTrip $writableRoot",
  );
  expect(child.slice(proveSandboxWrite, validateBun)).toContain(
    "$manifestProtectedInputs = @($manifest.protectedWritableInputs)",
  );
  expect(child).toContain(
    "$manifest.protectedWritableInputs -isnot [System.Array]",
  );
  expect(child.slice(proveSandboxWrite, validateBun)).toContain(
    "$expectedProtectedInputs = [System.Collections.Generic.List[string]]::new()",
  );
  expect(child.slice(proveSandboxWrite, validateBun)).not.toContain(
    '$expectedProtectedInputs = if ($manifest.operation -eq "consumer")',
  );
  expect(child.slice(proveSandboxWrite, validateBun)).toContain(
    "Add-ExpectedProtectedWritableInputs `",
  );
  expect(child.slice(proveSandboxWrite, validateBun)).toContain(
    'Assert-FileWriteOpenDenied $protectedInput "tracked writable-subtree input"',
  );
  expect(child.slice(proveSandboxWrite, validateBun)).toContain(
    'Assert-FileAppendOpenDenied $protectedInput "tracked writable-subtree input"',
  );
  expect(validateBun).toBeGreaterThan(setPath);
  expect(child).toContain(
    '-not (Test-PathInside $toolExecutionRoot $bunPath)',
  );
  expect(consumerReadProof).toBeGreaterThan(validateBun);
  expect(child.slice(consumerReadProof, consumerModuleLoadProof)).toContain(
    'Assert-DirectoryCreateDenied $repository "repository root"',
  );
  expect(child.slice(consumerReadProof, consumerModuleLoadProof)).toContain(
    "$relativeControlPath in $RepositoryConsumerControlReadRelativePaths",
  );
  expect(child.slice(consumerReadProof, consumerModuleLoadProof)).toContain(
    'Assert-DirectoryCreateDenied `\n                $controlDirectory `\n                "repository consumer control directory"',
  );
  expect(child.slice(consumerReadProof, consumerModuleLoadProof)).toContain(
    'Assert-FileWriteOpenDenied $consumerEntrypoint "repository consumer entrypoint"',
  );
  expect(child.slice(consumerReadProof, consumerModuleLoadProof)).toContain(
    'Assert-FileAppendOpenDenied $consumerEntrypoint "repository consumer entrypoint"',
  );
  expect(child.slice(consumerReadProof, consumerModuleLoadProof)).toContain(
    'Assert-FileAttributeWriteAllowed $consumerEntrypoint "repository consumer entrypoint"',
  );
  expect(child.slice(consumerReadProof, consumerModuleLoadProof)).toContain(
    "Assert-InheritedRepositoryMutationDeny `",
  );
  expect(child.slice(consumerReadProof, consumerModuleLoadProof)).toContain(
    "$consumerEntrypointSha256 -cne $manifest.consumerEntrypointSha256",
  );
  expect(consumerModuleLoadProof).toBeGreaterThan(consumerReadProof);
  expect(child.slice(consumerModuleLoadProof, expectedProbes)).toContain(
    "@($consumerEntrypoint, $RepositoryConsumerModuleLoadArgument)",
  );
  expect(child.slice(consumerModuleLoadProof, expectedProbes)).toContain(
    '$consumerModuleLoadResult.stdout.Trim() -cne\n            ($RepositoryConsumerModuleLoadProof + "`t" + $consumerControlReadSetSha256)',
  );
  expect(child.slice(consumerModuleLoadProof, expectedProbes)).toContain(
    'Fail "staged Bun changed the repository consumer control read set"',
  );
  expect(expectedProbes).toBeGreaterThan(consumerModuleLoadProof);
  expect(child.slice(expectedProbes, executeProbe)).toContain(
    '$expectedProbeNames = @(\n        "bun",\n        "deno",\n        "npm",\n        "pnpm",\n        "node",',
  );
  expect(child.slice(expectedProbes, executeProbe)).not.toContain(
    'if ($manifest.operation -eq "consumer")',
  );
  expect(executeProbe).toBeGreaterThan(expectedProbes);
  const denyStagedExecutableWrite = child.indexOf(
    "Assert-FileWriteOpenDenied `",
    expectedProbes,
  );
  expect(denyStagedExecutableWrite).toBeGreaterThan(expectedProbes);
  expect(denyStagedExecutableWrite).toBeLessThan(executeProbe);
  expect(child.slice(expectedProbes, executeProbe)).toContain(
    "if ($probeIsStaged)",
  );
  expect(child.slice(expectedProbes, executeProbe)).toContain(
    '$probePath `\n                "staged $($probe.name) executable"',
  );
  expect(child.slice(executeProbe, bunEvidence)).toContain(
    "$probeResult.exitCode -ne 0",
  );
  expect(child.slice(executeProbe, bunEvidence)).toContain(
    "[string]::IsNullOrWhiteSpace($probeResult.stdout + $probeResult.stderr)",
  );
  expect(child.slice(executeProbe, bunEvidence)).toContain(
    "[System.Security.Cryptography.SHA256]::HashData($probeBytes)",
  );
  expect(bunEvidence).toBeGreaterThan(executeProbe);
  expect(child).toContain(
    'Fail "child did not execute exactly one staged Bun probe"',
  );
  expect(gitProof).toBeGreaterThan(setPath);
  expect(proof).toBeGreaterThan(bunEvidence);
  expect(child.slice(proof, writeProof)).toContain("stagingVerified = $true");
  expect(child.slice(proof, writeProof)).toContain(
    "stagedTreeCount = $manifestToolStaging.Count",
  );
  expect(child.slice(proof, writeProof)).toContain("bunExecuted = $true");
  expect(child.slice(proof, writeProof)).toContain(
    "toolRootWriteDenied = $true",
  );
  expect(child.slice(proof, writeProof)).toContain(
    "sandboxWriteVerified = $true",
  );
  expect(child.slice(proof, writeProof)).toContain(
    "writableRootsNestedRoundTripVerified = $true",
  );
  expect(child.slice(proof, writeProof)).toContain(
    "probes = @($toolProbeEvidence)",
  );
  expect(proofObject).toBeGreaterThan(bunEvidence);
  expect(child.slice(proofObject, writeProof)).toContain(
    "repositoryAccess = $repositoryAccessEvidence",
  );
  expect(child.slice(consumerReadProof, proofObject)).toContain(
    "controlReadSetSha256 = $consumerControlReadSetSha256",
  );
  expect(child.slice(consumerReadProof, proofObject)).toContain(
    "preflightTrackedTreeCleanVerified = $true",
  );
  expect(child.slice(consumerReadProof, proofObject)).toContain(
    "entrypointDataWriteDenied = $true",
  );
  for (const evidence of [
    "entrypointAppendDenied",
    "metadataWriteVerified",
    "inheritedMutationDenyVerified",
    "controlReadSetMutationDenied",
    "sourceDirectoryCreateDenied",
    "protectedWritableInputsWriteDenied",
  ]) {
    expect(child.slice(consumerReadProof, proofObject)).toContain(
      `${evidence} = $true`,
    );
  }
  expect(writeProof).toBeGreaterThan(proof);
  expect(selfTestSuccess).toBeGreaterThan(writeProof);
  expect(child).toContain("& $bunPath @arguments");
  expect(child).not.toContain("& $manifest.bunPath @arguments");

  const boundedProbeStart = launcher.indexOf(
    "function Invoke-BoundedToolProbe(",
  );
  const boundedProbeEnd = launcher.indexOf(
    "\nfunction Get-ProcessesForAccount(",
    boundedProbeStart,
  );
  expect(boundedProbeStart).toBeGreaterThan(-1);
  expect(boundedProbeEnd).toBeGreaterThan(boundedProbeStart);
  const boundedProbe = launcher.slice(boundedProbeStart, boundedProbeEnd);
  expect(boundedProbe).toContain('$extension -in @(".cmd", ".bat")');
  expect(boundedProbe).toContain(
    "[char[]]@('\"', '%', '!', '^', '&', '|', '<', '>', '(', ')', \"`r\", \"`n\")",
  );
  expect(boundedProbe).toContain(
    "Where-Object { $_ -notmatch '^[A-Za-z0-9._/?=-]+$' }",
  );
  expect(boundedProbe).toContain('$commandArguments = @(');
  for (const token of ['"/d"', '"/s"', '"/v:off"', '"/c"', '"call"']) {
    expect(boundedProbe).toContain(token);
  }
  expect(boundedProbe).toContain("$Executable\n        ) + @($Arguments)");
  expect(boundedProbe).toContain("([string[]]$commandArguments)");
  expect(boundedProbe).not.toContain("$commandLine =");
  expect(boundedProbe.match(/Invoke-BoundedNativeProcess/gu)).toHaveLength(2);

  const accessDeniedClassifierStart = launcher.indexOf(
    "function Test-IsAccessDeniedException(",
  );
  const directoryDeniedStart = launcher.indexOf(
    "function Assert-DirectoryCreateDenied(",
    accessDeniedClassifierStart,
  );
  const fileDeniedStart = launcher.indexOf(
    "function Assert-FileWriteOpenDenied(",
    directoryDeniedStart,
  );
  const writeRoundTripStart = launcher.indexOf(
    "function Assert-DirectoryWriteRoundTrip(",
    fileDeniedStart,
  );
  const accessProofEnd = launcher.indexOf(
    "\nfunction Add-CleanupFailure(",
    writeRoundTripStart,
  );
  expect(accessDeniedClassifierStart).toBeGreaterThan(-1);
  expect(directoryDeniedStart).toBeGreaterThan(accessDeniedClassifierStart);
  expect(fileDeniedStart).toBeGreaterThan(directoryDeniedStart);
  expect(writeRoundTripStart).toBeGreaterThan(fileDeniedStart);
  expect(accessProofEnd).toBeGreaterThan(writeRoundTripStart);
  const accessDeniedClassifier = launcher.slice(
    accessDeniedClassifierStart,
    directoryDeniedStart,
  );
  const directoryDenied = launcher.slice(directoryDeniedStart, fileDeniedStart);
  const fileDenied = launcher.slice(fileDeniedStart, writeRoundTripStart);
  const writeRoundTrip = launcher.slice(writeRoundTripStart, accessProofEnd);
  expect(accessDeniedClassifier).toContain("$current = $current.InnerException");
  expect(accessDeniedClassifier).toContain("$depth -lt 16");
  expect(accessDeniedClassifier).toContain(
    "$current -is [System.UnauthorizedAccessException]",
  );
  expect(accessDeniedClassifier).toContain(
    "$current -is [System.Security.SecurityException]",
  );
  expect(accessDeniedClassifier).toContain("$current.HResult -eq -2147024891");
  expect(directoryDenied).toContain(
    '[System.IO.File]::WriteAllText($probePath, "must-not-write", $Utf8NoBom)',
  );
  expect(directoryDenied).toContain("Test-Path -LiteralPath $probePath");
  expect(directoryDenied).toContain("Remove-Item -LiteralPath $probePath");
  expect(directoryDenied).toContain("Test-IsAccessDeniedException $failure");
  expect(fileDenied).toContain("[System.IO.FileAccess]::Write");
  expect(fileDenied).toContain("$stream.Dispose()");
  expect(fileDenied).toContain("Test-IsAccessDeniedException $failure");
  expect(fileDenied).toContain("function Assert-FileAppendOpenDenied(");
  expect(fileDenied).toContain("[System.IO.FileMode]::Append");
  expect(fileDenied).toContain("function Assert-FileAttributeWriteAllowed(");
  expect(fileDenied).toContain("[System.IO.File]::SetAttributes($PathValue, $attributes)");
  expect(writeRoundTrip).toContain("[System.IO.Directory]::CreateDirectory($nested)");
  expect(writeRoundTrip).toContain("[System.IO.File]::WriteAllText(");
  expect(writeRoundTrip).toContain(
    '[System.IO.File]::AppendAllText($probePath, "+append", $Utf8NoBom)',
  );
  expect(writeRoundTrip).toContain(
    "[System.IO.File]::ReadAllText($probePath, [System.Text.Encoding]::UTF8)",
  );
  expect(writeRoundTrip).toContain("[System.IO.File]::Move($probePath, $renamedPath)");
  expect(writeRoundTrip).toContain("[System.IO.File]::Delete($renamedPath)");
  expect(writeRoundTrip).toContain("Remove-Item -LiteralPath $probeRoot -Recurse");
  expect(writeRoundTrip).toContain("Test-Path -LiteralPath $probeRoot");
  expect(launcher).toContain(
    "[System.Management.Automation.MethodInvocationException]::new(",
  );
  expect(launcher).toContain(
    "-not (Test-IsAccessDeniedException $wrappedAccessDenied)",
  );
});

test("the ephemeral account description fits the Windows local-user contract", () => {
  const launcher = readFileSync(standardUserLauncher, "utf8");
  const description = launcher.match(
    /\$localUserDescription = "([^"]+)"/u,
  )?.[1];
  expect(description).toBeDefined();
  expect(description?.length).toBeLessThanOrEqual(48);
  expect(launcher).toContain("$LocalUserDescriptionMaxLength = 48");
  expect(launcher).toContain(
    "$localUserDescription.Length -gt $LocalUserDescriptionMaxLength",
  );
  expect(launcher).toContain("Description = $localUserDescription");
});

test("all generated local-account fields enforce Windows limits before creation", () => {
  const launcher = readFileSync(standardUserLauncher, "utf8");
  const nameParts = launcher.match(
    /\$userName = "([^"]+)" \+ \$nonce\.Substring\(0, (\d+)\)/u,
  );
  const passwordBytes = Number(
    launcher.match(/\$bytes = \[byte\[\]\]::new\((\d+)\)/u)?.[1],
  );
  const passwordSuffix = launcher.match(
    /ToBase64String\(\$bytes\) \+ "([^"]*)"/u,
  )?.[1];
  expect(nameParts).not.toBeNull();
  expect(
    (nameParts?.[1].length ?? Infinity) + Number(nameParts?.[2]),
  ).toBeLessThanOrEqual(20);
  expect(Number.isInteger(passwordBytes)).toBe(true);
  expect(passwordSuffix).toBeDefined();
  expect(
    Math.ceil(passwordBytes / 3) * 4 + (passwordSuffix?.length ?? Infinity),
  ).toBeLessThanOrEqual(127);
  expect(launcher).toContain("$LocalUserNameMaxLength = 20");
  expect(launcher).toContain("$userName.Length -gt $LocalUserNameMaxLength");
  expect(launcher).toContain(
    'Fail "generated local-user name violates the Windows account-name contract"',
  );
  expect(launcher).toContain("$LocalUserPasswordMaxLength = 127");
  expect(launcher).toContain(
    "$passwordText.Length -gt $LocalUserPasswordMaxLength",
  );
  const nameGuard = launcher.indexOf(
    "$userName.Length -gt $LocalUserNameMaxLength",
  );
  const passwordGuard = launcher.indexOf(
    "$passwordText.Length -gt $LocalUserPasswordMaxLength",
  );
  const createAccount = launcher.indexOf("$user = New-LocalUser @newUser");
  expect(nameGuard).toBeGreaterThan(-1);
  expect(passwordGuard).toBeGreaterThan(nameGuard);
  expect(createAccount).toBeGreaterThan(passwordGuard);
});

test("the Windows standard-user cleanup verifies process quiescence before destructive cleanup", () => {
  const launcher = readFileSync(standardUserLauncher, "utf8");
  const verifierStart = launcher.indexOf("function Stop-And-ProveNoAccountProcesses(");
  const verifierEnd = launcher.indexOf("\nfunction Get-CommandPath", verifierStart);
  expect(verifierStart).toBeGreaterThan(-1);
  expect(verifierEnd).toBeGreaterThan(verifierStart);
  const verifier = launcher.slice(verifierStart, verifierEnd);
  const broadTaskkill = verifier.indexOf(
    "$initialTaskkill = Invoke-BoundedNativeProcess `",
  );
  const enumerateOwners = verifier.indexOf(
    "$lastProcesses = @(Get-ProcessesForAccount $CanonicalUserName)",
  );
  const verified = verifier.indexOf('$Proof["verified"] = $true');
  expect(broadTaskkill).toBeGreaterThan(-1);
  expect(enumerateOwners).toBeGreaterThan(broadTaskkill);
  expect(verified).toBeGreaterThan(enumerateOwners);
  expect(verifier).toContain("$zeroProcessSamples -ge 2");
  expect(verifier).toContain(
    'Fail "standard-user process cleanup did not reach two owner-enumerated zero-process samples"',
  );

  expect(launcher).toContain("Get-Process -IncludeUserName -ErrorAction Stop");
  expect(launcher).toContain("[System.StringComparison]::OrdinalIgnoreCase");
  expect(launcher).toContain('method = "Get-Process -IncludeUserName"');
  expect(launcher).toContain("initialTaskkillExitCode = $null");
  expect(launcher).toContain("initialTaskkillTimedOut = $false");
  expect(launcher).toContain("remainingProcesses = @()");

  const cleanupStart = launcher.indexOf(
    "    } finally {\n        $passwordText = $null",
  );
  const processProof = launcher.indexOf(
    "Stop-And-ProveNoAccountProcesses $canonicalUserName $user.SID.Value $processCleanup",
    cleanupStart,
  );
  const requireQuiescence = launcher.indexOf(
    "$processCleanup.verified -ne $true",
    processProof,
  );
  const recordQuiescence = launcher.indexOf(
    "$processesQuiescent = $true",
    requireQuiescence,
  );
  const gateAclCleanup = launcher.indexOf(
    "if ($processesQuiescent) {",
    recordQuiescence,
  );
  const removeAccount = launcher.indexOf(
    "Remove-LocalUser -Name $userName -ErrorAction Stop",
    cleanupStart,
  );
  const removeAcl = launcher.indexOf(
    "Remove-EphemeralAclGrant $grantedPath $user.SID.Value",
    cleanupStart,
  );
  const idempotentAclProof = launcher.indexOf(
    '"idempotent ACL absence proof for $grantedPath"',
    removeAccount,
  );
  const removeSandbox = launcher.indexOf(
    "Remove-Item -LiteralPath $sandbox -Recurse -Force -ErrorAction Stop",
    cleanupStart,
  );
  const gateDestructiveState = launcher.indexOf(
    "$canDestroyChildState = (-not $user) -or $processesQuiescent",
    gateAclCleanup,
  );
  const removeToolExecutionRoot = launcher.indexOf(
    "-LiteralPath $toolExecutionRoot `",
    removeSandbox,
  );
  const proveToolExecutionRootRemoved = launcher.indexOf(
    "$toolExecutionRootRemoved = -not (Test-Path -LiteralPath $toolExecutionRoot)",
    removeToolExecutionRoot,
  );
  const postCleanupIntegrity = launcher.indexOf(
    "$postCleanupTrackedSourceIntegrityVerified = $true",
    proveToolExecutionRootRemoved,
  );
  const mergeErrors = launcher.indexOf(
    "$failure = Merge-CleanupFailures $failure $cleanupErrors",
    cleanupStart,
  );
  const receipt = launcher.indexOf("Write-LauncherReceipt `", mergeErrors);
  expect(cleanupStart).toBeGreaterThan(-1);
  expect(processProof).toBeGreaterThan(cleanupStart);
  expect(requireQuiescence).toBeGreaterThan(processProof);
  expect(recordQuiescence).toBeGreaterThan(requireQuiescence);
  expect(gateAclCleanup).toBeGreaterThan(recordQuiescence);
  expect(removeAcl).toBeGreaterThan(gateAclCleanup);
  expect(removeAccount).toBeGreaterThan(removeAcl);
  expect(idempotentAclProof).toBeGreaterThan(removeAccount);
  expect(gateDestructiveState).toBeGreaterThan(idempotentAclProof);
  expect(removeSandbox).toBeGreaterThan(idempotentAclProof);
  expect(removeSandbox).toBeGreaterThan(gateDestructiveState);
  expect(removeToolExecutionRoot).toBeGreaterThan(removeSandbox);
  expect(proveToolExecutionRootRemoved).toBeGreaterThan(removeToolExecutionRoot);
  expect(postCleanupIntegrity).toBeGreaterThan(proveToolExecutionRootRemoved);
  expect(launcher.slice(proveToolExecutionRootRemoved, postCleanupIntegrity)).toContain(
    '"after standard-user cleanup"',
  );
  expect(mergeErrors).toBeGreaterThan(postCleanupIntegrity);
  expect(receipt).toBeGreaterThan(mergeErrors);
  expect(launcher).toContain(
    '$receiptError = if ($failure) { $failure.Message } else { $null }',
  );
  expect(launcher).not.toContain("$failure.Exception.Message");
  expect(launcher).toContain(
    "skipped because standard-user process quiescence was not proven; SID ACLs and account were retained",
  );
  expect(launcher).toContain("toolStaging = $ToolStaging");
  expect(launcher).toContain(
    "toolExecutionRootRemoved = $ToolExecutionRootRemoved",
  );
  expect(launcher).toContain(
    "$sandboxRemoved `\n            $toolStagingEvidence `\n            $toolExecutionRootRemoved `\n            $postCleanupTrackedSourceIntegrityVerified",
  );
  expect(launcher).toContain(
    "-not $sandboxRemoved -or\n            -not $toolExecutionRootRemoved -or\n            -not $selfTestInputRootRemoved -or\n            -not $postCleanupTrackedSourceIntegrityVerified",
  );
});

test("every Windows taskkill and child wait has an explicit outer deadline", () => {
  const launcher = readFileSync(standardUserLauncher, "utf8");
  const consumer = readFileSync(
    path.join(ROOT, "tools/release/js-exact-candidate-consumer.mjs"),
    "utf8",
  );
  const workflow = readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8");
  const boundedStart = launcher.indexOf("function Invoke-BoundedNativeProcess(");
  const boundedEnd = launcher.indexOf("\nfunction Get-ProcessesForAccount", boundedStart);
  expect(boundedStart).toBeGreaterThan(-1);
  expect(boundedEnd).toBeGreaterThan(boundedStart);
  const bounded = launcher.slice(boundedStart, boundedEnd);
  expect(bounded).toContain("$process.WaitForExit($TimeoutMilliseconds)");
  expect(bounded).toContain("$process.Kill($true)");
  expect(bounded).toContain('$result["timedOut"] = $true');

  const childStart = launcher.indexOf("function Invoke-ChildProcess(");
  const childEnd = launcher.indexOf("\nfunction Invoke-ChildMode", childStart);
  expect(childStart).toBeGreaterThan(-1);
  expect(childEnd).toBeGreaterThan(childStart);
  const child = launcher.slice(childStart, childEnd);
  expect(child).toContain("[DateTime]$DeadlineUtc");
  expect(child).toContain("[System.Threading.Tasks.Task]::WaitAny(");
  expect(child).toContain("$terminationResult = Invoke-BoundedNativeProcess `");
  expect(child).toContain("$process.WaitForExit(5000) | Out-Null");
  expect(child).not.toContain("$process.WaitForExit()\n");
  expect(child).toContain("$startInfo.RedirectStandardInput = $true");
  expect(child).toContain("$startInfo.RedirectStandardOutput = $true");
  expect(child).toContain("$startInfo.RedirectStandardError = $true");
  expect(child).toContain("$process.StandardInput.Close()");
  expect(child).toContain("New-BoundedStreamCapture $process.StandardOutput");
  expect(child).toContain("New-BoundedStreamCapture $process.StandardError");
  expect(child).toContain("foreach ($captureState in $captureStates)");
  expect(child).toContain(
    "$captureState.ReadTask -and $captureState.ReadTask.IsCompleted",
  );
  expect(child).not.toContain("CreateNoWindow");
  expect(child).not.toContain("ReadToEndAsync");
  expect(child).not.toContain("AddMinutes(");

  const parentStart = launcher.indexOf("function Invoke-ParentMode {");
  const parentEnd = launcher.indexOf(
    "\ntry {\n    if ($JsonContractSelfTest)",
    parentStart,
  );
  expect(parentStart).toBeGreaterThan(-1);
  expect(parentEnd).toBeGreaterThan(parentStart);
  const parent = launcher.slice(parentStart, parentEnd);
  expect(launcher).toContain("$LauncherStartedAtUtc = [DateTime]::UtcNow");
  expect(parent).toContain("$LauncherStartedAtUtc.AddMinutes(10)");
  expect(parent).toContain("$LauncherStartedAtUtc.AddMinutes(65)");
  expect(parent).toContain("deadlineUtc = $childDeadlineText");
  expect(parent).toContain(
    "$childDeadlineUtc `\n            $childEnvironment\n",
  );
  expect(launcher).toContain("$proof.deadlineUtc -cne $Manifest.deadlineUtc");

  expect(launcher).not.toMatch(
    /&\s+"\$env:SystemRoot\\System32\\taskkill\.exe"/u,
  );
  expect(launcher).toContain("$cleanupDeadline = [DateTime]::UtcNow.AddSeconds(60)");
  expect(consumer).toContain("const CONSUMER_TOTAL_BUDGET_MS = 60 * 60_000;");

  const jobStart = workflow.indexOf("  js-sdk-exact-candidate-consumer:\n");
  const jobEnd = workflow.indexOf("\n  wasix-rust-package:\n", jobStart);
  const job = workflow.slice(jobStart, jobEnd);
  const consume = job.indexOf("      - name: Consume exact TypeScript candidate\n");
  const stepDeadline = job.indexOf("        timeout-minutes: 70\n", consume);
  const evidence = job.indexOf("      - name: Upload exact TypeScript candidate evidence\n");
  expect(jobStart).toBeGreaterThan(-1);
  expect(jobEnd).toBeGreaterThan(jobStart);
  expect(consume).toBeGreaterThan(-1);
  expect(stepDeadline).toBeGreaterThan(consume);
  expect(evidence).toBeGreaterThan(stepDeadline);
});

test("Windows standard-user cleanup aggregates each failure without skipping later cleanup", () => {
  const launcher = readFileSync(standardUserLauncher, "utf8");
  expect(launcher).toContain(
    'Add-CleanupFailure $cleanupErrors "standard-user process cleanup proof" $_',
  );
  expect(launcher).toContain(
    'Add-CleanupFailure $cleanupErrors "ephemeral account removal" $_',
  );
  expect(launcher).toContain(
    'Add-CleanupFailure $cleanupErrors "ACL grant removal for $grantedPath" $_',
  );
  expect(launcher).toContain(
    'Add-CleanupFailure $cleanupErrors "standard-user sandbox removal" $_',
  );
  expect(launcher).toContain(
    'Add-CleanupFailure $cleanupErrors "staged tool execution root removal" $_',
  );
  expect(launcher).toContain(
    'Fail "explicit standard-user ACL entries remain on $PathValue after cleanup"',
  );
  expect(launcher).toContain('"$($primaryException.Message); cleanup failures: $cleanupMessage"');
});

test("alternate-token child diagnostics are bounded, sanitized, and never depend on inherited console handles", () => {
  const launcher = readFileSync(standardUserLauncher, "utf8");
  expect(launcher).toContain("$ChildCaptureTailCharacters = 16384");
  expect(launcher).toContain("$ChildDiagnosticTailCharacters = 4096");
  expect(launcher).toContain("$ChildCaptureDrainMilliseconds = 5000");
  expect(launcher).toContain("function Add-BoundedStreamText(");
  expect(launcher).toContain("$Capture.Tail.Remove(0, $excess)");
  expect(launcher).toContain("function ConvertTo-SanitizedDiagnosticTail(");
  expect(launcher).toContain(
    '$sanitized = $sanitized.Replace($SensitiveValue, "<redacted>")',
  );
  expect(launcher).toMatch(/gh\[pousr\]_\[A-Za-z0-9_\]/u);
  expect(launcher).toContain("Bearer <redacted>");
  expect(launcher).toContain("$stdoutJson = ConvertTo-Json $stdout -Compress");
  expect(launcher).toContain("$stderrJson = ConvertTo-Json $stderr -Compress");
  expect(launcher).toContain(
    '"standard-user child did not write its token proof; " +',
  );

  const childStart = launcher.indexOf("function Invoke-ChildMode(");
  const childEnd = launcher.indexOf("\nfunction Write-LauncherReceipt", childStart);
  expect(childStart).toBeGreaterThan(-1);
  expect(childEnd).toBeGreaterThan(childStart);
  const child = launcher.slice(childStart, childEnd);
  const invokeProbe = child.indexOf("$probeResult = Invoke-BoundedToolProbe `");
  const probeEvidence = child.indexOf(
    "$toolProbeEvidence.Add([ordered]@{",
    invokeProbe,
  );
  expect(invokeProbe).toBeGreaterThan(-1);
  expect(probeEvidence).toBeGreaterThan(invokeProbe);
  const probeFailure = child.slice(invokeProbe, probeEvidence);
  expect(probeFailure).toContain(
    "$probeStdout = ConvertTo-Json (\n                ConvertTo-SanitizedDiagnosticTail `\n                    $probeResult.stdout `\n                    \"\" `\n                    $false\n            ) -Compress",
  );
  expect(probeFailure).toContain(
    "$probeStderr = ConvertTo-Json (\n                ConvertTo-SanitizedDiagnosticTail `\n                    $probeResult.stderr `\n                    \"\" `\n                    $false\n            ) -Compress",
  );
  expect(probeFailure).toContain(
    '"error=$($probeResult.error) stdout=$probeStdout stderr=$probeStderr"',
  );
  expect(probeFailure).not.toContain("stdout=$($probeResult.stdout)");
  expect(probeFailure).not.toContain("stderr=$($probeResult.stderr)");
});

test("ephemeral ACLs use exact SID rules, nested-first removal, and verified idempotence", () => {
  const launcher = readFileSync(standardUserLauncher, "utf8");
  expect(launcher).toContain("function Get-ExplicitAclState(");
  expect(launcher).toContain("function Add-EphemeralAclGrant(");
  expect(launcher).toContain("function Add-EphemeralAclDeny(");
  expect(launcher).toContain("function Remove-EphemeralAclGrant(");
  expect(launcher).toContain("[System.Security.Principal.SecurityIdentifier]::new($Sid)");
  expect(launcher).toContain("$true,\n            $false,");
  expect(launcher).toContain("$state.Acl.PurgeAccessRules($state.Identity)");
  expect(launcher).toContain("Set-Acl -LiteralPath $PathValue");
  const addGrantStart = launcher.indexOf("function Add-EphemeralAclGrant(");
  const addGrantEnd = launcher.indexOf("\nfunction Remove-EphemeralAclGrant", addGrantStart);
  const addGrant = launcher.slice(addGrantStart, addGrantEnd);
  expect(addGrant.indexOf("Set-Acl -LiteralPath $PathValue")).toBeGreaterThan(-1);
  expect(addGrant.indexOf("$GrantedPaths.Add($PathValue)")).toBeLessThan(
    addGrant.indexOf("Set-Acl -LiteralPath $PathValue"),
  );
  expect(addGrant.indexOf("$verification = Get-ExplicitAclState")).toBeGreaterThan(
    addGrant.indexOf("Set-Acl -LiteralPath $PathValue"),
  );
  expect(launcher).toContain(
    "for ($index = $uniqueGrantedPaths.Count - 1; $index -ge 0; $index -= 1)",
  );
  expect(launcher).toContain("if ($state.Rules.Count -eq 0)");
  expect(launcher).toContain('"idempotent ACL absence proof for $grantedPath"');
  expect(launcher).not.toContain("if ($aclGrantsRemoved) {");
  expect(launcher).not.toContain("icacls.exe");
});

windowsTest("PowerShell parses the standard-user launcher without errors", () => {
  const launcherPathEnvironmentName = "OLIPHAUNT_POWERSHELL_PARSE_FILE";
  const parseCommand = [
    `$launcherPath = [Environment]::GetEnvironmentVariable('${launcherPathEnvironmentName}', [EnvironmentVariableTarget]::Process);`,
    "if ([string]::IsNullOrWhiteSpace($launcherPath) -or -not [IO.File]::Exists($launcherPath)) {",
    '  [Console]::Error.WriteLine("the launcher path environment contract is missing or invalid");',
    "  exit 1;",
    "}",
    "$tokens = $null; $errors = $null;",
    "[System.Management.Automation.Language.Parser]::ParseFile($launcherPath, [ref]$tokens, [ref]$errors) | Out-Null;",
    "if ($errors.Count -ne 0) {",
    "  $errors | ForEach-Object { [Console]::Error.WriteLine($_.Message) };",
    "  exit 1;",
    "}",
  ].join(" ");
  const result = spawnSync(
    "pwsh.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      parseCommand,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        [launcherPathEnvironmentName]: standardUserLauncher,
      },
      timeout: 30_000,
    },
  );
  expect(result.status, result.stderr || result.stdout).toBe(0);
});

windowsTest("preserves exact manifest and proof timestamps through PowerShell JSON", () => {
  const result = spawnSync(
    "pwsh.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      standardUserLauncher,
      "-JsonContractSelfTest",
    ],
    { encoding: "utf8", timeout: 30_000 },
  );
  expect(result.status, result.stderr || result.stdout).toBe(0);
  expect(result.stdout).toContain(
    "OLIPHAUNT_WINDOWS_JSON_CONTRACT_SELF_TEST_OK",
  );
});

hostedExactNpmTest("executes the exact hosted npm publisher shim through the launcher command contract", () => {
  const publisherManifest = readFileSync(
    path.join(ROOT, "src/sources/toolchains/npm-publisher.toml"),
    "utf8",
  );
  const expectedVersion = publisherManifest.match(
    /^\[toolchain\]\r?\nversion = "([0-9]+\.[0-9]+\.[0-9]+)"$/mu,
  )?.[1];
  expect(expectedVersion).toBe("11.18.0");
  expect(process.env.NPM_VERSION).toBe(expectedVersion);
  expect(process.env.RUNNER_TEMP).toBeTruthy();

  const probeCommand = [
    '$ErrorActionPreference = "Stop";',
    "$npm = Get-Command npm.cmd -CommandType Application -ErrorAction Stop | Select-Object -First 1;",
    "$npmPath = [System.IO.Path]::GetFullPath($npm.Path);",
    '$startInfo = [System.Diagnostics.ProcessStartInfo]::new();',
    '$startInfo.FileName = Join-Path $env:SystemRoot "System32/cmd.exe";',
    'foreach ($argument in @("/d", "/s", "/v:off", "/c", "call", $npmPath, "--version")) { $startInfo.ArgumentList.Add($argument) };',
    "$startInfo.UseShellExecute = $false;",
    "$startInfo.CreateNoWindow = $true;",
    "$startInfo.RedirectStandardOutput = $true;",
    "$startInfo.RedirectStandardError = $true;",
    "$process = [System.Diagnostics.Process]::new();",
    "$process.StartInfo = $startInfo;",
    'if (-not $process.Start()) { throw "npm probe process did not start" };',
    "$stdoutTask = $process.StandardOutput.ReadToEndAsync();",
    "$stderrTask = $process.StandardError.ReadToEndAsync();",
    'if (-not $process.WaitForExit(30000)) { $process.Kill($true); throw "npm probe timed out" };',
    "$stdout = $stdoutTask.GetAwaiter().GetResult();",
    "$stderr = $stderrTask.GetAwaiter().GetResult();",
    "$exitCode = $process.ExitCode;",
    "$process.Dispose();",
    "$result = [ordered]@{ npmPath = $npmPath; exitCode = $exitCode; stdout = $stdout; stderr = $stderr };",
    "$result | ConvertTo-Json -Compress;",
    'if ($exitCode -ne 0) { throw "npm probe exited with status $exitCode" };',
  ].join(" ");
  const result = spawnSync(
    "pwsh.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      probeCommand,
    ],
    { encoding: "utf8", timeout: 45_000 },
  );
  expect(
    result.status,
    `hosted npm batch probe failed:\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  ).toBe(0);
  const proof = JSON.parse(result.stdout.trim());
  expect(proof.exitCode).toBe(0);
  expect(proof.stderr).toBe("");
  expect(proof.stdout.trim()).toBe(expectedVersion);
  expect(path.extname(proof.npmPath).toLowerCase()).toBe(".cmd");

  const publisherRoot = path.resolve(
    process.env.RUNNER_TEMP,
    "oliphaunt-npm-publisher",
  );
  const relativeNpmPath = path.relative(publisherRoot, proof.npmPath);
  expect(relativeNpmPath).not.toBe("");
  expect(path.isAbsolute(relativeNpmPath)).toBe(false);
  expect(relativeNpmPath).not.toMatch(/^\.\.(?:[\\/]|$)/u);
  expect(relativeNpmPath.replaceAll("\\", "/")).toBe(
    `installations/npm-${expectedVersion}/verified/bin/npm.cmd`,
  );
});

windowsTest("preserves a spaced absolute batch path as a structured cmd command", () => {
  const root = mkdtempSync(path.join(tmpdir(), "oliphaunt PowerShell cmd transport "));
  try {
    const probe = path.join(root, "exact version probe.cmd");
    writeFileSync(
      probe,
      [
        "@echo off",
        'if not "%~1"=="--version" exit /b 23',
        "echo OLIPHAUNT_STRUCTURED_BATCH_OK",
        "",
      ].join("\r\n"),
    );
    const probeCommand = [
      '$ErrorActionPreference = "Stop";',
      "$probe = [System.IO.Path]::GetFullPath($env:OLIPHAUNT_STRUCTURED_BATCH_PROBE);",
      '$startInfo = [System.Diagnostics.ProcessStartInfo]::new();',
      '$startInfo.FileName = Join-Path $env:SystemRoot "System32/cmd.exe";',
      'foreach ($argument in @("/d", "/s", "/v:off", "/c", "call", $probe, "--version")) { $startInfo.ArgumentList.Add($argument) };',
      "$startInfo.UseShellExecute = $false;",
      "$startInfo.CreateNoWindow = $true;",
      "$startInfo.RedirectStandardOutput = $true;",
      "$startInfo.RedirectStandardError = $true;",
      "$process = [System.Diagnostics.Process]::new();",
      "$process.StartInfo = $startInfo;",
      'if (-not $process.Start()) { throw "structured batch probe did not start" };',
      "$stdoutTask = $process.StandardOutput.ReadToEndAsync();",
      "$stderrTask = $process.StandardError.ReadToEndAsync();",
      'if (-not $process.WaitForExit(30000)) { $process.Kill($true); throw "structured batch probe timed out" };',
      "$stdout = $stdoutTask.GetAwaiter().GetResult();",
      "$stderr = $stderrTask.GetAwaiter().GetResult();",
      "$exitCode = $process.ExitCode;",
      "$process.Dispose();",
      "$result = [ordered]@{ probe = $probe; exitCode = $exitCode; stdout = $stdout; stderr = $stderr };",
      "$result | ConvertTo-Json -Compress;",
      'if ($exitCode -ne 0) { throw "structured batch probe exited with status $exitCode" };',
    ].join(" ");
    const result = spawnSync(
      "pwsh.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", probeCommand],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          OLIPHAUNT_STRUCTURED_BATCH_PROBE: probe,
        },
        timeout: 45_000,
      },
    );
    expect(
      result.status,
      `structured batch probe failed:\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    ).toBe(0);
    const proof = JSON.parse(result.stdout.trim());
    // Windows may expose the same temp directory through its 8.3 short alias
    // to Bun and its long alias to PowerShell. Path canonicalizers can preserve
    // either spelling, so bind identity to the volume and file IDs instead.
    const expectedIdentity = statSync(probe, { bigint: true });
    const observedIdentity = statSync(proof.probe, { bigint: true });
    expect(expectedIdentity.isFile()).toBe(true);
    expect(observedIdentity.isFile()).toBe(true);
    expect(expectedIdentity.dev).toBeGreaterThan(0n);
    expect(expectedIdentity.ino).toBeGreaterThan(0n);
    expect(observedIdentity.dev).toBe(expectedIdentity.dev);
    expect(observedIdentity.ino).toBe(expectedIdentity.ino);
    expect(proof.exitCode).toBe(0);
    expect(proof.stderr).toBe("");
    expect(proof.stdout.trim()).toBe("OLIPHAUNT_STRUCTURED_BATCH_OK");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

windowsTest("preserves supported .cmd arguments and rejects expansion syntax", () => {
  const root = mkdtempSync(path.join(tmpdir(), "oliphaunt cmd transport "));
  try {
    const captureScript = path.join(root, "capture arguments.cjs");
    const captureFile = path.join(root, "captured arguments.json");
    const injectionMarker = path.join(root, "injected.txt");
    writeFileSync(
      captureScript,
      'require("node:fs").writeFileSync(process.env.OLIPHAUNT_CMD_CAPTURE_FILE, JSON.stringify(process.argv.slice(2)));\n',
    );
    for (const command of ["npm", "pnpm"]) {
      writeFileSync(
        path.join(root, `${command}.cmd`),
        [
          "@echo off",
          "setlocal DisableDelayedExpansion",
          '"%OLIPHAUNT_CMD_NODE%" "%OLIPHAUNT_CMD_CAPTURE_SCRIPT%" %*',
          "",
        ].join("\r\n"),
      );
      rmSync(captureFile, { force: true });
      rmSync(injectionMarker, { force: true });
      const expected = [
        "install",
        "--userconfig",
        String.raw`C:\work tree\registry & proof\npmrc`,
        "literal (parentheses) and caret ^ value",
        "literal pipe | and angles < >",
        "literal & echo injected>injected.txt",
        'quoted "value" with trailing\\',
      ];
      const invocation = exactCandidateCommandInvocation(command, expected, {
        cwd: root,
        platform: "win32",
        comspec: process.env.ComSpec ?? process.env.COMSPEC ?? "cmd.exe",
      });
      const result = spawnSync(invocation.command, invocation.args, {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          OLIPHAUNT_CMD_CAPTURE_FILE: captureFile,
          OLIPHAUNT_CMD_CAPTURE_SCRIPT: captureScript,
          OLIPHAUNT_CMD_NODE: process.execPath,
        },
        stdio: ["ignore", "pipe", "pipe"],
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      });
      expect(result.status, `${command}.cmd failed:\n${result.stderr || result.stdout}`).toBe(0);
      expect(JSON.parse(readFileSync(captureFile, "utf8"))).toEqual(expected);
      expect(existsSync(injectionMarker)).toBe(false);
    }

    for (const unsafe of ["literal %NAME%", "unmatched %", "literal !"]) {
      expect(() => exactCandidateCommandInvocation("npm", ["install", unsafe], {
        cwd: root,
        platform: "win32",
        comspec: process.env.ComSpec ?? process.env.COMSPEC ?? "cmd.exe",
      })).toThrow("contains '%' or '!'");
    }
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
