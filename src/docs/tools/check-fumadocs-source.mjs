#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const docsRoot = path.resolve(scriptDir, '..');
const sourceRoot = path.join(docsRoot, '.source');

const requiredFiles = [
  {
    file: 'server.ts',
    pattern: /\bexport\s+const\s+docs\b/u,
  },
  {
    file: 'browser.ts',
    pattern: /\bexport\s+default\s+browserCollections\b/u,
  },
  {
    file: 'dynamic.ts',
    pattern: /\bdynamic<.*\bConfig\b/su,
  },
];

for (const required of requiredFiles) {
  const filePath = path.join(sourceRoot, required.file);
  if (!fs.existsSync(filePath)) {
    console.error(`Fumadocs generated source is missing: .source/${required.file}`);
    process.exit(1);
  }
  const text = fs.readFileSync(filePath, 'utf8');
  if (text.trim().length === 0) {
    console.error(`Fumadocs generated source is empty: .source/${required.file}`);
    process.exit(1);
  }
  if (!required.pattern.test(text)) {
    console.error(`Fumadocs generated source is malformed: .source/${required.file}`);
    process.exit(1);
  }
}
