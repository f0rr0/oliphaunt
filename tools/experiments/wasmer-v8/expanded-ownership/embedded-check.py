"""Test embedded delivery with a standalone executable, cold races and the SDK."""
import hashlib
import json
import os
import pathlib
import shutil
import subprocess
import sys

output = pathlib.Path(sys.argv[1]).resolve()
env = os.environ.copy()
env["LIBCLANG_PATH"] = str(output / "absent-libclang")
paths = []
for part in env["PATH"].split(os.pathsep):
    directory = pathlib.Path(part)
    if any((directory / name).is_file() for name in (
        "oliphaunt_wee8.dll", "llvm-objcopy.exe", "objcopy.exe", "gobjcopy.exe",
        "libclang.dll", "clang.exe")):
        continue
    paths.append(part)
env["PATH"] = os.pathsep.join(paths)
bash = pathlib.Path(os.environ["PROGRAMFILES"]) / "Git/bin/bash.exe"
assert bash.is_file()
shutil.copy2(pathlib.Path(__file__).with_name("call-ownership.rs"),
             "src/wasix/sdks/rust/tests/research_v8_call_ownership.rs")
command = ["cargo", "test", "--locked", "-p", "oliphaunt-wasix", "--no-default-features",
           "--test", "research_v8_call_ownership", "--no-run", "--message-format=json"]
build = subprocess.run(command, env=env, capture_output=True, encoding="utf-8")
(output / "embedded-build.log").write_text(build.stdout + build.stderr)
if build.returncode:
    print(build.stderr[-16000:], flush=True)
    sys.exit(build.returncode)
executables = [json.loads(line)["executable"] for line in build.stdout.splitlines()
               if line.startswith("{") and json.loads(line).get("reason") == "compiler-artifact"
               and json.loads(line).get("executable")]
assert len(executables) == 1, executables
sandbox = output / "standalone-consumer"
sandbox.mkdir()
executable = sandbox / "consumer.exe"
shutil.copy2(executables[0], executable)
assert list(sandbox.iterdir()) == [executable], "consumer directory must contain only its exe"
msvc = pathlib.Path(os.environ["VCToolsInstallDir"]) / "bin/HostX64/x64"
imports = subprocess.check_output([str(msvc / "dumpbin.exe"), "/nologo", "/dependents",
                                  str(executable)], encoding="utf-8")
(output / "embedded-consumer-imports.log").write_text(imports)
assert "oliphaunt_wee8.dll" not in imports.lower(), imports
receipt = json.loads((output / "embedded-delivery-receipt.json").read_text())
digest = receipt["dll_sha256"]
assert len(digest) == 64 and all(char in "0123456789abcdef" for char in digest)
cache = pathlib.Path(os.environ["LOCALAPPDATA"]) / "Oliphaunt/research-engines" / digest
if cache.exists():
    shutil.rmtree(cache)
processes = []
for index in range(3):
    log = (output / f"embedded-cold-{index}.log").open("w")
    process = subprocess.Popen([str(executable), "--nocapture", "--test-threads=1"],
                               cwd=sandbox, env=env, stdout=log, stderr=subprocess.STDOUT)
    processes.append((process, log))
codes = []
try:
    for process, log in processes:
        codes.append(process.wait(timeout=180))
finally:
    for process, log in processes:
        if process.poll() is None:
            process.kill()
            process.wait()
        log.close()
assert codes == [0, 0, 0], codes
materialized = cache / "oliphaunt_wee8.dll"
assert hashlib.sha256(materialized.read_bytes()).hexdigest() == digest
for index in range(3):
    text = (output / f"embedded-cold-{index}.log").read_text()
    loaded = [pathlib.Path(line.removeprefix("research_embedded_engine_loaded="))
              for line in text.splitlines() if line.startswith("research_embedded_engine_loaded=")]
    assert len(loaded) == 1 and loaded[0].resolve() == materialized.resolve(), text[-2000:]
with (output / "embedded-warm.log").open("w") as log:
    result = subprocess.run([str(executable), "--nocapture", "--test-threads=1"],
                            cwd=sandbox, env=env, stdout=log, stderr=subprocess.STDOUT,
                            timeout=180)
assert result.returncode == 0, result.returncode
receipt.update({"standalone_executable_sha256": hashlib.sha256(executable.read_bytes()).hexdigest(),
                "cold_concurrent_exit_codes": codes, "warm_exit_code": result.returncode,
                "runtime_dll_path": str(materialized), "consumer_directory_files": [executable.name],
                "engine_in_normal_imports": False})
(output / "embedded-delivery-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
print(json.dumps(receipt, indent=2), flush=True)
commands = [
    ("embedded-runtime-extension-tools.log", [str(bash), "src/wasix/sdks/rust/tools/test-aot.sh"]),
    ("embedded-lifecycle-driver.log", [sys.executable,
                                      "tools/experiments/wasmer-v8/lifecycle_check.py", str(output)]),
]
for name, command in commands:
    with (output / name).open("w") as log:
        result = subprocess.run(command, env=env, stdout=log, stderr=subprocess.STDOUT)
    print(name, "exit=", result.returncode, flush=True)
    print((output / name).read_text(errors="replace")[-12000:], flush=True)
    if result.returncode:
        sys.exit(result.returncode)
