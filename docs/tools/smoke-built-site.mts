#!/usr/bin/env bun
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '../..');
const buildRoot = path.join(repoRoot, 'target', 'docs', 'build');
const routesPath = path.join(repoRoot, 'target', 'docs', 'generated', 'routes.json');

function fail(message) {
  console.error(message);
  process.exit(1);
}

function findFiles(root, predicate) {
  const files = [];
  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
      } else if (entry.isFile() && predicate(fullPath)) {
        files.push(fullPath);
      }
    }
  }
  if (fs.existsSync(root)) {
    visit(root);
  }
  return files;
}

if (!fs.existsSync(buildRoot)) {
  fail('docs build output is missing; run bun run build first');
}

if (!fs.existsSync(routesPath)) {
  fail('generated docs route metadata is missing; run docs generation before smoke');
}

const htmlFiles = findFiles(buildRoot, (file) => file.endsWith('.html'));
if (htmlFiles.length === 0) {
  fail('docs build produced no HTML files');
}

function routeHtmlPath(route) {
  const normalized = route === '/' ? 'index' : route.replace(/^\/+/u, '').replace(/\/$/u, '');
  return path.join(buildRoot, normalized, 'index.html');
}

const routeMetadata = JSON.parse(fs.readFileSync(routesPath, 'utf8'));
for (const record of routeMetadata.routes ?? []) {
  const route = record.route === '/' ? '/' : `/docs${record.route}`;
  const htmlPath = routeHtmlPath(route);
  if (!fs.existsSync(htmlPath)) {
    fail(
      `docs build did not export generated route ${route}: ${path.relative(repoRoot, htmlPath)}`,
    );
  }
}

for (const staticFile of ['llms.txt', 'llms-full.txt']) {
  const fullPath = path.join(buildRoot, staticFile);
  if (!fs.existsSync(fullPath)) {
    fail(`docs build did not publish ${staticFile}`);
  }
}

console.log(`docs smoke passed (${htmlFiles.length} HTML files)`);
