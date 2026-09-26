// Sample changes exercised by CI planning tests; never used for production affectedness.
export const paths = {
  windowsVcRuntimePolicy: 'tools/packaging/windows-vc-runtime-policy.json',
  wasixRuntimeCarrierSource: 'src/wasix/runtime/crates/assets/src/lib.rs',
  wasixToolsCarrierSource: 'src/wasix/postgres-tools/crates/tools/src/lib.rs',
  icuCarrierSource: 'src/database-resources/icu/cargo/src/lib.rs',
  mobileBindingSource: 'src/native/mobile-bindings/src/lib.rs',
  nativeBindingProtocolTest: 'src/native/rust-bindings/tests/protocol_input.rs',
  sdksRustQuerySrcLibRs: 'src/query/rust/src/lib.rs',
  sdksRustWasixSrcLibRs: 'src/wasix/sdks/rust/src/lib.rs',
  postgresToolsWasixToolsBuildPortableSh: 'src/wasix/postgres-tools/tools/build-portable.sh',
  extensionsArtifactsWasixToolsBuildPortableSh:
    'src/extensions/artifacts/wasix/tools/build-portable.sh',
  sdksTsQuerySrcQueryTs: 'src/query/ts/src/query.ts',
  sdksRustLiboliphauntNativeSrcLibRs: 'src/native/rust-bindings/src/lib.rs',
  sdksTsSdkSrcClientTs: 'src/native/sdks/ts/src/client.ts',
  sdksTsSdkREADMEMd: 'src/native/sdks/ts/README.md',
  sdksTsWasixNodeAddonREADMEMd: 'src/wasix/node-addon/README.md',
  sdksTsQueryREADMEMd: 'src/query/ts/README.md',
  extensionsEvidenceRuns20260607TransitionalCatalogSmokeJson:
    'src/extensions/evidence/runs/2026-06-07-transitional-catalog-smoke.json',
  sdksTsNodeAddonSrcLibRs: 'src/native/node-addon/src/lib.rs',
  runtimesLiboliphauntNativeSrcLiboliphauntProcessC:
    'src/native/runtime/src/liboliphaunt_process.c',
  sdksTsWasixNodeAddonSrcLibRs: 'src/wasix/node-addon/src/lib.rs',
  sdksTsWasixNodeAddonToolsPackageContractTestMts:
    'src/wasix/node-addon/tools/package-contract.test.mts',
  brokerToolsCreateReleaseFixtureMts: 'src/native/broker/tools/create-release-fixture.mts',
  brokerToolsBrokerDependencyLicenseContractTestMts:
    'src/native/broker/tools/broker-dependency-license-contract.test.mts',
  runtimesLiboliphauntWasixToolsCargoTestFilterSh: 'src/wasix/runtime/tools/cargo-test-filter.sh',
  extensionsArtifactsWasixToolsPackageReleaseAssetsMts:
    'src/extensions/artifacts/wasix/tools/package-release-assets.mts',
  runtimesLiboliphauntWasixVERSION: 'src/wasix/runtime/VERSION',
  runtimesLiboliphauntWasixReleaseToml: 'src/wasix/runtime/release.toml',
  extensionsArtifactsNativeToolsPackageReleaseAssetsSh:
    'src/extensions/artifacts/native/tools/package-release-assets.sh',
  runtimesLiboliphauntNativeToolsPackageLiboliphauntMobileAssetsSh:
    'src/native/runtime/tools/package-liboliphaunt-mobile-assets.sh',
  runtimesLiboliphauntNativeToolsPackageLiboliphauntLinuxAssetsSh:
    'src/native/runtime/tools/package-liboliphaunt-linux-assets.sh',
  runtimesLiboliphauntNativeSmokeLiboliphauntSmokeC:
    'src/native/runtime/smoke/liboliphaunt_smoke.c',
  configNextestToml: '.config/nextest.toml',
  sdksReactNativeSrcIndexTs: 'src/native/sdks/react-native/src/index.ts',
  extensionsExternalVectorSourceToml: 'src/extensions/external/vector/source.toml',
  runtimesWasixBrowserHostSourceToml: 'src/wasix/browser-host/source.toml',
  CargoLock: 'Cargo.lock',
  docsSrcAppDocsLayoutTsx: 'src/docs/src/app/docs/layout.tsx',
  sdksTsWasixSdkToolsPgwireClientMts: 'src/wasix/sdks/ts/tools/pgwire-client.mts',
  sdksTsWasixNodeAddonToolsPackagePlatformSh: 'src/wasix/node-addon/tools/package-platform.sh',
  toolsDevDenoSh: 'tools/dev/deno.sh',
  runtimesLiboliphauntWasixToolsWasixAotManifestMts:
    'src/wasix/runtime/tools/wasix-aot-manifest.mts',
  toolsGraphCiPlanMts: 'tools/ci/ci_plan.mts',
  moonTasksJavascriptQualityYml: '.moon/tasks/javascript-quality.yml',
  githubWorkflowsCiYml: '.github/workflows/ci.yml',
  githubScriptsReleaseCandidateLibMts: '.github/scripts/release-candidate-lib.mts',
  sdksKotlinToolsStageReleaseArtifactsMts:
    'src/native/sdks/kotlin/tools/stage-release-artifacts.mts',
  sdksTsNodeAddonToolsCheckReleaseAssetsMts: 'src/native/node-addon/tools/check-release-assets.mts',
  sdksTsSdkMoonYml: 'src/native/sdks/ts/moon.yml',
  sdksTsSdkReleaseToml: 'src/native/sdks/ts/release.toml',
  releasePleaseManifestJson: '.release-please-manifest.json',
  extensionsExternalPgUuidv7SourceToml: 'src/extensions/external/pg_uuidv7/source.toml',
  extensionsContribCarriersToml: 'src/extensions/contrib/carriers.toml',
  extensionsArtifactsPackagesToolsPackageReleaseAssetsSh:
    'src/extensions/artifacts/packages/tools/package-release-assets.sh',
  brokerSrcMainRs: 'src/native/broker/src/main.rs',
  runtimesLiboliphauntWasixPostmasterSourcesWasmerToml: 'src/wasix/postmaster/sources/wasmer.toml',
  thirdPartyToolsSourceFetchCoreTestMts: 'src/third-party/tools/source-fetch-core.test.mts',
  thirdPartyToolsSourceFetchCoreMts: 'src/third-party/tools/source-fetch-core.mts',
  thirdPartyPostgresFetchSourceTestSh: 'src/third-party/postgres/fetch-source.test.sh',
  runtimesLiboliphauntWasixPostmasterWasmerREADMEMd: 'src/wasix/postmaster/wasmer/README.md',
  runtimesLiboliphauntWasixPostmasterWasmerCapabilitiesTsv:
    'src/wasix/postmaster/wasmer/capabilities.tsv',
  runtimesLiboliphauntWasixPostmasterWasmerBinVerifyPostmasterConcurrencyContractTestMts:
    'src/wasix/postmaster/wasmer/bin/verify-postmaster-concurrency-contract.test.mts',
  srcSourcesThirdPartyNativeREADMEMd: 'src/sources/third-party/native/README.md',
  toolsDevMaestroToml: 'tools/dev/maestro.toml',
  postgresToolsWasixCratesToolsSrcLibRs: 'src/wasix/postgres-tools/crates/tools/src/lib.rs',
  runtimesLiboliphauntWasixToolsXtaskSrcMainRs: 'src/wasix/runtime/tools/xtask/src/main.rs',
  runtimesLiboliphauntWasixAssetsBuildDockerInstallPinnedWasixccSh:
    'src/wasix/runtime/assets/build/docker/install-pinned-wasixcc.sh',
  docsInternalOLIPHAUNTPATCHSTACKMd: 'src/docs/internal/OLIPHAUNT_PATCH_STACK.md',
  runtimesLiboliphauntWasixPostmasterExecutorSrcExecuteRs:
    'src/wasix/postmaster/executor/src/execute.rs',
  runtimesLiboliphauntWasixPostmasterToolsMergeProductReleaseAssetsMts:
    'src/wasix/postmaster/tools/merge-product-release-assets.mts',
  extensionsTestsNativeToolsRunNativeExtensionLifecycleProofSh:
    'src/extensions/tests/native/tools/run-native-extension-lifecycle-proof.sh',
  extensionsTestsNativeSrcMainRs: 'src/extensions/tests/native/src/main.rs',
  runtimesLiboliphauntWasixPostmasterLibProcessSupervisionSh:
    'src/wasix/postmaster/lib/process-supervision.sh',
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
