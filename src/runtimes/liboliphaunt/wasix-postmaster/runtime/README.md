# Patched WASIX postmaster runtime

This subtree builds the host runtime for
`liboliphaunt-wasix-postmaster`. Repository-pinned Wasmer and wasix-libc inputs
are copied into disposable worktrees, patched, tested, and built into a
compiler-bearing producer plus a compiler-free product executor.

Tracked product inputs are:

- `patches/wasmer/0001-postgres-wasix-blockers.patch`;
- `patches/wasix-libc/0001-postgres-wasix-blockers.patch`;
- the current contract inventory in `capabilities.tsv`;
- focused capability fixtures under `probes/`;
- preparation, build, verification, and qualification entrypoints under `bin/`.

Immutable upstream checkouts live under
`target/oliphaunt-sources/checkouts/`. Patched worktrees, sysroots, build
outputs, caches, and reports live under
`target/oliphaunt-wasix-postmaster/runtime/` and are never patched into the
source checkout.

`build-runtime.sh` produces a Wasmer build receipt and a separate product
executor receipt. Together they bind source pins, patch digests, prepared-tree
identities, Cargo.lock, sysroot manifests, compiler/executor features, host ABI,
Rust and LLVM versions, artifact ABI, runtime ABI, CPU policy, and binary
hashes. Runtime selection never falls back to a stock or `PATH` Wasmer.

The product executor accepts only an independently verified sealed carrier. It
does not expose the general Wasmer package, registry, network, or compilation
command graph. AOT production uses an explicit generic CPU baseline; native CPU
tuning is rejected for release carriers.

From the repository root:

```sh
moon run liboliphaunt-wasix-postmaster:source-fetch
moon run liboliphaunt-wasix-postmaster:prepare-runtime
moon run liboliphaunt-wasix-postmaster:runtime-build
moon run liboliphaunt-wasix-postmaster:runtime-capabilities
```

The architectural and operational rationale is maintained in
`docs/maintainers/wasix-postmaster.md`.
