#!/usr/bin/env python3
"""Check inherited word loads against byte semantics, including protected-page ends."""

import os
from pathlib import Path
import shlex
import subprocess
import tempfile


patch = Path(__file__).name.replace(".test.py", ".patch")
section = Path(__file__).with_name(patch).read_text().split("@@ -1,8 +1,43 @@\n", 1)[1]
implementation = "\n".join(line[1:] for line in section.splitlines()
                           if line.startswith(("+", " ")))
source = "#define memcmp candidate_memcmp\n" + implementation + r"""
#undef memcmp
#include <assert.h>
#include <sys/mman.h>
#include <unistd.h>

int main(void)
{
    unsigned char left[96], right[96];
    for (size_t a = 0; a < 8; a++)
        for (size_t b = 0; b < 8; b++)
            for (size_t n = 0; n <= 80; n++) {
                memset(left, 0x80, sizeof left);
                memset(right, 0x80, sizeof right);
                assert(candidate_memcmp(left + a, right + b, n) == 0);
                for (size_t mismatch = 0; mismatch < n; mismatch++) {
                    right[b + mismatch] = 0xff;
                    assert(candidate_memcmp(left + a, right + b, n) == -127);
                    assert(candidate_memcmp(right + b, left + a, n) == 127);
                    right[b + mismatch] = 0;
                    assert(candidate_memcmp(left + a, right + b, n) == 128);
                    right[b + mismatch] = 0x80;
                }
            }
    long page = sysconf(_SC_PAGESIZE);
    assert(page >= 4096);
    unsigned char *mapping = mmap(NULL, (size_t)page * 4,
        PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    assert(mapping != MAP_FAILED);
    assert(mprotect(mapping + page, (size_t)page, PROT_NONE) == 0);
    assert(mprotect(mapping + 3 * page, (size_t)page, PROT_NONE) == 0);
    for (size_t n = 0; n <= 80; n++) {
        unsigned char *l = mapping + page - n;
        unsigned char *r = mapping + 3 * page - n;
        memset(l, 0xff, n);
        memset(r, 0xff, n);
        assert(candidate_memcmp(l, r, n) == 0);
        if (n) {
            r[n - 1] = 0;
            assert(candidate_memcmp(l, r, n) == 255);
        }
    }
    assert(munmap(mapping, (size_t)page * 4) == 0);
    return 0;
}
"""
with tempfile.TemporaryDirectory(prefix="libc-memcmp-") as temporary:
    executable = str(Path(temporary) / "probe")
    for optimization in ("-O0", "-O2"):
        subprocess.run(shlex.split(os.environ.get("CC", "cc")) + ["-x", "c",
            "-D_GNU_SOURCE", optimization, "-Wall", "-Wextra", "-Werror",
            "-", "-o", executable], input=source, text=True, check=True)
        subprocess.run([executable], check=True)
print("memcmp O0/O2: all byte positions, independent alignments, unsigned order and protected-page bounds")
