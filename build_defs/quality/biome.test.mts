import { expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runBiome } from './biome.mts';

const binary =
  process.env.OLIPHAUNT_BIOME_BINARY ??
  (process.env.OLIPHAUNT_QUALITY_RUNFILES && process.env.OLIPHAUNT_BIOME_RUNFILE
    ? join(process.env.OLIPHAUNT_QUALITY_RUNFILES, process.env.OLIPHAUNT_BIOME_RUNFILE)
    : undefined);
if (!binary) throw new Error('Biome regressions require the declared formatter binary');
const config = readFileSync(new URL('../../biome.json', import.meta.url), 'utf8');

function fixture(files: Record<string, string>, check: (root: string) => void) {
  const root = mkdtempSync(join(process.env.TEST_TMPDIR ?? tmpdir(), 'oliphaunt-biome-fixture-'));
  try {
    for (const [path, content] of Object.entries({
      'biome.json': config,
      '.gitignore': '',
      ...files,
    })) {
      const file = join(root, path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content);
      chmodSync(file, 0o444);
    }
    check(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function check(root: string, mode: 'format' | 'lint', paths: string[]) {
  return runBiome(
    binary!,
    mode,
    ['biome.json', '.gitignore', ...paths].map((path) => ({ path, source: join(root, path) })),
    { capture: true },
  );
}

test('checks declared bytes and preserves read-only sources', () => {
  fixture({ 'src/bad.ts': 'export const value=1;\n' }, (root) => {
    const before = readFileSync(join(root, 'src/bad.ts'));
    expect(check(root, 'format', ['src/bad.ts']).status).toBe(1);
    expect(readFileSync(join(root, 'src/bad.ts'))).toEqual(before);
    const lint = check(root, 'lint', ['src/bad.ts']);
    expect(lint.status).toBe(0);
  });
});

test('applies conventional Biome directory exclusions and root/nested Git ignores', () => {
  fixture(
    {
      '.gitignore': '/root-ignored.ts\n',
      'src/.gitignore': 'local-ignored.ts\n',
      'src/good.ts': 'export const value = 1;\n',
      'root-ignored.ts': 'syntax error \\\n',
      'src/local-ignored.ts': 'syntax error \\\n',
      'src/generated/bad.ts': 'syntax error \\\n',
      'src/fixtures/bad.ts': 'syntax error \\\n',
    },
    (root) => {
      const paths = [
        'src/.gitignore',
        'src/good.ts',
        'root-ignored.ts',
        'src/local-ignored.ts',
        'src/generated/bad.ts',
        'src/fixtures/bad.ts',
      ];
      expect(check(root, 'format', paths).status).toBe(0);
      expect(check(root, 'lint', paths).status).toBe(0);
    },
  );
});

test('detects actual lint errors and refuses path escape or duplicate members', () => {
  fixture({ 'src/bad.ts': 'export const value = undeclaredIdentifier;\n' }, (root) => {
    expect(check(root, 'lint', ['src/bad.ts']).status).toBe(1);
    expect(() => check(root, 'format', ['../outside.ts'])).toThrow('Invalid or duplicate');
    expect(() => check(root, 'format', ['src/bad.ts', 'src/bad.ts'])).toThrow(
      'Invalid or duplicate',
    );
  });
});
