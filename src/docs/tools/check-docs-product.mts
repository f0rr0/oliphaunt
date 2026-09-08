#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

import { generateDocs } from './generate-content.mts';

const args = new Set(process.argv.slice(2));
const apiReferenceRequested = args.has('--api-reference');
const result = generateDocs({
  apiMode: apiReferenceRequested ? 'release' : 'fast',
  publishApiArtifacts: apiReferenceRequested,
});
const { manifest, routeRecords, paths } = result;
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

assertUniqueRoutes();
assertGeneratedFiles();
assertDocsInternalLinksResolve();
assertSnippetMarkers();
assertApiReferenceSummary({ requireGenerated: apiReferenceRequested });
console.log(`docs checks passed (${routeRecords.length} routes)`);
