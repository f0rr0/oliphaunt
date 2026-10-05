"""Research-only CDB/PageHeap diagnosis of the failing native SDK isolation test."""
import json
import os
import pathlib
import subprocess
import sys

out = pathlib.Path(sys.argv[1]).resolve()
debuggers = pathlib.Path(os.environ["PROGRAMFILES(X86)"]) / "Windows Kits/10/Debuggers/x64"
cdb, gflags = debuggers / "cdb.exe", debuggers / "gflags.exe"
if not cdb.is_file() or not gflags.is_file():
    raise RuntimeError(f"runner's Windows SDK debuggers missing: {debuggers}")
exe = list(pathlib.Path("target/debug/deps").glob("postgres_regression-*.exe"))
if len(exe) != 1:
    raise RuntimeError(f"expected exact failing test executable: {exe}")
exe = exe[0].resolve()
env = os.environ.copy()
env["PATH"] = str(out / "engine") + os.pathsep + env["PATH"]
command = [str(cdb), "-o", "-G", "-c",
    "sxe av; sxe 0xc0000374; g; .ecxr; !analyze -v; kP; q",
    str(exe), "memory_instances_are_isolated", "--exact", "--nocapture", "--test-threads=1"]
with (out / "pageheap-control.log").open("w", encoding="utf-8") as log:
    subprocess.run([str(gflags), "/p", "/enable", exe.name, "/full", "/dlls", "oliphaunt_wee8.dll"], check=True, stdout=log, stderr=subprocess.STDOUT)
    try:
        with (out / "pageheap-cdb.log").open("w", encoding="utf-8") as debug:
            result = subprocess.run(command, env=env, stdout=debug, stderr=subprocess.STDOUT, timeout=300)
    finally:
        subprocess.run([str(gflags), "/p", "/disable", exe.name], check=True, stdout=log, stderr=subprocess.STDOUT)
(out / "pageheap-receipt.json").write_text(json.dumps({"command": command, "debuggerExit": result.returncode,
    "scope": "native first-chance fault diagnosis, not SDK acceptance"}, indent=2) + "\n")
print((out / "pageheap-cdb.log").read_text(encoding="utf-8", errors="replace")[-18000:])
