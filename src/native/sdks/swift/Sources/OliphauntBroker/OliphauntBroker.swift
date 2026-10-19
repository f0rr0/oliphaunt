@_exported import OliphauntCore

#if os(iOS)
    import Darwin
    import ExtensionFoundation
    import Foundation
    import OliphauntNativeBindings
    import XPC

    @available(iOS 26, *)
    public struct OliphauntBrokerOptions: Sendable {
        public var startupTimeout: Duration
        public var operationTimeout: Duration?
        public init(startupTimeout: Duration = .seconds(30), operationTimeout: Duration? = nil) {
            self.startupTimeout = startupTimeout
            self.operationTimeout = operationTimeout
        }
    }

    @available(iOS 26, *)
    public enum OliphauntBroker {
        private static let ownership = BrokerOwnership()

        public static func open(
            configuration: OliphauntConfiguration = .init(),
            options: OliphauntBrokerOptions = .init()
        ) async throws -> OliphauntDatabase {
            try validate(configuration, options)
            let connection = try acquire()
            do {
                return try await withTaskCancellationHandler {
                    try await connection.launch(configuration, options: options, restoring: false)
                    let database = try await NativeDatabase.connectBroker(
                        fd: connection.socket.fileDescriptor,
                        generation: connection.generation, control: connection,
                        operationTimeoutMs: try options.operationTimeout.map(milliseconds))
                    connection.attach(database)
                    guard database.brokerIsUsable() else {
                        throw OliphauntBrokerError(
                            reason: .workerInterrupted, detail: "worker exited during startup")
                    }
                    try Task.checkCancellation()
                    return try await OliphauntDatabase.open(
                        configuration: configuration,
                        engine: ConnectedEngine(
                            session: BrokerSession(
                                database: database, connection: connection,
                                timeout: options.operationTimeout)))
                } onCancel: {
                    connection.close()
                }
            } catch {
                connection.close()
                throw nativeError(error)
            }
        }

        public static func restore(
            storage: OliphauntDatabaseStorage, from source: URL,
            options: OliphauntBrokerOptions = .init()
        ) async throws {
            let configuration = OliphauntConfiguration(storage: storage)
            try validate(configuration, options)
            let input = try FileHandle(forReadingFrom: source)
            defer { try? input.close() }
            let connection = try acquire()
            defer { connection.close() }
            try await withTaskCancellationHandler {
                try await connection.launch(configuration, options: options, restoring: true)
                do {
                    try await brokerRestore(
                        fd: connection.socket.fileDescriptor, generation: connection.generation,
                        control: connection,
                        operationTimeoutMs: try options.operationTimeout.map(milliseconds),
                        sourceFd: input.fileDescriptor)
                } catch { throw nativeError(error) }
            } onCancel: {
                connection.close()
            }
        }

        private static func acquire() throws -> BrokerConnection {
            try ownership.acquire()
            do { return try BrokerConnection(release: { ownership.release() }) } catch {
                ownership.release()
                throw error
            }
        }

        private static func validate(
            _ configuration: OliphauntConfiguration, _ options: OliphauntBrokerOptions
        ) throws {
            if case .directory = configuration.storage {
                throw OliphauntBrokerXPC.invalid(
                    "broker storage must be applicationData(name:) or temporaryDirectory")
            }
            try validateOliphauntStorage(configuration.storage)
            try validateOliphauntStartupGUCs(configuration.startupGUCs)
            try validateOliphauntStartupIdentity(configuration.username, label: "username")
            try validateOliphauntStartupIdentity(configuration.database, label: "database")
            _ = try validateOliphauntExtensionIds(configuration.extensions.map(\.sqlName))
            let strings =
                configuration.startupGUCs.flatMap { [$0.name, $0.value] }
                + configuration.extensions.map(\.sqlName)
                + [configuration.username, configuration.database].compactMap { $0 }
            guard configuration.startupGUCs.count <= 1024, configuration.extensions.count <= 1024,
                strings.reduce(0, { $0 + $1.utf8.count + 8 }) <= 64 * 1024
            else {
                throw OliphauntBrokerXPC.invalid("broker startup configuration exceeds 64 KiB")
            }
            _ = try milliseconds(options.startupTimeout)
            _ = try options.operationTimeout.map(milliseconds)
        }
    }

    @available(iOS 26, *)
    extension AppExtensionPoint {
        @Definition public static var oliphauntBroker: AppExtensionPoint {
            Name("OliphauntBroker")
            UserInterface(false)
        }
    }

    private final class BrokerOwnership: @unchecked Sendable {
        private let lock = NSLock()
        private var owned = false
        func acquire() throws {
            try lock.withLock {
                guard !owned else {
                    throw OliphauntBrokerError(
                        reason: .databaseInUse,
                        detail: "one broker handle is already open in this application")
                }
                owned = true
            }
        }
        func release() { lock.withLock { owned = false } }
    }

    @available(iOS 26, *)
    private final class BrokerConnection: BrokerControl, @unchecked Sendable {
        let socket: FileHandle
        private let workerSocket: FileHandle
        private let release: @Sendable () -> Void
        private let lock = NSLock()
        private var process: AppExtensionProcess?
        private var control: XPCSession?
        private weak var database: NativeDatabase?
        private var closed = false
        private var interrupted = false
        private var ready: Result<Data, any Error>?
        private var waiter: CheckedContinuation<Data, any Error>?
        private(set) var generation = Data()

        init(release: @escaping @Sendable () -> Void) throws {
            var descriptors: [Int32] = [-1, -1]
            guard socketpair(AF_UNIX, SOCK_STREAM, 0, &descriptors) == 0 else {
                throw POSIXError(.EMFILE)
            }
            guard descriptors.allSatisfy({ fcntl($0, F_SETFD, FD_CLOEXEC) == 0 }) else {
                let error = POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
                descriptors.forEach { _ = Darwin.close($0) }
                throw error
            }
            socket = FileHandle(fileDescriptor: descriptors[0], closeOnDealloc: true)
            workerSocket = FileHandle(fileDescriptor: descriptors[1], closeOnDealloc: true)
            self.release = release
        }

        func launch(
            _ configuration: OliphauntConfiguration, options: OliphauntBrokerOptions,
            restoring: Bool
        ) async throws {
            let deadline = ContinuousClock.now.advanced(by: options.startupTimeout)
            let timer = Task { [self] in
                do {
                    try await ContinuousClock().sleep(until: deadline)
                    complete(
                        .failure(
                            OliphauntBrokerError(
                                reason: .deadline, detail: "broker startup deadline exceeded")))
                    close()
                } catch {}
            }
            defer { timer.cancel() }
            Task { [self] in
                do {
                    let monitor = try await AppExtensionPoint.Monitor(
                        appExtensionPoint: .oliphauntBroker)
                    let expected =
                        Bundle.main.object(
                            forInfoDictionaryKey: "OliphauntBrokerExtensionBundleIdentifier")
                        as? String
                        ?? "\(Bundle.main.bundleIdentifier ?? "").OliphauntBroker"
                    guard
                        let identity = monitor.identities.first(where: {
                            $0.bundleIdentifier == expected
                        })
                    else {
                        throw OliphauntBrokerXPC.invalid(
                            "embedded OliphauntBroker extension is missing; add the signed extension target"
                        )
                    }
                    let acquired = try await AppExtensionProcess(
                        configuration: .init(
                            appExtensionIdentity: identity,
                            onInterruption: { [weak self] in self?.died() }))
                    let keep = lock.withLock {
                        if closed { return false }
                        process = acquired
                        return true
                    }
                    guard keep else {
                        acquired.invalidate()
                        return
                    }
                    let session = try acquired.makeXPCSession()
                    session.setTargetQueue(DispatchQueue(label: "dev.oliphaunt.broker.control"))
                    session.setCancellationHandler { [weak self] _ in self?.died() }
                    session.setIncomingMessageHandler {
                        [weak self] (message: XPCDictionary) -> XPCDictionary? in
                        self?.received(message, restoring: restoring)
                        return nil
                    }
                    try session.activate()
                    let keepSession = lock.withLock {
                        if closed { return false }
                        control = session
                        return true
                    }
                    guard keepSession else {
                        session.cancel(reason: "startup cancelled")
                        return
                    }
                    var message = XPCDictionary()
                    message["kind"] = "open"
                    message["restore"] = restoring
                    if case .applicationData(let name) = configuration.storage {
                        message["name"] = name
                        let parent = try FileManager.default.url(
                            for: .applicationSupportDirectory, in: .userDomainMask,
                            appropriateFor: nil, create: false)
                        message["legacyExists"] = FileManager.default.fileExists(
                            atPath:
                                parent.appendingPathComponent("Oliphaunt/\(name)/.oliphaunt.json")
                                .path)
                    }
                    message["gucNames"] = OliphauntBrokerXPC.strings(
                        configuration.startupGUCs.map(\.name))
                    message["gucValues"] = OliphauntBrokerXPC.strings(
                        configuration.startupGUCs.map(\.value))
                    message["extensions"] = OliphauntBrokerXPC.strings(
                        configuration.extensions.map(\.sqlName))
                    message["username"] = configuration.username
                    message["database"] = configuration.database
                    message["startupMillis"] = try milliseconds(
                        ContinuousClock.now.duration(to: deadline))
                    guard let descriptor = xpc_fd_create(workerSocket.fileDescriptor) else {
                        throw POSIXError(.EBADF)
                    }
                    message["socket"] = descriptor
                    try session.send(message: message)
                    try workerSocket.close()
                } catch {
                    complete(.failure(error))
                    close()
                }
            }
            generation = try await withCheckedThrowingContinuation { continuation in
                let result: Result<Data, any Error>? = lock.withLock {
                    if let ready { return ready }
                    waiter = continuation
                    return nil
                }
                if let result { continuation.resume(with: result) }
            }
        }

        private func received(_ message: XPCDictionary, restoring: Bool) {
            do {
                let kind: String? = message["kind"]
                if kind == "failed" {
                    let reason: String = message["reason"] ?? "database"
                    let detail: String = message["detail"] ?? "broker initialization failed"
                    throw OliphauntBrokerError(
                        reason: .init(rawValue: reason) ?? .database, detail: detail)
                }
                guard kind == "ready" else {
                    throw OliphauntBrokerXPC.invalid("unexpected worker control message")
                }
                let epoch = try OliphauntBrokerXPC.generation(message)
                let abi: UInt64 = message["abi"] ?? 0
                let version: String = message["version"] ?? ""
                guard restoring || (abi == 12 && !version.isEmpty) else {
                    throw OliphauntBrokerError(
                        reason: .incompatibleResources, detail: "incompatible worker runtime")
                }
                complete(.success(epoch))
            } catch {
                complete(.failure(error))
                died()
            }
        }

        private func complete(_ result: Result<Data, any Error>) {
            let continuation = lock.withLock {
                guard ready == nil else { return nil as CheckedContinuation<Data, any Error>? }
                ready = result
                defer { waiter = nil }
                return waiter
            }
            continuation?.resume(with: result)
        }

        func attach(_ value: NativeDatabase) {
            let failed = lock.withLock {
                database = value
                return interrupted || closed
            }
            try? socket.close()
            if failed { value.brokerInterrupted() }
        }

        private func died() {
            let value = lock.withLock {
                interrupted = true
                return database
            }
            value?.brokerInterrupted()
            complete(
                .failure(
                    OliphauntBrokerError(
                        reason: .workerInterrupted,
                        detail: "broker worker exited; close and reopen the database")))
        }

        func cancelRequest(epoch: Data, request: UInt64) -> Bool {
            var message = XPCDictionary()
            message["kind"] = "cancel"
            message["generation"] = epoch.base64EncodedString()
            message["request"] = request
            return send(message)
        }
        func closeWorker(epoch: Data) -> Bool {
            var message = XPCDictionary()
            message["kind"] = "close"
            message["generation"] = epoch.base64EncodedString()
            return send(message)
        }
        private func send(_ message: XPCDictionary) -> Bool {
            guard let control = lock.withLock({ control }) else { return false }
            do {
                try control.send(message: message)
                return true
            } catch { return false }
        }

        func close() {
            let resources = lock.withLock {
                () -> (XPCSession?, AppExtensionProcess?, NativeDatabase?)? in
                guard !closed else { return nil }
                closed = true
                defer {
                    control = nil
                    process = nil
                    database = nil
                }
                return (control, process, database)
            }
            guard let (control, process, database) = resources else { return }
            database?.brokerBeginClose()
            var message = XPCDictionary()
            message["kind"] = "close"
            try? control?.send(message: message)
            control?.cancel(reason: "broker handle closed")
            process?.invalidate()
            try? socket.close()
            try? workerSocket.close()
            complete(.failure(CancellationError()))
            release()
        }
        deinit { close() }
    }

    @available(iOS 26, *)
    private struct ConnectedEngine: OliphauntEngine {
        let session: BrokerSession
        func open(configuration: OliphauntConfiguration) async throws -> any OliphauntSession {
            session
        }
        func restore(destination: URL, bytes: Data) async throws {
            throw OliphauntBrokerXPC.invalid("use OliphauntBroker.restore")
        }
    }

    @available(iOS 26, *)
    private final class BrokerSession: OliphauntSession, Sendable {
        private let database: NativeDatabase
        private let session: NativeDirectSession
        private let connection: BrokerConnection
        let operationTimeout: Duration?
        init(database: NativeDatabase, connection: BrokerConnection, timeout: Duration?) {
            self.operationTimeout = timeout
            self.database = database
            self.session = NativeDirectSession(database: database)
            self.connection = connection
        }
        func execProtocolRaw(_ bytes: Data) async throws -> Data {
            try await session.execProtocolRaw(bytes)
        }
        func execProtocolRawUncancelled(_ bytes: Data) async throws -> Data {
            try await session.execProtocolRawUncancelled(bytes)
        }
        func execProtocolRawStream(
            _ bytes: Data, onChunk: @escaping @Sendable (Data) throws -> Void
        ) async throws -> OliphauntProtocolStreamOutcome {
            try await session.execProtocolRawStream(bytes, onChunk: onChunk)
        }
        func backup() async throws -> Data { try await session.backup() }
        func backup(to destination: URL) async throws { try await session.backup(to: destination) }
        func cancel() async throws { try await session.cancel() }
        func beginOperation(remaining: Duration?) {
            database.brokerOperationBudget(
                remainingMs: remaining.map { $0 <= .zero ? 0 : (try? milliseconds($0)) ?? 0 })
        }
        func isUsable() -> Bool { database.brokerIsUsable() }
        func beginClose() { database.brokerBeginClose() }
        func close() async throws {
            defer { connection.close() }
            try await session.close()
        }
    }

    private func milliseconds(_ duration: Duration) throws -> UInt64 {
        let components = duration.components
        guard duration > .zero, components.seconds < Int64.max / 1000 else {
            throw OliphauntBrokerError(
                reason: .invalidRequest, detail: "broker timeouts must be positive finite durations"
            )
        }
        return UInt64(
            max(1, components.seconds * 1000 + components.attoseconds / 1_000_000_000_000_000))
    }
#endif
