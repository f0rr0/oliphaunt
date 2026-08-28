# Mobile stability model

Swift, Kotlin, and React Native use native direct mode. One process-resident
PostgreSQL backend owns one serialized physical session. React Native delegates
runtime behavior to the same Swift and Kotlin SDKs instead of maintaining a
third mobile runtime.

## Public lifecycle

The public operations are open, query/execute/exec/describe, buffered or
callback-streamed raw protocol, transaction, cancellation, backup, static
restore, and close. PostgreSQL `CHECKPOINT` is available through ordinary
`execute`, not a dedicated method. Applications decide how those operations map
to foreground/background events. There is no background-preparation mode or
SDK-specific COPY object.

Direct close may logically detach the SDK handle while the backend remains
resident. Generation-guarded native cleanup prevents stale actor, coroutine, or
JavaScript finalizers from closing a newer logical lease. The app must use
broker/server on a supported desktop target when database-process crash
isolation is required.

## Storage

Mobile SDKs hydrate a packaged cluster seed into app-private storage and publish
the managed-root descriptor last. The C boundary validates complete PGDATA and
never runs `initdb`. A failed initialization cannot leave a descriptor-only
root that later opens as valid.

Persistent roots survive close. Physical backup uses the native archive;
restore accepts only a new or existing-empty destination. App migrations use
PostgreSQL SQL or logical dump/restore, not raw directory copies.

## React Native transport

React Native uses TurboModule for typed configuration and handle lifecycle and
JSI `ArrayBuffer` for raw protocol and archive bytes. The boundary preserves
typed-array offsets and avoids base64/JSON payload conversion. Raw protocol can
return one owned response or deliver response chunks through a callback.

## Scheduling contract

The async spelling is a caller contract, not a claim that PostgreSQL itself is
asynchronous. Native direct PostgreSQL calls are blocking internally, so each
mobile SDK moves them to an owned execution context:

| SDK | Public shape | Runtime owner | Cancellation and close |
| --- | --- | --- | --- |
| Swift | `async throws` | One dedicated serial dispatch queue owns root preparation, open, protocol work, backup, and close. | Transaction pinning and close are FIFO admission cutoffs: earlier permits drain and later incompatible calls fail. `cancel()` uses a separate control queue so it can interrupt the active owner call. |
| Kotlin | `suspend` | One single-thread coroutine dispatcher owns root preparation, JNI open, protocol work, backup, and close. | Transaction pinning and close are FIFO admission cutoffs. Admitted JNI work completes even if its caller is cancelled; close uses `NonCancellable`, while `cancel()` uses a separate control dispatcher. A phantom-reference fallback only enqueues forgotten-handle close on the owner. |
| React Native / Expo | JavaScript `Promise` | JSI copies binary arguments, then delegates to the same Swift or Kotlin SDK owner. | A thrown stream callback rejects its promise after native recovery confirms a known protocol boundary; an execution, transport, or recovery failure is authoritative instead. Invalidation stops callback delivery to the retiring runtime and schedules close without blocking the JavaScript, main, or UI thread. |

The synchronous callback used for raw protocol streaming is backpressure, not a
synchronous database API. The callback runs as part of the native owner's one
admitted operation; it must return before another chunk is produced. JavaScript
callbacks cannot be async, and all SDKs propagate a thrown callback as the
operation failure before releasing the owner for subsequent work when recovery
reaches a known PostgreSQL protocol boundary. If execution, transport, or
recovery fails, that failure takes precedence and the owner follows its normal
session-poisoning rules.

Admission and lifecycle state are one ordered contract. Publishing a transaction
pin or close cutoff cannot revoke an older permit that is already queued. BEGIN,
callback operations, ROLLBACK or COMMIT, and close occupy the same FIFO as normal
work. Only an outcome produced by earlier work, such as an unknown protocol
boundary that poisons the session, may reject a later admitted operation.
Cleaner/deinitializer paths are safety nets, not lifecycle APIs, and schedule
best-effort close on the same owner rather than running PostgreSQL on a runtime
finalizer thread.

The mobile bridges call `oliphaunt_copy_last_error` on the native operation's
calling thread and move its operation-local snapshot into language-owned
memory. The size probe and copy remain stable if the separate cancellation
owner updates the handle-wide fallback concurrently. The C boundary exposes no
borrowed error pointer for a bridge to retain across a native call or thread
hop.

## Extensions and packaging

Mobile builds package exact extension selections. Swift and Kotlin register the
matching static extension modules before first native init; React Native's
config plugin arranges those same artifacts in the app build. Runtime selection
must match what the installed application actually carries.

## Qualification

The pre-build mobile closure gates prove compile/header ABI compatibility only.
They intentionally do not claim runtime execution. Android x86_64 emulator and
iOS simulator installed-app tests consume those exact candidate closures,
validate the selected catalog profile, and reopen persistent storage. Their
PASS receipts are required by the top-level E2E gate, which is the final mobile
release execution qualification.

Mobile release evidence covers:

- repeated open/query/transaction/explicit-`CHECKPOINT`/close cycles;
- cancellation and PostgreSQL readiness recovery;
- process kill followed by WAL recovery of persistent storage;
- physical backup and restore round trips;
- low-storage and interrupted initialization without descriptor publication;
- selected-extension activation; and
- React Native TurboModule/JSI ownership and typed-array offset cases.

Platform lifecycle policy remains application code because iOS and Android
suspension windows are not a portable database mode.
