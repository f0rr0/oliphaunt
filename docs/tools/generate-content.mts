#!/usr/bin/env bun
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const parseToml = Bun.TOML.parse;

import { publishedProducts } from './published-products.mts';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const docsRoot = path.resolve(scriptDir, '..');
const repoRoot = path.resolve(scriptDir, '../..');
const manifestPath = path.join(docsRoot, 'docs-manifest.toml');
const generatedRoot = path.join(repoRoot, 'target', 'docs');
const siteDocsRoot = path.join(generatedRoot, 'site-docs');
const staticRoot = path.join(generatedRoot, 'static');

const generatedMetaRoot = path.join(generatedRoot, 'generated');

const SKIP_DIRS = new Set(['node_modules', '.git', '.moon', '.docusaurus', 'build', 'target']);

function readText(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function parseTomlFile(filePath) {
  return parseToml(readText(filePath));
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function resetDir(dirPath) {
  fs.rmSync(dirPath, { force: true, recursive: true });
  ensureDir(dirPath);
}

function assertInsideRepo(relativePath, label) {
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.includes('\0')) {
    throw new Error(`${label} must be a repository-relative path`);
  }
  const resolved = path.resolve(repoRoot, relativePath);
  if (!resolved.startsWith(repoRoot + path.sep)) {
    throw new Error(`${label} escapes the repository: ${relativePath}`);
  }
  return resolved;
}

function substituteVersions(markdown, products) {
  return markdown.replace(/\{\{release:([a-z0-9-]+)\}\}/gu, (_match, id) => {
    if (!(id in products)) throw new Error(`Unknown release product: ${id}`);
    return products[id]?.version ?? 'NOT-YET-PUBLISHED';
  });
}

function normalizeMdxComments(markdown) {
  return markdown.replace(/<!--([\s\S]*?)-->/gu, (_match, comment) => `{/*${comment}*/}`);
}

function yamlString(value) {
  return JSON.stringify(String(value ?? ''));
}

function ensureTitleFrontmatter(markdown, fallbackTitle) {
  const title = firstHeading(markdown, fallbackTitle);
  const frontmatterMatch = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/u);
  if (!frontmatterMatch) {
    return `---\ntitle: ${yamlString(title)}\n---\n\n${markdown}`;
  }
  if (/^title\s*:/mu.test(frontmatterMatch[1])) {
    return markdown;
  }
  return markdown.replace(/^---\r?\n/u, `---\ntitle: ${yamlString(title)}\n`);
}

function stripMatchingLeadingTitleHeading(markdown) {
  const title = frontmatterValue(markdown, 'title');
  if (!title) {
    return markdown;
  }
  const frontmatterMatch = markdown.match(/^(---\r?\n[\s\S]*?\r?\n---\r?\n?)([\s\S]*)$/u);
  const prefix = frontmatterMatch ? frontmatterMatch[1] : '';
  const body = frontmatterMatch ? frontmatterMatch[2] : markdown;
  const headingPattern = /^(\s*)#\s+(.+?)\s*#?\s*(?:\r?\n|$)/u;
  const headingMatch = body.match(headingPattern);
  if (!headingMatch || headingMatch[1].trim().length > 0) {
    return markdown;
  }
  if (headingMatch[2].trim() !== title) {
    return markdown;
  }
  const strippedBody = body.slice(headingMatch[0].length).replace(/^\r?\n/u, '');
  return `${prefix}${strippedBody}`;
}

function normalizePageMarkdown(markdown, fallbackTitle) {
  return stripMatchingLeadingTitleHeading(ensureTitleFrontmatter(markdown, fallbackTitle));
}

function normalizeCodeFenceInfoStrings(markdown) {
  return markdown.replace(
    /^(`{3,})([A-Za-z0-9_+-]+),([^\r\n]*)$/gmu,
    (_match, fence, lang, meta) => {
      return `${fence}${lang} ${meta.trim()}`;
    },
  );
}

function routeSourcePagePath(source, page) {
  for (const extension of ['.md', '.mdx']) {
    const candidate = path.join(source, `${page}${extension}`);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function copyMarkdownPage(from, to, context) {
  const markdown = normalizeCodeFenceInfoStrings(
    normalizeMdxComments(substituteVersions(readText(from), context)),
  );
  const fallbackTitle = path.basename(from, path.extname(from));
  ensureDir(path.dirname(to));
  fs.writeFileSync(to, normalizePageMarkdown(markdown, fallbackTitle));
}

function copyRoutePages(route, context) {
  const source = assertInsideRepo(route.source, `source for ${route.id}`);
  const destination = path.join(siteDocsRoot, route.route);
  ensureDir(destination);
  for (const page of uniqueInOrder([
    ...(route.page_order ?? []),
    ...(route.required_pages ?? []),
  ])) {
    const from = routeSourcePagePath(source, page);
    if (!from) {
      continue;
    }
    const to = path.join(destination, `${page}${path.extname(from)}`);
    copyMarkdownPage(from, to, context);
    if (route.product_id && !context[route.product_id]) {
      const warning =
        '\n> This product has no completed public release yet. Installation examples below are not available for use.\n';
      fs.writeFileSync(
        to,
        readText(to).replace(/^(---\r?\n[\s\S]*?\r?\n---\r?\n)/u, `$1${warning}`),
      );
    }
  }
}

function escapeMarkdown(value) {
  return String(value ?? '')
    .replaceAll('\\', '\\\\')
    .replaceAll('|', '\\|')
    .replaceAll('\n', ' ');
}

function firstHeading(markdown, fallback) {
  const match = markdown.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : fallback;
}

function frontmatterValue(markdown, key) {
  const frontmatterMatch = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/u);
  if (!frontmatterMatch) {
    return '';
  }
  const match = frontmatterMatch[1].match(new RegExp(`^${key}\\s*:\\s*(.+)$`, 'mu'));
  if (!match) {
    return '';
  }
  return match[1].trim().replace(/^["']|["']$/gu, '');
}

function collectMarkdownFiles(root) {
  const files = [];
  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) {
        continue;
      }
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
      } else if (entry.isFile() && /\.mdx?$/.test(entry.name)) {
        files.push(fullPath);
      }
    }
  }
  if (fs.existsSync(root)) {
    visit(root);
  }
  return files.sort();
}

function markdownRouteFor(filePath) {
  const relative = path.relative(siteDocsRoot, filePath).replaceAll(path.sep, '/');
  const withoutExtension = relative.replace(/\.mdx?$/, '');
  const route = withoutExtension.replace(/\/index$/, '');
  return `/${route}`;
}

function markdownDocIdFor(filePath) {
  return path
    .relative(siteDocsRoot, filePath)
    .replaceAll(path.sep, '/')
    .replace(/\.mdx?$/, '');
}

function generateExtensionCatalog() {
  const catalogPath = path.join(repoRoot, 'extensions/generated/extensions.catalog.json');
  if (!fs.existsSync(catalogPath)) {
    throw new Error('extension catalog source is required for public docs generation');
  }
  const catalog = JSON.parse(readText(catalogPath));
  const rows = (catalog.extensions ?? [])
    .sort((left, right) =>
      String(left['sql-name'] ?? left.id).localeCompare(String(right['sql-name'] ?? right.id)),
    )
    .map((extension) => {
      const control = extension.control ?? {};
      return `| ${escapeMarkdown(extension['sql-name'] ?? extension.id)} | ${escapeMarkdown(extension['display-name'] ?? extension.id)} | ${escapeMarkdown(extensionVersion(control['default-version']))} | ${escapeMarkdown(extensionFamily(extension['source-kind']))} | ${escapeMarkdown(extensionActivation(extension))} |`;
    });
  return `---
title: Extension Catalog
---

# Extension Catalog

Use this table to find exact SQL extension names. SDK and app packaging
selection uses the SQL extension name. Every listed extension is supported
extensions only.

| SQL extension | Display name | Version | Family | Activation |
| --- | --- | --- | --- | --- |
${rows.join('\n')}
`;
}

function extensionVersion(version) {
  if (!version || String(version).includes('@')) {
    return 'Packaged with runtime';
  }
  return version;
}

function extensionFamily(sourceKind) {
  const labels = {
    'postgres-contrib': 'PostgreSQL contrib',
    'oliphaunt-other-extension': 'External extension',
    postgis: 'PostGIS',
  };
  return labels[sourceKind] ?? 'Extension artifact';
}

function extensionActivation(extension) {
  if (extension.lifecycle?.['create-extension'] === false) {
    return 'Runtime module';
  }
  return 'CREATE EXTENSION';
}

function writeMetadata(routeRecords) {
  ensureDir(generatedMetaRoot);
  fs.writeFileSync(
    path.join(generatedMetaRoot, 'routes.json'),
    `${JSON.stringify({ routes: routeRecords }, null, 2)}\n`,
  );
}

function itemForPage(route, page) {
  return `${route.route}/${page}`;
}

const routePresentation = {
  start: {
    description: 'Install an SDK, open app-owned storage, and run the first PostgreSQL query.',
    icon: 'Route',
    defaultOpen: true,
    collapsible: false,
  },
  sdk: {
    description: 'Choose a native SDK, Rust WASIX, WASIX TypeScript, or the C ABI.',
    icon: 'PackageCheck',
    defaultOpen: false,
  },
  learn: {
    description:
      'Understand embedded PostgreSQL storage, lifecycle, runtime modes, and migrations.',
    icon: 'BookOpen',
    defaultOpen: false,
  },
  reference: {
    description: 'Look up capabilities, extensions, releases, performance results, and API links.',
    icon: 'SearchCheck',
    defaultOpen: false,
  },
  'liboliphaunt-native': {
    description: 'Stable C ABI, opaque handles, raw protocol bytes, and binding rules.',
    icon: 'CodeXml',
  },
  'oliphaunt-rust': {
    description: 'Rust and Tauri SDK with direct, broker, and server runtime modes.',
    icon: 'Laptop',
  },
  'oliphaunt-swift': {
    description: 'Apple SDK for iOS and macOS apps using Swift concurrency.',
    icon: 'Smartphone',
  },
  'oliphaunt-kotlin': {
    description: 'Android SDK with coroutine-first APIs and exact native resource packaging.',
    icon: 'Smartphone',
  },
  'oliphaunt-react-native': {
    description: 'New Architecture package with Expo config plugin, TurboModule, and JSI bytes.',
    icon: 'Layers',
  },
  'oliphaunt-js': {
    description: 'TypeScript SDK for Node.js, Bun, and Deno.',
    icon: 'Braces',
  },
  'oliphaunt-wasix-rust': {
    description: 'Rust SDK for the portable WASIX runtime.',
    icon: 'Boxes',
  },
  'oliphaunt-wasix-typescript': {
    description: 'Portable TypeScript SDK for browsers, Node.js, Bun, Deno, and Electron.',
    icon: 'Boxes',
  },
};

function metadataForRoute(route) {
  const presentation = routePresentation[route.id] ?? {};
  return Object.fromEntries(
    Object.entries(presentation).filter(([, value]) => value !== undefined),
  );
}

function category(label, items) {
  return {
    type: 'category',
    label,
    items,
  };
}

function sidebarPagesForRoute(route) {
  return route.sidebar_pages ?? route.page_order ?? [];
}

function orderedItemsForRoute(route, routeRecords) {
  const available = new Set(
    routeRecords
      .filter(
        (record) =>
          record.route === `/${route.route}` || record.route.startsWith(`/${route.route}/`),
      )
      .map((record) => record.docId),
  );
  const declared = sidebarPagesForRoute(route);
  const declaredItems = declared.map((page) => itemForPage(route, page));
  if (declared.length > 0) {
    return declaredItems.filter((item) => available.has(item));
  }
  return [...available].sort((left, right) => left.localeCompare(right));
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function uniqueInOrder(values) {
  const seen = new Set();
  const output = [];
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      output.push(value);
    }
  }
  return output;
}

function pageOrderForFumadocs(route) {
  return uniqueInOrder(
    sidebarPagesForRoute(route).map((page) => {
      const [first] = page.split('/');
      return first;
    }),
  );
}

function titleForPathSegment(segment) {
  return segment
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function writeRouteMeta(route) {
  const routeRoot = path.join(siteDocsRoot, route.route);
  const metadata = {
    title: route.title,
    ...metadataForRoute(route),
    pages: pageOrderForFumadocs(route),
  };
  if (metadata.pages.includes('index')) {
    metadata.pagesIndex = 'index';
    metadata.pages = metadata.pages.filter((page) => page !== 'index');
  }
  if (route.kind === 'public') {
    metadata.root = true;
    metadata.description ??= `${route.title} documentation`;
  }
  writeJson(path.join(routeRoot, 'meta.json'), metadata);

  const nested = new Map();
  for (const page of sidebarPagesForRoute(route)) {
    const parts = page.split('/');
    if (parts.length < 2) {
      continue;
    }
    const [folder, child] = parts;
    const children = nested.get(folder) ?? [];
    children.push(child);
    nested.set(folder, children);
  }

  for (const [folder, pages] of nested) {
    writeJson(path.join(routeRoot, folder, 'meta.json'), {
      title: titleForPathSegment(folder),
      pages: uniqueInOrder(pages),
    });
  }
}

function writeFumadocsMeta(manifest) {
  const sdkRoutes = (manifest.routes ?? []).filter((route) => route.kind === 'sdk');
  writeJson(path.join(siteDocsRoot, 'meta.json'), {
    title: 'Oliphaunt',
    description:
      'Embedded PostgreSQL SDK documentation for native, Rust WASIX, and WASIX TypeScript apps.',
    pages: ['start', 'sdk', 'learn', 'reference'],
  });
  for (const route of manifest.routes ?? []) {
    if (route.id !== 'sdk') {
      writeRouteMeta(route);
    }
  }
  writeJson(path.join(siteDocsRoot, 'sdk', 'meta.json'), {
    title: 'SDKs',
    description: routePresentation.sdk.description,
    icon: routePresentation.sdk.icon,
    root: true,
    defaultOpen: routePresentation.sdk.defaultOpen,
    pagesIndex: 'index',
    pages: sdkRoutes.map((route) => route.route.replace(/^sdk\//u, '')),
  });
}

function writeNavigationMetadata(manifest, routeRecords) {
  const byId = new Map((manifest.routes ?? []).map((route) => [route.id, route]));
  const sdkRoutes = (manifest.routes ?? []).filter((route) => route.kind === 'sdk');
  const navigation = {
    docs: [
      'start/index',
      category('SDKs', [
        'sdk/index',
        ...sdkRoutes.map((route) =>
          category(route.title, orderedItemsForRoute(route, routeRecords)),
        ),
      ]),
      category('Learn', orderedItemsForRoute(byId.get('learn'), routeRecords)),
      category('Reference', orderedItemsForRoute(byId.get('reference'), routeRecords)),
    ],
  };
  writeJson(path.join(generatedMetaRoot, 'navigation.json'), navigation);
  writeFumadocsMeta(manifest);
}

function stripFrontmatter(markdown) {
  return markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/u, '');
}

function writeLlmFiles(routeRecords) {
  ensureDir(staticRoot);
  const summary = [
    '# Oliphaunt Docs',
    '',
    'Oliphaunt is embedded PostgreSQL for native, Rust WASIX, and WASIX TypeScript apps.',
    '',
    '## Public routes',
    ...routeRecords.map((record) => `- ${record.title}: ${record.route}`),
    '',
  ].join('\n');
  fs.writeFileSync(path.join(staticRoot, 'llms.txt'), summary);

  const full = routeRecords
    .map((record) => {
      const markdown = stripFrontmatter(readText(record.file));
      return `# ${record.title}\n\nRoute: ${record.route}\n\n${markdown}`;
    })
    .join('\n\n---\n\n');
  fs.writeFileSync(path.join(staticRoot, 'llms-full.txt'), full);
}

function currentGitSha() {
  return process.env.OLIPHAUNT_DOCS_GIT_SHA || 'unknown';
}

export async function generateDocs() {
  const manifest = parseTomlFile(manifestPath);
  const products = await publishedProducts(manifest.routes);
  resetDir(siteDocsRoot);
  resetDir(staticRoot);
  resetDir(generatedMetaRoot);
  fs.writeFileSync(
    path.join(generatedMetaRoot, 'published-products.json'),
    JSON.stringify(products, null, 2) + '\n',
  );
  const context = products;
  for (const route of manifest.routes ?? []) {
    copyRoutePages(route, context);
  }

  fs.writeFileSync(
    path.join(siteDocsRoot, 'reference', 'extension-catalog.md'),
    generateExtensionCatalog(),
  );
  const rows = Object.entries(products).map(([id, product]) =>
    product ? `| ${id} | [${product.version}](${product.url}) |` : `| ${id} | Not yet published |`,
  );
  fs.writeFileSync(
    path.join(siteDocsRoot, 'reference', 'version-matrix.md'),
    '---\ntitle: Published products\n---\n\nThese guides describe the latest available products. Versions below come from completed public releases.\n\n| Product | Latest release |\n| --- | --- |\n' +
      rows.join('\n') +
      '\n',
  );

  const routeRecords = collectMarkdownFiles(siteDocsRoot).map((file) => {
    const markdown = readText(file);
    return {
      route: markdownRouteFor(file),
      docId: markdownDocIdFor(file),
      title:
        frontmatterValue(markdown, 'title') ||
        firstHeading(markdown, path.basename(file, path.extname(file))),
      file,
      source: path.relative(repoRoot, file),
    };
  });

  writeMetadata(routeRecords);
  writeNavigationMetadata(manifest, routeRecords);
  writeLlmFiles(routeRecords);
  fs.writeFileSync(
    path.join(generatedMetaRoot, 'build-metadata.json'),
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        gitSha: currentGitSha(),
        routeCount: routeRecords.length,
      },
      null,
      2,
    )}\n`,
  );

  return {
    manifest,
    routeRecords,
    paths: {
      repoRoot,
      docsRoot,
      siteDocsRoot,
      staticRoot,
      generatedMetaRoot,
    },
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await generateDocs();
  console.log(`generated ${result.routeRecords.length} docs routes`);
}
