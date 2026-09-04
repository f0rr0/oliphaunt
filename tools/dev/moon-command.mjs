/**
 * Resolve the Moon executable without consulting mutable home-directory state.
 * CI installs the verified binary on PATH; maintainers can override it with an
 * explicit MOON_BIN when they need an absolute path.
 */
export function moonCommand(environment = process.env) {
  return environment.MOON_BIN || "moon";
}

export function moonEnvironment(environment = process.env) {
  const clean = { ...environment };
  for (const name of Object.keys(clean)) {
    if (name.startsWith("PROTO_")) delete clean[name];
  }
  return clean;
}
