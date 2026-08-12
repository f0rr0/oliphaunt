import Foundation
@testable import Oliphaunt
import Testing

@Test
func configurationDefaultsToTemporaryDirectoryStorage() {
    #expect(OliphauntConfiguration().storage == .temporaryDirectory)
}

@Test
func openUsesDefaultConfigurationWhenOnlyAnEngineIsInjected() async throws {
    let database = try await OliphauntDatabase.open(
        engine: MockEngine(mode: .nativeDirect)
    )
    let capabilities = try await database.capabilities()
    #expect(capabilities.mode == .nativeDirect)
    try await database.close()
}

@Test
func opensAndExecutesThroughInjectedEngine() async throws {
    let database = try await OliphauntDatabase.open(
        configuration: OliphauntConfiguration(mode: .nativeDirect),
        engine: MockEngine(mode: .nativeDirect)
    )

    // OLIPHAUNT_DOCS_SNIPPET swift-quickstart
    let response = try await database.execProtocolRaw(Data([0x51]))
    #expect(response == Data([1, 0x51]))
}

@Test
func queryParsesSimpleQueryResultsThroughInjectedEngine() async throws {
    let database = try await OliphauntDatabase.open(
        configuration: OliphauntConfiguration(mode: .nativeDirect),
        engine: MockEngine(mode: .nativeDirect)
    )

    let result = try await database.query("SELECT 1::text AS value, NULL AS empty")

    #expect(result.fields.map(\.name) == ["value", "empty"])
    #expect(result.fields[0].typeOID == 25)
    #expect(result.rowCount == 1)
    #expect(result.commandTag == "SELECT 1")
    #expect(try result.getText(row: 0, column: "value") == "1")
    #expect(try result.getText(row: 0, column: "empty") == nil)
}

@Test
func queryParametersUseExtendedProtocolThroughInjectedEngine() async throws {
    let database = try await OliphauntDatabase.open(
        configuration: OliphauntConfiguration(mode: .nativeDirect),
        engine: MockEngine(mode: .nativeDirect)
    )

    let request = try OliphauntProtocol.extendedQuery(
        "SELECT $1::text AS value, $2::text AS empty",
        parameters: [.text("1"), .null]
    )
    #expect(request.first == 0x50)
    #expect(request.contains(0x42))
    #expect(request.contains(0x45))

    let result = try await database.query(
        "SELECT $1::text AS value, $2::text AS empty",
        parameters: [.text("1"), .null]
    )

    #expect(try result.getText(row: 0, column: "value") == "1")
    #expect(try result.getText(row: 0, column: "empty") == nil)
}

@Test
func simpleQueryRejectsNulSQLBeforeBuildingProtocol() throws {
    do {
        _ = try OliphauntProtocol.simpleQuery("SELECT 1\0SELECT 2")
        Issue.record("simple-query builder should reject NUL-containing SQL")
    } catch OliphauntError.engine(let message) {
        #expect(message == "simple query SQL must not contain NUL bytes")
    }
}

@Test
func extendedQueryRejectsInvalidFrontendInputsBeforeBuildingProtocol() throws {
    do {
        _ = try OliphauntProtocol.extendedQuery("SELECT \0", parameters: [.null])
        Issue.record("extended-query builder should reject NUL-containing SQL")
    } catch OliphauntError.engine(let message) {
        #expect(message == "extended query SQL must not contain NUL bytes")
    }

    let tooMany = Array(repeating: OliphauntQueryParam.null, count: Int(Int16.max) + 1)
    do {
        _ = try OliphauntProtocol.extendedQuery("SELECT 1", parameters: tooMany)
        Issue.record("extended-query builder should reject too many parameters")
    } catch OliphauntError.engine(let message) {
        #expect(message == "extended query supports at most \(Int16.max) parameters, got \(Int(Int16.max) + 1)")
    }
}

@Test
func transactionCommitsAndRejectsUnpinnedInterleaving() async throws {
    let session = MockSession(mode: .nativeDirect)
    let database = try await OliphauntDatabase.open(
        configuration: OliphauntConfiguration(mode: .nativeDirect),
        engine: FixedSessionEngine(session: session)
    )

    let value = try await database.transaction { transaction in
        do {
            _ = try await database.execute("SELECT outside_transaction")
            Issue.record("database work should not interleave while a transaction is active")
        } catch OliphauntError.engine(let message) {
            #expect(message.contains("active OliphauntTransaction"))
        }
        do {
            try await database.checkpoint()
            Issue.record("checkpoint should not interleave while a transaction is active")
        } catch OliphauntError.engine(let message) {
            #expect(message.contains("active OliphauntTransaction"))
        }
        _ = try await transaction.execute("INSERT INTO swift_tx VALUES (1)")
        let chunks = DataChunkAccumulator()
        try await transaction.execProtocolStream(Data([0x52])) { chunk in
            chunks.append(chunk)
        }
        #expect(chunks.chunks().map { Array($0) } == [[3, 0x52]])
        return 7
    }

    try await database.checkpoint()
    #expect(value == 7)
    let requests = await session.requestTexts()
    #expect(requests.contains { $0.contains("BEGIN") })
    #expect(requests.contains { $0.contains("INSERT INTO swift_tx") })
    #expect(requests.contains { $0.contains("COMMIT") })
    #expect(requests.contains { $0.contains("CHECKPOINT") })
    #expect(!requests.contains { $0.contains("ROLLBACK") })

    do {
        let escaped = try await database.transaction { transaction in
            transaction
        }
        _ = try await escaped.execute("SELECT after_commit")
        Issue.record("escaped transaction should be inactive after commit")
    } catch OliphauntError.engine(let message) {
        #expect(message.contains("transaction is no longer active"))
    }
}

@Test
func transactionRollsBackWhenBodyThrows() async throws {
    let session = MockSession(mode: .nativeDirect)
    let database = try await OliphauntDatabase.open(
        configuration: OliphauntConfiguration(mode: .nativeDirect),
        engine: FixedSessionEngine(session: session)
    )

    let captured = TransactionCapture()
    do {
        try await database.transaction { transaction in
            captured.store(transaction)
            _ = try await transaction.execute("INSERT INTO swift_tx VALUES (2)")
            throw OliphauntError.engine("boom")
        }
        Issue.record("transaction body error should escape")
    } catch OliphauntError.engine(let message) {
        #expect(message == "boom")
    }

    let requests = await session.requestTexts()
    #expect(requests.contains { $0.contains("BEGIN") })
    #expect(requests.contains { $0.contains("INSERT INTO swift_tx") })
    #expect(requests.contains { $0.contains("ROLLBACK") })

    guard let rollbackTransaction = captured.load() else {
        Issue.record("transaction body did not capture the rollback handle")
        return
    }
    do {
        _ = try await rollbackTransaction.execute("SELECT after_rollback")
        Issue.record("captured transaction should be inactive after rollback")
    } catch OliphauntError.engine(let message) {
        #expect(message.contains("transaction is no longer active"))
    }
}

@Test
func closeDuringTransactionClosesSessionAndRejectsPinnedWork() async throws {
    let session = MockSession(mode: .nativeDirect)
    let database = try await OliphauntDatabase.open(
        configuration: OliphauntConfiguration(mode: .nativeDirect),
        engine: FixedSessionEngine(session: session)
    )

    do {
        try await database.transaction { transaction in
            try await database.close()
            _ = try await transaction.execute("SELECT after_close")
        }
        Issue.record("transaction should fail after close")
    } catch OliphauntError.databaseClosed {
        // Expected: close is a lifecycle boundary and no work runs afterward.
    }

    do {
        _ = try await database.execute("SELECT after_closed_database")
        Issue.record("database work should fail after close")
    } catch OliphauntError.databaseClosed {
        // Expected.
    }

    let requests = await session.requestTexts()
    #expect(requests.contains { $0.contains("BEGIN") })
    #expect(!requests.contains { $0.contains("SELECT after_close") })
    #expect(!requests.contains { $0.contains("COMMIT") })
}

@Test
func rawProtocolStreamFallsBackToOwnedResponseThroughInjectedEngine() async throws {
    let database = try await OliphauntDatabase.open(
        configuration: OliphauntConfiguration(mode: .nativeDirect),
        engine: MockEngine(mode: .nativeDirect)
    )

    let chunks = DataChunkAccumulator()
    try await database.execProtocolStream(Data([0x51])) { chunk in
        chunks.append(chunk)
    }

    #expect(chunks.chunks() == [Data([1, 0x51])])
}

@Test
func querySurfacesPostgresErrors() throws {
    do {
        _ = try parseOliphauntQueryResponse(backendErrorResponse("ERROR", "42P01", "relation does not exist"))
        Issue.record("query parser should surface PostgreSQL ErrorResponse")
    } catch OliphauntError.postgres(let error) {
        #expect(error.severity == "ERROR")
        #expect(error.sqlstate == "42P01")
        #expect(error.message == "relation does not exist")
        #expect(error.description == "ERROR [42P01]: relation does not exist")
    }
}

@Test
func highLevelSQLSurfacesPostgresErrorsWhileRawProtocolPreservesBytes() async throws {
    let expected = backendErrorResponse("ERROR", "23505", "duplicate key value")
    let database = try await postgresErrorDatabase(failingOn: "FAIL")
    let request = try OliphauntProtocol.simpleQuery("SELECT FAIL")

    #expect(try await database.execProtocolRaw(request) == expected)

    do {
        _ = try await database.execute("SELECT FAIL")
        Issue.record("execute should surface PostgreSQL ErrorResponse")
    } catch OliphauntError.postgres(let error) {
        #expect(error.sqlstate == "23505")
        #expect(error.message == "duplicate key value")
    }

    do {
        _ = try await database.transaction { transaction in
            try await transaction.execute("SELECT FAIL")
        }
        Issue.record("transaction execute should surface PostgreSQL ErrorResponse")
    } catch OliphauntError.postgres(let error) {
        #expect(error.sqlstate == "23505")
    }
}

@Test
func transactionControlAndCheckpointSurfacePostgresErrors() async throws {
    let beginDatabase = try await postgresErrorDatabase(failingOn: "BEGIN")
    do {
        _ = try await beginDatabase.transaction { _ in () }
        Issue.record("BEGIN should surface PostgreSQL ErrorResponse")
    } catch OliphauntError.postgres(let error) {
        #expect(error.sqlstate == "23505")
    }
    _ = try await beginDatabase.execute("SELECT recovered")

    let commitDatabase = try await postgresErrorDatabase(failingOn: "COMMIT")
    do {
        _ = try await commitDatabase.transaction { _ in () }
        Issue.record("COMMIT should surface PostgreSQL ErrorResponse")
    } catch OliphauntError.postgres(let error) {
        #expect(error.sqlstate == "23505")
    }
    _ = try await commitDatabase.execute("SELECT recovered")

    do {
        try await postgresErrorDatabase(failingOn: "CHECKPOINT").checkpoint()
        Issue.record("checkpoint should surface PostgreSQL ErrorResponse")
    } catch OliphauntError.postgres(let error) {
        #expect(error.sqlstate == "23505")
    }
}

@Test
func queryNormalizesCancellationPostgresErrors() throws {
    do {
        _ = try parseOliphauntQueryResponse(backendErrorResponse(
            "ERROR",
            "57014",
            "canceling statement due to user request"
        ))
        Issue.record("query parser should surface cancellation as a PostgreSQL ErrorResponse")
    } catch OliphauntError.postgres(let error) {
        #expect(error.severity == "ERROR")
        #expect(error.sqlstate == "57014")
        #expect(error.message == "canceling statement due to user request")
    }
}

@Test
func queryParserRejectsInvalidUTF8FieldNames() throws {
    var response = Data()
    appendRawRowDescription(&response, fields: [(Data([0xff]), UInt32(25))])
    appendReadyForQuery(&response)

    do {
        _ = try parseOliphauntQueryResponse(response)
        Issue.record("query parser should reject malformed UTF-8 field names")
    } catch OliphauntError.engine(let message) {
        #expect(message.contains("field name is not valid UTF-8"))
    }
}

@Test
func queryTextAccessorsRejectInvalidUTF8Values() throws {
    var response = Data()
    appendRowDescription(&response, fields: [("value", UInt32(25))])
    appendDataRow(&response, values: [Data([0xff])])
    appendCommandComplete(&response, "SELECT 1")
    appendReadyForQuery(&response)

    let result = try parseOliphauntQueryResponse(response)
    do {
        _ = try result.getText(row: 0, column: "value")
        Issue.record("query text accessor should reject malformed UTF-8 values")
    } catch OliphauntError.engine(let message) {
        #expect(message.contains("query value is not valid UTF-8"))
    }
}

@Test
func queryParserAcceptsExtendedQueryControlMessages() throws {
    var response = Data()
    appendBackendMessage(&response, tag: 0x31, body: Data())
    appendBackendMessage(&response, tag: 0x32, body: Data())
    appendBackendMessage(&response, tag: 0x6e, body: Data())
    appendCommandComplete(&response, "INSERT 0 0")
    appendReadyForQuery(&response)

    let result = try parseOliphauntQueryResponse(response)
    #expect(result.fields.isEmpty)
    #expect(result.rows.isEmpty)
    #expect(result.commandTag == "INSERT 0 0")
}

@Test
func queryParserAcceptsAsyncBackendControlMessages() throws {
    var response = Data()
    appendParameterStatus(&response, name: "client_encoding", value: "UTF8")
    appendNoticeResponse(&response, severity: "NOTICE", message: "hello")
    appendNotificationResponse(&response, pid: 123, channel: "channel", payload: "payload")
    appendCommandComplete(&response, "SELECT 0")
    appendReadyForQuery(&response)

    let result = try parseOliphauntQueryResponse(response)
    #expect(result.commandTag == "SELECT 0")
}

@Test
func queryParserRejectsMalformedEmptyControlMessages() throws {
    var response = Data()
    appendBackendMessage(&response, tag: 0x31, body: Data([0]))
    appendReadyForQuery(&response)

    do {
        _ = try parseOliphauntQueryResponse(response)
        Issue.record("query parser should reject malformed empty control messages")
    } catch OliphauntError.engine(let message) {
        #expect(message.contains("ParseComplete contained trailing bytes"))
    }
}

@Test
func queryParserRejectsMalformedAsyncBackendControlMessages() throws {
    var malformedParameter = Data()
    appendBackendMessage(
        &malformedParameter,
        tag: 0x53,
        body: Data("client_encoding\u{0}".utf8)
    )
    appendReadyForQuery(&malformedParameter)
    do {
        _ = try parseOliphauntQueryResponse(malformedParameter)
        Issue.record("query parser should reject malformed ParameterStatus")
    } catch OliphauntError.engine(let message) {
        #expect(message.contains("ParameterStatus value is missing null terminator"))
    }

    var malformedNotice = Data()
    var noticeBody = Data([0x53])
    noticeBody.append(Data("NOTICE\u{0}".utf8))
    appendBackendMessage(&malformedNotice, tag: 0x4e, body: noticeBody)
    appendReadyForQuery(&malformedNotice)
    do {
        _ = try parseOliphauntQueryResponse(malformedNotice)
        Issue.record("query parser should reject malformed NoticeResponse")
    } catch OliphauntError.engine(let message) {
        #expect(message.contains("NoticeResponse is missing terminator"))
    }

    var malformedNotification = Data()
    var notificationBody = Data()
    appendInt32(&notificationBody, 123)
    notificationBody.append(Data("channel".utf8))
    appendBackendMessage(&malformedNotification, tag: 0x41, body: notificationBody)
    appendReadyForQuery(&malformedNotification)
    do {
        _ = try parseOliphauntQueryResponse(malformedNotification)
        Issue.record("query parser should reject malformed NotificationResponse")
    } catch OliphauntError.engine(let message) {
        #expect(message.contains("NotificationResponse channel is missing null terminator"))
    }
}

@Test
func queryParserRejectsUnexpectedBackendMessageTags() throws {
    var response = Data()
    appendBackendMessage(&response, tag: 0x52, body: Data([0, 0, 0, 0]))
    appendReadyForQuery(&response)

    do {
        _ = try parseOliphauntQueryResponse(response)
        Issue.record("query parser should reject unexpected backend message tags")
    } catch OliphauntError.engine(let message) {
        #expect(message.contains("unexpected backend message tag 0x52"))
    }
}

@Test
func queryParserAcceptsReadyForQueryTransactionStates() throws {
    for status in [UInt8(0x49), UInt8(0x54), UInt8(0x45)] {
        var response = Data()
        appendCommandComplete(&response, "SELECT 0")
        appendReadyForQuery(&response, status: status)

        let result = try parseOliphauntQueryResponse(response)
        #expect(result.commandTag == "SELECT 0")
    }
}

@Test
func queryParserRejectsMalformedReadyForQueryStatus() throws {
    var missing = Data()
    appendBackendMessage(&missing, tag: 0x5a, body: Data())
    do {
        _ = try parseOliphauntQueryResponse(missing)
        Issue.record("query parser should reject ReadyForQuery without status")
    } catch OliphauntError.engine(let message) {
        #expect(message.contains("ReadyForQuery contained 0 bytes, expected 1"))
    }

    var invalid = Data()
    appendReadyForQuery(&invalid, status: 0)
    do {
        _ = try parseOliphauntQueryResponse(invalid)
        Issue.record("query parser should reject invalid ReadyForQuery status")
    } catch OliphauntError.engine(let message) {
        #expect(message.contains("ReadyForQuery contained invalid transaction status 0x00"))
    }
}

@Test
func serverCapabilitiesExposeConnectionString() async throws {
    let database = try await OliphauntDatabase.open(
        configuration: OliphauntConfiguration(mode: .nativeServer),
        engine: MockEngine(mode: .nativeServer)
    )

    let capabilities = try await database.capabilities()
    #expect(capabilities.independentSessions)
    #expect(!capabilities.multipleInstances)
    #expect(capabilities.queryCancel)
    #expect(capabilities.backupRestore)
    #expect(capabilities.backupFormats == [.sql, .physicalArchive])
    #expect(capabilities.restoreFormats == [.physicalArchive])
    #expect(capabilities.supportsBackupFormat(.sql))
    #expect(capabilities.supportsBackupFormat(.physicalArchive))
    #expect(!capabilities.supportsBackupFormat(.oliphauntArchive))
    #expect(capabilities.supportsRestoreFormat(.physicalArchive))
    #expect(!capabilities.supportsRestoreFormat(.sql))
    #expect(try await database.supportsBackupFormat(.sql))
    #expect(try await database.supportsRestoreFormat(.physicalArchive))
    #expect(!(try await database.supportsRestoreFormat(.sql)))
    #expect(capabilities.simpleQuery)
    #expect(capabilities.connectionString == "postgres://postgres@127.0.0.1:55432/template1")
}

@Test
func connectionStringIsOnlyPresentForServerCapabilities() async throws {
    for mode in [OliphauntEngineMode.nativeDirect, .nativeBroker] {
        let database = try await OliphauntDatabase.open(
            configuration: OliphauntConfiguration(mode: mode),
            engine: MockEngine(mode: mode)
        )
        #expect(try await database.connectionString() == nil)
        #expect(!(try await database.capabilities()).independentSessions)
    }

    let server = try await OliphauntDatabase.open(
        configuration: OliphauntConfiguration(mode: .nativeServer),
        engine: MockEngine(mode: .nativeServer)
    )
    #expect(try await server.connectionString() == "postgres://postgres@127.0.0.1:55432/template1")
    #expect((try await server.capabilities()).independentSessions)
}

@Test
func backupUsesCanonicalFormats() async throws {
    let database = try await OliphauntDatabase.open(
        configuration: OliphauntConfiguration(mode: .nativeServer),
        engine: MockEngine(mode: .nativeServer)
    )

    let artifact = try await database.backup(OliphauntBackupRequest(format: .sql))
    #expect(artifact.format == .sql)
    #expect(artifact.bytes == Data("sql-backup".utf8))
}

@Test
func backupRejectsUnsupportedFormatsBeforeEngineCall() async throws {
    let database = try await OliphauntDatabase.open(
        configuration: OliphauntConfiguration(mode: .nativeDirect),
        engine: MockEngine(mode: .nativeDirect)
    )

    do {
        _ = try await database.backup(OliphauntBackupRequest(format: .sql))
        Issue.record("nativeDirect SQL backup should be rejected by capabilities")
    } catch OliphauntError.engine(let message) {
        #expect(message.contains("sql backup is not supported by nativeDirect"))
    }
}

@Test
func openRejectsNonFileStorageDirectoryBeforeEngineCall() async throws {
    do {
        _ = try await OliphauntDatabase.open(
            configuration: OliphauntConfiguration(
                mode: .nativeDirect,
                storage: .directory(URL(string: "https://example.invalid/liboliphaunt")!)
            ),
            engine: MockEngine(mode: .nativeDirect)
        )
        Issue.record("non-file storage directories should be rejected before engine open")
    } catch OliphauntError.engine(let message) {
        #expect(message.contains("database storage directory must be a file URL"))
    }
}

@Test
func openRejectsNulStorageDirectoryBeforeEngineCall() async throws {
    let engine = CountingEngine()
    do {
        _ = try await OliphauntDatabase.open(
            configuration: OliphauntConfiguration(
                mode: .nativeDirect,
                storage: .directory(URL(string: "file:///tmp/oliphaunt-swift%00storage")!)
            ),
            engine: engine
        )
        Issue.record("NUL-containing storage directories should be rejected before engine open")
    } catch OliphauntError.engine(let message) {
        #expect(message.contains("database storage directory must not contain NUL bytes"))
    }
    #expect(await engine.openCallCount() == 0)
}

@Test
func openValidatesExtensionIdsBeforeEngineCall() async throws {
    let engine = CountingEngine()

    do {
        _ = try await OliphauntDatabase.open(
            configuration: OliphauntConfiguration(
                mode: .nativeDirect,
                extensions: ["mobile/vector"]
            ),
            engine: engine
        )
        Issue.record("invalid extension ids should be rejected before engine open")
    } catch OliphauntError.engine(let message) {
        #expect(message.contains("extension id 'mobile/vector'"))
    }
    #expect(await engine.openCallCount() == 0)

    let database = try await OliphauntDatabase.open(
        configuration: OliphauntConfiguration(
            mode: .nativeDirect,
            extensions: [" pg_trgm ", "", "vector", "hstore"]
        ),
        engine: engine
    )
    #expect(await engine.openCallCount() == 1)
    #expect(await engine.lastExtensions() == ["pg_trgm", "vector", "hstore"])
    try await database.close()
}

@Test
func openForwardsFootprintAndStartupGUCsAndRejectsInvalidGUCsBeforeEngineCall() async throws {
    let engine = CountingEngine()

    do {
        _ = try await OliphauntDatabase.open(
            configuration: OliphauntConfiguration(
                mode: .nativeDirect,
                startupGUCs: [OliphauntStartupGUC("shared-buffers", "16MB")]
            ),
            engine: engine
        )
        Issue.record("invalid startup GUC names should be rejected before engine open")
    } catch OliphauntError.engine(let message) {
        #expect(message.contains("startup GUC name 'shared-buffers'"))
    }
    #expect(await engine.openCallCount() == 0)

    let database = try await OliphauntDatabase.open(
        configuration: OliphauntConfiguration(
            mode: .nativeDirect,
            runtimeFootprint: .balancedMobile,
            startupGUCs: [
                OliphauntStartupGUC("shared_buffers", "16MB"),
                OliphauntStartupGUC("wal_buffers", "256kB"),
            ]
        ),
        engine: engine
    )
    #expect(await engine.openCallCount() == 1)
    #expect(await engine.lastRuntimeFootprint() == .balancedMobile)
    #expect(await engine.lastStartupGUCs() == [
        OliphauntStartupGUC("shared_buffers", "16MB"),
        OliphauntStartupGUC("wal_buffers", "256kB"),
    ])
    try await database.close()
}

@Test
func runtimeFootprintProfilesBuildTheMobileStartupGUCContract() {
    #expect(
        startupAssignments(
            OliphauntConfiguration(
                durability: .balanced,
                runtimeFootprint: .balancedMobile,
                startupGUCs: [OliphauntStartupGUC(" shared_buffers ", "16MB")]
            ).postgresStartupArgs()
        ) == [
            "max_connections=1",
            "superuser_reserved_connections=0",
            "reserved_connections=0",
            "autovacuum_worker_slots=1",
            "max_wal_senders=0",
            "max_replication_slots=0",
            "shared_buffers=32MB",
            "wal_buffers=-1",
            "min_wal_size=32MB",
            "max_wal_size=64MB",
            "io_method=sync",
            "io_max_concurrency=1",
            "fsync=on",
            "full_page_writes=on",
            "synchronous_commit=off",
            "shared_buffers=16MB",
        ]
    )
    #expect(
        startupAssignments(
            OliphauntConfiguration(
                durability: .balanced,
                runtimeFootprint: .balancedMobile,
                startupGUCs: [OliphauntStartupGUC(" shared_buffers ", "16MB")]
            ).postgresStartupArgs(sharedPreloadLibraries: ["pg_search", "auto_explain", "pg_search"])
        ) == [
            "max_connections=1",
            "superuser_reserved_connections=0",
            "reserved_connections=0",
            "autovacuum_worker_slots=1",
            "max_wal_senders=0",
            "max_replication_slots=0",
            "shared_buffers=32MB",
            "wal_buffers=-1",
            "min_wal_size=32MB",
            "max_wal_size=64MB",
            "io_method=sync",
            "io_max_concurrency=1",
            "fsync=on",
            "full_page_writes=on",
            "synchronous_commit=off",
            "shared_buffers=16MB",
            "shared_preload_libraries=auto_explain,pg_search",
        ]
    )
    #expect(
        startupAssignments(
            OliphauntConfiguration(runtimeFootprint: .smallMobile).postgresStartupArgs()
        ) == [
            "max_connections=1",
            "superuser_reserved_connections=0",
            "reserved_connections=0",
            "autovacuum_worker_slots=1",
            "max_wal_senders=0",
            "max_replication_slots=0",
            "shared_buffers=8MB",
            "wal_buffers=256kB",
            "min_wal_size=32MB",
            "max_wal_size=64MB",
            "work_mem=1MB",
            "maintenance_work_mem=16MB",
            "io_method=sync",
            "io_max_concurrency=1",
            "fsync=on",
            "full_page_writes=on",
            "synchronous_commit=off",
        ]
    )
}

@Test
func openForwardsConnectionIdentityAndRejectsInvalidIdentityBeforeEngineCall() async throws {
    let engine = CountingEngine()

    do {
        _ = try await OliphauntDatabase.open(
            configuration: OliphauntConfiguration(
                mode: .nativeDirect,
                username: " \n"
            ),
            engine: engine
        )
        Issue.record("blank usernames should be rejected before engine open")
    } catch OliphauntError.engine(let message) {
        #expect(message.contains("username must not be empty"))
    }
    #expect(await engine.openCallCount() == 0)

    let database = try await OliphauntDatabase.open(
        configuration: OliphauntConfiguration(
            mode: .nativeDirect,
            username: "app_user",
            database: "app_db"
        ),
        engine: engine
    )
    #expect(await engine.openCallCount() == 1)
    #expect(await engine.lastUsername() == "app_user")
    #expect(await engine.lastDatabase() == "app_db")
    try await database.close()
}

@Test
func restoreUsesCanonicalPhysicalArchiveShape() async throws {
    let artifact = OliphauntBackupArtifact(
        format: .physicalArchive,
        bytes: Data("physical-backup".utf8)
    )
    let destination = URL(fileURLWithPath: "/tmp/oliphaunt-swift-restore")
    let restored = try await OliphauntDatabase.restore(
        OliphauntRestoreRequest(artifact: artifact, destination: destination).replaceExisting(),
        engine: MockEngine(
            mode: .nativeDirect,
            expectedRestoreDestinationPolicy: .replaceExisting
        )
    )

    #expect(restored == destination)
}

@Test
func restoreForwardsFailIfExistsByDefault() async throws {
    let artifact = OliphauntBackupArtifact(
        format: .physicalArchive,
        bytes: Data("physical-backup".utf8)
    )
    let destination = URL(fileURLWithPath: "/tmp/oliphaunt-swift-restore-default-policy")
    let restored = try await OliphauntDatabase.restore(
        OliphauntRestoreRequest(artifact: artifact, destination: destination),
        engine: MockEngine(
            mode: .nativeDirect,
            expectedRestoreDestinationPolicy: .failIfExists
        )
    )

    #expect(restored == destination)
}

@Test
func restoreRejectsUnsupportedFormatsBeforeEngineCall() async throws {
    let request = OliphauntRestoreRequest(
        artifact: OliphauntBackupArtifact(format: .sql, bytes: Data("sql-backup".utf8)),
        destination: URL(fileURLWithPath: "/tmp/oliphaunt-swift-restore-sql")
    )

    do {
        _ = try await OliphauntDatabase.restore(
            request,
            engine: MockEngine(mode: .nativeDirect)
        )
        Issue.record("SQL restore should be rejected before the engine call")
    } catch OliphauntError.engine(let message) {
        #expect(message.contains("restore currently requires a physicalArchive artifact, got sql"))
    }
}

@Test
func restoreRejectsNonFileDestinationBeforeEngineCall() async throws {
    let request = OliphauntRestoreRequest(
        artifact: OliphauntBackupArtifact(
            format: .physicalArchive,
            bytes: Data("physical-backup".utf8)
        ),
        destination: URL(string: "https://example.invalid/liboliphaunt-restore")!
    )

    do {
        _ = try await OliphauntDatabase.restore(
            request,
            engine: MockEngine(mode: .nativeDirect)
        )
        Issue.record("non-file restore destinations should be rejected before engine restore")
    } catch OliphauntError.engine(let message) {
        #expect(message.contains("restore destination must be a file URL"))
    }
}

@Test
func restoreRejectsNulDestinationBeforeEngineCall() async throws {
    let engine = CountingEngine()
    let request = OliphauntRestoreRequest(
        artifact: OliphauntBackupArtifact(
            format: .physicalArchive,
            bytes: Data("physical-backup".utf8)
        ),
        destination: URL(string: "file:///tmp/oliphaunt-swift%00restore")!
    )

    do {
        _ = try await OliphauntDatabase.restore(request, engine: engine)
        Issue.record("NUL-containing restore destinations should be rejected before engine restore")
    } catch OliphauntError.engine(let message) {
        #expect(message.contains("restore destination must not contain NUL bytes"))
    }
    #expect(await engine.restoreCallCount() == 0)
}

@Test
func closeIsIdempotentAndRejectsFurtherExecution() async throws {
    let database = try await OliphauntDatabase.open(
        configuration: OliphauntConfiguration(mode: .nativeDirect),
        engine: MockEngine(mode: .nativeDirect)
    )

    try await database.close()
    try await database.close()

    do {
        _ = try await database.execProtocolRaw(Data())
        Issue.record("execution after close should fail")
    } catch OliphauntError.databaseClosed {
    }
}

@Test
func failedCloseKeepsSessionUsableAndRetriesTheSameOwner() async throws {
    let session = FailOnceCloseSession()
    let database = try await OliphauntDatabase.open(
        configuration: OliphauntConfiguration(mode: .nativeDirect),
        engine: FixedSessionEngine(session: session)
    )

    do {
        try await database.close()
        Issue.record("injected first close should fail")
    } catch OliphauntError.engine(let message) {
        #expect(message == "injected detach failure")
    }

    #expect(try await database.execProtocolRaw(Data([1, 2, 3])) == Data([1, 2, 3]))
    try await database.close()
    #expect(await session.closeAttemptCount() == 2)
}

@Test
func closeWaitsForActiveExecutionBeforeClosing() async throws {
    let session = BlockingSession(mode: .nativeDirect)
    let database = try await OliphauntDatabase.open(
        configuration: OliphauntConfiguration(mode: .nativeDirect),
        engine: FixedSessionEngine(session: session)
    )

    let running = Task {
        try await database.execProtocolRaw(Data("SELECT pg_sleep(5)".utf8))
    }
    await session.waitUntilStarted()

    let closing = Task {
        try await database.close()
    }
    await Task.yield()

    #expect(!(await session.wasClosed()))
    await session.releaseExecution(with: Data("finished".utf8))
    let response = try await running.value
    #expect(response == Data("finished".utf8))
    try await closing.value
    #expect(!(await session.wasCancelled()))
    #expect(await session.wasClosed())

    do {
        try await database.cancel()
        Issue.record("cancel after close should fail")
    } catch OliphauntError.databaseClosed {
    }
}

@Test
func sessionOperationsQueueFifoAcrossConcurrentTasks() async throws {
    let session = BlockingSession(mode: .nativeDirect)
    let database = try await OliphauntDatabase.open(
        configuration: OliphauntConfiguration(mode: .nativeDirect),
        engine: FixedSessionEngine(session: session)
    )

    let first = Task {
        try await database.execProtocolRaw(Data([0x4c]))
    }
    await session.waitForRequestCount(1)

    let second = Task {
        try await database.execProtocolRaw(Data([0x31]))
    }
    await Task.yield()

    #expect(await session.requestBytes() == [Data([0x4c])])

    await session.releaseExecution(with: Data([0xf0]))
    #expect(try await first.value == Data([0xf0]))
    await session.waitForRequestCount(2)

    #expect(await session.requestBytes() == [Data([0x4c]), Data([0x31])])

    await session.releaseExecution(with: Data([0xf1]))
    #expect(try await second.value == Data([0xf1]))
}

@Test
func closeRejectsQueuedWorkBeforeNativeSessionCall() async throws {
    let session = BlockingSession(mode: .nativeDirect)
    let database = try await OliphauntDatabase.open(
        configuration: OliphauntConfiguration(mode: .nativeDirect),
        engine: FixedSessionEngine(session: session)
    )

    let running = Task {
        try await database.execProtocolRaw(Data("SELECT active".utf8))
    }
    await session.waitForRequestCount(1)

    let queued = Task {
        try await database.execProtocolRaw(Data("SELECT queued".utf8))
    }
    await Task.yield()

    let closing = Task {
        try await database.close()
    }
    await Task.yield()

    #expect(await session.requestTexts() == ["SELECT active"])

    await session.releaseExecution(with: Data("active done".utf8))
    #expect(try await running.value == Data("active done".utf8))
    do {
        _ = try await queued.value
        Issue.record("queued work should be rejected after close detaches the database")
    } catch OliphauntError.databaseClosed {
    }
    try await closing.value

    #expect(await session.wasClosed())
    #expect(await session.requestTexts() == ["SELECT active"])
}

@Test
func prepareForBackgroundCheckpointsWhenIdleAndResumeProbesSession() async throws {
    let session = MockSession(mode: .nativeDirect)
    let database = try await OliphauntDatabase.open(
        configuration: OliphauntConfiguration(mode: .nativeDirect),
        engine: FixedSessionEngine(session: session)
    )

    let prepared = try await database.prepareForBackground()

    #expect(prepared == OliphauntBackgroundPreparationResult(
        cancelledActiveWork: false,
        checkpointed: true
    ))
    try await database.resumeFromBackground()

    let requests = await session.requestTexts()
    #expect(requests.contains { $0.contains("CHECKPOINT") })
    #expect(requests.contains { $0.contains("SELECT 1") })
}

@Test
func prepareForBackgroundCancelsActiveWorkAndSkipsCheckpoint() async throws {
    let session = BlockingSession(mode: .nativeDirect)
    let database = try await OliphauntDatabase.open(
        configuration: OliphauntConfiguration(mode: .nativeDirect),
        engine: FixedSessionEngine(session: session)
    )

    let running = Task {
        try await database.execProtocolRaw(Data("SELECT pg_sleep(5)".utf8))
    }
    await session.waitUntilStarted()

    let prepared = try await database.prepareForBackground()

    #expect(prepared == OliphauntBackgroundPreparationResult(
        cancelledActiveWork: true,
        checkpointed: false,
        skippedCheckpointReason: .activeWork
    ))
    #expect(try await running.value == Data("cancelled".utf8))
    #expect(await session.wasCancelled())
}

@Test
func prepareForBackgroundSkipsCheckpointWhileTransactionIsActive() async throws {
    let session = MockSession(mode: .nativeDirect)
    let database = try await OliphauntDatabase.open(
        configuration: OliphauntConfiguration(mode: .nativeDirect),
        engine: FixedSessionEngine(session: session)
    )

    let prepared = try await database.transaction { _ in
        try await database.prepareForBackground()
    }

    #expect(prepared == OliphauntBackgroundPreparationResult(
        cancelledActiveWork: false,
        checkpointed: false,
        skippedCheckpointReason: .transactionActive
    ))
    let requests = await session.requestTexts()
    #expect(!requests.contains { $0.contains("CHECKPOINT") })
}

@Test
func nativeDirectEngineReportsMissingLibrary() async throws {
    let databaseDirectory = try makeExistingDatabaseDirectory()
    defer {
        try? FileManager.default.removeItem(at: databaseDirectory)
    }
    let engine = OliphauntNativeDirectEngine(
        libraryURL: URL(fileURLWithPath: "/tmp/oliphaunt-swift-missing.dylib")
    )

    do {
        _ = try await OliphauntDatabase.open(
            configuration: OliphauntConfiguration(
                mode: .nativeDirect,
                storage: .directory(databaseDirectory)
            ),
            engine: engine
        )
        Issue.record("opening with a missing liboliphaunt library should fail")
    } catch OliphauntError.engine(let message) {
        #expect(message.contains("failed to load liboliphaunt"))
    }
}

@Test
func defaultEngineUsesNativeDirectRuntimeForNativeDirect() async throws {
    let environment = ProcessInfo.processInfo.environment
    guard environment["LIBOLIPHAUNT_PATH"] == nil else {
        return
    }

    do {
        _ = try await OliphauntDatabase.open(
            configuration: OliphauntConfiguration(mode: .nativeDirect)
        )
        Issue.record("default nativeDirect engine should fail while liboliphaunt is unavailable")
    } catch OliphauntError.engine(let message) {
        #expect(message.contains("oliphaunt"))
    }
}

@Test
func defaultEngineRejectsBrokerAndServerUntilThoseRuntimesAreLinked() async throws {
    for mode in [OliphauntEngineMode.nativeBroker, .nativeServer] {
        do {
            _ = try await OliphauntDatabase.open(
                configuration: OliphauntConfiguration(mode: mode)
            )
            Issue.record("default engine should reject \(mode.rawValue)")
        } catch OliphauntError.runtimeUnavailable(let unavailableMode) {
            #expect(unavailableMode == mode)
        }
    }
}

@Test
func defaultEnginePublishesExplicitModeSupport() throws {
    let support = OliphauntDatabase.supportedModes()

    #expect(support.map(\.mode) == [.nativeDirect, .nativeBroker, .nativeServer])
    #expect(support[0].available)
    #expect(support[0].capabilities.maxClientSessions == 1)
    #expect(support[0].capabilities.backupFormats == [.physicalArchive])
    #expect(support[0].capabilities.supportsBackupFormat(.physicalArchive))
    #expect(!support[0].capabilities.supportsBackupFormat(.sql))
    #expect(!support[0].capabilities.independentSessions)
    #expect(!support[0].capabilities.multipleInstances)
    #expect(support[0].capabilities.sameInstanceLogicalReopen)
    #expect(!support[0].capabilities.instanceSwitchable)
    #expect(!support[0].capabilities.crashRestartable)
    #expect(!support[1].available)
    #expect(support[1].capabilities.processIsolated)
    #expect(support[1].capabilities.multipleInstances)
    #expect(!support[1].capabilities.sameInstanceLogicalReopen)
    #expect(support[1].capabilities.instanceSwitchable)
    #expect(support[1].capabilities.crashRestartable)
    #expect(support[1].unavailableReason?.contains("broker") == true)
    #expect(!support[2].available)
    #expect(support[2].capabilities.independentSessions)
    #expect(!support[2].capabilities.multipleInstances)
    #expect(!support[2].capabilities.sameInstanceLogicalReopen)
    #expect(support[2].capabilities.instanceSwitchable)
    #expect(!support[2].capabilities.crashRestartable)
    #expect(support[2].capabilities.backupFormats == [.sql, .physicalArchive])
    #expect(support[2].capabilities.supportsBackupFormat(.sql))
    #expect(support[2].capabilities.supportsRestoreFormat(.physicalArchive))
    #expect(support[2].unavailableReason?.contains("server") == true)
}

@Test
func nativeDirectExtensionsRequireExplicitRuntimeDirectory() async throws {
    let environment = ProcessInfo.processInfo.environment
    guard environment["OLIPHAUNT_INSTALL_DIR"] == nil,
          environment["OLIPHAUNT_RUNTIME_DIR"] == nil
    else {
        return
    }
    let engine = OliphauntNativeDirectEngine(
        libraryURL: URL(fileURLWithPath: "/tmp/oliphaunt-swift-missing.dylib")
    )

    do {
        _ = try await OliphauntDatabase.open(
            configuration: OliphauntConfiguration(
                mode: .nativeDirect,
                extensions: ["vector"]
            ),
            engine: engine
        )
        Issue.record("opening with extensions but no runtime directory should fail")
    } catch OliphauntError.engine(let message) {
        #expect(message.contains("extensions require runtimeDirectory"))
    }
}

@Test
func nativeDirectExtensionIdsArePortable() async throws {
    let engine = OliphauntNativeDirectEngine(
        libraryURL: URL(fileURLWithPath: "/tmp/oliphaunt-swift-missing.dylib"),
        runtimeDirectory: URL(fileURLWithPath: "/tmp/oliphaunt-swift-runtime")
    )

    do {
        _ = try await OliphauntDatabase.open(
            configuration: OliphauntConfiguration(
                mode: .nativeDirect,
                extensions: ["mobile/vector"]
            ),
            engine: engine
        )
        Issue.record("opening with a non-portable extension id should fail")
    } catch OliphauntError.engine(let message) {
        #expect(message.contains("must contain only ASCII"))
    }
}

@Test
func nativeDirectExtensionsRejectUnprovedExplicitRuntimeDirectory() async throws {
    let databaseDirectory = try makeExistingDatabaseDirectory()
    defer {
        try? FileManager.default.removeItem(at: databaseDirectory)
    }
    let engine = OliphauntNativeDirectEngine(
        libraryURL: URL(fileURLWithPath: "/tmp/oliphaunt-swift-missing.dylib"),
        runtimeDirectory: URL(fileURLWithPath: "/tmp/oliphaunt-swift-runtime")
    )

    do {
        _ = try await OliphauntDatabase.open(
            configuration: OliphauntConfiguration(
                mode: .nativeDirect,
                storage: .directory(databaseDirectory),
                extensions: ["vector"]
            ),
            engine: engine
        )
        Issue.record("explicit runtimeDirectory with extensions should require release-shaped proof")
    } catch OliphauntError.engine(let message) {
        #expect(message.contains("release-shaped OliphauntRuntimeResources"))
    }
}

@Test
func nativeDirectExtensionsUseExplicitRuntimeDirectory() async throws {
    let fixture = try makeRuntimeResourceFixture()
    let databaseDirectory = try makeExistingDatabaseDirectory()
    defer {
        try? FileManager.default.removeItem(at: fixture.root)
        try? FileManager.default.removeItem(at: databaseDirectory)
    }
    let engine = OliphauntNativeDirectEngine(
        libraryURL: URL(fileURLWithPath: "/tmp/oliphaunt-swift-missing.dylib"),
        runtimeDirectory: fixture.resourceRoot.appendingPathComponent("runtime/files", isDirectory: true)
    )

    do {
        _ = try await OliphauntDatabase.open(
            configuration: OliphauntConfiguration(
                mode: .nativeDirect,
                storage: .directory(databaseDirectory),
                extensions: ["vector"]
            ),
            engine: engine
        )
        Issue.record("missing liboliphaunt should fail after extension validation")
    } catch OliphauntError.engine(let message) {
        #expect(message.contains("failed to load liboliphaunt"))
    }
}

@Test
func runtimeResourcesMaterializeRuntimeAndPrepareTemplatePgdata() throws {
    let fixture = try makeRuntimeResourceFixture()
    defer {
        try? FileManager.default.removeItem(at: fixture.root)
    }
    let resources = OliphauntRuntimeResources(
        resourceRoot: fixture.resourceRoot,
        cacheRoot: fixture.cacheRoot
    )

    let runtime = try resources.materializeRuntime(requestedExtensions: ["vector"])
    #expect(FileManager.default.fileExists(
        atPath: runtime.appendingPathComponent("share/postgresql/README.liboliphaunt-smoke").path
    ))
    #expect(FileManager.default.fileExists(
        atPath: runtime.appendingPathComponent("share/postgresql/extension/vector.control").path
    ))
    #expect(FileManager.default.fileExists(
        atPath: runtime.appendingPathComponent("share/postgresql/extension/vector--1.0.sql").path
    ))
    #expect(!FileManager.default.fileExists(
        atPath: runtime.appendingPathComponent("share/postgresql/extension/hstore.control").path
    ))
    #expect(try resources.sharedPreloadLibraries(requestedExtensions: ["vector"]).isEmpty)

    let pgdata = fixture.root.appendingPathComponent("app-root/pgdata", isDirectory: true)
    #expect(try resources.preparePgdata(at: pgdata))
    #expect(FileManager.default.fileExists(atPath: pgdata.appendingPathComponent("PG_VERSION").path))
    #expect(FileManager.default.fileExists(atPath: pgdata.appendingPathComponent("pg_notify").path))
    #expect(FileManager.default.fileExists(atPath: pgdata.appendingPathComponent("pg_wal/archive_status").path))
    #expect(try posixPermissions(pgdata) == 0o700)
    #expect(try posixPermissions(pgdata.appendingPathComponent("PG_VERSION")) == 0o600)
}

@Test
func runtimeResourcesExposeManifestSharedPreloadLibraries() throws {
    let fixture = try makeRuntimeResourceFixture(sharedPreloadLibraries: "pg_search,auto_explain")
    defer {
        try? FileManager.default.removeItem(at: fixture.root)
    }
    let resources = OliphauntRuntimeResources(
        resourceRoot: fixture.resourceRoot,
        cacheRoot: fixture.cacheRoot
    )

    #expect(try resources.sharedPreloadLibraries(requestedExtensions: ["vector"]) == [
        "auto_explain",
        "pg_search",
    ])
}

@Test
func runtimeResourcesValidateExplicitRuntimeDirectory() throws {
    let fixture = try makeRuntimeResourceFixture(sharedPreloadLibraries: "pg_search")
    defer {
        try? FileManager.default.removeItem(at: fixture.root)
    }
    let resources = OliphauntRuntimeResources(
        resourceRoot: fixture.resourceRoot,
        cacheRoot: fixture.cacheRoot
    )
    let runtimeDirectory = fixture.resourceRoot
        .appendingPathComponent("runtime/files", isDirectory: true)

    #expect(try resources.sharedPreloadLibraries(
        forRuntimeDirectory: runtimeDirectory,
        requestedExtensions: ["vector"]
    ) == ["pg_search"])
    let inferred = try #require(try OliphauntRuntimeResources.releaseShapedResources(
        forRuntimeDirectory: runtimeDirectory,
        cacheRoot: fixture.cacheRoot
    ))
    #expect(inferred.resourceRoot.standardizedFileURL == fixture.resourceRoot.standardizedFileURL)
}

@Test
func runtimeResourcesDiscoverBundledResourceDirectoryCandidates() throws {
    let fixture = try makeRuntimeResourceFixture()
    defer {
        try? FileManager.default.removeItem(at: fixture.root)
    }

    let resources = try #require(try OliphauntRuntimeResources.bundledResource(
        inResourceDirectories: [
            fixture.root.appendingPathComponent("empty-bundle-resources", isDirectory: true),
            fixture.root.appendingPathComponent("resources", isDirectory: true),
        ],
        cacheRoot: fixture.cacheRoot
    ))
    #expect(resources.resourceRoot.standardizedFileURL == fixture.resourceRoot.standardizedFileURL)
}

@Test
func runtimeResourcesDiscoveryPrefersBundleContainingRequestedExtensions() throws {
    let fixture = try makeRuntimeResourceFixture()
    defer {
        try? FileManager.default.removeItem(at: fixture.root)
    }
    let baseOnlyResourceRoot = fixture.root.appendingPathComponent("base-bundle/oliphaunt", isDirectory: true)
    try writeText(
        baseOnlyResourceRoot.appendingPathComponent("runtime/manifest.properties"),
        """
        schema=oliphaunt-runtime-resources-v1
        layout=postgres-runtime-files-v1
        cacheKey=test-runtime-base-v1
        extensions=
        sharedPreloadLibraries=
        mobileStaticRegistryState=not-required
        mobileStaticRegistryRegistered=
        mobileStaticRegistryPending=
        nativeModuleStems=
        """
    )
    try writeText(
        baseOnlyResourceRoot.appendingPathComponent("runtime/files/share/postgresql/README.liboliphaunt-smoke"),
        "base runtime smoke\n"
    )

    let baseFirst = try #require(try OliphauntRuntimeResources.bundledResource(
        inResourceDirectories: [
            fixture.root.appendingPathComponent("base-bundle", isDirectory: true),
            fixture.root.appendingPathComponent("resources", isDirectory: true),
        ],
        cacheRoot: fixture.cacheRoot
    ))
    #expect(baseFirst.resourceRoot.standardizedFileURL == baseOnlyResourceRoot.standardizedFileURL)

    let vectorResources = try #require(try OliphauntRuntimeResources.bundledResource(
        inResourceDirectories: [
            fixture.root.appendingPathComponent("base-bundle", isDirectory: true),
            fixture.root.appendingPathComponent("resources", isDirectory: true),
        ],
        containing: ["vector"],
        cacheRoot: fixture.cacheRoot
    ))
    #expect(vectorResources.resourceRoot.standardizedFileURL == fixture.resourceRoot.standardizedFileURL)
}

@Test
func runtimeResourcesExposePackageSizeReport() throws {
    let fixture = try makeRuntimeResourceFixture()
    defer {
        try? FileManager.default.removeItem(at: fixture.root)
    }
    let resources = OliphauntRuntimeResources(
        resourceRoot: fixture.resourceRoot,
        cacheRoot: fixture.cacheRoot
    )

    let report = try #require(try resources.packageSizeReport())
    #expect(report.packageBytes == 185)
    #expect(report.runtimeBytes == 100)
    #expect(report.templatePgdataBytes == 40)
    #expect(report.staticRegistryBytes == 45)
    #expect(report.selectedExtensionBytes == 30)
    #expect(report.runtimeFeatures == ["icu"])
    #expect(report.extensions == [
        OliphauntExtensionSizeReport(
            name: "vector",
            fileCount: 3,
            bytes: 30
        ),
    ])
}

@Test
func runtimeResourcesRejectMalformedPackageSizeReport() throws {
    let fixture = try makeRuntimeResourceFixture()
    defer {
        try? FileManager.default.removeItem(at: fixture.root)
    }
    try writeText(
        fixture.resourceRoot.appendingPathComponent("package-size.tsv"),
        """
        kind\tid\textensions\tfiles\tbytes
        package\ttotal\t-\t-\tnot-bytes
        """
    )
    let resources = OliphauntRuntimeResources(
        resourceRoot: fixture.resourceRoot,
        cacheRoot: fixture.cacheRoot
    )

    do {
        _ = try resources.packageSizeReport()
        Issue.record("runtime resources should reject malformed package-size reports")
    } catch OliphauntError.engine(let message) {
        #expect(message.contains("invalid bytes value"))
    }
}

@Test
func runtimeResourcesRejectMissingExtension() throws {
    let fixture = try makeRuntimeResourceFixture()
    defer {
        try? FileManager.default.removeItem(at: fixture.root)
    }
    let resources = OliphauntRuntimeResources(
        resourceRoot: fixture.resourceRoot,
        cacheRoot: fixture.cacheRoot
    )

    do {
        _ = try resources.materializeRuntime(requestedExtensions: ["postgis"])
        Issue.record("runtime resources should reject extensions absent from the manifest")
    } catch OliphauntError.engine(let message) {
        #expect(message.contains("does not contain requested extension"))
    }
}

@Test
func runtimeResourcesUseSelectedDomainForModuleOnlyProducts() throws {
    let fixture = try makeRuntimeResourceFixture()
    defer {
        try? FileManager.default.removeItem(at: fixture.root)
    }
    try writeText(
        fixture.resourceRoot.appendingPathComponent("runtime/manifest.properties"),
        """
        schema=oliphaunt-runtime-resources-v1
        layout=postgres-runtime-files-v1
        cacheKey=test-runtime-module-only-v1
        selectedExtensions=auto_explain,vector
        extensions=vector
        runtimeFeatures=icu
        sharedPreloadLibraries=auto_explain
        mobileStaticRegistryState=complete
        mobileStaticRegistryRegistered=auto_explain,vector
        mobileStaticRegistryPending=
        nativeModuleStems=auto_explain,vector
        """
    )
    let resources = OliphauntRuntimeResources(
        resourceRoot: fixture.resourceRoot,
        cacheRoot: fixture.cacheRoot
    )

    #expect(try resources.hasPackagedResources(containing: ["auto_explain", "vector"]))
    let runtime = try resources.materializeRuntime(
        requestedExtensions: ["auto_explain", "vector"]
    )
    #expect(FileManager.default.fileExists(
        atPath: runtime.appendingPathComponent(
            "share/postgresql/extension/vector.control"
        ).path
    ))
    #expect(try resources.sharedPreloadLibraries(
        requestedExtensions: ["auto_explain"]
    ) == ["auto_explain"])
}

@Test
func runtimeResourcesRequireSelectedExtensions() throws {
    let fixture = try makeRuntimeResourceFixture()
    defer {
        try? FileManager.default.removeItem(at: fixture.root)
    }
    try writeText(
        fixture.resourceRoot.appendingPathComponent("runtime/manifest.properties"),
        """
        schema=oliphaunt-runtime-resources-v1
        layout=postgres-runtime-files-v1
        cacheKey=test-runtime-missing-selection-v1
        extensions=vector
        runtimeFeatures=icu
        sharedPreloadLibraries=
        mobileStaticRegistryState=complete
        mobileStaticRegistryRegistered=vector
        mobileStaticRegistryPending=
        nativeModuleStems=vector
        mobileStaticRegistrySource=static-registry/oliphaunt_static_registry.c
        """
    )
    let resources = OliphauntRuntimeResources(
        resourceRoot: fixture.resourceRoot,
        cacheRoot: fixture.cacheRoot
    )

    do {
        _ = try resources.materializeRuntime(requestedExtensions: ["vector"])
        Issue.record("runtime resources accepted a manifest without selectedExtensions")
    } catch {
        #expect(String(describing: error).contains("missing selectedExtensions"))
    }
}

@Test
func runtimeResourcesRejectCreateableExtensionsOutsideSelectedDomain() throws {
    let fixture = try makeRuntimeResourceFixture()
    defer {
        try? FileManager.default.removeItem(at: fixture.root)
    }
    try writeText(
        fixture.resourceRoot.appendingPathComponent("runtime/manifest.properties"),
        """
        schema=oliphaunt-runtime-resources-v1
        layout=postgres-runtime-files-v1
        cacheKey=test-runtime-invalid-domains-v1
        selectedExtensions=
        extensions=vector
        runtimeFeatures=
        sharedPreloadLibraries=
        mobileStaticRegistryState=not-required
        mobileStaticRegistryRegistered=
        mobileStaticRegistryPending=
        nativeModuleStems=
        """
    )
    let resources = OliphauntRuntimeResources(
        resourceRoot: fixture.resourceRoot,
        cacheRoot: fixture.cacheRoot
    )

    do {
        _ = try resources.materializeRuntime(requestedExtensions: ["auto_explain"])
        Issue.record("runtime resources accepted extensions outside selectedExtensions")
    } catch OliphauntError.engine(let message) {
        #expect(message.contains("extensions must be a subset of selectedExtensions"))
        #expect(message.contains("vector"))
    }
}

@Test
func runtimeResourcesRejectNativeExtensionsOutsideSelectedDomain() throws {
    let fixture = try makeRuntimeResourceFixture()
    defer {
        try? FileManager.default.removeItem(at: fixture.root)
    }
    try writeText(
        fixture.resourceRoot.appendingPathComponent("runtime/manifest.properties"),
        """
        schema=oliphaunt-runtime-resources-v1
        layout=postgres-runtime-files-v1
        cacheKey=test-runtime-invalid-native-domain-v1
        selectedExtensions=vector
        extensions=vector
        runtimeFeatures=
        sharedPreloadLibraries=
        mobileStaticRegistryState=complete
        mobileStaticRegistryRegistered=auto_explain,vector
        mobileStaticRegistryPending=
        nativeModuleStems=auto_explain,vector
        """
    )
    let resources = OliphauntRuntimeResources(
        resourceRoot: fixture.resourceRoot,
        cacheRoot: fixture.cacheRoot
    )

    do {
        _ = try resources.materializeRuntime(requestedExtensions: ["vector"])
        Issue.record("runtime resources accepted native extensions outside selectedExtensions")
    } catch OliphauntError.engine(let message) {
        #expect(message.contains("outside selectedExtensions"))
        #expect(message.contains("auto_explain"))
    }
}

@Test
func runtimeResourcesRejectDeclaredExtensionMissingControlFile() throws {
    let fixture = try makeRuntimeResourceFixture()
    defer {
        try? FileManager.default.removeItem(at: fixture.root)
    }
    try FileManager.default.removeItem(
        at: fixture.resourceRoot
            .appendingPathComponent("runtime/files/share/postgresql/extension/vector.control")
    )
    let resources = OliphauntRuntimeResources(
        resourceRoot: fixture.resourceRoot,
        cacheRoot: fixture.cacheRoot
    )

    do {
        _ = try resources.materializeRuntime(requestedExtensions: ["vector"])
        Issue.record("runtime resources should reject declared extensions missing control files")
    } catch OliphauntError.engine(let message) {
        #expect(message.contains("declare extension vector"))
        #expect(message.contains("missing vector.control"))
    }
}

@Test
func runtimeResourcesRejectDeclaredExtensionMissingInstallScript() throws {
    let fixture = try makeRuntimeResourceFixture()
    defer {
        try? FileManager.default.removeItem(at: fixture.root)
    }
    try FileManager.default.removeItem(
        at: fixture.resourceRoot
            .appendingPathComponent("runtime/files/share/postgresql/extension/vector--1.0.sql")
    )
    let resources = OliphauntRuntimeResources(
        resourceRoot: fixture.resourceRoot,
        cacheRoot: fixture.cacheRoot
    )

    do {
        _ = try resources.materializeRuntime(requestedExtensions: ["vector"])
        Issue.record("runtime resources should reject declared extensions missing install scripts")
    } catch OliphauntError.engine(let message) {
        #expect(message.contains("declare extension vector"))
        #expect(message.contains("missing vector--*.sql"))
    }
}

@Test
func runtimeResourcesRejectMalformedSharedPreloadLibraryMetadata() throws {
    let fixture = try makeRuntimeResourceFixture()
    defer {
        try? FileManager.default.removeItem(at: fixture.root)
    }
    try writeText(
        fixture.resourceRoot.appendingPathComponent("runtime/manifest.properties"),
        """
        schema=oliphaunt-runtime-resources-v1
        layout=postgres-runtime-files-v1
        cacheKey=test-runtime-v1
        selectedExtensions=vector
        extensions=vector
        sharedPreloadLibraries=pg search
        mobileStaticRegistryState=complete
        mobileStaticRegistryRegistered=vector
        mobileStaticRegistryPending=
        nativeModuleStems=vector
        """
    )
    let resources = OliphauntRuntimeResources(
        resourceRoot: fixture.resourceRoot,
        cacheRoot: fixture.cacheRoot
    )

    do {
        _ = try resources.materializeRuntime(requestedExtensions: ["vector"])
        Issue.record("runtime resources should reject malformed shared preload library metadata")
    } catch OliphauntError.engine(let message) {
        #expect(message.contains("shared preload library"))
    }
}

@Test
func runtimeResourcesRejectUnsupportedRuntimeFeatures() throws {
    let fixture = try makeRuntimeResourceFixture()
    defer {
        try? FileManager.default.removeItem(at: fixture.root)
    }
    try writeText(
        fixture.resourceRoot.appendingPathComponent("runtime/manifest.properties"),
        """
        schema=oliphaunt-runtime-resources-v1
        layout=postgres-runtime-files-v1
        cacheKey=test-runtime-v1
        extensions=vector
        runtimeFeatures=jit
        sharedPreloadLibraries=
        mobileStaticRegistryState=complete
        mobileStaticRegistryRegistered=vector
        mobileStaticRegistryPending=
        nativeModuleStems=vector
        """
    )
    let resources = OliphauntRuntimeResources(
        resourceRoot: fixture.resourceRoot,
        cacheRoot: fixture.cacheRoot
    )

    do {
        _ = try resources.materializeRuntime(requestedExtensions: ["vector"])
        Issue.record("runtime resources should reject unsupported runtime features")
    } catch OliphauntError.engine(let message) {
        #expect(message.contains("runtime feature(s) jit are not supported"))
    }
}

@Test
func runtimeResourcesRejectUnsupportedSchema() throws {
    let fixture = try makeRuntimeResourceFixture()
    defer {
        try? FileManager.default.removeItem(at: fixture.root)
    }
    try writeText(
        fixture.resourceRoot.appendingPathComponent("runtime/manifest.properties"),
        """
        schema=oliphaunt-runtime-resources-v0
        layout=postgres-runtime-files-v1
        cacheKey=test-runtime-v1
        extensions=vector
        mobileStaticRegistryState=complete
        mobileStaticRegistryRegistered=
        mobileStaticRegistryPending=
        nativeModuleStems=
        """
    )
    let resources = OliphauntRuntimeResources(
        resourceRoot: fixture.resourceRoot,
        cacheRoot: fixture.cacheRoot
    )

    do {
        _ = try resources.materializeRuntime(requestedExtensions: ["vector"])
        Issue.record("runtime resources should reject stale runtime-resource schemas")
    } catch OliphauntError.engine(let message) {
        #expect(message.contains("unsupported runtime resource schema"))
    }
}

@Test
func runtimeResourcesRejectUnsupportedPackageKindLayout() throws {
    let fixture = try makeRuntimeResourceFixture()
    defer {
        try? FileManager.default.removeItem(at: fixture.root)
    }
    try writeText(
        fixture.resourceRoot.appendingPathComponent("template-pgdata/manifest.properties"),
        """
        schema=oliphaunt-runtime-resources-v1
        layout=postgres-runtime-files-v1
        cacheKey=test-template-v1
        extensions=
        mobileStaticRegistryState=not-required
        mobileStaticRegistryRegistered=
        mobileStaticRegistryPending=
        nativeModuleStems=
        """
    )
    let resources = OliphauntRuntimeResources(
        resourceRoot: fixture.resourceRoot,
        cacheRoot: fixture.cacheRoot
    )
    let pgdata = fixture.root.appendingPathComponent("app-root/pgdata", isDirectory: true)

    do {
        _ = try resources.preparePgdata(at: pgdata)
        Issue.record("runtime resources should reject manifests with the wrong package-kind layout")
    } catch OliphauntError.engine(let message) {
        #expect(message.contains("unsupported layout"))
    }
}

@Test
func runtimeResourcesRejectMissingMobileStaticRegistryState() throws {
    let fixture = try makeRuntimeResourceFixture()
    defer {
        try? FileManager.default.removeItem(at: fixture.root)
    }
    try writeText(
        fixture.resourceRoot.appendingPathComponent("runtime/manifest.properties"),
        """
        schema=oliphaunt-runtime-resources-v1
        layout=postgres-runtime-files-v1
        cacheKey=test-runtime-v1
        extensions=
        mobileStaticRegistryRegistered=
        mobileStaticRegistryPending=
        nativeModuleStems=
        """
    )
    let resources = OliphauntRuntimeResources(
        resourceRoot: fixture.resourceRoot,
        cacheRoot: fixture.cacheRoot
    )

    do {
        _ = try resources.materializeRuntime()
        Issue.record("runtime resources should reject v1 manifests without mobileStaticRegistryState")
    } catch OliphauntError.engine(let message) {
        #expect(message.contains("omits mobileStaticRegistryState"))
    }
}

@Test
func runtimeResourcesRejectInconsistentCompleteMobileStaticRegistry() throws {
    let fixture = try makeRuntimeResourceFixture()
    defer {
        try? FileManager.default.removeItem(at: fixture.root)
    }
    try writeText(
        fixture.resourceRoot.appendingPathComponent("runtime/manifest.properties"),
        """
        schema=oliphaunt-runtime-resources-v1
        layout=postgres-runtime-files-v1
        cacheKey=test-runtime-v1
        extensions=vector
        mobileStaticRegistryState=complete
        mobileStaticRegistryRegistered=vector
        mobileStaticRegistryPending=vector
        nativeModuleStems=vector
        """
    )
    let resources = OliphauntRuntimeResources(
        resourceRoot: fixture.resourceRoot,
        cacheRoot: fixture.cacheRoot
    )

    do {
        _ = try resources.materializeRuntime(requestedExtensions: ["vector"])
        Issue.record("runtime resources should reject conflicting complete mobile registry metadata")
    } catch OliphauntError.engine(let message) {
        #expect(message.contains("registered and pending"))
    }
}

@Test
func runtimeResourcesRejectNotRequiredMobileStaticRegistryWithModules() throws {
    let fixture = try makeRuntimeResourceFixture()
    defer {
        try? FileManager.default.removeItem(at: fixture.root)
    }
    try writeText(
        fixture.resourceRoot.appendingPathComponent("runtime/manifest.properties"),
        """
        schema=oliphaunt-runtime-resources-v1
        layout=postgres-runtime-files-v1
        cacheKey=test-runtime-v1
        extensions=
        mobileStaticRegistryState=not-required
        mobileStaticRegistryRegistered=
        mobileStaticRegistryPending=
        nativeModuleStems=vector
        """
    )
    let resources = OliphauntRuntimeResources(
        resourceRoot: fixture.resourceRoot,
        cacheRoot: fixture.cacheRoot
    )

    do {
        _ = try resources.materializeRuntime()
        Issue.record("runtime resources should reject not-required mobile registry metadata that lists modules")
    } catch OliphauntError.engine(let message) {
        #expect(message.contains("not-required"))
    }
}

@Test
func nativeDirectCanUsePackagedRuntimeResourcesBeforeLibraryLoad() async throws {
    let fixture = try makeRuntimeResourceFixture()
    defer {
        try? FileManager.default.removeItem(at: fixture.root)
    }
    let resources = OliphauntRuntimeResources(
        resourceRoot: fixture.resourceRoot,
        cacheRoot: fixture.cacheRoot
    )
    let databaseDirectory = fixture.root.appendingPathComponent("database-directory", isDirectory: true)
    let engine = OliphauntNativeDirectEngine(
        libraryURL: URL(fileURLWithPath: "/tmp/oliphaunt-swift-missing.dylib"),
        runtimeResources: resources
    )

    do {
        _ = try await OliphauntDatabase.open(
            configuration: OliphauntConfiguration(
                mode: .nativeDirect,
                storage: .directory(databaseDirectory),
                extensions: ["vector"]
            ),
            engine: engine
        )
        Issue.record("missing liboliphaunt should fail after packaged resources are materialized")
    } catch OliphauntError.engine(let message) {
        #expect(message.contains("failed to load liboliphaunt"))
    }

    #expect(FileManager.default.fileExists(
        atPath: fixture.cacheRoot
            .appendingPathComponent("runtime/test-runtime-v1/share/postgresql/README.liboliphaunt-smoke")
            .path
    ))
    #expect(FileManager.default.fileExists(
        atPath: databaseDirectory.appendingPathComponent("pgdata/PG_VERSION").path
    ))
}

@Test
func nativeDirectEngineExecutesAgainstLinkedLiboliphauntWhenAvailable() async throws {
    let environment = ProcessInfo.processInfo.environment
    guard
        let library = environment["LIBOLIPHAUNT_PATH"],
        let runtime = environment["OLIPHAUNT_INSTALL_DIR"]
    else {
        return
    }

    let engine = OliphauntNativeDirectEngine(
        libraryURL: URL(fileURLWithPath: library),
        runtimeDirectory: URL(fileURLWithPath: runtime)
    )
    // liboliphaunt-doc-example:swift-open-exec-close
    let database = try await OliphauntDatabase.open(
        configuration: OliphauntConfiguration(mode: .nativeDirect, durability: .fastDev),
        engine: engine
    )

    let capabilities = try await database.capabilities()
    #expect(capabilities.protocolRaw)
    #expect(capabilities.protocolStream)
    #expect(capabilities.queryCancel)
    #expect(capabilities.backupRestore)
    #expect(capabilities.simpleQuery)
    #expect(!capabilities.multipleInstances)
    #expect(capabilities.sameInstanceLogicalReopen)
    #expect(!capabilities.instanceSwitchable)
    #expect(!capabilities.crashRestartable)

    let response = try await database.execProtocolRaw(try OliphauntProtocol.simpleQuery("SELECT 1 AS value"))
    #expect(response.contains(0x54))
    #expect(response.contains(0x44))
    #expect(response.contains(0x5A))

    // liboliphaunt-doc-example:swift-streaming
    let stream = DataChunkAccumulator()
    try await database.execProtocolStream(try OliphauntProtocol.simpleQuery("SELECT 1 AS streamed_value")) { chunk in
        stream.append(chunk)
    }
    let streamBytes = stream.joined()
    #expect(streamBytes.contains(0x54))
    #expect(streamBytes.contains(0x44))
    #expect(streamBytes.contains(0x5A))

    // liboliphaunt-doc-example:swift-typed-query
    let typed = try await database.query("SELECT 1::text AS value")
    #expect(try typed.getText(row: 0, column: "value") == "1")

    // liboliphaunt-doc-example:swift-parameterized-query
    let parameterized = try await database.query(
        "SELECT $1::text AS value",
        parameters: [.text("1")]
    )
    #expect(try parameterized.getText(row: 0, column: "value") == "1")

    let query = Task {
        try await database.execProtocolRaw(try OliphauntProtocol.simpleQuery("SELECT pg_sleep(5) AS should_cancel"))
    }
    try await Task.sleep(nanoseconds: 100_000_000)
    try await database.cancel()
    let cancelResponse = try await query.value
    #expect(cancelResponse.contains(0x45))
    #expect(cancelResponse.contains(0x5A))

    _ = try await database.execProtocolRaw(try OliphauntProtocol.simpleQuery(
        """
        CREATE TABLE IF NOT EXISTS swift_backup_smoke(value integer);
        TRUNCATE swift_backup_smoke;
        INSERT INTO swift_backup_smoke VALUES (42)
        """
    ))
    let archive = try await database.backup()
    #expect(archive.format == .physicalArchive)
    #expect(archive.bytes.range(of: Data("backup_label".utf8)) != nil)

    let restoreDestination = FileManager.default.temporaryDirectory
        .appendingPathComponent("liboliphaunt-swift-restore-\(UUID().uuidString)", isDirectory: true)
    defer {
        try? FileManager.default.removeItem(at: restoreDestination)
    }
    let restoredDestination = try await OliphauntDatabase.restore(
        OliphauntRestoreRequest(artifact: archive, destination: restoreDestination).replaceExisting(),
        engine: engine
    )
    #expect(restoredDestination == restoreDestination)
    #expect(FileManager.default.fileExists(
        atPath: restoreDestination.appendingPathComponent("pgdata/PG_VERSION").path
    ))
    #expect(FileManager.default.fileExists(
        atPath: restoreDestination.appendingPathComponent("pgdata/backup_label").path
    ))
    try await database.close()
}

private struct FixedSessionEngine: OliphauntEngine {
    let session: any OliphauntSession

    func open(configuration: OliphauntConfiguration) async throws -> any OliphauntSession {
        session
    }

    func restore(_ request: OliphauntRestoreRequest) async throws -> URL {
        request.destination
    }
}

private struct PostgresErrorSession: OliphauntSession {
    let failureSQL: String

    func capabilities() async -> OliphauntCapabilities {
        OliphauntCapabilities(
            mode: .nativeDirect,
            processIsolated: false,
            independentSessions: false,
            maxClientSessions: 1
        )
    }

    func execProtocolRaw(_ bytes: Data) async throws -> Data {
        if String(decoding: bytes, as: UTF8.self).contains(failureSQL) {
            return backendErrorResponse("ERROR", "23505", "duplicate key value")
        }
        return backendSelectResponse()
    }

    func backup(_ request: OliphauntBackupRequest) async throws -> OliphauntBackupArtifact {
        OliphauntBackupArtifact(format: request.format, bytes: Data())
    }

    func cancel() async throws {}

    func close() async throws {}
}

private func postgresErrorDatabase(failingOn sql: String) async throws -> OliphauntDatabase {
    try await OliphauntDatabase.open(
        configuration: OliphauntConfiguration(mode: .nativeDirect),
        engine: FixedSessionEngine(session: PostgresErrorSession(failureSQL: sql))
    )
}

private struct MockEngine: OliphauntEngine {
    let mode: OliphauntEngineMode
    let expectedRestoreDestinationPolicy: OliphauntRestoreDestinationPolicy?

    init(
        mode: OliphauntEngineMode,
        expectedRestoreDestinationPolicy: OliphauntRestoreDestinationPolicy? = nil
    ) {
        self.mode = mode
        self.expectedRestoreDestinationPolicy = expectedRestoreDestinationPolicy
    }

    func open(configuration: OliphauntConfiguration) async throws -> any OliphauntSession {
        #expect(configuration.mode == mode)
        return MockSession(mode: mode)
    }

    func restore(_ request: OliphauntRestoreRequest) async throws -> URL {
        #expect(request.artifact.format == .physicalArchive)
        if let expectedRestoreDestinationPolicy {
            #expect(request.destinationPolicy == expectedRestoreDestinationPolicy)
        }
        return request.destination
    }
}

private actor CountingEngine: OliphauntEngine {
    private var calls = 0
    private var restores = 0
    private var extensions: [String] = []
    private var runtimeFootprint: OliphauntRuntimeFootprintProfile?
    private var startupGUCs: [OliphauntStartupGUC] = []
    private var username: String?
    private var database: String?

    func open(configuration: OliphauntConfiguration) async throws -> any OliphauntSession {
        calls += 1
        extensions = configuration.extensions
        runtimeFootprint = configuration.runtimeFootprint
        startupGUCs = configuration.startupGUCs
        username = configuration.username
        database = configuration.database
        return MockSession(mode: configuration.mode)
    }

    func restore(_ request: OliphauntRestoreRequest) async throws -> URL {
        restores += 1
        return request.destination
    }

    func openCallCount() -> Int {
        calls
    }

    func restoreCallCount() -> Int {
        restores
    }

    func lastExtensions() -> [String] {
        extensions
    }

    func lastRuntimeFootprint() -> OliphauntRuntimeFootprintProfile? {
        runtimeFootprint
    }

    func lastStartupGUCs() -> [OliphauntStartupGUC] {
        startupGUCs
    }

    func lastUsername() -> String? {
        username
    }

    func lastDatabase() -> String? {
        database
    }
}

private actor MockSession: OliphauntSession {
    let mode: OliphauntEngineMode
    var calls = 0
    var requests: [Data] = []

    init(mode: OliphauntEngineMode) {
        self.mode = mode
    }

    func capabilities() async -> OliphauntCapabilities {
        switch mode {
        case .nativeDirect:
            return OliphauntCapabilities(
                mode: mode,
                processIsolated: false,
                independentSessions: false,
                maxClientSessions: 1
            )
        case .nativeBroker:
            return OliphauntCapabilities(
                mode: mode,
                processIsolated: true,
                independentSessions: false,
                maxClientSessions: 1
            )
        case .nativeServer:
            return OliphauntCapabilities(
                mode: mode,
                processIsolated: true,
                independentSessions: true,
                maxClientSessions: 32,
                backupFormats: [.sql, .physicalArchive],
                connectionString: "postgres://postgres@127.0.0.1:55432/template1"
            )
        }
    }

    func execProtocolRaw(_ bytes: Data) async throws -> Data {
        calls += 1
        requests.append(bytes)
        if bytes.count > 5, bytes.first == 0x51 || bytes.first == 0x50 {
            return backendSelectResponse()
        }
        return Data([UInt8(calls)]) + bytes
    }

    func requestTexts() -> [String] {
        requests.map { String(decoding: $0, as: UTF8.self) }
    }

    func backup(_ request: OliphauntBackupRequest) async throws -> OliphauntBackupArtifact {
        switch request.format {
        case .sql:
            return OliphauntBackupArtifact(format: .sql, bytes: Data("sql-backup".utf8))
        case .physicalArchive:
            return OliphauntBackupArtifact(format: .physicalArchive, bytes: Data("physical-backup".utf8))
        case .oliphauntArchive:
            throw OliphauntError.engine("oliphauntArchive is not available")
        }
    }

    func cancel() async throws {}

    func close() async throws {}
}

private actor FailOnceCloseSession: OliphauntSession {
    private var closeAttempts = 0

    func capabilities() async -> OliphauntCapabilities {
        OliphauntCapabilities(
            mode: .nativeDirect,
            processIsolated: false,
            independentSessions: false,
            maxClientSessions: 1
        )
    }

    func execProtocolRaw(_ bytes: Data) async throws -> Data {
        bytes
    }

    func backup(_ request: OliphauntBackupRequest) async throws -> OliphauntBackupArtifact {
        OliphauntBackupArtifact(format: request.format, bytes: Data())
    }

    func cancel() async throws {}

    func close() async throws {
        closeAttempts += 1
        if closeAttempts == 1 {
            throw OliphauntError.engine("injected detach failure")
        }
    }

    func closeAttemptCount() -> Int {
        closeAttempts
    }
}

private actor BlockingSession: OliphauntSession {
    let mode: OliphauntEngineMode
    private var started = false
    private var cancelled = false
    private var closed = false
    private var requests: [Data] = []
    private var startedContinuation: CheckedContinuation<Void, Never>?
    private var requestCountContinuations: [(minimum: Int, continuation: CheckedContinuation<Void, Never>)] = []
    private var unblockContinuations: [CheckedContinuation<Data, Never>] = []

    init(mode: OliphauntEngineMode) {
        self.mode = mode
    }

    func capabilities() async -> OliphauntCapabilities {
        OliphauntCapabilities(
            mode: mode,
            processIsolated: false,
            independentSessions: false,
            maxClientSessions: 1
        )
    }

    func execProtocolRaw(_ bytes: Data) async throws -> Data {
        requests.append(bytes)
        started = true
        startedContinuation?.resume()
        startedContinuation = nil
        resumeRequestCountWaiters()
        return await withCheckedContinuation { continuation in
            if cancelled {
                continuation.resume(returning: Data("cancelled".utf8))
            } else if closed {
                continuation.resume(returning: Data("closed".utf8))
            } else {
                unblockContinuations.append(continuation)
            }
        }
    }

    func backup(_ request: OliphauntBackupRequest) async throws -> OliphauntBackupArtifact {
        OliphauntBackupArtifact(format: request.format, bytes: Data())
    }

    func cancel() async throws {
        cancelled = true
        resumeAllExecutions(with: Data("cancelled".utf8))
    }

    func close() async throws {
        closed = true
        if !cancelled {
            resumeAllExecutions(with: Data("closed".utf8))
        }
    }

    func waitUntilStarted() async {
        if started {
            return
        }
        await withCheckedContinuation { continuation in
            startedContinuation = continuation
        }
    }

    func waitForRequestCount(_ count: Int) async {
        if requests.count >= count {
            return
        }
        await withCheckedContinuation { continuation in
            requestCountContinuations.append((minimum: count, continuation: continuation))
        }
    }

    func requestBytes() async -> [Data] {
        requests
    }

    func requestTexts() async -> [String] {
        requests.map { String(decoding: $0, as: UTF8.self) }
    }

    func releaseExecution(with data: Data) {
        guard !unblockContinuations.isEmpty else {
            return
        }
        unblockContinuations.removeFirst().resume(returning: data)
    }

    func wasCancelled() async -> Bool {
        cancelled
    }

    func wasClosed() async -> Bool {
        closed
    }

    private func resumeAllExecutions(with data: Data) {
        let continuations = unblockContinuations
        unblockContinuations.removeAll()
        for continuation in continuations {
            continuation.resume(returning: data)
        }
    }

    private func resumeRequestCountWaiters() {
        var remaining: [(minimum: Int, continuation: CheckedContinuation<Void, Never>)] = []
        for waiter in requestCountContinuations {
            if requests.count >= waiter.minimum {
                waiter.continuation.resume()
            } else {
                remaining.append(waiter)
            }
        }
        requestCountContinuations = remaining
    }
}

private final class DataChunkAccumulator: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [Data] = []

    func append(_ value: Data) {
        lock.lock()
        values.append(value)
        lock.unlock()
    }

    func chunks() -> [Data] {
        lock.lock()
        defer {
            lock.unlock()
        }
        return values
    }

    func joined() -> Data {
        lock.lock()
        defer {
            lock.unlock()
        }
        return values.reduce(into: Data()) { output, chunk in
            output.append(chunk)
        }
    }
}

private final class TransactionCapture: @unchecked Sendable {
    private let lock = NSLock()
    private var value: OliphauntTransaction?

    func store(_ transaction: OliphauntTransaction) {
        lock.lock()
        value = transaction
        lock.unlock()
    }

    func load() -> OliphauntTransaction? {
        lock.lock()
        defer {
            lock.unlock()
        }
        return value
    }
}

private func makeExistingDatabaseDirectory() throws -> URL {
    let directory = uniqueTempURL("liboliphaunt-swift-existing-database")
    try writeText(directory.appendingPathComponent("pgdata/PG_VERSION"), "18\n")
    return directory
}

private func makeRuntimeResourceFixture() throws -> (
    root: URL,
    resourceRoot: URL,
    cacheRoot: URL
) {
    return try makeRuntimeResourceFixture(sharedPreloadLibraries: "")
}

private func makeRuntimeResourceFixture(sharedPreloadLibraries: String) throws -> (
    root: URL,
    resourceRoot: URL,
    cacheRoot: URL
) {
    let root = uniqueTempURL("liboliphaunt-swift-resources")
    let resourceRoot = root.appendingPathComponent("resources/oliphaunt", isDirectory: true)
    let cacheRoot = root.appendingPathComponent("cache", isDirectory: true)

    try writeText(
        resourceRoot.appendingPathComponent("runtime/manifest.properties"),
        """
        schema=oliphaunt-runtime-resources-v1
        layout=postgres-runtime-files-v1
        cacheKey=test-runtime-v1
        selectedExtensions=vector
        extensions=vector
        runtimeFeatures=icu
        sharedPreloadLibraries=\(sharedPreloadLibraries)
        mobileStaticRegistryState=complete
        mobileStaticRegistryRegistered=vector
        mobileStaticRegistryPending=
        nativeModuleStems=vector
        """
    )
    try writeText(
        resourceRoot.appendingPathComponent("runtime/files/share/postgresql/README.liboliphaunt-smoke"),
        "runtime smoke\n"
    )
    try writeText(
        resourceRoot.appendingPathComponent("runtime/files/share/postgresql/extension/vector.control"),
        "comment = 'vector smoke control'\n"
    )
    try writeText(
        resourceRoot.appendingPathComponent("runtime/files/share/postgresql/extension/vector--1.0.sql"),
        "select 'vector smoke sql';\n"
    )
    try writeText(
        resourceRoot.appendingPathComponent("template-pgdata/manifest.properties"),
        """
        schema=oliphaunt-runtime-resources-v1
        layout=postgres-template-pgdata-v1
        cacheKey=test-template-v1
        selectedExtensions=
        extensions=
        runtimeFeatures=
        sharedPreloadLibraries=
        mobileStaticRegistryState=not-required
        mobileStaticRegistryRegistered=
        mobileStaticRegistryPending=
        nativeModuleStems=
        mobileStaticRegistrySource=
        """
    )
    try writeText(
        resourceRoot.appendingPathComponent("template-pgdata/files/PG_VERSION"),
        "18\n"
    )
    try writeText(
        resourceRoot.appendingPathComponent("package-size.tsv"),
        """
        kind\tid\textensions\tfiles\tbytes
        package\ttotal\t-\t-\t185
        package\truntime\t-\t-\t100
        package\ttemplate-pgdata\t-\t-\t40
        package\tstatic-registry\t-\t-\t45
        extensions\tselected\t-\t-\t30
        extension\tvector\t-\t3\t30
        """
    )

    return (root: root, resourceRoot: resourceRoot, cacheRoot: cacheRoot)
}

private func uniqueTempURL(_ prefix: String) -> URL {
    FileManager.default.temporaryDirectory
        .appendingPathComponent("\(prefix)-\(UUID().uuidString)", isDirectory: true)
}

private func writeText(_ url: URL, _ text: String) throws {
    try FileManager.default.createDirectory(
        at: url.deletingLastPathComponent(),
        withIntermediateDirectories: true
    )
    try text.write(to: url, atomically: true, encoding: .utf8)
}

private func posixPermissions(_ url: URL) throws -> Int {
    let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
    return try #require(attributes[.posixPermissions] as? Int)
}

private func backendSelectResponse() -> Data {
    var response = Data()
    appendRowDescription(&response, fields: [("value", UInt32(25)), ("empty", UInt32(25))])
    appendDataRow(&response, values: [Data("1".utf8), nil])
    appendCommandComplete(&response, "SELECT 1")
    appendReadyForQuery(&response)
    return response
}

private func backendErrorResponse(_ severity: String, _ sqlstate: String, _ message: String) -> Data {
    var body = Data()
    body.append(0x53)
    body.append(Data(severity.utf8))
    body.append(0)
    body.append(0x43)
    body.append(Data(sqlstate.utf8))
    body.append(0)
    body.append(0x4d)
    body.append(Data(message.utf8))
    body.append(0)
    body.append(0)
    var response = Data()
    appendBackendMessage(&response, tag: 0x45, body: body)
    appendReadyForQuery(&response)
    return response
}

private func appendRowDescription(
    _ response: inout Data,
    fields: [(name: String, typeOID: UInt32)]
) {
    appendRawRowDescription(
        &response,
        fields: fields.map { (Data($0.name.utf8), $0.typeOID) }
    )
}

private func appendRawRowDescription(
    _ response: inout Data,
    fields: [(name: Data, typeOID: UInt32)]
) {
    var body = Data()
    appendInt16(&body, Int16(fields.count))
    for field in fields {
        body.append(field.name)
        body.append(0)
        appendUInt32(&body, 0)
        appendInt16(&body, 0)
        appendUInt32(&body, field.typeOID)
        appendInt16(&body, -1)
        appendInt32(&body, -1)
        appendInt16(&body, 0)
    }
    appendBackendMessage(&response, tag: 0x54, body: body)
}

private func appendDataRow(_ response: inout Data, values: [Data?]) {
    var body = Data()
    appendInt16(&body, Int16(values.count))
    for value in values {
        guard let value else {
            appendInt32(&body, -1)
            continue
        }
        appendInt32(&body, Int32(value.count))
        body.append(value)
    }
    appendBackendMessage(&response, tag: 0x44, body: body)
}

private func appendCommandComplete(_ response: inout Data, _ tag: String) {
    var body = Data(tag.utf8)
    body.append(0)
    appendBackendMessage(&response, tag: 0x43, body: body)
}

private func appendNoticeResponse(
    _ response: inout Data,
    severity: String,
    message: String
) {
    var body = Data()
    body.append(0x53)
    body.append(Data(severity.utf8))
    body.append(0)
    body.append(0x4d)
    body.append(Data(message.utf8))
    body.append(0)
    body.append(0)
    appendBackendMessage(&response, tag: 0x4e, body: body)
}

private func appendParameterStatus(_ response: inout Data, name: String, value: String) {
    var body = Data(name.utf8)
    body.append(0)
    body.append(Data(value.utf8))
    body.append(0)
    appendBackendMessage(&response, tag: 0x53, body: body)
}

private func appendNotificationResponse(
    _ response: inout Data,
    pid: Int32,
    channel: String,
    payload: String
) {
    var body = Data()
    appendInt32(&body, pid)
    body.append(Data(channel.utf8))
    body.append(0)
    body.append(Data(payload.utf8))
    body.append(0)
    appendBackendMessage(&response, tag: 0x41, body: body)
}

private func appendReadyForQuery(_ response: inout Data, status: UInt8 = 0x49) {
    appendBackendMessage(&response, tag: 0x5a, body: Data([status]))
}

private func startupAssignments(_ args: [String]) -> [String] {
    var assignments: [String] = []
    var index = 0
    while index < args.count {
        precondition(args[index] == "-c", "unexpected startup flag \(args[index])")
        precondition(index + 1 < args.count, "missing startup assignment after -c")
        assignments.append(args[index + 1])
        index += 2
    }
    return assignments
}

private func appendBackendMessage(_ response: inout Data, tag: UInt8, body: Data) {
    response.append(tag)
    appendInt32(&response, Int32(body.count + 4))
    response.append(body)
}

private func appendUInt32(_ data: inout Data, _ value: UInt32) {
    data.append(UInt8((value >> 24) & 0xff))
    data.append(UInt8((value >> 16) & 0xff))
    data.append(UInt8((value >> 8) & 0xff))
    data.append(UInt8(value & 0xff))
}

private func appendInt32(_ data: inout Data, _ value: Int32) {
    appendUInt32(&data, UInt32(bitPattern: value))
}

private func appendInt16(_ data: inout Data, _ value: Int16) {
    let bits = UInt16(bitPattern: value)
    data.append(UInt8((bits >> 8) & 0xff))
    data.append(UInt8(bits & 0xff))
}
