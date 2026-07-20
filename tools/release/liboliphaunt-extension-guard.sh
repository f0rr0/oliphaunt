#!/usr/bin/env bash

oliphaunt_assert_base_runtime_has_no_optional_extensions() {
  local catalog_file="${1:?missing extension catalog TSV}"
  local runtime="${2:?missing runtime root}"
  local extension_dir="$runtime/share/postgresql/extension"
  local module_dir="$runtime/lib/postgresql"
  local failures=()
  local sql_name pg_major creates_extension stem dependencies shared_preload desktop_prebuilt mobile_prebuilt mobile_static_required mobile_static_targets data_files artifact_policy

  while IFS=$'\t' read -r sql_name pg_major creates_extension stem dependencies shared_preload desktop_prebuilt mobile_prebuilt mobile_static_required mobile_static_targets data_files artifact_policy; do
    [ -n "$sql_name" ] || continue
    if [ -f "$extension_dir/$sql_name.control" ]; then
      failures+=("control:$sql_name")
    fi
    if [ "$stem" != "-" ]; then
      local suffix
      for suffix in dylib so dll; do
        if [ -f "$module_dir/$stem.$suffix" ]; then
          failures+=("module:$stem.$suffix")
        fi
      done
    fi
    if [ "$data_files" != "-" ]; then
      local data_file
      IFS=',' read -r -a data_file_array <<<"$data_files"
      for data_file in "${data_file_array[@]}"; do
        [ -n "$data_file" ] || continue
        if [ -e "$runtime/share/postgresql/$data_file" ]; then
          failures+=("data:$data_file")
        fi
      done
    fi
  done < <(awk -F '\t' 'NR > 1 { print }' "$catalog_file")

  if [ "${#failures[@]}" -gt 0 ]; then
    printf 'base liboliphaunt runtime contains optional extension artifact(s):\n' >&2
    printf '  %s\n' "${failures[@]}" >&2
    return 1
  fi
}

oliphaunt_assert_base_embedded_modules_exact() {
  local module_dir="${1:?missing embedded module directory}"
  local suffix="${2:?missing embedded module suffix}"
  local expected="plpgsql.$suffix"
  local failures=()

  if [ ! -d "$module_dir" ] || [ -L "$module_dir" ]; then
    echo "base liboliphaunt embedded module directory must be a real directory: $module_dir" >&2
    return 1
  fi

  local expected_path="$module_dir/$expected"
  if [ ! -f "$expected_path" ] || [ -L "$expected_path" ]; then
    failures+=("missing-or-nonregular:$expected")
  fi

  local entry
  while IFS= read -r -d '' entry; do
    if [ "$(basename "$entry")" != "$expected" ]; then
      failures+=("unexpected:$(basename "$entry")")
    fi
  done < <(find "$module_dir" -mindepth 1 -maxdepth 1 -print0)

  if [ "${#failures[@]}" -gt 0 ]; then
    printf 'base liboliphaunt embedded module inventory is not exact:\n' >&2
    printf '  %s\n' "${failures[@]}" >&2
    return 1
  fi
}
