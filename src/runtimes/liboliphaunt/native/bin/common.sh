#!/usr/bin/env sh

oliphaunt_resolve_repo_root() {
  script_dir="${1:?oliphaunt_resolve_repo_root requires a script directory}"
  if repo_root="$(git -C "$script_dir" rev-parse --show-toplevel 2>/dev/null)"; then
    printf '%s\n' "$repo_root"
    return 0
  fi
  cd "$script_dir/../../../../.." && pwd
}
