#!/usr/bin/env bash
set -euo pipefail

oliphaunt_icu_source_dir() {
  local repo_root="${1:?repo root is required}"
  printf '%s\n' "${OLIPHAUNT_ICU_SOURCE_DIR:-$repo_root/target/oliphaunt-sources/checkouts/icu/icu4c/source}"
}

oliphaunt_icu_source_commit() {
  local source_dir="${1:?ICU source dir is required}"
  git -C "$source_dir/../../" rev-parse HEAD
}

oliphaunt_icu_script_sha256() {
  local script_dir="${1:?script dir is required}"
  shasum -a 256 "$script_dir/icu.sh" | awk '{print $1}'
}

oliphaunt_icu_native_tools_stamp() {
  local source_dir="$1"
  local script_dir="$2"
  {
    printf 'schema=oliphaunt-icu-native-tools-v2\n'
    printf 'source=%s\n' "$(oliphaunt_icu_source_commit "$source_dir")"
    printf 'script=%s\n' "$(oliphaunt_icu_script_sha256 "$script_dir")"
    printf 'configure=static-no-tests-no-samples-no-extras-no-icuio-no-layoutex-tools-only\n'
  } | shasum -a 256 | awk '{print $1}'
}

oliphaunt_icu_target_stamp() {
  local source_dir="$1"
  local script_dir="$2"
  local target_label="$3"
  local host="$4"
  local cc="$5"
  local cxx="$6"
  local ar="$7"
  local ranlib="$8"
  local cflags="$9"
  local cxxflags="${10}"
  local ldflags="${11}"
  {
    printf 'schema=oliphaunt-icu-target-v5\n'
    printf 'source=%s\n' "$(oliphaunt_icu_source_commit "$source_dir")"
    printf 'script=%s\n' "$(oliphaunt_icu_script_sha256 "$script_dir")"
    printf 'target=%s\n' "$target_label"
    printf 'host=%s\n' "$host"
    printf 'cc=%s\n' "$cc"
    printf 'cxx=%s\n' "$cxx"
    printf 'ar=%s\n' "$ar"
    printf 'ranlib=%s\n' "$ranlib"
    printf 'cflags=%s\n' "$cflags"
    printf 'cxxflags=%s\n' "$cxxflags"
    printf 'ldflags=%s\n' "$ldflags"
    printf 'configure=files-data-static-libs-static-consumer-no-extra-target-tools-stub-data-archive\n'
  } | shasum -a 256 | awk '{print $1}'
}

oliphaunt_icu_require_source() {
  local source_dir="${1:?ICU source dir is required}"
  if [ ! -x "$source_dir/configure" ]; then
    echo "missing ICU source checkout at $source_dir; run \`cargo run -p xtask -- assets fetch\` first" >&2
    return 1
  fi
}

oliphaunt_icu_native_tool_names() {
  printf '%s\n' \
    makeconv \
    gencnval \
    gencfu \
    genbrk \
    gendict \
    genrb \
    gensprep \
    icupkg \
    pkgdata \
    genccode \
    gencmn
}

oliphaunt_icu_native_tools_ready() {
  local native_build_dir="${1:?native build dir is required}"
  [ -f "$native_build_dir/icudefs.mk" ] || return 1
  [ -f "$native_build_dir/config/icucross.mk" ] || return 1
  [ -f "$native_build_dir/config/icucross.inc" ] || return 1
  [ -f "$native_build_dir/lib/libicui18n.a" ] || return 1
  [ -f "$native_build_dir/lib/libicuuc.a" ] || return 1
  [ -f "$native_build_dir/stubdata/libicudata.a" ] || return 1
  [ -f "$native_build_dir/lib/libicutu.a" ] || return 1
  local tool
  while IFS= read -r tool; do
    [ -x "$native_build_dir/bin/$tool" ] || return 1
  done < <(oliphaunt_icu_native_tool_names)
}

oliphaunt_icu_stub_data_archive_ready() {
  local archive="${1:?ICU data archive is required}"
  [ -f "$archive" ] || return 1
  local members
  members="$(ar -t "$archive")" || return 1
  grep -Eq '^stubdata\.ao/?$' <<< "$members" || return 1
  ! grep -Eq '^icudt[0-9]+[a-z]*_dat\.o/?$' <<< "$members"
}

oliphaunt_icu_data_root_contains_data() {
  local data_root="${1:?ICU data root is required}"
  [ -d "$data_root" ] || return 1
  local root_name
  root_name="$(basename "$data_root")"
  if [[ "$root_name" == icudt* ]] &&
     find "$data_root" -mindepth 1 -type f -print -quit 2>/dev/null | grep -q .; then
    return 0
  fi
  if compgen -G "$data_root/icudt*.dat" >/dev/null; then
    return 0
  fi
  local child
  while IFS= read -r child; do
    if find "$child" -type f -print -quit 2>/dev/null | grep -q .; then
      return 0
    fi
  done < <(find "$data_root" -mindepth 1 -maxdepth 1 -type d -name 'icudt*' 2>/dev/null | LC_ALL=C sort)
  return 1
}

oliphaunt_icu_files_data_ready() {
  local data_root="${1:?ICU data root is required}"
  oliphaunt_icu_data_root_contains_data "$data_root" && return 0
  local child
  while IFS= read -r child; do
    if oliphaunt_icu_data_root_contains_data "$child"; then
      return 0
    fi
  done < <(find "$data_root" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | LC_ALL=C sort)
  return 1
}

oliphaunt_icu_artifacts_ready() {
  local prefix="${1:?ICU prefix is required}"
  [ -f "$prefix/.oliphaunt-icu-build" ] || return 1
  [ -f "$prefix/include/unicode/ucol.h" ] || return 1
  [ -f "$prefix/lib/libicui18n.a" ] || return 1
  [ -f "$prefix/lib/libicuuc.a" ] || return 1
  oliphaunt_icu_stub_data_archive_ready "$prefix/lib/libicudata.a" || return 1
  oliphaunt_icu_files_data_ready "$prefix/share/icu"
}

oliphaunt_icu_linked_symbols_ready() {
  local symbols="${1-}"
  local data_symbol_re
  data_symbol_re='(^|[[:space:]])_?icudt[0-9]+[a-z]*_dat($|[[:space:]])'
  [ -n "$symbols" ] || return 1
  grep -Eq '(^|[[:space:]])_?ucol_open(_[0-9]+)?($|[[:space:]])' <<< "$symbols" || return 1
  ! grep -Eq '(^|[[:space:]])_?pg_register_static_icu_data($|[[:space:]])' <<< "$symbols" || return 1

  local line address size_or_type type_or_symbol symbol_name
  while IFS= read -r line; do
    [[ "$line" =~ $data_symbol_re ]] || continue
    read -r address size_or_type type_or_symbol symbol_name _ <<< "$line"
    if [[ "$size_or_type" =~ ^[[:xdigit:]]+$ ]] && [[ "$type_or_symbol" =~ ^[A-Za-z]$ ]]; then
      [ "$((16#$size_or_type))" -le 4096 ] || return 1
    fi
  done <<< "$symbols"
}

oliphaunt_icu_install_stub_data_archive() {
  local target_build_dir="${1:?target ICU build dir is required}"
  local prefix="${2:?ICU prefix is required}"
  local built_archive="$target_build_dir/stubdata/libicudata.a"
  local installed_archive="$prefix/lib/libicudata.a"
  local tmp_archive="$installed_archive.tmp"

  oliphaunt_icu_stub_data_archive_ready "$built_archive"
  mkdir -p "$prefix/lib"
  rm -f "$tmp_archive"
  cp "$built_archive" "$tmp_archive"
  chmod 0644 "$tmp_archive"
  mv "$tmp_archive" "$installed_archive"
}

oliphaunt_icu_built_files_data_dir() {
  local target_build_dir="${1:?target ICU build dir is required}"
  local build_root="$target_build_dir/data/out/build"
  local -a candidates=()
  local child
  while IFS= read -r child; do
    if oliphaunt_icu_data_root_contains_data "$child"; then
      candidates+=("$child")
    fi
  done < <(find "$build_root" -mindepth 1 -maxdepth 1 -type d -name 'icudt*' 2>/dev/null | LC_ALL=C sort)
  [ "${#candidates[@]}" -eq 1 ] || return 1
  printf '%s\n' "${candidates[0]}"
}

oliphaunt_icu_install_files_data() {
  local target_build_dir="${1:?target ICU build dir is required}"
  local prefix="${2:?ICU prefix is required}"
  local source
  source="$(oliphaunt_icu_built_files_data_dir "$target_build_dir")" || return 1
  local destination="$prefix/share/icu/$(basename "$source")"
  local tmp_destination="$destination.tmp"

  rm -rf "$tmp_destination"
  mkdir -p "$prefix/share/icu"
  cp -pR "$source" "$tmp_destination"
  rm -rf "$destination"
  mv "$tmp_destination" "$destination"
  oliphaunt_icu_files_data_ready "$prefix/share/icu"
}

oliphaunt_icu_prepare_files_data_install_dirs() {
  local target_build_dir="${1:?target ICU build dir is required}"
  local prefix="${2:?ICU prefix is required}"
  local build_data_root="$target_build_dir/data/out/build"
  [ -d "$build_data_root" ] || return 0

  local version
  version="$(
    awk -F' = ' '$1 == "VERSION" { print $2; exit }' "$target_build_dir/config/Makefile.inc"
  )"
  [ -n "$version" ] || {
    echo "unable to determine ICU version from $target_build_dir/config/Makefile.inc" >&2
    return 1
  }

  local install_data_root="$prefix/share/icu/$version"
  mkdir -p "$install_data_root"
  while IFS= read -r dir; do
    local relative="${dir#"$build_data_root"/}"
    [ "$relative" != "$dir" ] || continue
    mkdir -p "$install_data_root/$relative"
  done < <(find "$build_data_root" -type d -print)
}

oliphaunt_icu_data_source_dir() {
  local prefix="${1:?ICU prefix is required}"
  local installed_icu="$prefix/share/icu"
  if oliphaunt_icu_data_root_contains_data "$installed_icu"; then
    printf '%s\n' "$installed_icu"
    return 0
  fi

  local child
  while IFS= read -r child; do
    if [ -d "$child" ] && oliphaunt_icu_data_root_contains_data "$child"; then
      printf '%s\n' "$child"
      return 0
    fi
  done < <(find "$installed_icu" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | LC_ALL=C sort)
  return 1
}

oliphaunt_icu_stage_data() {
  local prefix="${1:?ICU prefix is required}"
  local destination="${2:?destination ICU data root is required}"
  local source
  source="$(oliphaunt_icu_data_source_dir "$prefix")" || return 1
  rm -rf "$destination"
  mkdir -p "$destination"
  cp -pR "$source/." "$destination/"
  oliphaunt_icu_files_data_ready "$destination"
}

oliphaunt_icu_build_native_tools() {
  local source_dir="${1:?ICU source dir is required}"
  local script_dir="${2:?script dir is required}"
  local native_build_dir="${3:?native build dir is required}"
  local jobs="${4:?jobs is required}"

  oliphaunt_icu_require_source "$source_dir"

  local stamp_file="$native_build_dir/.oliphaunt-icu-native-tools"
  local stamp
  stamp="$(oliphaunt_icu_native_tools_stamp "$source_dir" "$script_dir")"
  if [ -f "$stamp_file" ] &&
     [ "$(cat "$stamp_file")" = "$stamp" ] &&
     oliphaunt_icu_native_tools_ready "$native_build_dir"; then
    return 0
  fi

  rm -rf "$native_build_dir"
  mkdir -p "$native_build_dir"
  (
    cd "$native_build_dir"
    "$source_dir/configure" \
      --disable-shared \
      --enable-static \
      --disable-tests \
      --disable-samples \
      --disable-extras \
      --disable-icuio \
      --disable-layoutex
    make all-local
    mkdir -p lib bin
    make -j"$jobs" -C stubdata
    make -j"$jobs" -C common
    make -j"$jobs" -C i18n
    make -j"$jobs" -C tools/toolutil
    local tool
    while IFS= read -r tool; do
      make -j"$jobs" -C "tools/$tool"
    done < <(oliphaunt_icu_native_tool_names)
  )
  oliphaunt_icu_native_tools_ready "$native_build_dir"
  printf '%s\n' "$stamp" > "$stamp_file"
}

oliphaunt_icu_build_target() {
  local source_dir="${1:?ICU source dir is required}"
  local script_dir="${2:?script dir is required}"
  local native_build_dir="${3:?native build dir is required}"
  local target_build_dir="${4:?target build dir is required}"
  local prefix="${5:?prefix is required}"
  local jobs="${6:?jobs is required}"
  local target_label="${7:?target label is required}"
  local host="${8:?host is required}"
  local cc="${9:?cc is required}"
  local cxx="${10:?cxx is required}"
  local ar="${11:?ar is required}"
  local ranlib="${12:?ranlib is required}"
  local cflags="${13:-}"
  local cxxflags="${14:-}"
  local ldflags="${15:-}"

  oliphaunt_icu_build_native_tools "$source_dir" "$script_dir" "$native_build_dir" "$jobs"

  local stamp_file="$prefix/.oliphaunt-icu-build"
  local stamp
  stamp="$(oliphaunt_icu_target_stamp "$source_dir" "$script_dir" "$target_label" "$host" "$cc" "$cxx" "$ar" "$ranlib" "$cflags" "$cxxflags" "$ldflags")"
  if [ -f "$stamp_file" ] &&
     [ "$(cat "$stamp_file")" = "$stamp" ] &&
     oliphaunt_icu_artifacts_ready "$prefix"; then
    return 0
  fi

  rm -rf "$target_build_dir" "$prefix"
  mkdir -p "$target_build_dir" "$(dirname "$prefix")"
  (
    cd "$target_build_dir"
    CC="$cc" \
    CXX="$cxx" \
    AR="$ar" \
    RANLIB="$ranlib" \
    CFLAGS="$cflags" \
    CXXFLAGS="$cxxflags" \
    LDFLAGS="$ldflags" \
      "$source_dir/configure" \
        --host="$host" \
        --with-cross-build="$native_build_dir" \
        --with-data-packaging=files \
        --disable-shared \
        --enable-static \
        --disable-tests \
        --disable-samples \
        --disable-tools \
        --disable-extras \
        --disable-icuio \
        --disable-layoutex \
        --prefix="$prefix"
    local icu_pkgdata_opts="-O $target_build_dir/data/icupkg.inc -w"
    make -j"$jobs" PKGDATA_OPTS="$icu_pkgdata_opts"
    oliphaunt_icu_prepare_files_data_install_dirs "$target_build_dir" "$prefix"
    make install PKGDATA_OPTS="$icu_pkgdata_opts"
    make -j"$jobs" -C data packagedata PKGDATA_OPTS="$icu_pkgdata_opts"
    oliphaunt_icu_install_files_data "$target_build_dir" "$prefix"
    oliphaunt_icu_install_stub_data_archive "$target_build_dir" "$prefix"
  )

  test -f "$prefix/include/unicode/ucol.h"
  test -f "$prefix/lib/libicui18n.a"
  test -f "$prefix/lib/libicuuc.a"
  oliphaunt_icu_stub_data_archive_ready "$prefix/lib/libicudata.a"
  oliphaunt_icu_files_data_ready "$prefix/share/icu"
  printf '%s\n' "$stamp" > "$stamp_file"
}

oliphaunt_icu_cflags() {
  local prefix="${1:?prefix is required}"
  printf '%s\n' "-DU_STATIC_IMPLEMENTATION -I$prefix/include"
}

oliphaunt_icu_static_libs() {
  local prefix="${1:?prefix is required}"
  printf '%s\n' "$prefix/lib/libicui18n.a $prefix/lib/libicuuc.a $prefix/lib/libicudata.a"
}
