#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "must run inside the Oliphaunt git checkout" >&2
  exit 1
}
cd "$root"

fail() {
  echo "$1" >&2
  exit 1
}

proto_version() {
  local tool="$1"
  awk -F '=' -v tool="$tool" '
    $1 ~ "^[[:space:]]*" tool "[[:space:]]*$" {
      value=$2
      gsub(/^[[:space:]\"]+|[[:space:]\"]+$/, "", value)
      print value
      found=1
    }
    END { if (!found) exit 1 }
  ' .prototools
}

version="$(proto_version bun)"
if command -v bun >/dev/null 2>&1; then
  installed_version="$(bun --version 2>/dev/null || true)"
  if [[ "$installed_version" == "$version" ]]; then
    exec bun "$@"
  fi
fi

case "$(uname -s)" in
  Darwin)
    case "$(uname -m)" in
      arm64|aarch64) target="darwin-aarch64" ;;
      x86_64) target="darwin-x64" ;;
      *) fail "unsupported Bun host architecture: $(uname -m)" ;;
    esac
    exe_name="bun"
    ;;
  Linux)
    case "$(uname -m)" in
      arm64|aarch64) target="linux-aarch64" ;;
      x86_64) target="linux-x64" ;;
      *) fail "unsupported Bun host architecture: $(uname -m)" ;;
    esac
    exe_name="bun"
    ;;
  MINGW*|MSYS*|CYGWIN*)
    case "$(uname -m)" in
      x86_64|AMD64) target="windows-x64" ;;
      *) fail "unsupported Bun host architecture: $(uname -m)" ;;
    esac
    exe_name="bun.exe"
    ;;
  *)
    fail "unsupported Bun host operating system: $(uname -s)"
    ;;
esac

asset="bun-$target.zip"
install_dir="$root/target/oliphaunt-tools/bun/v$version/$target"
bun_bin="$install_dir/$exe_name"
if [[ ! -x "$bun_bin" ]]; then
  command -v curl >/dev/null 2>&1 || fail "missing required command: curl"
  command -v python3 >/dev/null 2>&1 || fail "missing required command: python3"
  mkdir -p "$install_dir"
  archive="$install_dir/bun.zip"
  url="https://github.com/oven-sh/bun/releases/download/bun-v$version/$asset"
  tmp_dir="$install_dir.tmp.$$"
  rm -rf "$tmp_dir"
  mkdir -p "$tmp_dir"
  curl --fail --location --retry 3 --retry-delay 2 --output "$archive" "$url"
  extracted_bin="$(python3 - "$archive" "$tmp_dir" "$exe_name" <<'PY'
import sys
import zipfile
from pathlib import Path

archive = Path(sys.argv[1])
target = Path(sys.argv[2])
exe_name = sys.argv[3]
with zipfile.ZipFile(archive) as zf:
    zf.extractall(target)
matches = [path for path in target.rglob(exe_name) if path.is_file()]
if len(matches) != 1:
    print(f"Bun archive must contain exactly one {exe_name}, found {len(matches)}", file=sys.stderr)
    for match in matches:
        print(match, file=sys.stderr)
    sys.exit(1)
print(matches[0])
PY
)"
  mv "$extracted_bin" "$bun_bin"
  chmod +x "$bun_bin"
  rm -rf "$tmp_dir" "$archive"
fi

exec "$bun_bin" "$@"
