/** Import the selected, licensed host SDK into declared Bazel inputs. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { release } from 'node:os';
import path from 'node:path';
import { windowsVcRuntimeProfileNames } from '../../tools/packaging/windows-vc-runtime-closure.mts';
import { captureAppleAppTools } from './apple-app-tools.mts';
import { appleDeploymentTargets } from './deployment-policy.mts';

export { appleDeploymentTargets } from './deployment-policy.mts';

export interface HostPolicy {
  apple: {
    xcode_version: string;
    developer_dir: string;
  };
  windows: {
    visual_studio_major: number;
    vc_toolset_major: number;
    vc_toolset_minor_min: number;
    vc_toolset_minor_max_exclusive: number;
    windows_sdk_major: number;
    crt_family: string;
  };
}

export interface Component {
  name: string;
  path: string;
  resolvedPath: string;
  directory: boolean;
  roles: ('compile' | 'link' | 'swift')[];
}

export interface HostSdk {
  family: 'apple' | 'msvc';
  components: Component[];
  observations: Record<string, string>;
  tools: Record<string, string>;
  resourceDirectory?: string;
  temporaryDirectory?: string;
  deploymentTargets?: Record<string, string>;
  developerDirectory?: string;
  runtimeDlls?: string[];
}

function scalar(value: unknown, name: string): string {
  assert.equal(typeof value, 'string', `${name} must be a string`);
  assert.ok(
    (value as string).length > 0 && !/[\r\n\0]/.test(value as string),
    `${name} is empty or contains a control character`,
  );
  return value as string;
}

export function parsePolicy(value: unknown): HostPolicy {
  assert.ok(
    value && typeof value === 'object' && !Array.isArray(value),
    'host policy must be an object',
  );
  const policy = value as HostPolicy;
  assert.ok(policy.apple && policy.windows, 'host policy needs Apple and Windows sections');
  for (const [key, version] of Object.entries(policy.apple)) {
    scalar(version, `apple.${key}`);
    if (key !== 'developer_dir') assert.match(version, /^\d+(?:\.\d+)+$/, `invalid apple.${key}`);
  }
  for (const key of ['xcode_version', 'developer_dir'] as const)
    scalar(policy.apple[key], `apple.${key}`);
  assert.equal(
    policy.apple.developer_dir,
    `/Applications/Xcode_${policy.apple.xcode_version}.app/Contents/Developer`,
    'Xcode path must identify the supported version',
  );
  for (const key of [
    'visual_studio_major',
    'vc_toolset_major',
    'vc_toolset_minor_min',
    'vc_toolset_minor_max_exclusive',
    'windows_sdk_major',
  ] as const) {
    assert.ok(
      Number.isSafeInteger(policy.windows[key]) && policy.windows[key] > 0,
      `invalid windows.${key}`,
    );
  }
  assert.ok(
    policy.windows.vc_toolset_minor_min < policy.windows.vc_toolset_minor_max_exclusive,
    'empty VC toolset family',
  );
  assert.match(scalar(policy.windows.crt_family, 'windows.crt_family'), /^VC\d+$/);
  return policy;
}

function run(
  executable: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  allowedStatus = [0],
): string {
  const result = spawnSync(executable, args, {
    env,
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(result.error, undefined, `${executable}: ${result.error}`);
  assert.ok(
    result.status !== null && allowedStatus.includes(result.status),
    `${executable} failed: ${result.stderr}`,
  );
  return `${result.stdout}${result.stderr}`.trim();
}

function component(
  name: string,
  input: string,
  directory: boolean,
  roles: Component['roles'],
): Component {
  const physical = realpathSync(input);
  assert.equal(statSync(physical).isDirectory(), directory, `${input} has the wrong file type`);
  return {
    name,
    // Preserve logical SDK paths for declared inputs and file/directory watches.
    path: path.resolve(input).replaceAll('\\', '/'),
    resolvedPath: physical.replaceAll('\\', '/'),
    directory,
    roles,
  };
}

function digest(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function version(value: string, name: string): number[] {
  assert.match(value, /^\d+(?:\.\d+){1,3}$/, `${name} must be a numeric version`);
  return value.split('.').map(Number);
}

export function verifyWindowsVersions(env: NodeJS.ProcessEnv, policy: HostPolicy['windows']) {
  const command = version(scalar(env.VSCMD_VER, 'VSCMD_VER'), 'VSCMD_VER');
  const vc = version(
    scalar(env.VCToolsVersion, 'VCToolsVersion').replace(/[\\/]+$/, ''),
    'VCToolsVersion',
  );
  const sdk = version(
    scalar(env.WindowsSDKVersion, 'WindowsSDKVersion').replace(/[\\/]+$/, ''),
    'WindowsSDKVersion',
  );
  assert.equal(command[0], policy.visual_studio_major, 'unsupported Visual Studio family');
  assert.equal(vc[0], policy.vc_toolset_major, 'unsupported VC toolset major');
  assert.ok(
    vc[1] >= policy.vc_toolset_minor_min && vc[1] < policy.vc_toolset_minor_max_exclusive,
    'unsupported VC toolset family',
  );
  assert.equal(sdk[0], policy.windows_sdk_major, 'unsupported Windows SDK family');
  assert.equal(env.VSCMD_ARG_HOST_ARCH, 'x64', 'MSVC host must be x64');
  assert.equal(env.VSCMD_ARG_TGT_ARCH, 'x64', 'MSVC target must be x64');
}

function captureWindows(policy: HostPolicy, env: NodeJS.ProcessEnv): HostSdk {
  verifyWindowsVersions(env, policy.windows);
  const vc = scalar(env.VCToolsInstallDir, 'VCToolsInstallDir');
  const sdkRoot = scalar(env.WindowsSdkDir, 'WindowsSdkDir');
  const sdkVersion = scalar(env.WindowsSDKVersion, 'WindowsSDKVersion').replace(/[\\/]+$/, '');
  assert.equal(
    path.basename(vc.replace(/[\\/]+$/, '')),
    scalar(env.VCToolsVersion, 'VCToolsVersion').replace(/[\\/]+$/, ''),
    'VCToolsInstallDir must identify the selected exact toolset',
  );
  const binary = path.join(vc, 'bin', 'HostX64', 'x64');
  const crt = path.join(
    scalar(env.VCToolsRedistDir, 'VCToolsRedistDir'),
    'x64',
    `Microsoft.${policy.windows.crt_family}.CRT`,
  );
  const components = [
    component('compiler_bin', binary, true, ['compile', 'link']),
    component('compiler_include', path.join(vc, 'include'), true, ['compile']),
    component('compiler_lib', path.join(vc, 'lib', 'x64'), true, ['link']),
    component('sdk_include', path.join(sdkRoot, 'Include', sdkVersion), true, ['compile']),
    component('sdk_lib_ucrt', path.join(sdkRoot, 'Lib', sdkVersion, 'ucrt', 'x64'), true, ['link']),
    component('sdk_lib_um', path.join(sdkRoot, 'Lib', sdkVersion, 'um', 'x64'), true, ['link']),
    component('sdk_bin', path.join(sdkRoot, 'bin', sdkVersion, 'x64'), true, ['link']),
    component('crt', crt, true, ['compile', 'link']),
  ];
  const tools: Record<string, string> = {};
  for (const name of ['cl', 'link', 'lib', 'dumpbin', 'ml64']) {
    const file = path.join(binary, `${name}.exe`);
    assert.ok(existsSync(file), `MSVC is missing ${file}`);
    tools[name] = `compiler_bin/${name}.exe`;
  }
  const resourceCompiler = path.join(sdkRoot, 'bin', sdkVersion, 'x64', 'rc.exe');
  assert.ok(statSync(resourceCompiler).isFile(), `Windows SDK is missing ${resourceCompiler}`);
  tools.rc = 'sdk_bin/rc.exe';
  const runtimeDlls = windowsVcRuntimeProfileNames('provider');
  assert.ok(runtimeDlls.length > 0, 'Windows provider runtime profile must not be empty');
  for (const name of runtimeDlls)
    assert.ok(statSync(path.join(crt, name)).isFile(), `missing regular CRT ${name}`);
  return {
    family: 'msvc',
    components,
    tools,
    runtimeDlls: runtimeDlls.map((name) => `crt/${name}`),
    temporaryDirectory: scalar(env.TEMP ?? env.TMP, 'MSVC temporary directory'),
    observations: {
      VSCMD_VER: scalar(env.VSCMD_VER, 'VSCMD_VER'),
      VCToolsVersion: scalar(env.VCToolsVersion, 'VCToolsVersion'),
      WindowsSDKVersion: sdkVersion,
      compiler: run(path.join(binary, 'cl.exe'), ['/Bv'], env, [0, 2]),
      compiler_sha256: digest(path.join(binary, 'cl.exe')),
      linker_sha256: digest(path.join(binary, 'link.exe')),
      dumpbin_sha256: digest(path.join(binary, 'dumpbin.exe')),
      resource_compiler_sha256: digest(resourceCompiler),
      os_build: release(),
      ImageOS: env.ImageOS ?? '',
      ImageVersion: env.ImageVersion ?? '',
    },
  };
}

function captureApple(policy: HostPolicy, env: NodeJS.ProcessEnv): HostSdk {
  assert.equal(
    env.TOOLCHAINS,
    undefined,
    'the declared Apple profile does not support TOOLCHAINS overrides',
  );
  assert.equal(
    env.DEVELOPER_DIR,
    policy.apple.developer_dir,
    'DEVELOPER_DIR must select the supported Xcode bundle',
  );
  const xcode = run('/usr/bin/xcodebuild', ['-version'], env);
  assert.equal(
    /^Xcode (.+)$/m.exec(xcode)?.[1],
    policy.apple.xcode_version,
    'unsupported Xcode version',
  );
  assert.match(xcode, /^Build version \S+$/m, 'Xcode build identity is missing');
  const developer = realpathSync(policy.apple.developer_dir);
  const toolchain = path.join(developer, 'Toolchains', 'XcodeDefault.xctoolchain', 'usr');
  const components = [component('toolchain', toolchain, true, ['compile', 'link', 'swift'])];
  const observations: Record<string, string> = {
    xcode,
    os_build: run('/usr/bin/sw_vers', ['-buildVersion']),
    ImageOS: env.ImageOS ?? '',
    ImageVersion: env.ImageVersion ?? '',
  };
  for (const [sdk, platform] of [
    ['macosx', 'MacOSX'],
    ['iphoneos', 'iPhoneOS'],
    ['iphonesimulator', 'iPhoneSimulator'],
  ]) {
    const platformDeveloper = path.join(
      developer,
      'Platforms',
      `${platform}.platform`,
      'Developer',
    );
    for (const directory of ['Library', 'usr/lib'])
      components.push(
        component(`platform_${sdk}/${directory}`, path.join(platformDeveloper, directory), true, [
          'compile',
          'link',
          'swift',
        ]),
      );
    const sdkPath = run('/usr/bin/xcrun', ['--sdk', sdk, '--show-sdk-path'], env);
    assert.ok(
      realpathSync(sdkPath).startsWith(`${developer}/`),
      `${sdk} must come from the selected Xcode bundle`,
    );
    components.push(component(`sdk_${sdk}`, sdkPath, true, ['compile', 'link', 'swift']));
    observations[`${sdk}_version`] = run(
      '/usr/bin/xcrun',
      ['--sdk', sdk, '--show-sdk-version'],
      env,
    );
    version(observations[`${sdk}_version`], `${sdk} SDK`);
  }
  const tools: Record<string, string> = {};
  for (const name of [
    'clang',
    'clang++',
    'libtool',
    'ar',
    'ld',
    'nm',
    'strip',
    'install_name_tool',
    'otool',
    'plutil',
    'dsymutil',
    'swiftc',
    'swift-symbolgraph-extract',
    'swift-synthesize-interface',
  ]) {
    const tool = run('/usr/bin/xcrun', ['--find', name], env);
    components.push(component(`tools/${name}`, tool, false, ['compile', 'link', 'swift']));
    tools[name] = `tools/${name}`;
    observations[`${name}_sha256`] = digest(tool);
  }
  const resource = realpathSync(run('/usr/bin/xcrun', ['clang', '-print-resource-dir'], env));
  assert.ok(
    resource.startsWith(`${realpathSync(toolchain)}/`),
    'Clang resource directory must come from the selected toolchain',
  );
  observations.swift = run('/usr/bin/xcrun', ['swiftc', '--version'], env);
  components.push(component('tools/xcrun', '/usr/bin/xcrun', false, ['compile', 'link', 'swift']));
  const appTools = captureAppleAppTools(developer, (name) =>
    name === 'ditto' ? '/usr/bin/ditto' : run('/usr/bin/xcrun', ['--find', name], env),
  );
  components.push(...appTools.components);
  Object.assign(tools, appTools.tools);
  Object.assign(observations, appTools.observations);
  // Standard Apple strip actions invoke the operating-system tool directly.
  components.push(component('system/strip', '/usr/bin/strip', false, ['link']));
  return {
    family: 'apple',
    components,
    tools,
    observations,
    developerDirectory: developer,
    resourceDirectory: `toolchain/${path.relative(realpathSync(toolchain), resource)}`,
  };
}

export function captureHostSdk(policy: HostPolicy, family: string): HostSdk {
  assert.ok(family === 'apple' || family === 'msvc', 'unknown host SDK family');
  assert.equal(
    process.platform,
    family === 'apple' ? 'darwin' : 'win32',
    'host SDK cannot be acquired from an incompatible host',
  );
  assert.equal(
    process.arch,
    family === 'apple' ? 'arm64' : 'x64',
    'host SDK profile has no compiler declaration for this CPU',
  );
  const sdk =
    family === 'apple' ? captureApple(policy, process.env) : captureWindows(policy, process.env);
  if (family === 'apple') sdk.deploymentTargets = appleDeploymentTargets();
  return sdk;
}

if (import.meta.main) {
  const [policyFile, family] = process.argv.slice(2);
  const policy = parsePolicy(JSON.parse(readFileSync(policyFile, 'utf8')));
  process.stdout.write(JSON.stringify(captureHostSdk(policy, family)));
}
