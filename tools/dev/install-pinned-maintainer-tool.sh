#!/usr/bin/env bash
set -euo pipefail

tool="${1:?usage: install-pinned-maintainer-tool.sh <cargo-binstall|actionlint> [--print-version|--promote-locked-cargo-source <binary>]}"
shift
case "$tool" in
  cargo-binstall | actionlint) ;;
  *) echo "unsupported pinned maintainer tool: $tool" >&2; exit 2 ;;
esac

root="${OLIPHAUNT_MAINTAINER_TOOLS_ROOT:-}"
if [ -z "$root" ]; then
  root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
fi
[ -n "$root" ] || { echo "could not determine repository root" >&2; exit 1; }
manifest="${OLIPHAUNT_MAINTAINER_TOOLS_MANIFEST:-$root/src/sources/toolchains/maintainer-tools.toml}"
if [ ! -f "$manifest" ] || [ -L "$manifest" ]; then
  echo "missing regular maintainer tool manifest: $manifest" >&2
  exit 1
fi

manifest_value() {
  local section="$1"
  local key="$2"
  awk -v wanted_section="$section" -v wanted_key="$key" '
    /^[[:space:]]*\[[^]]+\][[:space:]]*$/ {
      current = $0
      sub(/^[[:space:]]*\[/, "", current)
      sub(/\][[:space:]]*$/, "", current)
      if (current == wanted_section) sections++
      next
    }
    current == wanted_section && $0 ~ "^[[:space:]]*" wanted_key "[[:space:]]*=" {
      line = $0
      sub("^[[:space:]]*" wanted_key "[[:space:]]*=[[:space:]]*", "", line)
      if (line !~ /^"[^"]+"[[:space:]]*$/) invalid = 1
      sub(/^"/, "", line)
      sub(/"[[:space:]]*$/, "", line)
      values++
      value = line
    }
    END {
      if (sections != 1 || values != 1 || invalid) exit 1
      print value
    }
  ' "$manifest"
}

version="$(manifest_value "$tool" version || true)"
if [ -z "$version" ] || [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z]+)*$ ]]; then
  echo "$manifest must contain one valid quoted $tool.version" >&2
  exit 1
fi
case "$tool" in
  cargo-binstall)
    if [ -n "${CARGO_BINSTALL_VERSION:-}" ] && [ "$CARGO_BINSTALL_VERSION" != "$version" ]; then
      echo "CARGO_BINSTALL_VERSION must match $manifest ($version)" >&2
      exit 1
    fi
    ;;
  actionlint)
    if [ -n "${ACTIONLINT_VERSION:-}" ] && [ "$ACTIONLINT_VERSION" != "$version" ]; then
      echo "ACTIONLINT_VERSION must match $manifest ($version)" >&2
      exit 1
    fi
    ;;
esac

if [ "${1:-}" = "--print-version" ]; then
  [ "$#" = 1 ] || { echo "--print-version accepts no value" >&2; exit 2; }
  printf '%s\n' "$version"
  exit 0
fi

bin_dir="${OLIPHAUNT_MAINTAINER_BIN_DIR:-${CARGO_HOME:-$HOME/.cargo}/bin}"
mkdir -p "$bin_dir"
final="$bin_dir/$tool"
marker="$bin_dir/.$tool.oliphaunt-source"

sha256_file() {
  local path="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$path" | awk '{ print tolower($1) }'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$path" | awk '{ print tolower($1) }'
  else
    echo "installing $tool requires sha256sum or shasum" >&2
    return 127
  fi
}

tool_version() {
  local binary="$1"
  case "$tool" in
    cargo-binstall) "$binary" -V 2>/dev/null || true ;;
    actionlint) "$binary" -version 2>/dev/null || true ;;
  esac
}

version_matches() {
  local output="$1"
  local escaped
  escaped="$(printf '%s' "$version" | sed 's/[][\\.^$*+?{}|()]/\\&/g')"
  printf '%s\n' "$output" | grep -Eq "(^|[^0-9.])${escaped}([^0-9.]|$)"
}

source_marker_for() {
  local binary_sha="$1"
  printf 'tool=%s\nversion=%s\nsource=locked-cargo-install\nsource_ref=cargo-binstall@%s\nbinary_sha256=%s\n' \
    "$tool" "$version" "$version" "$binary_sha"
}

cache_valid_source() {
  [ "$tool" = cargo-binstall ] || return 1
  [ -f "$final" ] && [ ! -L "$final" ] && [ -x "$final" ] || return 1
  [ -f "$marker" ] && [ ! -L "$marker" ] || return 1
  local actual_sha expected_marker
  actual_sha="$(sha256_file "$final")" || return 1
  expected_marker="$(source_marker_for "$actual_sha")"
  [ "$(cat "$marker")" = "$expected_marker" ] || return 1
  version_matches "$(tool_version "$final")"
}

temporary_root=""
promotion_started=0
old_binary_moved=0
old_marker_moved=0
candidate_binary_promoted=0
candidate_marker_promoted=0
committed=0
previous_binary=""
previous_marker=""
extracted_candidate=""

cleanup() {
  local status="$?"
  trap - EXIT HUP INT TERM
  if [ "$promotion_started" = 1 ] && [ "$committed" != 1 ]; then
    [ "$candidate_marker_promoted" = 1 ] && rm -f "$marker"
    [ "$candidate_binary_promoted" = 1 ] && rm -f "$final"
    if [ "$old_binary_moved" = 1 ] && [ -e "$previous_binary" ]; then
      mv "$previous_binary" "$final" || status=1
    fi
    if [ "$old_marker_moved" = 1 ] && [ -e "$previous_marker" ]; then
      mv "$previous_marker" "$marker" || status=1
    fi
  fi
  [ -z "$temporary_root" ] || rm -rf "$temporary_root"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

promote_candidate() {
  local source_binary="$1"
  local marker_contents="$2"
  if [ ! -f "$source_binary" ] || [ -L "$source_binary" ] || [ ! -s "$source_binary" ]; then
    echo "$tool candidate is not a nonempty regular file" >&2
    return 1
  fi
  version_matches "$(tool_version "$source_binary")" || {
    echo "$tool candidate does not report pinned version $version" >&2
    return 1
  }
  if [ -z "$temporary_root" ]; then
    temporary_root="$(mktemp -d "$bin_dir/.$tool.install.XXXXXX")"
  fi
  local promotion_root="$temporary_root/promotion"
  mkdir -p "$promotion_root"
  local staged_binary="$promotion_root/candidate"
  local candidate_marker="$promotion_root/candidate.marker"
  install -m 0755 "$source_binary" "$staged_binary"
  printf '%s' "$marker_contents" >"$candidate_marker"
  previous_binary="$promotion_root/previous.binary"
  previous_marker="$promotion_root/previous.marker"
  promotion_started=1
  if [ -e "$final" ] || [ -L "$final" ]; then
    mv "$final" "$previous_binary"
    old_binary_moved=1
  fi
  if [ -e "$marker" ] || [ -L "$marker" ]; then
    mv "$marker" "$previous_marker"
    old_marker_moved=1
  fi
  mv "$staged_binary" "$final"
  candidate_binary_promoted=1
  mv "$candidate_marker" "$marker"
  candidate_marker_promoted=1
}

commit_promotion() {
  committed=1
}

if [ "${1:-}" = "--promote-locked-cargo-source" ]; then
  if [ "$tool" != cargo-binstall ] || [ "$#" != 2 ]; then
    echo "--promote-locked-cargo-source is valid only for cargo-binstall with one candidate" >&2
    exit 2
  fi
  candidate_source="$2"
  candidate_sha="$(sha256_file "$candidate_source")"
  promote_candidate "$candidate_source" "$(source_marker_for "$candidate_sha")"
  cache_valid_source || { echo "promoted locked cargo-binstall source candidate failed validation" >&2; exit 1; }
  commit_promotion
  printf 'installed cargo-binstall %s from an exact --locked Cargo source build\n' "$version"
  exit 0
fi
[ "$#" = 0 ] || { echo "unknown installer arguments: $*" >&2; exit 2; }

if cache_valid_source; then
  echo "cargo-binstall cache is identity-verified: $(tool_version "$final")"
  exit 0
fi

os="$(uname -s | tr '[:upper:]' '[:lower:]')"
arch="$(uname -m | tr '[:upper:]' '[:lower:]')"
case "$tool:$os:$arch" in
  cargo-binstall:darwin:arm64) platform=aarch64-apple-darwin ;;
  cargo-binstall:darwin:x86_64) platform=x86_64-apple-darwin ;;
  cargo-binstall:linux:aarch64 | cargo-binstall:linux:arm64) platform=aarch64-unknown-linux-musl ;;
  cargo-binstall:linux:x86_64 | cargo-binstall:linux:amd64) platform=x86_64-unknown-linux-musl ;;
  actionlint:darwin:arm64) platform=darwin-arm64 ;;
  actionlint:darwin:x86_64) platform=darwin-amd64 ;;
  actionlint:linux:aarch64 | actionlint:linux:arm64) platform=linux-arm64 ;;
  actionlint:linux:x86_64 | actionlint:linux:amd64) platform=linux-amd64 ;;
  *) echo "unsupported $tool platform: $os/$arch" >&2; exit 69 ;;
esac

section="$tool.assets.$platform"
url="$(manifest_value "$section" url || true)"
archive_sha="$(manifest_value "$section" sha256 || true)"
binary_sha="$(manifest_value "$section" binary_sha256 || true)"
archive_format="$(manifest_value "$section" format || true)"
binary_path="$(manifest_value "$section" binary_path || true)"
entry_count="$(manifest_value "$section" entry_count || true)"
max_archive_bytes="$(manifest_value "$section" max_archive_bytes || true)"
max_binary_bytes="$(manifest_value "$section" max_binary_bytes || true)"
for digest in "$archive_sha" "$binary_sha"; do
  if [ "${#digest}" != 64 ] || [[ "$digest" =~ [^0-9a-f] ]]; then
    echo "$manifest has an invalid SHA-256 in $section" >&2
    exit 1
  fi
done
for number in "$entry_count" "$max_archive_bytes" "$max_binary_bytes"; do
  [[ "$number" =~ ^[1-9][0-9]*$ ]] || { echo "$manifest has invalid bounds in $section" >&2; exit 1; }
done
[ "$binary_path" = "$tool" ] || { echo "$section.binary_path must be $tool" >&2; exit 1; }
case "$archive_format" in zip | tgz) ;; *) echo "$section.format must be zip or tgz" >&2; exit 1 ;; esac
case "$archive_format" in
  zip) asset_extension=zip ;;
  tgz) asset_extension=tgz ;;
esac
case "$tool:$platform" in
  cargo-binstall:*) expected_url="https://github.com/cargo-bins/cargo-binstall/releases/download/v$version/cargo-binstall-$platform.$asset_extension" ;;
  actionlint:*) expected_url="https://github.com/rhysd/actionlint/releases/download/v$version/actionlint_${version}_${platform%-*}_${platform#*-}.tar.gz" ;;
esac
[ "$url" = "$expected_url" ] || { echo "$section.url is not the exact pinned release URL" >&2; exit 1; }

release_marker="$(printf 'tool=%s\nversion=%s\nsource=release-asset\nplatform=%s\narchive_sha256=%s\nbinary_sha256=%s\n' \
  "$tool" "$version" "$platform" "$archive_sha" "$binary_sha")"
cache_valid_release() {
  [ -f "$final" ] && [ ! -L "$final" ] && [ -x "$final" ] || return 1
  [ -f "$marker" ] && [ ! -L "$marker" ] || return 1
  [ "$(cat "$marker")" = "$release_marker" ] || return 1
  [ "$(sha256_file "$final")" = "$binary_sha" ] || return 1
  version_matches "$(tool_version "$final")"
}
if cache_valid_release; then
  echo "$tool cache is identity-verified: $(tool_version "$final")"
  exit 0
fi

curl_command="${OLIPHAUNT_MAINTAINER_TOOLS_CURL:-curl}"
command -v "$curl_command" >/dev/null 2>&1 || { echo "missing required download command: $curl_command" >&2; exit 1; }
command -v mktemp >/dev/null 2>&1 || { echo "missing required command: mktemp" >&2; exit 1; }
[ "$archive_format" != zip ] || command -v unzip >/dev/null 2>&1 || { echo "missing required command: unzip" >&2; exit 1; }
[ "$archive_format" != tgz ] || command -v tar >/dev/null 2>&1 || { echo "missing required command: tar" >&2; exit 1; }
temporary_root="$(mktemp -d "$bin_dir/.$tool.download.XXXXXX")"
archive="$temporary_root/archive.partial"
extract_root="$temporary_root/extracted"
mkdir -p "$extract_root"
set +e
"$curl_command" \
  --fail \
  --location \
  --silent \
  --show-error \
  --retry 4 \
  --retry-all-errors \
  --retry-delay 2 \
  --retry-max-time 120 \
  --connect-timeout 20 \
  --max-time 180 \
  --max-filesize "$max_archive_bytes" \
  --proto '=https' \
  --proto-redir '=https' \
  --tlsv1.2 \
  --remove-on-error \
  --output "$archive" \
  "$url"
curl_status=$?
set -e
if [ "$curl_status" != 0 ]; then
  echo "$tool release asset download failed with curl status $curl_status" >&2
  case "$curl_status" in
    5 | 6 | 7 | 18 | 28 | 35 | 52 | 55 | 56 | 92) exit 75 ;;
    *) exit 1 ;;
  esac
fi
if [ ! -f "$archive" ] || [ -L "$archive" ]; then
  echo "$tool download did not produce a regular archive" >&2
  exit 1
fi
archive_bytes="$(wc -c <"$archive" | tr -d '[:space:]')"
[ "$archive_bytes" -le "$max_archive_bytes" ] || { echo "$tool archive exceeds its maximum size" >&2; exit 1; }
actual_archive_sha="$(sha256_file "$archive")"
[ "$actual_archive_sha" = "$archive_sha" ] || {
  echo "$tool archive checksum mismatch: expected $archive_sha, got $actual_archive_sha" >&2
  exit 1
}

case "$tool:$archive_format" in
  cargo-binstall:zip)
    members="$(unzip -Z1 "$archive")" || { echo "invalid cargo-binstall ZIP archive" >&2; exit 1; }
    if [ "$members" != cargo-binstall ] || [ "$(printf '%s\n' "$members" | awk 'NF { count++ } END { print count + 0 }')" != "$entry_count" ]; then
      echo "cargo-binstall ZIP archive has an unexpected member layout" >&2
      exit 1
    fi
    unzip -tqq "$archive" >/dev/null || { echo "cargo-binstall ZIP CRC validation failed" >&2; exit 1; }
    [ "$(unzip -Z -l "$archive" cargo-binstall | awk '$NF == "cargo-binstall" { print substr($1, 1, 1) }')" = - ] || {
      echo "cargo-binstall ZIP archive member is not a regular file" >&2; exit 1;
    }
    unzip -q "$archive" cargo-binstall -d "$extract_root"
    ;;
  cargo-binstall:tgz)
    members="$(tar -tzf "$archive")" || { echo "invalid cargo-binstall tar archive" >&2; exit 1; }
    if [ "$members" != cargo-binstall ] || [ "$(printf '%s\n' "$members" | awk 'NF { count++ } END { print count + 0 }')" != "$entry_count" ]; then
      echo "cargo-binstall tar archive has an unexpected member layout" >&2
      exit 1
    fi
    [ "$(tar -tvzf "$archive" | awk '{ print substr($1, 1, 1) }' | LC_ALL=C sort -u)" = - ] || {
      echo "cargo-binstall tar archive member is not a regular file" >&2; exit 1;
    }
    tar -xzf "$archive" -C "$extract_root" cargo-binstall
    ;;
  actionlint:tgz)
    members="$(tar -tzf "$archive")" || { echo "invalid actionlint tar archive" >&2; exit 1; }
    expected_members="$(printf '%s\n' LICENSE.txt README.md actionlint docs/README.md docs/api.md docs/checks.md docs/config.md docs/install.md docs/reference.md docs/usage.md man/actionlint.1 | LC_ALL=C sort)"
    if [ "$(printf '%s\n' "$members" | LC_ALL=C sort)" != "$expected_members" ] || \
      [ "$(printf '%s\n' "$members" | awk 'NF { count++ } END { print count + 0 }')" != "$entry_count" ]; then
      echo "actionlint tar archive has an unexpected member layout" >&2
      exit 1
    fi
    [ "$(tar -tvzf "$archive" | awk '{ print substr($1, 1, 1) }' | LC_ALL=C sort -u)" = - ] || {
      echo "actionlint tar archive contains a non-regular member" >&2; exit 1;
    }
    tar -xzf "$archive" -C "$extract_root" actionlint
    ;;
  *) echo "unsupported archive contract: $tool/$archive_format" >&2; exit 1 ;;
esac

extracted_candidate="$extract_root/$binary_path"
if [ ! -f "$extracted_candidate" ] || [ -L "$extracted_candidate" ] || [ ! -s "$extracted_candidate" ]; then
  echo "$tool archive did not produce its expected regular binary" >&2
  exit 1
fi
candidate_bytes="$(wc -c <"$extracted_candidate" | tr -d '[:space:]')"
[ "$candidate_bytes" -le "$max_binary_bytes" ] || { echo "$tool binary exceeds its maximum size" >&2; exit 1; }
[ "$(sha256_file "$extracted_candidate")" = "$binary_sha" ] || { echo "$tool extracted binary checksum mismatch" >&2; exit 1; }
chmod 0755 "$extracted_candidate"
promote_candidate "$extracted_candidate" "$release_marker"
cache_valid_release || { echo "promoted $tool failed identity validation" >&2; exit 1; }
commit_promotion
echo "installed identity-verified $tool: $(tool_version "$final")"
