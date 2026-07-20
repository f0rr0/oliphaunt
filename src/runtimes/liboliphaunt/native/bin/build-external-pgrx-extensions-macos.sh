#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$script_dir/common.sh"
repo_root="$(oliphaunt_resolve_repo_root "$script_dir")"
macos_deployment_target="${MACOSX_DEPLOYMENT_TARGET:-11.0}"
case "$macos_deployment_target" in
  ""|*[!0-9.]*)
    echo "MACOSX_DEPLOYMENT_TARGET must be a numeric dotted version" >&2
    exit 2
    ;;
esac
export MACOSX_DEPLOYMENT_TARGET="$macos_deployment_target"
work_root="${OLIPHAUNT_WORK_ROOT:-$repo_root/target/liboliphaunt-pg18}"
repo_tools_bin="$repo_root/target/liboliphaunt-tools/bin"
install_dir="$work_root/install"
out_dir="$work_root/out"
lib_out="$out_dir/liboliphaunt.dylib"
embedded_modules_dir="$out_dir/modules"
package_root="$work_root/external-pgrx/packages"
target_root="$work_root/external-pgrx/target"
source_stage_root="$work_root/external-pgrx/sources"
pgrx_home="${PGRX_HOME:-$work_root/external-pgrx/pgrx-home}"
stamp_root="$out_dir/external-pgrx"
script_mode="${1:-build}"
selected_extensions="${OLIPHAUNT_EXTERNAL_PGRX_EXTENSIONS:-all}"
build_fingerprint_schema="liboliphaunt-external-pgrx-build-v3"
pinned_git_fetcher="$script_dir/fetch-pinned-git-checkout.sh"

if [ -x "$repo_tools_bin/cargo-pgrx" ]; then
  case ":$PATH:" in
    *":$repo_tools_bin:"*) ;;
    *) export PATH="$repo_tools_bin:$PATH" ;;
  esac
fi

ids=(pggraph paradedb-pg-search)
sql_names=(graph pg_search)
module_stems=(graph pg_search)
repos=(
  https://github.com/evokoa/pggraph.git
  https://github.com/paradedb/paradedb.git
)
refs=(HEAD refs/tags/v0.23.4)
commits=(
  4ea3c3206811deda03de136b4f465a2cf9bc8e72
  c07921a78f3d24cbb0251b31a1150a7db600af5a
)
checkouts=(
  "$repo_root/target/oliphaunt-sources/checkouts/pggraph"
  "$repo_root/target/oliphaunt-sources/checkouts/paradedb"
)
source_subdirs=(graph pg_search)
pgrx_versions=(0.18.0 0.18.0)
pg_features=(pg18 pg18)
min_free_kib=(2097152 12582912)
max_checkout_kib=(524288 4194304)

usage() {
  cat >&2 <<'MSG'
usage: src/runtimes/liboliphaunt/native/bin/build-external-pgrx-extensions-macos.sh [build|--fetch|--check-current|--refresh-current-stamps|--print-required-artifacts]

Environment:
  OLIPHAUNT_EXTERNAL_PGRX_EXTENSIONS=all|pggraph,paradedb-pg-search
  OLIPHAUNT_EXTERNAL_PGRX_SKIP_DISK_PREFLIGHT=1 to bypass disk checks
  OLIPHAUNT_EXTERNAL_PGRX_FETCH_TIMEOUT_SECONDS=300 bounds each exact-commit fetch
  OLIPHAUNT_EXTERNAL_PGRX_FETCH_ATTEMPTS=3 sets the bounded attempt count (maximum 4)
  OLIPHAUNT_EXTERNAL_PGRX_FETCH_RETRY_DELAY_SECONDS=2 sets linear backoff (maximum 5)

The build mode requires cargo-pgrx. The default fast native validation does not
run this expensive lane; it is the opt-in artifact builder for SDK-known pgrx
extensions.
MSG
}

run() {
  printf '\n==> %s\n' "$*"
  "$@"
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "missing required command for external pgrx extension build: $1" >&2
    exit 1
  fi
}

available_kib_for_path() {
  local path="$1"
  mkdir -p "$path"
  df -Pk "$path" | awk 'NR == 2 { print $4 }'
}

format_gib_from_kib() {
  awk -v kib="$1" 'BEGIN { printf "%.1f GiB", kib / 1048576 }'
}

require_free_space_for_candidate() {
  local index="$1"
  [ "${OLIPHAUNT_EXTERNAL_PGRX_SKIP_DISK_PREFLIGHT:-0}" = "1" ] && return 0

  local required="${min_free_kib[$index]}"
  local available
  available="$(available_kib_for_path "$work_root")"
  if [ -z "$available" ] || [ "$available" -lt "$required" ]; then
    echo "external pgrx build for ${ids[$index]} needs at least $(format_gib_from_kib "$required") free under $work_root; available: $(format_gib_from_kib "${available:-0}")" >&2
    echo "free disk space or set OLIPHAUNT_EXTERNAL_PGRX_SKIP_DISK_PREFLIGHT=1 for a local experiment" >&2
    exit 1
  fi
}

candidate_selected() {
  local id="$1"
  local raw="$selected_extensions"
  [ "$raw" = "all" ] && return 0
  IFS=',' read -r -a selected <<< "$raw"
  local candidate
  for candidate in "${selected[@]}"; do
    candidate="${candidate#"${candidate%%[![:space:]]*}"}"
    candidate="${candidate%"${candidate##*[![:space:]]}"}"
    if [ "$candidate" = "$id" ]; then
      return 0
    fi
  done
  return 1
}

selected_indices() {
  local index
  for index in "${!ids[@]}"; do
    if candidate_selected "${ids[$index]}"; then
      printf '%s\n' "$index"
    fi
  done
}

assert_known_selection() {
  [ "$selected_extensions" = "all" ] && return 0
  IFS=',' read -r -a selected <<< "$selected_extensions"
  local candidate
  for candidate in "${selected[@]}"; do
    candidate="${candidate#"${candidate%%[![:space:]]*}"}"
    candidate="${candidate%"${candidate##*[![:space:]]}"}"
    [ -n "$candidate" ] || continue
    local found=0
    local id
    for id in "${ids[@]}"; do
      if [ "$candidate" = "$id" ]; then
        found=1
      fi
    done
    if [ "$found" -eq 0 ]; then
      echo "unknown external pgrx extension selection: $candidate" >&2
      exit 2
    fi
  done
}

module_depends_on_liboliphaunt() {
  local module="$1"
  [ -f "$module" ] || return 1
  case "$(otool -L "$module" 2>/dev/null || true)" in
    *"@rpath/liboliphaunt.dylib"*) return 0 ;;
    *) return 1 ;;
  esac
}

module_has_postgres_symbols_bound_to_liboliphaunt() {
  local module="$1"
  nm -m "$module" 2>/dev/null |
    awk 'index($0, "(from liboliphaunt)") { found = 1 } END { exit found ? 0 : 1 }'
}

normal_pgrx_rustflags() {
  printf '%s -C link-arg=-Wl,-undefined,dynamic_lookup' "${RUSTFLAGS:-}"
}

embedded_pgrx_rustflags() {
  printf '%s -C link-arg=-L%s -C link-arg=-loliphaunt -C link-arg=-Wl,-rpath,%s' \
    "${RUSTFLAGS:-}" "$out_dir" "$out_dir"
}

checkout_clean_or_allowed() {
  local checkout="$1"
  [ "${OLIPHAUNT_EXTERNAL_PGRX_ALLOW_DIRTY:-0}" = "1" ] && return 0
  if [ -n "$(git -C "$checkout" status --porcelain)" ]; then
    echo "external extension checkout has local changes: $checkout" >&2
    echo "set OLIPHAUNT_EXTERNAL_PGRX_ALLOW_DIRTY=1 only for local experiments" >&2
    exit 1
  fi
}

fetch_candidate() {
  local index="$1"
  local id="${ids[$index]}"
  local checkout="${checkouts[$index]}"
  local repo="${repos[$index]}"
  local ref="${refs[$index]}"
  local commit="${commits[$index]}"

  run "$pinned_git_fetcher" \
    "$id" \
    "$repo" \
    "$ref" \
    "$commit" \
    "$checkout" \
    "${max_checkout_kib[$index]}"
  echo "external pgrx checkout ready for $id at $commit"
}

fingerprint_source_state() {
  local root="$1"
  printf 'checkout_head=%s\n' "$(git -C "$root" rev-parse HEAD)"
  if [ -n "$(git -C "$root" status --porcelain=v1)" ]; then
    printf 'checkout_dirty=1\n'
    git -C "$root" status --porcelain=v1 | LC_ALL=C sort | sed 's/^/checkout_status=/'
    git -C "$root" diff --binary HEAD -- | shasum -a 256 | awk '{ print "checkout_diff_sha256=" $1 }'
  else
    printf 'checkout_dirty=0\n'
  fi
}

prepare_source_stage() {
  local index="$1"
  local id="${ids[$index]}"
  local checkout="${checkouts[$index]}"
  local source_subdir="${source_subdirs[$index]}"
  local stage="$source_stage_root/$id"

  rm -rf "$stage"
  mkdir -p "$stage"
  rsync -a \
    --exclude .git \
    --exclude target \
    --exclude .pgrx \
    "$checkout/" "$stage/"
  if [ ! -f "$stage/Cargo.toml" ]; then
    cat > "$stage/Cargo.toml" <<EOF
[workspace]
members = ["$source_subdir"]
resolver = "2"
EOF
  fi
  printf '%s\n' "$stage/$source_subdir"
}

artifact_stamp() {
  local id="$1"
  printf '%s/%s.inputs.sha256\n' "$stamp_root" "$id"
}

artifact_inputs() {
  local id="$1"
  printf '%s/%s.inputs.txt\n' "$stamp_root" "$id"
}

build_fingerprint_material() {
  local index="$1"
  local checkout="${checkouts[$index]}"
  printf 'schema=%s\n' "$build_fingerprint_schema"
  printf 'id=%s\n' "${ids[$index]}"
  printf 'sql_name=%s\n' "${sql_names[$index]}"
  printf 'module_stem=%s\n' "${module_stems[$index]}"
  printf 'repo=%s\n' "${repos[$index]}"
  printf 'commit=%s\n' "${commits[$index]}"
  printf 'source_subdir=%s\n' "${source_subdirs[$index]}"
  printf 'pgrx_version=%s\n' "${pgrx_versions[$index]}"
  printf 'pg_feature=%s\n' "${pg_features[$index]}"
  printf 'pg_config=%s\n' "$install_dir/bin/pg_config"
  printf 'pgrx_home=%s\n' "$pgrx_home"
  printf 'macos_deployment_target=%s\n' "$macos_deployment_target"
  printf 'ambient_rustflags=%s\n' "${RUSTFLAGS:-}"
  printf 'normal_rustflags=%s\n' "$(normal_pgrx_rustflags)"
  printf 'embedded_rustflags=%s\n' "$(embedded_pgrx_rustflags)"
  "$install_dir/bin/pg_config" --version
  rustc --version
  cargo --version
  cargo pgrx --version
  shasum -a 256 "$repo_root/src/runtimes/liboliphaunt/native/postgres18/external-extensions.toml"
  stat -f '%m %z %N' "$lib_out"
  stat -f '%m %z %N' "$install_dir/bin/postgres"
  fingerprint_source_state "$checkout"
}

build_fingerprint() {
  local index="$1"
  build_fingerprint_material "$index" | shasum -a 256 | awk '{print $1}'
}

write_artifact_stamp() {
  local index="$1"
  local id="${ids[$index]}"
  local stamp
  local inputs
  local tmp
  stamp="$(artifact_stamp "$id")"
  inputs="$(artifact_inputs "$id")"
  mkdir -p "$stamp_root"
  tmp="$(mktemp "$stamp_root/$id.inputs.XXXXXX")"
  build_fingerprint_material "$index" > "$tmp"
  shasum -a 256 "$tmp" | awk '{print $1}' > "$stamp"
  mv "$tmp" "$inputs"
}

find_one_packaged_file() {
  local root="$1"
  local name="$2"
  find "$root" -type f -name "$name" -print | LC_ALL=C sort | head -n 1
}

copy_sql_assets() {
  local package_dir="$1"
  local sql_name="$2"
  local target="$install_dir/share/postgresql/extension"
  mkdir -p "$target"

  local control
  control="$(find_one_packaged_file "$package_dir" "$sql_name.control")"
  if [ -z "$control" ]; then
    echo "pgrx package did not produce $sql_name.control under $package_dir" >&2
    exit 1
  fi
  cp -p "$control" "$target/$sql_name.control"

  local copied=0
  while IFS= read -r sql_file; do
    [ -n "$sql_file" ] || continue
    cp -p "$sql_file" "$target/$(basename "$sql_file")"
    copied=$((copied + 1))
  done < <(find "$package_dir" -type f -name "$sql_name--*.sql" -print | LC_ALL=C sort)
  if [ "$copied" -eq 0 ]; then
    echo "pgrx package did not produce any $sql_name--*.sql files under $package_dir" >&2
    exit 1
  fi
}

find_packaged_module() {
  local package_dir="$1"
  local module_stem="$2"
  local module
  module="$(find_one_packaged_file "$package_dir" "$module_stem.dylib")"
  if [ -n "$module" ]; then
    printf '%s\n' "$module"
    return 0
  fi
  module="$(find_one_packaged_file "$package_dir" "lib$module_stem.dylib")"
  if [ -n "$module" ]; then
    printf '%s\n' "$module"
    return 0
  fi
  return 1
}

copy_module_asset() {
  local package_dir="$1"
  local module_stem="$2"
  local target="$3"
  local module
  if ! module="$(find_packaged_module "$package_dir" "$module_stem")"; then
    echo "pgrx package did not produce module $module_stem.dylib under $package_dir" >&2
    exit 1
  fi
  mkdir -p "$(dirname "$target")"
  cp -p "$module" "$target"
}

artifact_payload_ready() {
  local index="$1"
  local sql_name="${sql_names[$index]}"
  local module_stem="${module_stems[$index]}"

  [ -f "$install_dir/share/postgresql/extension/$sql_name.control" ] || return 1
  compgen -G "$install_dir/share/postgresql/extension/$sql_name--*.sql" >/dev/null || return 1
  [ -f "$install_dir/lib/postgresql/$module_stem.dylib" ] || return 1
  [ -f "$embedded_modules_dir/$module_stem.dylib" ] || return 1
  module_depends_on_liboliphaunt "$install_dir/lib/postgresql/$module_stem.dylib" && return 1
  module_depends_on_liboliphaunt "$embedded_modules_dir/$module_stem.dylib" || return 1
  module_has_postgres_symbols_bound_to_liboliphaunt "$embedded_modules_dir/$module_stem.dylib" || return 1
}

artifact_ready() {
  local index="$1"
  local id="${ids[$index]}"
  local stamp
  stamp="$(artifact_stamp "$id")"

  artifact_payload_ready "$index" || return 1
  [ -f "$stamp" ] || return 1
  [ "$(cat "$stamp")" = "$(build_fingerprint "$index")" ] || return 1
}

refresh_candidate_stamp() {
  local index="$1"
  local id="${ids[$index]}"
  if ! artifact_payload_ready "$index"; then
    echo "external pgrx payload artifacts are missing or invalid for $id; rebuild before refreshing stamps" >&2
    exit 1
  fi
  write_artifact_stamp "$index"
  echo "external pgrx stamp refreshed for $id"
}

require_core_runtime() {
  if ! "$repo_root/src/runtimes/liboliphaunt/native/bin/build-postgres18-macos.sh" --check-oliphaunt-current >/dev/null; then
    echo "native liboliphaunt core runtime is missing or stale; refreshing core runtime first"
    OLIPHAUNT_BUILD_EXTENSIONS=0 "$repo_root/src/runtimes/liboliphaunt/native/bin/build-postgres18-macos.sh"
  fi
  [ -x "$install_dir/bin/pg_config" ] || {
    echo "native PostgreSQL install is missing pg_config at $install_dir/bin/pg_config" >&2
    exit 1
  }
}

require_pgrx_toolchain() {
  require_command cargo
  require_command rustc
  require_command rsync
  export PGRX_HOME="$pgrx_home"
  cargo pgrx --version >/dev/null 2>&1 || {
    cat >&2 <<'MSG'
missing cargo-pgrx. Install the version declared in
src/runtimes/liboliphaunt/native/postgres18/external-extensions.toml, for example:

  cargo install --locked cargo-pgrx --version 0.18.0 --root target/liboliphaunt-tools
MSG
    exit 1
  }
}

ensure_pgrx_home() {
  export PGRX_HOME="$pgrx_home"
  mkdir -p "$PGRX_HOME"
  if [ ! -f "$PGRX_HOME/config.toml" ] ||
    ! grep -q "$install_dir/bin/pg_config" "$PGRX_HOME/config.toml"; then
    run cargo pgrx init --pg18 "$install_dir/bin/pg_config"
  fi
}

verify_pgrx_version() {
  local expected="$1"
  local actual
  actual="$(cargo pgrx --version | awk '{print $2}')"
  if [ "$actual" != "$expected" ]; then
    echo "cargo-pgrx version mismatch: expected $expected, got $actual" >&2
    exit 1
  fi
}

build_candidate() {
  local index="$1"
  local id="${ids[$index]}"
  local checkout="${checkouts[$index]}"
  local source_dir
  local sql_name="${sql_names[$index]}"
  local module_stem="${module_stems[$index]}"
  local feature="${pg_features[$index]}"
  local pgrx_version="${pgrx_versions[$index]}"
  local normal_package="$package_root/$id/normal"
  local embedded_package="$package_root/$id/embedded"
  local normal_target="$target_root/$id/normal"
  local embedded_target="$target_root/$id/embedded"
  local stamp
  stamp="$(artifact_stamp "$id")"

  [ -d "$checkout/.git" ] || {
    echo "external pgrx checkout is missing for $id: $checkout" >&2
    echo "run: src/runtimes/liboliphaunt/native/bin/build-external-pgrx-extensions-macos.sh --fetch" >&2
    exit 1
  }
  checkout_clean_or_allowed "$checkout"
  if [ "$(git -C "$checkout" rev-parse HEAD)" != "${commits[$index]}" ]; then
    echo "external pgrx checkout for $id is not at pinned commit ${commits[$index]}" >&2
    exit 1
  fi
  [ -f "$checkout/${source_subdirs[$index]}/Cargo.toml" ] || {
    echo "external pgrx source for $id is missing Cargo.toml at $checkout/${source_subdirs[$index]}" >&2
    exit 1
  }

  verify_pgrx_version "$pgrx_version"
  local desired_hash
  desired_hash="$(build_fingerprint "$index")"
  if [ "${OLIPHAUNT_FORCE_EXTERNAL_PGRX_REBUILD:-0}" != "1" ] &&
    [ -f "$stamp" ] &&
    [ "$(cat "$stamp")" = "$desired_hash" ] &&
    artifact_ready "$index"; then
    echo "reusing external pgrx artifacts for $id"
    return
  fi

  require_free_space_for_candidate "$index"
  rm -rf "$normal_package" "$embedded_package"
  mkdir -p "$normal_package" "$embedded_package" "$normal_target" "$embedded_target" "$stamp_root"
  source_dir="$(prepare_source_stage "$index")"

  run env CARGO_TARGET_DIR="$normal_target" \
    RUSTFLAGS="$(normal_pgrx_rustflags)" \
    cargo pgrx package \
      --manifest-path "$source_dir/Cargo.toml" \
      --pg-config "$install_dir/bin/pg_config" \
      --out-dir "$normal_package" \
      --no-default-features \
      --features "$feature"

  copy_sql_assets "$normal_package" "$sql_name"
  copy_module_asset "$normal_package" "$module_stem" "$install_dir/lib/postgresql/$module_stem.dylib"
  if module_depends_on_liboliphaunt "$install_dir/lib/postgresql/$module_stem.dylib"; then
    echo "normal server module for $id unexpectedly links against liboliphaunt" >&2
    exit 1
  fi

  run env CARGO_TARGET_DIR="$embedded_target" \
    RUSTFLAGS="$(embedded_pgrx_rustflags)" \
    cargo pgrx package \
      --manifest-path "$source_dir/Cargo.toml" \
      --pg-config "$install_dir/bin/pg_config" \
      --out-dir "$embedded_package" \
      --no-default-features \
      --features "$feature"

  copy_module_asset "$embedded_package" "$module_stem" "$embedded_modules_dir/$module_stem.dylib"
  if ! module_depends_on_liboliphaunt "$embedded_modules_dir/$module_stem.dylib"; then
    echo "embedded module for $id is not linked against @rpath/liboliphaunt.dylib" >&2
    exit 1
  fi
  if ! module_has_postgres_symbols_bound_to_liboliphaunt "$embedded_modules_dir/$module_stem.dylib"; then
    echo "embedded module for $id does not bind PostgreSQL symbols to liboliphaunt" >&2
    exit 1
  fi

  write_artifact_stamp "$index"
  artifact_ready "$index" || {
    echo "external pgrx artifact validation failed for $id after build" >&2
    exit 1
  }
}

assert_manifest_and_pins() {
  run "$repo_root/src/runtimes/liboliphaunt/native/bin/check-external-extension-pins.sh"
}

if [ "$(uname -s)" != "Darwin" ]; then
  echo "external pgrx extension build currently targets the macOS native liboliphaunt lane" >&2
  exit 2
fi

assert_known_selection

case "$script_mode" in
  --print-required-artifacts)
    while IFS= read -r index; do
      printf 'control:%s\n' "${sql_names[$index]}"
      printf 'module:%s\n' "${module_stems[$index]}"
    done < <(selected_indices)
    exit 0
    ;;
  --fetch)
    assert_manifest_and_pins
    while IFS= read -r index; do
      fetch_candidate "$index"
    done < <(selected_indices)
    assert_manifest_and_pins
    exit 0
    ;;
  --check-current)
    assert_manifest_and_pins
    require_core_runtime
    require_pgrx_toolchain
    ensure_pgrx_home
    while IFS= read -r index; do
      if ! artifact_ready "$index"; then
        echo "external pgrx artifacts are missing or stale for ${ids[$index]}" >&2
        exit 1
      fi
    done < <(selected_indices)
    echo "external pgrx artifacts are current"
    exit 0
    ;;
  --refresh-current-stamps)
    assert_manifest_and_pins
    require_core_runtime
    require_pgrx_toolchain
    ensure_pgrx_home
    while IFS= read -r index; do
      refresh_candidate_stamp "$index"
    done < <(selected_indices)
    echo "external pgrx artifact stamps are current"
    exit 0
    ;;
  build)
    assert_manifest_and_pins
    require_core_runtime
    require_pgrx_toolchain
    ensure_pgrx_home
    while IFS= read -r index; do
      build_candidate "$index"
    done < <(selected_indices)
    echo "external pgrx artifacts are ready"
    ;;
  *)
    usage
    exit 2
    ;;
esac
