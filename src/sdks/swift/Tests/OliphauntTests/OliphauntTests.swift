import Foundation
@testable import Oliphaunt
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
func queryUsesCommandTagRowCount() throws {
    let result = try parseOliphauntQueryResponse(rowResponse(value: "1", commandTag: "SELECT 7"))
    #expect(result.rows.count == 1)
    #expect(result.rowCount == 7)
    #expect(try result.getText(row: 0, column: "value") == "1")
}

@Test
func postgresErrorPrefersNonlocalizedSeverity() {
    let error = OliphauntPostgresError(fields: [
        .init(code: Character("S").asciiValue!, value: "ERROR"),
        .init(code: Character("V").asciiValue!, value: "ERREUR"),
        .init(code: Character("M").asciiValue!, value: "bad query"),
    ])
    #expect(error.severity == "ERREUR")
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
    try await database.execProtocolStream(Data([Character("Q").asciiValue!, 0, 0, 0, 5, 0])) {
        chunks.append($0)
    }
    #expect(chunks.snapshot() == [response])
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
func rollbackFailurePoisonsFacadeUntilClose() async throws {
    struct Expected: Error {}
    let session = TestSession(response: commandResponse("UPDATE 1"), failRollback: true)
    let database = try await OliphauntDatabase.open(engine: TestEngine(session: session))
    await #expect(throws: Expected.self) {
        _ = try await database.transaction { _ -> Int in throw Expected() }
    }
    await #expect(throws: OliphauntError.self) {
        _ = try await database.execute("SELECT 1")
    }
    try await database.close()
}

@Test
func closeIsIdempotentAndRejectsFurtherWork() async throws {
    let session = TestSession(response: commandResponse("OK"))
    let database = try await OliphauntDatabase.open(engine: TestEngine(session: session))
    try await database.close()
    try await database.close()
    #expect(await session.closeCount() == 1)
    await #expect(throws: OliphauntError.self) {
        _ = try await database.execute("SELECT 1")
    }
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

private actor TestSession: OliphauntSession {
    private let response: Data
    private let backupBytes: Data
    private let commitTag: String
    private let failCommit: Bool
    private let failRollback: Bool
    private var capturedRequests: [Data] = []
    private var closes = 0

    init(
        response: Data,
        backupBytes: Data = Data(),
        commitTag: String = "COMMIT",
        failCommit: Bool = false,
        failRollback: Bool = false
    ) {
        self.response = response
        self.backupBytes = backupBytes
        self.commitTag = commitTag
        self.failCommit = failCommit
        self.failRollback = failRollback
    }

    func execProtocolRaw(_ bytes: Data) async throws -> Data {
        capturedRequests.append(bytes)
        if bytes.first == Character("Q").asciiValue,
           let sql = String(data: bytes.dropFirst(5).dropLast(), encoding: .utf8),
           ["BEGIN", "COMMIT", "ROLLBACK"].contains(sql)
        {
            if sql == "COMMIT", failCommit {
                throw OliphauntError.engine("commit transport failed")
            }
            if sql == "ROLLBACK", failRollback {
                throw OliphauntError.engine("rollback transport failed")
            }
            return commandResponse(sql == "COMMIT" ? commitTag : sql)
        }
        return response
    }

    func execProtocolStream(
        _ bytes: Data,
        onChunk: @escaping @Sendable (Data) throws -> Void
    ) async throws {
        try onChunk(try await execProtocolRaw(bytes))
    }

    func backup() async throws -> Data { backupBytes }
    func cancel() async throws {}
    func close() async throws { closes += 1 }
    func requests() -> [Data] { capturedRequests }
    func closeCount() -> Int { closes }

    func simpleQueries() -> [String] {
        capturedRequests.compactMap { request in
            guard request.first == Character("Q").asciiValue, request.count >= 6 else { return nil }
            return String(data: request.dropFirst(5).dropLast(), encoding: .utf8)
        }
    }
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

private func commandResponse(_ tag: String) -> Data {
    backendMessage(Character("C").asciiValue!, Data(tag.utf8) + Data([0])) +
        backendMessage(Character("Z").asciiValue!, Data([Character("I").asciiValue!]))
}

private func rowResponse(value: String, commandTag: String) -> Data {
    var rowDescription = Data([0, 1])
    rowDescription += Data("value".utf8) + Data([0])
    rowDescription += Data(repeating: 0, count: 6)
    rowDescription += Data([0, 0, 0, 25, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0, 0])
    let valueBytes = Data(value.utf8)
    let length = UInt32(valueBytes.count)
    let dataRow = Data([0, 1, UInt8(length >> 24), UInt8(length >> 16), UInt8(length >> 8), UInt8(length)]) + valueBytes
    return backendMessage(Character("T").asciiValue!, rowDescription) +
        backendMessage(Character("D").asciiValue!, dataRow) +
        commandResponse(commandTag)
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
