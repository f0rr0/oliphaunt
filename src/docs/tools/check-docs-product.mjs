#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { generateDocs } from './generate-content.mjs';

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

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function escapeMarkdownCell(value) {
  return String(value ?? '')
    .replaceAll('\\', '\\\\')
    .replaceAll('|', '\\|')
    .replaceAll('\n', ' ');
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
    path.join(staticRoot, 'llms.txt'),
    path.join(staticRoot, 'llms-full.txt'),
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
      if (metadata.pages?.includes('api-reference')) {
        fail(
          `${route.id} SDK metadata must keep API Reference out of the primary sidebar; link it from Reference and SDK page bodies`,
        );
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
  const expectedOrder = [
    'oliphaunt-rust',
    'oliphaunt-swift',
    'oliphaunt-kotlin',
    'oliphaunt-react-native',
    'oliphaunt-js',
    'oliphaunt-wasix',
    'liboliphaunt-native',
  ];
  const actualOrder = manifest.routes
    .filter((entry) => entry.kind === 'sdk')
    .map((entry) => entry.id);
  if (JSON.stringify(actualOrder) !== JSON.stringify(expectedOrder)) {
    fail(`SDK route order must stay app-developer first: ${expectedOrder.join(' -> ')}`);
  }

  for (const route of manifest.routes.filter((entry) => entry.kind === 'sdk')) {
    const expected =
      route.id === 'oliphaunt-react-native'
        ? ['index', 'guide', 'architecture']
        : route.id === 'oliphaunt-wasix'
          ? ['index', 'guide', 'runtime', 'dump-restore']
          : ['index', 'guide'];
    const actual = route.sidebar_pages ?? [];
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      fail(`${route.id} sidebar_pages must be ${expected.join(', ')}`);
    }
    if (actual.includes('api-reference')) {
      fail(`${route.id} sidebar_pages must not expose API Reference as a primary SDK page`);
    }
  }
}

function assertReferenceSidebarPages() {
  const route = manifest.routes.find((entry) => entry.id === 'reference');
  if (!route) {
    fail('docs manifest is missing reference route');
  }
  const expected = ['index', 'capabilities', 'extensions', 'performance'];
  const actual = route.sidebar_pages ?? [];
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`reference sidebar_pages must stay focused: ${expected.join(', ')}`);
  }
  for (const reachable of [
    'sdk-products',
    'releases',
    'version-matrix',
    'extension-catalog',
    'api-reference',
  ]) {
    if (!(route.page_order ?? []).includes(reachable)) {
      fail(`reference page_order must keep ${reachable} reachable from lookup pages`);
    }
    if (actual.includes(reachable)) {
      fail(`reference sidebar_pages must keep ${reachable} as a lookup page, not primary nav`);
    }
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
  const releaseIndex = readText('src/docs/content/reference/releases.mdx');
  for (const required of [
    '`latest` channel',
    'package versions',
    'compatibility notes',
    'release notes',
    'Versioned docs remain available',
    'Documentation changes can update the docs site',
  ]) {
    if (!releaseIndex.includes(required)) {
      fail(`release docs must describe lightweight docs versioning policy: missing ${required}`);
    }
  }
  const versionMatrix = readText(
    path.relative(repoRoot, path.join(siteDocsRoot, 'reference', 'version-matrix.md')),
  );
  for (const required of [
    '| Product | Current source version | First public version | Version relationship | Publish targets | Tag prefix |',
    'unreleased sentinel',
    'runtime-bound',
    'upstream-bound',
    'Release coupling is derived from Moon production and peer dependency scopes',
    'liboliphaunt-native',
    'oliphaunt-react-native',
    'oliphaunt-wasix-rust',
  ]) {
    if (!versionMatrix.includes(required)) {
      fail(`generated version matrix is missing compatibility/release data: ${required}`);
    }
  }
  const products = Object.entries(releaseGraph.products ?? {}).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  if (products.length === 0) {
    fail('generated version matrix has no canonical release products');
  }
  for (const [productId, product] of products) {
    const currentVersion = product.current_version === '0.0.0'
      ? `${product.current_version} (unreleased)`
      : product.current_version;
    const expectedRow = `| ${[
      productId,
      currentVersion,
      product.initial_version,
      product.version_relationship,
      (product.publish_targets ?? []).join(', ') || 'none',
      product.tag_prefix,
    ].map(escapeMarkdownCell).join(' | ')} |`;
    if (!versionMatrix.includes(expectedRow)) {
      fail(`generated version matrix is missing the canonical row for ${productId}: ${expectedRow}`);
    }
  }
  if (releaseGraph.products?.['oliphaunt-swift']?.initial_version !== '0.6.0') {
    fail('oliphaunt-swift must retain the collision-free first public version 0.6.0');
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

function assertLlmRouteCoverage() {
  const llms = readText(path.relative(repoRoot, path.join(staticRoot, 'llms.txt')));
  const full = readText(path.relative(repoRoot, path.join(staticRoot, 'llms-full.txt')));
  for (const record of routeRecords) {
    if (!llms.includes(record.route)) {
      fail(`llms.txt is missing route ${record.route}`);
    }
    if (!full.includes(`Route: ${record.route}`)) {
      fail(`llms-full.txt is missing route ${record.route}`);
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
  if (!href.startsWith('/docs')) {
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
  const guideSummaryIds = {
    'liboliphaunt-native': 'c-abi',
    'oliphaunt-rust': 'rust',
    'oliphaunt-swift': 'swift',
    'oliphaunt-kotlin': 'kotlin',
    'oliphaunt-react-native': 'react-native',
    'oliphaunt-js': 'typescript',
    'oliphaunt-wasix': 'wasm',
  };
  const guideHeadingOrder = {
    'liboliphaunt-native': [
      'Install',
      'Open and query',
      'Configure',
      'Choose a mode',
      'Handle lifecycle',
      'Select extensions',
      'Back up and restore',
    ],
    default: [
      'Install',
      'Open and query',
      'Create app data',
      'Configure',
      'Choose a mode',
      'Handle lifecycle',
      'Select extensions',
      'Back up and restore',
    ],
    'oliphaunt-wasix': [
      'Install',
      'Open and query',
      'Create app data',
      'Configure',
      'Choose a mode',
      'Handle lifecycle',
      'Select extensions',
      'Back up, dump, and restore',
    ],
  };
  for (const route of manifest.routes.filter((entry) => entry.kind === 'sdk')) {
    const requiredPages = route.required_pages ?? [];
    for (const required of ['index', 'guide', 'api-reference']) {
      if (!requiredPages.includes(required)) {
        fail(`${route.id} docs must declare ${required} in docs-manifest.toml`);
      }
    }
    if ((route.page_order ?? []).length > 6) {
      fail(
        `${route.id} docs sidebar is too granular; keep Overview, Guide, API Reference, and only justified deep pages`,
      );
    }
    for (const page of requiredPages) {
      const pagePath = routeSourcePagePath(route, page);
      if (!pagePath) {
        fail(`${route.id} docs are missing required page ${page}.md or ${page}.mdx`);
      }
    }
    const indexPath = routeSourcePagePath(route, 'index');
    const indexMarkdown = readText(indexPath);
    const landingId = guideSummaryIds[route.id];
    if (!landingId || !indexMarkdown.includes(`<SdkLanding id="${landingId}" />`)) {
      fail(`${route.id} SDK overview is missing the SDK landing component`);
    }
    const requiredOverviewHeadings = [
      'Install',
      'Open And Query',
      'Runtime Shape',
      'App Responsibilities',
      'First Query',
    ];
    let previousHeadingIndex = -1;
    for (const heading of requiredOverviewHeadings) {
      const headingPattern = new RegExp(`^##\\s+${escapeRegExp(heading)}\\s*$`, 'mu');
      const headingIndex = indexMarkdown.search(headingPattern);
      if (!headingPattern.test(indexMarkdown)) {
        fail(`${route.id} SDK overview is missing required section: ${heading}`);
      }
      if (headingIndex < previousHeadingIndex) {
        fail(
          `${route.id} SDK overview sections must use this order: ${requiredOverviewHeadings.join(' -> ')}`,
        );
      }
      previousHeadingIndex = headingIndex;
    }
    const guidePath = routeSourcePagePath(route, 'guide');
    const guideMarkdown = readText(guidePath);
    const guideSummaryId = guideSummaryIds[route.id];
    const hasGuideSummary =
      guideSummaryId && guideMarkdown.includes(`<SdkGuideSummary id="${guideSummaryId}" />`);
    const hasEquivalentGuideSummary =
      route.id === 'oliphaunt-react-native' &&
      guideMarkdown.includes('<ReactNativeApproachTable />');
    if (!hasGuideSummary && !hasEquivalentGuideSummary) {
      fail(`${route.id} developer guide is missing the SDK guide summary component`);
    }
    if (!guideMarkdown.includes(`<SdkGuideProof id="${guideSummaryId}" />`)) {
      fail(`${route.id} developer guide is missing the SDK guide proof component`);
    }
    const expectedGuideHeadings = guideHeadingOrder[route.id] ?? guideHeadingOrder.default;
    let previousGuideHeadingIndex = -1;
    for (const heading of expectedGuideHeadings) {
      const headingIndex = guideMarkdown.search(
        new RegExp(`^###\\s+${escapeRegExp(heading)}\\s*$`, 'mu'),
      );
      if (headingIndex < 0) {
        fail(`${route.id} developer guide is missing required step heading: ${heading}`);
      }
      if (headingIndex < previousGuideHeadingIndex) {
        fail(
          `${route.id} developer guide steps must use this order: ${expectedGuideHeadings.join(' -> ')}`,
        );
      }
      previousGuideHeadingIndex = headingIndex;
    }
    if (!/^##\s+Troubleshooting\s*$/mu.test(guideMarkdown)) {
      fail(`${route.id} developer guide is missing Troubleshooting`);
    }
    const sourceFiles = requiredPages.map((page) =>
      readText(routeSourcePagePath(route, page)).toLowerCase(),
    );
    const combined = sourceFiles.join('\n');
    if (!combined.includes('exact') || !combined.includes('extension')) {
      fail(`${route.id} docs must explain exact extension selection across its SDK section`);
    }
    if (!combined.includes('backup') || !combined.includes('restore')) {
      fail(`${route.id} docs must include backup and restore guidance`);
    }
    if (route.id === 'oliphaunt-react-native') {
      const architecturePath = routeSourcePagePath(route, 'architecture');
      if (!architecturePath) {
        fail('React Native SDK docs are missing architecture.md or architecture.mdx');
      }
      const architectureMarkdown = readText(architecturePath);
      if (!architectureMarkdown.includes('<ReactNativeBoundaryMap />')) {
        fail('React Native architecture docs are missing ReactNativeBoundaryMap');
      }
      for (const heading of [
        'Runtime Ownership',
        'JavaScript Shape',
        'Binary Transport',
        'Config Plugin And Packaging',
        'Lifecycle',
        'Capabilities',
        'What The React Native SDK Owns',
      ]) {
        if (!new RegExp(`^##\\s+${escapeRegExp(heading)}\\s*$`, 'mu').test(architectureMarkdown)) {
          fail(`React Native architecture docs are missing required section: ${heading}`);
        }
      }
    }
    if (route.id === 'oliphaunt-wasix') {
      const runtimePath = routeSourcePagePath(route, 'runtime');
      if (!runtimePath) {
        fail('WASM SDK docs are missing runtime.md or runtime.mdx');
      }
      const runtimeMarkdown = readText(runtimePath);
      if (!runtimeMarkdown.includes('<WasmRuntimeMap />')) {
        fail('WASM runtime docs are missing WasmRuntimeMap');
      }
      for (const heading of [
        'Choose A Mode',
        'Persistence Modes',
        'Operational Limits',
        'Root Locking And Lifecycle',
        'Startup And Preload',
        'Supported Targets',
        'Server-Compatible Access',
      ]) {
        if (!new RegExp(`^##\\s+${escapeRegExp(heading)}\\s*$`, 'mu').test(runtimeMarkdown)) {
          fail(`WASM runtime docs are missing required section: ${heading}`);
        }
      }

      const dumpRestorePath = routeSourcePagePath(route, 'dump-restore');
      if (!dumpRestorePath) {
        fail('WASM SDK docs are missing dump-restore.md or dump-restore.mdx');
      }
      const dumpRestoreMarkdown = readText(dumpRestorePath);
      if (!dumpRestoreMarkdown.includes('<WasmDataMovement />')) {
        fail('WASM dump/restore docs are missing WasmDataMovement');
      }
      for (const heading of [
        'Choose The Right Export Format',
        'Direct API',
        'Server API',
        '`PgDumpOptions`',
        'CLI',
        'Restore',
        'Upgrade Guidance',
      ]) {
        if (!new RegExp(`^##\\s+${escapeRegExp(heading)}\\s*$`, 'mu').test(dumpRestoreMarkdown)) {
          fail(`WASM dump/restore docs are missing required section: ${heading}`);
        }
      }
    }
  }
}

function assertStartPageCoverage() {
  const startRoute = manifest.routes.find((entry) => entry.id === 'start');
  if (!startRoute) {
    fail('docs manifest is missing the Start route');
  }
  const startPath = routeSourcePagePath(startRoute, 'index');
  if (!startPath) {
    fail('Start docs are missing index.md or index.mdx');
  }
  const markdown = readText(startPath);
  const requiredComponents = ['QuickstartPath', 'FirstQueryFlow', 'StartNextSteps'];
  for (const component of requiredComponents) {
    if (!markdown.includes(`<${component}`)) {
      fail(`Start docs are missing ${component}`);
    }
  }
  const requiredHeadings = [
    'Start In One App Target',
    'First Query Shape',
    'After The First Query',
  ];
  let previousHeadingIndex = -1;
  for (const heading of requiredHeadings) {
    const headingIndex = markdown.search(new RegExp(`^##\\s+${escapeRegExp(heading)}\\s*$`, 'mu'));
    if (headingIndex < 0) {
      fail(`Start docs are missing required section: ${heading}`);
    }
    if (headingIndex < previousHeadingIndex) {
      fail(`Start docs sections must use this order: ${requiredHeadings.join(' -> ')}`);
    }
    previousHeadingIndex = headingIndex;
  }
}

function assertReferencePageCoverage() {
  const referenceRoute = manifest.routes.find((entry) => entry.id === 'reference');
  if (!referenceRoute) {
    fail('docs manifest is missing the Reference route');
  }
  const requirements = [
    {
      page: 'capabilities',
      title: 'Capability Matrix',
      components: ['CapabilitySnapshot'],
      headings: ['SDKs', 'Runtime Modes', 'Feature Support', 'Choosing A Mode'],
    },
    {
      page: 'extensions',
      title: 'Extensions',
      components: ['ExactExtensionRule', 'ExtensionArtifactFlow'],
      headings: [
        'How Selection Works',
        'Platform Behavior',
        'Dependencies',
        'External Extensions',
        'Verifying App Artifacts',
      ],
    },
    {
      page: 'performance',
      title: 'Performance',
      components: ['PerformanceResultsGrid'],
      headings: [
        'What to measure',
        'Compare modes honestly',
        'SQLite comparison',
        'Release Measurements',
      ],
    },
    {
      page: 'releases',
      title: 'Releases',
      components: ['ReleaseLookup'],
      headings: [
        'First Release Boundary',
        'Version Relationships',
        'Target Availability',
        'What A Release Tells You',
        'Docs Versioning',
      ],
    },
  ];
  for (const requirement of requirements) {
    const pagePath = routeSourcePagePath(referenceRoute, requirement.page);
    if (!pagePath) {
      fail(`Reference docs are missing ${requirement.page}.md or ${requirement.page}.mdx`);
    }
    const markdown = readText(pagePath);
    if (!new RegExp(`^#\\s+${escapeRegExp(requirement.title)}\\s*$`, 'mu').test(markdown)) {
      fail(`Reference page ${requirement.page} is missing title heading: ${requirement.title}`);
    }
    for (const component of requirement.components) {
      if (!markdown.includes(`<${component}`)) {
        fail(`Reference page ${requirement.page} is missing ${component}`);
      }
    }
    let previousHeadingIndex = -1;
    for (const heading of requirement.headings) {
      const headingIndex = markdown.search(
        new RegExp(`^##\\s+${escapeRegExp(heading)}\\s*$`, 'mu'),
      );
      if (headingIndex < 0) {
        fail(`Reference page ${requirement.page} is missing required section: ${heading}`);
      }
      if (headingIndex < previousHeadingIndex) {
        fail(
          `Reference page ${requirement.page} sections must use this order: ${requirement.headings.join(' -> ')}`,
        );
      }
      previousHeadingIndex = headingIndex;
    }
  }
}

function assertLearnPageCoverage() {
  const learnRoute = manifest.routes.find((entry) => entry.id === 'learn');
  if (!learnRoute) {
    fail('docs manifest is missing the Learn route');
  }
  const requirements = [
    {
      page: 'embedded-postgres',
      title: 'Embedded PostgreSQL',
      components: ['EmbeddedPostgresModel'],
      headings: [
        'Root Storage',
        'Lifecycle Contract',
        'Extension Selection',
        'What is different from SQLite?',
      ],
    },
    {
      page: 'native-runtime',
      title: 'Native Runtime',
      components: ['ModeMatrix'],
      headings: [
        'Choose a mode',
        'Runtime Semantics',
        'Direct Lifecycle',
        'Storage',
        'Startup Configuration',
        'Extensions',
        'Capabilities',
      ],
    },
    {
      page: 'mobile-stability',
      title: 'Mobile Stability',
      components: ['MobileStabilityContract'],
      headings: [
        'What developers can rely on',
        'Close and reopen',
        'Background and foreground',
        'Choosing the mode',
      ],
    },
    {
      page: 'sqlite-upgrade',
      title: 'Moving From SQLite',
      components: ['SqliteMigrationMap'],
      headings: [
        'Concept Map',
        'Schema And SQL Differences',
        'Storage And Backup',
        'Migration Path',
        'When SQLite Is Still The Better Fit',
      ],
    },
    {
      page: 'tauri',
      title: 'Tauri Usage',
      components: ['TauriAppPattern'],
      headings: [
        'App Shape',
        'Direct Rust State',
        'Existing Postgres Clients',
        'Extensions And Assets',
        'Backup And Restore',
        'Operational Guidance',
      ],
    },
  ];
  for (const requirement of requirements) {
    const pagePath = routeSourcePagePath(learnRoute, requirement.page);
    if (!pagePath) {
      fail(`Learn docs are missing ${requirement.page}.md or ${requirement.page}.mdx`);
    }
    const markdown = readText(pagePath);
    if (!new RegExp(`^#\\s+${escapeRegExp(requirement.title)}\\s*$`, 'mu').test(markdown)) {
      fail(`Learn page ${requirement.page} is missing title heading: ${requirement.title}`);
    }
    for (const component of requirement.components) {
      if (!markdown.includes(`<${component}`)) {
        fail(`Learn page ${requirement.page} is missing ${component}`);
      }
    }
    let previousHeadingIndex = -1;
    for (const heading of requirement.headings) {
      const headingIndex = markdown.search(
        new RegExp(`^##\\s+${escapeRegExp(heading)}\\s*$`, 'mu'),
      );
      if (headingIndex < 0) {
        fail(`Learn page ${requirement.page} is missing required section: ${heading}`);
      }
      if (headingIndex < previousHeadingIndex) {
        fail(
          `Learn page ${requirement.page} sections must use this order: ${requirement.headings.join(' -> ')}`,
        );
      }
      previousHeadingIndex = headingIndex;
    }
  }
}

function markerDisplayId(marker) {
  if (!marker) {
    return '';
  }
  const colon = marker.lastIndexOf(':');
  if (colon >= 0) {
    return marker.slice(colon + 1);
  }
  const parts = marker.trim().split(/\s+/);
  return parts[parts.length - 1] ?? marker;
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
    const guidePath = routeSourcePagePath(route, 'guide');
    if (!guidePath) {
      fail(`${route.id} guide source is missing`);
    }
    const guide = readText(guidePath);
    if (!guide.includes(`oliphaunt-snippet: ${route.id}`)) {
      fail(`${route.id} guide must include the manifest-owned snippet directive`);
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
    'oliphaunt-wasix': 'wasm',
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
  if (releaseGraph.products?.['docs']) {
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
  const componentPattern =
    /<(SdkChooser|SdkLanding|SdkGuideProof|StartOutcome|StartNextSteps|EmbeddedPostgresModel|MobileStabilityContract|SqliteMigrationMap|TauriAppPattern|ReactNativeBoundaryMap|WasmRuntimeMap|WasmDataMovement|CapabilitySnapshot|ExtensionArtifactFlow|PerformanceResultsGrid|ReleaseLookup|QuickstartPath|FirstQueryFlow|VerifyChecklist|ModeMatrix|ExactExtensionRule|Steps|Step|Callout|Tabs|Tab|Cards|Card|Files|File|Folder)\b/u;
  const bad = routeRecords.filter(
    (record) => record.file.endsWith('.md') && componentPattern.test(readText(record.source)),
  );
  if (bad.length > 0) {
    fail(
      `docs pages with React components must be emitted as .mdx, not .md:\n${bad.map((record) => record.source).join('\n')}`,
    );
  }
}

function assertPublicDocsLanguageHygiene() {
  const disallowed = [
    { label: 'stale sdk-parity route', pattern: /sdk-parity/u },
    { label: 'source checkout', pattern: /\bsource checkout\b/iu },
    { label: 'stale Expo Go wording', pattern: /\bExpo Go\b/u },
    { label: 'stale base64 transport wording', pattern: /\bbase64\b/iu },
    { label: 'advisory should wording', pattern: /\bshould\b/iu },
    { label: 'defensive should-not wording', pattern: /\bshould not\b/iu },
    { label: 'planning phrase "not pretend"', pattern: /\bnot pretend\b/iu },
    { label: 'runtime smoke evidence', pattern: /\bruntime smoke evidence\b/iu },
    { label: 'package evidence', pattern: /\bpackage evidence\b/iu },
    { label: 'real device evidence', pattern: /\breal device evidence\b/iu },
    { label: 'internal evidence wording', pattern: /\bevidence\b/iu },
    {
      label: 'future or placeholder language',
      pattern: /\b(?:TODO|placeholder|not yet|coming soon|eventually|can be added later)\b/iu,
    },
    { label: 'release metadata internals', pattern: /\brelease metadata\b/iu },
    { label: 'maintainer-facing language', pattern: /\bmaintainer\b/iu },
    { label: 'internal-facing language', pattern: /\binternal\b/iu },
    { label: 'CI internals', pattern: /\bCI\b/u },
    { label: 'tooling path', pattern: /tools\//u },
    { label: 'source path', pattern: /src\//u },
    { label: 'target path', pattern: /target\//u },
    { label: 'fixture path', pattern: /fixtures\//u },
    { label: 'repo-structure language', pattern: /\bmonorepo\b/iu },
    { label: 'pre-release status language', pattern: /\bbefore the first stable\b/iu },
    { label: 'publication timing language', pattern: /\bonce release artifacts are published\b/iu },
    { label: 'defensive fallback wording', pattern: /\bfallback paths\b/iu },
    {
      label: 'stale unavailable extension wording',
      pattern: /\b(?:not available|not selected|not a pack)\b/iu,
    },
    { label: 'stale WASM comparison wording', pattern: /\bOlder WASM examples\b/u },
    { label: 'defensive crash isolation wording', pattern: /\bCrash isolation belongs\b/u },
    {
      label: 'defensive unsupported wording',
      pattern: /\bunsupported (?:operation|extension|extensions)\b/iu,
    },
    { label: 'internal lane wording', pattern: /\blane\b/iu },
  ];
  const failures = [];
  for (const record of routeRecords) {
    const markdown = readText(record.source);
    const lines = markdown.split('\n');
    lines.forEach((line, index) => {
      for (const rule of disallowed) {
        if (rule.pattern.test(line)) {
          failures.push(`${record.route}:${index + 1}: ${rule.label}: ${line.trim()}`);
        }
      }
    });
  }
  if (failures.length > 0) {
    fail(`public generated docs include maintainer or planning language:\n${failures.join('\n')}`);
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
    { label: 'stale sdk-parity route', pattern: /sdk-parity/iu },
    { label: 'source checkout', pattern: /\bsource checkout\b/iu },
    { label: 'stale Expo Go wording', pattern: /\bExpo Go\b/u },
    { label: 'stale base64 transport wording', pattern: /\bbase64\b/iu },
    { label: 'advisory should wording', pattern: /\bshould\b/iu },
    { label: 'defensive should-not wording', pattern: /\bshould not\b/iu },
    { label: 'planning phrase "not pretend"', pattern: /\bnot pretend\b/iu },
    { label: 'runtime smoke evidence', pattern: /\bruntime smoke evidence\b/iu },
    { label: 'package evidence', pattern: /\bpackage evidence\b/iu },
    { label: 'real device evidence', pattern: /\breal device evidence\b/iu },
    { label: 'internal evidence wording', pattern: /\bevidence\b/iu },
    {
      label: 'future or placeholder language',
      pattern: /\b(?:TODO|placeholder|not yet|coming soon|eventually|can be added later)\b/iu,
    },
    { label: 'release metadata internals', pattern: /\brelease metadata\b/iu },
    { label: 'maintainer-facing language', pattern: /\bmaintainer\b/iu },
    { label: 'internal-facing language', pattern: /\binternal\b/iu },
    { label: 'CI internals', pattern: /\bCI\b/u },
    { label: 'tooling path', pattern: /tools\//u },
    { label: 'source path', pattern: /src\//u },
    { label: 'target path', pattern: /target\//u },
    { label: 'fixture path', pattern: /fixtures\//u },
    { label: 'repo-structure language', pattern: /\bmonorepo\b/iu },
    { label: 'pre-release status language', pattern: /\bbefore the first stable\b/iu },
    { label: 'publication timing language', pattern: /\bonce release artifacts are published\b/iu },
    { label: 'defensive fallback wording', pattern: /\bfallback paths\b/iu },
    {
      label: 'stale unavailable extension wording',
      pattern: /\b(?:not available|not selected|not a pack)\b/iu,
    },
    { label: 'stale WASM comparison wording', pattern: /\bOlder WASM examples\b/u },
    { label: 'defensive crash isolation wording', pattern: /\bCrash isolation belongs\b/u },
    {
      label: 'defensive unsupported wording',
      pattern: /\bunsupported (?:operation|extension|extensions)\b/iu,
    },
    { label: 'internal lane wording', pattern: /\blane\b/iu },
    {
      label: 'generated API field',
      pattern: /\b(?:implementation_path|documentation_path|tested_snippet|reference_artifact)\b/iu,
    },
    { label: 'raw extension source kind', pattern: /\boliphaunt-other-extension\b/iu },
    { label: 'unrendered extension placeholder', pattern: /@EXTVERSION@|@MODULEPATH@/u },
    { label: 'generated reference wording', pattern: /\bgenerated language reference/iu },
    {
      label: 'removed upstream reference',
      pattern: new RegExp(`\\b${'pg'}${'lite'}\\b`, 'iu'),
    },
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
  const releasePlease = JSON.parse(readText('release-please-config.json'));
  const packages = Object.values(releasePlease.packages ?? {});
  const packageConfig = (component) => {
    const matches = packages.filter((entry) => entry?.component === component);
    if (matches.length !== 1) {
      fail(`release-please must define exactly one ${component} package`);
    }
    return matches[0];
  };
  const initialVersion = (component) =>
    packageConfig(component)['initial-version'] ?? releasePlease['initial-version'];
  const swiftVersion = initialVersion('oliphaunt-swift');
  const kotlinVersion = initialVersion('oliphaunt-kotlin');
  if (swiftVersion !== '0.6.0') {
    fail(`the first SwiftPM-compatible Oliphaunt version must remain 0.6.0; got ${swiftVersion}`);
  }

  const required = new Map([
    [
      'src/docs/content/sdk/swift/index.mdx',
      `.package(url: "https://github.com/f0rr0/oliphaunt.git", from: "${swiftVersion}")`,
    ],
    [
      'src/docs/content/sdk/swift/guide.mdx',
      `.package(url: "https://github.com/f0rr0/oliphaunt.git", from: "${swiftVersion}")`,
    ],
    [
      'src/sdks/swift/README.md',
      `.package(url: "https://github.com/f0rr0/oliphaunt.git", exact: "${swiftVersion}")`,
    ],
    [
      'src/docs/content/sdk/kotlin/index.mdx',
      `implementation("dev.oliphaunt:oliphaunt-android:${kotlinVersion}")`,
    ],
    [
      'src/docs/content/sdk/kotlin/guide.mdx',
      `implementation("dev.oliphaunt:oliphaunt-android:${kotlinVersion}")`,
    ],
    [
      'src/sdks/kotlin/README.md',
      `implementation("dev.oliphaunt:oliphaunt-android:${kotlinVersion}")`,
    ],
    ['src/docs/src/lib/docs-data.ts', `packageName: 'dev.oliphaunt:oliphaunt-android'`],
  ]);
  for (const [file, text] of required) {
    if (!readText(file).includes(text)) {
      fail(`${file} must use the release-owned SDK install contract ${JSON.stringify(text)}`);
    }
  }

  const publicKotlin = [
    'src/docs/content/sdk/kotlin/index.mdx',
    'src/docs/content/sdk/kotlin/guide.mdx',
    'src/docs/src/lib/docs-data.ts',
  ]
    .map(readText)
    .join('\n');
  if (publicKotlin.includes('dev.oliphaunt:oliphaunt:')) {
    fail(
      'public Kotlin install docs must not advertise the unpublished dev.oliphaunt:oliphaunt coordinate',
    );
  }
  const typescriptDocs = [
    'src/docs/content/sdk/typescript/index.mdx',
    'src/docs/content/reference/sdk-products.mdx',
  ]
    .map(readText)
    .join('\n');
  if (
    !typescriptDocs.includes('JSR package intentionally contains only') ||
    !typescriptDocs.includes('JSR distribution is deliberately limited')
  ) {
    fail(
      'TypeScript public docs must distinguish the native npm distribution from protocol/query-only JSR',
    );
  }
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
assertLlmRouteCoverage();
assertDocsInternalLinksResolve();
assertStartPageCoverage();
assertLearnPageCoverage();
assertReferencePageCoverage();
assertSdkSectionCoverage();
assertSnippetMarkers();
assertSdkManifestCoverage();
assertReleaseGraphPolicy();
assertNoNodeModulesGenerated();
assertMdxComponentPagesStayMdx();
assertPublicDocsLanguageHygiene();
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
