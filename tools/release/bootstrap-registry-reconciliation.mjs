function error(message) {
  return new Error(`bootstrap-registry-reconciliation: ${message}`);
}

function identityKey(name, version) {
  return `${name}\0${version}`;
}

function requiredIdentity(value, context) {
  if (
    value === null
    || Array.isArray(value)
    || typeof value !== "object"
    || typeof value.name !== "string"
    || value.name.length === 0
    || typeof value.version !== "string"
    || value.version.length === 0
  ) {
    throw error(`${context} must contain a package name and exact version`);
  }
  return identityKey(value.name, value.version);
}

function uniqueSet(values, context) {
  const result = new Set(values);
  if (result.size !== values.length) throw error(`${context} contains duplicates`);
  return result;
}

function sameSet(left, right) {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function inventoryStates(ecosystem, expectedCarriers, inventory) {
  if (
    inventory === null
    || Array.isArray(inventory)
    || typeof inventory !== "object"
    || !Array.isArray(inventory.selectedIdentities)
    || !Array.isArray(inventory.publishedIdentities)
    || !Array.isArray(inventory.pendingVersions)
    || !Array.isArray(inventory.missingNames)
  ) {
    throw error(`${ecosystem} inventory must contain selected, published, pending-version, and missing-name lists`);
  }
  const expectedKeys = uniqueSet(
    expectedCarriers.map(({ name, version }, index) => requiredIdentity({ name, version }, `${ecosystem} plan entry ${index}`)),
    `${ecosystem} plan`,
  );
  const selectedKeys = uniqueSet(
    inventory.selectedIdentities.map((identity, index) => requiredIdentity(identity, `${ecosystem} selected identity ${index}`)),
    `${ecosystem} selected identities`,
  );
  if (!sameSet(expectedKeys, selectedKeys)) {
    throw error(`${ecosystem} inventory selection does not exactly match the frozen bootstrap plan`);
  }

  const published = uniqueSet(
    inventory.publishedIdentities.map((identity, index) => requiredIdentity(identity, `${ecosystem} published identity ${index}`)),
    `${ecosystem} published identities`,
  );
  const pendingVersions = uniqueSet(
    inventory.pendingVersions.map((identity, index) => requiredIdentity(identity, `${ecosystem} pending version ${index}`)),
    `${ecosystem} pending versions`,
  );
  const byName = new Map(expectedCarriers.map((carrier) => [carrier.name, carrier]));
  if (byName.size !== expectedCarriers.length) {
    throw error(`${ecosystem} bootstrap plan contains duplicate package names`);
  }
  const missingNames = uniqueSet(inventory.missingNames.map((name, index) => {
    if (typeof name !== "string" || name.length === 0) {
      throw error(`${ecosystem} missing name ${index} must be a non-empty string`);
    }
    if (!byName.has(name)) throw error(`${ecosystem} inventory contains unknown missing name ${name}`);
    return name;
  }), `${ecosystem} missing names`);

  const states = new Map();
  for (const carrier of expectedCarriers) {
    const key = identityKey(carrier.name, carrier.version);
    const matches = Number(published.has(key)) + Number(pendingVersions.has(key)) + Number(missingNames.has(carrier.name));
    if (matches !== 1) {
      throw error(`${carrier.id} must have exactly one registry inventory state, observed ${matches}`);
    }
    if (published.has(key)) states.set(carrier.id, "published");
    else if (pendingVersions.has(key)) states.set(carrier.id, "pending-version");
    else states.set(carrier.id, "missing-name");
  }
  for (const key of [...published, ...pendingVersions]) {
    if (!expectedKeys.has(key)) throw error(`${ecosystem} inventory contains an identity outside the frozen bootstrap plan`);
  }
  return states;
}

export function reconcileBootstrapRegistryState({
  plan,
  cargoInventory,
  npmInventory,
  checkpoint = null,
}) {
  if (
    !Array.isArray(plan)
    || plan.length === 0
    || plan.some((carrier) =>
      carrier === null
      || Array.isArray(carrier)
      || typeof carrier !== "object"
      || typeof carrier.id !== "string"
      || carrier.id !== `${carrier.ecosystem}:${carrier.name}`
      || !["cargo", "npm"].includes(carrier.ecosystem)
      || typeof carrier.version !== "string"
      || carrier.version.length === 0)
  ) {
    throw error("bootstrap plan must contain valid Cargo/npm carrier identities");
  }
  if (new Set(plan.map(({ id }) => id)).size !== plan.length) {
    throw error("bootstrap plan contains duplicate carrier IDs");
  }

  const cargo = plan.filter(({ ecosystem }) => ecosystem === "cargo");
  const npm = plan.filter(({ ecosystem }) => ecosystem === "npm");
  const states = new Map([
    ...inventoryStates("Cargo", cargo, cargoInventory),
    ...inventoryStates("npm", npm, npmInventory),
  ]);
  const publicCarrierIds = plan.filter(({ id }) => states.get(id) === "published").map(({ id }) => id);
  const missingCarriers = plan.filter(({ id }) => states.get(id) === "missing-name");
  const existingNameCarriers = plan.filter(({ id }) => states.get(id) === "pending-version");

  if (checkpoint !== null) {
    if (
      Array.isArray(checkpoint)
      || typeof checkpoint !== "object"
      || !Array.isArray(checkpoint.receipts)
    ) {
      throw error("validated bootstrap checkpoint must contain receipts");
    }
    const planIds = new Set(plan.map(({ id }) => id));
    for (const receipt of checkpoint.receipts) {
      if (!planIds.has(receipt?.id)) {
        throw error(`bootstrap checkpoint contains receipt outside the active plan: ${String(receipt?.id)}`);
      }
      if (states.get(receipt.id) !== "published") {
        throw error(`${receipt.id} has an immutable receipt but its exact registry version is not public`);
      }
    }
  }

  return {
    publicCarrierIds,
    missingCarriers,
    existingNameCarriers,
    receiptedCarrierIds: checkpoint?.receipts.map(({ id }) => id) ?? [],
  };
}

export function resolveBootstrapScope(plan, reconciliation, checkpoint = null) {
  const scopeIds = checkpoint?.publications.map(({ id }) => id)
    ?? reconciliation.missingCarriers.map(({ id }) => id);
  if (scopeIds.length === 0) {
    throw error("the approved candidate has no absent Cargo/npm package names to bootstrap; use normal publish");
  }
  const scope = new Set(scopeIds);
  const scopedPlan = plan.filter(({ id }) => scope.has(id));
  if (scopedPlan.length !== scope.size) {
    throw error("bootstrap ledger scope contains a carrier outside the exact canonical plan");
  }
  const scopeConflicts = reconciliation.existingNameCarriers.filter(({ id }) => scope.has(id));
  if (scopeConflicts.length > 0) {
    throw error(
      `bootstrap-scoped package names now exist without the locked exact version: ${scopeConflicts.map(({ id }) => id).join(", ")}`,
    );
  }
  const outsideMissing = reconciliation.missingCarriers.filter(({ id }) => !scope.has(id));
  if (outsideMissing.length > 0) {
    throw error(`registry names disappeared outside the immutable bootstrap scope: ${outsideMissing.map(({ id }) => id).join(", ")}`);
  }
  const publicIds = new Set(reconciliation.publicCarrierIds);
  const existingIds = new Set(reconciliation.existingNameCarriers.map(({ id }) => id));
  return scopedPlan.map((carrier) => ({
    ...carrier,
    dependencies: carrier.dependencies.filter((dependency) => {
      if (scope.has(dependency)) return true;
      if (publicIds.has(dependency)) return false;
      if (!existingIds.has(dependency)) {
        throw error(`${carrier.id} depends on an unknown carrier outside the bootstrap scope: ${dependency}`);
      }
      const [ecosystem, ...nameParts] = dependency.split(":");
      const name = nameParts.join(":");
      const optionalNpmDependency = carrier.ecosystem === "npm"
        && ecosystem === "npm"
        && carrier.packageDependencies?.some((row) =>
          row.ecosystem === "npm" && row.name === name && row.scope === "optional"
        );
      if (!optionalNpmDependency) {
        throw error(
          `${carrier.id} cannot bootstrap before existing-name dependency ${dependency} reaches its locked version`,
        );
      }
      return false;
    }),
  }));
}
