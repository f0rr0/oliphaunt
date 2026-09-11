#!/usr/bin/env bun
import fs from 'node:fs';
import path from 'node:path';

import { generateDocs } from './generate-content.mts';

const result = await generateDocs();
const { manifest, routeRecords, paths } = result;
const { repoRoot, siteDocsRoot, staticRoot, generatedMetaRoot } = paths;

function fail(message) {
  console.error(message);
  process.exit(1);
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
    ...collectSourceTextFiles(path.join(repoRoot, 'docs/src')),
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

assertDocsInternalLinksResolve();
console.log(`docs links passed (${routeRecords.length} routes)`);
