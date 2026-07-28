import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  utimesSync,
} from "node:fs";
import path from "node:path";

const trackedTemporaryPaths = new Set();
const trackedPromotions = new Map();
let cleanupInstalled = false;

function cleanupTracked() {
  for (const { backup, destination } of [...trackedPromotions.values()].reverse()) {
    try {
      if (!existsSync(destination) && existsSync(backup)) {
        renameSync(backup, destination);
      } else if (existsSync(backup)) {
        rmSync(backup, { force: true, recursive: true });
      }
    } catch {
      // Preserve the recoverable backup when automatic restoration cannot run.
    }
  }
  for (const temporary of [...trackedTemporaryPaths].reverse()) {
    try {
      rmSync(temporary, { force: true, recursive: true });
    } catch {
      // The original failure or signal remains authoritative.
    }
  }
}

function installCleanup() {
  if (cleanupInstalled) return;
  cleanupInstalled = true;
  process.once("exit", cleanupTracked);
  for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]]) {
    process.once(signal, () => {
      cleanupTracked();
      process.exit(code);
    });
  }
}

export function trackTemporaryPath(temporary) {
  installCleanup();
  trackedTemporaryPaths.add(path.resolve(temporary));
  return temporary;
}

export function releaseTemporaryPath(temporary) {
  trackedTemporaryPaths.delete(path.resolve(temporary));
}

export function removeTemporaryPath(temporary) {
  rmSync(temporary, { force: true, recursive: true });
  releaseTemporaryPath(temporary);
}

export function createSiblingStage(destination, label = "stage") {
  const resolved = path.resolve(destination);
  const parent = path.dirname(resolved);
  mkdirSync(parent, { recursive: true });
  return trackTemporaryPath(
    mkdtempSync(path.join(parent, `.${path.basename(resolved)}.${label}-`)),
  );
}

export function copyDirectoryTree(source, destination) {
  const sourceStat = lstatSync(source);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
    throw new Error(`directory copy source is not a real directory: ${source}`);
  }
  mkdirSync(destination, { recursive: true, mode: sourceStat.mode });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    const stat = lstatSync(from);
    if (stat.isSymbolicLink()) {
      throw new Error(`directory copy refuses symbolic link ${from}`);
    }
    if (stat.isDirectory()) {
      copyDirectoryTree(from, to);
      chmodSync(to, stat.mode);
      utimesSync(to, stat.atime, stat.mtime);
    } else if (stat.isFile()) {
      copyFileSync(from, to, 0);
      chmodSync(to, stat.mode);
      utimesSync(to, stat.atime, stat.mtime);
    } else {
      throw new Error(`directory copy refuses special file ${from}`);
    }
  }
}

export function stageExistingDirectory(destination, label = "stage") {
  const stage = createSiblingStage(destination, label);
  if (existsSync(destination)) copyDirectoryTree(destination, stage);
  return stage;
}

export function promoteDirectory(stage, destination) {
  const resolvedStage = path.resolve(stage);
  const resolvedDestination = path.resolve(destination);
  if (path.dirname(resolvedStage) !== path.dirname(resolvedDestination)) {
    throw new Error("atomic directory stage must be a sibling of its destination");
  }
  const backup = `${resolvedStage}.previous`;
  trackedPromotions.set(resolvedStage, {
    backup,
    destination: resolvedDestination,
  });
  let movedExisting = false;
  try {
    if (existsSync(resolvedDestination)) {
      renameSync(resolvedDestination, backup);
      movedExisting = true;
    }
    try {
      renameSync(resolvedStage, resolvedDestination);
      releaseTemporaryPath(resolvedStage);
    } catch (error) {
      if (movedExisting) renameSync(backup, resolvedDestination);
      throw error;
    }
    if (movedExisting) rmSync(backup, { force: true, recursive: true });
    trackedPromotions.delete(resolvedStage);
  } catch (error) {
    if (movedExisting && !existsSync(resolvedDestination) && existsSync(backup)) {
      renameSync(backup, resolvedDestination);
    }
    trackedPromotions.delete(resolvedStage);
    throw error;
  }
}
