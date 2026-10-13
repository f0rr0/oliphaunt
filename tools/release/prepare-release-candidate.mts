import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { GitHub, Manifest, registerChangelogNotes } from 'release-please';
import { DefaultChangelogNotes } from 'release-please/build/src/changelog-notes/default.js';
import { parseConventionalCommits } from 'release-please/build/src/commit.js';
import { ManifestPlugin } from 'release-please/build/src/plugin.js';
import { Changelog } from 'release-please/build/src/updaters/changelog.js';
import { mergeUpdates } from 'release-please/build/src/updaters/composite.js';
import { GenericJson } from 'release-please/build/src/updaters/generic-json.js';
import { ReleasePleaseManifest } from 'release-please/build/src/updaters/release-please-manifest.js';
import { TagName } from 'release-please/build/src/util/tag-name.js';
import { Version } from 'release-please/build/src/version.js';
import { loadReleaseMetadata } from './bazel-release-metadata.mts';
import { readCommitHistory, readCommitPaths } from './commit-paths.mts';
import { createCompletedPublicationChecker } from './completed-release-publication.mts';
import {
  defaultExtensionReleasePlan,
  snapshotCurrentExactInputs,
} from './default-extension-release-plan.mts';
import { requestGithubRepositoryJson } from './github-read.mts';
import { fileIdentity } from './native-file-identity.mts';
import { writeNativeReleaseInputs } from './native-release-inputs.mts';
import {
  prepareNativeReleaseDelivery,
  qualifiedNativeSeedControls,
} from './native-release-preparation.mts';
import {
  collectNativeVersionUpdates,
  commitNativeVersionUpdates,
} from './native-version-source.mts';
import { sourceIdentity } from './publication-lock.mts';
import { deriveQualifiedNativeCurrentExactInputs } from './qualified-native-current-exact-inputs.mts';
import {
  releaseDependencyPlan,
  resolveBuildBoundCompatibilityProducts,
} from './release-dependency-plan.mts';
import {
  buildPlan,
  compatibilityVersionEntries,
  loadProducts,
  productCompatibilityVersion,
  ROOT,
} from './release-graph.mts';
import {
  cargoPathDependencyBindings,
  cargoPathDependencyConsumers,
  desiredCargoPathDependencyVersion,
  syncExampleCargoManifestText,
  syncReleasePr,
  syncTomlStringPath,
} from './sync-release-pr.mts';
import { releaseProductsFromManifests } from './verify-release-commit.mts';

// Initialize RP's public CommonJS entrypoint before its circular workspace modules.
const { NodeWorkspace } = await import('release-please/build/src/plugins/node-workspace.js');
const { appendDependenciesSectionToChangelog } = await import(
  'release-please/build/src/plugins/workspace.js'
);

// Supply source ownership and public host support intent. Release Please
// owns version policy, changelog text and ecosystem updaters in both cases.
export function includeOwnedSourceCommits(
  manifest,
  github,
  graph,
  readCompatibility = productCompatibilityVersion,
  options = {},
) {
  const buildBound = resolveBuildBoundCompatibilityProducts(graph.products, options);
  const native = Object.hasOwn(options, 'nativeNecessaryProducts');
  if (!native && Object.hasOwn(options, 'nativeCurrentExactInputs'))
    throw new Error('current exact inputs require the native necessary decision');
  const nativeCurrentExactInputs = native
    ? snapshotCurrentExactInputs(graph.products, options.nativeCurrentExactInputs)
    : undefined;
  const nativeSelected = new Set<string>();
  const nativeLeaves = new Map<string, Set<string>>();
  let nativePlan;
  let nativeCargoManifests;
  if (native) {
    const necessary = options.nativeNecessaryProducts;
    if (
      !(Array.isArray(necessary) || necessary instanceof Set) ||
      !Object.hasOwn(options, 'buildBound') ||
      typeof options.observeNativePlan !== 'function' ||
      options.nativeObservation?.coverage?.completeProductInventory !== true
    )
      throw new Error(
        'native Release Please requires a complete necessary decision and supplier map',
      );
    for (const product of necessary) {
      if (!Object.hasOwn(graph.products, product) || nativeSelected.has(product))
        throw new Error('native Release Please has unknown or duplicate necessary products');
      nativeSelected.add(product);
    }
    for (const { product, construction } of options.nativeObservation.products) {
      if (
        !Object.hasOwn(graph.products, product.id) ||
        nativeLeaves.has(product.id) ||
        !Array.isArray(construction) ||
        !construction.length
      )
        throw new Error('native Release Please lacks exact configured product input coverage');
      const leaves = new Set<string>();
      for (const view of construction) {
        if (
          !Array.isArray(view.leafInputPaths) ||
          view.leafInputPaths.some((file) => typeof file !== 'string' || !file)
        )
          throw new Error('native Release Please lacks captured causal source leaves');
        if (
          !Array.isArray(view.analysisInputPaths) ||
          view.analysisInputPaths.some((file) => typeof file !== 'string' || !file)
        )
          throw new Error('native Release Please has unknown loaded recipe version intent');
        for (const file of [...view.leafInputPaths, ...view.analysisInputPaths]) leaves.add(file);
      }
      nativeLeaves.set(product.id, leaves);
    }
    // Removed Files still carry the conventional intent of their former owner.
    for (const [id, baseline] of Object.entries(options.nativeVersionIntentBaselines ?? {})) {
      if (baseline.product.id !== id || !nativeLeaves.has(id))
        throw new Error('native version intent baseline has a different owner');
      for (const view of baseline.construction)
        for (const file of [...(view.leafInputPaths ?? []), ...(view.analysisInputPaths ?? [])])
          nativeLeaves.get(id).add(file);
    }
    if (nativeLeaves.size !== Object.keys(graph.products).length)
      throw new Error('native Release Please lacks complete configured product input coverage');
    // Use the pinned workspace extension hooks before it creates any dependency
    // updater. A held dependency cannot adopt an independently selected producer.
    manifest.plugins = manifest.plugins.map((plugin) => {
      if (!(plugin instanceof NodeWorkspace)) return plugin;
      return new (class extends NodeWorkspace {
        packageProducts = new Map<string, string>();
        async buildGraph(packages) {
          const graph = await super.buildGraph(packages);
          this.packageProducts = new Map(
            [...graph].map(([name, node]) => [
              name,
              this.repositoryConfig[this.pathFromPackage(node.value)].component,
            ]),
          );
          return graph;
        }
        buildGraphOrder(graph, names) {
          return super
            .buildGraphOrder(graph, names)
            .filter((pkg) =>
              nativeSelected.has(this.repositoryConfig[this.pathFromPackage(pkg)].component),
            );
        }
        updateCandidate(candidate, pkg, versions) {
          const consumer = this.repositoryConfig[this.pathFromPackage(pkg)].component;
          const adopted = new Set(
            [...nativePlan.requirements.values()]
              .filter((entry) => entry.product === consumer)
              .map((entry) => entry.sourceProduct),
          );
          return super.updateCandidate(
            candidate,
            pkg,
            new Map(
              [...versions].filter(([name]) => {
                const producer = this.packageProducts.get(name);
                return (
                  name === pkg.name ||
                  buildBound.get(consumer)?.has(producer) ||
                  adopted.has(producer)
                );
              }),
            ),
          );
        }
      })(github, 'main', manifest.repositoryConfig, {
        logger: plugin.logger,
        manifestPath: plugin.manifestPath,
        merge: plugin.merge,
        updateAllPackages: plugin.updateAllPackages,
        alwaysLinkLocal: plugin.alwaysLinkLocal,
        updatePeerDependencies: plugin.updatePeerDependencies,
      });
    });
  }
  const {
    readCommitFiles,
    commitHistory,
    assertCompletedPublication = createCompletedPublicationChecker({
      repository: `${github.repository.owner}/${github.repository.repo}`,
    }),
  } = options;
  const observed = [];
  const published = new Map();
  const selectedHistory = new Map();
  const releases = github.releaseIterator.bind(github);
  github.releaseIterator = async function* (options = {}) {
    published.clear();
    for await (const release of releases({ ...options, maxResults: Number.MAX_SAFE_INTEGER })) {
      if (release.draft) continue;
      published.set(release.tagName, release.sha);
      yield release;
    }
  };
  const iterate = github.mergeCommitIterator.bind(github);
  github.mergeCommitIterator = async function* (branch, options = {}) {
    observed.length = 0;
    selectedHistory.clear();
    const required = new Set();
    if (commitHistory) {
      for (const [ownerPath, config] of Object.entries(manifest.repositoryConfig)) {
        const version = manifest.releasedVersions[ownerPath]?.toString();
        const matches = [...published].filter(([name]) => {
          const tag = TagName.parse(name);
          return tag?.component === config.component && tag.version.toString() === version;
        });
        if (version !== '0.0.0' && matches.length !== 1)
          throw new Error(
            `prepare-release-candidate: ${config.component}@${version} has no unique published release boundary`,
          );
        const boundary = version === '0.0.0' ? manifest.bootstrapSha : matches[0][1];
        const selected = commitHistory.after(boundary);
        selectedHistory.set(ownerPath, { boundary, selected });
        for (const sha of selected) required.add(sha);
        if (boundary) required.add(boundary);
      }
    }
    const seen = new Set();
    // Buffer the exact local ancestry interval before Manifest can stop at a
    // delivered release SHA. API history order does not define publication scope.
    for await (const commit of iterate(branch, {
      ...options,
      maxResults: commitHistory?.commits.size ?? Number.MAX_SAFE_INTEGER,
      backfillFiles: readCommitFiles ? false : options.backfillFiles,
    })) {
      if (commitHistory && !commitHistory.commits.has(commit.sha))
        throw new Error(
          `prepare-release-candidate: history commit ${commit.sha} is outside the captured source`,
        );
      if (seen.has(commit.sha))
        throw new Error(`prepare-release-candidate: duplicate history commit ${commit.sha}`);
      seen.add(commit.sha);
      const captured = readCommitFiles
        ? { ...commit, files: await readCommitFiles(commit.sha) }
        : commit;
      observed.push(captured);
      if (!commitHistory) yield captured;
      else {
        required.delete(commit.sha);
        if (!required.size) break;
      }
    }
    if (commitHistory) {
      if (required.size)
        throw new Error(
          `prepare-release-candidate: API history did not cover captured source commits ${[...required].join(', ')}`,
        );
      const order = new Map([...commitHistory.commits].map((sha, index) => [sha, index]));
      observed.sort((left, right) => order.get(left.sha) - order.get(right.sha));
      yield* observed;
    }
  };
  manifest.plugins.push(
    new (class extends ManifestPlugin {
      strategies;
      releasesByPath;

      async preconfigure(strategies, commitsByPath, releasesByPath) {
        if (
          native &&
          nativeSelected.size &&
          !nativeCargoManifests &&
          Object.values(graph.products).some((product) =>
            product.registry_packages?.some((name) => name.startsWith('crates:')),
          )
        ) {
          const read = async (file) => {
            try {
              const text = (await github.getFileContentsOnBranch(file)).parsedContent;
              return { text, manifest: Bun.TOML.parse(text) };
            } catch (error) {
              if (error.status === 404) return undefined;
              throw error;
            }
          };
          const workspace = await read('Cargo.toml');
          const files = new Set([
            ...(workspace?.manifest.workspace?.members ?? []).map(
              (member) => member + '/Cargo.toml',
            ),
            ...(workspace?.manifest.workspace?.exclude ?? []).map(
              (member) => member + '/Cargo.toml',
            ),
            ...Object.values(graph.products).flatMap(
              (product) => product.embedded_cargo_manifests ?? [],
            ),
          ]);
          nativeCargoManifests = new Map([
            ...(workspace ? [['Cargo.toml', workspace]] : []),
            ...(
              await Promise.all(
                [...files]
                  .filter((file) => file !== 'Cargo.toml')
                  .map(async (file) => [file, await read(file)]),
              )
            ).filter(([, value]) => value),
          ]);
        }
        this.strategies = strategies;
        this.releasesByPath = releasesByPath;
        const seen = new Set();
        for (const commit of observed) {
          if (seen.has(commit.sha))
            throw new Error(`prepare-release-candidate: duplicate history commit ${commit.sha}`);
          if (!Array.isArray(commit.files))
            throw new Error(`prepare-release-candidate: missing changed files for ${commit.sha}`);
          seen.add(commit.sha);
        }
        const needsBootstrap = Object.keys(manifest.repositoryConfig).some(
          (ownerPath) => manifest.releasedVersions[ownerPath]?.toString() === '0.0.0',
        );
        if (needsBootstrap && manifest.bootstrapSha && !seen.has(manifest.bootstrapSha))
          throw new Error(
            `prepare-release-candidate: history did not reach bootstrap boundary ${manifest.bootstrapSha}`,
          );
        const owners = new Map(
          observed.map((commit) => [
            commit.sha,
            native
              ? new Set(
                  [...nativeLeaves]
                    .filter(([, leaves]) => commit.files.some((file) => leaves.has(file)))
                    .map(([product]) => product),
                )
              : new Set(
                  buildPlan(graph, commit.files ?? [], 'prepare-release-candidate').releaseProducts,
                ),
          ]),
        );
        const unmappedBreaking = new Set<string>();
        const partiallyMappedBreaking = new Set<string>();
        const knownNativeFiles = new Set([...nativeLeaves.values()].flatMap((files) => [...files]));
        const unknownIntent = new Map<string, string[]>();
        if (native)
          for (const commit of observed) {
            const parsed = parseConventionalCommits([commit]);
            for (const intent of parsed) {
              // Existing conventional component scopes are an explicit intent
              // contract, including repository inputs whose Git origin is not
              // yet represented by action leaves or loaded BUILD files.
              if (intent.scope && Object.hasOwn(graph.products, intent.scope))
                owners.get(commit.sha).add(intent.scope);
              else if (intent.notes?.length) {
                if (!owners.get(commit.sha).size) unmappedBreaking.add(commit.sha);
                else if (commit.files.some((file) => !knownNativeFiles.has(file)))
                  partiallyMappedBreaking.add(commit.sha);
              }
            }
          }
        for (const [ownerPath, config] of Object.entries(manifest.repositoryConfig)) {
          const release = releasesByPath[ownerPath];
          const version = manifest.releasedVersions[ownerPath]?.toString();
          if (!version)
            throw new Error(`prepare-release-candidate: missing product version for ${ownerPath}`);
          if (
            version !== '0.0.0' &&
            (!release?.sha || published.get(release.tag.toString()) !== release.sha)
          )
            throw new Error(
              `prepare-release-candidate: ${config.component}@${version} has no published release boundary`,
            );
          if (version !== '0.0.0')
            await assertCompletedPublication({
              product: config.component,
              version,
              publicationSha: release.sha,
              tagName: release.tag.toString(),
            });
          const boundary = release?.sha || (needsBootstrap ? manifest.bootstrapSha : undefined);
          const local = selectedHistory.get(ownerPath);
          if (local && local.boundary !== boundary)
            throw new Error(
              `prepare-release-candidate: ${config.component} release boundary changed during capture`,
            );
          if (boundary && !seen.has(boundary))
            throw new Error(
              `prepare-release-candidate: history did not reach ${config.component} boundary ${boundary}`,
            );
          const selected = [];
          const unknown = [];
          for (const commit of observed) {
            if (local ? !local.selected.has(commit.sha) : commit.sha === boundary) {
              if (local) continue;
              break;
            }
            if (unmappedBreaking.has(commit.sha)) unknown.push(commit.sha);
            if (
              partiallyMappedBreaking.has(commit.sha) &&
              !owners.get(commit.sha).has(config.component) &&
              !options.nativeVersionIntentBaselines?.[config.component]
            )
              unknown.push(commit.sha);
            if (
              (!native || nativeSelected.has(config.component)) &&
              owners.get(commit.sha).has(config.component)
            )
              selected.push(commit);
          }
          // A first publication has no prior API to break. Legacy products
          // without a captured old footprint need explicit component intent
          // when a breaking commit is only partly attributable to known Files.
          unknownIntent.set(config.component, version === '0.0.0' ? [] : unknown);
          commitsByPath[ownerPath] = selected;
        }
        const entries = compatibilityVersionEntries(graph.products, { requireSourceProduct: true });
        const hasReleaseIntent = (ownerPath, config) => {
          const releaseTypes = new Set(
            (config.changelogSections ?? [])
              .filter((section) => !section.hidden)
              .map((section) => section.type),
          );
          if (!releaseTypes.size)
            for (const type of ['feat', 'fix', 'perf', 'refactor', 'revert'])
              releaseTypes.add(type);
          return parseConventionalCommits(commitsByPath[ownerPath] ?? []).some(
            (commit) => commit.notes?.length || releaseTypes.has(commit.type),
          );
        };
        const addNativeIntent = (product, adoption = false) => {
          const ownerPath = graph.products[product].path;
          if (unknownIntent.get(product)?.length)
            throw new Error(
              `native Release Please has unknown breaking acquisition intent for ${product}: ${unknownIntent.get(product).join(', ')}`,
            );
          if (!strategies[ownerPath])
            throw new Error(`native Release Please lacks strategy for ${product}`);
          if (hasReleaseIntent(ownerPath, manifest.repositoryConfig[ownerPath])) return;
          commitsByPath[ownerPath].push({
            sha: '',
            files: [],
            message: adoption
              ? `${graph.products[product].extension?.class === 'external' ? 'fix!' : 'fix'}: align default extension installation`
              : 'fix: qualified native delivery changed',
          });
        };
        if (native) for (const product of nativeSelected) addNativeIntent(product);
        const plannedProducts = structuredClone(graph.products);
        // Only these source-selected producers determine public exact host retargets.
        for (const runtime of ['liboliphaunt-native', 'liboliphaunt-wasix']) {
          const owner = graph.products[runtime]?.path;
          if (!strategies[owner]) continue;
          let commits = parseConventionalCommits(commitsByPath[owner] ?? []);
          for (const plugin of manifest.plugins) commits = plugin.processCommits(commits);
          const candidate = await strategies[owner].buildReleasePullRequest(
            commits,
            releasesByPath[owner],
            manifest.draftPullRequest,
            manifest.labels,
          );
          if (candidate) plannedProducts[runtime].version = candidate.version.toString();
        }
        for (const [ownerPath, config] of Object.entries(manifest.repositoryConfig)) {
          const product = config.component;
          if (!graph.products[product] || !releasesByPath[ownerPath]) continue;
          const releaseIntent = hasReleaseIntent(ownerPath, config);
          const runtimeChanged = ['liboliphaunt-native', 'liboliphaunt-wasix'].some(
            (runtime) => plannedProducts[runtime]?.version !== graph.products[runtime]?.version,
          );
          if (!releaseIntent && !runtimeChanged) continue;
          const plan = releaseDependencyPlan(plannedProducts, [product], {
            entries: entries.filter((entry) => entry.product === product && entry.publicSupport),
            buildBound,
            readValue: (entry) => readCompatibility(entry.product, entry.sourceProduct),
          });
          const changes = plan.flatMap((entry) => {
            const previous = readCompatibility(
              product,
              entry.sourceProduct,
              'prepare-release-candidate',
              {
                ref:
                  graph.products[product].tag_prefix +
                  releasesByPath[ownerPath].tag.version.toString(),
              },
            );
            return previous === entry.version
              ? []
              : [{ producer: entry.sourceProduct, before: previous, after: entry.version }];
          });
          if (!changes.length) continue;
          const intent = parseConventionalCommits([
            {
              sha: '',
              files: [],
              message: `fix!: replace exact host support ${changes.map(({ producer, before, after }) => `${producer}@${before} with ${producer}@${after}`).join('; ')}`,
            },
          ]);
          const strategy = strategies[ownerPath];
          const bump = strategy.versioningStrategy.bump.bind(strategy.versioningStrategy);
          const withIntent = (commits) => [...commits, ...intent];
          // Workspace-created consumers call the native bump strategy with no commits.
          strategy.versioningStrategy.bump = (version, commits) =>
            bump(version, withIntent(commits));
          const build = strategy.buildReleasePullRequest.bind(strategy);
          strategy.buildReleasePullRequest = async (commits, latest, draft, labels, options) => {
            let candidate = await build(commits, latest, draft, labels, options);
            if (candidate)
              candidate = await build(withIntent(commits), latest, draft, labels, options);
            if (candidate && latest) {
              const floor = await bump(latest.tag.version, intent);
              if (Bun.semver.order(candidate.version.toString(), floor.toString()) < 0)
                throw new Error(
                  `prepare-release-candidate: ${product} version ${candidate.version} is below Release Please public-support floor ${floor}`,
                );
            }
            return candidate;
          };
        }
        if (native) {
          this.planNativeRequirements = (products, selected) => {
            const plan = defaultExtensionReleasePlan(products, selected, {
              readCompatibility,
              buildBound,
              currentExactInputs: nativeCurrentExactInputs,
            });
            if (!nativeCargoManifests) return plan;
            const owners = new Map(
              Object.entries(products).flatMap(([id, product]) =>
                (product.registry_packages ?? [])
                  .filter((name) => name.startsWith('crates:'))
                  .map((name) => [name.slice(7), id]),
              ),
            );
            const workspace = nativeCargoManifests.get('Cargo.toml')?.manifest.workspace ?? {};
            const packages = new Map(
              [...nativeCargoManifests].flatMap(([file, { manifest }]) => {
                if (!manifest.package) return [];
                const actual = manifest.package;
                const owner = owners.get(actual.name);
                const version = owner
                  ? products[owner].version
                  : actual.version?.workspace === true
                    ? workspace.package?.version
                    : actual.version;
                return typeof actual.name === 'string' && typeof version === 'string'
                  ? [[path.resolve(ROOT, file), [actual.name, version]]]
                  : [];
              }),
            );
            for (const [file, { text, manifest }] of nativeCargoManifests) {
              for (const binding of cargoPathDependencyBindings(
                text,
                path.resolve(ROOT, file),
                packages,
              )) {
                const declaration = binding.entryParts.reduce(
                  (value, key) => value?.[key],
                  manifest,
                );
                const input = path.resolve(
                  ROOT,
                  path.dirname(file),
                  declaration.path,
                  'Cargo.toml',
                );
                const sourceProduct = owners.get(packages.get(input)?.[0]);
                if (!selected.has(sourceProduct)) continue;
                const consumers = cargoPathDependencyConsumers(
                  file,
                  manifest,
                  nativeCargoManifests,
                  owners,
                  binding,
                );
                binding.expected = desiredCargoPathDependencyVersion(
                  declaration.version,
                  products[sourceProduct].version,
                  consumers.some((product) => selected.has(product)),
                );
                if (declaration.version === binding.expected) continue;
                // A changed normalized public Cargo requirement is a changed
                // source envelope. Private build/test manifests need a coherent
                // checkout without inventing another public delivery.
                for (const product of new Set(consumers.length ? consumers : [null])) {
                  if (product) plan.required.add(product);
                  plan.requirements.set(
                    'cargo:' + file + ':' + JSON.stringify(binding.entryParts) + ':' + product,
                    {
                      product,
                      sourceProduct,
                      version: products[sourceProduct].version,
                      path: file,
                      binding,
                    },
                  );
                }
              }
            }
            return plan;
          };
          const predicted = structuredClone(graph.products);
          const previewed = new Set<string>();
          for (;;) {
            for (const product of nativeSelected) {
              if (previewed.has(product)) continue;
              const ownerPath = graph.products[product].path;
              let commits = parseConventionalCommits(commitsByPath[ownerPath]);
              for (const plugin of manifest.plugins) commits = plugin.processCommits(commits);
              const candidate = await strategies[ownerPath].buildReleasePullRequest(
                commits,
                releasesByPath[ownerPath],
                manifest.draftPullRequest,
                manifest.labels,
              );
              if (!candidate)
                throw new Error(`native necessary delivery produced no candidate: ${product}`);
              predicted[product].version = candidate.version.toString();
              previewed.add(product);
            }
            nativePlan = this.planNativeRequirements(predicted, nativeSelected);
            const missing = [...nativePlan.required].filter(
              (product) => !nativeSelected.has(product),
            );
            if (!missing.length) break;
            for (const product of missing) {
              nativeSelected.add(product);
              addNativeIntent(product, true);
            }
          }
          await options.observeNativePlan(
            Object.freeze({
              selectedProducts: Object.freeze([...nativeSelected].sort()),
              requirements: Object.freeze(
                [...nativePlan.requirements.values()].map((entry) =>
                  Object.freeze(structuredClone(entry)),
                ),
              ),
            }),
          );
        }
        return strategies;
      }

      async run(candidates) {
        let plan;
        for (;;) {
          const products = structuredClone(graph.products);
          const selected = new Set();
          for (const candidate of candidates) {
            const product = this.repositoryConfig[candidate.path].component;
            products[product].version = candidate.pullRequest.version.toString();
            selected.add(product);
          }
          if (native) {
            if (
              selected.size !== nativeSelected.size ||
              [...selected].some((product) => !nativeSelected.has(product))
            )
              throw new Error('native Release Please escaped its frozen necessary/adoption scope');
            plan = this.planNativeRequirements(products, selected);
            if (
              [...plan.required].some((product) => !nativeSelected.has(product)) ||
              JSON.stringify([...plan.requirements]) !==
                JSON.stringify([...nativePlan.requirements])
            )
              throw new Error('native Release Please changed its admitted adoption plan');
          } else
            plan = defaultExtensionReleasePlan(products, selected, {
              readCompatibility,
              buildBound,
            });
          const missing = [...plan.required].filter((product) => !selected.has(product));
          if (!missing.length) break;
          for (const product of missing) {
            const metadata = products[product];
            const ownerPath = metadata.path;
            const commits = parseConventionalCommits([
              {
                sha: '',
                files: [],
                message: `${metadata.extension?.class === 'external' ? 'fix!' : 'fix'}: align default extension installation`,
              },
            ]);
            const pullRequest = await this.strategies[ownerPath].buildReleasePullRequest(
              commits,
              this.releasesByPath[ownerPath],
              manifest.draftPullRequest,
              manifest.labels,
            );
            if (!pullRequest) throw new Error(`could not prepare compatible product ${product}`);
            pullRequest.updates.push({
              path: manifest.manifestPath,
              createIfMissing: false,
              updater: new ReleasePleaseManifest({
                version: pullRequest.version,
                versionsMap: new Map([[ownerPath, pullRequest.version]]),
              }),
            });
            candidates.push({
              path: ownerPath,
              config: this.repositoryConfig[ownerPath],
              pullRequest,
            });
          }
        }
        const entries = compatibilityVersionEntries(graph.products, { requireSourceProduct: true });
        for (const candidate of candidates) {
          const product = this.repositoryConfig[candidate.path].component;
          const changes = [...plan.requirements.values()].filter(
            (entry) => entry.product === product,
          );
          for (const { sourceProduct, version, binding } of changes) {
            if (binding) continue;
            for (const entry of entries.filter(
              (entry) => entry.product === product && entry.sourceProduct === sourceProduct,
            )) {
              candidate.pullRequest.updates.push({
                path: entry.path,
                createIfMissing: false,
                updater: entry.parser.startsWith('json:')
                  ? new GenericJson(`$.${entry.parser.slice(5)}`, Version.parse(version))
                  : {
                      updateContent: (content) =>
                        entry.parser === 'raw'
                          ? `${version}\n`
                          : syncTomlStringPath(content, entry.parser.slice(5), version, entry.id)
                              .text,
                    },
              });
            }
          }
          if (!changes.length) continue;
          const notes = changes
            .map(({ sourceProduct, version, binding }) =>
              binding
                ? `* Update the local Cargo requirement for ${binding.name} to ${binding.expected}.`
                : `* Require ${sourceProduct}@${version} for the default extension install.`,
            )
            .join('\n');
          for (const update of candidate.pullRequest.updates) {
            if (update.updater instanceof Changelog)
              update.updater.changelogEntry = appendDependenciesSectionToChangelog(
                update.updater.changelogEntry,
                notes,
              );
          }
          for (const release of candidate.pullRequest.body.releaseData)
            release.notes = appendDependenciesSectionToChangelog(release.notes, notes);
        }
        if (native) {
          const written = new Set();
          for (const requirement of plan.requirements.values()) {
            if (!requirement.binding) continue;
            const key = requirement.path + ':' + JSON.stringify(requirement.binding.entryParts);
            if (written.has(key)) continue;
            written.add(key);
            const candidate = candidates.find(
              (candidate) =>
                this.repositoryConfig[candidate.path].component === requirement.sourceProduct,
            );
            if (!candidate) throw new Error('native Cargo requirement has no selected producer');
            candidate.pullRequest.updates.push({
              path: requirement.path,
              createIfMissing: false,
              updater: {
                updateContent: (content) =>
                  syncExampleCargoManifestText(content, {
                    policy: {},
                    bindings: [requirement.binding],
                    label: requirement.path,
                  }).text,
              },
            });
          }
        }
        return candidates;
      }
    })(github, 'main', manifest.repositoryConfig),
  );
}

export function useSourceDate(sourceDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(sourceDate)) throw new Error('source date must be YYYY-MM-DD');
  const require = createRequire(import.meta.url);
  const releaseRequire = createRequire(require.resolve('release-please'));
  const header = readFileSync(
    releaseRequire.resolve('conventional-changelog-conventionalcommits/templates/header.hbs'),
    'utf8',
  );
  registerChangelogNotes(
    'default',
    (options) =>
      new DefaultChangelogNotes({
        ...options,
        headerPartial: (options.headerPartial ?? header).replaceAll('{{date}}', sourceDate),
      }),
  );
}

export function bindReleaseSourceHistory(
  github,
  commitHistory,
  sha,
  readSource = () =>
    requestGithubRepositoryJson(
      `repos/${github.repository.owner}/${github.repository.repo}/git/ref/heads/main`,
    ),
) {
  if (commitHistory.head !== sha)
    throw new Error('captured Git history does not match the release source');
  const iterate = github.mergeCommitIterator.bind(github);
  github.mergeCommitIterator = async function* (...args) {
    const source = await readSource();
    if (source.object?.sha !== sha)
      throw new Error('main changed before Release Please history capture');
    yield* iterate(...args);
  };
}

export function applyCandidate(root, candidate, observeUpdate = undefined) {
  const changed = [];
  for (const update of mergeUpdates(candidate.updates)) {
    const destination = path.resolve(root, update.path);
    if (!destination.startsWith(`${path.resolve(root)}${path.sep}`))
      throw new Error(`unsafe release update path ${update.path}`);
    const before = existsSync(destination) ? readFileSync(destination, 'utf8') : undefined;
    if (before === undefined && !update.createIfMissing) continue;
    const after = update.updater.updateContent(before);
    if (after && after !== before) {
      mkdirSync(path.dirname(destination), { recursive: true });
      writeFileSync(destination, after);
      observeUpdate?.({
        path: update.path,
        before: before === undefined ? undefined : Buffer.from(before),
        after: Buffer.from(after),
      });
      changed.push(update.path);
    }
  }
  return changed;
}

async function main() {
  const root = process.cwd();
  const destination = process.argv[2];
  const sha = process.env.RELEASE_SOURCE_SHA;
  const repository = process.env.GITHUB_REPOSITORY;
  if (!destination || !/^[0-9a-f]{40}$/u.test(sha ?? '') || repository !== 'f0rr0/oliphaunt')
    throw new Error('candidate generation requires an exact canonical source and output directory');
  const nativeRun = process.env.NATIVE_QUALIFICATION_RUN_ID;
  if (!/^[1-9][0-9]*$/u.test(nativeRun ?? '') || !Number.isSafeInteger(Number(nativeRun)))
    throw new Error('native preparation requires an exact positive qualification run ID');
  useSourceDate(process.env.RELEASE_SOURCE_DATE);
  const [owner, repo] = repository.split('/');
  const github = await GitHub.create({
    owner,
    repo,
    defaultBranch: 'main',
    token: process.env.GH_TOKEN,
    fetch: (url, options = {}) =>
      fetch(url, {
        ...options,
        signal: options.signal
          ? AbortSignal.any([options.signal, AbortSignal.timeout(30_000)])
          : AbortSignal.timeout(30_000),
      }),
  });
  // File reads use the exact source even if main advances during API pagination.
  const getFile = github.getFileContentsOnBranch.bind(github);
  github.getFileContentsOnBranch = (file) => getFile(file, sha);
  const commitHistory = readCommitHistory();
  bindReleaseSourceHistory(github, commitHistory, sha);
  const manifest = await Manifest.fromManifest(github, 'main');
  const graph = { products: loadProducts('prepare-release-candidate') };
  const versionUpdates = collectNativeVersionUpdates();
  let nativeFinalProducts: string[] | undefined;
  const native = await prepareNativeReleaseDelivery({
    source: sourceIdentity(sha),
    runId: Number(nativeRun),
    completedVersions: Object.fromEntries(
      Object.entries(graph.products).map(([product, metadata]) => [
        product,
        manifest.releasedVersions[metadata.path]?.toString(),
      ]),
    ),
    directory: path.join(destination, 'native'),
  });
  const nativeCurrentExactInputs = deriveQualifiedNativeCurrentExactInputs(
    native,
    loadReleaseMetadata(root),
  );
  includeOwnedSourceCommits(manifest, github, graph, undefined, {
    readCommitFiles: readCommitPaths,
    commitHistory,
    buildBound: native.suppliers.buildBound,
    nativeNecessaryProducts: native.decision.selectedProducts,
    nativeObservation: native.observation,
    nativeVersionIntentBaselines: native.shippingBaselines,
    nativeCurrentExactInputs,
    observeNativePlan: async ({ selectedProducts, requirements }) => {
      const necessary = new Set(native.decision.selectedProducts);
      if (
        !Array.isArray(selectedProducts) ||
        new Set(selectedProducts).size !== selectedProducts.length ||
        selectedProducts.some((product) => !graph.products[product]) ||
        [...necessary].some((product) => !selectedProducts.includes(product))
      )
        throw new Error('native final release set differs from the qualified necessary products');
      for (const product of selectedProducts.filter((product) => !necessary.has(product))) {
        const declaredRetarget = [...requirements.values()].some(
          (entry) => entry.product === product,
        );
        const currentEmbedding = [...native.suppliers.buildBound.get(product)].some((supplier) =>
          selectedProducts.includes(supplier),
        );
        if (!declaredRetarget && !currentEmbedding)
          throw new Error(
            `native ${product} has no explicit default-install or current-embedding adoption`,
          );
      }
      for (const requirement of requirements.values()) {
        if (
          requirement.product !== 'database-resources' ||
          requirement.sourceProduct !== 'liboliphaunt-wasix'
        )
          continue;
        if (
          !nativeCurrentExactInputs.some(
            (pair) =>
              pair.product === requirement.product &&
              pair.sourceProduct === requirement.sourceProduct,
          ) ||
          !selectedProducts.includes(requirement.product) ||
          !selectedProducts.includes(requirement.sourceProduct)
        )
          throw new Error(
            'native current exact requirement lacks its authenticated two-profile consumer contract',
          );
      }
      const selected = [...selectedProducts].sort();
      if (nativeFinalProducts && JSON.stringify(nativeFinalProducts) !== JSON.stringify(selected))
        throw new Error('native final release set changed after its fixed point');
      nativeFinalProducts = selected;
    },
  });
  const candidates = await manifest.buildPullRequests();
  if (candidates.length > 1) throw new Error('expected one grouped Release Please candidate');
  mkdirSync(destination, { recursive: true });
  if (!candidates.length) {
    if (native.decision.selectedProducts.length)
      throw new Error('native necessary delivery produced no release candidate');
    writeFileSync(path.join(destination, 'required'), 'false\n');
    return;
  }
  const candidate = candidates[0];
  if (
    candidate.headRefName !== 'release-please--branches--main' ||
    candidate.title.toString() !== 'chore(release): prepare main releases'
  )
    throw new Error('unexpected Release Please branch/title');
  if (!nativeFinalProducts)
    throw new Error('native candidate did not freeze its compatible product set');
  applyCandidate(root, candidate, versionUpdates.observe);
  await syncReleasePr([], {
    buildBound: native.suppliers.buildBound,
    observeUpdate: versionUpdates.observe,
  });
  const bridge = versionUpdates.freeze(native.candidate.source);
  const before = JSON.parse(
    execFileSync('git', ['show', `${bridge.source.commit}:.release-please-manifest.json`], {
      cwd: root,
      encoding: 'utf8',
    }),
  );
  const after = JSON.parse(readFileSync(path.join(root, '.release-please-manifest.json'), 'utf8'));
  const config = JSON.parse(readFileSync(path.join(root, 'release-please-config.json'), 'utf8'));
  if (
    JSON.stringify(releaseProductsFromManifests(config, before, after)) !==
    JSON.stringify(nativeFinalProducts)
  )
    throw new Error('native generated manifest differs from the frozen release set');
  const preparedSource = commitNativeVersionUpdates(bridge, candidate.title.toString(), root);
  const record = {
    bridge,
    selectedProducts: nativeFinalProducts,
    preparedSource,
    buildBound: [...native.suppliers.buildBound]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([consumer, suppliers]) => [consumer, [...suppliers].sort()] as [string, string[]]),
  };
  const supplierArtifacts = [...(native.publicationInputs.snapshot.supplierArtifacts ?? [])];
  const finalConsumer = loadReleaseMetadata(root).databaseResourceWasixConsumer;
  if (nativeCurrentExactInputs.length && finalConsumer?.source === 'completed') {
    // An independent core-only release leaves the resource's old exact request
    // held. Its genuine baseline archive was already acquired and proved.
    const baseline = native.baselines.find(
      ({ publication }) =>
        publication.product === 'liboliphaunt-wasix' &&
        publication.version === finalConsumer.version,
    );
    const rows = native.candidate.productArtifacts.filter(
      (artifact) =>
        artifact.product === 'liboliphaunt-wasix' &&
        artifact.kind === 'wasix-runtime' &&
        artifact.target === 'portable',
    );
    if (!baseline || rows.length !== 1)
      throw new Error('native held WASIX consumer has no exact completed baseline');
    const artifact = rows[0];
    const original = native.completedPublicFiles.filter(
      (file) => file.path === baseline.productArtifacts?.[artifact.id],
    );
    if (original.length !== 1)
      throw new Error('native held WASIX archive is absent from its original public transport');
    const actual = fileIdentity(original[0].path);
    if (actual.size !== original[0].size || actual.sha256 !== original[0].sha256)
      throw new Error('native held WASIX archive changed after public authentication');
    if (
      !supplierArtifacts.some(
        (row) =>
          row.publication.product === baseline.publication.product &&
          row.publication.version === baseline.publication.version &&
          row.artifact === artifact.id,
      )
    )
      supplierArtifacts.push({
        publication: baseline.publication,
        artifact: artifact.id,
        file: { path: original[0].path, size: actual.size, sha256: actual.sha256 },
      });
  }
  writeNativeReleaseInputs(
    path.join(destination, 'native-release-inputs'),
    record,
    qualifiedNativeSeedControls(native, bridge, preparedSource, root),
    [
      ...new Map(
        [
          ...native.baselines.map(({ publication }) => publication),
          ...native.publicationInputs.snapshot.supplierPublications,
        ].map((publication) => [`${publication.product}@${publication.version}`, publication]),
      ).values(),
    ],
    supplierArtifacts,
  );
  writeFileSync(
    path.join(destination, 'native-version-source.json'),
    `${JSON.stringify(record)}\n`,
    { flag: 'wx' },
  );
  writeFileSync(path.join(destination, 'required'), 'true\n');
  writeFileSync(path.join(destination, 'title'), `${candidate.title.toString()}\n`);
  writeFileSync(path.join(destination, 'body.md'), `${candidate.body.toString()}\n`);
}

if (import.meta.main) await main();
