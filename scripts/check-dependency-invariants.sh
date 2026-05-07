#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$root"

blocked='wasm''time|wasm''time-wasi|wasmer-compiler-(llvm|cranelift|singlepass)|llvm-sys|cranelift-|singlepass'

if cargo tree -p pglite-oxide --features extensions --locked | rg -n "$blocked"; then
  cat >&2 <<'MSG'
blocked runtime dependency found in the normal user dependency tree.

The production path must stay on headless Wasmer AOT loading. Backend compiler
crates such as LLVM, Cranelift, Singlepass, and Wasmtime must not enter the
normal user build.
MSG
  exit 1
fi

if cargo tree -p xtask --features aot-serializer --locked | rg -n 'wasmer-compiler-(cranelift|singlepass)|cranelift-|singlepass|wasm''time'; then
  cat >&2 <<'MSG'
blocked maintainer serializer dependency found.

The AOT serializer may use Wasmer LLVM only. Cranelift, Singlepass, and Wasmtime
belong in isolated maintainer experiments, not in release/AOT tooling.
MSG
  exit 1
fi

echo "dependency invariants ok"
