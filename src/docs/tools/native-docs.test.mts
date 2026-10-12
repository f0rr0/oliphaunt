import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { type DocsPackage, docsBuildId, stageDocsSources } from './native-docs.mts';

const scratch: string[] = [];
afterEach(() => {
  for (const root of scratch.splice(0)) rmSync(root, { recursive: true, force: true });
});

function directory() {
  const root = mkdtempSync(path.join(process.env.TEST_TMPDIR ?? tmpdir(), 'docs-native-inputs-'));
  scratch.push(root);
  return root;
}

function file(root: string, name: string, content: string, mode = 0o644) {
  const target = path.join(root, name);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content, { mode });
  return target;
}

test('source staging validates the entire declared input set before writing files', () => {
  const source = directory();
  const destination = directory();
  const input = file(source, 'valid.ts', 'export const answer = 42;');
  file(destination, 'src/docs/valid.ts', 'previous');
  for (const pathName of ['../escape', '/absolute', 'src/../escape', 'src\\escape']) {
    expect(() =>
      stageDocsSources(destination, [
        { path: 'src/docs/valid.ts', source: input },
        { path: pathName, source: input },
      ]),
    ).toThrow('Invalid declared docs path');
    expect(readFileSync(path.join(destination, 'src/docs/valid.ts'), 'utf8')).toBe('previous');
  }
  expect(() =>
    stageDocsSources(destination, [
      { path: 'src/docs/valid.ts', source: input },
      { path: 'src/docs/valid.ts', source: input },
    ]),
  ).toThrow('Duplicate declared docs path');
  const link = path.join(source, 'linked.ts');
  symlinkSync(input, link);
  stageDocsSources(destination, [{ path: 'src/docs/linked.ts', source: link }]);
  expect(readFileSync(path.join(destination, 'src/docs/linked.ts'), 'utf8')).toContain('42');
  expect(() => stageDocsSources(destination, [{ path: 'src/docs/not-a-file', source }])).toThrow(
    'regular file',
  );
  stageDocsSources(destination, [{ path: 'src/docs/valid.ts', source: input }]);
  expect(readFileSync(path.join(destination, 'src/docs/valid.ts'), 'utf8')).toContain('42');
});

test('build IDs follow delivered pages and declared package identities, independently of scratch paths', () => {
  const first = directory();
  const second = directory();
  const a = file(first, 'src.tsx', 'export default function Page() { return null; }');
  const b = file(second, 'src.tsx', readFileSync(a, 'utf8'));
  const left = directory();
  const right = directory();
  file(left, 'start/index.mdx', '# Start\n');
  file(right, 'start/index.mdx', '# Start\n');
  const row: DocsPackage = {
    package: 'docs-fixture',
    version: '1.0.0',
    integrity: `sha512-${Buffer.alloc(64).toString('base64')}`,
    dependencies: {},
  };
  const options = { basePath: '', siteUrl: 'https://oliphaunt.dev' };
  const baseline = docsBuildId(
    [{ path: 'src/docs/src/page.tsx', source: a }],
    left,
    { a: row },
    options,
  );
  expect(
    docsBuildId([{ path: 'src/docs/src/page.tsx', source: b }], right, { a: row }, options),
  ).toBe(baseline);
  file(right, 'start/index.mdx', '# Changed\n');
  expect(
    docsBuildId([{ path: 'src/docs/src/page.tsx', source: b }], right, { a: row }, options),
  ).not.toBe(baseline);
  expect(
    docsBuildId(
      [{ path: 'src/docs/src/page.tsx', source: a }],
      left,
      { a: { ...row, version: '2.0.0' } },
      options,
    ),
  ).not.toBe(baseline);
  expect(
    docsBuildId(
      [{ path: 'src/docs/src/page.tsx', source: a }],
      left,
      { a: row },
      { ...options, basePath: '/preview' },
    ),
  ).not.toBe(baseline);
  const tool = file(first, 'node', 'pinned node identity');
  const withTool = docsBuildId(
    [{ path: 'src/docs/src/page.tsx', source: a }],
    left,
    { a: row },
    options,
    [{ path: 'node', source: tool }],
  );
  expect(withTool).not.toBe(baseline);
  file(first, 'node', 'another pinned node identity');
  expect(
    docsBuildId([{ path: 'src/docs/src/page.tsx', source: a }], left, { a: row }, options, [
      { path: 'node', source: tool },
    ]),
  ).not.toBe(withTool);
});

test('build IDs retain logical names across sandbox tree and leaf symlink transport', () => {
  const regular = directory();
  const input = file(regular, 'sdk/index.mdx', '# Declared content\n');
  const leaves = directory();
  mkdirSync(path.join(leaves, 'sdk'));
  symlinkSync(input, path.join(leaves, 'sdk/index.mdx'));
  const root = path.join(directory(), 'site-docs');
  symlinkSync(regular, root, 'dir');
  const options = { basePath: '', siteUrl: 'https://oliphaunt.dev' };
  const expected = docsBuildId([], regular, {}, options);
  expect(docsBuildId([], leaves, {}, options)).toBe(expected);
  expect(docsBuildId([], root, {}, options)).toBe(expected);
});
