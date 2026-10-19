import Foundation

/// Execution certainty and handle usability are separate from retry safety.
public struct OliphauntBrokerError: Error, Equatable, Sendable, CustomStringConvertible {
    public enum Reason: String, Sendable {
        case invalidRequest, cancelled, deadline, workerInterrupted, transport, database, callback
        case databaseInUse, migrationRequired, storage, incompatibleResources
    }
    public enum Execution: String, Sendable { case notStarted, completed, unknown }
    public let reason: Reason
    public let execution: Execution
    public let requiresReopen: Bool
    public let detail: String
    public var description: String { detail }

    package init(
        reason: Reason, execution: Execution = .notStarted, requiresReopen: Bool = true,
        detail: String
    ) {
        self.reason = reason
        self.execution = execution
        self.requiresReopen = requiresReopen
        self.detail = detail
    }
    package var unsubmitted: Self {
        .init(
            reason: reason, execution: .notStarted, requiresReopen: requiresReopen, detail: detail)
    }
}
