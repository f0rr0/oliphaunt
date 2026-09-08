import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { canonicalGzipSync } from '../../src/shared/artifact-packaging/portable-archive.mts';

export function tarOctal(value, length) {
  return Buffer.from(`${value.toString(8).padStart(length - 1, '0')}\0`, 'ascii');
}

export function tarArchive(rows) {
  const records = [];
  for (const row of rows) {
    const header = Buffer.alloc(512);
    let name = row.name,
      prefix = '';
    if (Buffer.byteLength(name) > 100) {
      const parts = name.split('/');
      for (let split = 1; split < parts.length; split++) {
        const parent = parts.slice(0, split).join('/'),
          leaf = parts.slice(split).join('/');
        if (Buffer.byteLength(parent) <= 155 && Buffer.byteLength(leaf) <= 100) {
          prefix = parent;
          name = leaf;
          break;
        }
      }
      if (!prefix || row.v7) throw new Error('fixture path does not fit ustar');
    }
    Buffer.from(name).copy(header, 0);
    Buffer.from(prefix).copy(header, 345);
    tarOctal(row.mode ?? 0o644, 8).copy(header, 100);
    tarOctal(0, 8).copy(header, 108);
    tarOctal(0, 8).copy(header, 116);
    const data = Buffer.from(row.data ?? '');
    tarOctal(row.size ?? data.length, 12).copy(header, 124);
    tarOctal(0, 12).copy(header, 136);
    header.fill(0x20, 148, 156);
    header[156] = (row.type ?? '0').charCodeAt(0);
    if (row.linkTarget) Buffer.from(row.linkTarget).copy(header, 157);
    if (!row.v7) {
      Buffer.from('ustar\0', 'binary').copy(header, 257);
      Buffer.from('00').copy(header, 263);
    }
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    Buffer.from(`${checksum.toString(8).padStart(6, '0')}\0 `, 'ascii').copy(header, 148);
    records.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  return canonicalGzipSync(Buffer.concat([...records, Buffer.alloc(1024)]));
}

export async function craftedTar(archive: string, entries: { name: string; type: string }[]) {
  await mkdir(dirname(archive), { recursive: true });
  await writeFile(
    archive,
    tarArchive(
      entries.map((row) => ({
        name: row.type === 'directory' && !row.name.endsWith('/') ? `${row.name}/` : row.name,
        type: row.type === 'directory' ? '5' : row.type === 'symlink' ? '2' : '0',
        mode: row.type === 'directory' ? 0o755 : 0o644,
        linkTarget: row.type === 'symlink' ? 'target' : undefined,
        data: ['directory', 'symlink'].includes(row.type) ? '' : 'fixture',
      })),
    ),
  );
}
