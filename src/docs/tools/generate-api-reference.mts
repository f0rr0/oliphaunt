#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parse as parseToml } from 'smol-toml';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const docsRoot = path.resolve(scriptDir, '..');
const repoRoot = path.resolve(scriptDir, '../../..');
const manifestPath = path.join(docsRoot, 'docs-manifest.toml');
const apiRoot = path.join(repoRoot, 'target', 'docs', 'generated', 'api');
const summaryPath = path.join(apiRoot, 'summary.json');

function readText(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function parseTomlFile(filePath) {
  return parseToml(readText(filePath));
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function relative(filePath) {
  return path.relative(repoRoot, filePath).replaceAll(path.sep, '/');
}

function statusRecord(route, status, details) {
  return {
    id: route.id,
    productId: route.product_id,
    title: route.title,
    referenceKind: route.reference_kind,
    status,
    ...details,
  };
}

function parseCHeader(headerPath) {
  const header = readText(headerPath);
  const withoutComments = header.replace(/\/\*[\s\S]*?\*\//g, '');
  const functions = [
    ...withoutComments.matchAll(
      /\b(?:int32_t|uint64_t|void|const\s+char\s+\*)\s+(oliphaunt_[a-z0-9_]+)\s*\(([\s\S]*?)\);/g,
    ),
  ].map((match) => ({
    name: match[1],
    args: match[2].replace(/\s+/g, ' ').trim(),
  }));
  const constants = [
    ...header.matchAll(/^#define[ \t]+(OLIPHAUNT_[A-Z0-9_]+)(?:[ \t]+([^\r\n]+))?$/gm),
  ]
    .map((match) => ({
      name: match[1],
      value: (match[2] ?? '').trim(),
    }))
    .filter((constant) => constant.value.length > 0);
  return { functions, constants };
}

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function writeCReference(manifest, route, fullMode) {
  const config = manifest.api_reference?.c ?? {};
  const headerPath = path.join(
    repoRoot,
    config.header ?? 'src/runtimes/liboliphaunt/native/include/oliphaunt.h',
  );
  const outputRoot = path.join(apiRoot, 'c');
  const xmlRoot = path.join(outputRoot, 'xml');
  ensureDir(xmlRoot);

  const parsed = parseCHeader(headerPath);
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<doxygen>
  <compounddef kind="file">
    <compoundname>${escapeXml(relative(headerPath))}</compoundname>
    <sectiondef kind="define">
${parsed.constants
  .map(
    (constant) =>
      `      <memberdef kind="define"><name>${escapeXml(constant.name)}</name><initializer>${escapeXml(constant.value)}</initializer></memberdef>`,
  )
  .join('\n')}
    </sectiondef>
    <sectiondef kind="func">
${parsed.functions
  .map(
    (fn) =>
      `      <memberdef kind="function"><name>${escapeXml(fn.name)}</name><argsstring>(${escapeXml(fn.args)})</argsstring></memberdef>`,
  )
  .join('\n')}
    </sectiondef>
  </compounddef>
</doxygen>
`;
  const fallbackXmlPath = path.join(xmlRoot, 'oliphaunt-header.xml');
  fs.writeFileSync(fallbackXmlPath, xml);

  const markdownPath = path.join(outputRoot, 'reference.md');
  fs.writeFileSync(
    markdownPath,
    `# C ABI Reference

Generated from \`${relative(headerPath)}\`.

## Functions

${parsed.functions.map((fn) => `- \`${fn.name}(${fn.args})\``).join('\n')}

## Constants

${parsed.constants.map((constant) => `- \`${constant.name}\` = \`${constant.value}\``).join('\n')}
`,
  );

  const expectedDoxygenXml = path.join(apiRoot, 'c', 'doxygen', 'xml', 'index.xml');
  const generatedByDoxygen = fs.existsSync(expectedDoxygenXml);
  const fullModeRequiresDoxygen = fullMode && Boolean(config.doxygen_config);
  const doxygenStatus = generatedByDoxygen ? 'generated' : 'not-run';
  const doxygenXmlPath = generatedByDoxygen ? relative(expectedDoxygenXml) : '';
  const doxygenFailureReason =
    fullModeRequiresDoxygen && !generatedByDoxygen
      ? 'Run moon run liboliphaunt-native:docs-api'
      : '';

  return statusRecord(
    route,
    fullModeRequiresDoxygen && !generatedByDoxygen ? 'failed' : 'generated',
    {
      artifact: relative(markdownPath),
      machineReadableArtifact: relative(fallbackXmlPath),
      docsEntry: relative(markdownPath),
      symbolCount: parsed.functions.length,
      constantCount: parsed.constants.length,
      generator: generatedByDoxygen ? 'doxygen+xml' : 'header-parser+xml',
      doxygenStatus,
      doxygenXmlPath,
      reason: doxygenFailureReason,
    },
  );
}

function referenceArtifact(route, entry, generator, fullMode) {
  const exists = fs.existsSync(path.join(repoRoot, entry));
  return statusRecord(route, exists ? 'generated' : fullMode ? 'failed' : 'configured', {
    artifact: entry,
    docsEntry: entry,
    generator,
    reason: exists ? '' : 'Run the product docs-api task to generate this reference.',
  });
}

function routeById(manifest, id) {
  return manifest.routes.find((route) => route.id === id);
}

export function generateApiReferenceArtifacts(options = {}) {
  const manifest = options.manifest ?? parseTomlFile(manifestPath);
  const fullMode = options.mode === 'release' || options.mode === 'full';
  ensureDir(apiRoot);
  fs.rmSync(summaryPath, { force: true });

  const records = [
    writeCReference(manifest, routeById(manifest, 'liboliphaunt-native'), fullMode),
    ...[
      ['oliphaunt-rust', 'rust', 'cargo doc'],
      ['oliphaunt-swift', 'swift', 'Swift-DocC'],
      ['oliphaunt-kotlin', 'kotlin', 'Dokka v2'],
      ['oliphaunt-react-native', 'react_native', 'TypeDoc'],
      ['oliphaunt-js', 'typescript', 'TypeDoc'],
      ['oliphaunt-wasix-rust', 'wasix_rust', 'cargo doc'],
      ['oliphaunt-wasix-typescript', 'wasix_typescript', 'TypeDoc'],
    ].map(([id, key, generator]) =>
      referenceArtifact(
        routeById(manifest, id),
        manifest.api_reference[key].docs_entry,
        generator,
        fullMode,
      ),
    ),
  ];

  const summary = {
    mode: fullMode ? 'release' : 'fast',
    generatedAt: new Date().toISOString(),
    records,
  };
  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const modeArg = process.argv.find((arg) => arg.startsWith('--mode='));
  const mode = modeArg ? modeArg.split('=')[1] : 'fast';
  const summary = generateApiReferenceArtifacts({ mode });
  console.log(
    `generated API reference status for ${summary.records.length} surfaces (${summary.mode})`,
  );
  const requireGenerated =
    mode === 'release' || process.env.OLIPHAUNT_DOCS_REQUIRE_NATIVE_API === '1';
  const failed = summary.records.filter((record) =>
    requireGenerated ? record.status !== 'generated' : record.status === 'failed',
  );
  if (failed.length > 0) {
    for (const record of failed) {
      console.error(`${record.id}: ${record.status}: ${record.reason || record.doxygenStatus}`);
    }
    process.exit(1);
  }
}
