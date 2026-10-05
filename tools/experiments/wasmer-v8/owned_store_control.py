"""Prepare private, pinned Windows ownership controls; never publish them."""
import argparse
import hashlib
import json
import pathlib
import shutil
import subprocess
import tomllib

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("output", type=pathlib.Path)
parser.add_argument("--dry-run", action="store_true")
parser.add_argument("--shared-memory", action="store_true")
parser.add_argument("--shared-module", action="store_true")
parser.add_argument("--observe-compilation", action="store_true")
args = parser.parse_args()
output = args.output.resolve()
output.mkdir(parents=True, exist_ok=True)

metadata_command = ["cargo", "metadata", "--locked", "--format-version=1",
                    "--filter-platform", "x86_64-pc-windows-msvc"]
metadata = json.loads(subprocess.check_output(metadata_command, encoding="utf-8"))
packages = [p for p in metadata["packages"] if p["name"] == "wasmer" and p["version"] == "7.5.0"]
if len(packages) != 1 or not packages[0]["source"].startswith("registry+"):
    raise RuntimeError("expected exactly one published Wasmer 7.5.0 dependency")
source = pathlib.Path(packages[0]["manifest_path"]).parent
relative = pathlib.Path("src/backend/v8/entities/store/mod.rs")
original = (source / relative).read_bytes()
expected_sha = "9e2cb3d3f69a537d6643b5ab9d3de0954b7b85ccf7a2a5936547c3b78eb88f9e"
if hashlib.sha256(original).hexdigest() != expected_sha:
    raise RuntimeError("pinned Wasmer Store source changed; refuse the private ABI experiment")
replacement = original.decode()
old_drop = "        unsafe { wasm_store_delete(self.inner) }"
old_import = "bindings::{wasm_store_delete, wasm_store_new, wasm_store_t}"
if replacement.count(old_drop) != 1 or replacement.count(old_import) != 1:
    raise RuntimeError("unexpected pinned Store layout")
replacement = replacement.replace(old_import, "bindings::{wasm_store_new, wasm_store_t}")
replacement = replacement.replace("impl Drop for Store {", '''// Research only: the pinned C API deletes an empty public base. This private
// MSVC symbol reaches the C++ owner's actual Store implementation cleanup.
unsafe extern "C" {
    #[link_name = "?destroy@Store@wasm@@AEAAXXZ"]
    fn research_owned_store_destroy(store: *mut wasm_store_t);
}

impl Drop for Store {''')
replacement = replacement.replace(old_drop, '''        eprintln!("research_owned_store_cleanup");
        unsafe { research_owned_store_destroy(self.inner) }''')
(output / "original-store.rs").write_bytes(original)
(output / "patched-store.rs").write_bytes(replacement.encode("utf-8"))
patches = {relative: replacement.encode("utf-8")}
receipt = {
    "wasmer_version": "7.5.0", "original_sha256": expected_sha,
    "patched_sha256": hashlib.sha256(replacement.encode()).hexdigest(),
    "method": "private MSVC wasm::Store::destroy; research only",
    "dry_run": args.dry_run,
}
if args.shared_memory:
    shared_relative = pathlib.Path("src/backend/v8/vm/mod.rs")
    shared_original = (source / shared_relative).read_bytes()
    shared_sha = "edb69d1d40e00d5f8adef496a7bef4d2568ca06e2006c09113a2a80d029f4c54"
    if hashlib.sha256(shared_original).hexdigest() != shared_sha:
        raise RuntimeError("pinned shared-memory source changed; refuse the private ABI experiment")
    shared_replacement = shared_original.decode("utf-8")
    old_shared_drop = "            wasm_shared_memory_delete(self.0);"
    if shared_replacement.count(old_shared_drop) != 1:
        raise RuntimeError("unexpected pinned shared-memory Drop layout")
    shared_replacement = shared_replacement.replace("impl Drop for SharedMemoryPointer {", '''// Preserve the existing Arc ownership and its exactly-once final Drop.
unsafe extern "C" {
    #[link_name = "?destroy@?$Shared@VMemory@wasm@@@wasm@@AEAAXXZ"]
    fn research_owned_shared_memory_destroy(memory: *mut wasm_shared_memory_t);
}

impl Drop for SharedMemoryPointer {''')
    shared_replacement = shared_replacement.replace(old_shared_drop,
        "            research_owned_shared_memory_destroy(self.0);")
    patches[shared_relative] = shared_replacement.encode("utf-8")
    (output / "original-shared-memory.rs").write_bytes(shared_original)
    (output / "patched-shared-memory.rs").write_bytes(patches[shared_relative])
    receipt["shared_memory"] = {
        "original_sha256": shared_sha,
        "patched_sha256": hashlib.sha256(patches[shared_relative]).hexdigest(),
        "method": "private MSVC wasm::Shared<Memory>::destroy; existing Arc Drop; research only",
    }
if args.observe_compilation or args.shared_module:
    module_relative = pathlib.Path("src/backend/v8/entities/module.rs")
    module_original = (source / module_relative).read_bytes()
    module_sha = "85cb8b002f654d293e881eac74d443e2ad250a5feaa8733950d0334a99b43e47"
    if hashlib.sha256(module_original).hexdigest() != module_sha:
        raise RuntimeError("pinned Module source changed; refuse compilation observation")
    module_replacement = module_original.decode("utf-8")
    if args.observe_compilation:
        entry = "    fn new(engine: &impl AsEngineRef, binary: &[u8]) -> Result<Self, CompileError> {"
        if module_replacement.count(entry) != 1:
            raise RuntimeError("unexpected pinned Module constructor layout")
        module_replacement = module_replacement.replace(entry, entry +
            '\n        eprintln!("research_v8_module_compile bytes={}", binary.len());')
    if args.shared_module:
        old_module_drop = "        unsafe { wasm_shared_module_delete(self.v8_shared_module_handle) }"
        if module_replacement.count(old_module_drop) != 1:
            raise RuntimeError("unexpected pinned shared-module Drop layout")
        module_replacement = module_replacement.replace("impl Drop for ModuleHandle {", '''// Preserve Module's existing Arc ownership and its unique final shared handle.
unsafe extern "C" {
    #[link_name = "?destroy@?$Shared@VModule@wasm@@@wasm@@AEAAXXZ"]
    fn research_owned_shared_module_destroy(module: *mut wasm_shared_module_t);
}

impl Drop for ModuleHandle {''')
        module_replacement = module_replacement.replace(old_module_drop,
            "        unsafe { research_owned_shared_module_destroy(self.v8_shared_module_handle) }")
    patches[module_relative] = module_replacement.encode("utf-8")
    (output / "original-module.rs").write_bytes(module_original)
    (output / "patched-module.rs").write_bytes(patches[module_relative])
    receipt["module_control"] = {
        "original_sha256": module_sha,
        "patched_sha256": hashlib.sha256(patches[module_relative]).hexdigest(),
        "shared_module_owner_cleanup": args.shared_module,
        "observe_compilation": args.observe_compilation,
        "method": "private MSVC shared Module owner; log Wasmer V8 new calls; excludes internal V8 compilation",
    }
if not args.dry_run:
    host = subprocess.check_output(["rustc", "-vV"], encoding="utf-8")
    if "host: x86_64-pc-windows-msvc" not in host:
        raise RuntimeError("this private ABI control requires native x64 Windows MSVC")
    root = pathlib.Path(metadata["workspace_root"])
    config = root / ".cargo/config.toml"
    if config.exists():
        raise RuntimeError("refuse to overwrite an existing workspace Cargo configuration")
    dependency = output / "dependency/wasmer-7.5.0"
    shutil.copytree(source, dependency)
    for file, contents in patches.items():
        (dependency / file).write_bytes(contents)
    lock = root / "Cargo.lock"
    before = lock.read_bytes()
    (output / "original-Cargo.lock").write_bytes(before)
    config.parent.mkdir(exist_ok=True)
    config.write_text("[patch.crates-io.wasmer]\npath = " + json.dumps(dependency.as_posix()) + "\n",
                      encoding="utf-8")
    # Resolve the local source substitution once; subsequent tests stay locked.
    subprocess.run(["cargo", "metadata", "--offline", "--format-version=1",
                    "--filter-platform", "x86_64-pc-windows-msvc"],
                   check=True, stdout=subprocess.DEVNULL)
    after = lock.read_bytes()
    old_packages = tomllib.loads(before.decode())["package"]
    new_packages = tomllib.loads(after.decode())["package"]
    for entries in (old_packages, new_packages):
        for package in entries:
            if package["name"] == "wasmer" and package["version"] == "7.5.0":
                package.pop("source", None)
                package.pop("checksum", None)
    # Cargo may reorder package records when replacing a registry source. Keep
    # every record and dependency edge, ignoring only that harmless ordering.
    if sorted(json.dumps(p, sort_keys=True) for p in old_packages) != sorted(
            json.dumps(p, sort_keys=True) for p in new_packages):
        raise RuntimeError("local experiment unexpectedly changed other dependency resolution")
    (output / "patched-Cargo.lock").write_bytes(after)
    receipt["cargo_config"] = config.read_text(encoding="utf-8")
(output / "owned-store-control.json").write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
print(json.dumps(receipt, indent=2))
