/**
 * Resolve the Moon executable without consulting mutable home-directory state.
 * CI installs the verified binary on PATH; maintainers can override it with an
 * explicit MOON_BIN when they need an absolute path.
 */
export function moonCommand(environment = process.env) {
  return environment.MOON_BIN || "moon";
}
