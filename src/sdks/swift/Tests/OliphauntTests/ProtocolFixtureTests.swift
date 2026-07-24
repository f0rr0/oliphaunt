import Foundation
@testable import Oliphaunt
import Testing

@Test
func queryParserMatchesSharedProtocolFixtures() throws {
    let fixtureURL = sharedProtocolFixtureURL()
    guard FileManager.default.fileExists(atPath: fixtureURL.path) else {
        return
    }

    let corpus = try JSONDecoder().decode(
        SharedProtocolFixtureCorpus.self,
        from: Data(contentsOf: fixtureURL)
    )
    #expect(corpus.schemaVersion == 1)
    #expect(corpus.kind == "postgres-backend-query-response")
    #expect(!corpus.cases.isEmpty)

    var names = Set<String>()
    for fixture in corpus.cases {
        #expect(names.insert(fixture.name).inserted)
        guard let expectation = fixture.queryExpectation else {
            continue
        }
        let bytes = try sharedProtocolBytes(fixture.responseHex)
        if let expected = expectation.ok {
            try expectSharedProtocolOkFixture(fixture, expected: expected, bytes: bytes)
        } else if let expected = expectation.postgresError {
            expectSharedProtocolPostgresErrorFixture(fixture, expected: expected, bytes: bytes)
        } else if let expected = expectation.engineErrorContains {
            expectSharedProtocolEngineErrorFixture(fixture, expected: expected, bytes: bytes)
        } else {
            Issue.record("shared protocol fixture \(fixture.name) has no query expectation")
        }
    }
}

private func expectSharedProtocolOkFixture(
    _ fixture: SharedProtocolFixtureCase,
    expected: SharedProtocolOkExpectation,
    bytes: Data
) throws {
    let result = try parseOliphauntQueryResponse(bytes)
    #expect(result.rowCount == expected.rowCount)
    #expect(result.commandTag == expected.commandTag)
    #expect(result.fields.count == expected.fields.count)
    #expect(result.rows.count == expected.rows.count)

    for (index, expectedField) in expected.fields.enumerated() {
        guard result.fields.indices.contains(index) else {
            Issue.record("shared protocol fixture \(fixture.name) is missing field \(index)")
            continue
        }
        let actual = result.fields[index]
        #expect(actual.name == expectedField.name)
        #expect(actual.typeOID == expectedField.typeOid)
        if expectedField.format == "text" {
            #expect(actual.format == .text)
        }
    }

    for (rowIndex, expectedRow) in expected.rows.enumerated() {
        #expect(expectedRow.count == expected.fields.count)
        for (columnIndex, expectedValue) in expectedRow.enumerated() {
            guard expected.fields.indices.contains(columnIndex) else {
                Issue.record("shared protocol fixture \(fixture.name) is missing expected field \(columnIndex)")
                continue
            }
            let field = expected.fields[columnIndex]
            #expect(try result.getText(row: rowIndex, column: field.name) == expectedValue)
        }
    }
}

private func expectSharedProtocolPostgresErrorFixture(
    _ fixture: SharedProtocolFixtureCase,
    expected: SharedProtocolPostgresErrorExpectation,
    bytes: Data
) {
    do {
        _ = try parseOliphauntQueryResponse(bytes)
        Issue.record("shared protocol fixture \(fixture.name) should have produced a PostgreSQL error")
    } catch OliphauntError.postgres(let error) {
        #expect(error.severity == expected.severity)
        #expect(error.sqlstate == expected.sqlstate)
        #expect(error.message == expected.message)
    } catch {
        Issue.record("shared protocol fixture \(fixture.name) produced unexpected error \(error)")
    }
}

private func expectSharedProtocolEngineErrorFixture(
    _ fixture: SharedProtocolFixtureCase,
    expected: String,
    bytes: Data
) {
    do {
        _ = try parseOliphauntQueryResponse(bytes)
        Issue.record("shared protocol fixture \(fixture.name) should have produced an engine error")
    } catch OliphauntError.engine(let message) {
        #expect(message.contains(expected))
    } catch {
        Issue.record("shared protocol fixture \(fixture.name) produced unexpected error \(error)")
    }
}

private func sharedProtocolFixtureURL() -> URL {
    if let fixtureRoot = ProcessInfo.processInfo.environment["OLIPHAUNT_SHARED_FIXTURES"] {
        return URL(fileURLWithPath: fixtureRoot, isDirectory: true)
            .appendingPathComponent("protocol")
            .appendingPathComponent("query-response-cases.json")
    }

    var root = URL(fileURLWithPath: #filePath)
    for _ in 0..<5 {
        root.deleteLastPathComponent()
    }
    return root
        .appendingPathComponent("src")
        .appendingPathComponent("shared")
        .appendingPathComponent("fixtures")
        .appendingPathComponent("protocol")
        .appendingPathComponent("query-response-cases.json")
}

private func sharedProtocolBytes(_ hex: String) throws -> Data {
    let compact = hex.filter { !$0.isWhitespace }
    guard compact.count.isMultiple(of: 2) else {
        throw SharedProtocolFixtureError.invalidHex(hex)
    }

    var bytes = Data()
    var index = compact.startIndex
    while index < compact.endIndex {
        let next = compact.index(index, offsetBy: 2)
        guard let byte = UInt8(String(compact[index..<next]), radix: 16) else {
            throw SharedProtocolFixtureError.invalidHex(hex)
        }
        bytes.append(byte)
        index = next
    }
    return bytes
}

private enum SharedProtocolFixtureError: Error {
    case invalidHex(String)
}

private struct SharedProtocolFixtureCorpus: Decodable {
    var schemaVersion: Int
    var kind: String
    var cases: [SharedProtocolFixtureCase]
}

private struct SharedProtocolFixtureCase: Decodable {
    var name: String
    var responseHex: String
    var queryExpectation: SharedProtocolQueryExpectation?
}

private struct SharedProtocolQueryExpectation: Decodable {
    var ok: SharedProtocolOkExpectation?
    var postgresError: SharedProtocolPostgresErrorExpectation?
    var engineErrorContains: String?
}

private struct SharedProtocolOkExpectation: Decodable {
    var fields: [SharedProtocolFieldExpectation]
    var rows: [[String?]]
    var commandTag: String?
    var rowCount: Int
}

private struct SharedProtocolFieldExpectation: Decodable {
    var name: String
    var typeOid: UInt32
    var format: String?
}

private struct SharedProtocolPostgresErrorExpectation: Decodable {
    var severity: String
    var sqlstate: String
    var message: String
}
