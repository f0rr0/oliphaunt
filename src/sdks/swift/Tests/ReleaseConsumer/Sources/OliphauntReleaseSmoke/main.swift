import Foundation
import Oliphaunt
import OliphauntICU

enum ReleaseConsumerError: Error, CustomStringConvertible {
    case invalidEnvironment(String)
    case unexpectedValue(String?)

    var description: String {
        switch self {
        case .invalidEnvironment(let message): message
        case .unexpectedValue(let value): "SELECT returned \(String(describing: value)); expected 1"
        }
    }
}

@main
struct OliphauntReleaseSmoke {
    static func main() async throws {
        let environment = ProcessInfo.processInfo.environment
        let library = try requiredFileURL("LIBOLIPHAUNT_PATH", environment: environment)
        let resourceRoot = try requiredDirectoryURL(
            "OLIPHAUNT_SWIFT_RESOURCE_ROOT",
            environment: environment
        )
        let cacheRoot = try requiredDirectoryURL(
            "OLIPHAUNT_SWIFT_RUNTIME_CACHE_DIR",
            environment: environment
        )
        let databaseRoot = try requiredDirectoryURL(
            "OLIPHAUNT_SWIFT_DATABASE_ROOT",
            environment: environment
        )

        guard OliphauntICUResources.bundled else {
            throw ReleaseConsumerError.invalidEnvironment("OliphauntICU resources are not linked")
        }
        let resources = OliphauntRuntimeResources(
            resourceRoot: resourceRoot,
            cacheRoot: cacheRoot
        )
        let engine = OliphauntNativeDirectEngine(
            libraryURL: library,
            runtimeResources: resources
        )
        let database = try await OliphauntDatabase.open(
            configuration: OliphauntConfiguration(root: databaseRoot),
            engine: engine
        )
        let result = try await database.query("SELECT 1::text AS value")
        let value = try result.getText(row: 0, column: "value")
        guard value == "1" else {
            try await database.close()
            throw ReleaseConsumerError.unexpectedValue(value)
        }
        try await database.close()
        print("Swift exact-candidate consumer proof passed: generated manifest, XCFramework, resources, SELECT")
        print(
            "OLIPHAUNT_SWIFT_RELEASE_CONSUMER_MODE_PASS "
                + "mode=nativeDirect "
                + "checks=generatedManifest,xcframework,runtimeResources,icu,open,select,close"
        )
    }

    private static func requiredFileURL(
        _ name: String,
        environment: [String: String]
    ) throws -> URL {
        let url = try requiredURL(name, environment: environment)
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory),
              !isDirectory.boolValue
        else {
            throw ReleaseConsumerError.invalidEnvironment("\(name) is not a file: \(url.path)")
        }
        return url
    }

    private static func requiredDirectoryURL(
        _ name: String,
        environment: [String: String]
    ) throws -> URL {
        let url = try requiredURL(name, environment: environment)
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory),
              isDirectory.boolValue
        else {
            throw ReleaseConsumerError.invalidEnvironment("\(name) is not a directory: \(url.path)")
        }
        return url
    }

    private static func requiredURL(
        _ name: String,
        environment: [String: String]
    ) throws -> URL {
        guard let value = environment[name], !value.isEmpty else {
            throw ReleaseConsumerError.invalidEnvironment("missing required environment variable \(name)")
        }
        return URL(fileURLWithPath: value)
    }
}
