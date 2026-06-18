#!/usr/bin/env node
import fs from 'node:fs';
import { runMoon } from './moon.mjs';

const releasePleaseConfig = JSON.parse(fs.readFileSync('release-please-config.json', 'utf8'));
const releasePackages = releasePleaseConfig.packages ?? {};
const releaseProductIds = Object.values(releasePackages).map((config) => config.component).filter(Boolean);
const releasePackagePathByProduct = new Map(
  Object.entries(releasePackages).map(([packagePath, config]) => [config.component, packagePath]),
);
const generatedSdkExtensions = JSON.parse(fs.readFileSync('src/extensions/generated/sdk/rust.json', 'utf8')).extensions ?? [];
const exactExtensionProducts = generatedSdkExtensions
  .map((extension) => `oliphaunt-extension-${extension['sql-name'].replaceAll('_', '-').toLowerCase()}`)
  .sort();
const contribExtensionProducts = exactExtensionProducts.filter((product) =>
  releasePackagePathByProduct.get(product)?.startsWith('src/extensions/contrib/'),
);
const externalExtensionProducts = exactExtensionProducts.filter((product) =>
  releasePackagePathByProduct.get(product)?.startsWith('src/extensions/external/'),
);

function parseProjects() {
  const output = runMoon(['query', 'projects']);
  const parsed = JSON.parse(output);
  if (!Array.isArray(parsed.projects)) {
    throw new Error('moon query projects did not return a projects array');
  }
  return parsed.projects;
}

function parseTasks() {
  const output = runMoon(['query', 'tasks']);
  const parsed = JSON.parse(output);
  if (!parsed.tasks || typeof parsed.tasks !== 'object') {
    throw new Error('moon query tasks did not return a tasks object');
  }
  return parsed.tasks;
}

function assertEqualSet(label, actual, expected) {
  const actualSorted = [...actual].sort();
  const expectedSorted = [...expected].sort();
  if (
    actualSorted.length !== expectedSorted.length ||
    actualSorted.some((value, index) => value !== expectedSorted[index])
  ) {
    throw new Error(
      `${label}: expected [${expectedSorted.join(', ')}], got [${actualSorted.join(', ')}]`,
    );
  }
}

function downstreamClosure(projectId, dependentsByProject) {
  const seen = new Set([projectId]);
  const queue = [projectId];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const dependent of dependentsByProject.get(current) ?? []) {
      if (!seen.has(dependent)) {
        seen.add(dependent);
        queue.push(dependent);
      }
    }
  }
  return seen;
}

function ownerProjectForPath(projects, path) {
  const matches = projects
    .filter(
      (project) =>
        project.source === '.' ||
        path === project.source ||
        path.startsWith(`${project.source}/`),
    )
    .sort((left, right) => right.source.length - left.source.length);
  return matches[0]?.id ?? null;
}

function assertTaskCommand(tasks, projectId, taskId, expectedCommand) {
  const task = tasks[projectId]?.[taskId];
  if (!task) {
    throw new Error(`missing moon task ${projectId}:${taskId}`);
  }
  const actual = [task.command, ...(task.args ?? [])].join(' ');
  if (expectedCommand.includes('.sh') && !expectedCommand.startsWith('bash ')) {
    expectedCommand = `bash ${expectedCommand}`;
  }
  if (actual !== expectedCommand) {
    throw new Error(`${projectId}:${taskId}: expected command '${expectedCommand}', got '${actual}'`);
  }
}

function assertShellTasksUseBash(tasks) {
  for (const [projectId, projectTasks] of Object.entries(tasks)) {
    for (const [taskId, task] of Object.entries(projectTasks ?? {})) {
      const command = [task.command, ...(task.args ?? [])].join(' ');
      if (command.includes('.sh') && !command.startsWith('bash ')) {
        throw new Error(`${projectId}:${taskId}: shell script commands must start with 'bash', got '${command}'`);
      }
    }
  }
}

function assertTaskInput(tasks, projectId, taskId, expectedInput) {
  const task = tasks[projectId]?.[taskId];
  if (!task) {
    throw new Error(`missing moon task ${projectId}:${taskId}`);
  }
  const inputs = taskInputs(task);
  if (!inputs.includes(expectedInput)) {
    throw new Error(
      `${projectId}:${taskId}: expected input '${expectedInput}', got [${inputs.sort().join(', ')}]`,
    );
  }
}

function assertTaskEnv(tasks, projectId, taskId, expectedName, expectedValue) {
  const task = tasks[projectId]?.[taskId];
  if (!task) {
    throw new Error(`missing moon task ${projectId}:${taskId}`);
  }
  if ((task.env ?? {})[expectedName] !== expectedValue) {
    throw new Error(
      `${projectId}:${taskId}: expected env ${expectedName}='${expectedValue}', got '${(task.env ?? {})[expectedName]}'`,
    );
  }
}

function assertTaskCargoTargetDir(tasks, projectId, taskId) {
  assertTaskEnv(tasks, projectId, taskId, 'CARGO_TARGET_DIR', `target/moon/${projectId}/${taskId}`);
}

function assertTaskCache(tasks, projectId, taskId, expected) {
  const task = tasks[projectId]?.[taskId];
  if (!task) {
    throw new Error(`missing moon task ${projectId}:${taskId}`);
  }
  if (task.options?.cache !== expected) {
    throw new Error(
      `${projectId}:${taskId}: expected cache=${JSON.stringify(expected)}, got ${JSON.stringify(task.options?.cache)}`,
    );
  }
}

function assertTaskRunsInCI(tasks, projectId, taskId) {
  const task = tasks[projectId]?.[taskId];
  if (!task) {
    throw new Error(`missing moon task ${projectId}:${taskId}`);
  }
  if (task.options?.runInCI === false) {
    throw new Error(`${projectId}:${taskId}: task is invoked by CI and must not set runInCI=false`);
  }
}

function assertTaskRunsOutsideCI(tasks, projectId, taskId) {
  const task = tasks[projectId]?.[taskId];
  if (!task) {
    throw new Error(`missing moon task ${projectId}:${taskId}`);
  }
  if (task.options?.runInCI !== false) {
    throw new Error(`${projectId}:${taskId}: task is not invoked by normal CI and must set runInCI=false`);
  }
}

function assertTaskSkippedByBroadCI(tasks, projectId, taskId) {
  const task = tasks[projectId]?.[taskId];
  if (!task) {
    throw new Error(`missing moon task ${projectId}:${taskId}`);
  }
  if (task.options?.runInCI !== 'skip') {
    throw new Error(`${projectId}:${taskId}: expected runInCI=skip so broad Moon CI does not start it`);
  }
}

function assertTaskDependency(tasks, projectId, taskId, expectedTarget) {
  const task = tasks[projectId]?.[taskId];
  if (!task) {
    throw new Error(`missing moon task ${projectId}:${taskId}`);
  }
  const deps = (task.deps ?? []).map((dep) => dep.target ?? dep);
  if (!deps.includes(expectedTarget)) {
    throw new Error(
      `${projectId}:${taskId}: expected dependency '${expectedTarget}', got [${deps.sort().join(', ')}]`,
    );
  }
}

function assertTaskDependencyCacheStrategy(tasks, projectId, taskId, expectedTarget, expectedStrategy) {
  const task = tasks[projectId]?.[taskId];
  if (!task) {
    throw new Error(`missing moon task ${projectId}:${taskId}`);
  }
  const dep = (task.deps ?? []).find((entry) => (entry.target ?? entry) === expectedTarget);
  if (!dep) {
    throw new Error(`${projectId}:${taskId}: expected dependency '${expectedTarget}'`);
  }
  if (dep.cacheStrategy !== expectedStrategy) {
    throw new Error(
      `${projectId}:${taskId}: dependency '${expectedTarget}' expected cacheStrategy='${expectedStrategy}', got '${dep.cacheStrategy}'`,
    );
  }
}

function assertTaskTags(tasks, projectId, taskId, expectedTags) {
  const task = tasks[projectId]?.[taskId];
  if (!task) {
    throw new Error(`missing moon task ${projectId}:${taskId}`);
  }
  const actual = new Set(task.tags ?? []);
  const missing = expectedTags.filter((tag) => !actual.has(tag));
  if (missing.length > 0) {
    throw new Error(
      `${projectId}:${taskId} tags missing [${missing.join(', ')}], got [${[...actual].sort().join(', ')}]`,
    );
  }
}

function assertCiTagTargets(tasks, expectedTargetsByTag) {
  const actualTargetsByTag = new Map();
  for (const [projectId, projectTasks] of Object.entries(tasks)) {
    for (const [taskId, task] of Object.entries(projectTasks ?? {})) {
      const target = task.target ?? `${projectId}:${taskId}`;
      for (const tag of task.tags ?? []) {
        if (typeof tag === 'string' && tag.startsWith('ci-')) {
          const targets = actualTargetsByTag.get(tag) ?? new Set();
          targets.add(target);
          actualTargetsByTag.set(tag, targets);
        }
      }
    }
  }
  for (const [tag, expectedTargets] of expectedTargetsByTag.entries()) {
    assertEqualSet(`Moon CI tag ${tag}`, actualTargetsByTag.get(tag) ?? new Set(), new Set(expectedTargets));
  }
  assertEqualSet(
    'Moon CI tag set',
    new Set(actualTargetsByTag.keys()),
    new Set(expectedTargetsByTag.keys()),
  );
}

function assertNoDefaultInputs(tasks, projectId, taskId) {
  const task = tasks[projectId]?.[taskId];
  if (!task) {
    throw new Error(`missing moon task ${projectId}:${taskId}`);
  }
  if (task.state?.defaultInputs) {
    throw new Error(`${projectId}:${taskId}: must declare explicit inputs; default **/* inputs are not allowed`);
  }
}

function rejectTaskInput(tasks, projectId, taskId, rejectedInput, reason = 'is not allowed') {
  const task = tasks[projectId]?.[taskId];
  if (!task) {
    throw new Error(`missing moon task ${projectId}:${taskId}`);
  }
  const inputs = taskInputs(task);
  if (inputs.includes(rejectedInput)) {
    throw new Error(`${projectId}:${taskId}: input '${rejectedInput}' ${reason}`);
  }
}

function taskInputs(task) {
  return [
    ...Object.keys(task.inputFiles ?? {}),
    ...Object.keys(task.inputGlobs ?? {}),
    ...(task.inputs ?? []).map((input) => input.file ?? input.glob).filter(Boolean),
  ];
}

function assertArtifactTasksDoNotDependOnCiImplementation(tasks) {
  for (const [projectId, projectTasks] of Object.entries(tasks)) {
    for (const [taskId, task] of Object.entries(projectTasks ?? {})) {
      if (!(task.tags ?? []).includes('artifact')) {
        continue;
      }
      const ciInputs = taskInputs(task).filter((input) => input.startsWith('/.github/'));
      if (ciInputs.length > 0) {
        throw new Error(
          `${projectId}:${taskId}: artifact tasks must model product source/toolchain inputs, not CI implementation inputs [${ciInputs.sort().join(', ')}]`,
        );
      }
    }
  }
}

function assertTaskOutput(tasks, projectId, taskId, expectedOutput) {
  const task = tasks[projectId]?.[taskId];
  if (!task) {
    throw new Error(`missing moon task ${projectId}:${taskId}`);
  }
  const outputs = [
    ...Object.keys(task.outputFiles ?? {}),
    ...Object.keys(task.outputGlobs ?? {}),
    ...(task.outputs ?? []).map((output) => output.file ?? output.glob ?? output).filter(Boolean),
  ];
  if (!outputs.includes(expectedOutput)) {
    throw new Error(
      `${projectId}:${taskId}: expected output '${expectedOutput}', got [${outputs.sort().join(', ')}]`,
    );
  }
}

const projects = parseProjects();
const tasks = parseTasks();
assertShellTasksUseBash(tasks);
assertArtifactTasksDoNotDependOnCiImplementation(tasks);
const requiredProjects = new Set([
  'repo',
  'ci-workflows',
  'docs',
  'benchmarks',
  'integration-examples',
  'postgres18',
  'source-inputs',
  'source-toolchains',
  'third-party-shared',
  'third-party-native',
  'third-party-wasix',
  'extension-runtime-contract',
  'extension-model',
  'extension-artifacts-native',
  'extension-artifacts-wasix',
  'extension-packages',
  'extension-contrib-postgres18',
  'extension-age',
  'extensions',
  'shared-contracts',
  'shared-fixtures',
  'shared-js-core',
  ...releaseProductIds,
  'dev-tools',
  'coverage-tools',
  'perf-tools',
  'policy-tools',
  'release-tools',
  'test-tools',
  'xtask',
]);
assertEqualSet(
  'moon projects',
  new Set(projects.map((project) => project.id).filter((id) => requiredProjects.has(id))),
  requiredProjects,
);

const byId = new Map(projects.map((project) => [project.id, project]));
const dependentsByProject = new Map();
for (const project of projects) {
  for (const dependency of project.dependencies ?? []) {
    if (!dependentsByProject.has(dependency.id)) {
      dependentsByProject.set(dependency.id, new Set());
    }
    dependentsByProject.get(dependency.id).add(project.id);
  }
}

const expectedDirectDependencies = new Map([
  [
    'repo',
    [
      'oliphaunt-kotlin',
      'oliphaunt-react-native',
      'oliphaunt-rust',
      'oliphaunt-swift',
      'oliphaunt-js',
      'oliphaunt-wasix-rust',
    ],
  ],
  ['ci-workflows', []],
  ['benchmarks', []],
  [
    'docs',
    [
      'extensions',
      'liboliphaunt-native',
      'liboliphaunt-wasix',
      'oliphaunt-kotlin',
      'oliphaunt-react-native',
      'oliphaunt-rust',
      'oliphaunt-swift',
      'oliphaunt-js',
      'oliphaunt-wasix-rust',
      'postgres18',
      'source-toolchains',
      'third-party-shared',
      'third-party-native',
      'third-party-wasix',
    ],
  ],
  ['integration-examples', []],
  ['postgres18', []],
  ['source-inputs', []],
  ['source-toolchains', []],
  ['third-party-shared', []],
  ['third-party-native', []],
  ['third-party-wasix', []],
  [
    'extensions',
    [
      'extension-age',
      'extension-contrib-postgres18',
      'extension-runtime-contract',
      ...exactExtensionProducts,
      'postgres18',
    ],
  ],
  ['extension-runtime-contract', []],
  ['extension-contrib-postgres18', ['extension-runtime-contract', 'postgres18']],
  ['extension-age', ['extension-runtime-contract']],
  ...contribExtensionProducts.map((product) => [
    product,
    ['extension-contrib-postgres18', 'extension-runtime-contract'],
  ]),
  ...externalExtensionProducts.map((product) => [product, ['extension-runtime-contract']]),
  ['extension-model', ['extensions']],
  ['extension-artifacts-native', ['extension-model', 'extensions', 'liboliphaunt-native', 'source-inputs']],
  ['extension-artifacts-wasix', ['extension-model', 'extensions', 'liboliphaunt-wasix', 'source-inputs']],
  ['extension-packages', ['extension-artifacts-native', 'extension-artifacts-wasix', 'extensions']],
  ['shared-contracts', []],
  ['shared-fixtures', ['shared-contracts']],
  ['shared-js-core', []],
  [
    'liboliphaunt-native',
    [
      'extension-runtime-contract',
      'postgres18',
      'source-inputs',
      'third-party-native',
      'third-party-shared',
    ],
  ],
  [
    'liboliphaunt-wasix',
    [
      'extension-model',
      'extension-runtime-contract',
      'postgres18',
      'shared-fixtures',
      'source-inputs',
      'source-toolchains',
      'third-party-shared',
      'third-party-wasix',
    ],
  ],
  ['oliphaunt-rust', ['extension-artifacts-native', 'liboliphaunt-native', 'shared-contracts', 'shared-fixtures']],
  ['oliphaunt-swift', ['liboliphaunt-native', 'shared-contracts', 'shared-fixtures']],
  ['oliphaunt-kotlin', ['liboliphaunt-native', 'shared-contracts', 'shared-fixtures']],
  [
    'oliphaunt-react-native',
    [
      'oliphaunt-kotlin',
      'oliphaunt-swift',
      'shared-contracts',
      'shared-fixtures',
      'shared-js-core',
    ],
  ],
  [
    'oliphaunt-js',
    [
      'liboliphaunt-native',
      'oliphaunt-broker',
      'oliphaunt-node-direct',
      'oliphaunt-rust',
      'shared-contracts',
      'shared-fixtures',
      'shared-js-core',
    ],
  ],
  ['oliphaunt-wasix-rust', ['liboliphaunt-wasix', 'shared-fixtures']],
  ['oliphaunt-broker', ['liboliphaunt-native', 'oliphaunt-rust']],
  ['oliphaunt-node-direct', ['liboliphaunt-native']],
  ['dev-tools', []],
  ['coverage-tools', []],
  ['perf-tools', ['benchmarks']],
  ['policy-tools', []],
  ['test-tools', []],
  [
    'release-tools',
    [
      'liboliphaunt-native',
      'liboliphaunt-wasix',
      'extensions',
      'postgres18',
      'source-toolchains',
      'third-party-shared',
      'third-party-native',
      'third-party-wasix',
      'oliphaunt-kotlin',
      'oliphaunt-react-native',
      'oliphaunt-js',
      'oliphaunt-broker',
      'oliphaunt-node-direct',
      'oliphaunt-rust',
      'oliphaunt-swift',
      'oliphaunt-wasix-rust',
    ],
  ],
  ['xtask', []],
]);
for (const [projectId, expected] of expectedDirectDependencies) {
  const project = byId.get(projectId);
  if (!project) {
    throw new Error(`missing moon project ${projectId}`);
  }
  assertEqualSet(
    `${projectId} dependencies`,
    new Set((project.dependencies ?? []).map((dependency) => dependency.id)),
    new Set(expected),
  );
}

const expectedRepoTasks = new Set([
  'check',
  'structure',
  'tooling',
  'ci-policy',
  'docs-policy',
  'release-policy',
  'release-metadata',
  'moon-graph',
  'prek',
  'test-policy',
  'smoke',
  'regression',
  'package',
  'coverage',
  'coverage-policy',
  'release-check',
  'bench',
  'bench-run',
]);
assertEqualSet('repo tasks', new Set(Object.keys(byId.get('repo')?.tasks ?? {})), expectedRepoTasks);

const expectedSourceInputTasks = new Set(['check']);
for (const projectId of [
  'postgres18',
  'source-toolchains',
  'extension-runtime-contract',
  'extension-contrib-postgres18',
  'extension-age',
  'extensions',
  'shared-js-core',
]) {
  const project = byId.get(projectId);
  assertEqualSet(`${projectId} tasks`, new Set(Object.keys(project.tasks ?? {})), expectedSourceInputTasks);
}
for (const projectId of exactExtensionProducts) {
  const project = byId.get(projectId);
  assertEqualSet(`${projectId} tasks`, new Set(Object.keys(project.tasks ?? {})), new Set(['check', 'assemble-release']));
}
assertEqualSet(
  'source-inputs tasks',
  new Set(Object.keys(byId.get('source-inputs')?.tasks ?? {})),
  new Set(['source-fetch', 'source-fetch-native-runtime', 'source-fetch-wasix-runtime', 'source-fetch-extensions']),
);
assertEqualSet(
  'third-party-shared tasks',
  new Set(Object.keys(byId.get('third-party-shared')?.tasks ?? {})),
  expectedSourceInputTasks,
);
for (const projectId of ['third-party-native', 'third-party-wasix']) {
  const project = byId.get(projectId);
  assertEqualSet(`${projectId} tasks`, new Set(Object.keys(project.tasks ?? {})), expectedSourceInputTasks);
}
assertEqualSet(
  'liboliphaunt tasks',
  new Set(Object.keys(byId.get('liboliphaunt-native')?.tasks ?? {})),
  new Set([
    'check',
    'host-smoke',
    'smoke',
    'build-ios-xcframework',
    'release-check',
    'bench',
    'release-runtime',
    'release-runtime-desktop',
    'release-runtime-mobile-target',
    'release-assets',
  ]),
);
assertEqualSet(
  'liboliphaunt-wasix tasks',
  new Set(Object.keys(byId.get('liboliphaunt-wasix')?.tasks ?? {})),
  new Set(['check', 'release-check', 'runtime-portable', 'runtime-aot', 'release-assets', 'smoke', 'regression']),
);
assertEqualSet(
  'extension-model tasks',
  new Set(Object.keys(byId.get('extension-model')?.tasks ?? {})),
  new Set(['check']),
);
assertEqualSet(
  'extension-artifacts-native tasks',
  new Set(Object.keys(byId.get('extension-artifacts-native')?.tasks ?? {})),
  new Set(['check', 'release-check', 'build-target']),
);
assertEqualSet(
  'extension-artifacts-wasix tasks',
  new Set(Object.keys(byId.get('extension-artifacts-wasix')?.tasks ?? {})),
  new Set(['check', 'build-target']),
);
assertEqualSet(
  'extension-packages tasks',
  new Set(Object.keys(byId.get('extension-packages')?.tasks ?? {})),
  new Set(['assemble-release', 'assemble-mobile']),
);

const expectedSdkTasks = new Set([
  'check',
  'test',
  'smoke',
  'package',
  'package-artifacts',
  'release-check',
  'bench',
  'regression',
  'coverage',
  'bench-run',
]);
for (const projectId of [
  'oliphaunt-swift',
  'oliphaunt-kotlin',
  'oliphaunt-js',
]) {
  const project = byId.get(projectId);
  assertEqualSet(`${projectId} tasks`, new Set(Object.keys(project.tasks ?? {})), expectedSdkTasks);
}
assertEqualSet(
  'oliphaunt-rust tasks',
  new Set(Object.keys(byId.get('oliphaunt-rust')?.tasks ?? {})),
  new Set([...expectedSdkTasks, 'extension-regression']),
);
assertEqualSet(
  'oliphaunt-wasix-rust tasks',
  new Set(Object.keys(byId.get('oliphaunt-wasix-rust')?.tasks ?? {})),
  new Set(['check', 'test', 'package', 'package-artifacts', 'release-check', 'example-check', 'bench', 'coverage', 'bench-run']),
);
assertEqualSet(
  'oliphaunt-react-native tasks',
  new Set(Object.keys(byId.get('oliphaunt-react-native')?.tasks ?? {})),
  new Set([
    ...expectedSdkTasks,
    'build-android-bridge',
    'build-ios-bridge',
    'smoke-android',
    'smoke-ios',
    'smoke-mobile',
    'e2e',
    'mobile-build-android',
    'mobile-e2e-android',
    'mobile-drill-android',
    'mobile-build-ios',
    'mobile-e2e-ios',
    'mobile-drill-ios',
  ]),
);
assertEqualSet(
  'docs tasks',
  new Set(Object.keys(byId.get('docs')?.tasks ?? {})),
  new Set(['dev', 'check', 'build', 'smoke', 'release-check']),
);
assertEqualSet(
  'oliphaunt-broker tasks',
  new Set(Object.keys(byId.get('oliphaunt-broker')?.tasks ?? {})),
  new Set(['check', 'test', 'package', 'release-check', 'release-assets']),
);
assertEqualSet(
  'oliphaunt-node-direct tasks',
  new Set(Object.keys(byId.get('oliphaunt-node-direct')?.tasks ?? {})),
  new Set(['check', 'package', 'release-check', 'release-assets']),
);

assertTaskCommand(tasks, 'repo', 'check', 'true');
for (const dependency of [
  'repo:structure',
  'repo:tooling',
  'repo:ci-policy',
  'repo:docs-policy',
  'repo:release-policy',
  'repo:release-metadata',
  'repo:moon-graph',
  'repo:test-policy',
  'repo:regression',
  'repo:prek',
]) {
  assertTaskDependency(tasks, 'repo', 'check', dependency);
}
assertTaskCommand(tasks, 'repo', 'coverage', 'tools/coverage/summarize');
assertTaskCommand(tasks, 'repo', 'coverage-policy', 'tools/policy/check-coverage.sh all');
assertTaskCommand(tasks, 'policy-tools', 'check', 'tools/policy/check-policy-tools.sh');
assertTaskCommand(tasks, 'shared-js-core', 'check', 'node src/shared/js-core/tools/check-js-core.mjs');
assertTaskInput(tasks, 'shared-js-core', 'check', '/src/shared/js-core/**/*');
assertTaskInput(tasks, 'shared-js-core', 'check', '/src/sdks/js/src/protocol.ts');
assertTaskInput(tasks, 'shared-js-core', 'check', '/src/sdks/js/src/query.ts');
assertTaskInput(tasks, 'shared-js-core', 'check', '/src/sdks/react-native/src/protocol.ts');
assertTaskInput(tasks, 'shared-js-core', 'check', '/src/sdks/react-native/src/query.ts');
assertTaskCache(tasks, 'shared-js-core', 'check', true);
assertTaskCommand(tasks, 'docs', 'check', 'pnpm --dir src/docs run check');
for (const [projectId, taskId] of [
  ['oliphaunt-rust', 'regression'],
  ['oliphaunt-js', 'regression'],
  ['liboliphaunt-wasix', 'regression'],
]) {
  assertTaskRunsInCI(tasks, projectId, taskId);
}
assertTaskCommand(tasks, 'docs', 'build', 'pnpm --dir src/docs run build');
assertTaskCommand(tasks, 'docs', 'smoke', 'pnpm --dir src/docs run smoke');
assertTaskCommand(tasks, 'docs', 'release-check', 'pnpm --dir src/docs run release-check');
assertTaskCommand(tasks, 'oliphaunt-rust', 'check', 'src/sdks/rust/tools/check-sdk.sh check-static');
assertTaskCommand(tasks, 'oliphaunt-rust', 'test', 'src/sdks/rust/tools/check-sdk.sh test-unit');
assertTaskCommand(tasks, 'oliphaunt-rust', 'regression', 'src/sdks/rust/tools/check-sdk.sh regression');
assertTaskCommand(tasks, 'oliphaunt-rust', 'extension-regression', 'src/sdks/rust/tools/check-sdk.sh extension-regression');
assertTaskCommand(tasks, 'oliphaunt-swift', 'check', 'src/sdks/swift/tools/check-sdk.sh check-static');
assertTaskCommand(tasks, 'oliphaunt-swift', 'test', 'src/sdks/swift/tools/check-sdk.sh test-unit');
assertTaskCommand(tasks, 'oliphaunt-kotlin', 'check', 'src/sdks/kotlin/tools/check-sdk.sh check-static');
assertTaskCommand(tasks, 'oliphaunt-kotlin', 'test', 'src/sdks/kotlin/tools/check-sdk.sh test-unit');
assertTaskCommand(tasks, 'oliphaunt-rust', 'package', 'src/sdks/rust/tools/check-sdk.sh package-shape');
assertTaskCommand(tasks, 'oliphaunt-rust', 'package-artifacts', 'tools/release/build-sdk-ci-artifacts.sh oliphaunt-rust');
assertTaskCommand(tasks, 'oliphaunt-swift', 'package', 'src/sdks/swift/tools/check-sdk.sh package-shape');
assertTaskCommand(tasks, 'oliphaunt-swift', 'package-artifacts', 'tools/release/build-sdk-ci-artifacts.sh oliphaunt-swift');
assertTaskCommand(tasks, 'oliphaunt-kotlin', 'package', 'src/sdks/kotlin/tools/check-sdk.sh package-shape');
assertTaskCommand(tasks, 'oliphaunt-kotlin', 'package-artifacts', 'tools/release/build-sdk-ci-artifacts.sh oliphaunt-kotlin');
assertTaskCommand(tasks, 'oliphaunt-react-native', 'check', 'src/sdks/react-native/tools/check-sdk.sh check-static');
assertTaskCommand(tasks, 'oliphaunt-react-native', 'build-android-bridge', 'src/sdks/react-native/tools/check-sdk.sh build-android-bridge');
assertTaskCommand(tasks, 'oliphaunt-react-native', 'build-ios-bridge', 'src/sdks/react-native/tools/check-sdk.sh build-ios-bridge');
assertTaskCommand(tasks, 'oliphaunt-react-native', 'test', 'src/sdks/react-native/tools/check-sdk.sh test-unit');
assertTaskCommand(tasks, 'oliphaunt-react-native', 'package', 'src/sdks/react-native/tools/check-sdk.sh package-shape');
assertTaskCommand(tasks, 'oliphaunt-react-native', 'package-artifacts', 'tools/release/build-sdk-ci-artifacts.sh oliphaunt-react-native');
assertTaskCommand(tasks, 'oliphaunt-react-native', 'smoke-android', 'pnpm --dir src/sdks/react-native/examples/expo run smoke:android');
assertTaskCommand(tasks, 'oliphaunt-react-native', 'smoke-ios', 'pnpm --dir src/sdks/react-native/examples/expo run smoke:ios');
assertTaskCommand(tasks, 'oliphaunt-react-native', 'smoke-mobile', 'pnpm --dir src/sdks/react-native/examples/expo run smoke');
assertTaskCommand(tasks, 'oliphaunt-react-native', 'mobile-build-android', 'pnpm --dir src/sdks/react-native/examples/expo run mobile-build:android');
assertTaskCommand(tasks, 'oliphaunt-react-native', 'mobile-e2e-android', 'pnpm --dir src/sdks/react-native/examples/expo run mobile-e2e:android');
assertTaskCommand(tasks, 'oliphaunt-react-native', 'mobile-drill-android', 'pnpm --dir src/sdks/react-native/examples/expo run mobile-drill:android');
assertTaskCommand(tasks, 'oliphaunt-react-native', 'mobile-build-ios', 'pnpm --dir src/sdks/react-native/examples/expo run mobile-build:ios');
assertTaskCommand(tasks, 'oliphaunt-react-native', 'mobile-e2e-ios', 'pnpm --dir src/sdks/react-native/examples/expo run mobile-e2e:ios');
assertTaskCommand(tasks, 'oliphaunt-react-native', 'mobile-drill-ios', 'pnpm --dir src/sdks/react-native/examples/expo run mobile-drill:ios');
assertTaskCommand(tasks, 'oliphaunt-js', 'check', 'src/sdks/js/tools/check-sdk.sh check-static');
assertTaskCommand(tasks, 'oliphaunt-js', 'test', 'src/sdks/js/tools/check-sdk.sh test-unit');
assertTaskCommand(tasks, 'oliphaunt-js', 'package', 'src/sdks/js/tools/check-sdk.sh package-shape');
assertTaskCommand(tasks, 'oliphaunt-js', 'package-artifacts', 'tools/release/build-sdk-ci-artifacts.sh oliphaunt-js');
for (const projectId of [
  'oliphaunt-rust',
  'oliphaunt-swift',
  'oliphaunt-kotlin',
  'oliphaunt-react-native',
  'oliphaunt-js',
]) {
  assertTaskDependency(tasks, projectId, 'package', `${projectId}:check`);
  assertTaskDependency(tasks, projectId, 'package', `${projectId}:test`);
  assertTaskDependency(tasks, projectId, 'package-artifacts', `${projectId}:package`);
}
assertTaskCommand(tasks, 'extension-artifacts-native', 'build-target', 'src/extensions/artifacts/native/tools/package-release-assets.sh');
assertTaskDependency(tasks, 'extension-artifacts-native', 'release-check', 'source-inputs:source-fetch-native-runtime');
assertTaskDependency(tasks, 'extension-artifacts-native', 'build-target', 'source-inputs:source-fetch-native-runtime');
rejectTaskInput(tasks, 'extension-artifacts-native', 'release-check', '/src/sdks/rust/src/bin/package_resources.rs');
rejectTaskInput(tasks, 'extension-artifacts-native', 'release-check', '/src/sdks/rust/src/bin/extension_artifact.rs');
rejectTaskInput(tasks, 'extension-artifacts-native', 'release-check', '/src/sdks/rust/src/runtime_resources/**/*');
assertTaskInput(tasks, 'extension-artifacts-native', 'build-target', '/src/sources/third-party/shared/**/*');
assertTaskInput(tasks, 'extension-artifacts-native', 'build-target', '/src/sources/third-party/native/**/*');
rejectTaskInput(tasks, 'extension-artifacts-native', 'build-target', '/src/sdks/rust/src/bin/package_resources.rs');
rejectTaskInput(tasks, 'extension-artifacts-native', 'build-target', '/src/sdks/rust/src/bin/extension_artifact.rs');
rejectTaskInput(tasks, 'extension-artifacts-native', 'build-target', '/src/sdks/rust/src/runtime_resources/**/*');
assertTaskOutput(tasks, 'extension-artifacts-native', 'build-target', 'target/extensions/native/release-assets/**/*');
assertTaskCommand(tasks, 'extension-artifacts-wasix', 'build-target', 'src/extensions/artifacts/wasix/tools/package-release-assets.sh');
assertTaskDependency(tasks, 'extension-artifacts-wasix', 'build-target', 'liboliphaunt-wasix:runtime-portable');
assertTaskOutput(tasks, 'extension-artifacts-wasix', 'build-target', 'target/extensions/wasix/release-assets/**/*');
assertTaskCommand(tasks, 'extension-packages', 'assemble-release', 'python3 tools/release/build-extension-ci-artifacts.py --all --require-native --require-wasix');
assertTaskOutput(tasks, 'extension-packages', 'assemble-release', 'target/extension-artifacts/**/*');
assertTaskCommand(tasks, 'extension-packages', 'assemble-mobile', 'src/extensions/artifacts/packages/tools/package-mobile-release-assets.sh');
assertTaskOutput(tasks, 'extension-packages', 'assemble-mobile', 'target/extension-artifacts/**/*');
for (const projectId of exactExtensionProducts) {
  assertTaskCommand(tasks, projectId, 'assemble-release', `python3 tools/release/build-extension-ci-artifacts.py ${projectId} --require-native --require-wasix`);
  assertTaskOutput(tasks, projectId, 'assemble-release', `target/extension-artifacts/${projectId}/**/*`);
  assertTaskCache(tasks, projectId, 'assemble-release', false);
}
assertTaskCommand(tasks, 'oliphaunt-wasix-rust', 'test', 'src/bindings/wasix-rust/tools/check-unit.sh');
assertTaskCommand(tasks, 'oliphaunt-wasix-rust', 'example-check', 'src/bindings/wasix-rust/tools/check-examples.sh');
assertTaskDependency(tasks, 'oliphaunt-broker', 'package', 'oliphaunt-broker:check');
assertTaskDependency(tasks, 'oliphaunt-broker', 'package', 'oliphaunt-broker:test');
assertTaskCommand(tasks, 'oliphaunt-broker', 'release-check', 'true');
assertTaskDependency(tasks, 'oliphaunt-broker', 'release-check', 'oliphaunt-broker:package');
assertTaskCommand(tasks, 'oliphaunt-broker', 'release-assets', 'tools/release/package-broker-assets.sh');
assertTaskDependency(tasks, 'oliphaunt-broker', 'release-assets', 'oliphaunt-broker:check');
assertTaskDependency(tasks, 'oliphaunt-broker', 'release-assets', 'oliphaunt-broker:test');
assertTaskTags(tasks, 'oliphaunt-broker', 'release-assets', ['artifact', 'release']);
assertTaskCache(tasks, 'oliphaunt-broker', 'release-assets', false);
assertTaskOutput(tasks, 'oliphaunt-broker', 'release-assets', 'target/oliphaunt-broker/release-assets/**/*');
assertTaskDependency(tasks, 'oliphaunt-node-direct', 'package', 'oliphaunt-node-direct:check');
assertTaskCommand(tasks, 'oliphaunt-node-direct', 'release-check', 'true');
assertTaskDependency(tasks, 'oliphaunt-node-direct', 'release-check', 'oliphaunt-node-direct:package');
assertTaskCommand(tasks, 'oliphaunt-node-direct', 'release-assets', 'src/runtimes/node-direct/tools/build-node-addon.sh');
assertTaskDependency(tasks, 'oliphaunt-node-direct', 'release-assets', 'oliphaunt-node-direct:package');
assertTaskTags(tasks, 'oliphaunt-node-direct', 'release-assets', ['artifact', 'release']);
assertTaskCache(tasks, 'oliphaunt-node-direct', 'release-assets', false);
assertTaskOutput(tasks, 'oliphaunt-node-direct', 'release-assets', 'target/oliphaunt-node-direct/release-assets/**/*');
assertTaskOutput(tasks, 'oliphaunt-node-direct', 'release-assets', 'target/oliphaunt-node-direct/npm-packages/**/*');
assertTaskCommand(tasks, 'liboliphaunt-wasix', 'regression', 'src/runtimes/liboliphaunt/wasix/tools/runtime-smoke.sh regression');
assertTaskCommand(tasks, 'liboliphaunt-wasix', 'runtime-portable', 'src/runtimes/liboliphaunt/wasix/tools/build-runtime-portable.sh');
assertTaskCommand(tasks, 'liboliphaunt-wasix', 'runtime-aot', 'src/runtimes/liboliphaunt/wasix/tools/build-aot-target.sh');
assertTaskCommand(tasks, 'liboliphaunt-wasix', 'release-assets', 'cargo run -p xtask -- release package-assets');
assertTaskDependency(tasks, 'liboliphaunt-wasix', 'runtime-aot', 'liboliphaunt-wasix:runtime-portable');
assertTaskDependency(tasks, 'liboliphaunt-wasix', 'release-assets', 'liboliphaunt-wasix:runtime-portable');
assertTaskDependency(tasks, 'liboliphaunt-wasix', 'release-assets', 'liboliphaunt-wasix:runtime-aot');
assertTaskTags(tasks, 'liboliphaunt-wasix', 'runtime-portable', ['artifact', 'runtime']);
assertTaskTags(tasks, 'liboliphaunt-wasix', 'runtime-aot', ['artifact', 'runtime']);
assertTaskTags(tasks, 'liboliphaunt-wasix', 'release-assets', ['artifact', 'release']);
assertTaskCache(tasks, 'liboliphaunt-wasix', 'runtime-portable', false);
assertTaskCache(tasks, 'liboliphaunt-wasix', 'runtime-aot', false);
assertTaskCache(tasks, 'liboliphaunt-wasix', 'release-assets', false);
rejectTaskInput(
  tasks,
  'liboliphaunt-wasix',
  'runtime-portable',
  '/.github/actions/setup-wasmer-llvm/**/*',
  'is CI implementation detail, not a WASIX runtime source input',
);
rejectTaskInput(
  tasks,
  'liboliphaunt-wasix',
  'runtime-portable',
  '/.github/workflows/ci.yml',
  'is CI implementation detail, not a WASIX runtime source input',
);
assertTaskInput(tasks, 'liboliphaunt-wasix', 'runtime-portable', '/src/runtimes/liboliphaunt/wasix/**/*');
assertTaskInput(tasks, 'liboliphaunt-wasix', 'runtime-portable', '/src/postgres/versions/18/**/*');
assertTaskInput(tasks, 'liboliphaunt-wasix', 'runtime-portable', '/src/sources/toolchains/**/*');
assertTaskInput(tasks, 'liboliphaunt-wasix', 'runtime-portable', '/src/sources/third-party/shared/**/*');
assertTaskInput(tasks, 'liboliphaunt-wasix', 'runtime-portable', '/src/sources/third-party/wasix/**/*');
assertTaskInput(tasks, 'liboliphaunt-wasix', 'runtime-portable', '/src/shared/extension-runtime-contract/**/*');
assertTaskInput(tasks, 'liboliphaunt-wasix', 'runtime-portable', '/tools/xtask/**/*');
rejectTaskInput(
  tasks,
  'liboliphaunt-wasix',
  'runtime-aot',
  '/.github/actions/setup-wasmer-llvm/**/*',
  'is CI implementation detail, not a WASIX AOT source input',
);
rejectTaskInput(
  tasks,
  'liboliphaunt-wasix',
  'runtime-aot',
  '/.github/workflows/ci.yml',
  'is CI implementation detail, not a WASIX AOT source input',
);
assertTaskInput(tasks, 'liboliphaunt-wasix', 'runtime-aot', '/src/runtimes/liboliphaunt/wasix/**/*');
assertTaskInput(tasks, 'liboliphaunt-wasix', 'runtime-aot', '/src/postgres/versions/18/**/*');
assertTaskInput(tasks, 'liboliphaunt-wasix', 'runtime-aot', '/src/sources/toolchains/**/*');
assertTaskInput(tasks, 'liboliphaunt-wasix', 'runtime-aot', '/src/sources/third-party/shared/**/*');
assertTaskInput(tasks, 'liboliphaunt-wasix', 'runtime-aot', '/src/sources/third-party/wasix/**/*');
assertTaskInput(tasks, 'liboliphaunt-wasix', 'runtime-aot', '/src/shared/extension-runtime-contract/**/*');
assertTaskInput(tasks, 'liboliphaunt-wasix', 'runtime-aot', '/tools/runtime/**/*');
assertTaskInput(tasks, 'liboliphaunt-wasix', 'runtime-aot', '/tools/xtask/**/*');
assertTaskInput(tasks, 'liboliphaunt-wasix', 'release-assets', '/target/oliphaunt-wasix/wasix-build/build/**/*');
assertTaskInput(tasks, 'liboliphaunt-wasix', 'release-assets', '/target/oliphaunt-wasix/assets/**/*');
assertTaskInput(tasks, 'liboliphaunt-wasix', 'release-assets', '/target/oliphaunt-wasix/aot/**/*');
assertTaskOutput(tasks, 'liboliphaunt-wasix', 'release-assets', 'target/oliphaunt-wasix/release-assets/**/*');
assertTaskDependency(tasks, 'oliphaunt-react-native', 'smoke-mobile', 'oliphaunt-swift:smoke');
assertTaskDependency(tasks, 'oliphaunt-react-native', 'smoke-mobile', 'oliphaunt-kotlin:smoke');
assertTaskCommand(tasks, 'oliphaunt-react-native', 'e2e', 'true');
assertTaskDependency(tasks, 'oliphaunt-react-native', 'e2e', 'oliphaunt-react-native:mobile-build-android');
assertTaskDependency(tasks, 'oliphaunt-react-native', 'e2e', 'oliphaunt-react-native:mobile-e2e-android');
assertTaskDependency(tasks, 'oliphaunt-react-native', 'e2e', 'oliphaunt-react-native:mobile-build-ios');
assertTaskDependency(tasks, 'oliphaunt-react-native', 'e2e', 'oliphaunt-react-native:mobile-e2e-ios');
assertTaskCache(tasks, 'oliphaunt-react-native', 'e2e', false);
assertTaskRunsOutsideCI(tasks, 'oliphaunt-react-native', 'e2e');
assertTaskDependency(tasks, 'oliphaunt-react-native', 'mobile-build-android', 'oliphaunt-kotlin:package-artifacts');
assertTaskDependency(tasks, 'oliphaunt-react-native', 'mobile-build-android', 'oliphaunt-react-native:package-artifacts');
assertTaskDependency(tasks, 'oliphaunt-react-native', 'mobile-build-ios', 'oliphaunt-swift:package-artifacts');
assertTaskDependency(tasks, 'oliphaunt-react-native', 'mobile-build-ios', 'oliphaunt-react-native:package-artifacts');
assertTaskInput(tasks, 'oliphaunt-react-native', 'mobile-build-android', '/target/sdk-artifacts/oliphaunt-kotlin/**/*');
assertTaskInput(tasks, 'oliphaunt-react-native', 'mobile-build-android', '/target/sdk-artifacts/oliphaunt-react-native/**/*');
assertTaskInput(tasks, 'oliphaunt-react-native', 'mobile-build-ios', '/target/sdk-artifacts/oliphaunt-react-native/**/*');
assertTaskInput(tasks, 'oliphaunt-react-native', 'mobile-build-ios', '/target/sdk-artifacts/oliphaunt-swift/**/*');
assertTaskRunsInCI(tasks, 'oliphaunt-react-native', 'mobile-build-android');
assertTaskRunsInCI(tasks, 'oliphaunt-react-native', 'mobile-build-ios');
assertTaskSkippedByBroadCI(tasks, 'oliphaunt-react-native', 'mobile-e2e-android');
assertTaskSkippedByBroadCI(tasks, 'oliphaunt-react-native', 'mobile-e2e-ios');
assertTaskRunsOutsideCI(tasks, 'oliphaunt-react-native', 'mobile-drill-android');
assertTaskRunsOutsideCI(tasks, 'oliphaunt-react-native', 'mobile-drill-ios');
for (const taskId of ['mobile-e2e-android', 'mobile-e2e-ios']) {
  assertTaskInput(tasks, 'oliphaunt-react-native', taskId, '/src/sdks/react-native/examples/expo/maestro/**/*');
  assertTaskInput(tasks, 'oliphaunt-react-native', taskId, '/src/sources/toolchains/maestro.toml');
  assertTaskInput(tasks, 'oliphaunt-react-native', taskId, '/tools/dev/setup-maestro.sh');
}
assertTaskInput(
  tasks,
  'oliphaunt-react-native',
  'mobile-e2e-android',
  '/src/sources/toolchains/android-emulator-runner.toml',
);
assertTaskDependency(tasks, 'liboliphaunt-native', 'host-smoke', 'liboliphaunt-native:release-runtime');
assertTaskEnv(tasks, 'liboliphaunt-native', 'host-smoke', 'OLIPHAUNT_TRACK_BUILD', 'never');
assertTaskSkippedByBroadCI(tasks, 'liboliphaunt-native', 'host-smoke');
assertTaskDependency(tasks, 'liboliphaunt-native', 'release-runtime', 'source-inputs:source-fetch-native-runtime');
assertTaskDependency(tasks, 'liboliphaunt-native', 'build-ios-xcframework', 'liboliphaunt-native:check');
assertTaskDependency(tasks, 'liboliphaunt-native', 'build-ios-xcframework', 'source-inputs:source-fetch-native-runtime');
assertTaskDependency(tasks, 'liboliphaunt-native', 'release-runtime-desktop', 'source-inputs:source-fetch-native-runtime');
assertTaskDependency(
  tasks,
  'liboliphaunt-native',
  'release-runtime-mobile-target',
  'source-inputs:source-fetch-native-runtime',
);
assertTaskDependency(tasks, 'liboliphaunt-native', 'release-check', 'liboliphaunt-native:release-runtime');
assertTaskEnv(tasks, 'liboliphaunt-native', 'release-check', 'OLIPHAUNT_TRACK_BUILD', 'never');
assertTaskDependency(tasks, 'oliphaunt-rust', 'regression', 'liboliphaunt-native:host-smoke');
assertTaskDependency(tasks, 'oliphaunt-rust', 'extension-regression', 'extension-artifacts-native:release-check');
assertTaskRunsOutsideCI(tasks, 'oliphaunt-rust', 'extension-regression');
assertTaskTags(tasks, 'liboliphaunt-native', 'host-smoke', ['runtime', 'smoke']);
assertTaskCache(tasks, 'liboliphaunt-native', 'host-smoke', false);
assertTaskTags(tasks, 'liboliphaunt-native', 'release-runtime', ['runtime', 'release']);
assertTaskTags(tasks, 'liboliphaunt-native', 'release-runtime-desktop', [
  'runtime',
  'release',
  'ci-liboliphaunt-native-desktop',
]);
assertTaskTags(tasks, 'liboliphaunt-native', 'release-runtime-mobile-target', [
  'runtime',
  'release',
  'ci-liboliphaunt-native-android',
  'ci-liboliphaunt-native-ios',
]);
assertTaskCache(tasks, 'liboliphaunt-native', 'release-runtime', false);
assertTaskCache(tasks, 'liboliphaunt-native', 'release-runtime-desktop', false);
assertTaskCache(tasks, 'liboliphaunt-native', 'release-runtime-mobile-target', false);
for (const sourceFetchTask of [
  'source-fetch',
  'source-fetch-native-runtime',
  'source-fetch-wasix-runtime',
  'source-fetch-extensions',
]) {
  assertTaskTags(tasks, 'source-inputs', sourceFetchTask, ['source', 'fetch']);
  assertTaskCache(tasks, 'source-inputs', sourceFetchTask, false);
}
for (const requiredFetchInput of [
  '/src/sources/**/*',
  '/src/extensions/external/**/source.toml',
  '/src/extensions/external/**/dependencies/**/source.toml',
  '/src/runtimes/liboliphaunt/wasix/assets/build/docker/Dockerfile',
  '/tools/policy/fetch-sources.mjs',
]) {
  assertTaskInput(tasks, 'source-inputs', 'source-fetch', requiredFetchInput);
}
for (const sourceFetchTask of [
  'source-fetch',
  'source-fetch-native-runtime',
  'source-fetch-wasix-runtime',
  'source-fetch-extensions',
]) {
  for (const rustFetchInput of ['/Cargo.lock', '/Cargo.toml', '/rust-toolchain.toml', '/tools/xtask/**/*']) {
    rejectTaskInput(tasks, 'source-inputs', sourceFetchTask, rustFetchInput);
  }
}
for (const rejectedNativeFetchInput of [
  '/src/extensions/**/*',
  '/src/sources/toolchains/**/*',
  '/src/sources/third-party/wasix/**/*',
  '/src/runtimes/liboliphaunt/wasix/assets/build/docker/Dockerfile',
]) {
  rejectTaskInput(tasks, 'source-inputs', 'source-fetch-native-runtime', rejectedNativeFetchInput);
}
assertTaskCommand(tasks, 'source-inputs', 'source-fetch', 'bun tools/policy/fetch-sources.mjs all');
assertTaskCommand(tasks, 'source-inputs', 'source-fetch-native-runtime', 'bun tools/policy/fetch-sources.mjs native-runtime');
assertTaskCommand(tasks, 'source-inputs', 'source-fetch-wasix-runtime', 'bun tools/policy/fetch-sources.mjs wasix-runtime');
assertTaskCommand(tasks, 'source-inputs', 'source-fetch-extensions', 'bun tools/policy/fetch-sources.mjs extensions');
for (const requiredNativeRuntimeSourceInput of [
  '/src/sources/third-party/shared/**/*',
  '/src/sources/third-party/native/**/*',
  '/src/extensions/external/**/source.toml',
  '/src/extensions/external/**/dependencies/**/source.toml',
]) {
  assertTaskInput(tasks, 'source-inputs', 'source-fetch-native-runtime', requiredNativeRuntimeSourceInput);
}
for (const requiredWasixRuntimeSourceInput of [
  '/src/sources/toolchains/**/*',
  '/src/sources/third-party/shared/**/*',
  '/src/sources/third-party/wasix/**/*',
  '/src/extensions/external/**/source.toml',
  '/src/extensions/external/**/dependencies/**/source.toml',
  '/src/runtimes/liboliphaunt/wasix/assets/build/docker/Dockerfile',
]) {
  assertTaskInput(tasks, 'source-inputs', 'source-fetch-wasix-runtime', requiredWasixRuntimeSourceInput);
}
assertTaskInput(tasks, 'source-inputs', 'source-fetch-extensions', '/src/extensions/external/**/source.toml');
assertTaskInput(tasks, 'source-inputs', 'source-fetch-extensions', '/src/extensions/external/**/dependencies/**/source.toml');
for (const requiredRuntimeInput of [
  '/src/postgres/versions/18/**/*',
  '/src/sources/third-party/shared/**/*',
  '/src/sources/third-party/native/**/*',
  '/src/shared/extension-runtime-contract/**/*',
  '/src/runtimes/liboliphaunt/native/**/*',
  '/tools/xtask/**/*',
  '/Cargo.lock',
  '/Cargo.toml',
  '/rust-toolchain.toml',
]) {
  assertTaskInput(tasks, 'liboliphaunt-native', 'release-runtime', requiredRuntimeInput);
}
for (const sdkProjectId of ['oliphaunt-rust', 'oliphaunt-swift', 'oliphaunt-kotlin']) {
  assertTaskDependency(tasks, sdkProjectId, 'release-check', 'liboliphaunt-native:release-runtime');
}
for (const [projectId, taskIds] of new Map([
  ['oliphaunt-rust', ['check', 'test', 'smoke', 'package', 'release-check', 'regression']],
  ['oliphaunt-swift', ['check', 'test', 'smoke', 'package', 'release-check', 'regression']],
  ['oliphaunt-kotlin', ['check', 'test', 'smoke', 'package', 'release-check', 'regression']],
  ['oliphaunt-js', ['check', 'test', 'smoke', 'package', 'release-check', 'regression']],
  ['liboliphaunt-wasix', ['smoke', 'regression']],
])) {
  for (const taskId of taskIds) {
    assertTaskInput(tasks, projectId, taskId, '/tools/runtime/**/*');
  }
}
for (const target of [
  'oliphaunt-rust:coverage',
  'oliphaunt-swift:coverage',
  'oliphaunt-kotlin:coverage',
  'oliphaunt-js:coverage',
  'oliphaunt-react-native:coverage',
  'oliphaunt-wasix-rust:coverage',
]) {
  assertTaskDependencyCacheStrategy(tasks, 'repo', 'coverage', target, 'outputs');
}
assertTaskDependencyCacheStrategy(tasks, 'docs', 'smoke', 'docs:build', 'outputs');
assertTaskDependencyCacheStrategy(tasks, 'docs', 'release-check', 'docs:build', 'outputs');
for (const [taskId, requiredInput] of [
  ['structure', 'README.md'],
  ['structure', 'package.json'],
  ['structure', 'pnpm-lock.yaml'],
  ['structure', 'src/shared/fixtures/**/*'],
  ['tooling', 'tools/**/*'],
  ['tooling', '.moon/workspace.yml'],
  ['tooling', '.moon/toolchains.yml'],
  ['docs-policy', 'docs/**/*'],
  ['release-policy', 'src/**/*'],
  ['release-policy', 'tools/release/**/*'],
  ['moon-graph', 'coverage/**/*'],
  ['prek', 'prek.toml'],
]) {
  assertTaskInput(tasks, 'repo', taskId, requiredInput);
}
assertTaskCache(tasks, 'repo', 'check', true);
assertTaskCache(tasks, 'repo', 'test-policy', true);
assertTaskCache(tasks, 'repo', 'bench', true);
assertTaskCache(tasks, 'repo', 'bench-run', false);
assertTaskTags(tasks, 'benchmarks', 'check', ['quality', 'static']);
assertTaskInput(tasks, 'benchmarks', 'check', 'benchmarks/**/*');
for (const requiredDocsInput of [
  'README.md',
  'docs/**/*',
  'src/docs/**/*',
  'src/extensions/**/*',
  '.release-please-manifest.json',
  'release-please-config.json',
  'src/**/release.toml',
]) {
  assertTaskInput(tasks, 'docs', 'check', requiredDocsInput);
}
assertTaskCache(tasks, 'docs', 'dev', false);
assertTaskCache(tasks, 'docs', 'check', true);
assertTaskCache(tasks, 'docs', 'build', 'local');
assertTaskCache(tasks, 'docs', 'smoke', 'local');
assertTaskCache(tasks, 'docs', 'release-check', 'local');
for (const [projectId, taskIds] of new Map([
  ['oliphaunt-rust', [
    'check',
    'test',
    'smoke',
    'package',
    'release-check',
    'bench',
    'regression',
    'extension-regression',
    'coverage',
    'bench-run',
  ]],
  ['oliphaunt-broker', ['check', 'test', 'package', 'release-assets']],
  ['oliphaunt-wasix-rust', [
    'check',
    'test',
    'package',
    'release-check',
    'bench',
    'coverage',
    'bench-run',
  ]],
  ['xtask', ['check', 'template-runner-check', 'release-check']],
  ['oliphaunt-js', ['smoke']],
])) {
  for (const taskId of taskIds) {
    assertTaskCargoTargetDir(tasks, projectId, taskId);
  }
}
assertTaskCommand(tasks, 'xtask', 'template-runner-check', 'cargo check -p xtask --features template-runner --locked');
assertTaskSkippedByBroadCI(tasks, 'xtask', 'template-runner-check');
assertTaskTags(tasks, 'xtask', 'template-runner-check', ['quality', 'static', 'wasix']);
assertTaskCache(tasks, 'oliphaunt-wasix-rust', 'example-check', 'local');
assertTaskInput(tasks, 'oliphaunt-wasix-rust', 'example-check', 'src/bindings/wasix-rust/examples/**/*');
assertTaskInput(tasks, 'oliphaunt-wasix-rust', 'example-check', 'src/bindings/wasix-rust/tools/check-examples.sh');
for (const project of projects) {
  for (const taskId of Object.keys(project.tasks ?? {})) {
    assertNoDefaultInputs(tasks, project.id, taskId);
    if ((tasks[project.id]?.[taskId]?.tags ?? []).length === 0) {
      throw new Error(`${project.id}:${taskId}: task must declare first-class Moon tags`);
    }
  }
}
for (const project of projects) {
  if (tasks[project.id]?.check) {
    assertTaskTags(tasks, project.id, 'check', ['quality', 'static']);
  }
  if (tasks[project.id]?.test) {
    assertTaskTags(tasks, project.id, 'test', ['quality', 'unit']);
  }
}
for (const projectId of [
  'oliphaunt-rust',
  'oliphaunt-swift',
  'oliphaunt-kotlin',
  'oliphaunt-react-native',
  'oliphaunt-js',
  'oliphaunt-wasix-rust',
]) {
  for (const taskId of ['check', 'test', 'coverage', 'bench']) {
    assertTaskCache(tasks, projectId, taskId, true);
  }
  assertTaskTags(tasks, projectId, 'coverage', ['coverage', 'quality']);
  assertTaskTags(tasks, projectId, 'bench-run', ['bench', 'measured']);
  assertTaskInput(tasks, projectId, 'bench', 'benchmarks/**/*');
  assertTaskInput(tasks, projectId, 'bench-run', 'benchmarks/**/*');
  assertTaskCommand(tasks, projectId, 'coverage', `tools/coverage/run-product ${projectId}`);
  assertTaskInput(tasks, projectId, 'coverage', 'coverage/baseline.toml');
  assertTaskInput(tasks, projectId, 'coverage', 'tools/coverage/**/*');
  assertTaskOutput(tasks, projectId, 'coverage', `target/coverage/${projectId}/**/*`);
  assertTaskOutput(tasks, projectId, 'package-artifacts', `target/sdk-artifacts/${projectId}/**/*`);
  assertTaskCache(tasks, projectId, 'bench-run', false);
}
assertTaskCommand(tasks, 'oliphaunt-wasix-rust', 'package', 'src/bindings/wasix-rust/tools/check-package.sh');
assertTaskCommand(tasks, 'oliphaunt-wasix-rust', 'package-artifacts', 'tools/release/build-sdk-ci-artifacts.sh oliphaunt-wasix-rust');
assertTaskDependency(tasks, 'oliphaunt-wasix-rust', 'package', 'oliphaunt-wasix-rust:check');
assertTaskDependency(tasks, 'oliphaunt-wasix-rust', 'package', 'oliphaunt-wasix-rust:test');
assertTaskDependency(tasks, 'oliphaunt-wasix-rust', 'package-artifacts', 'oliphaunt-wasix-rust:package');
assertTaskOutput(tasks, 'oliphaunt-wasix-rust', 'package-artifacts', 'target/sdk-artifacts/oliphaunt-wasix-rust/**/*');
for (const projectId of [
  'oliphaunt-rust',
  'oliphaunt-swift',
  'oliphaunt-kotlin',
  'oliphaunt-react-native',
  'oliphaunt-js',
  'liboliphaunt-wasix',
]) {
  assertTaskCache(tasks, projectId, 'smoke', 'local');
}
for (const projectId of ['oliphaunt-rust', 'oliphaunt-react-native', 'oliphaunt-js', 'oliphaunt-wasix-rust']) {
  assertTaskCache(tasks, projectId, 'package', true);
  assertTaskCache(tasks, projectId, 'package-artifacts', true);
}
for (const projectId of ['oliphaunt-swift', 'oliphaunt-kotlin']) {
  assertTaskCache(tasks, projectId, 'package', 'local');
  assertTaskCache(tasks, projectId, 'package-artifacts', 'local');
}
assertTaskInput(tasks, 'oliphaunt-js', 'smoke', 'src/shared/fixtures/**/*');
assertTaskInput(tasks, 'oliphaunt-js', 'smoke', 'src/sdks/js/**/*');
for (const projectId of ['oliphaunt-js', 'oliphaunt-react-native']) {
  assertTaskInput(tasks, projectId, 'test', 'tools/test/**/*');
  assertTaskInput(tasks, projectId, 'coverage', 'tools/test/**/*');
}
assertCiTagTargets(tasks, new Map([
  ['ci-broker-runtime', ['oliphaunt-broker:release-assets']],
  ['ci-extension-artifacts-native', ['extension-artifacts-native:build-target']],
  ['ci-extension-artifacts-wasix', ['extension-artifacts-wasix:build-target']],
  ['ci-extension-packages', ['extension-packages:assemble-release']],
  ['ci-mobile-extension-packages', ['extension-packages:assemble-mobile']],
  ['ci-js-sdk-package', ['oliphaunt-js:package-artifacts']],
  ['ci-kotlin-sdk-package', ['oliphaunt-kotlin:package-artifacts']],
  ['ci-liboliphaunt-native-android', ['liboliphaunt-native:release-runtime-mobile-target']],
  ['ci-liboliphaunt-native-desktop', ['liboliphaunt-native:release-runtime-desktop']],
  ['ci-liboliphaunt-native-ios', ['liboliphaunt-native:release-runtime-mobile-target']],
  ['ci-liboliphaunt-native-release-assets', ['liboliphaunt-native:release-assets']],
  ['ci-liboliphaunt-wasix-aot', ['liboliphaunt-wasix:runtime-aot']],
  ['ci-liboliphaunt-wasix-release-assets', ['liboliphaunt-wasix:release-assets']],
  ['ci-liboliphaunt-wasix-runtime', ['liboliphaunt-wasix:runtime-portable']],
  ['ci-mobile-build-android', ['oliphaunt-react-native:mobile-build-android']],
  ['ci-mobile-build-ios', ['oliphaunt-react-native:mobile-build-ios']],
  ['ci-node-direct', ['oliphaunt-node-direct:release-assets']],
  ['ci-react-native-sdk-package', ['oliphaunt-react-native:package-artifacts']],
  ['ci-rust-sdk-package', ['oliphaunt-rust:package-artifacts']],
  ['ci-swift-sdk-package', ['oliphaunt-swift:package-artifacts']],
  ['ci-wasix-rust-package', ['oliphaunt-wasix-rust:package-artifacts']],
  ['ci-wasm-regression', ['oliphaunt-wasix-rust:example-check']],
]));

console.log('moon product graph checks passed');
