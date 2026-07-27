#!/usr/bin/env bash

oliphaunt_wasix_source_lane() {
  printf '%s\n' "${OLIPHAUNT_WASM_SOURCE_LANE:-stable}"
}

oliphaunt_wasix_default_build_dir() {
  local lane="$1"
  case "$lane" in
    stable | released | packaged | default)
      printf '%s\n' "$CONTAINER_GENERATED_ROOT/work/docker-oliphaunt"
      ;;
    *)
      echo "unsupported OLIPHAUNT_WASM_SOURCE_LANE=$lane" >&2
      return 1
      ;;
  esac
}

oliphaunt_wasix_generated_build_dir() {
  local lane="$1"
  case "$lane" in
    stable | released | packaged | default)
      printf '%s\n' "$CONTAINER_GENERATED_ROOT/build"
      ;;
    *)
      echo "unsupported OLIPHAUNT_WASM_SOURCE_LANE=$lane" >&2
      return 1
      ;;
  esac
}

oliphaunt_wasix_scratch_build_dir() {
  local lane="$1"
  local name="$2"
  printf '%s/%s\n' "$(oliphaunt_wasix_generated_build_dir "$lane")" "$name"
}

oliphaunt_wasix_prepare_source_for_docker() {
  local lane="$1"
  case "$lane" in
    stable | released | packaged | default)
      local host_pgsrc
      host_pgsrc="$(SOURCE_CACHE="${SOURCE_CACHE:-$REPO_ROOT/target/liboliphaunt-pg18/source}" "$ROOT/prepare_postgres_source.sh")"
      case "$host_pgsrc" in
        "$REPO_ROOT"/*)
          printf '%s\n' "/work${host_pgsrc#"$REPO_ROOT"}"
          ;;
        *)
          echo "prepared PG18 source is outside repo mount: $host_pgsrc" >&2
          return 1
          ;;
      esac
      ;;
    *)
      echo "unsupported OLIPHAUNT_WASM_SOURCE_LANE=$lane" >&2
      return 1
      ;;
  esac
}

oliphaunt_wasix_check_source_markers() {
  case "${OLIPHAUNT_WASM_SOURCE_LANE:-stable}" in
    stable | released | packaged | default)
      if ! cmp -s "$PGSRC/.oliphaunt-wasix-source-fingerprint" "$BUILD_DIR/.oliphaunt-wasix-source-fingerprint"; then
        echo "PG18 build source fingerprint mismatch for $BUILD_DIR" >&2
        return 1
      fi
      if ! cmp -s "$PGSRC/.oliphaunt-wasix-postgres-version" "$BUILD_DIR/.oliphaunt-wasix-postgres-version"; then
        echo "PG18 build PostgreSQL version marker mismatch for $BUILD_DIR" >&2
        return 1
      fi
      ;;
    *)
      echo "unsupported OLIPHAUNT_WASM_SOURCE_LANE=${OLIPHAUNT_WASM_SOURCE_LANE:-}" >&2
      return 1
      ;;
  esac
}
