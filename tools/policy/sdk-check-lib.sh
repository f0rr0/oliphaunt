#!/usr/bin/env sh

root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "must run inside the Oliphaunt git checkout" >&2
  exit 1
}
cd "$root"

require_command() {
  command_name="$1"
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "missing required command: $command_name" >&2
    exit 1
  fi
}

require_command rg

require_file() {
  file="$1"
  if [ ! -f "$file" ]; then
    echo "missing required SDK parity file: $file" >&2
    exit 1
  fi
}

reject_file() {
  file="$1"
  message="$2"
  if [ -f "$file" ]; then
    echo "$message" >&2
    echo "unexpected SDK parity file: $file" >&2
    exit 1
  fi
}

require_text() {
  file="$1"
  text="$2"
  message="$3"
  if ! rg -q --fixed-strings -- "$text" "$file"; then
    echo "$message" >&2
    echo "expected '$text' in $file" >&2
    exit 1
  fi
}

require_no_files_under() {
  path="$1"
  message="$2"
  if [ -d "$path" ] && find "$path" -type f | grep -q .; then
    echo "$message" >&2
    find "$path" -type f >&2
    exit 1
  fi
}

reject_text() {
  file="$1"
  text="$2"
  message="$3"
  if rg -q --fixed-strings -- "$text" "$file"; then
    echo "$message" >&2
    echo "unexpected '$text' in $file" >&2
    exit 1
  fi
}

reject_tree_text() {
  path="$1"
  text="$2"
  message="$3"
  if [ -e "$path" ] && rg -n --fixed-strings -- "$text" "$path" >&2; then
    echo "$message" >&2
    echo "unexpected '$text' under $path" >&2
    exit 1
  fi
}
