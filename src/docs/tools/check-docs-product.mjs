#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { generateDocs, replaceVersionVariables } from './generate-content.mjs';

const args = new Set(process.argv.slice(2));
const apiReferenceRequested = args.has('--api-reference');
const result = generateDocs({
  apiMode: apiReferenceRequested ? 'release' : 'fast',
  publishApiArtifacts: apiReferenceRequested,
});
const { manifest, sdkManifest, releaseGraph, routeRecords, paths } = result;
const { repoRoot, siteDocsRoot, staticRoot, generatedMetaRoot } = paths;
const { apiSummary } = result;

function fail(message) {
  console.error(message);
  process.exit(1);
}

function requireFile(relativePath) {
  const fullPath = path.join(repoRoot, relativePath);
  if (!fs.existsSync(fullPath)) {
    fail(`required docs file missing: ${relativePath}`);
  }
  return fullPath;
}

function readText(relativePath) {
  return fs.readFileSync(requireFile(relativePath), 'utf8');
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function routeSourcePagePath(route, page) {
  const matches = ['.md', '.mdx']
    .map((extension) => path.join(route.source, `${page}${extension}`))
    .filter((relativePath) => fs.existsSync(path.join(repoRoot, relativePath)));
  if (matches.length > 1) {
    fail(`${route.id} docs contain duplicate source pages for ${page}: ${matches.join(', ')}`);
  }
  return matches[0] ?? null;
}

function routePageSet(routeId) {
  const route = manifest.routes.find((entry) => entry.id === routeId);
  return new Set(route?.page_order ?? []);
}

function sidebarPagesForRoute(route) {
  return route.sidebar_pages ?? route.page_order ?? [];
}

function gitTrackedFiles(pathspec) {
  try {
    return execFileSync('git', ['ls-files', pathspec], {
      cwd: repoRoot,
      encoding: 'utf8',
    })
      .trim()
      .split('\n')
      .filter(Boolean);
  } catch {
    return [];
  }
}

function assertNoTrackedRootProductsDocs() {
  const tracked = gitTrackedFiles('docs/products');
  if (tracked.length > 0) {
    fail(
      `public product docs must live under src/docs/content, found tracked docs/products files:\n${tracked.join('\n')}`,
    );
  }
}

function assertNoProductLocalPublicDocs() {
  const tracked = gitTrackedFiles('src/*/docs/**').filter(
    (file) => !file.startsWith('src/docs/') && /\.(md|mdx)$/u.test(file),
  );
  if (tracked.length > 0) {
    fail(
      `public SDK docs must be centralized under src/docs/content; product-local docs require an explicit package-shipped exception:\n${tracked.join('\n')}`,
    );
  }
}

function assertNoTrackedRootPublicDocs() {
  const tracked = gitTrackedFiles('docs').filter((file) => /^docs\/[^/]+\.md$/u.test(file));
  const unexpected = tracked.filter((file) => file !== 'docs/README.md');
  if (unexpected.length > 0) {
    fail(
      `top-level root docs are maintainer-only; move public docs into src/docs or docs subdirectories:\n${unexpected.join('\n')}`,
    );
  }
}

function assertRootDocsBuckets() {
  for (const dir of ['docs/architecture', 'docs/maintainers', 'docs/internal']) {
    if (!fs.existsSync(path.join(repoRoot, dir))) {
      fail(`required root docs bucket missing: ${dir}`);
    }
  }
}

function assertNoDocsMoonProject() {
  if (fs.existsSync(path.join(repoRoot, 'docs/moon.yml'))) {
    fail('docs/moon.yml must not exist; docs is the only docs project');
  }
}

function assertDocsChromeDoesNotExposeSourcePaths() {
  const pageShell = readText('src/docs/src/app/docs/[[...slug]]/page.tsx');
  if (/ViewOptionsPopover[\s\S]{0,240}\bgithubUrl\s*=/u.test(pageShell)) {
    fail(
      'public docs page actions must not expose monorepo source-file links through ViewOptionsPopover',
    );
  }
  if (pageShell.includes('src/docs/content')) {
    fail('public docs page actions must not construct GitHub links to source content paths');
  }
}

function assertUniqueRoutes() {
  const seen = new Set();
  for (const route of manifest.routes ?? []) {
    if (!route.id || !route.route || !route.source) {
      fail(`docs-manifest route is missing id, route, or source: ${JSON.stringify(route)}`);
    }
    if (route.route.startsWith('/') || route.route.includes('\\')) {
      fail(`docs route must be relative and URL-safe: ${route.id}`);
    }
    if (seen.has(route.route)) {
      fail(`duplicate docs route: ${route.route}`);
    }
    seen.add(route.route);
  }
}

function assertGeneratedFiles() {
  const referencePages = routePageSet('reference');
  const generatedReferencePages = [
    'sdk-matrix',
    'platforms',
    'extension-catalog',
    'api-reference',
    'tested-snippets',
    'artifact-provenance',
    'version-matrix',
  ]
    .filter((page) => referencePages.has(page))
    .map((page) => path.join(siteDocsRoot, 'reference', `${page}.md`));
  const required = [
    ...generatedReferencePages,
    path.join(generatedMetaRoot, 'routes.json'),
    path.join(generatedMetaRoot, 'navigation.json'),
    path.join(repoRoot, 'target', 'docs', 'generated', 'api', 'summary.json'),
    path.join(siteDocsRoot, 'meta.json'),
    path.join(siteDocsRoot, 'sdk', 'meta.json'),
  ];
  for (const file of required) {
    if (!fs.existsSync(file)) {
      fail(`generated docs artifact missing: ${path.relative(repoRoot, file)}`);
    }
  }
}

function assertGeneratedFumadocsMetadata() {
  const rootMeta = readJsonFile(path.join(siteDocsRoot, 'meta.json'));
  const expectedRootPages = ['start', 'sdk', 'learn', 'reference'];
  if (JSON.stringify(rootMeta.pages) !== JSON.stringify(expectedRootPages)) {
    fail(`root Fumadocs metadata must keep compact public nav: ${expectedRootPages.join(', ')}`);
  }
  if (!rootMeta.description || rootMeta.description.length < 48) {
    fail('root Fumadocs metadata must include a useful reader-facing description');
  }

  for (const route of manifest.routes ?? []) {
    const metaPath = path.join(siteDocsRoot, route.route, 'meta.json');
    if (!fs.existsSync(metaPath)) {
      fail(`generated Fumadocs metadata missing for route ${route.id}`);
    }
    const metadata = readJsonFile(metaPath);
    if (!metadata.title) {
      fail(`generated Fumadocs metadata missing title for route ${route.id}`);
    }
    if (!metadata.description || metadata.description === `${route.title} documentation`) {
      fail(`generated Fumadocs metadata needs a real description for route ${route.id}`);
    }
    if (!metadata.icon) {
      fail(`generated Fumadocs metadata needs an icon for route ${route.id}`);
    }
    if ((route.page_order ?? []).includes('index')) {
      if (metadata.pagesIndex !== 'index') {
        fail(`${route.id} metadata must expose index as the folder pagesIndex`);
      }
      if (metadata.pages?.includes('index')) {
        fail(`${route.id} metadata must not duplicate index as a sidebar child page`);
      }
    }
    if (route.kind === 'sdk') {
      if (metadata.pagesIndex !== 'index') {
        fail(`${route.id} SDK metadata must use the overview page as pagesIndex`);
      }
      if (!metadata.pages?.includes('guide')) {
        fail(`${route.id} SDK metadata must expose guide in the SDK folder`);
      }
      if (!metadata.pages?.includes('api-reference')) {
        fail(`${route.id} SDK metadata must expose its API reference`);
      }
      for (const page of ['api-reference']) {
        const routePath = page === 'index' ? `/${route.route}` : `/${route.route}/${page}`;
        if (!routeRecords.some((record) => record.route === routePath)) {
          fail(`${route.id} SDK metadata requires reachable ${page} route`);
        }
      }
    }
  }
}

function assertSdkSidebarPages() {
  for (const route of manifest.routes.filter((entry) => entry.kind === 'sdk')) {
    const pages = sidebarPagesForRoute(route);
    for (const required of ['index', 'guide', 'api-reference']) {
      if (!pages.includes(required)) fail(`${route.id} sidebar must expose ${required}`);
    }
    if (new Set(pages).size !== pages.length) fail(`${route.id} has duplicate sidebar pages`);
    for (const page of pages) {
      if (!route.page_order.includes(page))
        fail(`${route.id} sidebar points to undeclared ${page}`);
    }
  }
}

function assertReferenceSidebarPages() {
  const route = manifest.routes.find((entry) => entry.id === 'reference');
  if (!route) fail('docs manifest is missing reference route');
  for (const page of sidebarPagesForRoute(route)) {
    if (!route.page_order.includes(page)) fail(`reference sidebar points to undeclared ${page}`);
  }
  for (const page of [
    'sdk-products',
    'capabilities',
    'extensions',
    'releases',
    'version-matrix',
    'extension-catalog',
    'api-reference',
  ]) {
    if (!route.page_order.includes(page)) fail(`reference must keep ${page} reachable`);
  }
}

function assertNoStaleGeneratedNavigation() {
  const stale = path.join(generatedMetaRoot, 'sidebars.json');
  if (fs.existsSync(stale)) {
    fail(
      'stale generated sidebars.json must not exist; Fumadocs metadata is generated from meta.json and navigation.json',
    );
  }
}

function assertPublicContentIsMarkdownOnly() {
  const contentRoot = path.join(repoRoot, 'src/docs/content');
  const unexpected = [];
  function visit(dirPath) {
    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
        continue;
      }
      if (entry.isFile() && !/\.mdx?$/u.test(entry.name)) {
        unexpected.push(path.relative(repoRoot, fullPath));
      }
    }
  }
  visit(contentRoot);
  if (unexpected.length > 0) {
    fail(
      `public docs content may only contain Markdown/MDX pages; move data or policy files out of src/docs/content:\n${unexpected.join('\n')}`,
    );
  }
}

function collectPublicContentPages() {
  const contentRoot = path.join(repoRoot, 'src/docs/content');
  const pages = [];
  function visit(dirPath) {
    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
        continue;
      }
      if (entry.isFile() && /\.mdx?$/u.test(entry.name)) {
        pages.push(fullPath);
      }
    }
  }
  visit(contentRoot);
  return pages.sort();
}

function frontmatterValue(markdown, key) {
  const frontmatter = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/u);
  if (!frontmatter) {
    return '';
  }
  const match = frontmatter[1].match(new RegExp(`^${key}\\s*:\\s*(.+)$`, 'mu'));
  return match?.[1]?.trim().replace(/^["']|["']$/gu, '') ?? '';
}

function assertPublicContentMetadata() {
  const missing = [];
  for (const file of collectPublicContentPages()) {
    const relative = path.relative(repoRoot, file);
    const markdown = fs.readFileSync(file, 'utf8');
    const title = frontmatterValue(markdown, 'title');
    const description = frontmatterValue(markdown, 'description');
    if (!title) {
      missing.push(`${relative}: missing title frontmatter`);
    }
    if (!description) {
      missing.push(`${relative}: missing description frontmatter`);
    } else if (description.length < 24) {
      missing.push(`${relative}: description is too terse for a docs page`);
    }
  }
  if (missing.length > 0) {
    fail(`public docs pages must have explicit reader-facing metadata:\n${missing.join('\n')}`);
  }
}

function assertApplicabilityMetadata() {
  const missing = [];
  for (const record of routeRecords) {
    const markdown = fs.readFileSync(record.file, 'utf8');
    if (!record.appliesTo || !/^applies_to\s*:/mu.test(markdown)) {
      missing.push(record.source);
    }
  }
  if (missing.length > 0) {
    fail(`public docs pages must declare generated applies_to metadata:\n${missing.join('\n')}`);
  }
}

function assertLightweightVersioning() {
  const versions = readJsonFile(path.join(staticRoot, 'docs-version.json'));
  const expected = Object.fromEntries(
    Object.entries(releaseGraph.products).map(([id, product]) => [id, product.current_version]),
  );
  assert.deepEqual(versions.products, expected, 'docs version record must match release metadata');
  assert.match(versions.sourceRevision, /^[a-f0-9]{40}$/u);
  assert.equal(typeof versions.sourceDirty, 'boolean');
  const matrix = fs.readFileSync(path.join(siteDocsRoot, 'reference/version-matrix.md'), 'utf8');
  for (const [id, version] of Object.entries(expected)) {
    if (!matrix.includes(`| ${id} | ${version} |`)) fail(`version table missing ${id} ${version}`);
  }
  const sample = '@VERSION(sdk)@ / @VERSION(extension)@';
  assert.equal(
    replaceVersionVariables(sample, {
      sdk: { current_version: '1.2.3' },
      extension: { current_version: '2.0.0-rc.1' },
    }),
    '1.2.3 / 2.0.0-rc.1',
  );
  assert.throws(() => replaceVersionVariables(sample, {}), /unknown or invalid docs version/u);
  assert.throws(
    () => replaceVersionVariables('@VERSION(sdk)@', { sdk: { current_version: 'latest' } }),
    /unknown or invalid docs version/u,
  );
  for (const record of routeRecords) {
    if (fs.readFileSync(record.file, 'utf8').includes('@VERSION('))
      fail(`unresolved version in ${record.route}`);
  }
}

function assertRouteCoverage() {
  const routes = new Set(routeRecords.map((record) => record.route));
  const requiredRoutes = [];
  for (const route of manifest.routes ?? []) {
    for (const page of route.page_order ?? ['index']) {
      requiredRoutes.push(page === 'index' ? `/${route.route}` : `/${route.route}/${page}`);
    }
    for (const page of route.required_pages ?? []) {
      requiredRoutes.push(page === 'index' ? `/${route.route}` : `/${route.route}/${page}`);
    }
  }
  for (const route of requiredRoutes) {
    if (!routes.has(route)) {
      fail(`generated docs route missing: ${route}`);
    }
  }
}

function assertPublicRootLandingPages() {
  for (const route of manifest.routes.filter((entry) => entry.kind === 'public')) {
    if (!(route.page_order ?? []).includes('index')) {
      fail(`${route.id} public docs section must include an index landing page`);
    }
    const pagePath = routeSourcePagePath(route, 'index');
    if (!pagePath) {
      fail(`${route.id} public docs section is missing index.md or index.mdx`);
    }
  }
}

function stripMarkdownCodeBlocks(markdown) {
  return markdown.replace(/```[\s\S]*?```/gu, '');
}

function extractHrefTargets(text) {
  const hrefs = [];
  const stripped = stripMarkdownCodeBlocks(text);
  const markdownLinkPattern = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/gu;
  const mdxHrefPattern = /\bhref=(?:"([^"]+)"|'([^']+)')/gu;
  for (const match of stripped.matchAll(markdownLinkPattern)) {
    hrefs.push(match[1]);
  }
  for (const match of stripped.matchAll(mdxHrefPattern)) {
    hrefs.push(match[1] ?? match[2]);
  }
  return hrefs;
}

function normalizedDocsPath(href) {
  if (!href || href.startsWith('#')) {
    return null;
  }
  if (/^(?:[a-z][a-z0-9+.-]*:)?\/\//iu.test(href) || /^[a-z][a-z0-9+.-]*:/iu.test(href)) {
    return null;
  }
  if (href !== '/docs' && !href.startsWith('/docs/')) {
    return null;
  }
  const [withoutHash] = href.split('#');
  const [withoutQuery] = withoutHash.split('?');
  return withoutQuery.replace(/\/+$/u, '') || '/docs';
}

function collectSourceTextFiles(dirPath, output = []) {
  if (!fs.existsSync(dirPath)) {
    return output;
  }
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      if (!['node_modules', '.next', 'out'].includes(entry.name)) {
        collectSourceTextFiles(fullPath, output);
      }
      continue;
    }
    if (entry.isFile() && /\.(?:md|mdx|ts|tsx|js|jsx)$/iu.test(entry.name)) {
      output.push(fullPath);
    }
  }
  return output;
}

function assertDocsInternalLinksResolve() {
  const validDocsPaths = new Set(['/docs']);
  for (const record of routeRecords) {
    validDocsPaths.add(`/docs${record.route}`);
  }

  const failures = [];
  const files = [
    ...routeRecords.map((record) => record.file),
    ...collectSourceTextFiles(path.join(repoRoot, 'src/docs/src')),
  ];
  for (const file of files) {
    const relative = path.relative(repoRoot, file);
    const text = fs.readFileSync(file, 'utf8');
    for (const href of extractHrefTargets(text)) {
      const docsPath = normalizedDocsPath(href);
      if (docsPath && !validDocsPaths.has(docsPath)) {
        failures.push(`${relative}: unresolved docs link ${href}`);
      }
    }
  }
  if (failures.length > 0) {
    fail(`public docs contain unresolved internal links:\n${failures.join('\n')}`);
  }
}

function assertSdkSectionCoverage() {
  for (const route of manifest.routes.filter((entry) => entry.kind === 'sdk')) {
    const quickstart = readText(routeSourcePagePath(route, 'index'));
    if (
      !quickstart.includes(`\`\`\`${route.snippet_language}`) &&
      !(route.snippet_language === 'typescript' && quickstart.includes('```ts'))
    ) {
      fail(`${route.id} quickstart needs a language-specific code example`);
    }
    for (const page of ['guide', 'api-reference']) {
      if (!quickstart.includes(`/docs/${route.route}/${page}`))
        fail(`${route.id} quickstart must link to ${page}`);
    }
  }
}

function assertSnippetMarkers() {
  for (const route of manifest.routes.filter((entry) => entry.kind === 'sdk')) {
    const snippetPath = route.tested_snippet_path;
    const marker = route.tested_snippet_marker;
    if (!snippetPath || !marker) {
      fail(`SDK route ${route.id} must declare tested snippet path and marker`);
    }
    const source = readText(snippetPath);
    if (!source.includes(marker)) {
      fail(`${route.id} snippet source is missing marker "${marker}" in ${snippetPath}`);
    }
    const guidePath = routeSourcePagePath(route, 'index');
    if (!guidePath) {
      fail(`${route.id} guide source is missing`);
    }
    const guide = readText(guidePath);
    if (!guide.includes(`oliphaunt-snippet: ${route.id}`)) {
      fail(`${route.id} quickstart must include the manifest-owned snippet directive`);
    }
  }
}

function flattenNavigationItems(items, output = []) {
  for (const item of items ?? []) {
    if (typeof item === 'string') {
      output.push(item);
    } else if (item?.type === 'category') {
      flattenNavigationItems(item.items, output);
    }
  }
  return output;
}

function assertFumadocsMetaCoverage() {
  const rootMeta = JSON.parse(fs.readFileSync(path.join(siteDocsRoot, 'meta.json'), 'utf8'));
  for (const section of ['start', 'sdk', 'learn', 'reference']) {
    if (!(rootMeta.pages ?? []).includes(section)) {
      fail(`Fumadocs root meta is missing section ${section}`);
    }
  }
  for (const section of ['concepts', 'guides', 'releases']) {
    if ((rootMeta.pages ?? []).includes(section)) {
      fail(`Fumadocs root meta still exposes stale shallow section ${section}`);
    }
  }

  for (const route of manifest.routes ?? []) {
    const metaPath = path.join(siteDocsRoot, route.route, 'meta.json');
    if (!fs.existsSync(metaPath)) {
      fail(`Fumadocs meta missing for route ${route.route}`);
    }
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    const firstSegments = new Set(sidebarPagesForRoute(route).map((page) => page.split('/')[0]));
    for (const segment of firstSegments) {
      const present = (meta.pages ?? []).includes(segment) || meta.pagesIndex === segment;
      if (!present) {
        fail(`Fumadocs meta for ${route.route} is missing page or folder ${segment}`);
      }
    }
  }
}

function assertNavigationCoverage() {
  const navigationPath = path.join(generatedMetaRoot, 'navigation.json');
  const navigation = JSON.parse(fs.readFileSync(navigationPath, 'utf8'));
  const navigationItems = new Set(flattenNavigationItems(navigation.docs));
  const docIds = new Set(routeRecords.map((record) => record.docId));
  for (const item of navigationItems) {
    if (!docIds.has(item)) {
      fail(`generated navigation references missing doc id: ${item}`);
    }
  }
  for (const route of manifest.routes ?? []) {
    for (const page of sidebarPagesForRoute(route)) {
      const item = `${route.route}/${page}`;
      if (!navigationItems.has(item)) {
        fail(`generated navigation missing sidebar page ${item}`);
      }
    }
  }
}

function assertApiReferenceSummary({ requireGenerated = false } = {}) {
  const apiFileNames = {
    'liboliphaunt-native': 'c-abi',
    'oliphaunt-rust': 'rust',
    'oliphaunt-swift': 'swift',
    'oliphaunt-kotlin': 'kotlin',
    'oliphaunt-react-native': 'react-native',
    'oliphaunt-js': 'typescript',
    'oliphaunt-wasix-rust': 'wasix-rust',
    'oliphaunt-wasix-typescript': 'wasix-typescript',
  };
  const expected = new Set(
    manifest.routes.filter((entry) => entry.kind === 'sdk').map((entry) => entry.id),
  );
  const records = new Map((apiSummary.records ?? []).map((record) => [record.id, record]));
  for (const id of expected) {
    const record = records.get(id);
    if (!record) {
      fail(`API reference summary missing ${id}`);
    }
    if (!record.status || record.status === 'stub' || record.status === 'failed') {
      fail(`API reference status for ${id} is not truthful`);
    }
    if (!record.artifact) {
      fail(`API reference summary for ${id} is missing an artifact path`);
    }
    if (requireGenerated && record.status !== 'generated') {
      fail(
        `API reference generation did not complete for ${id}: ${record.reason ?? record.status}`,
      );
    }
  }
  for (const record of records.values()) {
    const apiPage = apiFileNames[record.id] ?? record.id;
    if (!routePageSet('reference').has(`api/${apiPage}`)) {
      continue;
    }
    const siteApiPage = path.join(siteDocsRoot, 'reference', 'api', `${apiPage}.md`);
    if (!fs.existsSync(siteApiPage)) {
      fail(`generated API reference site page missing for ${record.id}`);
    }
  }
}

function assertSdkManifestCoverage() {
  const manifestSdkIds = new Set(Object.keys(sdkManifest.sdks ?? {}));
  const required = ['rust', 'swift', 'kotlin', 'react-native', 'typescript'];
  for (const sdk of required) {
    if (!manifestSdkIds.has(sdk)) {
      fail(`SDK manifest missing ${sdk}`);
    }
  }
}

function assertReleaseGraphPolicy() {
  if (releaseGraph.products?.docs) {
    fail('docs must not be a release product');
  }
}

function assertNoNodeModulesGenerated() {
  const bad = routeRecords.filter((record) =>
    record.file.includes(`${path.sep}node_modules${path.sep}`),
  );
  if (bad.length > 0) {
    fail(`docs generator traversed node_modules:\n${bad.map((record) => record.file).join('\n')}`);
  }
}

function assertMdxComponentPagesStayMdx() {
  const componentPattern = /<(SdkChooser|Steps|Step|Callout|Tabs|Tab|Cards|Card)\b/u;
  const bad = routeRecords.filter(
    (record) => record.file.endsWith('.md') && componentPattern.test(readText(record.source)),
  );
  if (bad.length > 0) {
    fail(
      `docs pages with React components must be emitted as .mdx, not .md:\n${bad.map((record) => record.source).join('\n')}`,
    );
  }
}

function walkPublicTextFiles(dirPath, output = []) {
  if (!fs.existsSync(dirPath)) {
    return output;
  }
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      walkPublicTextFiles(fullPath, output);
      continue;
    }
    if (entry.isFile() && /\.(?:html|json|md|mdx|txt|xml)$/iu.test(entry.name)) {
      output.push(fullPath);
    }
  }
  return output;
}

function assertPublicGeneratedOutputHygiene() {
  const publicApiArtifacts = path.join(staticRoot, 'api-artifacts');
  if (!apiReferenceRequested && fs.existsSync(publicApiArtifacts)) {
    fail(
      'default docs builds must not publish API reference artifacts; run the explicit api-reference task when those artifacts are needed',
    );
  }

  const disallowed = [
    { label: 'unfinished authoring note', pattern: /\b(?:TODO|FIXME|coming soon)\b/u },
    {
      label: 'maintainer workflow leak',
      pattern:
        /docs\/(?:maintainers|internal)|release-please|\bMoon (?:production|peer|task)|runtime smoke evidence/iu,
    },
    { label: 'unresolved generated variable', pattern: /@VERSION\(|@EXTVERSION@|@MODULEPATH@/u },
    {
      label: 'generated implementation field',
      pattern: /\b(?:implementation_path|tested_snippet|reference_artifact)\b/u,
    },
    { label: 'stale route', pattern: /sdk-parity/u },
  ];
  const failures = [];
  for (const file of [...walkPublicTextFiles(siteDocsRoot), ...walkPublicTextFiles(staticRoot)]) {
    const relative = path.relative(repoRoot, file);
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      for (const rule of disallowed) {
        if (rule.pattern.test(line)) {
          failures.push(`${relative}:${index + 1}: ${rule.label}: ${line.trim()}`);
        }
      }
    });
  }
  if (failures.length > 0) {
    fail(
      `public generated docs output includes maintainer or planning language:\n${failures.join('\n')}`,
    );
  }
}

function assertReleaseReadinessDocs() {
  for (const route of manifest.routes.filter((entry) => entry.kind === 'sdk')) {
    const productId = route.product_id;
    const product = releaseGraph.products?.[productId];
    if (!product) {
      fail(`release metadata missing docs product ${productId}`);
    }
    if (product.changelog_path) {
      requireFile(product.changelog_path);
    }
    for (const page of ['index', 'guide', 'api-reference']) {
      const pagePath = routeSourcePagePath(route, page);
      if (!pagePath) {
        fail(`${productId} release docs are missing ${page}.md or ${page}.mdx`);
      }
      const markdown = readText(pagePath);
      if (!markdown.includes('# ')) {
        fail(`${productId} release docs page ${page}.md is missing a title heading`);
      }
    }
  }
}

function assertSdkInstallReleaseContracts() {
  const contracts = [
    ['oliphaunt-rust', 'sdk/rust/index.mdx', 'oliphaunt = "'],
    ['oliphaunt-swift', 'sdk/swift/index.mdx', 'exact: "'],
    ['oliphaunt-kotlin', 'sdk/kotlin/index.mdx', 'dev.oliphaunt:oliphaunt-android:'],
    ['oliphaunt-react-native', 'sdk/react-native/index.mdx', '@oliphaunt/react-native@'],
    ['oliphaunt-js', 'sdk/typescript/index.mdx', '@oliphaunt/ts@'],
    ['oliphaunt-wasix-rust', 'sdk/wasix-rust/index.mdx', 'oliphaunt-wasix = "'],
    ['oliphaunt-wasix-ts', 'sdk/wasix-typescript/index.mdx', '@oliphaunt/wasix-ts@'],
  ];
  for (const [id, file, prefix] of contracts) {
    const authored = readText(`src/docs/content/${file}`);
    if (!authored.includes(`@VERSION(${id})@`)) fail(`${file} must use its centralized version`);
    const generated = fs.readFileSync(path.join(siteDocsRoot, file), 'utf8');
    if (!generated.includes(prefix + releaseGraph.products[id].current_version))
      fail(`${file} install version does not match ${id}`);
  }
  const kotlin = fs.readFileSync(path.join(siteDocsRoot, 'sdk/kotlin/index.mdx'), 'utf8');
  if (kotlin.includes('dev.oliphaunt:oliphaunt:'))
    fail('Kotlin docs advertise an unpublished coordinate');
  if (
    !kotlin.includes(
      `id("dev.oliphaunt.android") version "${releaseGraph.products['oliphaunt-kotlin'].current_version}"`,
    )
  )
    fail('Android plugin and SDK versions must match');
}

assertNoTrackedRootProductsDocs();
assertNoProductLocalPublicDocs();
assertNoTrackedRootPublicDocs();
assertRootDocsBuckets();
assertNoDocsMoonProject();
assertDocsChromeDoesNotExposeSourcePaths();
assertUniqueRoutes();
assertGeneratedFiles();
assertGeneratedFumadocsMetadata();
assertSdkSidebarPages();
assertReferenceSidebarPages();
assertNoStaleGeneratedNavigation();
assertPublicContentIsMarkdownOnly();
assertPublicContentMetadata();
assertApplicabilityMetadata();
assertLightweightVersioning();
assertRouteCoverage();
assertPublicRootLandingPages();
assertDocsInternalLinksResolve();
assertSdkSectionCoverage();
assertSnippetMarkers();
assertSdkManifestCoverage();
assertReleaseGraphPolicy();
assertNoNodeModulesGenerated();
assertMdxComponentPagesStayMdx();
assertPublicGeneratedOutputHygiene();
assertFumadocsMetaCoverage();
assertNavigationCoverage();
assertApiReferenceSummary({ requireGenerated: apiReferenceRequested });
assertSdkInstallReleaseContracts();

if (args.has('--release')) {
  assertReleaseReadinessDocs();
}

if (args.has('--snippets')) {
  assertSnippetMarkers();
}

console.log(`docs product checks passed (${routeRecords.length} routes)`);
