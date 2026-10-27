import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { embeddedBindings, exportsDefinition } from './generate.mts';

const declaration = (name: string, args = '', result = '') =>
  `unsafe extern "C" { #[link_name = "\\u{1}wee8_${name}"] pub fn ${name}(${args}) ${result}; }`;
const functions = [
  declaration('wasm_store_delete', 'ptr: *mut wasm_store_t'),
  declaration(
    'wasm_func_call',
    'f: *const wasm_func_t, args: *const wasm_val_vec_t, results: *mut wasm_val_vec_t',
    '-> *mut wasm_trap_t',
  ),
  declaration(
    'wasm_func_new_with_env',
    'callback: Option<unsafe extern "C" fn(ptr: *mut c_void, pair: *const (u8, u8)) -> *mut c_void>, env: *mut c_void',
  ),
  ...Array.from({ length: 307 }, (_, index) => declaration(`wasm_unused_${index}`)),
];
const omitted = [
  'wasm_tag_get',
  'wasm_tag_set',
  'wasm_tagtype_as_externtype',
  'wasm_tagtype_as_externtype_const',
].map((name) => declaration(name));
const bindings = [...functions, ...omitted].join('\n');
const loader = readFileSync(new URL('./embedded-engine.rs', import.meta.url), 'utf8');

test('exports preserve the private C ownership boundary and required interrupt methods', () => {
  const output = exportsDefinition(bindings);
  expect(output).toContain('wee8_wasm_store_delete=research_store_delete');
  expect(output).toContain('wee8_wasm_func_call=research_func_call');
  expect(output).toContain('?GetCurrent@Isolate@v8@@SAPEAV12@XZ');
  expect(output).toContain('?TerminateExecution@Isolate@v8@@QEAAXXZ');
  expect(output).toContain('research_externtype_delete');
  expect(output).not.toContain('wee8_wasm_tag_get');
  expect(output).not.toContain('wee8_wasm_tag_set');
  expect(output).not.toContain('wee8_wasm_tagtype_as_externtype');
  expect(output.split('\n').filter((line) => line.startsWith('  '))).toHaveLength(313);
});

test('Rust dispatch borrows callback arguments and binds the cache to exact DLL bytes', () => {
  const dll = new Uint8Array([1, 2, 3]);
  const output = embeddedBindings(bindings, loader, dll);
  expect(output).toContain('unsafe { function(callback, env) }');
  expect(output).toContain('ptr: *mut wasm_tagtype_t');
  expect(output).toContain(`Oliphaunt/engines/${createHash('sha256').update(dll).digest('hex')}/`);
  expect(output).not.toContain('link_name');
  expect(output).not.toContain('research_embedded_engine_loaded');
  expect(output).not.toContain('@@ENGINE_DIGEST@@');
  expect(output).not.toContain('wasm_tagtype_as_externtype');
  expect(embeddedBindings(bindings, loader, dll)).toBe(output);
  expect(embeddedBindings(bindings, loader, new Uint8Array([1, 2, 4]))).not.toBe(output);
});

test('input drift fails before emitting a different engine ABI', () => {
  expect(() => exportsDefinition(bindings.replace(functions[0], ''))).toThrow(
    'declarations changed',
  );
  expect(() => exportsDefinition(bindings.replace(functions[0], functions[1]))).toThrow(
    'duplicate C declaration',
  );
  expect(() => exportsDefinition(`${bindings}\n#[link_name = "other"]`)).toThrow(
    'unhandled foreign declaration',
  );
  expect(() =>
    embeddedBindings(bindings, loader.replace('@@ENGINE_DIGEST@@', ''), new Uint8Array()),
  ).toThrow('one engine digest');
  expect(() =>
    embeddedBindings(
      bindings.replace('pair: *const (u8, u8)', 'pair: *const (u8, u8'),
      loader,
      new Uint8Array(),
    ),
  ).toThrow();
});
