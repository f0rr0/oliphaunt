export const NPM_TRUSTED_PUBLISHING_REPOSITORY =
  "git+https://github.com/f0rr0/oliphaunt.git";

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// This validator defines the npm manifests accepted by deterministic carrier
// materialization. Operational
// runtime and registry trust checks live in npm-trusted-publishing-runtime.mjs
// so changes to release transport do not spuriously version package products.
export function validateNpmTrustedPublishingManifest(manifest, context = "npm package") {
  if (!object(manifest)) {
    throw new TypeError(`${context} package.json must be an object`);
  }
  if (typeof manifest.name !== "string" || !manifest.name.startsWith("@oliphaunt/")) {
    throw new Error(`${context} must declare an @oliphaunt package name`);
  }
  if (typeof manifest.version !== "string" || manifest.version.length === 0) {
    throw new Error(`${context} must declare a package version`);
  }
  if (!object(manifest.repository)) {
    throw new Error(`${context} repository must be an object for npm trusted publishing`);
  }
  if (manifest.repository.type !== "git") {
    throw new Error(`${context} repository.type must be "git" for npm trusted publishing`);
  }
  if (manifest.repository.url !== NPM_TRUSTED_PUBLISHING_REPOSITORY) {
    throw new Error(
      `${context} repository.url must exactly match ${NPM_TRUSTED_PUBLISHING_REPOSITORY}; got ${JSON.stringify(manifest.repository.url ?? null)}`,
    );
  }
  if (manifest.private === true) {
    throw new Error(`${context} must not be private`);
  }
  if (manifest.publishConfig !== undefined && !object(manifest.publishConfig)) {
    throw new Error(`${context} publishConfig must be an object when present`);
  }
  if (manifest.publishConfig?.provenance === false) {
    throw new Error(`${context} must not disable npm provenance`);
  }
  if (manifest.publishConfig?.access !== undefined && manifest.publishConfig.access !== "public") {
    throw new Error(`${context} publishConfig.access must be "public" when present`);
  }
  return manifest;
}
