import { spawnSync } from "node:child_process";
import {
  accessSync,
  constants as fsConstants,
  cpSync,
  mkdirSync,
  readdirSync,
  statSync,
} from "node:fs";
import path from "node:path";

import { captureCommandOutput } from "../../dev/capture-command-output.mjs";

export const ROOT = path.resolve(import.meta.dir, "../../..");
export const BUN = process.execPath;

const PREFIX = "build-sdk-ci-artifacts.mjs";

export function fail(message) {
  console.error(`${PREFIX}: ${message}`);
  process.exit(1);
}

export function rel(file) {
  const relative = path.relative(ROOT, String(file));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return String(file).split(path.sep).join("/");
  }
  return relative.split(path.sep).join("/");
}

export function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function isFile(file) {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

export function isDirectory(file) {
  try {
    return statSync(file).isDirectory();
  } catch {
    return false;
  }
}

export function requireFile(file) {
  if (!isFile(file)) {
    fail(`missing package-shape output: ${rel(file)}`);
  }
}

export function requireDir(file) {
  if (!isDirectory(file)) {
    fail(`missing package-shape output directory: ${rel(file)}`);
  }
}

function commandCandidates(command) {
  if (command.includes("/") || command.includes("\\")) {
    return [path.resolve(ROOT, command)];
  }
  const pathEntries = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const extensions = process.platform === "win32"
    ? ["", ...(process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")]
    : [""];
  return pathEntries.flatMap((entry) => extensions.map((extension) => path.join(entry, `${command}${extension}`)));
}

export function requireCommand(command) {
  for (const candidate of commandCandidates(command)) {
    try {
      if (!statSync(candidate).isFile()) {
        continue;
      }
      accessSync(candidate, process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
      return;
    } catch {
      // Keep scanning PATH.
    }
  }
  fail(`missing required command: ${command}`);
}

export function copyDirContents(source, destination, { filter = () => true } = {}) {
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true }).sort((left, right) => compareText(left.name, right.name))) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    cpSync(sourcePath, destinationPath, {
      recursive: true,
      filter,
    });
  }
}

export function filesUnder(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => compareText(left.name, right.name))) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(file);
      } else if (entry.isFile()) {
        files.push(file);
      }
    }
  };
  visit(root);
  return files;
}

export function run(command, args, { cwd = ROOT, env = process.env, capture = false, label = command } = {}) {
  const result = capture
    ? captureCommandOutput(command, args, {
        cwd,
        env,
        label,
        maxOutputBytes: 100 * 1024 * 1024,
      })
    : spawnSync(command, args, { cwd, env, stdio: "inherit" });
  if (result.error) {
    fail(`${label} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = capture && result.stderr ? result.stderr.trim() : "";
    fail(`${label} failed${stderr ? `: ${stderr}` : ""}`);
  }
  return capture ? result.stdout : "";
}
