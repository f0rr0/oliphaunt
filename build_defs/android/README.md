# Native Android toolchain

The NDK archive version and checksum come from `tools/dev/android-sdk.toml`.
The minimum API and ELF page alignment come from
`tools/release/platform-compatibility-policy.mts`.
The Expo application NDK remains a separate SDK context.

`//build_defs/android:android_arm64` and `:android_x86_64` select the runtime
toolchain. Both execute the pinned Google Linux x86_64 compiler; the toolchain
reuses `rules_android_ndk`'s maintained C/C++ configuration and declares the
compiler, headers, target libraries and link tools as action inputs. Small local
registration targets keep unrelated platform analysis from acquiring the NDK.

Run the acquisition-policy tests and actual cross-compiled ELF checks together:

```sh
bash tools/dev/bazel.sh test //build_defs/android:metadata_test //build_defs/android:abi_test --jobs=2
```

The ELF checks compile real C++ code for each architecture and inspect the
resulting libraries with the existing platform validator: API 24, architecture,
static C++ runtime, private C++ symbols and 16 KiB load segments. The existing
runtime C++ symbol map is a declared linker
input. These checks do not execute an Android device or qualify a packaged
PostgreSQL runtime.

The Google compiler depends on Linux host libc, libz and libgcc. Publication
evidence must identify the trusted execution environment in addition to the
checksummed compiler archive; an archive hash alone does not certify those host
libraries.
