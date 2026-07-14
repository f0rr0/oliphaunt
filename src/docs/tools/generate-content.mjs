#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parse as parseToml } from 'smol-toml';

import { generateApiReferenceArtifacts } from './generate-api-reference.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const docsRoot = path.resolve(scriptDir, '..');
const repoRoot = path.resolve(scriptDir, '../../..');
const manifestPath = path.join(docsRoot, 'docs-manifest.toml');
const generatedRoot = path.join(repoRoot, 'target', 'docs');
const siteDocsRoot = path.join(generatedRoot, 'site-docs');
const staticRoot = path.join(generatedRoot, 'static');
const staticApiArtifactsRoot = path.join(staticRoot, 'api-artifacts');
const generatedMetaRoot = path.join(generatedRoot, 'generated');
const generationLockDir = path.join(generatedRoot, '.generate.lock');
const generationLockMetadata = path.join(generationLockDir, 'owner.json');

const SKIP_DIRS = new Set(['node_modules', '.git', '.moon', '.docusaurus', 'build', 'target']);

function readText(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function parseTomlFile(filePath) {
  return parseToml(readText(filePath));
}

function parseJsonFile(filePath) {
  return JSON.parse(readText(filePath));
}

function releaseProductMetadata() {
  const releasePlease = parseJsonFile(path.join(repoRoot, 'release-please-config.json'));
  const releaseManifest = parseJsonFile(path.join(repoRoot, '.release-please-manifest.json'));
  const packages = releasePlease.packages ?? {};
  const tagSeparator = releasePlease['tag-separator'] ?? '-';
  const tagVersionPrefix = releasePlease['include-v-in-tag'] === false ? '' : 'v';
  const defaultInitialVersion = releasePlease['initial-version'];
  const linkedVersionGroups = new Map();
  for (const plugin of releasePlease.plugins ?? []) {
    if (plugin?.type !== 'linked-versions' || typeof plugin.groupName !== 'string') {
      continue;
    }
    for (const component of plugin.components ?? []) {
      linkedVersionGroups.set(component, plugin.groupName);
    }
  }
  const products = {};
  for (const [packagePath, packageConfig] of Object.entries(packages)) {
    const productId = packageConfig.component;
    if (!productId) {
      throw new Error(`release-please package ${packagePath} is missing component`);
    }
    const metadata = parseTomlFile(path.join(repoRoot, packagePath, 'release.toml'));
    const currentVersion = releaseManifest[packagePath];
    const initialVersion = packageConfig['initial-version'] ?? defaultInitialVersion;
    if (typeof currentVersion !== 'string' || typeof initialVersion !== 'string') {
      throw new Error(`release version metadata is incomplete for ${productId}`);
    }
    const extensionVersioning = metadata.extension?.versioning;
    const linkedVersionGroup = linkedVersionGroups.get(productId);
    products[productId] = {
      ...metadata,
      current_version: currentVersion,
      initial_version: initialVersion,
      version_relationship:
        extensionVersioning ??
        (linkedVersionGroup ? `linked:${linkedVersionGroup}` : 'independent'),
      tag_prefix: `${productId}${tagSeparator}${tagVersionPrefix}`,
    };
  }
  return {
    policy: {
      repository: 'f0rr0/oliphaunt',
      default_branch: 'main',
      versioning: 'independent',
      extension_selection: 'exact-sql-extension',
    },
    input_groups: {},
    products,
  };
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function resetDir(dirPath) {
  fs.rmSync(dirPath, { force: true, recursive: true });
  ensureDir(dirPath);
}

function resetGeneratedMetadata() {
  ensureDir(generatedMetaRoot);
  for (const entry of fs.readdirSync(generatedMetaRoot, { withFileTypes: true })) {
    if (entry.name === 'api') {
      continue;
    }
    fs.rmSync(path.join(generatedMetaRoot, entry.name), { force: true, recursive: true });
  }
}

function sleep(milliseconds) {
  const buffer = new SharedArrayBuffer(4);
  const view = new Int32Array(buffer);
  Atomics.wait(view, 0, 0, milliseconds);
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function removeStaleGenerationLock() {
  if (!fs.existsSync(generationLockDir)) {
    return false;
  }
  try {
    if (fs.existsSync(generationLockMetadata)) {
      const metadata = JSON.parse(readText(generationLockMetadata));
      if (!processIsAlive(metadata.pid)) {
        fs.rmSync(generationLockDir, { force: true, recursive: true });
        return true;
      }
      return false;
    }
    const stat = fs.statSync(generationLockDir);
    if (Date.now() - stat.mtimeMs > 120_000) {
      fs.rmSync(generationLockDir, { force: true, recursive: true });
      return true;
    }
  } catch {
    fs.rmSync(generationLockDir, { force: true, recursive: true });
    return true;
  }
  return false;
}

function withGenerationLock(callback) {
  ensureDir(generatedRoot);
  const started = Date.now();
  while (true) {
    try {
      fs.mkdirSync(generationLockDir);
      fs.writeFileSync(
        generationLockMetadata,
        `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }, null, 2)}\n`,
      );
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        throw error;
      }
      if (removeStaleGenerationLock()) {
        continue;
      }
      if (Date.now() - started > 120_000) {
        throw new Error('timed out waiting for docs generation lock');
      }
      sleep(100);
    }
  }
  try {
    return callback();
  } finally {
    fs.rmSync(generationLockDir, { force: true, recursive: true });
  }
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

function replaceSnippetDirectives(markdown, context) {
  return markdown.replace(
    /<!--\s*oliphaunt-snippet:\s*([a-z0-9_-]+)\s*-->/giu,
    (match, routeId) => {
      if (!context.sdkRoutesById.has(routeId)) {
        throw new Error(`unknown docs snippet route id: ${routeId}`);
      }
      return '';
    },
  );
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

function copyDir(source, destination, context) {
  if (!fs.existsSync(source)) {
    throw new Error(`docs source does not exist: ${path.relative(repoRoot, source)}`);
  }
  ensureDir(destination);
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) {
      continue;
    }
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      copyDir(from, to, context);
    } else if (entry.isFile()) {
      if (/\.mdx?$/u.test(entry.name)) {
        const markdown = normalizeCodeFenceInfoStrings(
          replaceSnippetDirectives(readText(from), context),
        );
        const fallbackTitle = path.basename(entry.name, path.extname(entry.name));
        fs.writeFileSync(to, normalizePageMarkdown(markdown, fallbackTitle));
      } else {
        fs.copyFileSync(from, to);
      }
    }
  }
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
  const markdown = normalizeCodeFenceInfoStrings(replaceSnippetDirectives(readText(from), context));
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
  }
}

function copyStaticPath(source, destination) {
  if (!fs.existsSync(source)) {
    return false;
  }
  ensureDir(path.dirname(destination));
  const stat = fs.statSync(source);
  if (stat.isDirectory()) {
    fs.cpSync(source, destination, { force: true, recursive: true });
  } else if (stat.isFile()) {
    fs.copyFileSync(source, destination);
  }
  return true;
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

function releaseProducts(releaseGraph) {
  return Object.entries(releaseGraph.products ?? {}).sort(([left], [right]) =>
    left.localeCompare(right),
  );
}

function sdkRows(sdkManifest) {
  return Object.entries(sdkManifest.sdks ?? {}).sort(([left], [right]) =>
    left.localeCompare(right),
  );
}

function generateSdkMatrix(sdkManifest) {
  const rows = sdkRows(sdkManifest).map(([id, sdk]) => {
    const modes = (sdk.available_modes ?? []).join(', ');
    return `| ${escapeMarkdown(id)} | ${escapeMarkdown(sdk.package_identity)} | ${escapeMarkdown((sdk.supported_consumer_targets ?? []).join(', '))} | ${escapeMarkdown((sdk.planned_consumer_targets ?? []).join(', ') || 'none')} | ${escapeMarkdown(sdk.runtime_boundary)} | ${escapeMarkdown(modes)} |`;
  });
  return `---
title: SDK Matrix
---

# SDK Matrix

Use this matrix to compare registry-qualified package identities, supported and
planned consumer targets, runtime boundaries, and advertised modes.

| SDK | Package identity | Supported targets | Planned targets | Runtime boundary | Advertised modes |
| --- | --- | --- | --- | --- | --- |
${rows.join('\n')}
`;
}

function generatePlatformMatrix(sdkManifest) {
  const rows = sdkRows(sdkManifest).flatMap(([id, sdk]) =>
    (sdk.supported_consumer_targets ?? []).map(
      (target) =>
        `| ${escapeMarkdown(target)} | ${escapeMarkdown(id)} | ${escapeMarkdown(sdk.package_identity)} |`,
    ),
  );
  return `---
title: Platform And Package Matrix
---

# Platform And Package Matrix

Use this matrix to pick the package for each app target.

| Platform target | SDK | Package |
| --- | --- | --- |
${rows.join('\n')}
`;
}

function generateExtensionCatalog() {
  const catalogPath = path.join(repoRoot, 'src/extensions/generated/extensions.catalog.json');
  if (!fs.existsSync(catalogPath)) {
    throw new Error('extension catalog source is required for public docs generation');
  }
  const catalog = JSON.parse(readText(catalogPath));
  const rows = (catalog.extensions ?? [])
    .filter((extension) => {
      const promotion = extension.promotion ?? {};
      return promotion.stable && promotion.packaged && promotion.promoted;
    })
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
selection uses the SQL extension name. The table shows stable packaged
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

function statusLabel(status) {
  if (status === 'generated') {
    return 'generated';
  }
  if (status === 'configured') {
    return 'configured';
  }
  if (status === 'skipped') {
    return 'skipped';
  }
  return status || 'unknown';
}

function referenceLabel(referenceKind) {
  const labels = {
    doxygen: 'Doxygen header reference',
    rustdoc: 'Rustdoc',
    'swift-docc': 'Swift DocC',
    dokka: 'Dokka',
    typedoc: 'TypeDoc',
  };
  return labels[referenceKind] ?? referenceKind ?? 'API reference';
}

function link(label, href) {
  return href ? `[${label}](${href})` : '';
}

function apiArtifactHref(relativePath) {
  return `/api-artifacts/${relativePath}`;
}

function staticArtifactPlan(record) {
  const plans = {
    'liboliphaunt-native': [
      {
        source: record.artifact,
        destination: 'c/reference.md',
        href: apiArtifactHref('c/reference.md'),
        label: 'Open C ABI Markdown',
      },
      {
        source: record.machineReadableArtifact,
        destination: 'c/xml/oliphaunt-header.xml',
        href: apiArtifactHref('c/xml/oliphaunt-header.xml'),
        label: 'Open C ABI XML',
      },
      {
        source: record.doxygenXmlPath,
        destination: 'c/doxygen/xml/index.xml',
        href: apiArtifactHref('c/doxygen/xml/index.xml'),
        label: 'Open Doxygen XML index',
      },
    ],
    'oliphaunt-rust': [
      {
        source: 'target/docs/generated/api/rust/doc',
        destination: 'rust/doc',
        href: apiArtifactHref('rust/doc/oliphaunt/index.html'),
        label: 'Open rustdoc',
      },
    ],
    'oliphaunt-swift': [
      {
        source: record.artifact,
        destination: 'swift/Oliphaunt.doccarchive',
        href: apiArtifactHref('swift/Oliphaunt.doccarchive/index.html'),
        label: 'Open Swift DocC archive',
      },
    ],
    'oliphaunt-kotlin': [
      {
        source: 'target/docs/generated/api/kotlin/html',
        destination: 'kotlin/html',
        href: apiArtifactHref('kotlin/html/index.html'),
        label: 'Open Dokka reference',
      },
    ],
    'oliphaunt-react-native': [
      {
        source: 'target/docs/generated/api/react-native/html',
        destination: 'react-native/html',
        href: apiArtifactHref('react-native/html/index.html'),
        label: 'Open TypeDoc reference',
      },
    ],
    'oliphaunt-js': [
      {
        source: 'target/docs/generated/api/typescript/html',
        destination: 'typescript/html',
        href: apiArtifactHref('typescript/html/index.html'),
        label: 'Open TypeDoc reference',
      },
    ],
    'oliphaunt-wasix': [
      {
        source: 'target/docs/generated/api/wasm/doc',
        destination: 'wasm/doc',
        href: apiArtifactHref('wasm/doc/oliphaunt_wasix/index.html'),
        label: 'Open WASM rustdoc',
      },
    ],
  };
  return plans[record.id] ?? [];
}

function copyApiArtifactsToStatic(apiSummary) {
  const linksByRecordId = new Map();
  for (const record of apiSummary.records ?? []) {
    const links = [];
    for (const plan of staticArtifactPlan(record)) {
      if (!plan.source) {
        continue;
      }
      const source = assertInsideRepo(plan.source, `API artifact for ${record.id}`);
      const destination = path.join(staticApiArtifactsRoot, plan.destination);
      if (copyStaticPath(source, destination)) {
        links.push({
          label: plan.label,
          href: plan.href,
        });
      }
    }
    linksByRecordId.set(record.id, links);
  }
  return linksByRecordId;
}

function cReferenceBody(record) {
  if (record.id !== 'liboliphaunt-native' || !record.artifact) {
    return '';
  }
  const artifactPath = path.join(repoRoot, record.artifact);
  if (!fs.existsSync(artifactPath)) {
    return '';
  }
  return readText(artifactPath)
    .replace(/^# C ABI Reference\s*/u, '')
    .trim();
}

function generateApiReference(manifest) {
  const rows = manifest.routes
    .filter((route) => route.kind === 'sdk')
    .map((route) => {
      const reference = referenceLabel(route.reference_kind);
      return `| ${escapeMarkdown(route.title)} | [Open](/docs/${route.route}/api-reference) | ${escapeMarkdown(reference)} |`;
    });
  return `---
title: API Reference
---

# API Reference

Use this page when you know the SDK and need the API surface by task. SDK guides
show the first integration path. These maps point to the language reference for
configuration, query results, lifecycle, extension selection, backup and
restore, and error handling.

## Choose By Task

| Task | Look for |
| --- | --- |
| Open a database | builder or open configuration, root storage, runtime mode, durability |
| Run SQL | query, execute, parameters, row access, result typing |
| Use raw protocol | raw bytes, streaming, response ownership, cancellation |
| Manage lifecycle | close, background, foreground, cancellation, capability checks |
| Move data | backup, restore, dump, archive validation |
| Ship extensions | exact SQL extension names, dependency files, artifact reports |
| Handle errors | SDK errors, PostgreSQL SQLSTATE data, capability errors |

## Language References

| Surface | Reference page | Native reference format |
| --- | --- | --- |
${rows.join('\n')}
`;
}

function generateSdkApiReferencePage(record, artifactLinks = []) {
  const cBody = cReferenceBody(record);
  const links = artifactLinks
    .map((artifactLink) => `- ${link(artifactLink.label, artifactLink.href)}`)
    .join('\n');
  const reference = referenceLabel(record.referenceKind);
  return `---
title: ${record.title}
---

# ${record.title}

Use this page with the ${reference}. Product guides explain runtime behavior;
the API reference gives exact declarations for the released SDK.

${statusLabel(record.status) === 'generated' && links ? `## Reference\n\n${links}\n` : ''}
${cBody ? `## Symbols\n\n${cBody}\n` : ''}
`;
}

function apiReferenceFileName(record) {
  const names = {
    'liboliphaunt-native': 'c-abi',
    'oliphaunt-rust': 'rust',
    'oliphaunt-swift': 'swift',
    'oliphaunt-kotlin': 'kotlin',
    'oliphaunt-react-native': 'react-native',
    'oliphaunt-js': 'typescript',
    'oliphaunt-wasix': 'wasm',
  };
  return names[record.id] ?? record.id;
}

function generateTestedSnippets(manifest) {
  const rows = manifest.routes
    .filter((route) => route.kind === 'sdk')
    .map(
      (route) =>
        `| ${escapeMarkdown(route.title)} | ${escapeMarkdown(route.tested_snippet_marker)} | ${escapeMarkdown(route.tested_snippet_path)} |`,
    );
  return `---
title: Tested Snippets
---

# Tested Snippets

Public SDK snippets are tied to executable product tests or smoke files by
marker. The docs checker fails when a marker disappears.

| Surface | Marker | Executable source |
| --- | --- | --- |
${rows.join('\n')}
`;
}

function generateArtifactProvenance(releaseGraph) {
  const rows = releaseProducts(releaseGraph).map(([id, product]) => {
    return `| ${escapeMarkdown(id)} | ${escapeMarkdown((product.publish_targets ?? []).join(', '))} | ${escapeMarkdown((product.release_artifacts ?? []).join(', '))} | ${escapeMarkdown(product.tag_prefix)} |`;
  });
  return `---
title: Artifact And Provenance Matrix
---

# Artifact And Provenance Matrix

Release verification checks asset checksums, attestations, and registry
publication for these surfaces.

| Product | Publish targets | Release artifacts | Tag prefix |
| --- | --- | --- | --- |
${rows.join('\n')}
`;
}

function generateVersionMatrix(releaseGraph) {
  const rows = releaseProducts(releaseGraph).map(([id, product]) => {
    const currentVersion =
      product.current_version === '0.0.0'
        ? `${product.current_version} (unreleased)`
        : product.current_version;
    return `| ${escapeMarkdown(id)} | ${escapeMarkdown(currentVersion)} | ${escapeMarkdown(product.initial_version)} | ${escapeMarkdown(product.version_relationship)} | ${escapeMarkdown((product.publish_targets ?? []).join(', ') || 'none')} | ${escapeMarkdown(product.tag_prefix)} |`;
  });
  return `---
title: Version Matrix
---

# Version Matrix

Products are versioned independently.

The source version \`0.0.0\` is the unreleased sentinel, not a public registry
version. The first-public-version column is derived from Release Please's
global or per-product initial version.

Use this matrix before upgrading an app dependency. Start with the package your
app installs, then read the products it depends on for runtime artifact,
extension, and compatibility notes. A linked or runtime-bound release
relationship does not turn the repository into one version.

Release coupling is derived from Moon production and peer dependency scopes.

| Product | Current source version | First public version | Version relationship | Publish targets | Tag prefix |
| --- | --- | --- | --- | --- | --- |
${rows.join('\n')}
`;
}

function routePageSet(manifest, routeId) {
  const route = (manifest.routes ?? []).find((entry) => entry.id === routeId);
  return new Set(route?.page_order ?? []);
}

function writeGeneratedReferencePages(
  manifest,
  sdkManifest,
  releaseGraph,
  apiSummary,
  artifactLinksByRecordId,
) {
  const referenceRoot = path.join(siteDocsRoot, 'reference');
  const apiRootForSite = path.join(referenceRoot, 'api');
  const referencePages = routePageSet(manifest, 'reference');
  ensureDir(referenceRoot);
  if (referencePages.has('sdk-matrix')) {
    fs.writeFileSync(path.join(referenceRoot, 'sdk-matrix.md'), generateSdkMatrix(sdkManifest));
  }
  if (referencePages.has('platforms')) {
    fs.writeFileSync(path.join(referenceRoot, 'platforms.md'), generatePlatformMatrix(sdkManifest));
  }
  if (referencePages.has('extension-catalog')) {
    fs.writeFileSync(path.join(referenceRoot, 'extension-catalog.md'), generateExtensionCatalog());
  }
  if (referencePages.has('api-reference')) {
    fs.writeFileSync(path.join(referenceRoot, 'api-reference.md'), generateApiReference(manifest));
  }
  const apiPages = [...referencePages]
    .filter((page) => page.startsWith('api/'))
    .map((page) => page.slice('api/'.length));
  if (apiPages.length > 0) {
    ensureDir(apiRootForSite);
    for (const record of apiSummary.records ?? []) {
      const fileName = apiReferenceFileName(record);
      if (!apiPages.includes(fileName)) {
        continue;
      }
      fs.writeFileSync(
        path.join(apiRootForSite, `${fileName}.md`),
        generateSdkApiReferencePage(record, artifactLinksByRecordId.get(record.id) ?? []),
      );
    }
  }
  if (referencePages.has('tested-snippets')) {
    fs.writeFileSync(
      path.join(referenceRoot, 'tested-snippets.md'),
      generateTestedSnippets(manifest),
    );
  }
  if (referencePages.has('artifact-provenance')) {
    fs.writeFileSync(
      path.join(referenceRoot, 'artifact-provenance.md'),
      generateArtifactProvenance(releaseGraph),
    );
  }
  if (referencePages.has('version-matrix')) {
    fs.writeFileSync(
      path.join(referenceRoot, 'version-matrix.md'),
      generateVersionMatrix(releaseGraph),
    );
  }
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
    description: 'Choose Rust, Swift, Kotlin, React Native, TypeScript, WASM, or the C ABI.',
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
    description: 'TypeScript SDK for Node.js, Bun, Deno, and Tauri JavaScript apps.',
    icon: 'Braces',
  },
  'oliphaunt-wasix': {
    description: 'First-class WASM/WASIX runtime family and dump/restore flows.',
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
      'Embedded PostgreSQL SDK documentation for native, mobile, desktop, React Native, TypeScript, and WASM apps.',
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
    'Oliphaunt is embedded PostgreSQL for native, mobile, desktop, React Native, TypeScript, and WASM apps.',
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

function appliesToForRoute(route) {
  if (route.applies_to) {
    return String(route.applies_to);
  }
  if (route.kind === 'sdk' && route.product_id) {
    return `current ${route.product_id}`;
  }
  return 'current';
}

function routeForGeneratedPage(manifest, pageRoute) {
  const candidates = (manifest.routes ?? [])
    .filter((route) => {
      const root = `/${route.route}`;
      return pageRoute === root || pageRoute.startsWith(`${root}/`);
    })
    .sort((left, right) => right.route.length - left.route.length);
  return candidates[0];
}

function ensureApplicabilityFrontmatter(markdown, appliesTo) {
  const escaped = yamlString(appliesTo);
  const frontmatterMatch = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/u);
  if (!frontmatterMatch) {
    return `---\napplies_to: ${escaped}\n---\n\n${markdown}`;
  }
  if (/^applies_to\s*:/mu.test(frontmatterMatch[1])) {
    return markdown;
  }
  return markdown.replace(/^---\r?\n/u, `---\napplies_to: ${escaped}\n`);
}

function stampApplicabilityMetadata(manifest) {
  for (const file of collectMarkdownFiles(siteDocsRoot)) {
    const pageRoute = markdownRouteFor(file);
    const route = routeForGeneratedPage(manifest, pageRoute);
    if (!route) {
      throw new Error(`no docs manifest route owns generated page ${pageRoute}`);
    }
    const markdown = readText(file);
    fs.writeFileSync(
      file,
      stripMatchingLeadingTitleHeading(
        ensureApplicabilityFrontmatter(markdown, appliesToForRoute(route)),
      ),
    );
  }
}

function currentGitSha() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
    }).trim();
  } catch {
    return 'unknown';
  }
}

function generateDocsUnlocked(options = {}) {
  const manifest = parseTomlFile(manifestPath);
  const sdkManifest = parseTomlFile(path.join(repoRoot, 'tools/policy/sdk-manifest.toml'));
  const releaseGraph = releaseProductMetadata();
  const apiSummary = generateApiReferenceArtifacts({
    manifest,
    mode: options.apiMode ?? 'fast',
  });

  resetDir(siteDocsRoot);
  resetDir(staticRoot);
  resetGeneratedMetadata();
  copyDir(path.join(docsRoot, 'static'), staticRoot);
  const artifactLinksByRecordId = options.publishApiArtifacts
    ? copyApiArtifactsToStatic(apiSummary)
    : new Map();

  const context = {
    sdkRoutesById: new Map(
      (manifest.routes ?? [])
        .filter((route) => route.kind === 'sdk')
        .map((route) => [route.id, route]),
    ),
  };

  for (const route of manifest.routes ?? []) {
    copyRoutePages(route, context);
  }

  writeGeneratedReferencePages(
    manifest,
    sdkManifest,
    releaseGraph,
    apiSummary,
    artifactLinksByRecordId,
  );
  stampApplicabilityMetadata(manifest);

  const routeRecords = collectMarkdownFiles(siteDocsRoot).map((file) => {
    const markdown = readText(file);
    return {
      route: markdownRouteFor(file),
      docId: markdownDocIdFor(file),
      title:
        frontmatterValue(markdown, 'title') ||
        firstHeading(markdown, path.basename(file, path.extname(file))),
      appliesTo: frontmatterValue(markdown, 'applies_to'),
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
        apiReferenceMode: apiSummary.mode,
        apiArtifactsPublished: Boolean(options.publishApiArtifacts),
      },
      null,
      2,
    )}\n`,
  );

  return {
    manifest,
    sdkManifest,
    releaseGraph,
    apiSummary,
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

export function generateDocs(options = {}) {
  return withGenerationLock(() => generateDocsUnlocked(options));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const modeArg = process.argv.find((arg) => arg.startsWith('--api-mode='));
  const apiMode = modeArg ? modeArg.split('=')[1] : 'fast';
  const publishApiArtifacts = process.argv.includes('--publish-api-artifacts');
  const result = generateDocs({ apiMode, publishApiArtifacts });
  console.log(
    `generated ${result.routeRecords.length} docs routes in target/docs (api artifacts published: ${publishApiArtifacts})`,
  );
}
