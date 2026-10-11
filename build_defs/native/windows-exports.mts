import { readFileSync, writeFileSync } from 'node:fs';

/** PostgreSQL18.4 msvc_gendef.pl's x64 symbol selection, without shell/stamps. */
export function postgresExports(symbols: string): string {
  const exports = new Map<string, 'data' | 'func'>();
  for (const line of symbols.split(/\r?\n/)) {
    const fields = line.replace(/notype \(\)/g, 'func').replace(/notype/g, 'data').trim().split(/\s+/);
    if (!/^[A-F0-9]{3,}$/.test(fields[0] ?? '') || fields.length < 7) continue;
    const [,, section, type, visibility,, name] = fields;
    if (section === 'UNDEF' || visibility !== 'External' || !name) continue;
    if (/^(?:@|\(|__real|__xmm|__imp|__IMPORT_DESCRIPTOR|__NULL_IMPORT|\?\?_C)/.test(name) || /NULL_THUNK_DATA$/.test(name)) continue;
    if (type !== 'data' && type !== 'func') throw new Error(`Unsupported MSVC symbol type for ${name}: ${type}`);
    const previous = exports.get(name);
    if (previous && previous !== type) throw new Error(`MSVC symbol changes kind between core archives: ${name}`);
    exports.set(name, type);
  }
  if (!exports.size) throw new Error('MSVC produced no defined external core symbols');
  return 'EXPORTS\n' + [...exports].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([name, type]) => `  ${name}${type === 'data' ? ' DATA' : ''}\n`).join('');
}

if (import.meta.main) {
  const [input, output, ...extra] = process.argv.slice(2);
  if (!input || !output || extra.length) throw new Error('usage: windows-exports.mts SYMBOLS OUTPUT.def');
  writeFileSync(output, postgresExports(readFileSync(input, 'utf8')));
}
