#!/usr/bin/env sh

# Shared, fail-closed transport for the pinned PostgreSQL source archive.
# Keep this file POSIX-compatible: native and WASIX build scripts source it on
# both macOS and Linux.

oliphaunt_postgresql_sha256_file() (
  oliphaunt_sha_path="${1:?oliphaunt_postgresql_sha256_file requires a path}"
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$oliphaunt_sha_path" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$oliphaunt_sha_path" | awk '{print $1}'
  else
    echo "PostgreSQL source fetch requires shasum or sha256sum" >&2
    return 127
  fi
)

oliphaunt_fetch_postgresql_source_archive() (
  if [ "$#" -ne 4 ]; then
    echo "usage: oliphaunt_fetch_postgresql_source_archive DESTINATION VERSION SHA256 PRIMARY_URL" >&2
    return 2
  fi

  oliphaunt_destination="$1"
  oliphaunt_version="$2"
  oliphaunt_expected_sha="$(printf '%s' "$3" | tr 'A-F' 'a-f')"
  oliphaunt_primary_url="$4"
  oliphaunt_fallback_url="https://fossies.org/linux/misc/postgresql-${oliphaunt_version}.tar.bz2"

  if [ -z "$oliphaunt_destination" ]; then
    echo "PostgreSQL source destination must not be empty" >&2
    return 2
  fi
  case "$oliphaunt_version" in
    ""|.*|*.|*..*|*[!0-9.]*)
      echo "invalid PostgreSQL source version: $oliphaunt_version" >&2
      return 2
      ;;
  esac
  if [ "${#oliphaunt_expected_sha}" -ne 64 ]; then
    echo "PostgreSQL source SHA-256 must contain exactly 64 hexadecimal characters" >&2
    return 2
  fi
  case "$oliphaunt_expected_sha" in
    *[!0-9a-f]*)
      echo "PostgreSQL source SHA-256 must contain only hexadecimal characters" >&2
      return 2
      ;;
  esac
  for oliphaunt_url in "$oliphaunt_primary_url" "$oliphaunt_fallback_url"; do
    case "$oliphaunt_url" in
      https://*) ;;
      *)
        echo "refusing non-HTTPS PostgreSQL source URL: $oliphaunt_url" >&2
        return 2
        ;;
    esac
  done

  for oliphaunt_required_command in curl mktemp; do
    if ! command -v "$oliphaunt_required_command" >/dev/null 2>&1; then
      echo "PostgreSQL source fetch requires $oliphaunt_required_command" >&2
      return 127
    fi
  done
  if ! command -v shasum >/dev/null 2>&1 && ! command -v sha256sum >/dev/null 2>&1; then
    echo "PostgreSQL source fetch requires shasum or sha256sum" >&2
    return 127
  fi

  if [ -f "$oliphaunt_destination" ]; then
    oliphaunt_actual_sha="$(oliphaunt_postgresql_sha256_file "$oliphaunt_destination")"
    oliphaunt_actual_sha="$(printf '%s' "$oliphaunt_actual_sha" | tr 'A-F' 'a-f')"
    if [ "$oliphaunt_actual_sha" = "$oliphaunt_expected_sha" ]; then
      return 0
    fi
    echo "discarding cached PostgreSQL $oliphaunt_version source with checksum $oliphaunt_actual_sha instead of $oliphaunt_expected_sha" >&2
    rm -f "$oliphaunt_destination"
  fi

  oliphaunt_destination_dir="$(dirname "$oliphaunt_destination")"
  mkdir -p "$oliphaunt_destination_dir"
  umask 077
  oliphaunt_partial="$(mktemp "${oliphaunt_destination}.partial.XXXXXX")"
  trap 'rm -f "$oliphaunt_partial"' 0
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM

  for oliphaunt_url in "$oliphaunt_primary_url" "$oliphaunt_fallback_url"; do
    rm -f "$oliphaunt_partial"
    oliphaunt_curl_status=0
    if curl \
      --location \
      --fail \
      --silent \
      --show-error \
      --retry 4 \
      --retry-all-errors \
      --retry-delay 3 \
      --retry-max-time 90 \
      --connect-timeout 20 \
      --max-time 60 \
      --max-filesize 67108864 \
      --proto '=https' \
      --proto-redir '=https' \
      --tlsv1.2 \
      --output "$oliphaunt_partial" \
      "$oliphaunt_url"; then
      oliphaunt_actual_sha="$(oliphaunt_postgresql_sha256_file "$oliphaunt_partial")"
      oliphaunt_actual_sha="$(printf '%s' "$oliphaunt_actual_sha" | tr 'A-F' 'a-f')"
      if [ "$oliphaunt_actual_sha" = "$oliphaunt_expected_sha" ]; then
        mv -f "$oliphaunt_partial" "$oliphaunt_destination"
        return 0
      fi
      echo "discarding PostgreSQL $oliphaunt_version source from $oliphaunt_url with checksum $oliphaunt_actual_sha instead of $oliphaunt_expected_sha" >&2
    else
      oliphaunt_curl_status=$?
      echo "PostgreSQL $oliphaunt_version source download from $oliphaunt_url failed after bounded retries (curl exit $oliphaunt_curl_status)" >&2
    fi
  done

  rm -f "$oliphaunt_partial"
  echo "failed to download verified PostgreSQL $oliphaunt_version source from every pinned HTTPS location" >&2
  return 1
)
