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

version="$(proto_version deno)"
if command -v deno >/dev/null 2>&1; then
  installed_version="$(deno --version 2>/dev/null | awk 'NR == 1 { print $2 }')"
  if [[ "$installed_version" == "$version" ]]; then
    exec deno "$@"
  fi
fi

case "$(uname -s)" in
  Darwin)
    case "$(uname -m)" in
      arm64|aarch64) target="aarch64-apple-darwin" ;;
      x86_64) target="x86_64-apple-darwin" ;;
      *) fail "unsupported Deno host architecture: $(uname -m)" ;;
    esac
    exe_name="deno"
    ;;
  Linux)
    case "$(uname -m)" in
      arm64|aarch64) target="aarch64-unknown-linux-gnu" ;;
      x86_64) target="x86_64-unknown-linux-gnu" ;;
      *) fail "unsupported Deno host architecture: $(uname -m)" ;;
    esac
    exe_name="deno"
    ;;
  MINGW*|MSYS*|CYGWIN*)
    case "$(uname -m)" in
      x86_64|AMD64) target="x86_64-pc-windows-msvc" ;;
      *) fail "unsupported Deno host architecture: $(uname -m)" ;;
    esac
    exe_name="deno.exe"
    ;;
  *)
    fail "unsupported Deno host operating system: $(uname -s)"
    ;;
esac

install_dir="$root/target/oliphaunt-tools/deno/v$version/$target"
deno_bin="$install_dir/$exe_name"
if [[ ! -x "$deno_bin" ]]; then
  command -v curl >/dev/null 2>&1 || fail "missing required command: curl"
  command -v python3 >/dev/null 2>&1 || fail "missing required command: python3"
  mkdir -p "$install_dir"
  url="https://github.com/denoland/deno/releases/download/v$version/deno-$target.zip"
  tmp_dir="$install_dir.tmp.$$"
  rm -rf "$tmp_dir"
  mkdir -p "$tmp_dir"
  archive="$tmp_dir/deno.zip"
  curl \
    --fail \
    --location \
    --retry 8 \
    --retry-all-errors \
    --retry-delay 5 \
    --connect-timeout 20 \
    --output "$archive" \
    "$url"
  python3 - "$archive" "$tmp_dir" <<'PY'
import sys
import zipfile
from pathlib import Path

archive = Path(sys.argv[1])
target = Path(sys.argv[2])
with zipfile.ZipFile(archive) as zf:
    zf.extractall(target)
PY
  if [[ ! -f "$tmp_dir/$exe_name" ]]; then
    rm -rf "$tmp_dir"
    fail "Deno archive did not contain $exe_name: $url"
  fi
  mv "$tmp_dir/$exe_name" "$deno_bin"
  chmod +x "$deno_bin"
  rm -rf "$tmp_dir"
fi

exec "$deno_bin" "$@"
