# Mobile broker checks

## Shared transport and runtime

```sh
moon run oliphaunt-mobile-bindings:test oliphaunt-mobile-bindings:test-native
```

The shared tests cover close acknowledgement after worker exit, late cancellation,
and startup, unresponsive execution, and socket-loss retirement in dedicated child
processes. The native test uses real PostgreSQL for backup/restore and streams
8, 32, and 128 MiB through a slow reader. On Linux it checks sampled process RSS
growth against a 32 MiB allowance after warmup. Both transport endpoints and
PostgreSQL share that test process; this does not qualify device worker memory or
native process launchers.

## Installed consumers

These native consumer apps link the Swift CocoaPods host/ExtensionFoundation worker
and the Kotlin Android AAR/bound service, then run actual PostgreSQL operations.
They do not substitute for an Expo/TurboModule/JSI consumer or physical-device
Data Protection qualification. Only the dedicated `dev.oliphaunt.brokertest` app
is terminated by the runner.

## Build inputs

Use current-source native runtimes, generated UniFFI bindings, and ABI-compatible
runtime resources plus a seed. Do not mix a released runtime with changed C APIs.

The Swift builder expects these repository-relative artifacts:

- `target/mobile-bindings/generated/` (run the Swift `prepare-bindings.sh`).
- `target/aarch64-apple-ios/debug/liboliphaunt_mobile_bindings.a` and
  `target/aarch64-apple-ios-sim/debug/liboliphaunt_mobile_bindings.a`.
- `target/liboliphaunt-ios-simulator/out/liboliphaunt.dylib`.
- `target/broker-lifecycle/ios-resources/oliphaunt/`, with runtime resources and
  `cluster-seed/`.

Build with Xcode 26+, Ruby xcodeproj, and CocoaPods:

```sh
ruby src/native/sdks/swift/Tests/BrokerApp/build.rb
(cd target/broker-lifecycle/ios && pod install)
xcodebuild -workspace target/broker-lifecycle/ios/BrokerLifecycle.xcworkspace \
  -scheme BrokerLifecycle -configuration Debug -sdk iphonesimulator \
  -destination "id=$SIMULATOR" -derivedDataPath target/broker-lifecycle/ios-build build
xcrun simctl install "$SIMULATOR" \
  target/broker-lifecycle/ios-build/Build/Products/Debug-iphonesimulator/BrokerLifecycle.app
```

Android accepts explicit AAR, resources, and JNI library directories. The resources
root contains `oliphaunt/`; JNI libraries contain `arm64-v8a/liboliphaunt.so` and
its C++ runtime dependency. Build the AAR from the same source first:

```sh
src/native/sdks/kotlin/gradlew -p src/native/sdks/kotlin \
  :oliphaunt:bundleDebugAar -PoliphauntAndroidAbiFilters=arm64-v8a
src/native/sdks/kotlin/gradlew -p src/native/sdks/kotlin/tests/broker-app assembleDebug \
  -Paar="$PWD/src/native/sdks/kotlin/oliphaunt/build/outputs/aar/oliphaunt-debug.aar" \
  -Presources="$PWD/target/broker-lifecycle/android-resources" \
  -PnativeLibraries="$PWD/target/broker-lifecycle/android-jni"
adb -s "$EMULATOR" install -r \
  src/native/sdks/kotlin/tests/broker-app/build/outputs/apk/debug/BrokerLifecycle-debug.apk
```

## Run

Run `smoke` first. It creates the archive used by `restore-death`. `backup-death`
creates a 64 MiB uncompressed payload and waits for archive bytes before killing
the worker. The runner waits for restore staging before killing during restore.

```sh
for mode in smoke worker-death host-death deadline background backup-death open-death restore-death; do
  python3 src/native/sdks/tests/run-broker-lifecycle.py ios "$SIMULATOR" "$mode" || break
done
# Replace ios/$SIMULATOR with android/$EMULATOR; pass --adb when needed.
```

Receipts are written to `target/broker-lifecycle/reports/`. Each must end in
`PASS`. Smoke also checks host runtime isolation, plpgsql activation, duplicate
open rejection, an 8 MiB response, cancellation recovery, archive no-overwrite,
backup/restore, repeated close, and stale-handle cancel/close after reopening.
Host/worker death checks preserve a committed row through WAL recovery.
Simulator file protection is unavailable; the device-only verification remains
in the worker. Simulator sandbox paths do not qualify device container isolation.
