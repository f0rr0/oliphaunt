import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "../test/fd-backed-spawn-sync.mjs";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import {
  ExactCandidateCommandTimeoutError,
  ExactCandidateCommandWatchdogError,
  ExactCandidateDeadlineError,
  aggregateExactCandidateErrors,
  assertExactCandidateImmutableInputsUnchanged,
  assertExactInstalledPackages,
  captureExactCandidateImmutableInputs,
  combineExactCandidateSettlements,
  completeExactCandidateResults,
  createExactCandidateConsumerDeadline,
  exactCandidateCommandWatchdogFailureResult,
  exactCandidateCommandWatchdogEmergencyTimeout,
  exactCandidateCommandInvocation,
  exactCandidateErrorEvidence,
  exactCandidateExtensionProductGroups,
  exactCandidateExtensions,
  exactCandidateJsrPortableCommand,
  exactCandidateImmutableInputIntegrity,
  exactCandidatePendingSettlementReason,
  exactCandidateRuntimeCommand,
  exactCandidateRuntimeCases,
  exactCandidateRuntimeFailureMessage,
  exactCandidateTargetContract,
  exactCandidateWindowsProcessTreeKillArgs,
  executeExactCandidateRuntimeCasesFailLate,
  inspectIosBaseCarrierInput,
  parseExactCandidateConsumerArgs,
  parseExactCandidateCommandWatchdogProtocol,
  persistExactCandidateImmutableInputPostRunProof,
  prepareExactCandidateExtensionBuilderIsolation,
  removeExactCandidateRunRoot,
  runExactCandidateCommandToFileWithTimeout,
  runExactCandidateCommandWithTimeout,
  validateExactCandidateDenoPreparationReceipt,
  validateIosExtensionCandidateInputs,
  stopVerdaccio,
  terminateExactCandidateProcessTree,
  validateStagedBundleCarrier,
  validateStagedExtensionMember,
  writeBoundedExactCandidateDiagnostics,
} from "./js-exact-candidate-consumer.mjs";
import { NATIVE_EXTENSION_ASSET_INDEX_HEADER } from "./native-extension-asset-index-contract.mjs";
import {
  JS_EXACT_CANDIDATE_CONSUMER_TARGETS,
  jsExactCandidateConsumerMatrix,
} from "./artifact_target_matrix.mjs";
import { ROOT } from "./release-artifact-targets.mjs";
import { createDeterministicTar } from "./cargo-source-package.mjs";
import { canonicalGzipSync } from "./portable-archive.mjs";
import { stageReleaseNotices } from "./release-notices.mjs";
import { extensionCarrierLegalContract } from "./extension-upstream-licenses.mjs";
import {
  addImpliedJobs,
  assertJsExactCandidatePlanClosure,
  extensionArtifactsNativeMatrixForPlan,
  nativeTargetSubsetForJobs,
  planJobsForAffected,
  renderPlanForFullRun,
  renderPlanWithSelection,
  selectedExtensionProductsForPlan,
} from "../graph/ci_plan.mjs";

const scratch = [];
const RELEASE_GRAPH_TIMEOUT = { timeout: 300_000 };
const posixTest = process.platform === "win32" ? test.skip : test;

afterEach(() => {
  for (const root of scratch.splice(0)) rmSync(root, { recursive: true, force: true });
});

function candidateArgs() {
  const root = mkdtempSync(path.join(ROOT, "target/js-exact-candidate-test-"));
  scratch.push(root);
  const roots = Array.from({ length: 6 }, (_, index) => {
    const value = path.join(root, `input-${index}`);
    mkdirSync(value);
    return value;
  });
  const iosExtensionRoot = path.join(root, "ios-extension-input");
  mkdirSync(iosExtensionRoot);
  return {
    root,
    roots,
    iosExtensionRoot,
    output: path.join(root, "output"),
    argv: [
      "--candidate-sha", "a".repeat(40),
      "--target", "linux-x64-gnu",
      ...roots.flatMap((value) => ["--artifact-root", value]),
      "--ios-extension-artifact-root", iosExtensionRoot,
      "--output-root", path.join(root, "output"),
    ],
  };
}

function fileSha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function immutableInputFixture() {
  const root = mkdtempSync(path.join(ROOT, "target/js-exact-immutable-input-test-"));
  scratch.push(root);
  const artifactRoots = [path.join(root, "native"), path.join(root, "extensions")];
  const iosExtensionArtifactRoot = path.join(root, "ios-extensions");
  for (const directory of [...artifactRoots, iosExtensionArtifactRoot]) {
    mkdirSync(directory, { recursive: true });
  }
  const mutable = path.join(artifactRoots[0], "nested", "runtime.bin");
  const removable = path.join(artifactRoots[1], "extension-artifacts.json");
  const ios = path.join(iosExtensionArtifactRoot, "ios-xcframework", "extension.zip");
  for (const [file, contents] of [
    [mutable, "alpha\n"],
    [removable, "manifest\n"],
    [ios, "ios\n"],
  ]) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, contents);
  }
  const capture = () => captureExactCandidateImmutableInputs(
    artifactRoots,
    iosExtensionArtifactRoot,
  );
  return { artifactRoots, capture, iosExtensionArtifactRoot, mutable, removable, root };
}

function processExistsForTest(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function writeIosExtensionInputFixture(contract) {
  const root = mkdtempSync(path.join(ROOT, "target/js-exact-ios-extension-input-"));
  scratch.push(root);
  const targetDirectory = path.join(root, "ios-xcframework");
  mkdirSync(targetDirectory);
  const rows = [];
  const writeAsset = (name, contents) => {
    const file = path.join(targetDirectory, name);
    writeFileSync(file, contents);
    return readFileSync(file).byteLength;
  };
  for (const extension of contract.extensions) {
    const runtimeName = `${extension.sqlName}-runtime.tar.gz`;
    rows.push([
      extension.sqlName,
      "ios-xcframework",
      "runtime",
      "-",
      runtimeName,
      String(writeAsset(runtimeName, `runtime ${extension.sqlName}\n`)),
      "-",
    ]);
    if (extension.nativeModuleStem === null) continue;
    const primaryName = `${extension.sqlName}-primary.zip`;
    const registrationName = `${extension.sqlName}-registration.json`;
    writeAsset(registrationName, `${JSON.stringify({
      schema: "oliphaunt-ios-extension-registration-v1",
      sqlName: extension.sqlName,
      nativeModuleStem: extension.nativeModuleStem,
      magicSymbol: `${extension.nativeModuleStem}_magic`,
      initSymbol: null,
      symbols: [],
    })}\n`);
    rows.push([
      extension.sqlName,
      "ios-xcframework",
      "ios-xcframework",
      extension.nativeModuleStem,
      primaryName,
      String(writeAsset(primaryName, `primary ${extension.sqlName}\n`)),
      registrationName,
    ]);
    for (const dependency of extension.iosNativeDependencies) {
      const dependencyName = `${extension.sqlName}-${dependency}.zip`;
      rows.push([
        extension.sqlName,
        "ios-xcframework",
        "ios-dependency-xcframework",
        dependency,
        dependencyName,
        String(writeAsset(dependencyName, `dependency ${extension.sqlName}/${dependency}\n`)),
        "-",
      ]);
    }
  }
  const version = contract.versions.native;
  const index = path.join(targetDirectory, `liboliphaunt-${version}-native-extension-assets.tsv`);
  writeFileSync(index, `${[
    NATIVE_EXTENSION_ASSET_INDEX_HEADER.join("\t"),
    ...rows.map((row) => row.join("\t")),
  ].join("\n")}\n`);
  writeFileSync(
    path.join(targetDirectory, `liboliphaunt-${version}-extension-assets.tsv`),
    "legacy exact-extension inventory\n",
  );
  return { root, targetDirectory, index, rows };
}

test("parses exactly six disjoint immutable roots and a target-scoped output", () => {
  const fixture = candidateArgs();
  const parsed = parseExactCandidateConsumerArgs(fixture.argv);
  expect(parsed.artifactRoots).toEqual(fixture.roots);
  expect(parsed.iosExtensionArtifactRoot).toBe(fixture.iosExtensionRoot);
  expect(parsed.outputRoot).toBe(fixture.output);

  const fiveRoots = [...fixture.argv];
  fiveRoots.splice(fiveRoots.indexOf(fixture.roots[5]) - 1, 2);
  expect(() => parseExactCandidateConsumerArgs(fiveRoots)).toThrow(
    "exactly six --artifact-root values",
  );
  expect(() => parseExactCandidateConsumerArgs([
    ...fixture.argv,
    "--artifact-root", fixture.roots[0],
  ])).toThrow("exactly six --artifact-root values");

  const duplicate = [...fixture.argv];
  duplicate[duplicate.indexOf(fixture.roots[5])] = fixture.roots[0];
  expect(() => parseExactCandidateConsumerArgs(duplicate)).toThrow("must be unique");

  const duplicateIos = [...fixture.argv];
  duplicateIos[duplicateIos.indexOf(fixture.iosExtensionRoot)] = fixture.roots[0];
  expect(() => parseExactCandidateConsumerArgs(duplicateIos)).toThrow("must be unique");

  const nested = path.join(fixture.roots[0], "nested");
  mkdirSync(nested);
  const overlap = [...fixture.argv];
  overlap[overlap.indexOf(fixture.roots[5])] = nested;
  expect(() => parseExactCandidateConsumerArgs(overlap)).toThrow("must not overlap");

  const unsafeOutput = [...fixture.argv];
  unsafeOutput[unsafeOutput.indexOf(fixture.output)] = fixture.roots[0];
  expect(() => parseExactCandidateConsumerArgs(unsafeOutput)).toThrow(
    "must not be inside an immutable artifact root",
  );
  expect(() => parseExactCandidateConsumerArgs([
    ...fixture.argv.slice(0, -1),
    "/tmp/js-exact-candidate-unsafe",
  ])).toThrow("repository target directory");
  expect(() => parseExactCandidateConsumerArgs([
    ...fixture.argv.slice(0, 1),
    "ABC",
    ...fixture.argv.slice(2),
  ])).toThrow("full lowercase Git commit SHA");
});

test("isolates exact desktop extension staging from ambient WASIX outputs", () => {
  const root = mkdtempSync(path.join(ROOT, "target/js-exact-extension-isolation-"));
  scratch.push(root);
  const first = prepareExactCandidateExtensionBuilderIsolation(root);
  const releaseRoot = first.OLIPHAUNT_WASIX_EXTENSION_RELEASE_ASSET_ROOT;
  const aotRoot = first.OLIPHAUNT_WASIX_EXTENSION_AOT_ARTIFACT_ROOT;
  expect(releaseRoot.startsWith(`${root}${path.sep}`)).toBe(true);
  expect(aotRoot.startsWith(`${root}${path.sep}`)).toBe(true);
  expect(first.OLIPHAUNT_WASIX_GENERATED_ASSET_ROOT).toBe("");
  const stale = path.join(releaseRoot, "ambient-wasix.tar.zst");
  writeFileSync(stale, "ambient output must not survive\n");
  const second = prepareExactCandidateExtensionBuilderIsolation(root);
  expect(second).toEqual(first);
  expect(existsSync(stale)).toBe(false);
  expect(existsSync(second.OLIPHAUNT_WASIX_EXTENSION_RELEASE_ASSET_ROOT)).toBe(true);
  expect(existsSync(second.OLIPHAUNT_WASIX_EXTENSION_AOT_ARTIFACT_ROOT)).toBe(true);
});

test("records the exact full immutable-input file, byte, and digest envelope", () => {
  const fixture = immutableInputFixture();
  const before = fixture.capture();
  const after = fixture.capture();
  const integrity = assertExactCandidateImmutableInputsUnchanged(before, after);
  expect(before).toMatchObject({
    schema: "oliphaunt-exact-candidate-immutable-inputs-v1",
    fileCount: 3,
    totalBytes: 19,
  });
  expect(before.envelopeSha256).toMatch(/^[0-9a-f]{64}$/u);
  expect(before.files.map(({ root, path: relative }) => [root, relative])).toEqual([
    [0, "nested/runtime.bin"],
    [1, "extension-artifacts.json"],
    [2, "ios-xcframework/extension.zip"],
  ]);
  expect(after).toEqual(before);
  expect(integrity).toEqual({
    schema: "oliphaunt-exact-candidate-immutable-input-integrity-v1",
    state: "passed",
    unchanged: true,
    before: {
      fileCount: 3,
      totalBytes: 19,
      envelopeSha256: before.envelopeSha256,
    },
    after: {
      fileCount: 3,
      totalBytes: 19,
      envelopeSha256: before.envelopeSha256,
    },
    delta: { added: [], removed: [], changed: [], canonicalOrderChanged: false },
  });
});

test("fails immutable-input proof when existing bytes mutate", () => {
  const fixture = immutableInputFixture();
  const before = fixture.capture();
  writeFileSync(fixture.mutable, "omega\n");
  const after = fixture.capture();
  const integrity = exactCandidateImmutableInputIntegrity(before, after);
  expect(integrity).toMatchObject({
    state: "failed",
    unchanged: false,
    delta: {
      added: [],
      removed: [],
      changed: [{ root: 0, path: "nested/runtime.bin" }],
      canonicalOrderChanged: false,
    },
  });
  expect(integrity.before.totalBytes).toBe(integrity.after.totalBytes);
  expect(integrity.before.envelopeSha256).not.toBe(integrity.after.envelopeSha256);
  expect(() => assertExactCandidateImmutableInputsUnchanged(before, after)).toThrow(
    "added=0, removed=0, changed=1, canonicalOrderChanged=false",
  );
});

test("fails immutable-input proof when a file is added", () => {
  const fixture = immutableInputFixture();
  const before = fixture.capture();
  writeFileSync(path.join(fixture.artifactRoots[1], "unexpected.bin"), "added\n");
  const after = fixture.capture();
  const integrity = exactCandidateImmutableInputIntegrity(before, after);
  expect(integrity.delta).toMatchObject({
    added: [{ root: 1, path: "unexpected.bin", bytes: 6 }],
    removed: [],
    changed: [],
  });
  expect(() => assertExactCandidateImmutableInputsUnchanged(before, after)).toThrow(
    "added=1, removed=0, changed=0",
  );
});

test("fails immutable-input proof when a file is deleted", () => {
  const fixture = immutableInputFixture();
  const before = fixture.capture();
  rmSync(fixture.removable);
  const after = fixture.capture();
  const integrity = exactCandidateImmutableInputIntegrity(before, after);
  expect(integrity.delta).toMatchObject({
    added: [],
    removed: [{ root: 1, path: "extension-artifacts.json", bytes: 9 }],
    changed: [],
  });
  expect(() => assertExactCandidateImmutableInputsUnchanged(before, after)).toThrow(
    "added=0, removed=1, changed=0",
  );
});

test("persists fail-closed post-run evidence when an immutable root becomes unreadable", () => {
  const fixture = immutableInputFixture();
  const before = fixture.capture();
  const evidenceRoot = path.join(fixture.root, "evidence");
  mkdirSync(evidenceRoot);
  const afterPath = path.join(evidenceRoot, "immutable-inputs-after.json");
  const integrityPath = path.join(evidenceRoot, "immutable-input-integrity.json");
  rmSync(fixture.iosExtensionArtifactRoot, { recursive: true });
  expect(() => persistExactCandidateImmutableInputPostRunProof({
    artifactRoots: fixture.artifactRoots,
    iosExtensionArtifactRoot: fixture.iosExtensionArtifactRoot,
    beforeSnapshot: before,
    beforeEvidence: { ...before, observation: "before-consumption" },
    afterPath,
    integrityPath,
  })).toThrow();
  expect(JSON.parse(readFileSync(afterPath, "utf8"))).toMatchObject({
    observation: "after-consumption",
    state: "unreadable",
  });
  expect(JSON.parse(readFileSync(integrityPath, "utf8"))).toMatchObject({
    state: "failed",
    unchanged: false,
    reason: "after-input-snapshot-unreadable",
    before: {
      fileCount: before.fileCount,
      totalBytes: before.totalBytes,
      envelopeSha256: before.envelopeSha256,
    },
    after: { state: "unreadable" },
  });
});

posixTest("rejects an immutable root replaced by a byte-identical symlink", () => {
  const fixture = immutableInputFixture();
  const before = fixture.capture();
  const evidenceRoot = path.join(fixture.root, "symlink-evidence");
  mkdirSync(evidenceRoot);
  const replacedRoot = fixture.artifactRoots[0];
  const realRoot = `${replacedRoot}-real`;
  renameSync(replacedRoot, realRoot);
  symlinkSync(realRoot, replacedRoot, "dir");
  expect(() => persistExactCandidateImmutableInputPostRunProof({
    artifactRoots: fixture.artifactRoots,
    iosExtensionArtifactRoot: fixture.iosExtensionArtifactRoot,
    beforeSnapshot: before,
    beforeEvidence: { ...before, observation: "before-consumption" },
    afterPath: path.join(evidenceRoot, "immutable-inputs-after.json"),
    integrityPath: path.join(evidenceRoot, "immutable-input-integrity.json"),
  })).toThrow("filesystem traversal root must not be a symbolic link or junction");
  expect(JSON.parse(readFileSync(
    path.join(evidenceRoot, "immutable-input-integrity.json"),
    "utf8",
  ))).toMatchObject({
    state: "failed",
    unchanged: false,
    reason: "after-input-snapshot-unreadable",
  });
});

test("captures before inspection and proves inputs after registry cleanup on every outcome", () => {
  const source = readFileSync(
    path.join(ROOT, "tools/release/js-exact-candidate-consumer.mjs"),
    "utf8",
  );
  const mainSource = source.slice(source.indexOf("function main(argv)"));
  const beforeCapture = mainSource.indexOf(
    "immutableInputsBefore = captureExactCandidateImmutableInputs(",
  );
  const beforeEvidence = mainSource.indexOf("immutableInputsBeforePath,", beforeCapture);
  const inspection = mainSource.indexOf("const inputEvidence = inspectCandidateInputs(");
  const cleanup = mainSource.indexOf("stopVerdaccio(registryRoot)");
  const postRunProof = mainSource.indexOf(
    "persistExactCandidateImmutableInputPostRunProof({",
    cleanup,
  );
  const finalReceipt = mainSource.indexOf(
    'path.join(evidenceRoot, "exact-candidate.json")',
    postRunProof,
  );
  const passed = mainSource.indexOf('status.state = "passed"', finalReceipt);
  expect(beforeCapture).toBeGreaterThan(-1);
  expect(beforeEvidence).toBeGreaterThan(-1);
  expect(beforeEvidence).toBeGreaterThan(beforeCapture);
  expect(inspection).toBeGreaterThan(beforeEvidence);
  expect(cleanup).toBeGreaterThan(inspection);
  expect(postRunProof).toBeGreaterThan(cleanup);
  expect(finalReceipt).toBeGreaterThan(postRunProof);
  expect(passed).toBeGreaterThan(finalReceipt);
  expect(mainSource.slice(0, cleanup)).not.toContain(
    'path.join(evidenceRoot, "exact-candidate.json")',
  );
  expect(mainSource).toContain(
    "[primaryCause, cleanupCause, immutableInputProofCause]",
  );
  expect(mainSource).toContain(
    "status.immutableInputsUnchanged = immutableInputProof?.integrity?.unchanged ?? false",
  );
  for (const evidence of [
    "immutable-inputs-before.json",
    "immutable-inputs-after.json",
    "immutable-input-integrity.json",
  ]) {
    expect(source).toContain(evidence);
  }
});

test("enables TypeScript sloppy imports only for the portable JSR source proof", () => {
  const fixture = "/tmp/exact-candidate.mjs";
  const nativeDeno = exactCandidateRuntimeCommand("deno", fixture);
  expect(nativeDeno.command).toBe("deno");
  expect(nativeDeno.args).not.toContain("--sloppy-imports");
  expect(nativeDeno.args).toContain("--allow-ffi");
  expect(nativeDeno.args).toContain("--allow-run");
  expect(nativeDeno.args).toContain("--allow-net=127.0.0.1");

  const portableJsr = exactCandidateJsrPortableCommand(fixture);
  expect(portableJsr).toEqual({
    command: "deno",
    args: [
      "run",
      "--sloppy-imports",
      "--node-modules-dir=manual",
      "--allow-env",
      "--allow-read",
      "--allow-write",
      fixture,
    ],
  });
  expect(portableJsr.args).not.toContain("--allow-ffi");
  expect(portableJsr.args).not.toContain("--allow-run");
  expect(portableJsr.args).not.toContain("--allow-net=127.0.0.1");
});

test("accepts only the separate relative Deno embedded-module layout receipt", () => {
  const candidate = { sha: "a".repeat(40), tree: "b".repeat(40) };
  const receipt = {
    schemaVersion: 1,
    candidate,
    extensionCount: 39,
    packageManagedInput: true,
    preparedLayout: "explicit-deno-runtime-v2",
    embeddedModuleDirectory: "lib/modules",
    moduleStaging: {
      policy: "separate-embedded-modules-v1",
      copiedFileCount: 39,
    },
  };
  expect(() => validateExactCandidateDenoPreparationReceipt(receipt, 39, candidate)).not.toThrow();
  for (const invalid of [
    { ...receipt, schemaVersion: 2 },
    { ...receipt, candidate: { ...candidate, sha: "c".repeat(40) } },
    { ...receipt, preparedLayout: "explicit-deno-runtime-v1" },
    { ...receipt, embeddedModuleDirectory: "/tmp/modules" },
    { ...receipt, embeddedModuleDirectory: "lib/postgresql" },
    { ...receipt, extensionCount: 38 },
    { ...receipt, packageManagedInput: false },
    { ...receipt, moduleStaging: { ...receipt.moduleStaging, copiedFileCount: 0 } },
  ]) {
    expect(() => validateExactCandidateDenoPreparationReceipt(invalid, 39, candidate)).toThrow(
      "Deno exact-candidate runtime preparation receipt is invalid",
    );
  }
});

test("binds the complete Apple base carrier to one explicit immutable input root", RELEASE_GRAPH_TIMEOUT, () => {
  const fixture = candidateArgs();
  const contract = exactCandidateTargetContract("linux-x64-gnu");
  const iosRoot = fixture.roots[5];
  for (const [role, name] of Object.entries(contract.iosBaseAssets)) {
    writeFileSync(path.join(iosRoot, name), `same-run ${role}\n`);
  }
  // The portable ICU provider is a separate exact input. Its duplicate name
  // must not make the independently complete Apple carrier ambiguous.
  writeFileSync(
    path.join(fixture.roots[0], contract.iosBaseAssets.icuData),
    "portable ICU provider\n",
  );

  const inspected = inspectIosBaseCarrierInput(fixture.roots, contract);
  expect(inspected.root).toBe(iosRoot);
  expect(inspected.assetDir).toBe(iosRoot);
  expect(inspected.evidence.root).toBe(5);
  expect(inspected.evidence.assets.map(({ role, name }) => [role, name])).toEqual(
    Object.entries(contract.iosBaseAssets),
  );
  for (const asset of inspected.evidence.assets) {
    expect(asset.sha256).toBe(fileSha256(path.join(iosRoot, asset.name)));
    expect(asset.bytes).toBeGreaterThan(0);
  }

  rmSync(path.join(iosRoot, contract.iosBaseAssets.runtimeResources));
  expect(() => inspectIosBaseCarrierInput(fixture.roots, contract)).toThrow(
    "exactly one complete iOS base carrier artifact root, got 0",
  );
});

test("binds the exact indexed iOS extension producer and rejects orphaned or drifted roles", RELEASE_GRAPH_TIMEOUT, () => {
  const contract = exactCandidateTargetContract("linux-x64-gnu");
  const fixture = writeIosExtensionInputFixture(contract);
  const inspected = validateIosExtensionCandidateInputs(fixture.root, contract);
  expect(inspected.targetDirectory).toBe(fixture.targetDirectory);
  expect(inspected.artifacts).toHaveLength(85);
  expect(inspected.artifacts.filter(({ kind }) => kind === "runtime")).toHaveLength(39);
  expect(inspected.artifacts.filter(({ kind }) => kind === "ios-xcframework")).toHaveLength(38);
  expect(inspected.artifacts.filter(({ kind }) => kind === "ios-dependency-xcframework")).toHaveLength(8);

  const orphan = path.join(fixture.targetDirectory, "unindexed.zip");
  writeFileSync(orphan, "unindexed bytes\n");
  expect(() => validateIosExtensionCandidateInputs(fixture.root, contract)).toThrow(
    /contains unindexed files/u,
  );
  rmSync(orphan);

  const driftedRows = fixture.rows.map((row) => [...row]);
  const dependency = driftedRows.find((row) => row[2] === "ios-dependency-xcframework");
  expect(dependency).toBeDefined();
  dependency[3] = "forged-dependency";
  writeFileSync(fixture.index, `${[
    NATIVE_EXTENSION_ASSET_INDEX_HEADER.join("\t"),
    ...driftedRows.map((row) => row.join("\t")),
  ].join("\n")}\n`);
  expect(() => validateIosExtensionCandidateInputs(fixture.root, contract)).toThrow(
    /dependency rows drifted/u,
  );
});

test("executes Windows npm shims through an escaped command shell and terminates Verdaccio trees", () => {
  const invocation = exactCandidateCommandInvocation(
    "npm",
    ["install", "--userconfig", String.raw`C:\work tree\registry & proof\npmrc`],
    { platform: "win32", comspec: String.raw`C:\Windows\System32\cmd.exe` },
  );
  expect(invocation.command).toBe(String.raw`C:\Windows\System32\cmd.exe`);
  expect(invocation.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
  expect(invocation.args[3]).toContain("npm.cmd");
  expect(invocation.args[3]).toContain(String.raw`C:\work^^^ tree\registry^^^ ^^^&^^^ proof\npmrc`);
  expect(invocation.args[3]).not.toContain(String.raw`registry & proof`);
  expect(invocation.windowsVerbatimArguments).toBe(true);
  for (const unsafe of ["literal %NAME%", "unmatched %", "literal !"]) {
    expect(() => exactCandidateCommandInvocation(
      "npm",
      ["install", unsafe],
      { platform: "win32", comspec: String.raw`C:\Windows\System32\cmd.exe` },
    )).toThrow("contains '%' or '!'");
  }

  const node = exactCandidateCommandInvocation(
    "node",
    [String.raw`C:\work tree\fixture.mjs`],
    { platform: "win32" },
  );
  expect(node).toEqual({
    command: "node",
    args: [String.raw`C:\work tree\fixture.mjs`],
    windowsVerbatimArguments: false,
  });

  const tar = exactCandidateCommandInvocation(
    "tar",
    ["-xOzf", String.raw`D:\a\oliphaunt\candidate.tgz`, "package/package.json"],
    { platform: "win32", cwd: String.raw`D:\a\oliphaunt` },
  );
  expect(tar).toEqual({
    command: "tar",
    args: [
      "-xOzf",
      "candidate.tgz",
      "package/package.json",
    ],
    cwd: String.raw`D:\a\oliphaunt`,
    windowsVerbatimArguments: false,
  });
  expect(exactCandidateCommandInvocation(
    "tar",
    ["-tzf", "candidate.tgz"],
    { platform: "win32", cwd: String.raw`D:\a\oliphaunt` },
  ).args).toEqual([
    "-tzf",
    "candidate.tgz",
  ]);
  expect(exactCandidateCommandInvocation(
    "tar",
    ["-tzf", "/tmp/candidate.tgz"],
    { platform: "linux", cwd: "/workspace" },
  ).args).toEqual(["-tzf", "/tmp/candidate.tgz"]);

  const registryRoot = mkdtempSync(path.join(ROOT, "target/js-exact-verdaccio-stop-"));
  scratch.push(registryRoot);
  const verdaccioRoot = path.join(registryRoot, "verdaccio");
  mkdirSync(verdaccioRoot);
  const pidFile = path.join(verdaccioRoot, "verdaccio.pid");
  writeFileSync(pidFile, "4242\n");
  const taskkillCalls = [];
  stopVerdaccio(registryRoot, {
    platform: "win32",
    processExistsImpl: () => false,
    taskkill: (pid) => {
      taskkillCalls.push(["/pid", String(pid), "/t", "/f"]);
      return { status: 0 };
    },
  });
  expect(taskkillCalls).toEqual([["/pid", "4242", "/t", "/f"]]);
  expect(existsSync(pidFile)).toBe(false);

  writeFileSync(pidFile, "4243\n");
  expect(() => stopVerdaccio(registryRoot, {
    platform: "win32",
    processExistsImpl: () => true,
    taskkill: () => ({ status: 1, stderr: "access denied" }),
  })).toThrow(/failed to terminate the Verdaccio process tree 4243: .*access denied/u);
  expect(existsSync(pidFile)).toBe(true);

  writeFileSync(pidFile, "4244\n");
  const groupChecks = [true, true, false, false];
  const posixKillCalls = [];
  stopVerdaccio(registryRoot, {
    platform: "linux",
    killProcess: (pid, signal) => posixKillCalls.push([pid, signal]),
    processGroupExistsImpl: () => groupChecks.shift() ?? false,
  });
  expect(posixKillCalls).toEqual([[-4244, "SIGTERM"]]);
  expect(existsSync(pidFile)).toBe(false);

  writeFileSync(pidFile, "4245\n");
  expect(() => stopVerdaccio(registryRoot, {
    platform: "linux",
    killProcess: () => {
      const cause = new Error("operation not permitted");
      cause.code = "EPERM";
      throw cause;
    },
    processGroupExistsImpl: () => true,
  })).toThrow(/failed to terminate the Verdaccio process tree 4245/u);
  expect(existsSync(pidFile)).toBe(true);

  writeFileSync(pidFile, "4246\n");
  expect(() => stopVerdaccio(registryRoot, {
    platform: "linux",
    processExistsImpl: () => true,
    processGroupExistsImpl: () => false,
  })).toThrow(/live POSIX process 4246 does not own the promised process group/u);
  expect(existsSync(pidFile)).toBe(true);
});

posixTest("proves pinned Bun async detached children own the Verdaccio process-group boundary", () => {
  const launcher = spawnSync(process.execPath, [
    "-e",
    [
      'import { spawn } from "node:child_process";',
      "const child = spawn(process.execPath, [\"-e\", \"setInterval(() => {}, 10_000)\"], { detached: true, stdio: \"ignore\" });",
      "child.unref();",
      "process.stdout.write(String(child.pid));",
    ].join(" "),
  ], { encoding: "utf8", timeout: 10_000 });
  expect(launcher.status, launcher.stderr).toBe(0);
  const pid = Number.parseInt(launcher.stdout, 10);
  expect(() => process.kill(-pid, 0)).not.toThrow();
  try {
    const evidence = terminateExactCandidateProcessTree(pid);
    expect(evidence).toMatchObject({
      pid,
      strategy: "posix-process-group",
      terminated: true,
    });
  } finally {
    if (processExistsForTest(pid)) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // The helper already reaped the group.
      }
    }
  }
  expect(processExistsForTest(pid)).toBe(false);
});

test("validates one staged contrib carrier with exact nested and legal bytes", () => {
  const root = mkdtempSync(path.join(ROOT, "target/js-exact-staged-contrib-"));
  scratch.push(root);
  const outputRoot = path.join(root, "output");
  const product = "oliphaunt-extension-contrib-pg18";
  const version = "1.2.3";
  const target = "linux-x64-gnu";
  const carrierRoot = `${product}-${version}-native-${target}-bundle`;
  const stageParent = path.join(root, "stage");
  const stageRoot = path.join(stageParent, carrierRoot);
  const compatibility = {
    postgresMajor: "18",
    extensionRuntimeContract: "src/shared/extension-runtime-contract/contract.toml",
    nativeRuntimeProduct: "liboliphaunt-native",
    nativeRuntimeVersion: version,
    wasixRuntimeProduct: "liboliphaunt-wasix",
    wasixRuntimeVersion: version,
  };
  const memberNames = ["cube", "pg_trgm"];
  const legal = extensionCarrierLegalContract(product, memberNames, {
    family: "native",
    target,
  });
  const memberEvidence = ["cube", "pg_trgm"].map((sqlName) => {
    const name = `${sqlName}.tar.gz`;
    const memberPath = `extensions/${sqlName}/${name}`;
    const file = path.join(stageRoot, ...memberPath.split("/"));
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(
      file,
      sqlName === "cube"
        ? Buffer.alloc(2 * 1024 * 1024, 0x5a)
        : `exact raw carrier for ${sqlName}\n`,
    );
    return {
      sqlName,
      rawAssetBytes: readFileSync(file).byteLength,
      rawAssetSha256: fileSha256(file),
      asset: {
        name,
        family: "native",
        target,
        kind: "runtime",
        identity: null,
        bytes: readFileSync(file).byteLength,
        sha256: fileSha256(file),
        carrierAsset: `${carrierRoot}.tar.gz`,
        carrierRoot,
        memberPath,
      },
    };
  });
  stageReleaseNotices(stageRoot, { profile: legal.profile });
  writeFileSync(path.join(stageRoot, "bundle-manifest.json"), `${JSON.stringify({
    schema: "oliphaunt-extension-bundle-v1",
    product,
    version,
    compatibility,
    family: "native",
    target,
    licenseProfile: legal.profile,
    licenseFiles: legal.licenseFiles,
    members: memberEvidence.map(({ sqlName, asset }) => ({
      sqlName,
      kind: asset.kind,
      identity: asset.identity,
      path: asset.memberPath,
      sha256: asset.sha256,
      bytes: asset.bytes,
    })),
  }, null, 2)}\n`);
  mkdirSync(outputRoot, { recursive: true });
  const carrierFile = path.join(outputRoot, `${carrierRoot}.tar.gz`);
  writeFileSync(carrierFile, canonicalGzipSync(createDeterministicTar(stageRoot, carrierRoot, {
    fail: (message) => {
      throw new Error(message);
    },
    fixedFileMode: 0o644,
  })));
  const carrier = {
    name: path.basename(carrierFile),
    path: path.relative(ROOT, carrierFile),
    sha256: fileSha256(carrierFile),
    bytes: readFileSync(carrierFile).byteLength,
    family: "native",
    target,
    kind: "extension-bundle",
    memberCount: 2,
  };
  expect(validateStagedBundleCarrier({
    carrier,
    compatibility,
    contract: { target },
    group: { product, version, members: memberNames },
    memberEvidence,
    outputRoot,
  })).toMatchObject({ memberCount: 2, target });

  const tampered = structuredClone(memberEvidence);
  tampered[1].rawAssetSha256 = "0".repeat(64);
  expect(() => validateStagedBundleCarrier({
    carrier,
    compatibility,
    contract: { target },
    group: { product, version, members: memberNames },
    memberEvidence: tampered,
    outputRoot,
  })).toThrow(/pg_trgm bundle member bytes drifted/u);
});

test("binds staged exact-candidate members to every frozen inventory field", () => {
  const root = mkdtempSync(path.join(ROOT, "target/js-exact-member-inventory-"));
  scratch.push(root);
  const target = "linux-x64-gnu";
  const extension = exactCandidateExtensions(target).find(({ sqlName }) => sqlName === "pgtap");
  expect(extension).toBeDefined();
  const rawFile = path.join(root, "pgtap.tar.gz");
  writeFileSync(rawFile, "qualified raw pgtap carrier\n");
  const raw = {
    bytes: readFileSync(rawFile).byteLength,
    sha256: fileSha256(rawFile),
  };
  const iosFile = path.join(root, "pgtap-ios.tar.gz");
  writeFileSync(iosFile, "qualified raw iOS pgtap carrier\n");
  const asset = {
    name: path.basename(rawFile),
    path: path.relative(ROOT, rawFile),
    family: "native",
    kind: "runtime",
    target,
    identity: null,
    ...raw,
  };
  const iosAsset = {
    name: path.basename(iosFile),
    path: path.relative(ROOT, iosFile),
    family: "native",
    kind: "runtime",
    target: "ios-xcframework",
    identity: null,
    bytes: readFileSync(iosFile).byteLength,
    sha256: fileSha256(iosFile),
  };
  const member = {
    sqlName: extension.sqlName,
    desktopReleaseReady: true,
    mobileReleaseReady: true,
    createsExtension: extension.createsExtension,
    nativeModuleStem: extension.nativeModuleStem,
    iosNativeDependencies: extension.iosNativeDependencies,
    dependencies: extension.dependencies,
    dataFiles: extension.dataFiles,
    extensionSqlFileNames: extension.extensionSqlFileNames,
    extensionSqlFilePrefixes: extension.extensionSqlFilePrefixes,
    sharedPreloadLibraries: extension.sharedPreloadLibraries,
    assets: [asset, iosAsset],
  };
  expect(validateStagedExtensionMember({
    member,
    contract: { target },
    extension,
    outputRoot: root,
    raw,
  })).toMatchObject({ sqlName: "pgtap", rawAssetSha256: raw.sha256 });

  expect(() => validateStagedExtensionMember({
    member: { ...member, assets: [asset] },
    contract: { target },
    extension,
    outputRoot: root,
    raw,
  })).toThrow(/exact canonical iOS asset roles/u);

  for (const [field, forged] of [
    ["dataFiles", ["forged/data.dat"]],
    ["extensionSqlFileNames", []],
    ["extensionSqlFilePrefixes", []],
    ["sharedPreloadLibraries", ["forged_preload"]],
  ]) {
    expect(() => validateStagedExtensionMember({
      member: { ...member, [field]: forged },
      contract: { target },
      extension,
      outputRoot: root,
      raw,
    })).toThrow(/does not match the canonical exact-extension member contract/u);
  }
});

test("derives the exact four-target consumer and exact-extension product contracts", RELEASE_GRAPH_TIMEOUT, () => {
  const matrix = jsExactCandidateConsumerMatrix().include;
  expect(matrix.map((row) => row.target)).toEqual(JS_EXACT_CANDIDATE_CONSUMER_TARGETS);
  expect(matrix.map((row) => row.runner)).toEqual([
    "ubuntu-24.04-arm",
    "ubuntu-24.04",
    "macos-26",
    "windows-2025-vs2026",
  ]);
  for (const row of matrix) {
    expect(row.extension_artifact).toBe(`liboliphaunt-native-extension-artifacts-${row.target}`);
    const extensions = exactCandidateExtensions(row.target);
    expect(extensions).toHaveLength(39);
    expect(new Set(extensions.map((extension) => extension.sqlName)).size).toBe(39);
    for (const extension of extensions) {
      expect(extension.npmTargets).toEqual(JS_EXACT_CANDIDATE_CONSUMER_TARGETS);
      expect(extension.targetPackage.endsWith(`-${row.target}`)).toBe(true);
    }
    const cube = extensions.find(({ sqlName }) => sqlName === "cube");
    const pgTrgm = extensions.find(({ sqlName }) => sqlName === "pg_trgm");
    expect(cube).toBeDefined();
    expect(pgTrgm).toBeDefined();
    expect(cube.product).toBe("oliphaunt-extension-contrib-pg18");
    expect(pgTrgm.product).toBe("oliphaunt-extension-contrib-pg18");
    expect(cube.metaPackage).toBe(pgTrgm.metaPackage);
    expect(cube.targetPackage).toBe(pgTrgm.targetPackage);
    const contract = exactCandidateTargetContract(row.target);
    expect(Object.keys(contract.packages)).toHaveLength(22);
    expect(contract.extensions).toHaveLength(39);
  }
  const productGroups = exactCandidateExtensionProductGroups(
    exactCandidateExtensions("linux-x64-gnu"),
  );
  expect(productGroups).toHaveLength(8);
  const contrib = productGroups.find(
    ({ product }) => product === "oliphaunt-extension-contrib-pg18",
  );
  expect(contrib).toBeDefined();
  expect(contrib.members).toContain("cube");
  expect(contrib.members).toContain("pg_trgm");
  const coveredSqlNames = productGroups.flatMap(({ members }) => members);
  expect(coveredSqlNames).toHaveLength(39);
  expect(new Set(coveredSqlNames).size).toBe(39);
});

test("requires the same-run portable ICU package and asset on every desktop target", RELEASE_GRAPH_TIMEOUT, () => {
  for (const target of JS_EXACT_CANDIDATE_CONSUMER_TARGETS) {
    const contract = exactCandidateTargetContract(target);
    expect(contract.packages["@oliphaunt/icu"]).toBe(contract.versions.native);
    expect(contract.assets.icu).toBe(
      `liboliphaunt-${contract.versions.native}-icu-data.tar.gz`,
    );
  }
});

test("runs every claimed native JavaScript runtime on every published desktop target", () => {
  const expected = [
    { runtime: "node", engine: "nativeDirect" },
    { runtime: "node", engine: "nativeBroker" },
    { runtime: "node", engine: "nativeServer" },
    { runtime: "bun", engine: "nativeDirect" },
    { runtime: "deno", engine: "nativeDirect" },
  ];
  const matrix = jsExactCandidateConsumerMatrix().include;
  expect(matrix.map(({ target }) => target)).toEqual(JS_EXACT_CANDIDATE_CONSUMER_TARGETS);
  for (const { target, ...row } of matrix) {
    expect(row).not.toHaveProperty("extended_javascript_runtimes");
    expect(exactCandidateRuntimeCases(target)).toEqual(expected);
  }
  expect(() => exactCandidateRuntimeCases("macos-x64")).toThrow(
    /unsupported TypeScript exact-candidate target macos-x64/u,
  );
});

test("attempts every exact-candidate runtime case and aggregates independent failures", () => {
  const cases = exactCandidateRuntimeCases("linux-x64-gnu");
  const attempted = [];
  const snapshots = [];
  const settlement = executeExactCandidateRuntimeCasesFailLate(cases, {
    executePhase(testCase, phase, id) {
      attempted.push(`${id}/${phase}`);
      if (id === "node-nativeDirect" && phase === "produce") {
        throw new Error("direct host received SIGUSR1");
      }
      if (id === "node-nativeServer" && phase === "verify-restored") {
        throw new Error("server account rejected");
      }
    },
    readReceipt(_testCase, id) {
      return { id, verified: true };
    },
    onResult(_result, results) {
      snapshots.push(results);
    },
  });

  expect(attempted).toEqual([
    "node-nativeDirect/produce",
    "node-nativeBroker/produce",
    "node-nativeBroker/verify-restored",
    "node-nativeServer/produce",
    "node-nativeServer/verify-restored",
    "bun-nativeDirect/produce",
    "bun-nativeDirect/verify-restored",
    "deno-nativeDirect/produce",
    "deno-nativeDirect/verify-restored",
  ]);
  expect(settlement.results.map(({ id, state }) => `${id}:${state}`)).toEqual([
    "node-nativeDirect:failed",
    "node-nativeBroker:passed",
    "node-nativeServer:failed",
    "bun-nativeDirect:passed",
    "deno-nativeDirect:passed",
  ]);
  expect(settlement.failures.map(({ id, phase }) => `${id}/${phase}`)).toEqual([
    "node-nativeDirect/produce",
    "node-nativeServer/verify-restored",
  ]);
  expect(settlement.receipts).toEqual([
    { id: "node-nativeBroker", verified: true },
    { id: "bun-nativeDirect", verified: true },
    { id: "deno-nativeDirect", verified: true },
  ]);
  expect(snapshots.map((results) => results.length)).toEqual([1, 2, 3, 4, 5]);
  expect(exactCandidateRuntimeFailureMessage(settlement.failures)).toBe(
    "node-nativeDirect/produce: direct host received SIGUSR1; node-nativeServer/verify-restored: server account rejected",
  );
});

test("treats an unreadable runtime receipt as one case failure without masking later cases", () => {
  const cases = [
    { runtime: "node", engine: "nativeBroker" },
    { runtime: "bun", engine: "nativeDirect" },
  ];
  const attempted = [];
  const settlement = executeExactCandidateRuntimeCasesFailLate(cases, {
    executePhase(_testCase, phase, id) {
      attempted.push(`${id}/${phase}`);
    },
    readReceipt(_testCase, id) {
      if (id === "node-nativeBroker") throw new SyntaxError("invalid receipt JSON");
      return { id };
    },
  });

  expect(attempted).toEqual([
    "node-nativeBroker/produce",
    "node-nativeBroker/verify-restored",
    "bun-nativeDirect/produce",
    "bun-nativeDirect/verify-restored",
  ]);
  expect(settlement.failures).toEqual([{
    id: "node-nativeBroker",
    runtime: "node",
    engine: "nativeBroker",
    state: "failed",
    phase: "read-receipt",
    error: { name: "SyntaxError", message: "invalid receipt JSON" },
    phases: [
      { phase: "produce", state: "passed" },
      { phase: "verify-restored", state: "passed" },
      {
        phase: "read-receipt",
        state: "failed",
        error: { name: "SyntaxError", message: "invalid receipt JSON" },
      },
    ],
  }]);
  expect(settlement.receipts).toEqual([{ id: "bun-nativeDirect" }]);
});

test("a real command timeout is typed and fail-closes every later phase and case", () => {
  const root = mkdtempSync(path.join(ROOT, "target/js-exact-timeout-tree-"));
  scratch.push(root);
  const descendantPidFile = path.join(root, "descendant.pid");
  const cases = [
    { runtime: "node", engine: "nativeDirect" },
    { runtime: "bun", engine: "nativeDirect" },
  ];
  const attempted = [];
  const settlement = executeExactCandidateRuntimeCasesFailLate(cases, {
    executePhase(_testCase, phase, id) {
      attempted.push(`${id}/${phase}`);
      runExactCandidateCommandWithTimeout(process.execPath, [
        "-e",
        [
          'import { spawn } from "node:child_process";',
          'import { writeFileSync } from "node:fs";',
          "const child = spawn(process.execPath, [\"-e\", \"await new Promise((resolve) => setTimeout(resolve, 10_000))\"], { stdio: \"ignore\" });",
          "writeFileSync(process.env.OLIPHAUNT_DESCENDANT_PID_FILE, String(child.pid));",
          "await new Promise((resolve) => setTimeout(resolve, 10_000));",
        ].join(" "),
      ], {
        env: {
          ...process.env,
          OLIPHAUNT_DESCENDANT_PID_FILE: descendantPidFile,
        },
        timeout: 1_000,
      });
    },
    readReceipt(_testCase, id) {
      throw new Error(`unsafe receipt continuation for ${id}`);
    },
  });

  expect(attempted).toEqual(["node-nativeDirect/produce"]);
  expect(settlement.stopReason).toMatchObject({
    code: "unsafe-continuation-after-command-timeout",
    id: "node-nativeDirect",
    phase: "produce",
    error: {
      name: "ExactCandidateCommandTimeoutError",
      code: "OLIPHAUNT_EXACT_CANDIDATE_COMMAND_TIMEOUT",
      phaseStarted: true,
      timedOut: true,
      timeoutMs: 1_000,
      processTreeTerminated: true,
      processTree: {
        strategy: process.platform === "win32" ? "taskkill-tree" : "posix-process-group",
        terminated: true,
      },
    },
  });
  expect(settlement.results[0]).toMatchObject({
    state: "failed",
    phase: "produce",
    error: {
      name: "ExactCandidateCommandTimeoutError",
      timedOut: true,
    },
    phases: [
      { phase: "produce", state: "failed" },
      {
        phase: "verify-restored",
        state: "unattempted",
        reason: "unsafe-continuation-after-command-timeout",
      },
      {
        phase: "read-receipt",
        state: "unattempted",
        reason: "unsafe-continuation-after-command-timeout",
      },
    ],
  });
  expect(settlement.results[1]).toMatchObject({
    state: "unattempted",
    reason: "unsafe-continuation-after-command-timeout",
    phases: [
      {
        phase: "produce",
        state: "unattempted",
        reason: "unsafe-continuation-after-command-timeout",
      },
      {
        phase: "verify-restored",
        state: "unattempted",
        reason: "unsafe-continuation-after-command-timeout",
      },
      {
        phase: "read-receipt",
        state: "unattempted",
        reason: "unsafe-continuation-after-command-timeout",
      },
    ],
  });
  expect(settlement.failures[0].error.timedOut).toBe(true);
  const directPid = settlement.failures[0].error.processTree.pid;
  const descendantPid = Number.parseInt(readFileSync(descendantPidFile, "utf8"), 10);
  expect(processExistsForTest(directPid)).toBe(false);
  expect(processExistsForTest(descendantPid)).toBe(false);
  expect(new ExactCandidateCommandTimeoutError("test", 50)).toMatchObject({
    timedOut: true,
    phaseStarted: true,
  });
});

test("uses Windows tree termination semantics and never removes an unproven timeout run root", () => {
  expect(exactCandidateWindowsProcessTreeKillArgs(4242)).toEqual([
    "/pid",
    "4242",
    "/t",
    "/f",
  ]);
  const root = mkdtempSync(path.join(ROOT, "target/js-exact-retained-run-root-"));
  scratch.push(root);
  const runRoot = path.join(root, "run-root");
  mkdirSync(runRoot);
  writeFileSync(path.join(runRoot, "server.log"), "live descendant evidence\n");
  const timeoutResult = {
    id: "node-nativeDirect",
    error: { timedOut: true, processTreeTerminated: false },
  };

  expect(() => removeExactCandidateRunRoot(runRoot, timeoutResult)).toThrow(
    "run root was retained because child-tree termination was not proven",
  );
  expect(existsSync(runRoot)).toBe(true);
  removeExactCandidateRunRoot(runRoot, {
    ...timeoutResult,
    error: { timedOut: true, processTreeTerminated: true },
  });
  expect(existsSync(runRoot)).toBe(false);
});

test("bounds captured output and tears down the overflowing child and descendant", () => {
  const root = mkdtempSync(path.join(ROOT, "target/js-exact-output-limit-tree-"));
  scratch.push(root);
  const descendantPidFile = path.join(root, "descendant.pid");
  let cause;
  try {
    runExactCandidateCommandWithTimeout(process.execPath, [
      "-e",
      [
        'import { spawn } from "node:child_process";',
        'import { writeFileSync } from "node:fs";',
        "const child = spawn(process.execPath, [\"-e\", \"await new Promise((resolve) => setTimeout(resolve, 10_000))\"], { stdio: \"ignore\" });",
        "writeFileSync(process.env.OLIPHAUNT_DESCENDANT_PID_FILE, String(child.pid));",
        'process.stdout.write("x".repeat(5 * 1024 * 1024));',
        "await new Promise((resolve) => setTimeout(resolve, 10_000));",
      ].join(" "),
    ], {
      env: {
        ...process.env,
        OLIPHAUNT_DESCENDANT_PID_FILE: descendantPidFile,
      },
      timeout: 10_000,
    });
  } catch (error) {
    cause = error;
  }

  expect(cause).toBeInstanceOf(ExactCandidateCommandWatchdogError);
  expect(cause).toMatchObject({
    code: "OLIPHAUNT_EXACT_CANDIDATE_COMMAND_WATCHDOG",
    phaseStarted: true,
    processTreeTerminated: true,
    unsafeContinuation: false,
    processTree: { terminated: true },
  });
  expect(cause.message).toContain("command output exceeded 4194304 bytes");
  const descendantPid = Number.parseInt(readFileSync(descendantPidFile, "utf8"), 10);
  expect(processExistsForTest(cause.processTree.pid)).toBe(false);
  expect(processExistsForTest(descendantPid)).toBe(false);
});

test("uses a durable PID to emergency-terminate malformed, missing, or nonterminal protocols", () => {
  expect(exactCandidateCommandWatchdogEmergencyTimeout(1_000)).toBe(21_000);
  expect(exactCandidateCommandWatchdogEmergencyTimeout(1_000)).toBeLessThan(5 * 60_000);
  for (const invalid of [
    "",
    "{not-json}\n",
    `${JSON.stringify({ schemaVersion: 1, state: "running", pid: 42 })}\n`,
  ]) {
    expect(() => parseExactCandidateCommandWatchdogProtocol(invalid)).toThrow(
      /command watchdog/u,
    );
  }

  const launcher = spawnSync("node", [
    "-e",
    [
      'const { spawn } = require("node:child_process");',
      'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 10_000)"], { detached: true, stdio: "ignore" });',
      "child.unref();",
      "process.stdout.write(String(child.pid));",
    ].join(" "),
  ], { encoding: "utf8", timeout: 10_000 });
  expect(launcher.status, launcher.stderr).toBe(0);
  const durablePid = Number.parseInt(launcher.stdout, 10);
  expect(processExistsForTest(durablePid)).toBe(true);

  const protocolCause = new Error("malformed terminal record");
  const failure = exactCandidateCommandWatchdogFailureResult(
    {},
    durablePid,
    "watchdog produced no valid terminal record",
    protocolCause,
  );
  expect(failure).toMatchObject({
    supervisorFailed: true,
    unsafeContinuation: true,
    processTree: { pid: durablePid, terminated: true },
  });
  expect(processExistsForTest(durablePid)).toBe(false);
});

test("maps the source child signal and removes partial runToFile output on timeout", () => {
  expect(() => runExactCandidateCommandWithTimeout(process.execPath, [
    "-e",
    'process.kill(process.pid, "SIGTERM")',
  ], { timeout: 5_000 })).toThrow(/signal SIGTERM/u);

  const root = mkdtempSync(path.join(ROOT, "target/js-exact-run-to-file-"));
  scratch.push(root);
  const destination = path.join(root, "partial.bin");
  expect(() => runExactCandidateCommandToFileWithTimeout(process.execPath, [
    "-e",
    [
      'process.stdout.write("partial candidate bytes");',
      "await new Promise((resolve) => setTimeout(resolve, 10_000));",
    ].join(" "),
  ], destination, { timeout: 500 })).toThrow(ExactCandidateCommandTimeoutError);
  expect(existsSync(destination)).toBe(false);

  writeFileSync(destination, "preexisting evidence\n");
  expect(() => runExactCandidateCommandToFileWithTimeout(process.execPath, [
    "-e",
    'process.stdout.write("replacement")',
  ], destination, { timeout: 5_000 })).toThrow();
  expect(readFileSync(destination, "utf8")).toBe("preexisting evidence\n");
});

test("an unproven watchdog tree fail-closes later cases and retains the run root", () => {
  const cases = [
    { runtime: "node", engine: "nativeDirect" },
    { runtime: "bun", engine: "nativeDirect" },
    { runtime: "deno", engine: "nativeDirect" },
  ];
  const snapshots = [];
  const settlement = executeExactCandidateRuntimeCasesFailLate(cases, {
    executePhase() {
      throw new ExactCandidateCommandWatchdogError("node", "protocol failure", {
        processTree: { pid: 1234, terminated: false },
      });
    },
    readReceipt() {
      throw new Error("receipt must not be reached");
    },
    onResult(result, results) {
      snapshots.push(completeExactCandidateResults(
        cases,
        results,
        exactCandidatePendingSettlementReason(result, "pending-runtime-settlement"),
      ));
    },
  });
  expect(settlement.stopReason).toMatchObject({
    code: "unsafe-continuation-after-command-supervisor-failure",
  });
  expect(settlement.results[1]).toMatchObject({
    state: "unattempted",
    reason: "unsafe-continuation-after-command-supervisor-failure",
  });
  expect(settlement.results[2]).toMatchObject({
    state: "unattempted",
    reason: "unsafe-continuation-after-command-supervisor-failure",
  });
  expect(snapshots).toHaveLength(3);
  for (const snapshot of snapshots) {
    expect(snapshot.slice(1).map(({ state, reason }) => ({ state, reason }))).toEqual([
      {
        state: "unattempted",
        reason: "unsafe-continuation-after-command-supervisor-failure",
      },
      {
        state: "unattempted",
        reason: "unsafe-continuation-after-command-supervisor-failure",
      },
    ]);
  }

  const root = mkdtempSync(path.join(ROOT, "target/js-exact-watchdog-retained-root-"));
  scratch.push(root);
  const runRoot = path.join(root, "run-root");
  mkdirSync(runRoot);
  expect(() => removeExactCandidateRunRoot(runRoot, settlement.results[0])).toThrow(
    "run root was retained because child-tree termination was not proven",
  );
  expect(existsSync(runRoot)).toBe(true);
});

test("persists before cleanup and retains runtime, callback, and cleanup failures together", () => {
  const order = [];
  const snapshots = [];
  const settlement = executeExactCandidateRuntimeCasesFailLate([
    { runtime: "node", engine: "nativeDirect" },
    { runtime: "bun", engine: "nativeDirect" },
  ], {
    executePhase(_testCase, phase, id) {
      order.push(`execute:${id}/${phase}`);
      throw new Error("runtime primary failure");
    },
    readReceipt() {
      throw new Error("receipt must not be reached");
    },
    onResult(_result, results) {
      order.push("persist");
      snapshots.push(results);
      throw new Error("evidence persistence failure");
    },
    cleanupCase() {
      order.push("cleanup");
      throw new Error("run-root cleanup failure");
    },
  });

  expect(order.slice(0, 3)).toEqual([
    "execute:node-nativeDirect/produce",
    "persist",
    "cleanup",
  ]);
  expect(snapshots[0][0]).not.toHaveProperty("cleanupErrors");
  expect(settlement.results[0]).toMatchObject({
    id: "node-nativeDirect",
    state: "failed",
    phase: "produce",
    error: { message: "runtime primary failure" },
    callbackErrors: [{ message: "evidence persistence failure" }],
    cleanupErrors: [{ message: "run-root cleanup failure" }],
  });
  expect(settlement.results[1]).toMatchObject({
    id: "bun-nativeDirect",
    state: "unattempted",
    reason: "evidence-persistence-failed",
  });
  expect(settlement.failures).toHaveLength(1);
  expect(exactCandidateRuntimeFailureMessage(settlement.failures)).toBe(
    "node-nativeDirect/produce: runtime primary failure; "
      + "node-nativeDirect/cleanup: run-root cleanup failure; "
      + "node-nativeDirect/evidence: evidence persistence failure",
  );
});

test("aggregates independent runtime and portable JSR failures", () => {
  const runtime = executeExactCandidateRuntimeCasesFailLate([
    { runtime: "node", engine: "nativeDirect" },
  ], {
    executePhase() {
      throw new Error("runtime proof failure");
    },
    readReceipt() {
      throw new Error("runtime receipt must not be reached");
    },
  });
  const jsr = executeExactCandidateRuntimeCasesFailLate([
    { runtime: "deno", engine: "jsrPortable" },
  ], {
    phasesForCase: () => ["consume"],
    executePhase() {
      throw new Error("JSR proof failure");
    },
    readReceipt() {
      throw new Error("JSR receipt must not be reached");
    },
  });
  const combined = combineExactCandidateSettlements(runtime, jsr);

  expect(combined.failures.map(({ id }) => id)).toEqual([
    "node-nativeDirect",
    "deno-jsrPortable",
  ]);
  expect(exactCandidateRuntimeFailureMessage(combined.failures)).toBe(
    "node-nativeDirect/produce: runtime proof failure; deno-jsrPortable/consume: JSR proof failure",
  );
});

test("preserves a primary consumer failure and Verdaccio cleanup failure as aggregate evidence", () => {
  const registryRoot = mkdtempSync(path.join(ROOT, "target/js-exact-verdaccio-aggregate-"));
  scratch.push(registryRoot);
  const verdaccioRoot = path.join(registryRoot, "verdaccio");
  mkdirSync(verdaccioRoot);
  writeFileSync(path.join(verdaccioRoot, "verdaccio.pid"), "9001\n");
  let cleanupCause;
  try {
    stopVerdaccio(registryRoot, {
      platform: "win32",
      processExistsImpl: () => true,
      taskkill: () => ({ status: 1, stderr: "cleanup access denied" }),
    });
  } catch (cause) {
    cleanupCause = cause;
  }
  const primaryCause = new Error("runtime primary failure");
  const combined = aggregateExactCandidateErrors(
    "consumer and Verdaccio cleanup failed",
    [primaryCause, cleanupCause],
  );
  const evidence = exactCandidateErrorEvidence(combined);

  expect(combined).toBeInstanceOf(AggregateError);
  expect(combined.errors).toEqual([primaryCause, cleanupCause]);
  expect(evidence).toMatchObject({
    name: "AggregateError",
    errors: [
      { message: "runtime primary failure" },
      { message: expect.stringContaining("failed to terminate the Verdaccio process tree 9001") },
    ],
  });
});

test("the absolute consumer deadline records explicit unattempted phases without starting work", () => {
  const deadline = createExactCandidateConsumerDeadline({
    startedAtMs: 1_000,
    totalBudgetMs: 100,
    reserveMs: 20,
    now: () => 1_080,
  });
  const attempted = [];
  const settlement = executeExactCandidateRuntimeCasesFailLate([
    { runtime: "node", engine: "nativeDirect" },
    { runtime: "bun", engine: "nativeDirect" },
  ], {
    beforePhase(_testCase, phase, id) {
      return deadline.timeout(50, `${id}/${phase}`);
    },
    executePhase(_testCase, phase, id) {
      attempted.push(`${id}/${phase}`);
    },
    readReceipt() {
      throw new Error("receipt must not be reached");
    },
  });

  expect(attempted).toEqual([]);
  expect(settlement.results[0]).toMatchObject({
    state: "failed",
    phase: "admit-produce",
    error: {
      name: "ExactCandidateDeadlineError",
      code: "OLIPHAUNT_EXACT_CANDIDATE_DEADLINE",
      deadlineExceeded: true,
      phaseStarted: false,
    },
    phases: [
      {
        phase: "produce",
        state: "unattempted",
        reason: "consumer-deadline-reached",
      },
      {
        phase: "verify-restored",
        state: "unattempted",
        reason: "consumer-deadline-reached",
      },
      {
        phase: "read-receipt",
        state: "unattempted",
        reason: "consumer-deadline-reached",
      },
    ],
  });
  expect(settlement.results[1]).toMatchObject({
    state: "unattempted",
    reason: "consumer-deadline-reached",
  });
  expect(() => deadline.timeout(50, "late phase")).toThrow(ExactCandidateDeadlineError);
});

test("retains bounded sanitized first-and-last diagnostics for failed cases", () => {
  const root = mkdtempSync(path.join(ROOT, "target/js-exact-diagnostics-"));
  scratch.push(root);
  const evidenceRoot = path.join(root, "evidence");
  const runRoot = path.join(root, "run-root");
  mkdirSync(runRoot, { recursive: true });
  const log = [
    `FIRST ${runRoot} token=topsecret https://name:password@example.invalid/\n`,
    "x".repeat(300 * 1024),
    `\nLAST ${ROOT} authorization=Bearer-secret\n`,
  ].join("");
  writeFileSync(path.join(runRoot, "server.log"), log);

  writeBoundedExactCandidateDiagnostics({
    evidenceRoot,
    id: "node-nativeDirect",
    result: {
      state: "failed",
      error: { message: `token=topsecret ${runRoot}` },
    },
    runRoot,
  });

  const destination = path.join(
    evidenceRoot,
    "failed-case-diagnostics",
    "node-nativeDirect",
  );
  const manifest = JSON.parse(readFileSync(path.join(destination, "manifest.json"), "utf8"));
  const captured = readFileSync(path.join(destination, manifest.files[0].capturedPath), "utf8");
  expect(manifest.files[0]).toMatchObject({
    relativePath: "server.log",
    truncated: true,
  });
  expect(manifest.capturedBytes).toBeLessThanOrEqual(256 * 1024);
  expect(captured).toContain("FIRST <RUN_ROOT>");
  expect(captured).toContain("LAST <REPOSITORY>");
  expect(captured).toContain("<OLIPHAUNT_DIAGNOSTIC_TRUNCATED>");
  expect(captured).not.toContain("topsecret");
  expect(captured).not.toContain("name:password");
  expect(captured).not.toContain(runRoot);
  expect(captured).not.toContain(ROOT);
  expect(JSON.stringify(manifest.result)).not.toContain("topsecret");
  expect(JSON.stringify(manifest.result)).not.toContain(runRoot);
});

test("pins installable Bun and Deno binaries for every exact-candidate runner target", () => {
  const bun = Bun.TOML.parse(readFileSync(
    path.join(ROOT, "src/sources/toolchains/bun.toml"),
    "utf8",
  ));
  const deno = Bun.TOML.parse(readFileSync(
    path.join(ROOT, "src/sources/toolchains/deno.toml"),
    "utf8",
  ));
  const toolchainTargets = {
    "linux-arm64-gnu": ["linux-aarch64", "aarch64-unknown-linux-gnu"],
    "linux-x64-gnu": ["linux-x64", "x86_64-unknown-linux-gnu"],
    "macos-arm64": ["darwin-aarch64", "aarch64-apple-darwin"],
    "windows-x64-msvc": ["windows-x64", "x86_64-pc-windows-msvc"],
  };
  expect(Object.keys(toolchainTargets)).toEqual(JS_EXACT_CANDIDATE_CONSUMER_TARGETS);
  for (const [target, [bunTarget, denoTarget]] of Object.entries(toolchainTargets)) {
    for (const [runtime, manifest, runtimeTarget] of [
      ["Bun", bun, bunTarget],
      ["Deno", deno, denoTarget],
    ]) {
      const asset = manifest.assets?.[runtimeTarget];
      expect(asset, `${runtime} has no pinned binary for ${target}`).toBeDefined();
      expect(asset.url).toMatch(/^https:\/\//u);
      expect(asset.sha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(asset.binary_sha256).toMatch(/^[0-9a-f]{64}$/u);
    }
  }
});

test("planner closes every exact consumer over complete same-run producers without widening focused extensions", RELEASE_GRAPH_TIMEOUT, () => {
  const jobs = new Set(["affected", "js-sdk-exact-candidate-consumer"]);
  addImpliedJobs(jobs, new Set());
  for (const producer of [
    "broker-runtime",
    "extension-artifacts-native",
    "js-sdk-package",
    "liboliphaunt-native-desktop",
    "liboliphaunt-native-ios",
    "node-direct",
  ]) expect(jobs.has(producer)).toBe(true);
  expect(jobs.has("liboliphaunt-native-release-assets")).toBe(false);
  const products = selectedExtensionProductsForPlan(new Set(), new Set(), jobs);
  const expectedProducts = new Set(
    exactCandidateExtensionProductGroups(exactCandidateExtensions("linux-x64-gnu"))
      .map(({ product }) => product),
  );
  expect(products).toEqual(expectedProducts);
  expect(products?.size).toBe(8);
  const matrix = extensionArtifactsNativeMatrixForPlan(jobs, null, products).include;
  expect(matrix.map((row) => row.target)).toEqual(
    [...JS_EXACT_CANDIDATE_CONSUMER_TARGETS, "ios-xcframework"].sort(),
  );
  expect(matrix.every((row) => row.extension_count === "39")).toBe(true);

  const focusedJobs = new Set(["affected", "extension-artifacts-native"]);
  const vector = new Set(["oliphaunt-extension-vector"]);
  const focused = extensionArtifactsNativeMatrixForPlan(focusedJobs, new Set(["linux-x64-gnu"]), vector).include;
  expect(focused).toHaveLength(1);
  expect(focused[0].extensions_csv).toBe("oliphaunt-extension-vector");
});

test("focused desktop dispatches select one JS target plus the canonical portable ICU provider", RELEASE_GRAPH_TIMEOUT, () => {
  for (const target of JS_EXACT_CANDIDATE_CONSUMER_TARGETS) {
    const plan = renderPlanForFullRun({ nativeTarget: target });
    expect(plan.js_exact_candidate_consumer_matrix.include.map((row) => row.target)).toEqual([target]);
    expect(plan.liboliphaunt_native_desktop_runtime_matrix.include.map((row) => row.target).sort()).toEqual(
      [...new Set([target, "macos-arm64"])].sort(),
    );
    expect(plan.liboliphaunt_native_ios_runtime_matrix.include.map((row) => row.target)).toEqual([
      "ios-xcframework",
    ]);
    for (const matrix of [
      plan.extension_artifacts_native_matrix,
      plan.broker_runtime_matrix,
      plan.node_direct_runtime_matrix,
    ]) {
      expect(matrix.include.some((row) => row.target === target)).toBe(true);
    }
    expect(plan.extension_artifacts_native_matrix.include.some(
      (row) => row.target === "ios-xcframework",
    )).toBe(true);
    expect(() => assertJsExactCandidatePlanClosure(plan)).not.toThrow();
  }

  const full = renderPlanForFullRun();
  expect(full.js_exact_candidate_consumer_matrix.include.map((row) => row.target)).toEqual(
    JS_EXACT_CANDIDATE_CONSUMER_TARGETS,
  );
  expect(() => assertJsExactCandidatePlanClosure(full)).not.toThrow();
});

test("affected broker/lifecycle selection cannot narrow producers beneath the four-target JS matrix", RELEASE_GRAPH_TIMEOUT, () => {
  const directProjects = new Set(["oliphaunt-broker"]);
  const tasks = new Set(["oliphaunt-broker:release-assets"]);
  const jobs = planJobsForAffected(directProjects, tasks);
  const selectedTargets = nativeTargetSubsetForJobs(jobs, tasks);
  expect(selectedTargets).toEqual(new Set(["linux-x64-gnu"]));
  const selectedExtensionProducts = selectedExtensionProductsForPlan(directProjects, tasks, jobs);
  const plan = renderPlanWithSelection({
    jobs,
    projects: directProjects,
    tasks,
    reason: "broker affected-plan fixture",
    selectedTargets,
    selectedExtensionProducts,
    nativeTarget: "all",
  });

  for (const key of [
    "js_exact_candidate_consumer_matrix",
    "liboliphaunt_native_desktop_runtime_matrix",
    "broker_runtime_matrix",
    "node_direct_runtime_matrix",
  ]) {
    expect(plan[key].include.map((row) => row.target)).toEqual(JS_EXACT_CANDIDATE_CONSUMER_TARGETS);
  }
  expect(new Set(plan.extension_artifacts_native_matrix.include.map((row) => row.target))).toEqual(
    new Set([...JS_EXACT_CANDIDATE_CONSUMER_TARGETS, "ios-xcframework"]),
  );

  const missingIcuProvider = structuredClone(plan);
  missingIcuProvider.liboliphaunt_native_desktop_runtime_matrix.include =
    missingIcuProvider.liboliphaunt_native_desktop_runtime_matrix.include
      .filter((row) => row.target !== "macos-arm64");
  expect(() => assertJsExactCandidatePlanClosure(missingIcuProvider)).toThrow(/portable ICU producer/u);

  const missingBroker = structuredClone(plan);
  missingBroker.broker_runtime_matrix.include = missingBroker.broker_runtime_matrix.include.slice(1);
  expect(() => assertJsExactCandidatePlanClosure(missingBroker)).toThrow(/same-run broker producer/u);

  const missingIosExtension = structuredClone(plan);
  missingIosExtension.extension_artifacts_native_matrix.include =
    missingIosExtension.extension_artifacts_native_matrix.include
      .filter((row) => row.target !== "ios-xcframework");
  expect(() => assertJsExactCandidatePlanClosure(missingIosExtension)).toThrow(
    /iOS extension carrier producer/u,
  );
});

test("rejects package-lock substitution, drift, links, and missing real installs", () => {
  const root = mkdtempSync(path.join(ROOT, "target/js-exact-lock-test-"));
  scratch.push(root);
  const expectedPackages = {
    "@oliphaunt/ts": "1.2.3",
    "@oliphaunt/extension-vector-linux-x64-gnu": "4.5.6",
  };
  for (const [name, version] of Object.entries(expectedPackages)) {
    const directory = path.join(root, "node_modules", ...name.split("/"));
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, "package.json"), `${JSON.stringify({ name, version })}\n`);
  }
  const registryUrl = "http://127.0.0.1:4875";
  const lock = {
    lockfileVersion: 3,
    packages: {
      "": {},
      ...Object.fromEntries(Object.entries(expectedPackages).map(([name, version]) => [
        `node_modules/${name}`,
        {
          version,
          resolved: `${registryUrl}/${encodeURIComponent(name)}/-/${name.split("/").at(-1)}-${version}.tgz`,
          integrity: "sha512-candidate",
        },
      ])),
      "node_modules/@oliphaunt/extension-vector-windows-x64-msvc": { optional: true },
    },
  };
  expect(() => assertExactInstalledPackages({ lock, consumerRoot: root, registryUrl, expectedPackages })).not.toThrow();

  const publicRegistry = structuredClone(lock);
  publicRegistry.packages["node_modules/@oliphaunt/ts"].resolved = "https://registry.npmjs.org/@oliphaunt/ts/-/ts-1.2.3.tgz";
  expect(() => assertExactInstalledPackages({ lock: publicRegistry, consumerRoot: root, registryUrl, expectedPackages })).toThrow(
    "isolated same-run registry",
  );
  const drifted = structuredClone(lock);
  drifted.packages["node_modules/@oliphaunt/ts"].version = "9.9.9";
  expect(() => assertExactInstalledPackages({ lock: drifted, consumerRoot: root, registryUrl, expectedPackages })).toThrow(
    "identity/version",
  );
  const linked = structuredClone(lock);
  linked.packages["node_modules/@oliphaunt/ts"].link = true;
  expect(() => assertExactInstalledPackages({ lock: linked, consumerRoot: root, registryUrl, expectedPackages })).toThrow(
    "workspace, file path, or public registry",
  );
  const missing = structuredClone(lock);
  delete missing.packages["node_modules/@oliphaunt/ts"];
  expect(() => assertExactInstalledPackages({ lock: missing, consumerRoot: root, registryUrl, expectedPackages })).toThrow(
    "package set must be exact",
  );
});
