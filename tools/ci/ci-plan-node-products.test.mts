import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildPlan, loadGraph, normalizeFiles } from '../release/release-graph.mts';
import { affectedNames, triggeringProjectNames, triggeringTaskNames } from './affected.mts';
import {
  dependencyPlatformTargets,
  jobTargetsForJobs,
  planForReleaseProducts,
  planJobsForAffected,
  requiredTasksForAffected,
} from './ci_plan.mts';
import { combinedNativeWasix, paths, taskRoots } from './ci-plan-test-inputs.mts';
import { affectedObservation, taskObservation } from './ci-plan-test-observations.mts';
import { loadExtensionTargetProfiles } from '../../extensions/contracts/extension-target-profiles.mts';
import {
  contribCarrierDescriptor,
  extensionProductForSqlName,
} from '../release/release-artifact-targets.mts';
import { publishedConsumerDependencies } from '../../sdks/ts/sdk/tools/published-consumer.mts';

const GRAPH = loadGraph('ci-plan-node-products.test.mts');
const NATIVE_TS_CONSUMER_JOBS = [
  'affected',
  'broker-runtime',
  'js-sdk-package',
  'liboliphaunt-native-desktop',
  'native-consumers',
  'node-direct',
];

test('SDK-only release reuses a complete published dependency inventory, while missing or selected dependencies retain producers', () => {
  const inventory = Object.entries(publishedConsumerDependencies()).map(([name, version]) => ({
    name,
    version,
    integrity: `sha512-${Buffer.alloc(64).toString('base64')}`,
    tarball: `https://registry.npmjs.org/${name}/-/${name.split('/')[1]}-${version}.tgz`,
  }));
  const published = planForReleaseProducts(['oliphaunt-js'], 'a'.repeat(40), inventory);
  assert.deepEqual(published.jobs, ['affected', 'js-sdk-package', 'native-consumers']);
  assert.deepEqual(published.job_targets['native-consumers'], [
    'oliphaunt-js:test-consumer-published',
  ]);
  assert.deepEqual(published.job_targets['js-sdk-package'], ['oliphaunt-js:package']);
  assert(!published.tasks.includes('liboliphaunt-native:package-runtime-desktop-target'));
  for (const rows of [
    null,
    inventory.slice(1),
    inventory.map((row, index) => (index === 0 ? { ...row, version: '999.0.0' } : row)),
  ]) {
    const plan = planForReleaseProducts(['oliphaunt-js'], 'a'.repeat(40), rows);
    assert(plan.jobs.includes('liboliphaunt-native-desktop'));
    assert.deepEqual(plan.job_targets['native-consumers'], ['oliphaunt-js:test-consumer']);
  }
  const mixed = planForReleaseProducts(
    ['oliphaunt-js', 'oliphaunt-query-ts'],
    'a'.repeat(40),
    inventory,
  );
  assert(mixed.job_targets['js-sdk-package'].includes('oliphaunt-query-ts:package'));
  assert(mixed.jobs.includes('node-direct'));
  assert(
    !requiredTasksForAffected(new Set(['oliphaunt-js:test-consumer-published'])).has(
      'oliphaunt-js:test-consumer-published',
    ),
  );
  assert(
    !jobTargetsForJobs(new Set(['native-consumers']))['native-consumers'].includes(
      'oliphaunt-js:test-consumer-published',
    ),
  );
});

test('selected TypeScript SDK qualification includes shipped native consumption without mobile or WASIX producers', () => {
  const plan = planForReleaseProducts(['oliphaunt-js'], 'a'.repeat(40));
  assert.deepEqual(plan.qualification_products, ['oliphaunt-js']);
  assert.equal(plan.qualification_mode, 'selected-products');
  assert(plan.job_targets['js-sdk-package'].includes('oliphaunt-js:package'));
  assert(plan.job_targets['js-sdk-package'].includes('oliphaunt-query-ts:package'));
  assert(plan.job_targets['native-consumers'].includes('oliphaunt-js:test-consumer'));
  assert(plan.jobs.includes('liboliphaunt-native-desktop'));
  for (const matrix of [
    plan.liboliphaunt_native_desktop_runtime_matrix,
    plan.broker_runtime_matrix,
    plan.node_direct_runtime_matrix,
  ]) {
    assert.deepEqual(
      matrix.include.map((row) => row.target),
      ['linux-x64-gnu'],
    );
  }
  assert(!plan.jobs.some((job) => job.includes('wasix') || job.startsWith('mobile-')));
  assert.throws(
    () => planForReleaseProducts(['unknown-product'], 'a'.repeat(40)),
    /known product IDs/,
  );
  assert.throws(
    () => planForReleaseProducts(['oliphaunt-js', 'oliphaunt-js'], 'a'.repeat(40)),
    /unique list/,
  );
});

function effects(paths) {
  const relativePaths = Array.isArray(paths) ? paths : [paths];
  const affected = affectedObservation(relativePaths);
  const projects = triggeringProjectNames(affected.projects);
  const directTasks = triggeringTaskNames(affected.tasks);
  const tasks = affectedNames(affected.tasks);
  const jobs = planJobsForAffected(new Set(directTasks));
  return {
    directTasks,
    jobs: [...jobs].sort(),
    jobTargets: jobTargetsForJobs(jobs, requiredTasksForAffected(new Set(directTasks))),
    projects,
    releaseProducts: buildPlan(
      GRAPH,
      normalizeFiles(relativePaths),
      'ci-plan-node-products.test.mts',
    ).releaseProducts,
    tasks,
  };
}

test('Rust release qualification executes the compiled consumer against shipped Linux dependencies', () => {
  const consumer = 'oliphaunt-rust:test-consumer-runtime';
  const plan = planForReleaseProducts(['oliphaunt-rust'], 'd'.repeat(40));
  assert(plan.job_targets['native-consumers'].includes(consumer));
  assert(plan.job_targets['rust-sdk-package'].includes('oliphaunt-rust:test-consumer'));
  for (const target of [
    'liboliphaunt-native:package-runtime-desktop-target',
    'postgres-tools-native:package-assets',
    'oliphaunt-broker:build-release-assets',
  ])
    assert(plan.tasks.includes(target), `missing shipped consumer input ${target}`);
  const roots = new Set([consumer]);
  assert.deepEqual(
    [...dependencyPlatformTargets('liboliphaunt-native-desktop', roots)],
    ['linux-x64-gnu'],
  );
  assert.deepEqual([...dependencyPlatformTargets('broker-runtime', roots)], ['linux-x64-gnu']);
  assert(!requiredTasksForAffected(roots).has('native-extension-lifecycle:lifecycle'));
});

test('an empty Moon selection requires no product tasks or releases', () => {
  const tasks = new Set<string>();
  assert.deepEqual([...requiredTasksForAffected(tasks)], []);
  assert.deepEqual([...planJobsForAffected(tasks)], ['affected']);
  assert.deepEqual(buildPlan(GRAPH, [], 'ci-plan-node-products.test.mts').releaseProducts, []);
});

test('shared Rust query changes stage the native and WASIX consumer artifacts', () => {
  const result = effects(paths.sdksRustQuerySrcLibRs);
  for (const consumer of ['oliphaunt-wasix-ts:package', 'oliphaunt-wasix-ts:test-consumer']) {
    assert(result.jobTargets['wasix-ts-sdk-package'].includes(consumer), consumer);
  }
  for (const producer of [
    'oliphaunt-rust:package',
    'oliphaunt-query:package',
    'liboliphaunt-native-bindings:package',
    'oliphaunt-broker:package',
  ]) {
    assert(result.jobTargets['rust-sdk-package'].includes(producer), producer);
  }
});

test('compiled WASIX carrier sources reach SDK and addon checks without rebuilding runtime bytes', () => {
  for (const file of [
    paths.wasixRuntimeCarrierSource,
    paths.wasixToolsCarrierSource,
    paths.icuCarrierSource,
  ]) {
    const result = effects(file);
    for (const target of [
      'oliphaunt-wasix-rust:build',
      'oliphaunt-wasix-rust:test',
      'oliphaunt-wasix-napi:test',
      'oliphaunt-wasix-napi:rust-lint',
    ]) {
      assert(result.tasks.includes(target), `${file} must affect ${target}`);
    }
    for (const target of [
      'liboliphaunt-wasix:compiler-output',
      'liboliphaunt-wasix:runtime-portable',
      'liboliphaunt-wasix:runtime-aot',
    ]) {
      assert(!result.tasks.includes(target), `${file} must not rebuild ${target}`);
    }
  }
});

test('WASIX SDK changes select artifact consumption without invalidating AOT compilation', () => {
  for (const file of [paths.sdksRustQuerySrcLibRs, paths.sdksRustWasixSrcLibRs]) {
    const result = effects(file);
    assert.equal(result.directTasks.includes('oliphaunt-wasix-rust:test-aot'), true);
    assert.equal(result.directTasks.includes('liboliphaunt-wasix:runtime-aot'), false);
    assert.equal(result.directTasks.includes('liboliphaunt-wasix:runtime-portable'), false);
    assert.equal(
      result.jobTargets['liboliphaunt-wasix-aot'].includes('oliphaunt-wasix-rust:test-aot'),
      true,
    );
  }
  const consumer = actionTargets(taskRoots.oliphauntWasixRustTestAot);
  assert.equal(consumer.has('liboliphaunt-wasix:runtime-aot'), true);
  assert.equal(consumer.has('liboliphaunt-wasix:runtime-portable'), true);
  assert.equal(
    actionTargets(taskRoots.liboliphauntWasixRuntimeAot).has('oliphaunt-wasix-rust:test-aot'),
    false,
  );
});

test('optional WASIX compiler changes select their owner handoffs without invalidating core compilation', () => {
  for (const [file, owner] of [
    [paths.postgresToolsWasixToolsBuildPortableSh, 'postgres-tools-wasix'],
    [paths.extensionsArtifactsWasixToolsBuildPortableSh, 'extension-artifacts-wasix'],
  ]) {
    const result = effects(file);
    assert(result.directTasks.includes(`${owner}:compiler-output`));
    assert(!result.directTasks.includes('liboliphaunt-wasix:runtime-portable'));
    assert(!result.directTasks.includes('liboliphaunt-wasix:runtime-aot'));
    assert(result.jobTargets['liboliphaunt-wasix-runtime'].includes(`${owner}:compiler-output`));
    assert(result.jobTargets['liboliphaunt-wasix-aot'].includes(`${owner}:build-aot`));
    assert(actionTargets(`${owner}:build-aot`).has(`${owner}:compiler-output`));
  }
});

test('affected mobile consumers retain native ABI proofs and selected resources', () => {
  const result = effects(paths.sdksTsQuerySrcQueryTs);
  assert.deepEqual(result.jobTargets['liboliphaunt-native-android'], [
    'liboliphaunt-native:build-runtime-android-arm64-v8a',
    'liboliphaunt-native:build-runtime-android-x86_64',
    'liboliphaunt-native:package-runtime-android-arm64-v8a',
    'liboliphaunt-native:package-runtime-android-x86_64',
  ]);
  assert.deepEqual(result.jobTargets['liboliphaunt-native-android-abi'], [
    'database-resources:build-native-android-icu',
    'liboliphaunt-native:finalize-runtime-android-abi',
  ]);
  assert(
    result.jobTargets['liboliphaunt-native-ios-abi'].includes(
      'database-resources:build-native-ios-icu',
    ),
  );
  assert(result.jobTargets['js-sdk-package'].includes('database-resources:package-icu'));
});

test('mobile seed production transfers native builds without selecting runtime packages', () => {
  for (const platform of ['android', 'ios']) {
    const roots = new Set([`database-resources:build-native-${platform}-standard`]);
    const jobs = planJobsForAffected(roots);
    const targets = jobTargetsForJobs(jobs, requiredTasksForAffected(roots));
    const native = targets[`liboliphaunt-native-${platform}`];
    assert.deepEqual(
      native,
      platform === 'android'
        ? [
            'liboliphaunt-native:build-runtime-android-arm64-v8a',
            'liboliphaunt-native:build-runtime-android-x86_64',
          ]
        : ['liboliphaunt-native:build-runtime-ios-xcframework'],
    );
    assert.deepEqual(targets[`liboliphaunt-native-${platform}-abi`], [...roots]);
    assert.equal(jobs.has('liboliphaunt-native-release-assets'), false);
  }
});

test('native binding changes retain all source artifacts needed by the Rust consumer', () => {
  const result = effects(paths.sdksRustLiboliphauntNativeSrcLibRs);
  assert.deepEqual(result.jobTargets['rust-sdk-package'], [
    'liboliphaunt-native-bindings:package',
    'oliphaunt-broker:package',
    'oliphaunt-query:package',
    'oliphaunt-rust:package',
    'oliphaunt-rust:test-consumer',
  ]);
});

test('Rust dependency sources invalidate consumer checks while dependency tests and formatting stay local', () => {
  for (const file of [paths.sdksRustLiboliphauntNativeSrcLibRs, paths.sdksRustQuerySrcLibRs]) {
    const { tasks } = effects(file);
    for (const task of ['build', 'test', 'lint']) {
      assert(tasks.includes(`oliphaunt-rust:${task}`), `${file} must invalidate SDK ${task}`);
    }
    assert.equal(tasks.includes('oliphaunt-rust:format-check'), false);
  }
  const dependencyTests = effects(paths.nativeBindingProtocolTest);
  assert.equal(dependencyTests.tasks.includes('oliphaunt-rust:test'), false);
  assert.equal(dependencyTests.tasks.includes('oliphaunt-rust:build'), false);
});

function actionTargets(target) {
  return new Set(taskObservation(target).map((task) => task.target));
}
function taskRecord(target) {
  return taskObservation(target).find((task) => task.target === target);
}

test('mobile binding source selects Kotlin consumers while native test-only changes do not', () => {
  const implementation = effects(paths.mobileBindingSource);
  assert(implementation.jobTargets['kotlin-sdk-package'].includes('oliphaunt-kotlin:package'));
  assert.equal(implementation.tasks.includes('oliphaunt-kotlin:format-check'), false);
  const nativeTest = effects(paths.nativeBindingProtocolTest);
  assert.equal(nativeTest.jobTargets['kotlin-sdk-package'], undefined);
});

test('Swift native bindings retain their Apple producer before Linux package assembly', () => {
  const plan = planForReleaseProducts(['oliphaunt-swift'], 'b'.repeat(40));
  assert.deepEqual(plan.job_targets['swift-bindings'], ['oliphaunt-swift:package-bindings']);
  assert.deepEqual(plan.job_targets['swift-sdk-package'], ['oliphaunt-swift:package']);
  const producer = taskRecord(taskRoots.oliphauntSwiftPackageBindings);
  assert(producer.tags.includes('requires-apple'));
  assert(actionTargets(taskRoots.oliphauntSwiftPackage).has('oliphaunt-swift:package-bindings'));
});

test('JavaScript SDK source consumes shipped native artifacts without invalidating their compilation', () => {
  const result = effects(paths.sdksTsSdkSrcClientTs);
  assert.deepEqual(result.jobs, NATIVE_TS_CONSUMER_JOBS);
  assert.deepEqual(result.releaseProducts, ['oliphaunt-js']);
  assert.equal(result.tasks.includes('oliphaunt-js:build'), true);
  assert.equal(result.tasks.includes('oliphaunt-js:test'), true);
  assert.equal(result.tasks.includes('oliphaunt-node-direct:build-release-assets'), false);
  assert.equal(result.tasks.includes('release-tools:metadata'), false);
  assert.equal(result.tasks.includes('release-tools:test'), false);
});

test('product prose selects packaging and the cold action graph includes required compilation', () => {
  const javascript = effects(paths.sdksTsSdkREADMEMd);
  assert.deepEqual(javascript.jobs, NATIVE_TS_CONSUMER_JOBS);
  assert.equal(javascript.tasks.includes('oliphaunt-js:package'), true);
  for (const target of [
    'oliphaunt-js:test',
    'oliphaunt-js:test-native',
    'oliphaunt-js:build',
    'oliphaunt-js:test',
    'sdk-contracts:native-boundaries',
  ]) {
    assert.equal(javascript.tasks.includes(target), false, `${target} does not consume SDK prose`);
  }
  const actions = actionTargets(taskRoots.oliphauntJsPackage);
  assert.equal(actions.has('oliphaunt-js:build'), true);
  assert.equal(actions.has('oliphaunt-js:test'), false);

  const napi = effects(paths.sdksTsWasixNodeAddonREADMEMd);
  assert.deepEqual(napi.jobs, ['affected']);
  assert.equal(napi.tasks.includes('oliphaunt-wasix-napi:test'), false);
});

test('query package prose affects its archive without rebuilding SDK consumers', () => {
  const result = effects(paths.sdksTsQueryREADMEMd);
  assert.equal(result.directTasks.includes('oliphaunt-query-ts:package'), true);
  for (const target of [
    'oliphaunt-js:package',
    'oliphaunt-wasix-ts:package',
    'oliphaunt-react-native:package',
  ])
    assert.equal(
      result.directTasks.includes(target),
      false,
      `${target} consumes a published dependency`,
    );
  for (const target of [
    'oliphaunt-query-ts:build',
    'oliphaunt-query-ts:test',
    'oliphaunt-js:build',
    'oliphaunt-js:typecheck',
    'oliphaunt-js:test',
    'oliphaunt-react-native:build',
    'oliphaunt-react-native:typecheck',
    'oliphaunt-wasix-ts:typecheck',
    'oliphaunt-wasix-ts:test',
    'oliphaunt-wasix-rust:test-regression',
  ])
    assert.equal(result.directTasks.includes(target), false, `${target} does not read the README`);
});

test('extension evidence validates evidence without rebuilding products', () => {
  const result = effects(paths.extensionsEvidenceRuns20260607TransitionalCatalogSmokeJson);
  assert.equal(result.tasks.includes('extensions:lint'), true);
  assert.equal(result.tasks.includes('docs:check'), false);
  assert.equal(result.tasks.includes('sdk-contracts:fixtures'), false);
  for (const job of [
    'extension-artifacts-native',
    'extension-artifacts-wasix',
    'native-extension-lifecycle',
  ]) {
    assert.equal(result.jobs.includes(job), false, `${job} does not consume evidence records`);
  }
});

test('Node Direct source does not rebuild the independently versioned JavaScript SDK', () => {
  const result = effects(paths.sdksTsNodeAddonSrcLibRs);
  assert.deepEqual(result.jobs, [...NATIVE_TS_CONSUMER_JOBS, 'node-direct-release-assets'].sort());
  assert.deepEqual(result.releaseProducts, ['oliphaunt-node-direct']);
  assert.equal(result.tasks.includes('oliphaunt-node-direct:typecheck'), true);
  assert.equal(result.tasks.includes('oliphaunt-js:test'), false);
});

test('native implementation does not compile the version-decoupled broker', () => {
  const result = effects(paths.runtimesLiboliphauntNativeSrcLiboliphauntProcessC);
  assert.equal(result.tasks.includes('oliphaunt-broker:build'), false);
  assert.equal(result.tasks.includes('liboliphaunt-native:lint'), false);
  assert.equal(result.tasks.includes('oliphaunt-rust:test-integration'), true);
  assert.equal(result.tasks.includes('oliphaunt-swift:test-native'), true);
});

test('combined JavaScript SDK and WASIX N-API changes release only changed products', () => {
  const result = effects(combinedNativeWasix);
  assert.deepEqual(result.jobs, [
    'affected',
    'broker-runtime',
    'extension-artifacts-wasix',
    'js-sdk-package',
    'liboliphaunt-native-desktop',
    'liboliphaunt-wasix-aot',
    'liboliphaunt-wasix-runtime',
    'native-consumers',
    'node-direct',
    'wasix-napi',
    'wasix-napi-release-assets',
    'wasix-ts-sdk-package',
  ]);
  assert.deepEqual(result.releaseProducts, ['oliphaunt-js', 'oliphaunt-wasix-napi']);
});

test('shared contrib source releases only its two runtime owners', () => {
  const release = buildPlan(
    GRAPH,
    ['extensions/contrib/postgres18.toml'],
    'ci-plan-node-products.test.mts',
  );
  assert.deepEqual(release.directProducts, ['liboliphaunt-native', 'liboliphaunt-wasix']);
  assert.deepEqual(release.releaseProducts, ['liboliphaunt-native', 'liboliphaunt-wasix']);
  const plan = planForReleaseProducts(release.releaseProducts, 'c'.repeat(40));
  const contrib = contribCarrierDescriptor();
  assert(plan.extension_package_products.includes(contrib.artifactProduct));
  assert(plan.tasks.includes('native-extension-lifecycle:lifecycle'));
  assert(plan.tasks.includes('extension-artifacts-wasix:build-target'));
  for (const sql of ['hstore', 'pg_trgm']) {
    assert(plan.native_extension_lifecycle_sql_names.includes(sql));
    assert(
      plan.extension_artifacts_wasix_matrix.include.some((row) =>
        row.sql_names_csv.split(',').includes(sql),
      ),
    );
  }
  assert.throws(
    () => planForReleaseProducts([contrib.artifactProduct], 'c'.repeat(40)),
    /known product IDs/,
  );
});

test('external extension release selects shared producers and same-run lifecycle evidence', () => {
  const product = extensionProductForSqlName('pgtap');
  const plan = planForReleaseProducts([product], 'c'.repeat(40));
  assert.deepEqual(plan.qualification_products, [product]);
  for (const target of [
    'extension-artifacts-native:build-target',
    'extension-artifacts-wasix:build-target',
    'native-extension-lifecycle:lifecycle',
  ])
    assert(plan.tasks.includes(target), `missing ${target}`);
  assert(
    plan.job_targets['native-extension-lifecycle'].includes('native-extension-lifecycle:lifecycle'),
  );
  assert(plan.native_extension_lifecycle_sql_names.includes('pgtap'));
  assert(plan.jobs.includes('liboliphaunt-wasix-runtime'));
  assert(plan.jobs.includes('liboliphaunt-wasix-aot'));
  const profiles = loadExtensionTargetProfiles({
    file: new URL('../../extensions/contracts/extension-target-profiles.toml', import.meta.url),
  });
  for (const { family, target } of profiles.targets) {
    const rows =
      family === 'native'
        ? plan.extension_artifacts_native_matrix.include
        : plan.extension_artifacts_wasix_matrix.include;
    assert(
      rows.some((row) => row.target === target && row.sql_names_csv.split(',').includes('pgtap')),
      `missing pgtap ${target}`,
    );
  }
});

test('WASIX N-API source selects only its real WASIX artifact inputs', () => {
  const result = effects(paths.sdksTsWasixNodeAddonSrcLibRs);
  assert.deepEqual(result.jobs, [
    'affected',
    'extension-artifacts-wasix',
    'js-sdk-package',
    'liboliphaunt-wasix-aot',
    'liboliphaunt-wasix-runtime',
    'wasix-napi',
    'wasix-napi-release-assets',
    'wasix-ts-sdk-package',
  ]);
  assert.deepEqual(result.releaseProducts, ['oliphaunt-wasix-napi']);
  assert(result.jobTargets['wasix-ts-sdk-package'].includes('postgres-tools-wasix:test-consumer'));
  assert(result.jobTargets['js-sdk-package'].includes('oliphaunt-wasix-tools-ts:package'));
  assert.equal(result.tasks.includes('oliphaunt-wasix-napi:rust-format-check'), true);
  assert.equal(result.tasks.includes('oliphaunt-wasix-napi:test'), true);
});

test('packaging fixtures select their owner tests without artifact builders', () => {
  for (const [file, task] of [
    [paths.sdksTsWasixNodeAddonToolsPackageContractTestMts, 'oliphaunt-wasix-napi:test'],
    [paths.brokerToolsCreateReleaseFixtureMts, 'oliphaunt-broker:packaging-unit'],
    [paths.brokerToolsBrokerDependencyLicenseContractTestMts, 'oliphaunt-broker:packaging-unit'],
  ]) {
    const result = effects(file);
    assert.deepEqual(result.jobs, ['affected'], file);
    assert.equal(result.tasks.includes(task), true, file);
  }
});

test('WASIX test helpers invalidate only tasks that execute them', () => {
  const result = effects(paths.runtimesLiboliphauntWasixToolsCargoTestFilterSh);
  for (const target of [
    'oliphaunt-wasix-rust:test-aot',
    'liboliphaunt-wasix:smoke',
    'oliphaunt-wasix-rust:test-regression',
  ]) {
    assert.equal(result.directTasks.includes(target), true, `${target} executes the helper`);
  }
  for (const target of [
    'liboliphaunt-wasix:runtime-aot',
    'oliphaunt-wasix-rust:test',
    'extension-artifacts-wasix:build-target',
    'liboliphaunt-wasix:assets-verify',
    'liboliphaunt-wasix:release-assets',
    'liboliphaunt-wasix:runtime-portable',
    'perf-tools:wasix-browser-measure',
    'perf-tools:wasix-node-measure',
  ]) {
    assert.equal(
      result.directTasks.includes(target),
      false,
      `${target} does not execute the helper`,
    );
  }
});

test('WASIX extension staging follows its own code and produced runtime artifact', () => {
  const packager = effects(paths.extensionsArtifactsWasixToolsPackageReleaseAssetsMts);
  assert.equal(packager.directTasks.includes('extension-artifacts-wasix:build-target'), true);

  const runtimeVersion = effects(paths.runtimesLiboliphauntWasixVERSION);
  assert.equal(runtimeVersion.directTasks.includes('extension-artifacts-wasix:build-target'), true);

  const releaseMetadata = effects(paths.runtimesLiboliphauntWasixReleaseToml);
  assert.equal(
    releaseMetadata.directTasks.includes('extension-artifacts-wasix:build-target'),
    false,
  );
  assert.equal(
    releaseMetadata.directTasks.includes('oliphaunt-wasix-napi:build-release-assets'),
    true,
  );
});

test('extension artifact builders materialize overlapping source scopes once', () => {
  const native = actionTargets(taskRoots.extensionArtifactsNativeBuildTarget);
  assert.equal(native.has('source-inputs:source-fetch-native-runtime'), true);
  assert.equal(native.has('source-inputs:source-fetch-extensions'), false);

  const wasix = actionTargets(taskRoots.extensionArtifactsWasixBuildTarget);
  assert.equal(wasix.has('source-inputs:source-fetch-wasix-runtime'), true);
  assert.equal(wasix.has('source-inputs:source-fetch-extensions'), false);
});

test('executable packagers and Rust test configuration select their real owners', () => {
  const nativeExtensions = effects(paths.extensionsArtifactsNativeToolsPackageReleaseAssetsSh);
  assert.equal(
    nativeExtensions.directTasks.includes('extension-artifacts-native:build-target'),
    true,
  );
  assert.equal(nativeExtensions.jobs.includes('extension-artifacts-native'), true);

  const mobile = effects(paths.runtimesLiboliphauntNativeToolsPackageLiboliphauntMobileAssetsSh);
  for (const target of [
    'liboliphaunt-native:package-runtime-android-arm64-v8a',
    'liboliphaunt-native:package-runtime-android-x86_64',
    'liboliphaunt-native:package-runtime-ios-xcframework',
  ]) {
    assert.equal(
      mobile.directTasks.includes(target),
      true,
      `${target} executes the mobile packager`,
    );
  }
  assert.equal(
    mobile.directTasks.some((target) => target.includes(':build-runtime-android-')),
    false,
  );
  assert.equal(
    mobile.directTasks.includes('liboliphaunt-native:build-runtime-ios-xcframework'),
    false,
  );

  const desktop = effects(paths.runtimesLiboliphauntNativeToolsPackageLiboliphauntLinuxAssetsSh);
  assert.equal(
    desktop.directTasks.includes('liboliphaunt-native:package-runtime-desktop-target'),
    true,
  );
  assert.equal(
    desktop.directTasks.includes('liboliphaunt-native:build-runtime-desktop-target'),
    false,
  );

  const smoke = effects(paths.runtimesLiboliphauntNativeSmokeLiboliphauntSmokeC);
  assert(smoke.directTasks.includes('liboliphaunt-native:test-artifacts-desktop-target'));
  assert.equal(
    smoke.directTasks.includes('liboliphaunt-native:package-runtime-desktop-target'),
    false,
  );
  assert.equal(
    smoke.directTasks.includes('liboliphaunt-native:build-runtime-desktop-target'),
    false,
  );
  assert(
    smoke.jobTargets['liboliphaunt-native-desktop'].includes(
      'liboliphaunt-native:package-runtime-desktop-target',
    ),
  );

  const nextest = effects(paths.configNextestToml);
  assert.equal(nextest.directTasks.includes('oliphaunt-rust:test'), true);
  assert.equal(nextest.directTasks.includes('oliphaunt-wasix-rust:test'), true);
});

test('product unit suites remain selected without central coverage', () => {
  const reactNative = effects(paths.sdksReactNativeSrcIndexTs);
  assert.equal(reactNative.directTasks.includes('oliphaunt-react-native:test'), true);
  assert.equal(taskRecord(taskRoots.oliphauntReactNativeTest).options.runInCI, true);

  const wasixRust = effects(paths.sdksRustWasixSrcLibRs);
  assert.equal(wasixRust.directTasks.includes('oliphaunt-wasix-rust:test'), true);
});

test('source acquisition and WASIX browser-host ownership stay narrow', () => {
  const extensionPin = effects(paths.extensionsExternalVectorSourceToml);
  assert.equal(extensionPin.directTasks.includes('source-inputs:source-fetch-extensions'), true);
  assert.equal(
    extensionPin.directTasks.includes('source-inputs:source-fetch-native-runtime'),
    true,
  );
  assert.equal(extensionPin.directTasks.includes('source-inputs:source-fetch-wasix-runtime'), true);

  const browserHost = effects(paths.runtimesWasixBrowserHostSourceToml);
  assert.equal(browserHost.directTasks.includes('wasix-browser-host:build'), true);
  assert.equal(browserHost.tasks.includes('oliphaunt-wasix-ts:package'), true);
  assert.equal(browserHost.jobs.includes('wasix-ts-sdk-package'), true);

  const cargoLock = effects(paths.CargoLock);
  assert.equal(cargoLock.directTasks.includes('wasix-browser-host:build'), true);
});

test('docs changes select the production artifact and built-site smoke', () => {
  const result = effects(paths.docsSrcAppDocsLayoutTsx);
  assert.equal(result.directTasks.includes('docs:build'), true);
  assert.equal(result.tasks.includes('docs:test-package'), true);
});

test('WASIX N-API production helpers keep the release builder affected', () => {
  for (const relativePath of [
    paths.sdksTsWasixSdkToolsPgwireClientMts,
    paths.sdksTsWasixNodeAddonToolsPackagePlatformSh,
    paths.toolsDevDenoSh,
    paths.runtimesLiboliphauntWasixToolsWasixAotManifestMts,
  ]) {
    const result = effects(relativePath);
    assert.equal(
      result.tasks.includes('oliphaunt-wasix-napi:build-release-assets'),
      true,
      `${relativePath} must invalidate the WASIX N-API release builder`,
    );
    assert.equal(result.jobs.includes('wasix-napi-release-assets'), true);
  }
});

test('CI planner changes select the focused graph proof', () => {
  const result = effects(paths.toolsGraphCiPlanMts);
  assert.equal(result.tasks.includes('release-tools:graph-unit'), true);
  assert.equal(result.tasks.includes('release-tools:test'), false);
});

test('release mutation tests follow release helpers, not policy or workflow files', () => {
  for (const relativePath of [paths.moonTasksJavascriptQualityYml, paths.githubWorkflowsCiYml]) {
    const result = effects(relativePath);
    assert.equal(result.tasks.includes('release-tools:test'), false);
  }
  const result = effects(paths.githubScriptsReleaseCandidateLibMts);
  assert.equal(result.tasks.includes('release-tools:test'), true);
  assert.equal(result.tasks.includes('release-tools:graph-unit'), false);
});

test('workflow changes run workflow checks without rebuilding product artifacts', () => {
  const result = effects(paths.githubWorkflowsCiYml);
  assert.deepEqual(result.jobs, ['affected']);
  assert.equal(result.tasks.includes('ci-workflows:check'), true);
  assert.equal(result.tasks.includes('release-tools:metadata'), true);
});

test('release helper changes invalidate only their product artifacts', () => {
  const kotlin = effects(paths.sdksKotlinToolsStageReleaseArtifactsMts);
  assert.deepEqual(kotlin.jobs, [
    'affected',
    'extension-artifacts-native',
    'js-sdk-package',
    'kotlin-maven-staging',
    'kotlin-sdk-package',
    'liboliphaunt-native-android',
    'liboliphaunt-native-android-abi',
    'liboliphaunt-native-ios',
    'liboliphaunt-native-ios-abi',
    'mobile-build-android',
    'mobile-extension-packages',
    'react-native-sdk-package',
  ]);
  // The selected Expo build installs RN with its packed query dependency.
  assert.deepEqual(kotlin.jobTargets['js-sdk-package'], [
    'database-resources:package-icu',
    'oliphaunt-query-ts:package',
  ]);

  const nodeDirect = effects(paths.sdksTsNodeAddonToolsCheckReleaseAssetsMts);
  assert.deepEqual(
    nodeDirect.jobs,
    [...NATIVE_TS_CONSUMER_JOBS, 'node-direct-release-assets'].sort(),
  );
});

test('product Moon topology selects the focused release graph proof', () => {
  const result = effects(paths.sdksTsSdkMoonYml);
  assert.deepEqual(result.jobs, NATIVE_TS_CONSUMER_JOBS);
  assert.equal(result.tasks.includes('release-tools:graph-unit'), true);
  assert.equal(result.tasks.includes('release-tools:test'), false);
});

test('JavaScript release metadata does not rebuild unrelated products', () => {
  const result = effects(paths.sdksTsSdkReleaseToml);
  assert.deepEqual(result.jobs, NATIVE_TS_CONSUMER_JOBS);
  assert.deepEqual(result.releaseProducts, ['oliphaunt-js']);
  assert.equal(result.tasks.includes('release-tools:graph-unit'), true);
  assert.equal(result.tasks.includes('release-tools:metadata'), true);
  assert.equal(result.tasks.includes('release-tools:test'), false);
  for (const target of [
    'oliphaunt-broker:build-release-assets',
    'oliphaunt-react-native:package',
    'oliphaunt-swift:package',
    'oliphaunt-wasix-napi:build-release-assets',
  ]) {
    assert.equal(
      result.tasks.includes(target),
      false,
      `${target} is unrelated to the JavaScript SDK`,
    );
  }
});

test('release-please bookkeeping does not rebuild product artifacts', () => {
  const result = effects(paths.releasePleaseManifestJson);
  assert.deepEqual(result.jobs, ['affected']);
  assert.equal(result.tasks.includes('release-tools:graph-unit'), true);
  assert.equal(result.tasks.includes('release-tools:metadata'), true);
  assert.equal(result.tasks.includes('release-tools:test'), false);
  assert.equal(
    result.tasks.some((target) =>
      /:(aggregate-release-assets|package-artifacts|release-assets|[a-z-]+-sdk-package)$/u.test(
        target,
      ),
    ),
    false,
  );
});

test('extension sources select shared builders without leaf package wrappers', () => {
  for (const relativePath of [
    paths.extensionsExternalPgUuidv7SourceToml,
    paths.extensionsContribCarriersToml,
  ]) {
    const result = effects(relativePath);
    for (const job of [
      'extension-artifacts-native',
      'extension-artifacts-wasix',
      'extension-packages',
    ]) {
      assert.equal(result.jobs.includes(job), true, `${relativePath} must select ${job}`);
    }
    assert.equal(
      result.tasks.some((target) => /^oliphaunt-extension-[^:]+:package$/u.test(target)),
      false,
      `${relativePath} must not need a duplicate leaf package task`,
    );
  }
});

test('extension package tooling invalidates packaging without changing builders', () => {
  const result = effects(paths.extensionsArtifactsPackagesToolsPackageReleaseAssetsSh);
  assert.equal(result.tasks.includes('extension-packages:package'), true);
  assert.equal(result.tasks.includes('extension-packages:package-mobile'), false);
  for (const target of [
    'extension-artifacts-native:build-target',
    'extension-artifacts-wasix:build-target',
    'liboliphaunt-wasix:runtime-portable',
    'oliphaunt-rust:test-extensions',
  ]) {
    assert.equal(
      result.tasks.includes(target),
      false,
      `${target} does not consume package tooling`,
    );
  }
});

test('native producer host coverage is narrowed only for explicitly bounded dependency consumers', () => {
  const sdk = effects(paths.sdksTsSdkSrcClientTs);
  for (const job of ['liboliphaunt-native-desktop', 'broker-runtime', 'node-direct']) {
    assert.deepEqual(
      [...dependencyPlatformTargets(job, new Set(sdk.directTasks))],
      ['linux-x64-gnu'],
    );
  }
  for (const [source, job] of [
    [paths.runtimesLiboliphauntNativeSrcLiboliphauntProcessC, 'liboliphaunt-native-desktop'],
    [paths.brokerSrcMainRs, 'broker-runtime'],
    [paths.sdksTsNodeAddonSrcLibRs, 'node-direct'],
  ]) {
    assert.equal(dependencyPlatformTargets(job, new Set(effects(source).directTasks)), null);
  }
});

test('mixed SDK and query releases retain the Linux native consumer alongside mobile targets', () => {
  const plan = planForReleaseProducts(['oliphaunt-js', 'oliphaunt-query-ts'], 'a'.repeat(40));
  assert(plan.jobs.includes('native-consumers'));
  assert(
    plan.liboliphaunt_native_desktop_runtime_matrix.include.some(
      (row) => row.target === 'linux-x64-gnu',
    ),
  );
});
