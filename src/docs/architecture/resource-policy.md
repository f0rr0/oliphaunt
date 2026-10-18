# Resource configuration contract

Status: admission, OPFS options, native TypeScript filesystem inputs, desktop
broker login/recovery controls, mobile cleanup budgets, supported typed lifecycle
budgets, WASIX host executor/file-helper settings, WASIX tool startup budgets and
WASIX TypeScript physical archive limits are implemented in this checkout.
Transport/protocol options, additional tool output controls, native C runtime
options, package-import policies and producer profiles below remain proposals.
The public [performance guide](../content/reference/performance.mdx) gives the
implemented names, defaults, examples and platform limits. The
[runtime inventory](../maintainers/runtime-resource-budgets.md) records owners.

Resource settings should let developers control burst admission, transport
memory, startup capacity and supported input sizes. Each setting needs a
defined unit, scope, accounting lifetime and failure behavior. SDKs share those
meanings while retaining idiomatic configuration and existing wait/reject
behavior. This follows the [SDK parity policy](../maintainers/sdk-parity-policy.md).

## Separate policy from representation

| Kind | Meaning | Configuration owner |
| --- | --- | --- |
| Hard acceptance limit | Rejects one oversized item; does not reserve its maximum size | The importer, frame reader or collector that accepts the item |
| Admission watermark | Stops admitting more retained work; permits a larger single operation under the rules below | One database admission owner |
| Buffer capacity | Bounds bytes waiting in one transport direction; a full buffer applies backpressure | The transport endpoints |
| Read or delivery batch | Bounds one read or callback; does not limit total output | The reader or callback boundary |
| Initial allocation | Sets starting capacity for an allocation that may grow | The allocator or artifact producer |
| Execution capacity | Sets stack, guest memory or host-task capacity | The physical runtime or qualified build profile |
| Format bound | Follows a wire field, ABI layout or platform requirement | The format contract; ordinary configuration cannot change it |

The 128 MiB admission watermark, a 128 MiB frontend-message limit and the
native TypeScript broker's 128 MiB response-collection limit need independent
names and enforcement. A 64 KiB read batch must remain independent of a
256 KiB ring, PostgreSQL page size and maximum callback delivery.

## Where configuration belongs

Use small typed values on existing builders, open configurations, storage
factories and tool runners. Avoid a generic resource manager, arbitrary
key/value settings or a new environment variable for every constant.
The names below identify concepts; their language spelling can differ.

| Proposed concept | Fields | Scope and applicability |
| --- | --- | --- |
| Admission limits | `maxPendingOperations`, `highWaterMarkBytes` | Per database execution owner, shared by clones and transaction handles; asynchronous SDK admission only |
| Streaming options | `bufferCapacityBytes`, `maxChunkBytes` | Usable buffering per transport direction and maximum delivered chunk; read scratch sizes derive from the selected chunk where applicable |
| Protocol limits | `maxFrontendMessageBytes`, `maxRequestBytes`, `maxBackendMessageBytes`, `maxBufferedResponseBytes` | Separate message, complete-request and collected-response acceptance; introduce only fields the product actually enforces |
| Timeout options | `startupTimeoutMs`, `shutdownTimeoutMs` in JS; native duration types where idiomatic | Per physical runtime; retain existing mobile broker startup/operation options |
| Desktop broker handshake | Implemented: `broker.handshakeTimeoutMs` in native TS; `.broker_handshake_timeout(Duration)` on both native Rust builders | Per accepted SQL/management connection, ending after login. CLI `--handshake-timeout-ms`; default 5000. Separate from startup wait, SQL and backup lifetimes |
| OPFS options | `maxConcurrentIO`, `spareFileCount` | On the storage descriptor; concurrent helper I/O and the unused worker-handle reserve |
| Tool output options | `stderrTailBytes`, `terminateGraceMs` | Diagnostic tail on streaming summaries; termination grace applies to native subprocess tools only |
| Runtime build profile | Guest stack, initial/maximum guest memory and Postmaster task capacity | Producer-owned and included in artifact identity; native backend stack is a separate physical-runtime setting |

Implemented controls are listed in the status above. Protocol quotas and
additional batching options still require complete producer/consumer proof. A management-frame ceiling remains owned by the broker protocol until
an actual supported management operation needs consumer tuning.

The prepared-runtime cache is shared within a JavaScript realm. A per-database
cache-capacity option would let unrelated opens change each other's retention.
Keep its current bound until cache configuration has an explicit client/host
owner. Clock fallback and interrupt sampling also remain named internal policy:
changing them requires deadline and pending-work evidence, not a throughput
benchmark alone.

PostgreSQL memory, WAL and SQL deadlines continue through `startupGUCs` and
ordinary SQL settings. Do not create parallel SDK `workMem`, durability or
statement-timeout controls. Blocking Rust databases have no SDK operation queue;
their builders should not accept an admission setting that does nothing.
Endpoint-only server handles also have no application query queue. Put admission
on database builders rather than their shared server options; external
PostgreSQL clients own their pools and queues. A direct JS placement still has
SDK admission because its public operations use an asynchronous serial gate.

## Proposed product bindings

The tables mix implemented concepts with remaining proposals; use the public
performance guide for executable API examples. Transport and lifecycle fields
exist only for their owning placements. Types follow each product's current
naming style. Native Rust exposes lifecycle durations directly through
`.startup_timeout(...)` and `.shutdown_timeout(...)`, rather than the earlier
proposed `.timeouts(...)` wrapper.

### Existing storage constructors and filesystem inputs

Prefer the constructors already exported by each product:

| Product | Current constructor and input |
| --- | --- |
| Native TS | `directory(string | URL)` from `/storage/node`, `/storage/bun` or `/storage/deno` |
| WASIX TS desktop | `directory(string | URL)` from the corresponding host storage subpath |
| WASIX TS browser | `opfs(name)` or `indexedDB(name)`; these names identify origin storage, not OS paths |
| React Native | `directory(absolutePathOrLocalFileURI)` and `applicationData(name)`; current input is a string |
| Native/WASIX Rust | `DatabaseStorage::Directory(PathBuf)`; native seed/ICU directory and manifest fields already use `PathBuf` |
| Swift | `.directory(URL)` or `.applicationData(name:)`; validate a local file URL |
| Kotlin Android | `DatabaseStorage.Directory(File)` or `ApplicationData(name)`; runtime resource overrides also accept `File` |
| Native C | UTF-8 path strings at the ABI boundary; native path conversion belongs in the language binding |

Node's `path.join` and `path.resolve` return strings; there is no standard
Node `Path` instance to require. A filesystem input should accept a path
string or a `file:` URL object and use `fileURLToPath` for URL conversion.
Do not use `URL.pathname`, which mishandles percent encoding and Windows
paths. Keep string support and existing relative-path resolution; constructors
validate/describe storage and do not create it. See the platform
[path](https://nodejs.org/api/path.html) and
[file URL](https://nodejs.org/api/url.html#urlfileurltopathurl-options) APIs.

Native TS now uses one `string | URL` input rule for seed/ICU
`directory` and `manifestPath`, runtime/library/helper paths, Unix socket
directories, backup destinations and tool file destinations. Previously,
passing URL objects to seed fields failed with `value.trim is not a function`.
A shared private converter normalizes once before snapshotting or crossing a
worker/broker/FFI boundary; normalized records retain strings. Keep using the existing `directory()` constructor for storage.
No custom path class, new dependency or mandatory resource-record factory is
needed. Node `Buffer` paths are not implied: the FFI still requires supported
text encodings.

Keep Rust's `Path`/`PathBuf`, Swift's Foundation file `URL` and Kotlin's
existing `File`. Android currently supports API 24; `java.nio.file.Path`
starts at API 26, so replacing `File` would narrow platform support. A caller
on a compatible platform can convert a default-filesystem `Path` to `File`.
React Native mobile filesystem APIs commonly return URI strings; keep that
supported form without importing Node path utilities. WASIX archive/ICU inputs
may be fetchable URLs or owned bytes: preserve their asset-source contract
rather than treating them as local filesystem paths.

| Product | Developer supplies settings through | Proposed additions |
| --- | --- | --- |
| Native Rust, asynchronous database | `AsyncOliphaunt::builder()` | `.admission(AdmissionLimits)`, `.streaming(StreamingOptions)`, `.protocol(ProtocolLimits)`, `.runtime(NativeRuntimeOptions)`; `.timeouts(RuntimeTimeouts)` for broker placement |
| Native Rust, synchronous database | `Oliphaunt::builder()` | Same transport, protocol and native-runtime options; broker timeouts; no admission option |
| Native TypeScript | `Oliphaunt.open(OpenConfig)` | `admission`, `streaming`, `protocol`, `runtime`; `timeouts` for broker placement |
| Swift | `OliphauntDatabase.open(configuration: OliphauntConfiguration)`; broker equivalent accepts the same configuration | `admission: OliphauntAdmissionLimits`, `streaming: OliphauntStreamingOptions`, `protocol: OliphauntProtocolLimits`, `runtime: OliphauntNativeRuntimeOptions` |
| Kotlin | `Oliphaunt.open(context, config: OliphauntConfig)`; broker equivalent accepts the same configuration | `admission: AdmissionLimits`, `streaming: StreamingOptions`, `protocol: ProtocolLimits`, `runtime: NativeRuntimeOptions` |
| React Native | `Oliphaunt.open(OpenConfig)` | `admission`, `streaming`, `protocol`, `runtime`; forward to the Swift/Kotlin owner instead of retaining a conflicting lower fixed cap |
| WASIX Rust, asynchronous database | `AsyncOliphaunt::builder()` | `.admission(AdmissionLimits)`, `.streaming(StreamingOptions)`, `.protocol(ProtocolLimits)` |
| WASIX Rust, synchronous database | `Oliphaunt::builder()` | Delivery-chunk and protocol options; no admission option or raw-query buffer capacity when callbacks have no queue |
| WASIX TypeScript, root/direct/Worker databases | Each entry point's existing `Oliphaunt.open(OpenConfig)` | `admission`, `streaming`, `protocol`; `timeouts` on isolated placements that can retire their owner; browser Worker ring capacity, not a no-op capacity on direct callbacks |
| Native C ABI | Explicitly versioned native configuration and stream options | Native stack, owned stream capacity, delivery chunk and runtime-enforced protocol limits; no SDK admission, OPFS or tool-runner policy |

Use `maxPendingOperations` and `highWaterMarkBytes` in TS, Swift and Kotlin;
Rust uses `max_pending_operations` and `high_water_mark_bytes`. Swift's
admission initializer labels both values. Kotlin uses named constructor
arguments. Rust can require both through
`AdmissionLimits::new(max_pending_operations, high_water_mark_bytes)` and
validate at open, following the existing builder validation boundary.

`NativeRuntimeOptions` contains `backendStackBytes` (Rust
`backend_stack_bytes`). This is the native PostgreSQL backend thread stack,
selected before creation, not guest memory or the SQL stack-depth guard.
The embedded native stream queue uses `streaming.bufferCapacityBytes`.
WASIX raw callbacks without a byte queue accept only `maxChunkBytes`; direct
tool sockets keep their capacity with tool-runner transport options. Do not
conflate a socket read scratch allocation with queued transport capacity.

Keep mobile lifecycle options at their existing broker owner. Swift retains
`OliphauntBrokerOptions.startupTimeout` and `operationTimeout` as `Duration`,
adding `shutdownTimeout` only with enforceable retirement. Kotlin retains
`OliphauntBrokerOptions.startupTimeoutMillis` and `operationTimeoutMillis`,
adding `shutdownTimeoutMillis`. React Native retains
`broker.startupTimeoutMs` and `broker.operationTimeoutMs`, adding
`broker.shutdownTimeoutMs`. Preserve the existing timeout scopes; do not add
a competing `timeouts.startupTimeoutMs` to these mobile configurations.
New Rust lifecycle fields use `Duration`; new JS fields use the `Ms` suffix.

Listening server builders/configurations expose lifecycle and PostgreSQL
settings, not database admission or embedded raw-query buffer fields. If a
server product owns a separately bounded proxy, its limits belong to that
proxy. Audit `ServerOpenConfig` inheritance when adding database fields so
server options cannot accidentally accept unsupported controls.

The native Rust server builders are exported by `oliphaunt`. WASIX Rust
server builders are exported by the separate `oliphaunt-pgwire-server` crate,
not by the root `oliphaunt-wasix` database crate. Current native desktop TS
`libraryPath` selects the direct binding; do not present it as a broker
configuration override.

### Storage, tools and artifact producers

| Product/owner | Proposed supply and field names | Meaning |
| --- | --- | --- |
| Browser OPFS | `opfs(name, { maxConcurrentIO, spareFileCount })` | Concurrent helper I/O and unused direct-worker handles; no corresponding setting on IndexedDB or directory storage |
| Native npm tools | Existing `pgDumpToStream`/`psqlToStream` and file-runner options gain `stderrTailBytes`, `maxChunkBytes`, `terminateGraceMs` | Retained diagnostic tail, maximum destination write, native subprocess termination grace |
| WASIX npm tools | Existing destination options gain `stderrTailBytes`, `maxChunkBytes`; queued transports additionally accept `bufferCapacityBytes` | Forward through the existing database/tool runner; no subprocess kill grace for an in-process guest |
| Native and WASIX Rust tools | Existing `PgDumpOptions`/`PsqlOptions` gain `.stderr_tail_bytes(...)` and `.max_chunk_bytes(...)` for destination runners; WASIX tool sockets also gain `.buffer_capacity_bytes(...)` | Keep full-capture methods' stderr semantics; reject destination-only settings there rather than silently ignoring them |
| Native runtime producers | Existing canonical C API and native SDK bindings | Stack/stream configuration requires a versioned layout or entry point, with every consumer updated |
| Embedded WASIX runtime producer | Named build-profile fields `guestStackBytes`, `initialMemoryBytes`, `maxMemoryBytes`, `executionStackBytes` where the producer controls that resource | Guest stack lies within linear memory; host execution stack is separate; settings create a new qualified artifact identity |
| WASIX Postmaster producer | The same applicable memory/stack names plus `threading.maxGuestThreads`, `maxBlockingThreads`, `asyncWorkerThreads`, `coreBlockingThreads`, `blockingThreadIdleTimeoutMs` | Guest thread admission, maximum blocking-worker pool, async executor workers, retained blocking core and excess-worker idle lifetime; qualify with connection/worker GUCs and the receipt |
| Runtime, seed, ICU and extension importers | Role-owned archive policy: `maxCompressedBytes`, `maxExpandedBytes`, `maxEntries`, `maxEntryBytes`, and applicable `maxPathBytes`/`maxPathDepth` | Enforce while fetching/decompressing/extracting; reuse existing shared extension policy rather than introduce per-open duplicates |

Platform carrier packages, cluster seeds and ICU artifacts do not introduce
independent app-facing knobs. Build helpers and Gradle/Expo plugins relay the
selected producer settings; they do not redefine query admission. Do not add
per-open cache capacity for the realm-shared prepared-runtime cache. Internal
clock sampling, ABI text layouts and protocol representation bounds remain
outside ordinary application tuning.

Use the Postmaster threading names rather than the earlier `maxHostTasks`
proposal: the current 96 value is applied both to guest `max_threads`
capability and the blocking pool's `max_size`, not to every asynchronous task.
The producer must validate the coupled capacities against its PostgreSQL role
budget; the five fields are not independent promises of safe configurations.

### Read the tradeoffs without implementation terminology

| Option | What it controls | Raising it |
| --- | --- | --- |
| `maxPendingOperations` | How many accepted calls can be preparing, waiting or running | Accepts bigger bursts; does not add SQL parallelism and can increase waiting time |
| `highWaterMarkBytes` | How much SDK-owned input and fixed operation buffering can be retained before new calls wait/reject | Retains more input; one larger call can still run alone, and result/PostgreSQL memory is outside this watermark |
| `bufferCapacityBytes` | Bytes a producer may put ahead of a slower consumer in each direction | Uses more buffering and may absorb bursts; a full buffer makes the producer wait |
| `maxChunkBytes` | Maximum bytes delivered in one callback/write | May reduce callback overhead; smaller chunks give finer delivery; neither limits total output |
| Message/request/collected-response limits | Maximum accepted size of that specific item | Accepts larger items with greater worst-case resource exposure; does not accelerate smaller items |
| `maxConcurrentIO` | Files OPFS helpers may process at once | May reduce setup time or increase storage contention; publication stays ordered |
| `spareFileCount` | Unused direct-worker file handles maintained between operations | Higher values reduce durable overflow staging but increase startup and browser resource use. Zero is valid; this is not a database file-count limit |
| `stderrTailBytes` | Latest diagnostic bytes retained after a streaming tool run | Keeps more error context; complete stderr can still be sent to a separate destination |
| Lifecycle timeout | How long the owned lifecycle phase may wait before reporting failure/retiring its owner | Accommodates slower startup/cleanup, while delaying failure detection; not an SQL runtime limit |
| Native/guest/execution stack capacity | Space available for that stack's nested calls | Costs more capacity and may support deeper calls; it does not make ordinary SQL faster |

For example, a 256 KiB queue and 64 KiB maximum chunk describe waiting space
and a delivery unit. A large stream can pass through repeatedly. A separate
128 MiB backend-message cap can still reject one oversized encoded row. A
128 MiB input watermark instead limits retained accepted work; it is neither
of those transport limits and is not a total-memory bound.

## Admission semantics

### Legacy behavior when admission is omitted

| Owner | Count release | Byte accounting and release | Saturation |
| --- | --- | --- | --- |
| Shared TS `OperationBudget`, used by native, WASIX and React Native | After the ordered owner closure settles | Charges input allowances and browser tool-channel allocations before their protected copies/allocations; releases at owner settlement | Rejects |
| Native Rust async executor | On dequeue; excludes executing work | Estimates before encoding, then charges queued request allocation capacity; releases on dequeue | Ordinary Rust futures await fair capacity |
| WASIX Rust async owner | On dequeue; excludes executing work | Reserves an input allowance before construction; the byte permit remains through the owner action | Rust futures await; private Node-API submissions try admission |
| Swift serial gate | On active release or removal of an expired waiter | Charges encoded `Data` after construction; later bridge copies are behind the gate | Rejects |
| Kotlin admission | At ordered completion | Reserves through the request factory before encoding; completed reservations are removed at subsequent admission | Rejects |

Source owners are `src/query/ts/src/operation-budget.ts`, native Rust
`executor.rs`, WASIX Rust `async_api.rs`, Swift `Oliphaunt.swift` and
`OliphauntQuery.swift`, and Kotlin `Oliphaunt.kt`. The current count defaults
are 256 queued commands for native Rust and 64 for the other listed gates;
all use a 128 MiB byte budget. Those legacy count values are not equivalent. Explicit settings use the common
pending-operation lifetime below.

### Recommended common contract

1. One pending operation is one ordinary operation with an admission reservation,
   including preparation, queued and executing work until its owner settles.
   A Rust future still waiting for capacity has no reservation and must not
   construct an SDK snapshot. Its caller-owned input remains outside this budget.
2. Reserve the count and byte allowance before SDK copies, encoding or fixed
   transport allocations. Swift structured operations must use an admitted
   request factory instead of passing already-encoded `Data` into the gate.
3. Account conservative input/encoding allowances and operation-owned fixed
   buffers. Release only when the corresponding owned data is no longer retained;
   caller rejection alone is insufficient. Results, PostgreSQL memory,
   caller-owned inputs and destination-owned buffering are outside this budget.
4. A larger-than-watermark ordinary operation is permitted only with no other
   ordinary reservation. Once the watermark is reached, later ordinary work
   waits or rejects, including zero-input work. Existing hard input limits still
   apply. This keeps large valid operations possible without describing the
   watermark as a hard memory ceiling.
5. Clones and transaction handles share the database policy. Transaction
   ownership is a separate lease: do not hold an ordinary reservation around
   the whole callback, which would deadlock child queries with a limit of one.
   Explicit admission charges BEGIN until its owner completes, then releases
   before invoking the callback. Commit, rollback, cancel and close
   must remain admissible for recovery while ordinary capacity is exhausted.
6. Within an SDK, transfer the logical reservation between its queue and
   execution stages; do not acquire it again at each stage. Across host
   boundaries, propagate policy values rather than new wire-level ticket IDs.
   Transport buffers have their own accounting. No sum of these budgets is a
   promise of total process memory.

### Compatibility and adoption

Omitting admission configuration preserves the existing product behavior,
including its count/byte release points, numerical defaults and wait/reject
behavior. An explicit admission value supplies both `maxPendingOperations` and
`highWaterMarkBytes` and uses the common contract above. Reject an
incomplete admission object rather than merging a pending-operation setting
with a legacy queued-only default. No public legacy-mode switch is needed.

This distinction makes configuring a limit a deliberate choice while keeping
existing integrations stable. Raising an explicit limit must also reach any
underlying owner; a lower fixed legacy cap must not silently defeat it.
Changing omitted/default behavior to the common contract is a separate release
decision after qualification. Swift preserves the omitted path's error ordering
and avoids additional size scans; explicit settings reserve before encoding.

Aligning the Rust release points is a behavior change. Parameterizing their
current constants alone does not implement this contract. Compare accepted
bursts and waiting time against the baseline; unchanged numeric values do not
prove unchanged admission. Do not publish `maxPendingOperations` in one SDK
with an undocumented queued-only interpretation.

## Buffering, batching and response acceptance

`bufferCapacityBytes` denotes usable capacity per direction. A browser ring allocates
that capacity plus its sentinel byte and six control words. Charge the actual
allocation before creation, including every protocol/stdout/stderr channel.
The current tool path uses two protocol channels plus up to two output channels;
changing one ring's capacity changes several allocations per execution.

`maxChunkBytes` bounds one delivered callback or destination write, not a whole
message or result; chunks can be smaller without waiting to fill the maximum.
Read scratch sizes derive from it where appropriate. An omitted chunk size may
derive from the selected buffer and the supported callback maximum; document
that formula. Reject an explicitly incompatible chunk size. Increasing a
configurable scratch size must not turn an existing fixed stack array into an
unchecked variable-sized stack allocation.

The current WASIX 64 KiB callback maximum is a declared API policy generated
from `src/wasix/runtime/protocol-contract/contract.json`. It is not a PostgreSQL
message-size rule. Smaller batches and different ring capacities can preserve
that callback contract. Larger callback delivery requires a coherent contract
and consumer update; changing a read buffer alone cannot authorize it.

For protocol limits, count complete messages including their length field and
type byte when present. Specify startup packets separately because they have
no type byte. A complete multi-message request and its summed response need
their own limits. Audit existing native TypeScript backend checks, which
currently compare the PostgreSQL length field before its type byte is added.

Enforce declared-message limits before accepting the body, and collection
limits during accumulation before concatenating or publishing a complete
result. Streaming output can exceed a collection quota. After any already
forwarded or delivered prefix, preserve the existing drain/recovery rules;
retire the session when synchronization cannot be proven. Do not publish a
partial dump as successful output.

A Web/Node stream watermark does not replace internal channel capacity or
destination acknowledgement. Await successful writes under the current output
contract; readiness alone is not completion. See the
[Streams queuing strategy](https://streams.spec.whatwg.org/#queuing-strategy)
and [Node buffering semantics](https://nodejs.org/api/stream.html#buffering).

## Lifecycle deadline boundaries

Lifecycle controls retain each owner's boundary. Native desktop startup runs
from helper/server launch through readiness after asset resolution; teardown
starts after ordinary work drains. Browser startup includes asset preparation,
storage setup and protocol readiness. Its Worker close deadline includes work
still draining after `close()` is requested, preserving bounded-close behavior.
Mobile recovery and destructive-close budgets are separate from startup and
operation budgets. Existing mobile operation timeouts also include queued time.
The public guide states these differences; equal names do not imply that a
native process and an in-process guest can be interrupted in the same way.

Use one monotonic deadline through each owned lifecycle phase rather than
resetting the full duration for every retry. A native tool's termination grace
starts at SIGTERM and governs escalation to SIGKILL; draining and reaping still
need explicit cleanup ownership. Report an unreaped owner or uncertain teardown
as failure, preserving the existing terminal state and retained ownership.

Only placements that can enforce the requested deadline may accept it. A
timer cannot preempt a synchronous direct guest call or arbitrary blocked host
callback. Worker/process retirement can be available where direct in-process
termination is unsafe. Document and validate that capability difference before
offering the same timeout field on both placements.

## Validation and propagation

Normalize once at the existing public configuration boundary, before resource
loading, storage mutation or worker startup. Freeze the selected policy for
its owner lifetime. A receiving worker, addon or broker validates the serialized
values again before allocating. A shared physical native backend must reject
an incompatible stack change on a later logical lease.

- Explicit admission objects provide both fields; other option groups may
  resolve omitted fields using their documented product or derived defaults.
- Counts, byte watermarks and buffer capacities are positive integers. A zero
  diagnostic-tail size may explicitly disable retention. Omission selects the
  documented default; zero, infinity and a negative number never mean unlimited.
- Validate checked addition and conversion against the actual consumer types.
  In particular, WASIX byte-semaphore requests currently use `u32`, and ring
  offsets use signed 32-bit atomics. A JavaScript safe integer alone is not a
  sufficient range check. Separate configurable policy ceilings from these
  representation bounds.
- Reject unknown fields in the new policy objects, unsupported settings and
  explicit values outside the supported range. Never silently clamp a requested
  value or accept a field that stops at an SDK facade.
- For typed settings, explicit per-owner values take precedence over an
  existing environment override and then the product default. Preserve and
  document legacy environment read timing until its migration is implemented.
  Validate legacy native numeric text completely; current `strtoull` paths
  accept numeric prefixes and do not consistently reject overflow/signs.
- Durations must fit the timer actually used. Current desktop TS startup
  parsers accept values beyond Node's 2,147,483,647 ms timer range. Reject such
  values for a single timer; supporting longer deadlines requires bounded
  rearming. Do not turn a requested long deadline into 1 ms.
- Admission-only changes need no guest or native C layout change. Native
  runtime queue/stack settings need an explicitly versioned C configuration
  change with all header/FFI consumers updated; the current `OliphauntConfig`
  has no size field permitting an unversioned tail extension.
- Policies stay outside the managed-root descriptor and physical-backup
  identity. Existing saved PostgreSQL configuration retains its own precedence.

Use a small build-time contract for shared admission definitions/defaults and
generate language constants with the repository's existing generator pattern.
Keep application admission out of the guest protocol ABI contract, and keep
provider-local defaults with their providers. Packaged SDKs consume generated
code, not repository JSON or a reflective configuration registry.

## Runtime and import capacity

Guest C stack, engine execution stack and PostgreSQL `max_stack_depth` are
different resources. Increasing the SQL guard does not allocate either stack.
Changing linked guest memory/stack or sealed Postmaster task capacity requires
updated producer identities and fresh artifacts. Keep the Postmaster task
budget consistent with its PostgreSQL connection/worker profile and verified
receipt. Existing memory guards and recovery guarantees remain requirements.

Distinguish a linked memory minimum from a host's selected initial capacity.
PGlite can select initial memory at construction. A future Oliphaunt host might
reserve a larger initial capacity without changing the guest layout if its
instantiation path supports that; prove the mechanism and product support
before promising the same option. The lower linked minimum and guest-stack
layout remain artifact properties. The browser host's own `init({ memory })`
type is not evidence of a PostgreSQL guest-memory override.

Archive policies belong to runtime, seed, ICU or extension import roles, with
compressed bytes, expanded bytes, entry count and member-size limits defined
separately. Preserve the existing shared extension archive policy. Apply fetch
and decompression budgets while data grows; the current WASIX TS tar check
after full decompression is only an acceptance check. Traversal, duplicate
paths, hashes, physical identity and create-only publication stay mandatory.

## Comments and developer documentation

At each owning constant or option, explain the scope and the tradeoff the name
cannot show. Shared API reference documentation records units, default, range,
counted resources, lifetime, saturation/overflow behavior and product support.
Explain the oversized-operation exception beside the admission watermark.

Write one shared tuning guide with SDK-specific controls linked from references:

| Setting | Increasing it | Decreasing it | Measure |
| --- | --- | --- | --- |
| Pending operations / admitted bytes | Absorbs larger bursts; retains more input and can increase queue delay | Applies backpressure earlier | Rejected/waiting calls, queue delay, peak retained bytes |
| Transport capacity | Allows a producer to run farther ahead of a slow sink | Reduces waiting-byte retention and adds wakeups | Throughput, peak memory, slow-sink cancellation |
| Read/delivery batch | May reduce calls and copying overhead; larger scratch/bursts | Improves delivery granularity; may add calls | Small-query latency, bulk throughput, first-byte latency |
| OPFS I/O concurrency | May reduce startup time or increase storage contention | Reduces overlapping file work | First open, reopen, retained memory, publication/recovery |
| Diagnostic tail | Retains more failure context | Retains less data; discarded text remains explicitly reported | Error usefulness and per-execution retention |
| Startup/shutdown timeout | Allows slower initialization/cleanup | Reports failure or escalates sooner | Slow devices, stalled peers, cleanup outcome |

Document currently available PostgreSQL settings and environment overrides as
current behavior. Add runnable SDK examples only when the proposed controls
exist and their installed consumers have executed them. Do not describe queue
limits as query parallelism or offer settings that enable unsupported guest
threads, async callbacks or persistence guarantees.

## Implementation acceptance

Extend the existing owner tests with the same semantic cases in every affected
SDK; a generator check alone cannot prove runtime propagation:

- A limit of one works for ordinary queries and queries inside transactions;
  recovery/close still enters a saturated owner queue.
- Count and byte boundaries reject or wait before snapshots/getters/encoding;
  preparation failure, caller expiry and owner failure release exactly once.
- A larger single operation and following zero-input work obey the watermark
  contract; conservative allowance is distinguished from actual heap usage.
- Two clones share the limit; independent databases remain independent.
- Omitted admission retains the baseline overload and cutoff behavior; the
  explicit two-field policy follows the same pending/retention contract in
  each SDK, including when set above the old fixed capacity.
- Non-default policy reaches direct/broker/Worker/Node-API/mobile owners where
  supported; invalid/unknown/unsupported values fail before external work.
- A small buffer and slow sink preserve ordering, cancellation, EOF and cleanup;
  callbacks stay within their declared maximum and outputs remain complete.
- Header-only tests cover frontend/backend/request/management limits without
  giant allocations. Collector and decoder tests distinguish total output from
  a single large row and preserve the terminal/reusable session outcome.
- Timeout boundary tests exercise the actual host timer. Archive limits reject
  during fetch/decompression and preserve existing path/publication validation.

Benchmark configurable values using the same frozen artifacts with small SQL,
large/fragmented COPY and tool output, slow readers, multiple databases and
cold/warm persistent opens. Report throughput, latency distribution, first
byte, peak and retained memory. Larger numbers are not evidence of improvement.

## Review evidence

Implementation checks are recorded in the maintainer inventory. Admission tests
cover small capacities, omitted defaults, pre-encoding rejection, recovery and
owner completion. OPFS tests cover descriptor snapshots and bounded backing reads.
Apple installed-host and alternative-size performance proof remain separate from
portable source tests; package checks do not establish those runtime claims.
