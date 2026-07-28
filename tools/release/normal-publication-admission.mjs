import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

export const NORMAL_PUBLICATION_ADMISSION_SCHEMA = "oliphaunt-normal-publication-admission-v1";
export const DEFAULT_NORMAL_PUBLICATION_ADMISSION = "target/release/normal-publication-admission.json";

const MAX_ADMISSION_BYTES = 4 * 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/u;

function error(message) {
  return new Error(`normal-publication-admission: ${message}`);
}

function compareText(left, right) {
  const a = String(left);
  const b = String(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort(compareText).map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function object(value, context) {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw error(`${context} must be an object`);
  }
  return value;
}

function exactKeys(value, keys, context) {
  object(value, context);
  const actual = Object.keys(value).sort(compareText);
  const expected = [...keys].sort(compareText);
  if (stableJson(actual) !== stableJson(expected)) {
    throw error(`${context} keys must be exactly ${expected.join(", ")}`);
  }
}

function positiveInteger(value, context) {
  if (!Number.isSafeInteger(value) || value < 1) throw error(`${context} must be a positive safe integer`);
  return value;
}

function orderedProjection(values, planIds, context) {
  if (
    !Array.isArray(values)
    || values.some((id) => typeof id !== "string" || id.length === 0)
    || new Set(values).size !== values.length
  ) {
    throw error(`${context} must be a unique string list`);
  }
  const selected = new Set(values);
  const canonical = planIds.filter((id) => selected.has(id));
  if (canonical.length !== selected.size || stableJson(canonical) !== stableJson(values)) {
    throw error(`${context} must be an ordered exact-plan projection`);
  }
  return values;
}

function planPartition(plan, completedIds, admittedIds, unadmittedIds) {
  if (!Array.isArray(plan?.operations)) throw error("normal publication plan must contain operations");
  const planIds = plan.operations.map(({ id }, index) => {
    if (typeof id !== "string" || id.length === 0 || plan.operations[index].operationOrder !== index) {
      throw error(`normal publication operation ${index} is not canonical`);
    }
    return id;
  });
  if (new Set(planIds).size !== planIds.length) throw error("normal publication plan repeats an operation ID");
  orderedProjection(completedIds, planIds, "completedOperationIds");
  orderedProjection(admittedIds, planIds, "admittedOperationIds");
  orderedProjection(unadmittedIds, planIds, "unadmittedOperationIds");
  const groups = [completedIds, admittedIds, unadmittedIds];
  const union = new Set(groups.flat());
  if (
    union.size !== planIds.length
    || groups.flat().length !== planIds.length
    || planIds.some((id) => !union.has(id))
  ) {
    throw error("completed, admitted, and unadmitted operation IDs must exactly partition the canonical plan");
  }
  const completed = new Set(completedIds);
  const executable = new Set([...completedIds, ...admittedIds]);
  const operationById = new Map(plan.operations.map((operation) => [operation.id, operation]));
  for (const id of completedIds) {
    const missing = operationById.get(id).dependencies.filter((dependency) => !completed.has(dependency));
    if (missing.length > 0) throw error(`completed operation ${id} omits dependencies ${missing.join(", ")}`);
  }
  for (const id of admittedIds) {
    const missing = operationById.get(id).dependencies.filter((dependency) => !executable.has(dependency));
    if (missing.length > 0) throw error(`admitted operation ${id} omits dependencies ${missing.join(", ")}`);
  }
}

function binding(lock, products, plan, checkpoint) {
  object(lock, "publication lock");
  object(lock.source, "publication lock source");
  for (const field of ["lockDigest", "catalogDigest", "packageEnvelopeDigest"]) {
    if (!SHA256.test(lock[field] ?? "")) throw error(`publication lock ${field} must be a lowercase SHA-256 digest`);
  }
  for (const field of ["commit", "tree"]) {
    if (!/^[0-9a-f]{40,64}$/u.test(lock.source[field] ?? "")) {
      throw error(`publication lock source.${field} must be a lowercase Git object ID`);
    }
  }
  if (
    !Array.isArray(products)
    || products.length === 0
    || products.some((product) => typeof product !== "string" || product.length === 0)
    || new Set(products).size !== products.length
  ) {
    throw error("selected products must be a nonempty unique string list");
  }
  if (!SHA256.test(checkpoint?.checkpointDigest ?? "")) {
    throw error("normal publication checkpoint must expose a lowercase SHA-256 checkpointDigest");
  }
  return {
    source: { commit: lock.source.commit, tree: lock.source.tree },
    lock: {
      lockDigest: lock.lockDigest,
      catalogDigest: lock.catalogDigest,
      packageEnvelopeDigest: lock.packageEnvelopeDigest,
    },
    products: [...products].sort(compareText),
    planDigest: digest(plan),
    checkpointDigest: checkpoint.checkpointDigest,
  };
}

function withoutDigest(value) {
  return {
    schema: value.schema,
    decision: value.decision,
    source: value.source,
    lock: value.lock,
    products: value.products,
    planDigest: value.planDigest,
    checkpointDigest: value.checkpointDigest,
    authoritativeWindowSeconds: value.authoritativeWindowSeconds,
    requiredWindowSeconds: value.requiredWindowSeconds,
    completedOperationIds: value.completedOperationIds,
    admittedOperationIds: value.admittedOperationIds,
    unadmittedOperationIds: value.unadmittedOperationIds,
    publicationCompleteAfterAdmission: value.publicationCompleteAfterAdmission,
  };
}

export function normalPublicationAdmissionDocument({
  lock,
  products,
  plan,
  checkpoint,
  assessment,
}) {
  if (assessment?.decision !== "execute") {
    throw error("only an execute decision can authorize normal registry publication");
  }
  const expected = binding(lock, products, plan, checkpoint);
  const completedOperationIds = assessment.completedOperationIds ?? [];
  const admittedOperationIds = assessment.admittedOperationIds ?? [];
  const unadmittedOperationIds = assessment.unadmittedOperationIds ?? [];
  planPartition(plan, completedOperationIds, admittedOperationIds, unadmittedOperationIds);
  if (stableJson(completedOperationIds) !== stableJson(checkpoint.completedOperations)) {
    throw error("admission completedOperationIds differ from the bound checkpoint");
  }
  const authoritativeWindowSeconds = positiveInteger(
    assessment.authoritativeMutationWindowSeconds,
    "authoritativeWindowSeconds",
  );
  const requiredWindowSeconds = positiveInteger(assessment.minimumMutationWindowSeconds, "requiredWindowSeconds");
  if (requiredWindowSeconds > authoritativeWindowSeconds) {
    throw error("admitted operation subset exceeds the authoritative mutation window");
  }
  if (unadmittedOperationIds.length > 0 && admittedOperationIds.length === 0) {
    throw error("an incomplete execute admission must authorize nonzero durable progress");
  }
  const base = {
    schema: NORMAL_PUBLICATION_ADMISSION_SCHEMA,
    decision: "execute",
    ...expected,
    authoritativeWindowSeconds,
    requiredWindowSeconds,
    completedOperationIds,
    admittedOperationIds,
    unadmittedOperationIds,
    publicationCompleteAfterAdmission: unadmittedOperationIds.length === 0,
  };
  return { ...base, admissionDigest: digest(base) };
}

export function validateNormalPublicationAdmission(value, {
  lock,
  products,
  plan,
  checkpoint,
  authoritativeWindowSeconds,
} = {}) {
  exactKeys(value, [
    "schema",
    "decision",
    "source",
    "lock",
    "products",
    "planDigest",
    "checkpointDigest",
    "authoritativeWindowSeconds",
    "requiredWindowSeconds",
    "completedOperationIds",
    "admittedOperationIds",
    "unadmittedOperationIds",
    "publicationCompleteAfterAdmission",
    "admissionDigest",
  ], "normal publication admission");
  if (value.schema !== NORMAL_PUBLICATION_ADMISSION_SCHEMA || value.decision !== "execute") {
    throw error("normal publication admission has an unsupported schema or decision");
  }
  if (!SHA256.test(value.admissionDigest ?? "") || value.admissionDigest !== digest(withoutDigest(value))) {
    throw error("normal publication admission digest does not match its canonical content");
  }
  const expected = binding(lock, products, plan, checkpoint);
  for (const key of ["source", "lock", "products", "planDigest", "checkpointDigest"]) {
    if (stableJson(value[key]) !== stableJson(expected[key])) {
      throw error(`normal publication admission ${key} is stale or substituted`);
    }
  }
  planPartition(plan, value.completedOperationIds, value.admittedOperationIds, value.unadmittedOperationIds);
  if (stableJson(value.completedOperationIds) !== stableJson(checkpoint.completedOperations)) {
    throw error("normal publication admission completed operations differ from the bound checkpoint");
  }
  positiveInteger(value.authoritativeWindowSeconds, "authoritativeWindowSeconds");
  positiveInteger(value.requiredWindowSeconds, "requiredWindowSeconds");
  if (
    value.requiredWindowSeconds > value.authoritativeWindowSeconds
    || (authoritativeWindowSeconds !== undefined && value.authoritativeWindowSeconds !== authoritativeWindowSeconds)
  ) {
    throw error("normal publication admission window does not match the authoritative workflow window");
  }
  if (
    value.publicationCompleteAfterAdmission !== (value.unadmittedOperationIds.length === 0)
    || (value.unadmittedOperationIds.length > 0 && value.admittedOperationIds.length === 0)
  ) {
    throw error("normal publication admission progress/completion state is inconsistent");
  }
  return {
    ...withoutDigest(value),
    admissionDigest: value.admissionDigest,
  };
}

export function writeNormalPublicationAdmission(file, options) {
  const document = normalPublicationAdmissionDocument(options);
  const absolute = path.resolve(file);
  mkdirSync(path.dirname(absolute), { recursive: true });
  if (existsSync(absolute)) {
    const metadata = lstatSync(absolute);
    if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > MAX_ADMISSION_BYTES) {
      throw error(`refusing to replace unsafe admission file ${file}`);
    }
  }
  const temporary = `${absolute}.tmp-${process.pid}`;
  rmSync(temporary, { force: true });
  let descriptor;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(document, null, 2)}\n`);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, absolute);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
  return document;
}

export function loadNormalPublicationAdmission(file, expected) {
  const absolute = path.resolve(file);
  let metadata;
  try { metadata = lstatSync(absolute); } catch (cause) {
    throw error(`cannot inspect admission file ${file}: ${cause.message}`);
  }
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size < 2 || metadata.size > MAX_ADMISSION_BYTES) {
    throw error(`admission file ${file} must be a bounded regular non-symlink file`);
  }
  let value;
  try { value = JSON.parse(readFileSync(absolute, "utf8")); } catch (cause) {
    throw error(`admission file ${file} is not strict JSON: ${cause.message}`);
  }
  return validateNormalPublicationAdmission(value, expected);
}
