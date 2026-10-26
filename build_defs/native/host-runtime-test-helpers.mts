import assert from 'node:assert/strict';
import {
  chmodSync,
  createReadStream,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { dirname, join, posix, win32 } from 'node:path';
import {
  DEFAULT_PORTABLE_ARCHIVE_LIMITS,
  readPortableTarStream,
} from '../../tools/packaging/portable-archive.mts';

export async function extractNativePayload(archive: string, destination: string): Promise<void> {
  const file = statSync(archive);
  assert(
    file.isFile() && file.size > 0 && file.size <= DEFAULT_PORTABLE_ARCHIVE_LIMITS.maxArchiveBytes,
    'expected a bounded regular native payload archive',
  );
  mkdirSync(dirname(destination), { recursive: true });
  const staging = mkdtempSync(join(dirname(destination), '.native-payload-'));
  const input = createReadStream(archive);
  try {
    // Payloads are already plain tar. Keep the existing bounded reader without
    // recompressing or retaining an additional copy of the runtime in memory.
    const entries = await readPortableTarStream(input, archive, {}, { root: staging });
    for (const entry of [...entries.values()].reverse())
      if (entry.isDirectory) chmodSync(join(staging, entry.name), entry.mode);
    chmodSync(staging, 0o755);
    rmSync(destination, { recursive: true, force: true });
    renameSync(staging, destination);
  } finally {
    input.destroy();
    rmSync(staging, { recursive: true, force: true });
  }
}

export function hostRuntimeEnvironment(
  runtime: string,
  root: string,
  platform: NodeJS.Platform = process.platform,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  assert(
    ['linux', 'darwin', 'win32'].includes(platform),
    `unsupported native smoke host ${platform}`,
  );
  const env = { ...source };
  for (const key of Object.keys(env))
    if (
      /^(?:LD_|DYLD_|PG|OLIPHAUNT_|LIBOLIPHAUNT_)/iu.test(key) ||
      /^(?:PATH|INCLUDE|LIB|LIBPATH|RUNFILES_DIR|RUNFILES_MANIFEST_FILE|TEST_SRCDIR)$/iu.test(key)
    )
      delete env[key];
  const paths = platform === 'win32' ? win32 : posix;
  if (platform === 'win32') {
    const systemRoot = Object.entries(source).find(
      ([key]) => key.toLowerCase() === 'systemroot',
    )?.[1];
    assert(systemRoot && win32.isAbsolute(systemRoot), 'Windows smoke requires the OS SystemRoot');
    env.PATH = [win32.join(runtime, 'bin'), win32.join(systemRoot, 'System32'), systemRoot].join(
      ';',
    );
  } else {
    env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
    env[platform === 'darwin' ? 'DYLD_LIBRARY_PATH' : 'LD_LIBRARY_PATH'] = posix.join(
      runtime,
      'lib',
    );
    if (platform === 'darwin') env.DYLD_FALLBACK_LIBRARY_PATH = '';
  }
  env.ICU_DATA = paths.join(runtime, 'share', 'icu');
  env.PGSERVICEFILE = paths.join(root, 'no-service');
  env.PGPASSFILE = paths.join(root, 'no-password');
  return env;
}

export function runHostBinary(
  binary: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  output: 'pipe' | 'inherit' = 'pipe',
): string {
  const result = Bun.spawnSync([binary, ...args], { env, cwd, stdout: output, stderr: output });
  assert.equal(
    result.exitCode,
    0,
    `${binary}: ${result.stderr?.toString() ?? ''}\n${result.stdout?.toString() ?? ''}`,
  );
  return result.stdout?.toString() ?? '';
}

export function assertMissingHostRuntime(
  result: { exitCode: number; stderr: Uint8Array },
  library: string,
  platform: NodeJS.Platform = process.platform,
): void {
  const diagnostic = Buffer.from(result.stderr).toString();
  if (platform === 'win32') {
    // Bun exposes the low byte of Windows STATUS_DLL_NOT_FOUND (0xc0000135).
    assert.equal(result.exitCode, 0x35, 'consumer resolved the removed candidate DLL');
  } else if (platform === 'darwin') {
    assert.notEqual(result.exitCode, 0, 'consumer resolved the removed candidate dylib');
    assert(
      diagnostic.includes(library) &&
        /Library not loaded|library not found|image not found/iu.test(diagnostic),
      `expected the dyld missing-candidate diagnostic: ${diagnostic}`,
    );
  } else {
    assert.equal(result.exitCode, 127, 'consumer resolved the removed candidate shared library');
    assert(
      diagnostic.includes(library),
      `expected the missing-candidate loader diagnostic: ${diagnostic}`,
    );
  }
}

export function missingHostModuleError(
  response: string,
  name: string,
  platform: NodeJS.Platform = process.platform,
  ownerRoots: readonly string[] = [],
): boolean {
  const diagnostics = response.matchAll(
    /could not (?:access file|load library) ([^\n]*(?:\n[ \t]+(?:Referenced from:|Reason:|Library not loaded:)[^\n]*)*)/gu,
  );
  return [...diagnostics].some((match) => {
    const diagnostic = match[1];
    if (!/no such file|image not found|The specified module could not be found/iu.test(diagnostic))
      return false;
    const filenames = diagnostic.split(/[\s"':(),]+/u).map((path) => path.split(/[\\/]/u).at(-1));
    const identifies = (filename: string) => {
      const stem = filename.replace(/[.](?:so|dylib|dll)$/u, '');
      return filenames.includes(filename) || filenames.includes(stem);
    };
    // Windows reports the importing PG module when an imported DLL is absent.
    return identifies(name) || (platform === 'win32' && ownerRoots.some(identifies));
  });
}
