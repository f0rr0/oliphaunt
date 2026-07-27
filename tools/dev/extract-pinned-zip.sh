#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "extract-pinned-zip.sh: $*" >&2
  exit 1
}

archive=""
destination=""
prefix=""
entry_count=""
required=()
executables=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --archive) archive="${2:-}"; shift 2 ;;
    --destination) destination="${2:-}"; shift 2 ;;
    --prefix) prefix="${2:-}"; shift 2 ;;
    --entry-count) entry_count="${2:-}"; shift 2 ;;
    --required) required+=("${2:-}"); shift 2 ;;
    --executable) executables+=("${2:-}"); shift 2 ;;
    *) fail "unknown or incomplete option: $1" ;;
  esac
done

[ -f "$archive" ] || fail "archive is not a regular file: $archive"
[ -n "$destination" ] || fail "--destination is required"
case "$entry_count" in
  ''|*[!0-9]*) fail "--entry-count must be a positive integer" ;;
esac
[ "$entry_count" -ge 1 ] && [ "$entry_count" -le 4096 ] ||
  fail "--entry-count must be between 1 and 4096"
[ "${#required[@]}" -ge 1 ] || fail "at least one --required file is required"
[ "${#executables[@]}" -ge 1 ] || fail "at least one --executable file is required"
python_bin="${OLIPHAUNT_PINNED_ZIP_PYTHON:-}"
if [ -z "$python_bin" ]; then
  for candidate in python3 python; do
    if command -v "$candidate" >/dev/null 2>&1; then
      python_bin="$candidate"
      break
    fi
  done
fi
[ -n "$python_bin" ] && command -v "$python_bin" >/dev/null 2>&1 ||
  fail "Python 3 is required for bounded ZIP validation"
"$python_bin" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 8) else 1)' ||
  fail "Python 3.8 or newer is required for bounded ZIP validation"

required_file="$(mktemp "${TMPDIR:-/tmp}/oliphaunt-zip-required.XXXXXX")"
executable_file="$(mktemp "${TMPDIR:-/tmp}/oliphaunt-zip-executables.XXXXXX")"
cleanup() {
  rm -f "$required_file" "$executable_file"
}
trap cleanup EXIT HUP INT TERM
printf '%s\n' "${required[@]}" >"$required_file"
printf '%s\n' "${executables[@]}" >"$executable_file"

"$python_bin" - "$archive" "$destination" "$prefix" "$entry_count" "$required_file" "$executable_file" <<'PY'
import os
import shutil
import stat
import sys
import zipfile
from pathlib import Path, PurePosixPath

archive_path = Path(sys.argv[1])
destination = Path(sys.argv[2])
prefix = sys.argv[3]
expected_entries = int(sys.argv[4])
required = set(Path(sys.argv[5]).read_text(encoding="utf-8").splitlines())
executables = set(Path(sys.argv[6]).read_text(encoding="utf-8").splitlines())
max_archive = 220_000_000
max_expanded = 400_000_000
max_file = 150_000_000

def reject(message):
    raise ValueError(message)

def safe_name(info):
    name = info.filename
    try:
        name.encode("ascii")
    except UnicodeEncodeError:
        reject(f"non-ASCII archive path: {name!r}")
    if (
        not name
        or name.startswith("/")
        or "\\" in name
        or "\x00" in name
        or any(ord(character) < 0x20 or ord(character) == 0x7F for character in name)
    ):
        reject(f"unsafe archive path: {name!r}")
    directory_hint = name.endswith("/")
    trimmed = name[:-1] if directory_hint else name
    parts = trimmed.split("/")
    if (
        not trimmed
        or any(part in {"", ".", ".."} for part in parts)
        or any(len(part.encode("ascii")) > 255 for part in parts)
        or (parts and len(parts[0]) >= 2 and parts[0][1] == ":")
    ):
        reject(f"unsafe archive path: {name!r}")
    canonical = "/".join(parts)
    if prefix and canonical != prefix and not canonical.startswith(prefix + "/"):
        reject(f"archive path is outside required {prefix}/ root: {name!r}")

    mode = (info.external_attr >> 16) & 0xFFFF
    file_type = stat.S_IFMT(mode)
    if file_type not in {0, stat.S_IFREG, stat.S_IFDIR}:
        reject(f"unsupported archive entry type for {name!r}")
    directory = directory_hint or file_type == stat.S_IFDIR or bool(info.external_attr & 0x10)
    if directory != directory_hint:
        reject(f"inconsistent directory metadata for {name!r}")
    if directory and (info.file_size != 0 or info.compress_size != 0):
        reject(f"directory archive entry is not empty: {name!r}")
    return canonical, directory

try:
    archive_size = archive_path.stat().st_size
    if archive_size <= 0 or archive_size > max_archive:
        reject(f"archive size must be between 1 and {max_archive} bytes")
    if destination.exists() or destination.is_symlink():
        reject(f"private extraction destination must not already exist: {destination}")
    destination.mkdir(parents=True, mode=0o700)

    with zipfile.ZipFile(archive_path) as archive:
        entries = archive.infolist()
        if len(entries) != expected_entries:
            reject(f"archive entry count mismatch: expected {expected_entries}, got {len(entries)}")
        seen = {}
        total = 0
        validated = []
        for info in entries:
            canonical, directory = safe_name(info)
            folded = canonical.casefold()
            if folded in seen:
                reject(f"duplicate or case-colliding archive paths: {seen[folded]!r} and {canonical!r}")
            seen[folded] = canonical
            if info.flag_bits & 0x1:
                reject(f"encrypted archive entry: {canonical}")
            if info.compress_type not in {zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED}:
                reject(f"unsupported compression method for {canonical}")
            if info.file_size < 0 or info.file_size > max_file:
                reject(f"archive entry exceeds the {max_file}-byte per-file limit: {canonical}")
            total += info.file_size
            if total > max_expanded:
                reject(f"expanded archive exceeds the {max_expanded}-byte limit")
            validated.append((info, canonical, directory))

        missing = sorted(required - set(seen.values()))
        if missing:
            reject(f"archive is missing required files: {', '.join(missing)}")
        for path in required | executables:
            match = next((item for item in validated if item[1] == path), None)
            if match is None or match[2] or match[0].file_size == 0:
                reject(f"required archive path is not a non-empty regular file: {path}")
        for _, canonical, _ in validated:
            parent = PurePosixPath(canonical).parent
            while str(parent) != ".":
                parent_entry = next((item for item in validated if item[1].casefold() == str(parent).casefold()), None)
                if parent_entry is not None and not parent_entry[2]:
                    reject(f"archive path descends through a regular file: {canonical}")
                parent = parent.parent

        for info, canonical, directory in validated:
            target = destination.joinpath(*canonical.split("/"))
            resolved_parent = target.parent.resolve()
            destination_resolved = destination.resolve()
            if resolved_parent != destination_resolved and destination_resolved not in resolved_parent.parents:
                reject(f"resolved archive path escapes extraction root: {canonical}")
            if directory:
                target.mkdir(parents=True, exist_ok=True, mode=0o755)
                os.chmod(target, 0o755)
                continue
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
            with archive.open(info, "r") as source, target.open("xb") as output:
                copied = 0
                while True:
                    chunk = source.read(1024 * 1024)
                    if not chunk:
                        break
                    copied += len(chunk)
                    if copied > info.file_size or copied > max_file:
                        reject(f"archive entry expanded beyond its declared bound: {canonical}")
                    output.write(chunk)
                if copied != info.file_size:
                    reject(f"archive entry size mismatch: {canonical}")
            os.chmod(target, 0o755 if canonical in executables else 0o644)
except (OSError, ValueError, zipfile.BadZipFile, zipfile.LargeZipFile) as error:
    shutil.rmtree(destination, ignore_errors=True)
    raise SystemExit(f"pinned ZIP validation failed: {error}")
PY
