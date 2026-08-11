import Foundation
import Testing

@testable import OliphauntBrokerExtension

@Test
func backendPrivacyFilterRedactsEveryTextFieldAcrossOneByteSplits() throws {
    let sensitivePrefix = "/private/var/mobile/Containers/Data/Application/secret/PGDATA"
    let textFieldTags: [UInt8] = [
        0x4d, 0x44, 0x48, 0x57, 0x50, 0x70, 0x71, 0x73, 0x74, 0x63, 0x64, 0x6e,
        0x46, 0x4c, 0x52,
    ]

    for responseTag: UInt8 in [0x45, 0x4e] {
        var fields: [(UInt8, String)] = [
            (0x53, responseTag == 0x45 ? "ERROR" : "NOTICE"),
            (0x56, responseTag == 0x45 ? "ERROR" : "NOTICE"),
            (0x43, "58P01"),
        ]
        fields.append(
            contentsOf: textFieldTags.map { tag in
                (tag, "context before \(sensitivePrefix)/base/123 after")
            })
        let original = backendFieldMessage(tag: responseTag, fields: fields)
        let result = try runPrivacyFilter(
            original,
            sensitivePrefixes: [sensitivePrefix],
            chunkSizes: Array(repeating: 1, count: original.count)
        )

        #expect(!result.output.containsBytes(Data(sensitivePrefix.utf8)))
        #expect(result.outputChunks.count == 1)
        let decoded = try decodeBackendFieldMessage(result.output)
        #expect(decoded.tag == responseTag)
        #expect(
            decoded.fields.first(where: { $0.0 == 0x53 })?.1 == "ERROR"
                || decoded.fields.first(where: { $0.0 == 0x53 })?.1 == "NOTICE")
        #expect(
            decoded.fields.first(where: { $0.0 == 0x56 })?.1 == "ERROR"
                || decoded.fields.first(where: { $0.0 == 0x56 })?.1 == "NOTICE")
        #expect(decoded.fields.first(where: { $0.0 == 0x43 })?.1 == "58P01")
        for tag in textFieldTags {
            #expect(decoded.fields.first(where: { $0.0 == tag })?.1 == "[redacted]")
        }
    }
}

@Test
func backendPrivacyFilterPreservesSafeFieldsAndErrorReadyAdjacency() throws {
    let prefix = "/private/extension/root"
    let safeError = backendFieldMessage(
        tag: 0x45,
        fields: [
            (0x53, "ERROR"),
            (0x56, "ERROR"),
            (0x43, "22012"),
            (0x4d, "division by zero"),
        ]
    )
    let ready = backendMessage(tag: 0x5a, body: Data([0x49]))
    let input = safeError + ready
    let result = try runPrivacyFilter(
        input,
        sensitivePrefixes: [prefix],
        chunkSizes: [2, safeError.count - 1, input.count]
    )

    #expect(result.output == input)
    let messages = try splitBackendMessages(result.output)
    #expect(messages == [safeError, ready])
}

@Test
func backendPrivacyFilterStreamsLargeNonSensitiveFramesByteForByte() throws {
    let payload = Data(repeating: 0x61, count: 2 * 1024 * 1024)
    var dataRowBody = Data([0, 1])
    appendNetworkUInt32(UInt32(payload.count), to: &dataRowBody)
    dataRowBody.append(payload)
    let dataRow = backendMessage(tag: 0x44, body: dataRowBody)
    let filter = try BrokerBackendPrivacyFilter(
        sensitiveAbsolutePrefixes: ["/private/extension/root"]
    )
    var outputChunks: [Data] = []

    let firstCount = 97
    try filter.process(dataRow.prefix(firstCount)) { outputChunks.append($0) }
    #expect(!outputChunks.isEmpty)
    var offset = firstCount
    while offset < dataRow.count {
        let end = min(offset + 4093, dataRow.count)
        try filter.process(dataRow[offset..<end]) { outputChunks.append($0) }
        offset = end
    }
    try filter.finish()

    let output = outputChunks.reduce(into: Data()) { $0.append($1) }
    #expect(output == dataRow)
    #expect(outputChunks.max(by: { $0.count < $1.count })?.count ?? 0 <= 4093)
    #expect(outputChunks.count > 500)
}

@Test
func backendPrivacyFilterReplacesOversizedErrorsAndNoticesWithBoundedMessages() throws {
    let sensitivePrefix = "/private/extension/runtime"
    let filler = String(
        repeating: "x", count: BrokerBackendPrivacyFilter.maximumBufferedMessageBytes)

    for responseTag: UInt8 in [0x45, 0x4e] {
        let oversized = backendFieldMessage(
            tag: responseTag,
            fields: [
                (0x53, responseTag == 0x45 ? "ERROR" : "NOTICE"),
                (0x43, "58P01"),
                (0x4d, "could not open \(sensitivePrefix)/share/stopwords"),
                (0x44, filler),
            ]
        )
        let result = try runPrivacyFilter(
            oversized,
            sensitivePrefixes: [sensitivePrefix],
            chunkSizes: Array(repeating: 137, count: oversized.count / 137 + 1)
        )

        #expect(result.output.count < 256)
        #expect(!result.output.containsBytes(Data(sensitivePrefix.utf8)))
        let decoded = try decodeBackendFieldMessage(result.output)
        #expect(decoded.tag == responseTag)
        #expect(decoded.fields.first(where: { $0.0 == 0x43 })?.1 == "58P01")
        let message = try #require(decoded.fields.first(where: { $0.0 == 0x4d })?.1)
        #expect(message.contains("redacted"))
        #expect(!message.contains("/"))
    }
}

@Test
func backendPrivacyFilterFailsClosedForMalformedAndTruncatedMessages() throws {
    let prefix = "/private/extension/root"

    do {
        let filter = try BrokerBackendPrivacyFilter(sensitiveAbsolutePrefixes: [prefix])
        var output = Data()
        var malformed = Data([0x45, 0, 0, 0, 3])
        malformed.append(Data(prefix.utf8))
        try expectPrivacyFilterError(.malformedBackendMessage, sensitive: prefix) {
            try filter.process(malformed) { output.append($0) }
        }
        #expect(output.isEmpty)
    }

    do {
        let filter = try BrokerBackendPrivacyFilter(sensitiveAbsolutePrefixes: [prefix])
        var body = Data([0x4d])
        body.append(Data("failure at \(prefix)/base".utf8))
        let malformed = backendMessage(tag: 0x45, body: body)
        var output = Data()
        try expectPrivacyFilterError(.malformedBackendMessage, sensitive: prefix) {
            try filter.process(malformed) { output.append($0) }
        }
        #expect(output.isEmpty)
    }

    do {
        let filter = try BrokerBackendPrivacyFilter(sensitiveAbsolutePrefixes: [prefix])
        let complete = backendFieldMessage(
            tag: 0x4e,
            fields: [(0x53, "NOTICE"), (0x4d, "failure at \(prefix)/base")]
        )
        let truncated = complete.dropLast(3)
        var output = Data()
        try filter.process(truncated) { output.append($0) }
        #expect(output.isEmpty)
        try expectPrivacyFilterError(.incompleteBackendMessage, sensitive: prefix) {
            try filter.finish()
        }
        #expect(output.isEmpty)
    }

    do {
        let filter = try BrokerBackendPrivacyFilter(sensitiveAbsolutePrefixes: [prefix])
        let dataRow = backendMessage(tag: 0x44, body: Data(repeating: 0x61, count: 40))
        var output = Data()
        try filter.process(dataRow.dropLast()) { output.append($0) }
        #expect(!output.isEmpty)
        try expectPrivacyFilterError(.incompleteBackendMessage, sensitive: prefix) {
            try filter.finish()
        }
    }
}

@Test
func backendPrivacyFilterExpandsResolvedPathAliasesAndRejectsRoot() throws {
    let temporary = FileManager.default.temporaryDirectory
        .appendingPathComponent("broker-privacy-filter-\(UUID().uuidString)", isDirectory: true)
    let real = temporary.appendingPathComponent("real", isDirectory: true)
    let alias = temporary.appendingPathComponent("alias", isDirectory: true)
    try FileManager.default.createDirectory(at: real, withIntermediateDirectories: true)
    try FileManager.default.createSymbolicLink(at: alias, withDestinationURL: real)
    defer { try? FileManager.default.removeItem(at: temporary) }

    let filter = try BrokerBackendPrivacyFilter(sensitiveAbsolutePrefixes: [alias.path])
    let message = backendFieldMessage(
        tag: 0x45,
        fields: [(0x53, "ERROR"), (0x43, "58P01"), (0x4d, "missing \(real.path)/file")]
    )
    var output = Data()
    try filter.process(message) { output.append($0) }
    try filter.finish()
    #expect(!output.containsBytes(Data(real.path.utf8)))
    #expect(try decodeBackendFieldMessage(output).fields.last?.1 == "[redacted]")

    try expectPrivacyFilterError(.invalidConfiguration, sensitive: "ignored") {
        _ = try BrokerBackendPrivacyFilter(sensitiveAbsolutePrefixes: ["/"])
    }
    try expectPrivacyFilterError(.invalidConfiguration, sensitive: "ignored") {
        _ = try BrokerBackendPrivacyFilter(sensitiveAbsolutePrefixes: [])
    }
}

private struct PrivacyFilterRunResult {
    var output: Data
    var outputChunks: [Data]
}

private func runPrivacyFilter(
    _ input: Data,
    sensitivePrefixes: [String],
    chunkSizes: [Int]
) throws -> PrivacyFilterRunResult {
    let filter = try BrokerBackendPrivacyFilter(sensitiveAbsolutePrefixes: sensitivePrefixes)
    var outputChunks: [Data] = []
    var offset = 0
    var chunkIndex = 0
    while offset < input.count {
        let requested = chunkIndex < chunkSizes.count ? chunkSizes[chunkIndex] : input.count
        let end = min(offset + max(1, requested), input.count)
        try filter.process(input[offset..<end]) { outputChunks.append($0) }
        offset = end
        chunkIndex += 1
    }
    try filter.finish()
    return PrivacyFilterRunResult(
        output: outputChunks.reduce(into: Data()) { $0.append($1) },
        outputChunks: outputChunks
    )
}

private func backendFieldMessage(tag: UInt8, fields: [(UInt8, String)]) -> Data {
    var body = Data()
    for (fieldTag, value) in fields {
        body.append(fieldTag)
        body.append(Data(value.utf8))
        body.append(0)
    }
    body.append(0)
    return backendMessage(tag: tag, body: body)
}

private func backendMessage(tag: UInt8, body: Data) -> Data {
    var message = Data([tag])
    appendNetworkUInt32(UInt32(body.count + 4), to: &message)
    message.append(body)
    return message
}

private func appendNetworkUInt32(_ value: UInt32, to data: inout Data) {
    data.append(UInt8(truncatingIfNeeded: value >> 24))
    data.append(UInt8(truncatingIfNeeded: value >> 16))
    data.append(UInt8(truncatingIfNeeded: value >> 8))
    data.append(UInt8(truncatingIfNeeded: value))
}

private func splitBackendMessages(_ data: Data) throws -> [Data] {
    var messages: [Data] = []
    var offset = 0
    while offset < data.count {
        guard data.count - offset >= 5 else { throw PrivacyFilterTestError.malformed }
        let length = readNetworkUInt32(data[(offset + 1)..<(offset + 5)])
        guard length >= 4, let wireLength = Int(exactly: length + 1),
            wireLength <= data.count - offset
        else {
            throw PrivacyFilterTestError.malformed
        }
        messages.append(data[offset..<(offset + wireLength)])
        offset += wireLength
    }
    return messages
}

private func decodeBackendFieldMessage(
    _ data: Data
) throws -> (tag: UInt8, fields: [(UInt8, String)]) {
    guard data.count >= 6 else { throw PrivacyFilterTestError.malformed }
    let tag = data[data.startIndex]
    let length = readNetworkUInt32(data[(data.startIndex + 1)..<(data.startIndex + 5)])
    guard Int(length) + 1 == data.count else { throw PrivacyFilterTestError.malformed }
    let body = [UInt8](data.dropFirst(5))
    var fields: [(UInt8, String)] = []
    var offset = 0
    while offset < body.count {
        let fieldTag = body[offset]
        offset += 1
        if fieldTag == 0 {
            guard offset == body.count else { throw PrivacyFilterTestError.malformed }
            return (tag, fields)
        }
        guard let end = body[offset...].firstIndex(of: 0),
            let value = String(bytes: body[offset..<end], encoding: .utf8)
        else {
            throw PrivacyFilterTestError.malformed
        }
        fields.append((fieldTag, value))
        offset = end + 1
    }
    throw PrivacyFilterTestError.malformed
}

private func readNetworkUInt32(_ bytes: Data.SubSequence) -> UInt32 {
    bytes.reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
}

private func expectPrivacyFilterError(
    _ expected: BrokerBackendPrivacyFilterError,
    sensitive: String,
    operation: () throws -> Void
) throws {
    do {
        try operation()
        Issue.record("expected backend privacy filter error \(expected)")
    } catch let error as BrokerBackendPrivacyFilterError {
        #expect(error == expected)
        #expect(!error.localizedDescription.contains(sensitive))
        #expect(!error.localizedDescription.contains("/"))
    } catch {
        Issue.record("unexpected backend privacy filter error: \(error)")
    }
}

private enum PrivacyFilterTestError: Error {
    case malformed
}

extension Data {
    fileprivate func containsBytes(_ bytes: Data) -> Bool {
        range(of: bytes) != nil
    }
}
