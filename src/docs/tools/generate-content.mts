#!/usr/bin/env bun
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const parseToml = Bun.TOML.parse;

import { renderPublicPlatformCompatibilityTable } from '../../../tools/release/platform-compatibility-policy.mts';
import { loadExtensionTargetProfiles } from '../../extensions/contracts/extension-target-profiles.mts';
import { documentedProducts, publishedProducts } from './published-products.mts';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const docsRoot = path.resolve(scriptDir, '..');
const repoRoot = path.resolve(scriptDir, '../../..');
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
    normalizeMdxComments(
      substituteVersions(
        readText(from).replace(
          '<!-- oliphaunt-platforms -->',
          renderPublicPlatformCompatibilityTable(),
        ),
        context,
      ),
    ),
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

export function generateExtensionCatalog(root = repoRoot) {
  const catalogPath = path.join(root, 'src/extensions/generated/extensions.catalog.json');
  if (!fs.existsSync(catalogPath)) {
    throw new Error('extension catalog source is required for public docs generation');
  }
  const catalog = JSON.parse(readText(catalogPath));
  const projections = path.join(root, 'src/extensions/generated');
  const native = new Map(
    JSON.parse(readText(path.join(projections, 'sdk/extensions.json'))).extensions.map((row) => [
      row.id,
      row,
    ]),
  );
  const wasix = new Set(
    JSON.parse(readText(path.join(projections, 'wasix/extensions.json'))).extensions.map(
      (row) => row.id,
    ),
  );
  const mobile = new Set(
    JSON.parse(readText(path.join(projections, 'mobile/static-registry.json'))).modules.map(
      (row) => row.id,
    ),
  );
  const profiles = loadExtensionTargetProfiles({
    file: path.join(root, 'src/extensions/contracts/extension-target-profiles.toml'),
  });
  const targetRows = profiles.profiles.map(
    (profile) =>
      `| ${escapeMarkdown({ 'native-desktop-v1': 'Native desktop', 'native-mobile-v1': 'iOS and Android', 'wasix-portable-v1': 'WebAssembly (WASIX)' }[profile.id] ?? profile.id)} | ${profile.targets.map((row) => escapeMarkdown(row.target)).join(', ')} |`,
  );
  const rows = (catalog.extensions ?? [])
    .sort((left, right) =>
      String(left['sql-name'] ?? left.id).localeCompare(String(right['sql-name'] ?? right.id)),
    )
    .map((extension) => {
      const control = extension.control ?? {};
      const metadata = native.get(extension.id);
      if (!metadata || !wasix.has(extension.id)) {
        throw new Error(`extension ${extension.id} is missing a runtime packaging projection`);
      }
      const sqlOnly = metadata['native-module-stem'] === null;
      if (!sqlOnly && !mobile.has(extension.id)) {
        throw new Error(`extension ${extension.id} is missing its mobile static registry row`);
      }
      const name = extension['sql-name'] ?? extension.id;
      const displayName = extension['display-name'];
      const label = displayName && displayName !== name ? `${name} (${displayName})` : name;
      return `| ${escapeMarkdown(label)} | ${escapeMarkdown(extensionVersion(control['default-version']))} | ${escapeMarkdown(extensionFamily(extension['source-kind']))} | Declared | ${sqlOnly ? 'SQL resources' : 'Declared'} | Declared | ${escapeMarkdown(extensionActivation(extension))} |`;
    });
  return `---
title: Extension catalog
---

Find SQL names, activation methods, and declared packaging targets. Follow your [SDK setup](/docs/reference/extensions) to install and select an extension before opening a database. Versions here describe the upstream extension, not its Oliphaunt package.

## Packaging targets

The catalog uses the shared target contract below. Native desktop packages, native mobile resources, and portable WASIX packages are separate artifacts. WebAssembly PostgreSQL can use its portable extensions in browsers and supported Rust or JavaScript hosts; check [host requirements](/docs/reference/capabilities#supported-webassembly-hosts).

| Target profile | Declared targets |
| --- | --- |
${targetRows.join('\n')}

## Extensions

**Declared** means the extension is included in the corresponding packaging contract. These columns do not certify a particular release or device; check the [completed release](/docs/reference/version-matrix), use matching runtime packages, and test your selected extensions on the application target. **SQL resources** means the extension needs no native static module.

| SQL extension | Upstream version | Source | Native desktop | iOS / Android | WebAssembly | Activation |
| --- | --- | --- | --- | --- | --- | --- |
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
    description:
      'Choose an SDK for mobile, browsers, or desktop, with native or WebAssembly PostgreSQL.',
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
    description:
      'Native PostgreSQL for Rust desktop and Tauri, with direct, broker, and server modes.',
    icon: 'Laptop',
  },
  'oliphaunt-swift': {
    description: 'Apple SDK for iOS and macOS apps using Swift concurrency.',
    icon: 'Smartphone',
  },
  'oliphaunt-kotlin': {
    description: 'PostgreSQL for Android apps using coroutines.',
    icon: 'Smartphone',
  },
  'oliphaunt-react-native': {
    description: 'Native PostgreSQL for iOS and Android with React Native and Expo native builds.',
    icon: 'Layers',
  },
  'oliphaunt-js': {
    description: 'Native PostgreSQL for Node.js, Bun, Deno, and Electron.',
    icon: 'Braces',
  },
  'oliphaunt-wasix-rust': {
    description: 'WebAssembly PostgreSQL for Rust desktop and Tauri apps.',
    icon: 'Boxes',
  },
  'oliphaunt-wasix-typescript': {
    description: 'WebAssembly PostgreSQL for browsers, Node.js, Bun, Deno, and Electron.',
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
    metadata.root = false;
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
      'PostgreSQL for iOS, Android, React Native, browsers, and desktop apps, with native and WebAssembly runtimes.',
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
    root: false,
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

function currentGitSha() {
  return (
    process.env.OLIPHAUNT_DOCS_GIT_SHA ||
    process.env.VERCEL_GIT_COMMIT_SHA ||
    execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim()
  );
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
  const context = await documentedProducts();
  writeJson(path.join(staticRoot, 'docs-version.json'), {
    sourceRevision: currentGitSha(),
    dirty:
      execFileSync('git', ['status', '--porcelain'], {
        cwd: repoRoot,
        encoding: 'utf8',
      }).trim().length > 0,
    products: context,
  });
  for (const route of manifest.routes ?? []) {
    copyRoutePages(route, context);
  }

  fs.writeFileSync(
    path.join(siteDocsRoot, 'reference', 'extension-catalog.md'),
    generateExtensionCatalog(),
  );
  const rows = Object.entries(context).map(([id, product]) => {
    const published = products[id];
    return `| ${id} | ${product.version} | ${published ? `[${published.version}](${published.url})` : 'No completed release'} |`;
  });
  fs.writeFileSync(
    path.join(siteDocsRoot, 'reference', 'version-matrix.md'),
    '---\ntitle: Versions\ndescription: Package versions used by these guides and links to completed releases.\n---\n\nInstall examples and API descriptions use the documented versions below. The last column links to completed public releases; it may lag the documented version.\n\n| Product | Documented version | Latest completed release |\n| --- | --- | --- |\n' +
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
