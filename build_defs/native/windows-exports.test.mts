import { describe, expect, test } from 'bun:test';
import { postgresExports } from './windows-exports.mts';

describe('MSVC backend exports', () => {
  test('preserves upstream defined external DATA and function semantics', () => {
    const symbols = [
      '02E 00000130 SECTA notype External | standbyState',
      '064 00000020 SECTC notype () External | XLogCheckBuffer',
      '02F 00000009 SECT9 notype Static | LocalRecoveryInProgress',
      '065 00000000 UNDEF notype () External | BufferGetTag',
      '066 00000000 SECT2 notype External | __imp_malloc',
      '067 00000000 SECT2 notype External | __real@00000000',
      '068 00000000 SECT2 notype External | ??_C@_01@literal',
      '069 00000000 SECT2 notype External | __NULL_IMPORT_DESCRIPTOR',
      '070 00000000 SECT2 notype External | foo_NULL_THUNK_DATA',
      '071 00000000 SECT2 notype External | @compiler',
    ].join('\n');
    expect(postgresExports(symbols)).toBe('EXPORTS\n  XLogCheckBuffer\n  standbyState DATA\n');
  });
  test('merges duplicate definitions without ordinals or 32-bit decoration changes', () => {
    const symbol = '001 00000000 SECT1 notype () External | _x64Name';
    expect(postgresExports(`${symbol}\r\n${symbol}`)).toBe('EXPORTS\n  _x64Name\n');
  });
  test('rejects empty output and contradictory ABI symbol kinds', () => {
    expect(() => postgresExports('MSVC banner')).toThrow('no defined');
    expect(() =>
      postgresExports(
        '001 00000000 SECT1 notype External | symbol\n002 00000000 SECT1 notype () External | symbol',
      ),
    ).toThrow('changes kind');
  });
});
