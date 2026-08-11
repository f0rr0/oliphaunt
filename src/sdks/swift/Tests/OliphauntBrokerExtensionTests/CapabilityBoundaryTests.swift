import Foundation
import Oliphaunt
import OliphauntBrokerExtension
import OliphauntBrokerProtocol
import Testing

@Test
func workerReportsTheConservativeArchiveAndServerCapabilities() throws {
    let configuration = try archiveBoundaryConfiguration()
    #expect(!configuration.capabilities.backupRestore)
    #expect(configuration.capabilities.connectionString == nil)
    #expect(!configuration.capabilities.serverMode)
}

@Test
func backupIsRejectedBeforeNativeDispatch() async throws {
    try await expectUnsupportedArchiveOperation("backup")
}

@Test
func restoreIsRejectedBeforeNativeDispatch() async throws {
    try await expectUnsupportedArchiveOperation("restore")
}

private func expectUnsupportedArchiveOperation(_ operation: String) async throws {
    let configuration = try archiveBoundaryConfiguration()
    let core = WorkerCore(configuration: configuration)
    do {
        try await core.rejectBackupOrRestore()
        Issue.record("\(operation) unexpectedly crossed the broker boundary")
    } catch let error as BrokerError {
        guard case .rejected(.unsupportedCapability(let capability)) = error else {
            Issue.record("expected unsupported backupRestore rejection, got \(error)")
            return
        }
        #expect(capability == .backupRestore)
    }
}

private func archiveBoundaryConfiguration() throws -> BrokerWorkerConfiguration {
    let root = FileManager.default.temporaryDirectory
        .appendingPathComponent("oliphaunt-broker-archive-boundary-\(UUID().uuidString)")

    let storage = try BrokerExtensionStorage(
        location: .extensionPrivate,
        rootURL: root
    )
    return try BrokerWorkerConfiguration(
        storage: storage,
        engine: RuntimeUnavailableEngine(),
        liboliphauntVersion: "archive-boundary-test",
        startupConfigurationDigest: "archive-boundary-test"
    )
}
