#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$ROOT/source_lane.sh"

SOURCE_LANE="$(oliphaunt_wasix_source_lane)"
CONTAINER_GENERATED_ROOT="${CONTAINER_GENERATED_ROOT:-/work/target/oliphaunt-wasix/wasix-build}"
BUILD_DIR="${BUILD_DIR:-$(oliphaunt_wasix_default_build_dir "$SOURCE_LANE")}"
if [ -z "${PGSRC:-}" ]; then
  case "$SOURCE_LANE" in
    stable | released | packaged | default)
      echo "PGSRC must be set when pg_config_wasix.sh runs" >&2
      exit 2
      ;;
    *)
      echo "unsupported OLIPHAUNT_WASM_SOURCE_LANE=$SOURCE_LANE" >&2
      exit 2
      ;;
  esac
fi
case "$SOURCE_LANE" in
  stable | released | packaged | default)
  if [ ! -s "$PGSRC/.oliphaunt-wasix-postgres-version" ]; then
    echo "PG18 PGSRC is missing .oliphaunt-wasix-postgres-version: $PGSRC" >&2
    exit 2
  fi
  if [ ! -s "$PGSRC/.oliphaunt-wasix-source-fingerprint" ]; then
    echo "PG18 PGSRC is missing .oliphaunt-wasix-source-fingerprint: $PGSRC" >&2
    exit 2
    fi
    ;;
  *)
    echo "unsupported OLIPHAUNT_WASM_SOURCE_LANE=$SOURCE_LANE" >&2
    exit 2
    ;;
esac
PREFIX="${OLIPHAUNT_WASIX_PREFIX:-$BUILD_DIR/install}"

postgres_version() {
  local version_file version source_toml
  for version_file in \
    "$PGSRC/.oliphaunt-wasix-postgres-version" \
    "$BUILD_DIR/.oliphaunt-wasix-postgres-version"; do
    if [ -f "$version_file" ]; then
      IFS= read -r version < "$version_file"
      if [ -n "$version" ]; then
        printf '%s-wasix-oliphaunt\n' "$version"
        return
      fi
    fi
  done
  source_toml="$ROOT/postgres/source.toml"
  if [ -f "$source_toml" ]; then
    version="$(awk -F'=' '/^[[:space:]]*version[[:space:]]*=/ {gsub(/^[[:space:]]+|[[:space:]]+$/, "", $2); gsub(/^"|"$/, "", $2); print $2; exit}' "$source_toml")"
    if [ -n "$version" ]; then
      printf '%s-wasix-oliphaunt\n' "$version"
      return
    fi
  fi
  echo "unable to determine pinned PostgreSQL version" >&2
  return 2
}

case "${1:-}" in
  --pgxs)
    echo "$BUILD_DIR/src/makefiles/pgxs.mk"
    ;;
  --bindir)
    echo "$PREFIX/bin"
    ;;
  --sharedir)
    echo "$PREFIX/share"
    ;;
  --sysconfdir)
    echo "$PREFIX/etc"
    ;;
  --libdir)
    echo "$PREFIX/lib"
    ;;
  --pkglibdir)
    echo "$PREFIX/lib/postgresql"
    ;;
  --includedir | --pkgincludedir)
    echo "$PREFIX/include"
    ;;
  --includedir-server)
    echo "$BUILD_DIR/src/include"
    ;;
  --mandir)
    echo "$PREFIX/share/man"
    ;;
  --docdir)
    echo "$PREFIX/share/doc"
    ;;
  --localedir)
    echo "$PREFIX/share/locale"
    ;;
  --version)
    echo "PostgreSQL $(postgres_version)"
    ;;
  --configure)
    echo "--host=wasm32-wasix --with-template=wasix-dl"
    ;;
  --cc)
    echo "wasixcc"
    ;;
  --cppflags)
    echo "-I$BUILD_DIR/src/include -I$PGSRC/src/include -I$PGSRC/src/include/port/wasix-dl"
    ;;
  --cflags)
    echo ""
    ;;
  --ldflags | --libs)
    echo ""
    ;;
  *)
    echo "unsupported pg_config_wasix.sh option: ${1:-<none>}" >&2
    exit 2
    ;;
esac
