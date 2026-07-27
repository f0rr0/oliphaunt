#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
installer="$root/tools/dev/install-pinned-js-runtime.sh"
extractor="$root/tools/dev/extract-pinned-zip.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT HUP INT TERM

# These are literal workflow expressions, not shell expansions.
# shellcheck disable=SC2016
for action in .github/actions/setup-bun/action.yml .github/actions/setup-deno/action.yml; do
  grep -Fq '[[ "${RUNNER_OS:-}" == "Windows" ]]' "$action"
  grep -Fq 'binary_dir="$(cygpath -w "$binary_dir")"' "$action"
  grep -Fq 'echo "$binary_dir" >> "$GITHUB_PATH"' "$action"
done

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

# macOS still ships Bash 3.2, whose command-substitution parser can terminate
# early on an inline case pattern. Keep platform selection out of nested case
# so a Linux Bash 5 syntax check cannot certify a script that macOS rejects.
"$python_bin" - "$installer" <<'PY'
import re
import sys
from pathlib import Path

source = Path(sys.argv[1]).read_text(encoding="utf-8")
if re.search(r"\$\(\s*case\b", source):
    raise SystemExit("pinned JS runtime installer must not nest case inside command substitution")
PY

mkdir -p "$tmp/fixtures" "$tmp/config" "$tmp/bin"
"$python_bin" - "$tmp" <<'PY'
import hashlib
import stat
import sys
import zipfile
from pathlib import Path

root = Path(sys.argv[1])
fixtures = root / "fixtures"
config = root / "config"

def archive(name, path, contents):
    target = fixtures / name
    info = zipfile.ZipInfo(path)
    info.external_attr = (stat.S_IFREG | 0o755) << 16
    info.compress_type = zipfile.ZIP_DEFLATED
    with zipfile.ZipFile(target, "w") as output:
        output.writestr(info, contents)
    return target, hashlib.sha256(contents).hexdigest(), hashlib.sha256(target.read_bytes()).hexdigest()

bun, bun_binary_sha, bun_archive_sha = archive(
    "bun.zip", "bun-linux-x64/bun", b"#!/bin/sh\nprintf '1.2.3\\n'\n"
)
bad_bun, bad_bun_binary_sha, bad_bun_archive_sha = archive(
    "bun-wrong-version.zip", "bun-linux-x64/bun", b"#!/bin/sh\nprintf '9.9.9\\n'\n"
)
deno, deno_binary_sha, deno_archive_sha = archive(
    "deno.zip", "deno", b"#!/bin/sh\nprintf 'deno 1.2.3 (stable, release, x86_64-unknown-linux-gnu)\\n'\n"
)

def bun_manifest(name, archive_sha, binary_sha):
    (config / name).write_text(f'''[toolchain]
version = "1.2.3"

[assets.linux-x64]
url = "https://github.com/oven-sh/bun/releases/download/bun-v1.2.3/bun-linux-x64.zip"
sha256 = "{archive_sha}"
binary_path = "bun-linux-x64/bun"
binary_sha256 = "{binary_sha}"
entry_count = "1"
''', encoding="utf-8")

bun_manifest("bun.toml", bun_archive_sha, bun_binary_sha)
bun_manifest("bun-bad-sha.toml", "0" * 64, bun_binary_sha)
bun_manifest("bun-wrong-version.toml", bad_bun_archive_sha, bad_bun_binary_sha)
(config / "bun-receipt").write_text(
    f"tool=bun\nversion=1.2.3\ntarget=linux-x64\narchive_sha256={bun_archive_sha}\nbinary_sha256={bun_binary_sha}\n",
    encoding="utf-8",
)
(config / "deno.toml").write_text(f'''[toolchain]
version = "1.2.3"

[assets.x86_64-unknown-linux-gnu]
url = "https://github.com/denoland/deno/releases/download/v1.2.3/deno-x86_64-unknown-linux-gnu.zip"
mirror_url = "https://dl.deno.land/release/v1.2.3/deno-x86_64-unknown-linux-gnu.zip"
sha256 = "{deno_archive_sha}"
binary_path = "deno"
binary_sha256 = "{deno_binary_sha}"
entry_count = "1"
''', encoding="utf-8")
(config / "deno-receipt").write_text(
    f"tool=deno\nversion=1.2.3\ntarget=x86_64-unknown-linux-gnu\narchive_sha256={deno_archive_sha}\nbinary_sha256={deno_binary_sha}\n",
    encoding="utf-8",
)
(config / "prototools").write_text('bun = "1.2.3"\ndeno = "1.2.3"\n', encoding="utf-8")
PY

"$python_bin" - "$tmp/bin/curl" <<'PY'
import os
import stat
import sys
from pathlib import Path

path = Path(sys.argv[1])
path.write_text(r'''#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$@" >> "$CURL_ARGS_LOG"
output=""
url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output)
      output="$2"
      shift 2
      ;;
    *)
      url="$1"
      shift
      ;;
  esac
done
[ -n "$output" ] && [ -n "$url" ]
printf '%s\n' "$url" >> "$CURL_LOG"
case "$CURL_MODE" in
  bun-good)
    cp "$BUN_ARCHIVE" "$output"
    ;;
  bun-wrong-version)
    cp "$BUN_WRONG_VERSION_ARCHIVE" "$output"
    ;;
  deno-mirror)
    case "$url" in
      https://github.com/*) cp "$BUN_ARCHIVE" "$output" ;;
      https://dl.deno.land/*) cp "$DENO_ARCHIVE" "$output" ;;
      *) exit 22 ;;
    esac
    ;;
  fail-all)
    exit 22
    ;;
  *)
    echo "unknown CURL_MODE=$CURL_MODE" >&2
    exit 2
    ;;
esac
''', encoding="utf-8")
path.chmod(stat.S_IRUSR | stat.S_IWUSR | stat.S_IXUSR)
PY

common_env=(
  "OLIPHAUNT_PINNED_TOOL_ROOT=$tmp"
  "OLIPHAUNT_PINNED_TOOL_PROTO_FILE=$tmp/config/prototools"
  "OLIPHAUNT_PINNED_ZIP_EXTRACTOR=$extractor"
  "OLIPHAUNT_PINNED_TOOL_CURL=$tmp/bin/curl"
  "OLIPHAUNT_PINNED_TOOL_TARGET=linux-x64"
  "BUN_ARCHIVE=$tmp/fixtures/bun.zip"
  "BUN_WRONG_VERSION_ARCHIVE=$tmp/fixtures/bun-wrong-version.zip"
  "DENO_ARCHIVE=$tmp/fixtures/deno.zip"
  "CURL_LOG=$tmp/curl.log"
  "CURL_ARGS_LOG=$tmp/curl-args.log"
)

run_bun() {
  env "${common_env[@]}" \
    "OLIPHAUNT_BUN_TOOLCHAIN_MANIFEST=${BUN_MANIFEST:-$tmp/config/bun.toml}" \
    "OLIPHAUNT_PINNED_TOOL_CACHE_ROOT=${CACHE_ROOT:-$tmp/cache}" \
    "CURL_MODE=${CURL_MODE:-bun-good}" \
    "RUNNER_OS=${CASE_RUNNER_OS:-Linux}" \
    "$installer" bun --expected-version "${EXPECTED_VERSION:-1.2.3}"
}

portable_mode() {
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*|Windows_NT) return 1 ;;
  esac
  if stat -c '%a' "$1" >/dev/null 2>&1; then
    stat -c '%a' "$1"
  elif stat -f '%Lp' "$1" >/dev/null 2>&1; then
    stat -f '%Lp' "$1"
  else
    return 1
  fi
}

assert_envelope() {
  local binary="$1"
  local expected_receipt="$2"
  local final
  final="$(dirname "$(dirname "$binary")")"
  [ -d "$final" ] && [ ! -L "$final" ]
  [ "$(find "$final" -mindepth 1 -maxdepth 1 | wc -l | tr -d '[:space:]')" = "2" ]
  [ -d "$final/bin" ] && [ ! -L "$final/bin" ]
  [ "$(find "$final/bin" -mindepth 1 -maxdepth 1 | wc -l | tr -d '[:space:]')" = "1" ]
  [ -f "$binary" ] && [ ! -L "$binary" ]
  [ -f "$final/receipt" ] && [ ! -L "$final/receipt" ]
  cmp -s "$final/receipt" "$expected_receipt"
  if portable_mode "$final" >/dev/null 2>&1; then
    [ "$(portable_mode "$final")" = "700" ]
    [ "$(portable_mode "$final/bin")" = "700" ]
    [ "$(portable_mode "$binary")" = "555" ]
    [ "$(portable_mode "$final/receipt")" = "444" ]
  fi
}

repair_bun() {
  local repaired
  : > "$tmp/curl.log"
  repaired="$(run_bun)"
  assert_envelope "$repaired" "$tmp/config/bun-receipt"
  [ "$(wc -l < "$tmp/curl.log" | tr -d ' ')" = "1" ]
  printf '%s\n' "$repaired"
}

: > "$tmp/curl.log"
: > "$tmp/curl-args.log"
bun_binary="$(run_bun)"
[ -x "$bun_binary" ]
[ "$("$bun_binary" --version)" = "1.2.3" ]
[ "$(wc -l < "$tmp/curl.log" | tr -d ' ')" = "1" ]
assert_envelope "$bun_binary" "$tmp/config/bun-receipt"
if grep -Fx -- '--ssl-revoke-best-effort' "$tmp/curl-args.log" >/dev/null; then
  echo "Linux Bun transport unexpectedly used the Windows Schannel flag" >&2
  exit 1
fi

# Windows keeps certificate and hostname validation while tolerating only an
# unavailable Schannel revocation distribution point.
: > "$tmp/curl.log"
: > "$tmp/curl-args.log"
CASE_RUNNER_OS=Windows
CACHE_ROOT="$tmp/cache-windows"
bun_binary_windows="$(run_bun)"
unset CASE_RUNNER_OS CACHE_ROOT
[ -x "$bun_binary_windows" ]
grep -Fx -- '--ssl-revoke-best-effort' "$tmp/curl-args.log" >/dev/null
if grep -E -x -- '--insecure|-k' "$tmp/curl-args.log" >/dev/null; then
  echo "Windows Bun transport disabled TLS validation" >&2
  exit 1
fi

# A valid local is authoritative for the pin and must not touch the network.
: > "$tmp/curl.log"
bun_binary_again="$(CURL_MODE=fail-all run_bun)"
[ "$bun_binary_again" = "$bun_binary" ]
[ ! -s "$tmp/curl.log" ]
assert_envelope "$bun_binary_again" "$tmp/config/bun-receipt"

# A digest-corrupt cache entry is never trusted and is repaired from verified bytes.
chmod 0755 "$bun_binary"
printf 'corrupt\n' > "$bun_binary"
: > "$tmp/curl.log"
bun_binary="$(run_bun)"
[ "$("$bun_binary" --version)" = "1.2.3" ]
[ "$(wc -l < "$tmp/curl.log" | tr -d ' ')" = "1" ]
assert_envelope "$bun_binary" "$tmp/config/bun-receipt"

bun_final="$(dirname "$(dirname "$bun_binary")")"

# A second executable beside the pin invalidates the bin envelope.
printf '%s\n' '#!/bin/sh' 'exit 0' > "$bun_final/bin/injected"
chmod 0555 "$bun_final/bin/injected"
bun_binary="$(repair_bun)"
[ ! -e "$bun_final/bin/injected" ]

# An unexpected root-level file cannot hide beside the immutable receipt.
printf 'injected\n' > "$bun_final/injected"
bun_binary="$(repair_bun)"
[ ! -e "$bun_final/injected" ]

# Receipt contents, presence, and portable immutability mode are all part of the pin.
chmod 0644 "$bun_final/receipt"
printf 'corrupt-receipt\n' > "$bun_final/receipt"
chmod 0444 "$bun_final/receipt"
bun_binary="$(repair_bun)"

chmod 0644 "$bun_final/receipt"
printf '\n' >> "$bun_final/receipt"
chmod 0444 "$bun_final/receipt"
bun_binary="$(repair_bun)"

rm -f "$bun_final/receipt"
bun_binary="$(repair_bun)"

if portable_mode "$bun_final/receipt" >/dev/null 2>&1; then
  chmod 0644 "$bun_final/receipt"
  bun_binary="$(repair_bun)"
fi

# Symlink files and directories are rejected without touching their targets.
# Git Bash cannot always create native symlinks, so exercise these cases on
# every host where the filesystem exposes real symbolic-link semantics.
mkdir -p "$tmp/symlink-capability-target"
symlink_supported=0
if ln -s "$tmp/symlink-capability-target" "$tmp/symlink-capability-link" 2>/dev/null &&
  [ -L "$tmp/symlink-capability-link" ]; then
  symlink_supported=1
fi
rm -rf "$tmp/symlink-capability-link" "$tmp/symlink-capability-target"
if [ "$symlink_supported" = "1" ]; then
  printf 'receipt-target\n' > "$tmp/receipt-target"
  rm -f "$bun_final/receipt"
  ln -s "$tmp/receipt-target" "$bun_final/receipt"
  bun_binary="$(repair_bun)"
  grep -qx receipt-target "$tmp/receipt-target"

  mkdir -p "$tmp/bin-target"
  printf 'bin-target\n' > "$tmp/bin-target/marker"
  rm -rf "${bun_final:?}/bin"
  ln -s "$tmp/bin-target" "$bun_final/bin"
  bun_binary="$(repair_bun)"
  grep -qx bin-target "$tmp/bin-target/marker"

  mkdir -p "$tmp/final-target"
  printf 'final-target\n' > "$tmp/final-target/marker"
  rm -rf "${bun_final:?}"
  ln -s "$tmp/final-target" "$bun_final"
  bun_binary="$(repair_bun)"
  grep -qx final-target "$tmp/final-target/marker"
  [ ! -L "$bun_final" ]

  # A symbolic-link cache root fails closed rather than writing through the link.
  mkdir -p "$tmp/cache-root-target"
  ln -s "$tmp/cache-root-target" "$tmp/cache-root-link"
  if CACHE_ROOT="$tmp/cache-root-link" run_bun >"$tmp/cache-root-link.out" 2>"$tmp/cache-root-link.err"; then
    echo "expected symbolic-link cache root to fail" >&2
    exit 1
  fi
  [ -z "$(find "$tmp/cache-root-target" -mindepth 1 -print -quit)" ]
  grep -q 'cache root must not be a symbolic link' "$tmp/cache-root-link.err"
fi

# Bad checksums fail closed and never promote a final cache directory.
if BUN_MANIFEST="$tmp/config/bun-bad-sha.toml" CACHE_ROOT="$tmp/cache-bad-sha" run_bun >"$tmp/bad-sha.out" 2>"$tmp/bad-sha.err"; then
  echo "expected bad Bun checksum to fail" >&2
  exit 1
fi
[ ! -e "$tmp/cache-bad-sha/bun/v1.2.3/linux-x64" ]

# Even checksum-valid bytes are rejected when the executable reports another version.
if BUN_MANIFEST="$tmp/config/bun-wrong-version.toml" CACHE_ROOT="$tmp/cache-wrong-version" CURL_MODE=bun-wrong-version \
  run_bun >"$tmp/wrong-version.out" 2>"$tmp/wrong-version.err"; then
  echo "expected wrong Bun executable version to fail" >&2
  exit 1
fi
[ ! -e "$tmp/cache-wrong-version/bun/v1.2.3/linux-x64" ]

# Deno's independently pinned official mirror is used after primary transport failure.
: > "$tmp/curl.log"
deno_binary="$(env "${common_env[@]}" \
  "OLIPHAUNT_DENO_TOOLCHAIN_MANIFEST=$tmp/config/deno.toml" \
  "OLIPHAUNT_PINNED_TOOL_TARGET=x86_64-unknown-linux-gnu" \
  "OLIPHAUNT_PINNED_TOOL_CACHE_ROOT=$tmp/cache-deno" \
  CURL_MODE=deno-mirror \
  "$installer" deno --expected-version v1.2.3)"
[ -x "$deno_binary" ]
"$deno_binary" --version | grep -q '^deno 1\.2\.3 '
assert_envelope "$deno_binary" "$tmp/config/deno-receipt"
grep -q '^https://github.com/denoland/deno/' "$tmp/curl.log"
grep -q '^https://dl.deno.land/release/' "$tmp/curl.log"

# Deno also accepts its exact verified cache envelope without network access.
: > "$tmp/curl.log"
deno_binary_again="$(env "${common_env[@]}" \
  "OLIPHAUNT_DENO_TOOLCHAIN_MANIFEST=$tmp/config/deno.toml" \
  "OLIPHAUNT_PINNED_TOOL_TARGET=x86_64-unknown-linux-gnu" \
  "OLIPHAUNT_PINNED_TOOL_CACHE_ROOT=$tmp/cache-deno" \
  CURL_MODE=fail-all \
  "$installer" deno --expected-version v1.2.3)"
[ "$deno_binary_again" = "$deno_binary" ]
[ ! -s "$tmp/curl.log" ]
assert_envelope "$deno_binary_again" "$tmp/config/deno-receipt"

# An interruption after moving an invalid old cache restores that exact old state.
interrupt_final="$tmp/cache-interrupt/bun/v1.2.3/linux-x64"
mkdir -p "$interrupt_final/bin"
printf '%s\n' '#!/bin/sh' "printf '%s\\n' old-state" > "$interrupt_final/bin/bun"
chmod +x "$interrupt_final/bin/bun"
printf 'preserve-me\n' > "$interrupt_final/marker"
if OLIPHAUNT_PINNED_TOOL_TESTING=1 OLIPHAUNT_PINNED_TOOL_TEST_INTERRUPT_AFTER_BACKUP=1 \
  CACHE_ROOT="$tmp/cache-interrupt" run_bun >"$tmp/interrupt.out" 2>"$tmp/interrupt.err"; then
  echo "expected injected installer interruption" >&2
  exit 1
fi
[ "$("$interrupt_final/bin/bun")" = "old-state" ]
grep -qx preserve-me "$interrupt_final/marker"
if find "$tmp/cache-interrupt/bun/v1.2.3" -maxdepth 1 \
  \( -name '.linux-x64.stage.*' -o -name '.linux-x64.backup.*' -o -name '.linux-x64.archive.*' \) \
  -print -quit | grep -q .; then
  echo "interrupted installer left private staging state" >&2
  exit 1
fi

# A later complete run replaces the restored invalid state in one promotion.
: > "$tmp/curl.log"
interrupt_binary="$(CACHE_ROOT="$tmp/cache-interrupt" run_bun)"
assert_envelope "$interrupt_binary" "$tmp/config/bun-receipt"
[ "$(wc -l < "$tmp/curl.log" | tr -d ' ')" = "1" ]
[ ! -e "$interrupt_final/marker" ]

echo "pinned Bun/Deno installer fault tests passed"
