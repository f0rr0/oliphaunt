import Foundation
import Oliphaunt
import OliphauntBrokerExtension
import OliphauntBrokerProtocol
import Testing

@Test
func workerConfigurationRequiresTheRestrictedDatabaseIdentity() throws {
    let root = FileManager.default.temporaryDirectory
        .appendingPathComponent("oliphaunt-worker-role-config-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: root) }
    let storage = try BrokerExtensionStorage(location: .extensionPrivate, rootURL: root)
    let engine = RestrictedRoleTestEngine()

    let configuration = try BrokerWorkerConfiguration(
        storage: storage,
        engine: engine,
        liboliphauntVersion: "restricted-role-test-runtime",
        startupConfigurationDigest: "restricted-role-test-configuration"
    )
    #expect(configuration.username == BrokerWorkerConfiguration.restrictedRoleUsername)
    #expect(configuration.database == BrokerWorkerConfiguration.restrictedDatabase)
    #expect(
        configuration.startupGUCs == [
            OliphauntStartupGUC(
                "search_path",
                BrokerWorkerConfiguration.restrictedSearchPath
            )
        ]
    )

    #expect(throws: BrokerError.self) {
        _ = try BrokerWorkerConfiguration(
            storage: storage,
            engine: engine,
            liboliphauntVersion: "restricted-role-test-runtime",
            startupConfigurationDigest: "restricted-role-test-configuration",
            startupGUCs: [OliphauntStartupGUC("SEARCH_PATH", "public")]
        )
    }

    for identity in [("postgres", "postgres"), ("oliphaunt_broker", "template1")] {
        do {
            _ = try BrokerWorkerConfiguration(
                storage: storage,
                engine: engine,
                liboliphauntVersion: "restricted-role-test-runtime",
                startupConfigurationDigest: "restricted-role-test-configuration",
                username: identity.0,
                database: identity.1
            )
            Issue.record("insecure worker identity unexpectedly passed validation: \(identity)")
        } catch let error as BrokerError {
            guard case .invalidConfiguration = error else {
                Issue.record("insecure worker identity returned the wrong error: \(error)")
                continue
            }
        }
    }
}

@Test
func workerEstablishesRestrictedRoleBoundaryBeforeReady() async throws {
    let harness = try RestrictedRoleHarness(bootstrapFails: false)
    defer { harness.removeStorage() }

    _ = try await harness.core.start(hello: harness.hello)

    let opened = try #require(await harness.engine.openedConfiguration())
    #expect(opened.username == BrokerWorkerConfiguration.restrictedRoleUsername)
    #expect(opened.database == BrokerWorkerConfiguration.restrictedDatabase)
    #expect(
        opened.startupGUCs.last
            == OliphauntStartupGUC(
                "search_path",
                BrokerWorkerConfiguration.restrictedSearchPath
            )
    )

    let session = harness.engine.session
    let queries = await session.queries()
    #expect(queries.count == 2)
    let bootstrap = try #require(queries.first)
    #expect(bootstrap.hasPrefix("BEGIN;"))
    #expect(bootstrap.contains("CREATE EXTENSION IF NOT EXISTS %I"))
    #expect(bootstrap.contains("ARRAY['pg_trgm', 'vector']::text[]"))
    #expect(bootstrap.contains("REASSIGN OWNED BY \"oliphaunt_broker\""))
    #expect(bootstrap.contains("TO \"postgres\""))
    #expect(bootstrap.contains("CREATE SCHEMA IF NOT EXISTS \"oliphaunt_broker\""))
    #expect(bootstrap.contains("AUTHORIZATION \"oliphaunt_broker\""))
    #expect(bootstrap.contains("GRANT CONNECT, TEMPORARY"))
    #expect(bootstrap.contains("ON DATABASE \"postgres\""))
    #expect(bootstrap.contains("REVOKE CREATE"))
    #expect(bootstrap.contains("GRANT USAGE, CREATE"))
    #expect(bootstrap.contains("ON SCHEMA \"oliphaunt_broker\""))
    #expect(bootstrap.contains("GRANT USAGE ON SCHEMA public"))
    #expect(bootstrap.contains("GRANT pg_checkpoint TO \"oliphaunt_broker\""))
    #expect(bootstrap.contains("pg_relation_filepath(regclass)"))
    #expect(bootstrap.contains("pg_tablespace_location(oid)"))
    #expect(bootstrap.contains("FROM PUBLIC, \"oliphaunt_broker\""))
    #expect(bootstrap.contains("parent.rolname <> 'pg_checkpoint'"))
    #expect(bootstrap.contains("direct_memberships <> ARRAY['pg_checkpoint']::text[]"))
    #expect(bootstrap.contains("WITH RECURSIVE effective_role_oids(oid)"))
    #expect(bootstrap.contains("ARRAY['oliphaunt_broker', 'pg_checkpoint']::text[]"))
    #expect(bootstrap.contains("NOSUPERUSER NOCREATEDB NOCREATEROLE"))
    #expect(bootstrap.contains("INHERIT LOGIN NOREPLICATION NOBYPASSRLS"))
    #expect(
        bootstrap.components(separatedBy: "SET search_path TO \"$user\", public").count
            == 3
    )
    #expect(bootstrap.contains("rolconfig @> ARRAY['search_path=\"$user\", public']"))
    #expect(bootstrap.contains("SET SESSION AUTHORIZATION \"oliphaunt_broker\""))
    #expect(bootstrap.contains("SET search_path TO \"$user\", public"))
    #expect(bootstrap.contains("current_schemas(false)"))
    #expect(bootstrap.contains("ARRAY['oliphaunt_broker', 'public']::name[]"))
    #expect(bootstrap.contains("session_user <> 'oliphaunt_broker'"))
    #expect(bootstrap.contains("current_user <> 'oliphaunt_broker'"))
    #expect(bootstrap.contains("current_setting('is_superuser') <> 'off'"))
    #expect(bootstrap.contains("owner.rolname = 'postgres'"))
    #expect(bootstrap.contains("owner.rolname <> 'postgres'"))
    #expect(bootstrap.contains("'pg_database_owner', 'SET'"))
    #expect(bootstrap.contains("current_database(), 'CREATE'"))
    #expect(bootstrap.contains("'public', 'CREATE'"))
    #expect(bootstrap.contains("spcname NOT IN ('pg_default', 'pg_global')"))
    #expect(!bootstrap.contains("ALTER DATABASE"))
    #expect(bootstrap.hasSuffix("COMMIT;"))
    #expect(queries[1] == "SELECT 1 AS broker_health")
}

@Test
func failedRestrictedRoleValidationRollsBackAndNeverPublishesReady() async throws {
    let harness = try RestrictedRoleHarness(bootstrapFails: true)
    defer { harness.removeStorage() }
    let originalEpoch = await harness.core.epoch

    do {
        _ = try await harness.core.start(hello: harness.hello)
        Issue.record("worker unexpectedly published Ready after restricted-role failure")
    } catch let error as BrokerError {
        #expect(error == .brokerUnavailable)
    }

    let session = harness.engine.session
    #expect(await session.queries().last == "ROLLBACK")
    #expect(await session.closeCallCount() == 1)
    let diagnostics = try await harness.core.diagnostics(expectedEpoch: originalEpoch)
    #expect(diagnostics.state == .created)
}

@Test
func postOpenStorageProtectionFailureClosesSessionAndNeverPublishesReady() async throws {
    let harness = try RestrictedRoleHarness(
        bootstrapFails: false,
        createsUnprotectablePostOpenArtifact: true
    )
    defer { harness.removeStorage() }
    let originalEpoch = await harness.core.epoch

    do {
        _ = try await harness.core.start(hello: harness.hello)
        Issue.record("worker unexpectedly published Ready after storage-protection failure")
    } catch let error as BrokerError {
        #expect(error == .rejected(.rootOpen))
        #expect(!error.description.contains(harness.rootURL.path))
        #expect(!error.description.contains("post-open-private-artifact"))
    }

    #expect(await harness.engine.session.closeCallCount() == 1)
    let diagnostics = try await harness.core.diagnostics(expectedEpoch: originalEpoch)
    #expect(diagnostics.state == .created)
}

private struct RestrictedRoleHarness {
    let rootURL: URL
    let engine: RestrictedRoleTestEngine
    let core: WorkerCore
    let hello: BrokerHello

    init(
        bootstrapFails: Bool,
        createsUnprotectablePostOpenArtifact: Bool = false
    ) throws {
        rootURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("oliphaunt-worker-role-\(UUID().uuidString)")
        engine = RestrictedRoleTestEngine(
            bootstrapFails: bootstrapFails,
            createsUnprotectablePostOpenArtifact: createsUnprotectablePostOpenArtifact
        )
        let configuration = try BrokerWorkerConfiguration(
            storage: BrokerExtensionStorage(location: .extensionPrivate, rootURL: rootURL),
            engine: engine,
            liboliphauntVersion: "restricted-role-test-runtime",
            cABIVersion: 42,
            postgresMajorVersion: 18,
            startupConfigurationDigest: "restricted-role-test-configuration",
            selectedPostgresExtensions: ["vector", "pg_trgm"],
            runtimeVersionProvider: { "restricted-role-test-runtime" }
        )
        core = WorkerCore(configuration: configuration)
        hello = BrokerHello(
            expectedABI: 42,
            expectedRuntimeVersion: "restricted-role-test-runtime",
            startupConfigurationDigest: "restricted-role-test-configuration",
            requestedCapabilities: [.protocolRaw, .protocolStream, .queryCancel]
        )
    }

    func removeStorage() {
        try? FileManager.default.removeItem(at: rootURL)
    }
}

private actor RestrictedRoleTestEngine: OliphauntEngine {
    let session: RestrictedRoleTestSession
    private let createsUnprotectablePostOpenArtifact: Bool
    private var configuration: OliphauntConfiguration?

    init(
        bootstrapFails: Bool = false,
        createsUnprotectablePostOpenArtifact: Bool = false
    ) {
        session = RestrictedRoleTestSession(bootstrapFails: bootstrapFails)
        self.createsUnprotectablePostOpenArtifact = createsUnprotectablePostOpenArtifact
    }

    func open(configuration: OliphauntConfiguration) async throws -> any OliphauntSession {
        self.configuration = configuration
        let root = try #require(configuration.root)
        let pgdata = root.appendingPathComponent("pgdata", isDirectory: true)
        try FileManager.default.createDirectory(at: pgdata, withIntermediateDirectories: true)
        try Data("18\n".utf8).write(
            to: pgdata.appendingPathComponent("PG_VERSION"),
            options: .atomic
        )
        if createsUnprotectablePostOpenArtifact {
            let artifact = root.appendingPathComponent(
                "runtime-cache/post-open-private-artifact",
                isDirectory: false
            )
            try FileManager.default.createSymbolicLink(
                at: artifact,
                withDestinationURL: pgdata
            )
        }
        return session
    }

    func restore(_ request: OliphauntRestoreRequest) async throws -> URL {
        request.root
    }

    func openedConfiguration() -> OliphauntConfiguration? {
        configuration
    }
}

private actor RestrictedRoleTestSession: OliphauntSession {
    private let bootstrapFails: Bool
    private var recordedQueries: [String] = []
    private var closeCalls = 0

    init(bootstrapFails: Bool) {
        self.bootstrapFails = bootstrapFails
    }

    func capabilities() async -> OliphauntCapabilities {
        OliphauntCapabilities(
            mode: .nativeDirect,
            processIsolated: false,
            independentSessions: false,
            maxClientSessions: 1
        )
    }

    func execProtocolRaw(_ bytes: Data) async throws -> Data {
        let query = try #require(simpleQueryText(bytes))
        recordedQueries.append(query)
        if bootstrapFails, recordedQueries.count == 1 {
            return restrictedRoleErrorResponse()
        }
        if query == "SELECT 1 AS broker_health" {
            return restrictedRoleHealthResponse()
        }
        return restrictedRoleCommandResponse()
    }

    func execProtocolStream(
        _ bytes: Data,
        onChunk: @escaping @Sendable (Data) throws -> Void
    ) async throws {
        try onChunk(restrictedRoleHealthResponse())
    }

    func backup(_ request: OliphauntBackupRequest) async throws -> OliphauntBackupArtifact {
        OliphauntBackupArtifact(format: request.format, bytes: Data())
    }

    func cancel() async throws {}

    func close() async throws {
        closeCalls += 1
    }

    func queries() -> [String] {
        recordedQueries
    }

    func closeCallCount() -> Int {
        closeCalls
    }
}

private func simpleQueryText(_ request: Data) -> String? {
    guard request.count >= 6,
        request.first == 0x51,
        request.last == 0
    else {
        return nil
    }
    return String(decoding: request.dropFirst(5).dropLast(), as: UTF8.self)
}

private func restrictedRoleCommandResponse() -> Data {
    var response = Data()
    appendRestrictedRoleBackendMessage(0x43, body: Data("DO\0".utf8), to: &response)
    appendRestrictedRoleBackendMessage(0x5a, body: Data([0x49]), to: &response)
    return response
}

private func restrictedRoleErrorResponse() -> Data {
    var response = Data()
    var error = Data()
    error.append(0x53)
    error.append(Data("ERROR\0".utf8))
    error.append(0x43)
    error.append(Data("42501\0".utf8))
    error.append(0x4d)
    error.append(Data("broker restricted role validation failed\0".utf8))
    error.append(0)
    appendRestrictedRoleBackendMessage(0x45, body: error, to: &response)
    appendRestrictedRoleBackendMessage(0x5a, body: Data([0x45]), to: &response)
    return response
}

private func restrictedRoleHealthResponse() -> Data {
    var response = Data()
    var rowDescription = Data()
    appendRestrictedRoleInt16(1, to: &rowDescription)
    rowDescription.append(Data("broker_health".utf8))
    rowDescription.append(0)
    appendRestrictedRoleUInt32(0, to: &rowDescription)
    appendRestrictedRoleInt16(0, to: &rowDescription)
    appendRestrictedRoleUInt32(23, to: &rowDescription)
    appendRestrictedRoleInt16(4, to: &rowDescription)
    appendRestrictedRoleUInt32(UInt32.max, to: &rowDescription)
    appendRestrictedRoleInt16(0, to: &rowDescription)
    appendRestrictedRoleBackendMessage(0x54, body: rowDescription, to: &response)

    var row = Data()
    appendRestrictedRoleInt16(1, to: &row)
    appendRestrictedRoleUInt32(1, to: &row)
    row.append(Data("1".utf8))
    appendRestrictedRoleBackendMessage(0x44, body: row, to: &response)
    appendRestrictedRoleBackendMessage(0x43, body: Data("SELECT 1\0".utf8), to: &response)
    appendRestrictedRoleBackendMessage(0x5a, body: Data([0x49]), to: &response)
    return response
}

private func appendRestrictedRoleBackendMessage(
    _ tag: UInt8,
    body: Data,
    to response: inout Data
) {
    response.append(tag)
    appendRestrictedRoleUInt32(UInt32(body.count + 4), to: &response)
    response.append(body)
}

private func appendRestrictedRoleInt16(_ value: Int16, to data: inout Data) {
    let bits = UInt16(bitPattern: value)
    data.append(UInt8((bits >> 8) & 0xff))
    data.append(UInt8(bits & 0xff))
}

private func appendRestrictedRoleUInt32(_ value: UInt32, to data: inout Data) {
    data.append(UInt8((value >> 24) & 0xff))
    data.append(UInt8((value >> 16) & 0xff))
    data.append(UInt8((value >> 8) & 0xff))
    data.append(UInt8(value & 0xff))
}
