#!/usr/bin/env bun
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseTagCommits, parseTagRefs } from '../../src/shared/product-metadata/git-tag-state.mts';
import { currentVersion } from '../../src/shared/product-metadata/product-version.mts';
import {
  compareVersion,
  compatibilityVersionEntries,
  compatibilityVersionValue,
  formatVersion,
  assertStringList as graphAssertStringList,
  parseStableVersion as graphParseStableVersion,
  tagPrefixes as graphTagPrefixes,
  loadProducts,
  ROOT,
} from '../../src/shared/product-metadata/release-graph.mts';
import {
  checkRegistryPublication,
  queryProductPublication,
} from './check_registry_publication.mts';
import { expectedAssets, verifyReleaseAssets } from './verify_github_release_attestations.mts';

const TOOL = 'check_release_versions.mts';
const REGISTRY_TARGETS = new Set(['crates-io', 'npm', 'maven-central']);
const REGISTRY_INVENTORY_SCHEMA = 'oliphaunt-release-registry-inventory-v1';

function fail(message) {
  console.error(`${TOOL}: ${message}`);
  process.exit(1);
}

let git;

function parseStableVersion(version) {
  return graphParseStableVersion(version, TOOL);
}

function assertStringList(value, context) {
  return graphAssertStringList(value, context, TOOL);
}

function parseProducts(raw, graph) {
  const products = graph.products;
  if (products === null || Array.isArray(products) || typeof products !== 'object') {
    fail('release metadata must define [products.<id>] entries');
  }
  if (raw === undefined) {
    return Object.keys(products).sort();
  }
  const value = JSON.parse(raw);
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    fail('--products-json must be a JSON string list');
  }
  const unknown = value.filter((product) => !(product in products)).sort();
  if (unknown.length > 0) {
    fail(`unknown release products: ${unknown.join(', ')}`);
  }
  return value;
}

function registryInventoryPackages(packages, context) {
  return packages.map((pkg, index) => {
    if (
      pkg === null ||
      Array.isArray(pkg) ||
      typeof pkg !== 'object' ||
      typeof pkg.kind !== 'string' ||
      typeof pkg.name !== 'string' ||
      typeof pkg.version !== 'string'
    ) {
      fail(`${context}[${index}] is not a registry package identity`);
    }
    return { kind: pkg.kind, name: pkg.name, version: pkg.version };
  });
}

function tagPrefixes(config) {
  return graphTagPrefixes(config, TOOL);
}

function productTags(prefix, state = git) {
  return [...state.refs.keys()]
    .filter((ref) => !ref.endsWith('^{}'))
    .map((ref) => ref.slice('refs/tags/'.length))
    .filter((tag) => tag.startsWith(prefix) && /^[0-9]/u.test(tag.slice(prefix.length)));
}

function tagVersion(prefix, tag) {
  if (!tag.startsWith(prefix)) {
    return undefined;
  }
  const version = tag.slice(prefix.length);
  if (!/^[0-9]+[.][0-9]+[.][0-9]+$/.test(version)) {
    return undefined;
  }
  return parseStableVersion(version);
}

function tagCommit(tag, state = git) {
  const ref = `refs/tags/${tag}`;
  const commit = state.refs.get(ref + '^{}') ?? state.refs.get(ref);
  return state.commits.has(commit) ? commit : undefined;
}

function tagExists(tag) {
  return tagCommit(tag) !== undefined;
}

function validateSwiftpmVersionTag(product, version, headCommit, state) {
  if (product !== 'oliphaunt-swift') {
    return;
  }
  const existing = tagCommit(version, state) ?? null;
  if (existing === null) {
    return;
  }
  const parents = state.commits.get(existing);
  const sourceCommit = parents.length === 1 ? parents[0] : existing;
  if (sourceCommit === headCommit) {
    console.log(`SwiftPM version tag ${version} is bound to release commit ${headCommit}`);
    return;
  }
  throw new Error(
    `SwiftPM version tag ${version} already exists at ${existing}, whose source parent is ${sourceCommit}, not exact release commit ${headCommit}`,
  );
}

export function validateVersionTags(product, version, config, state) {
  if (typeof config.tag_prefix !== 'string' || config.tag_prefix.length === 0) {
    throw new Error(`${product} must declare tag_prefix`);
  }
  const current = parseStableVersion(version);
  const currentTag = `${config.tag_prefix}${version}`;
  const headCommit = state.headCommit;
  const tags = productTags(config.tag_prefix, state);
  if (tags.includes(currentTag)) {
    const currentTagCommit = tagCommit(currentTag, state);
    if (currentTagCommit !== headCommit) {
      throw new Error(
        `${product} version ${version} is already tagged as ${currentTag} at ${currentTagCommit}, not exact release commit ${headCommit}; every different commit requires a new version`,
      );
    }
    validateSwiftpmVersionTag(product, version, headCommit, state);
    return true;
  }
  validateSwiftpmVersionTag(product, version, headCommit, state);
  const previousVersions = [];
  for (const candidatePrefix of tagPrefixes(config)) {
    for (const tag of productTags(candidatePrefix, state)) {
      const parsed = tagVersion(candidatePrefix, tag);
      if (parsed !== undefined) {
        previousVersions.push(parsed);
      }
    }
  }
  if (previousVersions.length > 0) {
    const latest = previousVersions.reduce((max, candidate) =>
      compareVersion(candidate, max) > 0 ? candidate : max,
    );
    if (compareVersion(current, latest) <= 0) {
      throw new Error(
        `${product} version ${version} is not newer than latest tagged version ${formatVersion(
          latest,
        )}; merge the release-please release PR before publishing`,
      );
    }
  }
  return false;
}

async function validateRegistryPublication(products, graph, currentTagAtHead) {
  const graphProducts = graph.products;
  const headCommit = git.headCommit;
  const inventory = [];
  for (const product of products) {
    const config = graphProducts[product];
    const targets = assertStringList(config.publish_targets ?? [], `${product}.publish_targets`);
    const registryTargets = targets.filter((target) => REGISTRY_TARGETS.has(target));
    if (registryTargets.length === 0) {
      inventory.push({ product, packages: [], missing: [], published: [] });
      continue;
    }
    if (currentTagAtHead[product] === true) {
      const { packages, missing, published } = await queryProductPublication(product);
      if (packages.length === 0) {
        console.log(`${product} has no external registry packages to check`);
      } else {
        console.log(
          `${product} registry completion check: ${published.length} published, ${missing.length} missing`,
        );
      }
      inventory.push({
        product,
        packages: registryInventoryPackages(packages, `${product}.packages`),
        missing: registryInventoryPackages(missing, `${product}.missing`),
        published: registryInventoryPackages(published, `${product}.published`),
      });
      continue;
    }
    const { packages, missing, published } = await queryProductPublication(product);
    if (packages.length === 0) {
      console.log(`${product} has no external registry packages to check`);
    } else if (published.length > 0) {
      if (typeof config.tag_prefix !== 'string' || config.tag_prefix.length === 0) {
        fail(`${product} must declare tag_prefix`);
      }
      const version = await currentVersion(product);
      const currentTag = `${config.tag_prefix}${version}`;
      console.log(
        `${product} has registry versions awaiting workflow finalization: ${published
          .map((item) => `${item.kind}:${item.name}@${item.version}`)
          .join(
            ', ',
          )}; ${currentTag} is not yet exact at ${headCommit}. The protected publish workflow must prove these versions with the immutable bootstrap ledger before it stages exact-SHA tags; never create product tags manually.`,
      );
    } else {
      console.log(
        `${product} registry unpublished check passed: ${packages.map((item) => `${item.kind}:${item.name}@${item.version}`).join(', ')}`,
      );
    }
    inventory.push({
      product,
      packages: registryInventoryPackages(packages, `${product}.packages`),
      missing: registryInventoryPackages(missing, `${product}.missing`),
      published: registryInventoryPackages(published, `${product}.published`),
    });
  }
  return {
    schema: REGISTRY_INVENTORY_SCHEMA,
    source: { commit: headCommit },
    products: [...products],
    results: inventory,
  };
}

async function validateReleasedDependencyArtifacts(consumer, dependency, dependencyVersion, graph) {
  const dependencyConfig = graph.products[dependency];
  if (
    dependencyConfig === null ||
    Array.isArray(dependencyConfig) ||
    typeof dependencyConfig !== 'object'
  ) {
    fail(`${consumer} declares unknown release dependency ${dependency}`);
  }
  const targets = assertStringList(
    dependencyConfig.publish_targets ?? [],
    `${dependency}.publish_targets`,
  );
  const registryTargets = targets.filter((target) => REGISTRY_TARGETS.has(target));
  if (registryTargets.length > 0) {
    await checkRegistryPublication([
      '--product',
      dependency,
      '--require-published',
      '--version',
      dependencyVersion,
    ]);
  }
  if (targets.includes('github-release-assets')) {
    await verifyReleaseAssets(
      dependency,
      dependencyVersion,
      await expectedAssets(dependency, dependencyVersion),
    );
  }
}

async function validateDependencyTag(consumer, dependency, dependencyVersion, graph, selected) {
  parseStableVersion(dependencyVersion);
  if (
    selectedDependencySatisfiesPin(
      selected,
      dependency,
      dependencyVersion,
      selected.has(dependency) ? await currentVersion(dependency) : undefined,
    )
  ) {
    return;
  }
  const dependencyConfig = graph.products[dependency];
  if (
    dependencyConfig === null ||
    Array.isArray(dependencyConfig) ||
    typeof dependencyConfig !== 'object'
  ) {
    fail(`${consumer} declares unknown release dependency ${dependency}`);
  }
  if (typeof dependencyConfig.tag_prefix !== 'string' || dependencyConfig.tag_prefix.length === 0) {
    fail(`${dependency} must declare tag_prefix`);
  }
  const tag = `${dependencyConfig.tag_prefix}${dependencyVersion}`;
  if (!tagExists(tag)) {
    fail(
      `${consumer} depends on ${dependency} ${dependencyVersion}, but release tag ${tag} does not exist; ` +
        `publish that exact dependency version first or select ${dependency} at ${dependencyVersion}`,
    );
  }
  await validateReleasedDependencyArtifacts(consumer, dependency, dependencyVersion, graph);
}

export function selectedDependencySatisfiesPin(
  selected,
  dependency,
  pinnedVersion,
  selectedVersion,
) {
  return selected.has(dependency) && selectedVersion === pinnedVersion;
}

async function validateReleaseDependencies(products, graph) {
  const selected = new Set(products);
  const entries = compatibilityVersionEntries(graph.products, {
    requireSourceProduct: true,
    prefix: TOOL,
  });
  for (const product of products) {
    const dependencies = new Map();
    for (const entry of entries.filter(({ product: owner }) => owner === product)) {
      const version = compatibilityVersionValue(entry, { prefix: TOOL });
      const existing = dependencies.get(entry.sourceProduct);
      if (existing !== undefined && existing !== version) {
        fail(`${product} declares conflicting versions of ${entry.sourceProduct}`);
      }
      dependencies.set(entry.sourceProduct, version);
    }
    for (const [dependency, dependencyVersion] of dependencies) {
      await validateDependencyTag(product, dependency, dependencyVersion, graph, selected);
    }
  }
}

function parseArgs(argv) {
  const args = {
    productsJson: undefined,
    headRef: 'HEAD',
    checkRegistries: false,
    registryInventoryOutput: '',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--products-json') {
      if (index + 1 >= argv.length) {
        fail('--products-json requires a value');
      }
      args.productsJson = argv[index + 1];
      index += 1;
    } else if (value.startsWith('--products-json=')) {
      args.productsJson = value.slice('--products-json='.length);
    } else if (value === '--head-ref') {
      if (index + 1 >= argv.length) {
        fail('--head-ref requires a value');
      }
      args.headRef = argv[index + 1];
      index += 1;
    } else if (value.startsWith('--head-ref=')) {
      args.headRef = value.slice('--head-ref='.length);
    } else if (value === '--check-registries') {
      args.checkRegistries = true;
    } else if (value === '--registry-inventory-output') {
      if (index + 1 >= argv.length) {
        fail('--registry-inventory-output requires a value');
      }
      args.registryInventoryOutput = argv[index + 1];
      index += 1;
    } else if (value.startsWith('--registry-inventory-output=')) {
      args.registryInventoryOutput = value.slice('--registry-inventory-output='.length);
    } else if (value === '-h' || value === '--help') {
      console.log(
        'usage: tools/release/check_release_versions.mts [--products-json JSON] [--head-ref REF] [--check-registries] [--registry-inventory-output FILE]',
      );
      process.exit(0);
    } else {
      fail(`unknown argument ${value}`);
    }
  }
  return args;
}

async function main(argv) {
  const args = parseArgs(argv);
  if (
    !/^[0-9a-f]{40}$/u.test(process.env.RELEASE_HEAD_COMMIT ?? '') ||
    !process.env.RELEASE_TAG_REFS ||
    !process.env.RELEASE_TAG_COMMITS
  ) {
    fail('use check-release-versions.sh to read the checked-out Git state');
  }
  git = {
    headCommit: process.env.RELEASE_HEAD_COMMIT,
    refs: parseTagRefs(readFileSync(process.env.RELEASE_TAG_REFS, 'utf8')),
    commits: parseTagCommits(readFileSync(process.env.RELEASE_TAG_COMMITS, 'utf8')),
  };
  const graph = { products: loadProducts() };
  const selected = parseProducts(args.productsJson, graph);
  if (args.registryInventoryOutput && !args.checkRegistries) {
    fail('--registry-inventory-output requires --check-registries');
  }
  const currentTagAtHead = {};
  for (const product of selected) {
    currentTagAtHead[product] = validateVersionTags(
      product,
      await currentVersion(product),
      graph.products[product],
      git,
    );
  }
  await validateReleaseDependencies(selected, graph);
  if (args.checkRegistries) {
    const inventory = await validateRegistryPublication(
      selected,
      graph,
      currentTagAtHead,
      args.headRef,
    );
    if (args.registryInventoryOutput) {
      const output = path.resolve(ROOT, args.registryInventoryOutput);
      mkdirSync(path.dirname(output), { recursive: true });
      writeFileSync(output, `${JSON.stringify(inventory, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o644,
      });
    }
  }
  console.log('release version checks passed');
}

if (import.meta.main) {
  await main(Bun.argv.slice(2));
}
