# liboliphaunt WASIX Postmaster

`liboliphaunt-wasix-postmaster` is the concurrent PostgreSQL 18 runtime for
WASIX. One PostgreSQL postmaster accepts connections and starts isolated WASIX
backend processes that coordinate through PostgreSQL shared memory.

This is a release product. Its release identity, version, source pins, build,
sealed carrier, verification, and qualification tasks are owned by this
directory. The existing `liboliphaunt-wasix` runtime remains the lightweight
single-backend product; applications select the topology that fits their
workload without changing PostgreSQL protocol semantics.

## Release targets

Release carriers are published as level-19 Zstandard `.tar.zst` archives for
`linux-arm64-gnu`, `linux-x64-gnu`, and `macos-arm64`, matching the normal
WASIX carrier format. Each published carrier contains:

- the compiler-free postmaster executor;
- `initdb`, `postgres`, and every side module declared by
  `runtime/policies/sealed-side-modules.v1.tsv`;
- receipt-bound AOT artifacts for every admitted executable module;
- PostgreSQL support files, build receipts, a complete payload inventory, and
  the sealed manifest.

Each carrier is fail-closed: the verifier rejects missing, unexpected, renamed,
symlinked, special, or modified payloads, an incompatible runtime ABI, a
mismatched producer recipe, and undeclared modules. Platform support is a
release target claim, not an inference from Wasmer portability. Additional
targets are added only with an artifact target, CI builder, and consumer smoke.

## Run the release carrier

Download and extract the release archive matching the host, then start a local
cluster through its supported launcher:

```sh
./bin/oliphaunt-wasix-postmaster start --data-dir "$PWD/pgdata"
```

The launcher initializes an empty directory with the `postgres` superuser,
prints `postgresql://postgres@127.0.0.1:5432/postgres`, and keeps PostgreSQL in
the foreground. It binds only to loopback unless `--allow-remote` is explicit.
Use `--port`, repeated `--guc name=value`, and `--username` to configure the
cluster without depending on the repository's build scripts. Send SIGTERM for
a clean shutdown. The archive is self-contained; it does not compile or fetch
code when it starts.

## Build and verify

Run the focused source and product checks:

```sh
moon run liboliphaunt-wasix-postmaster:check
```

Build the pinned runtime and PostgreSQL guest, then construct the sealed
carrier:

```sh
moon run liboliphaunt-wasix-postmaster:runtime-build
moon run liboliphaunt-wasix-postmaster:postgres-build
moon run liboliphaunt-wasix-postmaster:carrier
```

Verify an existing carrier independently:

```sh
src/runtimes/liboliphaunt/wasix-postmaster/bin/verify-sealed-headless-carrier.sh \
  target/oliphaunt-wasix-postmaster/carriers/<carrier-directory>
```

Build outputs, fetched sources, caches, and qualification results stay under
`target/oliphaunt-wasix-postmaster/`. Nothing generated is admitted as a
release asset unless it was built from the exact release commit and passes the
product verifier and lifecycle qualification.

Linux release qualification additionally requires immutable-inode activation
and cgroup-v2 memory controls. macOS uses runtime-owned private AOT and memory
image copies because Linux immutable-inode and cgroup primitives do not exist
there; qualification proves the copy/hash byte accounting, forbids carrier
source writes and sync calls, and runs the same backend-wave and crash-recovery
campaign.

## Architecture boundary

The launcher's `--data-dir` is a raw PostgreSQL PGDATA directory. It is not an
Oliphaunt SDK managed root and does not participate in the single-backend
WASIX root or physical-backup contracts.

PostgreSQL is built with `EXEC_BACKEND`. The postmaster uses the WASIX process
and exec syscalls to create a fresh Wasmer instance for each backend. The child
restores PostgreSQL's serialized backend parameters and reattaches the
postmaster's shared-memory segment at the original guest address.

```text
native supervisor and compiler-free WASIX executor
  PostgreSQL postmaster.wasm
    TCP listener + PostgreSQL shared memory
      |
      +-- vfork + execv --> isolated backend.wasm instance
      +-- vfork + execv --> isolated backend.wasm instance
```

The postmaster guest deliberately does not consume the single-backend patches
that remove concurrent observers, workers, process creation, or PostgreSQL's
normal spinlock/atomic behavior. Compatible PostgreSQL optimizations are
referenced from the canonical WASIX product where possible; postmaster-only
concurrency patches remain local and are justified in
`postgres/product-patch-provenance.toml`.

Maintainer architecture, failure semantics, performance interpretation, and
the durable conclusions from product development are documented in
`docs/maintainers/wasix-postmaster.md`. Product source contains only build,
runtime, packaging, verification, and qualification machinery.

## Release contract

- Product id and tag prefix: `liboliphaunt-wasix-postmaster` and
  `liboliphaunt-wasix-postmaster-v`.
- The source version remains `0.0.0` until the first generated release PR.
- `release.toml`, Moon release metadata, Release Please, and the release asset
  task describe the same product.
- A release is valid only when the exact release commit produced and verified
  the carrier later attached to its GitHub release.
- The checksum manifest uses the same canonical release-asset contract as the
  single-backend WASIX product and covers every published carrier exactly.
