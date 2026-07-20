const CARGO_CREDENTIAL_ENV = Object.freeze([
  "CARGO_REGISTRIES_CRATES_IO_TOKEN",
  "CARGO_REGISTRY_TOKEN",
  "CRATES_IO_BOOTSTRAP_TOKEN",
  "CRATES_IO_TRUST_CONFIG_TOKEN",
]);

const NPM_CREDENTIAL_ENV = Object.freeze([
  "NODE_AUTH_TOKEN",
  "NPM_BOOTSTRAP_TOKEN",
  "NPM_CONFIG__AUTH",
  "NPM_CONFIG__AUTHTOKEN",
  "NPM_CONFIG_USERCONFIG",
  "NPM_TOKEN",
]);

/**
 * Give a bootstrap publisher only the credential family for its immutable
 * registry lane. The parent orchestrator needs both families so it can run the
 * lanes concurrently; a child publisher never does.
 */
export function bootstrapCarrierEnvironment(ecosystem, parentEnvironment = process.env) {
  if (!new Set(["cargo", "npm"]).has(ecosystem)) {
    throw new Error(`unsupported bootstrap credential ecosystem ${JSON.stringify(ecosystem)}`);
  }
  const environment = { ...parentEnvironment };
  const remove = ecosystem === "cargo" ? NPM_CREDENTIAL_ENV : CARGO_CREDENTIAL_ENV;
  for (const name of remove) delete environment[name];
  return environment;
}
