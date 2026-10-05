"""Research-only expanded C owner cleanup inside the pinned Windows engine DLL."""
import argparse
import hashlib
import json
import os
import pathlib
import re
import shutil
import subprocess
import urllib.request


def run(command):
    subprocess.run(command, check=True)


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("output", type=pathlib.Path)
args = parser.parse_args()
output = args.output.resolve()
output.mkdir(parents=True, exist_ok=False)
msvc = pathlib.Path(os.environ["VCToolsInstallDir"]) / "bin/HostX64/x64"
for tool in ["cl.exe", "link.exe", "lib.exe"]:
    assert (msvc / tool).is_file(), msvc / tool
metadata = json.loads(subprocess.check_output(
    ["cargo", "metadata", "--locked", "--format-version=1"], encoding="utf-8"))
packages = [p for p in metadata["packages"] if p["name"] == "wasmer" and p["version"] == "7.5.0"]
assert len(packages) == 1 and packages[0]["source"].startswith("registry+")
source = pathlib.Path(packages[0]["manifest_path"]).parent
target = pathlib.Path(metadata["target_directory"])
bindings = list((target / "release/build").glob("wasmer-*/out/v8_bindings.rs"))
assert bindings and len({p.read_bytes() for p in bindings}) == 1
binding_data = bindings[0].read_bytes()
symbols = sorted(set(re.findall(r"wee8_wasm\w+", binding_data.decode())))
assert len(symbols) > 200, len(symbols)
unsupported = {"wee8_wasm_tag_get", "wee8_wasm_tag_set",
               "wee8_wasm_tagtype_as_externtype", "wee8_wasm_tagtype_as_externtype_const"}
# These declarations are absent from the pinned Windows archive; Wasmer's
# currently implemented paths do not reference them. Do not fabricate exports.
symbols = [s for s in symbols if s not in unsupported]
archive = target / "wee8-artifacts/11.9.7/windows-amd64/lib/v8.lib"
assert archive.is_file(), archive
header_url = "https://raw.githubusercontent.com/v8/v8/b0a55a7dad7f536cce1f9aaddba89894c8533946/third_party/wasm-api/wasm.hh"
with urllib.request.urlopen(header_url, timeout=60) as response:
    header = response.read()
assert hashlib.sha256(header).hexdigest() == "18f49f653f79a9485d6bda1d650a9c29f538987b7092457e2bb95e8fa68aae76"
(output / "wasm.hh").write_bytes(header)
cpp = '''#define LIBWASM_STATIC
#include "wasm.hh"
namespace wasm {
template <> class Shared<Memory> {
  friend class destroyer;
  void destroy();
protected:
  Shared() = default;
  ~Shared() = default;
};
}
extern "C" void research_store_delete(wasm::Store* p) {
  if (p) wasm::destroyer{}(p);
}
extern "C" void research_shared_memory_delete(wasm::Shared<wasm::Memory>* p) {
  if (p) wasm::destroyer{}(p);
}
extern "C" void research_shared_module_delete(wasm::Shared<wasm::Module>* p) {
  if (p) wasm::destroyer{}(p);
}
extern "C" void research_functype_delete(wasm::FuncType* p) {
  if (p) wasm::destroyer{}(p);
}
extern "C" void research_module_delete(wasm::Module* p) {
  if (p) wasm::destroyer{}(p);
}
extern "C" void research_ref_delete(wasm::Ref* p) {
  if (p) wasm::destroyer{}(p);
}
extern "C" void research_extern_delete(wasm::Extern* p) {
  if (p) wasm::destroyer{}(p);
}
extern "C" void research_valtype_delete(wasm::ValType* p) {
  if (p) wasm::destroyer{}(p);
}
extern "C" void research_memorytype_delete(wasm::MemoryType* p) {
  if (p) wasm::destroyer{}(p);
}
extern "C" void research_globaltype_delete(wasm::GlobalType* p) {
  if (p) wasm::destroyer{}(p);
}
extern "C" void research_tabletype_delete(wasm::TableType* p) {
  if (p) wasm::destroyer{}(p);
}
extern "C" void research_trap_delete(wasm::Trap* p) {
  if (p) wasm::destroyer{}(p);
}
extern "C" void research_externtype_delete(wasm::ExternType* p) {
  if (p) wasm::destroyer{}(p);
}
'''
(output / "bridge.cpp").write_text(cpp, encoding="utf-8")
owners = {'wee8_wasm_store_delete': 'research_store_delete', 'wee8_wasm_shared_memory_delete': 'research_shared_memory_delete', 'wee8_wasm_shared_module_delete': 'research_shared_module_delete', 'wee8_wasm_functype_delete': 'research_functype_delete', 'wee8_wasm_module_delete': 'research_module_delete', 'wee8_wasm_ref_delete': 'research_ref_delete', 'wee8_wasm_extern_delete': 'research_extern_delete', 'wee8_wasm_valtype_delete': 'research_valtype_delete', 'wee8_wasm_memorytype_delete': 'research_memorytype_delete', 'wee8_wasm_globaltype_delete': 'research_globaltype_delete', 'wee8_wasm_tabletype_delete': 'research_tabletype_delete', 'wee8_wasm_trap_delete': 'research_trap_delete'}
exports = [f"  {s}={owners.get(s, s.removeprefix('wee8_'))}" for s in symbols]
exports.append("  research_externtype_delete")
exports.append("  research_set_v8_flags=?SetFlagsFromString@V8@v8@@SAXPEBD_K@Z")
(output / "engine.def").write_text("LIBRARY oliphaunt_wee8\nEXPORTS\n" + "\n".join(exports) + "\n")
run([str(msvc / "cl.exe"), "/nologo", "/c", "/O2", "/MT", "/EHsc", "/std:c++20",
     str(output / "bridge.cpp"), f"/Fo{output / 'bridge.obj'}"])
run([str(msvc / "link.exe"), "/NOLOGO", "/DLL", f"/OUT:{output / 'oliphaunt_wee8.dll'}",
     f"/DEF:{output / 'engine.def'}", f"/IMPLIB:{output / 'engine-all-exports.lib'}",
     str(output / "bridge.obj"), str(archive), "winmm.lib", "dbghelp.lib", "shlwapi.lib"])
# V8 archive directives may export C++ symbols. Restrict the consumer import
# library to C entries regardless; inspect the DLL's exports in the evidence.
(output / "imports.def").write_text("LIBRARY oliphaunt_wee8.dll\nEXPORTS\n" +
    "\n".join("  " + s for s in symbols + ["research_set_v8_flags", "research_externtype_delete"]) + "\n")
run([str(msvc / "lib.exe"), "/NOLOGO", "/MACHINE:X64", f"/DEF:{output / 'imports.def'}",
     f"/OUT:{output / 'oliphaunt_wee8.lib'}"])
dependency = output / "dependency/wasmer-7.5.0"
shutil.copytree(source, dependency)
(dependency / "prebuilt").mkdir()
for name in ["oliphaunt_wee8.lib", "oliphaunt_wee8.dll"]:
    shutil.copy2(output / name, dependency / "prebuilt" / name)
(dependency / "prebuilt/v8_bindings.rs").write_bytes(binding_data)
(dependency / "build.rs").write_text('''fn main() {
    if std::env::var_os("CARGO_FEATURE_V8").is_none() { return; }
    let root = std::path::PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let out = std::path::PathBuf::from(std::env::var("OUT_DIR").unwrap());
    std::fs::copy(root.join("prebuilt/v8_bindings.rs"), out.join("v8_bindings.rs")).unwrap();
    println!("cargo:rustc-link-search=native={}", root.join("prebuilt").display());
    println!("cargo:rustc-link-lib=dylib=oliphaunt_wee8");
}
''', encoding="utf-8")
manifest = dependency / "Cargo.toml"
text = manifest.read_text()
# A maintained package would omit its producer-only tools from consumer builds.
for name in ["bindgen", "which", "ureq", "tar", "xz", "tempfile"]:
    text = re.sub(r"\n\[(?:[^\]\n]*\.)?build-dependencies\." + name + r"\][\s\S]*?(?=\n\[|\Z)", "", text)
    text = re.sub(r'^\s*"dep:' + name + r'",\n', "", text, flags=re.M)
manifest.write_text(text, encoding="utf-8")
config = pathlib.Path(metadata["workspace_root"]) / ".cargo/config.toml"
assert not config.exists(), "refuse to replace existing Cargo configuration"
config.parent.mkdir(exist_ok=True)
config.write_text("[patch.crates-io.wasmer]\npath = " + json.dumps(dependency.as_posix()) + "\n")
receipt = {"scope": "private expanded C owner DLL boundary, not a published or automatically located SDK runtime",
           "symbols": len(symbols), "source": packages[0]["source"],
           "unsupportedHeaderDeclarations": sorted(unsupported),
           "hashes": {"wasm.hh": hashlib.sha256(header).hexdigest(),
                      "v8.lib": hashlib.sha256(archive.read_bytes()).hexdigest(),
                      "bindings": hashlib.sha256(binding_data).hexdigest(),
                      "dll": hashlib.sha256((output / 'oliphaunt_wee8.dll').read_bytes()).hexdigest()},
           "buildTools": "producer only", "consumerImportSurface": "C API only"}
(output / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
print(json.dumps(receipt, indent=2))
