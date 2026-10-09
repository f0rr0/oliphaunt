@testable import OliphauntCore
import Foundation
import Oliphaunt
import Testing

@Suite(.enabled(if: ProcessInfo.processInfo.environment["OLIPHAUNT_SWIFT_REQUIRE_NATIVE"] == "1"))
struct NativeRuntimeTests {
    @Test
    func nativeDatabaseExecutesSQLAndCloses() async throws {
        let database = try await OliphauntDatabase.open()
        do {
            let result = try await database.query("SELECT $1::int4 AS answer", parameters: [.int32(42)])
            #expect(try result.rows[0].value(named: "answer", as: Int32.self) == 42)
            await #expect(throws: (any Error).self) {
                _ = try await database.exec("SELECT 1 / 0")
            }
            let transactionResult = try await database.transaction { transaction in
                try await transaction.query("SELECT 7::int4 AS answer")
            }
            #expect(try transactionResult.rows[0].value(named: "answer", as: Int32.self) == 7)

            let typed = try await database.query(
                "SELECT $1::uuid AS empty, $2::int4 AS same, $3::bytea AS same",
                parameters: [.typedNull(.uuid), .binary(Data([0, 0, 0, 42]), typeOID: .int4), .bytes(Data([0, 255, 1, 2]))])
            #expect(try typed.rows[0].raw(0) == nil)
            #expect(typed.fields.map(\.name) == ["empty", "same", "same"])
            #expect(try typed.rows[0].value(at: 1, as: Int32.self) == 42)
            #expect(try typed.rows[0].value(at: 2, as: Data.self) == Data([0, 255, 1, 2]))
            #expect(throws: (any Error).self) { _ = try typed.rows[0].raw("same") }
            _ = try await database.exec("CREATE TEMP TABLE typed_fixture (value int)")
            _ = try await database.exec("CREATE TYPE pg_temp.typed_fixture_enum AS ENUM ('one')")
            let oidResult = try await database.query("SELECT 'pg_temp.typed_fixture_enum'::regtype::oid::text")
            let oid = OliphauntPostgresOID(UInt32(try oidResult.rows[0].text(0)!)!)
            let custom = try await database.query("SELECT $1 AS value", parameters: [.text("one", typeOID: oid)])
            #expect(custom.fields[0].typeOID == oid)
            #expect(try custom.rows[0].text(0) == "one")
            do {
                _ = try await database.query("SELECT $1", parameters: [.text("missing", typeOID: oid)])
                Issue.record("invalid enum value must fail")
            } catch OliphauntError.postgres(let error) { #expect(error.sqlstate == "22P02") }
            #expect(try await database.query("SELECT 9").rows[0].text(0) == "9")

            enum CallbackFailure: Error { case stopped }
            let sql = Data("SELECT generate_series(1, 1000)\0".utf8)
            var length = UInt32(sql.count + 4).bigEndian
            let request = Data([81]) + withUnsafeBytes(of: &length) { Data($0) } + sql
            do {
                try await database.execProtocolRawStream(request) { _ in throw CallbackFailure.stopped }
                Issue.record("stream must preserve the callback failure")
            } catch CallbackFailure.stopped {}
            _ = try await database.query("SELECT 1")

            let sleeping = Task { try await database.query("SELECT pg_sleep(60)") }
            try await Task.sleep(for: .milliseconds(100))
            let start = ContinuousClock.now
            sleeping.cancel()
            do {
                _ = try await sleeping.value
                Issue.record("cancelled query must not succeed")
            } catch is CancellationError {
            } catch OliphauntError.postgres(let error) {
                #expect(error.sqlstate == "57014")
            }
            #expect(start.duration(to: .now) < .seconds(3))
            _ = try await database.query("SELECT 1")
            let transactionSleep = Task {
                try await database.transaction { transaction in
                    try await transaction.query("SELECT pg_sleep(60)")
                }
            }
            try await Task.sleep(for: .milliseconds(100))
            transactionSleep.cancel()
            do { _ = try await transactionSleep.value }
            catch is CancellationError {}
            catch OliphauntError.postgres(let error) { #expect(error.sqlstate == "57014") }
            _ = try await database.query("SELECT 1")
            let archive = FileManager.default.temporaryDirectory.appendingPathComponent("oliphaunt-swift-backup-\(UUID().uuidString).tar")
            defer { try? FileManager.default.removeItem(at: archive) }
            try await database.backup(to: archive)
            let backup = try Data(contentsOf: archive)
            #expect(!backup.isEmpty)
            await #expect(throws: (any Error).self) { try await database.backup(to: archive) }
            #expect(try Data(contentsOf: archive) == backup)
            try await database.close()
            #expect(await database.isClosed)
            let name = "oliphaunt-swift-restore-\(UUID().uuidString)"
            let support = try FileManager.default.url(
                for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            let destinations: [(OliphauntDatabaseStorage, URL)] = [
                (.directory(FileManager.default.temporaryDirectory.appendingPathComponent(name)),
                 FileManager.default.temporaryDirectory.appendingPathComponent(name)),
                (.applicationData(name: name), support.appendingPathComponent("Oliphaunt/\(name)")),
            ]
            for (storage, destination) in destinations {
                defer { try? FileManager.default.removeItem(at: destination) }
                try await OliphauntDatabase.restore(storage: storage, bytes: backup)
                #expect(FileManager.default.fileExists(atPath: destination.appendingPathComponent("pgdata/PG_VERSION").path))
                #expect(FileManager.default.fileExists(atPath: destination.appendingPathComponent(".oliphaunt.json").path))
                await #expect(throws: (any Error).self) {
                    try await OliphauntDatabase.restore(storage: storage, bytes: backup)
                }
            }
        } catch {
            try? await database.close()
            throw error
        }
    }
}
