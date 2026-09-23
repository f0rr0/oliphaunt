import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { readPortableArchiveEntries } from '../packaging/portable-archive.mts';
const [archive, destination, version] = process.argv.slice(2);
try {
  const entries = readPortableArchiveEntries(archive, {
    maxArchiveBytes: 400_000_000,
    maxExpandedBytes: 800_000_000,
    maxEntries: 4096,
  });
  for (const name of ['maestro/bin/maestro', 'maestro/lib/maestro-cli-' + version + '.jar']) {
    if (!entries.get(name)?.isFile || !entries.get(name)?.size)
      throw new Error('missing expected archive entry: ' + name);
  }
  for (const entry of entries.values()) {
    if (entry.name !== 'maestro' && !entry.name.startsWith('maestro/'))
      throw new Error('unsafe Maestro archive path: ' + entry.name);
  }
  for (const entry of entries.values()) {
    const output = path.join(destination, entry.name);
    mkdirSync(entry.isDirectory ? output : path.dirname(output), { recursive: true });
    if (entry.isFile) writeFileSync(output, entry.data(), { flag: 'wx', mode: 0o644 });
  }
} catch (error) {
  console.error(`invalid Maestro archive: ${error.message}`);
  process.exitCode = 1;
}
