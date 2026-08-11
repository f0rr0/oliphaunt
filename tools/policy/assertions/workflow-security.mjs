#!/usr/bin/env bun

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "../../..");
const FULL_COMMIT_SHA = /^[0-9a-f]{40}$/u;
const FULL_DIGEST = /^[0-9a-f]{64}$/u;

function invariant(condition, message) {
  if (!condition) throw new Error(`workflow security: ${message}`);
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function yamlFiles(root, relativeRoot) {
  const files = [];
  const visit = (relative) => {
    for (const entry of readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const child = path.join(relative, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile() && /[.]ya?ml$/u.test(entry.name)) files.push(child);
    }
  };
  visit(relativeRoot);
  return files.sort();
}

function parseYaml(root, relativePath) {
  try {
    const value = Bun.YAML.parse(readFileSync(path.join(root, relativePath), "utf8"));
    invariant(object(value), `${relativePath} must contain a YAML object`);
    return value;
  } catch (cause) {
    if (cause instanceof Error && cause.message.startsWith("workflow security:")) throw cause;
    throw new Error(`workflow security: cannot parse ${relativePath}: ${cause.message}`);
  }
}

function remoteUse(value) {
  const uses = String(value ?? "");
  if (!uses || uses.startsWith("./")) return undefined;
  if (uses.startsWith("docker://")) {
    const revision = uses.match(/@sha256:([0-9a-f]+)$/u)?.[1];
    return { immutable: revision !== undefined && FULL_DIGEST.test(revision), uses };
  }
  const separator = uses.lastIndexOf("@");
  const revision = separator === -1 ? "" : uses.slice(separator + 1);
  return { immutable: FULL_COMMIT_SHA.test(revision), uses };
}

export function assertPinnedRemoteUses(document, label) {
  const visit = (value, location) => {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, `${location}[${index}]`));
      return;
    }
    if (!object(value)) return;
    for (const [key, child] of Object.entries(value)) {
      const childLocation = `${location}.${key}`;
      if (key === "uses") {
        const remote = remoteUse(child);
        invariant(
          remote === undefined || remote.immutable,
          `${childLocation} must pin ${remote?.uses ?? child} by commit or digest`,
        );
      } else {
        visit(child, childLocation);
      }
    }
  };
  visit(document, label);
}

function assertPermissions(workflow, label) {
  invariant(object(workflow.permissions), `${label} must declare top-level permissions`);
  invariant(Object.keys(workflow.permissions).length > 0, `${label} permissions cannot be empty`);
  for (const [scope, access] of Object.entries(workflow.permissions)) {
    invariant(
      access === "read" || access === "none",
      `${label} top-level ${scope} permission must be read-only`,
    );
  }

  for (const [jobId, job] of Object.entries(workflow.jobs)) {
    if (job.permissions === undefined) continue;
    invariant(object(job.permissions), `${label} ${jobId} permissions must be explicit`);
    for (const [scope, access] of Object.entries(job.permissions)) {
      invariant(
        access === "read" || access === "write" || access === "none",
        `${label} ${jobId} has invalid ${scope} permission ${String(access)}`,
      );
    }
    if (job.permissions["id-token"] === "write") {
      invariant(
        typeof job.environment === "string" && job.environment.length > 0,
        `${label} ${jobId} must use a protected environment before requesting an OIDC token`,
      );
    }
  }
}

function actionName(step) {
  return String(step.uses ?? "").split("@")[0];
}

function assertArtifactsAndCheckouts(workflow, label) {
  for (const [jobId, job] of Object.entries(workflow.jobs)) {
    const canWrite = object(job.permissions)
      && Object.values(job.permissions).includes("write");
    for (const [index, step] of (job.steps ?? []).entries()) {
      const location = `${label} ${jobId}.steps[${index}]`;
      const action = actionName(step);
      if (action === "actions/checkout") {
        invariant(
          step.with?.["persist-credentials"] === false,
          `${location} checkout must disable persisted credentials`,
        );
        const ref = step.with?.ref;
        invariant(
          ref === undefined
            || FULL_COMMIT_SHA.test(String(ref))
            || String(ref).startsWith("${{"),
          `${location} checkout must use the triggering commit or an explicit SHA expression`,
        );
      }

      if (action === "actions/upload-artifact") {
        invariant(
          typeof step.with?.name === "string" && step.with.name.length > 0,
          `${location} upload must name its artifact`,
        );
        invariant(
          typeof step.with?.path === "string" && step.with.path.length > 0,
          `${location} upload must declare its source path`,
        );
      }

      if (action === "actions/download-artifact") {
        const selectors = ["name", "pattern", "artifact-ids"]
          .filter((key) => typeof step.with?.[key] === "string" && step.with[key].length > 0);
        invariant(
          selectors.length === 1,
          `${location} download must select artifacts by one name, pattern, or ID`,
        );
        invariant(
          typeof step.with?.path === "string" && step.with.path.length > 0,
          `${location} download must use an explicit destination`,
        );
        for (const crossRunInput of ["run-id", "repository", "github-token"]) {
          invariant(
            step.with?.[crossRunInput] === undefined,
            `${location} cannot download artifacts from another run or repository`,
          );
        }
        invariant(
          !canWrite || selectors[0] === "artifact-ids",
          `${location} in a write-capable job must select an exact artifact ID`,
        );
      }
    }
  }
}

export function assertWorkflowSecurity(workflow, label = "workflow") {
  invariant(object(workflow.jobs) && Object.keys(workflow.jobs).length > 0, `${label} must declare jobs`);
  assertPinnedRemoteUses(workflow, label);
  assertPermissions(workflow, label);
  assertArtifactsAndCheckouts(workflow, label);
}

export function checkRepositoryWorkflowSecurity(root = ROOT) {
  const workflows = yamlFiles(root, ".github/workflows");
  const actions = yamlFiles(root, ".github/actions");
  for (const relativePath of workflows) {
    assertWorkflowSecurity(parseYaml(root, relativePath), relativePath);
  }
  for (const relativePath of actions) {
    assertPinnedRemoteUses(parseYaml(root, relativePath), relativePath);
  }
  return { actions: actions.length, workflows: workflows.length };
}

function stripShellComment(line) {
  let quote;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (escaped) escaped = false;
    else if (character === "\\" && quote !== "'") escaped = true;
    else if (quote !== undefined && character === quote) quote = undefined;
    else if (quote === undefined && /['"`]/u.test(character)) quote = character;
    else if (quote === undefined && character === "#" && (index === 0 || /[\s;&|()]/u.test(line[index - 1]))) {
      return line.slice(0, index);
    }
  }
  return line;
}

export function executableShell(source) {
  const active = [];
  const heredocs = [];
  for (const line of String(source ?? "").replace(/\r\n?/gu, "\n").split("\n")) {
    if (heredocs.length > 0) {
      const current = heredocs[0];
      const candidate = current.stripTabs ? line.replace(/^\t+/u, "") : line;
      if (candidate === current.marker) heredocs.shift();
      continue;
    }
    const code = stripShellComment(line);
    active.push(code);
    const matcher = /<<(-)?\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))/gu;
    for (const match of code.matchAll(matcher)) {
      heredocs.push({ marker: match[2] ?? match[3] ?? match[4], stripTabs: match[1] === "-" });
    }
  }
  return active.join("\n").replace(/\\\n/gu, " ");
}

if (import.meta.main) {
  if (process.argv.includes("--help")) {
    console.log("usage: workflow-security.mjs");
  } else {
    try {
      const summary = checkRepositoryWorkflowSecurity();
      console.log(`workflow security checks passed (${summary.workflows} workflows, ${summary.actions} actions)`);
    } catch (cause) {
      console.error(cause instanceof Error ? cause.message : String(cause));
      process.exitCode = 1;
    }
  }
}
