#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "WASIX runtime link: $*" >&2
  exit 2
}

usage() {
  echo "usage: $0 BUILD_DIR ICU_PREFIX BRIDGE_OBJECT EXPORTS PROFILE" >&2
  exit 2
}

[ "$#" -eq 5 ] || usage
build_dir="$1"
icu_prefix="$2"
bridge_object="$3"
exports_file="$4"
profile="$5"

[ -z "${WASIXCC_LINKER_FLAGS:-}" ] ||
  fail "custom WASIXCC_LINKER_FLAGS are unsupported by the sealed runtime link"
case "$profile:${OLIPHAUNT_WASM_PROFILE_LDFLAGS:-}" in
  debug:|release:-flto=thin|release-o3:-flto=thin|release-os:|release-oz:) ;;
  *) fail "custom profile linker flags are unsupported by the sealed runtime link" ;;
esac
case "${WASIXCC_WASM_OPT_SUPPRESS_DEFAULT:-no}" in
  no|false|0) suppress_default=no ;;
  yes|true|1) suppress_default=yes ;;
  *) fail "WASIXCC_WASM_OPT_SUPPRESS_DEFAULT must be a boolean" ;;
esac
case "${WASIXCC_WASM_OPT_PRESERVE_UNOPTIMIZED:-no}" in
  no|false|0) ;;
  yes|true|1) fail "preserving an unoptimized runtime is unsupported by the sealed runtime link" ;;
  *) fail "WASIXCC_WASM_OPT_PRESERVE_UNOPTIMIZED must be a boolean" ;;
esac

for directory in "$build_dir" "$icu_prefix"; do
  [ -d "$directory" ] && [ ! -L "$directory" ] || fail "unsafe build input directory: $directory"
done
for input in \
  "$bridge_object" \
  "$exports_file" \
  "$build_dir/libpgcore.a" \
  "$build_dir/src/backend/main/main.o" \
  "$icu_prefix/lib/libicui18n.a" \
  "$icu_prefix/lib/libicuuc.a" \
  "$icu_prefix/lib/libicudata.a"
do
  [ -f "$input" ] && [ ! -L "$input" ] || fail "unsafe or missing link input: $input"
done

wasix_home="${WASIX_HOME:-}"
[ -n "$wasix_home" ] || fail "WASIX_HOME is not set"
linker="$wasix_home/llvm/bin/wasm-ld"
optimizer="$wasix_home/binaryen/bin/wasm-opt"
sysroot="$wasix_home/sysroot/sysroot-exnref-ehpic"
sysroot_lib="$sysroot/lib/wasm32-wasi"
[ -x "$linker" ] || fail "pinned wasm-ld is missing: $linker"
[ -x "$optimizer" ] || fail "pinned wasm-opt is missing: $optimizer"
[ -d "$sysroot_lib" ] && [ ! -L "$sysroot_lib" ] || fail "pinned WASIX sysroot is missing: $sysroot_lib"
[ "$("$optimizer" --version)" = "wasm-opt version 130 (version_130)" ] ||
  fail "unexpected wasm-opt identity"

LC_ALL=C sort -c -u "$exports_file" 2>/dev/null ||
  fail "export policy must be sorted and unique: $exports_file"
tail -c 1 "$exports_file" | od -An -t x1 | grep -Eq '^[[:space:]]*0a[[:space:]]*$' ||
  fail "export policy must end with LF: $exports_file"
if LC_ALL=C grep -q $'\r' "$exports_file"; then
  fail "export policy must not contain CR: $exports_file"
fi
awk '
  !/^[A-Za-z_][A-Za-z0-9_.$@]*$/ { exit 1 }
  END { if (NR == 0) exit 1 }
' "$exports_file" || fail "export policy contains an invalid symbol: $exports_file"

case "$profile" in
  debug) default_opt="" ;;
  release) default_opt="-O2" ;;
  release-o3) default_opt="-O3" ;;
  release-os) default_opt="-Os" ;;
  release-oz) default_opt="-Oz" ;;
  *) fail "unsupported build profile: $profile" ;;
esac

stage="$(mktemp -d "$build_dir/src/backend/.oliphaunt-link.XXXXXX")"
cleanup() {
  rm -rf -- "$stage"
}
trap cleanup EXIT

response="$stage/exports.rsp"
while IFS= read -r symbol; do
  printf '%s\n' "--export=$symbol"
done < "$exports_file" > "$response"

raw="$stage/oliphaunt.unoptimized.wasm"
"$linker" \
  -L"$build_dir/src/port" \
  -L"$build_dir/src/common" \
  -L"$icu_prefix/lib" \
  -lm \
  --no-entry \
  --extra-features=atomics \
  --extra-features=bulk-memory \
  --extra-features=mutable-globals \
  --shared-memory \
  --max-memory=4294967296 \
  --import-memory \
  --export=__wasm_call_ctors \
  --no-demangle \
  -mllvm --wasm-enable-eh \
  -mllvm --wasm-enable-sjlj \
  -mllvm --wasm-use-legacy-eh=false \
  -mllvm --exception-model=wasm \
  --export=__wasm_init_tls \
  --export=__wasm_signal \
  --export=__tls_size \
  --export=__tls_align \
  --export=__tls_base \
  --export-if-defined=__indirect_function_table \
  --export-if-defined=__stack_pointer \
  --export-if-defined=__heap_base \
  --export-if-defined=__data_end \
  --whole-archive \
  -L"$sysroot/lib" \
  -L"$sysroot_lib" \
  -lwasi-emulated-getpid \
  -lwasi-emulated-mman \
  -lwasi-emulated-process-clocks \
  -lc \
  -lresolv \
  -lrt \
  -lm \
  -lpthread \
  -lutil \
  --no-whole-archive \
  -lclang_rt.builtins-wasm32 \
  --experimental-pic \
  --export-if-defined=__wasm_apply_data_relocs \
  --export-if-defined=__wasm_apply_tls_relocs \
  -pie \
  -lcommon-tag-stubs \
  "@$response" \
  "$build_dir/libpgcore.a" \
  "$build_dir/src/backend/main/main.o" \
  "$bridge_object" \
  "$icu_prefix/lib/libicui18n.a" \
  "$icu_prefix/lib/libicuuc.a" \
  "$icu_prefix/lib/libicudata.a" \
  "$sysroot_lib/libc++.a" \
  "$sysroot_lib/libc++abi.a" \
  "$sysroot_lib/libunwind.a" \
  "$sysroot_lib/crt1.o" \
  -o "$raw"

final="$raw"
if [ "${WASIXCC_RUN_WASM_OPT:-yes}" = "yes" ]; then
  optimized="$stage/oliphaunt.wasm"
  opt_args=()
  if [ "$suppress_default" = no ] && [ -n "$default_opt" ]; then
    opt_args+=("$default_opt")
  fi
  opt_args+=(--emit-exnref)
  if [ -n "${WASIXCC_WASM_OPT_FLAGS:-}" ]; then
    IFS=: read -r -a configured_opt_args <<< "$WASIXCC_WASM_OPT_FLAGS"
    opt_args+=("${configured_opt_args[@]}")
  fi
  "$optimizer" "$raw" "${opt_args[@]}" -o "$optimized"
  final="$optimized"
elif [ "${WASIXCC_RUN_WASM_OPT:-yes}" != "no" ]; then
  fail "WASIXCC_RUN_WASM_OPT must be yes or no"
fi

[ -s "$final" ] || fail "linker produced an empty runtime"
chmod 0755 "$final"
mv -f -- "$final" "$build_dir/src/backend/oliphaunt"
echo "WASIX runtime link: sealed exports from $exports_file"
