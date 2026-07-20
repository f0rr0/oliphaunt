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
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import {
  validateLockedRegistryReceipts,
  verifyLockedRegistryIntegrity,
} from "./registry-integrity.mjs";

export const NORMAL_PUBLICATION_CHECKPOINT_SCHEMA = "oliphaunt-normal-publication-checkpoint-v1";
export const DEFAULT_NORMAL_PUBLICATION_CHECKPOINT = "target/release/normal-publication-checkpoint.json";

const MAX_CHECKPOINT_BYTES = 64 * 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/u;

function error(message) {
  return new Error(`normal-publication-checkpoint: ${message}`);
}

function compareText(left, right) {
  const renderedLeft = String(left);
  const renderedRight = String(right);
  return renderedLeft < renderedRight ? -1 : renderedLeft > renderedRight ? 1 : 0;
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

function uniqueStrings(value, context, { allowEmpty = true, sort = true } = {}) {
  if (
    !Array.isArray(value)
    || (!allowEmpty && value.length === 0)
    || value.some((item) => typeof item !== "string" || item.length === 0)
    || new Set(value).size !== value.length
  ) {
    throw error(`${context} must be a ${allowEmpty ? "" : "nonempty "}unique string list`);
  }
  return sort ? [...value].sort(compareText) : [...value];
}

function lockBinding(lock) {
  object(lock, "publication lock");
  for (const field of ["lockDigest", "catalogDigest", "packageEnvelopeDigest"]) {
    if (typeof lock[field] !== "string" || !SHA256.test(lock[field])) {
      throw error(`publication lock ${field} must be a lowercase SHA-256 digest`);
    }
  }
  object(lock.source, "publication lock source");
  for (const field of ["commit", "tree"]) {
    if (typeof lock.source[field] !== "string" || !/^[0-9a-f]{40,64}$/u.test(lock.source[field])) {
      throw error(`publication lock source.${field} must be a lowercase Git object id`);
    }
  }
  return {
    lockDigest: lock.lockDigest,
    catalogDigest: lock.catalogDigest,
    packageEnvelopeDigest: lock.packageEnvelopeDigest,
    source: { commit: lock.source.commit, tree: lock.source.tree },
  };
}

function operationCarrierIds(operation) {
  return operation.kind === "carrier" ? [operation.carrierId] : operation.carrierIds;
}

function operationEnvelope(operation) {
  const row = {
    id: operation.id,
    kind: operation.kind,
    ecosystem: operation.ecosystem,
  };
  if (operation.kind === "carrier") {
    row.product = operation.product;
    row.carrierId = operation.carrierId;
  }
  return {
    ...row,
    products: uniqueStrings(operation.products, `${operation.id} products`),
    carrierIds: uniqueStrings(operationCarrierIds(operation), `${operation.id} carrierIds`, {
      allowEmpty: false,
      sort: false,
    }),
    firstPublishOrder: operation.firstPublishOrder,
    lastPublishOrder: operation.lastPublishOrder,
    dependencies: uniqueStrings(operation.dependencies, `${operation.id} dependencies`, { sort: false }),
    operationOrder: operation.operationOrder,
  };
}

function canonicalPlan(lock, products, plan) {
  object(plan, "normal publication plan");
  const selectedProducts = uniqueStrings(products, "selected products", { allowEmpty: false });
  const planProducts = uniqueStrings(plan.products, "normal publication plan products", { allowEmpty: false });
  if (stableJson(selectedProducts) !== stableJson(planProducts)) {
    throw error("normal publication plan products do not exactly match the selected products");
  }
  if (!Number.isSafeInteger(plan.carrierCount) || plan.carrierCount < 0 || !Array.isArray(plan.operations)) {
    throw error("normal publication plan must contain a non-negative carrierCount and operations list");
  }
  if (!Array.isArray(lock.carriers)) throw error("publication lock must contain a carriers list");
  const lockedById = new Map(lock.carriers.map((carrier) => [carrier.id, carrier]));
  if (lockedById.size !== lock.carriers.length) throw error("publication lock contains duplicate carrier IDs");
  const selectedSet = new Set(selectedProducts);
  const expectedCarrierIds = lock.carriers
    .filter((carrier) => selectedSet.has(carrier.product))
    .sort((left, right) => left.publishOrder - right.publishOrder || compareText(left.id, right.id))
    .map(({ id }) => id);
  const operationIds = new Set();
  const carrierIds = new Set();
  const canonicalOperations = [];
  for (const [index, operation] of plan.operations.entries()) {
    object(operation, `normal publication operation ${index}`);
    if (operation.operationOrder !== index || typeof operation.id !== "string" || operation.id.length === 0) {
      throw error(`normal publication operation ${index} is not in contiguous canonical order`);
    }
    if (operationIds.has(operation.id)) throw error(`normal publication operation ${operation.id} is duplicated`);
    operationIds.add(operation.id);
    const dependencies = uniqueStrings(operation.dependencies, `${operation.id} dependencies`, { sort: false });
    for (const dependency of dependencies) {
      if (!operationIds.has(dependency)) {
        throw error(`${operation.id} dependency ${dependency} is unknown or not earlier in canonical order`);
      }
    }
    if (!new Set(["cargo", "npm", "maven", "jsr"]).has(operation.ecosystem)) {
      throw error(`${operation.id} uses unsupported ecosystem ${JSON.stringify(operation.ecosystem)}`);
    }
    let ids;
    const row = {
      id: operation.id,
      kind: operation.kind,
      ecosystem: operation.ecosystem,
    };
    if (operation.kind === "carrier") {
      if (
        operation.ecosystem === "maven"
        || typeof operation.product !== "string"
        || typeof operation.carrierId !== "string"
        || stableJson(operation.carrierIds) !== stableJson([operation.carrierId])
      ) {
        throw error(`carrier operation ${operation.id} has an invalid identity envelope`);
      }
      ids = [operation.carrierId];
      row.product = operation.product;
      row.carrierId = operation.carrierId;
    } else if (operation.kind === "maven-atomic-deployment") {
      if (operation.ecosystem !== "maven") throw error(`${operation.id} must use the Maven ecosystem`);
      ids = uniqueStrings(operation.carrierIds, `${operation.id} carrierIds`, { allowEmpty: false, sort: false });
    } else {
      throw error(`${operation.id} uses unsupported kind ${JSON.stringify(operation.kind)}`);
    }
    for (const id of ids) {
      if (carrierIds.has(id)) throw error(`normal publication carrier ${id} is assigned to multiple operations`);
      carrierIds.add(id);
      const carrier = lockedById.get(id);
      if (carrier === undefined || carrier.ecosystem !== operation.ecosystem || !selectedSet.has(carrier.product)) {
        throw error(`${operation.id} carrier ${id} does not match the selected frozen publication lock`);
      }
      if (operation.kind === "carrier" && carrier.product !== operation.product) {
        throw error(`${operation.id} product does not match ${id}`);
      }
    }
    const operationProducts = [...new Set(ids.map((id) => lockedById.get(id).product))].sort(compareText);
    if (stableJson(operationProducts) !== stableJson(uniqueStrings(operation.products, `${operation.id} products`))) {
      throw error(`${operation.id} products do not match its frozen carriers`);
    }
    const publishOrders = ids.map((id) => lockedById.get(id).publishOrder);
    if (
      operation.firstPublishOrder !== Math.min(...publishOrders)
      || operation.lastPublishOrder !== Math.max(...publishOrders)
    ) {
      throw error(`${operation.id} publish-order envelope does not match its frozen carriers`);
    }
    canonicalOperations.push({
      ...row,
      products: operationProducts,
      carrierIds: ids,
      firstPublishOrder: operation.firstPublishOrder,
      lastPublishOrder: operation.lastPublishOrder,
      dependencies,
      operationOrder: index,
    });
  }
  if (
    carrierIds.size !== plan.carrierCount
    || stableJson([...carrierIds].sort(compareText)) !== stableJson([...expectedCarrierIds].sort(compareText))
  ) {
    throw error("normal publication operations do not exactly partition every selected frozen carrier");
  }
  return { products: selectedProducts, carrierCount: plan.carrierCount, operations: canonicalOperations };
}

function checkpointWithoutDigest({ lock, products, plan, completedOperations, receipts }) {
  return {
    schema: NORMAL_PUBLICATION_CHECKPOINT_SCHEMA,
    lock,
    products,
    plan,
    completedOperations,
    receipts,
  };
}

function checkpointDocument(value) {
  const base = checkpointWithoutDigest(value);
  return { ...base, checkpointDigest: digest(base) };
}

function atomicWrite(file, value) {
  const absolute = path.resolve(file);
  mkdirSync(path.dirname(absolute), { recursive: true });
  if (existsSync(absolute)) {
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_CHECKPOINT_BYTES) {
      throw error(`refusing to replace unsafe checkpoint ${file}`);
    }
  }
  const temporary = `${absolute}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  let descriptor;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, absolute);
    try {
      const directory = openSync(path.dirname(absolute), "r");
      try { fsyncSync(directory); } finally { closeSync(directory); }
    } catch (cause) {
      if (!new Set(["EINVAL", "ENOTSUP", "EPERM", "EISDIR"]).has(cause?.code)) throw cause;
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    try { unlinkSync(temporary); } catch {}
  }
}

function readCheckpoint(file) {
  const absolute = path.resolve(file);
  let stat;
  try { stat = lstatSync(absolute); } catch (cause) {
    if (cause?.code === "ENOENT") return null;
    throw error(`cannot inspect checkpoint ${file}: ${cause.message}`);
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_CHECKPOINT_BYTES) {
    throw error(`checkpoint ${file} must be a regular non-symlink file no larger than ${MAX_CHECKPOINT_BYTES} bytes`);
  }
  try {
    return JSON.parse(readFileSync(absolute, "utf8"));
  } catch (cause) {
    throw error(`checkpoint ${file} is not strict JSON: ${cause.message}`);
  }
}

function validateCheckpoint(raw, expected, lock) {
  exactKeys(raw, [
    "schema",
    "lock",
    "products",
    "plan",
    "completedOperations",
    "receipts",
    "checkpointDigest",
  ], "checkpoint");
  if (raw.schema !== NORMAL_PUBLICATION_CHECKPOINT_SCHEMA) {
    throw error(`checkpoint schema must be ${NORMAL_PUBLICATION_CHECKPOINT_SCHEMA}`);
  }
  if (!SHA256.test(raw.checkpointDigest ?? "")) throw error("checkpointDigest must be a lowercase SHA-256 digest");
  const base = checkpointWithoutDigest(raw);
  if (raw.checkpointDigest !== digest(base)) throw error("checkpointDigest does not match checkpoint content");
  if (
    stableJson(raw.lock) !== stableJson(expected.lock)
    || stableJson(raw.products) !== stableJson(expected.products)
    || stableJson(raw.plan) !== stableJson(expected.plan)
  ) {
    throw error("checkpoint is stale for the active lock source, package envelope, product selection, or publication plan");
  }
  const completedOperations = uniqueStrings(raw.completedOperations, "completedOperations", { sort: false });
  const operationById = new Map(expected.plan.operations.map((operation) => [operation.id, operation]));
  const sortedCompleted = [...completedOperations].sort(
    (left, right) => operationById.get(left)?.operationOrder - operationById.get(right)?.operationOrder,
  );
  if (completedOperations.some((id) => !operationById.has(id)) || stableJson(completedOperations) !== stableJson(sortedCompleted)) {
    throw error("completedOperations must be a canonical operation-order subset of the active plan");
  }
  const completedSet = new Set(completedOperations);
  for (const operationId of completedOperations) {
    const missing = operationById.get(operationId).dependencies.filter((dependency) => !completedSet.has(dependency));
    if (missing.length > 0) {
      throw error(`completed operation ${operationId} is missing completed dependencies: ${missing.join(", ")}`);
    }
  }
  const completedCarrierIds = completedOperations.flatMap((id) => operationById.get(id).carrierIds);
  const receipts = validateLockedRegistryReceipts(lock, {
    carrierIds: completedCarrierIds,
    receipts: raw.receipts,
  });
  return checkpointDocument({
    lock: expected.lock,
    products: expected.products,
    plan: expected.plan,
    completedOperations,
    receipts,
  });
}

function resultReceipts(value) {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

export function openNormalPublicationCheckpoint({
  file = DEFAULT_NORMAL_PUBLICATION_CHECKPOINT,
  lock,
  products,
  plan,
  initialReceipts = [],
} = {}) {
  const expected = {
    lock: lockBinding(lock),
    products: uniqueStrings(products, "selected products", { allowEmpty: false }),
    plan: canonicalPlan(lock, products, plan),
  };
  if (!Array.isArray(initialReceipts)) throw error("initial receipts must be a list");
  const selectedCarrierIds = new Set(expected.plan.operations.flatMap(({ carrierIds }) => carrierIds));
  const initialById = new Map();
  for (const receipt of initialReceipts) {
    if (receipt === null || Array.isArray(receipt) || typeof receipt !== "object" || typeof receipt.id !== "string") {
      throw error("initial receipts must contain receipt objects with IDs");
    }
    const carrier = lock.carriers.find(({ id }) => id === receipt.id);
    if (
      carrier === undefined
      || !selectedCarrierIds.has(receipt.id)
      || !new Set(["cargo", "npm"]).has(carrier.ecosystem)
      || initialById.has(receipt.id)
    ) {
      throw error(`initial receipt ${receipt.id} is not a unique selected Cargo/npm bootstrap receipt`);
    }
    initialById.set(receipt.id, receipt);
  }
  if (initialReceipts.length > 0) {
    validateLockedRegistryReceipts(lock, { carrierIds: [...initialById.keys()], receipts: initialReceipts });
  }

  const empty = checkpointDocument({ ...expected, completedOperations: [], receipts: [] });
  const raw = readCheckpoint(file);
  let current = raw === null ? empty : validateCheckpoint(raw, expected, lock);
  if (raw === null) atomicWrite(file, current);
  const operationById = new Map(expected.plan.operations.map((operation) => [operation.id, operation]));

  function completedOperationResults(receipts = current.receipts) {
    const byId = new Map(receipts.map((receipt) => [receipt.id, receipt]));
    return new Map(current.completedOperations.map((operationId) => {
      const operation = operationById.get(operationId);
      const operationReceipts = operation.carrierIds.map((id) => byId.get(id));
      const result = operation.kind === "carrier" && initialById.has(operation.carrierId)
        ? undefined
        : operation.kind === "carrier" ? operationReceipts[0] : operationReceipts;
      return [operationId, result];
    }));
  }

  function recordOperation(operation, value) {
    const canonical = operationById.get(operation?.id);
    let observedEnvelope;
    try {
      observedEnvelope = operationEnvelope(operation);
    } catch {
      observedEnvelope = null;
    }
    if (canonical === undefined || stableJson(canonical) !== stableJson(observedEnvelope)) {
      throw error(`completed operation ${operation?.id ?? "<unknown>"} does not match the active plan`);
    }
    if (current.completedOperations.includes(canonical.id)) {
      throw error(`operation ${canonical.id} is already checkpointed`);
    }
    const completed = new Set(current.completedOperations);
    const missingDependencies = canonical.dependencies.filter((dependency) => !completed.has(dependency));
    if (missingDependencies.length > 0) {
      throw error(`operation ${canonical.id} completed before checkpointed dependencies ${missingDependencies.join(", ")}`);
    }
    const observed = new Map();
    for (const receipt of resultReceipts(value)) {
      if (receipt === null || Array.isArray(receipt) || typeof receipt !== "object" || typeof receipt.id !== "string" || observed.has(receipt.id)) {
        throw error(`operation ${canonical.id} returned invalid or duplicate receipts`);
      }
      observed.set(receipt.id, receipt);
    }
    for (const id of canonical.carrierIds) {
      if (!observed.has(id) && initialById.has(id)) observed.set(id, initialById.get(id));
    }
    const operationReceipts = canonical.carrierIds.map((id) => observed.get(id));
    if (observed.size !== canonical.carrierIds.length || operationReceipts.some((receipt) => receipt === undefined)) {
      throw error(`operation ${canonical.id} did not return its exact frozen carrier receipt set`);
    }
    validateLockedRegistryReceipts(lock, { carrierIds: canonical.carrierIds, receipts: operationReceipts });
    const completedOperations = [...current.completedOperations, canonical.id]
      .sort((left, right) => operationById.get(left).operationOrder - operationById.get(right).operationOrder);
    const allReceiptById = new Map(current.receipts.map((receipt) => [receipt.id, receipt]));
    for (const receipt of operationReceipts) allReceiptById.set(receipt.id, receipt);
    const completedCarrierIds = completedOperations.flatMap((id) => operationById.get(id).carrierIds);
    const receipts = validateLockedRegistryReceipts(lock, {
      carrierIds: completedCarrierIds,
      receipts: [...allReceiptById.values()],
    });
    const next = checkpointDocument({ ...expected, completedOperations, receipts });
    atomicWrite(file, next);
    current = next;
  }

  async function reconcileCompleted({ verifyImpl = verifyLockedRegistryIntegrity } = {}) {
    if (typeof verifyImpl !== "function") throw error("checkpoint reconciliation verifier must be a function");
    const carrierIds = current.completedOperations.flatMap((id) => operationById.get(id).carrierIds);
    if (carrierIds.length === 0) return completedOperationResults();
    const verified = await verifyImpl(lock, { carrierIds });
    const receipts = validateLockedRegistryReceipts(lock, { carrierIds, receipts: verified });
    if (stableJson(receipts) !== stableJson(current.receipts)) {
      throw error("live registry reconciliation does not match the checkpointed frozen receipts");
    }
    return completedOperationResults(receipts);
  }

  return {
    get checkpoint() { return current; },
    completedOperationResults,
    reconcileCompleted,
    recordOperation,
  };
}
