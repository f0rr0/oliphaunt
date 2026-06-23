#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();

const readmes = [
  {
    sdk: 'rust',
    path: 'src/sdks/rust/README.md',
    languages: new Set(['rust']),
  },
  {
    sdk: 'swift',
    path: 'src/sdks/swift/README.md',
    languages: new Set(['swift']),
  },
  {
    sdk: 'kotlin',
    path: 'src/sdks/kotlin/README.md',
    languages: new Set(['kotlin']),
  },
  {
    sdk: 'react-native',
    path: 'src/sdks/react-native/README.md',
    languages: new Set(['ts', 'typescript']),
  },
];

const coverageRoots = [
  'src/sdks/rust/tests',
  'src/sdks/swift/Tests',
  'src/sdks/kotlin/oliphaunt/src',
  'src/sdks/react-native/src/__tests__',
];

const markerPattern = /liboliphaunt-doc-example:([a-z0-9][a-z0-9_.-]*)/g;

function readFile(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function lineNumberAt(source, offset) {
  return source.slice(0, offset).split('\n').length;
}

function previousNonEmptyLine(lines, index) {
  for (let i = index - 1; i >= 0; i -= 1) {
    if (lines[i].trim().length > 0) {
      return {line: lines[i], index: i};
    }
  }
  return null;
}

function collectReadmeExamples(spec) {
  const source = readFile(spec.path);
  const lines = source.split('\n');
  const examples = [];
  let inFence = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const fence = line.match(/^```([A-Za-z0-9_-]*)\s*$/);
    if (!fence) {
      continue;
    }
    if (inFence) {
      inFence = false;
      continue;
    }
    inFence = true;
    const language = fence[1].toLowerCase();
    if (!spec.languages.has(language)) {
      continue;
    }
    const previous = previousNonEmptyLine(lines, i);
    const marker = previous?.line.match(/liboliphaunt-doc-example:([a-z0-9][a-z0-9_.-]*)/);
    if (!marker) {
      throw new Error(
        `${spec.path}:${i + 1} ${language} example must be preceded by a liboliphaunt-doc-example marker`,
      );
    }
    examples.push({
      id: marker[1],
      file: spec.path,
      line: i + 1,
      language,
    });
  }

  const markerIds = new Set();
  for (const match of source.matchAll(markerPattern)) {
    const id = match[1];
    markerIds.add(id);
    const line = lineNumberAt(source, match.index ?? 0);
    const following = lines.slice(line).find(entry => entry.trim().length > 0);
    if (!following?.startsWith('```')) {
      throw new Error(
        `${spec.path}:${line} doc-example marker ${id} must be immediately followed by a fenced code block`,
      );
    }
  }

  for (const id of markerIds) {
    if (!examples.some(example => example.id === id)) {
      throw new Error(`${spec.path} marker ${id} did not attach to a tracked code example`);
    }
  }

  return examples;
}

function listFiles(dir) {
  const fullDir = path.join(root, dir);
  if (!fs.existsSync(fullDir)) {
    return [];
  }
  const files = [];
  for (const entry of fs.readdirSync(fullDir, {withFileTypes: true})) {
    const relative = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(relative));
    } else if (entry.isFile()) {
      files.push(relative);
    }
  }
  return files;
}

function collectCoverageMarkers() {
  const markers = new Map();
  for (const file of coverageRoots.flatMap(listFiles)) {
    const source = readFile(file);
    for (const match of source.matchAll(markerPattern)) {
      const id = match[1];
      const entries = markers.get(id) ?? [];
      entries.push({
        file,
        line: lineNumberAt(source, match.index ?? 0),
      });
      markers.set(id, entries);
    }
  }
  return markers;
}

const examples = readmes.flatMap(collectReadmeExamples);
const seen = new Map();
for (const example of examples) {
  const previous = seen.get(example.id);
  if (previous) {
    throw new Error(
      `duplicate doc-example id ${example.id}: ${previous.file}:${previous.line} and ${example.file}:${example.line}`,
    );
  }
  seen.set(example.id, example);
}

const coverage = collectCoverageMarkers();
for (const example of examples) {
  if (!coverage.has(example.id)) {
    throw new Error(
      `${example.file}:${example.line} doc-example ${example.id} has no SDK test/source coverage marker`,
    );
  }
}

for (const [id, entries] of coverage) {
  if (!seen.has(id)) {
    const first = entries[0];
    throw new Error(`${first.file}:${first.line} stale SDK doc-example coverage marker ${id}`);
  }
}

console.log(`SDK README example coverage checks passed (${examples.length} examples).`);
