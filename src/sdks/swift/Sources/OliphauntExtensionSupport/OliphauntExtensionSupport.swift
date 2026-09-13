import COliphaunt
import Foundation
@_spi(ExtensionSupport) import Oliphaunt

/// Runtime support used by independently released extension packages.
public enum OliphauntExtensionSupport {
    public static func register(
        product: String,
        sqlName: String,
        version: String,
        dependencies: [String],
        nativeDependencies: [String],
        sharedPreloadLibraries: [String],
        nativeModuleStem: String?,
        resourceRoot: URL,
        descriptor: UnsafePointer<OliphauntStaticExtension>?
    ) throws {
        try OliphauntStaticExtensionRegistry.register(
            product: product, sqlName: sqlName, version: version,
            dependencies: dependencies, nativeDependencies: nativeDependencies,
            sharedPreloadLibraries: sharedPreloadLibraries, nativeModuleStem: nativeModuleStem,
            resourceRoot: resourceRoot, descriptor: descriptor
        )
    }
}
