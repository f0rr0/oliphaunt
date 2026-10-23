/** Assemble an internal native member payload from explicit Bazel inputs. */
import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { gzipSync } from 'node:zlib';
import { tarHeader } from '../../tools/packaging/archive-directory.mts';
import { portableMemberName } from '../../tools/packaging/portable-archive.mts';

export interface MemberSpec {
  descriptor: Record<string, unknown>;
  inputs: { source: string; destination: string; tree?: boolean }[];
}

function compareText(left: string, right: string): number {
  const a = Array.from(left, (character) => character.codePointAt(0) ?? 0);
  const b = Array.from(right, (character) => character.codePointAt(0) ?? 0);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return a.length - b.length;
}

// Preserve the prior inventory's sorted keys, two-space indentation and ASCII
// escaping, including nested objects, integer-like keys and UTF-16 surrogate pairs.
function inventoryJson(value: unknown, depth = 0): string {
  const indent = '  '.repeat(depth);
  const childIndent = `${indent}  `;
  if (Array.isArray(value)) {
    return value.length
      ? `[\n${value.map((item) => childIndent + inventoryJson(item, depth + 1)).join(',\n')}\n${indent}]`
      : '[]';
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort(compareText);
    return keys.length
      ? `{\n${keys.map((key) => `${childIndent}${inventoryJson(key)}: ${inventoryJson(record[key], depth + 1)}`).join(',\n')}\n${indent}}`
      : '{}';
  }
  const text = JSON.stringify(value);
  if (text === undefined || (typeof value === 'number' && !Number.isFinite(value))) {
    throw new Error('member inventory must contain JSON values');
  }
  return text.replace(
    /[\u007f-\uffff]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

export function safePath(value: string): string {
  if (
    !value ||
    value.startsWith('/') ||
    value.includes('\\') ||
    value.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error(`unsafe member destination: ${value}`);
  }
  portableMemberName(value, 'file', value);
  return value;
}

async function treeFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if ((await lstat(file)).isDirectory()) files.push(...(await treeFiles(file)));
    else files.push(file);
  }
  return files;
}

export async function assemble(spec: MemberSpec, output: string, inventory: string): Promise<void> {
  if (!spec.descriptor || typeof spec.descriptor !== 'object' || Array.isArray(spec.descriptor)) {
    throw new Error('member specification must declare a descriptor object');
  }
  const contents = new Map<string, Buffer>();
  for (const entry of spec.inputs) {
    if (typeof entry.destination !== 'string') {
      throw new Error('member input must declare a destination string');
    }
    // Flatten Bazel's projected file links, without following directory links
    // into undeclared trees. Every emitted archive entry is a regular file.
    const source = await realpath(entry.source);
    const files = entry.tree ? await treeFiles(source) : [source];
    for (const file of files) {
      const metadata = await stat(file);
      if (metadata.isDirectory()) continue;
      if (!metadata.isFile()) throw new Error(`member input is not a regular file: ${file}`);
      const destination = safePath(
        entry.tree
          ? `${entry.destination}/${path.relative(source, file).split(path.sep).join('/')}`
          : entry.destination,
      );
      if (contents.has(destination) || destination === 'extension.json') {
        throw new Error(`duplicate member destination: ${destination}`);
      }
      contents.set(destination, await readFile(file));
    }
  }
  const names = [...contents.keys()].sort(compareText);
  const descriptor = {
    ...spec.descriptor,
    files: names.map((name) => ({
      path: name,
      sha256: createHash('sha256')
        .update(contents.get(name) ?? Buffer.alloc(0))
        .digest('hex'),
    })),
  };
  const json = `${inventoryJson(descriptor)}\n`;
  contents.set('extension.json', Buffer.from(json));
  const chunks: Buffer[] = [];
  for (const name of [...contents.keys()].sort(compareText)) {
    const data = contents.get(name);
    if (!data) throw new Error(`missing member content: ${name}`);
    chunks.push(
      tarHeader({ name, isDirectory: false }, data.length, name.startsWith('lib/') ? 0o755 : 0o644),
      data,
      Buffer.alloc((512 - (data.length % 512)) % 512),
    );
  }
  chunks.push(Buffer.alloc(1024));
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  chunks.push(Buffer.alloc((10_240 - (length % 10_240)) % 10_240));
  // Retain the internal format's level-9 XFL=2/OS=255 header and 10 KiB tar
  // record framing. The compressed deflate stream belongs to the pinned Bun.
  const compressed = gzipSync(Buffer.concat(chunks), { level: 9 });
  compressed.fill(0, 4, 8);
  compressed[8] = 2;
  compressed[9] = 255;
  await writeFile(output, compressed);
  await writeFile(inventory, json);
}

if (import.meta.main) {
  try {
    const { values } = parseArgs({
      options: {
        spec: { type: 'string' },
        output: { type: 'string' },
        inventory: { type: 'string' },
      },
    });
    if (!values.spec || !values.output || !values.inventory) {
      throw new Error(
        'usage: member_payload.mts --spec <json> --output <tar.gz> --inventory <json>',
      );
    }
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      await readFile(values.spec),
    );
    await assemble(JSON.parse(text), values.output, values.inventory);
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exitCode = 2;
  }
}
