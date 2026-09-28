package dev.oliphaunt

import dev.oliphaunt.bindings.NativeException

internal fun NativeException.Broker.toPublicError(): OliphauntBrokerException = OliphauntBrokerException(
    when (reason) {
        dev.oliphaunt.bindings.BrokerReason.INVALID_REQUEST -> BrokerFailureReason.InvalidRequest
        dev.oliphaunt.bindings.BrokerReason.CANCELLED -> BrokerFailureReason.Cancelled
        dev.oliphaunt.bindings.BrokerReason.DEADLINE -> BrokerFailureReason.Deadline
        dev.oliphaunt.bindings.BrokerReason.WORKER_INTERRUPTED -> BrokerFailureReason.WorkerInterrupted
        dev.oliphaunt.bindings.BrokerReason.TRANSPORT -> BrokerFailureReason.Transport
        dev.oliphaunt.bindings.BrokerReason.DATABASE -> BrokerFailureReason.Database
        dev.oliphaunt.bindings.BrokerReason.CALLBACK -> BrokerFailureReason.Callback
    },
    when (execution) {
        dev.oliphaunt.bindings.BrokerExecution.NOT_STARTED -> BrokerExecution.NotStarted
        dev.oliphaunt.bindings.BrokerExecution.COMPLETED -> BrokerExecution.Completed
        dev.oliphaunt.bindings.BrokerExecution.UNKNOWN -> BrokerExecution.Unknown
    },
    requiresReopen,
    detail,
)

internal fun brokerError(reason: BrokerFailureReason, detail: String): OliphauntBrokerException = OliphauntBrokerException(reason, BrokerExecution.NotStarted, true, detail)
