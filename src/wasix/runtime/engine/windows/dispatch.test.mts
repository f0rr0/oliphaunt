import { expect, test } from 'bun:test';
import { renderDispatch, renderExports, V8_FLAGS } from './dispatch.mts';

test('resolves the complete pinned C ABI before V8 initialization', () => {
  const { generated, symbols } = renderDispatch('a'.repeat(64));
  expect(new Set(symbols).size).toBe(314);
  expect(generated).not.toContain('link_name');
  expect(generated).not.toContain('pub unsafe fn wasm_tag_get(');
  expect(generated).toContain(V8_FLAGS);
  expect(generated).toContain('Oliphaunt/engines/' + 'a'.repeat(64));
  expect(generated).toContain('type Function = unsafe extern "C" fn(');
  // Nested callback types must not become extra call arguments.
  expect(generated.includes('function(arg1, type_, arg2, env, finalizer)')).toBe(true);
  expect(renderExports(symbols)).toContain('wee8_wasm_func_call=oliphaunt_func_call');
  expect(renderExports(symbols)).toContain('wee8_wasm_store_delete=oliphaunt_store_delete');
  expect(symbols.includes('wee8_wasm_tag_get')).toBe(false);
});

test('requires a content-addressed engine identity', () => {
  expect(() => renderDispatch('../engine')).toThrow();
});
