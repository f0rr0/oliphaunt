"""Research producer: genuine Windows V8 cache on an emulated SSE4.1 CPU."""
import hashlib
import json
import os
import pathlib
import re
import shutil
import struct
import subprocess
import sys

output = pathlib.Path(sys.argv[1]).resolve()
output.mkdir(parents=True, exist_ok=True)
source = pathlib.Path(__file__).resolve().parent
frozen = pathlib.Path(sys.argv[2]).resolve()
guest = pathlib.Path(sys.argv[3]).resolve()
assert hashlib.sha256(guest.read_bytes()).hexdigest() == "69fdbc72f9e110c1e356db8f46b941cb67591eff140231fcfaffff201d4e7cf9"
engine = next(frozen.rglob("engine/oliphaunt_wee8.dll"))
receipt = json.loads(engine.with_name("receipt.json").read_text())
assert hashlib.sha256(engine.read_bytes()).hexdigest() == receipt["hashes"]["dll"]
for path in [source / "cache-probe.c", source / "kernel32.def", engine,
             engine.with_suffix(".lib")]:
    shutil.copy2(path, output)
shutil.copy2(guest, output / "guest.wasm")
def run(command, name, env=None, timeout=300):
    with (output / name).open("w") as log:
        result = subprocess.run(command, cwd=output, env=env, stdout=log,
                                stderr=subprocess.STDOUT, timeout=timeout)
    print(name, "exit=", result.returncode, flush=True)
    print((output / name).read_text(errors="replace")[-4000:], flush=True)
    assert result.returncode == 0, name

clang = next((shutil.which(n) for n in ["clang-18", "clang"] if shutil.which(n)))
link = next((shutil.which(n) for n in ["lld-link-18", "lld-link"] if shutil.which(n)))
run([link, "/lib", "/machine:x64", "/def:kernel32.def", "/out:kernel32.lib"], "import-lib.log")
run([clang, "--target=x86_64-pc-windows-msvc", "-c", "-O2", "-ffreestanding",
     "-fno-stack-protector", "cache-probe.c", "-o", "cache-probe.obj"], "compile.log")
run([link, "/nologo", "/nodefaultlib", "/machine:x64", "/entry:mainCRTStartup",
     "/subsystem:console", "cache-probe.obj", "kernel32.lib", "oliphaunt_wee8.lib",
     "/out:cache-probe.exe"], "link.log")
run(["apt-get", "download", "wine64", "libwine", "libz-mingw-w64", "qemu-user"], "packages.log")
private = output / "private"
for package in output.glob("*.deb"):
    run(["dpkg-deb", "-x", str(package), str(private)], "extract-" + package.name + ".log")
wine = private / "usr/lib/wine"
shutil.copy2(wine / "wineserver64", wine / "wineserver")
libs = private / "usr/lib/x86_64-linux-gnu/wine"
prefix = output / "wine-prefix"
system = prefix / "drive_c/windows/system32"
system.mkdir(parents=True)
shutil.copy2(private / "usr/x86_64-w64-mingw32/lib/zlib1.dll", system)
env = os.environ.copy()
env.update(WINEPREFIX=str(prefix), WINEDEBUG="-all",
           WINEDLLPATH=str(libs / "x86_64-windows") + ":" + str(libs / "x86_64-unix"),
           LD_LIBRARY_PATH=str(libs / "x86_64-unix"))
run([str(wine / "wine64"), "cmd", "/c", "exit", "0"], "wine-initialize.log", env)
# Wine's first launch execs another native loader, which escapes QEMU user
# emulation. Keep this producer in the emulated process; its CPUID log verifies it.
env["WINELOADERNOEXEC"] = "1"
qemu = private / "usr/bin/qemu-x86_64"
command = [str(qemu), "-cpu", "Penryn", str(wine / "wine64"), "cache-probe.exe"]
run(command + ["write"], "wine-penryn-write.log", env)
run(command + ["read"], "wine-penryn-fresh-read.log", env)
for name in ["wine-penryn-write.log", "wine-penryn-fresh-read.log"]:
    cpu = re.findall(r"cpuid_leaf1_ecx=(0x[0-9a-f]+) cpuid_leaf7_ecx=(0x[0-9a-f]+)",
                     (output / name).read_text())
    assert len(cpu) == 1, name
    leaf1, leaf7 = (int(value, 16) for value in cpu[0])
    assert leaf1 & (1 << 19) and not leaf1 & (1 << 28) and not leaf7 & (1 << 7), cpu
data = (output / "cache.bin").read_bytes()
offset = 0
wire = 0
shift = 0
while True:
    byte = data[offset]
    offset += 1
    wire |= (byte & 127) << shift
    shift += 7
    if not byte & 128:
        break
header = struct.unpack_from("<5I", data, offset + wire)
assert header[0] == 0xc0de0689 and header[2] == 0xe, header
shutil.copy2(output / "cache.bin", output / "wine-postgres.cache")
evidence = {"method": "exact Windows DLL under Wine/QEMU Penryn; native cache headers unmodified",
            "dll_sha256": receipt["hashes"]["dll"], "cache_sha256": hashlib.sha256(data).hexdigest(),
            "native_bytes": len(data) - offset - wire, "header": header,
            "guest_sha256": hashlib.sha256(data[offset:offset + wire]).hexdigest(),
            "packages": {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in output.glob("*.deb")}}
(output / "wine-producer-receipt.json").write_text(json.dumps(evidence, indent=2) + "\n")
print(json.dumps(evidence, indent=2))
