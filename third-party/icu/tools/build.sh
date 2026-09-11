#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)/database-resources/icu/tools/data.sh"

oliphaunt_icu_source_dir() {
  local repo_root="${1:?repo root is required}"
  printf '%s\n' "${OLIPHAUNT_ICU_SOURCE_DIR:-$repo_root/target/oliphaunt-sources/checkouts/icu/icu4c/source}"
}

oliphaunt_icu_source_commit() {
  local source_dir="${1:?ICU source dir is required}"
  git -C "$source_dir/../../" rev-parse HEAD
}

oliphaunt_icu_script_sha256() {
  cat "${BASH_SOURCE[0]}" "$(dirname "${BASH_SOURCE[0]}")/../../../database-resources/icu/tools/data.sh" | shasum -a 256 | awk '{print $1}'
}

oliphaunt_icu_native_tools_stamp() {
  local source_dir="$1"
  {
    printf 'schema=oliphaunt-icu-native-tools-v4\n'
    printf 'source=%s\n' "$(oliphaunt_icu_source_commit "$source_dir")"
    printf 'script=%s\n' "$(oliphaunt_icu_script_sha256)"
    printf 'configure=static-no-tests-no-samples-no-extras-no-icuio-no-layoutex-tools-only\n'
  } | shasum -a 256 | awk '{print $1}'
}

oliphaunt_icu_target_stamp() {
  local source_dir="$1"
  local target_label="$2"
  local host="$3"
  local cc="$4"
  local cxx="$5"
  local ar="$6"
  local ranlib="$7"
  local cflags="$8"
  local cxxflags="${9}"
  local ldflags="${10}"
  {
    printf 'schema=oliphaunt-icu-target-v8\n'
    printf 'source=%s\n' "$(oliphaunt_icu_source_commit "$source_dir")"
    printf 'script=%s\n' "$(oliphaunt_icu_script_sha256)"
    printf 'target=%s\n' "$target_label"
    printf 'host=%s\n' "$host"
    printf 'cc=%s\n' "$cc"
    printf 'cxx=%s\n' "$cxx"
    printf 'ar=%s\n' "$ar"
    printf 'ranlib=%s\n' "$ranlib"
    printf 'cflags=%s\n' "$cflags"
    printf 'cxxflags=%s\n' "$cxxflags"
    printf 'ldflags=%s\n' "$ldflags"
    printf 'canonical-data-sha256=%s\n' "$(oliphaunt_icu_canonical_data_sha256)"
    printf 'configure=files-data-static-libs-static-consumer-no-extra-target-tools-stub-data-archive-pinned-upstream-data\n'
  } | shasum -a 256 | awk '{print $1}'
}

oliphaunt_icu_require_source() {
  local source_dir="${1:?ICU source dir is required}"
  if [ ! -x "$source_dir/configure" ]; then
    echo "missing ICU source checkout at $source_dir; run \`bash third-party/tools/fetch-sources.sh native-runtime --force\` first" >&2
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

oliphaunt_icu_build_native_tools() (
  set -e
  local source_dir="${1:?ICU source dir is required}"
  local native_build_dir="${2:?native build dir is required}"
  local jobs="${3:?jobs is required}"

  oliphaunt_icu_require_source "$source_dir"

  local stamp_file="$native_build_dir/.oliphaunt-icu-native-tools"
  local stamp
  stamp="$(oliphaunt_icu_native_tools_stamp "$source_dir")"
  if [ -f "$stamp_file" ] &&
     [ "$(cat "$stamp_file")" = "$stamp" ] &&
     oliphaunt_icu_native_tools_ready "$native_build_dir"; then
    return 0
  fi

  # ICU records this absolute build directory in its cross-build makefiles.
  # Restore the previous complete build at the same path if rebuilding fails.
  local backup rebuilding=0
  mkdir -p "$(dirname "$native_build_dir")"
  backup="$(mktemp -d "$native_build_dir.previous.XXXXXX")"
  trap 'status=$?; if [ "$status" -ne 0 ] && [ "$rebuilding" = 1 ]; then rm -rf "$native_build_dir"; if [ -d "$backup/build" ]; then mv "$backup/build" "$native_build_dir" || exit "$status"; fi; fi; rm -rf "$backup"' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  if [ -e "$native_build_dir" ]; then mv "$native_build_dir" "$backup/build"; fi
  rebuilding=1
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
)

oliphaunt_icu_publish_prefix() (
  set -e
  local staged="$1" prefix="$2" backup
  backup="$(mktemp -d "$prefix.previous.XXXXXX")"
  trap 'status=$?; if [ "$status" -ne 0 ] && [ ! -e "$prefix" ] && [ -d "$backup/prefix" ]; then mv "$backup/prefix" "$prefix" || exit "$status"; fi; rm -rf "$backup"' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  if [ -e "$prefix" ]; then mv "$prefix" "$backup/prefix"; fi
  mv "$staged" "$prefix"
)

oliphaunt_icu_build_target() (
  set -e
  local source_dir="${1:?ICU source dir is required}"
  local native_build_dir="${2:?native build dir is required}"
  local target_build_dir="${3:?target build dir is required}"
  local prefix="${4:?prefix is required}"
  local jobs="${5:?jobs is required}"
  local target_label="${6:?target label is required}"
  local host="${7:?host is required}"
  local cc="${8:?cc is required}"
  local cxx="${9:?cxx is required}"
  local ar="${10:?ar is required}"
  local ranlib="${11:?ranlib is required}"
  local cflags="${12:-}"
  local cxxflags="${13:-}"
  local ldflags="${14:-}"

  oliphaunt_icu_build_native_tools "$source_dir" "$native_build_dir" "$jobs"
  oliphaunt_icu_require_canonical_data "$(oliphaunt_icu_canonical_data_archive "$source_dir")"

  local stamp_file="$prefix/.oliphaunt-icu-build"
  local stamp
  stamp="$(oliphaunt_icu_target_stamp "$source_dir" "$target_label" "$host" "$cc" "$cxx" "$ar" "$ranlib" "$cflags" "$cxxflags" "$ldflags")"
  if [ -f "$stamp_file" ] &&
     [ "$(cat "$stamp_file")" = "$stamp" ] &&
     oliphaunt_icu_artifacts_ready "$prefix"; then
    return 0
  fi

  rm -rf "$target_build_dir"
  mkdir -p "$target_build_dir" "$(dirname "$prefix")"
  local install_stage staged_prefix
  install_stage="$(mktemp -d "$prefix.install.XXXXXX")"
  staged_prefix="$install_stage$prefix"
  trap 'rm -rf "$install_stage"' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
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
    local icu_data_name
    icu_data_name="$(
      awk -F' = ' '$1 == "ICUDATA_NAME" { print $2; exit }' \
        "$target_build_dir/config/Makefile.inc"
    )"
    if [[ ! "$icu_data_name" =~ ^icudt[0-9]+[a-z]+$ ]]; then
      echo "invalid ICU data name in $target_build_dir/config/Makefile.inc: $icu_data_name" >&2
      return 1
    fi
    # ICU 76.1 does not order genrb after cnvalias.icu. Complete the alias
    # file before parallel data generators can map a partially written file.
    make -j1 -C data "out/build/$icu_data_name/cnvalias.icu" PKGDATA_OPTS="$icu_pkgdata_opts"
    make -j"$jobs" PKGDATA_OPTS="$icu_pkgdata_opts"
    oliphaunt_icu_prepare_files_data_install_dirs "$target_build_dir" "$staged_prefix"
    make install DESTDIR="$install_stage" PKGDATA_OPTS="$icu_pkgdata_opts"
    make -j"$jobs" -C data packagedata PKGDATA_OPTS="$icu_pkgdata_opts"
    oliphaunt_icu_install_canonical_data "$(oliphaunt_icu_canonical_data_archive "$source_dir")" "$staged_prefix/share/icu"
    oliphaunt_icu_install_stub_data_archive "$target_build_dir" "$staged_prefix"
  )

  printf '%s\n' "$stamp" > "$staged_prefix/.oliphaunt-icu-build"
  oliphaunt_icu_artifacts_ready "$staged_prefix"
  oliphaunt_icu_publish_prefix "$staged_prefix" "$prefix"
)

oliphaunt_icu_cflags() {
  local prefix="${1:?prefix is required}"
  printf '%s\n' "-DU_STATIC_IMPLEMENTATION -I$prefix/include"
}

oliphaunt_icu_static_libs() {
  local prefix="${1:?prefix is required}"
  printf '%s\n' "$prefix/lib/libicui18n.a $prefix/lib/libicuuc.a $prefix/lib/libicudata.a"
}
