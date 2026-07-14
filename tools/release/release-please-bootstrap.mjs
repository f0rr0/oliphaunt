export const RELEASE_PLEASE_BOOTSTRAP_SHA =
  "07a9054faa03d5737dc0193f7a77ed4a71920c05";

function isObject(value) {
  return value !== null && !Array.isArray(value) && typeof value === "object";
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
