"""Execute the private patched SDK through its producer-staged DLL boundary."""
import json
import os
import pathlib
import subprocess
import sys

output = pathlib.Path(sys.argv[1]).resolve()
env = os.environ.copy()
env["LIBCLANG_PATH"] = str(output / "absent-libclang")
removed, paths = [], []
for part in env["PATH"].split(os.pathsep):
    path = pathlib.Path(part)
    if any((path / name).is_file() for name in (
        "llvm-objcopy.exe", "objcopy.exe", "gobjcopy.exe", "libclang.dll", "clang.exe")):
        removed.append(part)
    else:
        paths.append(part)
env["PATH"] = os.pathsep.join([str(output / "engine")] + paths)
(output / "sdk-consumer-tools.json").write_text(json.dumps({
    "removed": removed, "libclangPath": env["LIBCLANG_PATH"],
    "scope": "producer-owned DLL staging, not installed package discovery"}, indent=2) + "\n")
bash = pathlib.Path(os.environ["PROGRAMFILES"]) / "Git/bin/bash.exe"
if not bash.is_file():
    raise RuntimeError(f"missing runner Git Bash: {bash}")
import shutil
shutil.copy2(pathlib.Path(__file__).with_name("call-ownership.rs"),
             "src/wasix/sdks/rust/tests/research_v8_call_ownership.rs")
commands = [
    ("call-ownership.log", ["cargo", "test", "--locked", "-p", "oliphaunt-wasix",
                            "--no-default-features", "--test", "research_v8_call_ownership",
                            "--", "--nocapture", "--test-threads=1"]),
    ("runtime-extension-tools.log", [str(bash), "src/wasix/sdks/rust/tools/test-aot.sh"]),
    ("lifecycle-driver.log", [sys.executable, "tools/experiments/wasmer-v8/lifecycle_check.py", str(output)]),
]
for name, command in commands:
    with (output / name).open("w", encoding="utf-8") as log:
        result = subprocess.run(command, env=env, stdout=log, stderr=subprocess.STDOUT)
    print(name, "exit=", result.returncode, flush=True)
    print((output / name).read_text(encoding="utf-8", errors="replace")[-12000:], flush=True)
    if result.returncode:
        sys.exit(result.returncode)
