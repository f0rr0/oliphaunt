import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { hostRuntimeEnvironment } from '../native/host-runtime-test-helpers.mts';

/** Match the concrete executor to the canonical native runtime artifact. */
export function nativeSeedHost(
  artifact: { target: string; npm_os: string; npm_cpu: string; library_relative_path: string },
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch,
) {
  assert(['linux', 'darwin', 'win32'].includes(platform), 'unsupported native seed executor');
  assert.equal(artifact.npm_os, platform, 'seed runtime must match the executor OS');
  assert.equal(artifact.npm_cpu, architecture, 'seed runtime must match the executor CPU');
  assert(
    /^(?:bin|lib)\/[A-Za-z0-9_.-]+$/u.test(artifact.library_relative_path),
    'native seed requires the canonical desktop runtime library path',
  );
  return {
    target: artifact.target,
    executableSuffix: platform === 'win32' ? '.exe' : '',
    memoryType: platform === 'win32' ? 'windows' : 'mmap',
    libraryRelativePath: artifact.library_relative_path,
  };
}

export function readSpecification(extraArguments = 0) {
  assert.equal(
    process.argv.length,
    3 + extraArguments,
    extraArguments
      ? 'expected declared action arguments'
      : 'expected one declared action specification',
  );
  return JSON.parse(readFileSync(process.argv[2], 'utf8'));
}

export function privateWork(output: string): string {
  mkdirSync(path.dirname(output), { recursive: true });
  return mkdtempSync(path.join(path.dirname(output), '.resource-'));
}

export function materializeInputs(inputs: Record<string, string>, root: string): string {
  for (const [relative, source] of Object.entries(inputs)) {
    assert(
      relative &&
        !path.isAbsolute(relative) &&
        !relative.split('/').some((part) => ['', '.', '..'].includes(part)),
      'unsafe declared resource input path',
    );
    const destination = path.join(root, relative);
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(source, destination);
  }
  return root;
}

export function materializeArchive(source: string, root: string): string {
  const name = path.basename(source);
  materializeInputs({ [name]: source }, root);
  return path.join(root, name);
}

export function seedEnvironment(
  runtime: string,
  root: string,
  icuData?: string,
  platform: NodeJS.Platform = process.platform,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  // Keep only the Windows OS loader root; ambient build/locale variables must
  // not affect a distributed cluster's bootstrap or satisfy a missing carrier.
  const systemRoot = Object.entries(source).find(([key]) => key.toLowerCase() === 'systemroot');
  const osEnvironment = platform === 'win32' && systemRoot ? { SystemRoot: systemRoot[1] } : {};
  const env = hostRuntimeEnvironment(runtime, root, platform, osEnvironment);
  delete env.ICU_DATA;
  return {
    ...env,
    HOME: root,
    TEMP: root,
    TMP: root,
    LANG: 'C',
    LC_ALL: 'C',
    TZ: 'UTC',
    PGTZ: 'UTC',
    PGSERVICEFILE: path.join(root, 'no-service'),
    PGPASSFILE: path.join(root, 'no-password'),
    OLIPHAUNT_INTERNAL_SKIP_SYSTEM_COLLATION_DISCOVERY: '1',
    ...(icuData === undefined
      ? { OLIPHAUNT_INTERNAL_SKIP_ICU_DISCOVERY: '1' }
      : {
          ICU_DATA: icuData,
          OLIPHAUNT_INTERNAL_ICU_READY: '1',
        }),
  };
}

export function run(binary: string, args: string[], env: NodeJS.ProcessEnv, cwd: string): string {
  const result = Bun.spawnSync([binary, ...args], { env, cwd, stdout: 'pipe', stderr: 'pipe' });
  assert.equal(
    result.exitCode,
    0,
    `${binary}: ${result.stderr.toString()}\n${result.stdout.toString()}`,
  );
  return result.stdout.toString();
}
