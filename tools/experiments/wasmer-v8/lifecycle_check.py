"""Measure one SDK test process, preserving its exit status and raw memory samples."""
import ctypes
from ctypes import wintypes
import json
import pathlib
import subprocess
import sys
import time

output = pathlib.Path(sys.argv[1])
command = ["cargo", "test", "--locked", "-p", "oliphaunt-wasix", "--no-default-features",
           "--features", "extension-vector", "--test", "extensions_smoke", "--no-run",
           "--message-format=json"]
build = subprocess.run(command, capture_output=True, encoding="utf-8")
(output / "lifecycle-build.log").write_text(build.stdout + build.stderr, encoding="utf-8")
if build.returncode:
    print(build.stderr, file=sys.stderr)
    sys.exit(build.returncode)
executables = [json.loads(line)["executable"] for line in build.stdout.splitlines()
               if line.startswith("{") and json.loads(line).get("reason") == "compiler-artifact"
               and json.loads(line).get("executable")]
if len(executables) != 1:
    raise RuntimeError(f"expected exactly one SDK test executable: {executables}")


class Counters(ctypes.Structure):
    _fields_ = [("cb", wintypes.DWORD), ("PageFaultCount", wintypes.DWORD)] + [
        (name, ctypes.c_size_t) for name in (
            "PeakWorkingSetSize", "WorkingSetSize", "QuotaPeakPagedPoolUsage", "QuotaPagedPoolUsage",
            "QuotaPeakNonPagedPoolUsage", "QuotaNonPagedPoolUsage", "PagefileUsage",
            "PeakPagefileUsage", "PrivateUsage")]


kernel = ctypes.WinDLL("kernel32", use_last_error=True)
psapi = ctypes.WinDLL("psapi", use_last_error=True)
kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
kernel.OpenProcess.restype = wintypes.HANDLE
kernel.CloseHandle.argtypes = [wintypes.HANDLE]
psapi.GetProcessMemoryInfo.argtypes = [wintypes.HANDLE, ctypes.POINTER(Counters), wintypes.DWORD]
psapi.GetProcessMemoryInfo.restype = wintypes.BOOL
samples = []
with (output / "lifecycle.log").open("w") as log:
    process = subprocess.Popen([executables[0], "vector_extension_repeated_lifecycle", "--ignored",
                                "--exact", "--nocapture", "--test-threads=1"], stdout=log, stderr=log)
    handle = kernel.OpenProcess(0x0400 | 0x0010, False, process.pid)
    if not handle:
        process.kill()
        raise ctypes.WinError(ctypes.get_last_error())
    start = time.monotonic()
    try:
        while process.poll() is None:
            counters = Counters(cb=ctypes.sizeof(Counters))
            if psapi.GetProcessMemoryInfo(handle, ctypes.byref(counters), counters.cb):
                samples.append({"seconds": round(time.monotonic() - start, 3),
                                "private_bytes": counters.PrivateUsage,
                                "working_set_bytes": counters.WorkingSetSize,
                                "completed_cycles": (output / "lifecycle.log").read_text().count(
                                    "completed_extension_lifecycle=")})
            if time.monotonic() - start > 300:
                process.kill()
                process.wait()
                raise TimeoutError("25 SDK lifecycles exceeded five minutes")
            time.sleep(0.1)
    finally:
        kernel.CloseHandle(handle)
        (output / "lifecycle-memory.json").write_text(json.dumps(samples, indent=2) + "\n")
print((output / "lifecycle.log").read_text())
if not samples:
    raise RuntimeError("Windows process memory counters produced no samples")
print(f"samples={len(samples)} peak_private_bytes={max(s['private_bytes'] for s in samples)}")
sys.exit(process.returncode)
