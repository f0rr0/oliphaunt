#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "must run inside the Oliphaunt git checkout" >&2
  exit 1
}
cd "$root"

if [[ -z "${CARGO_REGISTRIES_OLIPHAUNT_LOCAL_INDEX:-}" ]]; then
  exec examples/tools/with-local-registries.sh bash "$0"
fi

run() {
  printf '\n==> %s\n' "$*"
  "$@"
}

source_dir="src/bindings/wasix-rust/examples/tauri-sqlx-vanilla"
workspace="target/oliphaunt-wasix-rust/examples/tauri-sqlx-vanilla/workspaces/$$"
work="$workspace/$source_dir"
trap 'rm -rf "$workspace"' EXIT
rm -rf "$workspace"
mkdir -p "$work" "$workspace/src/bindings/wasix-rust" "$workspace/src/runtimes/liboliphaunt"

rsync -a --delete \
  --exclude node_modules \
  --exclude dist \
  --exclude src-tauri/gen \
  --exclude src-tauri/target \
  "$source_dir/" "$work/"

ln -s "$root/src/bindings/wasix-rust/crates" "$workspace/src/bindings/wasix-rust/crates"
ln -s "$root/src/runtimes/liboliphaunt/wasix" "$workspace/src/runtimes/liboliphaunt/wasix"

run cargo generate-lockfile \
  --manifest-path "$work/src-tauri/Cargo.toml"
run cargo check \
  --manifest-path "$work/src-tauri/Cargo.toml" \
  --target-dir target/oliphaunt-wasix-rust/examples/tauri-sqlx-vanilla/src-tauri \
  --locked

cat >"$workspace/package.json" <<'JSON'
{
  "name": "oliphaunt-tauri-example-check-workspace",
  "private": true,
  "packageManager": "pnpm@11.5.0"
}
JSON
run node "$root/tools/dev/write-scoped-pnpm-workspace.mjs" \
  --source "$root/pnpm-workspace.yaml" \
  --output "$workspace/pnpm-workspace.yaml" \
  --package "src/bindings/wasix-rust/examples/tauri-sqlx-vanilla"
cp pnpm-lock.yaml "$workspace/pnpm-lock.yaml"

if [[ "${PNPM_CONFIG_LOCKFILE:-}" == "false" ]]; then
  run pnpm --dir "$work" install --no-frozen-lockfile
else
  run pnpm --dir "$work" install --frozen-lockfile
fi
run pnpm --dir "$work" run build
