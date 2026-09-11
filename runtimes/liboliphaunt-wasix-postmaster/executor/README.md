# Postmaster executor

This crate owns the sealed WASIX PostgreSQL executor and its build-time analysis tools. It is an internal part of the postmaster runtime, not an independently published SDK. Its version matches the Wasmer artifact ABI family because sealed manifests compare that exact version.

Prepare the pinned, patched Wasmer checkout from this directory:

```sh
moon run liboliphaunt-wasix-postmaster:prepare-runtime
```

Then ordinary Cargo commands work here:

```sh
cargo fmt --check
cargo build --locked --release --no-default-features --features product-executor --bin oliphaunt-wasix-postmaster-executor
cargo test --locked --release --no-default-features --features product-executor --lib
```

The preparation step writes only `.cargo/config.toml` with paths to the six patched Wasmer dependencies. The committed manifest declares their versions, features and ownership; the committed lockfile pins the remaining dependency closure. No executor source is copied into Wasmer. The patched generic Wasmer CLI depends directly on this crate for its sealed-loader functionality. To reconnect an already prepared checkout at a different location, run `bun prepare-paths.mts /absolute/path/to/wasmer`.

The equivalent `moon run liboliphaunt-wasix-postmaster:executor-build` and `executor-test` tasks prepare dependencies first and share the product executor build directory. A source build without `OLIPHAUNT_WASIX_RUNTIME_ABI_ID` can run source tests and print its version, but intentionally cannot load a sealed release carrier. The complete `runtime-build` task computes that identity from the prepared inputs and creates the release receipts.

The `product-executor` feature has no LLVM or Cranelift backend. Build-time tools are explicit features: `start-proof-tool`, `memory-profile-tool`, and `product-compiler`. The compiler requires LLVM 22 and must use its separate compiler target directory; `wasmer/bin/build-runtime.sh` maintains that separation and packaging copies only the executor into the carrier. The `cranelift,wat` feature pair exists solely for behavioral tests of sealed artifact loading.

Run Cargo from this directory so its generated dependency-path configuration is loaded. All preparation is unprivileged; compilation requires the matching native host toolchain. Runtime concurrency and host-capability tests remain in the postmaster product’s `runtime-patch-tests` and capability qualification tasks.
