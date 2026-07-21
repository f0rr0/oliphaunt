import { readFileSync } from "node:fs";
import path from "node:path";

const FULL_COMMIT_SHA = /^[0-9a-f]{40}$/u;
const STEP_ID = /^[A-Za-z_][A-Za-z0-9_-]*$/u;

export function invariant(condition, message) {
  if (!condition) throw new Error(`workflow policy: ${message}`);
}

export function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function strings(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value.map(String) : [String(value)];
}

export function sameSet(actual, expected) {
  const left = [...new Set(actual)].sort();
  const right = [...new Set(expected)].sort();
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

export function normalized(value) {
  return String(value ?? "").replace(/\s+/gu, " ").trim();
}

export function parseWorkflow(root, repoPath) {
  let workflow;
  try {
    workflow = Bun.YAML.parse(readFileSync(path.join(root, repoPath), "utf8"));
  } catch (cause) {
    throw new Error(`workflow policy: cannot parse ${repoPath}: ${cause.message}`);
  }
  invariant(object(workflow), `${repoPath} must contain a YAML object`);
  invariant(object(workflow.on), `${repoPath} must declare workflow triggers`);
  invariant(
    object(workflow.jobs) && Object.keys(workflow.jobs).length > 0,
    `${repoPath} must declare jobs`,
  );
  return workflow;
}

export function workflowNeeds(workflow, jobId) {
  const job = workflow.jobs?.[jobId];
  invariant(object(job), `missing job ${jobId}`);
  return new Set(strings(job.needs));
}

export function workflowSteps(workflow, jobId) {
  const job = workflow.jobs?.[jobId];
  invariant(object(job), `missing job ${jobId}`);
  invariant(Array.isArray(job.steps), `${jobId} must declare steps`);
  return job.steps;
}

export function stepById(workflow, jobId, id) {
  const matches = workflowSteps(workflow, jobId)
    .map((step, index) => ({ index, step }))
    .filter(({ step }) => step.id === id);
  invariant(
    matches.length === 1,
    `${jobId} must contain exactly one stable step id ${id}; found ${matches.length}`,
  );
  return matches[0];
}

export function assertExactNeeds(workflow, jobId, expected) {
  const actual = [...workflowNeeds(workflow, jobId)];
  invariant(
    sameSet(actual, expected),
    `${jobId}.needs must be ${JSON.stringify([...expected].sort())}; got ${JSON.stringify(actual.sort())}`,
  );
}

export function assertNeedsInclude(workflow, jobId, expected) {
  const actual = workflowNeeds(workflow, jobId);
  const missing = expected.filter((job) => !actual.has(job));
  invariant(
    missing.length === 0,
    `${jobId}.needs is missing ${JSON.stringify(missing.sort())}`,
  );
}

export function assertGraph(workflow, label) {
  const jobs = new Set(Object.keys(workflow.jobs));
  for (const [jobId, job] of Object.entries(workflow.jobs)) {
    for (const dependency of strings(job.needs)) {
      invariant(jobs.has(dependency), `${label} ${jobId}.needs references missing job ${dependency}`);
    }
  }

  const visiting = new Set();
  const visited = new Set();
  const visit = (jobId) => {
    if (visited.has(jobId)) return;
    invariant(!visiting.has(jobId), `${label} job dependency graph contains a cycle through ${jobId}`);
    visiting.add(jobId);
    for (const dependency of strings(workflow.jobs[jobId].needs)) visit(dependency);
    visiting.delete(jobId);
    visited.add(jobId);
  };
  for (const jobId of jobs) visit(jobId);
}

function remoteUseIdentity(value) {
  const uses = String(value ?? "");
  if (!uses || uses.startsWith("./")) return undefined;
  if (uses.startsWith("docker://")) {
    const digest = uses.match(/@sha256:([0-9a-f]{64})$/u)?.[1];
    return digest === undefined
      ? { uses, revision: undefined, digest: true }
      : { uses, revision: digest, digest: true };
  }
  const separator = uses.lastIndexOf("@");
  return separator === -1
    ? { uses, revision: undefined, digest: false }
    : { uses, revision: uses.slice(separator + 1), digest: false };
}

export function assertPinnedActions(workflow, label) {
  const entries = [];
  for (const [jobId, job] of Object.entries(workflow.jobs)) {
    if (job.uses !== undefined) entries.push([`${jobId}.uses`, job.uses]);
    for (const [index, step] of (job.steps ?? []).entries()) {
      if (step.uses !== undefined) entries.push([`${jobId}.steps[${index}].uses`, step.uses]);
    }
  }
  for (const [location, value] of entries) {
    const identity = remoteUseIdentity(value);
    if (identity === undefined) continue;
    invariant(
      identity.revision !== undefined
        && (identity.digest
          ? /^[0-9a-f]{64}$/u.test(identity.revision)
          : FULL_COMMIT_SHA.test(identity.revision)),
      `${label} ${location} must pin a remote action or workflow by immutable commit/digest; got ${identity.uses}`,
    );
  }
}

function assertPinnedRunnerValue(value, location) {
  if (typeof value === "string") {
    invariant(
      !/^(?:ubuntu|macos|windows)-latest(?:-|$)/u.test(value),
      `${location} must pin an explicit hosted runner OS version; got ${value}`,
    );
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertPinnedRunnerValue(entry, `${location}[${index}]`));
  }
}

export function assertPinnedRunnerLabels(workflow, label) {
  for (const [jobId, job] of Object.entries(workflow.jobs)) {
    if (job["runs-on"] !== undefined) {
      assertPinnedRunnerValue(job["runs-on"], `${label}.jobs.${jobId}.runs-on`);
    }
    for (const [index, row] of (job.strategy?.matrix?.include ?? []).entries()) {
      for (const key of ["runner", "os", "runs-on"]) {
        if (row[key] !== undefined) {
          assertPinnedRunnerValue(
            row[key],
            `${label}.jobs.${jobId}.strategy.matrix.include[${index}].${key}`,
          );
        }
      }
    }
  }
}

export function assertPermissions(actual, expected, context) {
  invariant(object(actual), `${context} must declare permissions explicitly`);
  invariant(
    sameSet(Object.keys(actual), Object.keys(expected))
      && Object.entries(expected).every(([scope, access]) => actual[scope] === access),
    `${context} permissions must be ${JSON.stringify(expected)}; got ${JSON.stringify(actual)}`,
  );
}

export function assertStableIds(workflow, jobId, requiredIds) {
  const seen = new Set();
  for (const step of workflowSteps(workflow, jobId)) {
    if (step.id === undefined) continue;
    invariant(STEP_ID.test(step.id), `${jobId} has invalid step id ${String(step.id)}`);
    invariant(!seen.has(step.id), `${jobId} has duplicate step id ${step.id}`);
    seen.add(step.id);
  }
  for (const id of requiredIds) {
    invariant(seen.has(id), `${jobId} is missing required stable step id ${id}`);
  }
}

export function assertStepOrder(workflow, jobId, orderedIds, { final } = {}) {
  assertStableIds(workflow, jobId, orderedIds);
  const phases = orderedIds.map((id) => stepById(workflow, jobId, id));
  for (let index = 1; index < phases.length; index += 1) {
    invariant(
      phases[index - 1].index < phases[index].index,
      `${jobId} phase ${orderedIds[index - 1]} must precede ${orderedIds[index]}`,
    );
  }
  if (final !== undefined) {
    invariant(
      stepById(workflow, jobId, final).index === workflowSteps(workflow, jobId).length - 1,
      `${jobId} phase ${final} must be the literal final step`,
    );
  }
}

function phaseLocation(value) {
  const separator = value.lastIndexOf(".");
  invariant(separator > 0 && separator < value.length - 1, `invalid phase location ${value}`);
  return { jobId: value.slice(0, separator), stepId: value.slice(separator + 1) };
}

function jobDependsOn(workflow, downstream, upstream, visited = new Set()) {
  if (downstream === upstream) return true;
  if (visited.has(downstream)) return false;
  visited.add(downstream);
  return strings(workflow.jobs?.[downstream]?.needs)
    .some((dependency) => jobDependsOn(workflow, dependency, upstream, visited));
}

export function assertPhaseChain(workflow, locations) {
  const phases = locations.map((location) => {
    const parsed = phaseLocation(location);
    return { ...parsed, ...stepById(workflow, parsed.jobId, parsed.stepId) };
  });
  for (let index = 1; index < phases.length; index += 1) {
    const before = phases[index - 1];
    const after = phases[index];
    const ordered = before.jobId === after.jobId
      ? before.index < after.index
      : jobDependsOn(workflow, after.jobId, before.jobId);
    invariant(
      ordered,
      `${locations[index - 1]} must precede ${locations[index]} through step order or the job DAG`,
    );
  }
}

function stripOuterParentheses(source) {
  let value = source.trim();
  while (value.startsWith("(") && value.endsWith(")")) {
    let depth = 0;
    let quoted;
    let closesAtEnd = false;
    for (let index = 0; index < value.length; index += 1) {
      const character = value[index];
      if (quoted !== undefined) {
        if (character === quoted && value[index - 1] !== "\\") quoted = undefined;
        continue;
      }
      if (character === "'" || character === '"') quoted = character;
      else if (character === "(") depth += 1;
      else if (character === ")") {
        depth -= 1;
        if (depth === 0) {
          closesAtEnd = index === value.length - 1;
          break;
        }
      }
    }
    if (!closesAtEnd) break;
    value = value.slice(1, -1).trim();
  }
  return value;
}

function splitBoolean(source, operator) {
  const parts = [];
  let depth = 0;
  let quoted;
  let start = 0;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quoted !== undefined) {
      if (character === quoted && source[index - 1] !== "\\") quoted = undefined;
      continue;
    }
    if (character === "'" || character === '"') quoted = character;
    else if (character === "(") depth += 1;
    else if (character === ")") depth -= 1;
    else if (depth === 0 && source.startsWith(operator, index)) {
      parts.push(source.slice(start, index));
      start = index + operator.length;
      index += operator.length - 1;
    }
  }
  if (parts.length === 0) return undefined;
  parts.push(source.slice(start));
  return parts;
}

function conditionAst(source) {
  let value = normalized(source)
    .replace(/^\$\{\{\s*/u, "")
    .replace(/\s*\}\}$/u, "");
  value = stripOuterParentheses(value);
  const disjunction = splitBoolean(value, "||");
  if (disjunction !== undefined) return { type: "or", values: disjunction.map(conditionAst) };
  const conjunction = splitBoolean(value, "&&");
  if (conjunction !== undefined) return { type: "and", values: conjunction.map(conditionAst) };
  if (value.startsWith("!")) return { type: "not", value: conditionAst(value.slice(1)) };
  return { type: "atom", value: normalized(value) };
}

function intersection(sets) {
  if (sets.length === 0) return new Set();
  return new Set([...sets[0]].filter((value) => sets.every((set) => set.has(value))));
}

function guaranteedConditionAtoms(ast) {
  if (ast.type === "atom") return new Set([ast.value]);
  if (ast.type === "not") {
    if (ast.value.type === "atom") return new Set([`!${ast.value.value}`]);
    return new Set();
  }
  const sets = ast.values.map(guaranteedConditionAtoms);
  if (ast.type === "or") return intersection(sets);
  return new Set(sets.flatMap((set) => [...set]));
}

function conditionBranches(ast) {
  if (ast.type === "atom") return [new Set([ast.value])];
  if (ast.type === "not") {
    return ast.value.type === "atom" ? [new Set([`!${ast.value.value}`])] : [];
  }
  const branches = ast.values.map(conditionBranches);
  if (ast.type === "or") return branches.flat();
  return branches.reduce(
    (combined, entries) => combined.flatMap((left) =>
      entries.map((right) => new Set([...left, ...right]))),
    [new Set()],
  );
}

function branchIdentity(branch) {
  return [...branch].sort().join("\u0000");
}

export function assertConditionRequires(condition, requiredAtoms, context) {
  invariant(typeof condition === "string" && condition.trim(), `${context} must declare an if condition`);
  const guaranteed = guaranteedConditionAtoms(conditionAst(condition));
  const missing = requiredAtoms.map(normalized).filter((atom) => !guaranteed.has(atom));
  invariant(
    missing.length === 0,
    `${context} condition does not guarantee ${JSON.stringify(missing)}; guaranteed atoms are ${JSON.stringify([...guaranteed].sort())}`,
  );
}

export function assertConditionBranches(condition, expectedBranches, context) {
  invariant(typeof condition === "string" && condition.trim(), `${context} must declare an if condition`);
  const actual = conditionBranches(conditionAst(condition)).map(branchIdentity).sort();
  const expected = expectedBranches
    .map((branch) => new Set(branch.map(normalized)))
    .map(branchIdentity)
    .sort();
  invariant(
    sameSet(actual, expected),
    `${context} condition branches must be ${JSON.stringify(expected)}; got ${JSON.stringify(actual)}`,
  );
}

function stripShellComment(line) {
  let quote;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      continue;
    }
    if (character === "#" && (index === 0 || /[\s;&|()]/u.test(line[index - 1]))) {
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

export function assertRunInvocation(workflow, jobId, stepId, pattern, description) {
  const entry = stepById(workflow, jobId, stepId);
  invariant(typeof entry.step.run === "string", `${jobId}.${stepId} must be a run step`);
  pattern.lastIndex = 0;
  invariant(
    pattern.test(executableShell(entry.step.run)),
    `${jobId}.${stepId} must actively invoke ${description}`,
  );
  return entry;
}

export function assertActionStep(workflow, jobId, stepId, usesPrefix) {
  const entry = stepById(workflow, jobId, stepId);
  invariant(
    String(entry.step.uses ?? "").startsWith(usesPrefix),
    `${jobId}.${stepId} must use ${usesPrefix}`,
  );
  return entry;
}

const ACTIVE_COMMAND_BOUNDARY = String.raw`(?:^|[\n;|&()])\s*`;
const OPTIONAL_COMMAND_PREFIX = String.raw`(?:(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s]+)|command|sudo)\s+)*`;
const MUTATION_PATTERNS = new Map([
  ["release_pr_push", new RegExp(`${ACTIVE_COMMAND_BOUNDARY}(?:tools/dev/bun[.]sh|bun|node)\\s+[^\\n]*normalize-release-please-pr[.]mjs\\s+push\\b`, "mu")],
  ["github_stage", new RegExp(`${ACTIVE_COMMAND_BOUNDARY}(?:tools/dev/bun[.]sh|bun|node)\\s+[^\\n]*manage-release-drafts[.]mjs\\s+stage\\b`, "mu")],
  ["github_promote", new RegExp(`${ACTIVE_COMMAND_BOUNDARY}(?:tools/dev/bun[.]sh|bun|node)\\s+[^\\n]*manage-release-drafts[.]mjs\\s+promote\\b`, "mu")],
  ["release_publish", new RegExp(`${ACTIVE_COMMAND_BOUNDARY}(?:tools/dev/bun[.]sh|bun|node)\\s+[^\\n]*release-publish[.]mjs\\s+publish(?:\\s|\\\\$)`, "mu")],
  ["registry_bootstrap", new RegExp(`${ACTIVE_COMMAND_BOUNDARY}(?:tools/dev/bun[.]sh|bun|node)\\s+[^\\n]*bootstrap-registry-identities[.]mjs\\b`, "mu")],
  ["unmediated_package_publish", new RegExp(`${ACTIVE_COMMAND_BOUNDARY}${OPTIONAL_COMMAND_PREFIX}(?:(?:npm|cargo)\\s+[^\\n;&|]*\\bpublish\\b|(?:mvn|gradle|[.]\\/gradlew)\\s+[^\\n;&|]*(?:deploy|publish)\\b|(?:npx\\s+)?jsr\\s+[^\\n;&|]*\\bpublish\\b)`, "mu")],
  ["unmediated_git_push", new RegExp(`${ACTIVE_COMMAND_BOUNDARY}git\\s+[^\\n]*\\bpush\\b`, "mu")],
  ["unmediated_github_release", new RegExp(`${ACTIVE_COMMAND_BOUNDARY}gh\\s+release\\s+(?:create|delete|edit|upload)\\b`, "mu")],
  ["unmediated_github_api_write", new RegExp(`${ACTIVE_COMMAND_BOUNDARY}gh\\s+api\\s+[^\\n]*(?:(?:-X|--method)\\s+(?:POST|PUT|PATCH|DELETE))`, "mu")],
]);

function detectedMutations(step) {
  const mutations = [];
  if (typeof step.run === "string") {
    const shell = executableShell(step.run);
    for (const [kind, pattern] of MUTATION_PATTERNS) {
      pattern.lastIndex = 0;
      if (pattern.test(shell)) mutations.push(kind);
    }
  }
  const uses = String(step.uses ?? "");
  if (uses.startsWith("actions/attest-build-provenance@")) mutations.push("attestation");
  if (uses.startsWith("googleapis/release-please-action@")) mutations.push("release_please");
  return mutations;
}

export function assertMutationBoundary(workflow, expected) {
  const observed = new Map();
  const allowed = new Map(
    Object.entries(expected).map(([kind, locations]) => [kind, new Set(locations)]),
  );
  for (const [jobId, job] of Object.entries(workflow.jobs)) {
    for (const step of job.steps ?? []) {
      const location = `${jobId}.${step.id ?? "<missing-id>"}`;
      for (const kind of detectedMutations(step)) {
        const permitted = allowed.get(kind);
        invariant(
          permitted?.has(location) === true,
          `${location} performs unapproved ${kind} mutation`,
        );
        const key = `${kind}:${location}`;
        observed.set(key, (observed.get(key) ?? 0) + 1);
      }
    }
  }
  for (const [kind, locations] of allowed) {
    for (const location of locations) {
      invariant(
        observed.get(`${kind}:${location}`) === 1,
        `${location} must contain exactly one active ${kind} mutation`,
      );
    }
  }
}

export function assertCheckout(step, ref, context) {
  invariant(String(step.uses ?? "").startsWith("actions/checkout@"), `${context} must use checkout`);
  if (ref !== undefined) {
    invariant(step.with?.ref === ref, `${context} checkout ref must be ${ref}`);
  }
  invariant(
    step.with?.["persist-credentials"] === false,
    `${context} checkout must disable persisted credentials`,
  );
}

export function assertAllCheckouts(workflow, ref) {
  for (const [jobId, job] of Object.entries(workflow.jobs)) {
    for (const step of job.steps ?? []) {
      if (String(step.uses ?? "").startsWith("actions/checkout@")) {
        assertCheckout(step, ref, jobId);
      }
    }
  }
}

export function assertUploadById(
  workflow,
  jobId,
  stepId,
  { name, path: artifactPath, ifNoFiles = "error" } = {},
) {
  const entry = assertActionStep(workflow, jobId, stepId, "actions/upload-artifact@");
  if (name !== undefined) invariant(entry.step.with?.name === name, `${jobId}.${stepId} artifact name must be ${name}`);
  if (artifactPath !== undefined) invariant(entry.step.with?.path === artifactPath, `${jobId}.${stepId} artifact path must be ${artifactPath}`);
  if (ifNoFiles !== undefined) {
    invariant(
      entry.step.with?.["if-no-files-found"] === ifNoFiles,
      `${jobId}.${stepId} if-no-files-found must be ${ifNoFiles}`,
    );
  }
  return entry;
}
