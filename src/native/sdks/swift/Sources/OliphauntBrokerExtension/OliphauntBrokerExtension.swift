#if os(iOS)
    import Darwin
    import Foundation
    import Oliphaunt
    import OliphauntCore
    import OliphauntNativeBindings
    import XPC

    /// The extension template installs one peer per accepted native connection.
    /// PostgreSQL work runs on the shared Rust owner, never on the XPC queue.
    @available(iOS 26, *)
    public final class OliphauntBrokerExtensionPeer: XPCPeerHandler, @unchecked Sendable {
        public typealias Input = XPCDictionary
        public typealias Output = XPCDictionary
        private let session: XPCSession
        private let extensions: [OliphauntExtension]
        private let lock = NSLock()
        private var worker: NativeBrokerWorker?
        private var opened = false
        private var closed = false

        public init(session: XPCSession, extensions: [OliphauntExtension] = []) {
            precondition(
                Bundle.main.bundleURL.pathExtension == "appex",
                "broker worker requires an app extension")
            self.session = session
            self.extensions = extensions
        }

        public func handleIncomingRequest(_ message: XPCDictionary) -> XPCDictionary? {
            do {
                let kind: String? = message["kind"]
                switch kind {
                case "open": try open(message)
                case "cancel":
                    let generation = try OliphauntBrokerXPC.generation(message)
                    guard let request: UInt64 = message["request"] else {
                        throw OliphauntBrokerXPC.invalid("missing request")
                    }
                    try lock.withLock {
                        try worker?.cancelRequest(generation: generation, request: request)
                    }
                case "close":
                    // A connection may close during preparation, before it knows the epoch.
                    try lock.withLock {
                        if let worker {
                            let supplied: String? = message["generation"]
                            if supplied != nil,
                                try OliphauntBrokerXPC.generation(message) != worker.generation()
                            {
                                return
                            }
                            closed = true
                            try worker.close(generation: worker.generation())
                        } else {
                            closed = true
                        }
                    }
                default: throw OliphauntBrokerXPC.invalid("unknown broker control message")
                }
            } catch { sendFailure(error) }
            return nil
        }

        public func handleCancellation(error: XPCRichError) {
            lock.withLock {
                closed = true
                if let worker { try? worker.close(generation: worker.generation()) }
            }
        }

        private func open(_ message: XPCDictionary) throws {
            let accepted = lock.withLock {
                guard !opened, !closed else { return false }
                opened = true
                return true
            }
            guard accepted else {
                throw OliphauntBrokerError(
                    reason: .databaseInUse, detail: "worker is already owned")
            }
            guard let descriptor: xpc_object_t = message["socket"],
                xpc_get_type(descriptor) == XPC_TYPE_FD,
                let timeout: UInt64 = message["startupMillis"], timeout > 0
            else {
                throw OliphauntBrokerXPC.invalid("missing socket or startup deadline")
            }
            let restoring: Bool = message["restore"] ?? false
            let name: String? = message["name"]
            let legacyExists: Bool = message["legacyExists"] ?? false
            let username: String? = message["username"]
            let database: String? = message["database"]
            let names = try OliphauntBrokerXPC.strings(message, "gucNames")
            let values = try OliphauntBrokerXPC.strings(message, "gucValues")
            let selected = try OliphauntBrokerXPC.strings(message, "extensions")
            guard names.count == values.count,
                (names + values + selected + [name, username, database].compactMap { $0 })
                    .reduce(0, { $0 + $1.utf8.count + 8 }) <= 64 * 1024 else {
                throw OliphauntBrokerXPC.invalid("invalid or oversized startup settings")
            }
            let fd = xpc_fd_dup(descriptor)
            guard fd >= 0 else { throw POSIXError(.EBADF) }
            defer { Darwin.close(fd) }
            let native = try NativeBrokerWorker.create(
                fd: fd, retirement: ExtensionRetirement(), startupTimeoutMs: timeout)
            try lock.withLock {
                worker = native
                if closed { try native.close(generation: native.generation()) }
            }
            Task.detached { [self, native] in
                do {
                    let root = try storage(
                        name: name, legacyExists: legacyExists,
                        restoring: restoring)
                    if restoring {
                        sendReady(generation: native.generation(), abi: 0, version: "")
                        try await native.restore(libraryPath: nil, destination: root.path)
                    } else {
                        let available = Dictionary(
                            extensions.map { ($0.sqlName, $0) },
                            uniquingKeysWith: { first, _ in first })
                        let configuration = OliphauntConfiguration(
                            storage: .directory(root),
                            startupGUCs: zip(names, values).map { OliphauntStartupGUC($0, $1) },
                            username: username, database: database,
                            extensions: try selected.map {
                                try available[$0] ?? OliphauntExtension(sqlName: $0)
                            })
                        let options = try OliphauntNativeDirectEngine().prepare(
                            configuration: configuration)
                        try verifyProtection(root)
                        let ready = try await native.open(options: options)
                        sendReady(
                            generation: ready.generation, abi: ready.abi,
                            version: ready.runtimeVersion)
                        try await native.serve()
                    }
                } catch {
                    sendFailure(error)
                    native.retire()
                }
            }
        }

        private func sendReady(generation: Data, abi: UInt32, version: String) {
            var message = XPCDictionary()
            message["kind"] = "ready"
            message["generation"] = generation.base64EncodedString()
            message["abi"] = UInt64(abi)
            message["version"] = version
            try? session.send(message: message)
        }

        private func sendFailure(_ error: any Error) {
            var message = XPCDictionary()
            message["kind"] = "failed"
            message["reason"] = (error as? OliphauntBrokerError)?.reason.rawValue ?? "database"
            message["detail"] = String(String(describing: error).prefix(1024))
            try? session.send(message: message)
        }

        private func storage(name: String?, legacyExists: Bool, restoring: Bool) throws -> URL {
            let manager = FileManager.default
            let parent: URL
            if name != nil {
                parent = try manager.url(
                    for: .applicationSupportDirectory, in: .userDomainMask,
                    appropriateFor: nil, create: true
                ).appendingPathComponent("Oliphaunt", isDirectory: true)
            } else {
                parent = manager.temporaryDirectory.appendingPathComponent(
                    "Oliphaunt", isDirectory: true)
            }
            if let name { try validateOliphauntDatabaseName(name) }
            let root = parent.appendingPathComponent(name ?? UUID().uuidString, isDirectory: true)
            if !manager.fileExists(atPath: root.path), legacyExists, !restoring {
                throw OliphauntBrokerError(
                    reason: .migrationRequired,
                    detail:
                        "a direct database with this name exists; export, close, and restore it into broker storage"
                )
            }
            try manager.createDirectory(
                at: parent, withIntermediateDirectories: true,
                attributes: [
                    .protectionKey: FileProtectionType.completeUntilFirstUserAuthentication
                ])
            try manager.setAttributes(
                [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
                ofItemAtPath: parent.path)
            var excluded = parent
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            try excluded.setResourceValues(values)
            if !restoring, !manager.fileExists(atPath: root.path) {
                try manager.createDirectory(
                    at: root, withIntermediateDirectories: false,
                    attributes: [
                        .protectionKey: FileProtectionType.completeUntilFirstUserAuthentication
                    ])
            }
            return root
        }

        private func verifyProtection(_ root: URL) throws {
            // The simulator does not implement iOS Data Protection or its file attributes.
            #if !targetEnvironment(simulator)
            guard
                let tree = FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil)
            else {
                throw OliphauntBrokerError(
                    reason: .storage, detail: "cannot inspect protected database storage")
            }
            for case let url as URL in tree {
                let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
                guard
                    attributes[.protectionKey] as? FileProtectionType
                        == .completeUntilFirstUserAuthentication
                else {
                    throw OliphauntBrokerError(
                        reason: .storage, detail: "database storage did not inherit file protection")
                }
            }
            #endif
        }
    }

    private final class ExtensionRetirement: BrokerRetirement, Sendable {
        func retire() { _exit(0) }
    }
#endif
