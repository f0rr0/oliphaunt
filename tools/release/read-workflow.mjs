import { readFileSync } from "node:fs";
import path from "node:path";

export function parseWorkflow(root, relativePath) {
  let workflow;
  try {
    workflow = Bun.YAML.parse(readFileSync(path.join(root, relativePath), "utf8"));
  } catch (cause) {
    throw new Error(`cannot parse ${relativePath}: ${cause.message}`);
  }
  if (workflow === null || typeof workflow !== "object" || Array.isArray(workflow)) {
    throw new Error(`${relativePath} must contain a YAML object`);
  }
  if (workflow.jobs === null || typeof workflow.jobs !== "object" || Array.isArray(workflow.jobs)) {
    throw new Error(`${relativePath} must declare jobs`);
  }
  return workflow;
}
