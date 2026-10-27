import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { prepareWindowsSources, type WindowsSourceInputs } from './windows_source_inputs.mts';

const directories: string[] = [];
function fixture(): { root: string; spec: WindowsSourceInputs } {
  const root = mkdtempSync(
    path.join(process.env.TEST_TMPDIR ?? tmpdir(), 'windows-extension-inputs-'),
  );
  directories.push(root);
  const source = path.join(root, 'uuid.c');
  writeFileSync(
    source,
    '// pinned source café\r\n#define EPOCH_DIFF_USECS ((POSTGRES_EPOCH_JDATE - UNIX_EPOCH_JDATE) * USECS_PER_DAY)\r\n',
  );
  return {
    root,
    spec: {
      extension: 'pg_uuidv7',
      files: [{ name: 'pg_uuidv7.c', source, output: path.join(root, 'declared/pg_uuidv7.c') }],
      headers: [],
    },
  };
}
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

test('declared source transformation preserves original files and unchanged nested input bytes', () => {
  const { root, spec } = fixture();
  const original = readFileSync(spec.files[0].source);
  const nested = path.join(root, 'header');
  const bytes = Buffer.from('\ufeff// unrelated source café\r\n');
  writeFileSync(nested, bytes);
  spec.files.push({
    name: 'include/nested/header.h',
    source: nested,
    output: path.join(root, 'declared/include/nested/header.h'),
  });
  prepareWindowsSources(spec);
  expect(readFileSync(spec.files[0].source)).toEqual(original);
  expect(readFileSync(spec.files[0].output, 'utf8')).toContain(
    'GetCurrentTimestamp() + EPOCH_DIFF_USECS',
  );
  expect(readFileSync(spec.files[1].output)).toEqual(bytes);
});

test('missing, ambiguous or malformed source rejects before any output is written', () => {
  for (const bytes of [
    Buffer.from('missing anchor\n'),
    Buffer.from([0xff]),
    Buffer.from(
      '#define EPOCH_DIFF_USECS ((POSTGRES_EPOCH_JDATE - UNIX_EPOCH_JDATE) * USECS_PER_DAY)\n'.repeat(
        2,
      ),
    ),
  ]) {
    const { spec } = fixture();
    writeFileSync(spec.files[0].source, bytes);
    expect(() => prepareWindowsSources(spec)).toThrow();
    expect(() => readFileSync(spec.files[0].output)).toThrow();
  }
});

test('declared output names, membership and compatibility headers are checked before copying', () => {
  const unknown = fixture();
  unknown.spec.extension = 'unreviewed';
  expect(() => prepareWindowsSources(unknown.spec)).toThrow('existing pinned');
  for (const name of ['', '../escape', '/absolute', 'dir//empty', 'dir\\file']) {
    const { spec } = fixture();
    spec.files[0].name = name;
    expect(() => prepareWindowsSources(spec)).toThrow('safe relative');
  }
  const { spec } = fixture();
  spec.files.push({ ...spec.files[0] });
  expect(() => prepareWindowsSources(spec)).toThrow('duplicate');
  spec.files.pop();
  spec.headers.push({ name: 'invented.h', output: spec.files[0].output });
  expect(() => prepareWindowsSources(spec)).toThrow('duplicate');
  spec.headers[0].output += '.other';
  expect(() => prepareWindowsSources(spec)).toThrow('shared source recipe');
});
