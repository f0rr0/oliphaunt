#!/usr/bin/env bun
import { accessSync, constants, existsSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "./release-cli-utils.mjs";
import { ROOT } from "./release-cli-utils.mjs";

const TOOL = "local-registry-publish.mjs";
const DEFAULT_RUN_ID = "28049923289";
const DEFAULT_CURRENT_ARTIFACT_ROOT = path.join(ROOT, "target/local-registry-current");
const DEFAULT_ARTIFACT_ROOT = path.join(ROOT, "target/local-registry-artifacts");
const DEFAULT_ROOTS = [
  DEFAULT_CURRENT_ARTIFACT_ROOT,
  DEFAULT_ARTIFACT_ROOT,
  path.join(ROOT, "target/sdk-artifacts"),
  path.join(ROOT, "target/package/tmp-crate"),
  path.join(ROOT, "target/package/tmp-registry"),
  path.join(ROOT, "target/local-registry-generated/broker-cargo"),
  path.join(ROOT, "target/oliphaunt-broker/cargo-artifacts"),
  path.join(ROOT, "target/extension-artifacts"),
];

function rel(file) {
  const relative = path.relative(ROOT, file);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative)
    ? relative.split(path.sep).join("/")
    : file.split(path.sep).join("/");
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function executableExists(name) {
  const pathEnv = process.env.PATH ?? "";
  const extensions = os.platform() === "win32"
    ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")
    : [""];
  for (const directory of pathEnv.split(path.delimiter)) {
    if (!directory) {
      continue;
    }
    for (const extension of extensions) {
      const candidate = path.join(directory, os.platform() === "win32" && !name.includes(".") ? `${name}${extension}` : name);
      try {
        accessSync(candidate, constants.X_OK);
        return true;
      } catch {
        // Keep searching.
      }
    }
  }
  return false;
}

function walkFiles(root) {
  const files = [];
  const visit = (current) => {
    const entries = readdirSync(current, { withFileTypes: true })
      .sort((left, right) => compareText(left.name, right.name));
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
      } else if (entry.isFile()) {
        files.push(entryPath);
      }
    }
  };
  visit(root);
  return files;
}

function walkDirsNamed(root, name) {
  const dirs = [];
  const visit = (current) => {
    const entries = readdirSync(current, { withFileTypes: true })
      .sort((left, right) => compareText(left.name, right.name));
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (!entry.isDirectory()) {
        continue;
      }
      if (entry.name === name) {
        dirs.push(entryPath);
      }
      visit(entryPath);
    }
  };
  visit(root);
  return dirs;
}

function discoverRoots(artifactRoots) {
  const roots = artifactRoots.length > 0 ? artifactRoots : DEFAULT_ROOTS;
  const seen = new Set();
  const result = [];
  for (const root of roots) {
    const resolved = path.resolve(ROOT, root);
    if (seen.has(resolved) || !existsSync(resolved)) {
      continue;
    }
    seen.add(resolved);
    result.push(resolved);
  }
  return result;
}

function discoverFiles(roots, suffixes) {
  const files = new Set();
  for (const root of roots) {
    const stats = statSync(root);
    if (stats.isFile() && suffixes.some((suffix) => path.basename(root).endsWith(suffix))) {
      files.add(root);
      continue;
    }
    if (stats.isDirectory()) {
      for (const file of walkFiles(root)) {
        if (suffixes.some((suffix) => path.basename(file).endsWith(suffix))) {
          files.add(file);
        }
      }
    }
  }
  return [...files].sort(compareText);
}

function parseStatusArgs(argv) {
  const artifactRoots = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--artifact-root") {
      if (index + 1 >= argv.length) {
        console.error(`${TOOL}: --artifact-root requires a value`);
        process.exit(2);
      }
      artifactRoots.push(argv[index + 1]);
      index += 1;
      continue;
    }
    if (value.startsWith("--artifact-root=")) {
      artifactRoots.push(value.slice("--artifact-root=".length));
      continue;
    }
    if (value === "-h" || value === "--help") {
      run(TOOL, ["python3", "tools/release/local_registry_publish.py", "status", ...argv]);
      process.exit(0);
    }
    console.error(`${TOOL}: unknown status argument ${value}`);
    process.exit(2);
  }
  return { artifactRoots };
}

function status(argv) {
  const { artifactRoots } = parseStatusArgs(argv);
  const roots = discoverRoots(artifactRoots);
  const report = {
    artifact_roots: roots.map((root) => root),
    artifacts: {
      cargo: discoverFiles(roots, [".crate"]).map(rel),
      maven_roots: roots
        .filter((root) => statSync(root).isDirectory())
        .flatMap((root) => walkDirsNamed(root, "maven").map(rel)),
      npm: discoverFiles(roots, [".tgz"]).map(rel),
      swift: discoverFiles(roots, [".swift", ".zip"])
        .filter((file) => path.basename(file) === "Package.swift.release" || file.includes("swift"))
        .map(rel),
    },
    default_run_id: DEFAULT_RUN_ID,
    tools: {
      cargo: executableExists("cargo"),
      gh: executableExists("gh"),
      java: executableExists("java"),
      npm: executableExists("npm"),
      pnpm: executableExists("pnpm"),
      swift: executableExists("swift"),
    },
  };
  console.log(JSON.stringify(report, null, 2));
}

const [command, ...args] = Bun.argv.slice(2);
if (command === "status") {
  status(args);
} else {
  run(TOOL, ["python3", "tools/release/local_registry_publish.py", ...Bun.argv.slice(2)]);
}
