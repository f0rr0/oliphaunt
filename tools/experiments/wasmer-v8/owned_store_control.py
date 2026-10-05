"""Prepare a private, pinned Windows Store-deletion experiment; never publish it."""
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
args = parser.parse_args()
output = args.output.resolve()
output.mkdir(parents=True, exist_ok=True)

metadata_command = ["cargo", "metadata", "--locked", "--format-version=1",
                    "--filter-platform", "x86_64-pc-windows-msvc"]
metadata = json.loads(subprocess.check_output(metadata_command, text=True))
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
(output / "patched-store.rs").write_text(replacement)
receipt = {
    "wasmer_version": "7.5.0", "original_sha256": expected_sha,
    "patched_sha256": hashlib.sha256(replacement.encode()).hexdigest(),
    "method": "private MSVC wasm::Store::destroy; research only",
    "dry_run": args.dry_run,
}
if not args.dry_run:
    host = subprocess.check_output(["rustc", "-vV"], text=True)
    if "host: x86_64-pc-windows-msvc" not in host:
        raise RuntimeError("this private ABI control requires native x64 Windows MSVC")
    root = pathlib.Path(metadata["workspace_root"])
    config = root / ".cargo/config.toml"
    if config.exists():
        raise RuntimeError("refuse to overwrite an existing workspace Cargo configuration")
    dependency = output / "dependency/wasmer-7.5.0"
    shutil.copytree(source, dependency)
    (dependency / relative).write_text(replacement)
    lock = root / "Cargo.lock"
    before = lock.read_bytes()
    (output / "original-Cargo.lock").write_bytes(before)
    config.parent.mkdir(exist_ok=True)
    config.write_text("[patch.crates-io.wasmer]\npath = " + json.dumps(dependency.as_posix()) + "\n")
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
    if old_packages != new_packages:
        raise RuntimeError("local experiment unexpectedly changed other dependency resolution")
    (output / "patched-Cargo.lock").write_bytes(after)
    receipt["cargo_config"] = config.read_text()
(output / "owned-store-control.json").write_text(json.dumps(receipt, indent=2) + "\n")
print(json.dumps(receipt, indent=2))
