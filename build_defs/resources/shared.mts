import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import path from 'node:path';

export function readSpecification() {
  assert.equal(process.argv.length, 3, 'expected one declared action specification');
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
): NodeJS.ProcessEnv {
  return {
    PATH: '/usr/bin:/bin',
    HOME: root,
    LANG: 'C',
    LC_ALL: 'C',
    TZ: 'UTC',
    PGTZ: 'UTC',
    LD_LIBRARY_PATH: path.join(runtime, 'lib'),
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
