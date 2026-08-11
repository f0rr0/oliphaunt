# iOS NativeBroker feasibility harness

This fixture is an iOS 26-only host application with a bundle-only, non-UI
ExtensionFoundation app extension. It exists to exercise the public
`AppExtensionProcess` model on an iOS simulator without adding an example app
to the released Swift package. Device packaging remains a separate qualification
gate.

The checked-in Ruby generator creates an Xcode project under `Generated/`.
The generated project:

- enables `EX_ENABLE_EXTENSION_POINT_GENERATION` in the host and extension;
- embeds an ExtensionKit extension in the host app;
- links broker protocol/host code into the app;
- links native Oliphaunt code and `liboliphaunt.xcframework` only into the
  extension when the XCFramework path is supplied;
- copies runtime/template-PGDATA resources only into the extension.

Run `src/sdks/swift/tools/run-ios-broker-simulator.sh` from the repository root. The runner
builds the required local artifacts, boots an iOS 26 simulator, installs the
host app, launches its self-test, and writes logs and a JSON result beneath
`target/ios-native-broker-spike/`.

The simulator proves packaging, discovery, process separation, XPC file-
descriptor transfer, framing and host survival. Real-device memory ceilings,
background suspension behavior, and App Store review remain separate gates.
