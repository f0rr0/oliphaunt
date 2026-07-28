#!/usr/bin/env bun

import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  readlink,
  readdir,
  rename,
  rm,
  symlink,
  utimes,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const TOOL = "materialize-release-symlinks.mjs";

function fail(message) {
  throw new Error(`${TOOL}: ${message}`);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === ""
    || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

async function requiredLstat(file, context) {
  try {
    return await lstat(file);
  } catch (error) {
    fail(`${context}: ${error.message}`);
  }
}

async function collectSymlinks(root, directory = root, links = []) {
  const entries = (await readdir(directory)).sort(compareText);
  for (const name of entries) {
    const file = path.join(directory, name);
    const stat = await requiredLstat(file, `cannot inspect ${file}`);
    if (stat.isSymbolicLink()) {
      links.push(file);
    } else if (stat.isDirectory()) {
      await collectSymlinks(root, file, links);
    }
  }
  return links;
}

async function resolveRegularTarget(root, link) {
  let current = link;
  const visited = new Set([current]);

  while (true) {
    const target = await readlink(current);
    if (target.length === 0 || path.isAbsolute(target) || path.win32.isAbsolute(target)) {
      fail(`${link} must use only relative symbolic-link targets`);
    }
    const next = path.resolve(path.dirname(current), target);
    if (!isInside(root, next)) {
      fail(`${link} escapes the staged release tree through ${JSON.stringify(target)}`);
    }
    const stat = await requiredLstat(next, `${link} has a broken symbolic-link target`);
    if (stat.isSymbolicLink()) {
      if (visited.has(next)) {
        fail(`${link} contains a symbolic-link cycle`);
      }
      visited.add(next);
      current = next;
      continue;
    }
    if (!stat.isFile()) {
      fail(`${link} must resolve to a regular file, not a directory or special file`);
    }
    return { file: next, stat };
  }
}

async function cleanupTemps(plans) {
  await Promise.all(plans.map(({ temp }) => rm(temp, { force: true }).catch(() => {})));
}

export async function materializeReleaseSymlinks(rootInput) {
  if (typeof rootInput !== "string" || rootInput.length === 0 || rootInput.includes("\0")) {
    fail("a staged release root is required");
  }
  const root = path.resolve(rootInput);
  const rootStat = await requiredLstat(root, `cannot inspect staged release root ${root}`);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    fail(`staged release root must be a real directory: ${root}`);
  }

  const links = await collectSymlinks(root);
  const plans = [];
  for (const link of links) {
    const originalTarget = await readlink(link);
    const resolved = await resolveRegularTarget(root, link);
    plans.push({
      link,
      originalTarget,
      source: resolved.file,
      sourceStat: resolved.stat,
      temp: path.join(path.dirname(link), `.${path.basename(link)}.materialize-${randomUUID()}.tmp`),
    });
  }

  try {
    for (const plan of plans) {
      await copyFile(plan.source, plan.temp, constants.COPYFILE_EXCL);
      await chmod(plan.temp, plan.sourceStat.mode & 0o777);
      await utimes(plan.temp, plan.sourceStat.atime, plan.sourceStat.mtime);
    }
  } catch (error) {
    await cleanupTemps(plans);
    fail(`could not stage verified symbolic-link replacements: ${error.message}`);
  }

  const committed = [];
  try {
    for (const plan of plans) {
      const currentStat = await requiredLstat(plan.link, `cannot revalidate ${plan.link}`);
      const currentTarget = currentStat.isSymbolicLink() ? await readlink(plan.link) : "";
      if (!currentStat.isSymbolicLink() || currentTarget !== plan.originalTarget) {
        fail(`${plan.link} changed while its replacement was staged`);
      }
      await rename(plan.temp, plan.link);
      committed.push(plan);
    }
  } catch (error) {
    for (const plan of committed.reverse()) {
      await rm(plan.link, { force: true }).catch(() => {});
      await symlink(plan.originalTarget, plan.link).catch(() => {});
    }
    await cleanupTemps(plans);
    throw error;
  }

  await cleanupTemps(plans);
  const remaining = await collectSymlinks(root);
  if (remaining.length !== 0) {
    fail(`staged release tree still contains symbolic links: ${remaining.join(", ")}`);
  }
  return plans.length;
}

async function main(argv) {
  if (argv.length !== 1) {
    fail("usage: tools/release/materialize-release-symlinks.mjs ROOT");
  }
  const count = await materializeReleaseSymlinks(argv[0]);
  console.log(`materializedReleaseSymlinks=${count}`);
}

if (import.meta.main) {
  main(Bun.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
