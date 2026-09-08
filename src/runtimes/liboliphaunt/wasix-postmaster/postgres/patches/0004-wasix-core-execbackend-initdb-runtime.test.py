#!/usr/bin/env python3
"""Exercise the patched executable-version probe's native and WASIX branches."""

import os
from pathlib import Path
import shlex
import subprocess
import tempfile


patch = Path(__file__).with_suffix("").with_suffix(".patch").read_text()
start = patch.index("@@ -327,10 ")
end = patch.index("\n@@", start + 3)
lines = patch[start:end].splitlines()[1:]
updated = "\n".join(line[1:] for line in lines if line.startswith(("+", " ")))
probe = updated[updated.index("#ifdef __wasi__"):updated.index("\tif (strcmp")]

source = r'''
#include <assert.h>
#include <stdio.h>
#include <string.h>
static char *result;
static char *wasix_read_first_line_from_argv(char *const argv[]) { return result; }
static char *pipe_read_line(const char *command) { return result; }
static int probe_version(void) {
    char *line;
    char retpath[] = "/postgres";
    const char *versionstr = "PostgreSQL 18.4\n";
    char cmd[128];
''' + probe + r'''
    return strcmp(line, versionstr) == 0 ? 0 : -2;
}
int main(void) {
    /* Spawn/read failure, empty output, and failed child all yield NULL. */
    result = NULL;
    assert(probe_version() == -1);
    result = "PostgreSQL 18.4\n";
    assert(probe_version() == 0);
    result = "PostgreSQL 17.0\n";
    assert(probe_version() == -2);
}
'''

with tempfile.TemporaryDirectory(prefix="postgres-version-probe-") as temporary:
    directory = Path(temporary)
    source_path = directory / "probe.c"
    source_path.write_text(source)
    for mode in ([], ["-D__wasi__"]):
        executable = directory / "probe"
        subprocess.run(
            shlex.split(os.environ.get("CC", "cc"))
            + ["-std=c99", *mode, str(source_path), "-o", str(executable)],
            check=True,
        )
        subprocess.run([str(executable)], check=True)

print("native and WASIX executable-version failure checks passed")
