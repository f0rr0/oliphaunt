# React Native SDK Agent Guide

## Scope

This directory owns the React Native New Architecture SDK: TypeScript API,
TurboModule Codegen spec, JSI binary transport, iOS adapter glue, Android
adapter glue, Expo development-client example, and mobile smoke runners.

Use `.agents/skills/mobile-smoke/SKILL.md` for installed-app smoke, E2E,
Metro, emulator/simulator, Maestro, or Expo dev-client work.

## Boundaries

- React Native delegates platform runtime behavior to the Swift and Kotlin SDKs.
  Do not duplicate PostgreSQL lifecycle, native runtime packaging, or backup
  logic in React Native native code.
- Keep the Codegen spec lifecycle/control-oriented. Binary protocol, backup,
  restore, stream, and byte transport belong in the JSI ArrayBuffer path.
- Do not use base64, `atob`, `btoa`, or Node `Buffer` for runtime binary
  transport.
- Do not commit generated `lib/`, `node_modules/`, `android/build`,
  `android/.gradle`, `android/.cxx`, `ios/vendor`, or generated Expo
  `examples/expo/android` and `examples/expo/ios`.
- The Expo example is a development-client harness, not Expo Go.

## Commands

```sh
moon run oliphaunt-react-native:check
moon run oliphaunt-react-native:test
moon run oliphaunt-react-native:package
moon run oliphaunt-react-native:release-check
moon run oliphaunt-react-native:smoke-android
moon run oliphaunt-react-native:smoke-ios
moon run oliphaunt-react-native:smoke-mobile
pnpm --dir src/sdks/react-native/examples/expo run smoke:android
pnpm --dir src/sdks/react-native/examples/expo run smoke:ios
```

Static/package/unit checks run through `tools/check-sdk.sh`. Installed-app
smokes run through `examples/expo` scripts and require real or staged native
artifacts.

## Validation Pattern

- For TypeScript/API/config-plugin work, run `moon run oliphaunt-react-native:check`
  and `moon run oliphaunt-react-native:test`.
- For package shape, run `moon run oliphaunt-react-native:package`.
- For iOS adapter changes, include `moon run oliphaunt-react-native:build-ios-bridge`
  on macOS/Xcode when available.
- For Android adapter changes, include
  `moon run oliphaunt-react-native:build-android-bridge` with Android SDK/NDK.
- For installed-app proof, use platform-specific smokes with `--cache off` when
  current device/simulator state matters.

## Edit Checklist

- Keep package peer dependencies and Expo example versions coherent with
  `package.json`, `pnpm-lock.yaml`, and package-shape checks.
- Keep `EXPO_UNSTABLE_MCP_SERVER=1 expo start --dev-client` as the local MCP
  development-client path.
- If Swift/Kotlin compatibility versions change, update the `oliphaunt` block
  in `package.json`, podspec/Gradle wiring, docs, and release metadata together.
- If extension packaging behavior changes, inspect `src/extensions/generated/*`
  and the mobile extension packaging checks before editing runners.
