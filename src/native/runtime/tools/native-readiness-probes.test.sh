#!/usr/bin/env bash
set -euo pipefail
root="$(git rev-parse --show-toplevel)"
. "$root/src/native/runtime/bin/common.sh"
. "$root/src/native/runtime/bin/mobile-static-extensions.sh"


required_symbols='oliphaunt_builtin_dict_snowball_Pg_magic_func
dsnowball_init
pg_finfo_dsnowball_init
dsnowball_lexize
pg_finfo_dsnowball_lexize'

for symbol_prefix in '' '_'; do
  symbols="$({
    while IFS= read -r symbol; do
      printf '0000000000000000 T %s%s\n' "$symbol_prefix" "$symbol"
    done <<EOF
$required_symbols
EOF
    awk 'BEGIN { for (i = 0; i < 8192; i++) printf "%016x T unrelated_symbol_%06d_padding_padding_padding_padding_padding\n", i, i }'
  })"
  oliphaunt_mobile_builtin_snowball_linked_symbols_ready "$symbols"
done

while IFS= read -r omitted; do
  symbols="$({
    while IFS= read -r symbol; do
      [ "$symbol" = "$omitted" ] || printf '0000000000000000 T %s\n' "$symbol"
    done <<EOF
$required_symbols
EOF
  })"
  if oliphaunt_mobile_builtin_snowball_linked_symbols_ready "$symbols"; then
    echo "Snowball readiness accepted a payload without $omitted" >&2
    exit 1
  fi
done <<EOF
$required_symbols
EOF

dynamic_section=' 0x0000000000000001 (NEEDED)             Shared library: [liboliphaunt.so]'
oliphaunt_text_matches_ere "$dynamic_section" 'Shared library: [[]liboliphaunt[.]so[]]'
if oliphaunt_text_matches_ere "$dynamic_section" 'Shared library: [[]libother[.]so[]]'; then
  echo "native text probe accepted the wrong shared library" >&2
  exit 1
fi
device_metadata='      platform IOS'
simulator_metadata='      platform IOSSIMULATOR'
ios_device_pattern='(^|[[:space:]])platform[[:space:]]+IOS([[:space:]]|$)'
ios_simulator_pattern='(^|[[:space:]])platform[[:space:]]+IOSSIMULATOR([[:space:]]|$)'
oliphaunt_text_matches_ere "$device_metadata" "$ios_device_pattern"
oliphaunt_text_matches_ere "$simulator_metadata" "$ios_simulator_pattern"
if oliphaunt_text_matches_ere "$simulator_metadata" "$ios_device_pattern"; then
  echo "iOS device probe accepted an iOS simulator slice" >&2
  exit 1
fi

log="$(mktemp)"
trap 'rm -f "$log"' EXIT
awk 'BEGIN { for (i = 1; i <= 100; i++) { printf "%03d ", i; for (j = 0; j < 5000; j++) printf "x"; printf "\n" } }' > "$log"
excerpt="$(oliphaunt_tail_log_excerpt "$log" 10 200)"
[ "$(printf '%s\n' "$excerpt" | awk 'END { print NR }')" -eq 10 ]
printf '%s\n' "$excerpt" | awk 'length($0) > 221 { exit 1 }'

printf "native symbol, target, and bounded-log probes passed\n"

source_enumeration_work="$(mktemp -d)"
trap 'rm -f "$log"; rm -rf "$source_enumeration_work"' EXIT
for caller in build-macos-extension-archives.sh build-postgres18-ios-device.sh build-postgres18-ios-simulator.sh build-postgres18-android-arm64.sh; do
  for mode in failure intermediate_failure success; do
    case_dir="$source_enumeration_work/$caller-$mode"
    mkdir -p "$case_dir/source"
    : > "$case_dir/source/createas.c"
    : > "$case_dir/source/pg_ivm.c"
    if "$BASH" -s -- "$root" "$caller" "$case_dir" "$mode" > "$case_dir/output.log" 2>&1 <<'SH'
set -euo pipefail
root="$1"
caller="$2"
case_dir="$3"
mode="$4"
. "$root/src/native/runtime/bin/mobile-static-extensions.sh"
case "$caller" in
  build-macos-extension-archives.sh) build_function=build_static_extension_objects ;;
  *) build_function=build_mobile_static_extension_objects ;;
esac
eval "$(awk -v name="$build_function" '$0 == name "() {" { printing=1 } printing { print } printing && /^\}/ { exit }' "$root/src/native/runtime/bin/$caller")"
fail() { exit 1; }
oliphaunt_mobile_static_extension_module_stem() { printf 'fixture\n'; }
oliphaunt_mobile_static_extension_source_dir() { printf '%s\n' "$case_dir/source"; }
oliphaunt_mobile_static_extension_include_dirs() { :; }
oliphaunt_mobile_static_extension_cflags() { :; }
oliphaunt_mobile_static_extension_kind() { printf 'external\n'; }
oliphaunt_mobile_static_extension_source_files() {
  printf '%s\n' "$case_dir/source/createas.c"
  [ "$mode" != failure ] || return 37
  if [ "$mode" = intermediate_failure ]; then false; fi
  printf '%s\n' "$case_dir/source/pg_ivm.c"
}
compile_spy() {
  local previous='' source='' object='' argument
  for argument in "$@"; do
    case "$previous" in -c) source="$argument" ;; -o) object="$argument" ;; esac
    previous="$argument"
  done
  printf '%s\n' "$source" >> "$case_dir/compiled.list"
  printf '%s\n' "$@" > "$case_dir/$(basename "$source").args"
  : > "$object"
}
archive_mobile_static_extension_objects() { : > "$case_dir/archive.called"; }
repo_root="$root"
build_dir="$case_dir/build"
out_dir="$case_dir/out"
mobile_static_extensions=(fixture)
mobile_static_objects=()
cc=(compile_spy)
pg_extension_cflags='-O2 -DOLIPHAUNT_EMBEDDED'
pg_extension_cflag_args=(-O2 -DOLIPHAUNT_EMBEDDED)
"$build_function"
SH
    then
      status=0
    else
      status=$?
    fi
    if [ "$mode" != success ]; then
      expected_status=37
      [ "$mode" != intermediate_failure ] || expected_status=1
      if [ "$status" -ne "$expected_status" ] || [ -e "$case_dir/compiled.list" ] || [ -e "$case_dir/archive.called" ]; then
        echo "$caller compiled or archived a partial source enumeration" >&2
        exit 1
      fi
    else
      [ "$status" -eq 0 ] || { echo "$caller rejected complete source enumeration" >&2; exit 1; }
      printf '%s\n' "$case_dir/source/createas.c" "$case_dir/source/pg_ivm.c" > "$case_dir/expected.list"
      cmp -s "$case_dir/compiled.list" "$case_dir/expected.list"
      [ -e "$case_dir/archive.called" ]
      for source in createas.c pg_ivm.c; do
        grep -F -x -- '-DPg_magic_func=oliphaunt_static_fixture_Pg_magic_func' "$case_dir/$source.args" >/dev/null
        grep -F -x -- '-D_PG_init=oliphaunt_static_fixture__PG_init' "$case_dir/$source.args" >/dev/null
      done
    fi
  done
done
printf 'checked static extension source enumeration passed\n'
