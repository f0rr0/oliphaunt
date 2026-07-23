#!/usr/bin/env node

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

function usage(message) {
  if (message) {
    console.error(message);
  }
  console.error(
    "usage: write-scoped-pnpm-workspace.mjs --source FILE --output FILE --package GLOB [--package GLOB ...]",
  );
  process.exit(2);
}

export function renderScopedWorkspace(source, packageGlobs) {
  if (!Array.isArray(packageGlobs) || packageGlobs.length === 0) {
    throw new Error("at least one package glob is required");
  }
  for (const packageGlob of packageGlobs) {
    if (
      typeof packageGlob !== "string" ||
      packageGlob.trim() !== packageGlob ||
      packageGlob.length === 0 ||
      /[\r\n\0]/u.test(packageGlob)
    ) {
      throw new Error(`invalid package glob: ${JSON.stringify(packageGlob)}`);
    }
  }

  const normalized = source.replaceAll("\r\n", "\n");
  const lines = normalized.split("\n");
  if (lines[0] !== "packages:") {
    throw new Error("source workspace must begin with the packages mapping");
  }

  let remainderIndex = 1;
  while (remainderIndex < lines.length) {
    const line = lines[remainderIndex];
    if (line.length > 0 && !/^\s/u.test(line) && !line.startsWith("#")) {
      break;
    }
    remainderIndex += 1;
  }
  if (remainderIndex >= lines.length) {
    throw new Error("source workspace has no shared configuration after packages");
  }

  const remainder = lines.slice(remainderIndex).join("\n").replace(/^\n+/u, "");
  const packageLines = packageGlobs.map((packageGlob) => `  - ${JSON.stringify(packageGlob)}`);
  return `packages:\n${packageLines.join("\n")}\n\n${remainder}`;
}

export async function writeScopedWorkspace({ sourcePath, outputPath, packageGlobs }) {
  const source = path.resolve(sourcePath);
  const output = path.resolve(outputPath);
  if (source === output) {
    throw new Error("refusing to overwrite the source workspace");
  }

  const rendered = renderScopedWorkspace(await readFile(source, "utf8"), packageGlobs);
  await mkdir(path.dirname(output), { recursive: true });
  const temporary = `${output}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, rendered, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, output);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function main(argv) {
  let sourcePath;
  let outputPath;
  const packageGlobs = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    switch (argument) {
      case "--source":
        if (!value) usage("--source requires a file");
        sourcePath = value;
        index += 1;
        break;
      case "--output":
        if (!value) usage("--output requires a file");
        outputPath = value;
        index += 1;
        break;
      case "--package":
        if (!value) usage("--package requires a glob");
        packageGlobs.push(value);
        index += 1;
        break;
      default:
        usage(`unknown argument: ${argument}`);
    }
  }
  if (!sourcePath || !outputPath || packageGlobs.length === 0) {
    usage();
  }
  await writeScopedWorkspace({ sourcePath, outputPath, packageGlobs });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
