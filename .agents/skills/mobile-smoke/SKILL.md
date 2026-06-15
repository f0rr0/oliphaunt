---
name: mobile-smoke
description: React Native mobile smoke and E2E workflow for the Expo development-client harness, Android/iOS native artifacts, Metro with EXPO_UNSTABLE_MCP_SERVER, Maestro flows, emulator/simulator triage, and installed-app validation. Use when touching src/sdks/react-native mobile runners, Expo example, Android/iOS adapter code, or mobile CI.
---

# Mobile Smoke

## Workflow

1. Identify the changed surface:
   - package/API: `src/sdks/react-native/src/`
   - Codegen spec: `src/sdks/react-native/src/specs/NativeOliphaunt.ts`
   - Android adapter: `src/sdks/react-native/android/`
   - iOS adapter: `src/sdks/react-native/ios/`
   - Expo harness: `src/sdks/react-native/examples/expo/`
   - mobile runner scripts: `src/sdks/react-native/tools/`
2. Keep React Native as adapter glue over Swift/Kotlin SDKs. Do not duplicate
   runtime lifecycle or native artifact packaging in React Native.
3. Keep the Expo example on development-client, not Expo Go.
4. Keep generated app projects and build output untracked.

## Commands

```sh
moon run oliphaunt-react-native:check
moon run oliphaunt-react-native:test
moon run oliphaunt-react-native:package
moon run oliphaunt-react-native:build-android-bridge
moon run oliphaunt-react-native:build-ios-bridge
moon run oliphaunt-react-native:smoke-android --cache off
moon run oliphaunt-react-native:smoke-ios --cache off
moon run oliphaunt-react-native:smoke-mobile --cache off
pnpm --dir src/sdks/react-native/examples/expo run smoke:android
pnpm --dir src/sdks/react-native/examples/expo run smoke:ios
```

Android bridge/smoke paths require Android SDK/NDK. iOS bridge/smoke paths
require macOS with Xcode/CoreSimulator unless running build-only modes.

## Triage Rules

- If Metro/dev-server behavior changes, verify scripts keep
  `EXPO_UNSTABLE_MCP_SERVER=1 expo start --dev-client`.
- If installed-app smoke fails, inspect artifact materialization, generated
  native project setup, Metro startup, device/simulator availability, and
  Maestro logs before changing provider/tooling decisions.
- If Android packaging changes, inspect Kotlin SDK dependency resolution and
  generated asset manifests.
- If iOS packaging changes, inspect Swift SDK dependency resolution and reject
  macOS dylibs in iOS paths.
- If binary transport changes, reject base64/Buffer paths and keep byte
  transport in JSI ArrayBuffer code.

## Evidence To Report

Report platform, host prerequisites, native artifact source, whether generated
Expo projects were reused or regenerated, Metro/MCP mode, and exact smoke/E2E
commands run.
