#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
extractor="$root/tools/dev/extract-pinned-zip.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT HUP INT TERM

python_bin=""
for candidate in python3 python; do
  if command -v "$candidate" >/dev/null 2>&1 &&
    "$candidate" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 8) else 1)'; then
    python_bin="$candidate"
    break
  fi
done
[ -n "$python_bin" ] || {
  echo "Python 3.8 or newer is required" >&2
  exit 1
}

"$python_bin" - "$tmp" <<'PY'
import os
import stat
import struct
import sys
import warnings
import zipfile
from pathlib import Path

root = Path(sys.argv[1])

def write_zip(name, entries):
    with zipfile.ZipFile(root / name, "w", zipfile.ZIP_DEFLATED) as archive:
        for path, contents, mode in entries:
            info = zipfile.ZipInfo(path)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = mode << 16
            archive.writestr(info, contents)

write_zip("valid.zip", [("tool/bin/tool", b"#!/bin/sh\necho ok\n", stat.S_IFREG | 0o755)])
write_zip("traversal.zip", [("tool/../escape", b"no", stat.S_IFREG | 0o644)])
write_zip("symlink.zip", [("tool/bin/tool", b"/tmp/escape", stat.S_IFLNK | 0o777)])
write_zip("wrong-layout.zip", [("other/bin/tool", b"no", stat.S_IFREG | 0o755)])
write_zip("case-collision.zip", [
    ("tool/bin/tool", b"one", stat.S_IFREG | 0o755),
    ("tool/bin/Tool", b"two", stat.S_IFREG | 0o755),
])

with warnings.catch_warnings():
    warnings.simplefilter("ignore", UserWarning)
    with zipfile.ZipFile(root / "duplicate.zip", "w", zipfile.ZIP_STORED) as archive:
        archive.writestr("tool/bin/tool", b"one")
        archive.writestr("tool/bin/tool", b"two")

valid = (root / "valid.zip").read_bytes()
(root / "truncated.zip").write_bytes(valid[:-7])

oversized = bytearray(valid)
central = oversized.find(b"PK\x01\x02")
if central < 0:
    raise SystemExit("could not locate ZIP central directory")
struct.pack_into("<I", oversized, central + 24, 150_000_001)
(root / "oversized.zip").write_bytes(oversized)
PY

expect_failure() {
  local name="$1"
  local archive="$2"
  local count="$3"
  local prefix="${4:-tool}"
  local destination="$tmp/out-$name"
  if "$extractor" \
    --archive "$archive" \
    --destination "$destination" \
    --prefix "$prefix" \
    --entry-count "$count" \
    --required tool/bin/tool \
    --executable tool/bin/tool >"$tmp/$name.stdout" 2>"$tmp/$name.stderr"; then
    echo "expected $name archive rejection" >&2
    exit 1
  fi
  [ ! -e "$destination" ] || {
    echo "$name left a partial extraction destination" >&2
    exit 1
  }
}

valid_destination="$tmp/valid-out"
"$extractor" \
  --archive "$tmp/valid.zip" \
  --destination "$valid_destination" \
  --prefix tool \
  --entry-count 1 \
  --required tool/bin/tool \
  --executable tool/bin/tool
"$valid_destination/tool/bin/tool" | grep -qx ok
"$python_bin" - "$valid_destination/tool/bin/tool" <<'PY'
import os
import stat
import sys
mode = stat.S_IMODE(os.stat(sys.argv[1]).st_mode)
raise SystemExit(0 if mode == 0o755 else f"unexpected extracted mode: {mode:o}")
PY

expect_failure traversal "$tmp/traversal.zip" 1
expect_failure symlink "$tmp/symlink.zip" 1
expect_failure duplicate "$tmp/duplicate.zip" 2
expect_failure case-collision "$tmp/case-collision.zip" 2
expect_failure oversized "$tmp/oversized.zip" 1
expect_failure truncated "$tmp/truncated.zip" 1
expect_failure wrong-layout "$tmp/wrong-layout.zip" 1
expect_failure wrong-entry-count "$tmp/valid.zip" 2

echo "pinned ZIP adversarial tests passed"
