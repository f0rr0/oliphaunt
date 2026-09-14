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
            let backup = try await database.backup()
            #expect(!backup.isEmpty)
            try await database.close()
            #expect(await database.isClosed)
            let restored = FileManager.default.temporaryDirectory
                .appendingPathComponent("oliphaunt-swift-restore-\(UUID().uuidString)")
            defer { try? FileManager.default.removeItem(at: restored) }
            try await OliphauntDatabase.restore(destination: restored, bytes: backup)
            #expect(FileManager.default.fileExists(atPath: restored.appendingPathComponent("pgdata/PG_VERSION").path))
        } catch {
            try? await database.close()
            throw error
        }
    }
}
