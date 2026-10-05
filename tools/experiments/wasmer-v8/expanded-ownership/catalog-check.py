"""Private native catalog qualification with consumer compiler tools unavailable."""
import json
import os
import pathlib
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
# Let the full regression materialize the complete catalog, rather than reuse
# the preceding vector-only package selection.
env.pop("OLIPHAUNT_WASIX_EXTENSION_ARTIFACT_ROOT", None)
evidence = output / "catalog-evidence"
evidence.mkdir()
env["OLIPHAUNT_EXTENSION_EVIDENCE_DIR"] = str(evidence)
bash = pathlib.Path(os.environ["PROGRAMFILES"]) / "Git/bin/bash.exe"
assert bash.is_file()
with (output / "catalog-full-regression.log").open("w") as log:
    result = subprocess.run([str(bash), "src/wasix/runtime/tools/runtime-smoke.sh", "regression"],
                            env=env, stdout=log, stderr=subprocess.STDOUT, timeout=3600)
print("catalog-full-regression.log exit=", result.returncode, flush=True)
print((output / "catalog-full-regression.log").read_text(errors="replace")[-16000:], flush=True)
(output / "catalog-control-receipt.json").write_text(json.dumps({
    "scope": "private Windows full catalog, server and tools regression; not a published release",
    "exit_code": result.returncode,
    "consumer_libclang": False,
    "consumer_objcopy": False,
    "evidence_files": sorted(p.name for p in evidence.iterdir()),
}, indent=2) + "\n")
sys.exit(result.returncode)
