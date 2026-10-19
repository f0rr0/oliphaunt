import COliphaunt
import Foundation
@_spi(ExtensionSupport) import Oliphaunt

/// Registers independently packaged static PostgreSQL extensions as one
/// deterministic liboliphaunt registry before the first database starts.
public enum OliphauntExtensionSupport {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var descriptors: [String: UnsafePointer<OliphauntStaticExtension>] = [:]

    /// Adds an exact-extension descriptor and republishes the complete selected
    /// set. Calling this after a database has started fails in liboliphaunt.
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
        lock.lock()
        defer { lock.unlock() }

        switch (nativeModuleStem, descriptor) {
        case (nil, nil):
            break
        case (let expectedStem?, let descriptor?):
            guard let descriptorName = descriptor.pointee.name,
                  String(cString: descriptorName) == expectedStem
            else {
                throw OliphauntError.engine(
                    "static-extension descriptor name does not match \(sqlName) native module stem \(expectedStem)"
                )
            }
        default:
            throw OliphauntError.engine(
                "SwiftPM exact-extension \(sqlName) must provide both a native module stem and descriptor, or neither"
            )
        }

        let insertedResource = try OliphauntRuntimeResources.registerPackagedExtensionResource(
            product: product,
            version: version,
            sqlName: sqlName,
            dependencies: dependencies,
            nativeDependencies: nativeDependencies,
            nativeModuleStem: nativeModuleStem,
            sharedPreloadLibraries: sharedPreloadLibraries,
            resourceRoot: resourceRoot
        )
        guard let descriptor else {
            return
        }

        let previous = descriptors[sqlName]
        do {
            if let previous, previous != descriptor {
                throw OliphauntError.engine(
                    "conflicting static-extension descriptors were linked for \(sqlName)"
                )
            }
            descriptors[sqlName] = descriptor

            let rows = descriptors.keys.sorted().compactMap { descriptors[$0]?.pointee }
            let status = rows.withUnsafeBufferPointer { buffer in
                oliphaunt_register_static_extensions(buffer.baseAddress, buffer.count)
            }
            guard status == 0 else {
                let nativeMessage = copyNativeLastError()
                throw OliphauntError.engine(
                    "could not register selected static extensions while adding \(sqlName) " +
                        "before backend startup: \(nativeMessage)"
                )
            }
        } catch {
            if let previous {
                descriptors[sqlName] = previous
            } else {
                descriptors.removeValue(forKey: sqlName)
            }
            if insertedResource {
                OliphauntRuntimeResources.unregisterPackagedExtensionResource(
                    sqlName: sqlName,
                    resourceRoot: resourceRoot
                )
            }
            throw error
        }
    }

    private static func copyNativeLastError() -> String {
        let fallback = "unknown liboliphaunt static-extension registration error"
        let required = oliphaunt_copy_last_error(nil, nil, 0)
        guard required > 0, required < Int.max else {
            return fallback
        }
        var bytes = [CChar](repeating: 0, count: required + 1)
        let currentRequired = bytes.withUnsafeMutableBufferPointer { buffer in
            oliphaunt_copy_last_error(nil, buffer.baseAddress, buffer.count)
        }
        if currentRequired >= bytes.count {
            bytes = [CChar](repeating: 0, count: currentRequired + 1)
            bytes.withUnsafeMutableBufferPointer { buffer in
                _ = oliphaunt_copy_last_error(nil, buffer.baseAddress, buffer.count)
            }
        }
        let message = bytes.withUnsafeBufferPointer { buffer in
            String(cString: buffer.baseAddress!)
        }
        return message.isEmpty ? fallback : message
    }
}
