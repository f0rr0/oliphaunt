# Compiler Caching

Oliphaunt uses three separate cache layers. Keep them separate:

- Moon caches deterministic task outputs.
- Cargo, Gradle, pnpm, SwiftPM, and Xcode cache their own dependency/build
  state through their native tools.
- Compiler caches reuse object-code compilation when a native lane has to run.

Moon decides whether a product task runs. Compiler caches make the task cheaper
when it does run. Do not replace affectedness with compiler cache hits, and do
not treat compiler cache hits as release evidence.

## Current Decision

Use `ccache` for C/PostgreSQL native runtime builds on macOS, Linux,
iOS-simulator/device, and Android host builds when the build runs from a Unix
shell. These lanes compile PostgreSQL and liboliphaunt through clang or gcc, and
the build scripts already route `CC`/`CXX` through ccache when it is available.

Use Cargo cache actions for Rust dependencies and `target` reuse. Do not enable
`sccache` by default yet.

Use normal Gradle, SwiftPM, pnpm, Moon, and GitHub Actions caches for their
ecosystems. Do not put simulator state, device state, registry responses,
PostgreSQL source checkouts, or release artifacts into Moon's cache.

Do not share native build roots across targets. Sharing object caches can be
reasonable when the compiler cache understands the compiler identity and flags,
but sharing build directories across macOS, Linux, iOS, Android, and Windows is
not.

## Local Native Builds

The liboliphaunt build scripts automatically use `ccache` when it is on `PATH`.

```sh
brew install ccache
src/runtimes/liboliphaunt/native/bin/build-postgres18-macos.sh
ccache --show-stats
```

On Linux:

```sh
sudo apt-get install ccache
src/runtimes/liboliphaunt/native/bin/build-postgres18-linux.sh
ccache --show-stats
```

The iOS and Android native build scripts use the same `OLIPHAUNT_CCACHE`
contract because they are clang-based cross-builds launched from macOS.

Override or disable it with:

```sh
OLIPHAUNT_CCACHE=/opt/homebrew/bin/ccache src/runtimes/liboliphaunt/native/bin/build-postgres18-macos.sh
OLIPHAUNT_CCACHE=off src/runtimes/liboliphaunt/native/bin/build-postgres18-macos.sh
```

The build scripts use prefix mode (`CC="ccache cc"` style). Keep cache
configuration boring: set a local size, review `ccache --show-stats`, and avoid
broad `CCACHE_SLOPPINESS` settings unless a measured local experiment proves the
trade-off is worth it.

Recommended local defaults:

```sh
ccache --max-size=10G
ccache --set-config=compression=true
```

Use a per-workstation cache directory only when you need to isolate experiments:

```sh
CCACHE_DIR="$HOME/.cache/oliphaunt-ccache" src/runtimes/liboliphaunt/native/bin/build-postgres18-macos.sh
```

## CI Native Builds

CI restores `~/.ccache` for Unix-hosted native runtime lanes and scopes native
build-tree caches by runtime target:

```text
liboliphaunt-native-ccache-<target>-<runner.os>-<runner.arch>-<input-hash>
release-native-assets-ccache-<target>-<runner.os>-<runner.arch>-<input-hash>
```

The target id is part of the key because the cached build root is target
specific. A Linux x64 build tree, Linux arm64 build tree, macOS build tree, iOS
build tree, Android build tree, and Windows build tree must not share the same
build-root cache. `ccache` itself is designed to key on compiler inputs, but the
surrounding build tree is not a generic object cache.

The input hash must track the same source domains that drive the Moon native
runtime tasks: PostgreSQL pins, third-party pins, extension metadata, all
`src/runtimes/liboliphaunt/native/**` sources and scripts, `tools/xtask/**`, `Cargo.toml`,
`Cargo.lock`, and `rust-toolchain.toml`. A cache hit across any of those changes
is treated as stale build-root reuse, not an acceptable optimization.

CI prints `ccache --show-stats` after native builds. Treat those stats as the
first signal before changing cache size, keys, or storage.

## Windows

The Windows liboliphaunt lane uses MSVC and Meson/Ninja. It currently gets
target-scoped build-root reuse through GitHub Actions cache but not object-code
reuse. `ccache` is not the right default there; if Windows object caching becomes
necessary, use `sccache` for MSVC in a dedicated CI experiment before promoting
it to the release path.

Use a native Windows Perl for PostgreSQL's MSVC build, such as Strawberry Perl.
Do not let Meson discover Git/MSYS Perl for this lane: MSYS path rewriting can
turn native linker options into bogus paths before PostgreSQL's Windows export
generation calls `dumpbin`.

## sccache

`sccache` is attractive because it supports Rust, C/C++, MSVC, local caches,
GitHub Actions cache storage, cloud storage, and distributed compilation. It is
also a bigger operational choice:

- Rust cache hits require `RUSTC_WRAPPER=sccache`, and incremental workspace
  crates are not cacheable.
- C/C++ cache hits require build-system launcher integration per build path.
- Shared cache hit rates depend heavily on stable toolchains, SDKs, compiler
  flags, absolute path normalization, and per-platform keys.
- Remote or GitHub-backed caches add a new failure mode and need stats before
  being trusted.

Recommended adoption path:

1. Keep current `ccache` plus Cargo cache as the release path.
2. Add a manual `workflow_dispatch` experiment that enables
   `mozilla-actions/sccache-action`, `SCCACHE_GHA_ENABLED=true`, and
   `RUSTC_WRAPPER=sccache` for Rust-heavy lanes only. Set `CARGO_INCREMENTAL=0`
   in that experiment so Rust compiler outputs are cacheable and comparable.
3. Compare wall time, cache hit rate, upload/download time, and flake rate
   against the current CI for at least five same-SHA reruns.
4. If Rust results are good, add a second experiment for Windows MSVC and
   Unix C/C++ builds through explicit compiler launchers. Keep target-specific
   cache scopes; do not let Linux, macOS, iOS, Android, and Windows publish into
   one undifferentiated cache namespace.
5. Promote sccache only after the experiment writes stable stats to the CI
   summary and has a documented rollback switch.

Use these environment variables only in the experiment workflow:

```text
SCCACHE_GHA_ENABLED=true
RUSTC_WRAPPER=sccache
CARGO_INCREMENTAL=0
```

For local Rust experimentation, keep it opt-in:

```sh
brew install sccache
RUSTC_WRAPPER=sccache CARGO_INCREMENTAL=0 cargo test -p oliphaunt
sccache --show-stats
```

## References

- ccache manual 4.13.6: <https://ccache.dev/manual/4.13.6.html>
- sccache README: <https://github.com/mozilla/sccache>
- sccache GitHub Action: <https://github.com/Mozilla-Actions/sccache-action>
- GitHub Actions cache: <https://github.com/actions/cache>
- Meson machine files: <https://mesonbuild.com/Machine-files.html>
