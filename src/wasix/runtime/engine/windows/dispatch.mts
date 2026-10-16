import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const DECLARATION =
  /unsafe extern "C" \{\s*#\[link_name = "\\u\{1\}(wee8_[^"]+)"\]\s*pub fn (\w+)\(([^;]*)\)\s*(->[^;]+)?;\s*\}/gs;
const UNSUPPORTED = new Set([
  'wee8_wasm_tag_get',
  'wee8_wasm_tag_set',
  'wee8_wasm_tagtype_as_externtype',
  'wee8_wasm_tagtype_as_externtype_const',
]);
const BRIDGES = [
  [
    '?GetCurrent@Isolate@v8@@SAPEAV12@XZ',
    'oliphaunt_v8_current_isolate',
    '',
    '-> *mut std::ffi::c_void',
  ],
  [
    '?TerminateExecution@Isolate@v8@@QEAAXXZ',
    'oliphaunt_v8_terminate_execution',
    'ptr: *mut std::ffi::c_void',
    '',
  ],
  ['oliphaunt_externtype_delete', 'oliphaunt_externtype_delete', 'ptr: *mut wasm_tagtype_t', ''],
  [
    'oliphaunt_set_v8_flags',
    'oliphaunt_set_v8_flags',
    'flags: *const std::ffi::c_char, size: usize',
    '',
  ],
];

export const V8_FLAGS =
  '--mcpu=generic --no-enable-sse4-2 --no-enable-sahf --no-enable-avx --no-enable-avx2 --no-enable-avx-vnni --no-enable-avx-vnni-int8 --no-enable-fma3 --no-enable-f16c --no-enable-bmi1 --no-enable-bmi2 --no-enable-lzcnt --no-enable-popcnt --no-intel-jcc-erratum-mitigation';

function argumentNames(args: string) {
  let depth = 0,
    start = 0;
  const names: string[] = [];
  for (const [offset, char] of [...`${args},`].entries()) {
    if ('(<['.includes(char)) depth++;
    else if (')>]'.includes(char) && !(char === '>' && args[offset - 1] === '-')) depth--;
    else if (char === ',' && depth === 0) {
      const argument = args.slice(start, offset).trim();
      if (argument) names.push(argument.split(':', 1)[0].trim());
      start = offset + 1;
    }
  }
  assert.equal(depth, 0, 'unbalanced C declaration');
  return names;
}

export function renderDispatch(digest: string) {
  assert.match(digest, /^[0-9a-f]{64}$/);
  const symbols: string[] = [];
  const omitted = new Set<string>();
  function wrap(symbol: string, name: string, args: string, ret = '', visibility = 'pub') {
    if (UNSUPPORTED.has(symbol)) {
      omitted.add(symbol);
      return ''; // Absent upstream exports stay absent: future calls fail to compile.
    }
    const index = symbols.length;
    symbols.push(symbol);
    return `${visibility} unsafe fn ${name}(${args}) ${ret} {
    type Function = unsafe extern "C" fn(${args}) ${ret};
    let function = unsafe {
        std::mem::transmute::<*mut std::ffi::c_void, Function>(embedded_engine::symbol(${index}))
    };
    unsafe { function(${argumentNames(args).join(', ')}) }
}`;
  }
  let count = 0;
  let generated = readFileSync(path.join(import.meta.dir, 'bindings.rs'), 'utf8').replace(
    DECLARATION,
    (_, symbol, name, args, ret) => {
      count++;
      return wrap(symbol, name, args, ret);
    },
  );
  assert.equal(count, 314, 'pinned Wasmer C ABI changed');
  assert.deepEqual(omitted, UNSUPPORTED);
  assert(!generated.includes('link_name'), 'unhandled foreign declaration');
  for (const [symbol, name, args, ret] of BRIDGES) {
    generated += `\n${wrap(symbol, name, args, ret, 'pub(crate)')}\n`;
  }
  const loader = readFileSync(path.join(import.meta.dir, 'loader.rs'), 'utf8').replace(
    'ENGINE_DIGEST',
    digest,
  );
  generated += `\nmod embedded_engine {\n${loader}
const REQUIRED_SYMBOLS: &[&[u8]] = &[
${symbols.map((symbol) => `    b"${symbol}\\0",`).join('\n')}
];
}
pub(crate) fn oliphaunt_v8_prepare() -> std::io::Result<()> {
    embedded_engine::prepare()
}
pub(crate) unsafe fn oliphaunt_v8_configure() {
    const FLAGS: &[u8] = b"${V8_FLAGS}";
    unsafe { oliphaunt_set_v8_flags(FLAGS.as_ptr().cast(), FLAGS.len()) };
}
`;
  return { generated, symbols };
}

export function renderExports(symbols: string[]) {
  const owners = new Set(
    [
      'store',
      'shared_memory',
      'shared_module',
      'functype',
      'module',
      'ref',
      'extern',
      'valtype',
      'memorytype',
      'globaltype',
      'tabletype',
      'trap',
    ].map((name) => `wasm_${name}_delete`),
  );
  owners.add('wasm_func_call');
  return (
    'LIBRARY oliphaunt_wee8\nEXPORTS\n' +
    symbols
      .filter((symbol) => symbol.startsWith('wee8_'))
      .map((symbol) => {
        const original = symbol.slice('wee8_'.length);
        const implementation = owners.has(original)
          ? original.replace('wasm_', 'oliphaunt_')
          : original;
        return `  ${symbol}=${implementation}`;
      })
      .join('\n') +
    '\n  oliphaunt_externtype_delete\n  oliphaunt_set_v8_flags=?SetFlagsFromString@V8@v8@@SAXPEBD_K@Z\n'
  );
}
