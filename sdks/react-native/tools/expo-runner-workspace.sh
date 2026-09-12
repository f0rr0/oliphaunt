#!/usr/bin/env bash

# Shared scratch-workspace helpers for the React Native
# Expo mobile runners. Callers provide platform-specific variables such as
# scratch_root, example_dir, package_work, source_example_dir, rn_dir,
# react_native_package_extra_excludes.

react_native_package_extra_excludes=()

react_native_source_package_fingerprint() {
  bun "$rn_dir/tools/react-native-package-inputs.mts" \
    --root "$root" \
    --rn-dir "$rn_dir" \
    --example-package "$source_example_dir/package.json"
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
  if expo_requires_sdk_artifacts; then
    local query_artifact
    query_artifact="$(expo_single_sdk_artifact_file oliphaunt-query-ts '*.tgz')" || return
    bun "$root/sdks/react-native/tools/expo-runner-common.mts" check-query-dependency \
      "${dependency_spec#file:}" "$query_artifact" || return
  fi
  bun "$root/sdks/react-native/tools/expo-runner-common.mts" patch-dependency "$example_dir/package.json" "$dependency_spec"
}

write_scratch_bun_workspace() {
  local query_artifact=""
  if expo_requires_sdk_artifacts; then
    query_artifact="$(expo_single_sdk_artifact_file oliphaunt-query-ts '*.tgz')" || return
  fi
  bun "$root/sdks/react-native/tools/expo-runner-common.mts" workspace \
    "$root" "$scratch_root" "${scratch_workspace_name:-oliphaunt-react-native-expo-workspace}" "$query_artifact"
}
install_expo_example_dependencies() {
  if [ "$example_dir" = "$scratch_root/examples/react-native-expo" ]; then
    if expo_requires_sdk_artifacts; then
      run bun install --cwd "$scratch_root" --prefer-offline
    else
      run bun install --cwd "$scratch_root" --prefer-offline --filter react-native-oliphaunt-expo
    fi
  else
    run bun install --cwd "$example_dir" --prefer-offline
  fi
}

install_react_native_package_dependencies() {
  if [ "$package_work" = "$scratch_root/sdks/react-native" ]; then
    run bun install --cwd "$scratch_root" --filter @oliphaunt/react-native
  else
    run bun install --cwd "$package_work"
  fi
}

prepare_expo_example_workspace() {
  need_cmd bun
  need_cmd rsync
  write_scratch_bun_workspace
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
  write_scratch_bun_workspace
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
    "$root/extensions/generated/sdk/extensions.json" \
    "$package_work/src/generated/extensions.json"
  cp \
    "$root/extensions/generated/sdk/ios-static-dependencies.json" \
    "$package_work/src/generated/ios-static-dependencies.json"
  if [ -d "$rn_dir/node_modules" ]; then
    ln -s "$rn_dir/node_modules" "$package_work/node_modules"
  else
    install_react_native_package_dependencies
  fi
}
