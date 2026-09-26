#!/usr/bin/env bash
set -euo pipefail
project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
source "$project_root/lib/common.sh"
source "$project_root/lib/sealed-carrier.sh"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
base="$work/guest"
mkdir -p "$base.generations" "$work/bin"
real_bun="$(command -v bun)"

fixture() {
  local stage relative _aliases _abi _extra
  stage="$(mktemp -d "$base.generations/.pending.XXXXXXXX")"
  mkdir -p "$stage/bin" "$stage/include" "$stage/lib/postgresql" "$stage/share/postgresql"
  printf 'header\n' >"$stage/include/postgres.h"
  printf '%s\n' "$1" >"$stage/bin/postgres"
  cp "$stage/bin/postgres" "$stage/bin/initdb"
  while IFS=$'\t' read -r relative _aliases _abi _extra; do
    case "$relative" in ''|'#'*) continue ;; esac
    mkdir -p "$(dirname "$stage/$relative")"
    printf 'side module\n' >"$stage/$relative"
  done <"$project_root/wasmer/policies/sealed-side-modules.v1.tsv"
  printf 'proof for %s\n' "$1" >"$stage/share/postgresql/proof.receipt"
  printf 'installed_closure_sha256=%s\n' \
    "$(bun "$project_root/lib/guest-build-provenance.mts" identity "$stage")" >"$stage/guest-build.receipt"
  printf '%s\n' "$stage"
}

old="$(fresh_publish_guest_generation "$(fixture old)" "$base")"
[ "$(fresh_resolve_guest_generation "$base")" = "$old" ]
[ "$(fresh_publish_guest_generation "$(fixture old)" "$base")" = "$old" ]
[ "$(cat "$old/bin/postgres")" = old ]

# Kill the real publisher at observable pre-publication/selection boundaries.
# Only the process boundary is shimmed; all hashing, fsync and renames are real.
cat >"$work/bin/bun" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
case "$1:${2:-}" in
  */guest-build-provenance.mts:seal-identity)
    if [ "$KILL_POINT" = before-directory ]; then kill -KILL "$GENERATION_PUBLISHER_PID"; exit 137; fi ;;
  */select-guest-generation.mts:*)
    if [ "$KILL_POINT" = before-selection ]; then kill -KILL "$GENERATION_PUBLISHER_PID"; exit 137; fi
    "$REAL_BUN" "$@"
    if [ "$KILL_POINT" = after-selection ]; then kill -KILL "$GENERATION_PUBLISHER_PID"; exit 137; fi
    exit 0 ;;
esac
exec "$REAL_BUN" "$@"
EOF
chmod +x "$work/bin/bun"
for point in before-directory before-selection after-selection; do
  stage="$(fixture "$point")"
  prior="$(fresh_resolve_guest_generation "$base")"
  if env PATH="$work/bin:$PATH" REAL_BUN="$real_bun" KILL_POINT="$point" \
    bash -c 'set -euo pipefail; source "$1/lib/common.sh"; source "$1/lib/sealed-carrier.sh"; export GENERATION_PUBLISHER_PID=$$; fresh_publish_guest_generation "$2" "$3"' \
    bash "$project_root" "$stage" "$base" >"$work/$point.log" 2>&1; then
    echo "publisher did not stop at $point" >&2; exit 1
  fi
  selected="$(fresh_resolve_guest_generation "$base")"
  if [ "$point" = after-selection ]; then
    [ "$(cat "$selected/bin/postgres")" = "$point" ]
  else
    [ "$selected" = "$prior" ]
  fi
  [ "$(cat "$old/bin/postgres")" = old ]
  # A retry either admits the new stage or verifies the already published tree.
  recovered="$(fresh_publish_guest_generation "$(fixture "$point")" "$base")"
  [ "$(cat "$recovered/bin/postgres")" = "$point" ]
done

# Concurrent publishers cannot replace or nest beneath the admitted directory.
first="$(fixture concurrent)"
second="$(fixture concurrent)"
fresh_publish_guest_generation "$first" "$base" >"$work/first.out" 2>"$work/first.err" &
first_pid=$!
fresh_publish_guest_generation "$second" "$base" >"$work/second.out" 2>"$work/second.err" &
second_pid=$!
first_status=0
second_status=0
wait "$first_pid" || first_status=$?
wait "$second_pid" || second_status=$?
[ "$first_status" = 0 ] || [ "$second_status" = 0 ]
selected="$(fresh_resolve_guest_generation "$base")"
[ "$(cat "$selected/bin/postgres")" = concurrent ]
[ "$(find "$selected" -name '.pending.*' | wc -l)" = 0 ]
[ "$(cat "$old/bin/postgres")" = old ]

# Corruption cannot be hidden by a matching generation directory name.
printf 'corrupt\n' >"$recovered/include/postgres.h"
if fresh_publish_guest_generation "$(fixture after-selection)" "$base" >/dev/null 2>&1; then
  echo 'corrupt existing generation accepted' >&2; exit 1
fi
printf '../escape\n' >"$base.current"
if fresh_resolve_guest_generation "$base" >/dev/null 2>&1; then
  echo 'escaping generation selection accepted' >&2; exit 1
fi
printf 'completed guest generation publication tests passed\n'
