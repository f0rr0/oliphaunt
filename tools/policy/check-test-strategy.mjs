#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { runMoon } from './moon.mjs';

function fail(message) {
  throw new Error(message);
}

function requireFile(path) {
  if (!existsSync(path)) {
    fail(`missing test strategy file: ${path}`);
  }
}

function requireText(path, text) {
  const source = readFileSync(path, 'utf8');
  if (!source.includes(text)) {
    fail(`expected '${text}' in ${path}`);
  }
}

function rejectText(path, text) {
  const source = readFileSync(path, 'utf8');
  if (source.includes(text)) {
    fail(`unexpected '${text}' in ${path}`);
  }
}

function posixRelative(from, to) {
  return path.relative(from, to).split(path.sep).join('/');
}

function expectedJsTestScript(packagePath) {
  const packageDir = path.dirname(packagePath);
  const runner = posixRelative(packageDir, 'tools/test/run-js-tests.mjs');
  return `node ${runner} src/__tests__`;
}

function parseTasks() {
  const parsed = JSON.parse(runMoon(['query', 'tasks']));
  if (!parsed.tasks || typeof parsed.tasks !== 'object') {
    fail('moon query tasks did not return a tasks object');
  }
  return parsed.tasks;
}

function taskCommand(tasks, projectId, taskId) {
  const task = tasks[projectId]?.[taskId];
  if (!task) {
    fail(`missing moon task ${projectId}:${taskId}`);
  }
  return [task.command, ...(task.args ?? [])].join(' ').trim();
}

function configuredTask(tasks, projectId, taskId) {
  const configured = tasks[projectId]?.[taskId];
  if (!configured) {
    fail(`missing moon task ${projectId}:${taskId}`);
  }
  return configured;
}

function taskDeps(tasks, projectId, taskId) {
  return (configuredTask(tasks, projectId, taskId).deps ?? []).map((dep) => dep.target ?? dep);
}

function requireTaskDependency(tasks, projectId, taskId, dependency) {
  const deps = taskDeps(tasks, projectId, taskId);
  if (!deps.includes(dependency)) {
    fail(`${projectId}:${taskId} must depend on ${dependency}; got [${deps.join(', ')}]`);
  }
}

function requireDistinctTaskCommands(tasks, projectId, left, right) {
  const leftCommand = taskCommand(tasks, projectId, left);
  const rightCommand = taskCommand(tasks, projectId, right);
  if (leftCommand === rightCommand) {
    fail(`${projectId}:${left} and ${projectId}:${right} must not call the same command`);
  }
}

for (const path of [
  'src/shared/fixtures/protocol/query-response-cases.json',
  'src/shared/fixtures/sdk-capabilities/mode-support.json',
  'src/shared/fixtures/runtime-resources/manifest.properties',
  'src/shared/fixtures/runtime-resources/template-pgdata-manifest.properties',
  'src/shared/fixtures/runtime-resources/package-size.tsv',
  'src/shared/fixtures/backup/physical-archive-manifest.json',
  'src/shared/fixtures/lifecycle/session-lifecycle.json',
  'src/shared/fixtures/react-native-jsi/binary-transport.json',
  'coverage/baseline.toml',
  'tools/runtime/preflight.sh',
  'tools/test/run-js-tests.mjs',
]) {
  requireFile(path);
}

const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
const rootScripts = Object.keys(packageJson.scripts ?? {});
if (rootScripts.length !== 0) {
  fail(`root package.json scripts must be empty; use moon directly, got ${rootScripts.join(', ')}`);
}

const tasks = parseTasks();

for (const [projectId, projectTasks] of Object.entries(tasks)) {
  if (projectTasks.check && projectTasks.test) {
    requireDistinctTaskCommands(tasks, projectId, 'check', 'test');
  }
}

const peerProducts = [
  'oliphaunt-rust',
  'oliphaunt-swift',
  'oliphaunt-kotlin',
  'oliphaunt-js',
  'oliphaunt-react-native',
  'oliphaunt-wasix-rust',
];

for (const product of peerProducts) {
  const requiredTaskIds =
    product === 'oliphaunt-wasix-rust'
      ? ['check', 'test', 'package', 'example-check', 'coverage', 'bench']
      : ['check', 'test', 'package', 'smoke', 'regression', 'coverage', 'bench'];
  for (const taskId of requiredTaskIds) {
    taskCommand(tasks, product, taskId);
    if (configuredTask(tasks, product, taskId).state?.defaultInputs) {
      fail(`${product}:${taskId} must declare explicit Moon inputs instead of default **/* inputs`);
    }
  }
  requireDistinctTaskCommands(tasks, product, 'check', 'test');
  requireDistinctTaskCommands(tasks, product, 'test', 'package');
  if (product === 'oliphaunt-wasix-rust') {
    requireDistinctTaskCommands(tasks, product, 'check', 'example-check');
  }
  for (const cacheableTask of ['check', 'test', 'coverage', 'bench']) {
    if (configuredTask(tasks, product, cacheableTask).options?.cache !== true) {
      fail(`${product}:${cacheableTask} must be cacheable; it is deterministic product validation`);
    }
  }
  if (requiredTaskIds.includes('smoke') && configuredTask(tasks, product, 'smoke').options?.cache !== 'local') {
    fail(`${product}:smoke must use local-only caching for developer runtime probes`);
  }
  if (product === 'oliphaunt-wasix-rust' && configuredTask(tasks, product, 'example-check').options?.cache !== 'local') {
    fail('oliphaunt-wasix-rust:example-check must use local-only caching for product-local example validation');
  }
  if (!taskCommand(tasks, product, 'test').match(/(test-unit|check-unit\.sh|cargo nextest|swift test|gradle .*test|pnpm .* test|runtime-smoke)/)) {
    fail(`${product}:test must run product-native tests, not only metadata checks`);
  }
  if (taskCommand(tasks, product, 'test').includes('--no-run')) {
    fail(`${product}:test must execute deterministic tests; compile-only belongs in check/package`);
  }
  const coverageCommand = taskCommand(tasks, product, 'coverage');
  if (!coverageCommand.includes(`tools/coverage/run-product ${product}`)) {
    fail(`${product}:coverage must run measured product coverage through tools/coverage/run-product`);
  }
  if (coverageCommand.includes('tools/policy/check-coverage.sh')) {
    fail(`${product}:coverage must not be a metadata-only policy check`);
  }
  const coverageTask = configuredTask(tasks, product, 'coverage');
  const outputs = [
    ...Object.keys(coverageTask.outputFiles ?? {}),
    ...Object.keys(coverageTask.outputGlobs ?? {}),
    ...(coverageTask.outputs ?? []).map((output) => output.file ?? output.glob ?? output).filter(Boolean),
  ];
  if (!outputs.includes(`target/coverage/${product}/**/*`)) {
    fail(`${product}:coverage must declare target/coverage/${product}/**/* as a Moon output`);
  }
}

for (const taskId of ['check', 'release-check', 'runtime-portable', 'runtime-aot', 'smoke', 'regression']) {
  taskCommand(tasks, 'liboliphaunt-wasix', taskId);
  if (configuredTask(tasks, 'liboliphaunt-wasix', taskId).state?.defaultInputs) {
    fail(`liboliphaunt-wasix:${taskId} must declare explicit Moon inputs instead of default **/* inputs`);
  }
}
if (configuredTask(tasks, 'liboliphaunt-wasix', 'smoke').options?.cache !== 'local') {
  fail('liboliphaunt-wasix:smoke must use local-only caching for developer runtime probes');
}

for (const task of ['smoke-android', 'smoke-ios', 'smoke-mobile']) {
  taskCommand(tasks, 'oliphaunt-react-native', task);
  if (tasks['oliphaunt-react-native'][task].options?.cache !== 'local') {
    fail(`oliphaunt-react-native:${task} must use local-only caching`);
  }
}
if (taskCommand(tasks, 'oliphaunt-react-native', 'smoke') !== taskCommand(tasks, 'oliphaunt-react-native', 'smoke-mobile')) {
  fail('oliphaunt-react-native:smoke must be the explicit mobile smoke aggregate');
}
requireTaskDependency(tasks, 'oliphaunt-react-native', 'smoke-mobile', 'oliphaunt-swift:smoke');
requireTaskDependency(tasks, 'oliphaunt-react-native', 'smoke-mobile', 'oliphaunt-kotlin:smoke');
for (const task of ['smoke', 'smoke-android', 'smoke-ios', 'smoke-mobile']) {
  if (configuredTask(tasks, 'oliphaunt-react-native', task).options?.runInCI === false) {
    fail(`oliphaunt-react-native:${task} is an explicit mobile smoke lane and must not set runInCI=false`);
  }
}
if (taskCommand(tasks, 'oliphaunt-react-native', 'e2e') !== 'pnpm --dir src/sdks/react-native/examples/expo run mobile-e2e') {
  fail('oliphaunt-react-native:e2e must be the explicit installed-app E2E aggregate');
}
for (const task of [
  'mobile-build-android',
  'mobile-e2e-android',
  'mobile-build-ios',
  'mobile-e2e-ios',
]) {
  requireTaskDependency(tasks, 'oliphaunt-react-native', 'e2e', `oliphaunt-react-native:${task}`);
}
if (configuredTask(tasks, 'oliphaunt-react-native', 'e2e').options?.cache !== false) {
  fail('oliphaunt-react-native:e2e must not use Moon cache; installed-app E2E is runtime evidence');
}
if (configuredTask(tasks, 'oliphaunt-react-native', 'e2e').options?.runInCI !== false) {
  fail('oliphaunt-react-native:e2e aggregate must not run in default Moon CI; CI selects platform E2E lanes explicitly');
}
for (const task of [
  'mobile-build-android',
  'mobile-e2e-android',
  'mobile-build-ios',
  'mobile-e2e-ios',
]) {
  taskCommand(tasks, 'oliphaunt-react-native', task);
  if (configuredTask(tasks, 'oliphaunt-react-native', task).options?.cache !== false) {
    fail(`oliphaunt-react-native:${task} must not use Moon cache; mobile app build/e2e state is runtime evidence`);
  }
  const runInCI = configuredTask(tasks, 'oliphaunt-react-native', task).options?.runInCI;
  if (task.startsWith('mobile-e2e-')) {
    if (runInCI !== 'skip') {
      fail(`oliphaunt-react-native:${task} must use runInCI=skip so broad Moon CI does not start installed-app E2E`);
    }
  } else if (runInCI === false) {
    fail(`oliphaunt-react-native:${task} is a selected mobile CI lane and must not set runInCI=false`);
  }
}
for (const task of ['mobile-drill-android', 'mobile-drill-ios']) {
  taskCommand(tasks, 'oliphaunt-react-native', task);
  if (configuredTask(tasks, 'oliphaunt-react-native', task).options?.cache !== false) {
    fail(`oliphaunt-react-native:${task} must not use Moon cache; lifecycle/crash drills are runtime evidence`);
  }
  if (configuredTask(tasks, 'oliphaunt-react-native', task).options?.runInCI !== false) {
    fail(`oliphaunt-react-native:${task} must stay out of default CI; schedule it in nightly/release/manual lanes`);
  }
}
requireText('src/sdks/react-native/tools/mobile-build.sh', 'OLIPHAUNT_EXPO_ANDROID_BUILD_TYPE="${OLIPHAUNT_EXPO_ANDROID_BUILD_TYPE:-release}"');
requireText('src/sdks/react-native/tools/mobile-build.sh', 'OLIPHAUNT_EXPO_IOS_CONFIGURATION="${OLIPHAUNT_EXPO_IOS_CONFIGURATION:-Release}"');
requireText('src/sdks/react-native/tools/mobile-e2e.sh', 'OLIPHAUNT_EXPO_ANDROID_E2E_ONLY=1');
requireText('src/sdks/react-native/tools/mobile-e2e.sh', 'OLIPHAUNT_EXPO_IOS_E2E_ONLY=1');
requireText('src/sdks/react-native/tools/mobile-e2e.sh', 'OLIPHAUNT_EXPO_IOS_CONFIGURATION="${OLIPHAUNT_EXPO_IOS_CONFIGURATION:-Release}"');
requireText('src/sdks/react-native/tools/mobile-e2e.sh', 'OLIPHAUNT_MOBILE_E2E_ASSERTION_RUNNER="${OLIPHAUNT_MOBILE_E2E_ASSERTION_RUNNER:-maestro}"');
requireText('src/sdks/react-native/tools/mobile-e2e.sh', 'OLIPHAUNT_EXPO_ANDROID_LIFECYCLE_SMOKE="${OLIPHAUNT_EXPO_ANDROID_LIFECYCLE_SMOKE:-0}"');
requireText('src/sdks/react-native/tools/mobile-e2e.sh', 'OLIPHAUNT_EXPO_IOS_LIFECYCLE_SMOKE="${OLIPHAUNT_EXPO_IOS_LIFECYCLE_SMOKE:-0}"');
requireText('src/sdks/react-native/examples/expo/src/SmokeDashboard.tsx', 'liboliphaunt-smoke-status-${state}');
requireText('src/sdks/react-native/examples/expo/maestro/installed-smoke.yaml', 'id: liboliphaunt-smoke-status-passed');
requireText('src/sdks/react-native/examples/expo/maestro/installed-smoke.yaml', 'id: liboliphaunt-smoke-result');
requireText('src/sdks/react-native/tools/expo-runner-common.sh', 'maestro_binary()');
requireText('src/sdks/react-native/tools/expo-runner-common.sh', 'file_from_offset()');
requireText('src/sdks/react-native/tools/expo-runner-common.sh', 'urlencode()');
requireText('src/sdks/react-native/tools/expo-runner-metro.sh', 'reserve_metro_port()');
requireText('src/sdks/react-native/tools/expo-runner-metro.sh', 'stop_owned_metro()');
requireText('src/sdks/react-native/tools/expo-runner-metro.sh', 'cleanup()');
requireText('src/sdks/react-native/tools/expo-runner-reporting.sh', 'write_runner_report()');
requireText('src/sdks/react-native/tools/expo-runner-reporting.sh', 'write_maestro_runner_report()');
requireText('src/sdks/react-native/tools/expo-runner-reporting.sh', 'write_mobile_package_size_report()');
requireText('src/sdks/react-native/tools/expo-runner-reporting.sh', 'write_mobile_build_artifact_report_json()');
requireText('src/sdks/react-native/tools/expo-runner-reporting.sh', 'OLIPHAUNT_EXPO_LOG_TAG');
requireText('src/sdks/react-native/tools/expo-runner-reporting.sh', "schema: 'oliphaunt-react-native-mobile-build-v1'");
requireText('src/sdks/react-native/tools/expo-runner-runtime-resources.sh', 'prepare_mobile_runtime_resource_package()');
requireText('src/sdks/react-native/tools/expo-runner-runtime-resources.sh', 'copy_mobile_runtime_files()');
requireText('src/sdks/react-native/tools/expo-runner-runtime-resources.sh', 'schema=oliphaunt-runtime-resources-v1');
requireText('src/sdks/react-native/tools/expo-runner-runtime-resources.sh', 'kind\tid\textensions\tfiles\tbytes');
requireText('src/sdks/react-native/tools/expo-runner-runtime-resources.sh', 'oliphaunt_dev_assert_runtime_data_files "$runtime_dest" "$selected_extensions" "$platform"');
requireText('src/sdks/react-native/tools/expo-runner-runtime-resources.sh', 'src/extensions/generated/mobile/static-registry.json');
requireText('src/sdks/react-native/tools/expo-runner-workspace.sh', 'prepare_expo_example_workspace()');
requireText('src/sdks/react-native/tools/expo-runner-workspace.sh', 'prepare_react_native_package_worktree()');
requireText('src/sdks/react-native/tools/expo-runner-workspace.sh', 'prepare_mobile_template_pgdata()');
requireText('src/sdks/react-native/tools/expo-runner-workspace.sh', 'find_latest_mobile_pgdata()');
requireText('src/sdks/react-native/tools/expo-runner-ios-device.sh', 'select_ios_simulator_udid()');
requireText('src/sdks/react-native/tools/expo-runner-ios-device.sh', 'select_ios_physical_device_id()');
requireText('src/sdks/react-native/tools/expo-runner-ios-device.sh', 'configure_iphoneos_signing()');
requireText('src/sdks/react-native/tools/expo-runner-ios-device.sh', 'preflight_physical_ios_device()');
requireText('src/sdks/react-native/tools/expo-runner-ios-device.sh', 'resolve_xcode_destination()');
requireText('src/sdks/react-native/tools/expo-runner-ios-device.sh', 'boot_ios_simulator()');
requireText('src/sdks/react-native/tools/expo-runner-ios-installed-app.sh', 'latest_metro_runner_pass()');
requireText('src/sdks/react-native/tools/expo-runner-ios-installed-app.sh', 'run_maestro_installed_smoke()');
requireText('src/sdks/react-native/tools/expo-runner-ios-installed-app.sh', 'write_ios_process_metrics()');
requireText('src/sdks/react-native/tools/expo-runner-ios-installed-app.sh', 'resolve_prebuilt_ios_app()');
requireText('src/sdks/react-native/tools/expo-runner-ios-installed-app.sh', 'write_ios_device_process_metrics()');
requireText('src/sdks/react-native/tools/expo-runner-ios-installed-app.sh', 'exercise_ios_lifecycle()');
requireText('src/sdks/react-native/tools/expo-runner-ios-installed-app.sh', 'exercise_ios_device_lifecycle()');
requireText('src/sdks/react-native/tools/expo-runner-ios-installed-app.sh', 'exercise_ios_crash_recovery()');
requireText('src/sdks/react-native/tools/expo-runner-ios-installed-app.sh', 'exercise_ios_device_crash_recovery()');
requireText('src/sdks/react-native/tools/expo-runner-ios-installed-app.sh', 'install_and_launch()');
requireText('src/sdks/react-native/tools/expo-runner-android-device.sh', 'should_use_maestro_e2e()');
requireText('src/sdks/react-native/tools/expo-runner-android-device.sh', 'run_maestro_installed_smoke()');
requireText('src/sdks/react-native/tools/expo-runner-android-device.sh', 'write_android_process_metrics()');
requireText('src/sdks/react-native/tools/expo-runner-android-device.sh', 'write_android_e2e_diagnostics()');
requireText('src/sdks/react-native/tools/expo-runner-android-device.sh', 'exercise_android_lifecycle()');
requireText('src/sdks/react-native/tools/expo-runner-android-device.sh', 'wake_android_device()');
requireText('src/sdks/react-native/tools/expo-runner-android-device.sh', 'exercise_android_crash_recovery()');
requireText('src/sdks/react-native/tools/expo-runner-android-device.sh', 'install_and_launch()');
requireText('src/sdks/react-native/tools/expo-runner-android-device.sh', 'dismiss_expo_dev_menu_onboarding()');
requireText('src/sdks/react-native/tools/expo-ios-runner.sh', 'src/sdks/react-native/tools/expo-runner-common.sh');
requireText('src/sdks/react-native/tools/expo-ios-runner.sh', 'src/sdks/react-native/tools/expo-runner-metro.sh');
requireText('src/sdks/react-native/tools/expo-ios-runner.sh', 'src/sdks/react-native/tools/expo-runner-reporting.sh');
requireText('src/sdks/react-native/tools/expo-ios-runner.sh', 'src/sdks/react-native/tools/expo-runner-workspace.sh');
requireText('src/sdks/react-native/tools/expo-ios-runner.sh', 'src/sdks/react-native/tools/mobile-extension-runtime.sh');
requireText('src/sdks/react-native/tools/expo-ios-runner.sh', 'src/sdks/react-native/tools/expo-runner-runtime-resources.sh');
requireText('src/sdks/react-native/tools/expo-ios-runner.sh', 'src/sdks/react-native/tools/expo-runner-ios-device.sh');
requireText('src/sdks/react-native/tools/expo-ios-runner.sh', 'src/sdks/react-native/tools/expo-runner-ios-installed-app.sh');
requireText('src/sdks/react-native/tools/expo-ios-runner.sh', 'prepare_mobile_runtime_resource_package \\');
requireText('src/sdks/react-native/tools/expo-ios-runner.sh', 'iOS \\');
requireText('src/sdks/react-native/tools/expo-ios-runner.sh', 'oliphaunt_dev_assert_runtime_file_list "$selected_extensions" "iOS"');
requireText('src/sdks/react-native/tools/expo-ios-runner.sh', 'iOS app is missing OliphauntReactNativeResources.bundle/oliphaunt resource root');
requireText('src/sdks/react-native/tools/expo-android-runner.sh', 'src/sdks/react-native/tools/expo-runner-common.sh');
requireText('src/sdks/react-native/tools/expo-android-runner.sh', 'src/sdks/react-native/tools/expo-runner-metro.sh');
requireText('src/sdks/react-native/tools/expo-android-runner.sh', 'src/sdks/react-native/tools/expo-runner-reporting.sh');
requireText('src/sdks/react-native/tools/expo-android-runner.sh', 'src/sdks/react-native/tools/expo-runner-workspace.sh');
requireText('src/sdks/react-native/tools/expo-android-runner.sh', 'src/sdks/react-native/tools/mobile-extension-runtime.sh');
requireText('src/sdks/react-native/tools/expo-android-runner.sh', 'src/sdks/react-native/tools/expo-runner-runtime-resources.sh');
requireText('src/sdks/react-native/tools/expo-android-runner.sh', 'src/sdks/react-native/tools/expo-runner-android-device.sh');
requireText('src/sdks/react-native/tools/expo-android-runner.sh', 'prepare_mobile_runtime_resource_package \\');
requireText('src/sdks/react-native/tools/expo-android-runner.sh', 'Android \\');
requireText('src/sdks/react-native/tools/expo-android-runner.sh', 'oliphaunt_dev_assert_runtime_file_list "$selected_extensions" "Android"');
rejectText('src/sdks/react-native/tools/expo-ios-runner.sh', '\nrun() {');
rejectText('src/sdks/react-native/tools/expo-ios-runner.sh', '\nmaestro_binary() {');
rejectText('src/sdks/react-native/tools/expo-ios-runner.sh', '\nfile_from_offset() {');
rejectText('src/sdks/react-native/tools/expo-ios-runner.sh', '\nprepare_expo_example_workspace() {');
rejectText('src/sdks/react-native/tools/expo-ios-runner.sh', '\nprepare_react_native_package_worktree() {');
rejectText('src/sdks/react-native/tools/expo-ios-runner.sh', '\nprepare_mobile_template_pgdata() {');
rejectText('src/sdks/react-native/tools/expo-ios-runner.sh', '\nfind_latest_pgdata() {');
rejectText('src/sdks/react-native/tools/expo-ios-runner.sh', '\nport_is_listening() {');
rejectText('src/sdks/react-native/tools/expo-ios-runner.sh', '\nreserve_metro_port() {');
rejectText('src/sdks/react-native/tools/expo-ios-runner.sh', '\nkill_process_tree() {');
rejectText('src/sdks/react-native/tools/expo-ios-runner.sh', '\nstop_owned_metro() {');
rejectText('src/sdks/react-native/tools/expo-ios-runner.sh', '\ncleanup() {');
rejectText('src/sdks/react-native/tools/expo-ios-runner.sh', '\nwrite_runner_report() {');
rejectText('src/sdks/react-native/tools/expo-ios-runner.sh', '\nwrite_maestro_runner_report() {');
rejectText('src/sdks/react-native/tools/expo-ios-runner.sh', '\ncopy_mobile_runtime_files() {');
rejectText('src/sdks/react-native/tools/expo-ios-runner.sh', '\nselect_ios_simulator_udid() {');
rejectText('src/sdks/react-native/tools/expo-ios-runner.sh', '\nselect_ios_physical_device_id() {');
rejectText('src/sdks/react-native/tools/expo-ios-runner.sh', '\nconfigure_iphoneos_signing() {');
rejectText('src/sdks/react-native/tools/expo-ios-runner.sh', '\npreflight_physical_ios_device() {');
rejectText('src/sdks/react-native/tools/expo-ios-runner.sh', '\nresolve_xcode_destination() {');
rejectText('src/sdks/react-native/tools/expo-ios-runner.sh', '\nboot_ios_simulator() {');
rejectText('src/sdks/react-native/tools/expo-ios-runner.sh', '\nlatest_metro_runner_pass() {');
rejectText('src/sdks/react-native/tools/expo-ios-runner.sh', '\nlatest_metro_tag() {');
rejectText('src/sdks/react-native/tools/expo-ios-runner.sh', '\nlatest_metro_runner_failure() {');
rejectText('src/sdks/react-native/tools/expo-ios-runner.sh', '\nshould_use_maestro_e2e() {');
rejectText('src/sdks/react-native/tools/expo-ios-runner.sh', '\nrun_maestro_installed_smoke() {');
rejectText('src/sdks/react-native/tools/expo-ios-runner.sh', '\nwrite_ios_process_metrics() {');
rejectText('src/sdks/react-native/tools/expo-ios-runner.sh', '\nresolve_prebuilt_ios_app() {');
rejectText('src/sdks/react-native/tools/expo-ios-runner.sh', '\nextract_devicectl_pid() {');
rejectText('src/sdks/react-native/tools/expo-ios-runner.sh', '\nwrite_ios_device_process_metrics() {');
rejectText('src/sdks/react-native/tools/expo-ios-runner.sh', '\nlogs_have_lifecycle_ready() {');
rejectText('src/sdks/react-native/tools/expo-ios-runner.sh', '\nexercise_ios_lifecycle() {');
rejectText('src/sdks/react-native/tools/expo-ios-runner.sh', '\nexercise_ios_device_lifecycle() {');
rejectText('src/sdks/react-native/tools/expo-ios-runner.sh', '\nios_metro_url() {');
rejectText('src/sdks/react-native/tools/expo-ios-runner.sh', '\nios_runner_url() {');
rejectText('src/sdks/react-native/tools/expo-ios-runner.sh', '\nwait_for_ios_tag() {');
rejectText('src/sdks/react-native/tools/expo-ios-runner.sh', '\nexercise_ios_crash_recovery() {');
rejectText('src/sdks/react-native/tools/expo-ios-runner.sh', '\nlaunch_ios_device_runner() {');
rejectText('src/sdks/react-native/tools/expo-ios-runner.sh', '\nwait_for_ios_device_runner() {');
rejectText('src/sdks/react-native/tools/expo-ios-runner.sh', '\nexercise_ios_device_crash_recovery() {');
rejectText('src/sdks/react-native/tools/expo-ios-runner.sh', '\nwait_for_ios_tag_from_metro() {');
rejectText('src/sdks/react-native/tools/expo-ios-runner.sh', '\ninstall_and_launch() {');
rejectText('src/sdks/react-native/tools/expo-ios-runner.sh', 'cat >"$reports_dir/$runner-package-sizes.json" <<JSON');
rejectText('src/sdks/react-native/tools/expo-ios-runner.sh', 'cat >"$package_root/oliphaunt/runtime/manifest.properties" <<MANIFEST');
rejectText('src/sdks/react-native/tools/expo-ios-runner.sh', 'cat >"$package_root/oliphaunt/package-size.tsv" <<REPORT');
rejectText('src/sdks/react-native/tools/expo-ios-runner.sh', "schema: 'oliphaunt-react-native-mobile-build-v1'");
rejectText('src/sdks/react-native/tools/expo-android-runner.sh', '\nrun() {');
rejectText('src/sdks/react-native/tools/expo-android-runner.sh', '\nmaestro_binary() {');
rejectText('src/sdks/react-native/tools/expo-android-runner.sh', '\nfile_from_offset() {');
rejectText('src/sdks/react-native/tools/expo-android-runner.sh', '\nprepare_expo_example_workspace() {');
rejectText('src/sdks/react-native/tools/expo-android-runner.sh', '\nprepare_react_native_package_worktree() {');
rejectText('src/sdks/react-native/tools/expo-android-runner.sh', '\nprepare_mobile_template_pgdata() {');
rejectText('src/sdks/react-native/tools/expo-android-runner.sh', '\nfind_latest_pgdata() {');
rejectText('src/sdks/react-native/tools/expo-android-runner.sh', '\nport_is_listening() {');
rejectText('src/sdks/react-native/tools/expo-android-runner.sh', '\nreserve_metro_port() {');
rejectText('src/sdks/react-native/tools/expo-android-runner.sh', '\nkill_process_tree() {');
rejectText('src/sdks/react-native/tools/expo-android-runner.sh', '\nstop_owned_metro() {');
rejectText('src/sdks/react-native/tools/expo-android-runner.sh', '\ncleanup() {');
rejectText('src/sdks/react-native/tools/expo-android-runner.sh', '\nwrite_runner_report() {');
rejectText('src/sdks/react-native/tools/expo-android-runner.sh', '\nwrite_maestro_runner_report() {');
rejectText('src/sdks/react-native/tools/expo-android-runner.sh', '\ncopy_mobile_runtime_files() {');
rejectText('src/sdks/react-native/tools/expo-android-runner.sh', '\nshould_use_maestro_e2e() {');
rejectText('src/sdks/react-native/tools/expo-android-runner.sh', '\nrun_maestro_installed_smoke() {');
rejectText('src/sdks/react-native/tools/expo-android-runner.sh', '\nlatest_metro_tag() {');
rejectText('src/sdks/react-native/tools/expo-android-runner.sh', '\nwrite_android_process_metrics() {');
rejectText('src/sdks/react-native/tools/expo-android-runner.sh', '\nlogs_have_lifecycle_ready() {');
rejectText('src/sdks/react-native/tools/expo-android-runner.sh', '\nandroid_failure_log_pattern() {');
rejectText('src/sdks/react-native/tools/expo-android-runner.sh', '\nprint_android_timeout_diagnostics() {');
rejectText('src/sdks/react-native/tools/expo-android-runner.sh', '\nexercise_android_lifecycle() {');
rejectText('src/sdks/react-native/tools/expo-android-runner.sh', '\nandroid_task_id() {');
rejectText('src/sdks/react-native/tools/expo-android-runner.sh', '\nforeground_android_app() {');
rejectText('src/sdks/react-native/tools/expo-android-runner.sh', '\nandroid_runner_url() {');
rejectText('src/sdks/react-native/tools/expo-android-runner.sh', '\nwait_for_android_tag() {');
rejectText('src/sdks/react-native/tools/expo-android-runner.sh', '\nwake_android_device() {');
rejectText('src/sdks/react-native/tools/expo-android-runner.sh', '\nexercise_android_crash_recovery() {');
rejectText('src/sdks/react-native/tools/expo-android-runner.sh', '\ninstall_and_launch() {');
rejectText('src/sdks/react-native/tools/expo-android-runner.sh', '\ndismiss_expo_dev_menu_onboarding() {');
rejectText('src/sdks/react-native/tools/expo-android-runner.sh', 'cat >"$reports_dir/$runner-package-sizes.json" <<JSON');
rejectText('src/sdks/react-native/tools/expo-android-runner.sh', 'cat >"$package_root/oliphaunt/runtime/manifest.properties" <<MANIFEST');
rejectText('src/sdks/react-native/tools/expo-android-runner.sh', 'cat >"$package_root/oliphaunt/package-size.tsv" <<REPORT');
rejectText('src/sdks/react-native/tools/expo-android-runner.sh', "schema: 'oliphaunt-react-native-mobile-build-v1'");
requireText('src/sdks/react-native/tools/mobile-extension-runtime.sh', 'oliphaunt_dev_normalize_mobile_extensions');
requireText('src/sdks/react-native/tools/mobile-extension-runtime.sh', 'selected-extension-dependencies');
requireText('src/sdks/react-native/tools/mobile-extension-runtime.sh', 'oliphaunt_dev_installed_runtime_extension_complete');
requireText('src/sdks/react-native/tools/mobile-extension-runtime.sh', 'default_version');
requireText('src/sdks/react-native/tools/mobile-extension-runtime.sh', 'extension install script for default_version=');
requireText('src/sdks/react-native/tools/mobile-extension-runtime.sh', 'app includes unselected PostgreSQL extension asset');
requireText('src/sdks/react-native/tools/mobile-extension-runtime.sh', 'app includes unselected ${sqlName} extension data file');
requireText('tools/dev/setup-maestro.sh', 'src/sources/toolchains/maestro.toml');
requireText('tools/dev/setup-maestro.sh', 'https://get.maestro.mobile.dev');
requireText('src/sdks/react-native/tools/expo-runner-android-device.sh', 'run_maestro_installed_smoke');
requireText('src/sdks/react-native/tools/expo-runner-ios-installed-app.sh', 'run_maestro_installed_smoke');
rejectText(
  'src/sdks/react-native/tools/expo-android-runner.sh',
  'Android E2E-only mode requires the generated Expo example',
);
rejectText(
  'src/sdks/react-native/tools/expo-ios-runner.sh',
  'iOS E2E-only mode requires the generated Expo example',
);
requireText('src/sdks/react-native/tools/expo-ios-runner.sh', 'uses_ios_metro()');
requireText(
  'src/sdks/react-native/tools/expo-runner-ios-installed-app.sh',
  'local url="$scheme://oliphaunt-smoke?liboliphauntRunner=$selected_runner',
);
requireText('src/sdks/react-native/tools/expo-android-runner.sh', 'write_mobile_package_size_report apkBytes "$apk_bytes" "$rn_package_bytes"');
requireText('src/sdks/react-native/tools/expo-android-runner.sh', 'write_mobile_build_artifact_report_json \\');
requireText('src/sdks/react-native/tools/expo-android-runner.sh', 'buildType "$build_type" \\');
requireText('src/sdks/react-native/tools/expo-android-runner.sh', 'abi "$android_abi"');
requireText('src/sdks/react-native/tools/expo-ios-runner.sh', 'write_mobile_package_size_report iosAppBytes "$app_bytes" "$rn_package_bytes"');
requireText('src/sdks/react-native/tools/expo-ios-runner.sh', 'write_mobile_build_artifact_report_json \\');
requireText('src/sdks/react-native/tools/expo-ios-runner.sh', 'configuration "$configuration" \\');
requireText('src/sdks/react-native/tools/expo-ios-runner.sh', 'sdk "$sdk"');
requireText('docs/maintainers/testing.md', 'pinned open-source Maestro CLI');
requireText('docs/maintainers/testing.md', 'GitHub-hosted emulator/simulator jobs');
requireText('docs/maintainers/testing.md', 'Decision (2026-06-08)');
requireText('docs/maintainers/testing.md', 'This is not an open research loop');
requireText('docs/maintainers/testing.md', 'Do not keep re-checking Maestro');
requireText('docs/maintainers/testing.md', 'written implementation proposal');
requireText('docs/maintainers/testing.md', 'installed-app E2E requirement that the pinned open-source Maestro CLI cannot');
requireText('docs/maintainers/testing.md', 'free and public-checkout');
requireText('docs/maintainers/testing.md', 'Paid hosted-device providers');
requireText('docs/maintainers/testing.md', 'Debug the chosen implementation first');
requireText('docs/maintainers/testing.md', 'free and public-checkout');
requireText('src/sources/toolchains/maestro.toml', 'free, public-checkout reproducible');

const wasmTestCommand = taskCommand(tasks, 'oliphaunt-wasix-rust', 'test');
if (wasmTestCommand !== 'bash src/bindings/wasix-rust/tools/check-unit.sh') {
  fail('oliphaunt-wasix-rust:test must use the product-owned WASIX Rust unit test wrapper');
}
requireText('src/bindings/wasix-rust/tools/check-unit.sh', 'cargo test -p oliphaunt-wasix --doc --locked');
requireText('src/bindings/wasix-rust/tools/check-unit.sh', 'cargo nextest run -p oliphaunt-wasix --locked --profile ci --no-default-features --lib --no-tests=fail --test-threads=1');
if (!taskCommand(tasks, 'liboliphaunt-wasix', 'regression').includes('runtime-smoke.sh regression')) {
  fail('liboliphaunt-wasix:regression must use the full regression runtime-smoke mode');
}
requireText('src/runtimes/liboliphaunt/wasix/tools/runtime-smoke.sh', 'tools/runtime/preflight.sh');
requireText('src/runtimes/liboliphaunt/wasix/tools/runtime-smoke.sh', 'oliphaunt_runtime_wasm_require "$mode"');
requireText('src/runtimes/liboliphaunt/wasix/tools/runtime-smoke.sh', '--test client_compat');
requireText('tools/runtime/preflight.sh', 'full WASIX assets are required');

for (const packagePath of ['src/sdks/js/package.json', 'src/sdks/react-native/package.json']) {
  const productPackage = JSON.parse(readFileSync(packagePath, 'utf8'));
  const testScript = productPackage.scripts?.test ?? '';
  if (testScript !== expectedJsTestScript(packagePath)) {
    fail(`${packagePath} must use shared *.test.ts discovery for its test script`);
  }
  if (testScript.includes('tsx src/__tests__/')) {
    fail(`${packagePath} must not manually chain individual test files`);
  }
  if (!productPackage.devDependencies?.vitest) {
    fail(`${packagePath} must use Vitest for discovered TypeScript tests`);
  }
  if (!productPackage.devDependencies?.['@vitest/coverage-v8']) {
    fail(`${packagePath} must use Vitest's V8 coverage provider for TypeScript coverage`);
  }
  if (productPackage.devDependencies?.c8) {
    fail(`${packagePath} must not keep c8 as a parallel TypeScript coverage runner`);
  }
}
const rnPackage = JSON.parse(readFileSync('src/sdks/react-native/package.json', 'utf8'));
if (rnPackage['react-native'] !== 'lib/module/index.js') {
  fail('React Native package must expose the compiled module entrypoint to Metro; raw TS source breaks Release bundling with ESM .js specifiers');
}
if (!rnPackage.scripts?.build?.includes('tsconfig.build.module.json') || !rnPackage.scripts?.build?.includes('tsconfig.build.commonjs.json')) {
  fail('React Native package build must emit real module and CommonJS JavaScript artifacts, not declarations only');
}
requireText('src/sdks/react-native/tsconfig.build.module.json', '"outDir": "lib/module"');
requireText('src/sdks/react-native/tsconfig.build.commonjs.json', '"outDir": "lib/commonjs"');

const jsRunner = readFileSync('tools/test/run-js-tests.mjs', 'utf8');
if (!jsRunner.includes('const vitestArgs = [') || !jsRunner.includes("'run'")) {
  fail('shared JS test runner must build discovered test files into Vitest arguments');
}
if (
  !jsRunner.includes("spawnSync('pnpm'") ||
  !jsRunner.includes("'exec', 'vitest', ...vitestArgs")
) {
  fail('shared JS test runner must execute discovered test files through Vitest');
}
if (jsRunner.includes("'tsx'")) {
  fail('shared JS test runner must not execute discovered test files through a tsx loop');
}
requireText('tools/test/run-js-tests.mjs', '--coverage.provider=v8');
requireText('tools/test/run-js-tests.mjs', 'OLIPHAUNT_VITEST_COVERAGE_INCLUDE');
requireText('tools/test/run-js-tests.mjs', 'OLIPHAUNT_VITEST_COVERAGE_EXCLUDE');
requireText('tools/coverage/coverage.py', '"OLIPHAUNT_VITEST_COVERAGE": "1"');
requireText('tools/coverage/coverage.py', 'write_summary(product, "vitest-v8"');
rejectText('tools/coverage/coverage.py', '"c8"');

for (const productDir of ['src/sdks/js', 'src/sdks/react-native']) {
  const testsDir = path.join(productDir, 'src', '__tests__');
  const testFiles = readdirSync(testsDir).filter((file) => file.endsWith('.test.ts'));
  if (testFiles.length === 0) {
    fail(`${productDir} must contain discoverable *.test.ts tests`);
  }
}

const rustCheckSdk = readFileSync('src/sdks/rust/tools/check-sdk.sh', 'utf8');
if (!rustCheckSdk.includes('tools/runtime/preflight.sh')) {
  fail('Rust SDK runtime lanes must source the shared runtime preflight helper');
}
if (!rustCheckSdk.includes('oliphaunt_runtime_native_host_ready extensions')) {
  fail('Rust SDK smoke/regression must require native host runtime plus extension artifacts');
}
if (!rustCheckSdk.includes('cargo test -p oliphaunt --doc --locked')) {
  fail('Rust SDK test-unit lane must keep doctests through cargo test --doc');
}
if (!rustCheckSdk.includes('cargo nextest run -p oliphaunt --locked --profile ci --no-tests=fail --test-threads=1')) {
  fail('Rust SDK test-unit lane must use nextest discovery for compiled tests');
}
for (const manuallyListed of ['--test sdk_config_modes', '--test sdk_shape', '--test protocol_parser_fuzz']) {
  if (rustCheckSdk.includes(manuallyListed)) {
    fail(`Rust SDK test-unit lane must not handpick ${manuallyListed}; use nextest discovery`);
  }
}

requireText('src/sdks/swift/tools/check-sdk.sh', 'tools/runtime/preflight.sh');
requireText('src/sdks/swift/tools/check-sdk.sh', 'oliphaunt_runtime_native_host_ready basic');
requireText('src/sdks/swift/tools/check-sdk.sh', 'tools/runtime/preflight.sh ios-simulator');
requireText('src/sdks/kotlin/tools/check-sdk.sh', 'tools/runtime/preflight.sh');
requireText('src/sdks/kotlin/tools/check-sdk.sh', 'run_android_runtime_smoke');
requireText('src/sdks/kotlin/tools/check-sdk.sh', 'static_tasks=');
requireText('src/sdks/kotlin/tools/check-sdk.sh', 'unit_tasks=');
requireText('src/sdks/kotlin/tools/check-sdk.sh', 'run_without_linked_native_runtime');
requireText('src/sdks/kotlin/tools/check-sdk.sh', 'if [ "$mode" = "regression" ] || [ "$mode" = "release-check" ]; then');
rejectText('src/sdks/kotlin/tools/check-sdk.sh', 'if [ "$mode" != "package-shape" ]; then');
requireText('src/sdks/kotlin/tools/check-sdk.sh', 'Kotlin Android smoke AAR must include the explicitly supplied liboliphaunt runtime');
requireText('src/sdks/js/tools/check-sdk.sh', 'tools/runtime/preflight.sh');
requireText('src/sdks/js/tools/check-sdk.sh', 'oliphaunt_runtime_native_host_require basic');

requireText('src/sdks/react-native/src/__tests__/client.test.ts', 'testJsiArrayBufferTransportIsRequiredAndUsedForBinaryCalls');
requireText('src/sdks/react-native/src/__tests__/client.test.ts', 'testJsiStreamTransportAdvertisesAndUsesNativeChunks');
requireText('src/sdks/react-native/tools/check-sdk.sh', 'base64_runtime_hits');
requireText('src/sdks/react-native/tools/check-sdk.sh', 'Codegen spec must stay lifecycle/control-only');
requireText('src/sdks/react-native/tools/check-sdk.sh', 'ios/podspecs/COliphaunt.podspec');
requireText('src/sdks/react-native/tools/check-sdk.sh', 'ios/vendor/oliphaunt-swift');
rejectText('src/sdks/react-native/package.json', 'prepare-apple-vendor');
requireText('src/sdks/react-native/src/__tests__/client.test.ts', 'react-native-jsi/binary-transport.json');
rejectText('src/sdks/react-native/src/specs/NativeOliphaunt.ts', 'base64');
rejectText('src/sdks/react-native/tools/check-sdk.sh', 'pnpm --dir "$root" install');
rejectText('src/sdks/react-native/tools/check-sdk.sh', '$root/src/sdks/react-native/node_modules');
rejectText('src/sdks/react-native/tools/check-sdk.sh', '$root/src/sdks/js/node_modules');
rejectText('src/sdks/js/tools/check-sdk.sh', '$source_package_dir/node_modules');
requireText('src/sdks/react-native/tools/check-sdk.sh', 'core-js: false');
requireText('src/sdks/js/tools/check-sdk.sh', 'core-js: false');
requireText('src/sdks/react-native/tools/check-sdk.sh', "--glob '!**/__tests__/**'");
requireText('src/sdks/js/tools/check-sdk.sh', "--glob '!**/__tests__/**'");

const sharedConsumers = new Map([
  ['src/sdks/rust/tests/protocol_query_fixtures.rs', 'query-response-cases.json'],
  ['src/sdks/swift/Tests/OliphauntTests/ProtocolFixtureTests.swift', 'query-response-cases.json'],
  ['src/sdks/kotlin/oliphaunt/src/jvmTest/kotlin/dev/oliphaunt/SharedProtocolFixtureTest.kt', 'query-response-cases.json'],
  ['src/sdks/js/src/__tests__/protocol-fixtures.test.ts', 'query-response-cases.json'],
  ['src/sdks/react-native/src/__tests__/protocol-fixtures.test.ts', 'query-response-cases.json'],
  ['src/bindings/wasix-rust/crates/oliphaunt-wasix/src/protocol/shared_fixture_tests.rs', 'query-response-cases.json'],
]);
for (const [file, marker] of sharedConsumers) {
  requireText(file, marker);
}

for (const file of [
  'src/sdks/rust/tests/sdk_config_modes.rs',
  'src/sdks/swift/Tests/OliphauntTests/OliphauntTests.swift',
  'src/sdks/kotlin/oliphaunt/src/androidUnitTest/kotlin/dev/oliphaunt/OliphauntAndroidDefaultEngineTest.kt',
  'src/sdks/js/src/__tests__/client.test.ts',
  'src/sdks/react-native/src/__tests__/client.test.ts',
]) {
  requireText(file, 'supportedModes');
}

for (const file of [
  'tools/perf/matrix/run_bench_matrix.sh',
  'src/docs/content/reference/performance.mdx',
]) {
  rejectText(file, 'node-bench');
  rejectText(file, 'bench-oxide');
  rejectText(file, 'nodefs');
}

console.log('peer SDK test strategy checks passed');
