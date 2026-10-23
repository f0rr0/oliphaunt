import Foundation
import Oliphaunt

func compileTransactionFailureAPI(
    rollbackFailure: OliphauntTransactionRollbackError,
    databaseFailure: OliphauntTransactionDatabaseError
) {
    let _: any Error = rollbackFailure
    let _: any Error = rollbackFailure.callbackError
    let _: any Error = rollbackFailure.rollbackError
    let _: String = rollbackFailure.description

    let _: any Error = databaseFailure
    let _: any Error = databaseFailure.callbackError
    let _: any Error = databaseFailure.databaseError
    let _: String = databaseFailure.description
}

func compileOliphauntPublicAPI(restoreDestination: URL) async throws {
    let configuration = OliphauntConfiguration(
        storage: .temporaryDirectory,
        startupGUCs: [.init("application_name", "public-api-consumer")],
        username: "postgres",
        database: "postgres"
    )
    let database = try await OliphauntDatabase.open(configuration: configuration)

    let query: OliphauntQueryResult = try await database.query(
        "SELECT $1::int4 AS answer",
        parameters: [.int32(41)]
    )
    let _: Int32? = try query.rows[0].value(named: "answer", as: Int32.self)
    let _: OliphauntCommandResult = try await database.execute(
        "SELECT $1::int4", parameters: [.int32(41)])
    let _: OliphauntExecResult = try await database.exec("SELECT 1; SELECT 2")
    let _: OliphauntQueryDescription = try await database.describe(
        "SELECT $1::int4",
        parameterTypes: [.int4]
    )

    let request = Data([0])
    let _: Data = try await database.execProtocolRaw(request)
    try await database.execProtocolRawStream(request) { chunk in
        _ = chunk.count
    }

    let _: Bool = try await database.transaction { transaction in
        let _: OliphauntQueryResult = try await transaction.query("SELECT 1")
        let _: OliphauntCommandResult = try await transaction.execute("SELECT 1")
        let _: OliphauntExecResult = try await transaction.exec("SELECT 1; SELECT 2")
        let _: OliphauntQueryDescription = try await transaction.describe(
            "SELECT $1", parameterTypes: [.text])
        _ = await transaction.isClosed
        return true
    }
    let _: Void = try await database.transaction { transaction in
        try await transaction.rollback()
    }

    _ = await database.isClosed
    try await database.cancel()
    let backup = try await database.backup()
    try await database.close()
    try await OliphauntDatabase.restore(destination: restoreDestination, bytes: backup)
}

@main
enum OliphauntPublicApiConsumer {
    static func main() async throws {
        guard CommandLine.arguments.count > 1 else { return }
        guard CommandLine.arguments.count == 3,
              ["create", "reopen"].contains(CommandLine.arguments[1]) else {
            fatalError("Expected create|reopen and database directory")
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
            fatalError("Installed Swift SDK failed the persisted query")
        }
        try await database.close()
        print("installed-swift-\(CommandLine.arguments[1])-42")
    }
}
