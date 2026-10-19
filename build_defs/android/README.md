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

Released native slices and APK native dependencies use
`rules_android`'s `android_split_transition`. The release producer sets its API
floor from the compatibility policy before that split. Packaged archives and
runtime data enter through `android_product_inputs`, which clears the consuming
app's Android split settings and restores the Linux producer context. Executable
tools retain `cfg = "exec"`. This keeps app configuration out of the released
products without copying upstream's native transition or lowering the app's Java
minimum SDK.
`android_native_member` forwards registration and the C++ library together from
that native context, and verifies that both reference the same archive. This
also preserves reuse when the consuming app raises its minimum SDK.

`//src/examples/native/react-native-expo:android_cpp_reuse_test` compares the actual
selected release archive Files with the Files linked into the example APK for
every declared ABI, at the app's minimum SDK and at a higher app SDK. Its
inventory comes from the existing carrier metadata and selected extensions;
adding an object file does not require updating the test.

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
