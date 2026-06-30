#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "must run inside the Oliphaunt git checkout" >&2
  exit 1
}
cd "$root"

fail() {
  echo "run-electron-driver-smoke.sh: $*" >&2
  exit 1
}

app_dir="${1:-}"
if [ -z "$app_dir" ]; then
  fail "usage: examples/tools/run-electron-driver-smoke.sh <electron-example-dir>"
fi
if [ ! -f "$app_dir/package.json" ] || [ ! -f "$app_dir/src/main-process.ts" ]; then
  fail "$app_dir does not look like an Electron example directory"
fi

command -v node >/dev/null 2>&1 || fail "missing node"
command -v pnpm >/dev/null 2>&1 || fail "missing pnpm"

assert_npm_package() {
  local package_name="$1"
  local expected_version="$2"
  local resolver_package="${3:-}"
  examples/tools/with-local-registries.sh pnpm --dir "$app_dir" exec node - "$package_name" "$expected_version" "$resolver_package" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');

const [packageName, expectedVersion, resolverPackage] = process.argv.slice(2);
const resolvePaths = [process.cwd()];
if (resolverPackage) {
  const resolverPackageJson = require.resolve(`${resolverPackage}/package.json`, {
    paths: [process.cwd()],
  });
  resolvePaths.unshift(path.dirname(resolverPackageJson));
}
const packageJson = require.resolve(`${packageName}/package.json`, {
  paths: resolvePaths,
});
const data = JSON.parse(fs.readFileSync(packageJson, 'utf8'));
if (data.version !== expectedVersion) {
  throw new Error(`${packageName} resolved version ${data.version}, expected ${expectedVersion}`);
}
const normalized = packageJson.split(path.sep).join('/');
if (!normalized.includes('/node_modules/')) {
  throw new Error(`${packageName} resolved outside node_modules: ${packageJson}`);
}
NODE
}

electron_relative_path() {
  local platform="$1"
  local arch="$2"
  case "$platform/$arch" in
    linux/*)
      printf '%s\n' "electron"
      ;;
    darwin/*)
      printf '%s\n' "Electron.app/Contents/MacOS/Electron"
      ;;
    win32/*)
      printf '%s\n' "electron.exe"
      ;;
    *)
      fail "unsupported Electron e2e platform: $platform/$arch"
      ;;
  esac
}

repair_electron_install() {
  local electron_pkg="$1"
  local platform="$2"
  local arch="$3"
  local relative_path="$4"
  local electron_path="$electron_pkg/dist/$relative_path"

  if [ -x "$electron_path" ]; then
    return
  fi
  command -v unzip >/dev/null 2>&1 || fail "missing unzip required to repair Electron binary install"

  local version
  version="$(node -e 'process.stdout.write(require(process.argv[1]).version)' "$electron_pkg/package.json")"
  local archive_name="electron-v$version-$platform-$arch.zip"
  local archive=""
  for cache_root in "${electron_config_cache:-}" "$HOME/.cache/electron"; do
    if [ -n "$cache_root" ] && [ -d "$cache_root" ]; then
      archive="$(find "$cache_root" -name "$archive_name" -type f | sort | tail -n 1)"
      [ -n "$archive" ] && break
    fi
  done
  if [ -z "$archive" ]; then
    fail "Electron installed without $relative_path and cached $archive_name was not found"
  fi

  rm -rf "$electron_pkg/dist"
  mkdir -p "$electron_pkg/dist"
  unzip -q "$archive" -d "$electron_pkg/dist"
  printf '%s' "$relative_path" > "$electron_pkg/path.txt"
  if [ -f "$electron_pkg/dist/electron.d.ts" ]; then
    mv "$electron_pkg/dist/electron.d.ts" "$electron_pkg/electron.d.ts"
  fi
}

wasix_sidecar_env=()
prepare_wasix_sidecar() {
  if [ ! -f "$app_dir/src-wasix/Cargo.toml" ]; then
    return
  fi

  local scratch="$root/target/e2e/electron-sidecars/${app_dir//\//-}"
  rm -rf "$scratch"
  mkdir -p "$scratch"
  cp -R "$root/$app_dir/src-wasix/." "$scratch/"
  rm -f "$scratch/Cargo.lock"

  examples/tools/with-local-registries.sh cargo build \
    --quiet \
    --manifest-path "$scratch/Cargo.toml" \
    --target-dir "$scratch/target"

  local package_name
  package_name="$(
    awk -F'"' '
      $0 ~ /^\[package\]/ { in_package = 1; next }
      $0 ~ /^\[/ && $0 !~ /^\[package\]/ { in_package = 0 }
      in_package && $1 ~ /^name = / { print $2; exit }
    ' "$scratch/Cargo.toml"
  )"
  if [ -z "$package_name" ]; then
    fail "could not read package name from $scratch/Cargo.toml"
  fi
  local sidecar="$scratch/target/debug/$package_name"
  if [ ! -x "$sidecar" ]; then
    fail "missing built WASIX sidecar: $sidecar"
  fi
  wasix_sidecar_env=("OLIPHAUNT_WASIX_TODO_SIDECAR=$sidecar")
}

examples/tools/with-local-registries.sh pnpm --dir "$app_dir" install --no-frozen-lockfile
electron_pkg="$root/$app_dir/node_modules/electron"
electron_platform="$(node -p 'process.platform')"
electron_arch="$(node -p 'process.arch')"
electron_relative="$(electron_relative_path "$electron_platform" "$electron_arch")"
repair_electron_install "$electron_pkg" "$electron_platform" "$electron_arch" "$electron_relative"
electron="$electron_pkg/dist/$electron_relative"
if [ ! -x "$electron" ]; then
  fail "missing Electron executable at $electron after example install"
fi
if [ "$app_dir" = "examples/electron" ]; then
  assert_npm_package "@oliphaunt/ts" "0.1.0"
  assert_npm_package "@oliphaunt/liboliphaunt-linux-x64-gnu" "0.1.0" "@oliphaunt/ts"
  assert_npm_package "@oliphaunt/tools-linux-x64-gnu" "0.1.0" "@oliphaunt/ts"
  assert_npm_package "@oliphaunt/extension-hstore" "0.1.0"
fi
examples/tools/with-local-registries.sh pnpm --dir "$app_dir" build
prepare_wasix_sidecar

run_smoke=(
  env
  "OLIPHAUNT_E2E_ELECTRON=$electron"
  "OLIPHAUNT_E2E_ELECTRON_APP=$root/$app_dir"
  "${wasix_sidecar_env[@]}"
  examples/tools/with-local-registries.sh
  node
  "$root/examples/tools/electron-driver-smoke.mjs"
)

if command -v xvfb-run >/dev/null 2>&1; then
  xvfb-run -a "${run_smoke[@]}"
else
  "${run_smoke[@]}"
fi
