import process from "node:process";

const ISOLATED_ENVIRONMENT_PREFIXES = Object.freeze([
  "ACTIONS_",
  "GH_",
  "GITHUB_",
  "OLIPHAUNT_GITHUB_",
  "OLIPHAUNT_RELEASE_",
  "RELEASE_",
]);

const ISOLATED_ENVIRONMENT_NAMES = new Set([
  "BOOTSTRAP_LEDGER_PATH",
  "CI_RUN_ID",
  "OLIPHAUNT_REQUIRE_GITHUB_CORE_REQUEST_JOURNAL",
]);

function environmentObject(value, label) {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new TypeError(`${label} must be an environment object`);
  }
  return value;
}

/**
 * Synthetic GitHub fixtures must not inherit a live Actions job's GitHub
 * credentials, journal, pacer, snapshots, retry tuning, or release state.
 * Tests add every GitHub identity and release knob they intend to exercise
 * back through overrides.
 */
export function isolatedGitHubTestEnvironment(
  overrides = {},
  inheritedEnvironment = process.env,
) {
  const inherited = environmentObject(inheritedEnvironment, "inherited environment");
  const additions = environmentObject(overrides, "environment overrides");
  const environment = { ...inherited };
  for (const name of Object.keys(environment)) {
    if (
      ISOLATED_ENVIRONMENT_PREFIXES.some((prefix) => name.startsWith(prefix))
      || ISOLATED_ENVIRONMENT_NAMES.has(name)
    ) {
      delete environment[name];
    }
  }
  return { ...environment, ...additions };
}
