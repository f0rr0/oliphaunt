import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkDocsProduct } from './check-docs-product.mts';
import { generateDocs, readDocsProvenance } from './generate-content.mts';

const scratch: string[] = [];
afterEach(() => {
  for (const root of scratch.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const repoRoot = mkdtempSync(path.join(process.env.TEST_TMPDIR ?? tmpdir(), 'docs-inputs-'));
  scratch.push(repoRoot);
  function write(relative: string, contents: string | object) {
    const file = path.join(repoRoot, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, typeof contents === 'string' ? contents : JSON.stringify(contents));
    return file;
  }
  const groups = ['start', 'sdk', 'learn', 'reference'];
  write(
    'src/docs/docs-manifest.toml',
    groups
      .map(
        (id) => `[[routes]]
id = "${id}"
title = "${id}"
kind = "public"
route = "${id}"
source = "src/docs/content/${id}"
page_order = ${id === 'reference' ? '["index", "extensions"]' : '["index"]'}
`,
      )
      .join('\n'),
  );
  for (const id of groups)
    write(`src/docs/content/${id}/index.mdx`, `# ${id}\n\n[Start](/docs/start)\n`);
  write('src/docs/content/reference/extensions.mdx', '# Extensions\n');
  write('src/docs/src/links.tsx', '<a href="/docs/reference/version-matrix">Releases</a>');
  write('release-please-config.json', { packages: { 'src/sdk': { component: 'sdk' } } });
  write('.release-please-manifest.json', { 'src/sdk': '9.0.0' });
  write('src/extensions/generated/extensions.catalog.json', { extensions: [] });
  const releasesFile = write('releases.json', [
    {
      tag_name: 'sdk-v1.2.3',
      html_url: 'https://github.com/f0rr0/oliphaunt/releases/tag/sdk-v1.2.3',
      draft: false,
      prerelease: false,
      published_at: '2026-09-11T00:00:00Z',
    },
  ]);
  const provenanceFile = write('provenance.json', { sourceRevision: 'a'.repeat(40), dirty: false });
  return { repoRoot, releasesFile, provenanceFile, write };
}

function contents(root: string) {
  const files: Record<string, string> = {};
  function visit(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else files[path.relative(root, file)] = readFileSync(file, 'utf8');
    }
  }
  visit(root);
  return files;
}

test('declared snapshots generate identical relocatable content without a Git checkout', async () => {
  const first = fixture();
  const second = fixture();
  const left = await generateDocs(first);
  const right = await generateDocs(second);
  expect(contents(left.paths.generatedRoot)).toEqual(contents(right.paths.generatedRoot));
  checkDocsProduct(left);
  for (const record of left.routeRecords) {
    expect(path.isAbsolute(record.file)).toBe(false);
    expect(record.file).toStartWith('site-docs/');
  }
  expect(
    JSON.parse(readFileSync(path.join(left.paths.staticRoot, 'docs-version.json'), 'utf8')),
  ).toEqual({
    sourceRevision: 'a'.repeat(40),
    dirty: false,
    products: { sdk: { version: '9.0.0' } },
  });
  const releases = readFileSync(
    path.join(left.paths.siteDocsRoot, 'reference/version-matrix.md'),
    'utf8',
  );
  expect(releases).toContain('[1.2.3]');
  expect(releases).not.toContain('9.0.0');
  expect(contents(left.paths.generatedRoot)['generated/build-metadata.json']).not.toContain(
    'generatedAt',
  );
});

test('a relocated output directory keeps route metadata and source-link checks valid', async () => {
  const inputs = fixture();
  const generatedRoot = path.join(inputs.repoRoot, 'target/relocated-docs');
  const result = await generateDocs({ ...inputs, generatedRoot });
  checkDocsProduct(result);
  inputs.write('src/docs/src/links.tsx', '<a href="/docs/missing">Broken</a>');
  expect(() => checkDocsProduct(result)).toThrow('unresolved docs link /docs/missing');
});

test('explicit provenance rejects volatile, missing and malformed fields', () => {
  const inputs = fixture();
  for (const value of [
    null,
    [],
    {},
    { sourceRevision: 'main', dirty: false },
    { sourceRevision: ['a'.repeat(40)], dirty: false },
    { sourceRevision: 'a'.repeat(40), dirty: 'false' },
    { sourceRevision: 'a'.repeat(40), dirty: false, generatedAt: 'now' },
  ]) {
    inputs.write('provenance.json', JSON.stringify(value));
    expect(() => readDocsProvenance(inputs.provenanceFile)).toThrow('exact source revision');
  }
});

test('bad declared inputs fail before deleting a previous generated result', async () => {
  const inputs = fixture();
  const result = await generateDocs(inputs);
  const before = contents(result.paths.generatedRoot);
  inputs.write('releases.json', {});
  await expect(generateDocs(inputs)).rejects.toThrow('GitHub releases array');
  expect(contents(result.paths.generatedRoot)).toEqual(before);
  inputs.write('releases.json', [
    {
      tag_name: 'sdk-v1.2.3',
      html_url: 'javascript:alert(1)',
      draft: false,
      prerelease: false,
      published_at: '2026-09-11',
    },
  ]);
  await expect(generateDocs(inputs)).rejects.toThrow('invalid GitHub release record');
  expect(contents(result.paths.generatedRoot)).toEqual(before);
});

test('an empty completed-release snapshot never advertises a checkout candidate', async () => {
  const inputs = fixture();
  inputs.write('releases.json', []);
  const result = await generateDocs(inputs);
  const releases = readFileSync(
    path.join(result.paths.siteDocsRoot, 'reference/version-matrix.md'),
    'utf8',
  );
  expect(releases).toContain('No completed release');
  expect(releases).not.toContain('9.0.0');
});

test('declared output and route paths cannot overwrite source inputs', async () => {
  const inputs = fixture();
  for (const generatedRoot of [
    inputs.repoRoot,
    path.dirname(inputs.repoRoot),
    path.join(inputs.repoRoot, 'src/docs'),
  ])
    await expect(generateDocs({ ...inputs, generatedRoot })).rejects.toThrow(
      'outside source inputs',
    );
  const manifest = readFileSync(path.join(inputs.repoRoot, 'src/docs/docs-manifest.toml'), 'utf8');
  for (const route of ['../escape', '/absolute', 'start/../../escape']) {
    inputs.write(
      'src/docs/docs-manifest.toml',
      manifest.replace('route = "start"', `route = "${route}"`),
    );
    await expect(generateDocs(inputs)).rejects.toThrow('repository-relative path');
  }
});

test('missing required pages fail before producing a misleading partial site', async () => {
  const inputs = fixture();
  const manifest = readFileSync(path.join(inputs.repoRoot, 'src/docs/docs-manifest.toml'), 'utf8');
  inputs.write(
    'src/docs/docs-manifest.toml',
    manifest.replace(
      'page_order = ["index"]',
      'page_order = ["index"]\nrequired_pages = ["missing"]',
    ),
  );
  await expect(generateDocs(inputs)).rejects.toThrow('missing required docs page missing');
});
