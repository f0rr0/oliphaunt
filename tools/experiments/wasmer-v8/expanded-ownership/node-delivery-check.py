"""Measure real Node addon process survival and retry after Windows DLL errors."""
import ctypes
import hashlib
import json
import os
import pathlib
import queue
import shutil
import subprocess
import sys
import threading


def main():
    output = pathlib.Path(sys.argv[1]).resolve()
    drivers = pathlib.Path(__file__).resolve().parent
    build = subprocess.run(["cargo", "build", "--locked", "-p", "oliphaunt-wasix-napi",
        "--no-default-features", "--message-format=json"], capture_output=True, encoding="utf-8", timeout=1200)
    (output / "node-delivery-build.log").write_text(build.stdout + build.stderr)
    if build.returncode:
        print(build.stderr[-16000:], flush=True)
        raise RuntimeError(f"Node addon build failed: {build.returncode}")
    binaries = [file for line in build.stdout.splitlines() if line.startswith("{")
        for message in [json.loads(line)] if message.get("reason") == "compiler-artifact"
        and message["target"]["name"] == "oliphaunt_wasix_napi"
        for file in message["filenames"] if file.endswith(".dll")]
    assert len(binaries) == 1
    addon = output / "delivery-addon.node"
    shutil.copy2(binaries[0], addon)
    digest = json.loads((output / "embedded-delivery-receipt.json").read_text())["dll_sha256"]
    cache = pathlib.Path(os.environ["LOCALAPPDATA"]) / "Oliphaunt/research-engines" / digest / "oliphaunt_wee8.dll"
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateFileW.argtypes = [ctypes.c_wchar_p, ctypes.c_uint32, ctypes.c_uint32,
                                  ctypes.c_void_p, ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p]
    kernel.CreateFileW.restype = ctypes.c_void_p
    kernel.CloseHandle.argtypes = [ctypes.c_void_p]
    checks = []
    for mode in ("direct", "actor"):
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_bytes(b"locked damaged engine")
        handle = kernel.CreateFileW(str(cache), 0x80000000, 1, None, 3, 0x80, None)
        assert handle != ctypes.c_void_p(-1).value, ctypes.get_last_error()
        process = subprocess.Popen(["node", str(drivers / "node-delivery.mjs"), str(addon), mode, str(cache)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        lines = []
        events = queue.Queue()
        def read():
            for line in process.stdout:
                lines.append(line)
                if "node_loader_failure=PASS" in line:
                    events.put(True)
            events.put(False)
        reader = threading.Thread(target=read, daemon=True)
        reader.start()
        try:
            assert events.get(timeout=60), ''.join(lines)
            assert kernel.CloseHandle(handle)
            handle = None
            process.stdin.write("retry\n")
            process.stdin.flush()
            process.stdin.close()
            code = process.wait(timeout=180)
            reader.join(timeout=10)
            assert code == 0, ''.join(lines)
            assert sum("node_loader_retry=PASS" in line for line in lines) == 1
            assert hashlib.sha256(cache.read_bytes()).hexdigest() == digest
            checks.append({"mode": mode, "failure": "structured runtime-error", "retry": "query and close", "exit_code": code})
        finally:
            if handle is not None:
                kernel.CloseHandle(handle)
            if process.poll() is None:
                process.kill()
                process.wait()
            (output / ("node-delivery-" + mode + ".log")).write_text(''.join(lines))
            print(''.join(lines), flush=True)
    (output / "node-delivery-receipt.json").write_text(json.dumps({
        "scope": "actual Node addon DLL error propagation and same-process retry; not installed npm carrier",
        "addon_sha256": hashlib.sha256(addon.read_bytes()).hexdigest(), "checks": checks,
    }, indent=2) + "\n")


if __name__ == "__main__":
    main()
