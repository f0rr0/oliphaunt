import Foundation
@testable @_spi(ExtensionSupport) import Oliphaunt
import Testing

#if canImport(Darwin)
import Darwin
#elseif canImport(Glibc)
import Glibc
#endif

#if os(iOS) || os(macOS) || os(tvOS) || os(watchOS) || os(visionOS)
@Test
func discoversCocoaPodsRuntimeResourceBundlesBeforeTheyAreLoaded() throws {
    let root = FileManager.default.temporaryDirectory
        .appendingPathComponent("oliphaunt-swift-bundle-discovery-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: root) }

    let bundleRoot = root.appendingPathComponent("OliphauntReactNativeResources.bundle", isDirectory: true)
    let runtimeRoot = bundleRoot.appendingPathComponent("oliphaunt", isDirectory: true)
    try FileManager.default.createDirectory(at: runtimeRoot, withIntermediateDirectories: true)
    try Data(
        """
        <?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
        <plist version="1.0"><dict>
          <key>CFBundleIdentifier</key><string>dev.oliphaunt.test.resources</string>
          <key>CFBundleName</key><string>OliphauntReactNativeResources</string>
          <key>CFBundlePackageType</key><string>BNDL</string>
        </dict></plist>
        """.utf8
    ).write(to: bundleRoot.appendingPathComponent("Info.plist"))

    let urls = bundleResourceURLs([], discoveringChildBundlesAt: root)
    #expect(urls.map(\.standardizedFileURL).contains(bundleRoot.standardizedFileURL))
}
#endif

@Test
func runtimeCacheUsesApplicationDataNamespaceCasing() {
    let cacheRoot = OliphauntRuntimeResources.defaultCacheRoot()
    #expect(cacheRoot.lastPathComponent == "runtime-cache")
    #expect(cacheRoot.deletingLastPathComponent().lastPathComponent == "Oliphaunt")
}

// OLIPHAUNT_DOCS_SNIPPET swift-quickstart
// liboliphaunt-doc-example:swift-open-exec-close
// liboliphaunt-doc-example:swift-parameterized-query
// liboliphaunt-doc-example:swift-backup-restore

@Test
func executeReturnsPostgresCommandMetadata() async throws {
    let session = TestSession(response: commandResponse("UPDATE 3"))
    let database = try await OliphauntDatabase.open(engine: TestEngine(session: session))
    let result = try await database.execute("UPDATE widgets SET ready = true")
    #expect(result.commandTag == "UPDATE 3")
    #expect(result.rowCount == 3)
    #expect(await session.requests().first?.first == Character("P").asciiValue)
}

@Test
func executeUsesExtendedProtocolForParameters() async throws {
    let session = TestSession(response: commandResponse("INSERT 0 1"))
    let database = try await OliphauntDatabase.open(engine: TestEngine(session: session))
    let result = try await database.execute(
        "INSERT INTO widgets(value) VALUES ($1)",
        parameters: [.text("hello")]
    )
    #expect(result.rowCount == 1)
    let request = try #require(await session.requests().first)
    #expect(request.first == Character("P").asciiValue)
}

@Test
func executeRejectsRows() throws {
    #expect(throws: OliphauntError.self) {
        _ = try parseOliphauntCommandResponse(rowResponse(value: "1", commandTag: "SELECT 1"))
    }
}

@Test
func singleStatementParsersRequireSemanticCompletion() throws {
    let readyOnly = readyResponse()
    let controlsOnly = backendMessage(Character("1").asciiValue!, Data()) +
        backendMessage(Character("2").asciiValue!, Data()) +
        backendMessage(Character("n").asciiValue!, Data()) +
        readyResponse()

    for response in [readyOnly, controlsOnly] {
        #expect(throws: OliphauntError.self) {
            _ = try parseOliphauntCommandResponse(response)
        }
        #expect(throws: OliphauntError.self) {
            _ = try parseOliphauntQueryResponse(response)
        }
    }

    let exactEmpty = combineMessages(
        backendMessage(Character("1").asciiValue!, Data()),
        backendMessage(Character("2").asciiValue!, Data()),
        backendMessage(Character("n").asciiValue!, Data()),
        emptyQueryResponse(),
        readyResponse()
    )
    _ = try parseOliphauntCommandResponse(exactEmpty)
    _ = try parseOliphauntQueryResponse(exactEmpty)
}

@Test
func queryParserRejectsRowsAfterCompletion() {
    let response = combineMessages(
        backendMessage(Character("1").asciiValue!, Data()),
        backendMessage(Character("2").asciiValue!, Data()),
        rowDescription(),
        commandComplete("SELECT 0"),
        dataRow(valueBytes: Data("late".utf8)),
        readyResponse()
    )
    #expect(throws: OliphauntError.self) {
        _ = try parseOliphauntQueryResponse(response)
    }
}

@Test
func structuredParsersRejectInvalidExtendedOrdering() {
    let parse = backendMessage(Character("1").asciiValue!, Data())
    let bind = backendMessage(Character("2").asciiValue!, Data())
    let noData = backendMessage(Character("n").asciiValue!, Data())
    let close = backendMessage(Character("3").asciiValue!, Data())
    let command = commandComplete("SELECT 0")
    let completeCommand = combineMessages(parse, bind, noData, command)

    let commonCases = [
        combineMessages(bind, parse, noData, command, readyResponse()),
        combineMessages(parse, parse, bind, noData, command, readyResponse()),
        combineMessages(parse, bind, bind, noData, command, readyResponse()),
        combineMessages(parse, bind, command, readyResponse()),
        combineMessages(parse, bind, emptyQueryResponse(), readyResponse()),
        combineMessages(parse, bind, noData, close, command, readyResponse()),
        combineMessages(completeCommand, parse, readyResponse()),
        combineMessages(
            completeCommand,
            errorResponse(sqlstate: "22000", message: "late"),
            readyResponse()
        ),
    ]
    for response in commonCases {
        #expect(throws: OliphauntError.self) {
            _ = try parseOliphauntCommandResponse(response)
        }
        #expect(throws: OliphauntError.self) {
            _ = try parseOliphauntQueryResponse(response)
        }
    }

    let queryOnlyCases = [
        combineMessages(parse, bind, noData, rowDescription(), command, readyResponse()),
        combineMessages(parse, bind, rowDescription(), noData, command, readyResponse()),
    ]
    for response in queryOnlyCases {
        #expect(throws: OliphauntError.self) {
            _ = try parseOliphauntQueryResponse(response)
        }
    }
}

@Test
func describeParserRequiresOrderedParseMetadata() {
    let missingParse = parameterDescription([]) +
        backendMessage(Character("n").asciiValue!, Data()) +
        readyResponse()
    #expect(throws: OliphauntError.self) {
        _ = try parseOliphauntDescribeResponse(missingParse)
    }

    let parameterDescriptionAfterNoData =
        backendMessage(Character("1").asciiValue!, Data()) +
        backendMessage(Character("n").asciiValue!, Data()) +
        parameterDescription([]) +
        readyResponse()
    #expect(throws: OliphauntError.self) {
        _ = try parseOliphauntDescribeResponse(parameterDescriptionAfterNoData)
    }

    let completeDescription = combineMessages(
        backendMessage(Character("1").asciiValue!, Data()),
        parameterDescription([]),
        backendMessage(Character("n").asciiValue!, Data())
    )
    #expect(throws: OliphauntError.self) {
        _ = try parseOliphauntDescribeResponse(
            combineMessages(
                completeDescription,
                errorResponse(sqlstate: "22000", message: "late"),
                readyResponse()
            )
        )
    }
    #expect(throws: OliphauntError.self) {
        _ = try parseOliphauntDescribeResponse(
            combineMessages(
                backendMessage(Character("1").asciiValue!, Data()),
                parameterDescription([]),
                backendMessage(Character("3").asciiValue!, Data()),
                backendMessage(Character("n").asciiValue!, Data()),
                readyResponse()
            )
        )
    }
}

@Test
func queryUsesCommandTagRowCount() throws {
    let result = try parseOliphauntQueryResponse(rowResponse(value: "1", commandTag: "SELECT 7"))
    #expect(result.rows.count == 1)
    #expect(result.rowCount == 7)
    #expect(try result.getText(row: 0, column: "value") == "1")
}

@Test
func publicResultEqualityIgnoresInternalReadyStatus() {
    let command = OliphauntCommandResult(commandTag: "UPDATE 1", rowCount: 1)
    let transactionCommand = OliphauntCommandResult(
        commandTag: "UPDATE 1",
        rowCount: 1,
        notices: [],
        readyStatus: .transaction
    )
    #expect(command == transactionCommand)

    let query = OliphauntQueryResult(
        fields: [],
        rows: [],
        commandTag: "SELECT 0",
        rowCount: 0,
        notices: [],
        readyStatus: .idle
    )
    let transactionQuery = OliphauntQueryResult(
        fields: [],
        rows: [],
        commandTag: "SELECT 0",
        rowCount: 0,
        notices: [],
        readyStatus: .transaction
    )
    #expect(query == transactionQuery)

    let description = OliphauntQueryDescription(parameterTypes: [], fields: nil)
    let transactionDescription = OliphauntQueryDescription(
        parameterTypes: [],
        fields: nil,
        notices: [],
        readyStatus: .transaction
    )
    #expect(description == transactionDescription)

    let exec = OliphauntExecResult(statements: [.command(command)])
    let transactionExec = OliphauntExecResult(
        statements: [.command(transactionCommand)],
        notices: [],
        readyStatus: .transaction
    )
    #expect(exec == transactionExec)
}

@Test
func queryResultGetTextRejectsDuplicateColumnNames() throws {
    let response = backendMessage(Character("1").asciiValue!, Data()) +
        backendMessage(Character("2").asciiValue!, Data()) +
        rowDescription(names: ["value", "value"]) +
        dataRow(valueBytes: [Data("first".utf8), Data("second".utf8)]) +
        commandComplete("SELECT 1") +
        readyResponse()
    let result = try parseOliphauntQueryResponse(response)

    do {
        _ = try result.getText(row: 0, column: "value")
        Issue.record("getText should reject an ambiguous duplicate column name")
    } catch OliphauntError.engine(let message) {
        #expect(message.contains("multiple columns named"))
        #expect(message.contains("use a column index"))
    } catch {
        Issue.record("getText produced an unexpected duplicate-column error: \(error)")
    }
}

@Test
func queryParametersCarryExplicitPostgresTypeOids() throws {
    let request = try OliphauntProtocol.extendedQuery(
        "SELECT $1, $2, $3",
        parameters: [.int32(42), .typedNull(.uuid), .bytes(Data([0, 255]))]
    )
    #expect(try parseParameterTypeOids(request) == [.int4, .uuid, .bytea])
    #expect(OliphauntQueryParam.int32(42).bytes == Data("42".utf8))
    #expect(OliphauntQueryParam.typedNull(.uuid).bytes == nil)
    #expect(
        OliphauntQueryParam(typeOID: .uuid, format: .binary, bytes: nil).format == .text
    )
    #expect(OliphauntQueryParam.bytes(Data([1])).format == .binary)
    #expect(OliphauntPostgresOID.timetz.rawValue == 1_266)
    #expect(OliphauntPostgresOID.timetzArray.rawValue == 1_270)
}

@Test
func queryParametersRejectExplicitZeroOidButPreserveInference() throws {
    let inferred = try OliphauntProtocol.extendedQuery(
        "SELECT $1",
        parameters: [.text("inferred")]
    )
    #expect(try parseParameterTypeOids(inferred) == [OliphauntPostgresOID(0)])

    #expect(throws: OliphauntError.self) {
        _ = try OliphauntProtocol.extendedQuery(
            "SELECT $1",
            parameters: [.text("invalid", typeOID: OliphauntPostgresOID(0))]
        )
    }

    let described = try OliphauntProtocol.describeQuery(
        "SELECT $1",
        parameterTypes: [OliphauntPostgresOID(0)]
    )
    #expect(try parseParameterTypeOids(described) == [OliphauntPostgresOID(0)])
}

@Test
func queryRowsOfferRawBuiltInAndCustomOidAwareDecoding() throws {
    let result = try parseOliphauntQueryResponse(rowResponse(
        value: "-2147483648",
        commandTag: "SELECT 1",
        typeOID: .int4
    ))
    let row = try #require(result.rows.first)
    #expect(try row.raw(0) == Data("-2147483648".utf8))
    let value: Int32? = try row.value(at: 0)
    #expect(value == Int32.min)
    let stringValue: String? = try row.value(at: 0)
    #expect(stringValue == "-2147483648")

    let textResult = try parseOliphauntQueryResponse(rowResponse(
        value: "hello",
        commandTag: "SELECT 1",
        typeOID: .text
    ))
    let decoded: UppercaseText? = try textResult.rows[0].value(named: "value")
    #expect(decoded == UppercaseText(value: "HELLO"))
}

@Test
func timetzDecodesAsText() throws {
    let result = try parseOliphauntQueryResponse(rowResponse(
        value: "04:05:06.789-07:30",
        commandTag: "SELECT 1",
        typeOID: .timetz
    ))
    let value: String? = try result.rows[0].value(at: 0)
    #expect(value == "04:05:06.789-07:30")
}

@Test
func byteaDecoderPreservesTextAndBinaryBytes() throws {
    let textResult = try parseOliphauntQueryResponse(rowResponse(
        value: "\\x00ff5c",
        commandTag: "SELECT 1",
        typeOID: .bytea
    ))
    let textBytes: Data? = try textResult.rows[0].value(at: 0)
    #expect(textBytes == Data([0, 255, 92]))

    let binaryResult = try parseOliphauntQueryResponse(rowResponse(
        valueBytes: Data([0, 255, 92]),
        commandTag: "SELECT 1",
        typeOID: .bytea,
        format: 1
    ))
    let binaryBytes: Data? = try binaryResult.rows[0].value(at: 0)
    #expect(binaryBytes == Data([0, 255, 92]))
}

@Test
func queryPreservesStructuredNotices() throws {
    let response = noticeResponse(severity: "NOTICE", message: "using fallback") +
        commandResponse("UPDATE 0")
    let result = try parseOliphauntCommandResponse(response)
    #expect(result.notices.count == 1)
    #expect(result.notices[0].severity == "NOTICE")
    #expect(result.notices[0].message == "using fallback")
}

@Test
func execReturnsOrderedStatementsAndOperationNotices() async throws {
    let response = noticeResponse(severity: "NOTICE", message: "created") +
        commandComplete("CREATE TABLE") +
        noticeResponse(severity: "NOTICE", message: "selected") +
        rowResultMessages(valueBytes: Data("1".utf8), typeOID: .text) +
        commandComplete("SELECT 1") +
        emptyQueryResponse() +
        emptyQueryResponse() +
        readyResponse()
    let database = try await OliphauntDatabase.open(
        engine: TestEngine(session: TestSession(response: response))
    )
    let result = try await database.exec("CREATE TABLE t(); SELECT '1';;")
    let command = try requireCommandStatement(result.statements[0])
    let rows = try requireRowsStatement(result.statements[1])
    #expect(command.commandTag == "CREATE TABLE")
    #expect(command.notices.map(\.message) == ["created"])
    #expect(rows.commandTag == "SELECT 1")
    #expect(try rows.rows[0].text(0) == "1")
    #expect(rows.notices.map(\.message) == ["selected"])
    #expect(result.notices.map(\.message) == ["created", "selected"])

    for tag in ["1", "2", "3", "n"] {
        let controlOnly = backendMessage(Character(tag).asciiValue!, Data()) + readyResponse()
        #expect(throws: OliphauntError.self) {
            _ = try parseOliphauntExecResponse(controlOnly)
        }
    }
    #expect(throws: OliphauntError.self) {
        _ = try parseOliphauntExecResponse(readyResponse())
    }
    #expect(throws: OliphauntError.self) {
        _ = try parseOliphauntExecResponse(
            combineMessages(
                rowDescription(),
                dataRow(valueBytes: Data("pending".utf8)),
                emptyQueryResponse(),
                commandComplete("SELECT 1"),
                readyResponse()
            )
        )
    }
}

@Test
func describeReturnsParameterAndOptionalRowMetadata() async throws {
    let response = backendMessage(Character("1").asciiValue!, Data()) +
        parameterDescription([.int4]) +
        rowDescription(name: "value", typeOID: .text) +
        readyResponse()
    let database = try await OliphauntDatabase.open(
        engine: TestEngine(session: TestSession(response: response))
    )
    let description = try await database.describe("SELECT $1::int4::text")
    #expect(description.parameterTypes == [.int4])
    #expect(description.fields?.map(\.name) == ["value"])

    let noData = try parseOliphauntDescribeResponse(
        backendMessage(Character("1").asciiValue!, Data()) +
            parameterDescription([]) +
            backendMessage(Character("n").asciiValue!, Data()) +
            readyResponse()
    )
    #expect(noData.fields == nil)
}

@Test
func typedDatabaseOperationRecoversAnEscapedTransactionBeforeReturning() async throws {
    let session = TestSession(response: commandResponse("BEGIN", status: "T"))
    let database = try await OliphauntDatabase.open(engine: TestEngine(session: session))
    await #expect(throws: OliphauntError.self) {
        _ = try await database.execute("BEGIN")
    }
    #expect(await session.simpleQueries() == ["ROLLBACK"])
}

@Test
func structuredCopyIsRejectedBeforeSessionDispatch() async throws {
    let session = TestSession(response: commandResponse("OK"))
    let database = try await OliphauntDatabase.open(engine: TestEngine(session: session))
    await #expect(throws: OliphauntError.self) {
        _ = try await database.exec("SELECT 1; COPY items TO STDOUT")
    }
    await #expect(throws: OliphauntError.self) {
        _ = try await database.execute("/* outer /* nested */ */ COPY items FROM STDIN")
    }
    #expect(await session.requests().isEmpty)
}

@Test
func transactionChainIsRejectedBeforeSessionDispatch() async throws {
    let session = TestSession(response: commandResponse("OK"))
    let database = try await OliphauntDatabase.open(engine: TestEngine(session: session))

    try await database.transaction { transaction in
        let requestCount = await session.requests().count
        await #expect(throws: OliphauntError.self) {
            _ = try await transaction.exec("ROLLBACK WORK /* keep ownership */ AND CHAIN")
        }
        #expect(await session.requests().count == requestCount)
    }

    #expect(await session.simpleQueries() == ["BEGIN", "COMMIT"])
}

@Test
func noticesAttachToPostgresErrors() throws {
    let response = noticeResponse(severity: "NOTICE", message: "before failure") +
        errorResponse(sqlstate: "22000", message: "bad query") + readyResponse()
    do {
        _ = try parseOliphauntCommandResponse(response)
        Issue.record("expected a PostgreSQL error")
    } catch OliphauntError.postgres(let error) {
        #expect(error.sqlstate == "22000")
        #expect(error.notices.map(\.message) == ["before failure"])
    }
}

@Test
func typedTransportFailurePoisonsDatabaseAndExpiresTransaction() async throws {
    let session = TestSession(response: commandResponse("OK"), failTyped: true)
    let database = try await OliphauntDatabase.open(engine: TestEngine(session: session))
    do {
        _ = try await database.execute("SELECT 1")
        Issue.record("typed transport should fail")
    } catch OliphauntError.engine(let message) {
        #expect(message.contains("typed transport failed"))
    }
    do {
        _ = try await database.execute("SELECT 2")
        Issue.record("database should be poisoned")
    } catch OliphauntError.engine(let message) {
        #expect(message.contains("outcome is unknown"))
    }

    let transactionSession = TestSession(response: commandResponse("OK"), failTyped: true)
    let transactionDatabase = try await OliphauntDatabase.open(
        engine: TestEngine(session: transactionSession)
    )
    await #expect(throws: OliphauntError.self) {
        _ = try await transactionDatabase.transaction { transaction in
            do {
                _ = try await transaction.execute("SELECT 1")
            } catch {
                // Returning must not COMMIT an operation with an unknown boundary.
            }
            return 1
        }
    }
    #expect(await transactionSession.simpleQueries() == ["BEGIN"])
}

@Test
func callbackAndIndependentDatabaseFailuresAreBothPreserved() async throws {
    struct Expected: Error, Sendable {}
    let callbackError = Expected()
    let session = TestSession(response: commandResponse("OK"), failTyped: true)
    let database = try await OliphauntDatabase.open(engine: TestEngine(session: session))

    do {
        _ = try await database.transaction { transaction -> Int in
            do {
                _ = try await transaction.execute("SELECT transport_failure")
            } catch {
                // Replace the independently poisoning transport failure with a
                // business error; the transaction boundary must retain both.
            }
            throw callbackError
        }
        Issue.record("transaction should retain callback and database failures")
    } catch let failure as OliphauntTransactionDatabaseError {
        #expect(failure.callbackError is Expected)
        if case OliphauntError.engine(let message) = failure.databaseError {
            #expect(message == "typed transport failed")
        } else {
            Issue.record("transaction should retain the typed transport failure")
        }
        #expect(failure.description.contains("independent database failure"))
    } catch {
        Issue.record("unexpected transaction failure: \(error)")
    }

    #expect(await session.simpleQueries() == ["BEGIN"])
    let requestCount = await session.requests().count
    await #expect(throws: OliphauntError.self) {
        _ = try await database.execute("SELECT never_runs")
    }
    #expect(await session.requests().count == requestCount)
    try await database.close()
}

@Test
func directlyPropagatedDatabaseFailureKeepsItsPublicErrorType() async throws {
    let session = TestSession(response: commandResponse("OK"), failTyped: true)
    let database = try await OliphauntDatabase.open(engine: TestEngine(session: session))

    do {
        _ = try await database.transaction { transaction in
            do {
                return try await transaction.execute("SELECT transport_failure")
            } catch {
                // Rethrowing the database failure must preserve its public
                // error type at the outer transaction boundary.
                throw error
            }
        }
        Issue.record("transaction should propagate its primary database failure")
    } catch OliphauntError.engine(let message) {
        #expect(message == "typed transport failed")
    } catch {
        Issue.record("directly propagated database failure changed type: \(error)")
    }
}

@Test
func callbackTypedCatchSeesPublicDatabaseError() async throws {
    let session = TestSession(response: commandResponse("OK"), failTyped: true)
    let database = try await OliphauntDatabase.open(engine: TestEngine(session: session))

    do {
        _ = try await database.transaction { transaction in
            do {
                return try await transaction.execute("SELECT transport_failure")
            } catch OliphauntError.engine(let message) {
                #expect(message == "typed transport failed")
                throw OliphauntError.engine(message)
            } catch {
                Issue.record("transaction operation hid its public error type: \(error)")
                throw error
            }
        }
        Issue.record("transaction should propagate its database failure")
    } catch OliphauntError.engine(let message) {
        #expect(message == "typed transport failed")
    } catch {
        Issue.record("callback-local typed catch changed the outer error type: \(error)")
    }
}

@Test
func missingTerminalReadyPoisonsTypedDatabase() async throws {
    let database = try await OliphauntDatabase.open(
        engine: TestEngine(session: TestSession(response: commandComplete("SELECT 1")))
    )
    await #expect(throws: OliphauntError.self) {
        _ = try await database.execute("SELECT 1")
    }
    do {
        _ = try await database.execute("SELECT 2")
        Issue.record("database should be poisoned after a missing ReadyForQuery")
    } catch OliphauntError.engine(let message) {
        #expect(message.contains("outcome is unknown"))
    }
}

@Test
func rollbackPublishesFinishingStateBeforeWaitingForProtocol() async throws {
    let session = SettlementBlockingSession(blockedControl: "ROLLBACK")
    let database = try await OliphauntDatabase.open(engine: TestEngine(session: session))
    _ = try await database.transaction { transaction in
        let rollback = Task { try await transaction.rollback() }
        await session.waitUntilBlockedControlStarted()
        await #expect(throws: OliphauntError.self) {
            _ = try await transaction.execute("SELECT 1")
        }
        await session.releaseBlockedControl()
        try await rollback.value
        return 1
    }
    #expect(await session.simpleQueries() == ["BEGIN", "ROLLBACK"])
}

@Test
func commitPublishesFinishingStateBeforeWaitingForProtocol() async throws {
    let session = SettlementBlockingSession(blockedControl: "COMMIT")
    let database = try await OliphauntDatabase.open(engine: TestEngine(session: session))
    let box = TransactionBox()
    let outer = Task {
        try await database.transaction { transaction in
            await box.store(transaction)
            return 1
        }
    }
    await session.waitUntilBlockedControlStarted()
    let transaction = try #require(await box.value())
    await #expect(throws: OliphauntError.self) {
        _ = try await transaction.execute("SELECT 1")
    }
    await session.releaseBlockedControl()
    #expect(try await outer.value == 1)
    #expect(await session.simpleQueries() == ["BEGIN", "COMMIT"])
}

@Test
func rollbackCutoffDrainsEarlierTransactionAdmissions() async throws {
    let session = AdmissionOrderSession()
    let database = try await OliphauntDatabase.open(engine: TestEngine(session: session))

    let value = try await database.transaction { transaction in
        let first = Task { try await transaction.execute("UPDATE records SET value = 1") }
        await session.waitUntilFirstRawStarted()
        let second = Task { try await transaction.execute("UPDATE records SET value = 2") }
        await database.waitUntilQueuedOperationCount(atLeast: 1)
        let rollback = Task { try await transaction.rollback() }
        await database.waitUntilQueuedOperationCount(atLeast: 2)

        await #expect(throws: OliphauntError.self) {
            _ = try await transaction.execute("UPDATE records SET value = 3")
        }
        await session.releaseFirstRaw()
        #expect(try await first.value.commandTag == "UPDATE 1")
        #expect(try await second.value.commandTag == "UPDATE 1")
        try await rollback.value
        return 7
    }

    #expect(value == 7)
    #expect(await session.events() == ["BEGIN", "typed:1", "typed:2", "ROLLBACK"])
}

@Test
func commitCutoffDrainsEarlierTransactionAdmissions() async throws {
    let session = AdmissionOrderSession()
    let database = try await OliphauntDatabase.open(engine: TestEngine(session: session))
    let box = TransactionBox()

    let outer = Task {
        try await database.transaction { transaction in
            Task { _ = try await transaction.execute("UPDATE records SET value = 1") }
            await session.waitUntilFirstRawStarted()
            Task { _ = try await transaction.execute("UPDATE records SET value = 2") }
            await database.waitUntilQueuedOperationCount(atLeast: 1)
            await box.store(transaction)
            return 7
        }
    }

    await database.waitUntilQueuedOperationCount(atLeast: 2)
    let transaction = try #require(await box.value())
    #expect(await transaction.isClosed)
    await #expect(throws: OliphauntError.self) {
        _ = try await transaction.execute("UPDATE records SET value = 3")
    }
    await session.releaseFirstRaw()
    #expect(try await outer.value == 7)
    #expect(await session.events() == ["BEGIN", "typed:1", "typed:2", "COMMIT"])
}

@Test
func postgresErrorUsesProtocolSeverityAndRetainsNonlocalizedSeverity() {
    let error = OliphauntPostgresError(fields: [
        .init(code: Character("S").asciiValue!, value: "ERROR"),
        .init(code: Character("V").asciiValue!, value: "ERREUR"),
        .init(code: Character("p").asciiValue!, value: "12"),
        .init(code: Character("q").asciiValue!, value: "SELECT bad"),
        .init(code: Character("F").asciiValue!, value: "parse.c"),
        .init(code: Character("L").asciiValue!, value: "42"),
        .init(code: Character("R").asciiValue!, value: "parse_query"),
        .init(code: Character("M").asciiValue!, value: "bad query"),
    ])
    #expect(error.severity == "ERROR")
    #expect(error.localizedSeverity == "ERROR")
    #expect(error.nonlocalizedSeverity == "ERREUR")
    #expect(error.internalPosition == "12")
    #expect(error.internalQuery == "SELECT bad")
    #expect(error.file == "parse.c")
    #expect(error.line == "42")
    #expect(error.routine == "parse_query")
}

@Test
func backupAndRestoreUsePhysicalBytesDirectly() async throws {
    let session = TestSession(response: commandResponse("CHECKPOINT"), backupBytes: Data([1, 2, 3]))
    let engine = TestEngine(session: session)
    let database = try await OliphauntDatabase.open(engine: engine)
    #expect(try await database.backup() == Data([1, 2, 3]))

    let destination = FileManager.default.temporaryDirectory
        .appendingPathComponent("oliphaunt-swift-restore-\(UUID().uuidString)", isDirectory: true)
    try await OliphauntDatabase.restore(
        destination: destination,
        bytes: Data([4, 5]),
        engine: engine
    )
    #expect(engine.restoredDestination == destination)
    #expect(engine.restoredBytes == Data([4, 5]))
}

@Test
func rawProtocolStreamingForwardsOwnedChunks() async throws {
    let response = commandResponse("SELECT 1")
    let session = TestSession(response: response)
    let database = try await OliphauntDatabase.open(engine: TestEngine(session: session))
    let chunks = ChunkBox()
    try await database.execProtocolRawStream(Data([Character("Q").asciiValue!, 0, 0, 0, 5, 0])) {
        chunks.append($0)
    }
    #expect(chunks.snapshot() == [response])
}

@Test
func rawProtocolTransportFailurePoisonsDatabase() async throws {
    let session = TestSession(
        response: commandResponse("OK"),
        failRawRequest: Data([1])
    )
    let database = try await OliphauntDatabase.open(engine: TestEngine(session: session))

    do {
        _ = try await database.execProtocolRaw(Data([1]))
        Issue.record("raw protocol transport failure should reject")
    } catch OliphauntError.engine(let message) {
        #expect(message == "raw transport failed")
    }
    await #expect(throws: OliphauntError.self) {
        _ = try await database.execProtocolRaw(Data([2]))
    }
    #expect(await session.requests().count == 1)
}

@Test
func rawProtocolStreamTransportFailurePoisonsDatabase() async throws {
    let session = TestSession(
        response: commandResponse("OK"),
        failRawRequest: Data([1])
    )
    let database = try await OliphauntDatabase.open(engine: TestEngine(session: session))

    do {
        try await database.execProtocolRawStream(Data([1])) { _ in }
        Issue.record("raw protocol stream transport failure should reject")
    } catch OliphauntError.engine(let message) {
        #expect(message == "raw transport failed")
    }
    await #expect(throws: OliphauntError.self) {
        _ = try await database.execProtocolRaw(Data([2]))
    }
    #expect(await session.requests().count == 1)
}

@Test
func rawProtocolStreamRecoveryFailureWinsOverCallbackAndPoisonsDatabase() async throws {
    struct CallbackFailure: Error {}
    let session = TestSession(
        response: commandResponse("OK"),
        failStreamAfterCallback: true
    )
    let database = try await OliphauntDatabase.open(engine: TestEngine(session: session))

    do {
        try await database.execProtocolRawStream(Data([1])) { _ in throw CallbackFailure() }
        Issue.record("stream recovery failure should reject")
    } catch OliphauntError.engine(let message) {
        #expect(message == "stream recovery failed")
    } catch {
        Issue.record("stream recovery failure must be authoritative: \(error)")
    }
    await #expect(throws: OliphauntError.self) {
        _ = try await database.execProtocolRaw(Data([2]))
    }
    #expect(await session.requests().count == 1)
}

@Test
func transactionCommitsAndPinsThePhysicalSession() async throws {
    let session = TestSession(response: commandResponse("OK"))
    let database = try await OliphauntDatabase.open(engine: TestEngine(session: session))
    let value = try await database.transaction { transaction in
        await #expect(throws: OliphauntError.self) {
            _ = try await database.execute("SELECT 1")
        }
        _ = try await transaction.execute("UPDATE widgets SET ready = true")
        return 42
    }
    #expect(value == 42)
    #expect(await session.simpleQueries() == ["BEGIN", "COMMIT"])
    #expect(await session.requests().contains { $0.first == Character("P").asciiValue })
}

@Test
func structuredTransactionOutcomeClassifierUsesExactTagsAndTerminalReady() throws {
    let forbidden = [
        "BEGIN",
        "START TRANSACTION",
        "COMMIT",
        "PREPARE TRANSACTION",
        "COMMIT PREPARED",
        "ROLLBACK PREPARED",
    ]
    for tag in forbidden {
        let outcome = try inspectOliphauntStructuredTransactionProtocolOutcome(
            simpleCommandResponse(tag, status: "T")
        )
        #expect(outcome.lifecycleCommandTag == tag)
        #expect(outcome.readyStatus == .transaction)
    }

    for tag in ["ROLLBACK", "SAVEPOINT", "RELEASE", "SET", "PREPARE", "CREATE FUNCTION", "CALL", "DO"] {
        let outcome = try inspectOliphauntStructuredTransactionProtocolOutcome(
            simpleCommandResponse(tag, status: "T")
        )
        #expect(outcome.lifecycleCommandTag == nil)
    }
    #expect(
        try inspectOliphauntStructuredTransactionProtocolOutcome(
            simpleCommandResponse("ROLLBACK", status: "E")
        ).lifecycleCommandTag == nil
    )
    #expect(throws: OliphauntError.self) {
        _ = try inspectOliphauntStructuredTransactionProtocolOutcome(
            simpleCommandResponse("SELECT 1", status: "T") + readyResponse(status: "T")
        )
    }
    #expect(throws: OliphauntError.self) {
        _ = try inspectOliphauntStructuredTransactionProtocolOutcome(
            backendMessage(Character("C").asciiValue!, Data("COMMIT".utf8)) + readyResponse(status: "T")
        )
    }
}

@Test
func everyStructuredTransactionOperationRejectsLifecycleCommandTagsAndSkipsSettlement() async throws {
    func verify(
        response: Data,
        operation: @escaping @Sendable (OliphauntTransaction) async throws -> Void
    ) async throws {
        let session = TestSession(response: response, preserveResponseStatus: true)
        let database = try await OliphauntDatabase.open(engine: TestEngine(session: session))
        do {
            try await database.transaction { transaction in
                try await operation(transaction)
            }
            Issue.record("transaction lifecycle command should reject")
        } catch OliphauntError.engine(let message) {
            #expect(message.contains("unsupported lifecycle command"))
        } catch {
            Issue.record("unexpected transaction lifecycle error: \(error)")
        }
        #expect(await session.simpleQueries().allSatisfy { $0 != "COMMIT" && $0 != "ROLLBACK" })
        let requestCount = await session.requests().count
        await #expect(throws: OliphauntError.self) {
            _ = try await database.execute("SELECT 1")
        }
        #expect(await session.requests().count == requestCount)
    }

    try await verify(response: commandResponse("BEGIN", status: "T")) { transaction in
        _ = try await transaction.execute("BEGIN")
    }
    try await verify(response: commandResponse("COMMIT", status: "T")) { transaction in
        _ = try await transaction.query("COMMIT")
    }
    try await verify(response: simpleCommandResponse("PREPARE TRANSACTION", status: "T")) { transaction in
        _ = try await transaction.exec("PREPARE TRANSACTION 'owned'")
    }
}

@Test
func lifecycleTagBeforeLaterPostgresErrorWinsAndLeavesDatabaseCloseOnly() async throws {
    let response = commandComplete("COMMIT") +
        errorResponse(sqlstate: "22000", message: "later failure") +
        readyResponse(status: "T")
    let session = TestSession(response: response, preserveResponseStatus: true)
    let database = try await OliphauntDatabase.open(engine: TestEngine(session: session))

    do {
        try await database.transaction { transaction in
            _ = try await transaction.exec("COMMIT; SELECT invalid")
        }
        Issue.record("lifecycle command followed by PostgreSQL error should reject")
    } catch OliphauntError.engine(let message) {
        #expect(message.contains("unsupported lifecycle command COMMIT"))
        #expect(message.contains("later failure"))
    } catch {
        Issue.record("lifecycle ownership error must win over later parser error: \(error)")
    }
    #expect(await session.simpleQueries().allSatisfy { $0 != "ROLLBACK" })
}

@Test
func transactionReadyStatusDistinguishesFullFromSavepointRollback() async throws {
    let escapedSession = TestSession(
        response: commandResponse("ROLLBACK"),
        preserveResponseStatus: true
    )
    let escapedDatabase = try await OliphauntDatabase.open(engine: TestEngine(session: escapedSession))
    do {
        try await escapedDatabase.transaction { transaction in
            _ = try await transaction.execute("ROLLBACK")
        }
        Issue.record("full transaction rollback should reject")
    } catch OliphauntError.engine(let message) {
        #expect(message.contains("left PostgreSQL idle"))
    }
    #expect(await escapedSession.simpleQueries().allSatisfy { $0 != "ROLLBACK" })

    let savepointSession = TestSession(response: commandResponse("ROLLBACK", status: "T"))
    let savepointDatabase = try await OliphauntDatabase.open(engine: TestEngine(session: savepointSession))
    let result = try await savepointDatabase.transaction { transaction in
        try await transaction.execute("ROLLBACK TO SAVEPOINT nested")
    }
    #expect(result.commandTag == "ROLLBACK")
    #expect(await savepointSession.simpleQueries() == ["BEGIN", "COMMIT"])
}

@Test
func transactionRollsBackOriginalFailure() async throws {
    struct Expected: Error {}
    let session = TestSession(response: commandResponse("OK"))
    let database = try await OliphauntDatabase.open(engine: TestEngine(session: session))
    await #expect(throws: Expected.self) {
        _ = try await database.transaction { _ -> Int in throw Expected() }
    }
    #expect(await session.simpleQueries() == ["BEGIN", "ROLLBACK"])
}

@Test
func cancellationObservedImmediatelyAfterBeginRollsBackWithoutInvokingCallback() async throws {
    let session = TestSession(response: commandResponse("UPDATE 1"), blockBegin: true)
    let database = try await OliphauntDatabase.open(engine: TestEngine(session: session))
    let transaction = Task {
        try await database.transaction { _ -> Int in
            Issue.record("a transaction canceled while BEGIN completes must not invoke its callback")
            return 1
        }
    }

    await session.waitUntilBeginStarted()
    transaction.cancel()
    await session.releaseBegin()

    await #expect(throws: CancellationError.self) {
        _ = try await transaction.value
    }
    #expect(await session.simpleQueries() == ["BEGIN", "ROLLBACK"])
    #expect(try await database.execute("UPDATE widgets SET ready = true").rowCount == 1)
}

@Test
func cancellationObservedAfterCallbackReturnRollsBackInsteadOfCommitting() async throws {
    let session = TestSession(response: commandResponse("UPDATE 1"))
    let database = try await OliphauntDatabase.open(engine: TestEngine(session: session))
    let transaction = Task {
        try await database.transaction { _ in
            withUnsafeCurrentTask { task in
                task?.cancel()
            }
            return 42
        }
    }

    await #expect(throws: CancellationError.self) {
        _ = try await transaction.value
    }
    #expect(await session.simpleQueries() == ["BEGIN", "ROLLBACK"])
    #expect(try await database.execute("UPDATE widgets SET ready = true").rowCount == 1)
}

@Test
func explicitRollbackRunsOnceExpiresTransactionAndSkipsCommit() async throws {
    let session = TestSession(response: commandResponse("UPDATE 1"))
    let database = try await OliphauntDatabase.open(engine: TestEngine(session: session))
    let value = try await database.transaction { transaction in
        #expect(!(await transaction.isClosed))
        try await transaction.rollback()
        #expect(await transaction.isClosed)
        await #expect(throws: OliphauntError.self) {
            try await transaction.rollback()
        }
        return 42
    }
    #expect(value == 42)
    #expect(await session.simpleQueries() == ["BEGIN", "ROLLBACK"])
}

@Test
func transactionWaitsForInFlightExplicitRollbackBeforeReturning() async throws {
    let session = SettlementBlockingSession(blockedControl: "ROLLBACK")
    let database = try await OliphauntDatabase.open(engine: TestEngine(session: session))
    let callbackReturned = AsyncStringSignal()
    let transactionFinished = AsyncStringSignal()

    let outer = Task {
        do {
            let result = try await database.transaction { transaction in
                _ = Task { try await transaction.rollback() }
                await session.waitUntilBlockedControlStarted()
                await callbackReturned.complete("returned")
                return 7
            }
            await transactionFinished.complete("success")
            return result
        } catch {
            await transactionFinished.complete("failure: \(error)")
            throw error
        }
    }

    _ = await callbackReturned.wait()
    await Task.yield()
    #expect(await transactionFinished.current() == nil)
    await session.releaseBlockedControl()
    #expect(try await outer.value == 7)
    #expect(await session.simpleQueries() == ["BEGIN", "ROLLBACK"])
    try await database.close()
}

@Test
func transactionWaitsForInFlightExplicitRollbackBeforeRethrowingCallbackFailure() async throws {
    struct Expected: Error {}

    let session = SettlementBlockingSession(blockedControl: "ROLLBACK")
    let database = try await OliphauntDatabase.open(engine: TestEngine(session: session))
    let callbackThrew = AsyncStringSignal()
    let transactionFinished = AsyncStringSignal()

    let outer = Task {
        do {
            let result = try await database.transaction { transaction -> Int in
                _ = Task { try await transaction.rollback() }
                await session.waitUntilBlockedControlStarted()
                await callbackThrew.complete("threw")
                throw Expected()
            }
            await transactionFinished.complete("success")
            return result
        } catch {
            await transactionFinished.complete("failure: \(error)")
            throw error
        }
    }

    _ = await callbackThrew.wait()
    await Task.yield()
    #expect(await transactionFinished.current() == nil)
    await session.releaseBlockedControl()
    await #expect(throws: Expected.self) {
        _ = try await outer.value
    }
    #expect(await session.simpleQueries() == ["BEGIN", "ROLLBACK"])
    try await database.close()
}

@Test
func callbackAndCompletedExplicitRollbackFailuresAreBothPreserved() async throws {
    struct Expected: Error {}

    let session = TestSession(response: commandResponse("UPDATE 1"), failRollback: true)
    let database = try await OliphauntDatabase.open(engine: TestEngine(session: session))

    do {
        _ = try await database.transaction { transaction -> Int in
            do {
                try await transaction.rollback()
            } catch {
                // The callback has its own independent failure after observing
                // the failed explicit settlement.
            }
            throw Expected()
        }
        Issue.record("transaction should retain callback and explicit rollback failures")
    } catch let failure as OliphauntTransactionRollbackError {
        #expect(failure.callbackError is Expected)
        #expect(String(describing: failure.rollbackError) == "rollback transport failed")
    } catch {
        Issue.record("unexpected explicit rollback composite error: \(error)")
    }

    #expect(await session.simpleQueries() == ["BEGIN", "ROLLBACK"])
    await #expect(throws: OliphauntError.self) {
        _ = try await database.execute("SELECT never_runs")
    }
    try await database.close()
}

@Test
func commitRequiresExactCommitTag() async throws {
    let session = TestSession(response: commandResponse("UPDATE 1"), commitTag: "ROLLBACK")
    let database = try await OliphauntDatabase.open(engine: TestEngine(session: session))
    await #expect(throws: OliphauntError.self) {
        _ = try await database.transaction { _ in 1 }
    }
    _ = try await database.execute("SELECT 1")
    #expect(await session.simpleQueries() == ["BEGIN", "COMMIT"])
}

@Test
func commitTransportFailureDoesNotRollbackAndPoisonsFacade() async throws {
    let session = TestSession(response: commandResponse("UPDATE 1"), failCommit: true)
    let database = try await OliphauntDatabase.open(engine: TestEngine(session: session))
    do {
        _ = try await database.transaction { _ in 1 }
        Issue.record("transaction should preserve the COMMIT transport error")
    } catch OliphauntError.engine(let message) {
        #expect(message.contains("commit transport failed"))
    }
    #expect(await session.simpleQueries() == ["BEGIN", "COMMIT"])
    await #expect(throws: OliphauntError.self) {
        _ = try await database.execute("SELECT 1")
    }
    try await database.close()
}

@Test
func beginFailureRecoveryFollowsReadyStatusAndLeavesConfirmedSessionsUsable() async throws {
    let cases: [(status: Character, expectedControls: [String])] = [
        ("I", ["BEGIN"]),
        ("T", ["BEGIN", "ROLLBACK"]),
        ("E", ["BEGIN", "ROLLBACK"]),
    ]

    for testCase in cases {
        let beginResponse = errorResponse(
            sqlstate: "0A000",
            message: "begin rejected"
        ) + readyResponse(status: testCase.status)
        let session = TestSession(
            response: commandResponse("UPDATE 1"),
            beginResponse: beginResponse
        )
        let database = try await OliphauntDatabase.open(engine: TestEngine(session: session))

        do {
            _ = try await database.transaction { _ in
                Issue.record("failed BEGIN must not invoke the transaction callback")
                return 1
            }
            Issue.record("failed BEGIN should reject")
        } catch OliphauntError.postgres(let error) {
            #expect(error.sqlstate == "0A000")
            #expect(error.message == "begin rejected")
        } catch {
            Issue.record("failed BEGIN lost its primary PostgreSQL error: \(error)")
        }

        #expect(await session.simpleQueries() == testCase.expectedControls)
        #expect(try await database.execute("UPDATE widgets SET ready = true").rowCount == 1)
    }
}

@Test
func beginFailureWithFailedRecoveryPreservesBothErrorsAndPoisonsFacade() async throws {
    let beginResponse = errorResponse(
        sqlstate: "0A000",
        message: "begin rejected"
    ) + readyResponse(status: "E")
    let session = TestSession(
        response: commandResponse("UPDATE 1"),
        failRollback: true,
        beginResponse: beginResponse
    )
    let database = try await OliphauntDatabase.open(engine: TestEngine(session: session))

    do {
        _ = try await database.transaction { _ in 1 }
        Issue.record("failed BEGIN recovery should reject")
    } catch OliphauntError.engine(let message) {
        #expect(message.contains("begin rejected"))
        #expect(message.contains("rollback transport failed"))
    } catch {
        Issue.record("unexpected failed BEGIN recovery error: \(error)")
    }
    #expect(await session.simpleQueries() == ["BEGIN", "ROLLBACK"])
    let requestCount = await session.requests().count
    await #expect(throws: OliphauntError.self) {
        _ = try await database.execute("SELECT never_runs")
    }
    #expect(await session.requests().count == requestCount)
}

@Test
func beginUnexpectedCommandTagWithTransactionalStatusIsRolledBack() async throws {
    let session = TestSession(
        response: commandResponse("UPDATE 1"),
        beginResponse: simpleCommandResponse("NOT BEGIN", status: "T")
    )
    let database = try await OliphauntDatabase.open(engine: TestEngine(session: session))

    do {
        _ = try await database.transaction { _ in 1 }
        Issue.record("unexpected BEGIN command tag should reject")
    } catch OliphauntError.engine(let message) {
        #expect(message.contains("unexpected command tag NOT BEGIN"))
    } catch {
        Issue.record("unexpected BEGIN command-tag error: \(error)")
    }
    #expect(await session.simpleQueries() == ["BEGIN", "ROLLBACK"])
    #expect(try await database.execute("UPDATE widgets SET ready = true").rowCount == 1)
}

@Test
func beginTransportFailureDoesNotAttemptBlindRollback() async throws {
    let session = TestSession(response: commandResponse("UPDATE 1"), failBegin: true)
    let database = try await OliphauntDatabase.open(engine: TestEngine(session: session))
    await #expect(throws: OliphauntError.self) {
        _ = try await database.transaction { _ in 1 }
    }
    #expect(await session.simpleQueries() == ["BEGIN"])
    await #expect(throws: OliphauntError.self) {
        _ = try await database.execute("SELECT 1")
    }
    try await database.close()
}

@Test
func beginWithoutTerminalReadyDoesNotAttemptBlindRollback() async throws {
    let session = TestSession(response: commandResponse("UPDATE 1"), omitBeginReady: true)
    let database = try await OliphauntDatabase.open(engine: TestEngine(session: session))
    await #expect(throws: OliphauntError.self) {
        _ = try await database.transaction { _ in 1 }
    }
    #expect(await session.simpleQueries() == ["BEGIN"])
    await #expect(throws: OliphauntError.self) {
        _ = try await database.execute("SELECT 1")
    }
    try await database.close()
}

@Test
func rollbackFailurePoisonsFacadeUntilClose() async throws {
    struct Expected: Error {}
    let session = TestSession(response: commandResponse("UPDATE 1"), failRollback: true)
    let database = try await OliphauntDatabase.open(engine: TestEngine(session: session))
    do {
        _ = try await database.transaction { _ -> Int in throw Expected() }
        Issue.record("transaction should report callback and rollback failures")
    } catch let failure as OliphauntTransactionRollbackError {
        #expect(failure.callbackError is Expected)
        if case OliphauntError.engine(let message) = failure.rollbackError {
            #expect(message == "rollback transport failed")
        } else {
            Issue.record("transaction should retain the rollback transport error")
        }
        #expect(failure.description.contains("automatic ROLLBACK did not complete"))
    } catch {
        Issue.record("unexpected transaction failure: \(error)")
    }
    #expect(await session.simpleQueries() == ["BEGIN", "ROLLBACK"])
    await #expect(throws: OliphauntError.self) {
        _ = try await database.execute("SELECT 1")
    }
    try await database.close()
}

@Test
func closeIsIdempotentAndRejectsFurtherWork() async throws {
    let session = TestSession(response: commandResponse("OK"))
    let database = try await OliphauntDatabase.open(engine: TestEngine(session: session))
    #expect(!(await database.isClosed))
    try await database.close()
    #expect(await database.isClosed)
    try await database.close()
    #expect(await session.closeCount() == 1)
    await #expect(throws: OliphauntError.self) {
        _ = try await database.execute("SELECT 1")
    }
}

@Test
func closeCutsOffLaterCallsButDrainsEveryEarlierAdmission() async throws {
    let session = AdmissionOrderSession()
    let database = try await OliphauntDatabase.open(engine: TestEngine(session: session))

    let first = Task { try await database.execProtocolRaw(Data([1])) }
    await session.waitUntilFirstRawStarted()
    let second = Task { try await database.execProtocolRaw(Data([2])) }
    await database.waitUntilQueuedOperationCount(atLeast: 1)
    let closing = Task { try await database.close() }
    await database.waitUntilQueuedOperationCount(atLeast: 2)

    await #expect(throws: OliphauntError.self) {
        _ = try await database.execProtocolRaw(Data([3]))
    }

    await session.releaseFirstRaw()
    #expect(try await first.value == Data([1]))
    #expect(try await second.value == Data([2]))
    try await closing.value
    #expect(await session.events() == ["raw:1", "raw:2", "close"])
}

@Test
func transactionPinningDoesNotRevokeEarlierAdmissions() async throws {
    let session = AdmissionOrderSession()
    let database = try await OliphauntDatabase.open(engine: TestEngine(session: session))

    let first = Task { try await database.execProtocolRaw(Data([1])) }
    await session.waitUntilFirstRawStarted()
    let second = Task { try await database.execProtocolRaw(Data([2])) }
    await database.waitUntilQueuedOperationCount(atLeast: 1)
    let transaction = Task {
        try await database.transaction { _ in 7 }
    }
    await database.waitUntilQueuedOperationCount(atLeast: 2)

    await #expect(throws: OliphauntError.self) {
        _ = try await database.execProtocolRaw(Data([3]))
    }

    await session.releaseFirstRaw()
    #expect(try await first.value == Data([1]))
    #expect(try await second.value == Data([2]))
    #expect(try await transaction.value == 7)
    #expect(await session.events() == ["raw:1", "raw:2", "BEGIN", "COMMIT"])
}

@Test
func cancellationCannotStrandCloseOwnership() async throws {
    let session = TestSession(response: commandResponse("OK"), blockClose: true)
    let database = try await OliphauntDatabase.open(engine: TestEngine(session: session))
    let closing = Task { try await database.close() }

    await session.awaitClose()
    closing.cancel()
    await session.releaseClose()
    try await closing.value

    #expect(await session.closeCount() == 1)
    #expect(await database.isClosed)
}

@Test
@MainActor
func nativeOwnerRunsAwayFromTheMainThread() async throws {
    let owner = OliphauntNativeOwner(label: "dev.oliphaunt.swift.tests.owner")
    let ranOnMainThread = try await owner.run { Thread.isMainThread }
    #expect(!ranOnMainThread)
}

@Test
func nativeStreamCompletionPreservesCallbackOnlyAfterConfirmedRecovery() {
    #expect(
        classifyOliphauntNativeStreamCompletion(result: 0, callbackFailed: false) == .success
    )
    #expect(
        classifyOliphauntNativeStreamCompletion(
            result: OliphauntNativeStreamCompletion.callbackAbortedResult,
            callbackFailed: true
        ) == .callbackAborted
    )
    #expect(
        classifyOliphauntNativeStreamCompletion(result: -1, callbackFailed: true) == .nativeFailure
    )
    #expect(
        classifyOliphauntNativeStreamCompletion(result: -1, callbackFailed: false) == .nativeFailure
    )
    #expect(
        classifyOliphauntNativeStreamCompletion(result: 0, callbackFailed: true) ==
            .protocolInconsistency
    )
    #expect(
        classifyOliphauntNativeStreamCompletion(
            result: OliphauntNativeStreamCompletion.callbackAbortedResult,
            callbackFailed: false
        ) == .protocolInconsistency
    )
    #expect(
        classifyOliphauntNativeStreamCompletion(result: 2, callbackFailed: true) ==
            .protocolInconsistency
    )
}

@Test
func rawStreamCallbackFailureRejectsAndReleasesTheSession() async throws {
    final class Expected: Error, @unchecked Sendable {}
    let session = TestSession(response: commandResponse("OK"))
    let database = try await OliphauntDatabase.open(engine: TestEngine(session: session))
    let expected = Expected()

    do {
        try await database.execProtocolRawStream(Data([1])) { _ in throw expected }
        Issue.record("raw stream callback failure should reject")
    } catch let error as Expected {
        #expect(error === expected)
    } catch {
        Issue.record("raw stream callback identity was not preserved: \(error)")
    }
    _ = try await database.execProtocolRaw(Data([2]))

    #expect(await session.requests().count == 2)
}

@Test
func rawStreamCallbackRejectsSameHandleReentryButAllowsCancellation() async throws {
    let session = TestSession(response: commandResponse("OK"))
    let database = try await OliphauntDatabase.open(engine: TestEngine(session: session))
    let outcomes = (0..<6).map { _ in AsyncStringSignal() }
    let cancellation = AsyncStringSignal()

    try await database.execProtocolRawStream(Data([1])) { _ in
        let forbidden: [@Sendable () async throws -> Void] = [
            { _ = try await database.execProtocolRaw(Data([2])) },
            { try await database.execProtocolRawStream(Data([3])) { _ in } },
            { _ = try await database.query("SELECT 1") },
            { _ = try await database.backup() },
            { _ = try await database.transaction { _ in () } },
            { try await database.close() },
        ]
        for (operation, outcome) in zip(forbidden, outcomes) {
            Task {
                do {
                    try await operation()
                    await outcome.complete("unexpected success")
                } catch {
                    await outcome.complete(String(describing: error))
                }
            }
        }
        Task {
            do {
                try await database.cancel()
                await cancellation.complete("success")
            } catch {
                await cancellation.complete(String(describing: error))
            }
        }
    }

    for outcome in outcomes {
        #expect(
            await outcome.wait().contains(
                "must not reenter the same Oliphaunt database or transaction"
            )
        )
    }
    #expect(await cancellation.wait() == "success")
    #expect(await session.cancelCount() == 1)
    #expect(await session.requests().count == 1)
    try await database.close()
}

@Test
func cancellationRemainsAvailableUntilCloseStartsNativeTeardown() async throws {
    let session = AdmissionOrderSession(blockClose: true)
    let database = try await OliphauntDatabase.open(engine: TestEngine(session: session))
    let first = Task { try await database.execProtocolRaw(Data([1])) }
    await session.waitUntilFirstRawStarted()
    let closing = Task { try await database.close() }

    try await database.cancel()
    #expect(await session.cancelCount() == 1)
    await session.releaseFirstRaw()
    _ = try await first.value
    await session.waitUntilCloseStarted()
    await #expect(throws: OliphauntError.self) {
        try await database.cancel()
    }

    await session.releaseClose()
    try await closing.value
    #expect(await session.events() == ["raw:1", "cancel", "close"])
}

@Test
func closeDrainsCancellationAdmittedBeforeNativeTeardown() async throws {
    let session = AdmissionOrderSession(blockCancel: true)
    let database = try await OliphauntDatabase.open(engine: TestEngine(session: session))
    let first = Task { try await database.execProtocolRaw(Data([1])) }
    await session.waitUntilFirstRawStarted()
    let closing = Task { try await database.close() }
    let cancellation = Task { try await database.cancel() }
    await session.waitUntilCancelStarted()

    await session.releaseFirstRaw()
    _ = try await first.value

    await session.releaseCancel()
    try await cancellation.value
    try await closing.value
    #expect(await session.events() == ["raw:1", "cancel:start", "cancel:end", "close"])
}

@Test
func configurationForwardsOnlyExplicitPostgresSettings() async throws {
    let session = TestSession(response: commandResponse("OK"))
    let engine = TestEngine(session: session)
    _ = try await OliphauntDatabase.open(
        configuration: OliphauntConfiguration(
            startupGUCs: [.init("shared_buffers", "16MB")],
            username: "alice",
            database: "app"
        ),
        engine: engine
    )
    let config = try #require(engine.openedConfiguration)
    #expect(config.username == "alice")
    #expect(config.database == "app")
    #expect(config.postgresStartupArgs() == ["-c", "shared_buffers=16MB"])
}

@Test
func freshRootAcceptsOnlyFixedBootstrapRole() throws {
    try requireOliphauntFreshRootRole("postgres")
    #expect(throws: OliphauntError.self) {
        try requireOliphauntFreshRootRole("alice")
    }
}

@Test
func startupGUCNamesUsePortablePostgresGrammar() async throws {
    try validateOliphauntStartupGUCs([
        .init("_name", ""),
        .init("ext.name$1", "on"),
    ])
    for name in ["1name", ".foo", "a..b", "a.1b", "ext.$name"] {
        #expect(throws: OliphauntError.self) {
            try validateOliphauntStartupGUCs([.init(name, "1")])
        }
    }
    #expect(throws: OliphauntError.self) {
        try validateOliphauntStartupGUCs([.init("good", "bad\0value")])
    }
    for name in ["CONFIG_FILE", "data_directory"] {
        #expect(throws: OliphauntError.self) {
            try validateOliphauntStartupGUCs([.init(name, "/tmp/other")])
        }
    }

    let config = OliphauntConfiguration(startupGUCs: [
        .init("work_mem", "16MB"),
        .init("SHARED_PRELOAD_LIBRARIES", "auto_explain, pg_textsearch"),
    ])
    #expect(config.postgresStartupArgs(sharedPreloadLibraries: ["pg_textsearch", "z"]) == [
        "-c", "work_mem=16MB",
        "-c", "shared_preload_libraries=auto_explain,pg_textsearch,z",
    ])
}

@Test
func existingDatabaseFixtureCarriesCanonicalRootDescriptor() throws {
    let fixtureDescriptor = try databaseRootDescriptorFixture(family: "native")
    let actualDescriptor = try JSONSerialization.jsonObject(with: Data(nativeRootDescriptor.utf8))
    #expect(try canonicalJSON(actualDescriptor) == canonicalJSON(fixtureDescriptor))

    let directory = try makeExistingDatabaseDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let descriptor = try String(
        contentsOf: directory.appendingPathComponent(".oliphaunt.json"),
        encoding: .utf8
    )
    #expect(descriptor == nativeRootDescriptor)
    #expect(FileManager.default.fileExists(atPath: directory.appendingPathComponent("pgdata/PG_VERSION").path))
}

@Test
func nativeFirstOpenDoesNotPublishAnIncompleteManagedRoot() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(
        "oliphaunt-swift-new-root-\(UUID().uuidString)",
        isDirectory: true
    )
    defer { try? FileManager.default.removeItem(at: root) }
    do {
        _ = try await OliphauntDatabase.open(
            configuration: .init(storage: .directory(root)),
            engine: OliphauntNativeDirectEngine(
                libraryURL: URL(fileURLWithPath: "/tmp/oliphaunt-swift-missing.dylib")
            )
        )
        Issue.record("open should fail for a missing native library")
    } catch {
        let contents = (try? FileManager.default.contentsOfDirectory(atPath: root.path)) ?? []
        if !contents.isEmpty {
            #expect(Set(contents) == Set([".oliphaunt.json", "pgdata"]))
            #expect(
                try String(
                    contentsOf: root.appendingPathComponent(".oliphaunt.json"),
                    encoding: .utf8
                ) == nativeRootDescriptor
            )
            try validateOliphauntCompletePgdata(
                root.appendingPathComponent("pgdata", isDirectory: true)
            )
        }
    }
}

@Test
func nativeFirstOpenRejectsDescriptorlessNonemptyRootWithoutMutation() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(
        "oliphaunt-swift-nonempty-root-\(UUID().uuidString)",
        isDirectory: true
    )
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    let sentinel = root.appendingPathComponent("keep.txt")
    try Data("keep".utf8).write(to: sentinel)
    defer { try? FileManager.default.removeItem(at: root) }
    do {
        _ = try await OliphauntDatabase.open(
            configuration: .init(storage: .directory(root)),
            engine: OliphauntNativeDirectEngine(
                libraryURL: URL(fileURLWithPath: "/tmp/oliphaunt-swift-missing.dylib")
            )
        )
        Issue.record("descriptorless nonempty root should be rejected")
    } catch OliphauntError.engine(let message) {
        #expect(message.contains("nonempty"))
        #expect(try String(contentsOf: sentinel, encoding: .utf8) == "keep")
        #expect(!FileManager.default.fileExists(atPath: root.appendingPathComponent(".oliphaunt.json").path))
    }
}

@Test
func nativeOpenRejectsEverySharedInvalidDescriptorBeforeNativeLoad() async throws {
    let fixture = try databaseRootFixture()
    let invalidObjects = try #require(fixture["invalidDescriptors"] as? [[String: Any]])
    let malformedObjects = try #require(fixture["malformedJson"] as? [[String: Any]])
    let invalidDescriptors = try invalidObjects.map { entry in
        try JSONSerialization.data(withJSONObject: #require(entry["value"]))
    }.map { String(decoding: $0, as: UTF8.self) } + malformedObjects.map { entry in
        try #require(entry["value"] as? String)
    }
    for descriptor in invalidDescriptors {
        let root = try makeExistingDatabaseDirectory(descriptor: descriptor)
        defer { try? FileManager.default.removeItem(at: root) }
        do {
            _ = try await OliphauntDatabase.open(
                configuration: .init(storage: .directory(root)),
                engine: OliphauntNativeDirectEngine(
                    libraryURL: URL(fileURLWithPath: "/tmp/oliphaunt-swift-missing.dylib")
                )
            )
            Issue.record("invalid descriptor should be rejected")
        } catch OliphauntError.engine(let message) {
            #expect(message.contains("invalid database root descriptor"))
            #expect(try String(contentsOf: root.appendingPathComponent("pgdata/PG_VERSION"), encoding: .utf8) == "18\n")
        }
    }
}

@Test
func nativeOpenDoesNotRejectAValidWasixRootDescriptor() async throws {
    let wasixDescriptor = String(
        decoding: try JSONSerialization.data(
            withJSONObject: databaseRootDescriptorFixture(family: "wasix")
        ),
        as: UTF8.self
    )
    let root = try makeExistingDatabaseDirectory(descriptor: wasixDescriptor)
    defer { try? FileManager.default.removeItem(at: root) }
    do {
        _ = try await OliphauntDatabase.open(
            configuration: .init(storage: .directory(root)),
            engine: OliphauntNativeDirectEngine(
                libraryURL: URL(fileURLWithPath: "/tmp/oliphaunt-swift-missing.dylib")
            )
        )
        Issue.record("open should fail for a missing native library")
    } catch OliphauntError.engine(let message) {
        #expect(message.contains("failed to load liboliphaunt"))
    }
}

@Test
func pgdataPublicationAdoptsACompleteWinnerWithoutReplacingIt() throws {
    let parent = FileManager.default.temporaryDirectory.appendingPathComponent(
        "oliphaunt-swift-publication-\(UUID().uuidString)",
        isDirectory: true
    )
    let staging = parent.appendingPathComponent("staging", isDirectory: true)
    let destination = parent.appendingPathComponent("pgdata", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: parent) }
    try makeCompletePgdata(at: staging)
    try makeCompletePgdata(at: destination)
    let sentinel = destination.appendingPathComponent("winner")
    try Data("keep".utf8).write(to: sentinel)

    let publication = try publishOliphauntPreparedPgdata(staging, to: destination)

    #expect(publication == .existing)
    #expect(try String(contentsOf: sentinel, encoding: .utf8) == "keep")
    #expect(FileManager.default.fileExists(atPath: staging.path))
}

@Test
func pgdataPublicationReportsAnOwnedDestination() throws {
    let parent = FileManager.default.temporaryDirectory.appendingPathComponent(
        "oliphaunt-swift-owned-publication-\(UUID().uuidString)",
        isDirectory: true
    )
    let staging = parent.appendingPathComponent("staging", isDirectory: true)
    let destination = parent.appendingPathComponent("pgdata", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: parent) }
    try makeCompletePgdata(at: staging)

    var didPublish = false
    let publication = try publishOliphauntPreparedPgdata(
        staging,
        to: destination,
        didPublishDestination: { didPublish = true }
    )

    #expect(publication == .published)
    #expect(didPublish)
    #expect(!FileManager.default.fileExists(atPath: staging.path))
    try validateOliphauntCompletePgdata(destination)
}

@Test
func publicationTreeDurabilityRejectsSpecialEntries() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(
        "oliphaunt-swift-special-publication-\(UUID().uuidString)",
        isDirectory: true
    )
    defer { try? FileManager.default.removeItem(at: root) }
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    let fifo = root.appendingPathComponent("fifo")
    let result = fifo.path.withCString { mkfifo($0, 0o600) }
    #expect(result == 0)

    do {
        try makeOliphauntPublicationTreeDurable(root)
        Issue.record("publication durability accepted a special entry")
    } catch OliphauntError.engine(let message) {
        #expect(message.contains("publication tree contains a special entry"))
    }
}

@Test
func stagingCleanupFailurePreventsSuccessAndComposesPrimaryFailure() {
    let success: Result<Int, Error> = .success(1)
    do {
        _ = try finishOliphauntStaging(success, operation: "PGDATA preparation") {
            throw ManagedRootPublicationTestError.cleanup
        }
        Issue.record("cleanup failure must prevent PGDATA preparation success")
    } catch OliphauntError.engine(let message) {
        #expect(message.contains("PGDATA preparation staging cleanup failed"))
    } catch {
        Issue.record("unexpected PGDATA staging cleanup error: \(error)")
    }

    let failure: Result<Int, Error> = .failure(ManagedRootPublicationTestError.publication)
    do {
        _ = try finishOliphauntStaging(failure, operation: "PGDATA preparation") {
            throw ManagedRootPublicationTestError.cleanup
        }
    } catch OliphauntError.engine(let message) {
        #expect(message.contains("PGDATA preparation failed"))
        #expect(message.contains("staging cleanup failed"))
    } catch {
        Issue.record("unexpected composed PGDATA staging error: \(error)")
    }
}

@Test
func managedRootFailureCleansOnlyWhenDescriptorIsDefinitelyAbsent() {
    let scenarios: [(owns: Bool, descriptorAbsent: Bool, expectedCalls: [String])] = [
        (true, true, ["remove", "sync"]),
        (true, false, []),
        (false, true, []),
    ]
    for scenario in scenarios {
        var calls: [String] = []
        do {
            try recoverOliphauntManagedRootPublicationFailure(
                ManagedRootPublicationTestError.publication,
                ownsPublishedPgdata: scenario.owns,
                descriptorDefinitelyAbsent: { scenario.descriptorAbsent },
                removePublishedPgdata: { calls.append("remove") },
                syncRoot: { calls.append("sync") }
            )
        } catch ManagedRootPublicationTestError.publication {
            #expect(calls == scenario.expectedCalls)
        } catch {
            Issue.record("unexpected managed-root recovery error: \(error)")
        }
    }
}

@Test
func managedRootFailureSurfacesCleanupFailure() {
    do {
        try recoverOliphauntManagedRootPublicationFailure(
            ManagedRootPublicationTestError.publication,
            ownsPublishedPgdata: true,
            descriptorDefinitelyAbsent: { true },
            removePublishedPgdata: { throw ManagedRootPublicationTestError.cleanup },
            syncRoot: {}
        )
    } catch OliphauntError.engine(let message) {
        #expect(message.contains("descriptor publication failed"))
        #expect(message.contains("failed to clean uncommitted PGDATA"))
    } catch {
        Issue.record("unexpected managed-root recovery error: \(error)")
    }
}

@Test
func managedRootFailurePreservesPgdataWhenDescriptorInspectionIsUncertain() {
    var calls: [String] = []
    do {
        try recoverOliphauntManagedRootPublicationFailure(
            ManagedRootPublicationTestError.publication,
            ownsPublishedPgdata: true,
            descriptorDefinitelyAbsent: { throw ManagedRootPublicationTestError.inspection },
            removePublishedPgdata: { calls.append("remove") },
            syncRoot: { calls.append("sync") }
        )
    } catch OliphauntError.engine(let message) {
        #expect(message.contains("descriptor publication is uncertain"))
        #expect(message.contains("publication"))
        #expect(calls.isEmpty)
    } catch {
        Issue.record("unexpected descriptor-inspection error: \(error)")
    }
}

private final class TestEngine: OliphauntEngine, @unchecked Sendable {
    let session: any OliphauntSession
    var openedConfiguration: OliphauntConfiguration?
    var restoredDestination: URL?
    var restoredBytes: Data?

    init(session: any OliphauntSession) {
        self.session = session
    }

    func open(configuration: OliphauntConfiguration) async throws -> any OliphauntSession {
        openedConfiguration = configuration
        return session
    }

    func restore(destination: URL, bytes: Data) async throws {
        restoredDestination = destination
        restoredBytes = bytes
    }
}

private final class ChunkBox: @unchecked Sendable {
    private let lock = NSLock()
    private var chunks: [Data] = []

    func append(_ chunk: Data) {
        lock.lock()
        chunks.append(chunk)
        lock.unlock()
    }

    func snapshot() -> [Data] {
        lock.lock()
        defer { lock.unlock() }
        return chunks
    }
}

private actor AsyncStringSignal {
    private var result: String?
    private var waiters: [CheckedContinuation<String, Never>] = []

    func complete(_ value: String) {
        guard result == nil else { return }
        result = value
        let current = waiters
        waiters.removeAll()
        current.forEach { $0.resume(returning: value) }
    }

    func wait() async -> String {
        if let result { return result }
        return await withCheckedContinuation { continuation in
            waiters.append(continuation)
        }
    }

    func current() -> String? { result }
}

private struct UppercaseText: Equatable, Sendable, OliphauntPostgresDecodable {
    let value: String

    static func decodePostgres(
        _ bytes: Data?,
        field: OliphauntQueryField
    ) throws -> UppercaseText? {
        guard field.typeOID == .text else {
            throw OliphauntError.engine("UppercaseText requires PostgreSQL text")
        }
        guard let bytes else { return nil }
        guard let value = String(data: bytes, encoding: .utf8) else {
            throw OliphauntError.engine("UppercaseText requires UTF-8")
        }
        return UppercaseText(value: value.uppercased())
    }
}

private func requireCommandStatement(
    _ statement: OliphauntStatementResult
) throws -> OliphauntCommandResult {
    guard case .command(let result) = statement else {
        throw OliphauntError.engine("test expected a command statement")
    }
    return result
}

private func requireRowsStatement(
    _ statement: OliphauntStatementResult
) throws -> OliphauntQueryResult {
    guard case .rows(let result) = statement else {
        throw OliphauntError.engine("test expected a row statement")
    }
    return result
}

private func captureProtocolStreamCallback(
    _ chunk: Data,
    onChunk: @escaping @Sendable (Data) throws -> Void
) -> OliphauntProtocolStreamOutcome {
    do {
        try onChunk(chunk)
        return .complete
    } catch {
        return .callbackAborted(error)
    }
}

private actor TestSession: OliphauntSession {
    private let response: Data
    private let backupBytes: Data
    private let commitTag: String
    private let failBegin: Bool
    private let failCommit: Bool
    private let failRollback: Bool
    private let beginResponse: Data?
    private let failTyped: Bool
    private let failRawRequest: Data?
    private let failStreamAfterCallback: Bool
    private let omitBeginReady: Bool
    private let blockBegin: Bool
    private let blockClose: Bool
    private let preserveResponseStatus: Bool
    private var capturedRequests: [Data] = []
    private var cancels = 0
    private var closes = 0
    private var inTransaction = false
    private var beginStarted = false
    private var beginStartWaiters: [CheckedContinuation<Void, Never>] = []
    private var beginRelease: CheckedContinuation<Void, Never>?
    private var closeStarted = false
    private var closeStartWaiters: [CheckedContinuation<Void, Never>] = []
    private var closeRelease: CheckedContinuation<Void, Never>?

    init(
        response: Data,
        backupBytes: Data = Data(),
        commitTag: String = "COMMIT",
        failBegin: Bool = false,
        failCommit: Bool = false,
        failRollback: Bool = false,
        beginResponse: Data? = nil,
        failTyped: Bool = false,
        failRawRequest: Data? = nil,
        failStreamAfterCallback: Bool = false,
        omitBeginReady: Bool = false,
        blockBegin: Bool = false,
        blockClose: Bool = false,
        preserveResponseStatus: Bool = false
    ) {
        self.response = response
        self.backupBytes = backupBytes
        self.commitTag = commitTag
        self.failBegin = failBegin
        self.failCommit = failCommit
        self.failRollback = failRollback
        self.beginResponse = beginResponse
        self.failTyped = failTyped
        self.failRawRequest = failRawRequest
        self.failStreamAfterCallback = failStreamAfterCallback
        self.omitBeginReady = omitBeginReady
        self.blockBegin = blockBegin
        self.blockClose = blockClose
        self.preserveResponseStatus = preserveResponseStatus
    }

    func execProtocolRaw(_ bytes: Data) async throws -> Data {
        capturedRequests.append(bytes)
        if let failRawRequest, bytes == failRawRequest {
            throw OliphauntError.engine("raw transport failed")
        }
        if bytes.first != Character("Q").asciiValue, failTyped {
            throw OliphauntError.engine("typed transport failed")
        }
        if bytes.first == Character("Q").asciiValue,
           let sql = String(data: bytes.dropFirst(5).dropLast(), encoding: .utf8),
           ["BEGIN", "COMMIT", "ROLLBACK"].contains(sql)
        {
            if sql == "BEGIN", failBegin {
                throw OliphauntError.engine("begin transport failed")
            }
            if sql == "COMMIT", failCommit {
                throw OliphauntError.engine("commit transport failed")
            }
            if sql == "ROLLBACK", failRollback {
                throw OliphauntError.engine("rollback transport failed")
            }
            if sql == "BEGIN" {
                if blockBegin {
                    beginStarted = true
                    beginStartWaiters.forEach { $0.resume() }
                    beginStartWaiters.removeAll()
                    await withCheckedContinuation { continuation in
                        beginRelease = continuation
                    }
                }
                if let beginResponse {
                    if let status = try? inspectOliphauntTerminalReadyStatus(beginResponse) {
                        inTransaction = status != .idle
                    }
                    return beginResponse
                }
                inTransaction = true
                if omitBeginReady {
                    return commandComplete("BEGIN")
                }
            } else {
                inTransaction = false
            }
            return simpleCommandResponse(
                sql == "COMMIT" ? commitTag : sql,
                status: inTransaction ? "T" : "I"
            )
        }
        guard !preserveResponseStatus,
              inTransaction,
              response.last == Character("I").asciiValue else {
            return response
        }
        var transactionResponse = response
        transactionResponse[transactionResponse.index(before: transactionResponse.endIndex)] =
            Character("T").asciiValue!
        return transactionResponse
    }

    func execProtocolRawStream(
        _ bytes: Data,
        onChunk: @escaping @Sendable (Data) throws -> Void
    ) async throws -> OliphauntProtocolStreamOutcome {
        let outcome = captureProtocolStreamCallback(try await execProtocolRaw(bytes), onChunk: onChunk)
        if failStreamAfterCallback {
            throw OliphauntError.engine("stream recovery failed")
        }
        return outcome
    }

    func backup() async throws -> Data { backupBytes }
    func cancel() async throws { cancels += 1 }
    func close() async throws {
        if blockClose {
            closeStarted = true
            closeStartWaiters.forEach { $0.resume() }
            closeStartWaiters.removeAll()
            await withCheckedContinuation { continuation in
                closeRelease = continuation
            }
        }
        closes += 1
    }
    func requests() -> [Data] { capturedRequests }
    func cancelCount() -> Int { cancels }
    func closeCount() -> Int { closes }

    func waitUntilBeginStarted() async {
        if beginStarted { return }
        await withCheckedContinuation { continuation in
            beginStartWaiters.append(continuation)
        }
    }

    func releaseBegin() {
        beginRelease?.resume()
        beginRelease = nil
    }

    func awaitClose() async {
        if closeStarted {
            return
        }
        await withCheckedContinuation { continuation in
            closeStartWaiters.append(continuation)
        }
    }

    func releaseClose() {
        closeRelease?.resume()
        closeRelease = nil
    }

    func simpleQueries() -> [String] {
        capturedRequests.compactMap { request in
            guard request.first == Character("Q").asciiValue, request.count >= 6 else { return nil }
            return String(data: request.dropFirst(5).dropLast(), encoding: .utf8)
        }
    }
}

private actor AdmissionOrderSession: OliphauntSession {
    private let blockClose: Bool
    private let blockCancel: Bool
    private var capturedEvents: [String] = []
    private var firstRawStarted = false
    private var firstRawStartWaiters: [CheckedContinuation<Void, Never>] = []
    private var firstRawRelease: CheckedContinuation<Void, Never>?
    private var closeStarted = false
    private var closeStartWaiters: [CheckedContinuation<Void, Never>] = []
    private var closeRelease: CheckedContinuation<Void, Never>?
    private var cancelStarted = false
    private var cancelStartWaiters: [CheckedContinuation<Void, Never>] = []
    private var cancelRelease: CheckedContinuation<Void, Never>?
    private var cancels = 0
    private var typedOperationCount = 0

    init(blockClose: Bool = false, blockCancel: Bool = false) {
        self.blockClose = blockClose
        self.blockCancel = blockCancel
    }

    func execProtocolRaw(_ bytes: Data) async throws -> Data {
        if bytes.first == Character("Q").asciiValue,
           let sql = String(data: bytes.dropFirst(5).dropLast(), encoding: .utf8),
           ["BEGIN", "COMMIT", "ROLLBACK"].contains(sql)
        {
            capturedEvents.append(sql)
            return simpleCommandResponse(sql, status: sql == "BEGIN" ? "T" : "I")
        }

        if bytes.first == Character("P").asciiValue {
            typedOperationCount += 1
            capturedEvents.append("typed:\(typedOperationCount)")
            if typedOperationCount == 1 {
                firstRawStarted = true
                firstRawStartWaiters.forEach { $0.resume() }
                firstRawStartWaiters.removeAll()
                await withCheckedContinuation { continuation in
                    firstRawRelease = continuation
                }
            }
            return commandResponse("UPDATE 1", status: "T")
        }

        let marker = bytes.first.map(String.init) ?? "empty"
        capturedEvents.append("raw:\(marker)")
        if bytes == Data([1]) {
            firstRawStarted = true
            firstRawStartWaiters.forEach { $0.resume() }
            firstRawStartWaiters.removeAll()
            await withCheckedContinuation { continuation in
                firstRawRelease = continuation
            }
        }
        return bytes
    }

    func execProtocolRawStream(
        _ bytes: Data,
        onChunk: @escaping @Sendable (Data) throws -> Void
    ) async throws -> OliphauntProtocolStreamOutcome {
        captureProtocolStreamCallback(try await execProtocolRaw(bytes), onChunk: onChunk)
    }

    func backup() async throws -> Data { Data() }
    func cancel() async throws {
        cancels += 1
        if blockCancel {
            capturedEvents.append("cancel:start")
            cancelStarted = true
            cancelStartWaiters.forEach { $0.resume() }
            cancelStartWaiters.removeAll()
            await withCheckedContinuation { continuation in
                cancelRelease = continuation
            }
            capturedEvents.append("cancel:end")
        } else {
            capturedEvents.append("cancel")
        }
    }

    func close() async throws {
        capturedEvents.append("close")
        if blockClose {
            closeStarted = true
            closeStartWaiters.forEach { $0.resume() }
            closeStartWaiters.removeAll()
            await withCheckedContinuation { continuation in
                closeRelease = continuation
            }
        }
    }

    func waitUntilFirstRawStarted() async {
        guard !firstRawStarted else { return }
        await withCheckedContinuation { continuation in
            firstRawStartWaiters.append(continuation)
        }
    }

    func releaseFirstRaw() {
        firstRawRelease?.resume()
        firstRawRelease = nil
    }

    func waitUntilCloseStarted() async {
        if closeStarted { return }
        await withCheckedContinuation { continuation in
            closeStartWaiters.append(continuation)
        }
    }

    func releaseClose() {
        closeRelease?.resume()
        closeRelease = nil
    }

    func waitUntilCancelStarted() async {
        if cancelStarted { return }
        await withCheckedContinuation { continuation in
            cancelStartWaiters.append(continuation)
        }
    }

    func releaseCancel() {
        cancelRelease?.resume()
        cancelRelease = nil
    }

    func cancelCount() -> Int { cancels }

    func events() -> [String] { capturedEvents }
}

private actor SettlementBlockingSession: OliphauntSession {
    private let blockedControl: String
    private var capturedQueries: [String] = []
    private var blockedControlStarted = false
    private var released = false
    private var startWaiters: [CheckedContinuation<Void, Never>] = []
    private var releaseWaiter: CheckedContinuation<Void, Never>?

    init(blockedControl: String) {
        self.blockedControl = blockedControl
    }

    func execProtocolRaw(_ bytes: Data) async throws -> Data {
        guard bytes.first == Character("Q").asciiValue,
              let sql = String(data: bytes.dropFirst(5).dropLast(), encoding: .utf8)
        else {
            return commandResponse("OK", status: "T")
        }
        capturedQueries.append(sql)
        if sql == blockedControl {
            blockedControlStarted = true
            let waiters = startWaiters
            startWaiters.removeAll()
            waiters.forEach { $0.resume() }
            if !released {
                await withCheckedContinuation { continuation in
                    releaseWaiter = continuation
                }
            }
        }
        return simpleCommandResponse(sql, status: sql == "BEGIN" ? "T" : "I")
    }

    func execProtocolRawStream(
        _ bytes: Data,
        onChunk: @escaping @Sendable (Data) throws -> Void
    ) async throws -> OliphauntProtocolStreamOutcome {
        captureProtocolStreamCallback(try await execProtocolRaw(bytes), onChunk: onChunk)
    }

    func backup() async throws -> Data { Data() }
    func cancel() async throws {}
    func close() async throws {}

    func waitUntilBlockedControlStarted() async {
        if blockedControlStarted { return }
        await withCheckedContinuation { continuation in
            startWaiters.append(continuation)
        }
    }

    func releaseBlockedControl() {
        released = true
        releaseWaiter?.resume()
        releaseWaiter = nil
    }

    func simpleQueries() -> [String] { capturedQueries }
}

private actor TransactionBox {
    private var transaction: OliphauntTransaction?

    func store(_ transaction: OliphauntTransaction) {
        self.transaction = transaction
    }

    func value() -> OliphauntTransaction? { transaction }
}

private func backendMessage(_ tag: UInt8, _ body: Data) -> Data {
    let length = UInt32(body.count + 4)
    return Data([
        tag,
        UInt8((length >> 24) & 0xff),
        UInt8((length >> 16) & 0xff),
        UInt8((length >> 8) & 0xff),
        UInt8(length & 0xff),
    ]) + body
}

private func combineMessages(_ messages: Data...) -> Data {
    messages.reduce(into: Data()) { response, message in
        response.append(message)
    }
}

private func commandComplete(_ tag: String) -> Data {
    backendMessage(Character("C").asciiValue!, Data(tag.utf8) + Data([0]))
}

private func readyResponse(status: Character = "I") -> Data {
    backendMessage(Character("Z").asciiValue!, Data([status.asciiValue!]))
}

private func commandResponse(_ tag: String, status: Character = "I") -> Data {
    backendMessage(Character("1").asciiValue!, Data()) +
        backendMessage(Character("2").asciiValue!, Data()) +
        backendMessage(Character("n").asciiValue!, Data()) +
        simpleCommandResponse(tag, status: status)
}

private func simpleCommandResponse(_ tag: String, status: Character = "I") -> Data {
    commandComplete(tag) + readyResponse(status: status)
}

private func emptyQueryResponse() -> Data {
    backendMessage(Character("I").asciiValue!, Data())
}

private func rowDescription(
    name: String = "value",
    typeOID: OliphauntPostgresOID = .text,
    format: Int16 = 0
) -> Data {
    rowDescription(names: [name], typeOID: typeOID, format: format)
}

private func rowDescription(
    names: [String],
    typeOID: OliphauntPostgresOID = .text,
    format: Int16 = 0
) -> Data {
    var body = Data()
    appendInt16(Int16(names.count), to: &body)
    for name in names {
        body += Data(name.utf8) + Data([0])
        body += Data(repeating: 0, count: 6)
        appendUInt32(typeOID.rawValue, to: &body)
        body += Data([0xff, 0xff, 0xff, 0xff, 0xff, 0xff])
        appendInt16(format, to: &body)
    }
    return backendMessage(Character("T").asciiValue!, body)
}

private func rowResultMessages(
    valueBytes: Data?,
    name: String = "value",
    typeOID: OliphauntPostgresOID = .text,
    format: Int16 = 0
) -> Data {
    rowDescription(name: name, typeOID: typeOID, format: format) +
        dataRow(valueBytes: valueBytes)
}

private func dataRow(valueBytes: Data?) -> Data {
    dataRow(valueBytes: [valueBytes])
}

private func dataRow(valueBytes: [Data?]) -> Data {
    var body = Data()
    appendInt16(Int16(valueBytes.count), to: &body)
    for value in valueBytes {
        if let value {
            appendUInt32(UInt32(value.count), to: &body)
            body += value
        } else {
            body += Data([0xff, 0xff, 0xff, 0xff])
        }
    }
    return backendMessage(Character("D").asciiValue!, body)
}

private func rowResponse(
    value: String,
    commandTag: String,
    typeOID: OliphauntPostgresOID = .text,
    format: Int16 = 0,
    status: Character = "I"
) -> Data {
    rowResponse(
        valueBytes: Data(value.utf8),
        commandTag: commandTag,
        typeOID: typeOID,
        format: format,
        status: status
    )
}

private func rowResponse(
    valueBytes: Data?,
    commandTag: String,
    typeOID: OliphauntPostgresOID = .text,
    format: Int16 = 0,
    status: Character = "I"
) -> Data {
    backendMessage(Character("1").asciiValue!, Data()) +
        backendMessage(Character("2").asciiValue!, Data()) +
        rowResultMessages(valueBytes: valueBytes, typeOID: typeOID, format: format) +
        commandComplete(commandTag) +
        readyResponse(status: status)
}

private func noticeResponse(severity: String, message: String) -> Data {
    let body = Data([Character("S").asciiValue!]) + Data(severity.utf8) + Data([0]) +
        Data([Character("M").asciiValue!]) + Data(message.utf8) + Data([0, 0])
    return backendMessage(Character("N").asciiValue!, body)
}

private func errorResponse(sqlstate: String, message: String) -> Data {
    var body = Data([Character("S").asciiValue!])
    body.append(Data("ERROR".utf8))
    body.append(0)
    body.append(Character("C").asciiValue!)
    body.append(Data(sqlstate.utf8))
    body.append(0)
    body.append(Character("M").asciiValue!)
    body.append(Data(message.utf8))
    body.append(contentsOf: [0, 0])
    return backendMessage(Character("E").asciiValue!, body)
}

private func parameterDescription(_ types: [OliphauntPostgresOID]) -> Data {
    var body = Data()
    appendInt16(Int16(types.count), to: &body)
    for type in types {
        appendUInt32(type.rawValue, to: &body)
    }
    return backendMessage(Character("t").asciiValue!, body)
}

private func appendUInt32(_ value: UInt32, to data: inout Data) {
    data += Data([
        UInt8((value >> 24) & 0xff),
        UInt8((value >> 16) & 0xff),
        UInt8((value >> 8) & 0xff),
        UInt8(value & 0xff),
    ])
}

private func appendInt16(_ value: Int16, to data: inout Data) {
    let bits = UInt16(bitPattern: value)
    data += Data([UInt8((bits >> 8) & 0xff), UInt8(bits & 0xff)])
}

private func parseParameterTypeOids(_ request: Data) throws -> [OliphauntPostgresOID] {
    let bytes = [UInt8](request)
    guard bytes.first == Character("P").asciiValue, bytes.count >= 7 else {
        throw OliphauntError.engine("test request is not a Parse message")
    }
    var offset = 5
    for label in ["statement name", "SQL"] {
        guard let terminator = bytes[offset...].firstIndex(of: 0) else {
            throw OliphauntError.engine("test Parse \(label) is unterminated")
        }
        offset = terminator + 1
    }
    guard offset + 2 <= bytes.count else {
        throw OliphauntError.engine("test Parse parameter count is truncated")
    }
    let count = Int(UInt16(bytes[offset]) << 8 | UInt16(bytes[offset + 1]))
    offset += 2
    var result: [OliphauntPostgresOID] = []
    for _ in 0..<count {
        guard offset + 4 <= bytes.count else {
            throw OliphauntError.engine("test Parse parameter OID is truncated")
        }
        let value = UInt32(bytes[offset]) << 24 |
            UInt32(bytes[offset + 1]) << 16 |
            UInt32(bytes[offset + 2]) << 8 |
            UInt32(bytes[offset + 3])
        result.append(OliphauntPostgresOID(value))
        offset += 4
    }
    return result
}

private let nativeRootDescriptor =
    "{\"schema\":\"oliphaunt-database-root-v1\",\"engineFamily\":\"native\",\"pgdata\":\"pgdata\",\"postgresMajor\":18,\"physicalFormat\":\"native-pg18-v1\"}\n"

private enum ManagedRootPublicationTestError: Error {
    case publication
    case cleanup
    case inspection
}

private func databaseRootFixture() throws -> [String: Any] {
    let source = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .appendingPathComponent("shared/fixtures/storage/database-root.json")
    return try #require(
        JSONSerialization.jsonObject(with: Data(contentsOf: source)) as? [String: Any]
    )
}

private func databaseRootDescriptorFixture(family: String) throws -> [String: Any] {
    let fixture = try databaseRootFixture()
    let descriptors = try #require(fixture["validDescriptors"] as? [[String: Any]])
    return try #require(descriptors.first { $0["engineFamily"] as? String == family })
}

private func canonicalJSON(_ value: Any) throws -> Data {
    try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
}

private func makeExistingDatabaseDirectory(descriptor: String = nativeRootDescriptor) throws -> URL {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
        "liboliphaunt-swift-existing-database-\(UUID().uuidString)",
        isDirectory: true
    )
    try makeCompletePgdata(at: directory.appendingPathComponent("pgdata", isDirectory: true))
    try Data(descriptor.utf8).write(to: directory.appendingPathComponent(".oliphaunt.json"))
    return directory
}

private func makeCompletePgdata(at pgdata: URL) throws {
    try FileManager.default.createDirectory(
        at: pgdata.appendingPathComponent("global", isDirectory: true),
        withIntermediateDirectories: true
    )
    try FileManager.default.createDirectory(
        at: pgdata.appendingPathComponent("pg_wal", isDirectory: true),
        withIntermediateDirectories: true
    )
    try Data("18\n".utf8).write(to: pgdata.appendingPathComponent("PG_VERSION"))
    try Data("control".utf8).write(to: pgdata.appendingPathComponent("global/pg_control"))
}
