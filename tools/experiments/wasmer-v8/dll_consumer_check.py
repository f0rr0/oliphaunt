"""Build the private DLL consumer without engine producer tools, then execute it."""
import json
import os
import pathlib
import shutil
import subprocess
import sys

output = pathlib.Path(sys.argv[1]).resolve()
env = os.environ.copy()
env["LIBCLANG_PATH"] = str(output / "absent-libclang")
removed = []
paths = []
for part in env["PATH"].split(os.pathsep):
    path = pathlib.Path(part)
    if any((path / name).is_file() for name in (
            "llvm-objcopy.exe", "objcopy.exe", "gobjcopy.exe", "libclang.dll", "clang.exe")):
        removed.append(part)
    else:
        paths.append(part)
env["PATH"] = os.pathsep.join(paths)


def run(name, command, *, environment=env):
    result = subprocess.run(command, capture_output=True, encoding="utf-8", errors="replace", env=environment)
    (output / (name + ".log")).write_text(result.stdout + result.stderr, encoding="utf-8")
    print(f"{name}: exit={result.returncode}")
    if result.returncode:
        print(result.stdout[-4000:] + result.stderr[-4000:])
        sys.exit(result.returncode)
    return result


run("resolve-private-dependency", ["cargo", "metadata", "--offline", "--format-version=1"])
run("consumer-build-no-engine-tools", ["cargo", "build", "--locked", "--release", "--features",
    "wasix,private-dll-control"])
# Producer staging only. This deliberately does not claim automatic installed
# SDK DLL location, standalone executable deployment, or registry publication.
release = pathlib.Path("target/release").resolve()
shutil.copy2(output / "oliphaunt_wee8.dll", release / "oliphaunt_wee8.dll")
binary = str(release / "oliphaunt-wasmer-v8-probe.exe")
for profile in ["baseline", "baseline-no-jcc"]:
    cache = str(output / (profile + ".cache"))
    guest = str(pathlib.Path("profile-results/postgres.wasm").resolve())
    run(profile + "-write", [binary, "cpu-profile", profile, "write", cache, guest])
    run(profile + "-read", [binary, "cpu-profile", profile, "read", cache, guest])
host_lib = pathlib.Path("target/host-map").resolve()
run("ordinary-md-link", ["cargo", "rustc", "--locked", "--release", "--features",
    "private-dll-control", "--example", "mixed_host", "--", "-L", "native=" + str(host_lib)])
examples = release / "examples"
shutil.copy2(output / "oliphaunt_wee8.dll", examples / "oliphaunt_wee8.dll")
for i in range(10):
    run(f"ordinary-md-runtime-{i}", [str(examples / "mixed_host.exe")])
for tool, argument, name in [("dumpbin.exe", "/EXPORTS", "dll-exports"),
                            ("dumpbin.exe", "/DEPENDENTS", "dll-dependencies")]:
    run(name, [tool, "/NOLOGO", argument, str(output / "oliphaunt_wee8.dll")])
receipt = {"consumerToolDirectoriesRemoved": removed, "libclangPath": env["LIBCLANG_PATH"],
           "profiles": ["baseline", "baseline-no-jcc"], "ordinaryMdRuntimeProcesses": 10,
           "scope": "private DLL and dependency build; producer-staged runtime layout; not full SDK delivery"}
(output / "consumer-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
