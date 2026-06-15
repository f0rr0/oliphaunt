# Mobile Stability Model

This document is the stability contract for the Swift, Kotlin, and React Native
SDKs over `liboliphaunt`.

The deeper iOS process-model investigation is captured in
`docs/architecture/ios.md`. That document is the source of
truth for why iOS direct mode is the universal fast path and why any robust iOS
broker must be an ExtensionFoundation/AppExtensionProcess design rather than a
normal helper daemon.

## Current Truth

`NativeDirect` embeds one PostgreSQL backend in the host app process. Swift and
Kotlin serialize all direct calls through one actor/owner dispatcher. React
Native delegates to those SDKs and uses a New Architecture JSI ArrayBuffer
transport for protocol bytes.

This is fast, but it is not process isolated. A PostgreSQL `ERROR`, protocol
error, cancellation, or controlled `proc_exit` path can be surfaced as an SDK
error. A native crash such as memory corruption, abort, or unhandled signal is a
host-process crash in direct mode.

Direct mode's reliability claim is crash consistency, not crash isolation. If
the host process dies, the next app launch must reopen the same root and let
PostgreSQL perform WAL recovery. Direct mode must not be documented or surfaced
as host-app-survivable after native PostgreSQL crashes.

`close()` is a logical detach in mobile direct mode. It releases the SDK handle,
rolls back any active transaction, runs `DISCARD ALL`, and keeps the resident
backend alive so the same root can be reopened in the same process. It is not a
full PostgreSQL shutdown. Direct mode cannot switch to a different root after
that resident backend exists.

The SDK should make this resident-runtime model explicit with an app-scope
manager/container. Developers should not need to discover by accident that
`close()` does not make the process reusable for another root.

Temporary direct roots are therefore process-resident too. The SDKs now reuse one
process-lifetime temporary root so `open(temporary)`, `close()`, and
`open(temporary)` do not accidentally ask the C ABI to switch roots.

React Native `protocolStream` means true chunked native streaming through JSI.
If the installed JSI transport only has owned-response `execProtocolRaw`,
`execProtocolStream(...)` remains callable as a fallback but reports
`protocolStream=false` and emits one owned response chunk.

## Platform Constraints

React Native New Architecture is the correct JS/native boundary. The official
architecture replaces the old asynchronous bridge with JSI and allows JS to hold
references to native objects without serialization costs for database-like
objects. TurboModule Codegen remains the typed lifecycle/control surface; bulk
bytes should stay on JSI.

Android can support a real mobile broker. A bound service is explicitly designed
for long-lived interaction over `IBinder`, and Android services can be declared
with a separate `android:process`. That gives us a credible crash-isolated
database process for Android apps.

iOS does not have the same general app-owned daemon model. Normal apps receive
only a short background window before suspension. App extensions do run in
separate processes, and ExtensionFoundation exposes host-launched app-extension
processes with XPC connections on iOS 26+, but this is not the same thing as a
macOS helper service or Android service process. It likely starts as a
single-root broker because one app-extension identity maps to one running
process and the embedded PostgreSQL runtime is still process-wide. Until that
feasibility track passes on real devices, iOS direct mode must be honest: fast
and ergonomic, not crash isolated.

PostgreSQL's normal robustness assumes a supervisor process and WAL recovery. In
server mode, an immediate shutdown or crash leads to WAL replay on restart. In
direct mode there is no external supervisor around the embedded backend thread;
only a broker/server process can make backend death survivable for the app
process.

## Product Direction

### iOS

Default to `NativeDirect` for the first shippable iOS SDK. Make the contract
explicit:

- one resident backend per app process;
- one physical session;
- serialized requests;
- same-root logical reopen only;
- no true independent concurrent sessions;
- no crash isolation;
- backgrounding is handled by checkpoint/cancel/close guidance, not by keeping
  arbitrary work alive while suspended.

The robust iOS direction is an opt-in `NativeExtensionBroker` built on
ExtensionFoundation/AppExtensionProcess only if device/App Store testing proves
the extension lifecycle, crash/reconnect behavior, memory ceiling, background
behavior, App Group storage model, and XPC throughput are acceptable. If that
feasibility fails, iOS remains direct plus server unavailable. Even if it
succeeds, it must not advertise desktop-style multi-root broker semantics until
worker multiplicity is proven.

The product must fail closed here: if the iOS broker extension target, App Group,
minimum OS, or device evidence is missing, `NativeExtensionBroker` is
unavailable. It must not silently alias to direct mode.

### Android

Add `NativeBroker` as the recommended robust Android mode:

- a bound service in `:liboliphaunt` owns roots and direct C ABI handles;
- app/RN process talks to it over Binder;
- one worker per root, serialized per root;
- service crash is observed through binder death, then the SDK reconnects and
  reopens the root after WAL recovery;
- in-flight requests fail with unknown commit state unless the SDK has an
  explicit idempotent replay envelope;
- `NativeServer` is separate and only for true PostgreSQL client sessions.

The direct Android mode remains the fastest single-session path and the fallback
where apps do not want a service process.

### React Native

React Native should remain an adapter over Swift/Kotlin, but the hot path should
eventually move one layer lower:

- TurboModule Codegen for typed lifecycle, capabilities, open, close, cancel,
  backup/restore metadata, and package-size reporting;
- JSI HostObject/ArrayBuffer for database handles and protocol bytes;
- native chunked JSI streaming for large protocol responses;
- no base64 and no bridge byte transport;
- no private RN database runtime divergent from Swift/Kotlin semantics.

On Android broker, RN should talk to Kotlin broker handles. On iOS direct, RN
talks to Swift direct handles. If an iOS broker becomes viable, RN should inherit
it through Swift.

## Required Follow-Up Changes

1. Add Android `NativeBroker` with a remote-process bound service and binder
   death/reconnect tests.
2. Run an iOS 26+ ExtensionFoundation broker feasibility spike on real devices
   and document whether App Store-safe single-root process isolation is viable.
3. Add mobile crash drills: direct-mode controlled backend exit, Android broker
   service kill/reconnect, app background/foreground with long query
   cancellation, and WAL recovery after process death.
4. Keep lifecycle APIs around foreground/background transitions covered on every
   SDK surface: `prepareForBackground`, `resumeFromBackground`, bounded
   checkpoint, and explicit cancellation policy.

## References

- React Native New Architecture: https://reactnative.dev/architecture/landing-page
- React Native Turbo Native Modules: https://reactnative.dev/docs/turbo-native-modules-android
- Android services and bound services:
  https://developer.android.com/develop/background-work/services
- Android service manifest attributes:
  https://developer.android.com/guide/topics/manifest/service-element
- Apple background execution:
  https://developer.apple.com/documentation/uikit/extending-your-app-s-background-execution-time
- Apple ExtensionFoundation:
  https://developer.apple.com/documentation/extensionfoundation
- Apple AppExtensionProcess:
  https://developer.apple.com/documentation/ExtensionFoundation/AppExtensionProcess
- PostgreSQL server shutdown and recovery:
  https://www.postgresql.org/docs/current/server-shutdown.html
- PostgreSQL WAL:
  https://www.postgresql.org/docs/current/wal-intro.html
