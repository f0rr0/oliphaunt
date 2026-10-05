"""Apply a private pinned Windows ownership experiment to a copied dependency."""
import argparse
import hashlib
import json
import pathlib
import sys
import subprocess
import tomllib

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("output", type=pathlib.Path)
args = parser.parse_args()
output = args.output.resolve()
output.mkdir(parents=True, exist_ok=True)
host = subprocess.check_output(["rustc", "-vV"], encoding="utf-8")
if "host: x86_64-pc-windows-msvc" not in host:
    raise RuntimeError("native Windows MSVC control only")
metadata = json.loads(subprocess.check_output(["cargo", "metadata", "--locked", "--format-version=1", "--filter-platform", "x86_64-pc-windows-msvc"], encoding="utf-8"))
packages = [p for p in metadata["packages"] if p["name"] == "wasmer" and p["version"] == "7.5.0"]
if len(packages) != 1 or not packages[0]["source"].startswith("registry+"):
    raise RuntimeError("expected immutable registry Wasmer 7.5.0")
source = pathlib.Path(packages[0]["manifest_path"]).parent
patch = pathlib.Path(__file__).resolve().with_name("wasmer-7.5-private-dll.diff")
expected = json.loads(patch.with_suffix(".inputs.json").read_text(encoding="utf-8"))
for path, digest in expected.items():
    if hashlib.sha256((source / path).read_bytes()).hexdigest() != digest:
        raise RuntimeError(f"pinned source changed: {path}")
dependency = output / "dependency/wasmer-7.5.0"
subprocess.run([sys.executable, str(pathlib.Path(__file__).with_name("dll-prepare.py")), str(output / "engine")], check=True)
dependency = output / "engine/dependency/wasmer-7.5.0"
subprocess.run(["git", "apply", "--unsafe-paths", "--directory=" + dependency.as_posix(), str(patch)], check=True)
root = pathlib.Path(metadata["workspace_root"])
config = root / ".cargo/config.toml"
lock = root / "Cargo.lock"
before = lock.read_bytes()
(output / "original-Cargo.lock").write_bytes(before)
subprocess.run(["cargo", "metadata", "--offline", "--format-version=1", "--filter-platform", "x86_64-pc-windows-msvc"], check=True, stdout=subprocess.DEVNULL)
after = lock.read_bytes()
records = []
for raw in (before, after):
    packages = tomllib.loads(raw.decode())["package"]
    for package in packages:
        if package["name"] == "wasmer" and package["version"] == "7.5.0":
            package.pop("source", None)
            package.pop("checksum", None)
    records.append(sorted(json.dumps(p, sort_keys=True) for p in packages))
(output / "cargo-resolution-before.json").write_text(json.dumps(records[0], indent=2) + "\n")
(output / "cargo-resolution-after.json").write_text(json.dumps(records[1], indent=2) + "\n")
receipt = {"method": "private C engine DLL owner cleanup and Store-scoped roots; source control only", "patch_sha256": hashlib.sha256(patch.read_bytes()).hexdigest(), "input_hashes": expected, "output_hashes": {path: hashlib.sha256((dependency / path).read_bytes()).hexdigest() for path in expected}, "cargo_config": config.read_text()}
(output / "ownership-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
(output / "private-ownership.diff").write_bytes(patch.read_bytes())
(output / "patched-Cargo.lock").write_bytes(after)
print(json.dumps(receipt, indent=2))
