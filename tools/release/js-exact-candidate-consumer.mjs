#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { captureCommandBytes, captureCommandOutput } from "../dev/capture-command-output.mjs";
import {
  JS_EXACT_CANDIDATE_CONSUMER_TARGETS,
  jsExactCandidateConsumerMatrix,
} from "./artifact_target_matrix.mjs";
import { buildIosCarrierManifest } from "./ios-carrier-manifest.mjs";
import {
  extensionNpmPackageForProduct,
  extensionNpmTargetPackageForProduct,
} from "./extension-registry-packages.mjs";
import {
  allArtifactTargets,
  compareText,
  currentProductVersionSync,
  exactExtensionProducts,
  extensionMetadata,
  extensionRegistryPackageTargetSets,
  extensionSqlNames,
} from "./release-artifact-targets.mjs";
import {
  NATIVE_EXTENSION_ASSET_INDEX_HEADER,
  isCanonicalNativeExtensionRuntimeIndexRow,
} from "./native-extension-asset-index-contract.mjs";
import { localWindowsTarInvocation } from "./tar-command.mjs";
import { validateExtensionArtifactArchive } from "./extension-artifact-inventory.mjs";
import {
  assertReleaseNoticesInArchive,
  releaseNoticeRows,
} from "./release-notices.mjs";
import {
  assertExtensionUpstreamLicensesInArchive,
  extensionCarrierLegalContract,
} from "./extension-upstream-licenses.mjs";

const TOOL = "js-exact-candidate-consumer.mjs";
export const WINDOWS_STANDARD_USER_MODULE_LOAD_PROOF =
  "OLIPHAUNT_WINDOWS_STANDARD_USER_CONSUMER_MODULE_OK";
export const WINDOWS_STANDARD_USER_CONTROL_READ_FILES = Object.freeze([
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
]);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const RUNTIME_FIXTURE = path.join(ROOT, "tools/release/fixtures/js-exact-candidate-runtime.mjs");
const PROCSIGNAL_FIXTURE = path.join(
  ROOT,
  "tools/release/fixtures/js-exact-candidate-procsignal.mjs",
);
const DENO_RUNTIME_PREPARATION_FIXTURE = path.join(
  ROOT,
  "tools/release/fixtures/js-exact-candidate-prepare-deno-runtime.mjs",
);
const JSR_FIXTURE = path.join(ROOT, "tools/release/fixtures/js-exact-candidate-jsr.mjs");
const EXTENSION_BUILDER = path.join(ROOT, "tools/release/build-extension-ci-artifacts.mjs");
const COMMAND_WATCHDOG = path.join(ROOT, "tools/release/exact-candidate-command-watchdog.mjs");
const GENERATED_EXTENSION_SDK = path.join(ROOT, "src/extensions/generated/sdk/js.json");
const GENERATED_EXTENSION_CATALOG = path.join(ROOT, "src/extensions/generated/extensions.catalog.json");
const GENERATED_MOBILE_STATIC_EXTENSIONS = path.join(
  ROOT,
  "src/extensions/generated/mobile/static-extensions.tsv",
);
const OVERRIDE_ENV = [
  "LIBOLIPHAUNT_PATH",
  "OLIPHAUNT_BROKER",
  "OLIPHAUNT_EMBEDDED_MODULE_DIR",
  "OLIPHAUNT_ICU_DATA_DIR",
  "OLIPHAUNT_INSTALL_DIR",
  "OLIPHAUNT_NODE_ADDON",
  "OLIPHAUNT_POSTGRES",
  "OLIPHAUNT_POSTGRES_TOOL_DIR",
  "OLIPHAUNT_RUNTIME_DIR",
];
const WINDOWS_CMD_META_CHARACTERS = /[ ^&()<>|"]/gu;
const WINDOWS_CMD_EXPANSION_CHARACTERS = /[%!]/u;
const MAX_CAPTURE_BYTES = 32 * 1024 * 1024;
const RUNTIME_CASE_TIMEOUT_MS = 7 * 60_000;
const JSR_CASE_TIMEOUT_MS = 7 * 60_000;
const CONSUMER_TOTAL_BUDGET_MS = 60 * 60_000;
const CONSUMER_EVIDENCE_RESERVE_MS = 5 * 60_000;
const FAILED_DIAGNOSTIC_MAX_FILES = 16;
const FAILED_DIAGNOSTIC_MAX_FILE_BYTES = 256 * 1024;
const FAILED_DIAGNOSTIC_MAX_TOTAL_BYTES = 1024 * 1024;
const FAILED_DIAGNOSTIC_MAX_WALK_ENTRIES = 4096;
const PROCESS_TREE_POLL_MS = 25;
const PROCESS_TREE_TERM_GRACE_MS = 750;
const PROCESS_TREE_KILL_GRACE_MS = 2_000;
const COMMAND_WATCHDOG_EMERGENCY_RESERVE_MS = 20_000;
const COMMAND_WATCHDOG_CAPTURE_BYTES = 4 * 1024 * 1024;

export function windowsStandardUserControlReadSetSha256() {
  const serialized = WINDOWS_STANDARD_USER_CONTROL_READ_FILES.map((relative) => {
    const file = path.join(ROOT, ...relative.split("/"));
    const digest = createHash("sha256").update(readFileSync(file)).digest("hex");
    return `${relative}\0${digest}\n`;
  }).join("");
  return createHash("sha256").update(serialized, "utf8").digest("hex");
}

let activeConsumerDeadline;

export class ExactCandidateCommandTimeoutError extends Error {
  constructor(
    command,
    timeoutMs,
    { deadlineLimited = false, processTree, watchdogCleanupError } = {},
  ) {
    super(`${command} timed out after ${timeoutMs}ms`);
    this.name = "ExactCandidateCommandTimeoutError";
    this.code = "OLIPHAUNT_EXACT_CANDIDATE_COMMAND_TIMEOUT";
    this.command = command;
    this.deadlineLimited = deadlineLimited;
    this.phaseStarted = true;
    this.processTree = processTree;
    this.processTreeTerminated = processTree?.terminated === true;
    this.timedOut = true;
    this.timeoutMs = timeoutMs;
    if (watchdogCleanupError !== undefined) this.watchdogCleanupError = watchdogCleanupError;
  }
}

export class ExactCandidateDeadlineError extends Error {
  constructor(label, remainingMs, reserveMs) {
    super(
      `${label} was not started because the exact-candidate evidence reserve was reached `
        + `(remaining=${Math.max(0, remainingMs)}ms reserve=${reserveMs}ms)`,
    );
    this.name = "ExactCandidateDeadlineError";
    this.code = "OLIPHAUNT_EXACT_CANDIDATE_DEADLINE";
    this.deadlineExceeded = true;
    this.label = label;
    this.phaseStarted = false;
    this.remainingMs = Math.max(0, remainingMs);
    this.reserveMs = reserveMs;
  }
}

export class ExactCandidateCommandWatchdogError extends Error {
  constructor(
    command,
    message,
    { code, processTree, unsafeContinuation, watchdogCleanupError } = {},
  ) {
    super(`${command} command supervision failed: ${message}`);
    this.name = "ExactCandidateCommandWatchdogError";
    this.code = code ?? "OLIPHAUNT_EXACT_CANDIDATE_COMMAND_WATCHDOG";
    this.command = command;
    this.phaseStarted = true;
    this.processTree = processTree;
    this.processTreeTerminated = processTree?.terminated === true;
    this.unsafeContinuation = unsafeContinuation ?? processTree?.terminated !== true;
    if (watchdogCleanupError !== undefined) this.watchdogCleanupError = watchdogCleanupError;
  }
}

export function createExactCandidateConsumerDeadline({
  startedAtMs = Date.now(),
  totalBudgetMs = CONSUMER_TOTAL_BUDGET_MS,
  reserveMs = CONSUMER_EVIDENCE_RESERVE_MS,
  now = () => Date.now(),
} = {}) {
  if (!Number.isSafeInteger(startedAtMs) || startedAtMs < 0) {
    throw error("consumer deadline startedAtMs must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(totalBudgetMs) || totalBudgetMs <= 0) {
    throw error("consumer deadline totalBudgetMs must be a positive safe integer");
  }
  if (!Number.isSafeInteger(reserveMs) || reserveMs <= 0 || reserveMs >= totalBudgetMs) {
    throw error("consumer deadline reserveMs must be positive and smaller than totalBudgetMs");
  }
  if (typeof now !== "function") throw error("consumer deadline clock must be a function");
  const hardDeadlineMs = startedAtMs + totalBudgetMs;
  const admissionDeadlineMs = hardDeadlineMs - reserveMs;
  return {
    admissionDeadlineMs,
    hardDeadlineMs,
    reserveMs,
    timeout(requestedMs, label) {
      if (!Number.isSafeInteger(requestedMs) || requestedMs <= 0) {
        throw error(`${label} timeout must be a positive safe integer`);
      }
      const current = now();
      const remainingMs = admissionDeadlineMs - current;
      if (remainingMs <= 0) {
        throw new ExactCandidateDeadlineError(label, hardDeadlineMs - current, reserveMs);
      }
      return {
        deadlineLimited: remainingMs < requestedMs,
        timeoutMs: Math.max(1, Math.min(requestedMs, remainingMs)),
      };
    },
  };
}

function error(message) {
  return new Error(`${TOOL}: ${message}`);
}

function requiredValue(value, label) {
  if (typeof value !== "string" || value.length === 0) throw error(`${label} is required`);
  return value;
}

function normalizedJson(value) {
  if (Array.isArray(value)) return value.map(normalizedJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => compareText(left, right))
        .map(([key, entry]) => [key, normalizedJson(entry)]),
    );
  }
  return value;
}

function sameJson(left, right) {
  return JSON.stringify(normalizedJson(left)) === JSON.stringify(normalizedJson(right));
}

export function parseExactCandidateConsumerArgs(argv) {
  const options = {
    artifactRoots: [],
    iosExtensionArtifactRoot: undefined,
    outputRoot: undefined,
    candidateSha: undefined,
    target: undefined,
    port: 4875,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    const read = (label) => {
      if (index + 1 >= argv.length) throw error(`${label} requires a value`);
      index += 1;
      return argv[index];
    };
    if (value === "--artifact-root") options.artifactRoots.push(read(value));
    else if (value.startsWith("--artifact-root=")) options.artifactRoots.push(value.slice("--artifact-root=".length));
    else if (value === "--ios-extension-artifact-root") options.iosExtensionArtifactRoot = read(value);
    else if (value.startsWith("--ios-extension-artifact-root=")) {
      options.iosExtensionArtifactRoot = value.slice("--ios-extension-artifact-root=".length);
    } else if (value === "--output-root") options.outputRoot = read(value);
    else if (value.startsWith("--output-root=")) options.outputRoot = value.slice("--output-root=".length);
    else if (value === "--candidate-sha") options.candidateSha = read(value);
    else if (value.startsWith("--candidate-sha=")) options.candidateSha = value.slice("--candidate-sha=".length);
    else if (value === "--target") options.target = read(value);
    else if (value.startsWith("--target=")) options.target = value.slice("--target=".length);
    else if (value === "--verdaccio-port") options.port = Number.parseInt(read(value), 10);
    else if (value.startsWith("--verdaccio-port=")) options.port = Number.parseInt(value.slice("--verdaccio-port=".length), 10);
    else throw error(`unknown argument ${value}`);
  }
  requiredValue(options.outputRoot, "--output-root");
  requiredValue(options.candidateSha, "--candidate-sha");
  requiredValue(options.target, "--target");
  requiredValue(options.iosExtensionArtifactRoot, "--ios-extension-artifact-root");
  if (!/^[0-9a-f]{40}$/u.test(options.candidateSha)) throw error("--candidate-sha must be a full lowercase Git commit SHA");
  if (options.artifactRoots.length !== 6) {
    throw error(`exactly six --artifact-root values are required, got ${options.artifactRoots.length}`);
  }
  if (!Number.isInteger(options.port) || options.port < 1024 || options.port > 65535) {
    throw error("--verdaccio-port must be an integer from 1024 through 65535");
  }
  const roots = options.artifactRoots.map((root) => path.resolve(ROOT, root));
  const iosExtensionArtifactRoot = path.resolve(ROOT, options.iosExtensionArtifactRoot);
  const immutableRoots = [...roots, iosExtensionArtifactRoot];
  if (new Set(immutableRoots).size !== immutableRoots.length) {
    throw error("immutable artifact roots must be unique");
  }
  const outputRoot = path.resolve(ROOT, options.outputRoot);
  const targetRoot = path.join(ROOT, "target");
  if (!pathInside(targetRoot, outputRoot)) {
    throw error("--output-root must be a strict descendant of the repository target directory");
  }
  for (const root of immutableRoots) {
    if (!existsSync(root)) throw error(`artifact root does not exist: ${root}`);
    if (!pathInside(ROOT, root)) throw error(`artifact roots must be strict repository descendants: ${root}`);
    if (!statSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) {
      throw error(`artifact root must be a real directory: ${root}`);
    }
    const relative = path.relative(root, outputRoot);
    if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
      throw error("--output-root must not be inside an immutable artifact root");
    }
  }
  for (let left = 0; left < immutableRoots.length; left += 1) {
    for (let right = left + 1; right < immutableRoots.length; right += 1) {
      if (
        pathInside(immutableRoots[left], immutableRoots[right])
        || pathInside(immutableRoots[right], immutableRoots[left])
      ) {
        throw error("immutable artifact roots must not overlap");
      }
    }
  }
  return { ...options, artifactRoots: roots, iosExtensionArtifactRoot, outputRoot };
}

function pathInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function escapeWindowsCmdArgument(value, { doubleEscape = false } = {}) {
  const input = String(value);
  let escaped = input;
  if (input.length === 0) {
    escaped = '""';
  } else if (/[ \t\n\v"]/u.test(input)) {
    escaped = '"';
    for (let index = 0; index <= input.length; index += 1) {
      let slashCount = 0;
      while (input[index] === "\\") {
        index += 1;
        slashCount += 1;
      }
      if (index === input.length) {
        escaped += "\\".repeat(slashCount * 2);
        break;
      }
      if (input[index] === '"') {
        escaped += "\\".repeat(slashCount * 2 + 1);
      } else {
        escaped += "\\".repeat(slashCount);
      }
      escaped += input[index];
    }
    escaped += '"';
  }

  // npm.cmd and pnpm.cmd are parsed once by cmd.exe and again by the batch
  // shim. Escape shell metacharacters for both passes so argument bytes cannot
  // become shell syntax between the JavaScript consumer and the package tool.
  escaped = escaped.replace(WINDOWS_CMD_META_CHARACTERS, "^$&");
  if (doubleEscape) escaped = escaped.replace(WINDOWS_CMD_META_CHARACTERS, "^$&");
  return escaped;
}

export function exactCandidateCommandInvocation(
  command,
  args,
  {
    platform = process.platform,
    comspec = process.env.ComSpec ?? process.env.COMSPEC ?? process.env.comspec ?? "cmd.exe",
    cwd = ROOT,
  } = {},
) {
  if (platform === "win32" && command === "tar") {
    const invocation = localWindowsTarInvocation(args, { cwd, platform });
    return {
      command,
      args: invocation.args,
      cwd: invocation.cwd,
      windowsVerbatimArguments: false,
    };
  }
  if (platform !== "win32" || !["npm", "pnpm"].includes(command)) {
    return { command, args: [...args], windowsVerbatimArguments: false };
  }
  const unsafeArgumentIndex = args.findIndex((argument) =>
    WINDOWS_CMD_EXPANSION_CHARACTERS.test(String(argument)));
  if (unsafeArgumentIndex !== -1) {
    throw error(
      `${command}.cmd argument ${unsafeArgumentIndex + 1} contains '%' or '!', which cannot be transported safely through cmd.exe and a batch shim`,
    );
  }
  const shim = `${command}.cmd`;
  const shellCommand = [
    shim,
    ...args.map((argument) => escapeWindowsCmdArgument(argument, { doubleEscape: true })),
  ].join(" ");
  return {
    command: comspec,
    args: ["/d", "/s", "/c", shellCommand],
    windowsVerbatimArguments: true,
  };
}

function boundedCommandTimeout(timeout, label) {
  if (activeConsumerDeadline === undefined) {
    return { deadlineLimited: false, timeoutMs: timeout };
  }
  return activeConsumerDeadline.timeout(timeout, label);
}

export function exactCandidateCommandWatchdogEmergencyTimeout(timeoutMs) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw error("command watchdog timeout must be a positive safe integer");
  }
  return timeoutMs + COMMAND_WATCHDOG_EMERGENCY_RESERVE_MS;
}

export function parseExactCandidateCommandWatchdogProtocol(value) {
  const text = Buffer.isBuffer(value) ? value.toString("utf8") : String(value ?? "");
  const lines = text.split(/\r?\n/u).filter(Boolean);
  if (lines.length !== 1) throw error("command watchdog must write exactly one terminal record");
  let terminal;
  try {
    terminal = JSON.parse(lines[0]);
  } catch (cause) {
    throw error(`command watchdog terminal record is not JSON: ${cause.message}`);
  }
  if (
    terminal?.schemaVersion !== 1
    || !["exited", "output-limit", "spawn-failed", "supervisor-failed", "timed-out"]
      .includes(terminal.state)
  ) {
    throw error("command watchdog terminal record has an invalid schema or state");
  }
  if (
    terminal.state !== "spawn-failed"
    && (!Number.isInteger(terminal.pid) || terminal.pid <= 0)
  ) {
    throw error("command watchdog terminal record has an invalid PID");
  }
  if (
    terminal.state === "exited"
    && !(
      (Number.isInteger(terminal.status) && terminal.signal === null)
      || (terminal.status === null && typeof terminal.signal === "string" && terminal.signal.length > 0)
    )
  ) {
    throw error("command watchdog exited record has an invalid status/signal pair");
  }
  return terminal;
}

function failedWatchdogProcessTree(pid, priorCause) {
  try {
    return terminateExactCandidateProcessTree(pid);
  } catch (cause) {
    return {
      pid,
      platform: process.platform,
      strategy: process.platform === "win32" ? "taskkill-tree" : "posix-process-group",
      terminated: false,
      error: exactCandidateErrorEvidence(aggregateExactCandidateErrors(
        "command watchdog protocol and emergency teardown failed",
        [priorCause, cause],
      )),
    };
  }
}

export function exactCandidateCommandWatchdogFailureResult(
  result,
  pid,
  message,
  priorCause,
  existingProcessTree,
  { allowContinuation = false } = {},
) {
  const processTree = existingProcessTree?.terminated === true
    ? existingProcessTree
    : failedWatchdogProcessTree(pid, priorCause);
  const failure = new Error(message);
  failure.code = "OLIPHAUNT_EXACT_CANDIDATE_COMMAND_WATCHDOG";
  return {
    ...result,
    error: failure,
    pid,
    processTree,
    supervisorFailed: true,
    unsafeContinuation: !allowContinuation || processTree?.terminated !== true,
  };
}

function spawnSyncUnderExactCandidateWatchdog(
  command,
  args,
  {
    cwd,
    encoding,
    env,
    maxBuffer,
    stdio,
    timeout,
    windowsVerbatimArguments,
  },
) {
  const mode = stdio === "inherit"
    ? "inherit"
    : Array.isArray(stdio) && stdio[1] === "pipe"
      ? "capture"
      : "file";
  const request = `${JSON.stringify({
    args,
    captureLimitBytes: COMMAND_WATCHDOG_CAPTURE_BYTES,
    command,
    cwd,
    stdio: mode,
    timeoutMs: timeout,
    windowsVerbatimArguments,
  })}\n`;
  const protocolRoot = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-command-watchdog-"));
  const resultPath = path.join(protocolRoot, "result.json");
  const pidPath = path.join(protocolRoot, "pid");
  let result;
  let terminal;
  let pid;
  let protocolCause;
  try {
    const supervisorArgs = [COMMAND_WATCHDOG, resultPath, pidPath];
    const supervisorTimeout = exactCandidateCommandWatchdogEmergencyTimeout(timeout);
    if (mode === "inherit") {
      result = spawnSync("node", supervisorArgs, {
        cwd,
        encoding,
        env,
        input: request,
        maxBuffer,
        stdio: ["pipe", "inherit", "inherit"],
        timeout: supervisorTimeout,
        windowsVerbatimArguments: false,
      });
    } else {
      const capture = encoding === null ? captureCommandBytes : captureCommandOutput;
      result = capture("node", supervisorArgs, {
        cwd,
        env,
        input: request,
        label: `${command} exact-candidate command watchdog`,
        maxOutputBytes: maxBuffer,
        ...(mode === "file" ? { stdoutDescriptor: stdio[1] } : {}),
        timeout: supervisorTimeout,
        windowsHide: false,
      });
    }
    if (existsSync(pidPath)) {
      pid = Number.parseInt(readFileSync(pidPath, "utf8").trim(), 10);
      if (!Number.isInteger(pid) || pid <= 0) throw error("command watchdog PID file is invalid");
    }
    if (existsSync(resultPath)) {
      terminal = parseExactCandidateCommandWatchdogProtocol(readFileSync(resultPath));
      if (terminal.pid !== undefined && pid !== undefined && terminal.pid !== pid) {
        throw error("command watchdog PID file and terminal record disagree");
      }
      pid = terminal.pid ?? pid;
    }
  } catch (cause) {
    protocolCause = cause;
    if (pid === undefined && existsSync(pidPath)) {
      try {
        const recovered = Number.parseInt(readFileSync(pidPath, "utf8").trim(), 10);
        if (Number.isInteger(recovered) && recovered > 0) pid = recovered;
      } catch {
        // The failure result below records that no trustworthy PID existed.
      }
    }
  }

  let settledResult;
  if (protocolCause !== undefined || terminal === undefined) {
    settledResult = exactCandidateCommandWatchdogFailureResult(
      result,
      pid,
      `${command} command watchdog produced no valid terminal record`,
      protocolCause ?? result.error ?? new Error("missing terminal record"),
    );
  } else if (terminal.state === "spawn-failed") {
    const spawnError = new Error(terminal.error?.message ?? `${command} failed to start`);
    spawnError.code = terminal.error?.code;
    settledResult = { ...result, error: spawnError };
  } else if (terminal.state === "exited") {
    if (result.error !== undefined) {
      settledResult = exactCandidateCommandWatchdogFailureResult(
        result,
        pid,
        `${command} command watchdog transport failed after the child exited`,
        result.error,
        {
          pid,
          platform: process.platform,
          strategy: "source-process-exited",
          terminated: true,
        },
      );
    } else {
      settledResult = {
        ...result,
        error: undefined,
        pid,
        signal: terminal.signal,
        status: terminal.status,
      };
    }
  } else {
    let processTree = terminal.processTree;
    if (processTree?.terminated !== true) {
      processTree = failedWatchdogProcessTree(pid, processTree?.error);
    }
    if (terminal.state === "timed-out") {
      const timeoutError = new Error(`${command} ETIMEDOUT`);
      timeoutError.code = "ETIMEDOUT";
      settledResult = {
        ...result,
        error: timeoutError,
        pid,
        processTree,
        signal: null,
        status: null,
      };
    } else {
      settledResult = exactCandidateCommandWatchdogFailureResult(
        result,
        pid,
        terminal.error?.message ?? `${command} command watchdog failed`,
        terminal.error,
        processTree,
        {
          allowContinuation: terminal.state === "output-limit"
            && processTree?.terminated === true,
        },
      );
    }
  }

  try {
    rmSync(protocolRoot, { recursive: true, force: true });
  } catch (cause) {
    const cleanupEvidence = exactCandidateErrorEvidence(cause);
    if (settledResult.error !== undefined) {
      settledResult.supervisorFailed = true;
      settledResult.unsafeContinuation = true;
      settledResult.watchdogCleanupError = cleanupEvidence;
    } else {
      settledResult = exactCandidateCommandWatchdogFailureResult(
        settledResult,
        pid,
        `${command} command watchdog protocol cleanup failed`,
        cause,
        {
          pid,
          platform: process.platform,
          strategy: "source-process-exited",
          terminated: true,
        },
      );
    }
  }
  return settledResult;
}

function posixProcessGroupExists(pid, killProcess = process.kill) {
  try {
    killProcess(-pid, 0);
    return true;
  } catch (cause) {
    if (cause?.code === "ESRCH") return false;
    if (cause?.code === "EPERM") return true;
    throw cause;
  }
}

function waitForProcessTreeExit(exists, graceMs) {
  const attempts = Math.ceil(graceMs / PROCESS_TREE_POLL_MS);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (!exists()) return true;
    Atomics.wait(
      new Int32Array(new SharedArrayBuffer(4)),
      0,
      0,
      PROCESS_TREE_POLL_MS,
    );
  }
  return !exists();
}

export function exactCandidateWindowsProcessTreeKillArgs(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw error("Windows process-tree PID must be a positive integer");
  }
  return ["/pid", String(pid), "/t", "/f"];
}

export function terminateExactCandidateProcessTree(
  pid,
  {
    platform = process.platform,
    killProcess = process.kill,
    processExistsImpl = processExists,
    processGroupExistsImpl = (candidate) => posixProcessGroupExists(candidate, killProcess),
    taskkill = undefined,
  } = {},
) {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw error("timed-out command did not expose a valid process-tree PID");
  }
  if (platform === "win32") {
    const result = taskkill === undefined
      ? captureCommandOutput("taskkill.exe", exactCandidateWindowsProcessTreeKillArgs(pid), {
          label: `taskkill.exe process tree ${pid}`,
          maxOutputBytes: 4 * 1024 * 1024,
          timeout: 30_000,
        })
      : taskkill(pid);
    const stillRunning = processExistsImpl(pid);
    if (result?.error !== undefined || result?.status !== 0 || stillRunning) {
      const detail = (result?.stderr || result?.stdout || result?.error?.message || "").trim();
      throw error(
        `failed to verify termination of timed-out Windows process tree ${pid}`
          + `${detail ? `: ${detail}` : ""}`,
      );
    }
    return {
      pid,
      platform,
      strategy: "taskkill-tree",
      terminated: true,
    };
  }

  const exists = () => processGroupExistsImpl(pid);
  if (!exists() && processExistsImpl(pid)) {
    throw error(`live POSIX process ${pid} does not own the promised process group`);
  }
  let termSent = false;
  let killSent = false;
  if (exists()) {
    try {
      killProcess(-pid, "SIGTERM");
      termSent = true;
    } catch (cause) {
      if (cause?.code !== "ESRCH") throw cause;
    }
  }
  if (!waitForProcessTreeExit(exists, PROCESS_TREE_TERM_GRACE_MS)) {
    try {
      killProcess(-pid, "SIGKILL");
      killSent = true;
    } catch (cause) {
      if (cause?.code !== "ESRCH") throw cause;
    }
  }
  if (!waitForProcessTreeExit(exists, PROCESS_TREE_KILL_GRACE_MS) || processExistsImpl(pid)) {
    throw error(`timed-out POSIX process group ${pid} survived SIGTERM and SIGKILL`);
  }
  return {
    pid,
    platform,
    strategy: "posix-process-group",
    termSent,
    killSent,
    terminated: true,
  };
}

export function removeExactCandidateRunRoot(runRoot, result, remove = rmSync) {
  if (
    (result?.error?.timedOut === true || result?.error?.unsafeContinuation === true)
    && result.error.processTreeTerminated !== true
  ) {
    throw error(
      `${result.id ?? "exact-candidate"} run root was retained because child-tree termination was not proven`,
    );
  }
  remove(runRoot, { recursive: true, force: true });
}

function commandSpawnError(command, result, timeout) {
  if (result?.error?.code === "ETIMEDOUT") {
    let processTree = result.processTree;
    if (processTree === undefined) {
      try {
        processTree = terminateExactCandidateProcessTree(result.pid);
      } catch (cause) {
        processTree = {
          pid: result?.pid,
          platform: process.platform,
          strategy: process.platform === "win32" ? "taskkill-tree" : "posix-process-group",
          terminated: false,
          error: exactCandidateErrorEvidence(cause),
        };
      }
    }
    return new ExactCandidateCommandTimeoutError(
      command,
      timeout.timeoutMs,
      { ...timeout, processTree, watchdogCleanupError: result.watchdogCleanupError },
    );
  }
  if (result.supervisorFailed === true) {
    return new ExactCandidateCommandWatchdogError(
      command,
      result?.error?.message ?? "unknown supervisor error",
      {
        code: result?.error?.code,
        processTree: result.processTree,
        unsafeContinuation: result.unsafeContinuation,
        watchdogCleanupError: result.watchdogCleanupError,
      },
    );
  }
  const failure = error(
    `${command} failed to start: ${result?.error?.message ?? "unknown spawn error"}`,
  );
  if (typeof result?.error?.code === "string") failure.code = result.error.code;
  if (result.processTree !== undefined) {
    failure.phaseStarted = true;
    failure.processTree = result.processTree;
    failure.processTreeTerminated = result.processTree.terminated === true;
    failure.unsafeContinuation = result.processTree.terminated !== true;
  }
  if (result.watchdogCleanupError !== undefined) {
    failure.watchdogCleanupError = result.watchdogCleanupError;
  }
  return failure;
}

function run(command, args, { cwd = ROOT, env = process.env, capture = false, timeout = 10 * 60_000 } = {}) {
  const invocation = exactCandidateCommandInvocation(command, args, { cwd });
  const boundedTimeout = boundedCommandTimeout(timeout, command);
  const result = spawnSyncUnderExactCandidateWatchdog(invocation.command, invocation.args, {
    cwd: invocation.cwd ?? cwd,
    env,
    encoding: "utf8",
    maxBuffer: MAX_CAPTURE_BYTES,
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    timeout: boundedTimeout.timeoutMs,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });
  if (result.error) throw commandSpawnError(command, result, boundedTimeout);
  if (result.status !== 0) {
    const detail = capture ? (result.stderr || result.stdout || "").trim() : "";
    const termination = result.signal === null
      ? `status ${result.status}`
      : `signal ${result.signal}${result.status === null ? "" : ` (status ${result.status})`}`;
    throw error(`${command} exited with ${termination}${detail ? `: ${detail}` : ""}`);
  }
  return capture ? result.stdout.trim() : "";
}

export function runExactCandidateCommandWithTimeout(
  command,
  args,
  { cwd = ROOT, env = process.env, timeout = 10 * 60_000 } = {},
) {
  return run(command, args, { capture: true, cwd, env, timeout });
}

function runBytes(command, args, { cwd = ROOT, env = process.env, timeout = 10 * 60_000 } = {}) {
  const invocation = exactCandidateCommandInvocation(command, args, { cwd });
  const boundedTimeout = boundedCommandTimeout(timeout, command);
  const result = spawnSyncUnderExactCandidateWatchdog(invocation.command, invocation.args, {
    cwd: invocation.cwd ?? cwd,
    env,
    encoding: null,
    maxBuffer: MAX_CAPTURE_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: boundedTimeout.timeoutMs,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });
  if (result.error) throw commandSpawnError(command, result, boundedTimeout);
  if (result.status !== 0) {
    const detail = Buffer.concat([result.stderr ?? Buffer.alloc(0), result.stdout ?? Buffer.alloc(0)])
      .toString("utf8")
      .trim();
    const termination = result.signal === null
      ? `status ${result.status}`
      : `signal ${result.signal}${result.status === null ? "" : ` (status ${result.status})`}`;
    throw error(`${command} exited with ${termination}${detail ? `: ${detail}` : ""}`);
  }
  return result.stdout;
}

function retainCleanupError(primary, cleanup) {
  if (primary !== null && typeof primary === "object") {
    primary.cleanupErrors = [
      ...(Array.isArray(primary.cleanupErrors) ? primary.cleanupErrors : []),
      exactCandidateErrorEvidence(cleanup),
    ];
  }
  return primary;
}

function runToFile(command, args, destination, { cwd = ROOT, env = process.env, timeout = 10 * 60_000 } = {}) {
  const invocation = exactCandidateCommandInvocation(command, args, { cwd });
  const boundedTimeout = boundedCommandTimeout(timeout, command);
  mkdirSync(path.dirname(destination), { recursive: true });
  let descriptor;
  let result;
  let invocationCause;
  let ownsDestination = false;
  try {
    descriptor = openSync(destination, "wx", 0o600);
    ownsDestination = true;
    result = spawnSyncUnderExactCandidateWatchdog(invocation.command, invocation.args, {
      cwd: invocation.cwd ?? cwd,
      env,
      encoding: null,
      maxBuffer: MAX_CAPTURE_BYTES,
      stdio: ["ignore", descriptor, "pipe"],
      timeout: boundedTimeout.timeoutMs,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });
  } catch (cause) {
    invocationCause = cause;
  }
  if (descriptor !== undefined) {
    try {
      closeSync(descriptor);
    } catch (cause) {
      invocationCause = invocationCause === undefined
        ? cause
        : retainCleanupError(invocationCause, cause);
    }
  }
  if (invocationCause !== undefined) {
    if (ownsDestination) {
      try {
        rmSync(destination, { force: true });
      } catch (cause) {
        retainCleanupError(invocationCause, cause);
      }
    }
    throw invocationCause;
  }
  if (result?.error) {
    const primary = commandSpawnError(command, result, boundedTimeout);
    try {
      rmSync(destination, { force: true });
    } catch (cause) {
      retainCleanupError(primary, cause);
    }
    throw primary;
  }
  if (result?.status !== 0) {
    const detail = Buffer.from(result?.stderr ?? "").toString("utf8").trim();
    const termination = result?.signal === null
      ? `status ${result?.status}`
      : `signal ${result?.signal}${result?.status === null ? "" : ` (status ${result.status})`}`;
    const primary = error(
      `${command} exited with ${termination}${detail ? `: ${detail}` : ""}`,
    );
    try {
      rmSync(destination, { force: true });
    } catch (cause) {
      retainCleanupError(primary, cause);
    }
    throw primary;
  }
}

export function runExactCandidateCommandToFileWithTimeout(
  command,
  args,
  destination,
  { cwd = ROOT, env = process.env, timeout = 10 * 60_000 } = {},
) {
  return runToFile(command, args, destination, { cwd, env, timeout });
}

function walkFiles(root) {
  const rootStats = lstatSync(root);
  if (rootStats.isSymbolicLink()) {
    throw error(`filesystem traversal root must not be a symbolic link or junction: ${root}`);
  }
  if (!rootStats.isDirectory()) {
    throw error(`filesystem traversal root must be a real directory: ${root}`);
  }
  const files = [];
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((left, right) => compareText(left.name, right.name))) {
      const file = path.join(current, entry.name);
      const stats = lstatSync(file);
      if (stats.isSymbolicLink()) throw error(`candidate artifact inputs must not contain symbolic links: ${file}`);
      if (stats.isDirectory()) visit(file);
      else if (stats.isFile()) files.push(file);
      else throw error(`candidate artifact inputs contain unsupported filesystem entry: ${file}`);
    }
  };
  visit(root);
  return files;
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function immutableInputSnapshotFromFiles(files) {
  const canonicalFiles = files.map((file) => ({
    root: file.root,
    path: file.path,
    bytes: file.bytes,
    sha256: file.sha256,
  }));
  return {
    schema: "oliphaunt-exact-candidate-immutable-inputs-v1",
    fileCount: canonicalFiles.length,
    totalBytes: canonicalFiles.reduce((total, file) => total + file.bytes, 0),
    envelopeSha256: sha256Bytes(JSON.stringify(canonicalFiles)),
    files: canonicalFiles,
  };
}

export function captureExactCandidateImmutableInputs(artifactRoots, iosExtensionArtifactRoot) {
  const immutableRoots = [...artifactRoots, iosExtensionArtifactRoot];
  const files = immutableRoots.flatMap((root, rootIndex) =>
    walkFiles(root).map((file) => ({
      root: rootIndex,
      path: path.relative(root, file).replaceAll(path.sep, "/"),
      bytes: statSync(file).size,
      sha256: sha256(file),
    })),
  );
  return immutableInputSnapshotFromFiles(files);
}

function immutableInputFileKey(file) {
  return `${file.root}\0${file.path}`;
}

function immutableInputSnapshotSummary(snapshot) {
  return {
    fileCount: snapshot.fileCount,
    totalBytes: snapshot.totalBytes,
    envelopeSha256: snapshot.envelopeSha256,
  };
}

function immutableInputObservation(snapshot, observation) {
  return { ...snapshot, observation };
}

function unreadableImmutableInputObservation(observation, cause) {
  return {
    schema: "oliphaunt-exact-candidate-immutable-inputs-v1",
    observation,
    state: "unreadable",
    error: exactCandidateErrorEvidence(cause),
  };
}

export function exactCandidateImmutableInputIntegrity(before, after) {
  const beforeByPath = new Map(before.files.map((file) => [immutableInputFileKey(file), file]));
  const afterByPath = new Map(after.files.map((file) => [immutableInputFileKey(file), file]));
  if (beforeByPath.size !== before.files.length || afterByPath.size !== after.files.length) {
    throw error("immutable input snapshots must not contain duplicate root/path identities");
  }
  const added = after.files.filter((file) => !beforeByPath.has(immutableInputFileKey(file)));
  const removed = before.files.filter((file) => !afterByPath.has(immutableInputFileKey(file)));
  const changed = before.files.flatMap((file) => {
    const observed = afterByPath.get(immutableInputFileKey(file));
    if (
      observed === undefined
      || (observed.bytes === file.bytes && observed.sha256 === file.sha256)
    ) {
      return [];
    }
    return [{
      root: file.root,
      path: file.path,
      before: { bytes: file.bytes, sha256: file.sha256 },
      after: { bytes: observed.bytes, sha256: observed.sha256 },
    }];
  });
  const canonicalOrderChanged = before.files.length === after.files.length
    && before.files.some((file, index) =>
      immutableInputFileKey(file) !== immutableInputFileKey(after.files[index]),
    );
  const unchanged = (
    added.length === 0
    && removed.length === 0
    && changed.length === 0
    && !canonicalOrderChanged
    && before.fileCount === after.fileCount
    && before.totalBytes === after.totalBytes
    && before.envelopeSha256 === after.envelopeSha256
  );
  return {
    schema: "oliphaunt-exact-candidate-immutable-input-integrity-v1",
    state: unchanged ? "passed" : "failed",
    unchanged,
    before: immutableInputSnapshotSummary(before),
    after: immutableInputSnapshotSummary(after),
    delta: {
      added,
      removed,
      changed,
      canonicalOrderChanged,
    },
  };
}

export function assertExactCandidateImmutableInputsUnchanged(before, after) {
  const integrity = exactCandidateImmutableInputIntegrity(before, after);
  if (!integrity.unchanged) {
    const cause = error(
      "immutable candidate inputs changed during exact-candidate consumption: "
      + `added=${integrity.delta.added.length}, `
      + `removed=${integrity.delta.removed.length}, `
      + `changed=${integrity.delta.changed.length}, `
      + `canonicalOrderChanged=${integrity.delta.canonicalOrderChanged}`,
    );
    cause.immutableInputIntegrity = integrity;
    throw cause;
  }
  return integrity;
}

export function persistExactCandidateImmutableInputPostRunProof({
  artifactRoots,
  iosExtensionArtifactRoot,
  beforeSnapshot,
  beforeEvidence,
  afterPath,
  integrityPath,
}) {
  let afterSnapshot;
  let captureCause;
  try {
    afterSnapshot = captureExactCandidateImmutableInputs(
      artifactRoots,
      iosExtensionArtifactRoot,
    );
  } catch (cause) {
    captureCause = cause;
  }

  const afterEvidence = afterSnapshot === undefined
    ? unreadableImmutableInputObservation("after-consumption", captureCause)
    : immutableInputObservation(afterSnapshot, "after-consumption");
  let integrity;
  let comparisonCause;
  if (beforeSnapshot === undefined) {
    integrity = {
      schema: "oliphaunt-exact-candidate-immutable-input-integrity-v1",
      state: "failed",
      unchanged: false,
      reason: "before-input-snapshot-unavailable",
      before: beforeEvidence ?? {
        schema: "oliphaunt-exact-candidate-immutable-inputs-v1",
        observation: "before-consumption",
        state: "missing",
      },
      after: afterSnapshot === undefined
        ? afterEvidence
        : immutableInputSnapshotSummary(afterSnapshot),
    };
    comparisonCause = error(
      "immutable candidate inputs cannot be proven unchanged because the before-consumption snapshot is unavailable",
    );
  } else if (afterSnapshot === undefined) {
    integrity = {
      schema: "oliphaunt-exact-candidate-immutable-input-integrity-v1",
      state: "failed",
      unchanged: false,
      reason: "after-input-snapshot-unreadable",
      before: immutableInputSnapshotSummary(beforeSnapshot),
      after: afterEvidence,
    };
  } else {
    integrity = exactCandidateImmutableInputIntegrity(beforeSnapshot, afterSnapshot);
    try {
      assertExactCandidateImmutableInputsUnchanged(beforeSnapshot, afterSnapshot);
    } catch (cause) {
      comparisonCause = cause;
    }
  }

  const persistenceCauses = [];
  for (const [file, evidence] of [
    [afterPath, afterEvidence],
    [integrityPath, integrity],
  ]) {
    try {
      writeFileSync(file, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    } catch (cause) {
      persistenceCauses.push(cause);
    }
  }
  const proofCause = aggregateExactCandidateErrors(
    "immutable candidate input proof failed",
    [captureCause, comparisonCause, ...persistenceCauses],
  );
  if (proofCause !== undefined) {
    proofCause.immutableInputAfterSnapshot = afterSnapshot;
    proofCause.immutableInputIntegrity = integrity;
    throw proofCause;
  }
  return { afterSnapshot, integrity };
}

function tarballIdentity(file) {
  const text = run("tar", ["-xOzf", file, "package/package.json"], { capture: true });
  const manifest = JSON.parse(text);
  return { name: manifest.name, version: manifest.version };
}

function parseTsv(file) {
  const lines = readFileSync(file, "utf8").split(/\r?\n/u).filter(Boolean);
  const expectedHeader = NATIVE_EXTENSION_ASSET_INDEX_HEADER;
  if (lines.length < 2 || lines[0].split("\t").join("\0") !== expectedHeader.join("\0")) {
    throw error(`${file} does not have the canonical native extension index header`);
  }
  return lines.slice(1).map((line, index) => {
    const fields = line.split("\t");
    if (fields.length !== expectedHeader.length) throw error(`${file} row ${index + 2} is malformed`);
    return Object.fromEntries(expectedHeader.map((name, field) => [name, fields[field]]));
  });
}

function generatedIosDependenciesBySqlName() {
  const lines = readFileSync(GENERATED_MOBILE_STATIC_EXTENSIONS, "utf8")
    .split(/\r?\n/u)
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  const header = lines.shift()?.split("\t") ?? [];
  const sqlNameIndex = header.indexOf("sql-name");
  const dependenciesIndex = header.indexOf("ios-static-dependencies");
  if (sqlNameIndex === -1 || dependenciesIndex === -1) {
    throw error("generated mobile static-extension metadata lacks iOS dependency columns");
  }
  const result = new Map();
  for (const line of lines) {
    const fields = line.split("\t");
    const sqlName = fields[sqlNameIndex];
    const dependencies = (fields[dependenciesIndex] ?? "")
      .split(",")
      .filter(Boolean)
      .sort(compareText);
    if (typeof sqlName !== "string" || sqlName.length === 0 || result.has(sqlName)) {
      throw error("generated mobile static-extension metadata repeats or malforms a SQL name");
    }
    result.set(sqlName, dependencies);
  }
  return result;
}

function validateExtensionCandidateInputs(roots, files, contract) {
  const expectedExtensionCount = contract.extensions.length;
  const indexName = `liboliphaunt-${contract.versions.native}-native-extension-assets.tsv`;
  const legacyIndexName = `liboliphaunt-${contract.versions.native}-extension-assets.tsv`;
  const index = oneFileByBasename(files, indexName, "native extension candidate index");
  const legacyIndex = oneFileByBasename(files, legacyIndexName, "legacy native extension candidate index");
  const extensionRoot = roots.find((root) => pathInside(root, index));
  if (extensionRoot === undefined || !pathInside(extensionRoot, legacyIndex)) {
    throw error("native extension indexes must share one immutable artifact root");
  }
  const rows = parseTsv(index);
  const expectedByName = new Map(contract.extensions.map((extension) => [extension.sqlName, extension]));
  const actualNames = rows.map((row) => row.sql_name).sort(compareText);
  const expectedNames = [...expectedByName.keys()].sort(compareText);
  if (
    rows.length !== expectedExtensionCount
    || new Set(actualNames).size !== rows.length
    || actualNames.join("\0") !== expectedNames.join("\0")
  ) {
    throw error(`native extension index must cover the exact ${expectedExtensionCount}-extension desktop set`);
  }
  const referenced = new Set([index, legacyIndex]);
  const artifacts = [];
  for (const row of rows) {
    const extension = expectedByName.get(row.sql_name);
    if (extension === undefined) throw error(`native extension index contains unknown SQL name ${row.sql_name}`);
    if (
      !isCanonicalNativeExtensionRuntimeIndexRow(row, contract.target)
      || !/^[1-9][0-9]*$/u.test(row.artifact_bytes)
    ) {
      throw error(`native extension index has a noncanonical ${row.sql_name}/${contract.target} carrier row`);
    }
    const archive = path.resolve(path.dirname(index), row.artifact);
    if (!pathInside(extensionRoot, archive) || !existsSync(archive) || !statSync(archive).isFile()) {
      throw error(`native extension index references missing or escaping artifact ${row.artifact}`);
    }
    if (statSync(archive).size !== Number(row.artifact_bytes)) {
      throw error(`native extension artifact byte count drifted for ${row.sql_name}`);
    }
    referenced.add(archive);
    try {
      validateExtensionArtifactArchive({
        file: archive,
        label: path.basename(archive),
        metadata: extension,
        target: contract.target,
        nativeRuntimeVersion: contract.versions.native,
      });
    } catch (validationError) {
      throw error(validationError instanceof Error ? validationError.message : String(validationError));
    }
    artifacts.push({
      product: extension.product,
      sqlName: row.sql_name,
      name: path.basename(archive),
      bytes: statSync(archive).size,
      sha256: sha256(archive),
    });
  }
  const actualExtensionFiles = files.filter((file) => pathInside(extensionRoot, file));
  if (
    actualExtensionFiles.length !== referenced.size
    || actualExtensionFiles.some((file) => !referenced.has(file))
  ) {
    throw error("native extension artifact root contains unindexed files");
  }
  return {
    root: extensionRoot,
    targetDirectory: path.dirname(index),
    index: { name: path.basename(index), bytes: statSync(index).size, sha256: sha256(index) },
    legacyIndex: {
      name: path.basename(legacyIndex),
      bytes: statSync(legacyIndex).size,
      sha256: sha256(legacyIndex),
    },
    artifacts: artifacts.sort((left, right) => compareText(left.sqlName, right.sqlName)),
  };
}

export function validateIosExtensionCandidateInputs(root, contract) {
  const target = "ios-xcframework";
  const files = walkFiles(root);
  const indexName = `liboliphaunt-${contract.versions.native}-native-extension-assets.tsv`;
  const legacyIndexName = `liboliphaunt-${contract.versions.native}-extension-assets.tsv`;
  const index = oneFileByBasename(files, indexName, "iOS native extension candidate index");
  const legacyIndex = oneFileByBasename(files, legacyIndexName, "legacy iOS native extension candidate index");
  const targetDirectory = path.dirname(index);
  if (
    path.dirname(legacyIndex) !== targetDirectory
    || path.relative(root, targetDirectory).replaceAll(path.sep, "/") !== target
  ) {
    throw error(`iOS native extension indexes must share the exact ${target} target directory`);
  }

  const expectedByName = new Map(contract.extensions.map((extension) => [extension.sqlName, extension]));
  const rows = parseTsv(index);
  const referenced = new Set([index, legacyIndex]);
  const seenRoles = new Set();
  const runtimeNames = [];
  const primaryNames = [];
  const artifacts = [];
  const allowedKinds = new Set(["runtime", "ios-xcframework", "ios-dependency-xcframework"]);

  for (const row of rows) {
    const extension = expectedByName.get(row.sql_name);
    if (extension === undefined) {
      throw error(`iOS native extension index contains unknown SQL name ${row.sql_name}`);
    }
    if (
      row.target !== target
      || !allowedKinds.has(row.kind)
      || !/^[1-9][0-9]*$/u.test(row.artifact_bytes)
    ) {
      throw error(`iOS native extension index has a noncanonical ${row.sql_name}/${row.kind} row`);
    }
    if (row.kind === "runtime") {
      if (!isCanonicalNativeExtensionRuntimeIndexRow(row, target)) {
        throw error(`iOS native extension index has a noncanonical runtime row for ${row.sql_name}`);
      }
      runtimeNames.push(row.sql_name);
    } else if (row.kind === "ios-xcframework") {
      if (
        extension.nativeModuleStem === null
        || row.identity !== extension.nativeModuleStem
        || row.registration_artifact === "-"
      ) {
        throw error(`iOS native extension index has a noncanonical primary XCFramework row for ${row.sql_name}`);
      }
      primaryNames.push(row.sql_name);
    } else if (
      row.identity === "-"
      || row.registration_artifact !== "-"
      || extension.nativeModuleStem === null
    ) {
      throw error(`iOS native extension index has a noncanonical dependency XCFramework row for ${row.sql_name}`);
    }

    const role = `${row.sql_name}\0${row.kind}\0${row.identity}`;
    if (seenRoles.has(role)) {
      throw error(`iOS native extension index repeats ${row.sql_name}/${row.kind}/${row.identity}`);
    }
    seenRoles.add(role);

    const archive = path.resolve(targetDirectory, row.artifact);
    if (!pathInside(root, archive) || !existsSync(archive) || !statSync(archive).isFile()) {
      throw error(`iOS native extension index references missing or escaping artifact ${row.artifact}`);
    }
    if (statSync(archive).size !== Number(row.artifact_bytes)) {
      throw error(`iOS native extension artifact byte count drifted for ${row.sql_name}/${row.kind}`);
    }
    referenced.add(archive);

    let registration = null;
    if (row.registration_artifact !== "-") {
      registration = path.resolve(targetDirectory, row.registration_artifact);
      if (!pathInside(root, registration) || !existsSync(registration) || !statSync(registration).isFile()) {
        throw error(`iOS native extension index references missing or escaping registration ${row.registration_artifact}`);
      }
      let registrationDocument;
      try {
        registrationDocument = JSON.parse(readFileSync(registration, "utf8"));
      } catch (registrationError) {
        throw error(`${row.registration_artifact} is not valid iOS registration JSON: ${registrationError.message}`);
      }
      if (
        registrationDocument?.schema !== "oliphaunt-ios-extension-registration-v1"
        || registrationDocument.sqlName !== row.sql_name
        || registrationDocument.nativeModuleStem !== extension.nativeModuleStem
        || typeof registrationDocument.magicSymbol !== "string"
        || !(registrationDocument.initSymbol === null || typeof registrationDocument.initSymbol === "string")
        || !Array.isArray(registrationDocument.symbols)
      ) {
        throw error(`${row.registration_artifact} does not bind ${row.sql_name}/${extension.nativeModuleStem}`);
      }
      referenced.add(registration);
    }

    artifacts.push({
      product: extension.product,
      sqlName: row.sql_name,
      kind: row.kind,
      identity: row.identity === "-" ? null : row.identity,
      name: path.basename(archive),
      bytes: statSync(archive).size,
      sha256: sha256(archive),
      registration: registration === null
        ? null
        : {
            name: path.basename(registration),
            bytes: statSync(registration).size,
            sha256: sha256(registration),
          },
    });
  }

  const expectedNames = [...expectedByName.keys()].sort(compareText);
  const expectedPrimaryNames = contract.extensions
    .filter(({ nativeModuleStem }) => nativeModuleStem !== null)
    .map(({ sqlName }) => sqlName)
    .sort(compareText);
  const dependencyRows = rows.filter(({ kind }) => kind === "ios-dependency-xcframework");
  for (const extension of contract.extensions) {
    const actualDependencies = dependencyRows
      .filter(({ sql_name: sqlName }) => sqlName === extension.sqlName)
      .map(({ identity }) => identity)
      .sort(compareText);
    if (!sameJson(actualDependencies, extension.iosNativeDependencies)) {
      throw error(`iOS native dependency rows drifted for ${extension.sqlName}`);
    }
  }
  if (
    !sameJson(runtimeNames.sort(compareText), expectedNames)
    || !sameJson(primaryNames.sort(compareText), expectedPrimaryNames)
  ) {
    throw error("iOS native extension index must cover every exact runtime and canonical primary XCFramework once");
  }
  if (files.length !== referenced.size || files.some((file) => !referenced.has(file))) {
    throw error("iOS native extension artifact root contains unindexed files");
  }

  return {
    root,
    targetDirectory,
    index: { name: path.basename(index), bytes: statSync(index).size, sha256: sha256(index) },
    legacyIndex: {
      name: path.basename(legacyIndex),
      bytes: statSync(legacyIndex).size,
      sha256: sha256(legacyIndex),
    },
    artifacts: artifacts.sort((left, right) => compareText(
      `${left.sqlName}\0${left.kind}\0${left.identity ?? ""}`,
      `${right.sqlName}\0${right.kind}\0${right.identity ?? ""}`,
    )),
  };
}

function oneTarget(product, kind, target) {
  const matches = allArtifactTargets({ product, kind, publishedOnly: true }, TOOL)
    .filter((entry) => entry.target === target);
  if (matches.length !== 1) throw error(`expected one ${product} ${kind} target ${target}, got ${matches.length}`);
  return matches[0];
}

function oneFileByBasename(files, basename, label) {
  const matches = files.filter((file) => path.basename(file) === basename);
  if (matches.length !== 1) throw error(`${label} requires exactly one ${basename}, got ${matches.length}`);
  return matches[0];
}

function currentHostTarget() {
  if (process.platform === "linux" && process.arch === "x64") return "linux-x64-gnu";
  if (process.platform === "linux" && process.arch === "arm64") return "linux-arm64-gnu";
  if (process.platform === "darwin" && process.arch === "arm64") return "macos-arm64";
  if (process.platform === "win32" && process.arch === "x64") return "windows-x64-msvc";
  return undefined;
}

export function exactCandidateExtensions(targetId) {
  const sdk = JSON.parse(readFileSync(GENERATED_EXTENSION_SDK, "utf8"));
  const catalog = JSON.parse(readFileSync(GENERATED_EXTENSION_CATALOG, "utf8"));
  const iosDependenciesBySqlName = generatedIosDependenciesBySqlName();
  const sdkByName = new Map((sdk.extensions ?? []).map((row) => [row["sql-name"], row]));
  const catalogByName = new Map((catalog.extensions ?? []).map((row) => [row["sql-name"], row]));
  const products = exactExtensionProducts(TOOL);
  const productRows = products.map((product) => {
    const productMembers = extensionSqlNames(product, TOOL);
    const version = currentProductVersionSync(product, TOOL);
    const npmTargets = extensionRegistryPackageTargetSets(product, TOOL).npmTargets;
    if (!npmTargets.includes(targetId)) {
      throw error(`promoted extension ${product} does not publish npm target ${targetId}`);
    }
    return {
      product,
      productMembers,
      version,
      npmTargets,
      metaPackage: extensionNpmPackageForProduct(product),
      targetPackage: extensionNpmTargetPackageForProduct(product, targetId),
    };
  });
  const rows = productRows
    .flatMap(({ product, productMembers, version, npmTargets, metaPackage, targetPackage }) => {
      return productMembers.map((sqlName) => {
        const metadata = sdkByName.get(sqlName);
        const catalogRow = catalogByName.get(sqlName);
        if (metadata?.["desktop-release-ready"] !== true || catalogRow === undefined) {
          throw error(`promoted extension ${product}/${sqlName} lacks canonical desktop metadata`);
        }
        if (metadata["release-product"] !== product) {
          throw error(
            `promoted extension ${product}/${sqlName} disagrees with generated release ownership`,
          );
        }
        const createsExtension = metadata["creates-extension"] === true;
        if (catalogRow.lifecycle?.["create-extension"] !== createsExtension) {
          throw error(`promoted extension ${product}/${sqlName} lifecycle metadata disagrees`);
        }
        const nativeModuleStem = metadata["native-module-stem"] ?? null;
        const iosNativeDependencies = iosDependenciesBySqlName.get(sqlName);
        if (nativeModuleStem !== null && iosNativeDependencies === undefined) {
          throw error(`promoted extension ${product}/${sqlName} lacks generated iOS dependency metadata`);
        }
        if (nativeModuleStem === null && iosNativeDependencies !== undefined) {
          throw error(`SQL-only extension ${product}/${sqlName} fabricates generated iOS dependency metadata`);
        }
        const loadSql = [...(catalogRow.lifecycle?.["load-sql"] ?? [])];
        if (!createsExtension && loadSql.length === 0) {
          throw error(`load-only extension ${product}/${sqlName} has no activation SQL`);
        }
        return {
          product,
          version,
          sqlName,
          createsExtension,
          loadSql,
          members: productMembers,
          dependencies: [...(metadata["selected-extension-dependencies"] ?? [])].sort(compareText),
          dataFiles: [...(metadata["runtime-share-data-files"] ?? [])].sort(compareText),
          extensionSqlFileNames: [...(metadata["extension-sql-file-names"] ?? [])].sort(compareText),
          extensionSqlFilePrefixes: [...(metadata["extension-sql-file-prefixes"] ?? [])].sort(compareText),
          sharedPreloadLibraries: [...(metadata["shared-preload-libraries"] ?? [])].sort(compareText),
          nativeModuleStem,
          iosNativeDependencies: iosNativeDependencies ?? [],
          mobileReleaseReady: metadata["mobile-release-ready"] === true,
          npmTargets,
          metaPackage,
          targetPackage,
        };
      });
    })
    .sort((left, right) => compareText(left.sqlName, right.sqlName));
  const expectedSqlNames = productRows.flatMap(({ productMembers }) => productMembers);
  if (
    rows.length !== expectedSqlNames.length ||
    new Set(rows.map((row) => row.sqlName)).size !== rows.length
  ) {
    throw error(`canonical desktop extension set must contain ${expectedSqlNames.length} unique SQL names`);
  }
  return rows;
}

export function exactCandidateExtensionProductGroups(extensions) {
  if (!Array.isArray(extensions) || extensions.length === 0) {
    throw error("exact extension contract must contain extension rows");
  }
  const groups = new Map();
  for (const extension of extensions) {
    if (
      extension === null
      || typeof extension !== "object"
      || typeof extension.product !== "string"
      || typeof extension.version !== "string"
      || typeof extension.sqlName !== "string"
      || !Array.isArray(extension.members)
    ) {
      throw error("exact extension contract contains a malformed row");
    }
    const group = groups.get(extension.product) ?? {
      product: extension.product,
      version: extension.version,
      members: [...extension.members].sort(compareText),
      extensions: [],
    };
    if (
      group.version !== extension.version
      || !sameJson(group.members, [...extension.members].sort(compareText))
      || group.extensions.some((row) => row.sqlName === extension.sqlName)
    ) {
      throw error(`exact extension contract has inconsistent release owner ${extension.product}`);
    }
    group.extensions.push(extension);
    groups.set(extension.product, group);
  }
  const result = [...groups.values()]
    .map((group) => {
      group.extensions.sort((left, right) => compareText(left.sqlName, right.sqlName));
      const actualMembers = group.extensions.map(({ sqlName }) => sqlName);
      if (!sameJson(actualMembers, group.members)) {
        throw error(
          `exact extension release owner ${group.product} must cover members ${group.members.join(", ")}`,
        );
      }
      return group;
    })
    .sort((left, right) => compareText(left.product, right.product));
  const covered = result.flatMap(({ members }) => members);
  if (covered.length !== extensions.length || new Set(covered).size !== covered.length) {
    throw error("exact extension release-owner groups must cover every SQL extension exactly once");
  }
  return result;
}

export function exactCandidateTargetContract(targetId) {
  const row = jsExactCandidateConsumerMatrix().include.find((entry) => entry.target === targetId);
  if (row === undefined) throw error(`unsupported TypeScript exact-candidate target ${targetId}`);
  const versions = {
    js: currentProductVersionSync("oliphaunt-js", TOOL),
    native: currentProductVersionSync("liboliphaunt-native", TOOL),
    broker: currentProductVersionSync("oliphaunt-broker", TOOL),
    node: currentProductVersionSync("oliphaunt-node-direct", TOOL),
  };
  const native = oneTarget("liboliphaunt-native", "native-runtime", targetId);
  const tools = oneTarget("liboliphaunt-native", "native-tools", targetId);
  const icu = oneTarget("liboliphaunt-native", "icu-data", "portable");
  const broker = oneTarget("oliphaunt-broker", "broker-helper", targetId);
  const extensions = exactCandidateExtensions(targetId);
  const extensionPackages = Object.fromEntries(
    extensions.flatMap((extension) => [
      [extension.metaPackage, extension.version],
      [extension.targetPackage, extension.version],
    ]),
  );
  return {
    ...row,
    versions,
    assets: {
      native: native.asset.replaceAll("{version}", versions.native),
      tools: tools.asset.replaceAll("{version}", versions.native),
      icu: icu.asset.replaceAll("{version}", versions.native),
      broker: broker.asset.replaceAll("{version}", versions.broker),
    },
    iosBaseAssets: {
      baseXcframework: `liboliphaunt-${versions.native}-apple-spm-xcframework.zip`,
      runtimeResources: `liboliphaunt-${versions.native}-runtime-resources.tar.gz`,
      icuData: `liboliphaunt-${versions.native}-icu-data.tar.gz`,
    },
    extensions,
    packages: {
      "@oliphaunt/ts": versions.js,
      "@oliphaunt/icu": versions.native,
      [row.native_package]: versions.native,
      [row.tools_package]: versions.native,
      [row.broker_package]: versions.broker,
      [row.node_package]: versions.node,
      ...extensionPackages,
    },
  };
}

export function exactCandidateRuntimeCases(targetId) {
  if (!JS_EXACT_CANDIDATE_CONSUMER_TARGETS.includes(targetId)) {
    throw error(`unsupported TypeScript exact-candidate target ${targetId}`);
  }
  return [
    { runtime: "node", engine: "nativeDirect" },
    { runtime: "node", engine: "nativeBroker" },
    { runtime: "node", engine: "nativeServer" },
    { runtime: "bun", engine: "nativeDirect" },
    { runtime: "deno", engine: "nativeDirect" },
  ];
}

export function exactCandidateErrorEvidence(cause, depth = 0) {
  const detail = {
    name: cause instanceof Error ? cause.name : "Error",
    message: cause instanceof Error ? cause.message : String(cause),
  };
  if (cause !== null && typeof cause === "object") {
    for (const key of [
      "code",
      "command",
      "deadlineExceeded",
      "deadlineLimited",
      "label",
      "phaseStarted",
      "processTreeTerminated",
      "remainingMs",
      "reserveMs",
      "timedOut",
      "timeoutMs",
      "unsafeContinuation",
    ]) {
      if (["boolean", "number", "string"].includes(typeof cause[key])) detail[key] = cause[key];
    }
    if (cause.processTree !== null && typeof cause.processTree === "object" && depth < 3) {
      detail.processTree = Object.fromEntries(
        ["killSent", "pid", "platform", "strategy", "termSent", "terminated"]
          .flatMap((key) => ["boolean", "number", "string"].includes(
            typeof cause.processTree[key],
          ) ? [[key, cause.processTree[key]]] : []),
      );
      if (cause.processTree.error !== undefined) {
        detail.processTree.error = cause.processTree.error instanceof Error
          ? exactCandidateErrorEvidence(cause.processTree.error, depth + 1)
          : cause.processTree.error;
      }
    }
    if (cause.watchdogCleanupError !== undefined && depth < 3) {
      detail.watchdogCleanupError = cause.watchdogCleanupError instanceof Error
        ? exactCandidateErrorEvidence(cause.watchdogCleanupError, depth + 1)
        : cause.watchdogCleanupError;
    }
    if (Array.isArray(cause.cleanupErrors) && depth < 3) {
      detail.cleanupErrors = cause.cleanupErrors.slice(0, 16).map((entry) =>
        entry instanceof Error ? exactCandidateErrorEvidence(entry, depth + 1) : entry
      );
    }
    if (cause instanceof AggregateError && depth < 3) {
      detail.errors = [...cause.errors]
        .slice(0, 16)
        .map((entry) => exactCandidateErrorEvidence(entry, depth + 1));
    }
  }
  return detail;
}

export function aggregateExactCandidateErrors(label, causes) {
  const errors = causes.filter((cause) => cause !== undefined && cause !== null);
  if (errors.length === 0) return undefined;
  if (errors.length === 1) return errors[0];
  return new AggregateError(
    errors,
    `${label}: ${errors.map((cause) => exactCandidateErrorEvidence(cause).message).join("; ")}`,
  );
}

function exactCandidateCaseIdentity(testCase) {
  const runtime = requiredValue(testCase?.runtime, "runtime-case runtime");
  const engine = requiredValue(testCase?.engine, "runtime-case engine");
  return { engine, id: `${runtime}-${engine}`, runtime };
}

function exactCandidateCasePhases(testCase, phasesForCase) {
  const phases = phasesForCase(testCase);
  if (
    !Array.isArray(phases)
    || phases.length === 0
    || phases.some((phase) => typeof phase !== "string" || phase.length === 0)
    || new Set(phases).size !== phases.length
    || phases.includes("read-receipt")
  ) {
    throw error("runtime-case phases must be a non-empty, unique string array excluding read-receipt");
  }
  return [...phases, "read-receipt"];
}

function exactCandidateUnattemptedResult(testCase, phases, reason) {
  const { engine, id, runtime } = exactCandidateCaseIdentity(testCase);
  return {
    id,
    runtime,
    engine,
    state: "unattempted",
    reason,
    phases: phases.map((phase) => ({ phase, state: "unattempted", reason })),
  };
}

function cloneExactCandidateResults(results) {
  return JSON.parse(JSON.stringify(results));
}

function unsafeStopForError(detail, id, phase) {
  if (detail.deadlineExceeded === true) {
    return { code: "consumer-deadline-reached", id, phase, error: detail };
  }
  if (detail.timedOut === true) {
    return { code: "unsafe-continuation-after-command-timeout", id, phase, error: detail };
  }
  if (detail.unsafeContinuation === true) {
    return { code: "unsafe-continuation-after-command-supervisor-failure", id, phase, error: detail };
  }
  return undefined;
}

export function unattemptedExactCandidateSettlement(
  testCases,
  reason,
  { phasesForCase = () => ["produce", "verify-restored"] } = {},
) {
  if (!Array.isArray(testCases)) throw error("exact-candidate test cases must be an array");
  const caseIds = new Set();
  const results = testCases.map((testCase) => {
    const { id } = exactCandidateCaseIdentity(testCase);
    if (caseIds.has(id)) throw error(`duplicate exact-candidate runtime case ${id}`);
    caseIds.add(id);
    return exactCandidateUnattemptedResult(
      testCase,
      exactCandidateCasePhases(testCase, phasesForCase),
      reason,
    );
  });
  return { failures: [], receipts: [], results, stopReason: { code: reason } };
}

export function executeExactCandidateRuntimeCasesFailLate(
  testCases,
  {
    beforePhase = () => undefined,
    cleanupCase = () => {},
    executePhase,
    phasesForCase = () => ["produce", "verify-restored"],
    readReceipt,
    onResult = () => {},
  },
) {
  if (!Array.isArray(testCases) || testCases.length === 0) {
    throw error("at least one exact-candidate runtime case is required");
  }
  if (typeof executePhase !== "function" || typeof readReceipt !== "function") {
    throw error("runtime-case phase and receipt callbacks are required");
  }
  if (typeof beforePhase !== "function") throw error("runtime-case admission callback must be a function");
  if (typeof cleanupCase !== "function") throw error("runtime-case cleanup callback must be a function");
  if (typeof phasesForCase !== "function") throw error("runtime-case phases callback must be a function");
  if (typeof onResult !== "function") throw error("runtime-case result callback must be a function");

  const receipts = [];
  const results = [];
  const caseIds = new Set();
  const preparedCases = testCases.map((testCase) => {
    const identity = exactCandidateCaseIdentity(testCase);
    if (caseIds.has(identity.id)) {
      throw error(`duplicate exact-candidate runtime case ${identity.id}`);
    }
    caseIds.add(identity.id);
    return {
      identity,
      phases: exactCandidateCasePhases(testCase, phasesForCase),
      testCase,
    };
  });
  let stopReason;

  const notify = (result) => {
    try {
      onResult(result, cloneExactCandidateResults(results));
      return undefined;
    } catch (cause) {
      const detail = exactCandidateErrorEvidence(cause);
      result.callbackErrors = [...(result.callbackErrors ?? []), detail];
      if (result.state !== "failed") {
        result.state = "failed";
        result.phase = "persist-result";
        result.error = detail;
      }
      return detail;
    }
  };

  for (const { identity: { engine, id, runtime }, phases, testCase } of preparedCases) {
    if (stopReason !== undefined) {
      const result = exactCandidateUnattemptedResult(testCase, phases, stopReason.code);
      results.push(result);
      if (stopReason.code !== "evidence-persistence-failed") notify(result);
      continue;
    }

    const phaseResults = phases.map((phase) => ({
      phase,
      state: "unattempted",
      reason: "not-reached",
    }));
    let failedResult;
    let receipt;
    for (const [phaseIndex, phase] of phases.slice(0, -1).entries()) {
      let admission;
      try {
        admission = beforePhase(testCase, phase, id);
      } catch (cause) {
        const detail = exactCandidateErrorEvidence(cause);
        phaseResults[phaseIndex].reason = detail.deadlineExceeded === true
          ? "consumer-deadline-reached"
          : "phase-admission-failed";
        failedResult = {
          id,
          runtime,
          engine,
          state: "failed",
          phase: `admit-${phase}`,
          error: detail,
          phases: phaseResults,
        };
        stopReason = unsafeStopForError(detail, id, phase) ?? {
          code: "phase-admission-failed",
          id,
          phase,
          error: detail,
        };
        for (let later = phaseIndex + 1; later < phaseResults.length; later += 1) {
          phaseResults[later].reason = stopReason.code;
        }
        break;
      }
      try {
        executePhase(testCase, phase, id, admission);
        phaseResults[phaseIndex] = { phase, state: "passed" };
      } catch (cause) {
        const detail = exactCandidateErrorEvidence(cause);
        phaseResults[phaseIndex] = detail.phaseStarted === false
          ? { phase, state: "unattempted", reason: "consumer-deadline-reached", error: detail }
          : { phase, state: "failed", error: detail };
        const unsafeStop = unsafeStopForError(detail, id, phase);
        const unattemptedReason = unsafeStop?.code ?? "prior-phase-failed";
        for (let later = phaseIndex + 1; later < phaseResults.length; later += 1) {
          phaseResults[later].reason = unattemptedReason;
        }
        failedResult = {
          id,
          runtime,
          engine,
          state: "failed",
          phase: detail.phaseStarted === false ? `admit-${phase}` : phase,
          error: detail,
          phases: phaseResults,
        };
        if (unsafeStop !== undefined) stopReason = unsafeStop;
        break;
      }
    }

    if (failedResult === undefined) {
      const receiptIndex = phaseResults.length - 1;
      try {
        receipt = readReceipt(testCase, id);
        phaseResults[receiptIndex] = { phase: "read-receipt", state: "passed" };
      } catch (cause) {
        const detail = exactCandidateErrorEvidence(cause);
        phaseResults[receiptIndex] = { phase: "read-receipt", state: "failed", error: detail };
        failedResult = {
          id,
          runtime,
          engine,
          state: "failed",
          phase: "read-receipt",
          error: detail,
          phases: phaseResults,
        };
      }
    }

    const result = failedResult ?? { id, runtime, engine, state: "passed", phases: phaseResults };
    results.push(result);

    // Persist the completed semantic result before diagnostics or filesystem
    // cleanup can fail. A callback failure is retained and stops admission of
    // later cases because the qualification evidence can no longer be proven.
    const callbackError = notify(result);
    if (callbackError !== undefined) {
      stopReason = {
        code: "evidence-persistence-failed",
        id,
        phase: "persist-result",
        error: callbackError,
      };
    }

    try {
      cleanupCase(testCase, id, result);
    } catch (cause) {
      const detail = exactCandidateErrorEvidence(cause);
      result.cleanupErrors = [...(result.cleanupErrors ?? []), detail];
      if (result.state !== "failed") {
        result.state = "failed";
        result.phase = "cleanup";
        result.error = detail;
      }
      stopReason = callbackError === undefined
        ? {
          code: "unsafe-continuation-after-cleanup-failure",
          id,
          phase: "cleanup",
          error: detail,
        }
        : {
          code: "evidence-persistence-failed",
          id,
          phase: "persist-result",
          error: callbackError,
          cleanupError: detail,
        };
      if (callbackError === undefined) {
        const cleanupPersistenceError = notify(result);
        if (cleanupPersistenceError !== undefined) {
          stopReason = {
            code: "evidence-persistence-failed",
            id,
            phase: "persist-cleanup-result",
            error: cleanupPersistenceError,
          };
        }
      }
    }

    if (result.state === "passed") receipts.push(receipt);
  }

  return {
    receipts,
    results,
    failures: results.filter(({ state }) => state === "failed"),
    stopReason,
  };
}

export function exactCandidateRuntimeFailureMessage(failures) {
  if (!Array.isArray(failures) || failures.length === 0) {
    throw error("at least one failed runtime case is required");
  }
  return failures.flatMap(({ id, phase, error: detail, callbackErrors = [], cleanupErrors = [] }) => [
    `${id}/${phase}: ${detail?.message ?? "unknown failure"}`,
    ...cleanupErrors
      .filter((entry) => entry.message !== detail?.message)
      .map((entry) => `${id}/cleanup: ${entry.message}`),
    ...callbackErrors
      .filter((entry) => entry.message !== detail?.message)
      .map((entry) => `${id}/evidence: ${entry.message}`),
  ]).join("; ");
}

export function combineExactCandidateSettlements(...settlements) {
  const normalized = settlements.filter((settlement) => settlement !== undefined);
  return {
    receipts: normalized.flatMap(({ receipts = [] }) => receipts),
    results: normalized.flatMap(({ results = [] }) => results),
    failures: normalized.flatMap(({ failures = [] }) => failures),
    stopReasons: normalized.flatMap(({ stopReason }) => stopReason === undefined ? [] : [stopReason]),
  };
}

export function completeExactCandidateResults(
  testCases,
  settledResults,
  reason,
  { phasesForCase = () => ["produce", "verify-restored"] } = {},
) {
  const placeholders = unattemptedExactCandidateSettlement(
    testCases,
    reason,
    { phasesForCase },
  ).results;
  const settledById = new Map();
  for (const result of settledResults) {
    if (settledById.has(result.id)) {
      throw error(`duplicate settled exact-candidate case ${result.id}`);
    }
    settledById.set(result.id, result);
  }
  return placeholders.map((placeholder) => settledById.get(placeholder.id) ?? placeholder);
}

function exactCandidateSettlementSummary(results) {
  return {
    expected: results.length,
    attempted: results.filter(({ phases = [] }) =>
      phases.some(({ state }) => state === "passed" || state === "failed")
    ).length,
    passed: results.filter(({ state }) => state === "passed").length,
    failed: results.filter(({ state }) => state === "failed").length,
    unattempted: results.filter(({ state }) => state === "unattempted").length,
  };
}

export function exactCandidatePendingSettlementReason(result, pendingReason) {
  if (result?.state === "unattempted" && typeof result.reason === "string") {
    return result.reason;
  }
  if (result?.error?.timedOut === true) return "unsafe-continuation-after-command-timeout";
  if (result?.error?.deadlineExceeded === true) return "consumer-deadline-reached";
  if (result?.error?.unsafeContinuation === true) {
    return "unsafe-continuation-after-command-supervisor-failure";
  }
  if (result?.cleanupErrors?.length > 0) {
    return "unsafe-continuation-after-cleanup-failure";
  }
  return pendingReason;
}

export function inspectIosBaseCarrierInput(roots, contract) {
  const expected = Object.entries(contract.iosBaseAssets ?? {});
  if (expected.length !== 3) {
    throw error("exact-candidate contract must declare the three iOS base carrier assets");
  }
  const candidates = [];
  for (const [rootIndex, root] of roots.entries()) {
    const files = walkFiles(root);
    const assets = [];
    for (const [role, basename] of expected) {
      const matches = files.filter((file) => path.basename(file) === basename);
      if (matches.length === 0) break;
      if (matches.length !== 1) {
        throw error(`iOS base carrier input repeats ${basename} under artifact root ${rootIndex}`);
      }
      const file = matches[0];
      assets.push({
        role,
        name: basename,
        path: path.relative(root, file).replaceAll(path.sep, "/"),
        bytes: statSync(file).size,
        sha256: sha256(file),
        file,
      });
    }
    if (assets.length !== expected.length) continue;
    const directories = new Set(assets.map(({ file }) => path.dirname(file)));
    if (directories.size !== 1) {
      throw error(`iOS base carrier assets under artifact root ${rootIndex} must share one exact directory`);
    }
    candidates.push({
      assetDir: directories.values().next().value,
      root,
      evidence: {
        root: rootIndex,
        assets: assets.map(({ file: _file, ...asset }) => asset),
      },
    });
  }
  if (candidates.length !== 1) {
    throw error(`candidate inputs require exactly one complete iOS base carrier artifact root, got ${candidates.length}`);
  }
  return candidates[0];
}

function inspectCandidateInputs(roots, iosExtensionArtifactRoot, contract) {
  const files = roots.flatMap(walkFiles);
  const iosExtensionFiles = walkFiles(iosExtensionArtifactRoot);
  const iosBase = inspectIosBaseCarrierInput(roots, contract);
  const nonIosFiles = files.filter((file) => !pathInside(iosBase.root, file));
  for (const [label, basename] of Object.entries(contract.assets)) {
    oneFileByBasename(nonIosFiles, basename, label);
  }
  const tarballs = files.filter((file) => file.endsWith(".tgz"));
  const identities = tarballs.map((file) => ({ file, ...tarballIdentity(file) }));
  for (const [name, version] of [["@oliphaunt/ts", contract.versions.js], [contract.node_package, contract.versions.node]]) {
    const matches = identities.filter((identity) => identity.name === name && identity.version === version);
    if (matches.length !== 1) throw error(`candidate inputs require exactly one ${name}@${version} tarball, got ${matches.length}`);
  }
  const unexpected = identities.filter((identity) => !["@oliphaunt/ts", contract.node_package].includes(identity.name));
  if (unexpected.length > 0) throw error(`candidate inputs contain unexpected npm tarballs: ${unexpected.map((item) => item.name).join(", ")}`);
  const jsrRoots = roots.flatMap((root) => walkDirectoriesNamed(root, "jsr-source"));
  if (jsrRoots.length !== 1) throw error(`candidate inputs require exactly one staged jsr-source directory, got ${jsrRoots.length}`);
  const jsr = JSON.parse(readFileSync(path.join(jsrRoots[0], "jsr.json"), "utf8"));
  if (jsr.name !== "@oliphaunt/ts" || jsr.version !== contract.versions.js || jsr.exports?.["."] !== "./src/jsr.ts") {
    throw error("staged JSR source identity, version, or root export does not match the exact TypeScript candidate");
  }
  const extensionInputs = validateExtensionCandidateInputs(roots, files, contract);
  const iosExtensionInputs = validateIosExtensionCandidateInputs(iosExtensionArtifactRoot, contract);
  const immutableRoots = [...roots, iosExtensionArtifactRoot];
  const immutableFiles = [...files, ...iosExtensionFiles].map((file) => ({
    root: immutableRoots.findIndex((root) => file === root || file.startsWith(`${root}${path.sep}`)),
    path: path.relative(immutableRoots.find((root) => pathInside(root, file)), file).replaceAll(path.sep, "/"),
    bytes: statSync(file).size,
    sha256: sha256(file),
  }));
  return {
    files: immutableFiles,
    immutableInputSnapshot: immutableInputSnapshotFromFiles(immutableFiles),
    jsrSourceRoot: jsrRoots[0],
    extensionInputs,
    iosExtensionInputs,
    iosBaseAssetDir: iosBase.assetDir,
    iosBaseInput: iosBase.evidence,
  };
}

function walkDirectoriesNamed(root, name) {
  if (!statSync(root).isDirectory()) return [];
  const matches = [];
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const directory = path.join(current, entry.name);
      if (entry.name === name) matches.push(directory);
      else visit(directory);
    }
  };
  visit(root);
  return matches;
}

function packageDirectory(consumerRoot, name) {
  return path.join(consumerRoot, "node_modules", ...name.split("/"));
}

export function assertExactInstalledPackages({ lock, consumerRoot, registryUrl, expectedPackages }) {
  if (lock.lockfileVersion !== 3 || typeof lock.packages !== "object" || lock.packages === null) {
    throw error("consumer package-lock.json must use lockfileVersion 3");
  }
  const expectedNames = Object.keys(expectedPackages).sort();
  const oliphauntEntries = Object.entries(lock.packages)
    .filter(([key]) => key.includes("node_modules/@oliphaunt/"));
  const lockedNames = oliphauntEntries
    .filter(([, entry]) => typeof entry.version === "string" || typeof entry.resolved === "string")
    .map(([key]) => key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length))
    .sort();
  if (JSON.stringify(lockedNames) !== JSON.stringify(expectedNames)) {
    throw error(`installed Oliphaunt package set must be exact; expected ${expectedNames.join(", ")}, got ${lockedNames.join(", ")}`);
  }
  for (const [key, entry] of oliphauntEntries) {
    if (typeof entry.version === "string" || typeof entry.resolved === "string") continue;
    if (entry.optional !== true || entry.integrity !== undefined || existsSync(path.join(consumerRoot, key))) {
      throw error(`${key} may only be an unresolved, absent incompatible-platform optional placeholder`);
    }
  }
  for (const [name, version] of Object.entries(expectedPackages)) {
    const key = `node_modules/${name}`;
    const entry = lock.packages[key];
    if (entry?.version !== version) throw error(`${name} lock identity/version does not match ${version}`);
    if (entry.link === true || typeof entry.resolved !== "string" || !entry.resolved.startsWith(`${registryUrl}/`)) {
      throw error(`${name} must resolve from the isolated same-run registry, not a workspace, file path, or public registry`);
    }
    if (typeof entry.integrity !== "string" || !entry.integrity.startsWith("sha512-")) throw error(`${name} must be integrity locked`);
    const directory = packageDirectory(consumerRoot, name);
    if (!existsSync(directory) || lstatSync(directory).isSymbolicLink() || realpathSync(directory) !== path.resolve(directory)) {
      throw error(`${name} must be a real installed package directory`);
    }
    const manifest = JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8"));
    if (manifest.name !== name || manifest.version !== version) throw error(`${name} installed manifest does not match its lock entry`);
  }
}

function installedPackageEvidence({ lock, consumerRoot, expectedPackages }) {
  return Object.entries(expectedPackages)
    .sort(([left], [right]) => compareText(left, right))
    .map(([name, version]) => {
      const entry = lock.packages[`node_modules/${name}`];
      const directory = packageDirectory(consumerRoot, name);
      const files = walkFiles(directory).map((file) => ({
        path: path.relative(directory, file).replaceAll(path.sep, "/"),
        bytes: statSync(file).size,
        sha256: sha256(file),
      }));
      return {
        name,
        version,
        integrity: entry.integrity,
        resolved: entry.resolved,
        fileCount: files.length,
        installedTreeSha256: sha256Bytes(JSON.stringify(files)),
      };
    });
}

function assertExtensionPackageManifests(consumerRoot, contract) {
  for (const extension of contract.extensions) {
    const meta = JSON.parse(
      readFileSync(path.join(packageDirectory(consumerRoot, extension.metaPackage), "package.json"), "utf8"),
    );
    const target = JSON.parse(
      readFileSync(path.join(packageDirectory(consumerRoot, extension.targetPackage), "package.json"), "utf8"),
    );
    const targetPackageNames = Object.fromEntries(
      extension.npmTargets.map((targetId) => [
        targetId,
        extensionNpmTargetPackageForProduct(extension.product, targetId),
      ]),
    );
    const optionalDependencies = Object.fromEntries(
      Object.values(targetPackageNames).map((name) => [name, extension.version]),
    );
    const bundle = extension.members.length > 1;
    if (
      meta.name !== extension.metaPackage
      || meta.version !== extension.version
      || meta.oliphaunt?.kind !== (bundle ? "exact-extension-bundle" : "exact-extension")
      || meta.oliphaunt?.product !== extension.product
      || JSON.stringify(meta.oliphaunt?.members) !== JSON.stringify(extension.members)
      || (!bundle && meta.oliphaunt?.sqlName !== extension.sqlName)
      || JSON.stringify(meta.oliphaunt?.targetPackageNames) !== JSON.stringify(targetPackageNames)
      || JSON.stringify(meta.optionalDependencies) !== JSON.stringify(optionalDependencies)
    ) {
      throw error(`${extension.metaPackage} does not preserve the full canonical target map`);
    }
    if (
      target.name !== extension.targetPackage
      || target.version !== extension.version
      || target.oliphaunt?.kind !== (bundle
        ? "exact-extension-bundle-target"
        : "exact-extension-target")
      || target.oliphaunt?.product !== extension.product
      || JSON.stringify(target.oliphaunt?.members) !== JSON.stringify(extension.members)
      || (!bundle && target.oliphaunt?.sqlName !== extension.sqlName)
      || target.oliphaunt?.target !== contract.target
      || target.oliphaunt?.liboliphauntVersion !== contract.versions.native
    ) {
      throw error(`${extension.targetPackage} does not match the exact target extension contract`);
    }
  }
}

function stagedOutputFile(outputRoot, relativePath, label) {
  if (typeof relativePath !== "string" || relativePath.length === 0) {
    throw error(`${label} must declare a staged file path`);
  }
  const file = path.resolve(ROOT, relativePath);
  if (!pathInside(path.resolve(outputRoot), file) || !existsSync(file) || !statSync(file).isFile()) {
    throw error(`${label} references a missing or escaping staged file ${relativePath}`);
  }
  return file;
}

function validateStagedRawAsset({ asset, contract, extension, outputRoot, raw }) {
  if (
    asset === null
    || typeof asset !== "object"
    || asset.family !== "native"
    || asset.kind !== "runtime"
    || asset.target !== contract.target
    || asset.identity !== null
    || asset.bytes !== raw?.bytes
    || asset.sha256 !== raw?.sha256
  ) {
    throw error(
      `${extension.product}/${extension.sqlName} does not bind the exact raw ${contract.target} extension carrier`,
    );
  }
  const file = stagedOutputFile(
    outputRoot,
    asset.path,
    `${extension.product}/${extension.sqlName} raw asset`,
  );
  if (
    typeof asset.name !== "string"
    || path.basename(file) !== asset.name
    || statSync(file).size !== raw.bytes
    || sha256(file) !== raw.sha256
  ) {
    throw error(`${extension.product}/${extension.sqlName} staged raw asset bytes drifted`);
  }
  return file;
}

function validateStagedIosAssets({ assets, extension, outputRoot }) {
  const expectedRoles = [
    "runtime\0",
    ...(extension.nativeModuleStem === null
      ? []
      : [
          `ios-xcframework\0${extension.nativeModuleStem}`,
          ...extension.iosNativeDependencies.map((identity) =>
            `ios-dependency-xcframework\0${identity}`),
        ]),
  ].sort(compareText);
  const actualRoles = assets.map((asset) => `${asset?.kind}\0${asset?.identity ?? ""}`).sort(compareText);
  if (!sameJson(actualRoles, expectedRoles)) {
    throw error(`${extension.product}/${extension.sqlName} does not stage its exact canonical iOS asset roles`);
  }
  return assets
    .map((asset) => {
      if (
        asset === null
        || typeof asset !== "object"
        || asset.family !== "native"
        || asset.target !== "ios-xcframework"
        || !Number.isSafeInteger(asset.bytes)
        || asset.bytes <= 0
        || !/^[0-9a-f]{64}$/u.test(asset.sha256 ?? "")
      ) {
        throw error(`${extension.product}/${extension.sqlName} has malformed staged iOS asset metadata`);
      }
      const file = stagedOutputFile(
        outputRoot,
        asset.path,
        `${extension.product}/${extension.sqlName} iOS ${asset.kind} asset`,
      );
      if (
        typeof asset.name !== "string"
        || path.basename(file) !== asset.name
        || statSync(file).size !== asset.bytes
        || sha256(file) !== asset.sha256
      ) {
        throw error(`${extension.product}/${extension.sqlName} staged iOS asset bytes drifted`);
      }
      return {
        kind: asset.kind,
        identity: asset.identity,
        name: asset.name,
        bytes: asset.bytes,
        sha256: asset.sha256,
      };
    })
    .sort((left, right) => compareText(
      `${left.kind}\0${left.identity ?? ""}`,
      `${right.kind}\0${right.identity ?? ""}`,
    ));
}

export function validateStagedExtensionMember({ member, contract, extension, outputRoot, raw }) {
  if (
    member === null
    || typeof member !== "object"
    || member.sqlName !== extension.sqlName
    || member.desktopReleaseReady !== true
    || member.mobileReleaseReady !== extension.mobileReleaseReady
    || member.createsExtension !== extension.createsExtension
    || member.nativeModuleStem !== extension.nativeModuleStem
    || !sameJson(member.iosNativeDependencies, extension.iosNativeDependencies)
    || !sameJson(member.dependencies, extension.dependencies)
    || !sameJson(member.dataFiles, extension.dataFiles)
    || !sameJson(member.extensionSqlFileNames, extension.extensionSqlFileNames)
    || !sameJson(member.extensionSqlFilePrefixes, extension.extensionSqlFilePrefixes)
    || !sameJson(member.sharedPreloadLibraries, extension.sharedPreloadLibraries)
  ) {
    throw error(
      `${extension.product}/${extension.sqlName} does not match the canonical exact-extension member contract`,
    );
  }
  if (!Array.isArray(member.assets)) {
    throw error(`${extension.product}/${extension.sqlName} must stage exact desktop and iOS raw assets`);
  }
  const unexpectedTargets = member.assets.filter(
    ({ target }) => target !== contract.target && target !== "ios-xcframework",
  );
  const desktopAssets = member.assets.filter(({ target }) => target === contract.target);
  const iosAssets = member.assets.filter(({ target }) => target === "ios-xcframework");
  if (unexpectedTargets.length !== 0 || desktopAssets.length !== 1) {
    throw error(`${extension.product}/${extension.sqlName} must stage exactly one ${contract.target} raw asset`);
  }
  const asset = desktopAssets[0];
  validateStagedRawAsset({ asset, contract, extension, outputRoot, raw });
  const iosEvidence = validateStagedIosAssets({ assets: iosAssets, extension, outputRoot });
  return {
    sqlName: extension.sqlName,
    rawAssetName: raw.name,
    rawAssetSha256: raw.sha256,
    rawAssetBytes: raw.bytes,
    stagedAssetName: asset.name,
    stagedAssetSha256: asset.sha256,
    stagedAssetBytes: asset.bytes,
    iosAssets: iosEvidence,
    asset,
  };
}

export function validateStagedBundleCarrier({
  carrier,
  compatibility,
  contract,
  group,
  memberEvidence,
  outputRoot,
}) {
  const expectedCarrierName = `${group.product}-${group.version}-native-${contract.target}-bundle.tar.gz`;
  if (
    carrier === null
    || typeof carrier !== "object"
    || carrier.family !== "native"
    || carrier.kind !== "extension-bundle"
    || carrier.target !== contract.target
    || carrier.memberCount !== group.members.length
    || carrier.name !== expectedCarrierName
    || !Number.isSafeInteger(carrier.bytes)
    || carrier.bytes <= 0
    || !/^[0-9a-f]{64}$/u.test(carrier.sha256 ?? "")
  ) {
    throw error(`${group.product} has a noncanonical ${contract.target} bundle carrier`);
  }
  const carrierFile = stagedOutputFile(outputRoot, carrier.path, `${group.product} bundle carrier`);
  if (
    path.basename(carrierFile) !== carrier.name
    || statSync(carrierFile).size !== carrier.bytes
    || sha256(carrierFile) !== carrier.sha256
  ) {
    throw error(`${group.product} staged bundle carrier bytes drifted`);
  }
  const legal = extensionCarrierLegalContract(group.product, group.members, {
    family: "native",
    target: contract.target,
  });
  const carrierRoot = carrier.name.slice(0, -".tar.gz".length);
  const bundleManifestMember = `${carrierRoot}/bundle-manifest.json`;
  let bundleManifest;
  try {
    bundleManifest = JSON.parse(
      runBytes("tar", ["-xOzf", carrierFile, bundleManifestMember]).toString("utf8"),
    );
  } catch (cause) {
    throw error(`${group.product} bundle carrier has an invalid bundle-manifest.json: ${cause.message}`);
  }
  if (
    bundleManifest?.schema !== "oliphaunt-extension-bundle-v1"
    || bundleManifest.product !== group.product
    || bundleManifest.version !== group.version
    || bundleManifest.family !== "native"
    || bundleManifest.target !== contract.target
    || !sameJson(bundleManifest.compatibility, compatibility)
    || bundleManifest.licenseProfile !== legal.profile
    || !sameJson(bundleManifest.licenseFiles, legal.licenseFiles)
    || !Array.isArray(bundleManifest.members)
  ) {
    throw error(`${group.product} bundle-manifest.json does not match the exact candidate contract`);
  }
  const expectedArchiveFiles = [
    bundleManifestMember,
    ...memberEvidence.map(({ asset }) => `${carrierRoot}/${asset.memberPath}`),
    ...releaseNoticeRows({ profile: legal.profile })
      .map(({ member }) => `${carrierRoot}/${member}`),
    ...legal.licenseFiles.map((member) => `${carrierRoot}/${member}`),
  ].sort(compareText);
  const archiveFiles = run("tar", ["-tzf", carrierFile], { capture: true })
    .split(/\r?\n/u)
    .map((name) => name.replace(/^\.\//u, ""))
    .filter((name) => name.length > 0 && !name.endsWith("/"))
    .sort(compareText);
  if (
    new Set(archiveFiles).size !== archiveFiles.length
    || !sameJson(archiveFiles, expectedArchiveFiles)
  ) {
    throw error(
      `${group.product} bundle carrier must contain only its exact manifest, member, and legal files`,
    );
  }
  try {
    assertReleaseNoticesInArchive(carrierFile, {
      prefix: carrierRoot,
      profile: legal.profile,
    });
    if (legal.upstreamMembers.length > 0) {
      assertExtensionUpstreamLicensesInArchive(legal.upstreamMembers, carrierFile, {
        prefix: carrierRoot,
      });
    }
  } catch (cause) {
    throw error(`${group.product} bundle carrier has invalid legal payload bytes: ${cause.message}`);
  }
  const nestedBySqlName = new Map();
  for (const nested of bundleManifest.members) {
    if (
      nested === null
      || typeof nested !== "object"
      || typeof nested.sqlName !== "string"
      || nestedBySqlName.has(nested.sqlName)
    ) {
      throw error(`${group.product} bundle-manifest.json repeats or malforms a member`);
    }
    nestedBySqlName.set(nested.sqlName, nested);
  }
  if (!sameJson([...nestedBySqlName.keys()].sort(compareText), group.members)) {
    throw error(`${group.product} bundle-manifest.json must cover its full exact member set`);
  }
  const verificationRoot = mkdtempSync(path.join(outputRoot, ".bundle-member-validation-"));
  try {
    for (const row of memberEvidence) {
      const expectedMemberPath = `extensions/${row.sqlName}/${row.asset.name}`;
      const nested = nestedBySqlName.get(row.sqlName);
      if (
        row.asset.carrierAsset !== carrier.name
        || row.asset.carrierRoot !== carrierRoot
        || row.asset.memberPath !== expectedMemberPath
        || !sameJson(nested, {
          sqlName: row.sqlName,
          kind: row.asset.kind,
          identity: row.asset.identity,
          path: expectedMemberPath,
          sha256: row.asset.sha256,
          bytes: row.asset.bytes,
        })
      ) {
        throw error(`${group.product}/${row.sqlName} has a stale bundle member locator`);
      }
      const extracted = path.join(verificationRoot, `${row.sqlName}.archive`);
      runToFile(
        "tar",
        ["-xOzf", carrierFile, `${carrierRoot}/${expectedMemberPath}`],
        extracted,
      );
      if (
        statSync(extracted).size !== row.rawAssetBytes
        || sha256(extracted) !== row.rawAssetSha256
      ) {
        throw error(`${group.product}/${row.sqlName} bundle member bytes drifted from the raw producer`);
      }
    }
  } finally {
    rmSync(verificationRoot, { recursive: true, force: true });
  }
  return {
    name: carrier.name,
    bytes: carrier.bytes,
    sha256: carrier.sha256,
    target: carrier.target,
    memberCount: carrier.memberCount,
  };
}

function copyExactExtensionTargetInput(sourceDirectory, target, unionRoot) {
  if (path.basename(sourceDirectory) !== target) {
    throw error(`exact extension input directory ${sourceDirectory} does not bind target ${target}`);
  }
  const destinationDirectory = path.join(unionRoot, target);
  for (const source of walkFiles(sourceDirectory)) {
    const relative = path.relative(sourceDirectory, source);
    const destination = path.join(destinationDirectory, relative);
    if (!pathInside(destinationDirectory, destination) || existsSync(destination)) {
      throw error(`exact extension input union has an escaping or duplicate ${target} member ${relative}`);
    }
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(source, destination);
    if (statSync(destination).size !== statSync(source).size || sha256(destination) !== sha256(source)) {
      throw error(`exact extension input union changed ${target}/${relative}`);
    }
  }
}

export function prepareExactCandidateExtensionBuilderIsolation(candidateOutputRoot) {
  const isolationRoot = path.join(
    candidateOutputRoot,
    "isolated-absent-wasix-extension-inputs",
  );
  const releaseAssetRoot = path.join(isolationRoot, "release-assets");
  const aotArtifactRoot = path.join(isolationRoot, "aot-artifacts");
  rmSync(isolationRoot, { recursive: true, force: true });
  mkdirSync(releaseAssetRoot, { recursive: true });
  mkdirSync(aotArtifactRoot, { recursive: true });
  return Object.freeze({
    OLIPHAUNT_WASIX_EXTENSION_RELEASE_ASSET_ROOT: releaseAssetRoot,
    OLIPHAUNT_WASIX_EXTENSION_AOT_ARTIFACT_ROOT: aotArtifactRoot,
    OLIPHAUNT_WASIX_GENERATED_ASSET_ROOT: "",
  });
}

export function stageExtensionCandidates(options, contract, inputEvidence) {
  const outputRoot = path.join(options.outputRoot, "staged-extension-candidates");
  const unionRoot = path.join(options.outputRoot, "staged-native-extension-inputs");
  const isolatedOptionalInputs = prepareExactCandidateExtensionBuilderIsolation(
    options.outputRoot,
  );
  const productGroups = exactCandidateExtensionProductGroups(contract.extensions);
  rmSync(unionRoot, { recursive: true, force: true });
  mkdirSync(unionRoot, { recursive: true });
  copyExactExtensionTargetInput(
    inputEvidence.extensionInputs.targetDirectory,
    contract.target,
    unionRoot,
  );
  copyExactExtensionTargetInput(
    inputEvidence.iosExtensionInputs.targetDirectory,
    "ios-xcframework",
    unionRoot,
  );
  run(process.execPath, [
    EXTENSION_BUILDER,
    "--all",
    "--output-root", outputRoot,
    "--require-native-target", contract.target,
    "--require-native-target", "ios-xcframework",
  ], {
    env: cleanConsumerEnv({
      OLIPHAUNT_EXTENSION_PACKAGE_PRODUCTS: productGroups.map(({ product }) => product).join(","),
      OLIPHAUNT_NATIVE_EXTENSION_RELEASE_ASSET_ROOT: unionRoot,
      ...isolatedOptionalInputs,
    }),
    timeout: 10 * 60_000,
  });
  const manifests = walkFiles(outputRoot).filter((file) => path.basename(file) === "extension-artifacts.json");
  if (manifests.length !== productGroups.length) {
    throw error(`staged extension candidates must contain ${productGroups.length} product manifests, got ${manifests.length}`);
  }
  const rawByName = new Map(
    inputEvidence.extensionInputs.artifacts.map((artifact) => [artifact.sqlName, artifact]),
  );
  const expectedByProduct = new Map(productGroups.map((group) => [group.product, group]));
  const seenProducts = new Set();
  const evidence = manifests.map((file) => {
    const manifest = JSON.parse(readFileSync(file, "utf8"));
    const group = expectedByProduct.get(manifest.product);
    if (
      group === undefined
      || seenProducts.has(manifest.product)
      || manifest.version !== group.version
    ) {
      throw error(`${file} does not identify one unique canonical exact-extension release owner`);
    }
    seenProducts.add(group.product);
    const compatibility = extensionMetadata(group.product, TOOL).compatibility;
    if (!sameJson(manifest.compatibility, compatibility)) {
      throw error(`${file} has stale extension runtime compatibility metadata`);
    }
    const bundle = group.members.length > 1;
    if (manifest.schema !== (bundle
      ? "oliphaunt-extension-ci-artifacts-v2"
      : "oliphaunt-extension-ci-artifacts-v1")) {
      throw error(`${file} has the wrong exact-extension manifest schema for ${group.product}`);
    }
    const manifestMembers = bundle ? manifest.extensions : [manifest];
    if (!Array.isArray(manifestMembers)) {
      throw error(`${file} must declare its exact extension members`);
    }
    const manifestBySqlName = new Map();
    for (const member of manifestMembers) {
      if (
        member === null
        || typeof member !== "object"
        || typeof member.sqlName !== "string"
        || manifestBySqlName.has(member.sqlName)
      ) {
        throw error(`${file} repeats or malforms an exact extension member`);
      }
      manifestBySqlName.set(member.sqlName, member);
    }
    if (!sameJson([...manifestBySqlName.keys()].sort(compareText), group.members)) {
      throw error(`${file} must cover the full exact member set for ${group.product}`);
    }
    const memberEvidence = group.extensions.map((extension) => {
      const raw = rawByName.get(extension.sqlName);
      if (raw === undefined) {
        throw error(`${file} has no same-run raw producer for ${extension.sqlName}`);
      }
      return validateStagedExtensionMember({
        member: manifestBySqlName.get(extension.sqlName),
        contract,
        extension,
        outputRoot,
        raw,
      });
    });
    let carrierEvidence;
    if (bundle) {
      const carrierTargets = Array.isArray(manifest.carrierAssets)
        ? manifest.carrierAssets.map(({ target }) => target).sort(compareText)
        : [];
      if (!sameJson(carrierTargets, [contract.target, "ios-xcframework"].sort(compareText))) {
        throw error(`${file} must stage exact ${contract.target} and iOS aggregate bundle carriers`);
      }
      const desktopCarrier = manifest.carrierAssets.find(({ target }) => target === contract.target);
      carrierEvidence = [validateStagedBundleCarrier({
        carrier: desktopCarrier,
        compatibility,
        contract,
        group,
        memberEvidence,
        outputRoot,
      })];
    } else {
      const asset = memberEvidence[0].asset;
      if (
        manifest.extensions !== undefined
        || manifest.carrierAssets !== undefined
        || asset.carrierAsset !== undefined
        || asset.carrierRoot !== undefined
        || asset.memberPath !== undefined
      ) {
        throw error(`${file} singleton manifest must expose one direct raw carrier`);
      }
      carrierEvidence = [{
        name: asset.name,
        bytes: asset.bytes,
        sha256: asset.sha256,
        target: asset.target,
        memberCount: 1,
      }];
    }
    return {
      product: group.product,
      version: group.version,
      manifestSha256: sha256(file),
      members: memberEvidence.map(({ asset: _asset, ...member }) => member),
      carrierAssets: carrierEvidence,
    };
  }).sort((left, right) => compareText(left.product, right.product));
  const coveredSqlNames = evidence.flatMap(({ members }) => members.map(({ sqlName }) => sqlName));
  const expectedSqlNames = contract.extensions.map(({ sqlName }) => sqlName).sort(compareText);
  if (
    seenProducts.size !== productGroups.length
    || coveredSqlNames.length !== contract.extensions.length
    || new Set(coveredSqlNames).size !== coveredSqlNames.length
    || !sameJson(coveredSqlNames.sort(compareText), expectedSqlNames)
  ) {
    throw error("staged extension product manifests must cover all exact SQL rows exactly once");
  }
  const iosCarrier = buildIosCarrierManifest({
    baseAssetDir: inputEvidence.iosBaseAssetDir,
    extensionManifests: manifests,
    localUrls: true,
    verifyMembers: true,
  });
  const iosSqlNames = iosCarrier.extensions.map(({ sqlName }) => sqlName).sort(compareText);
  if (!sameJson(iosSqlNames, expectedSqlNames)) {
    throw error("staged iOS carrier manifest must cover all exact SQL rows exactly once");
  }
  return {
    outputRoot,
    evidence,
    iosCarrier: {
      schema: iosCarrier.schema,
      extensionCount: iosCarrier.extensions.length,
      carrierCount: iosCarrier.carriers.length,
      sha256: sha256Bytes(JSON.stringify(iosCarrier)),
    },
  };
}

function cleanConsumerEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const name of OVERRIDE_ENV) delete env[name];
  return env;
}

export function exactCandidateRuntimeCommand(runtime, fixture) {
  if (runtime === "node") return { command: "node", args: [fixture] };
  if (runtime === "bun") return { command: "bun", args: [fixture] };
  if (runtime === "deno") {
    return {
      command: "deno",
      args: ["run", "--node-modules-dir=manual", "--allow-env", "--allow-ffi", "--allow-read", "--allow-write", "--allow-run", "--allow-net=127.0.0.1", fixture],
    };
  }
  throw error(`unknown runtime ${runtime}`);
}

export function exactCandidateJsrPortableCommand(fixture) {
  return {
    command: "deno",
    args: [
      "run",
      // JSR accepts Node-style `.js` specifiers backed by TypeScript sources.
      // This proof imports the staged package through a file URL, so opt into
      // the same resolution behavior without broadening native Deno execution.
      "--sloppy-imports",
      "--node-modules-dir=manual",
      "--allow-env",
      "--allow-read",
      "--allow-write",
      fixture,
    ],
  };
}

export function validateExactCandidateDenoPreparationReceipt(receipt, extensionCount, candidate) {
  if (
    receipt?.schemaVersion !== 1
    || !sameJson(receipt?.candidate, candidate)
    || receipt?.preparedLayout !== "explicit-deno-runtime-v2"
    || receipt?.embeddedModuleDirectory !== "lib/modules"
    || receipt?.extensionCount !== extensionCount
    || receipt?.packageManagedInput !== true
    || receipt?.moduleStaging?.policy !== "separate-embedded-modules-v1"
    || !Number.isSafeInteger(receipt?.moduleStaging?.copiedFileCount)
    || receipt.moduleStaging.copiedFileCount <= 0
  ) {
    throw error("Deno exact-candidate runtime preparation receipt is invalid");
  }
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function stopVerdaccio(
  registryRoot,
  {
    platform = process.platform,
    killProcess = process.kill,
    processExistsImpl = processExists,
    processGroupExistsImpl = (candidate) => posixProcessGroupExists(candidate, killProcess),
    taskkill = undefined,
  } = {},
) {
  const pidFile = path.join(registryRoot, "verdaccio", "verdaccio.pid");
  if (!existsSync(pidFile)) return;
  const pid = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0) {
    rmSync(pidFile, { force: true });
    return;
  }
  try {
    terminateExactCandidateProcessTree(pid, {
      platform,
      killProcess,
      processExistsImpl,
      processGroupExistsImpl,
      taskkill,
    });
  } catch (cause) {
    throw error(
      `failed to terminate the Verdaccio process tree ${pid}: ${exactCandidateErrorEvidence(cause).message}`,
    );
  }
  rmSync(pidFile, { force: true });
}

function diagnosticCandidate(relative) {
  const basename = path.basename(relative);
  return basename === "state.json"
    || basename === "current_logfiles"
    || basename === "postmaster.opts"
    || basename === "postmaster.pid"
    || /(?:^|[_.-])(?:log|stderr|stdout)(?:$|[_.-])/iu.test(basename)
    || /[.](?:log|stderr|stdout)$/iu.test(basename);
}

function boundedDiagnosticBytes(file, bytes, maxBytes) {
  const limit = Math.min(bytes, maxBytes);
  const descriptor = openSync(file, "r");
  try {
    if (bytes <= limit) {
      const buffer = Buffer.alloc(bytes);
      if (bytes > 0) readSync(descriptor, buffer, 0, bytes, 0);
      return { bytes: buffer, truncated: false };
    }
    const marker = Buffer.from("\n<OLIPHAUNT_DIAGNOSTIC_TRUNCATED>\n", "utf8");
    if (limit <= marker.length) {
      const first = Buffer.alloc(limit);
      readSync(descriptor, first, 0, limit, 0);
      return { bytes: first, truncated: true };
    }
    const available = limit - marker.length;
    const firstBytes = Math.floor(available / 2);
    const lastBytes = available - firstBytes;
    const first = Buffer.alloc(firstBytes);
    const last = Buffer.alloc(lastBytes);
    readSync(descriptor, first, 0, firstBytes, 0);
    readSync(descriptor, last, 0, lastBytes, Math.max(0, bytes - lastBytes));
    return { bytes: Buffer.concat([first, marker, last]), truncated: true };
  } finally {
    closeSync(descriptor);
  }
}

function sanitizedDiagnosticText(bytes, runRoot) {
  if (bytes.includes(0)) return undefined;
  return bytes
    .toString("utf8")
    .replaceAll(runRoot, "<RUN_ROOT>")
    .replaceAll(ROOT, "<REPOSITORY>")
    .replace(/:\/\/[^/\s:@]+:[^@\s/]+@/gu, "://<redacted>@")
    .replace(/((?:authorization|password|secret|token)\s*[=:]\s*)[^\s"']+/giu, "$1<redacted>")
    .replaceAll(/[^\t\n\r\x20-\x7e]/gu, "?");
}

export function writeBoundedExactCandidateDiagnostics({ evidenceRoot, id, result, runRoot }) {
  if (!/^[A-Za-z0-9._-]+$/u.test(id)) throw error(`diagnostic case id is not portable: ${id}`);
  const destination = path.join(evidenceRoot, "failed-case-diagnostics", id);
  mkdirSync(destination, { recursive: true });
  const candidates = [];
  let walkedEntries = 0;
  if (existsSync(runRoot)) {
    const pending = [runRoot];
    while (pending.length > 0 && walkedEntries < FAILED_DIAGNOSTIC_MAX_WALK_ENTRIES) {
      const current = pending.pop();
      for (const entry of readdirSync(current, { withFileTypes: true })
        .sort((left, right) => compareText(left.name, right.name))) {
        walkedEntries += 1;
        if (walkedEntries > FAILED_DIAGNOSTIC_MAX_WALK_ENTRIES) break;
        const file = path.join(current, entry.name);
        const relative = path.relative(runRoot, file).replaceAll(path.sep, "/");
        const metadata = lstatSync(file);
        if (metadata.isSymbolicLink()) continue;
        if (metadata.isDirectory()) pending.push(file);
        else if (metadata.isFile() && diagnosticCandidate(relative)) {
          candidates.push({ bytes: metadata.size, file, relative });
        }
      }
    }
  }
  candidates.sort((left, right) => compareText(left.relative, right.relative));

  const files = [];
  let capturedBytes = 0;
  for (const candidate of candidates) {
    if (files.length >= FAILED_DIAGNOSTIC_MAX_FILES) break;
    const remaining = FAILED_DIAGNOSTIC_MAX_TOTAL_BYTES - capturedBytes;
    if (remaining <= 0) break;
    const captureLimit = Math.min(FAILED_DIAGNOSTIC_MAX_FILE_BYTES, remaining);
    const captured = boundedDiagnosticBytes(candidate.file, candidate.bytes, captureLimit);
    let text = sanitizedDiagnosticText(captured.bytes, runRoot);
    if (text === undefined) {
      files.push({
        relativePath: candidate.relative,
        originalBytes: candidate.bytes,
        omitted: "binary",
      });
      continue;
    }
    let sanitizedTruncated = false;
    if (Buffer.byteLength(text, "utf8") > captureLimit) {
      const marker = "\n<OLIPHAUNT_SANITIZED_DIAGNOSTIC_TRUNCATED>\n";
      if (captureLimit <= Buffer.byteLength(marker, "utf8")) {
        text = text.slice(0, captureLimit);
      } else {
        const available = captureLimit - Buffer.byteLength(marker, "utf8");
        const first = Math.floor(available / 2);
        const last = available - first;
        text = `${text.slice(0, first)}${marker}${text.slice(text.length - last)}`;
      }
      sanitizedTruncated = true;
    }
    const name = `${String(files.length + 1).padStart(2, "0")}-${path.basename(candidate.relative)
      .replaceAll(/[^A-Za-z0-9._-]/gu, "_")}.txt`;
    const output = path.join(destination, name);
    writeFileSync(output, text, "utf8");
    const writtenBytes = statSync(output).size;
    capturedBytes += writtenBytes;
    files.push({
      capturedBytes: writtenBytes,
      capturedPath: name,
      originalBytes: candidate.bytes,
      relativePath: candidate.relative,
      truncated: captured.truncated || sanitizedTruncated,
    });
  }

  writeFileSync(path.join(destination, "manifest.json"), `${JSON.stringify({
    schemaVersion: 1,
    case: id,
    result: JSON.parse(sanitizedDiagnosticText(
      Buffer.from(JSON.stringify(result), "utf8"),
      runRoot,
    )),
    limits: {
      maxFiles: FAILED_DIAGNOSTIC_MAX_FILES,
      maxFileBytes: FAILED_DIAGNOSTIC_MAX_FILE_BYTES,
      maxTotalBytes: FAILED_DIAGNOSTIC_MAX_TOTAL_BYTES,
      maxWalkEntries: FAILED_DIAGNOSTIC_MAX_WALK_ENTRIES,
    },
    walkedEntries,
    discoveredCandidates: candidates.length,
    capturedBytes,
    files,
  }, null, 2)}\n`, "utf8");
}

function main(argv) {
  const consumerStartedAtMs = Date.now();
  const options = parseExactCandidateConsumerArgs(argv);
  rmSync(options.outputRoot, { recursive: true, force: true });
  const registryRoot = path.join(options.outputRoot, "registry");
  const consumerRoot = path.join(options.outputRoot, "consumer");
  const evidenceRoot = path.join(options.outputRoot, "evidence");
  mkdirSync(consumerRoot, { recursive: true });
  mkdirSync(evidenceRoot, { recursive: true });
  const statusPath = path.join(evidenceRoot, "status.json");
  const runtimeCaseResultsPath = path.join(evidenceRoot, "runtime-case-results.json");
  const immutableInputsBeforePath = path.join(evidenceRoot, "immutable-inputs-before.json");
  const immutableInputsAfterPath = path.join(evidenceRoot, "immutable-inputs-after.json");
  const immutableInputIntegrityPath = path.join(evidenceRoot, "immutable-input-integrity.json");
  const runtimeCases = exactCandidateRuntimeCases(options.target);
  const auxiliaryCases = options.target === "linux-x64-gnu"
    ? [{ runtime: "deno", engine: "jsrPortable" }]
    : [];
  const auxiliaryPhasesForCase = () => ["consume"];
  let runtimeResults = unattemptedExactCandidateSettlement(
    runtimeCases,
    "consumer-not-started",
  ).results;
  let auxiliaryResults = auxiliaryCases.length === 0
    ? []
    : unattemptedExactCandidateSettlement(
      auxiliaryCases,
      "consumer-not-started",
      { phasesForCase: auxiliaryPhasesForCase },
    ).results;
  let runtimeStopReason = { code: "consumer-not-started" };
  let auxiliaryStopReason = auxiliaryCases.length === 0
    ? undefined
    : { code: "consumer-not-started" };
  let runtimeSettlementStarted = false;
  let auxiliarySettlementFinalized = auxiliaryCases.length === 0;
  activeConsumerDeadline = createExactCandidateConsumerDeadline({
    startedAtMs: consumerStartedAtMs,
  });
  const status = {
    schemaVersion: 1,
    state: "running",
    phase: "checkout",
    candidate: { sha: options.candidateSha, tree: null },
    target: options.target,
    inputEnvelopeSha256: null,
    postRunInputEnvelopeSha256: null,
    immutableInputsUnchanged: null,
  };
  const writeStatus = () => {
    writeFileSync(statusPath, `${JSON.stringify(status, null, 2)}\n`, "utf8");
  };
  const persistCaseSettlements = () => {
    status.runtimeCaseSummary = exactCandidateSettlementSummary(runtimeResults);
    status.auxiliaryCaseSummary = exactCandidateSettlementSummary(auxiliaryResults);
    status.runtimeStopReason = runtimeStopReason ?? null;
    status.auxiliaryStopReason = auxiliaryStopReason ?? null;
    writeFileSync(runtimeCaseResultsPath, `${JSON.stringify({
      schemaVersion: 2,
      candidate: status.candidate,
      target: options.target,
      runtime: {
        summary: status.runtimeCaseSummary,
        stopReason: status.runtimeStopReason,
        results: runtimeResults,
      },
      auxiliary: {
        summary: status.auxiliaryCaseSummary,
        stopReason: status.auxiliaryStopReason,
        results: auxiliaryResults,
      },
    }, null, 2)}\n`, "utf8");
    writeStatus();
  };
  const admitConsumerPhase = (phase) => {
    status.phase = phase;
    writeStatus();
    activeConsumerDeadline.timeout(1, phase);
  };
  let immutableInputsBefore;
  let immutableInputsBeforeEvidence;
  let pendingSuccessEvidence;
  let primaryCause;
  try {
    persistCaseSettlements();
    status.phase = "capture-immutable-inputs-before";
    writeStatus();
    let immutableInputsBeforeCaptureCause;
    try {
      immutableInputsBefore = captureExactCandidateImmutableInputs(
        options.artifactRoots,
        options.iosExtensionArtifactRoot,
      );
      immutableInputsBeforeEvidence = immutableInputObservation(
        immutableInputsBefore,
        "before-consumption",
      );
    } catch (cause) {
      immutableInputsBeforeCaptureCause = cause;
      immutableInputsBeforeEvidence = unreadableImmutableInputObservation(
        "before-consumption",
        cause,
      );
    }
    let immutableInputsBeforePersistenceCause;
    try {
      writeFileSync(
        immutableInputsBeforePath,
        `${JSON.stringify(immutableInputsBeforeEvidence, null, 2)}\n`,
        "utf8",
      );
    } catch (cause) {
      immutableInputsBeforePersistenceCause = cause;
    }
    const immutableInputsBeforeCause = aggregateExactCandidateErrors(
      "before-consumption immutable candidate input capture failed",
      [immutableInputsBeforeCaptureCause, immutableInputsBeforePersistenceCause],
    );
    if (immutableInputsBeforeCause !== undefined) throw immutableInputsBeforeCause;
    status.inputEnvelopeSha256 = immutableInputsBefore.envelopeSha256;
    status.inputArtifactCount = immutableInputsBefore.fileCount;
    status.inputArtifactBytes = immutableInputsBefore.totalBytes;

    const contract = exactCandidateTargetContract(options.target);
    if (currentHostTarget() !== options.target) {
      throw error(`runner host maps to ${currentHostTarget() ?? "unsupported"}, not requested target ${options.target}`);
    }
    const checkoutSha = run("git", ["rev-parse", "HEAD"], { capture: true });
    if (checkoutSha !== options.candidateSha) {
      throw error(`checkout SHA ${checkoutSha} does not match candidate ${options.candidateSha}`);
    }
    const candidateTree = run("git", ["rev-parse", "HEAD^{tree}"], { capture: true });
    status.candidate.tree = candidateTree;
    admitConsumerPhase("inspect-inputs");
    const inputEvidence = inspectCandidateInputs(
      options.artifactRoots,
      options.iosExtensionArtifactRoot,
      contract,
    );
    assertExactCandidateImmutableInputsUnchanged(
      immutableInputsBefore,
      inputEvidence.immutableInputSnapshot,
    );
    const inputEnvelopeSha256 = immutableInputsBefore.envelopeSha256;
    admitConsumerPhase("stage-extensions");
    const stagedExtensions = stageExtensionCandidates(options, contract, inputEvidence);
    status.stagedExtensionEnvelopeSha256 = sha256Bytes(JSON.stringify({
      products: stagedExtensions.evidence,
      iosCarrier: stagedExtensions.iosCarrier,
    }));
    admitConsumerPhase("publish-local-registry");
    const publishArgs = [
      path.join(ROOT, "tools/release/local-registry-publish.mjs"),
      "publish",
      "--surface", "npm",
      "--strict",
      "--ios-base-asset-dir", inputEvidence.iosBaseAssetDir,
      "--verdaccio-port", String(options.port),
      "--registry-root", registryRoot,
      ...[...options.artifactRoots, stagedExtensions.outputRoot]
        .flatMap((root) => ["--artifact-root", root]),
    ];
    run(process.execPath, publishArgs, { timeout: 30 * 60_000 });
    const registryUrl = readFileSync(path.join(registryRoot, "verdaccio", "registry-url.txt"), "utf8").trim().replace(/\/$/u, "");
    const npmrc = path.join(registryRoot, "verdaccio", "npmrc");
    writeFileSync(path.join(consumerRoot, "package.json"), `${JSON.stringify({
      name: "oliphaunt-js-exact-candidate-consumer",
      private: true,
      type: "module",
      dependencies: contract.packages,
    }, null, 2)}\n`, "utf8");
    admitConsumerPhase("install-exact-packages");
    run("npm", [
      "install",
      "--ignore-scripts",
      "--audit=false",
      "--fund=false",
      "--fetch-retries=0",
      "--registry", registryUrl,
      "--userconfig", npmrc,
    ], { cwd: consumerRoot, timeout: 15 * 60_000 });
    const lock = JSON.parse(readFileSync(path.join(consumerRoot, "package-lock.json"), "utf8"));
    assertExactInstalledPackages({ lock, consumerRoot, registryUrl, expectedPackages: contract.packages });
    assertExtensionPackageManifests(consumerRoot, contract);
    const installedPackages = installedPackageEvidence({
      lock,
      consumerRoot,
      expectedPackages: contract.packages,
    });

    const runtimeFixture = path.join(consumerRoot, "exact-candidate-runtime.mjs");
    copyFileSync(RUNTIME_FIXTURE, runtimeFixture);
    copyFileSync(
      PROCSIGNAL_FIXTURE,
      path.join(consumerRoot, "js-exact-candidate-procsignal.mjs"),
    );
    const extensionContractPath = path.join(consumerRoot, "exact-extension-contract.json");
    const extensionContract = {
      schemaVersion: 1,
      candidate: { sha: options.candidateSha, tree: candidateTree },
      target: options.target,
      extensions: contract.extensions.map((extension) => ({
        product: extension.product,
        version: extension.version,
        sqlName: extension.sqlName,
        createsExtension: extension.createsExtension,
        loadSql: extension.loadSql,
      })),
    };
    writeFileSync(extensionContractPath, `${JSON.stringify(extensionContract, null, 2)}\n`, "utf8");
    const denoPreparationFixture = path.join(
      consumerRoot,
      "exact-candidate-prepare-deno-runtime.mjs",
    );
    copyFileSync(DENO_RUNTIME_PREPARATION_FIXTURE, denoPreparationFixture);
    const denoPreparedRuntime = path.join(options.outputRoot, "prepared", "deno-runtime");
    const denoPreparationReceiptPath = path.join(
      evidenceRoot,
      "deno-prepared-runtime.json",
    );
    admitConsumerPhase("prepare-deno-extension-runtime");
    run("node", [denoPreparationFixture], {
      cwd: consumerRoot,
      timeout: 15 * 60_000,
      env: cleanConsumerEnv({
        TMPDIR: path.join(options.outputRoot, "tmp", "deno-preparation"),
        TMP: path.join(options.outputRoot, "tmp", "deno-preparation"),
        TEMP: path.join(options.outputRoot, "tmp", "deno-preparation"),
        OLIPHAUNT_CONSUMER_EXTENSION_CONTRACT: extensionContractPath,
        OLIPHAUNT_CONSUMER_PREPARED_RUNTIME: denoPreparedRuntime,
        OLIPHAUNT_CONSUMER_PREPARED_RUNTIME_RECEIPT: denoPreparationReceiptPath,
      }),
    });
    const denoPreparation = JSON.parse(readFileSync(denoPreparationReceiptPath, "utf8"));
    validateExactCandidateDenoPreparationReceipt(
      denoPreparation,
      contract.extensions.length,
      extensionContract.candidate,
    );
    const runtimeCaseContexts = new Map();
    runtimeSettlementStarted = true;
    runtimeStopReason = undefined;
    runtimeResults = completeExactCandidateResults(
      runtimeCases,
      [],
      "pending-runtime-settlement",
    );
    persistCaseSettlements();
    const runtimeSettlement = executeExactCandidateRuntimeCasesFailLate(
      runtimeCases,
      {
        beforePhase(_testCase, phase, id) {
          return activeConsumerDeadline.timeout(
            RUNTIME_CASE_TIMEOUT_MS,
            `runtime:${id}:${phase}`,
          );
        },
        executePhase(testCase, phase, id) {
          let context = runtimeCaseContexts.get(id);
          if (context === undefined) {
            const receipt = path.join(evidenceRoot, `${id}.json`);
            const progress = path.join(evidenceRoot, `${id}.progress.jsonl`);
            const runRoot = path.join(options.outputRoot, "runs", id);
            const temporary = path.join(options.outputRoot, "tmp", id);
            mkdirSync(temporary, { recursive: true });
            context = {
              receipt,
              progress,
              runRoot,
              temporary,
              invocation: exactCandidateRuntimeCommand(testCase.runtime, runtimeFixture),
            };
            runtimeCaseContexts.set(id, context);
          }

          status.phase = `runtime:${id}:${phase}`;
          writeStatus();
          run(context.invocation.command, context.invocation.args, {
            cwd: consumerRoot,
            timeout: RUNTIME_CASE_TIMEOUT_MS,
            env: cleanConsumerEnv({
              TMPDIR: context.temporary,
              TMP: context.temporary,
              TEMP: context.temporary,
              OLIPHAUNT_CANDIDATE_SHA: options.candidateSha,
              OLIPHAUNT_CANDIDATE_TREE: candidateTree,
              OLIPHAUNT_CONSUMER_RUNTIME: testCase.runtime,
              OLIPHAUNT_CONSUMER_ENGINE: testCase.engine,
              OLIPHAUNT_CONSUMER_EXTENSION_CONTRACT: extensionContractPath,
              OLIPHAUNT_CONSUMER_PHASE: phase,
              OLIPHAUNT_CONSUMER_RUN_ROOT: context.runRoot,
              OLIPHAUNT_CONSUMER_RECEIPT: context.receipt,
              OLIPHAUNT_CONSUMER_PROGRESS: context.progress,
              ...(testCase.runtime === "deno"
                ? { OLIPHAUNT_CONSUMER_RUNTIME_DIRECTORY: denoPreparedRuntime }
                : {}),
            }),
          });
        },
        readReceipt(_testCase, id) {
          return JSON.parse(readFileSync(runtimeCaseContexts.get(id).receipt, "utf8"));
        },
        onResult(result, results) {
          const reason = exactCandidatePendingSettlementReason(
            result,
            "pending-runtime-settlement",
          );
          if (reason !== "pending-runtime-settlement" && runtimeStopReason === undefined) {
            runtimeStopReason = {
              code: reason,
              id: result.id,
              phase: result.phase ?? "not-started",
              error: result.error,
            };
          }
          runtimeResults = completeExactCandidateResults(runtimeCases, results, reason);
          persistCaseSettlements();
        },
        cleanupCase(_testCase, id, result) {
          const context = runtimeCaseContexts.get(id);
          if (context === undefined) return;
          const cleanupCauses = [];
          if (result.state === "failed") {
            try {
              writeBoundedExactCandidateDiagnostics({
                evidenceRoot,
                id,
                result,
                runRoot: context.runRoot,
              });
            } catch (cause) {
              cleanupCauses.push(cause);
            }
          }
          try {
            removeExactCandidateRunRoot(context.runRoot, result);
          } catch (cause) {
            cleanupCauses.push(cause);
          }
          const cleanupCause = aggregateExactCandidateErrors(
            `${id} diagnostic capture and run-root cleanup failed`,
            cleanupCauses,
          );
          if (cleanupCause !== undefined) throw cleanupCause;
        },
      },
    );
    runtimeResults = completeExactCandidateResults(
      runtimeCases,
      runtimeSettlement.results,
      runtimeSettlement.stopReason?.code ?? "runtime-settlement-incomplete",
    );
    runtimeStopReason = runtimeSettlement.stopReason;
    persistCaseSettlements();

    let jsrReceipt = null;
    let auxiliarySettlement;
    if (auxiliaryCases.length > 0 && runtimeSettlement.stopReason !== undefined) {
      auxiliarySettlementFinalized = true;
      auxiliaryStopReason = {
        code: "unsafe-continuation-after-runtime-stop",
        upstream: runtimeSettlement.stopReason,
      };
      auxiliarySettlement = unattemptedExactCandidateSettlement(
        auxiliaryCases,
        auxiliaryStopReason.code,
        { phasesForCase: auxiliaryPhasesForCase },
      );
      auxiliaryResults = auxiliarySettlement.results;
      persistCaseSettlements();
    } else if (auxiliaryCases.length > 0) {
      auxiliarySettlementFinalized = true;
      auxiliaryStopReason = undefined;
      auxiliaryResults = completeExactCandidateResults(
        auxiliaryCases,
        [],
        "pending-auxiliary-settlement",
        { phasesForCase: auxiliaryPhasesForCase },
      );
      persistCaseSettlements();
      const fixture = path.join(consumerRoot, "exact-candidate-jsr.mjs");
      const receipt = path.join(evidenceRoot, "deno-jsr-portable.json");
      auxiliarySettlement = executeExactCandidateRuntimeCasesFailLate(auxiliaryCases, {
        phasesForCase: auxiliaryPhasesForCase,
        beforePhase(_testCase, phase, id) {
          return activeConsumerDeadline.timeout(
            JSR_CASE_TIMEOUT_MS,
            `auxiliary:${id}:${phase}`,
          );
        },
        executePhase(_testCase, _phase, id) {
          status.phase = `auxiliary:${id}:consume`;
          writeStatus();
          copyFileSync(JSR_FIXTURE, fixture);
          const invocation = exactCandidateJsrPortableCommand(fixture);
          run(invocation.command, invocation.args, {
            cwd: consumerRoot,
            timeout: JSR_CASE_TIMEOUT_MS,
            env: cleanConsumerEnv({
              OLIPHAUNT_CANDIDATE_SHA: options.candidateSha,
              OLIPHAUNT_CANDIDATE_TREE: candidateTree,
              OLIPHAUNT_JSR_SOURCE_ROOT: inputEvidence.jsrSourceRoot,
              OLIPHAUNT_CONSUMER_RECEIPT: receipt,
            }),
          });
        },
        readReceipt() {
          return JSON.parse(readFileSync(receipt, "utf8"));
        },
        onResult(result, results) {
          const reason = exactCandidatePendingSettlementReason(
            result,
            "pending-auxiliary-settlement",
          );
          if (reason !== "pending-auxiliary-settlement" && auxiliaryStopReason === undefined) {
            auxiliaryStopReason = {
              code: reason,
              id: result.id,
              phase: result.phase ?? "not-started",
              error: result.error,
            };
          }
          auxiliaryResults = completeExactCandidateResults(
            auxiliaryCases,
            results,
            reason,
            { phasesForCase: auxiliaryPhasesForCase },
          );
          persistCaseSettlements();
        },
      });
      auxiliaryResults = completeExactCandidateResults(
        auxiliaryCases,
        auxiliarySettlement.results,
        auxiliarySettlement.stopReason?.code ?? "auxiliary-settlement-incomplete",
        { phasesForCase: auxiliaryPhasesForCase },
      );
      auxiliaryStopReason = auxiliarySettlement.stopReason;
      persistCaseSettlements();
      jsrReceipt = auxiliarySettlement.receipts[0] ?? null;
    }

    const combinedSettlement = combineExactCandidateSettlements(
      runtimeSettlement,
      auxiliarySettlement,
    );
    if (combinedSettlement.failures.length > 0) {
      throw error(
        `exact-candidate runtime or auxiliary cases failed: ${exactCandidateRuntimeFailureMessage(combinedSettlement.failures)}`,
      );
    }
    const receipts = runtimeSettlement.receipts;

    const versions = Object.fromEntries(
      [...new Set(runtimeCases.map((entry) => entry.runtime))]
        .map((runtime) => [runtime, run(runtime, ["--version"], { capture: true }).split(/\r?\n/u)[0]]),
    );
    pendingSuccessEvidence = {
      schemaVersion: 2,
      candidate: { sha: options.candidateSha, tree: candidateTree },
      target: options.target,
      runner: { platform: process.platform, arch: process.arch, release: os.release() },
      contract,
      inputEnvelopeSha256,
      inputArtifacts: inputEvidence.files,
      extensionInputs: inputEvidence.extensionInputs,
      iosBaseInput: inputEvidence.iosBaseInput,
      stagedExtensions: stagedExtensions.evidence,
      packageLockSha256: sha256(path.join(consumerRoot, "package-lock.json")),
      installedPackages,
      extensionPackageCount: installedPackages.filter((entry) =>
        entry.name.startsWith("@oliphaunt/extension-"),
      ).length,
      denoPreparation,
      runtimeVersions: versions,
      runtimeCases: receipts,
      jsrPortableCase: jsrReceipt,
    };
  } catch (cause) {
    primaryCause = cause;
    status.primaryFailurePhase = status.phase;
    const detail = exactCandidateErrorEvidence(cause);
    const unattemptedReason = detail.deadlineExceeded === true
      ? "consumer-deadline-before-runtime"
      : detail.timedOut === true
        ? "consumer-command-timeout-before-runtime"
        : "consumer-prerequisite-failed";
    if (!runtimeSettlementStarted) {
      runtimeResults = unattemptedExactCandidateSettlement(
        runtimeCases,
        unattemptedReason,
      ).results;
      runtimeStopReason = { code: unattemptedReason, error: detail };
    }
    if (!auxiliarySettlementFinalized) {
      auxiliaryResults = unattemptedExactCandidateSettlement(
        auxiliaryCases,
        unattemptedReason,
        { phasesForCase: auxiliaryPhasesForCase },
      ).results;
      auxiliaryStopReason = { code: unattemptedReason, error: detail };
    }
    status.state = "failed";
    try {
      status.primaryError = detail;
      status.error = detail;
      persistCaseSettlements();
    } catch (persistenceCause) {
      primaryCause = aggregateExactCandidateErrors(
        "exact-candidate failure and final settlement persistence failed",
        [primaryCause, persistenceCause],
      );
    }
  }

  let cleanupCause;
  try {
    stopVerdaccio(registryRoot);
  } catch (cause) {
    cleanupCause = cause;
    status.state = "failed";
    status.cleanupError = exactCandidateErrorEvidence(cause);
    if (primaryCause === undefined) status.phase = "cleanup-local-registry";
  }
  activeConsumerDeadline = undefined;

  status.phase = "verify-immutable-inputs";
  let immutableInputProof;
  let immutableInputProofCause;
  try {
    immutableInputProof = persistExactCandidateImmutableInputPostRunProof({
      artifactRoots: options.artifactRoots,
      iosExtensionArtifactRoot: options.iosExtensionArtifactRoot,
      beforeSnapshot: immutableInputsBefore,
      beforeEvidence: immutableInputsBeforeEvidence,
      afterPath: immutableInputsAfterPath,
      integrityPath: immutableInputIntegrityPath,
    });
  } catch (cause) {
    immutableInputProofCause = cause;
    status.immutableInputProofError = exactCandidateErrorEvidence(cause);
    immutableInputProof = {
      afterSnapshot: cause.immutableInputAfterSnapshot,
      integrity: cause.immutableInputIntegrity,
    };
  }
  if (immutableInputProof?.afterSnapshot !== undefined) {
    status.postRunInputEnvelopeSha256 = immutableInputProof.afterSnapshot.envelopeSha256;
    status.postRunInputArtifactCount = immutableInputProof.afterSnapshot.fileCount;
    status.postRunInputArtifactBytes = immutableInputProof.afterSnapshot.totalBytes;
  }
  status.immutableInputsUnchanged = immutableInputProof?.integrity?.unchanged ?? false;

  let finalCause = aggregateExactCandidateErrors(
    "exact-candidate consumer, local-registry cleanup, or immutable-input proof failed",
    [primaryCause, cleanupCause, immutableInputProofCause],
  );
  if (finalCause === undefined) {
    try {
      if (pendingSuccessEvidence === undefined) {
        throw error("exact-candidate workload completed without pending success evidence");
      }
      const evidence = {
        ...pendingSuccessEvidence,
        immutableInputIntegrity: immutableInputProof.integrity,
        immutableInputEvidence: {
          before: path.basename(immutableInputsBeforePath),
          after: path.basename(immutableInputsAfterPath),
          integrity: path.basename(immutableInputIntegrityPath),
        },
      };
      writeFileSync(
        path.join(evidenceRoot, "exact-candidate.json"),
        `${JSON.stringify(evidence, null, 2)}\n`,
        "utf8",
      );
      copyFileSync(
        path.join(consumerRoot, "package-lock.json"),
        path.join(evidenceRoot, "package-lock.json"),
      );
      copyFileSync(
        path.join(registryRoot, "report.json"),
        path.join(evidenceRoot, "local-registry-report.json"),
      );
      status.state = "passed";
      status.phase = "complete";
      status.receiptSha256 = sha256(path.join(evidenceRoot, "exact-candidate.json"));
    } catch (cause) {
      finalCause = cause;
      status.state = "failed";
      status.phase = "finalize-evidence";
      status.finalizationError = exactCandidateErrorEvidence(cause);
      status.error = status.finalizationError;
    }
  } else {
    status.state = "failed";
    status.phase = status.primaryFailurePhase
      ?? (cleanupCause === undefined ? "verify-immutable-inputs" : "cleanup-local-registry");
    status.error = exactCandidateErrorEvidence(finalCause);
  }
  try {
    writeStatus();
  } catch (statusCause) {
    finalCause = aggregateExactCandidateErrors(
      "exact-candidate failure and final status persistence failed",
      [finalCause, statusCause],
    );
  }
  if (finalCause !== undefined) throw finalCause;
}

if (import.meta.main) {
  if (
    Bun.argv.length === 3
    && Bun.argv[2] === "--windows-standard-user-module-load-proof"
  ) {
    try {
      const contract = exactCandidateTargetContract("windows-x64-msvc");
      if (contract.extensions.length === 0 || Object.keys(contract.packages).length === 0) {
        throw error("Windows standard-user module-load proof resolved an empty contract");
      }
      console.log(
        `${WINDOWS_STANDARD_USER_MODULE_LOAD_PROOF}\t${windowsStandardUserControlReadSetSha256()}`,
      );
    } catch (cause) {
      console.error(cause instanceof Error ? cause.message : String(cause));
      process.exit(1);
    }
  } else {
    try {
      main(Bun.argv.slice(2));
    } catch (cause) {
      console.error(cause instanceof Error ? cause.message : String(cause));
      process.exit(1);
    }
  }
}
