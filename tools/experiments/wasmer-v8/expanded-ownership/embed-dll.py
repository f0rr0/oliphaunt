"""Private automatic-delivery control; generate C bindings for an embedded DLL."""
import hashlib
import json
import pathlib
import re
import sys

output = pathlib.Path(sys.argv[1]).resolve()
dependency = output / "engine/dependency/wasmer-7.5.0"
prebuilt = dependency / "prebuilt"
dll = (prebuilt / "oliphaunt_wee8.dll").read_bytes()
digest = hashlib.sha256(dll).hexdigest()
bindings = (prebuilt / "v8_bindings.rs").read_text()
pattern = re.compile(r'unsafe extern "C" \{\s*#\[link_name = "\\u\{1\}(wee8_[^"]+)"\]\s*pub fn (\w+)\((.*?)\)\s*(->[^;]+)?;\s*\}', re.S)
symbols = []


def wrap(match):
    symbol, name, args, ret = match.groups()
    symbols.append(symbol)
    depth, start, arguments = 0, 0, []
    for index, char in enumerate(args + ","):
        if char in "(<[":
            depth += 1
        elif char in ")>]" and not (char == ">" and args[index - 1] == "-"):
            depth -= 1
        elif char == "," and depth == 0:
            argument = args[start:index].strip()
            if argument:
                arguments.append(argument.split(":", 1)[0].strip())
            start = index + 1
    assert depth == 0, name
    ret = ret or ""
    return f'''pub unsafe extern "C" fn {name}({args}) {ret} {{
    type Function = unsafe extern "C" fn({args}) {ret};
    static FUNCTION: std::sync::OnceLock<Function> = std::sync::OnceLock::new();
    let function = FUNCTION.get_or_init(|| unsafe {{
        std::mem::transmute::<*mut std::ffi::c_void, Function>(
            research_embedded_engine::symbol(b"{symbol}\\0"))
    }});
    unsafe {{ function({", ".join(arguments)}) }}
}}'''


generated = pattern.sub(wrap, bindings)
assert len(symbols) == 314, len(symbols)
assert "link_name" not in generated, "unhandled foreign declaration"
loader = pathlib.Path(__file__).with_name("embedded-engine.rs").read_text()
loader = loader.replace("RESEARCH_ENGINE_DIGEST", digest)
generated += "\nmod research_embedded_engine {\n" + loader + "\n}\n"
generated += '''
pub(crate) unsafe fn oliphaunt_v8_current_isolate() -> *mut std::ffi::c_void {
    type Function = unsafe extern "C" fn() -> *mut std::ffi::c_void;
    static FUNCTION: std::sync::OnceLock<Function> = std::sync::OnceLock::new();
    let function = FUNCTION.get_or_init(|| unsafe {
        std::mem::transmute::<*mut std::ffi::c_void, Function>(
            research_embedded_engine::symbol(b"?GetCurrent@Isolate@v8@@SAPEAV12@XZ\\0"))
    });
    unsafe { function() }
}
pub(crate) unsafe fn oliphaunt_v8_terminate_execution(ptr: *mut std::ffi::c_void) {
    type Function = unsafe extern "C" fn(*mut std::ffi::c_void);
    static FUNCTION: std::sync::OnceLock<Function> = std::sync::OnceLock::new();
    let function = FUNCTION.get_or_init(|| unsafe {
        std::mem::transmute::<*mut std::ffi::c_void, Function>(
            research_embedded_engine::symbol(b"?TerminateExecution@Isolate@v8@@QEAAXXZ\\0"))
    });
    unsafe { function(ptr) }
}
pub(crate) unsafe fn research_externtype_delete(ptr: *mut wasm_tagtype_t) {
    type Function = unsafe extern "C" fn(*mut wasm_tagtype_t);
    static FUNCTION: std::sync::OnceLock<Function> = std::sync::OnceLock::new();
    let function = FUNCTION.get_or_init(|| unsafe {
        std::mem::transmute::<*mut std::ffi::c_void, Function>(
            research_embedded_engine::symbol(b"research_externtype_delete\\0"))
    });
    unsafe { function(ptr) };
}
'''
(prebuilt / "embedded_bindings.rs").write_text(generated)
tag = dependency / "src/backend/v8/entities/tag.rs"
source = tag.read_text()
old = "unsafe extern \"C\" { fn research_externtype_delete(type_: *mut wasm_tagtype_t); }"
assert old in source
tag.write_text(source.replace(old, "use crate::backend::v8::bindings::research_externtype_delete;"))
(dependency / "build.rs").write_text('''fn main() {
    if std::env::var_os("CARGO_FEATURE_V8").is_none() { return; }
    let root = std::path::PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let out = std::path::PathBuf::from(std::env::var("OUT_DIR").unwrap());
    std::fs::copy(root.join("prebuilt/embedded_bindings.rs"), out.join("v8_bindings.rs")).unwrap();
    std::fs::copy(root.join("prebuilt/oliphaunt_wee8.dll"), out.join("oliphaunt_wee8.dll")).unwrap();
}
''')
receipt = {"scope": "private embedded DLL and generated C function dispatch; not published crate delivery",
           "dll_sha256": digest, "generated_bindings_sha256": hashlib.sha256(generated.encode()).hexdigest(),
           "foreign_declarations": len(symbols), "consumer_engine_import_library": False,
           "consumer_compiler_tools": False, "dll_path_setup": False}
(output / "embedded-delivery-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
print(json.dumps(receipt, indent=2))
