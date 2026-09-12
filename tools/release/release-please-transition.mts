import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { CONTRIB_CARRIERS_PATH } from '../../extensions/artifacts/packages/tools/contrib-carriers.mts';
import { compareText, ROOT } from './release-graph.mts';

const STABLE_VERSION = /^(?:0|[1-9][0-9]*)[.](?:0|[1-9][0-9]*)[.](?:0|[1-9][0-9]*)$/u;
const RETIRED_CONTRIB_RELEASE_PATH = path.posix.dirname(CONTRIB_CARRIERS_PATH);

function transitionError(prefix, message) {
  return new Error(`${prefix}: ${message}`);
}

function object(value, context, prefix) {
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    throw transitionError(prefix, `${context} must contain a JSON object`);
  }
  return value;
}

function stableVersion(value, context, prefix) {
  if (typeof value !== 'string' || !STABLE_VERSION.test(value)) {
    throw transitionError(
      prefix,
      `${context} must be a stable x.y.z version, got ${JSON.stringify(value)}`,
    );
  }
  return value.split('.').map((part) => Number.parseInt(part, 10));
}

function compareVersions(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

export function releasePleaseState(root, headRef) {
  const state = process.env.OLIPHAUNT_RELEASE_PLEASE_STATE;
  if (!state) throw new Error('release history requires release-please-state.sh');
  const [capturedRoot, capturedRef, end] = readFileSync(path.join(state, 'context'), 'utf8').split(
    '\0',
  );
  if (end !== '' || realpathSync(root) !== capturedRoot || capturedRef !== headRef)
    throw new Error('release history snapshot does not match the requested checkout/ref');
  return state;
}

export function cargoManifestPaths({ root = ROOT } = {}) {
  const state = releasePleaseState(root, 'HEAD');
  const inventory = readFileSync(path.join(state, 'cargo-files'), 'utf8');
  if (!inventory || !inventory.endsWith('\0'))
    throw new Error('could not enumerate tracked Cargo manifests');
  return [...new Set(inventory.split('\0').filter(Boolean))]
    .map((file) => path.join(root, file))
    .filter((file) => existsSync(file))
    .sort(compareText);
}

function packageProducts(config, prefix) {
  const packages = object(config.packages, 'release-please-config.json packages', prefix);
  const products = new Map();
  for (const [packagePath, packageConfig] of Object.entries(packages)) {
    object(packageConfig, `release-please package ${packagePath}`, prefix);
    const product = packageConfig.component;
    if (typeof product !== 'string' || product.length === 0) {
      throw transitionError(
        prefix,
        `release-please package ${packagePath} must declare a component`,
      );
    }
    if ([...products.values()].includes(product)) {
      throw transitionError(
        prefix,
        `release-please component ${product} is declared more than once`,
      );
    }
    products.set(packagePath, product);
  }
  if (products.size === 0) {
    throw transitionError(prefix, 'release-please config must declare at least one package');
  }
  return products;
}

function readJsonObject(file, context, prefix) {
  let value;
  try {
    value = JSON.parse(readFileSync(file, 'utf8'));
  } catch (cause) {
    throw transitionError(prefix, `${context} is unreadable: ${cause.message}`);
  }
  return object(value, context, prefix);
}

/**
 * Derive the products whose Release Please manifest entries advanced.
 * A newly introduced 0.0.0 entry is seed state, not a release transition.
 */
export function releasePleaseManifestTransitions(
  config,
  beforeManifest,
  afterManifest,
  { prefix = 'release-please-transition', beforeConfig = config } = {},
) {
  object(config, 'release-please-config.json', prefix);
  const after = object(afterManifest, '.release-please-manifest.json', prefix);
  const before =
    beforeManifest === null
      ? null
      : object(beforeManifest, 'parent .release-please-manifest.json', prefix);
  const products = packageProducts(config, prefix);
  const priorProducts = packageProducts(beforeConfig, prefix);
  const priorPaths = new Map(
    [...priorProducts].map(([packagePath, product]) => [product, packagePath]),
  );
  const currentProducts = new Set(products.values());

  const currentPaths = new Set(products.keys());
  const retiredParentPaths =
    before === null
      ? []
      : Object.keys(before)
          .filter((packagePath) => !currentProducts.has(priorProducts.get(packagePath)))
          .sort();
  const unexpectedRetirements = retiredParentPaths.filter(
    (packagePath) => packagePath !== RETIRED_CONTRIB_RELEASE_PATH,
  );
  if (unexpectedRetirements.length > 0) {
    throw transitionError(
      prefix,
      `release-please packages cannot disappear from both config and manifest: ${JSON.stringify(unexpectedRetirements)}`,
    );
  }
  const missing = [...currentPaths]
    .filter((packagePath) => !Object.hasOwn(after, packagePath))
    .sort();
  const extra = Object.keys(after)
    .filter((packagePath) => !currentPaths.has(packagePath))
    .sort();
  if (missing.length > 0 || extra.length > 0) {
    throw transitionError(
      prefix,
      `release-please manifest paths must exactly match configured packages; missing=${JSON.stringify(missing)} extra=${JSON.stringify(extra)}`,
    );
  }

  const transitions = [];
  for (const [packagePath, product] of products) {
    const afterVersion = after[packagePath];
    const parsedAfter = stableVersion(afterVersion, `${product} manifest version`, prefix);
    const priorPath = priorPaths.get(product);
    const beforeVersion = priorPath === undefined ? undefined : before?.[priorPath];
    if (beforeVersion === undefined) {
      if (afterVersion !== '0.0.0') {
        transitions.push({ product, packagePath, before: null, after: afterVersion });
      }
      continue;
    }
    const parsedBefore = stableVersion(beforeVersion, `${product} parent manifest version`, prefix);
    const order = compareVersions(parsedAfter, parsedBefore);
    if (order < 0) {
      throw transitionError(
        prefix,
        `${product} manifest version regressed from ${beforeVersion} to ${afterVersion}`,
      );
    }
    if (order > 0) {
      transitions.push({ product, packagePath, before: beforeVersion, after: afterVersion });
    }
  }
  return transitions.sort((left, right) => compareText(left.product, right.product));
}

export function compatibilityEntriesForBumpedProducts(entries, transitions) {
  const bumpedProducts = new Set(transitions.map(({ product }) => product));
  return entries.filter(({ product }) => bumpedProducts.has(product));
}

/**
 * Read the worktree's normalized Release Please state against HEAD's sole
 * parent. The introduction commit legitimately has no parent manifest.
 */
export function releasePleaseWorktreeTransitions(
  root,
  { headRef = 'HEAD', prefix = 'release-please-transition' } = {},
) {
  const config = readJsonObject(
    path.join(root, 'release-please-config.json'),
    'release-please-config.json',
    prefix,
  );
  const after = readJsonObject(
    path.join(root, '.release-please-manifest.json'),
    '.release-please-manifest.json',
    prefix,
  );
  const state = releasePleaseState(root, headRef);
  const ancestry = readFileSync(path.join(state, 'ancestry'), 'utf8').trim().split(/\s+/u);
  if (ancestry.length !== 2 || ancestry.some((sha) => !/^[0-9a-f]{40}$/u.test(sha))) {
    throw transitionError(prefix, `${headRef} must resolve to one commit with exactly one parent`);
  }
  const prior = path.join(state, 'manifest.json');
  const before = existsSync(prior)
    ? readJsonObject(prior, 'parent .release-please-manifest.json', prefix)
    : null;
  if (before === null && Object.values(after).some((version) => version !== '0.0.0')) {
    throw transitionError(
      prefix,
      'a missing parent release-please manifest is valid only for the unreleased 0.0.0 introduction state',
    );
  }
  const priorConfigFile = path.join(state, 'parent-config.json');
  const beforeConfig = existsSync(priorConfigFile)
    ? readJsonObject(priorConfigFile, 'parent release-please-config.json', prefix)
    : config;
  return releasePleaseManifestTransitions(config, before, after, { prefix, beforeConfig });
}
