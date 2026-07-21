#!/usr/bin/env sh
set -eu

usage() {
  echo "usage: tools/policy/run-gradle-lint-checked.sh <log-file> -- <command> [args...]" >&2
  exit 2
}

[ "$#" -ge 3 ] || usage
log_file="$1"
shift
[ "$1" = "--" ] || usage
shift
[ "$#" -gt 0 ] || usage

mkdir -p "$(dirname "$log_file")"

command_status=0
if "$@" >"$log_file" 2>&1; then
  :
else
  command_status="$?"
fi

# Gradle's Android Lint worker can print analyzer/compiler incompatibilities
# and still return success. Replay the complete combined output for CI and
# preserve a genuine command failure before checking for that false-green case.
cat "$log_file"
if [ "$command_status" -ne 0 ]; then
  exit "$command_status"
fi

forbidden_pattern='Module was compiled with an incompatible version of Kotlin|The binary version of its metadata is .*expected version is'
if grep -E -q "$forbidden_pattern" "$log_file"; then
  echo "Gradle Lint emitted fatal analyzer compatibility diagnostics despite exiting successfully:" >&2
  grep -E -n "$forbidden_pattern" "$log_file" >&2
  exit 1
fi
