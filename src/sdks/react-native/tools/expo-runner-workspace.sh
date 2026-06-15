#!/usr/bin/env bash

# Shared scratch-workspace and template-PGDATA helpers for the React Native
# Expo mobile runners. Callers provide platform-specific variables such as
# scratch_root, example_dir, package_work, source_example_dir, rn_dir,
# mobile_template_initdb, wal_segsize_mb, and react_native_package_extra_excludes.

react_native_package_extra_excludes=()

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

normalize_template_pgdata() {
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

prepare_mobile_template_pgdata() {
  local initdb="${mobile_template_initdb:-}"
  if [ -z "$initdb" ]; then
    local runtime_source
    runtime_source="$(ensure_host_runtime_assets)"
    initdb="$runtime_source/bin/initdb"
  fi
  local pgdata="$scratch_root/mobile-template-pgdata"
  local stamp="$pgdata/.liboliphaunt-mobile-template-v1"

  [ -x "$initdb" ] || return 1

  local wanted
  wanted="$(
    printf 'initdb=%s\n' "$initdb"
    shasum -a 256 "$initdb"
    shasum -a 256 "$script_path"
    printf 'locale=C\nencoding=UTF8\nnormalizer=mobile-template-v1\n'
    printf 'walSegsizeMB=%s\n' "$wal_segsize_mb"
  )"
  if [ -f "$pgdata/PG_VERSION" ] &&
    [ -f "$stamp" ] &&
    [ "$wanted" = "$(cat "$stamp")" ]; then
    printf '%s\n' "$pgdata"
    return
  fi

  rm -rf "$pgdata"
  mkdir -p "$pgdata"
  "$initdb" \
    -D "$pgdata" \
    -U postgres \
    --auth=trust \
    --no-sync \
    --locale=C \
    --wal-segsize="$wal_segsize_mb" \
    --encoding=UTF8 >/dev/null
  normalize_template_pgdata "$pgdata"
  printf '%s' "$wanted" > "$stamp"
  printf '%s\n' "$pgdata"
}

find_latest_mobile_pgdata() {
  local platform="$1"
  local configured="$2"
  local configured_template_env="$3"
  local initdb_env="$4"
  if [ -n "$configured" ]; then
    [ -f "$configured/PG_VERSION" ] || fail "template PGDATA is missing PG_VERSION: $configured"
    printf '%s\n' "$configured"
    return
  fi

  if prepare_mobile_template_pgdata; then
    return
  fi

  if [ "$wal_segsize_mb" != "16" ]; then
    fail "OLIPHAUNT_EXPO_MOBILE_WAL_SEGSIZE_MB=$wal_segsize_mb requires initdb so the mobile template PGDATA can be generated with --wal-segsize=$wal_segsize_mb; set $initdb_env or $configured_template_env"
  fi

  local selected=""
  local selected_mtime=0
  local version_file pgdata mtime
  while IFS= read -r version_file; do
    pgdata="$(dirname "$version_file")"
    [ -f "$pgdata/postgresql.conf" ] || continue
    mtime="$(stat_mtime "$pgdata")"
    if [ "$mtime" -gt "$selected_mtime" ]; then
      selected="$pgdata"
      selected_mtime="$mtime"
    fi
  done < <(find "$root/target/liboliphaunt-pg18" -path '*/.oliphaunt-pgdata/PG_VERSION' -type f 2>/dev/null)

  [ -n "$selected" ] || fail "no template PGDATA found for $platform; run src/runtimes/liboliphaunt/native/bin/smoke-host-happy-path.sh once or set $configured_template_env"
  printf '%s\n' "$selected"
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
  cat >"$scratch_root/pnpm-workspace.yaml" <<'YAML'
packages:
  - "src/sdks/react-native"
  - "src/sdks/react-native/examples/expo"

catalog:
  "@vitest/coverage-v8": ^4.1.8
  tsx: ^4.20.6
  typedoc: ^0.28.16
  typescript: ^5.9.3
  vitest: ^4.1.8

minimumReleaseAge: 1440
saveWorkspaceProtocol: rolling
updateNotifier: false

allowBuilds:
  esbuild: true
  msgpackr-extract: true
  unrs-resolver: true
YAML
  if [ "$scratch_root/pnpm-lock.yaml" != "$root/pnpm-lock.yaml" ]; then
    cp "$root/pnpm-lock.yaml" "$scratch_root/pnpm-lock.yaml"
  fi
}

install_expo_example_dependencies() {
  if [ "$example_dir" = "$scratch_root/src/sdks/react-native/examples/expo" ]; then
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
  if [ -d "$rn_dir/node_modules" ]; then
    ln -s "$rn_dir/node_modules" "$package_work/node_modules"
  else
    install_react_native_package_dependencies
  fi
}
