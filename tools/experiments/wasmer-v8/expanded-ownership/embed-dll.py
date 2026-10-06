"""Prepare complete Rust dispatch for the embedded private Windows engine."""
import hashlib
import json
import pathlib
import re
import subprocess
import sys

PATTERN = re.compile(r'unsafe extern "C" \{\s*#\[link_name = "\\u\{1\}(wee8_[^"]+)"\]\s*pub fn (\w+)\(([^;]*)\)\s*(->[^;]+)?;\s*\}', re.S)
UNSUPPORTED = {
    "wee8_wasm_tag_get", "wee8_wasm_tag_set",
    "wee8_wasm_tagtype_as_externtype", "wee8_wasm_tagtype_as_externtype_const",
}
BRIDGES = [
    ("?GetCurrent@Isolate@v8@@SAPEAV12@XZ", "oliphaunt_v8_current_isolate", "", "-> *mut std::ffi::c_void"),
    ("?TerminateExecution@Isolate@v8@@QEAAXXZ", "oliphaunt_v8_terminate_execution", "ptr: *mut std::ffi::c_void", ""),
    ("research_externtype_delete", "research_externtype_delete", "ptr: *mut wasm_tagtype_t", ""),
]


def render(bindings, digest):
    symbols, omitted = [], []

    def wrap(symbol, name, args, ret, visibility="pub"):
        if symbol in UNSUPPORTED:
            omitted.append(symbol)
            # These unused declarations have no implementation in the pinned
            # archive. Removing them makes accidental future calls fail to build.
            return ""
        index = len(symbols)
        symbols.append(symbol)
        depth, start, arguments = 0, 0, []
        for offset, char in enumerate(args + ","):
            if char in "(<[":
                depth += 1
            elif char in ")>]" and not (char == ">" and args[offset - 1] == "-"):
                depth -= 1
            elif char == "," and depth == 0:
                argument = args[start:offset].strip()
                if argument:
                    arguments.append(argument.split(":", 1)[0].strip())
                start = offset + 1
        assert depth == 0, name
        return f'''{visibility} unsafe fn {name}({args}) {ret or ""} {{
    type Function = unsafe extern "C" fn({args}) {ret or ""};
    let function = unsafe {{
        std::mem::transmute::<*mut std::ffi::c_void, Function>(
            research_embedded_engine::symbol({index}))
    }};
    unsafe {{ function({", ".join(arguments)}) }}
}}'''

    generated, count = PATTERN.subn(lambda match: wrap(*match.groups()), bindings)
    assert count == 314, count
    assert set(omitted) == UNSUPPORTED
    assert "link_name" not in generated, "unhandled foreign declaration"
    for symbol, name, args, ret in BRIDGES:
        generated += "\n" + wrap(symbol, name, args, ret, "pub(crate)") + "\n"
    loader = pathlib.Path(__file__).with_name("embedded-engine.rs").read_text()
    loader = loader.replace("RESEARCH_ENGINE_DIGEST", digest)
    table = "\n".join(f'    b"{symbol}\\0",' for symbol in symbols)
    generated += "\nmod research_embedded_engine {\n" + loader + \
        "\nconst REQUIRED_SYMBOLS: &[&[u8]] = &[\n" + table + "\n];\n}\n"
    generated += '''
pub(crate) fn oliphaunt_v8_prepare() -> std::io::Result<()> {
    research_embedded_engine::prepare()
}
'''
    return generated, symbols, omitted


def apply_patch(root, dependency, name):
    patch = root / "src/wasix/runtime/engine/patches" / (name + ".patch")
    inputs = json.loads(patch.with_suffix(".inputs.json").read_text())
    for path, digest in inputs.items():
        assert hashlib.sha256((dependency / path).read_bytes()).hexdigest() == digest, path
    subprocess.run(["git", "apply", "--unsafe-paths", "--directory=" + dependency.as_posix(),
                    str(patch)], check=True)
    return {"patch_sha256": hashlib.sha256(patch.read_bytes()).hexdigest(), "inputs": inputs,
            "outputs": {path: hashlib.sha256((dependency / path).read_bytes()).hexdigest()
                        for path in inputs}}


def main():
    output = pathlib.Path(sys.argv[1]).resolve()
    root = pathlib.Path(__file__).resolve().parents[4]
    dependency = output / "engine/dependency/wasmer-7.5.0"
    prebuilt = dependency / "prebuilt"
    digest = hashlib.sha256((prebuilt / "oliphaunt_wee8.dll").read_bytes()).hexdigest()
    generated, symbols, omitted = render((prebuilt / "v8_bindings.rs").read_text(), digest)
    (prebuilt / "embedded_bindings.rs").write_text(generated)
    tag = dependency / "src/backend/v8/entities/tag.rs"
    source = tag.read_text()
    old = 'unsafe extern "C" { fn research_externtype_delete(type_: *mut wasm_tagtype_t); }'
    assert source.count(old) == 1
    tag.write_text(source.replace(old, "use crate::backend::v8::bindings::research_externtype_delete;"))
    patches = {
        "0010-fallible-v8-engine": apply_patch(root, dependency, "0010-fallible-v8-engine"),
        "0011-sdk-fallible-v8-engine": apply_patch(root, root, "0011-sdk-fallible-v8-engine"),
    }
    manifest = dependency / "Cargo.toml"
    text = manifest.read_text()
    assert "[dependencies.tempfile]" not in text
    text += '\n[target.\'cfg(windows)\'.dependencies.tempfile]\nversion = "3"\n'
    manifest.write_text(text)
    # Runtime tempfile is already in the SDK lock; refresh only Wasmer's edge.
    subprocess.run(["cargo", "metadata", "--offline", "--format-version=1"],
                    check=True, stdout=subprocess.DEVNULL)
    (dependency / "build.rs").write_text('''fn main() {
    if std::env::var_os("CARGO_FEATURE_V8").is_none() { return; }
    let root = std::path::PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let out = std::path::PathBuf::from(std::env::var("OUT_DIR").unwrap());
    std::fs::copy(root.join("prebuilt/embedded_bindings.rs"), out.join("v8_bindings.rs")).unwrap();
    std::fs::copy(root.join("prebuilt/oliphaunt_wee8.dll"), out.join("oliphaunt_wee8.dll")).unwrap();
}
''')
    receipt = {"scope": "private fallible embedded engine preparation; not published crate delivery",
               "dll_sha256": digest,
               "generated_bindings_sha256": hashlib.sha256(generated.encode()).hexdigest(),
               "foreign_declarations": 314, "resolved_entries": len(symbols),
               "omitted_unused_declarations": sorted(omitted), "patches": patches,
               "dispatch_abi": "Rust; native pointers retain C ABI",
               "consumer_engine_import_library": False,
               "consumer_compiler_tools": False, "dll_path_setup": False}
    (output / "embedded-delivery-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps(receipt, indent=2))


if __name__ == "__main__":
    main()
