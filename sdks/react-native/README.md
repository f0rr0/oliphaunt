# React Native SDK

Future home of the React Native New Architecture package.

Target shape:

```text
sdks/react-native/
├── package.json
├── src/
├── ios/
├── android/
└── example/
```

The module should expose a small TurboModule boundary over the native Swift and
Kotlin SDKs rather than duplicating PostgreSQL or C ABI lifecycle logic in JS.
