# Mobile stability model

Swift, Kotlin, and React Native use native direct mode. One process-resident
PostgreSQL backend owns one serialized physical session. React Native delegates
runtime behavior to the same Swift and Kotlin SDKs instead of maintaining a
third mobile runtime.

## Public lifecycle

The public operations are open, query/execute, buffered or callback-streamed raw
protocol, transaction, checkpoint, cancellation, backup, static restore, and
close. Applications decide how those operations map to foreground/background
events. There is no background-preparation mode or SDK-specific COPY object.

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

- repeated open/query/transaction/checkpoint/close cycles;
- cancellation and PostgreSQL readiness recovery;
- process kill followed by WAL recovery of persistent storage;
- physical backup and restore round trips;
- low-storage and interrupted initialization without descriptor publication;
- selected-extension activation; and
- React Native TurboModule/JSI ownership and typed-array offset cases.

Platform lifecycle policy remains application code because iOS and Android
suspension windows are not a portable database mode.
