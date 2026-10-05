"""Research Windows readers: select a genuine compatible cache without compiling."""
import hashlib
import json
import pathlib
import shutil
import struct
import subprocess
import sys

output = pathlib.Path(sys.argv[1]).resolve()
wine = pathlib.Path(sys.argv[2]).resolve()
engine = output / "engine"
sandbox = output / "cache-pair"
sandbox.mkdir()
for name in ["cache-probe.exe", "wine-postgres.cache", "guest.wasm"]:
    shutil.copy2(wine / name, sandbox)
shutil.copy2(engine / "oliphaunt_wee8.dll", sandbox)
receipt = json.loads((wine / "wine-producer-receipt.json").read_text())
assert hashlib.sha256((sandbox / "wine-postgres.cache").read_bytes()).hexdigest() == receipt["cache_sha256"]
def run(operation, name):
    with (sandbox / name).open("w") as log:
        result = subprocess.run([str(sandbox / "cache-probe.exe"), operation], cwd=sandbox,
                                stdout=log, stderr=subprocess.STDOUT, timeout=180)
    text = (sandbox / name).read_text()
    print(name, "exit=", result.returncode, text, flush=True)
    return result.returncode

assert run("write", "native-write.log") == 0
shutil.copy2(sandbox / "cache.bin", sandbox / "native-postgres.cache")
accepted = []
for name in ["wine-postgres.cache", "native-postgres.cache"]:
    shutil.copy2(sandbox / name, sandbox / "cache.bin")
    code = run("read", name + ".read.log")
    assert code in [0, 24], code
    accepted.append({"cache": name, "exit_code": code,
                     "sha256": hashlib.sha256((sandbox / name).read_bytes()).hexdigest()})
assert accepted[1]["exit_code"] == 0
(sandbox / "cache-pair-receipt.json").write_text(json.dumps({
    "method": "producer compile followed by fresh native readers; readers never compile",
    "wine_producer": receipt, "readers": accepted,
    "compatible_variant": next(x["cache"] for x in accepted if x["exit_code"] == 0)}, indent=2) + "\n")
