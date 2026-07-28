#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "stage-tauri-webdriver-app.sh: must run inside the Oliphaunt git checkout" >&2
  exit 1
}
cd "$root"

fail() {
  echo "stage-tauri-webdriver-app.sh: $*" >&2
  exit 1
}

source_app_dir="${1:-}"
destination_root="${2:-}"
if [[ -z "$source_app_dir" || -z "$destination_root" ]]; then
  fail "usage: examples/tools/stage-tauri-webdriver-app.sh <tauri-example-dir> <destination-root>"
fi
for command_name in node realpath rsync; do
  command -v "$command_name" >/dev/null 2>&1 || fail "missing required command: $command_name"
done

if [[ "$source_app_dir" = /* ]]; then
  source_app_path="$(realpath -m "$source_app_dir")"
else
  source_app_path="$(realpath -m "$root/$source_app_dir")"
fi
case "$source_app_path" in
  "$root/examples/"*) ;;
  *) fail "Tauri webdriver examples must live under $root/examples: $source_app_dir" ;;
esac
[[ -f "$source_app_path/package.json" && -f "$source_app_path/src-tauri/Cargo.toml" ]] ||
  fail "$source_app_dir does not look like a Tauri example directory"
source_app_relative="${source_app_path#"$root"/}"
case "$source_app_relative" in
  examples/tauri|examples/tauri-wasix) ;;
  *) fail "unsupported Tauri webdriver example: $source_app_relative" ;;
esac

destination_root="$(realpath -m "$destination_root")"
case "$destination_root" in
  /|"$root"|"$root/examples"|"$root/examples/"*)
    fail "destination must not overlap the checkout or its example sources: $destination_root"
    ;;
esac
worktree="$destination_root/worktree"
rm -rf "$worktree"
mkdir -p "$worktree/examples"

# Keep the bounded example family at its repository-relative location. The
# Tauri variants deliberately share frontend sources, and relocating only one
# app silently breaks those relative imports.
for example in tauri tauri-wasix; do
  mkdir -p "$worktree/examples/$example"
  rsync -a --delete \
    --exclude node_modules \
    --exclude dist \
    --exclude src-tauri/gen \
    --exclude src-tauri/target \
    "$root/examples/$example/" "$worktree/examples/$example/"
done

# Tauri resolves bundle icons relative to src-tauri/tauri.conf.json. Copy each
# selected app icon as a regular file at the same repository-relative path so
# the scratch build has no symlink or live-checkout dependency.
config="$source_app_path/src-tauri/tauri.conf.json"
if [[ -f "$config" ]]; then
  while IFS= read -r asset_relative; do
    [[ -n "$asset_relative" ]] || continue
    mkdir -p "$worktree/$(dirname "$asset_relative")"
    cp -p "$root/$asset_relative" "$worktree/$asset_relative"
  done < <(
    node - "$config" "$root" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const [configFile, root] = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
const icons = config?.bundle?.icon ?? [];
if (!Array.isArray(icons) || !icons.every((value) => typeof value === "string")) {
  throw new Error(`${configFile}: bundle.icon must be an array of paths`);
}
for (const icon of icons) {
  const source = path.resolve(path.dirname(configFile), icon);
  const relative = path.relative(root, source);
  if (relative === "" || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${configFile}: bundle icon escapes the repository: ${icon}`);
  }
  if (/[\r\n\0]/u.test(relative)) {
    throw new Error(`${configFile}: bundle icon has an unsafe path: ${icon}`);
  }
  if (!fs.statSync(source).isFile()) {
    throw new Error(`${configFile}: bundle icon is not a regular file: ${icon}`);
  }
  process.stdout.write(`${relative.split(path.sep).join("/")}\n`);
}
NODE
  )
fi

app_dir="$worktree/$source_app_relative"
[[ -f "$app_dir/package.json" && -f "$app_dir/src-tauri/Cargo.toml" ]] ||
  fail "staged Tauri example is incomplete: $app_dir"
printf '%s\n' "$app_dir"
