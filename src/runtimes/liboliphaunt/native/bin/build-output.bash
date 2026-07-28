#!/usr/bin/env bash

oliphaunt_capture_build_artifact_path() {
  local description="${1:?oliphaunt_capture_build_artifact_path requires a description}"
  shift
  local log_file="${1:?oliphaunt_capture_build_artifact_path requires a log file}"
  shift
  local log_dir tmp status artifact

  log_dir="$(dirname "$log_file")"
  mkdir -p "$log_dir"
  tmp="$(mktemp "${TMPDIR:-/tmp}/oliphaunt-build-output.XXXXXX")"

  set +e
  "$@" 2>&1 | tee "$tmp" | tee "$log_file" >&2
  status="${PIPESTATUS[0]}"
  set -e

  if [ "$status" -ne 0 ]; then
    rm -f "$tmp"
    echo "error: $description failed; see $log_file" >&2
    return "$status"
  fi

  artifact=""
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    if [ -e "$line" ]; then
      artifact="$line"
    fi
  done < "$tmp"
  if [ -z "$artifact" ]; then
    artifact="$(awk 'NF { line = $0 } END { if (line != "") print line }' "$tmp")"
  fi
  rm -f "$tmp"
  if [ -z "$artifact" ]; then
    echo "error: $description did not print an artifact path; see $log_file" >&2
    return 1
  fi

  printf '%s\n' "$artifact"
}
