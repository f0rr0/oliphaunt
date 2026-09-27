# iOS broker target

Requires Xcode 26+ and iOS 26+. The Expo plugin performs these steps for managed
React Native projects. For a Swift app:

1. Add `OliphauntBroker` to the app target. Copy `OliphauntBrokerHost.swift.template`
   to `OliphauntBrokerHost.swift` **in the app target**. Set
   `EX_ENABLE_EXTENSION_POINT_GENERATION = YES` on that target so Xcode extracts
   the declaration into the app's `.appext` metadata.
2. Add an ordinary ExtensionFoundation target named `OliphauntBroker`, with
   product type `com.apple.product-type.extensionkit-extension` and product file
   type `wrapper.extensionkit-extension`. Its bundle identifier defaults to
   `<app bundle identifier>.OliphauntBroker`. Use your app's signing team, version,
   and build number. This is a non-UI extension without Enhanced Security or App Groups.
3. Copy `OliphauntBroker.swift.template` as `OliphauntBroker.swift` into the worker
   target only. Replace `__HOST_BUNDLE_IDENTIFIER__` with the app identifier.
   Set `INFOPLIST_FILE` to this template's `Info.plist` and apply `Broker.xcconfig`.
4. Link `OliphauntBrokerExtension` and your selected seed, ICU, and generated
   extension products to the **worker target**. Pass generated extension resources
   into `OliphauntBrokerExtensionPeer(session:extensions:)`. The app selects plain
   `OliphauntExtension(sqlName:)` values so resource products stay in the worker.
5. Make the app depend on the worker. Embed and sign its `.appex` in
   `$(EXTENSIONS_FOLDER_PATH)` (Copy Files destination 16), with CodeSignOnCopy
   and RemoveHeadersOnCopy. Verify both targets' signing identities and profiles.

This follows Apple's [host extension-point declaration](https://developer.apple.com/documentation/extensionfoundation/adding-support-for-app-extensions-to-your-app)
and [app-extension binding](https://developer.apple.com/documentation/extensionfoundation/building-an-app-extension-to-support-a-host-app).
A compile check alone does not qualify signing, platform launch, file protection,
or installed-worker lifecycle. See the repository mobile stability model for
outstanding installed-device qualification.
