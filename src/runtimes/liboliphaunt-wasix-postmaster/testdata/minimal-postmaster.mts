import { writeFileSync } from 'node:fs';
const bytes = (...values: (number | Uint8Array)[]) =>
  Buffer.concat(
    values.map((value) => (typeof value === 'number' ? Buffer.from([value]) : Buffer.from(value))),
  );
const leb = (value: number): Buffer =>
  value < 128 ? bytes(value) : bytes((value & 127) | 128, leb(Math.floor(value / 128)));
const name = (value: string) => bytes(leb(Buffer.byteLength(value)), Buffer.from(value));
const vector = (rows: Uint8Array[]) => bytes(leb(rows.length), ...rows);
const section = (id: number, data: Uint8Array) => bytes(id, leb(data.length), data);
export function minimalPostmaster(shared = true, lookalike = false, extraFences = 0) {
  const entries = [
    ['SetLatch', 2],
    ['ResetLatch', 1],
    ['WaitEventSetWait', 1],
  ] as const;
  const bodies = entries.map(([, count]) =>
    bytes(0, ...Array.from({ length: count }, () => bytes(254, 3, 0)), 11),
  );
  bodies.push(
    bytes(
      0,
      ...Array.from({ length: extraFences }, () => bytes(254, 3, 0)),
      ...(lookalike ? [bytes(0x41, 0xfe, 3, 0)] : []),
      11,
    ),
  );
  return bytes(
    Buffer.from('0061736d01000000', 'hex'),
    section(1, vector([bytes(0x60, 4, 0x7f, 0x7e, 0x7e, 0x7f, 1, 0x7f), bytes(0x60, 0, 0)])),
    section(
      2,
      vector([
        bytes(name('oliphaunt_postmaster_v1'), name('fd_sync_range'), 0, 0),
        bytes(name('env'), name('memory'), 2, shared ? 3 : 1, 1, 2),
      ]),
    ),
    section(3, vector(bodies.map(() => bytes(1)))),
    section(7, vector(entries.map(([key], index) => bytes(name(key), 0, leb(index + 1))))),
    section(10, vector(bodies.map((body) => bytes(leb(body.length), body)))),
  );
}
if (import.meta.main) {
  if (process.argv.length !== 3) throw new Error('usage: minimal-postmaster.mts OUTPUT');
  writeFileSync(process.argv[2]!, minimalPostmaster(true, false, 3));
}
