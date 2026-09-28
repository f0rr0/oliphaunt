@_exported import OliphauntCore
import Foundation

struct OliphauntDefaultEngine: OliphauntEngine {
    func open(configuration: OliphauntConfiguration) async throws -> any OliphauntSession {
        try await OliphauntNativeDirectEngine().open(configuration: configuration)
    }

    func restore(destination: URL, bytes: Data) async throws {
        try await OliphauntNativeDirectEngine().restore(destination: destination, bytes: bytes)
    }
}

extension OliphauntDatabase {
    public static func open(
        configuration: OliphauntConfiguration = .init()
    ) async throws -> OliphauntDatabase {
        try await open(configuration: configuration, engine: OliphauntDefaultEngine())
    }

    public static func restore(storage: OliphauntDatabaseStorage, bytes: Data) async throws {
        guard storage != .temporaryDirectory else {
            throw OliphauntError.engine("restore requires persistent storage")
        }
        try await restore(destination: OliphauntNativeDirectEngine.storageDirectory(storage), bytes: bytes)
    }

    public static func restore(destination: URL, bytes: Data) async throws {
        try await restore(
            destination: destination,
            bytes: bytes,
            engine: OliphauntDefaultEngine()
        )
    }

}
