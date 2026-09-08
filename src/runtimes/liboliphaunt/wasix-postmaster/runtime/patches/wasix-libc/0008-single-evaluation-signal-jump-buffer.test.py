#!/usr/bin/env python3
"""Execute the patched EH helpers with host frame/mask primitives, not a WASIX mask claim."""

import os
from pathlib import Path
import shlex
import subprocess
import tempfile


directory = Path(__file__).parent


def after_image(patch, path):
    section = (directory / patch).read_text().split(f"+++ b/{path}\n", 1)[1]
    section = section.split("\ndiff --git ", 1)[0]
    return "\n".join(line[1:] for line in section.splitlines()
                     if line.startswith(("+", " ")))


new_patch = Path(__file__).name.replace(".test.py", ".patch")
old_patch = "0005-wasm-eh-signal-context.patch"
header = after_image(new_patch, "libc-top-half/musl/include/setjmp.h")
declaration = header[header.index("\tstruct __jmp_buf_tag *"):header.index("\n#else", header.index("#define sigsetjmp"))]
helper = after_image(new_patch, "libc-top-half/musl/src/signal/sigsetjmp_tail.c")
helper = helper[helper.index("struct __jmp_buf_tag *__wasilibc_sigsetjmp_save"):helper.rindex("\n#endif")]
restore = after_image(old_patch, "libc-top-half/musl/src/signal/siglongjmp.c")
restore = restore[restore.index("_Noreturn void siglongjmp"):]
probe = (directory.parent.parent / "probes/wasm_eh_sjlj_probe.c").read_text()

# Only frame representation is adapted. Both helper bodies and the public macro
# come from the actual patches. _setjmp captures the live caller, never a wrapper.
adapter = r"""
#include <setjmp.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
struct probe_jmp_buf {
    jmp_buf native;
    unsigned long __fl;
    unsigned long __ss[128 / sizeof(long)];
};
typedef struct probe_jmp_buf probe_sigjmp_buf[1];
#ifdef __cplusplus
#define _Noreturn [[noreturn]]
#endif
#define __jmp_buf_tag probe_jmp_buf
#define sigjmp_buf probe_sigjmp_buf
#define jmp_buf probe_sigjmp_buf
#undef setjmp
#define setjmp(buf) _setjmp((buf)->native)
#define longjmp(buf, value) (longjmp)((buf)->native, (value))
#define siglongjmp probe_siglongjmp
#undef sigsetjmp
#define __wasm_exception_handling__ 1
"""

with tempfile.TemporaryDirectory(prefix="libc-sigsetjmp-") as temporary:
    for language, compiler in (("c", os.environ.get("CC", "cc")),
                               ("c++", os.environ.get("CXX", "c++"))):
        for optimization in ("-O0", "-O2"):
            for fixed in (False, True):
                macro = declaration if fixed else declaration.replace(
                    "setjmp(__wasilibc_sigsetjmp_save((buf), (savesigs)))",
                    "(__wasilibc_sigsetjmp_save((buf), (savesigs)), setjmp((buf)))")
                source = "\n".join((adapter, macro, helper, restore, probe))
                executable = str(Path(temporary) / "probe")
                subprocess.run(shlex.split(compiler) + ["-x", language,
                    "-D_POSIX_C_SOURCE=200809L", optimization, "-Wall", "-Wextra",
                    "-Werror", "-", "-o", executable], input=source, text=True, check=True)
                result = subprocess.run([executable], capture_output=True, text=True)
                assert result.returncode == (0 if fixed else 21), (language, optimization, fixed, result)
                if fixed:
                    assert "mask-preserved" in result.stdout

print("C/C++ O0/O2: caller-owned jumps, arguments once, zero/nonzero returns, host mask hooks; old macro rejected")
