import Foundation
import Testing

@testable import OliphauntCore

@Test func brokerRejectionPreservesSessionAndUnknownPoisonsLaterWork() async throws {
    let session = BrokerTestSession()
    let database = try await OliphauntDatabase.open(engine: BrokerTestEngine(session: session))
    do {
        _ = try await database.execProtocolRaw(Data([1]))
        Issue.record("expected rejection")
    } catch let error as OliphauntBrokerError { #expect(!error.requiresReopen) }
    #expect(try await database.execProtocolRaw(Data([2])) == Data([2]))
    do {
        _ = try await database.execProtocolRaw(Data([3]))
        Issue.record("expected interruption")
    } catch let error as OliphauntBrokerError { #expect(error.execution == .unknown) }
    do {
        _ = try await database.execProtocolRaw(Data([4]))
        Issue.record("expected unusable handle")
    } catch let error as OliphauntBrokerError {
        #expect(error.execution == .notStarted)
        #expect(error.requiresReopen)
    }
    #expect(await session.calls == 3)
    try await database.close()
}

private struct BrokerTestEngine: OliphauntEngine {
    let session: BrokerTestSession
    func open(configuration: OliphauntConfiguration) async throws -> any OliphauntSession {
        session
    }
    func restore(destination: URL, bytes: Data) async throws { fatalError("unused") }
}
private actor BrokerTestSession: OliphauntSession {
    nonisolated let failClose: Bool
    init(failClose: Bool = false) { self.failClose = failClose }
    nonisolated func isUsable() -> Bool { !failClose }
    private(set) var calls = 0
    func execProtocolRaw(_ bytes: Data) async throws -> Data {
        calls += 1
        if bytes.first == 1 {
            throw OliphauntBrokerError(
                reason: .invalidRequest, requiresReopen: false, detail: "invalid group")
        }
        if bytes.first == 3 {
            throw OliphauntBrokerError(
                reason: .workerInterrupted, execution: .unknown, detail: "terminal lost")
        }
        return bytes
    }
    func execProtocolRawStream(
        _ bytes: Data, onChunk: @escaping @Sendable (Data) throws -> Void
    ) async throws -> OliphauntProtocolStreamOutcome { fatalError("unused") }
    func backup() async throws -> Data { fatalError("unused") }
    func cancel() async throws {}
    func close() async throws {
        if failClose {
            throw OliphauntBrokerError(
                reason: .workerInterrupted, execution: .unknown,
                detail: "worker retired before close receipt")
        }
    }
}

@Test func brokerTerminalCloseReleasesFacadeEvenWhenReceiptIsLost() async throws {
    let database = try await OliphauntDatabase.open(
        engine: BrokerTestEngine(session: BrokerTestSession(failClose: true)))
    await #expect(throws: OliphauntBrokerError.self) { try await database.close() }
    #expect(await database.isClosed)
    try await database.close()
}
