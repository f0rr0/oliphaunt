export const RELEASE_PLEASE_BOOTSTRAP_SHA =
  "07a9054faa03d5737dc0193f7a77ed4a71920c05";
export const RELEASE_PLEASE_DISPLACED_MAIN_SHA =
  "06816d377f96ab8e53d3c6ec8732577cc4386f2e";
export const RELEASE_PLEASE_INTRODUCTION_SUBJECT = "feat: introduce oliphaunt";
const STABLE_VERSION = /^(?:0|[1-9][0-9]*)[.](?:0|[1-9][0-9]*)[.](?:0|[1-9][0-9]*)$/u;
const CANONICAL_CONTRIB_PATH = "src/extensions/contrib";
const CANONICAL_CONTRIB_PRODUCT = "oliphaunt-extension-contrib-pg18";
const LEGACY_CONTRIB_PATHS = [
  "src/extensions/contrib/amcheck",
  "src/extensions/contrib/auto_explain",
  "src/extensions/contrib/bloom",
  "src/extensions/contrib/btree_gin",
  "src/extensions/contrib/btree_gist",
  "src/extensions/contrib/citext",
  "src/extensions/contrib/cube",
  "src/extensions/contrib/dict_int",
  "src/extensions/contrib/dict_xsyn",
  "src/extensions/contrib/earthdistance",
  "src/extensions/contrib/file_fdw",
  "src/extensions/contrib/fuzzystrmatch",
  "src/extensions/contrib/hstore",
  "src/extensions/contrib/intarray",
  "src/extensions/contrib/isn",
  "src/extensions/contrib/lo",
  "src/extensions/contrib/ltree",
  "src/extensions/contrib/pageinspect",
  "src/extensions/contrib/pg_buffercache",
  "src/extensions/contrib/pg_freespacemap",
  "src/extensions/contrib/pg_surgery",
  "src/extensions/contrib/pg_trgm",
  "src/extensions/contrib/pg_visibility",
  "src/extensions/contrib/pg_walinspect",
  "src/extensions/contrib/pgcrypto",
  "src/extensions/contrib/seg",
  "src/extensions/contrib/tablefunc",
  "src/extensions/contrib/tcn",
  "src/extensions/contrib/tsm_system_rows",
  "src/extensions/contrib/tsm_system_time",
  "src/extensions/contrib/unaccent",
  "src/extensions/contrib/uuid_ossp",
].sort();

function isObject(value) {
  return value !== null && !Array.isArray(value) && typeof value === "object";
}

function baselineError(prefix, message) {
  return new Error(`${prefix}: ${message}`);
}

function sortedStrings(values) {
  return [...values].sort();
}

function sameStrings(left, right) {
  const sortedLeft = sortedStrings(left);
  const sortedRight = sortedStrings(right);
  return sortedLeft.length === sortedRight.length &&
    sortedLeft.every((value, index) => value === sortedRight[index]);
}

function requireStableVersion(value, context, prefix) {
  if (typeof value !== "string" || !STABLE_VERSION.test(value)) {
    throw baselineError(prefix, `${context} must be a stable x.y.z version, got ${JSON.stringify(value)}`);
  }
}

export function isUnreleasedReleasePleaseManifest(manifest) {
  if (!isObject(manifest)) {
    throw new TypeError("release-please manifest must be an object");
  }
  const versions = Object.values(manifest);
  return versions.length > 0 && versions.every((version) => version === "0.0.0");
}

export function isExactReleasePleaseIntroductionCommit(config, manifest, parentShas) {
  if (!isObject(config)) {
    throw new TypeError("release-please config must be an object");
  }
  if (
    !Array.isArray(parentShas) ||
    parentShas.some((parentSha) => typeof parentSha !== "string")
  ) {
    throw new TypeError("release-please introduction parents must be an array of commit SHAs");
  }
  return (
    isUnreleasedReleasePleaseManifest(manifest) &&
    config["bootstrap-sha"] === RELEASE_PLEASE_BOOTSTRAP_SHA &&
    parentShas.length === 1 &&
    parentShas[0] === RELEASE_PLEASE_BOOTSTRAP_SHA
  );
}

/**
 * Prove the one pre-rewrite qualification baseline. The transport commit sits
 * on displaced main so hosted CI can qualify its tree before main is rewritten;
 * its parent still has 32 obsolete contrib leaf release identities. Returning
 * a normalized parent manifest is valid only for the complete unreleased,
 * version-continuous 32-to-1 ownership migration. A near miss on that exact
 * parent is an error, while every other parent is simply not this baseline.
 */
export function exactReleasePleaseQualificationTransportBaseline(
  config,
  beforeManifest,
  afterManifest,
  parentShas,
  { prefix = "release-please-bootstrap" } = {},
) {
  if (
    !Array.isArray(parentShas) ||
    parentShas.some((parentSha) => typeof parentSha !== "string")
  ) {
    throw new TypeError("release-please qualification parents must be an array of commit SHAs");
  }
  if (parentShas.length !== 1 || parentShas[0] !== RELEASE_PLEASE_DISPLACED_MAIN_SHA) {
    return null;
  }
  if (!isObject(config)) {
    throw baselineError(prefix, "release-please config must contain a JSON object");
  }
  if (!isObject(beforeManifest)) {
    throw baselineError(prefix, "displaced-main release-please manifest must contain a JSON object");
  }
  if (!isObject(afterManifest)) {
    throw baselineError(prefix, "qualification release-please manifest must contain a JSON object");
  }
  if (config["bootstrap-sha"] !== RELEASE_PLEASE_BOOTSTRAP_SHA) {
    throw baselineError(
      prefix,
      `the contrib consolidation on displaced main requires bootstrap-sha ${RELEASE_PLEASE_BOOTSTRAP_SHA}`,
    );
  }

  const packages = config.packages;
  if (!isObject(packages) || Object.keys(packages).length === 0) {
    throw baselineError(prefix, "release-please config must declare a nonempty packages object");
  }
  const components = new Set();
  for (const [packagePath, packageConfig] of Object.entries(packages)) {
    if (!isObject(packageConfig)) {
      throw baselineError(prefix, `release-please package ${packagePath} must contain an object`);
    }
    const component = packageConfig.component;
    if (typeof component !== "string" || component.length === 0 || components.has(component)) {
      throw baselineError(prefix, `release-please package ${packagePath} must declare one unique component`);
    }
    components.add(component);
  }
  if (packages[CANONICAL_CONTRIB_PATH]?.component !== CANONICAL_CONTRIB_PRODUCT) {
    throw baselineError(
      prefix,
      `the contrib consolidation must replace the legacy leaves with ${CANONICAL_CONTRIB_PATH} component ${CANONICAL_CONTRIB_PRODUCT}`,
    );
  }

  const currentPaths = Object.keys(packages);
  if (!sameStrings(Object.keys(afterManifest), currentPaths)) {
    throw baselineError(
      prefix,
      "the qualification manifest paths must exactly match the canonical release-please packages",
    );
  }
  if (!isUnreleasedReleasePleaseManifest(afterManifest)) {
    throw baselineError(
      prefix,
      "the displaced-main contrib consolidation is valid only for the unreleased 0.0.0 qualification transport",
    );
  }

  const expectedBeforePaths = [
    ...currentPaths.filter((packagePath) => packagePath !== CANONICAL_CONTRIB_PATH),
    ...LEGACY_CONTRIB_PATHS,
  ];
  if (!sameStrings(Object.keys(beforeManifest), expectedBeforePaths)) {
    throw baselineError(
      prefix,
      "the displaced-main contrib consolidation must replace exactly the 32 canonical legacy contrib package paths and no other package path",
    );
  }

  const aggregateVersion = afterManifest[CANONICAL_CONTRIB_PATH];
  for (const packagePath of LEGACY_CONTRIB_PATHS) {
    requireStableVersion(beforeManifest[packagePath], `${packagePath} parent manifest version`, prefix);
    if (beforeManifest[packagePath] !== aggregateVersion) {
      throw baselineError(
        prefix,
        `legacy contrib version continuity requires ${packagePath} ${beforeManifest[packagePath]} to equal ${CANONICAL_CONTRIB_PATH} ${aggregateVersion}`,
      );
    }
  }
  for (const packagePath of currentPaths) {
    if (packagePath === CANONICAL_CONTRIB_PATH) continue;
    requireStableVersion(beforeManifest[packagePath], `${packagePath} parent manifest version`, prefix);
    if (beforeManifest[packagePath] !== afterManifest[packagePath]) {
      throw baselineError(
        prefix,
        `the displaced-main qualification transport may change only the contrib package ownership; ${packagePath} changed from ${beforeManifest[packagePath]} to ${afterManifest[packagePath]}`,
      );
    }
  }

  return {
    kind: "qualification-transport",
    parentSha: RELEASE_PLEASE_DISPLACED_MAIN_SHA,
    normalizedBeforeManifest: Object.fromEntries(
      currentPaths.map((packagePath) => [
        packagePath,
        packagePath === CANONICAL_CONTRIB_PATH
          ? aggregateVersion
          : beforeManifest[packagePath],
      ]),
    ),
  };
}

export function releasePleaseBootstrapLifecycleError(config, manifest) {
  if (!isObject(config)) {
    throw new TypeError("release-please config must be an object");
  }
  if (isUnreleasedReleasePleaseManifest(manifest)) {
    if (config["bootstrap-sha"] !== RELEASE_PLEASE_BOOTSTRAP_SHA) {
      return (
        `release-please bootstrap-sha must be the full legacy-history boundary ` +
        `${RELEASE_PLEASE_BOOTSTRAP_SHA} until the first generated release bump consumes it`
      );
    }
    return undefined;
  }
  if (Object.hasOwn(config, "bootstrap-sha")) {
    return "release-please bootstrap-sha is one-time state and must be absent after the first generated release bump";
  }
  return undefined;
}

export function releasePleaseConfigAfterBootstrapConsumption(config, manifest) {
  if (!isObject(config)) {
    throw new TypeError("release-please config must be an object");
  }
  if (isUnreleasedReleasePleaseManifest(manifest) || !Object.hasOwn(config, "bootstrap-sha")) {
    return config;
  }
  const updated = { ...config };
  delete updated["bootstrap-sha"];
  return updated;
}
