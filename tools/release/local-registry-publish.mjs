#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import {
  accessSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fail, ROOT, run } from "./release-cli-utils.mjs";

const TOOL = "local-registry-publish.mjs";
const DEFAULT_RUN_ID = "28049923289";
const DEFAULT_REPO = "f0rr0/oliphaunt";
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

function commandOutput(args) {
  const result = spawnSync(args[0], args.slice(1), {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    fail(TOOL, `${args[0]} failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    fail(TOOL, detail || `${args.join(" ")} failed with exit code ${result.status}`, result.status ?? 1);
  }
  return result.stdout;
}

function runQuiet(args) {
  const result = spawnSync(args[0], args.slice(1), {
    cwd: ROOT,
    stdio: "inherit",
  });
  if (result.error) {
    fail(TOOL, `${args[0]} failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function commandJson(args, label) {
  const output = commandOutput(args);
  try {
    return JSON.parse(output);
  } catch (error) {
    fail(TOOL, `${label} did not return valid JSON: ${error.message}`);
  }
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

function requireCommand(name) {
  if (!executableExists(name)) {
    fail(TOOL, `missing required command: ${name}`);
  }
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

function copyTreeContents(source, destination) {
  let copied = 0;
  for (const file of walkFiles(source)) {
    const relative = path.relative(source, file);
    const target = path.join(destination, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(file, target);
    copied += 1;
  }
  return copied;
}

function localPublishArtifacts() {
  const names = commandJson([
    "tools/dev/bun.sh",
    "tools/release/local_registry_metadata.mjs",
    "local-publish-artifacts",
  ], "local registry metadata local-publish-artifacts");
  if (!Array.isArray(names) || names.some((name) => typeof name !== "string" || name.length === 0)) {
    fail(TOOL, "local registry metadata local-publish-artifacts must return a non-empty string list");
  }
  if (names.length === 0) {
    fail(TOOL, "local registry metadata returned no local-publish artifacts");
  }
  const duplicates = [...new Set(names.filter((name, index) => names.indexOf(name) !== index))].sort(compareText);
  if (duplicates.length > 0) {
    fail(TOOL, `local registry metadata returned duplicate local-publish artifacts: ${duplicates.join(", ")}`);
  }
  return names;
}

function listCiArtifacts(repo, runId) {
  requireCommand("gh");
  const data = commandJson([
    "gh",
    "api",
    `repos/${repo}/actions/runs/${runId}/artifacts?per_page=100`,
    "--paginate",
  ], `GitHub Actions artifacts for ${repo} run ${runId}`);
  if (Array.isArray(data)) {
    return data.flatMap((page) => Array.isArray(page?.artifacts) ? page.artifacts : []);
  }
  return Array.isArray(data?.artifacts) ? data.artifacts : [];
}

function parseDownloadArgs(argv) {
  const options = {
    repo: DEFAULT_REPO,
    runId: DEFAULT_RUN_ID,
    destination: DEFAULT_ARTIFACT_ROOT,
    artifacts: [],
    preset: null,
    force: false,
    dryRun: false,
  };
  const readValue = (index, flag) => {
    if (index + 1 >= argv.length) {
      fail(TOOL, `${flag} requires a value`, 2);
    }
    return argv[index + 1];
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "-h" || value === "--help") {
      console.log(`usage: tools/release/local-registry-publish.mjs download [--repo REPO] [--run-id RUN_ID] [--destination DIR] [--artifact NAME] [--preset local-publish] [--force] [--dry-run]`);
      process.exit(0);
    }
    if (value === "--repo") {
      options.repo = readValue(index, value);
      index += 1;
      continue;
    }
    if (value.startsWith("--repo=")) {
      options.repo = value.slice("--repo=".length);
      continue;
    }
    if (value === "--run-id") {
      options.runId = readValue(index, value);
      index += 1;
      continue;
    }
    if (value.startsWith("--run-id=")) {
      options.runId = value.slice("--run-id=".length);
      continue;
    }
    if (value === "--destination") {
      options.destination = path.resolve(ROOT, readValue(index, value));
      index += 1;
      continue;
    }
    if (value.startsWith("--destination=")) {
      options.destination = path.resolve(ROOT, value.slice("--destination=".length));
      continue;
    }
    if (value === "--artifact") {
      options.artifacts.push(readValue(index, value));
      index += 1;
      continue;
    }
    if (value.startsWith("--artifact=")) {
      options.artifacts.push(value.slice("--artifact=".length));
      continue;
    }
    if (value === "--preset") {
      options.preset = readValue(index, value);
      index += 1;
      continue;
    }
    if (value.startsWith("--preset=")) {
      options.preset = value.slice("--preset=".length);
      continue;
    }
    if (value === "--force") {
      options.force = true;
      continue;
    }
    if (value === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    fail(TOOL, `unknown download argument ${value}`, 2);
  }
  if (options.preset !== null && options.preset !== "local-publish") {
    fail(TOOL, `download --preset must be local-publish, got ${options.preset}`, 2);
  }
  return options;
}

function download(argv) {
  const options = parseDownloadArgs(argv);
  const selectedArtifacts = [
    ...options.artifacts,
    ...(options.preset === "local-publish" ? localPublishArtifacts() : []),
  ];
  const artifacts = [...new Set(selectedArtifacts)].sort(compareText);
  if (artifacts.length === 0) {
    console.error("No artifacts selected; pass --artifact or --preset local-publish.");
    process.exit(2);
  }

  const available = new Map(listCiArtifacts(options.repo, options.runId).map((artifact) => [artifact.name, artifact]));
  const missing = artifacts.filter((artifact) => !available.has(artifact));
  if (missing.length > 0) {
    console.error(`Run ${options.runId} is missing artifacts: ${missing.join(", ")}`);
    process.exit(1);
  }
  if (options.dryRun) {
    for (const artifact of artifacts) {
      console.log(`${artifact}\t${available.get(artifact).size_in_bytes ?? 0}`);
    }
    return;
  }

  mkdirSync(options.destination, { recursive: true });
  for (const artifact of artifacts) {
    const artifactDir = path.join(options.destination, artifact);
    if (existsSync(artifactDir) && readdirSync(artifactDir).length > 0 && !options.force) {
      console.log(`Skipping existing ${rel(artifactDir)}`);
      continue;
    }
    rmSync(artifactDir, { recursive: true, force: true });
    mkdirSync(artifactDir, { recursive: true });
    console.log(`Downloading ${artifact} from ${options.repo} run ${options.runId}`);
    runQuiet([
      "gh",
      "run",
      "download",
      options.runId,
      "--repo",
      options.repo,
      "--name",
      artifact,
      "--dir",
      artifactDir,
    ]);
  }
}

function surfaceResult(surface) {
  return {
    surface,
    published: [],
    staged: [],
    skipped: [],
  };
}

function reportSurfaceResult(result) {
  return {
    published: result.published,
    skipped: result.skipped,
    staged: result.staged,
    surface: result.surface,
  };
}

function addSkip(result, message, strict) {
  result.skipped.push(message);
  if (strict) {
    fail(TOOL, message);
  }
}

function publishMaven(roots, registryRoot, dryRun, strict) {
  const result = surfaceResult("maven");
  const candidates = roots
    .filter((root) => statSync(root).isDirectory())
    .flatMap((root) => walkDirsNamed(root, "maven"))
    .sort(compareText);
  if (candidates.length === 0) {
    addSkip(result, "no staged Maven repository directories named maven found", strict);
    return result;
  }
  const mavenRoot = path.join(registryRoot, "maven");
  if (dryRun) {
    result.published.push(...candidates.map((candidate) => `dry-run maven copy ${rel(candidate)}`));
    return result;
  }
  rmSync(mavenRoot, { recursive: true, force: true });
  mkdirSync(mavenRoot, { recursive: true });
  for (const candidate of candidates) {
    const count = copyTreeContents(candidate, mavenRoot);
    result.published.push(`${rel(candidate)} (${count} files)`);
  }
  result.staged.push(rel(mavenRoot));
  return result;
}

function publishSwift(roots, registryRoot, dryRun, strict) {
  const result = surfaceResult("swift");
  const swiftFiles = discoverFiles(roots, [".swift", ".zip"])
    .filter((file) => path.basename(file) === "Package.swift.release" || path.basename(file).endsWith("-source.zip") || file.includes("swift"));
  if (swiftFiles.length === 0) {
    addSkip(result, "no SwiftPM package artifacts found", strict);
    return result;
  }
  if (!executableExists("swift")) {
    result.skipped.push("swift is not installed; staged artifacts are copyable, registry publish skipped on this Linux host");
  }
  const swiftRoot = path.join(registryRoot, "swift");
  if (dryRun) {
    result.published.push(...swiftFiles.map((file) => `dry-run swift stage ${rel(file)}`));
    return result;
  }
  rmSync(swiftRoot, { recursive: true, force: true });
  mkdirSync(swiftRoot, { recursive: true });
  for (const file of swiftFiles) {
    const target = path.join(swiftRoot, path.basename(file));
    copyFileSync(file, target);
    result.staged.push(rel(target));
  }
  return result;
}

function parsePublishArgs(argv) {
  const options = {
    artifactRoots: [],
    registryRoot: path.join(ROOT, "target/local-registries"),
    surfaces: [],
    verdaccioPort: "4873",
    dryRun: false,
    strict: false,
    help: false,
  };
  const readValue = (index, flag) => {
    if (index + 1 >= argv.length) {
      fail(TOOL, `${flag} requires a value`, 2);
    }
    return argv[index + 1];
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "-h" || value === "--help") {
      options.help = true;
      continue;
    }
    if (value === "--artifact-root") {
      options.artifactRoots.push(readValue(index, value));
      index += 1;
      continue;
    }
    if (value.startsWith("--artifact-root=")) {
      options.artifactRoots.push(value.slice("--artifact-root=".length));
      continue;
    }
    if (value === "--registry-root") {
      options.registryRoot = path.resolve(ROOT, readValue(index, value));
      index += 1;
      continue;
    }
    if (value.startsWith("--registry-root=")) {
      options.registryRoot = path.resolve(ROOT, value.slice("--registry-root=".length));
      continue;
    }
    if (value === "--surface") {
      options.surfaces.push(readValue(index, value));
      index += 1;
      continue;
    }
    if (value.startsWith("--surface=")) {
      options.surfaces.push(value.slice("--surface=".length));
      continue;
    }
    if (value === "--verdaccio-port") {
      options.verdaccioPort = readValue(index, value);
      index += 1;
      continue;
    }
    if (value.startsWith("--verdaccio-port=")) {
      options.verdaccioPort = value.slice("--verdaccio-port=".length);
      continue;
    }
    if (value === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (value === "--strict") {
      options.strict = true;
      continue;
    }
    fail(TOOL, `unknown publish argument ${value}`, 2);
  }
  const invalidSurfaces = options.surfaces.filter((surface) => !["npm", "cargo", "maven", "swift"].includes(surface));
  if (invalidSurfaces.length > 0) {
    fail(TOOL, `unsupported publish surface: ${invalidSurfaces[0]}`, 2);
  }
  return options;
}

function canPublishInBun(options) {
  return !options.help && options.surfaces.length > 0 && options.surfaces.every((surface) => surface === "maven" || surface === "swift");
}

function publish(argv) {
  const options = parsePublishArgs(argv);
  if (!canPublishInBun(options)) {
    run(TOOL, ["python3", "tools/release/local_registry_publish.py", "publish", ...argv]);
    return;
  }
  const roots = discoverRoots(options.artifactRoots);
  mkdirSync(options.registryRoot, { recursive: true });
  const results = [];
  for (const surface of options.surfaces) {
    if (surface === "maven") {
      results.push(publishMaven(roots, options.registryRoot, options.dryRun, options.strict));
    } else if (surface === "swift") {
      results.push(publishSwift(roots, options.registryRoot, options.dryRun, options.strict));
    }
  }
  const report = {
    artifact_roots: roots,
    dry_run: options.dryRun,
    registry_root: options.registryRoot,
    surfaces: results.map(reportSurfaceResult),
  };
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (!options.dryRun) {
    writeFileSync(path.join(options.registryRoot, "report.json"), text);
  }
  process.stdout.write(text);
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
if (command === "download") {
  download(args);
} else if (command === "publish") {
  publish(args);
} else if (command === "status") {
  status(args);
} else {
  run(TOOL, ["python3", "tools/release/local_registry_publish.py", ...Bun.argv.slice(2)]);
}
