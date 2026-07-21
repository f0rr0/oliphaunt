#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "must run inside the Oliphaunt git checkout" >&2
  exit 1
}
cd "$root"

strict=0
if [[ "${1:-}" == "--strict" ]]; then
  strict=1
fi

failures=0
warnings=0

expected() {
  local tool="$1"
  awk -F '"' -v tool="$tool" '$1 ~ "^" tool " = " { print $2 }' .prototools
}

check_command() {
  local command="$1"
  local message="$2"
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "missing $command: $message" >&2
    failures=$((failures + 1))
    return 1
  fi
}

check_version() {
  local command="$1"
  local expected_version="$2"
  local actual="$3"
  local severity="${4:-error}"
  if [[ "$actual" != *"$expected_version"* ]]; then
    echo "$command version mismatch: expected $expected_version, got $actual" >&2
    if [[ "$severity" == "warning" ]]; then
      warnings=$((warnings + 1))
    else
      failures=$((failures + 1))
    fi
  else
    echo "$command ok: $actual"
  fi
}

proto_version="$(awk -F '"' '/^[[:space:]]+version: / { print $2; exit }' .moon/toolchains.yml)"
moon_version="$(expected moon)"
node_version="$(expected node)"
pnpm_version="$(expected pnpm)"
bun_version="$(expected bun)"
deno_version="$(expected deno)"
proto_bin="$(command -v proto 2>/dev/null || true)"
if [[ -z "$proto_bin" && -x "$HOME/.proto/bin/proto" ]]; then
  proto_bin="$HOME/.proto/bin/proto"
fi

check_command git "required for workspace root and affected checks" || true
check_command cargo "install Rust from rustup; CI uses Rust 1.93.1" || true
check_command node "run 'export PATH=\"\$(dirname \"\$(bash .github/actions/setup-moon/install-pinned-node.sh)\"):\$PATH\"'" || true
check_command pnpm "after installing pinned Node, run 'export PATH=\"\$(bash .github/actions/setup-node-pnpm/install-pinned-pnpm.sh)/bin:\$PATH\"'" || true
if [[ ! -x tools/dev/bun.sh ]]; then
  echo "missing tools/dev/bun.sh: TypeScript SDK checks need the pinned Bun launcher" >&2
  failures=$((failures + 1))
fi

if command -v pnpm >/dev/null 2>&1; then
  check_version pnpm "$pnpm_version" "$(pnpm --version 2>/dev/null || true)"
fi
if command -v bun >/dev/null 2>&1; then
  check_version bun "$bun_version" "$(bun --version 2>/dev/null || true)" warning
else
  echo "missing optional bun: TypeScript package checks will use tools/dev/bun.sh to download pinned Bun $bun_version on demand" >&2
fi
if command -v node >/dev/null 2>&1; then
  proto_node="$HOME/.proto/tools/node/$node_version/bin/node"
  if [[ -x "$proto_node" ]]; then
    echo "node ok: $node_version via proto toolchain"
    shell_node="$(node --version 2>/dev/null | sed 's/^v//')"
    if [[ "$shell_node" != "$node_version" ]]; then
      echo "node shell version differs from pinned toolchain: shell $shell_node, proto $node_version"
    fi
  else
    check_version node "$node_version" "$(node --version 2>/dev/null | sed 's/^v//')" warning
  fi
fi

if [[ -n "$proto_bin" ]]; then
  check_version proto "$proto_version" "$("$proto_bin" --version 2>/dev/null || true)"
else
  echo "proto is not on PATH; moon will manage proto $proto_version through its pinned setup"
fi

if command -v moon >/dev/null 2>&1; then
  check_version moon "$moon_version" "$(moon --version 2>/dev/null || true)"
else
  echo "missing moon: run 'export PATH=\"\$(bash .github/actions/setup-moon/install-pinned-toolchain.sh)/bin:\$PATH\"'" >&2
  failures=$((failures + 1))
fi

if command -v deno >/dev/null 2>&1; then
  check_version deno "$deno_version" "$(deno --version 2>/dev/null | head -n 1)" warning
else
  echo "missing optional deno: TypeScript package checks will use tools/dev/deno.sh to download pinned Deno $deno_version on demand" >&2
  [[ "$strict" -eq 0 ]] || failures=$((failures + 1))
fi

for optional in \
  actionlint \
  autoconf \
  aclocal \
  cargo-deny \
  cargo-hack \
  cargo-nextest \
  cargo-semver-checks \
  ccache \
  dprint \
  glibtoolize \
  lychee \
  prek \
  rg \
  shellcheck \
  shfmt \
  swift-format \
  swiftlint \
  taplo \
  typos \
  zizmor
do
  if command -v "$optional" >/dev/null 2>&1; then
    echo "$optional ok: $(command -v "$optional")"
  else
    echo "missing optional $optional: run tools/dev/bootstrap-tools.sh for maintainer gates" >&2
    [[ "$strict" -eq 0 ]] || failures=$((failures + 1))
  fi
done

if [[ "$failures" -ne 0 ]]; then
  echo "doctor found $failures tooling issue(s)" >&2
  exit 1
fi

if [[ "$warnings" -ne 0 ]]; then
  echo "doctor completed with $warnings advisory warning(s)" >&2
fi

echo "doctor passed"
