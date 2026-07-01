#!/usr/bin/env node
import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PG_VERSION = '18.4';

function usage() {
  console.error(`usage: src/runtimes/liboliphaunt/native/tools/run-host-c-smoke.mjs [--abi-only|--smoke-only] [--root <dir>]

Compiles and runs the host liboliphaunt C ABI smoke against the current native
runtime artifacts for macOS, Linux, or Windows.

Set LIBOLIPHAUNT_PATH and OLIPHAUNT_INSTALL_DIR to smoke a staged release
layout. Set OLIPHAUNT_SMOKE_BIN_DIR to keep compiled smoke binaries out of that
layout. Set OLIPHAUNT_SMOKE_ROOT to run database scratch roots outside the
build work root.`);
}

function parseArgs(argv) {
  const args = {
    abiOnly: false,
    smokeOnly: false,
    root: '',
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--abi-only') {
      args.abiOnly = true;
    } else if (arg === '--smoke-only') {
      args.smokeOnly = true;
    } else if (arg === '--root') {
      index++;
      if (index >= argv.length) {
        throw new Error('--root requires a directory');
      }
      args.root = argv[index];
    } else if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    } else if (!arg.startsWith('-') && !args.root) {
      args.root = arg;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (args.abiOnly && args.smokeOnly) {
    throw new Error('--abi-only and --smoke-only are mutually exclusive');
  }
  return args;
}

function run(command, args, options = {}) {
  const rendered = [command, ...args].join(' ');
  console.error(`\n==> ${rendered}`);
  const result = childProcess.spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: 'utf8',
    shell: false,
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    windowsVerbatimArguments: options.windowsVerbatimArguments ?? false,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    if (options.capture) {
      process.stderr.write(result.stderr ?? '');
      process.stderr.write(result.stdout ?? '');
    }
    throw new Error(`${rendered} exited with status ${result.status}`);
  }
  return result.stdout ?? '';
}

function commandExists(command, env = process.env) {
  const result = process.platform === 'win32'
    ? childProcess.spawnSync('where.exe', [command], { env, stdio: 'ignore' })
    : childProcess.spawnSync('sh', ['-c', 'command -v "$1" >/dev/null 2>&1', 'sh', command], {
      env,
      stdio: 'ignore',
    });
  return result.status === 0;
}

function executableExists(file) {
  if (!fs.existsSync(file)) {
    return false;
  }
  if (process.platform === 'win32') {
    return true;
  }
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function requireExecutable(file, label) {
  if (!executableExists(file)) {
    throw new Error(`missing ${label}: ${file}`);
  }
}

function repoRoot() {
  const output = childProcess.spawnSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (output.status === 0 && output.stdout.trim()) {
    return output.stdout.trim();
  }
  return path.resolve(new URL('../../..', import.meta.url).pathname);
}

function hostTarget() {
  if (process.platform === 'darwin') {
    return process.arch === 'x64' ? 'macos-x64' : 'macos-arm64';
  }
  if (process.platform === 'linux') {
    if (process.arch === 'x64') {
      return 'linux-x64-gnu';
    }
    if (process.arch === 'arm64') {
      return 'linux-arm64-gnu';
    }
  }
  if (process.platform === 'win32' && process.arch === 'x64') {
    return 'windows-x64-msvc';
  }
  throw new Error(`unsupported liboliphaunt host target: ${process.platform}/${process.arch}`);
}

function defaultWorkRoot(root, target) {
  if (process.env.OLIPHAUNT_WORK_ROOT) {
    return path.resolve(process.env.OLIPHAUNT_WORK_ROOT);
  }
  if (process.platform === 'darwin') {
    return path.join(root, 'target/liboliphaunt-pg18');
  }
  return path.join(root, `target/liboliphaunt-pg18-${target}`);
}

function executableName(name) {
  return process.platform === 'win32' ? `${name}.exe` : name;
}

function artifactPaths(root) {
  const target = hostTarget();
  const workRoot = defaultWorkRoot(root, target);
  const installDir = path.resolve(process.env.OLIPHAUNT_INSTALL_DIR ?? path.join(workRoot, 'install'));
  const libPath = path.resolve(
    process.env.LIBOLIPHAUNT_PATH ??
      (process.platform === 'win32'
        ? path.join(workRoot, 'out/bin/oliphaunt.dll')
        : path.join(workRoot, `out/${process.platform === 'darwin' ? 'liboliphaunt.dylib' : 'liboliphaunt.so'}`)),
  );
  const outDir = process.platform === 'win32'
    ? path.dirname(path.dirname(libPath))
    : path.dirname(libPath);
  const binDir = path.resolve(
    process.env.OLIPHAUNT_SMOKE_BIN_DIR ??
      (process.platform === 'win32' ? path.dirname(libPath) : outDir),
  );
  return {
    root,
    target,
    workRoot,
    outDir,
    binDir,
    installDir,
    buildDir: path.join(workRoot, `postgresql-${PG_VERSION}`),
    embeddedBuildDir: path.join(workRoot, 'meson-embedded'),
    libPath,
    importLib: path.join(outDir, 'lib/oliphaunt.lib'),
    initdb: path.resolve(process.env.OLIPHAUNT_INITDB ?? path.join(installDir, 'bin', executableName('initdb'))),
    postgres: path.resolve(process.env.OLIPHAUNT_POSTGRES ?? path.join(installDir, 'bin', executableName('postgres'))),
  };
}

function requireFile(file, label) {
  if (!fs.existsSync(file)) {
    throw new Error(`missing ${label}: ${file}`);
  }
}

function normalizeForC(value) {
  return process.platform === 'win32' ? value.replaceAll('\\', '/') : value;
}

function splitCommand(value, fallback) {
  return (value ?? fallback).trim().split(/\s+/).filter(Boolean);
}

function ccachePrefix() {
  const mode = process.env.OLIPHAUNT_CCACHE ?? 'auto';
  if (mode === '0' || mode === 'off' || process.platform === 'win32') {
    return [];
  }
  if (mode !== 'auto') {
    return [mode];
  }
  return commandExists('ccache') ? ['ccache'] : [];
}

function compileUnix(paths, kind, source, output, extraArgs) {
  const envName = kind === 'abi' ? 'OLIPHAUNT_ABI_CC' : 'OLIPHAUNT_SMOKE_CC';
  const compiler = splitCommand(process.env[envName], 'cc');
  const command = [...ccachePrefix(), ...compiler];
  const exe = command[0];
  const args = [
    ...command.slice(1),
    '-std=c11',
    '-Wall',
    '-Wextra',
    '-Werror',
    '-O0',
    '-g',
    '-I',
    path.join(paths.root, 'src/runtimes/liboliphaunt/native/include'),
    ...extraArgs,
    source,
    '-L',
    path.dirname(paths.libPath),
    `-Wl,-rpath,${path.dirname(paths.libPath)}`,
    '-pthread',
    '-loliphaunt',
    '-o',
    output,
  ];
  run(exe, args, { cwd: paths.root });
}

function msvcEnvironment() {
  if (commandExists('cl.exe')) {
    return process.env;
  }
  const programFilesX86 = process.env['ProgramFiles(x86)'];
  if (!programFilesX86) {
    throw new Error('ProgramFiles(x86) is not set; cannot locate Visual Studio Build Tools');
  }
  const vswhere = path.join(programFilesX86, 'Microsoft Visual Studio/Installer/vswhere.exe');
  requireFile(vswhere, 'vswhere.exe');
  const vsRoot = run(
    vswhere,
    [
      '-latest',
      '-products',
      '*',
      '-requires',
      'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
      '-property',
      'installationPath',
    ],
    { capture: true },
  ).trim();
  if (!vsRoot) {
    throw new Error('Visual Studio Build Tools with MSVC x64 tools were not found');
  }
  const vsDevCmd = path.join(vsRoot, 'Common7/Tools/VsDevCmd.bat');
  requireFile(vsDevCmd, 'VsDevCmd.bat');
  const envOutput = run(
    'cmd.exe',
    ['/d', '/s', '/c', `call "${vsDevCmd}" -arch=x64 -host_arch=x64 >nul && set`],
    { capture: true, windowsVerbatimArguments: true },
  );
  const env = { ...process.env };
  for (const line of envOutput.split(/\r?\n/)) {
    const match = /^(.*?)=(.*)$/.exec(line);
    if (match) {
      env[match[1]] = match[2];
    }
  }
  return env;
}

function compileWindows(paths, source, output, extraIncludes) {
  requireFile(paths.importLib, 'Windows import library');
  const env = msvcEnvironment();
  fs.mkdirSync(path.dirname(output), { recursive: true });
  run(
    'cl.exe',
    [
      '/nologo',
      '/std:c11',
      '/Zi',
      '/MD',
      '/D_CRT_SECURE_NO_WARNINGS',
      '/DWIN32_LEAN_AND_MEAN',
      `/I${path.join(paths.root, 'src/runtimes/liboliphaunt/native/include')}`,
      ...extraIncludes.map((include) => `/I${include}`),
      source,
      '/link',
      `/LIBPATH:${path.dirname(paths.importLib)}`,
      'oliphaunt.lib',
      `/OUT:${output}`,
    ],
    { cwd: paths.root, env },
  );
}

function compileAbi(paths) {
  requireFile(paths.libPath, 'liboliphaunt library');
  const source = path.join(paths.root, 'src/runtimes/liboliphaunt/native/smoke/liboliphaunt_abi_conformance.c');
  const output = path.join(paths.binDir, executableName('liboliphaunt_abi_conformance'));
  fs.mkdirSync(path.dirname(output), { recursive: true });
  if (process.platform === 'win32') {
    compileWindows(paths, source, output, []);
  } else {
    compileUnix(paths, 'abi', source, output, ['-pedantic']);
  }
  run(output, [], { env: smokeEnv(paths) });
}

function smokeIncludes(paths) {
  const includes = [
    path.join(paths.root, 'src/runtimes/liboliphaunt/native/src'),
    path.join(paths.buildDir, 'src/include'),
    path.join(paths.embeddedBuildDir, 'src/include'),
    path.join(paths.installDir, 'include'),
  ];
  if (process.platform === 'win32') {
    includes.push(path.join(paths.buildDir, 'src/include/port/win32'));
  }
  return includes;
}

function compileSmoke(paths) {
  requireFile(paths.libPath, 'liboliphaunt library');
  requireExecutable(paths.initdb, 'initdb');
  requireExecutable(paths.postgres, 'postgres');
  const source = path.join(paths.root, 'src/runtimes/liboliphaunt/native/smoke/liboliphaunt_smoke.c');
  const output = path.join(paths.binDir, executableName('liboliphaunt_smoke'));
  fs.mkdirSync(path.dirname(output), { recursive: true });
  if (process.platform === 'win32') {
    compileWindows(paths, source, output, smokeIncludes(paths));
  } else {
    const includeArgs = smokeIncludes(paths).flatMap((include) => ['-I', include]);
    compileUnix(paths, 'smoke', source, output, includeArgs);
  }
  return output;
}

function smokeEnv(paths) {
  const sharedPathEnv = process.platform === 'win32'
    ? { PATH: [path.dirname(paths.libPath), path.join(paths.installDir, 'bin'), process.env.PATH ?? ''].join(path.delimiter) }
    : process.platform === 'darwin'
      ? { DYLD_LIBRARY_PATH: [path.dirname(paths.libPath), process.env.DYLD_LIBRARY_PATH ?? ''].join(path.delimiter) }
      : { LD_LIBRARY_PATH: [path.dirname(paths.libPath), process.env.LD_LIBRARY_PATH ?? ''].join(path.delimiter) };
  return {
    ...process.env,
    ...sharedPathEnv,
    LIBOLIPHAUNT_PATH: paths.libPath,
    OLIPHAUNT_INITDB: paths.initdb,
    OLIPHAUNT_POSTGRES: paths.postgres,
    OLIPHAUNT_INSTALL_DIR: paths.installDir,
    OLIPHAUNT_STREAM_QUEUE_MAX_BYTES: process.env.OLIPHAUNT_STREAM_QUEUE_MAX_BYTES ?? '4096',
  };
}

function runSmoke(paths, smokeBin, rootArg) {
  const smokeRoot = process.env.OLIPHAUNT_SMOKE_ROOT
    ? path.resolve(process.env.OLIPHAUNT_SMOKE_ROOT)
    : paths.workRoot;
  if (!rootArg) {
    fs.mkdirSync(smokeRoot, { recursive: true });
  }
  const root = rootArg
    ? path.resolve(rootArg)
    : fs.mkdtempSync(path.join(smokeRoot, 'smoke.'));
  const keepRoot = Boolean(rootArg);
  const pgdata = path.join(root, '.oliphaunt-pgdata');
  const args = [normalizeForC(pgdata), normalizeForC(paths.installDir)];
  const env = smokeEnv(paths);
  try {
    run(smokeBin, args, { env });
    run(smokeBin, args, { env });
    if (!keepRoot) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  } catch (error) {
    console.error(`native smoke root: ${root}`);
    throw error;
  }
}

function checkIosCSourceSyntax(paths) {
  if (process.platform !== 'darwin') {
    return;
  }
  const sdkPath = childProcess.spawnSync('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-path'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).stdout?.trim();
  const clang = childProcess.spawnSync('xcrun', ['--sdk', 'iphonesimulator', '--find', 'clang'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).stdout?.trim();
  if (!sdkPath || !clang) {
    console.error('skipping iOS C source syntax check: iPhoneSimulator SDK is unavailable');
    return;
  }

  const sources = [
    'liboliphaunt_native.c',
    'liboliphaunt_runtime.c',
    'liboliphaunt_protocol.c',
    'liboliphaunt_bootstrap.c',
    'liboliphaunt_process.c',
    'liboliphaunt_trace.c',
    'liboliphaunt_fs.c',
    'liboliphaunt_archive.c',
    'liboliphaunt_archive_tar.c',
    'liboliphaunt_static_extensions.c',
    'liboliphaunt_builtin_extensions.c',
  ];
  for (const source of sources) {
    run(clang, [
      '-std=c11',
      '-Wall',
      '-Wextra',
      '-Werror',
      '-Wpedantic',
      '-Werror=unguarded-availability-new',
      '-fsyntax-only',
      '-target',
      'arm64-apple-ios17.0-simulator',
      '-mios-simulator-version-min=17.0',
      '-isysroot',
      sdkPath,
      '-I',
      path.join(paths.root, 'src/runtimes/liboliphaunt/native/include'),
      '-I',
      path.join(paths.root, 'src/runtimes/liboliphaunt/native/src'),
      path.join(paths.root, 'src/runtimes/liboliphaunt/native/src', source),
    ]);
  }
  console.error('iOS liboliphaunt C source syntax check passed');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = repoRoot();
  const paths = artifactPaths(root);
  console.error(`liboliphaunt host target: ${paths.target}`);
  console.error(`liboliphaunt work root: ${paths.workRoot}`);

  if (!args.smokeOnly) {
    compileAbi(paths);
    checkIosCSourceSyntax(paths);
  }
  if (!args.abiOnly) {
    const smokeBin = compileSmoke(paths);
    runSmoke(paths, smokeBin, args.root);
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
