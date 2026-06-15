#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "must run inside the Oliphaunt git checkout" >&2
  exit 1
}
cd "$root"

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
cat >"$workspace/pnpm-workspace.yaml" <<'YAML'
packages:
  - "src/bindings/wasix-rust/examples/tauri-sqlx-vanilla"
catalog:
  "@vitest/coverage-v8": ^4.1.8
  tsx: ^4.20.6
  typedoc: ^0.28.16
  typescript: ^5.9.3
  vitest: ^4.1.8
minimumReleaseAge: 1440
nodeLinker: hoisted
confirmModulesPurge: false
autoInstallPeers: false
saveWorkspaceProtocol: rolling
updateNotifier: false
verifyDepsBeforeRun: false

allowBuilds:
  core-js: false
  esbuild: true
  msgpackr-extract: true
  sharp: true
  unrs-resolver: true
YAML
cp pnpm-lock.yaml "$workspace/pnpm-lock.yaml"

run pnpm --dir "$work" install --frozen-lockfile
run pnpm --dir "$work" run build
