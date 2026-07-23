#!/usr/bin/env bash
set -euo pipefail

export LC_ALL=C

fail() {
  echo "install-pinned-wasixcc: $*" >&2
  exit 1
}

usage() {
  cat >&2 <<'USAGE'
usage: install-pinned-wasixcc.sh --manifest PATH --install-root ABSOLUTE_PATH

Downloads the closed Oliphaunt WASIX compiler asset set, verifies every size
and SHA-256 digest, validates archive layouts, smoke-compiles with the staged
toolchain, and atomically promotes the complete installation.
USAGE
  exit "${1:-2}"
}

manifest=""
install_root=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --manifest)
      [ "$#" -ge 2 ] || usage
      manifest="$2"
      shift 2
      ;;
    --install-root)
      [ "$#" -ge 2 ] || usage
      install_root="$2"
      shift 2
      ;;
    --help | -h)
      usage 0
      ;;
    *)
      usage
      ;;
  esac
done

[ -f "$manifest" ] || fail "asset manifest is missing: ${manifest:-<unset>}"
case "$install_root" in
  /*) ;;
  *) fail "--install-root must be an absolute path" ;;
esac
[ "$install_root" != "/" ] || fail "refusing to install over /"
if [ -e "$install_root" ] || [ -L "$install_root" ]; then
  fail "install root already exists; refusing a non-atomic replacement: $install_root"
fi

for command_name in awk basename cp curl dirname find grep install mktemp mv od python3 readlink sha256sum sort tar wc; do
  command -v "$command_name" >/dev/null 2>&1 || fail "missing required command: $command_name"
done

install_parent="$(dirname "$install_root")"
install -d -m 0755 "$install_parent"
work_root="$(mktemp -d "$install_parent/.wasixcc-install.XXXXXX")"
candidate_root="$work_root/candidate"
download_root="$work_root/downloads"
extract_root="$work_root/extracted"
install -d -m 0755 "$candidate_root" "$download_root" "$extract_root"

cleanup() {
  rm -rf "$work_root"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

validate_archive_members() {
  local archive="$1"
  local asset_name="$2"

  if ! python3 - "$archive" "$asset_name" <<'PY'
import posixpath
import sys
import tarfile

archive_path = sys.argv[1]
asset_name = sys.argv[2]
max_members = 200_000
max_member_bytes = 2_000_000_000
max_expanded_bytes = 4_000_000_000


def safe_name(value: str, label: str) -> str:
    if not value or "\\" in value or "\x00" in value or any(ord(char) < 32 or ord(char) == 127 for char in value):
        raise ValueError(f"{label} contains invalid characters: {value!r}")
    if value.startswith("/"):
        raise ValueError(f"{label} is absolute: {value!r}")
    trimmed = value[:-1] if value.endswith("/") else value
    parts = trimmed.split("/")
    if not trimmed or any(part in {"", ".", ".."} for part in parts):
        raise ValueError(f"{label} is unsafe: {value!r}")
    return trimmed


try:
    with tarfile.open(archive_path, mode="r:gz") as archive:
        members = archive.getmembers()
        if not members:
            raise ValueError("archive is empty")
        if len(members) > max_members:
            raise ValueError(f"archive has too many members: {len(members)}")

        seen = {}
        links = []
        expanded_bytes = 0
        for member in members:
            name = safe_name(member.name, "archive member")
            if name in seen:
                raise ValueError(f"duplicate archive member: {name!r}")
            seen[name] = member

            if member.isdir():
                continue
            if member.isreg():
                if member.size < 0 or member.size > max_member_bytes:
                    raise ValueError(f"archive member has invalid size: {name!r} ({member.size})")
                expanded_bytes += member.size
                if expanded_bytes > max_expanded_bytes:
                    raise ValueError(f"archive expands beyond {max_expanded_bytes} bytes")
                continue
            if member.issym() or member.islnk():
                safe_name(member.linkname, f"link target for {name}")
                links.append((name, member.linkname, member.issym()))
                continue
            raise ValueError(f"unsupported archive member type for {name!r}")

        for name, linkname, symbolic in links:
            if symbolic:
                target = posixpath.normpath(posixpath.join(posixpath.dirname(name), linkname))
            else:
                target = posixpath.normpath(linkname)
            if target == ".." or target.startswith("../") or target.startswith("/"):
                raise ValueError(f"link escapes archive root: {name!r} -> {linkname!r}")
            if target not in seen:
                raise ValueError(f"link target is absent from archive: {name!r} -> {linkname!r}")
except (OSError, tarfile.TarError, ValueError) as error:
    raise SystemExit(f"{asset_name} failed safe archive validation: {error}")
PY
  then
    fail "$asset_name failed archive safety validation"
  fi
}

validate_extracted_links() {
  local root="$1"
  local asset_name="$2"
  local link
  local resolved

  while IFS= read -r -d '' link; do
    resolved="$(readlink -f -- "$link")" || fail "$asset_name contains a dangling symbolic link: $link"
    case "$resolved" in
      "$root" | "$root"/*) ;;
      *) fail "$asset_name contains a symbolic link escaping its extraction root: $link -> $resolved" ;;
    esac
  done < <(find "$root" -type l -print0)
}

extract_verified_archive() {
  local archive="$1"
  local asset_name="$2"
  local destination="$extract_root/$asset_name"

  validate_archive_members "$archive" "$asset_name"
  install -d -m 0755 "$destination"
  tar \
    --extract \
    --gzip \
    --no-same-owner \
    --no-same-permissions \
    --file "$archive" \
    --directory "$destination"
  validate_extracted_links "$destination" "$asset_name"
  printf '%s\n' "$destination"
}

require_only_top_level() {
  local root="$1"
  shift
  local actual
  local expected

  actual="$(find "$root" -mindepth 1 -maxdepth 1 -printf '%f\n' | sort)"
  expected="$(printf '%s\n' "$@" | sort)"
  [ "$actual" = "$expected" ] ||
    fail "unexpected archive top-level layout under $root: expected [$expected], got [$actual]"
}

install_driver() {
  local extracted="$1"
  require_only_top_level "$extracted" wasixccenv
  if [ ! -f "$extracted/wasixccenv" ] || [ -L "$extracted/wasixccenv" ]; then
    fail "wasixcc driver archive did not contain a regular wasixccenv executable"
  fi
  install -m 0755 "$extracted/wasixccenv" "$candidate_root/wasixccenv"
}

install_sysroot() {
  local extracted="$1"
  local asset_name="$2"
  local destination_name="${asset_name%.tar.gz}"
  local upstream_root="wasix-$destination_name"
  local source="$extracted/$upstream_root/sysroot"

  require_only_top_level "$extracted" "$upstream_root"
  [ -d "$source/include" ] || fail "$asset_name is missing its include directory"
  [ -f "$source/include/stdio.h" ] || fail "$asset_name is missing include/stdio.h"
  [ -f "$source/lib/wasm32-wasi/libc.a" ] || fail "$asset_name is missing lib/wasm32-wasi/libc.a"
  install -d -m 0755 "$candidate_root/sysroot"
  mv "$source" "$candidate_root/sysroot/$destination_name"
}

install_llvm() {
  local extracted="$1"
  require_only_top_level "$extracted" bin lib
  for executable in clang clang++ clang-21 llvm-ar llvm-nm llvm-ranlib wasm-ld; do
    [ -e "$extracted/bin/$executable" ] || fail "LLVM archive is missing bin/$executable"
  done
  mv "$extracted" "$candidate_root/llvm"
  find "$candidate_root/llvm/bin" -maxdepth 1 -type f -exec chmod a+x {} +
}

install_binaryen() {
  local extracted="$1"
  local upstream_root="binaryen-version_130"
  require_only_top_level "$extracted" "$upstream_root"
  [ -f "$extracted/$upstream_root/bin/wasm-opt" ] || fail "Binaryen archive is missing bin/wasm-opt"
  mv "$extracted/$upstream_root" "$candidate_root/binaryen"
  find "$candidate_root/binaryen/bin" -maxdepth 1 -type f -exec chmod a+x {} +
}

declare -A seen_assets=()
asset_count=0
while IFS=$'\t' read -r kind asset_name expected_bytes expected_sha256 url extra || [ -n "${kind:-}" ]; do
  case "${kind:-}" in
    "" | \#*) continue ;;
  esac
  [ -z "${extra:-}" ] || fail "asset manifest row for $asset_name has too many fields"
  case "$asset_name" in
    *[!A-Za-z0-9._-]* | "") fail "invalid asset name: $asset_name" ;;
  esac
  case "$expected_bytes" in
    *[!0-9]* | "") fail "$asset_name has an invalid byte count: $expected_bytes" ;;
  esac
  if [ "$expected_bytes" -le 0 ] || [ "$expected_bytes" -gt 500000000 ]; then
    fail "$asset_name byte count is outside the allowed range: $expected_bytes"
  fi
  [[ "$expected_sha256" =~ ^[0-9a-f]{64}$ ]] || fail "$asset_name has an invalid SHA-256 digest"
  [ "$(basename "$url")" = "$asset_name" ] || fail "$asset_name URL basename does not match its asset name"

  case "$kind:$asset_name:$url" in
    driver:wasixcc-x86_64-unknown-linux-gnu.tar.gz:https://github.com/wasix-org/wasixcc/releases/download/v0.4.3/wasixcc-x86_64-unknown-linux-gnu.tar.gz | \
      sysroot:sysroot.tar.gz:https://github.com/wasix-org/wasix-libc/releases/download/v2026-03-02.1/sysroot.tar.gz | \
      sysroot:sysroot-eh.tar.gz:https://github.com/wasix-org/wasix-libc/releases/download/v2026-03-02.1/sysroot-eh.tar.gz | \
      sysroot:sysroot-ehpic.tar.gz:https://github.com/wasix-org/wasix-libc/releases/download/v2026-03-02.1/sysroot-ehpic.tar.gz | \
      sysroot:sysroot-exnref-eh.tar.gz:https://github.com/wasix-org/wasix-libc/releases/download/v2026-03-02.1/sysroot-exnref-eh.tar.gz | \
      sysroot:sysroot-exnref-ehpic.tar.gz:https://github.com/wasix-org/wasix-libc/releases/download/v2026-03-02.1/sysroot-exnref-ehpic.tar.gz | \
      llvm:LLVM-Linux-x86_64.tar.gz:https://github.com/wasix-org/llvm-project/releases/download/21.1.204/LLVM-Linux-x86_64.tar.gz | \
      binaryen:binaryen-version_130-x86_64-linux.tar.gz:https://github.com/WebAssembly/binaryen/releases/download/version_130/binaryen-version_130-x86_64-linux.tar.gz)
      ;;
    *) fail "asset manifest contains an unapproved kind/name/URL tuple: $kind / $asset_name / $url" ;;
  esac
  [ -z "${seen_assets[$asset_name]:-}" ] || fail "asset manifest repeats $asset_name"
  seen_assets[$asset_name]=1
  asset_count=$((asset_count + 1))

  partial="$download_root/$asset_name.partial"
  archive="$download_root/$asset_name"
  rm -f "$partial" "$archive"
  curl \
    --fail \
    --location \
    --silent \
    --show-error \
    --retry 8 \
    --retry-all-errors \
    --retry-delay 5 \
    --retry-max-time 900 \
    --connect-timeout 20 \
    --max-time 900 \
    --speed-limit 1024 \
    --speed-time 120 \
    --max-filesize "$expected_bytes" \
    --proto '=https' \
    --proto-redir '=https' \
    --tlsv1.2 \
    --remove-on-error \
    --output "$partial" \
    "$url"

  actual_bytes="$(wc -c <"$partial" | awk '{print $1}')"
  [ "$actual_bytes" = "$expected_bytes" ] ||
    fail "$asset_name size mismatch: expected $expected_bytes bytes, got $actual_bytes"
  actual_sha256="$(sha256sum "$partial" | awk '{print tolower($1)}')"
  [ "$actual_sha256" = "$expected_sha256" ] ||
    fail "$asset_name checksum mismatch: expected $expected_sha256, got $actual_sha256"
  mv "$partial" "$archive"

  extracted="$(extract_verified_archive "$archive" "$asset_name")"
  case "$kind" in
    driver) install_driver "$extracted" ;;
    sysroot) install_sysroot "$extracted" "$asset_name" ;;
    llvm) install_llvm "$extracted" ;;
    binaryen) install_binaryen "$extracted" ;;
    *) fail "unsupported asset kind after validation: $kind" ;;
  esac
done <"$manifest"

[ "$asset_count" -eq 8 ] || fail "asset manifest must contain exactly 8 assets, got $asset_count"
for required_asset in \
  wasixcc-x86_64-unknown-linux-gnu.tar.gz \
  sysroot.tar.gz \
  sysroot-eh.tar.gz \
  sysroot-ehpic.tar.gz \
  sysroot-exnref-eh.tar.gz \
  sysroot-exnref-ehpic.tar.gz \
  LLVM-Linux-x86_64.tar.gz \
  binaryen-version_130-x86_64-linux.tar.gz; do
  [ "${seen_assets[$required_asset]:-}" = "1" ] || fail "asset manifest is missing $required_asset"
done

install -d -m 0755 "$candidate_root/bin"
for command_name in wasixcc wasix++ wasixcc++ wasixar wasixnm wasixranlib wasixld wasixccenv; do
  ln -s ../wasixccenv "$candidate_root/bin/$command_name"
done

install -m 0644 "$manifest" "$candidate_root/.oliphaunt-toolchain-assets.tsv"
manifest_sha256="$(sha256sum "$manifest" | awk '{print tolower($1)}')"
printf '%s  %s\n' "$manifest_sha256" .oliphaunt-toolchain-assets.tsv \
  >"$candidate_root/.oliphaunt-toolchain-assets.sha256"

driver_version="$("$candidate_root/wasixccenv" --version 2>/dev/null || true)"
[ "$driver_version" = "wasixcc 0.4.3" ] ||
  fail "wasixcc driver version mismatch: expected 'wasixcc 0.4.3', got '${driver_version:-<missing>}'"
compiler_version="$(
  WASIXCC_LLVM_LOCATION="$candidate_root/llvm" \
    "$candidate_root/bin/wasixcc" --version 2>/dev/null || true
)"
expected_compiler_version="$(printf '%s\n' \
  'wasixcc 0.4.3' \
  '----------------------------------' \
  'WASIX clang version 21.1.2' \
  'Target: unknown' \
  'Thread model: posix' \
  "InstalledDir: $candidate_root/llvm/bin")"
[ "$compiler_version" = "$expected_compiler_version" ] ||
  fail "wasixcc compiler version output does not match the pinned driver/LLVM identity: ${compiler_version:-<missing>}"
llvm_version="$("$candidate_root/llvm/bin/clang" --version 2>/dev/null | sed -n '1p' || true)"
[ "$llvm_version" = "WASIX clang version 21.1.2" ] ||
  fail "LLVM version mismatch: expected 'WASIX clang version 21.1.2', got '${llvm_version:-<missing>}'"
binaryen_version="$("$candidate_root/binaryen/bin/wasm-opt" --version 2>/dev/null || true)"
[ "$binaryen_version" = "wasm-opt version 130 (version_130)" ] ||
  fail "Binaryen version mismatch: expected version 130, got '${binaryen_version:-<missing>}'"

for sysroot_name in sysroot sysroot-eh sysroot-ehpic sysroot-exnref-eh sysroot-exnref-ehpic; do
  [ -f "$candidate_root/sysroot/$sysroot_name/include/stdio.h" ] ||
    fail "staged toolchain is missing $sysroot_name/include/stdio.h"
  [ -f "$candidate_root/sysroot/$sysroot_name/lib/wasm32-wasi/libc.a" ] ||
    fail "staged toolchain is missing $sysroot_name/lib/wasm32-wasi/libc.a"
done
for command_name in wasixcc wasix++ wasixcc++ wasixar wasixnm wasixranlib wasixld wasixccenv; do
  [ "$(readlink "$candidate_root/bin/$command_name")" = "../wasixccenv" ] ||
    fail "staged command link has an unexpected target: bin/$command_name"
done

smoke_source="$work_root/smoke.c"
smoke_object="$work_root/smoke.o"
printf '%s\n' 'int oliphaunt_wasix_toolchain_smoke(void) { return 0; }' >"$smoke_source"
HOME="$work_root/home" \
  WASIXCC_SYSROOT_PREFIX="$candidate_root/sysroot" \
  WASIXCC_LLVM_LOCATION="$candidate_root/llvm" \
  WASIXCC_BINARYEN_LOCATION="$candidate_root/binaryen" \
  "$candidate_root/bin/wasixcc" -fwasm-exceptions -c "$smoke_source" -o "$smoke_object"
[ -f "$smoke_object" ] || fail "staged wasixcc smoke compile produced no object"
smoke_magic="$(od -An -tx1 -N4 "$smoke_object" | awk '{$1=$1; print}')"
[ "$smoke_magic" = "00 61 73 6d" ] || fail "staged wasixcc smoke object is not WebAssembly"

if [ -e "$install_root" ] || [ -L "$install_root" ]; then
  fail "install root appeared before promotion: $install_root"
fi
mv "$candidate_root" "$install_root"
trap - EXIT HUP INT TERM
rm -rf "$work_root"
printf 'installed pinned WASIX toolchain %s at %s\n' "$manifest_sha256" "$install_root"
