#!/usr/bin/env sh

oliphaunt_android_ndk_bin_dir() {
  if [ -z "${ANDROID_HOME:-}" ]; then
    echo "ANDROID_HOME is required to build Android smoke native artifacts" >&2
    return 1
  fi
  for candidate in "$ANDROID_HOME"/ndk/*/toolchains/llvm/prebuilt/*/bin; do
    if [ -x "$candidate/llvm-ar" ]; then
      printf '%s\n' "$candidate"
    fi
  done |
    sort |
    tail -n 1
}

oliphaunt_android_clang_name_for_abi() {
  case "$1" in
    arm64-v8a)
      printf '%s\n' aarch64-linux-android24-clang
      ;;
    armeabi-v7a)
      printf '%s\n' armv7a-linux-androideabi24-clang
      ;;
    x86)
      printf '%s\n' i686-linux-android24-clang
      ;;
    x86_64)
      printf '%s\n' x86_64-linux-android24-clang
      ;;
    *)
      echo "unsupported Android smoke ABI: $1" >&2
      return 1
      ;;
  esac
}

oliphaunt_android_create_static_extension_smoke_artifacts() {
  scratch_root="$1"
  abi="$2"
  runtime_resources_root="$3"
  jni_libs_root="$4"
  stem="$5"

  ndk_bin="$(oliphaunt_android_ndk_bin_dir)"
  if [ -z "$ndk_bin" ]; then
    echo "could not find Android NDK LLVM toolchain under ANDROID_HOME=$ANDROID_HOME" >&2
    return 1
  fi
  clang_name="$(oliphaunt_android_clang_name_for_abi "$abi")"
  clang="$ndk_bin/$clang_name"
  ar="$ndk_bin/llvm-ar"
  if [ ! -x "$clang" ]; then
    echo "missing Android clang for $abi: $clang" >&2
    return 1
  fi
  if [ ! -x "$ar" ]; then
    echo "missing Android llvm-ar: $ar" >&2
    return 1
  fi

  work="$scratch_root/android-smoke-native/$abi/$stem"
  archive_dir="$runtime_resources_root/oliphaunt/static-registry/archives/$abi/extensions/$stem"
  jni_dir="$jni_libs_root/jniLibs/$abi"
  rm -rf "$work"
  mkdir -p "$work" "$archive_dir" "$jni_dir"

  symbol_stem="$(
    printf '%s' "$stem" |
      tr -c 'A-Za-z0-9_' '_' |
      sed 's/^/x_/'
  )"
  cat >"$work/extension.c" <<C
void oliphaunt_extension_${symbol_stem}_smoke(void) {}
C
  "$clang" -fPIC -c "$work/extension.c" -o "$work/extension.o"
  "$ar" rcs "$archive_dir/liboliphaunt_extension_$stem.a" "$work/extension.o"

  cat >"$work/liboliphaunt.c" <<'C'
void oliphaunt_android_smoke_liboliphaunt(void) {}
C
  "$clang" -shared -fPIC "$work/liboliphaunt.c" -Wl,-soname,liboliphaunt.so \
    -o "$jni_dir/liboliphaunt.so"
}
