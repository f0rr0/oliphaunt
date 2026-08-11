# Sealed main-module export closure

## Outcome

The WASIX postmaster product treats dynamic linking as a build-time graph, not
as permission to retain every symbol in PostgreSQL and the sysroot.  A seed
main module and every packaged side module are analyzed together.  The final
main module exports exactly the typed transitive closure required by those
fixed bytes plus the small runtime/start/qualification policy.

For the exact PostgreSQL 18.4 v5 seed used to develop this path, the result is:

| Structure | Seed | Final |
|---|---:|---:|
| Main exports | 23,187 | 383 |
| Local functions | 16,922 | 12,777 |
| Local globals | 10,911 | 1,020 |
| Function element entries | 4,739 | 4,739 |
| Module bytes | 14,026,016 | 12,646,628 |

The element inventory is intentionally unchanged.  It is the relocation and
indirect-call substrate used by dynamic side modules, not dead export-table
metadata.

Wasmer 7.2 currently constructs one 32-byte
`VMCallerCheckedAnyfunc` for every local function and allocates 48 bytes of
VM-global definition/handle/descriptor structure for every local global on a
64-bit host.  The structural estimate for the exact seed is therefore:

```text
(16,922 - 12,777) * 32 + (10,911 - 1,020) * 48
= 607,408 bytes per instance
```

The source anchors are `lib/vm/src/instance/mod.rs` (`funcrefs` and local
global handles), `lib/vm/src/vmcontext.rs` (`VMCallerCheckedAnyfunc` and
`VMGlobalDefinition`), and `lib/compiler/src/engine/tunables.rs`
(`create_globals`).  This is why deleting export names alone has no RSS effect:
the instance allocation is driven by local definition counts, which only fall
after reachability DCE.

This is an estimate of structures that are no longer created.  It is not an
RSS or PSS measurement and deliberately excludes allocator overhead, host
page sharing, AOT mappings, linear memory, PostgreSQL shared memory, and the
kernel page cache.  The build writes the formula, inputs, result, and caveat to
`wasix-postmaster.sealed-export.structure.receipt`; runtime qualification must
still measure PSS and cgroup memory.

## Why this is a two-pass seal

The first pass builds ordinary DynamicMain output and all side modules.  That
is the only point at which ThinLTO, archive extraction, PIC relocations, and
the final side import surface are facts rather than guesses.  The product-local
Rust analyzer then:

1. validates every complete WebAssembly module;
2. hashes the exact main and side bytes;
3. walks each side's `dylink.0` dependency list;
4. maps direct `env` imports to exact function/global/tag descriptors;
5. maps `GOT.func` address relocations to function exports;
6. maps mutable `GOT.mem` slots to the value type of the main module's
   immutable address globals;
7. unions those requirements with the explicit runtime and main-`dlsym`
   policies; and
8. fails before rewriting on any missing name, kind mismatch, descriptor
   mismatch, or absent side dependency.

The second pass rewrites only the export section, proves every other section
is byte-identical, and invokes pinned Binaryen with exactly one optimization
pass: `--remove-unused-module-elements`.  This pass performs reachability DCE
after the broad export roots have gone away.  It does not run another `-O3`,
inlining, function merging, or a general optimization pipeline.

That distinction is tested evidence, not aesthetic preference.  A second
Binaryen `-O3` reduced more functions but changed the deterministic LLVM start
shape and was rejected by the start-proof analyzer.  The single module-element
pass preserves the start proof, packed atomic-fence inventory, and all 4,739
element entries while deleting 9,891 synthetic address globals and 4,145
otherwise unreachable functions.

## Fail-closed dynamic loading

The policies live in `runtime/policies`:

- `sealed-side-modules.v1.tsv` admits all 27 canonical runtime-loadable modules:
  libpq, PL/pgSQL, snowball, and PostgreSQL's 24 encoding-conversion modules.
  It also records the byte-identical libpq aliases.
- `sealed-main-runtime-exports.v1.txt` contains fixed WASIX execution, TLS,
  signal, deterministic-start, and packed-fence proof roots.
- `sealed-main-dlsym-exports.v1.txt` is empty for this profile because
  PostgreSQL resolves extension entry points against their `dlopen` handle,
  not the main module through `RTLD_DEFAULT`.

The 24 conversion modules add only 13 roots over the smaller libpq/PL/pgSQL/
snowball graph, so the product preserves PostgreSQL encoding behavior instead
of obtaining a misleading memory result by pruning features.  Carrier payload
selection remains a separate policy, but a build-time install with any
runtime-loadable module absent from this graph fails closed.

The installed `.so` inventory must exactly match the side manifest.  An
unknown main-module `dlsym` name has no ambient export and therefore fails.
Adding a side module, changing its bytes/imports, or introducing a declared
main-module `dlsym` consumer requires a new graph, main module, AOT artifact,
memory image, and carrier identity.  There is no name-prefix heuristic and no
runtime fallback to `--export-all`.

Side-module public exports are intentionally not stripped by this research step.
That preserves libpq's public ABI and every PostgreSQL extension entry point.
Side-module export minimization is outside this lane; libpq's public ABI and
server-extension entry points remain intact.

## Publication and proof order

`build-wasix-core.sh` builds the seed closure first and then runs
`seal-wasix-core-exports.sh`.  The latter stages all output and publishes
nothing until the export-DCE successor bytes pass:

- exact final-export equality with seed descriptors;
- unchanged function-element inventory;
- required Oliphaunt postmaster import signatures;
- the receipt-bound deterministic-start analyzer; and
- the exact packed `SetLatch`, `ResetLatch`, and `WaitEventSetWait` fence proof.

The start and concurrency artifacts emitted here are deliberately named
`*.intermediate.*`.  Bounded linear-memory sealing is the next module-rewriting
stage.  It binds this stage's structural receipt and the predecessor/successor
module hashes, then the build regenerates the final import, start, and
concurrency proofs against the memory-sealed bytes before writing the guest
receipt.

The structural receipt binds the analyzer binary, policy hashes, side-manifest
hash, side byte hashes, allowlist, seed/final proofs, Binaryen binary/version,
the single allowed DCE pass, and before/after structure.  The ordinary guest
build receipt's installed-closure hash then binds the published module and all
of these receipts.  Carrier AOT, preinitialized-memory, and start receipts are
regenerated from the final bytes; stale seed or intermediate artifacts cannot
validate as final proof.

## Rejected eager-funcref shortcut

The final module still has 12,777 local functions but only 4,739 function
element entries. Wasmer eagerly materializes all local funcrefs. A sparse or
lazy slab would change VM pointer-ownership semantics across table
initialization, passive elements, `ref.func`, export lookup, `dlsym`, and fresh
EXEC_BACKEND instantiation, so it is outside this patch. Per-symbol name
filters and moving vectors are rejected because they do not preserve that
contract. The two-pass seal provides the bounded reduction without changing
the VM ownership model.
