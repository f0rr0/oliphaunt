# PostgreSQL protocol transport contract

The Oliphaunt WASIX PostgreSQL guest, Wasmer host, Rust binding, TypeScript
facade share one private transport ABI. This contract keeps
its mode values, size bounds, ownership, flush status, and failure lifecycle in
one reviewable place. Implementations retain compile-time constants; the policy
checker validates the schema and generated views, while the compiled bridge ABI
test exercises bounds, failure propagation, reset and transport transitions.
Published packages do not depend on repository-relative JSON at runtime.

Mode 0 buffers both directions. Mode 1 streams both directions. Mode 2 begins
buffered and switches both directions to streaming only after PostgreSQL reports
a COPY response and the complete buffered response prefix has flushed
successfully. Mode 3 buffers the finite frontend request and streams ordinary
non-COPY output. COPY must keep mode 2's duplex behavior; ordinary responses do
not need to become duplex merely to avoid complete-output buffering.

Buffered output has an inclusive 64 MiB limit. Overflow fails closed without
publishing a prefix and makes the session terminal; callers must reopen it.
The bound applies to mode 0
and mode 2 before its transition. Buffered bytes remain guest-owned until the
host validates the size, copies them into host-owned storage, and resets output
in that order. The host callback boundary,
not the C guest, caps stream chunks at 64 KiB. JavaScript callbacks receive a
fresh owned copy; Rust callbacks borrow a slice only for the synchronous
callback invocation. A stream can already have delivered a prefix before a
later write fails, so failure is terminal and stops further delivery but cannot
retract earlier callbacks.

The guest flush export returns a signed status. It calls PostgreSQL's
`pq_flush()` first, then samples the bridge's first sticky positive errno, and
preserves PostgreSQL's nonzero status when both failed. Buffered writes, hybrid
prefix flushes, and direct mode-1/mode-3 writes retain the first positive errno;
once recorded it gates writes in every mode and is cleared only by output reset.
This prevents PostgreSQL from publishing more stream bytes after a failed write
while still allowing the host to observe the failure through the signed flush
status. A host may publish buffered output only after a zero flush status.

Output reset clears buffered bytes and scan state, the buffered ErrorResponse
marker, sticky buffered-output failure, COPY state, and a pending hybrid
transition. It does not silently select another transport mode or retract an
already-active duplex stream. The stream-active export reports full-duplex mode
1 or an activated mode 2; output-only mode 3 deliberately leaves it false.

This is a downstream correctness and maintainability contract, not a claim that
the branded ABI should be upstreamed unchanged.

`contract.json` is the only hand-edited numeric/signature source. Run
`node src/shared/postgres-protocol-transport-contract/generate.mjs` after a
contract change. The checked-in generated C header is consumed by the bridge
and its native ABI test; the generated JavaScript module gives policy and probe
code parsed values without another set of literals.
