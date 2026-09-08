#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
guard="$script_dir/verify_wasix_sjlj_artifact.sh"
scratch="$(mktemp -d "${TMPDIR:-/tmp}/oliphaunt-sjlj-guard.XXXXXX")"
cleanup() {
  rm -rf -- "$scratch"
}
trap cleanup EXIT

mkdir -p "$scratch/bin"
touch \
  "$scratch/good.wasm" \
  "$scratch/plain-setjmp.wasm" \
  "$scratch/missing-tag-symbol.wasm" \
  "$scratch/missing-test-symbol.wasm" \
  "$scratch/missing-catch.wasm" \
  "$scratch/disassembly-fails.wasm"

cat >"$scratch/bin/llvm-nm" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
artifact="${2:?artifact is required}"
case "$artifact" in
  *plain-setjmp*)
    printf '%s\n' '         U __c_longjmp' '         U __wasm_setjmp_test' '         U setjmp'
    ;;
  *missing-tag-symbol*)
    printf '%s\n' '         U __wasm_setjmp_test'
    ;;
  *missing-test-symbol*)
    printf '%s\n' '         U __c_longjmp'
    ;;
  *)
    printf '%s\n' '         U __c_longjmp' '         U __wasm_setjmp_test'
    ;;
esac
EOF

cat >"$scratch/bin/wasm-dis" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
artifact="${1:?artifact is required}"
case "$artifact" in
  *disassembly-fails*) exit 7 ;;
esac
printf '%s\n' \
  '(module' \
  ' (import "env" "__c_longjmp" (tag $eimport$0 (param i32)))'
case "$artifact" in
  *missing-catch*) ;;
  *) printf '%s\n' ' (func (try_table (catch $eimport$0 0) (nop)))' ;;
esac
printf '%s\n' ')'
EOF
chmod 0755 "$scratch/bin/llvm-nm" "$scratch/bin/wasm-dis"

bash "$guard" "$scratch/good.wasm" "$scratch/bin/llvm-nm" "$scratch/bin/wasm-dis"

expect_failure() {
  local artifact="$1"
  local expected="$2"
  if bash "$guard" "$scratch/$artifact" "$scratch/bin/llvm-nm" "$scratch/bin/wasm-dis" \
    >"$scratch/stdout" 2>"$scratch/stderr"; then
    echo "SJLJ artifact guard accepted invalid fixture: $artifact" >&2
    exit 1
  fi
  grep -F "$expected" "$scratch/stderr" >/dev/null || {
    echo "SJLJ artifact guard emitted the wrong failure for $artifact" >&2
    cat "$scratch/stderr" >&2
    exit 1
  }
}

expect_failure plain-setjmp.wasm 'unlowered SJLJ symbols remain'
expect_failure missing-tag-symbol.wasm '__c_longjmp'
expect_failure missing-test-symbol.wasm '__wasm_setjmp_test'
expect_failure missing-catch.wasm 'could not prove a lowered __c_longjmp try_table/catch'
expect_failure disassembly-fails.wasm 'could not prove a lowered __c_longjmp try_table/catch'

echo "WASIX SJLJ artifact guard: PASS"
