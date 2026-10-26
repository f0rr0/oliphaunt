import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const declaration =
  /unsafe extern "C" \{\s*#\[link_name = "\\u\{1\}(wee8_[^"]+)"\]\s*pub fn (\w+)\(([^;]*)\)\s*(->[^;]+)?;\s*\}/gs;
const unsupported = new Set([
  'wee8_wasm_tag_get',
  'wee8_wasm_tag_set',
  'wee8_wasm_tagtype_as_externtype',
  'wee8_wasm_tagtype_as_externtype_const',
]);
const owners = new Map(
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
  ].map((name) => [`wee8_wasm_${name}_delete`, `research_${name}_delete`]),
);
owners.set('wee8_wasm_func_call', 'research_func_call');
const bridges = [
  {
    symbol: '?GetCurrent@Isolate@v8@@SAPEAV12@XZ',
    name: 'oliphaunt_v8_current_isolate',
    args: '',
    result: '-> *mut std::ffi::c_void',
  },
  {
    symbol: '?TerminateExecution@Isolate@v8@@QEAAXXZ',
    name: 'oliphaunt_v8_terminate_execution',
    args: 'ptr: *mut std::ffi::c_void',
    result: '',
  },
  {
    symbol: 'research_externtype_delete',
    name: 'research_externtype_delete',
    args: 'ptr: *mut wasm_tagtype_t',
    result: '',
  },
];

function declarations(bindings: string) {
  const matches = [...bindings.matchAll(declaration)];
  assert.equal(matches.length, 314, 'pinned Wasmer C declarations changed');
  assert.equal(
    new Set(matches.map((match) => match[1])).size,
    matches.length,
    'duplicate C declaration',
  );
  assert.deepEqual(
    new Set(matches.filter((match) => unsupported.has(match[1])).map((match) => match[1])),
    unsupported,
  );
  assert(!bindings.replace(declaration, '').includes('link_name'), 'unhandled foreign declaration');
  return matches.filter((match) => !unsupported.has(match[1]));
}

export function exportsDefinition(bindings: string): string {
  const exports = declarations(bindings)
    .map(([_, symbol]) => `  ${symbol}=${owners.get(symbol) ?? symbol.slice('wee8_'.length)}`)
    .sort();
  // These two V8 methods are also required by the Rust interrupt bridge.
  exports.push(...bridges.map(({ symbol }) => `  ${symbol}`));
  return `LIBRARY oliphaunt_wee8\nEXPORTS\n${exports.join('\n')}\n`;
}

function argumentNames(args: string): string[] {
  let depth = 0;
  let start = 0;
  const names: string[] = [];
  for (let offset = 0; offset <= args.length; offset++) {
    const char = args[offset] ?? ',';
    if ('(<['.includes(char)) depth++;
    else if (')>]'.includes(char) && !(char === '>' && args[offset - 1] === '-')) depth--;
    else if (char === ',' && depth === 0) {
      const argument = args.slice(start, offset).trim();
      if (argument) {
        const name = argument.slice(0, argument.indexOf(':')).trim();
        assert.match(name, /^(?:r#)?[A-Za-z_][A-Za-z_0-9]*$/, 'unsupported Rust argument');
        names.push(name);
      }
      start = offset + 1;
    }
    assert(depth >= 0, 'unbalanced Rust argument type');
  }
  assert.equal(depth, 0, 'unbalanced Rust argument type');
  return names;
}

export function embeddedBindings(bindings: string, loader: string, dll: Uint8Array): string {
  declarations(bindings);
  const symbols: string[] = [];
  const wrap = (symbol: string, name: string, args: string, result = '', visibility = 'pub') => {
    if (unsupported.has(symbol)) return '';
    const index = symbols.push(symbol) - 1;
    return `${visibility} unsafe fn ${name}(${args}) ${result} {
    type Function = unsafe extern "C" fn(${args}) ${result};
    let function = unsafe {
        std::mem::transmute::<*mut std::ffi::c_void, Function>(
            research_embedded_engine::symbol(${index}))
    };
    unsafe { function(${argumentNames(args).join(', ')}) }
}`;
  };
  let generated = bindings.replace(declaration, (_, symbol, name, args, result) =>
    wrap(symbol, name, args, result),
  );
  for (const { symbol, name, args, result } of bridges)
    generated += `\n${wrap(symbol, name, args, result, 'pub(crate)')}\n`;
  assert.equal(
    loader.split('@@ENGINE_DIGEST@@').length,
    2,
    'one engine digest placeholder required',
  );
  const digest = createHash('sha256').update(dll).digest('hex');
  generated += `\nmod research_embedded_engine {\n${loader.replace('@@ENGINE_DIGEST@@', digest)}\nconst REQUIRED_SYMBOLS: &[&[u8]] = &[\n${symbols.map((symbol) => `    b"${symbol}\\0",`).join('\n')}\n];\n}\n`;
  generated +=
    '\npub(crate) fn oliphaunt_v8_prepare() -> std::io::Result<()> {\n    research_embedded_engine::prepare()\n}\n';
  return generated;
}

if (import.meta.main) {
  const [mode, bindings, output, loader, dll] = process.argv.slice(2);
  assert(
    bindings && output && (mode === 'exports' || (mode === 'embedded' && loader && dll)),
    'usage: generate.mts exports BINDINGS OUTPUT | embedded BINDINGS OUTPUT LOADER DLL',
  );
  const source = readFileSync(bindings, 'utf8');
  writeFileSync(
    output,
    mode === 'exports'
      ? exportsDefinition(source)
      : embeddedBindings(source, readFileSync(loader, 'utf8'), readFileSync(dll)),
  );
}
