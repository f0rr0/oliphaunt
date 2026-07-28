#!/usr/bin/env bun

import { existsSync, lstatSync, readFileSync } from "node:fs";
import path from "node:path";

import { captureCommandOutput } from "../../dev/capture-command-output.mjs";

const TOOL = "assert-ambient-js-tools.mjs";

// These entrypoints are coupled to setup-npm-publisher by workflow semantics.
// All product builders and ordinary checks use the workspace's pinned pnpm.
export const VERIFIED_NPM_COMMAND_FILES = new Set([
  "tools/release/frozen-npm-publish.mjs",
  "tools/release/js-exact-candidate-consumer.mjs",
  "tools/release/public-consumer-smoke.mjs",
  "tools/release/trusted-publisher-config.mjs",
]);

const COMMAND_SOURCE_SUFFIX = /[.](?:bash|cjs|js|json|mjs|ps1|py|rs|sh|ts|tsx|yaml|yml|zsh)$/u;
const TEST_OR_FIXTURE_PATH = /(?:^|\/)(?:__fixtures__|__tests__|fixtures|testdata)\/|[.](?:spec|test)[.]/u;
const JAVASCRIPT_SOURCE_SUFFIX = /[.](?:cjs|js|mjs|ts|tsx)$/u;
const SHELL_SOURCE_SUFFIX = /[.](?:bash|ps1|sh|yaml|yml|zsh)$/u;

const ASSIGNMENTS = String.raw`(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s;&|()]+)[ \t]+)*`;
const LAUNCHER = String.raw`(?:(?:command|exec)(?:[ \t]+--)?[ \t]+|(?:sudo|xargs)(?:[ \t]+-[A-Za-z]+)*[ \t]+|env[ \t]+(?:--?[A-Za-z0-9_-]+(?:=[^ \t\r\n]+)?[ \t]+)*)?`;
const SHELL_COMMAND = new RegExp(
  String.raw`(?:^[ \t]*|[;&|][ \t]*|\$\([ \t]*|\brun:[ \t]*)${LAUNCHER}${ASSIGNMENTS}(npm|npx)(?=[ \t\r\n]|$)`,
  "gmu",
);
const SIMPLE_POWERSHELL_HASHTABLE = /(^[ \t]*\$[A-Za-z_][A-Za-z0-9_]*[ \t]*=[ \t]*(?:\[ordered\][ \t]*)?@\{[ \t]*(?:#[^\r\n]*)?\r?\n)((?:^[ \t]+(?:[A-Za-z_][A-Za-z0-9_]*|'[^'\r\n]+'|"[^"\r\n]+")[ \t]*=[ \t]*\$[A-Za-z_][A-Za-z0-9_]*[ \t]*(?:#[^\r\n]*)?\r?\n)+)(^[ \t]*\}[ \t]*(?:#[^\r\n]*)?$)/gmu;
const SHELL_PNPM_COMMAND = new RegExp(
  String.raw`(?:^[ \t]*|[;&|][ \t]*|\$\([ \t]*|\brun:[ \t]*)${LAUNCHER}${ASSIGNMENTS}pnpm(?=[ \t])([^\r\n;&|]*)`,
  "gmu",
);
const JS_COMMAND_PATTERNS = [
  /\b(?:commandJson|commandOutput|commandResult|exec|execFile|execFileSync|execSync|execa|execaCommand|execaSync|run|runBoundedCommand|runCommand|runNpmPublishCommand|runQuiet|runSync|spawn|spawnImpl|spawnSync|tryCommandOutput)\s*\(\s*(?:\[\s*)?["'`](npm|npx)["'`]/gmu,
  /\b(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*\[\s*["'`](npm|npx)["'`]/gmu,
  /\bnew\s+Deno[.]Command\s*\(\s*["'`](npm|npx)["'`]/gmu,
  /\bBun[.]spawn(?:Sync)?\s*\(\s*(?:\[\s*)?["'`](npm|npx)["'`]/gmu,
  /\$\s*`[ \t]*(npm|npx)(?=[ \t\r\n])/gmu,
];
const JS_LAUNCHER_NAMES = String.raw`(?:commandJson|commandOutput|commandResult|exec|execFile|execFileSync|execSync|execa|execaCommand|execaSync|run|runBoundedCommand|runCommand|runNpmPublishCommand|runOrThrow|runQuiet|runSync|spawn|spawnImpl|spawnSync|tryCommandOutput)`;
const JS_DIRECT_BUN_SHELL_PATTERNS = [
  new RegExp(
    String.raw`\b${JS_LAUNCHER_NAMES}\s*\(\s*(?:\[\s*)?["'\x60]tools/dev/bun[.]sh["'\x60]`,
    "gmu",
  ),
  new RegExp(
    String.raw`\b${JS_LAUNCHER_NAMES}\s*\(\s*[^,\r\n]+,\s*\[\s*["'\x60]tools/dev/bun[.]sh["'\x60]`,
    "gmu",
  ),
  /\b(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*\[\s*["'`]tools\/dev\/bun[.]sh["'`]/gmu,
  /\breturn\s*\[\s*["'`]tools\/dev\/bun[.]sh["'`]/gmu,
  new RegExp(
    String.raw`\b${JS_LAUNCHER_NAMES}\s*\(\s*path[.]join\s*\([^\r\n)]*["'\x60]tools/dev/bun[.]sh["'\x60][^\r\n)]*\)`,
    "gmu",
  ),
];
const PYTHON_COMMAND = /\bsubprocess[.](?:call|check_call|check_output|Popen|run)\s*\(\s*(?:\[\s*)?["'](npm|npx)["']/gmu;
const RUST_COMMAND = /\bCommand::new\s*\(\s*"(npm|npx)"/gmu;
const JS_PNPM_DLX_PATTERNS = [
  /\b(?:commandJson|commandOutput|commandResult|exec|execFile|execFileSync|execSync|execa|execaCommand|execaSync|run|runBoundedCommand|runCommand|runQuiet|runSync|spawn|spawnSync|tryCommandOutput)\s*\(\s*["'`]pnpm["'`]\s*,\s*\[\s*["'`]dlx["'`]\s*,\s*["'`]([^"'`]+)["'`]/gmu,
  /\bBun[.]spawn(?:Sync)?\s*\(\s*\[\s*["'`]pnpm["'`]\s*,\s*["'`]dlx["'`]\s*,\s*["'`]([^"'`]+)["'`]/gmu,
  /\b(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*\[\s*["'`]pnpm["'`]\s*,\s*["'`]dlx["'`]\s*,\s*["'`]([^"'`]+)["'`]/gmu,
];
const EXACT_PACKAGE_SPEC = /^(?:@[^/@\s]+\/[^/@\s]+|[^@/\s]+)@[0-9]+[.][0-9]+[.][0-9]+(?:-[0-9A-Za-z.-]+)?$/u;

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function lineNumber(text, offset) {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (text.charCodeAt(index) === 10) line += 1;
  }
  return line;
}

function collectMatches(text, pattern, kind, findings) {
  pattern.lastIndex = 0;
  for (const match of text.matchAll(pattern)) {
    findings.push({
      tool: match[1],
      line: lineNumber(text, match.index ?? 0),
      kind,
    });
  }
}

function maskSimplePowerShellHashtableCommandKeys(text) {
  SIMPLE_POWERSHELL_HASHTABLE.lastIndex = 0;
  return text.replace(
    SIMPLE_POWERSHELL_HASHTABLE,
    (_block, opening, entries, closing) => opening + entries.replace(
      /^([ \t]*)(npm|npx)(?=[ \t]*=)/gmu,
      (_entry, indentation, tool) => indentation + " ".repeat(tool.length),
    ) + closing,
  );
}

function unquotedToken(value) {
  const token = value.trim();
  if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
    return token.slice(1, -1);
  }
  return token;
}

function collectMutableShellDlx(text, kind, findings) {
  SHELL_PNPM_COMMAND.lastIndex = 0;
  for (const match of text.matchAll(SHELL_PNPM_COMMAND)) {
    const args = match[1];
    const dlx = /(?:^|[ \t])dlx[ \t]+((?:"[^"\r\n]+"|'[^'\r\n]+'|[^ \t\\]+))/u.exec(args);
    if (dlx === null) continue;
    const exactPackages = [...args.matchAll(/--package(?:=|[ \t]+)((?:"[^"\r\n]+"|'[^'\r\n]+'|[^ \t\\]+))/gu)]
      .map((candidate) => unquotedToken(candidate[1]));
    const spec = unquotedToken(dlx[1]);
    if (exactPackages.some((candidate) => EXACT_PACKAGE_SPEC.test(candidate)) || EXACT_PACKAGE_SPEC.test(spec)) {
      continue;
    }
    findings.push({
      tool: "pnpm-dlx",
      spec,
      line: lineNumber(text, match.index ?? 0),
      kind,
    });
  }
}

function collectMutableJavaScriptDlx(text, findings) {
  for (const pattern of JS_PNPM_DLX_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      if (EXACT_PACKAGE_SPEC.test(match[1])) continue;
      findings.push({
        tool: "pnpm-dlx",
        spec: match[1],
        line: lineNumber(text, match.index ?? 0),
        kind: "process launch",
      });
    }
  }
}

function collectDirectBunShellLaunches(text, findings) {
  for (const pattern of JS_DIRECT_BUN_SHELL_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      findings.push({
        tool: "bun-shell-wrapper",
        line: lineNumber(text, match.index ?? 0),
        kind: "process launch",
      });
    }
  }
}

function packageScriptFindings(file, text, findings) {
  if (!file.endsWith("/package.json") && file !== "package.json") return;
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch {
    return;
  }
  if (manifest?.scripts === null || typeof manifest?.scripts !== "object" || Array.isArray(manifest.scripts)) {
    return;
  }
  let searchOffset = 0;
  for (const command of Object.values(manifest.scripts)) {
    if (typeof command !== "string") continue;
    const scriptFindings = [];
    collectMatches(command, SHELL_COMMAND, "package script", scriptFindings);
    collectMutableShellDlx(command, "package script", scriptFindings);
    const commandOffset = text.indexOf(command, searchOffset);
    if (commandOffset >= 0) searchOffset = commandOffset + command.length;
    for (const finding of scriptFindings) {
      findings.push({
        ...finding,
        line: commandOffset < 0 ? 1 : lineNumber(text, commandOffset),
      });
    }
  }
}

export function isCommandSourcePath(file) {
  return COMMAND_SOURCE_SUFFIX.test(file) && !TEST_OR_FIXTURE_PATH.test(file);
}

export function findJsToolCommandInvocations(file, text) {
  if (!isCommandSourcePath(file)) return [];
  const findings = [];
  if (SHELL_SOURCE_SUFFIX.test(file)) {
    const shellText = file.endsWith(".ps1")
      ? maskSimplePowerShellHashtableCommandKeys(text)
      : text;
    collectMatches(shellText, SHELL_COMMAND, "shell command", findings);
    collectMutableShellDlx(shellText, "shell command", findings);
  }
  if (JAVASCRIPT_SOURCE_SUFFIX.test(file)) {
    for (const pattern of JS_COMMAND_PATTERNS) {
      collectMatches(text, pattern, "process launch", findings);
    }
    collectMutableJavaScriptDlx(text, findings);
    collectDirectBunShellLaunches(text, findings);
  }
  if (file.endsWith(".py")) collectMatches(text, PYTHON_COMMAND, "process launch", findings);
  if (file.endsWith(".rs")) collectMatches(text, RUST_COMMAND, "process launch", findings);
  packageScriptFindings(file, text, findings);
  return findings.filter((finding, index, all) =>
    all.findIndex((candidate) => candidate.tool === finding.tool && candidate.line === finding.line) === index);
}

export function ambientJsToolViolations(sources, {
  verifiedNpmCommandFiles = VERIFIED_NPM_COMMAND_FILES,
} = {}) {
  const violations = [];
  for (const { file, text } of sources) {
    for (const finding of findJsToolCommandInvocations(file, text)) {
      if (finding.tool === "npm" && verifiedNpmCommandFiles.has(file)) continue;
      violations.push({ file, ...finding });
    }
  }
  return violations.sort((left, right) =>
    compareText(left.file, right.file) || left.line - right.line || compareText(left.tool, right.tool));
}

export function staleVerifiedNpmCommandFiles(sources, {
  verifiedNpmCommandFiles = VERIFIED_NPM_COMMAND_FILES,
} = {}) {
  const sourceByFile = new Map(sources.map((source) => [source.file, source.text]));
  return [...verifiedNpmCommandFiles]
    .filter((file) => {
      const text = sourceByFile.get(file);
      return text === undefined
        || !findJsToolCommandInvocations(file, text).some(({ tool }) => tool === "npm");
    })
    .sort();
}

function git(root, args) {
  const nulInventory = args.includes("-z");
  const result = captureCommandOutput("git", args, {
    allowEmptyOutput: nulInventory,
    cwd: root,
    label: `git ${args.join(" ")}`,
    stdoutTerminator: nulInventory ? "\0" : undefined,
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(result.error?.message ?? (result.stderr.trim() || `git ${args.join(" ")} failed`));
  }
  return result.stdout;
}

export function repositoryCommandSources(root) {
  const files = git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"])
    .split("\0")
    .filter(Boolean)
    .filter(isCommandSourcePath)
    .sort();
  return files.flatMap((file) => {
    const absolute = path.join(root, file);
    if (!existsSync(absolute) || !lstatSync(absolute).isFile()) return [];
    return [{ file, text: readFileSync(absolute, "utf8") }];
  });
}

function workspaceRoot() {
  const result = captureCommandOutput("git", ["rev-parse", "--show-toplevel"], {
    label: "git rev-parse --show-toplevel",
  });
  if (result.error !== undefined || result.status !== 0 || !result.stdout.trim()) {
    throw new Error("must run inside the Oliphaunt git checkout");
  }
  return result.stdout.trim();
}

function main() {
  const root = workspaceRoot();
  const sources = repositoryCommandSources(root);
  const staleVerifiedFiles = staleVerifiedNpmCommandFiles(sources);
  if (staleVerifiedFiles.length > 0) {
    throw new Error(
      `verified npm command inventory contains missing or inactive paths: ${staleVerifiedFiles.join(", ")}`,
    );
  }
  const violations = ambientJsToolViolations(sources);
  if (violations.length > 0) {
    const details = violations.map(({ file, line, tool, kind, spec }) => tool === "pnpm-dlx"
      ? `${file}:${line}: ${kind} resolves mutable pnpm dlx package ${spec}`
      : tool === "bun-shell-wrapper"
        ? `${file}:${line}: ${kind} launches tools/dev/bun.sh directly instead of process.execPath`
      : `${file}:${line}: ${kind} invokes ambient ${tool}`).join("\n");
    throw new Error(
      `ambient JavaScript CLI boundary failed:\n${details}\n`
      + "Use process.execPath for nested Bun programs and pinned pnpm for builds and checks. npm is permitted only in entrypoints coupled to the verified npm setup action; npx and mutable pnpm dlx packages are forbidden.",
    );
  }
  console.log("ambient JavaScript CLI boundary passed");
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    console.error(`${TOOL}: ${error.message ?? String(error)}`);
    process.exit(1);
  }
}
