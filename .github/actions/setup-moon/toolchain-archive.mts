import { createHash } from 'node:crypto';
import {
  createReadStream,
  lstatSync,
  readdirSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
  rmSync,
} from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  portableMemberName,
  readPortableArchiveEntries,
} from '../../../tools/packaging/portable-archive.mts';

const MAX_BYTES = 750 * 1024 * 1024;
function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}
function safeName(name) {
  return portableMemberName(name, 'file', 'bootstrap');
}
function number(value, maximum) {
  const result = Number(value);
  requireValue(
    Number.isSafeInteger(result) && result > 0 && result <= maximum,
    `invalid bounded count: ${value}`,
  );
  return result;
}

async function treeDigest(root, executables) {
  requireValue(lstatSync(root).isDirectory(), 'tree root must be a real directory');
  const files = [];
  const names = new Map();
  let totalBytes = 0;
  let count = 0;
  function walk(relative) {
    for (const name of readdirSync(path.join(root, relative))) {
      requireValue(++count <= 4096, 'tree exceeds entry limit');
      const member = safeName(relative ? `${relative}/${name}` : name);
      const folded = member.normalize('NFC').toLowerCase();
      requireValue(!names.has(folded), `tree has colliding paths: ${member}`);
      names.set(folded, member);
      const file = path.join(root, member);
      const stat = lstatSync(file);
      if (stat.isDirectory()) {
        walk(member);
        continue;
      }
      requireValue(stat.isFile(), `tree contains a link or special file: ${member}`);
      totalBytes += stat.size;
      requireValue(
        totalBytes <= MAX_BYTES && stat.size <= 250 * 1024 * 1024,
        'tree exceeds byte limit',
      );
      if (process.platform !== 'win32') {
        requireValue(
          Boolean(stat.mode & 0o111) === executables.has(member),
          `tree executable mode mismatch: ${member}`,
        );
      }
      files.push({ member, file, size: stat.size });
    }
  }
  walk('');
  for (const name of executables)
    requireValue(
      files.some((file) => file.member === name),
      `missing executable: ${name}`,
    );
  files.sort((a, b) => Buffer.compare(Buffer.from(a.member), Buffer.from(b.member)));
  const digest = createHash('sha256').update('oliphaunt-bootstrap-tree-v2\0');
  for (const { member, file, size } of files) {
    digest.update(`${member}\0${size}\0${executables.has(member) ? 'x' : '-'}\0`);
    for await (const block of createReadStream(file)) digest.update(block);
    digest.update('\0');
  }
  return `${files.length} ${digest.digest('hex')}`;
}

function extract(values, executables) {
  const archive = values.archive;
  const stat = lstatSync(archive);
  requireValue(
    stat.isFile() && stat.size === number(values['expected-bytes'], 250 * 1024 * 1024),
    'archive byte-size mismatch',
  );
  requireValue(values.format === 'tar.gz', 'package archive must be tar.gz');
  const count = number(values['entry-count'], 4096);
  const expanded = number(values['expanded-bytes'], MAX_BYTES);
  const prefix = safeName(values.prefix);
  const entries = readPortableArchiveEntries(archive, {
    format: 'tar.gz',
    maxArchiveBytes: 250 * 1024 * 1024,
    maxEntryBytes: 250 * 1024 * 1024,
    maxExpandedBytes: MAX_BYTES,
    maxEntries: 4096,
  });
  requireValue(entries.size === count, 'archive entry count mismatch');
  requireValue(
    [...entries.values()].reduce((sum, entry) => sum + entry.size, 0) === expanded,
    'archive expanded byte-size mismatch',
  );
  const required = new Set((values.required ?? []).map(safeName));
  requireValue(
    required.size > 0 && [...executables].every((name) => required.has(name)),
    'executables must be required files',
  );
  for (const entry of entries.values()) {
    requireValue(
      entry.name === prefix ? entry.isDirectory : entry.name.startsWith(`${prefix}/`),
      `archive member outside pinned root: ${entry.name}`,
    );
    if (entry.isFile)
      requireValue(
        Boolean(entry.mode & 0o111) === executables.has(entry.name.slice(prefix.length + 1)),
        `archive executable mismatch: ${entry.name}`,
      );
  }
  for (const name of required) {
    const entry = entries.get(`${prefix}/${name}`);
    requireValue(entry?.isFile && entry.size > 0, `missing non-empty required file: ${name}`);
  }
  const destination = values.destination;
  mkdirSync(path.dirname(path.resolve(destination)), { recursive: true });
  mkdirSync(destination, { mode: 0o700 });
  try {
    for (const entry of entries.values()) {
      if (entry.name === prefix) continue;
      const relative = entry.name.slice(prefix.length + 1);
      const output = path.join(destination, relative);
      mkdirSync(entry.isDirectory ? output : path.dirname(output), {
        recursive: true,
        mode: 0o755,
      });
      if (entry.isFile) {
        const mode = executables.has(relative) ? 0o755 : 0o644;
        writeFileSync(output, entry.data(), { flag: 'wx', mode });
        chmodSync(output, mode);
      }
    }
  } catch (error) {
    rmSync(destination, { recursive: true, force: true });
    throw error;
  }
}

try {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'oci-token' || command === 'oci-manifest') {
    const bytes = readFileSync(args[0]);
    requireValue(
      bytes.length <= (command === 'oci-token' ? 16384 : 1024 * 1024),
      'oversized OCI response',
    );
    const value = JSON.parse(bytes.toString('utf8'));
    if (command === 'oci-token') {
      requireValue(
        typeof value.token === 'string' &&
          value.token.length <= 8192 &&
          /^[-A-Za-z0-9._~+/=]+$/u.test(value.token),
        'unsafe OCI token',
      );
      console.log(value.token);
    } else {
      requireValue(
        value.schemaVersion === 2 &&
          value.mediaType === 'application/vnd.oci.image.manifest.v1+json' &&
          Array.isArray(value.layers),
        'invalid OCI manifest',
      );
      const wasm = value.layers.filter((layer) => layer?.mediaType === 'application/wasm');
      requireValue(
        wasm.length === 1 &&
          wasm[0].digest === `sha256:${args[1]}` &&
          wasm[0].size === Number(args[2]),
        'OCI manifest does not bind the expected WASM blob',
      );
    }
  } else {
    const { values } = parseArgs({
      args,
      options: Object.fromEntries([
        ...[
          'root',
          'archive',
          'format',
          'prefix',
          'entry-count',
          'expected-bytes',
          'expanded-bytes',
          'destination',
        ].map((key) => [key, { type: 'string' }]),
        ['required', { type: 'string', multiple: true }],
        ['executable', { type: 'string', multiple: true }],
      ]),
    });
    const executables = new Set((values.executable ?? []).map(safeName));
    if (command === 'tree-digest') console.log(await treeDigest(values.root, executables));
    else if (command === 'extract') extract(values, executables);
    else throw new Error(`unknown toolchain operation: ${command}`);
  }
} catch (error) {
  console.error(`pinned bootstrap archive rejected: ${error.message}`);
  process.exitCode = 1;
}
