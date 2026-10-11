import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export type QualitySource = { path: string; source: string };

/** Preserve repository paths so the conventional Biome and Git exclusions apply. */
export function runBiome(
  binary: string,
  mode: 'format' | 'lint',
  sources: QualitySource[],
  options: { capture?: boolean } = {},
) {
  if (mode !== 'format' && mode !== 'lint') throw new Error('Expected Biome format or lint');
  const root = mkdtempSync(join(process.env.TEST_TMPDIR ?? tmpdir(), 'oliphaunt-biome-'));
  try {
    const paths = new Set<string>();
    for (const file of sources) {
      if (
        !file.path ||
        file.path.includes('\\') ||
        file.path.startsWith('/') ||
        file.path.split('/').some((part) => !part || part === '.' || part === '..') ||
        paths.has(file.path)
      )
        throw new Error(`Invalid or duplicate declared quality source: ${file.path}`);
      paths.add(file.path);
      const target = join(root, file.path);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(file.source, target);
    }
    if (!paths.has('biome.json') || !paths.has('.gitignore'))
      throw new Error('Biome source checks require conventional biome.json and .gitignore');
    const result = spawnSync(
      resolve(binary),
      [
        mode,
        ...(mode === 'lint' ? ['--diagnostic-level=error'] : []),
        '--no-errors-on-unmatched',
        `--vcs-root=${root}`,
        '.',
      ],
      { cwd: root, stdio: options.capture ? 'pipe' : 'inherit', encoding: 'utf8' },
    );
    if (result.error) throw result.error;
    if (result.signal || result.status === null)
      throw new Error(`Biome ${mode} terminated without an exit status`);
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const [binary, mode, ...files] = Bun.argv.slice(2);
  if (!binary || (mode !== 'format' && mode !== 'lint') || files.length % 2)
    throw new Error('Expected Biome binary, mode, and declared path/File pairs');
  process.exitCode = runBiome(
    binary,
    mode,
    Array.from({ length: files.length / 2 }, (_, index) => ({
      path: files[index * 2],
      source: files[index * 2 + 1],
    })),
  ).status;
}
