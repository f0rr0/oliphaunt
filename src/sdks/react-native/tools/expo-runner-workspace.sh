#!/usr/bin/env bash

# Shared scratch-workspace and cluster-seed helpers for the React Native
# Expo mobile runners. Callers provide platform-specific variables such as
# scratch_root, example_dir, package_work, source_example_dir, rn_dir,
# mobile_packaging_initdb and react_native_package_extra_excludes.

react_native_package_extra_excludes=()

react_native_source_package_fingerprint() {
  node "$rn_dir/tools/react-native-package-inputs.mjs" \
    --root "$root" \
    --rn-dir "$rn_dir" \
    --example-package "$source_example_dir/package.json"
}

host_runtime_label() {
  case "$(uname -s):$(uname -m)" in
    Darwin:*) printf '%s\n' macos ;;
    Linux:x86_64|Linux:amd64) printf '%s\n' linux-x64-gnu ;;
    Linux:aarch64|Linux:arm64) printf '%s\n' linux-arm64-gnu ;;
    *) fail "unsupported host runtime build platform for mobile packaging: $(uname -s)/$(uname -m)" ;;
  esac
}

host_runtime_work_root() {
  case "$(host_runtime_label)" in
    macos) printf '%s\n' "${OLIPHAUNT_WORK_ROOT:-$root/target/liboliphaunt-pg18}" ;;
    linux-x64-gnu) printf '%s\n' "${OLIPHAUNT_LINUX_WORK_ROOT:-${OLIPHAUNT_WORK_ROOT:-$root/target/liboliphaunt-pg18-linux-x64-gnu}}" ;;
    linux-arm64-gnu) printf '%s\n' "${OLIPHAUNT_LINUX_WORK_ROOT:-${OLIPHAUNT_WORK_ROOT:-$root/target/liboliphaunt-pg18-linux-arm64-gnu}}" ;;
    *) fail "unsupported host runtime build platform for mobile packaging: $(uname -s)/$(uname -m)" ;;
  esac
}

host_runtime_install_dir() {
  printf '%s/install\n' "$(host_runtime_work_root)"
}

host_runtime_build_script() {
  case "$(host_runtime_label)" in
    macos) printf '%s\n' "$root/src/runtimes/liboliphaunt/native/bin/build-postgres18-macos.sh" ;;
    linux-x64-gnu|linux-arm64-gnu) printf '%s\n' "$root/src/runtimes/liboliphaunt/native/bin/build-postgres18-linux.sh" ;;
    *) fail "unsupported host runtime build platform for mobile packaging: $(uname -s)/$(uname -m)" ;;
  esac
}

host_runtime_ready() {
  local runtime_source="$1"
  [ -x "$runtime_source/bin/initdb" ] &&
    [ -f "$runtime_source/share/postgresql/postgres.bki" ] &&
    [ -f "$runtime_source/share/postgresql/postgresql.conf.sample" ]
}

ensure_host_runtime_assets() {
  local runtime_source
  runtime_source="$(host_runtime_install_dir)"
  if host_runtime_ready "$runtime_source"; then
    printf '%s\n' "$runtime_source"
    return
  fi
  if ! expo_allows_native_builds; then
    fail "host PostgreSQL runtime assets are missing and native builds are disabled; set OLIPHAUNT_EXPO_*_RUNTIME_DIR and OLIPHAUNT_EXPO_*_INITDB to prebuilt liboliphaunt artifacts"
  fi

  local label log build_script
  label="$(host_runtime_label)"
  build_script="$(host_runtime_build_script)"
  log="$scratch_root/logs/build-host-runtime-$label.log"
  mkdir -p "$(dirname "$log")"
  if ! "$build_script" --runtime-only >"$log" 2>&1; then
    tail -120 "$log" >&2 || true
    fail "failed to build host PostgreSQL runtime assets for mobile packaging; see $log"
  fi
  if ! host_runtime_ready "$runtime_source"; then
    tail -120 "$log" >&2 || true
    fail "host PostgreSQL runtime assets are incomplete after build: $runtime_source"
  fi
  printf '%s\n' "$runtime_source"
}

normalize_cluster_seed() {
  local pgdata="$1"
  local conf="$pgdata/postgresql.conf"
  [ -f "$conf" ] || return 0

  local tmp="$conf.liboliphaunt-normalized"
  awk '
    /^[[:space:]]*dynamic_shared_memory_type[[:space:]]*=/ {
      print "dynamic_shared_memory_type = mmap"
      next
    }
    /^[[:space:]]*log_timezone[[:space:]]*=/ {
      print "log_timezone = '\''UTC'\''"
      next
    }
    /^[[:space:]]*timezone[[:space:]]*=/ {
      print "timezone = '\''UTC'\''"
      next
    }
    /^[[:space:]]*lc_messages[[:space:]]*=/ {
      print "lc_messages = '\''C'\''"
      next
    }
    /^[[:space:]]*lc_monetary[[:space:]]*=/ {
      print "lc_monetary = '\''C'\''"
      next
    }
    /^[[:space:]]*lc_numeric[[:space:]]*=/ {
      print "lc_numeric = '\''C'\''"
      next
    }
    /^[[:space:]]*lc_time[[:space:]]*=/ {
      print "lc_time = '\''C'\''"
      next
    }
    { print }
  ' "$conf" > "$tmp"
  mv "$tmp" "$conf"
}

ensure_mobile_tool_executable() {
  local tool="$1"
  [ -n "$tool" ] || return 0
  [ -f "$tool" ] || return 0
  [ -x "$tool" ] && return 0
  chmod u+x "$tool" ||
    fail "mobile runtime tool is not executable and could not be repaired: $tool"
}

ensure_mobile_runtime_tool_permissions() {
  local runtime_source="$1"
  local tool
  for tool in postgres initdb pg_ctl pg_dump psql; do
    ensure_mobile_tool_executable "$runtime_source/bin/$tool"
  done
}

directory_fingerprint() {
  local dir="$1"
  (
    cd "$dir"
    find . -type f | LC_ALL=C sort | while IFS= read -r file; do
      shasum -a 256 "$file"
    done
  ) | shasum -a 256 | awk '{print $1}'
}

patch_expo_example_react_native_dependency() {
  local dependency_spec="$1"
  node - "$example_dir/package.json" "$dependency_spec" <<'NODE'
const fs = require('node:fs');
const [packageJson, dependencySpec] = process.argv.slice(2);
const pkg = JSON.parse(fs.readFileSync(packageJson, 'utf8'));
pkg.dependencies ??= {};
pkg.dependencies['@oliphaunt/react-native'] = dependencySpec;
fs.writeFileSync(packageJson, `${JSON.stringify(pkg, null, 2)}\n`);
NODE
}

write_scratch_pnpm_workspace() {
  mkdir -p "$scratch_root"
  cat >"$scratch_root/package.json" <<JSON
{
  "name": "${scratch_workspace_name:-oliphaunt-react-native-expo-workspace}",
  "private": true,
  "packageManager": "pnpm@11.5.0"
}
JSON
  node "$root/tools/dev/write-scoped-pnpm-workspace.mjs" \
    --source "$root/pnpm-workspace.yaml" \
    --output "$scratch_root/pnpm-workspace.yaml" \
    --package "src/sdks/react-native" \
    --package "examples/react-native-expo"
  if [ "$scratch_root/pnpm-lock.yaml" != "$root/pnpm-lock.yaml" ]; then
    cp "$root/pnpm-lock.yaml" "$scratch_root/pnpm-lock.yaml"
  fi
}

install_expo_example_dependencies() {
  if [ "$example_dir" = "$scratch_root/examples/react-native-expo" ]; then
    run pnpm --dir "$scratch_root" install --no-frozen-lockfile --prefer-offline --filter react-native-oliphaunt-expo
  else
    run pnpm --dir "$example_dir" install --no-frozen-lockfile --prefer-offline
  fi
}

install_react_native_package_dependencies() {
  if [ "$package_work" = "$scratch_root/src/sdks/react-native" ]; then
    run pnpm --dir "$scratch_root" install --frozen-lockfile --filter @oliphaunt/react-native
  else
    run pnpm --dir "$package_work" install --frozen-lockfile
  fi
}

prepare_expo_example_workspace() {
  need_cmd node
  need_cmd rsync
  write_scratch_pnpm_workspace
  mkdir -p "$scratch_root"
  if [ "$example_dir" = "$source_example_dir" ]; then
    return
  fi
  mkdir -p "$example_dir"
  rsync -a --delete \
    --exclude node_modules \
    --exclude .expo \
    --exclude android \
    --exclude ios \
    --exclude dist \
    --exclude web-build \
    "$source_example_dir/" "$example_dir/"
}

prepare_react_native_package_worktree() {
  need_cmd rsync
  write_scratch_pnpm_workspace
  rm -rf "$package_work"
  mkdir -p "$package_work"
  local rsync_args=(
    -a
    --delete
    --exclude node_modules
    --exclude lib
    --exclude .build
    --exclude android/.gradle
    --exclude android/.cxx
    --exclude android/build
  )
  if [ "${#react_native_package_extra_excludes[@]}" -gt 0 ]; then
    rsync_args+=(${react_native_package_extra_excludes[@]+"${react_native_package_extra_excludes[@]}"})
  fi
  rsync_args+=("$rn_dir/" "$package_work/")
  rsync "${rsync_args[@]}"
  mkdir -p "$package_work/src/generated"
  cp \
    "$root/src/extensions/generated/sdk/extensions.json" \
    "$package_work/src/generated/extensions.json"
  cp \
    "$root/src/extensions/generated/sdk/ios-static-dependencies.json" \
    "$package_work/src/generated/ios-static-dependencies.json"
  mkdir -p "$scratch_root/tools/dev"
  cp "$root/tools/dev/clean-package-lib.mjs" "$scratch_root/tools/dev/clean-package-lib.mjs"
  if [ -d "$rn_dir/node_modules" ]; then
    ln -s "$rn_dir/node_modules" "$package_work/node_modules"
  else
    install_react_native_package_dependencies
  fi
}
