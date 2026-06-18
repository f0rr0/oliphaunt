#!/usr/bin/env bash
set -euo pipefail

oliphaunt_wasix_script_root() {
  cd "$(dirname "${BASH_SOURCE[1]}")" && pwd
}

oliphaunt_wasix_repo_root() {
  local root="$1"
  git -C "$root" rev-parse --show-toplevel 2>/dev/null || (cd "$root/../../../../../.." && pwd)
}

oliphaunt_wasix_generated_root() {
  local repo_root="$1"
  printf '%s\n' "${CONTAINER_GENERATED_ROOT:-${OLIPHAUNT_WASM_GENERATED_ROOT:-$repo_root/target/oliphaunt-wasix/wasix-build}}"
}

oliphaunt_wasix_run_extension_build_in_docker_if_needed() {
  local root="$1"
  local repo_root="$2"
  local source_lane="$3"
  local repo_relative_script="$4"
  local jobs="${JOBS:-4}"
  if [ "${OLIPHAUNT_WASM_EXTENSION_BUILD_IN_DOCKER:-0}" = "1" ] ||
     command -v wasixcc >/dev/null 2>&1; then
    return 0
  fi

  local image="${IMAGE:-oliphaunt-wasix-wasix-build:local}"
  local docker="${DOCKER:-$(command -v docker 2>/dev/null || true)}"
  if [ -z "$docker" ] && [ -x /usr/local/bin/docker ]; then
    docker=/usr/local/bin/docker
  fi
  if [ -z "$docker" ] && [ -x /opt/homebrew/bin/docker ]; then
    docker=/opt/homebrew/bin/docker
  fi
  if [ -z "$docker" ]; then
    echo "wasixcc and docker CLI not found; set DOCKER=/path/to/docker or install wasixcc" >&2
    exit 127
  fi
  export PATH="$(dirname "$docker"):$PATH"

  local docker_user_args=()
  if [ "${OLIPHAUNT_WASM_DOCKER_AS_ROOT:-0}" != "1" ]; then
    docker_user_args=(--user "$(id -u):$(id -g)" -e HOME=/tmp)
  fi
  if [ "${OLIPHAUNT_WASM_SKIP_IMAGE_BUILD:-0}" = "1" ]; then
    "$docker" image inspect "$image" >/dev/null 2>&1 || {
      echo "WASIX build image is missing: $image" >&2
      exit 1
    }
    echo "reusing Docker image $image"
  elif [ "${FORCE_IMAGE_BUILD:-0}" = "1" ] || ! "$docker" image inspect "$image" >/dev/null 2>&1; then
    "$docker" build \
      -t "$image" \
      -f "$root/docker/Dockerfile" \
      "$root/docker"
  else
    echo "reusing Docker image $image"
  fi

  "$docker" run --rm \
    "${docker_user_args[@]}" \
    --cpus="$jobs" \
    -e OLIPHAUNT_WASM_EXTENSION_BUILD_IN_DOCKER=1 \
    -e OLIPHAUNT_WASM_SOURCE_LANE="$source_lane" \
    -e JOBS="$jobs" \
    -e OLIPHAUNT_WASM_BUILD_PROFILE="${OLIPHAUNT_WASM_BUILD_PROFILE:-release}" \
    -e OLIPHAUNT_WASM_WASIX_COPT="${OLIPHAUNT_WASM_WASIX_COPT:-}" \
    -e OLIPHAUNT_WASM_WASIX_LOPT="${OLIPHAUNT_WASM_WASIX_LOPT:-}" \
    -e OLIPHAUNT_WASM_WASIX_CONFIGURE_WASM_OPT="${OLIPHAUNT_WASM_WASIX_CONFIGURE_WASM_OPT:-no}" \
    -e OLIPHAUNT_WASM_WASIX_BUILD_WASM_OPT="${OLIPHAUNT_WASM_WASIX_BUILD_WASM_OPT:-yes}" \
    -e OLIPHAUNT_WASM_WASM_OPT_FLAGS="${OLIPHAUNT_WASM_WASM_OPT_FLAGS-}" \
    -e OLIPHAUNT_WASM_WASM_OPT_SUPPRESS_DEFAULT="${OLIPHAUNT_WASM_WASM_OPT_SUPPRESS_DEFAULT-}" \
    -e OLIPHAUNT_WASM_WASM_OPT_PRESERVE_UNOPTIMIZED="${OLIPHAUNT_WASM_WASM_OPT_PRESERVE_UNOPTIMIZED-}" \
    -e OLIPHAUNT_WASM_WASIX_COMPILER_FLAGS="${OLIPHAUNT_WASM_WASIX_COMPILER_FLAGS:-}" \
    -e OLIPHAUNT_WASM_WASIX_LINKER_FLAGS="${OLIPHAUNT_WASM_WASIX_LINKER_FLAGS:-}" \
    -e WASIX_HOME=/opt/wasixcc-home/.wasixcc \
    -v "$repo_root:/work" \
    -w /work \
    "$image" \
    bash -lc "./$repo_relative_script"
  exit 0
}

oliphaunt_wasix_source_commit() {
  git -C "$1" rev-parse HEAD
}

oliphaunt_wasix_script_sha256() {
  sha256sum "$1" | awk '{print $1}'
}

oliphaunt_wasix_extension_wasix_target_values() {
  local repo_root="$1"
  local extension="$2"
  local key="$3"
  local target="$repo_root/src/extensions/external/$extension/targets/wasix.toml"
  python3 - "$target" "$key" <<'PY'
from __future__ import annotations

import sys
import tomllib
from pathlib import Path

target = Path(sys.argv[1])
key = sys.argv[2]
with target.open("rb") as handle:
    data = tomllib.load(handle)
values = data.get(key, [])
if not isinstance(values, list) or not all(isinstance(value, str) for value in values):
    raise SystemExit(f"{target} field {key} must be an array of strings")
for value in values:
    print(value)
PY
}

oliphaunt_wasix_extension_recipe_value() {
  local repo_root="$1"
  local extension="$2"
  local key="$3"
  local recipe="$repo_root/src/extensions/external/$extension/recipe.toml"
  python3 - "$recipe" "$key" <<'PY'
from __future__ import annotations

import sys
import tomllib
from pathlib import Path

recipe = Path(sys.argv[1])
key = sys.argv[2]
with recipe.open("rb") as handle:
    data = tomllib.load(handle)
value = data.get(key)
if not isinstance(value, str) or not value:
    raise SystemExit(f"{recipe} field {key} must be a non-empty string")
print(value)
PY
}

oliphaunt_wasix_extension_source_dir() {
  local repo_root="$1"
  local extension="$2"
  local source
  source="$(oliphaunt_wasix_extension_recipe_value "$repo_root" "$extension" source)"
  printf '%s\n' "$repo_root/target/oliphaunt-sources/checkouts/$source"
}

oliphaunt_wasix_extension_build_dir() {
  local build_root="$1"
  local extension="$2"
  printf '%s\n' "$build_root/$extension"
}

oliphaunt_wasix_extension_wasix_dependencies() {
  oliphaunt_wasix_extension_wasix_target_values "$1" "$2" dependencies
}

oliphaunt_wasix_extension_wasix_configure_flags() {
  oliphaunt_wasix_extension_wasix_target_values "$1" "$2" configure_flags
}

oliphaunt_wasix_extension_wasix_required_build_files() {
  oliphaunt_wasix_extension_wasix_target_values "$1" "$2" required_build_files
}

oliphaunt_wasix_extension_wasix_required_build_globs() {
  oliphaunt_wasix_extension_wasix_target_values "$1" "$2" required_build_globs
}

oliphaunt_wasix_extension_build_outputs_exist() {
  local repo_root="$1"
  local extension="$2"
  local build_dir="$3"
  local quiet=0
  if [ "${4:-}" = "--quiet" ]; then
    quiet=1
  fi

  local missing=0
  local required_file
  while IFS= read -r required_file; do
    [ -n "$required_file" ] || continue
    if [ ! -f "$build_dir/$required_file" ]; then
      if [ "$quiet" -ne 1 ]; then
        echo "missing WASIX $extension build output: $build_dir/$required_file" >&2
      fi
      missing=1
    fi
  done < <(oliphaunt_wasix_extension_wasix_required_build_files "$repo_root" "$extension")

  local required_glob
  while IFS= read -r required_glob; do
    [ -n "$required_glob" ] || continue
    if ! compgen -G "$build_dir/$required_glob" >/dev/null; then
      if [ "$quiet" -ne 1 ]; then
        echo "missing WASIX $extension build output matching: $build_dir/$required_glob" >&2
      fi
      missing=1
    fi
  done < <(oliphaunt_wasix_extension_wasix_required_build_globs "$repo_root" "$extension")

  [ "$missing" -eq 0 ]
}

oliphaunt_wasix_dependency_script_stem() {
  case "$1" in
    json-c) echo "jsonc" ;;
    *) echo "${1//-/_}" ;;
  esac
}

oliphaunt_wasix_dependency_env_prefix() {
  case "$1" in
    json-c) echo "JSONC" ;;
    *) echo "${1//-/_}" | tr '[:lower:]' '[:upper:]' ;;
  esac
}

oliphaunt_wasix_dependency_stamp_file() {
  case "$1" in
    *) echo ".oliphaunt-wasix-$1-build" ;;
  esac
}

oliphaunt_wasix_export_extension_dependency_prefixes() {
  local root="$1"
  local repo_root="$2"
  local extension="$3"
  local dependency script prefix env_prefix env_name
  while IFS= read -r dependency; do
    [ -n "$dependency" ] || continue
    script="$root/build_wasix_$(oliphaunt_wasix_dependency_script_stem "$dependency").sh"
    if [ ! -f "$script" ]; then
      echo "missing WASIX dependency build script for $extension dependency $dependency: $script" >&2
      exit 1
    fi
    env_prefix="$(oliphaunt_wasix_dependency_env_prefix "$dependency")"
    env_name="${env_prefix}_PREFIX"
    prefix="${!env_name:-}"
    if [ -z "$prefix" ]; then
      prefix="$("$script")"
    fi
    printf -v "$env_name" '%s' "$prefix"
    export "$env_name"
  done < <(oliphaunt_wasix_extension_wasix_dependencies "$repo_root" "$extension")
}

oliphaunt_wasix_extension_dependency_stamp_block() {
  local repo_root="$1"
  local extension="$2"
  local dependency env_prefix env_name prefix stamp_file
  while IFS= read -r dependency; do
    [ -n "$dependency" ] || continue
    env_prefix="$(oliphaunt_wasix_dependency_env_prefix "$dependency")"
    env_name="${env_prefix}_PREFIX"
    prefix="${!env_name:-}"
    if [ -z "$prefix" ]; then
      echo "missing exported dependency prefix $env_name for $extension" >&2
      exit 1
    fi
    stamp_file="$(oliphaunt_wasix_dependency_stamp_file "$dependency")"
    if [ ! -f "$prefix/$stamp_file" ]; then
      echo "missing WASIX dependency stamp for $extension dependency $dependency: $prefix/$stamp_file" >&2
      exit 1
    fi
    printf '%s=%s\n' "$dependency" "$(cat "$prefix/$stamp_file")"
  done < <(oliphaunt_wasix_extension_wasix_dependencies "$repo_root" "$extension")
}

oliphaunt_wasix_extension_configure_signature() {
  local repo_root="$1"
  local extension="$2"
  local flags=()
  local flag
  while IFS= read -r flag; do
    [ -n "$flag" ] && flags+=("$flag")
  done < <(oliphaunt_wasix_extension_wasix_configure_flags "$repo_root" "$extension")
  local joined
  joined="$(printf '%s\n' "${flags[@]}" | paste -sd ',' -)"
  printf '%s\n' "${joined:-none}"
}

oliphaunt_wasix_copy_source_clean() {
  local source_dir="$1"
  local build_dir="$2"
  rm -rf "$build_dir"
  mkdir -p "$build_dir"
  cp -a "$source_dir/." "$build_dir/"
  rm -rf "$build_dir/.git"
}

oliphaunt_wasix_write_cmake_toolchain() {
  local toolchain_file="$1"
  mkdir -p "$(dirname "$toolchain_file")"
  cat >"$toolchain_file" <<'EOF'
set(CMAKE_SYSTEM_NAME Generic)
set(CMAKE_C_COMPILER wasixcc)
set(CMAKE_CXX_COMPILER wasixcc++)
set(CMAKE_AR wasixar)
set(CMAKE_RANLIB wasixranlib)
set(CMAKE_C_COMPILER_WORKS TRUE)
set(CMAKE_CXX_COMPILER_WORKS TRUE)
set(CMAKE_TRY_COMPILE_TARGET_TYPE STATIC_LIBRARY)
set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_PACKAGE ONLY)
EOF
}

oliphaunt_wasix_static_cmake_build() {
  local source_dir="$1"
  local build_dir="$2"
  local prefix="$3"
  shift 3
  local toolchain_file="$build_dir/oliphaunt-wasix-toolchain.cmake"
  oliphaunt_wasix_write_cmake_toolchain "$toolchain_file"
  cmake -S "$source_dir" -B "$build_dir" \
    -DCMAKE_TOOLCHAIN_FILE="$toolchain_file" \
    -DCMAKE_INSTALL_PREFIX="$prefix" \
    -DCMAKE_BUILD_TYPE=Release \
    -DBUILD_SHARED_LIBS=OFF \
    -DCMAKE_C_VISIBILITY_PRESET=hidden \
    -DCMAKE_CXX_VISIBILITY_PRESET=hidden \
    -DCMAKE_VISIBILITY_INLINES_HIDDEN=ON \
    -DCMAKE_C_FLAGS="$OLIPHAUNT_WASM_PROFILE_CFLAGS -fPIC -fvisibility=hidden -Wno-unused-command-line-argument" \
    -DCMAKE_CXX_FLAGS="$OLIPHAUNT_WASM_PROFILE_CFLAGS -fPIC -fvisibility=hidden -fvisibility-inlines-hidden -Wno-unused-command-line-argument" \
    "$@"
  cmake --build "$build_dir" --parallel "$JOBS"
  cmake --install "$build_dir"
}
