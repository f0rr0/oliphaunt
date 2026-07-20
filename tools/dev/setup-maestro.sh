#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "must run inside the Oliphaunt git checkout" >&2
  exit 1
}
cd "$root"

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "missing required command: $1" >&2
    exit 1
  }
}

need_cmd curl
need_cmd java
need_cmd mktemp
need_cmd python3

export MAESTRO_CLI_NO_ANALYTICS=true
export MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED=true
maestro_bin="$HOME/.maestro/bin/maestro"
maestro_manifest="src/sources/toolchains/maestro.toml"

manifest_value() {
  local key="$1"
  local count
  local value
  count="$(grep -Ec "^[[:space:]]*${key}[[:space:]]*=" "$maestro_manifest" || true)"
  [ "$count" = "1" ] || return 1
  value="$(sed -n "s/^[[:space:]]*${key}[[:space:]]*=[[:space:]]*\"\([^\"]*\)\"[[:space:]]*$/\\1/p" "$maestro_manifest")"
  [ -n "$value" ] || return 1
  printf '%s\n' "$value"
}

version="$(manifest_value maestro || true)"
maestro_url="$(manifest_value install_url || true)"
maestro_sha256="$(manifest_value sha256 || true)"
if [ -z "$version" ] || [ -z "$maestro_url" ] || [ -z "$maestro_sha256" ]; then
  echo "$maestro_manifest must contain exactly one quoted maestro version, install_url, and sha256 pin" >&2
  exit 1
fi

normalized_version="${version#cli-}"
if ! [[ "$normalized_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z]+)*$ ]] || {
  [ "$version" != "$normalized_version" ] && [ "$version" != "cli-$normalized_version" ];
}; then
  echo "$maestro_manifest contains an invalid Maestro version: $version" >&2
  exit 1
fi
expected_url="https://github.com/mobile-dev-inc/Maestro/releases/download/cli-$normalized_version/maestro.zip"
if [ "$maestro_url" != "$expected_url" ]; then
  echo "$maestro_manifest install_url must be the exact release asset for cli-$normalized_version" >&2
  exit 1
fi
if [ "${#maestro_sha256}" -ne 64 ] || [[ "$maestro_sha256" =~ [^0-9A-Fa-f] ]]; then
  echo "$maestro_manifest sha256 must be exactly 64 hexadecimal characters" >&2
  exit 1
fi
maestro_sha256="$(printf '%s' "$maestro_sha256" | tr '[:upper:]' '[:lower:]')"

maestro_version() {
  local binary="$1"
  local output
  local detected
  output="$("$binary" --version 2>/dev/null)" || return 1
  detected="$(printf '%s\n' "$output" | awk 'NF { value = $NF } END { print value }')"
  detected="${detected#cli-}"
  [ -n "$detected" ] || return 1
  printf '%s\n' "$detected"
}

maestro_sha256_file() {
  local path="$1"
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$path" | awk '{print tolower($1)}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$path" | awk '{print tolower($1)}'
  else
    echo "Maestro installation requires shasum or sha256sum" >&2
    return 127
  fi
}

export MAESTRO_VERSION="$normalized_version"
if ! command -v shasum >/dev/null 2>&1 && ! command -v sha256sum >/dev/null 2>&1; then
  echo "Maestro installation requires shasum or sha256sum" >&2
  exit 127
fi
umask 077
mkdir -p "$HOME"
install_root="$HOME/.maestro"
temporary_root="$(mktemp -d "$HOME/.maestro.install.XXXXXX")"
previous_root="$temporary_root/previous"
had_previous=0
promotion_started=0
cleanup() {
  local cleanup_status="$?"
  trap - EXIT HUP INT TERM
  if [ "$promotion_started" = "1" ] && [ "$had_previous" = "1" ] && \
    [ ! -e "$install_root" ] && [ ! -L "$install_root" ] && \
    { [ -e "$previous_root" ] || [ -L "$previous_root" ]; }; then
    if ! mv "$previous_root" "$install_root"; then
      echo "could not restore the previous Maestro installation; it remains at $previous_root" >&2
      [ "$cleanup_status" -ne 0 ] || cleanup_status=1
      exit "$cleanup_status"
    fi
  fi
  rm -rf "$temporary_root"
  exit "$cleanup_status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

archive="$temporary_root/maestro.zip"
extract_root="$temporary_root/extracted"
mkdir -p "$extract_root"
curl \
  --fail \
  --location \
  --silent \
  --show-error \
  --retry 4 \
  --retry-all-errors \
  --retry-delay 3 \
  --retry-max-time 300 \
  --connect-timeout 20 \
  --max-time 300 \
  --max-filesize 400000000 \
  --proto '=https' \
  --proto-redir '=https' \
  --tlsv1.2 \
  --remove-on-error \
  --output "$archive" \
  "$maestro_url"

actual_sha256="$(maestro_sha256_file "$archive")"
if [ "$actual_sha256" != "$maestro_sha256" ]; then
  echo "Maestro $normalized_version archive checksum mismatch: expected $maestro_sha256, got $actual_sha256" >&2
  exit 1
fi

python3 - "$archive" "$extract_root" "$normalized_version" <<'PY'
import stat
import sys
import zipfile
from pathlib import Path

archive_path = Path(sys.argv[1])
extract_root = Path(sys.argv[2])
version = sys.argv[3]
required = {
    "maestro/bin/maestro",
    f"maestro/lib/maestro-cli-{version}.jar",
}
seen = set()

try:
    with zipfile.ZipFile(archive_path) as archive:
        entries = archive.infolist()
        if not entries or len(entries) > 4096:
            raise ValueError(f"unexpected entry count: {len(entries)}")
        expanded_size = sum(entry.file_size for entry in entries)
        if expanded_size > 800_000_000:
            raise ValueError(f"expanded archive is too large: {expanded_size} bytes")

        for entry in entries:
            name = entry.filename
            if not name or "\\" in name or "\x00" in name:
                raise ValueError(f"unsafe archive path: {name!r}")
            trimmed = name[:-1] if name.endswith("/") else name
            parts = trimmed.split("/")
            if (
                not trimmed
                or name.startswith("/")
                or any(part in {"", ".", ".."} for part in parts)
                or parts[0] != "maestro"
            ):
                raise ValueError(f"unsafe archive path: {name!r}")
            canonical = "/".join(parts)
            if canonical in seen:
                raise ValueError(f"duplicate archive path: {canonical}")
            seen.add(canonical)
            if entry.flag_bits & 0x1:
                raise ValueError(f"encrypted archive entry: {name}")
            mode = (entry.external_attr >> 16) & 0xFFFF
            file_type = stat.S_IFMT(mode)
            if file_type not in {0, stat.S_IFREG, stat.S_IFDIR}:
                raise ValueError(f"unsupported archive entry type: {name}")

        missing = sorted(required - seen)
        if missing:
            raise ValueError(f"missing expected archive entries: {', '.join(missing)}")
        corrupt = archive.testzip()
        if corrupt is not None:
            raise ValueError(f"archive CRC validation failed at {corrupt}")
        archive.extractall(extract_root)
except (OSError, ValueError, zipfile.BadZipFile) as error:
    raise SystemExit(f"invalid Maestro archive: {error}")
PY

candidate_root="$extract_root/maestro"
candidate_bin="$candidate_root/bin/maestro"
candidate_jar="$candidate_root/lib/maestro-cli-$normalized_version.jar"
if [ ! -f "$candidate_bin" ] || [ -L "$candidate_bin" ]; then
  echo "Maestro archive did not produce a regular launcher at $candidate_bin" >&2
  exit 1
fi
if [ ! -f "$candidate_jar" ] || [ -L "$candidate_jar" ]; then
  echo "Maestro archive did not produce the pinned CLI jar at $candidate_jar" >&2
  exit 1
fi
chmod 0755 "$candidate_bin"
candidate_version="$(maestro_version "$candidate_bin" || true)"
if [ "$candidate_version" != "$normalized_version" ]; then
  echo "Maestro archive launcher version mismatch: expected $normalized_version, got ${candidate_version:-<missing>}" >&2
  exit 1
fi

if [ -e "$install_root" ] || [ -L "$install_root" ]; then
  promotion_started=1
  had_previous=1
  mv "$install_root" "$previous_root"
fi
if mv "$candidate_root" "$install_root"; then
  :
else
  promotion_status=$?
  if [ "$had_previous" = "1" ] && ! mv "$previous_root" "$install_root"; then
    trap - EXIT
    echo "Maestro promotion failed and rollback failed; the previous installation remains at $previous_root" >&2
    exit "$promotion_status"
  fi
  echo "Maestro promotion failed; the previous installation was restored" >&2
  exit "$promotion_status"
fi

[ -x "$maestro_bin" ] || {
  echo "maestro install did not produce $maestro_bin" >&2
  exit 1
}

if [ -n "${GITHUB_PATH:-}" ]; then
  printf '%s\n' "$HOME/.maestro/bin" >>"$GITHUB_PATH"
fi

"$maestro_bin" --version
