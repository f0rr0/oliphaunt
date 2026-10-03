# Patched WASIX postmaster runtime

This subtree builds the host runtime for
`liboliphaunt-wasix-postmaster`. Repository-pinned Wasmer and wasix-libc inputs
are copied into disposable worktrees, patched, tested, and built into a
compiler-bearing producer plus a compiler-free product executor.

Tracked product inputs are:

- `patches/wasmer/series`;
- `patches/wasix-libc/series`;
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

The ordered `series` files, not directory globs, select patches. Their digest
includes the manifest, member names and contents; editing or reordering a patch
invalidates receipts. Wasmer patches 0001–0008 decompose the inherited main
bundle without changing its source hunks. The product executor stays in
`../executor`, as on main, rather than being copied into the Wasmer fork.
The compiler and verifier retain main's nonvolatile-memory policy. Disabling
that optimization for strict shared-memory semantics is a separate follow-up,
not part of the source-equivalent split. That policy change requires matching
compiler and carrier identities; artifacts must never be relabelled.

The libc series separates mapping, file, socket, process, exception and resource
contracts. Its `sigsetjmp` fix evaluates the buffer expression once in the live
caller and keeps helper declarations limited to exception-enabled builds.
The host C/C++ probes prove those language contracts, not WASIX signal delivery;
the runtime capability probes remain required for that claim.

The product executor accepts only an independently verified sealed carrier. It
does not expose the general Wasmer package, registry, network, or compilation
command graph. AOT production uses an explicit generic CPU baseline; native CPU
tuning is rejected for release carriers.

From the repository root:

```sh
moon run source-inputs:source-fetch-wasix-postmaster-runtime
moon run liboliphaunt-wasix-postmaster:prepare-runtime
moon run liboliphaunt-wasix-postmaster:runtime-build
moon run liboliphaunt-wasix-postmaster:runtime-patch-tests
moon run liboliphaunt-wasix-postmaster:runtime-capabilities
```

The architectural and operational rationale is maintained in
`src/docs/maintainers/wasix-postmaster.md`.
