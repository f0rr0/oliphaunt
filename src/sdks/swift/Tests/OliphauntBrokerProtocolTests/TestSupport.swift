import Foundation
import OliphauntBrokerProtocol
import Testing

let brokerTestEpoch = BrokerEpoch(
    UUID(uuidString: "00112233-4455-6677-8899-AABBCCDDEEFF")!
)

let otherBrokerTestEpoch = BrokerEpoch(
    UUID(uuidString: "FFEEDDCC-BBAA-9988-7766-554433221100")!
)

func expectProtocolError<T>(
    _ expected: BrokerProtocolError,
    performing operation: () throws -> T
) {
    do {
        _ = try operation()
        Issue.record("expected protocol error \(expected), but the operation succeeded")
    } catch let actual as BrokerProtocolError {
        #expect(actual == expected)
    } catch {
        Issue.record("expected protocol error \(expected), got \(error)")
    }
}

func expectBrokerError<T>(
    _ expected: BrokerError,
    performing operation: () throws -> T
) {
    do {
        _ = try operation()
        Issue.record("expected broker error \(expected), but the operation succeeded")
    } catch let actual as BrokerError {
        #expect(actual == expected)
    } catch {
        Issue.record("expected broker error \(expected), got \(error)")
    }
}

func postgresFrontendMessage(type: UInt8, body: [UInt8]) -> Data {
    let length = UInt32(body.count + 4)
    var result = Data([type])
    result.append(UInt8((length >> 24) & 0xff))
    result.append(UInt8((length >> 16) & 0xff))
    result.append(UInt8((length >> 8) & 0xff))
    result.append(UInt8(length & 0xff))
    result.append(contentsOf: body)
    return result
}

func writeNetworkUInt16(_ value: UInt16, to bytes: inout Data, at offset: Int) {
    bytes[offset] = UInt8((value >> 8) & 0xff)
    bytes[offset + 1] = UInt8(value & 0xff)
}

func writeNetworkUInt32(_ value: UInt32, to bytes: inout Data, at offset: Int) {
    bytes[offset] = UInt8((value >> 24) & 0xff)
    bytes[offset + 1] = UInt8((value >> 16) & 0xff)
    bytes[offset + 2] = UInt8((value >> 8) & 0xff)
    bytes[offset + 3] = UInt8(value & 0xff)
}

func writeNetworkUInt64(_ value: UInt64, to bytes: inout Data, at offset: Int) {
    for byteOffset in 0..<8 {
        let shift = UInt64(56 - byteOffset * 8)
        bytes[offset + byteOffset] = UInt8((value >> shift) & 0xff)
    }
}
