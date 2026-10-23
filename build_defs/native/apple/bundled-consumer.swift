import Foundation
import Oliphaunt

@main
enum BundledRuntimeConsumer {
    static func main() async throws {
        guard ProcessInfo.processInfo.environment["OLIPHAUNT_RUNTIME_DIR"] == nil,
              CommandLine.arguments.count == 3,
              ["create", "reopen"].contains(CommandLine.arguments[1]) else {
            fatalError("Expected bundled resources and create|reopen plus database directory")
        }
        guard let framework = Bundle(identifier: "dev.oliphaunt.liboliphaunt"),
              let resources = framework.resourceURL,
              FileManager.default.fileExists(
                atPath: resources.appendingPathComponent("oliphaunt/runtime/manifest.properties").path
              ) else {
            fatalError("Installed dynamic framework did not deliver its bundled runtime resources")
        }
        let configuration = OliphauntConfiguration(
            storage: .directory(URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true)),
            username: "postgres", database: "postgres"
        )
        let database = try await OliphauntDatabase.open(configuration: configuration)
        if CommandLine.arguments[1] == "create" {
            _ = try await database.execute("CREATE TABLE persisted(value int4 NOT NULL)")
            _ = try await database.execute("INSERT INTO persisted VALUES ($1)", parameters: [.int32(42)])
        }
        let result = try await database.query("SELECT value AS answer FROM persisted")
        guard result.rows.count == 1,
              try result.rows[0].value(named: "answer", as: Int32.self) == 42 else {
            fatalError("Bundled Swift candidate failed the persisted query")
        }
        try await database.close()
        print("installed-swift-\(CommandLine.arguments[1])-42")
    }
}
