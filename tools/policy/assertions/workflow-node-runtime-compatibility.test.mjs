import assert from "node:assert/strict";
import {
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import path from "node:path";
import test from "node:test";

import { executableShell } from "./workflow-contract-core.mjs";

const ROOT = process.cwd();
const WORKFLOW_ROOTS = [".github/workflows", ".github/actions"];
const NODE_ENTRYPOINT = /\bnode\s+(?:--[A-Za-z0-9_.=-]+\s+)*["']?([.][./A-Za-z0-9_-]*[.]mjs)["']?/gu;

function filesBelow(relativeRoot) {
  const result = [];
  const visit = (relative) => {
    const absolute = path.join(ROOT, relative);
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      const child = path.join(relative, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile() && /[.]ya?ml$/u.test(entry.name)) result.push(child);
    }
  };
  visit(relativeRoot);
  return result.sort();
}

function runBlocks(value, blocks = []) {
  if (Array.isArray(value)) {
    for (const child of value) runBlocks(child, blocks);
  } else if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (key === "run" && typeof child === "string") blocks.push(child);
      else runBlocks(child, blocks);
    }
  }
  return blocks;
}

function localImports(source) {
  const values = [];
  for (const pattern of [
    /\b(?:import|export)\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']/gu,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu,
  ]) {
    for (const match of source.matchAll(pattern)) {
      if (match[1].startsWith(".")) values.push(match[1]);
    }
  }
  return values;
}

function resolvedImport(parent, specifier) {
  const candidate = path.resolve(path.dirname(parent), specifier);
  for (const file of [candidate, `${candidate}.mjs`, `${candidate}.js`]) {
    if (existsSync(file)) return file;
  }
  assert.fail(`${path.relative(ROOT, parent)} imports missing local module ${specifier}`);
}

function nodeIncompatibleModules(entrypoint) {
  const seen = new Set();
  const incompatible = [];
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = readFileSync(file, "utf8");
    const reasons = [];
    if (/\bBun\s*(?:[.]|\[)/u.test(source)) reasons.push("Bun global");
    if (/\bDeno\s*(?:[.]|\[)/u.test(source)) reasons.push("Deno global");
    if (/\bimport[.]meta[.](?:dir|main|path)\b/u.test(source)) {
      reasons.push("Bun-only import.meta extension");
    }
    if (reasons.length > 0) {
      incompatible.push(`${path.relative(ROOT, file)} (${reasons.join(", ")})`);
    }
    for (const specifier of localImports(source)) visit(resolvedImport(file, specifier));
  };
  visit(entrypoint);
  return incompatible;
}

test("every workflow node entrypoint has a transitively Node-compatible module graph", () => {
  const entrypoints = new Map();
  for (const workflowFile of WORKFLOW_ROOTS.flatMap(filesBelow)) {
    const workflow = Bun.YAML.parse(readFileSync(path.join(ROOT, workflowFile), "utf8"));
    for (const block of runBlocks(workflow)) {
      const active = executableShell(block);
      for (const match of active.matchAll(NODE_ENTRYPOINT)) {
        const absolute = path.resolve(ROOT, match[1]);
        assert.ok(
          absolute.startsWith(`${ROOT}${path.sep}`) && existsSync(absolute),
          `${workflowFile} invokes missing or escaping Node entrypoint ${match[1]}`,
        );
        const consumers = entrypoints.get(absolute) ?? [];
        consumers.push(workflowFile);
        entrypoints.set(absolute, consumers);
      }
    }
  }
  assert.ok(entrypoints.size > 0, "workflow Node entrypoint inventory must not be empty");
  const findings = [];
  for (const [entrypoint, consumers] of entrypoints) {
    for (const incompatible of nodeIncompatibleModules(entrypoint)) {
      findings.push(
        `${path.relative(ROOT, entrypoint)} used by ${[...new Set(consumers)].sort().join(", ")} imports ${incompatible}`,
      );
    }
  }
  assert.deepEqual(findings, []);
});
