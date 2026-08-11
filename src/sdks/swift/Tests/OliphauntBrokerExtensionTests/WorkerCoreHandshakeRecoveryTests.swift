import Foundation
import Oliphaunt
import OliphauntBrokerExtension
import OliphauntBrokerProtocol
import Testing

@Test
func rejectedHelloDoesNotPoisonTheResidentWorkerProcess() async throws {
    let root = FileManager.default.temporaryDirectory
        .appendingPathComponent("oliphaunt-worker-handshake-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: root) }

    let engine = HandshakeFailingOpenEngine()
    let configuration = try BrokerWorkerConfiguration(
        storage: BrokerExtensionStorage(location: .extensionPrivate, rootURL: root),
        engine: engine,
        liboliphauntVersion: "handshake-test-runtime",
        cABIVersion: 42,
        postgresMajorVersion: 18,
        startupConfigurationDigest: "handshake-test-configuration",
        runtimeVersionProvider: { "handshake-test-runtime" }
    )
    let core = WorkerCore(configuration: configuration)
    let originalEpoch = await core.epoch
    let valid = BrokerHello(
        expectedABI: 42,
        expectedRuntimeVersion: "handshake-test-runtime",
        startupConfigurationDigest: "handshake-test-configuration",
        requestedCapabilities: [.protocolRaw, .protocolStream, .queryCancel]
    )

    var incompatibleProtocol = valid
    incompatibleProtocol.minimumProtocolVersion = 99
    incompatibleProtocol.maximumProtocolVersion = 99
    await expectHandshakeRejection(.incompatibleProtocol) {
        try await core.start(hello: incompatibleProtocol)
    }

    var incompatibleABI = valid
    incompatibleABI.expectedABI = 43
    await expectHandshakeRejection(.incompatibleABI) {
        try await core.start(hello: incompatibleABI)
    }

    var runtimeMismatch = valid
    runtimeMismatch.expectedRuntimeVersion = "wrong-runtime"
    await expectHandshakeRejection(.runtimeMismatch) {
        try await core.start(hello: runtimeMismatch)
    }

    var rootMismatch = valid
    rootMismatch.rootID = "wrong-root"
    await expectHandshakeRejection(.rootMismatch) {
        try await core.start(hello: rootMismatch)
    }

    var configurationMismatch = valid
    configurationMismatch.startupConfigurationDigest = "wrong-configuration"
    await expectHandshakeRejection(.invalidConfiguration) {
        try await core.start(hello: configurationMismatch)
    }

    let diagnostics = try await core.diagnostics(expectedEpoch: originalEpoch)
    #expect(diagnostics.state == .created)
    #expect(diagnostics.epoch == originalEpoch)
    #expect(await engine.openCount() == 0)

    do {
        _ = try await core.start(hello: valid)
        Issue.record("the deliberately failing engine unexpectedly opened")
    } catch let error as BrokerError {
        #expect(error == .rejected(.rootOpen))
        #expect(!error.description.contains(extensionPrivatePathSentinel))
        #expect(!error.description.lowercased().contains("pgdata"))
    } catch {
        Issue.record("valid Hello did not reach the engine: \(error)")
    }
    #expect(await engine.openCount() == 1)
}

private enum ExpectedHandshakeError {
    case incompatibleProtocol
    case incompatibleABI
    case runtimeMismatch
    case rootMismatch
    case invalidConfiguration

    func matches(_ error: BrokerError) -> Bool {
        switch (self, error) {
        case (.incompatibleProtocol, .incompatibleProtocol),
            (.incompatibleABI, .incompatibleABI),
            (.runtimeMismatch, .runtimeMismatch),
            (.rootMismatch, .rootMismatch),
            (.invalidConfiguration, .invalidConfiguration):
            true
        default:
            false
        }
    }
}

private func expectHandshakeRejection(
    _ expected: ExpectedHandshakeError,
    operation: () async throws -> BrokerReady
) async {
    do {
        _ = try await operation()
        Issue.record("mismatched Hello unexpectedly succeeded")
    } catch let error as BrokerError {
        #expect(expected.matches(error))
    } catch {
        Issue.record("mismatched Hello returned an unstructured error: \(error)")
    }
}

private let extensionPrivatePathSentinel =
    "/private/var/mobile/Containers/Data/PluginKitPlugin/worker-open-sentinel/pgdata"

private struct HandshakeOpenError: Error, CustomStringConvertible {
    var description: String {
        "native direct open failed at \(extensionPrivatePathSentinel)"
    }
}

private actor HandshakeFailingOpenEngine: OliphauntEngine {
    private var count = 0

    func open(configuration: OliphauntConfiguration) async throws -> any OliphauntSession {
        count += 1
        throw HandshakeOpenError()
    }

    func restore(_ request: OliphauntRestoreRequest) async throws -> URL {
        throw HandshakeOpenError()
    }

    func openCount() -> Int {
        count
    }
}
