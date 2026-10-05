"""Research Windows readers: select a genuine compatible cache without compiling."""
import hashlib
import json
import pathlib
import shutil
import subprocess
import sys

output = pathlib.Path(sys.argv[1]).resolve()
wine = pathlib.Path(sys.argv[2]).resolve()
engine = output / "engine"
sandbox = output / "cache-pair"
sandbox.mkdir()
for name in ["cache-probe.exe", "atomic-wait.exe", "wine-postgres.cache", "guest.wasm"]:
    shutil.copy2(wine / name, sandbox)
shutil.copy2(engine / "oliphaunt_wee8.dll", sandbox)
receipt = json.loads((wine / "wine-producer-receipt.json").read_text())
assert hashlib.sha256((sandbox / "wine-postgres.cache").read_bytes()).hexdigest() == receipt["cache_sha256"]
assert hashlib.sha256((sandbox / "cache-probe.exe").read_bytes()).hexdigest() == receipt["native_reader_exe_sha256"]
assert hashlib.sha256((sandbox / "oliphaunt_wee8.dll").read_bytes()).hexdigest() == receipt["dll_sha256"]
assert hashlib.sha256((sandbox / "atomic-wait.exe").read_bytes()).hexdigest() == receipt["atomic_wait_exe_sha256"]
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
with (sandbox / "atomic-wait.log").open("w") as log:
    interrupt = subprocess.run([str(sandbox / "atomic-wait.exe")], cwd=sandbox,
                               stdout=log, stderr=subprocess.STDOUT, timeout=20)
print("atomic-wait.log exit=", interrupt.returncode,
      (sandbox / "atomic-wait.log").read_text(), flush=True)
assert interrupt.returncode == 0
assert "native_indefinite_wait_interruption=PASS cycles=20" in (sandbox / "atomic-wait.log").read_text()
(sandbox / "cache-pair-receipt.json").write_text(json.dumps({
    "method": "producer compile followed by fresh native readers; readers never compile",
    "wine_producer": receipt, "readers": accepted,
    "native_atomic_wait_cycles": 20,
    "compatible_variant": next(x["cache"] for x in accepted if x["exit_code"] == 0)}, indent=2) + "\n")
