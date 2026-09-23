// Sample changes exercised by CI planning tests; never used for production affectedness.
export const paths = {
  wasixRuntimeCarrierSource: 'src/runtimes/liboliphaunt-wasix/crates/assets/src/lib.rs',
  wasixToolsCarrierSource: 'src/postgres-tools/wasix/crates/tools/src/lib.rs',
  icuCarrierSource: 'src/database-resources/icu/cargo/src/lib.rs',
  mobileBindingSource: 'src/sdks/rust/mobile-bindings/src/lib.rs',
  nativeBindingProtocolTest: 'src/sdks/rust/liboliphaunt-native/tests/protocol_input.rs',
  sdksRustQuerySrcLibRs: 'src/sdks/rust-query/src/lib.rs',
  sdksRustWasixSrcLibRs: 'src/sdks/rust-wasix/src/lib.rs',
  postgresToolsWasixToolsBuildPortableSh: 'src/postgres-tools/wasix/tools/build-portable.sh',
  extensionsArtifactsWasixToolsBuildPortableSh:
    'src/extensions/artifacts/wasix/tools/build-portable.sh',
  sdksTsQuerySrcQueryTs: 'src/sdks/ts-query/src/query.ts',
  sdksRustLiboliphauntNativeSrcLibRs: 'src/sdks/rust/liboliphaunt-native/src/lib.rs',
  sdksTsSdkSrcClientTs: 'src/sdks/ts/sdk/src/client.ts',
  sdksTsSdkREADMEMd: 'src/sdks/ts/sdk/README.md',
  sdksTsWasixNodeAddonREADMEMd: 'src/sdks/ts-wasix/node-addon/README.md',
  sdksTsQueryREADMEMd: 'src/sdks/ts-query/README.md',
  extensionsEvidenceRuns20260607TransitionalCatalogSmokeJson:
    'src/extensions/evidence/runs/2026-06-07-transitional-catalog-smoke.json',
  sdksTsNodeAddonSrcLibRs: 'src/sdks/ts/node-addon/src/lib.rs',
  runtimesLiboliphauntNativeSrcLiboliphauntProcessC:
    'src/runtimes/liboliphaunt-native/src/liboliphaunt_process.c',
  sdksTsWasixNodeAddonSrcLibRs: 'src/sdks/ts-wasix/node-addon/src/lib.rs',
  sdksTsWasixNodeAddonToolsPackageContractTestMts:
    'src/sdks/ts-wasix/node-addon/tools/package-contract.test.mts',
  brokerToolsCreateReleaseFixtureMts: 'src/broker/tools/create-release-fixture.mts',
  brokerToolsBrokerDependencyLicenseContractTestMts:
    'src/broker/tools/broker-dependency-license-contract.test.mts',
  runtimesLiboliphauntWasixToolsCargoTestFilterSh:
    'src/runtimes/liboliphaunt-wasix/tools/cargo-test-filter.sh',
  extensionsArtifactsWasixToolsPackageReleaseAssetsMts:
    'src/extensions/artifacts/wasix/tools/package-release-assets.mts',
  runtimesLiboliphauntWasixVERSION: 'src/runtimes/liboliphaunt-wasix/VERSION',
  runtimesLiboliphauntWasixReleaseToml: 'src/runtimes/liboliphaunt-wasix/release.toml',
  extensionsArtifactsNativeToolsPackageReleaseAssetsSh:
    'src/extensions/artifacts/native/tools/package-release-assets.sh',
  runtimesLiboliphauntNativeToolsPackageLiboliphauntMobileAssetsSh:
    'src/runtimes/liboliphaunt-native/tools/package-liboliphaunt-mobile-assets.sh',
  runtimesLiboliphauntNativeToolsPackageLiboliphauntLinuxAssetsSh:
    'src/runtimes/liboliphaunt-native/tools/package-liboliphaunt-linux-assets.sh',
  runtimesLiboliphauntNativeSmokeLiboliphauntSmokeC:
    'src/runtimes/liboliphaunt-native/smoke/liboliphaunt_smoke.c',
  configNextestToml: '.config/nextest.toml',
  sdksReactNativeSrcIndexTs: 'src/sdks/react-native/src/index.ts',
  extensionsExternalVectorSourceToml: 'src/extensions/external/vector/source.toml',
  runtimesWasixBrowserHostSourceToml: 'src/runtimes/wasix-browser-host/source.toml',
  CargoLock: 'Cargo.lock',
  docsSrcAppDocsLayoutTsx: 'src/docs/src/app/docs/layout.tsx',
  sdksTsWasixSdkToolsPgwireClientMts: 'src/sdks/ts-wasix/sdk/tools/pgwire-client.mts',
  sdksTsWasixNodeAddonToolsPackagePlatformSh:
    'src/sdks/ts-wasix/node-addon/tools/package-platform.sh',
  toolsDevDenoSh: 'tools/dev/deno.sh',
  runtimesLiboliphauntWasixToolsWasixAotManifestMts:
    'src/runtimes/liboliphaunt-wasix/tools/wasix-aot-manifest.mts',
  toolsGraphCiPlanMts: 'tools/ci/ci_plan.mts',
  moonTasksJavascriptQualityYml: '.moon/tasks/javascript-quality.yml',
  githubWorkflowsCiYml: '.github/workflows/ci.yml',
  githubScriptsReleaseCandidateLibMts: '.github/scripts/release-candidate-lib.mts',
  sdksKotlinToolsStageReleaseArtifactsMts: 'src/sdks/kotlin/tools/stage-release-artifacts.mts',
  sdksTsNodeAddonToolsCheckReleaseAssetsMts:
    'src/sdks/ts/node-addon/tools/check-release-assets.mts',
  sdksTsSdkMoonYml: 'src/sdks/ts/sdk/moon.yml',
  sdksTsSdkReleaseToml: 'src/sdks/ts/sdk/release.toml',
  releasePleaseManifestJson: '.release-please-manifest.json',
  extensionsExternalPgUuidv7SourceToml: 'src/extensions/external/pg_uuidv7/source.toml',
  extensionsContribCarriersToml: 'src/extensions/contrib/carriers.toml',
  extensionsArtifactsPackagesToolsPackageReleaseAssetsSh:
    'src/extensions/artifacts/packages/tools/package-release-assets.sh',
  brokerSrcMainRs: 'src/broker/src/main.rs',
  runtimesLiboliphauntWasixPostmasterSourcesWasmerToml:
    'src/runtimes/liboliphaunt-wasix-postmaster/sources/wasmer.toml',
  thirdPartyToolsSourceFetchCoreTestMts: 'src/third-party/tools/source-fetch-core.test.mts',
  thirdPartyToolsSourceFetchCoreMts: 'src/third-party/tools/source-fetch-core.mts',
  thirdPartyPostgresFetchSourceTestSh: 'src/third-party/postgres/fetch-source.test.sh',
  runtimesLiboliphauntWasixPostmasterWasmerREADMEMd:
    'src/runtimes/liboliphaunt-wasix-postmaster/wasmer/README.md',
  runtimesLiboliphauntWasixPostmasterWasmerCapabilitiesTsv:
    'src/runtimes/liboliphaunt-wasix-postmaster/wasmer/capabilities.tsv',
  runtimesLiboliphauntWasixPostmasterWasmerBinVerifyPostmasterConcurrencyContractTestMts:
    'src/runtimes/liboliphaunt-wasix-postmaster/wasmer/bin/verify-postmaster-concurrency-contract.test.mts',
  srcSourcesThirdPartyNativeREADMEMd: 'src/sources/third-party/native/README.md',
  toolsDevMaestroToml: 'tools/dev/maestro.toml',
  postgresToolsWasixCratesToolsSrcLibRs: 'src/postgres-tools/wasix/crates/tools/src/lib.rs',
  runtimesLiboliphauntWasixToolsXtaskSrcMainRs:
    'src/runtimes/liboliphaunt-wasix/tools/xtask/src/main.rs',
  runtimesLiboliphauntWasixAssetsBuildDockerInstallPinnedWasixccSh:
    'src/runtimes/liboliphaunt-wasix/assets/build/docker/install-pinned-wasixcc.sh',
  docsInternalOLIPHAUNTPATCHSTACKMd: 'src/docs/internal/OLIPHAUNT_PATCH_STACK.md',
  runtimesLiboliphauntWasixPostmasterExecutorSrcExecuteRs:
    'src/runtimes/liboliphaunt-wasix-postmaster/executor/src/execute.rs',
  runtimesLiboliphauntWasixPostmasterToolsMergeProductReleaseAssetsMts:
    'src/runtimes/liboliphaunt-wasix-postmaster/tools/merge-product-release-assets.mts',
  extensionsTestsNativeToolsRunNativeExtensionLifecycleProofSh:
    'src/extensions/tests/native/tools/run-native-extension-lifecycle-proof.sh',
  extensionsTestsNativeSrcMainRs: 'src/extensions/tests/native/src/main.rs',
  runtimesLiboliphauntWasixPostmasterLibProcessSupervisionSh:
    'src/runtimes/liboliphaunt-wasix-postmaster/lib/process-supervision.sh',
};
export const taskRoots = {
  oliphauntWasixRustTestAot: 'oliphaunt-wasix-rust:test-aot',
  liboliphauntWasixRuntimeAot: 'liboliphaunt-wasix:runtime-aot',
  oliphauntSwiftPackageBindings: 'oliphaunt-swift:package-bindings',
  oliphauntSwiftPackage: 'oliphaunt-swift:package',
  oliphauntJsPackage: 'oliphaunt-js:package',
  extensionArtifactsNativeBuildTarget: 'extension-artifacts-native:build-target',
  extensionArtifactsWasixBuildTarget: 'extension-artifacts-wasix:build-target',
  oliphauntReactNativeTest: 'oliphaunt-react-native:test',
  liboliphauntWasixPostmasterPreparePostgres: 'liboliphaunt-wasix-postmaster:prepare-postgres',
  liboliphauntWasixPostmasterPortableInputs: 'liboliphaunt-wasix-postmaster:portable-inputs',
  liboliphauntWasixPostmasterReleaseAssets: 'liboliphaunt-wasix-postmaster:release-assets',
  postgresToolsWasixBuildAot: 'postgres-tools-wasix:build-aot',
  extensionArtifactsWasixBuildAot: 'extension-artifacts-wasix:build-aot',
};
export const combinedNativeWasix = [paths.sdksTsWasixNodeAddonSrcLibRs, paths.sdksTsSdkSrcClientTs];
export const affectedInputs = [...Object.values(paths).map((file) => [file]), combinedNativeWasix];
