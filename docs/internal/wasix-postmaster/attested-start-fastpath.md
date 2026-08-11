# Attested fresh-backend instantiation

## Decision

The implemented v5 source keeps ordinary WebAssembly instantiation and module
start for every EXEC_BACKEND. An
`oliphaunt.wasix-postmaster.memory-image.v2` receipt eliminates only repeated
post-start byte comparison, and only after both of these independent checks
succeed:

1. the pinned carrier-build analyzer proves that the exact raw module's
   transitive start
   closure belongs to a restricted deterministic-effects policy; and
2. the first fresh instance in each executor activation runs ordinary start and
   compares the entire mapped prefix with the immutable captured image.

The proof uses schema
`oliphaunt.wasix-postmaster.deterministic-start-proof.v1`; the final manifest
binds its digest and the analyzer's exact output digest. The first comparison
result, success or failure, is stored in the image object's single-flight
`OnceLock`. Later fresh instances still run module start but reuse that exact
attestation result. A private, non-`Copy`, non-`Clone` witness is constructed
only after ordinary instance construction and is consumed by image application,
so callers cannot mint a successful-start claim. V1 images continue to compare
every instance. An attested image fails closed if the runtime supplies reused,
copied, or otherwise non-fresh memory.

This preserves the product's defining architecture: the postmaster launches a
real, fresh EXEC_BACKEND PostgreSQL process. It is not a backend pool, store
snapshot, fork emulation, or guest-visible lifecycle shortcut.

## Measured motivation

The pre-attestation 256 MiB reconnect diagnostic attributed these medians per
fresh instance:

| Component | Mean per instance |
| --- | ---: |
| `wasi_env.instantiate.linker.new` | 6.291 ms |
| `main_instance.new` | 2.539 ms |
| post-start compare/remap | 2.460 ms |
| data relocations | 0.775 ms |
| import construction | 0.258 ms |
| memory construction | 0.121 ms |
| symbol resolution | 0.019 ms |

That historical implementation read and compared 2,621,440 bytes for every
postgres backend. Removing the repeated comparison projected about 2.46 ms from
each warm backend launch while retaining ordinary start. The number is a
pre-attestation diagnostic estimate, not a v5 measurement or qualification
result.

## Exact PostgreSQL module evidence

The following values are bound to the historical analyzed carrier, not stable
product constants. For module
`277e02c8263ca93ce5db23149540c46edcf27c73e48e4a145c762e2b8750b958`:

- the module start is function 147, exported as `__wasm_init_memory`;
- its only call is local function 148,
  `__wasm_apply_global_tls_relocs`;
- it calls no imported function and performs no table operation;
- it initializes three passive data segments totaling 2,415,803 bytes,
  performs one zero fill, and uses LLVM's one-time shared-memory atomic guard;
- it writes local globals 5, 172, 689, and 690 from the receipt-bound
  `env.__memory_base`; and
- it drops passive data segments 1 and 2 while retaining TLS segment 0.

The proof digest for the analyzed start closure is
`3558b5cd25769fb8b5e3aa07be691f47d2af047f15dcbdf4ed402b8991ac9a29`.
The analyzer also accepts the exact initdb module under the same policy, with
proof digest
`c382782eaac57cbc24a0d9e9358798419492e3bd603878f1bf0f556123a9b914`.

The analyzer uses `wasmparser`, validates the whole module first, and rejects
unknown operators. Its accepted closure is deliberately narrow: integer-only
constant/local/global relocation arithmetic, direct local calls, the LLVM
atomic initialization guard, passive `memory.init`, one `memory.fill`, and
the expected data drops. Imported calls, table operations, memory loads,
indirect calls, memory growth, floating point, SIMD, relaxed SIMD, reference
effects, exceptions, and an unknown control-flow shape all fail the proof.

The proof digest is SHA-256 over the policy identifier, a delimiter, the raw
module digest in lowercase ASCII, then each sorted transitive function index,
body length, and exact raw body bytes. The carrier manifest already binds the
receipt and raw module digests; the runtime additionally checks the embedded
module hash, start index, start export, runtime ABI, and memory layout.

## Implemented build and activation protocol

The carrier builder performs the following transaction before final
manifest publication:

1. validate and analyze the exact raw executable;
2. capture two independent ordinary-start images, as today;
3. require byte-identical images and receipts;
4. emit memory-image schema
   `oliphaunt.wasix-postmaster.memory-image.v2`, embedding the analyzer proof;
5. validate the proof's module digest against the executable and AOT module
   hash;
6. bind the v2 receipt fields and image digest into the final manifest; and
7. exercise initdb plus real EXEC_BACKEND launches from the immutable carrier.

At activation the loader validates all v2 proof constants before it opens the
fast path. The first fresh instance performs the ordinary full comparison.
`OnceLock<Result<(), Arc<str>>>` gives concurrent backend launches one
linearizable validation. A mismatch, I/O error, non-fresh memory, malformed
proof, module/start mismatch, or layout mismatch remains an error and is never
downgraded to v1 behavior silently.

The runtime appends one terminal
`oliphaunt.wasix-postmaster.attested-start-runtime-summary.v1` JSONL record for
each loaded `(native executor pid, module SHA-256)` activation. It does so only
after the root status, every execution lease, every pending child publication,
and every process published in the same control-plane epoch are quiescent. The
barrier joins the snapshot and then rechecks the epoch exclusively, so a late
descendant cannot be omitted merely because the root status was already
published. Evidence finalization remains inside the originally admitted
`run_wasm` execution.

`oliphaunt.wasix-postmaster.sealed-loader-audit-validation.v3` binds each
terminal summary to the v2 memory metadata in the final manifest and requires,
for every activation:

```text
ordinary_start_completed_instances = fresh_zeroed_instances + nonfresh_instances
validation_attempts = ordinary_start_completed_instances
full_compare_attempts = full_compare_successes + full_compare_failures = 1
validation_attempts = full_compare_attempts + reuse_successes + reuse_failures
reuse_successes = ordinary_start_completed_instances - 1
compared_bytes = mapped_size * full_compare_successes
skipped_bytes = mapped_size * reuse_successes
remap_successes + remap_failures = full_compare_successes + reuse_successes
remap_successes = ordinary_start_completed_instances
```

It additionally requires `nonfresh_instances`, `full_compare_failures`,
`reuse_failures`, `remap_failures`, and `counter_overflow` to be zero. There
must be exactly one summary after, and no orphan summary without, its matching
preinitialized-memory loader row. The loader mapping rows remain
`oliphaunt.wasix-postmaster.sealed-loader-receipt.v2`; summary v1 and mapping v2
coexist deliberately in the same bounded append-only JSONL stream.

## Why ordinary start is not skipped

The current image is only the 64 KiB-aligned prefix below `stack_low`. For
postgres it ends at 2,621,440, while `stack_low` is 2,665,472. The LLVM atomic
initialization guard is in that un-mapped final partial page. Memory bytes are
also not the complete Wasm-visible post-start state: start mutates globals and
passive-data drop state. Blindly mapping the image and omitting start would
therefore be observably wrong even for this exact module.

Skipping ordinary module start is unsupported. The v2 comparison cache remains
the implemented boundary: it runs ordinary start, compares the mapped prefix,
and fails closed on proof-schema, analyzer, identity, layout, or byte mismatch.
It makes no direct-template, aggregate latency, memory, or adaptive-cache claim.
