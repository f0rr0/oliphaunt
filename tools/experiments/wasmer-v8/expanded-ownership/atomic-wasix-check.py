"""Run a bounded negative control and patched Windows WASIX signal registry."""
import hashlib
import json
import os
import pathlib
import subprocess
import sys

output = pathlib.Path(sys.argv[1]).resolve()
env = os.environ.copy()
command = ["cargo", "test", "--locked", "-p", "oliphaunt-wasix", "--no-default-features",
           "--test", "research_v8_atomic_wasix", "--no-run", "--message-format=json"]
build = subprocess.run(command, env=env, capture_output=True, encoding="utf-8")
(output / "atomic-wasix-build.log").write_text(build.stdout + build.stderr)
if build.returncode:
    print(build.stderr[-16000:], flush=True)
    sys.exit(build.returncode)
executables = [json.loads(line)["executable"] for line in build.stdout.splitlines()
               if line.startswith("{") and json.loads(line).get("reason") == "compiler-artifact"
               and json.loads(line).get("executable")]
assert len(executables) == 1, executables
executable = pathlib.Path(executables[0])
arguments = [str(executable), "--nocapture", "--test-threads=1"]
stock_env = env | {"RESEARCH_ATOMIC_STOCK": "1"}
with (output / "atomic-wasix-stock.log").open("w") as log:
    child = subprocess.Popen(arguments, env=stock_env, stdout=log, stderr=subprocess.STDOUT)
    try:
        code = child.wait(timeout=5)
    except subprocess.TimeoutExpired:
        child.kill()
        child.wait()
        code = "parent_timeout_after_delivered_sigkill"
assert code == "parent_timeout_after_delivered_sigkill", code
assert "wasix_sigkill_sent=true workers=1 stock=true" in (output / "atomic-wasix-stock.log").read_text()
with (output / "atomic-wasix-patched.log").open("w") as log:
    result = subprocess.run(arguments, env=env, stdout=log, stderr=subprocess.STDOUT, timeout=60)
text = (output / "atomic-wasix-patched.log").read_text(errors="replace")
print(text, flush=True)
assert result.returncode == 0, result.returncode
assert "native_wasix_signal_registry=PASS single_cycles=20 three_waiter_cycles=5 late_attach=25 late_signals=2500" in text
source = pathlib.Path(__file__).parent
(output / "atomic-wasix-receipt.json").write_text(json.dumps({
    "scope": "private Windows WASIX signal path and shared-memory isolate registry; not production teardown hooks",
    "stock_result": code,
    "patched_exit_code": result.returncode,
    "executable_sha256": hashlib.sha256(executable.read_bytes()).hexdigest(),
    "source_hashes": {name: hashlib.sha256((source / name).read_bytes()).hexdigest()
                      for name in ("atomic-wasix.rs", "atomic-wasix.diff", "atomic-wasix.wasm")},
    "single_cycles": 20,
    "three_waiter_cycles": 5,
    "late_attach_cycles": 25,
    "late_signals": 2500,
}, indent=2) + "\n")
