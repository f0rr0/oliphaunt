import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { muslAlltypes, publicLibcHeaders } from './libc-headers.mts';

// The fixture is the genuine pinned musl program; actual full-template sed
// parity is also checked separately from native producer qualification.
const script = readFileSync(`${import.meta.dir}/testdata/mkalltypes.sed`, 'utf8');

test('canonical musl needs guards retain declarations and trailing blank lines', () => {
  expect(
    muslAlltypes(script, [
      'TYPEDEF unsigned long size_t;\n',
      'STRUCT pair { int x; };\nUNION value { int i; };\n',
    ]),
  ).toBe(
    '#if defined(__NEED_size_t) && !defined(__DEFINED_size_t)\ntypedef unsigned long size_t;\n#define __DEFINED_size_t\n#endif\n\n' +
      '#if defined(__NEED_struct_pair) && !defined(__DEFINED_struct_pair)\nstruct pair { int x; };\n#define __DEFINED_struct_pair\n#endif\n\n' +
      '#if defined(__NEED_union_value) && !defined(__DEFINED_union_value)\nunion value { int i; };\n#define __DEFINED_union_value\n#endif\n\n',
  );
  expect(() => muslAlltypes(`${script}arbitrary new command\n`, ['TYPEDEF int size_t;\n'])).toThrow(
    'semantics changed',
  );
});

test('public headers retain canonical overwrite order and omit unsupported musl headers', () => {
  const files = new Map<string, Buffer>([
    ['libc-top-half/musl/tools/mkalltypes.sed', Buffer.from(script)],
    [
      'libc-top-half/musl/arch/wasm32/bits/alltypes.h.in',
      Buffer.from('TYPEDEF unsigned size_t;\n'),
    ],
    ['libc-top-half/musl/include/alltypes.h.in', Buffer.from('')],
    ['libc-bottom-half/headers/public/sys/mman.h', Buffer.from('patched mmap')],
    ['libc-bottom-half/headers/public/wasix/context.h', Buffer.from('actual context')],
    ['libc-bottom-half/headers/public/string.h', Buffer.from('bottom')],
    ['libc-top-half/musl/include/string.h', Buffer.from('musl')],
    ['libc-top-half/musl/include/unsupported.h', Buffer.from('omit')],
    ['libc-top-half/musl/arch/generic/bits/selected.h', Buffer.from('generic')],
    ['libc-top-half/musl/arch/wasm32/bits/selected.h', Buffer.from('wasm32')],
  ]);
  const headers = publicLibcHeaders(files, [
    'unsupported.h',
    'bits/alltypes.h.in',
    'alltypes.h.in',
  ]);
  expect(headers.get('string.h')?.toString()).toBe('musl');
  expect(headers.get('bits/selected.h')?.toString()).toBe('wasm32');
  expect(headers.has('unsupported.h')).toBeFalse();
  expect(headers.get('sys/mman.h')?.toString()).toBe('patched mmap');
  expect(() =>
    publicLibcHeaders(new Map([...files].filter(([path]) => !path.endsWith('mkalltypes.sed'))), []),
  ).toThrow('Missing libc header input');
});
