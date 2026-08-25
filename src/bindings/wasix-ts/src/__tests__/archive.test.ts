import { describe, expect, it } from 'vitest';

import {
  clusterSeedMount,
  decompressIfNeeded,
  extractTar,
  layoutRuntimeSupport,
} from '../archive.js';

// liboliphaunt-doc-example:wasix-typescript-backup-restore
describe('WASIX TypeScript archives', () => {
  it('preserves uncompressed archive bytes by identity', () => {
    const bytes = Uint8Array.of(1, 2, 3);

    expect(decompressIfNeeded(bytes)).toBe(bytes);
  });

  it('extracts regular files from a tar archive', () => {
    const archive = tar([
      ['oliphaunt/bin/postgres', Uint8Array.of(0, 97, 115, 109)],
      ['oliphaunt/share/postgresql/postgres.bki', new TextEncoder().encode('bki')],
    ]);

    expect(extractTar(archive)).toEqual({
      files: new Map([
        ['oliphaunt/bin/postgres', Uint8Array.of(0, 97, 115, 109)],
        ['oliphaunt/share/postgresql/postgres.bki', new TextEncoder().encode('bki')],
      ]),
      directories: new Set(),
    });
  });

  it('keeps extracted file payloads as zero-copy archive views', () => {
    const archive = tar([['share/data', Uint8Array.of(1, 2, 3)]]);

    const extracted = extractTar(archive).files.get('share/data');

    expect(extracted).toEqual(Uint8Array.of(1, 2, 3));
    expect(extracted?.buffer).toBe(archive.buffer);
  });

  it('preserves empty directories needed by PostgreSQL', () => {
    const archive = tar([
      ['PG_VERSION', new TextEncoder().encode('18')],
      ['pg_notify', undefined],
    ]);

    expect(extractTar(archive).directories).toEqual(new Set(['pg_notify']));
  });

  it('uses byte lengths when parsing non-ASCII pax records', () => {
    const archive = tar([
      [
        'PaxHeader',
        paxPayload([
          ['comment', 'déjà'],
          ['path', 'données/file'],
        ]),
        'x',
      ],
      ['ignored', Uint8Array.of(42)],
    ]);

    expect(extractTar(archive).files).toEqual(new Map([['données/file', Uint8Array.of(42)]]));
  });

  it('rejects pax metadata that changes entry size semantics', () => {
    const archive = tar([
      ['PaxHeader', paxPayload([['size', '1']]), 'x'],
      ['ignored', Uint8Array.of(42)],
    ]);

    expect(() => extractTar(archive)).toThrow('unsupported pax key: size');
  });

  it('rejects repeated tar file paths instead of applying last-entry-wins', () => {
    const archive = tar([
      ['share/postgresql/extension/pgtap.control', Uint8Array.of(1)],
      ['share/postgresql/extension/pgtap.control', Uint8Array.of(2)],
    ]);

    expect(() => extractTar(archive)).toThrow(
      'tar archive repeats entry path: share/postgresql/extension/pgtap.control',
    );
  });

  it('separates canonical runtime support from the cluster seed mount', () => {
    const runtime = {
      files: new Map([
        ['oliphaunt/bin/postgres', Uint8Array.of(0, 97, 115, 109)],
        ['oliphaunt/lib/postgresql/plpgsql.so', Uint8Array.of(1)],
        ['oliphaunt/share/postgresql/postgres.bki', Uint8Array.of(2)],
      ]),
      directories: new Set(['oliphaunt/lib/postgresql']),
    };
    const pgdata = {
      files: new Map([
        ['PG_VERSION', new TextEncoder().encode('18')],
        ['global/pg_control', Uint8Array.of(3)],
      ]),
      directories: new Set(['global', 'pg_notify']),
    };

    const layout = layoutRuntimeSupport(runtime);
    const seed = clusterSeedMount(pgdata);

    expect(layout.module).toEqual(Uint8Array.of(0, 97, 115, 109));
    expect(layout.mounts['/bin']?.files.postgres).toEqual(layout.module);
    expect(layout.mounts['/bin']?.files.oliphaunt).toBeUndefined();
    expect(layout.mounts['/lib']?.files['postgresql/plpgsql.so']).toEqual(Uint8Array.of(1));
    expect(layout.mounts['/lib']?.directories).toContain('postgresql');
    expect(layout.mounts['/base']).toBeUndefined();
    expect(seed.files['global/pg_control']).toEqual(Uint8Array.of(3));
    expect(seed.directories).toContain('pg_notify');

    runtime.files.set('oliphaunt/base/PG_VERSION', new TextEncoder().encode('18'));
    expect(() => layoutRuntimeSupport(runtime)).toThrow('storage-owned /base mount');
  });
});

function tar(
  entries: ReadonlyArray<readonly [string, Uint8Array | undefined, ('0' | '5' | 'x')?]>,
): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (const [path, contents, explicitType] of entries) {
    const header = new Uint8Array(512);
    writeAscii(header, 0, path);
    writeOctal(header, 100, 8, 0o644);
    writeOctal(header, 124, 12, contents?.length ?? 0);
    header[156] = (explicitType ?? (contents === undefined ? '5' : '0')).charCodeAt(0);
    writeAscii(header, 257, 'ustar\0');
    writeAscii(header, 263, '00');
    blocks.push(header);
    if (contents === undefined) {
      continue;
    }
    blocks.push(contents);
    const padding = (512 - (contents.length % 512)) % 512;
    if (padding > 0) {
      blocks.push(new Uint8Array(padding));
    }
  }
  blocks.push(new Uint8Array(1024));
  const total = blocks.reduce((sum, block) => sum + block.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const block of blocks) {
    result.set(block, offset);
    offset += block.length;
  }
  return result;
}

function paxPayload(records: ReadonlyArray<readonly [string, string]>): Uint8Array {
  const encoder = new TextEncoder();
  const encoded = records.map(([key, value]) => encodePaxRecord(encoder, key, value));
  const length = encoded.reduce((sum, record) => sum + record.length, 0);
  const payload = new Uint8Array(length);
  let offset = 0;
  for (const record of encoded) {
    payload.set(record, offset);
    offset += record.length;
  }
  return payload;
}

function encodePaxRecord(encoder: TextEncoder, key: string, value: string): Uint8Array {
  let length = encoder.encode(` ${key}=${value}\n`).length + 1;
  while (true) {
    const record = encoder.encode(`${length} ${key}=${value}\n`);
    if (record.length === length) {
      return record;
    }
    length = record.length;
  }
}

function writeAscii(target: Uint8Array, offset: number, value: string): void {
  target.set(new TextEncoder().encode(value), offset);
}

function writeOctal(target: Uint8Array, offset: number, length: number, value: number): void {
  const text = value.toString(8).padStart(length - 1, '0');
  writeAscii(target, offset, text);
  target[offset + length - 1] = 0;
}
