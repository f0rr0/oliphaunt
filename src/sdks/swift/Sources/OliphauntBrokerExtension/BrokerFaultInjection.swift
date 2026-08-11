import Dispatch
import Foundation
import OliphauntBrokerProtocol

#if DEBUG
    import Darwin

    /// DEBUG-only, one-shot crash and hang hooks for simulator qualification.
    /// This type is not present in release builds.
    public final class BrokerFaultInjector: @unchecked Sendable {
        private struct ArmedFault {
            var fault: BrokerWorkerFault
            var responseChunkThreshold: Int
            var nativeDelay: Duration
        }

        private let lock = NSLock()
        private var armed: ArmedFault?
        private var responseChunks = 0

        public init() {}

        public func inject(
            _ fault: BrokerWorkerFault,
            afterResponseChunks: Int = 1,
            duringNativeDelay: Duration = .milliseconds(50)
        ) {
            precondition(afterResponseChunks > 0)
            switch fault {
            case .abort, .invalidMemoryAccess, .deadlock, .deadlockWithFailStop:
                trigger(fault)
            default:
                lock.withFaultLock {
                    armed = ArmedFault(
                        fault: fault,
                        responseChunkThreshold: afterResponseChunks,
                        nativeDelay: duringNativeDelay
                    )
                    responseChunks = 0
                }
            }
        }

        /// Arms the next registered native request to wedge WorkerCore. The
        /// InjectFault XPC handler can therefore acknowledge before the actor is
        /// deliberately blocked.
        func armDeadlockAfterNativeRequestRegistration(failStop: Bool = false) {
            lock.withFaultLock {
                armed = ArmedFault(
                    fault: failStop ? .deadlockWithFailStop : .deadlock,
                    responseChunkThreshold: 1,
                    nativeDelay: .zero
                )
                responseChunks = 0
            }
        }

        func beforeNativeDispatch() {
            triggerIfArmed(.beforeNativeDispatch)
        }

        func afterNativeRequestRegistration() {
            triggerIfArmed(.deadlockWithFailStop)
            triggerIfArmed(.deadlock)
        }

        func beginNativeExecution() -> DispatchWorkItem? {
            let delay: Duration? = lock.withFaultLock {
                guard armed?.fault == .duringNativeExecution else { return nil }
                let value = armed?.nativeDelay
                armed = nil
                return value
            }
            guard let delay else { return nil }
            let workItem = DispatchWorkItem { trigger(.duringNativeExecution) }
            let nanoseconds = max(0, durationNanoseconds(delay))
            DispatchQueue.global(qos: .userInitiated).asyncAfter(
                deadline: .now() + .nanoseconds(Int(clamping: nanoseconds)),
                execute: workItem
            )
            return workItem
        }

        func afterResponseChunk() {
            let shouldTrigger = lock.withFaultLock {
                guard let armed, armed.fault == .afterResponseChunks else { return false }
                responseChunks += 1
                if responseChunks >= armed.responseChunkThreshold {
                    self.armed = nil
                    return true
                }
                return false
            }
            if shouldTrigger { trigger(.afterResponseChunks) }
        }

        func afterNativeSuccessBeforeCompleted() {
            triggerIfArmed(.afterNativeSuccessBeforeCompleted)
        }

        func duringCheckpoint() {
            triggerIfArmed(.duringCheckpoint)
        }

        private func triggerIfArmed(_ fault: BrokerWorkerFault) {
            let shouldTrigger = lock.withFaultLock {
                guard armed?.fault == fault else { return false }
                armed = nil
                return true
            }
            if shouldTrigger { trigger(fault) }
        }
    }

    private func trigger(_ fault: BrokerWorkerFault) -> Never {
        switch fault {
        case .deadlock:
            DispatchSemaphore(value: 0).wait()
            fatalError("unreachable after broker deadlock fault")
        case .deadlockWithFailStop:
            DispatchQueue.global(qos: .userInitiated).asyncAfter(
                deadline: .now() + .seconds(1)
            ) {
                Darwin._exit(70)
            }
            DispatchSemaphore(value: 0).wait()
            fatalError("unreachable after broker fail-stop deadlock fault")
        case .invalidMemoryAccess:
            raise(SIGSEGV)
            fatalError("SIGSEGV handler unexpectedly returned")
        default:
            abort()
        }
    }

    private func durationNanoseconds(_ duration: Duration) -> Int64 {
        let components = duration.components
        let seconds = components.seconds.multipliedReportingOverflow(by: 1_000_000_000)
        guard !seconds.overflow else {
            return components.seconds >= 0 ? Int64.max : Int64.min
        }
        let attoseconds = components.attoseconds / 1_000_000_000
        let sum = seconds.partialValue.addingReportingOverflow(attoseconds)
        guard !sum.overflow else {
            return seconds.partialValue >= 0 ? Int64.max : Int64.min
        }
        return sum.partialValue
    }

    extension NSLock {
        fileprivate func withFaultLock<Result>(_ body: () -> Result) -> Result {
            lock()
            defer { unlock() }
            return body()
        }
    }
#endif
