# Private expanded ownership experiments

These scripts patch an immutable private copy of registry Wasmer 7.5.0. They
are research controls, not consumer installation instructions. Run them only
in an isolated native Windows checkout after the diagnostic producer has
created its release Wee8 archive and bindings. Both variants check source
hashes and preserve patch/lock provenance.

- `prepare.py` applies the static C++ owner-method control. It fails the real
  SDK isolation regression on both tested toolsets; do not ship that variant.
- `prepare-dll.py` builds the engine DLL with designated C++ deleters inside
  it, then applies the C ABI ownership patch to its private Wasmer copy. The
  current bridge also preserves borrowed call arguments; its preceding version
  failed because the raw C call deleted them before Rust cleanup.
- `sdk-dll-check.py` runs the actual SDK through that DLL with consumer
  Clang/objcopy paths removed. The producer owns DLL staging for the control.
  This does not test automatic installed-SDK delivery.
- `call-ownership.rs` checks argument-bearing calls, retries, finish, guest
  traps and callback errors. The driver stages it as an isolated SDK test;
  diagnostic fixture compilation is separate from the product AOT contract.
- `embed-dll.py`, `embedded-engine.rs` and `embedded-check.py` generate prepared
  Rust dispatch and test automatic internal DLL delivery. The preceding lazy
  C dispatch passed three concurrent cold executable-only starts, warm starts
  and 500 real vector database lifecycles on both Windows toolchains.
- `trap-ownership.diff` and `trap-ownership.rs` test native errors retained
  after Store destruction, discarded retry traps and typed host-error owners.
  The original Linux control crashes; the owned-message correction passes
  on Linux and both native Windows toolsets.
- `callback-panic.diff` and `callback-panic.rs` replace the upstream callback
  handler's second panic with a runtime error. All four constructors pass the
  Linux negative/positive control and both native Windows combinations. The
  `.wasm` fixtures are compiled by the
  producer; SDK tests require no WAT-parser feature.
- `wine-producer.py`, `cache-probe.c` and `cache-pair-check.py` produce genuine
  Windows CPU variants and exercise fresh readers without compilation fallback.
  Wine/QEMU and the freestanding C compiler are producer infrastructure only.
  A separate emulated helper avoids a Wine/QEMU process-detach failure using
  direct process termination; native readers retain normal shutdown.
- `atomic-wait.c` exercises interruption of an indefinite native guest wait
  through the pinned public V8 methods. It captures the isolate in a host
  callback and joins the sender before Store teardown. This engine control
  complements the separate Rust WASIX signal-path control; it is not a complete
  production interrupt-capability registry.

- `atomic-wasix.diff`, `atomic-wasix.rs` and `atomic-wasix-check.py`
  exercise the real WASIX signal path with a shared-memory isolate registry.
  Both Windows toolsets pass 20 single and five three-waiter cycles, 25 late
  attachments and 2,500 signals after teardown. The stock path times out.
  A refinement captures the initial capability through a direct host-function
  call before creating any guest module; all 25 cycles pass on both native
  Windows toolsets with this refinement too.
- `catalog-check.py` runs the existing complete native Windows extension,
  server, restart/backup and tools regression with consumer compiler paths
  removed.
- `cache-only-prepare.py`, `cache-only-wasix.diff`, `native-payload.diff`
  and `cache-only.rs` qualify a cached-loading policy inside the existing
  WASIX runtime and its overrides. They preserve existing services and reject
  cache misses and wire-only payloads before compilation. The full catalog
  candidate includes a maintainer-only sentinel that fails if consumer guest
  compilation is reached. All 195 extension/mode records, server tests and the
  tools round-trip pass with that entry point blocked. This sentinel is not a
  production SDK implementation.
- `automatic-interrupt-prepare.py`, `automatic-interrupt-check.py` and
  `automatic-interrupt.rs` apply the product-owned lifetime patch and exercise
  existing APIs without manual isolate registration or retirement. Native
  single/simultaneous waits, aliases, post-teardown signals and Store teardown
  races pass on both Windows toolsets. The full strict catalog passes too.
- `fallible-attachment.py` applies the follow-up Wasmer/WASIX patches and tests
  ordinary attachment errors through the task manager, plus 256 attachments
  racing with shutdown. The control passes on both native Windows toolsets;
  see the ledger for the exact source and retained failed package steps.
- `stage-family.py`, `family-check.py` and `family-consumer.rs` generate four
  aligned unpublished API crates, a small engine facade and two DLL payload
  crates. They use the existing source packager, compile from extracted archives,
  check dependency identities and verify exact DLL reconstruction. The consumer
  passes on both Windows toolsets from an executable-only directory in cold
  and warm launches. Overrides
  cover unpublished private names only. This is package-boundary evidence,
  not registry installation, complete notices or installed SDK qualification.
- `public-api-review.rs` diagnoses shared data/growth, retained typed errors,
  reentry after interruption and copied/independent-memory cancellation. Its
  cancellation cases print observations, not parity passes. The
  [API review](../../../../src/docs/maintainers/windows-v8-api-review.md)
  records reproduced Linux limits and the engine delivery error-handling blocker.
- `terminal-entry.rs`, `terminal-contract.rs`, `terminal-copy.rs` and
  `loader-boundary-review.rs` cover entry admission, memory participants and
  the preceding generated C ABI. The corrections are maintained patches
  `0008` through `0011`, applied by the existing candidate drivers. The
  [root-cause review](../../../../src/docs/maintainers/windows-v8-root-cause-review.md)
  records the staged negative/positive controls.
- `dynamic-reference.rs` verifies that cleaning up call vectors preserves
  borrowed and returned functions, null references and Store teardown over
  1,000 cycles. The earlier terminal proposal crashes the borrowed-argument
  control; patch `0008` owns copies rather than deleting borrowed wrappers.
- `delivery-check.py` and `loader-faults.rs` exercise the actual loader source
  against Windows permissions, competing writes, file locks, invalid DLLs and
  missing exports. Separate blocking/async SDK subprocesses verify typed errors
  and successful retry in the same process. `node-delivery-check.py` and
  `node-delivery.mjs` exercise the actual direct/actor Node addon after activating
  the cached-loading policy and compilation sentinel. No consumer fault options
  are added. See the
  [implementation record](../../../../src/docs/maintainers/windows-v8-implementation.md)
  for current qualification status.

The lifetime patches and their exact input digests live under
`src/wasix/runtime/engine/patches`. Package generation deliberately removes the
diagnostic compilation sentinel; the SDK's actual cached-loading policy and
native-payload rejection remain in the candidate source.

Run the offline driver regressions with
`moon run liboliphaunt-wasix:engine-control-test`. The check validates receipt
coverage and fixture drift without building an engine or SDK. The
[code and CI review](../../../../src/docs/maintainers/windows-v8-review.md)
records cleanup and the actual SDK dependency boundaries.

The scoped native workflow lives on `f0rr0/windows-v8-ownership-control`.
Its exact run/source and results are recorded in the
[decision ledger](../../../../src/docs/maintainers/windows-v8-decision-log.md).
Do not replace the root workflow with the isolated manual research workflow.
