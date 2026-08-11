import Foundation
import OliphauntBrokerProtocol
import Testing

private func hello(
    minimumVersion: UInt16 = 1,
    maximumVersion: UInt16 = 1,
    expectedABI: UInt32 = 6,
    expectedRuntimeVersion: String? = "0.4.0",
    rootID: String = OliphauntBrokerProtocol.canonicalRootID,
    digest: String = "configuration-sha256"
) -> BrokerHello {
    BrokerHello(
        minimumProtocolVersion: minimumVersion,
        maximumProtocolVersion: maximumVersion,
        expectedABI: expectedABI,
        expectedRuntimeVersion: expectedRuntimeVersion,
        rootID: rootID,
        startupConfigurationDigest: digest,
        requestedCapabilities: [.processIsolated, .protocolRaw, .protocolStream]
    )
}

@Test
func handshakeNegotiatesHighestMutuallySupportedVersion() throws {
    #expect(OliphauntBrokerProtocol.minimumVersion == 1)
    #expect(OliphauntBrokerProtocol.maximumVersion == 1)
    #expect(try BrokerHandshake.negotiateVersion(hello()) == 1)
    #expect(
        try BrokerHandshake.negotiateVersion(
            hello(minimumVersion: 0, maximumVersion: 2)
        ) == 1
    )

    expectBrokerError(.incompatibleProtocol(minimum: 0, maximum: 0)) {
        try BrokerHandshake.negotiateVersion(hello(minimumVersion: 0, maximumVersion: 0))
    }
    expectBrokerError(.incompatibleProtocol(minimum: 2, maximum: 3)) {
        try BrokerHandshake.negotiateVersion(hello(minimumVersion: 2, maximumVersion: 3))
    }
    expectBrokerError(
        .invalidConfiguration("minimum protocol version exceeds maximum")
    ) {
        try BrokerHandshake.negotiateVersion(hello(minimumVersion: 2, maximumVersion: 1))
    }
}

@Test
func handshakeValidatesABIIdentityRootAndStartupConfiguration() throws {
    #expect(
        try BrokerHandshake.validate(
            hello(),
            actualABI: 6,
            actualRuntimeVersion: "0.4.0",
            residentRootID: nil,
            startupConfigurationDigest: "configuration-sha256"
        ) == 1
    )
    #expect(
        try BrokerHandshake.validate(
            hello(expectedRuntimeVersion: nil),
            actualABI: 6,
            actualRuntimeVersion: "newer-runtime",
            residentRootID: OliphauntBrokerProtocol.canonicalRootID,
            startupConfigurationDigest: "configuration-sha256"
        ) == 1
    )

    expectBrokerError(.incompatibleABI(expected: 7, actual: 6)) {
        try BrokerHandshake.validate(
            hello(expectedABI: 7),
            actualABI: 6,
            actualRuntimeVersion: "0.4.0",
            residentRootID: nil,
            startupConfigurationDigest: "configuration-sha256"
        )
    }
    expectBrokerError(.runtimeMismatch(expected: "0.4.0", actual: "0.5.0")) {
        try BrokerHandshake.validate(
            hello(),
            actualABI: 6,
            actualRuntimeVersion: "0.5.0",
            residentRootID: nil,
            startupConfigurationDigest: "configuration-sha256"
        )
    }
    expectBrokerError(.rootMismatch(expected: "default", actual: "another-root")) {
        try BrokerHandshake.validate(
            hello(rootID: "another-root"),
            actualABI: 6,
            actualRuntimeVersion: "0.4.0",
            residentRootID: nil,
            startupConfigurationDigest: "configuration-sha256"
        )
    }
    expectBrokerError(.rootMismatch(expected: "resident-root", actual: "default")) {
        try BrokerHandshake.validate(
            hello(),
            actualABI: 6,
            actualRuntimeVersion: "0.4.0",
            residentRootID: "resident-root",
            startupConfigurationDigest: "configuration-sha256"
        )
    }
    expectBrokerError(.invalidConfiguration("startup-configuration digest mismatch")) {
        try BrokerHandshake.validate(
            hello(digest: "wrong"),
            actualABI: 6,
            actualRuntimeVersion: "0.4.0",
            residentRootID: nil,
            startupConfigurationDigest: "configuration-sha256"
        )
    }
}

@Test
func defaultCapabilitiesEncodeOnlyConservativeIOSBrokerClaims() throws {
    let capabilities = BrokerCapabilities()
    let expectedEnabled: Set<BrokerCapability> = [
        .processIsolated,
        .crashRestartable,
        .sameRootLogicalReopen,
        .protocolRaw,
        .protocolStream,
        .queryCancel,
    ]
    #expect(capabilities.enabled == expectedEnabled)

    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    let encoded = try encoder.encode(capabilities)
    let json = try #require(String(data: encoded, encoding: .utf8))
    #expect(
        json
            == "{\"backgroundContinuable\":false,\"backupRestore\":false,\"crashRestartable\":true,\"hangRestartable\":false,\"implementation\":\"iosExtensionBroker\",\"independentSessions\":false,\"maxClientSessions\":1,\"minimumOS\":\"iOS 26\",\"mode\":\"nativeBroker\",\"multiRoot\":false,\"processIsolated\":true,\"protocolRaw\":true,\"protocolStream\":true,\"queryCancel\":true,\"requiresAppGroup\":false,\"rootSwitchable\":false,\"sameRootLogicalReopen\":true,\"serverMode\":false,\"streamingRequestInput\":false}"
    )

    let decoded = try JSONDecoder().decode(BrokerCapabilities.self, from: encoded)
    #expect(decoded == capabilities)
    #expect(decoded.mode == "nativeBroker")
    #expect(decoded.implementation == "iosExtensionBroker")
    #expect(decoded.minimumOS == "iOS 26")
    #expect(decoded.processIsolated)
    #expect(decoded.crashRestartable)
    #expect(!decoded.hangRestartable)
    #expect(decoded.sameRootLogicalReopen)
    #expect(!decoded.rootSwitchable)
    #expect(!decoded.multiRoot)
    #expect(!decoded.independentSessions)
    #expect(decoded.maxClientSessions == 1)
    #expect(!decoded.backgroundContinuable)
    #expect(!decoded.requiresAppGroup)
    #expect(decoded.protocolRaw)
    #expect(decoded.protocolStream)
    #expect(!decoded.streamingRequestInput)
    #expect(decoded.queryCancel)
    #expect(!decoded.backupRestore)
    #expect(decoded.connectionString == nil)
    #expect(!decoded.serverMode)
}

@Test
func readyAndStructuredOutcomeUnknownSurviveCodableRoundTrips() throws {
    let capabilities = BrokerCapabilities()
    let ready = BrokerReady(
        selectedProtocolVersion: 1,
        epoch: brokerTestEpoch,
        extensionPID: 4242,
        runtimeVersion: "0.4.0",
        abiVersion: 6,
        postgresMajorVersion: 18,
        rootManifestDigest: "manifest-sha256",
        actualCapabilities: capabilities,
        actualRuntimeConfiguration: BrokerRuntimeConfiguration(
            rootID: "default",
            startupConfigurationDigest: "configuration-sha256",
            selectedExtensions: ["pg_trgm", "vector"]
        )
    )
    let encodedReady = try JSONEncoder().encode(ready)
    #expect(try JSONDecoder().decode(BrokerReady.self, from: encodedReady) == ready)

    let requestID = try BrokerRequestID(validating: 99)
    let error = BrokerError.outcomeUnknown(epoch: brokerTestEpoch, requestID: requestID)
    let encodedError = try JSONEncoder().encode(error)
    #expect(try JSONDecoder().decode(BrokerError.self, from: encodedError) == error)
    #expect(error.description.contains(brokerTestEpoch.description))
    #expect(error.description.contains("99"))
}
