"""Private full-SDK cache-only policy; preserve the existing WASIX runtime."""
import hashlib
import json
import pathlib
import re
import shutil
import subprocess
import sys
import tomllib

output = pathlib.Path(sys.argv[1]).resolve()
drivers = pathlib.Path(__file__).resolve().parent
metadata = json.loads(subprocess.check_output(
    ["cargo", "metadata", "--locked", "--format-version=1"], encoding="utf-8"))
packages = [p for p in metadata["packages"] if p["name"] == "wasmer-wasix" and p["version"] == "0.705.0"]
assert len(packages) == 1
source = pathlib.Path(packages[0]["manifest_path"]).parent
private_attachment = output / "interrupt-dependency/wasmer-wasix-0.705.0"
if packages[0]["source"] is None:
    assert source.resolve() == private_attachment.resolve()
    attachment = json.loads((output / "fallible-attachment-source-receipt.json").read_text())
    for name, digest in attachment["patches"]["0007-wasix-fallible-shared-memory-attachment"]["outputs"].items():
        assert hashlib.sha256((source / name).read_bytes()).hexdigest() == digest, name
else:
    assert packages[0]["source"].startswith("registry+")
expected = json.loads((drivers / "cache-only-wasix.inputs.json").read_text())
for name, digest in expected.items():
    assert hashlib.sha256((source / name).read_bytes()).hexdigest() == digest, name
dependency = output / "cache-only-dependency/wasmer-wasix-0.705.0"
shutil.copytree(source, dependency)
subprocess.run(["git", "apply", "--unsafe-paths", "--directory=" + dependency.as_posix(),
                str(drivers / "cache-only-wasix.diff")], check=True)
root = pathlib.Path(metadata["workspace_root"])
config = root / ".cargo/config.toml"
assert config.exists()
if source.resolve() == private_attachment.resolve():
    text = config.read_text()
    old = json.dumps(private_attachment.as_posix())
    assert text.count(old) == 1
    config.write_text(text.replace(old, json.dumps(dependency.as_posix())))
else:
    assert "wasmer-wasix" not in config.read_text()
    config.write_text(config.read_text() + "\n[patch.crates-io.wasmer-wasix]\npath = " + json.dumps(dependency.as_posix()) + "\n")
lock = root / "Cargo.lock"
before = lock.read_bytes()
subprocess.run(["cargo", "metadata", "--offline", "--format-version=1"], check=True, stdout=subprocess.DEVNULL)
after = lock.read_bytes()
records = []
for data in (before, after):
    packages = tomllib.loads(data.decode())["package"]
    for package in packages:
        if package["name"] == "wasmer-wasix" and package["version"] == "0.705.0":
            package.pop("source", None)
            package.pop("checksum", None)
    records.append(sorted(json.dumps(p, sort_keys=True) for p in packages))
assert records[0] == records[1], "unexpected dependency resolution change"
sdk = root / "src/wasix/sdks/rust/src/oliphaunt/postgres_mod.rs"
text = sdk.read_text()
old = "    wasix_runtime.set_module_cache(module_cache);"
assert text.count(old) == 1
sdk.write_text(text.replace(old, old + "\n    wasix_runtime.module_cache_only = true;"))
wasmer = output / "engine/dependency/wasmer-7.5.0"
subprocess.run(["git", "apply", "--unsafe-paths", "--directory=" + wasmer.as_posix(),
                str(drivers / "native-payload.diff")], check=True)
# A maintainer-only sentinel makes an accidental C API guest compilation fail
# the full regression. The producer has already generated the tested AOT assets.
bindings = wasmer / "prebuilt/embedded_bindings.rs"
text = bindings.read_text()
pattern = r'(pub unsafe fn wasm_module_new\([\s\S]*?\)\s*->[^\{]+\{)'
text, count = re.subn(pattern, r'\1\n    eprintln!("research_guest_compilation_reached=true");\n    std::process::abort();', text)
assert count == 1, count
bindings.write_text(text)
(output / "cache-only-receipt.json").write_text(json.dumps({
    "scope": "private complete SDK cached-loading policy and compile sentinel; not published crate delivery",
    "wasix_input_hashes": expected,
    "wasix_runtime_sha256": hashlib.sha256((dependency / "src/runtime/mod.rs").read_bytes()).hexdigest(),
    "sdk_source_sha256": hashlib.sha256(sdk.read_bytes()).hexdigest(),
    "native_payload_module_sha256": hashlib.sha256((wasmer / "src/backend/v8/entities/module.rs").read_bytes()).hexdigest(),
    "patch_hashes": {name: hashlib.sha256((drivers / name).read_bytes()).hexdigest()
                     for name in ("cache-only-wasix.diff", "native-payload.diff")},
    "compiler_sentinel": True,
    "dependency_resolution_unchanged_except_private_wasix_source": True,
}, indent=2) + "\n")
