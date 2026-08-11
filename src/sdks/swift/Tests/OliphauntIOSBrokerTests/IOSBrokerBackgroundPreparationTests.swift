import Oliphaunt
import Testing

@testable import OliphauntIOSBroker

@available(iOS 26.0, macOS 26.0, *)
@Test
func backgroundPreparationPreservesHostObservedActiveCancellation() {
    let worker = OliphauntBackgroundPreparationResult(
        cancelledActiveWork: false,
        checkpointed: true
    )

    let merged = IOSBrokerManager.mergeBackgroundPreparationResult(
        hostCancelledActiveWork: true,
        workerResult: worker
    )

    #expect(merged.cancelledActiveWork)
    #expect(merged.checkpointed)
    #expect(merged.skippedCheckpointReason == nil)
}

@available(iOS 26.0, macOS 26.0, *)
@Test
func backgroundPreparationPreservesWorkerSkipReason() {
    let worker = OliphauntBackgroundPreparationResult(
        cancelledActiveWork: true,
        checkpointed: false,
        skippedCheckpointReason: .activeWork
    )

    let merged = IOSBrokerManager.mergeBackgroundPreparationResult(
        hostCancelledActiveWork: false,
        workerResult: worker
    )

    #expect(merged.cancelledActiveWork)
    #expect(!merged.checkpointed)
    #expect(merged.skippedCheckpointReason == .activeWork)
}
