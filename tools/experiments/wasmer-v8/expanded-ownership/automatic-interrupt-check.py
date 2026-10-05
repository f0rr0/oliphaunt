"""Exercise automatic WASIX interruption, late attachment and teardown races."""
import hashlib
import json
import pathlib
import subprocess
import sys

output = pathlib.Path(sys.argv[1]).resolve()
command = ["cargo", "test", "--locked", "-p", "oliphaunt-wasix", "--no-default-features",
           "--test", "research_v8_automatic_interrupt", "--no-run", "--message-format=json"]
build = subprocess.run(command, capture_output=True, encoding="utf-8")
(output / "automatic-interrupt-build.log").write_text(build.stdout + build.stderr)
if build.returncode:
    print(build.stderr[-16000:], flush=True)
    sys.exit(build.returncode)
executables = [json.loads(line)["executable"] for line in build.stdout.splitlines()
               if line.startswith("{") and json.loads(line).get("reason") == "compiler-artifact"
               and json.loads(line).get("executable")]
assert len(executables) == 1, executables
executable = pathlib.Path(executables[0])
with (output / "automatic-interrupt.log").open("w") as log:
    result = subprocess.run([str(executable), "--nocapture", "--test-threads=1"],
                            stdout=log, stderr=subprocess.STDOUT, timeout=120)
text = (output / "automatic-interrupt.log").read_text(errors="replace")
print(text, flush=True)
assert result.returncode == 0, result.returncode
assert "automatic_store_interrupt=PASS wait_cycles=25 waiters=35 late_attach_rejections=25 post_teardown_signals=2500 teardown_races=32 race_stores=288" in text
(output / "automatic-interrupt-receipt.json").write_text(json.dumps({
    "scope": "existing WASIX and memory APIs with automatic lifetime hooks; not installed carriers",
    "exit_code": result.returncode,
    "executable_sha256": hashlib.sha256(executable.read_bytes()).hexdigest(),
    "wait_cycles": 25, "waiters": 35, "late_attach_rejections": 25,
    "post_teardown_signals": 2500, "teardown_races": 32, "race_stores": 288,
    "manual_capture_or_retirement": False,
}, indent=2) + "\n")
