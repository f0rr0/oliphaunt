import ExtensionFoundation
import Foundation
import OliphauntBrokerProtocol
import SwiftUI
import UIKit
import XPC

extension AppExtensionPoint {
    @Definition
    static var oliphauntBrokerSpike: AppExtensionPoint {
        Name("OliphauntBroker")
        UserInterface(false)
    }
}

enum BrokerFixtureBundleIdentifiers {
    static let extensionBundleIdentifier = "dev.oliphaunt.brokerspike.extension"
}

@main
struct BrokerSpikeApp: App {
    @UIApplicationDelegateAdaptor(BrokerSpikeAppDelegate.self)
    private var appDelegate
    @State private var model = BrokerSpikeModel()

    var body: some Scene {
        WindowGroup {
            BrokerSpikeView(model: model)
        }
    }
}

private struct BrokerSpikeView: View {
    let model: BrokerSpikeModel

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text("Oliphaunt iOS NativeBroker")
                    .font(.title2.monospaced())
                Text(model.status)
                    .font(.body.monospaced())
                    .textSelection(.enabled)
                    .accessibilityIdentifier("broker-spike-status")
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding()
        }
        .task {
            await model.runIfNeeded()
        }
    }
}

private enum BrokerFixtureApplicationLifecycle {
    static let events = BrokerHostLifecycleEventSource()
}

@MainActor
private final class BrokerSpikeAppDelegate: NSObject, UIApplicationDelegate {
    private let events = BrokerFixtureApplicationLifecycle.events
    private let managesDisplayIdleTimer =
        ProcessInfo.processInfo.environment[
            "OLIPHAUNT_BROKER_FIXTURE_DISABLE_IDLE_TIMER"
        ] == "YES"

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        let notifications = NotificationCenter.default
        notifications.addObserver(
            self,
            selector: #selector(didBecomeActive(_:)),
            name: UIApplication.didBecomeActiveNotification,
            object: nil
        )
        notifications.addObserver(
            self,
            selector: #selector(willResignActive(_:)),
            name: UIApplication.willResignActiveNotification,
            object: nil
        )
        notifications.addObserver(
            self,
            selector: #selector(didEnterBackground(_:)),
            name: UIApplication.didEnterBackgroundNotification,
            object: nil
        )
        notifications.addObserver(
            self,
            selector: #selector(willEnterForeground(_:)),
            name: UIApplication.willEnterForegroundNotification,
            object: nil
        )
        notifications.addObserver(
            self,
            selector: #selector(didReceiveMemoryWarning(_:)),
            name: UIApplication.didReceiveMemoryWarningNotification,
            object: nil
        )
        publish(application.applicationState)
        return true
    }

    @objc private func didBecomeActive(_ notification: Notification) {
        publish(.active)
    }

    @objc private func willResignActive(_ notification: Notification) {
        publish(.inactive)
    }

    @objc private func didEnterBackground(_ notification: Notification) {
        publish(.background)
    }

    @objc private func willEnterForeground(_ notification: Notification) {
        publish(.inactive)
    }

    @objc private func didReceiveMemoryWarning(_ notification: Notification) {
        events.send(.memoryWarning)
    }

    private func publish(_ state: UIApplication.State) {
        if managesDisplayIdleTimer {
            UIApplication.shared.isIdleTimerDisabled = state == .active
        }
        switch state {
        case .active:
            events.send(.active)
        case .inactive:
            events.send(.inactive)
        case .background:
            events.send(.background)
        @unknown default:
            break
        }
    }
}

@MainActor
@Observable
final class BrokerSpikeModel {
    private(set) var status = "STARTING"
    private var started = false
    #if canImport(OliphauntIOSBroker)
        private let lifecycleEvents = BrokerFixtureApplicationLifecycle.events
    #endif
    #if !canImport(OliphauntIOSBroker)
        private var process: AppExtensionProcess?
        private var session: XPCSession?
    #endif

    func runIfNeeded() async {
        guard !started else { return }
        started = true
        do {
            #if canImport(OliphauntIOSBroker)
                let mode =
                    ProcessInfo.processInfo.environment[
                        "OLIPHAUNT_BROKER_FIXTURE_MODE"
                    ] ?? "default"
                let result: BrokerProbeResult
                switch mode {
                case "default", "foreground", "semantic":
                    result = try await NativeBrokerFixture.run()
                case "lifecycle":
                    result = try await DeviceLifecycleFixture.run(events: lifecycleEvents)
                #if DEBUG
                    case "extendedFaults":
                        result = try await ExtendedFaultMatrix.run()
                    case "hang":
                        result = try await HangFaultMatrix.run()
                #endif
                case "handshakeNegatives":
                    result = try await HandshakeNegativeMatrix.run()
                default:
                    throw BrokerFixtureModeFailure.unknown(mode)
                }
            #else
                let result = try await BrokerPlatformProbe.run { process, session in
                    self.process = process
                    self.session = session
                }
            #endif
            status =
                "PASS\nhostPID=\(result.hostPID)\nworkerPID=\(result.workerPID)\nepoch=\(result.epoch)\nchecks=\(result.checks.joined(separator: ","))"
            let reportData = try persist(result: result, error: nil)
            if let reportJSON = String(data: reportData, encoding: .utf8) {
                print("OLIPHAUNT_BROKER_SPIKE_JSON \(reportJSON)")
            }
            print("OLIPHAUNT_BROKER_SPIKE PASS \(result.logSummary)")
        } catch {
            status = "FAIL\n\(error)"
            _ = try? persist(result: nil, error: String(describing: error))
            print("OLIPHAUNT_BROKER_SPIKE FAIL \(error)")
        }
    }

    @discardableResult
    private func persist(result: BrokerProbeResult?, error: String?) throws -> Data {
        let report = BrokerProbeReport(result: result, error: error)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let data = try encoder.encode(report)
        let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        try data.write(
            to: documents.appendingPathComponent("broker-spike-report.json"),
            options: .atomic
        )
        return data
    }
}

private enum BrokerFixtureModeFailure: Error, CustomStringConvertible {
    case unknown(String)

    var description: String {
        switch self {
        case .unknown(let value):
            "unknown OLIPHAUNT_BROKER_FIXTURE_MODE \(String(reflecting: value))"
        }
    }
}

private struct BrokerProbeReport: Codable {
    var result: BrokerProbeResult?
    var error: String?
}

struct BrokerProbeResult: Codable {
    var hostPID: Int32
    var workerPID: Int32
    var epoch: String
    var checks: [String]
    var recoveredEpochs: [String] = []
    var diagnostics: [BrokerDiagnosticEvidence] = []
    var observations: [String: String] = [:]

    var logSummary: String {
        "hostPID=\(hostPID) workerPID=\(workerPID) epoch=\(epoch) checks=\(checks.joined(separator: ","))"
    }
}

struct BrokerDiagnosticEvidence: Codable {
    var phase: String
    var managerState: String
    var epoch: String?
    var workerPID: Int32?
    var logicalHandleCount: Int
    var queuedOperationCount: Int
    var activeRequestID: UInt64?
    var launchCount: UInt64
    var interruptionCount: UInt64
    var admissionsPaused: Bool = false
    var workerState: String?
    var transactionStatus: String?
    var manifestDigest: String?
    var currentPhysFootprintBytes: UInt64?
    var currentResidentBytes: UInt64?
    var availableMemoryBytes: UInt64?
    var nativeDispatchStarted: Bool = false
    var checkpointInProgress: Bool = false
    var storageProtectionEvidenceJSON: String?
    var extensionEntryPreOpenPhysFootprintBytes: UInt64?
    var extensionEntryPreOpenResidentBytes: UInt64?
    var openedIdlePhysFootprintBytes: UInt64?
    var openedIdleResidentBytes: UInt64?
}
