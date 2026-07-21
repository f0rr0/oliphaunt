#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "must run inside the Oliphaunt git checkout" >&2
  exit 1
}
cd "$root"

fail() {
  echo "$1" >&2
  exit 1
}

proto_version() {
  local tool="$1"
  awk -F '=' -v tool="$tool" '
    $1 ~ "^[[:space:]]*" tool "[[:space:]]*$" {
      value=$2
      gsub(/^[[:space:]"]+|[[:space:]"]+$/, "", value)
      print value
      found=1
    }
    END { if (!found) exit 1 }
  ' .prototools
}

version="$(proto_version bun)"
args=("$@")
# Bun's five-second default is too short for process-backed integration tests
# under aggregate CI load. Enforce one bounded default at the pinned launcher
# so direct files, Moon tasks, and workflow invocations share the same policy.
# An explicit CLI timeout remains available for a genuinely exceptional test.
if [[ "${args[0]:-}" == "test" ]]; then
  has_test_timeout=false
  for arg in "${args[@]:1}"; do
    case "$arg" in
      --timeout|--timeout=*)
        has_test_timeout=true
        break
        ;;
    esac
  done
  if [[ "$has_test_timeout" == false ]]; then
    args=(test --timeout=30000 "${args[@]:1}")
  fi
fi
if command -v bun >/dev/null 2>&1; then
  installed_version="$(bun --version 2>/dev/null || true)"
  if [[ "$installed_version" == "$version" ]]; then
    exec bun "${args[@]}"
  fi
fi
pinned_bun="$(bash tools/dev/install-pinned-js-runtime.sh bun --expected-version "$version")"
exec "$pinned_bun" "${args[@]}"
