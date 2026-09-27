#!/usr/bin/env python3
"""Keep sigsetjmp's helper macro within its implementation's EH build scope."""

import os
from pathlib import Path
import shlex
import subprocess


patch = Path(__file__).with_suffix("").with_suffix(".patch").read_text()
section = patch.split("+++ b/libc-top-half/musl/include/setjmp.h\n", 1)[1]
section = section.split("\ndiff --git ", 1)[0]
lines = section.splitlines()[1:]
header = "\n".join(line[1:] for line in lines if line.startswith(("+", " ")))
source = header + "\nsigsetjmp(probe_buffer, 1);\n"

for defines, helper_expected in (
    ([], False),
    (["__wasm_exception_handling__"], True),
    (["__wasm_exception_handling__", "__WASIX_LIBC_BUILDING_SETJMP"], False),
    (["__wasm_exception_handling__", "__wasilibc_unmodified_upstream"], False),
):
    preprocessed = subprocess.run(
        shlex.split(os.environ.get("CC", "cc"))
        + ["-E", "-P", "-x", "c", "-D_POSIX_SOURCE"]
        + [f"-D{define}" for define in defines]
        + ["-"],
        input=source,
        text=True,
        capture_output=True,
        check=True,
    ).stdout
    assert ("__wasilibc_sigsetjmp_save" in preprocessed) == helper_expected, defines
    assert ("sigsetjmp(probe_buffer, 1)" not in preprocessed) == helper_expected, defines

print("sigsetjmp helper matches EH, non-EH, libc-build and upstream header scopes")
