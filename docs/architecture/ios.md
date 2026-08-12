# iOS Architecture Investigation

This document evaluates the strongest iOS architecture for `liboliphaunt` without
assuming the current direct-mode shape is the final answer.

## Confidence Reframe

The iOS product should not depend on a speculative broker to feel reliable.
The reliable, shippable baseline is:

- crash-consistent storage through PostgreSQL WAL;
- a resident in-process engine with one database instance and one physical session;
- explicit lifecycle APIs for backgrounding, cancellation, checkpoint, backup,
  and logical detach;
- test evidence that app relaunch after process death reopens the same persistent storage
  cleanly.

That is not crash isolation. It is crash consistency. If native PostgreSQL
crashes in direct mode, the host app process dies. The next app launch should
recover the database by WAL replay and reopen the same persistent storage. That is the honest
guarantee we can make on every supported iOS version.

Crash isolation is a different product capability. On iOS it requires a proven
separate process. Today the only credible Apple-supported path is
`ExtensionFoundation.AppExtensionProcess` on iOS 26+. That should be built as a
separate, availability-gated `NativeExtensionBroker` mode. If it fails the
feasibility gate, the product answer is not to fake isolation in direct mode;
the answer is that iOS supports fast embedded direct mode, and crash-contained
embedded PostgreSQL is unavailable on that OS/configuration.

## Hard Constraints

### iOS Does Not Have A General Helper Daemon Model

The macOS-style "app plus bundled XPC service" model is not generally available
to iOS apps. The iPhoneOS SDK marks `NSXPCConnection.init(serviceName:)` and
Mach-service creation unavailable on iOS, and the Foundation `Process`/`NSTask`
API is not present in the iPhoneOS Foundation headers. The App Store rules also
require apps to stay self-contained and not download, install, or execute code
that changes app functionality after review.

Implication: a robust iOS database process cannot be designed as a normal
spawned helper, launch agent, or app-owned daemon.

### ExtensionFoundation Is Real, But It Is Not A Normal Daemon

Starting in the current iOS SDK, `ExtensionFoundation.AppExtensionProcess` is
available on iOS 26+. It creates or attaches to a separate app-extension
process, exposes `makeXPCConnection()` and `makeXPCSession()`, and reports
unexpected extension termination through an interruption handler.

This is the first credible Apple-supported path to iOS process isolation for
`liboliphaunt`. It still has limits:

- it requires iOS 26+;
- it runs an app extension, not an arbitrary service;
- the host must keep a strong `AppExtensionProcess` reference;
- the system can suspend an extension if no XPC connection is established;
- an app extension is not a long-running background worker;
- app and extension storage must be explicit, usually through an App Group;
- one extension identity appears to map to one running process, so it should
  not be treated as an unlimited worker pool.

Implication: an iOS broker is possible enough to deserve a serious spike, but
it must be modeled as a constrained extension-process broker, not as the same
broker implementation we can ship on macOS or Android.

### Background Execution Is Finite

UIKit gives apps a short background window and a finite extension mechanism via
`beginBackgroundTask`. BackgroundTasks can relaunch the app for scheduled work,
but not as an interactive database server. App extensions cannot call
`UIApplication` and must use extension-safe background mechanisms.

Implication: iOS cannot promise an always-on local PostgreSQL service. The SDK
should make foreground database calls fast, finish or cancel foreground work
cleanly when the app backgrounds, and use scheduled background work only for
maintenance such as checkpoint, vacuum policy, sync, or backups.

### PostgreSQL Wants A Process Boundary For Crash Recovery

Normal PostgreSQL robustness comes from a supervisor process, child backend
processes, shared-memory reinitialization after abnormal child death, and WAL
replay after immediate shutdown or crash. Our embedded direct path starts a
standalone PostgreSQL backend inside the app process and routes FE/BE protocol
I/O through host callbacks.

The direct path can recover from PostgreSQL `ERROR`, protocol errors,
cancellation, and many controlled `proc_exit` paths. It cannot recover from a
native crash, abort, memory corruption, or process-wide PostgreSQL global state
poisoning without taking down the app process. Full in-process close/reopen
across arbitrary database instances is not a sound product promise until PostgreSQL can be
proven re-entrant under our patches.

Implication: direct mode can be SQLite-like in latency and embedding, but not in
crash containment. Only a separate iOS extension process can make PostgreSQL
death survivable for the host app.

## Brittle Assumptions To Remove

The architecture should explicitly reject these assumptions:

- `close()` means full PostgreSQL shutdown. In mobile direct mode it does not;
  it is logical detach from a resident process-wide runtime.
- Lifecycle recovery is not one capability. Same-instance logical reopen,
  instance switching, and crash restart are separate properties.
- iOS broker means desktop broker. iOS process isolation is extension-process
  isolation with lifecycle and OS-version limits.
- iOS server mode can be emulated with a loopback listener. That gives a
  connection-shaped API without PostgreSQL's real process semantics.
- background execution can keep an interactive database alive indefinitely. It
  cannot.
- WASIX makes iOS direct mode safe. A same-process Wasm runtime may improve
  portability or memory sandboxing, but it does not provide host-app survival
  after database runtime failure.

Removing these assumptions makes the architecture less magical and more
defensible.

## Candidate Architectures

| Candidate | Strengths | Failure Modes | Verdict |
| --- | --- | --- | --- |
| In-process `NativeDirect` | Lowest latency, App Store viable on all supported iOS versions, simplest Swift/RN DX, static extensions work | App crashes if native PostgreSQL crashes; one resident instance/session; logical close only | Ship as universal fast path, with honest capabilities |
| In-process multi-session | Looks like server semantics without IPC | PostgreSQL globals, shared memory, signals, session state, temp objects, GUCs, transactions; no crash isolation | Reject unless upstream PostgreSQL grows a real embeddable multi-session runtime |
| In-process loopback server | Familiar connection string shape | No process isolation; true multi-client sessions still require PostgreSQL's process model; background behavior is misleading | Do not ship on iOS |
| Spawned helper/XPC service | Would solve crash isolation and restart | Not generally available to iOS apps | Reject for App Store iOS |
| ExtensionFoundation broker | Separate process, XPC, interruption handling, App Store-shaped packaging path on iOS 26+ | New OS floor, extension lifecycle limits, likely one process per extension identity, App Group storage, unknown memory/throughput ceilings | Best robust iOS direction; spike and gate before promising |
| System extension / Network Extension / File Provider abuse | Separate process in some cases | Wrong extension point, entitlement/review risk, user-visible policy mismatch | Reject |
| BackgroundTasks broker | System-supported background launch | Scheduled, finite, non-interactive; not request/response | Use only for maintenance |
| Separate WASIX product | Portable runtime and sandboxed memory model | Not a native engine mode and does not create iOS process isolation | Keep outside the native iOS product architecture |
| Remote/cloud broker | Strong isolation | Not embedded/offline, not SQLite competitor | Out of scope for the embedded product |

## Recommended iOS Product Shape

### 1. Universal Fast Path: `NativeDirect`

`NativeDirect` should remain the default iOS runtime for broad OS support and
low latency. It should be marketed as an embedded single-session PostgreSQL
runtime, not as a local server.

The API should present this as an app-scope resident database, not a disposable
object that happens to keep native state behind the scenes.

Contract:

- one resident PostgreSQL backend per app process;
- one physical session;
- one database instance per process lifetime;
- many Swift/RN callers may enqueue work, but execution is serialized;
- transaction APIs pin the physical session and reject unpinned work;
- `close()` is logical detach, not full PostgreSQL shutdown;
- same-instance logical reopen is supported;
- instance switching requires a fresh process;
- native crashes terminate the host app;
- WAL recovery happens after the app relaunches and opens the same persistent storage.

DX requirements:

- provide an app-scope `OliphauntContainer` or `OliphauntResidentDatabase` manager;
- open once per app process and reuse stable handles;
- make `close()`/`detach()` release the logical SDK handle only;
- provide explicit persistent-storage removal only when its database is not
  resident in the current process;
- provide `fullShutdown` as unsupported in iOS direct mode rather than a best
  effort;
- serialize all work through a fair owner queue;
- expose query cancellation and statement timeouts;
- make transaction helpers pin the physical session and reject unpinned work;
- expose `prepareForBackground(deadline:)` and `resumeFromBackground()`;
- default Swift/RN integrations should register lifecycle hooks when the app
  framework is present, while still allowing manual control.

This turns the current "close is special" behavior into the public model rather
than a surprising implementation detail.

### 2. Robust Path: `NativeExtensionBroker` On iOS 26+

The best process-isolated iOS architecture is a bundle-only custom app extension
owned by the app and launched through `ExtensionFoundation.AppExtensionProcess`.
The extension owns `liboliphaunt`, the PostgreSQL runtime, and the selected static
extensions. The host app talks to it over XPC/XPCSession.

Target contract:

- host app defines a bundle-only extension point for `liboliphaunt`;
- broker extension links the same `liboliphaunt` C ABI and selected extension
  objects;
- PGDATA and runtime resources live in an App Group container;
- XPC messages carry control requests and raw protocol chunks;
- the broker serializes one physical PostgreSQL session per opened instance;
- host observes `onInterruption`/XPC invalidation and marks in-flight requests
  as failed with unknown transaction outcome;
- reconnect starts a fresh extension process and reopens the same persistent storage after
  WAL recovery;
- no automatic replay of writes unless the user opts into an idempotent request
  envelope;
- capability reporting says `processIsolated=true`,
  `crashRestartable=true`, and `independentSessions=false`.

Important limit: this should not advertise `multipleInstances=true` until proven. If
one extension identity maps to one running process, and `liboliphaunt` embeds one
process-wide PostgreSQL runtime, then iOS broker v1 is still a single-instance
process-isolated runtime. A future multiple-instance design would need either a
defensible worker-slot model with multiple bundled extension identities, or a
much deeper PostgreSQL re-entrancy breakthrough.

This mode should fail closed:

- unavailable below iOS 26;
- unavailable without the broker extension target;
- unavailable without the required App Group;
- unavailable when extension lifecycle or XPC throughput evidence is missing;
- unavailable for multiple-instance unless worker multiplicity is proven.

It should be named and documented as iOS process-isolated mode, not as generic
desktop broker parity.

### 3. Server Mode: Explicitly Unavailable On iOS

`NativeServer` should not be faked on iOS. A same-process loopback listener does
not provide independent sessions or crash isolation, and a real PostgreSQL
postmaster-style process tree is not an iOS app model. If a future
ExtensionFoundation broker can safely host a compatibility socket for one client,
that should be named as compatibility, not as true server mode.

## Lifecycle Policy

The SDK should provide explicit lifecycle APIs instead of hoping app authors
guess correctly:

- `prepareForBackground(deadline:)`: stop accepting new work, cancel or allow
  bounded active work, optionally `CHECKPOINT` if idle, then return before the
  system deadline.
- `resumeFromBackground()`: verify the session still responds; if broker mode
  was interrupted, reconnect and reopen.
- `cancel()`: interrupt the current PostgreSQL statement and surface a normal
  PostgreSQL cancellation error when possible.
- `checkpoint()`: explicit durability boundary for apps about to background.
- crash drill helpers for tests: kill broker extension, kill host process, and
  reopen persistent storage to prove WAL recovery.

For direct mode, background handling improves data durability and UX but cannot
make native PostgreSQL crash-isolated. For broker mode, background handling must
also account for the extension being suspended or killed independently.

The mobile SDK should treat lifecycle as part of the database API:

- every long-running call accepts cancellation;
- every queued call has a bounded wait/cancellation path;
- background transition blocks new work before attempting checkpoint/cancel;
- foreground transition verifies the live session with a cheap query or protocol
  sync before accepting normal traffic;
- memory warning handling can recommend `DISCARD ALL`, checkpoint, or app-level
  query cancellation, but must not pretend to free PostgreSQL's process-wide
  runtime in direct mode.

## Extension Policy

iOS extension support should stay static and opt-in:

- selected extensions are compiled into the app and, for broker mode, into
  the broker extension target;
- SQL/control/share assets are packaged as resources and copied/materialized by
  the SDK;
- `CREATE EXTENSION` succeeds only when the selected extension is present and its
  static registry is ready;
- dynamic extension loading is not the portable iOS path;
- downloading executable extension code after review is not allowed.

This is the right tradeoff for iOS package size, App Store review, and
predictable crash/debug symbols.

## Capability Vocabulary Needed

iOS needs distinct lifecycle capability fields across Swift, Kotlin, Rust, and
React Native:

- `sameInstanceLogicalReopen`
- `instanceSwitchable`
- `crashRestartable`
- `processIsolated`
- `independentSessions`
- `maxClientSessions`
- `multipleInstances`
- `backgroundContinuable`
- `requiresAppGroup`
- `minimumOS`

This avoids selling direct mode as more recoverable than it is, and avoids
selling an iOS extension broker as a full desktop broker before worker
multiplicity is proven.

Example direct-mode capabilities:

```json
{
  "engine": "nativeDirect",
  "processIsolated": false,
  "sameInstanceLogicalReopen": true,
  "instanceSwitchable": false,
  "crashRestartable": false,
  "independentSessions": false,
  "maxClientSessions": 1,
  "backgroundContinuable": false
}
```

Example extension-broker capabilities after the feasibility gate passes:

```json
{
  "engine": "nativeExtensionBroker",
  "processIsolated": true,
  "sameInstanceLogicalReopen": true,
  "instanceSwitchable": false,
  "crashRestartable": true,
  "independentSessions": false,
  "maxClientSessions": 1,
  "backgroundContinuable": false,
  "requiresAppGroup": true,
  "minimumOS": "iOS 26"
}
```

The broker should not report `instanceSwitchable=true` or `multipleInstances=true` until a
real multi-worker model is proven.

## Direct-Mode Confidence Gate

Direct mode is shippable on iOS only when these tests pass on simulator and real
devices:

1. Open the same persistent storage repeatedly through the app-scope manager and
   prove all logical handles share the resident runtime.
2. Reject opening a different database instance in the same process with a precise error.
3. Run concurrent Swift tasks/RN promises and prove fair serialization,
   transaction pinning, cancellation, and close/detach behavior.
4. Enter background during idle, during a read, during a write transaction, and
   during a long-running query; prove the lifecycle policy either finishes
   within deadline or cancels cleanly.
5. Kill the app process after committed writes, after uncommitted writes, and
   during WAL activity; relaunch and prove PostgreSQL recovery returns a
   consistent database.
6. Inject PostgreSQL `ERROR`, malformed protocol, cancellation, and controlled
   `proc_exit`; prove the host surfaces errors without corrupting the session
   when PostgreSQL allows recovery.
7. Inject an actual native crash in the backend thread; document that direct
   mode crashes the host app, then prove app relaunch recovers the database.
8. Verify selected static extensions, backup/restore, memory warning
   handling, and package-size reporting.

This gate does not claim direct mode is crash-isolated. It proves the direct
mode guarantee: fast, single-session, crash-consistent embedded PostgreSQL.

## Feasibility Gate For The iOS Broker

Do not productize `NativeExtensionBroker` until these pass on real devices:

1. Build an iOS 26+ app with a bundle-only custom ExtensionFoundation extension
   point and a broker extension target.
2. Start the extension, establish XPCSession or NSXPCConnection, and roundtrip a
   1 MB binary payload without JS/UI blocking.
3. Link `liboliphaunt` into the extension, open a packaged-template PGDATA directory in
   an App Group container, run `SELECT 1`, close, and reopen.
4. Kill the extension process during idle and during a transaction; host app
   must stay alive, report unknown transaction state, reconnect, and pass WAL
   recovery.
5. Background and foreground during an active query; the SDK must either finish
   within the deadline or cancel cleanly.
6. Package selected static extensions in the extension and verify
   `CREATE EXTENSION vector` and `CREATE EXTENSION graph` when selected.
7. Measure XPC raw protocol RTT, streaming throughput, memory, app IPA size, and
   extension memory ceiling against direct mode.
8. Verify TestFlight/App Store review viability with the extension declared as a
   private bundle-only app extension and no downloaded executable code.

## Decision

The strongest iOS architecture is a two-tier product:

- `NativeDirect` is the universal, fastest, SQLite-competitive embedded mode.
  It must be honest about single-instance, single-session, logical close, and lack
  of crash isolation.
- `NativeExtensionBroker` is the best robust iOS mode for iOS 26+ if the
  feasibility gate passes. It gives the host app a recoverable process boundary,
  but should start as single-instance and single-session rather than pretending to
  be a desktop broker.

The separate WASIX product does not solve native iOS stability unless it runs
out of process. It is not a fallback mode inside this native product and is
outside this architecture decision.

## References

- Apple ExtensionFoundation `AppExtensionProcess`:
  https://developer.apple.com/documentation/ExtensionFoundation/AppExtensionProcess
- Apple custom app-extension support:
  https://developer.apple.com/documentation/extensionfoundation/adding-support-for-app-extensions-to-your-app
- Apple app extensions overview:
  https://developer.apple.com/documentation/technologyoverviews/app-extensions
- Apple background execution:
  https://developer.apple.com/documentation/uikit/extending-your-app-s-background-execution-time
- Apple App Store Review Guidelines:
  https://developer.apple.com/app-store/review/guidelines
- PostgreSQL server shutdown and WAL recovery:
  https://www.postgresql.org/docs/current/server-shutdown.html
- PostgreSQL `CREATE EXTENSION`:
  https://www.postgresql.org/docs/current/sql-createextension.html
