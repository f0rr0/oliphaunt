#!/usr/bin/env bun
import {existsSync, readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import process from 'node:process';

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    ...options,
  });
}

function runBun(args, options = {}) {
  // A shell script is not a Windows executable and Bun/libuv reports EFTYPE
  // when one is passed directly to spawnSync. Reuse this already-pinned Bun
  // process for nested policy checks on every host. Nested test runners do not
  // pass through tools/dev/bun.sh, so apply the same bounded default here.
  const boundedArgs = args[0] === 'test'
    && !args.slice(1).some((arg) => arg === '--timeout' || arg.startsWith('--timeout='))
    ? ['test', '--timeout=30000', ...args.slice(1)]
    : args;
  return run(process.execPath, boundedArgs, options);
}

function workspaceRoot() {
  const result = run('git', ['rev-parse', '--show-toplevel']);
  const root = result.status === 0 && typeof result.stdout === 'string' ? result.stdout.trim() : '';
  if (root) {
    return root;
  }
  const cwd = process.cwd();
  if (cwd) {
    return cwd;
  }
  throw new Error('could not determine workspace root');
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function requireFile(path) {
  if (!existsSync(path)) {
    fail(`missing required file: ${path}`);
  }
}

function requireText(path, text) {
  requireFile(path);
  const contents = readFileSync(path, 'utf8');
  if (!contents.includes(text)) {
    fail(`${path} must contain ${text}`);
  }
}

function rejectText(path, text) {
  requireFile(path);
  const contents = readFileSync(path, 'utf8');
  if (contents.includes(text)) {
    fail(`${path} must not contain ${text}`);
  }
}

function gitGrep(args) {
  const result = run('git', ['grep', '-I', '-n', ...args, '--', ':!target/**', ':!node_modules/**']);
  if (result.status === 1) {
    return [];
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
  return result.stdout.trim().split(/\r?\n/u).filter(Boolean);
}

function grepLinePath(line) {
  const separator = line.indexOf(':');
  return separator === -1 ? line : line.slice(0, separator);
}

function unexpectedGrepLines(lines, allowedPaths) {
  const allowed = new Set(allowedPaths);
  return lines.filter((line) => !allowed.has(grepLinePath(line)));
}

function checkPostgres18() {
  requireText('src/postgres/versions/18/source.toml', 'version = "18.4"');
  requireText('src/postgres/versions/18/source.toml', 'postgresql-18.4.tar.bz2');
  requireText('src/postgres/versions/18/source.toml', 'sha256 = "');
  requireText('src/postgres/versions/18/fetch-source.sh', '--retry-all-errors');
  requireText('src/postgres/versions/18/fetch-source.sh', '--proto-redir');
  requireText('src/postgres/versions/18/fetch-source.sh', 'trap \'rm -f "$oliphaunt_partial"\' 0');
  for (const path of [
    'src/runtimes/liboliphaunt/native/bin/build-postgres18-macos.sh',
    'src/runtimes/liboliphaunt/native/bin/build-postgres18-linux.sh',
    'src/runtimes/liboliphaunt/native/bin/build-postgres18-android-arm64.sh',
    'src/runtimes/liboliphaunt/native/bin/build-postgres18-ios-simulator.sh',
    'src/runtimes/liboliphaunt/native/bin/build-postgres18-ios-device.sh',
    'src/runtimes/liboliphaunt/native/bin/check-postgres18-ios-simulator.sh',
    'src/runtimes/liboliphaunt/wasix/assets/build/prepare_postgres_source.sh',
  ]) {
    requireText(path, 'fetch-source.sh');
    requireText(path, 'oliphaunt_fetch_postgresql_source_archive');
  }
  const transportTest = run('bash', ['src/postgres/versions/18/fetch-source.test.sh'], {stdio: 'inherit'});
  if (transportTest.error !== undefined) {
    fail(transportTest.error.message);
  }
  if (transportTest.status !== 0) {
    process.exit(transportTest.status ?? 1);
  }
}

function checkThirdParty() {
  checkSourceAcquisitionSpine();
  checkThirdPartyShared();
  checkThirdPartyNative();
  checkThirdPartyWasix();
}

function checkSourceAcquisitionSpine() {
  for (const path of [
    'tools/policy/fetch-sources.mjs',
    'tools/policy/source-fetch-core.mjs',
    'tools/policy/source-fetch-core.test.mjs',
    'tools/policy/source-archive.py',
    'tools/policy/verify-source-tree.py',
  ]) {
    requireFile(path);
  }
  requireText('tools/policy/fetch-sources.mjs', "from './source-fetch-core.mjs'");
  requireText('tools/policy/fetch-sources.mjs', "arg === '--verify-only'");
  for (const token of [
    "'--max-time'",
    "'--speed-limit'",
    "'--max-filesize'",
    "'--proto-redir'",
    "'=https'",
    'promotePathTransactional',
    'archiveTreeDigest',
    'source-archive-v2',
    'GIT_CONFIG_NOSYSTEM',
    'protocol.https.allow=always',
    "['rev-parse', '--verify', 'FETCH_HEAD^{commit}']",
  ]) {
    requireText('tools/policy/source-fetch-core.mjs', token);
  }
  requireText('tools/xtask/src/source_spine.rs', 'run_hardened_source_fetch(source_scope)');
  requireText('tools/xtask/src/source_spine.rs', 'tools/policy/fetch-sources.mjs');
  const rustSourceSpine = readFileSync('tools/xtask/src/source_spine.rs', 'utf8');
  for (const forbidden of ['Command::new("curl")', 'Command::new("tar")', '"fetch", "--no-tags"']) {
    if (rustSourceSpine.includes(forbidden)) {
      fail(`tools/xtask/src/source_spine.rs must delegate acquisition instead of using ${forbidden}`);
    }
  }

  const faultTests = runBun(['test', 'tools/policy/source-fetch-core.test.mjs'], {
    stdio: 'inherit',
  });
  if (faultTests.error !== undefined) {
    fail(faultTests.error.message);
  }
  if (faultTests.status !== 0) {
    process.exit(faultTests.status ?? 1);
  }
}

function checkThirdPartyShared() {
  for (const path of [
    'src/sources/third-party/shared/icu.toml',
    'src/sources/third-party/shared/openssl.toml',
  ]) {
    requireText(path, 'name = "');
    requireText(path, 'commit = "');
  }
}

function checkThirdPartyNative() {
  requireFile('src/sources/third-party/native/README.md');
}

function checkThirdPartyWasix() {
  requireFile('src/sources/third-party/wasix/README.md');
}

function checkToolchains() {
  requireText('rust-toolchain.toml', 'channel = "1.93.1"');
  requireText('.github/actions/setup-rust-tools/action.yml', 'default: "1.93.1"');
  const parseQuotedManifest = (manifestPath) => {
    requireFile(manifestPath);
    const sections = new Map();
    let section = '';
    for (const [index, rawLine] of readFileSync(manifestPath, 'utf8').split(/\r?\n/u).entries()) {
      const line = rawLine.trim();
      if (line === '' || line.startsWith('#')) continue;
      const heading = line.match(/^\[([A-Za-z0-9_.-]+)\]$/u);
      if (heading !== null) {
        section = heading[1];
        if (sections.has(section)) fail(`${manifestPath} repeats section [${section}]`);
        sections.set(section, new Map());
        continue;
      }
      const assignment = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*"([^"\r\n]+)"$/u);
      if (section === '' || assignment === null) {
        fail(`${manifestPath}:${index + 1} must be a quoted assignment inside a named section`);
      }
      const values = sections.get(section);
      if (values.has(assignment[1])) fail(`${manifestPath} repeats ${section}.${assignment[1]}`);
      values.set(assignment[1], assignment[2]);
    }
    return sections;
  };
  const manifestValue = (manifestPath, sections, section, key) => {
    const value = sections.get(section)?.get(key);
    if (value === undefined) fail(`${manifestPath} must contain exactly one quoted ${section}.${key}`);
    return value;
  };
  const sameValues = (left, right) =>
    left.length === right.length
    && [...left].sort().every((value, index) => value === [...right].sort()[index]);
  const requireExactManifestShape = (manifestPath, sections, expected) => {
    if (!sameValues([...sections.keys()], Object.keys(expected))) {
      fail(`${manifestPath} sections must be exactly ${Object.keys(expected).join(', ')}`);
    }
    for (const [section, keys] of Object.entries(expected)) {
      if (!sameValues([...sections.get(section).keys()], keys)) {
        fail(`${manifestPath} [${section}] keys must be exactly ${keys.join(', ')}`);
      }
    }
  };
  const runFaultTest = (path) => {
    const result = run('bash', [path], {stdio: 'inherit'});
    if (result.error !== undefined) fail(result.error.message);
    if (result.status !== 0) process.exit(result.status ?? 1);
  };

  const curlPlatformPolicyPath = 'tools/dev/curl-platform-flags.sh';
  requireText(curlPlatformPolicyPath, 'RUNNER_OS');
  requireText(curlPlatformPolicyPath, 'MINGW* | MSYS* | CYGWIN*');
  requireText(curlPlatformPolicyPath, "printf '%s\\n' '--ssl-revoke-best-effort'");
  rejectText(curlPlatformPolicyPath, '--insecure');
  for (const downloader of [
    'tools/dev/install-pinned-js-runtime.sh',
    'src/runtimes/node-direct/tools/install-node-fallback.sh',
    '.github/actions/setup-wasmer-llvm/install.sh',
    '.github/actions/setup-moon/install-pinned-node.sh',
    '.github/actions/setup-moon/install-pinned-toolchain.sh',
    '.github/actions/setup-node-pnpm/install-pinned-pnpm.sh',
    '.github/actions/setup-npm-publisher/install.sh',
  ]) {
    requireText(downloader, 'curl-platform-flags.sh');
    requireText(downloader, 'oliphaunt_curl_platform_tls_flag');
    rejectText(downloader, '--insecure');
  }
  requireText('tools/policy/source-fetch-core.mjs', 'curlPlatformTlsArgs');
  requireText('tools/policy/source-fetch-core.mjs', "['--ssl-revoke-best-effort']");
  rejectText('tools/policy/source-fetch-core.mjs', '--insecure');
  requireText('src/runtimes/liboliphaunt/native/bin/build-postgres18-windows.ps1', '--ssl-revoke-best-effort');
  rejectText('src/runtimes/liboliphaunt/native/bin/build-postgres18-windows.ps1', '--insecure');

  const wasixAptInstallerTestPath = 'src/runtimes/liboliphaunt/wasix/assets/build/docker/install-pinned-apt-packages.test.sh';
  const wasixInstallerTestPath = 'src/runtimes/liboliphaunt/wasix/assets/build/docker/install-pinned-wasixcc.test.sh';
  const wasixContract = runBun(
    ['tools/policy/fetch-sources.mjs', 'wasix-runtime', '--validate-only'],
    {stdio: 'inherit'},
  );
  if (wasixContract.error !== undefined) {
    fail(wasixContract.error.message);
  }
  if (wasixContract.status !== 0) {
    process.exit(wasixContract.status ?? 1);
  }
  for (const installerTestPath of [wasixAptInstallerTestPath, wasixInstallerTestPath]) {
    runFaultTest(installerTestPath);
  }
  const maestroManifestPath = 'src/sources/toolchains/maestro.toml';
  requireText(maestroManifestPath, '[toolchain]');
  requireText(maestroManifestPath, 'cloud_required = false');
  const maestroManifest = readFileSync(maestroManifestPath, 'utf8');
  const maestroValue = (key) => {
    const assignment = new RegExp(`^[\\t ]*${key}[\\t ]*=`, 'gmu');
    const quoted = new RegExp(`^[\\t ]*${key}[\\t ]*=[\\t ]*"([^"]+)"[\\t ]*$`, 'gmu');
    const assignments = [...maestroManifest.matchAll(assignment)];
    const values = [...maestroManifest.matchAll(quoted)];
    if (assignments.length !== 1 || values.length !== 1) {
      fail(`${maestroManifestPath} must contain exactly one quoted ${key} value`);
    }
    return values[0][1];
  };
  const maestroVersion = maestroValue('maestro');
  const normalizedMaestroVersion = maestroVersion.replace(/^cli-/u, '');
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:[.-][0-9A-Za-z]+)*$/u.test(normalizedMaestroVersion)) {
    fail(`${maestroManifestPath} has an invalid Maestro version: ${maestroVersion}`);
  }
  const expectedMaestroUrl = `https://github.com/mobile-dev-inc/Maestro/releases/download/cli-${normalizedMaestroVersion}/maestro.zip`;
  if (maestroValue('install_url') !== expectedMaestroUrl) {
    fail(`${maestroManifestPath} install_url must be ${expectedMaestroUrl}`);
  }
  if (!/^[0-9A-Fa-f]{64}$/u.test(maestroValue('sha256'))) {
    fail(`${maestroManifestPath} sha256 must contain exactly 64 hexadecimal characters`);
  }
  requireText('tools/dev/setup-maestro.sh', '--retry-all-errors');
  requireText('tools/dev/setup-maestro.sh', '--proto-redir');
  requireText('tools/dev/setup-maestro.sh', 'sha256sum');
  const maestroInstallerTest = run('bash', ['tools/dev/setup-maestro.test.sh'], {stdio: 'inherit'});
  if (maestroInstallerTest.error !== undefined) {
    fail(maestroInstallerTest.error.message);
  }
  if (maestroInstallerTest.status !== 0) {
    process.exit(maestroInstallerTest.status ?? 1);
  }
  const nodeManifestPath = 'src/sources/toolchains/node.toml';
  requireText(nodeManifestPath, '[toolchain]');
  const nodeManifest = readFileSync(nodeManifestPath, 'utf8');
  const nodeLines = nodeManifest.split(/\r?\n/u);
  const nodeValue = (section, key) => {
    let activeSection = '';
    const values = [];
    for (const line of nodeLines) {
      const heading = line.match(/^\s*\[([^\]]+)\]\s*$/u);
      if (heading !== null) {
        activeSection = heading[1];
        continue;
      }
      if (activeSection !== section) {
        continue;
      }
      const assignment = line.match(/^\s*([A-Za-z0-9_.-]+)\s*=\s*"([^"]+)"\s*$/u);
      if (assignment !== null && assignment[1] === key) {
        values.push(assignment[2]);
      }
    }
    if (values.length !== 1) {
      fail(`${nodeManifestPath} must contain exactly one quoted ${section}.${key} value`);
    }
    return values[0];
  };
  const nodeVersion = nodeValue('toolchain', 'version');
  if (!/^[0-9]+\.[0-9]+\.[0-9]+$/u.test(nodeVersion)) {
    fail(`${nodeManifestPath} has an invalid Node version: ${nodeVersion}`);
  }
  const expectedHeadersUrl = `https://nodejs.org/download/release/v${nodeVersion}/node-v${nodeVersion}-headers.tar.gz`;
  const expectedWindowsLibUrl = `https://nodejs.org/download/release/v${nodeVersion}/win-x64/node.lib`;
  if (nodeValue('headers', 'url') !== expectedHeadersUrl) {
    fail(`${nodeManifestPath} headers.url must be ${expectedHeadersUrl}`);
  }
  if (nodeValue('windows.x64', 'url') !== expectedWindowsLibUrl) {
    fail(`${nodeManifestPath} windows.x64.url must be ${expectedWindowsLibUrl}`);
  }
  for (const section of ['headers', 'windows.x64']) {
    if (!/^[0-9a-f]{64}$/u.test(nodeValue(section, 'sha256'))) {
      fail(`${nodeManifestPath} ${section}.sha256 must contain exactly 64 lowercase hexadecimal characters`);
    }
  }
  requireText('.prototools', `node = "${nodeVersion}"`);
  for (const workflow of [
    '.github/workflows/ci.yml',
    '.github/workflows/mobile-e2e.yml',
    '.github/workflows/release.yml',
  ]) {
    requireText(workflow, `NODE_VERSION: ${nodeVersion}`);
  }
  requireText('src/runtimes/node-direct/tools/build-node-addon.sh', 'install-node-fallback.sh headers');
  requireText('src/runtimes/node-direct/tools/build-node-addon.sh', 'install-node-fallback.sh windows-lib');
  requireText('src/runtimes/node-direct/tools/install-node-fallback.sh', '--proto-redir');
  requireText('src/runtimes/node-direct/tools/install-node-fallback.sh', '--retry-all-errors');
  const nodeFallbackTest = run('bash', ['src/runtimes/node-direct/tools/install-node-fallback.test.sh'], {stdio: 'inherit'});
  if (nodeFallbackTest.error !== undefined) {
    fail(nodeFallbackTest.error.message);
  }
  if (nodeFallbackTest.status !== 0) {
    process.exit(nodeFallbackTest.status ?? 1);
  }

  const verifiedBootstrapInputs = [
    '.github/actions/setup-node-runtime/action.yml',
    '.github/actions/setup-moon/action.yml',
    '.github/actions/setup-moon/install-pinned-node.sh',
    '.github/actions/setup-moon/install-pinned-node.test.sh',
    '.github/actions/setup-moon/install-pinned-toolchain.sh',
    '.github/actions/setup-moon/install-pinned-toolchain.test.sh',
    '.github/actions/setup-moon/toolchain-archive.py',
    '.github/actions/setup-node-pnpm/action.yml',
    '.github/actions/setup-node-pnpm/install-pinned-pnpm.sh',
    '.github/actions/setup-node-pnpm/install-pinned-pnpm.test.sh',
    '.github/actions/setup-npm-publisher/action.yml',
    '.github/actions/setup-npm-publisher/install.sh',
    '.github/actions/setup-npm-publisher/install.test.sh',
    '.github/scripts/setup-native-build-tools.sh',
    'src/sources/toolchains/moon-cli.toml',
    'src/sources/toolchains/moon-plugins.toml',
    'src/sources/toolchains/node-runtime.toml',
    'src/sources/toolchains/npm-publisher.toml',
    'src/sources/toolchains/pnpm.toml',
    'src/sources/toolchains/proto.toml',
    'src/sources/toolchains/winflexbison.toml',
    'tools/dev/install-pinned-winflexbison.sh',
    'tools/dev/install-pinned-winflexbison.test.sh',
  ];
  for (const path of verifiedBootstrapInputs) requireFile(path);
  for (const action of [
    '.github/actions/setup-node-runtime/action.yml',
    '.github/actions/setup-moon/action.yml',
    '.github/actions/setup-node-pnpm/action.yml',
    '.github/actions/setup-npm-publisher/action.yml',
  ]) {
    rejectText(action, 'actions/setup-node@');
    rejectText(action, 'moonrepo/setup-toolchain@');
    rejectText(action, 'corepack');
    requireText(action, 'actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9');
  }
  requireText(
    '.github/actions/setup-npm-publisher/action.yml',
    '"$node_executable" tools/release/npm-trusted-publishing.mjs check-runtime',
  );
  rejectText(
    '.github/actions/setup-npm-publisher/action.yml',
    'tools/dev/bun.sh tools/release/npm-trusted-publishing.mjs',
  );
  for (const action of [
    '.github/actions/setup-bun/action.yml',
    '.github/actions/setup-deno/action.yml',
    '.github/actions/setup-node-runtime/action.yml',
    '.github/actions/setup-moon/action.yml',
    '.github/actions/setup-node-pnpm/action.yml',
    '.github/actions/setup-npm-publisher/action.yml',
  ]) {
    requireText(action, 'cygpath -w');
  }
  requireText('.github/actions/setup-moon/action.yml', 'MOON_TOOLCHAIN_FORCE_GLOBALS=true');
  requireText('.github/actions/setup-moon/action.yml', 'moon_home_fs="$(cygpath -u "$moon_home")"');
  requireText('.github/actions/setup-moon/action.yml', 'moon_home_env="$(cygpath -w "$moon_home_fs")"');
  requireText('.github/actions/setup-moon/action.yml', 'MOON_HOME=$moon_home_env');
  requireText('.github/actions/setup-moon/action.yml', 'export_dir_fs="$(cygpath -u "$export_dir")"');
  requireText('.github/actions/setup-moon/action.yml', 'github_path_entry="$(cygpath -w "$export_dir_fs")"');
  requireText('.github/actions/setup-moon/install-pinned-toolchain.sh', 'application/vnd.oci.image.manifest.v1+json');
  requireText('.github/actions/setup-moon/install-pinned-toolchain.sh', 'docker-content-digest:');
  requireText('.github/actions/setup-moon/install-pinned-toolchain.sh', 'schemaVersion');
  rejectText('.github/actions/setup-moon/install-pinned-toolchain.sh', 'proto install');
  rejectText('.github/actions/setup-moon/install-pinned-toolchain.sh', '/master/');
  requireText('.github/actions/setup-node-pnpm/install-pinned-pnpm.sh', 'package.sha512');
  requireText('.github/actions/setup-npm-publisher/install.sh', 'package.sha512');
  requireText('.github/actions/setup-moon/toolchain-archive.py', 'unsupported extended metadata');

  const runtimeManifestPath = 'src/sources/toolchains/node-runtime.toml';
  const runtimeSections = parseQuotedManifest(runtimeManifestPath);
  const runtimeTargets = {
    'aarch64-apple-darwin': ['node-v22.22.3-darwin-arm64.tar.gz', 'tar.gz', 'node-v22.22.3-darwin-arm64/bin/node'],
    'x86_64-apple-darwin': ['node-v22.22.3-darwin-x64.tar.gz', 'tar.gz', 'node-v22.22.3-darwin-x64/bin/node'],
    'aarch64-unknown-linux-gnu': ['node-v22.22.3-linux-arm64.tar.xz', 'tar.xz', 'node-v22.22.3-linux-arm64/bin/node'],
    'x86_64-unknown-linux-gnu': ['node-v22.22.3-linux-x64.tar.xz', 'tar.xz', 'node-v22.22.3-linux-x64/bin/node'],
    'x86_64-pc-windows-msvc': ['node-v22.22.3-win-x64.zip', 'zip', 'node-v22.22.3-win-x64/node.exe'],
  };
  requireExactManifestShape(runtimeManifestPath, runtimeSections, {
    toolchain: ['version'],
    ...Object.fromEntries(Object.keys(runtimeTargets).map((target) => [
      `assets.${target}`,
      ['url', 'sha256', 'bytes', 'format', 'binary_path', 'binary_sha256', 'binary_bytes'],
    ])),
  });
  if (manifestValue(runtimeManifestPath, runtimeSections, 'toolchain', 'version') !== nodeVersion) {
    fail(`${runtimeManifestPath} version must match the repository Node pin`);
  }
  for (const [target, [name, archiveFormat, binaryPath]] of Object.entries(runtimeTargets)) {
    const section = `assets.${target}`;
    const expectedUrl = `https://nodejs.org/download/release/v${nodeVersion}/${name}`;
    if (manifestValue(runtimeManifestPath, runtimeSections, section, 'url') !== expectedUrl
      || manifestValue(runtimeManifestPath, runtimeSections, section, 'format') !== archiveFormat
      || manifestValue(runtimeManifestPath, runtimeSections, section, 'binary_path') !== binaryPath) {
      fail(`${runtimeManifestPath} ${section} must describe the canonical Node release asset`);
    }
    for (const key of ['sha256', 'binary_sha256']) {
      if (!/^[0-9a-f]{64}$/u.test(manifestValue(runtimeManifestPath, runtimeSections, section, key))) {
        fail(`${runtimeManifestPath} ${section}.${key} must be an exact SHA-256`);
      }
    }
    for (const key of ['bytes', 'binary_bytes']) {
      if (!/^[1-9][0-9]*$/u.test(manifestValue(runtimeManifestPath, runtimeSections, section, key))) {
        fail(`${runtimeManifestPath} ${section}.${key} must be a positive byte count`);
      }
    }
  }

  requireText('src/sources/toolchains/npm-publisher.toml', 'version = "11.18.0"');
  requireText('src/sources/toolchains/npm-publisher.toml', 'https://registry.npmjs.org/npm/-/npm-11.18.0.tgz');
  requireText('src/sources/toolchains/npm-publisher.toml', 'tree_sha256 = "');
  requireText('src/sources/toolchains/pnpm.toml', 'https://registry.npmjs.org/pnpm/-/pnpm-11.5.0.tgz');
  requireText('src/sources/toolchains/pnpm.toml', 'sha512 = "');
  requireText('src/sources/toolchains/moon-plugins.toml', 'manifest_sha256 = "');
  requireText('src/sources/toolchains/moon-plugins.toml', 'blob_sha256 = "');
  requireText('.moon/toolchains.yml', '@sha256:');

  const winflexManifestPath = 'src/sources/toolchains/winflexbison.toml';
  const winflexSections = parseQuotedManifest(winflexManifestPath);
  requireExactManifestShape(winflexManifestPath, winflexSections, {
    toolchain: ['version', 'repository'],
    'assets.windows-x64': [
      'url',
      'sha256',
      'bytes',
      'entry_count',
      'file_count',
      'expanded_bytes',
      'tree_sha256',
      'flex_path',
      'flex_sha256',
      'bison_path',
      'bison_sha256',
    ],
  });
  const winflexVersion = manifestValue(
    winflexManifestPath,
    winflexSections,
    'toolchain',
    'version',
  );
  const winflexRepository = manifestValue(
    winflexManifestPath,
    winflexSections,
    'toolchain',
    'repository',
  );
  if (!/^[0-9]+[.][0-9]+[.][0-9]+$/u.test(winflexVersion)) {
    fail(`${winflexManifestPath} has invalid version ${winflexVersion}`);
  }
  if (winflexRepository !== 'lexxmark/winflexbison') {
    fail(`${winflexManifestPath} must pin the official lexxmark/winflexbison repository`);
  }
  const winflexSection = 'assets.windows-x64';
  const winflexUrl = `https://github.com/${winflexRepository}/releases/download/v${winflexVersion}/win_flex_bison-${winflexVersion}.zip`;
  if (manifestValue(winflexManifestPath, winflexSections, winflexSection, 'url') !== winflexUrl) {
    fail(`${winflexManifestPath} must use the canonical version-bound release asset URL`);
  }
  for (const key of ['sha256', 'tree_sha256', 'flex_sha256', 'bison_sha256']) {
    if (!/^[0-9a-f]{64}$/u.test(
      manifestValue(winflexManifestPath, winflexSections, winflexSection, key),
    )) {
      fail(`${winflexManifestPath} ${winflexSection}.${key} must be an exact SHA-256`);
    }
  }
  for (const key of ['bytes', 'entry_count', 'file_count', 'expanded_bytes']) {
    if (!/^[1-9][0-9]*$/u.test(
      manifestValue(winflexManifestPath, winflexSections, winflexSection, key),
    )) {
      fail(`${winflexManifestPath} ${winflexSection}.${key} must be positive`);
    }
  }
  if (
    manifestValue(winflexManifestPath, winflexSections, winflexSection, 'flex_path') !==
      'win_flex.exe' ||
    manifestValue(winflexManifestPath, winflexSections, winflexSection, 'bison_path') !==
      'win_bison.exe'
  ) {
    fail(`${winflexManifestPath} must name the exact upstream Windows executables`);
  }
  for (const text of [
    "--proto '=https'",
    "--proto-redir '=https'",
    '--retry-all-errors',
    '--max-filesize',
    '--remove-on-error',
    'archive checksum mismatch',
    'tree_sha256',
    'cache_valid',
  ]) requireText('tools/dev/install-pinned-winflexbison.sh', text);
  requireText(
    '.github/scripts/setup-native-build-tools.sh',
    'tools/dev/install-pinned-winflexbison.sh',
  );
  rejectText('.github/scripts/setup-native-build-tools.sh', 'winflexbison3');

  for (const faultTest of [
    '.github/actions/setup-moon/install-pinned-node.test.sh',
    '.github/actions/setup-moon/install-pinned-toolchain.test.sh',
    '.github/actions/setup-node-pnpm/install-pinned-pnpm.test.sh',
    '.github/actions/setup-npm-publisher/install.test.sh',
  ]) runFaultTest(faultTest);
  const maintainerManifestPath = 'src/sources/toolchains/maintainer-tools.toml';
  const maintainerManifest = readFileSync(maintainerManifestPath, 'utf8');
  const maintainerLines = maintainerManifest.split(/\r?\n/u);
  const maintainerValue = (section, key) => {
    let activeSection = '';
    const values = [];
    for (const line of maintainerLines) {
      const heading = line.match(/^\s*\[([^\]]+)\]\s*$/u);
      if (heading !== null) {
        activeSection = heading[1];
        continue;
      }
      if (activeSection !== section) continue;
      const assignment = line.match(/^\s*([A-Za-z0-9_.-]+)\s*=\s*"([^"]+)"\s*$/u);
      if (assignment !== null && assignment[1] === key) values.push(assignment[2]);
    }
    if (values.length !== 1) {
      fail(`${maintainerManifestPath} must contain exactly one quoted ${section}.${key} value`);
    }
    return values[0];
  };
  const expectedMaintainerAssets = {
    'cargo-binstall.assets.aarch64-apple-darwin': {
      url: 'https://github.com/cargo-bins/cargo-binstall/releases/download/v1.19.1/cargo-binstall-aarch64-apple-darwin.zip',
      sha256: 'bf9da6a27e432784f361cfbc70a6d04e548abc548470ae9a7587c3cffb8fb0a7',
      binary_sha256: '5ef3a5d5287bb89c6158ea11b87ae51463d2c3a001d8f0c3d558fc46a8a396ce',
      format: 'zip',
      binary_path: 'cargo-binstall',
      entry_count: '1',
      max_archive_bytes: '16777216',
      max_binary_bytes: '33554432',
    },
    'cargo-binstall.assets.x86_64-apple-darwin': {
      url: 'https://github.com/cargo-bins/cargo-binstall/releases/download/v1.19.1/cargo-binstall-x86_64-apple-darwin.zip',
      sha256: '39257851fe4fd8cc9dd81fb318f15d589b7178b74165879eddeda8062bd9fcf2',
      binary_sha256: '7af1e1ce18848e9d7b8a4306836964b3f65717f32b090e384f20fec8e808d6eb',
      format: 'zip',
      binary_path: 'cargo-binstall',
      entry_count: '1',
      max_archive_bytes: '16777216',
      max_binary_bytes: '33554432',
    },
    'cargo-binstall.assets.aarch64-unknown-linux-musl': {
      url: 'https://github.com/cargo-bins/cargo-binstall/releases/download/v1.19.1/cargo-binstall-aarch64-unknown-linux-musl.tgz',
      sha256: '2001eee8da26705ad9627e57a25c23eb4639647521205f3e4a7b4e09d067d199',
      binary_sha256: 'c257882fc98d2af05d063c8335f0c95cd17c0617d2ca705d9e3c235b65b54ed0',
      format: 'tgz',
      binary_path: 'cargo-binstall',
      entry_count: '1',
      max_archive_bytes: '16777216',
      max_binary_bytes: '33554432',
    },
    'cargo-binstall.assets.x86_64-unknown-linux-musl': {
      url: 'https://github.com/cargo-bins/cargo-binstall/releases/download/v1.19.1/cargo-binstall-x86_64-unknown-linux-musl.tgz',
      sha256: '4a50fcf01418862e2fa8e4076cb6cb80ff4061b0c0b1464e71a63ce01ee29bde',
      binary_sha256: 'e231f8fefaa40c70ae5d0236babb9a36d10c2c9e62de65a1d87e2fd56ceb55c7',
      format: 'tgz',
      binary_path: 'cargo-binstall',
      entry_count: '1',
      max_archive_bytes: '16777216',
      max_binary_bytes: '33554432',
    },
    'actionlint.assets.darwin-amd64': {
      url: 'https://github.com/rhysd/actionlint/releases/download/v1.7.12/actionlint_1.7.12_darwin_amd64.tar.gz',
      sha256: '5b44c3bc2255115c9b69e30efc0fecdf498fdb63c5d58e17084fd5f16324c644',
      binary_sha256: 'd1f7cee75ae2873609bd9567b4600bebc5315a5e733e73202987a44fafdd53b2',
      format: 'tgz',
      binary_path: 'actionlint',
      entry_count: '11',
      max_archive_bytes: '8388608',
      max_binary_bytes: '16777216',
    },
    'actionlint.assets.darwin-arm64': {
      url: 'https://github.com/rhysd/actionlint/releases/download/v1.7.12/actionlint_1.7.12_darwin_arm64.tar.gz',
      sha256: 'aba9ced2dee8d27fecca3dc7feb1a7f9a52caefa1eb46f3271ea66b6e0e6953f',
      binary_sha256: '8db11704dc296f096216db4db65d86cd7f0ebfdf4c38453a1da276b137b88388',
      format: 'tgz',
      binary_path: 'actionlint',
      entry_count: '11',
      max_archive_bytes: '8388608',
      max_binary_bytes: '16777216',
    },
    'actionlint.assets.linux-amd64': {
      url: 'https://github.com/rhysd/actionlint/releases/download/v1.7.12/actionlint_1.7.12_linux_amd64.tar.gz',
      sha256: '8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8',
      binary_sha256: 'c872d6db8c6bf83a8eaa704fc93999f027d55dffbc63b8a6abdccb47df5f4cd4',
      format: 'tgz',
      binary_path: 'actionlint',
      entry_count: '11',
      max_archive_bytes: '8388608',
      max_binary_bytes: '16777216',
    },
    'actionlint.assets.linux-arm64': {
      url: 'https://github.com/rhysd/actionlint/releases/download/v1.7.12/actionlint_1.7.12_linux_arm64.tar.gz',
      sha256: '325e971b6ba9bfa504672e29be93c24981eeb1c07576d730e9f7c8805afff0c6',
      binary_sha256: 'ac0323433c2853ec3fb978c611430c5b3dc5d43c58d1a1ec031b00ab572beb60',
      format: 'tgz',
      binary_path: 'actionlint',
      entry_count: '11',
      max_archive_bytes: '8388608',
      max_binary_bytes: '16777216',
    },
  };
  const actualMaintainerSections = maintainerLines
    .map((line) => line.match(/^\s*\[([^\]]+)\]\s*$/u)?.[1])
    .filter((section) => section !== undefined)
    .sort();
  const expectedMaintainerSections = [
    'cargo-binstall',
    'actionlint',
    ...Object.keys(expectedMaintainerAssets),
  ].sort();
  if (JSON.stringify(actualMaintainerSections) !== JSON.stringify(expectedMaintainerSections)) {
    fail(`${maintainerManifestPath} must describe exactly the supported cargo-binstall and actionlint host assets`);
  }
  if (maintainerValue('cargo-binstall', 'version') !== '1.19.1') {
    fail(`${maintainerManifestPath} cargo-binstall.version must be 1.19.1`);
  }
  if (maintainerValue('cargo-binstall', 'repository') !== 'cargo-bins/cargo-binstall') {
    fail(`${maintainerManifestPath} cargo-binstall.repository must identify the upstream release repository`);
  }
  if (maintainerValue('cargo-binstall', 'license') !== 'MIT') {
    fail(`${maintainerManifestPath} cargo-binstall.license must be MIT`);
  }
  if (maintainerValue('cargo-binstall', 'source_fallback') !== 'cargo install cargo-binstall --version 1.19.1 --locked') {
    fail(`${maintainerManifestPath} must declare the exact locked cargo-binstall fallback`);
  }
  if (maintainerValue('actionlint', 'version') !== '1.7.12') {
    fail(`${maintainerManifestPath} actionlint.version must be 1.7.12`);
  }
  if (maintainerValue('actionlint', 'repository') !== 'rhysd/actionlint') {
    fail(`${maintainerManifestPath} actionlint.repository must identify the upstream release repository`);
  }
  if (maintainerValue('actionlint', 'license') !== 'MIT') {
    fail(`${maintainerManifestPath} actionlint.license must be MIT`);
  }
  if (!maintainerValue('actionlint', 'source_fallback').startsWith('none;')) {
    fail(`${maintainerManifestPath} must prohibit an unpinned actionlint source fallback`);
  }
  for (const [section, values] of Object.entries(expectedMaintainerAssets)) {
    for (const [key, expected] of Object.entries(values)) {
      const actual = maintainerValue(section, key);
      if (actual !== expected) fail(`${maintainerManifestPath} ${section}.${key} must be ${expected}`);
    }
  }
  for (const text of [
    '--max-filesize',
    "--proto '=https'",
    "--proto-redir '=https'",
    '--tlsv1.2',
    '--remove-on-error',
    'archive checksum mismatch',
    'binary checksum mismatch',
    'unexpected member layout',
    'source=release-asset',
    'binary_sha256=',
  ]) requireText('tools/dev/install-pinned-maintainer-tool.sh', text);
  requireText('tools/dev/bootstrap-tools.sh', '--locked');
  requireText('tools/dev/bootstrap-tools.sh', '--promote-locked-cargo-source');
  requireText('tools/dev/install-actionlint.sh', 'install-pinned-maintainer-tool.sh');
  if (readFileSync('tools/dev/install-actionlint.sh', 'utf8').includes('go install')) {
    fail('tools/dev/install-actionlint.sh must not bypass the pinned archive with an unpinned Go toolchain');
  }
  const maintainerInstallerTest = run(
    process.execPath,
    ['test', 'tools/release/maintainer-tool-install.test.mjs'],
    {stdio: 'inherit'},
  );
  if (maintainerInstallerTest.error !== undefined) fail(maintainerInstallerTest.error.message);
  if (maintainerInstallerTest.status !== 0) process.exit(maintainerInstallerTest.status ?? 1);

  const runtimeManifests = [
    {
      path: 'src/sources/toolchains/bun.toml',
      tool: 'bun',
      versionPrefix: 'bun-v',
      primaryRoot: 'https://github.com/oven-sh/bun/releases/download/',
      targets: ['darwin-aarch64', 'darwin-x64', 'linux-aarch64', 'linux-x64', 'windows-x64'],
      entryCount: '2',
      mirror: false,
    },
    {
      path: 'src/sources/toolchains/deno.toml',
      tool: 'deno',
      versionPrefix: 'v',
      primaryRoot: 'https://github.com/denoland/deno/releases/download/',
      targets: [
        'aarch64-apple-darwin',
        'x86_64-apple-darwin',
        'aarch64-unknown-linux-gnu',
        'x86_64-unknown-linux-gnu',
        'x86_64-pc-windows-msvc',
      ],
      entryCount: '1',
      mirror: true,
    },
  ];
  for (const runtime of runtimeManifests) {
    const sections = parseQuotedManifest(runtime.path);
    requireExactManifestShape(runtime.path, sections, {
      toolchain: ['version'],
      ...Object.fromEntries(runtime.targets.map((target) => [
        `assets.${target}`,
        runtime.mirror
          ? ['url', 'mirror_url', 'sha256', 'binary_path', 'binary_sha256', 'entry_count']
          : ['url', 'sha256', 'binary_path', 'binary_sha256', 'entry_count'],
      ])),
    });
    const version = manifestValue(runtime.path, sections, 'toolchain', 'version');
    if (!/^[0-9]+\.[0-9]+\.[0-9]+$/u.test(version)) fail(`${runtime.path} has invalid version ${version}`);
    requireText('.prototools', `${runtime.tool} = "${version}"`);
    for (const target of runtime.targets) {
      const section = `assets.${target}`;
      const asset = `${runtime.tool}-${target}.zip`;
      const expectedPrimary = `${runtime.primaryRoot}${runtime.versionPrefix}${version}/${asset}`;
      if (manifestValue(runtime.path, sections, section, 'url') !== expectedPrimary) {
        fail(`${runtime.path} ${section}.url must be ${expectedPrimary}`);
      }
      if (runtime.mirror) {
        const expectedMirror = `https://dl.deno.land/release/v${version}/${asset}`;
        if (manifestValue(runtime.path, sections, section, 'mirror_url') !== expectedMirror) {
          fail(`${runtime.path} ${section}.mirror_url must be ${expectedMirror}`);
        }
      }
      for (const key of ['sha256', 'binary_sha256']) {
        if (!/^[0-9a-f]{64}$/u.test(manifestValue(runtime.path, sections, section, key))) {
          fail(`${runtime.path} ${section}.${key} must be 64 lowercase hexadecimal characters`);
        }
      }
      const binaryName = target.includes('windows') ? `${runtime.tool}.exe` : runtime.tool;
      const expectedBinary = runtime.tool === 'bun' ? `bun-${target}/${binaryName}` : binaryName;
      if (manifestValue(runtime.path, sections, section, 'binary_path') !== expectedBinary) {
        fail(`${runtime.path} ${section}.binary_path must be ${expectedBinary}`);
      }
      if (manifestValue(runtime.path, sections, section, 'entry_count') !== runtime.entryCount) {
        fail(`${runtime.path} ${section}.entry_count must be ${runtime.entryCount}`);
      }
    }
  }
  requireText('tools/dev/bun.sh', 'install-pinned-js-runtime.sh bun');
  requireText('tools/dev/deno.sh', 'install-pinned-js-runtime.sh deno');
  requireText('.github/actions/setup-bun/action.yml', 'tools/dev/install-pinned-js-runtime.sh bun');
  requireText('.github/actions/setup-deno/action.yml', 'tools/dev/install-pinned-js-runtime.sh deno');
  for (const action of ['.github/actions/setup-bun/action.yml', '.github/actions/setup-deno/action.yml']) {
    const source = readFileSync(action, 'utf8');
    if (/uses:\s*(?:oven-sh\/setup-bun|denoland\/setup-deno)@/u.test(source) || source.includes('continue-on-error: true')) {
      fail(`${action} must not retain an unverified setup-action or continue-on-error fallback`);
    }
  }

  const androidManifestPath = 'src/sources/toolchains/android-sdk.toml';
  const android = parseQuotedManifest(androidManifestPath);
  const androidPackageKeys = [
    'command_line_tools_build',
    'command_line_tools_revision',
    'ndk',
    'cmake',
    'compile_sdk',
    'build_tools',
  ];
  requireExactManifestShape(androidManifestPath, android, {
    packages: androidPackageKeys,
    'command_line_tools.linux': ['url', 'mirror_url', 'sha256', 'entry_count'],
    'command_line_tools.mac': ['url', 'mirror_url', 'sha256', 'entry_count'],
  });
  const androidPackage = (key) => manifestValue(androidManifestPath, android, 'packages', key);
  const commandLineBuild = androidPackage('command_line_tools_build');
  for (const host of ['linux', 'mac']) {
    const section = `command_line_tools.${host}`;
    const asset = `commandlinetools-${host}-${commandLineBuild}_latest.zip`;
    const expectedPrimary = `https://dl.google.com/android/repository/${asset}`;
    const expectedMirror = `https://edgedl.me.gvt1.com/edgedl/android/repository/${asset}`;
    if (manifestValue(androidManifestPath, android, section, 'url') !== expectedPrimary) {
      fail(`${androidManifestPath} ${section}.url must be ${expectedPrimary}`);
    }
    if (manifestValue(androidManifestPath, android, section, 'mirror_url') !== expectedMirror) {
      fail(`${androidManifestPath} ${section}.mirror_url must be ${expectedMirror}`);
    }
    if (!/^[0-9a-f]{64}$/u.test(manifestValue(androidManifestPath, android, section, 'sha256'))) {
      fail(`${androidManifestPath} ${section}.sha256 must be 64 lowercase hexadecimal characters`);
    }
    if (!/^[1-9][0-9]*$/u.test(manifestValue(androidManifestPath, android, section, 'entry_count'))) {
      fail(`${androidManifestPath} ${section}.entry_count must be a positive integer`);
    }
  }
  const androidAction = readFileSync('.github/actions/setup-android/action.yml', 'utf8');
  for (const value of [androidPackage('ndk'), androidPackage('cmake'), androidPackage('compile_sdk')]) {
    if (!androidAction.includes(`default: "${value}"`)) {
      fail(`.github/actions/setup-android/action.yml must default to manifest value ${value}`);
    }
  }
  for (const text of [
    'gradle-cache:',
    "inputs.gradle-cache == 'true'",
    "inputs.gradle-cache != 'true'",
    'Prepare native Android ccache directory',
  ]) {
    if (!androidAction.includes(text)) fail(`.github/actions/setup-android/action.yml must contain ${text}`);
  }
  const androidActionYaml = Bun.YAML.parse(androidAction);
  const gradleCacheScopeInput = androidActionYaml?.inputs?.['gradle-cache-scope-file'];
  if (gradleCacheScopeInput?.required !== false || gradleCacheScopeInput?.default !== '') {
    fail('setup-android gradle-cache-scope-file must remain an optional empty-by-default cache-key input');
  }
  const androidActionSteps = androidActionYaml?.runs?.steps ?? [];
  const cachedJavaStep = androidActionSteps.find(({name}) => name === 'Set up Java with Gradle cache');
  const cacheDependencyPaths = String(cachedJavaStep?.with?.['cache-dependency-path'] ?? '');
  if (!cacheDependencyPaths.includes('${{ inputs.gradle-cache-scope-file }}')) {
    fail('setup-android must bind gradle-cache-scope-file into the setup-java dependency cache key');
  }
  const prepareCcacheIndex = androidActionSteps.findIndex(({name}) => name === 'Prepare native Android ccache directory');
  const restoreCcacheIndex = androidActionSteps.findIndex(({name}) => name === 'Restore native Android ccache');
  if (prepareCcacheIndex < 0 || restoreCcacheIndex < 0 || prepareCcacheIndex >= restoreCcacheIndex) {
    fail('Android ccache directory must be created before actions/cache restore');
  }
  const ciWorkflow = Bun.YAML.parse(readFileSync('.github/workflows/ci.yml', 'utf8'));
  const androidStep = (job) => {
    const matches = (ciWorkflow?.jobs?.[job]?.steps ?? [])
      .filter(({uses}) => uses === './.github/actions/setup-android');
    if (matches.length !== 1) fail(`CI job ${job} must use setup-android exactly once`);
    return matches[0];
  };
  for (const job of [
    'extension-artifacts-native',
    'liboliphaunt-native-android',
    'mobile-e2e-android',
  ]) {
    if (androidStep(job).with?.['gradle-cache'] !== 'false') {
      fail(`non-Gradle CI job ${job} must disable setup-java Gradle caching`);
    }
  }
  for (const job of ['kotlin-sdk-package', 'mobile-build-android']) {
    if (androidStep(job).with?.['gradle-cache'] === 'false') {
      fail(`Gradle/Expo CI job ${job} must retain setup-java Gradle caching`);
    }
  }
  const nativeTestCacheScopePath = 'src/sdks/kotlin/gradle/cache-scopes/linux-native-tests.txt';
  requireFile(nativeTestCacheScopePath);
  if (readFileSync(nativeTestCacheScopePath, 'utf8') !== 'oliphaunt-kotlin-linux-native-tests-v1\n') {
    fail(`${nativeTestCacheScopePath} must retain its stable, dedicated cache identity`);
  }
  const scopedAndroidSteps = Object.entries(ciWorkflow?.jobs ?? {})
    .flatMap(([job, definition]) => (definition?.steps ?? [])
      .filter(({uses, with: inputs}) =>
        uses === './.github/actions/setup-android'
        && Object.hasOwn(inputs ?? {}, 'gradle-cache-scope-file'))
      .map((step) => ({job, step})));
  const expectedNativeTestScope = "${{ matrix.target == 'oliphaunt-kotlin:test' && 'src/sdks/kotlin/gradle/cache-scopes/linux-native-tests.txt' || '' }}";
  if (
    scopedAndroidSteps.length !== 1
    || scopedAndroidSteps[0].job !== 'test-targets'
    || scopedAndroidSteps[0].step.with['gradle-cache-scope-file'] !== expectedNativeTestScope
  ) {
    fail('only the oliphaunt-kotlin:test matrix entry may select the dedicated Linux-native Gradle cache scope');
  }

  const kotlinSettingsPath = 'src/sdks/kotlin/settings.gradle.kts';
  const kotlinSettings = readFileSync(kotlinSettingsPath, 'utf8');
  const googleMirrorRepository = String.raw`maven\s*\{\s*name = "GoogleCloudMavenCentralMirror"\s*url = uri\("https://maven-central\.storage-download\.googleapis\.com/maven2/"\)\s*\}`;
  const pluginRepositoryTopology = new RegExp(
    String.raw`pluginManagement\s*\{\s*repositories\s*\{\s*google\(\)\s*${googleMirrorRepository}\s*mavenCentral\(\)\s*gradlePluginPortal\(\)\s*\}\s*\}`,
    'u',
  );
  const dependencyRepositoryTopology = new RegExp(
    String.raw`dependencyResolutionManagement\s*\{\s*repositoriesMode\.set\(RepositoriesMode\.FAIL_ON_PROJECT_REPOS\)\s*repositories\s*\{\s*google\(\)\s*${googleMirrorRepository}\s*mavenCentral\(\)\s*\}\s*\}`,
    'u',
  );
  const mirrorUrlOccurrences = kotlinSettings.match(/https:\/\/maven-central\.storage-download\.googleapis\.com\/maven2\//gu) ?? [];
  if (
    !pluginRepositoryTopology.test(kotlinSettings)
    || !dependencyRepositoryTopology.test(kotlinSettings)
    || mirrorUrlOccurrences.length !== 2
  ) {
    fail(`${kotlinSettingsPath} must route plugin and dependency resolution through the fixed Google Cloud Maven Central mirror before canonical Central`);
  }
  const requirePreparedCache = (job, prepareName, restoreName, expectedPath) => {
    const steps = ciWorkflow?.jobs?.[job]?.steps ?? [];
    const prepareIndex = steps.findIndex(({name}) => name === prepareName);
    const restoreIndex = steps.findIndex(({name}) => name === restoreName);
    if (prepareIndex < 0 || restoreIndex < 0 || prepareIndex >= restoreIndex) {
      fail(`${job} must prepare its compiler cache path before restore`);
    }
    const cachePath = String(steps[restoreIndex]?.with?.path ?? '');
    if (!cachePath.includes(expectedPath) || cachePath.includes('~/.ccache')) {
      fail(`${job} cache restore must use configured path ${expectedPath}, never unused ~/.ccache`);
    }
    return cachePath;
  };
  requirePreparedCache(
    'extension-artifacts-native',
    'Prepare native compiler cache path',
    'Restore native compiler cache',
    '${{ env.CCACHE_DIR }}',
  );
  const androidOuterCache = requirePreparedCache(
    'liboliphaunt-native-android',
    'Prepare native build cache path',
    'Restore native compiler cache',
    '${{ matrix.build-root }}',
  );
  if (androidOuterCache.includes('oliphaunt-ccache')) {
    fail('liboliphaunt-native-android outer cache must leave configured ccache ownership to setup-android');
  }
  for (const job of ['liboliphaunt-native-desktop', 'liboliphaunt-native-ios']) {
    const nativeJob = ciWorkflow?.jobs?.[job] ?? {};
    if (nativeJob.env?.CCACHE_DIR !== '${{ github.workspace }}/.ci-cache/ccache/native-runtime/${{ matrix.target }}') {
      fail(`${job} must configure one target-scoped native-runtime CCACHE_DIR`);
    }
    for (const [name, expected] of [
      ['CCACHE_BASEDIR', '${{ github.workspace }}'],
      ['CCACHE_COMPILERCHECK', 'content'],
      ['CCACHE_COMPRESS', 'true'],
      ['OLIPHAUNT_CCACHE_ZERO_STATS', '1'],
    ]) {
      if (String(nativeJob.env?.[name] ?? '') !== expected) {
        fail(`${job} must configure ${name}=${expected}`);
      }
    }
    const nativeCache = requirePreparedCache(
      job,
      'Prepare native compiler cache paths',
      'Restore native compiler cache',
      '${{ env.CCACHE_DIR }}',
    );
    if (!nativeCache.includes('${{ matrix.build-root }}')) {
      fail(`${job} cache must retain its target-scoped native build root`);
    }
    const restore = (nativeJob.steps ?? []).find(({name}) => name === 'Restore native compiler cache');
    if (!String(restore?.with?.key ?? '').startsWith('liboliphaunt-native-ccache-v2-${{ matrix.target }}-')) {
      fail(`${job} cache key must use the corrected v2 compiler-cache namespace`);
    }
    if (job === 'liboliphaunt-native-desktop') {
      const prepare = (nativeJob.steps ?? []).find(({name}) => name === 'Prepare native compiler cache paths');
      const prepareRun = String(prepare?.run ?? '');
      if (
        !prepareRun.includes('mkdir -p "$NATIVE_BUILD_ROOT"') ||
        !prepareRun.includes('if [[ "$RUNNER_OS" != "Windows" ]]') ||
        !prepareRun.includes('mkdir -p "$CCACHE_DIR"')
      ) {
        fail('liboliphaunt-native-desktop must prepare its relative build root on every target and CCACHE_DIR only outside Windows');
      }
      if (restore?.if !== "${{ runner.os != 'Windows' }}") {
        fail('liboliphaunt-native-desktop compiler-cache restore must exclude Windows');
      }
      const windowsRestore = (nativeJob.steps ?? []).find(({name}) => name === 'Restore native Windows build cache');
      if (
        windowsRestore?.if !== "${{ runner.os == 'Windows' }}" ||
        String(windowsRestore?.with?.path ?? '') !== '${{ matrix.build-root }}' ||
        String(windowsRestore?.with?.path ?? '').includes('CCACHE_DIR') ||
        !String(windowsRestore?.with?.key ?? '').startsWith('liboliphaunt-native-build-v2-${{ matrix.target }}-')
      ) {
        fail('liboliphaunt-native-desktop Windows cache must persist only the relative target build root');
      }
    }
  }
  const androidInstaller = readFileSync('tools/dev/setup-android-sdk.sh', 'utf8');
  if (/sha-?1|ANDROID_CMDLINE_TOOLS_(?:URL|VERSION)/iu.test(androidInstaller)) {
    fail('Android bootstrap must not contain SHA-1 or command-line-tools URL/version override ambiguity');
  }
  for (const token of [
    '--proto-redir',
    '--max-filesize',
    'cmdline_tools_valid',
    'sdk_packages_valid',
    'ANDROID_SDKMANAGER_INSTALL_ATTEMPTS must be at most 8',
    'ANDROID_SDKMANAGER_RETRY_DELAY must be at most 60 seconds',
  ]) {
    if (!androidInstaller.includes(token)) fail(`Android bootstrap must enforce ${token}`);
  }
  runFaultTest('tools/dev/extract-pinned-zip.test.sh');
  runFaultTest('tools/dev/install-pinned-js-runtime.test.sh');
  runFaultTest('tools/dev/setup-android-sdk.test.sh');
  requireText('src/sources/toolchains/android-emulator-runner.toml', 'repository = "ReactiveCircus/android-emulator-runner"');
  requireText('src/sources/toolchains/android-emulator-runner.toml', 'sha = "70f4dee990796918b78d040e3278474bdbd348a7"');
  requireText('src/sources/toolchains/android-emulator-runner.toml', 'cloud_required = false');
}

function checkExtensions() {
  for (const path of [
    'src/extensions/catalog/extensions.promoted.toml',
    'src/extensions/catalog/extensions.smoke.toml',
    'src/extensions/contrib/postgres18.toml',
    'src/extensions/external/README.md',
    'src/extensions/external/vector/source.toml',
    'src/extensions/external/postgis/source.toml',
    'src/extensions/external/postgis/dependencies/geos/source.toml',
    'src/extensions/external/postgis/dependencies/proj/source.toml',
    'src/extensions/external/postgis/dependencies/sqlite/source.toml',
    'src/extensions/external/postgis/dependencies/libxml2/source.toml',
    'src/extensions/external/postgis/dependencies/json-c/source.toml',
    'src/extensions/external/postgis/dependencies/libiconv/source.toml',
    'src/extensions/schemas/recipe.schema.json',
    'src/extensions/schemas/support-table.schema.json',
    'src/extensions/evidence/matrix.toml',
    'src/extensions/evidence/schemas/matrix.schema.json',
    'src/extensions/evidence/schemas/run.schema.json',
    'src/extensions/evidence/runs/2026-06-07-transitional-catalog-smoke.json',
    'src/extensions/generated/extensions.catalog.json',
    'src/extensions/generated/extensions.build-plan.json',
    'src/extensions/generated/contrib-build.tsv',
    'src/extensions/generated/pgxs-build.tsv',
    'src/extensions/generated/docs/extensions.json',
    'src/extensions/generated/docs/extension-evidence.json',
    'src/extensions/generated/sdk/rust.json',
    'src/extensions/generated/sdk/swift.json',
    'src/extensions/generated/sdk/kotlin.json',
    'src/extensions/generated/sdk/js.json',
    'src/extensions/generated/sdk/react-native.json',
    'src/sdks/rust/src/generated/extensions.rs',
    'src/sdks/js/src/generated/extensions.ts',
    'src/sdks/kotlin/oliphaunt/src/commonMain/kotlin/dev/oliphaunt/GeneratedExtensions.kt',
    'src/sdks/kotlin/oliphaunt/src/generated/extensions.json',
    'src/sdks/react-native/src/generated/extensions.ts',
    'src/sdks/react-native/src/generated/extensions.json',
    'src/extensions/generated/mobile/static-registry.json',
    'src/extensions/generated/mobile/static-extensions.tsv',
    'src/extensions/generated/wasix/extensions.json',
    'src/extensions/tools/check-extension-model.mjs',
    'src/extensions/tools/check-extension-model.py',
  ]) {
    requireFile(path);
  }

  const result = runBun(['src/extensions/tools/check-extension-model.mjs', '--check'], {
    stdio: 'inherit',
  });
  if (result.error !== undefined) {
    fail(result.error.message);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function checkRepoPolicy() {
  const ephemeralExampleLockfiles = [
    'examples/electron-wasix/src-wasix/Cargo.lock',
    'examples/tauri/src-tauri/Cargo.lock',
    'examples/tauri-wasix/src-tauri/Cargo.lock',
    'src/bindings/wasix-rust/examples/tauri-sqlx-vanilla/src-tauri/Cargo.lock',
  ];
  const registryNeutralExampleManifests = [
    'examples/electron-wasix/src-wasix/Cargo.toml',
    'examples/tauri/src-tauri/Cargo.toml',
    'examples/tauri-wasix/src-tauri/Cargo.toml',
    'src/bindings/wasix-rust/examples/tauri-sqlx-vanilla/src-tauri/Cargo.toml',
  ];

  const assets = run('git', ['ls-files', 'assets']);
  if (assets.status !== 0) {
    process.exit(assets.status ?? 1);
  }
  if (assets.stdout.trim().length > 0) {
    fail(`root assets/ must not contain tracked files:\n${assets.stdout.trim()}`);
  }
  const retiredThirdParty = run('git', ['ls-files', 'src/third-party']);
  if (retiredThirdParty.status !== 0) {
    process.exit(retiredThirdParty.status ?? 1);
  }
  if (retiredThirdParty.stdout.trim().length > 0) {
    fail(`src/third-party must not contain tracked files:\n${retiredThirdParty.stdout.trim()}`);
  }

  requireFile('tools/policy/check-docs.sh');
  requireFile('tools/release/example-cargo-policy.mjs');
  requireFile('tools/release/validate-example-cargo-candidates.mjs');
  requireText('tools/release/example-cargo-registry.mjs', 'https://cargo.oliphaunt.invalid/index');
  requireText('examples/tools/check-lockfiles.sh', 'tools/release/example-cargo-policy.mjs --check');

  for (const manifest of registryNeutralExampleManifests) {
    requireFile(manifest);
    if (/\bregistry\s*=\s*["']oliphaunt-local["']/u.test(readFileSync(manifest, 'utf8'))) {
      fail(`${manifest} must use normal crates.io resolution; candidate patches belong only in release scratch space`);
    }
  }
  for (const lockfile of ephemeralExampleLockfiles) {
    if (existsSync(lockfile)) {
      fail(`${lockfile} must be generated only in release scratch space, not in the source tree`);
    }
    const ignored = run('git', ['check-ignore', '--no-index', '--quiet', '--', lockfile]);
    if (ignored.status !== 0) {
      fail(`${lockfile} must be explicitly ignored`);
    }
    const tracked = run('git', ['ls-files', '--cached', '--', lockfile]);
    if (tracked.status !== 0) {
      process.exit(tracked.status ?? 1);
    }
    if (tracked.stdout.trim().length > 0) {
      const pendingDeletion = run('git', ['status', '--short', '--', lockfile]);
      if (pendingDeletion.status !== 0 || !/(^|\n)( D|D )/u.test(pendingDeletion.stdout)) {
        fail(`${lockfile} must not be tracked`);
      }
    }
  }

  const removedName = 'pg' + 'lite';
  const grepLines = gitGrep([
    '-i',
    '-e',
    `@electric-sql/${removedName}`,
    '-e',
    `@electric-sql/${removedName}-socket`,
    '-e',
    `electric-sql/${removedName}`,
    '-e',
    `postgres-${removedName}`,
    '-e',
    `${removedName}-build`,
    '-e',
    `${removedName}-bindings`,
    '-e',
    `REL_17_5-${removedName}`,
    '-e',
    'pgl_startPG' + 'lite',
    '-e',
    'PG' + 'Lite',
    '-e',
    removedName,
  ]);
  const unexpectedLegacyLines = unexpectedGrepLines(grepLines, [
    'README.md',
    'docs/internal/OLIPHAUNT_README.md',
    'tools/policy/check-docs.sh',
  ]);
  if (unexpectedLegacyLines.length > 0) {
    console.error(unexpectedLegacyLines.join('\n'));
    fail('removed upstream identifiers remain in tracked source');
  }
}

process.chdir(workspaceRoot());

const scope = process.argv[2] ?? 'all';
switch (scope) {
  case 'postgres18':
    checkPostgres18();
    break;
  case 'third-party':
    checkThirdParty();
    break;
  case 'third-party-shared':
    checkSourceAcquisitionSpine();
    checkThirdPartyShared();
    break;
  case 'third-party-native':
    checkThirdPartyNative();
    break;
  case 'third-party-wasix':
    checkThirdPartyWasix();
    break;
  case 'toolchains':
    checkToolchains();
    break;
  case 'extensions':
    checkPostgres18();
    checkThirdParty();
    checkExtensions();
    break;
  case 'all':
    checkPostgres18();
    checkThirdParty();
    checkToolchains();
    checkExtensions();
    checkRepoPolicy();
    break;
  default:
    fail('usage: assert-source-inputs.mjs [postgres18|third-party|third-party-shared|third-party-native|third-party-wasix|toolchains|extensions|all]');
}
