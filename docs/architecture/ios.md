# iOS Runtime Architecture

iOS uses the Swift SDK over native `liboliphaunt` direct mode. React Native on
Apple platforms delegates to the same Swift implementation.

## Runtime boundary

- One PostgreSQL backend is resident in the app process.
- One physical PostgreSQL session is serialized by the SDK.
- Native runtime, cluster-seed, and exact selected-extension resources are packaged
  into the app.
- App-owned storage is a managed root containing exactly `pgdata` and the
  `.oliphaunt.json` descriptor. PostgreSQL owns `pg_wal` inside `pgdata`.
- PostgreSQL WAL recovery handles reopening persistent storage after process
  termination.

The iOS package does not expose broker, server, runtime-profile, capability,
initialization-mode, archive-format, or replacement-policy APIs.

## Lifecycle

Opening prepares or validates the managed root before starting the C runtime.
`close()` logically detaches the Swift handle so the same database can be
reopened while the process remains resident. A different root requires a fresh
process because native direct mode owns process-global PostgreSQL state.

Applications call `checkpoint()`, `cancel()`, and `close()` when appropriate for
their own UIKit or SwiftUI lifecycle policy. There is no SDK background or
foreground mode.

## Data movement

Backup returns the one physical archive format. Static restore writes to a new
or existing-empty destination. Restore rejects a non-empty destination and does
not expose a replacement switch. Applications must not copy a live PGDATA
directory.

## Concurrency and transport

Swift actors and the SDK executor keep database work off the main actor and
serialize access to the physical session. Typed queries, buffered raw protocol,
and callback-streamed raw protocol are public. Swift forwards the native C
stream callback without inventing a second protocol or COPY parser.

## Extensions

Extensions are selected exactly before building the app. The package contains
only selected extension resources and declared dependencies. Module-backed
extensions use the generated static registry and target-specific prebuilt
archives.

## Product limits

iOS direct mode does not provide process isolation or independent client
sessions. A local loopback listener would not change those semantics and is not
presented as server mode. Process-isolated Apple execution is outside the
current product and is not a dormant mode in the API.
