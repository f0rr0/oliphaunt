"""Apply the product-owned automatic lifetime hooks to the private candidate."""
import hashlib
import json
import pathlib
import subprocess
import sys

output = pathlib.Path(sys.argv[1]).resolve()
root = pathlib.Path(__file__).resolve().parents[4]
patch = root / "src/wasix/runtime/engine/patches/0005-automatic-shared-memory-interruption.patch"
dependency = output / "engine/dependency/wasmer-7.5.0"
inputs = json.loads(patch.with_suffix(".inputs.json").read_text())
for name, digest in inputs.items():
    assert hashlib.sha256((dependency / name).read_bytes()).hexdigest() == digest, name
subprocess.run(["git", "apply", "--unsafe-paths", "--directory=" + dependency.as_posix(),
                str(patch)], check=True)
names = [*inputs, "src/backend/v8/entities/store/interrupt.rs"]
test = root / "src/wasix/sdks/rust/tests/research_v8_automatic_interrupt.rs"
source = pathlib.Path(__file__).with_name("automatic-interrupt.rs").read_text()
assert source.count("fn main() {") == 1
test.write_text(source.replace("fn main() {", "#[test]\nfn automatic_store_interrupt() {"))
(output / "automatic-interrupt-source-receipt.json").write_text(json.dumps({
    "scope": "automatic Store and shared-memory lifetime integration; private dependency",
    "input_hashes": inputs,
    "patch_sha256": hashlib.sha256(patch.read_bytes()).hexdigest(),
    "output_hashes": {name: hashlib.sha256((dependency / name).read_bytes()).hexdigest()
                      for name in names},
    "test_sha256": hashlib.sha256(test.read_bytes()).hexdigest(),
}, indent=2) + "\n")
