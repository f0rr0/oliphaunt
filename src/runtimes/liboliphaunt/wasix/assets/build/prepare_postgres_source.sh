#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null || (cd "$SCRIPT_DIR/../../../../../.." && pwd))"
SOURCE_ROOT="$SCRIPT_DIR/postgres"
SOURCE_TOML="$REPO_ROOT/src/postgres/versions/18/source.toml"
PATCH_DIR="$SOURCE_ROOT/patches"

read_toml_value() {
  local key="$1"
  awk -F'=' -v key="$key" '
    $1 ~ "^[[:space:]]*" key "[[:space:]]*$" {
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", $2)
      gsub(/^"|"$/, "", $2)
      print $2
      exit
    }
  ' "$SOURCE_TOML"
}

sha256_file() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    sha256sum "$1" | awk '{print $1}'
  fi
}

sha256_stream() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 | awk '{print $1}'
  else
    sha256sum | awk '{print $1}'
  fi
}

sha256_text_lf() {
  sed 's/\r$//' "$1" | sha256_stream
}

source_has_patch_artifacts() {
  [[ -d "$1" ]] && find "$1" \( -name "*.orig" -o -name "*.rej" \) -print -quit | grep -q .
}

PG_VERSION="$(read_toml_value version)"
PG_URL="$(read_toml_value url)"
PG_SHA256="$(read_toml_value sha256)"

if [[ -z "$PG_VERSION" || -z "$PG_URL" || -z "$PG_SHA256" ]]; then
  echo "prepare_postgres_source: failed to read PostgreSQL source metadata from $SOURCE_TOML" >&2
  exit 1
fi

GENERATED_ROOT="${OLIPHAUNT_WASM_GENERATED_ROOT:-$REPO_ROOT/target/oliphaunt-wasix/wasix-build}"
WORK_ROOT="${OLIPHAUNT_WASM_POSTGRES_WORK_ROOT:-$GENERATED_ROOT}"
SOURCE_CACHE="${SOURCE_CACHE:-$REPO_ROOT/target/liboliphaunt-pg18/source}"
TARBALL="$SOURCE_CACHE/postgresql-$PG_VERSION.tar.bz2"
PATCHED_PGSRC="$WORK_ROOT/work/postgresql-$PG_VERSION-oliphaunt-wasix-src"
FINGERPRINT="$WORK_ROOT/.source-fingerprint"
SOURCE_FINGERPRINT_FILE="$PATCHED_PGSRC/.oliphaunt-wasix-source-fingerprint"
SOURCE_VERSION_FILE="$PATCHED_PGSRC/.oliphaunt-wasix-postgres-version"

mkdir -p "$SOURCE_CACHE" "$WORK_ROOT/work"

if [[ ! -f "$TARBALL" ]]; then
  echo "prepare_postgres_source: downloading PostgreSQL $PG_VERSION" >&2
  curl -L "$PG_URL" -o "$TARBALL"
fi

actual_sha="$(sha256_file "$TARBALL")"
if [[ "$actual_sha" != "$PG_SHA256" ]]; then
  echo "prepare_postgres_source: checksum mismatch for $TARBALL" >&2
  echo "  expected: $PG_SHA256" >&2
  echo "  actual:   $actual_sha" >&2
  exit 1
fi

series_hash="$(
  {
    sha256_text_lf "$PATCH_DIR/series"
    for patch_file in "$PATCH_DIR"/*.patch; do
      sha256_text_lf "$patch_file"
    done
  } | sha256_stream
)"
new_fingerprint="$PG_VERSION:$PG_SHA256:$series_hash"

if [[ -d "$PATCHED_PGSRC" && -f "$FINGERPRINT" && "$(cat "$FINGERPRINT")" == "$new_fingerprint" ]] && ! source_has_patch_artifacts "$PATCHED_PGSRC"; then
  if [[ ! -f "$SOURCE_FINGERPRINT_FILE" || "$(cat "$SOURCE_FINGERPRINT_FILE")" != "$new_fingerprint" ]]; then
    printf '%s\n' "$new_fingerprint" > "$SOURCE_FINGERPRINT_FILE"
  fi
  if [[ ! -f "$SOURCE_VERSION_FILE" || "$(cat "$SOURCE_VERSION_FILE")" != "$PG_VERSION" ]]; then
    printf '%s\n' "$PG_VERSION" > "$SOURCE_VERSION_FILE"
  fi
  echo "$PATCHED_PGSRC"
  exit 0
fi

rm -rf "$PATCHED_PGSRC"
tar -xjf "$TARBALL" -C "$WORK_ROOT/work"
mv "$WORK_ROOT/work/postgresql-$PG_VERSION" "$PATCHED_PGSRC"

while IFS= read -r patch_name; do
  [[ -z "$patch_name" || "$patch_name" =~ ^# ]] && continue
  echo "prepare_postgres_source: applying $patch_name" >&2
  (cd "$PATCHED_PGSRC" && patch --no-backup-if-mismatch -p1 < "$PATCH_DIR/$patch_name") >&2
done < "$PATCH_DIR/series"

if source_has_patch_artifacts "$PATCHED_PGSRC"; then
  echo "prepare_postgres_source: patch backup/reject files were left in $PATCHED_PGSRC" >&2
  find "$PATCHED_PGSRC" \( -name "*.orig" -o -name "*.rej" \) -print >&2
  exit 1
fi

printf '%s\n' "$new_fingerprint" > "$FINGERPRINT"
printf '%s\n' "$new_fingerprint" > "$SOURCE_FINGERPRINT_FILE"
printf '%s\n' "$PG_VERSION" > "$SOURCE_VERSION_FILE"
echo "$PATCHED_PGSRC"
