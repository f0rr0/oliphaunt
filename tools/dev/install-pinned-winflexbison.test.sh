#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
installer="$root/tools/dev/install-pinned-winflexbison.sh"
extractor="$root/tools/dev/extract-pinned-zip.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
mkdir -p "$tmp/fixtures" "$tmp/config" "$tmp/bin"

python_bin=""
for candidate in python3 python; do
  if command -v "$candidate" >/dev/null 2>&1 &&
    "$candidate" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 8) else 1)'; then
    python_bin="$candidate"
    break
  fi
done
[ -n "$python_bin" ] || { echo "Python 3.8 or newer is required" >&2; exit 1; }

"$python_bin" - "$tmp" <<'PY'
import hashlib
import stat
import sys
import zipfile
from pathlib import Path

root = Path(sys.argv[1])
files = {
    "win_flex.exe": b"fixture-flex\n",
    "win_bison.exe": b"fixture-bison\n",
    "data/README.md": b"fixture-data\n",
}
archive = root / "fixtures" / "winflex.zip"
with zipfile.ZipFile(archive, "w") as output:
    for name, contents in files.items():
        info = zipfile.ZipInfo(name)
        info.external_attr = (stat.S_IFREG | (0o755 if name.endswith(".exe") else 0o644)) << 16
        info.compress_type = zipfile.ZIP_DEFLATED
        output.writestr(info, contents)
tree = hashlib.sha256()
for name, contents in sorted(files.items(), key=lambda item: item[0].encode("utf-8")):
    digest = hashlib.sha256(contents).hexdigest()
    tree.update(f"{name}\0{len(contents)}\0{digest}\n".encode("utf-8"))
values = {
    "archive_sha": hashlib.sha256(archive.read_bytes()).hexdigest(),
    "archive_bytes": archive.stat().st_size,
    "expanded_bytes": sum(map(len, files.values())),
    "tree_sha": tree.hexdigest(),
    "flex_sha": hashlib.sha256(files["win_flex.exe"]).hexdigest(),
    "bison_sha": hashlib.sha256(files["win_bison.exe"]).hexdigest(),
}
manifest = f'''[toolchain]
version = "1.2.3"
repository = "lexxmark/winflexbison"

[assets.windows-x64]
url = "https://github.com/lexxmark/winflexbison/releases/download/v1.2.3/win_flex_bison-1.2.3.zip"
sha256 = "{values['archive_sha']}"
bytes = "{values['archive_bytes']}"
entry_count = "3"
file_count = "3"
expanded_bytes = "{values['expanded_bytes']}"
tree_sha256 = "{values['tree_sha']}"
flex_path = "win_flex.exe"
flex_sha256 = "{values['flex_sha']}"
bison_path = "win_bison.exe"
bison_sha256 = "{values['bison_sha']}"
'''
(root / "config" / "winflexbison.toml").write_text(manifest, encoding="utf-8")
(root / "config" / "bad-sha.toml").write_text(
    manifest.replace(values["archive_sha"], "0" * 64), encoding="utf-8"
)
(root / "config" / "bad-tree.toml").write_text(
    manifest.replace(values["tree_sha"], "0" * 64), encoding="utf-8"
)
(root / "config" / "bad-url.toml").write_text(
    manifest.replace("https://github.com/lexxmark/winflexbison/", "https://example.invalid/"),
    encoding="utf-8",
)
PY

cat >"$tmp/bin/curl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$@" >>"$CURL_ARGS_LOG"
output=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output) output="$2"; shift 2 ;;
    *) shift ;;
  esac
done
[ -n "$output" ]
case "$CURL_MODE" in
  good) cp "$WINFLEX_ARCHIVE" "$output" ;;
  fail) exit 22 ;;
  *) exit 2 ;;
esac
SH
chmod +x "$tmp/bin/curl"

run_installer() {
  env \
    "OLIPHAUNT_PINNED_TOOL_ROOT=$root" \
    "OLIPHAUNT_WINFLEXBISON_MANIFEST=${MANIFEST:-$tmp/config/winflexbison.toml}" \
    "OLIPHAUNT_PINNED_ZIP_EXTRACTOR=$extractor" \
    "OLIPHAUNT_PINNED_NATIVE_TOOL_CACHE_ROOT=${CACHE_ROOT:-$tmp/cache}" \
    "OLIPHAUNT_WINFLEXBISON_CURL=$tmp/bin/curl" \
    "OLIPHAUNT_WINFLEXBISON_PYTHON=$python_bin" \
    "WINFLEX_ARCHIVE=$tmp/fixtures/winflex.zip" \
    "CURL_ARGS_LOG=$tmp/curl-args.log" \
    "CURL_MODE=${CURL_MODE:-good}" \
    "OLIPHAUNT_WINFLEXBISON_TESTING=${TESTING:-0}" \
    "OLIPHAUNT_WINFLEXBISON_TEST_INTERRUPT_AFTER_BACKUP=${INTERRUPT:-0}" \
    "$installer"
}

payload="$(run_installer)"
[ -x "$payload/win_flex.exe" ]
[ -x "$payload/win_bison.exe" ]
[ -f "$payload/data/README.md" ]
grep -Fxq -- "--retry-all-errors" "$tmp/curl-args.log"
grep -Fxq -- "=https" "$tmp/curl-args.log"

# A complete verified cache is network-independent.
: >"$tmp/curl-args.log"
cached="$(CURL_MODE=fail run_installer)"
[ "$cached" = "$payload" ]
[ ! -s "$tmp/curl-args.log" ]

# Payload corruption is detected across the complete extracted tree and repaired.
printf 'tampered\n' >"$payload/data/README.md"
repaired="$(run_installer)"
[ "$repaired" = "$payload" ]
grep -Fxq 'fixture-data' "$payload/data/README.md"

# Archive and extracted-tree pin drift fail before promotion.
if MANIFEST="$tmp/config/bad-sha.toml" CACHE_ROOT="$tmp/bad-sha-cache" run_installer >/dev/null 2>&1; then
  echo "bad archive checksum unexpectedly succeeded" >&2
  exit 1
fi
[ ! -e "$tmp/bad-sha-cache/winflexbison/v1.2.3/windows-x64" ]
if MANIFEST="$tmp/config/bad-tree.toml" CACHE_ROOT="$tmp/bad-tree-cache" run_installer >/dev/null 2>&1; then
  echo "bad payload tree unexpectedly succeeded" >&2
  exit 1
fi
[ ! -e "$tmp/bad-tree-cache/winflexbison/v1.2.3/windows-x64" ]
if MANIFEST="$tmp/config/bad-url.toml" CACHE_ROOT="$tmp/bad-url-cache" run_installer >/dev/null 2>&1; then
  echo "noncanonical upstream URL unexpectedly succeeded" >&2
  exit 1
fi
[ ! -e "$tmp/bad-url-cache/winflexbison/v1.2.3/windows-x64" ]

# Transport failure preserves an existing invalid cache, while interrupted
# promotion restores it byte-for-byte instead of leaving a missing destination.
printf 'old-invalid\n' >"$payload/win_flex.exe"
if CURL_MODE=fail run_installer >/dev/null 2>&1; then
  echo "failed transport unexpectedly repaired the cache" >&2
  exit 1
fi
grep -Fxq 'old-invalid' "$payload/win_flex.exe"
if TESTING=1 INTERRUPT=1 run_installer >/dev/null 2>&1; then
  echo "interrupted promotion unexpectedly succeeded" >&2
  exit 1
fi
grep -Fxq 'old-invalid' "$payload/win_flex.exe"
final="$(run_installer)"
grep -Fxq 'fixture-flex' "$final/win_flex.exe"

# A symbolic-link cache root is rejected before any download or write-through.
mkdir -p "$tmp/cache-target"
ln -s "$tmp/cache-target" "$tmp/cache-link"
if CACHE_ROOT="$tmp/cache-link" run_installer >/dev/null 2>&1; then
  echo "symbolic-link cache root unexpectedly succeeded" >&2
  exit 1
fi
[ -z "$(find "$tmp/cache-target" -mindepth 1 -print -quit)" ]
