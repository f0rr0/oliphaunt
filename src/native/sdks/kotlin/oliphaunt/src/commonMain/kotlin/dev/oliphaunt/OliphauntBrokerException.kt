package dev.oliphaunt

public enum class BrokerFailureReason {
    InvalidRequest,
    Cancelled,
    Deadline,
    WorkerInterrupted,
    Transport,
    Database,
    Callback,
    DatabaseInUse,
    MigrationRequired,
    Storage,
    IncompatibleResources,
}

public enum class BrokerExecution { NotStarted, Completed, Unknown }

/** Execution certainty does not imply that replay is safe. */
public class OliphauntBrokerException internal constructor(
    public val reason: BrokerFailureReason,
    public val execution: BrokerExecution,
    public val requiresReopen: Boolean,
    message: String,
) : OliphauntException(message) {
    internal fun unsubmitted(): OliphauntBrokerException = OliphauntBrokerException(reason, BrokerExecution.NotStarted, requiresReopen, message.orEmpty())
}
