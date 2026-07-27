import Foundation

public enum OliphauntQueryFormat: Equatable, Sendable {
    case text
    case binary
    case other(Int16)

    fileprivate init(code: Int16) {
        switch code {
        case 0:
            self = .text
        case 1:
            self = .binary
        default:
            self = .other(code)
        }
    }
}

public enum OliphauntQueryParam: Equatable, Sendable {
    case null
    case text(String)
    case binary(Data)

    public static func binary(_ bytes: [UInt8]) -> OliphauntQueryParam {
        .binary(Data(bytes))
    }
}

public struct OliphauntQueryField: Equatable, Sendable {
    public var name: String
    public var tableOID: UInt32
    public var tableAttribute: Int16
    public var typeOID: UInt32
    public var typeSize: Int16
    public var typeModifier: Int32
    public var format: OliphauntQueryFormat
}

public struct OliphauntQueryRow: Equatable, Sendable {
    public var values: [Data?]

    public func text(_ column: Int) throws -> String? {
        guard values.indices.contains(column) else {
            throw OliphauntError.engine("query row has no column at index \(column)")
        }
        guard let value = values[column] else {
            return nil
        }
        guard let text = String(data: value, encoding: .utf8) else {
            throw OliphauntError.engine("query value is not valid UTF-8")
        }
        return text
    }
}

public struct OliphauntQueryResult: Equatable, Sendable {
    public var fields: [OliphauntQueryField]
    public var rows: [OliphauntQueryRow]
    public var commandTag: String?

    public var rowCount: Int {
        rows.count
    }

    public func fieldIndex(_ name: String) -> Int? {
        fields.firstIndex { $0.name == name }
    }

    public func getText(row: Int, column: String) throws -> String? {
        guard let columnIndex = fieldIndex(column) else {
            throw OliphauntError.engine("query result has no column named \(String(reflecting: column))")
        }
        guard rows.indices.contains(row) else {
            throw OliphauntError.engine("query result has no row at index \(row)")
        }
        return try rows[row].text(columnIndex)
    }
}

public struct OliphauntPostgresErrorField: Equatable, Sendable {
    public var code: UInt8
    public var value: String

    public init(code: UInt8, value: String) {
        self.code = code
        self.value = value
    }
}

public struct OliphauntPostgresError: Equatable, Sendable, CustomStringConvertible {
    public var severity: String?
    public var sqlstate: String?
    public var message: String
    public var detail: String?
    public var hint: String?
    public var position: String?
    public var whereText: String?
    public var schemaName: String?
    public var tableName: String?
    public var columnName: String?
    public var dataTypeName: String?
    public var constraintName: String?
    public var fields: [OliphauntPostgresErrorField]

    public init(fields: [OliphauntPostgresErrorField]) {
        self.fields = fields
        self.severity = fieldValue(fields, 0x53) ?? fieldValue(fields, 0x56)
        self.sqlstate = fieldValue(fields, 0x43)
        self.message = fieldValue(fields, 0x4d) ?? "PostgreSQL ErrorResponse"
        self.detail = fieldValue(fields, 0x44)
        self.hint = fieldValue(fields, 0x48)
        self.position = fieldValue(fields, 0x50)
        self.whereText = fieldValue(fields, 0x57)
        self.schemaName = fieldValue(fields, 0x73)
        self.tableName = fieldValue(fields, 0x74)
        self.columnName = fieldValue(fields, 0x63)
        self.dataTypeName = fieldValue(fields, 0x64)
        self.constraintName = fieldValue(fields, 0x6e)
    }

    public static func fallback() -> OliphauntPostgresError {
        OliphauntPostgresError(fields: [
            OliphauntPostgresErrorField(code: 0x4d, value: "PostgreSQL ErrorResponse")
        ])
    }

    public var description: String {
        switch (severity, sqlstate) {
        case (.some(let severity), .some(let sqlstate)):
            "\(severity) [\(sqlstate)]: \(message)"
        case (.some(let severity), .none):
            "\(severity): \(message)"
        case (.none, .some(let sqlstate)):
            "[\(sqlstate)]: \(message)"
        case (.none, .none):
            message
        }
    }
}

public extension OliphauntDatabase {
    func execute(_ sql: String) async throws -> Data {
        try await execProtocolRaw(try OliphauntProtocol.simpleQuery(sql))
    }

    func query(_ sql: String) async throws -> OliphauntQueryResult {
        try await parseOliphauntQueryResponse(execute(sql))
    }

    func query(_ sql: String, parameters: [OliphauntQueryParam]) async throws -> OliphauntQueryResult {
        try await parseOliphauntQueryResponse(
            execProtocolRaw(try OliphauntProtocol.extendedQuery(sql, parameters: parameters))
        )
    }
}

public extension OliphauntTransaction {
    func execute(_ sql: String) async throws -> Data {
        try await execProtocolRaw(try OliphauntProtocol.simpleQuery(sql))
    }

    func query(_ sql: String) async throws -> OliphauntQueryResult {
        try await parseOliphauntQueryResponse(execute(sql))
    }

    func query(_ sql: String, parameters: [OliphauntQueryParam]) async throws -> OliphauntQueryResult {
        try await parseOliphauntQueryResponse(
            execProtocolRaw(try OliphauntProtocol.extendedQuery(sql, parameters: parameters))
        )
    }
}

public enum OliphauntProtocol {
    public static func simpleQuery(_ sql: String) throws -> Data {
        guard !sql.utf8.contains(0) else {
            throw OliphauntError.engine("simple query SQL must not contain NUL bytes")
        }
        var body = Data(sql.utf8)
        body.append(0)
        let length = UInt32(body.count + 4)
        var message = Data([0x51])
        message.append(UInt8((length >> 24) & 0xff))
        message.append(UInt8((length >> 16) & 0xff))
        message.append(UInt8((length >> 8) & 0xff))
        message.append(UInt8(length & 0xff))
        message.append(body)
        return message
    }

    public static func extendedQuery(
        _ sql: String,
        parameters: [OliphauntQueryParam]
    ) throws -> Data {
        guard parameters.count <= Int(Int16.max) else {
            throw OliphauntError.engine(
                "extended query supports at most \(Int16.max) parameters, got \(parameters.count)"
            )
        }
        guard !sql.utf8.contains(0) else {
            throw OliphauntError.engine("extended query SQL must not contain NUL bytes")
        }

        var packet = Data()
        try appendParse(to: &packet, sql: sql)
        try appendBind(to: &packet, parameters: parameters)
        try appendDescribePortal(to: &packet)
        try appendExecute(to: &packet)
        appendFrontendMessage(to: &packet, tag: 0x53, body: Data())
        return packet
    }

    private static func appendParse(to packet: inout Data, sql: String) throws {
        var body = Data()
        try appendCString(to: &body, "")
        try appendCString(to: &body, sql)
        appendInt16(to: &body, 0)
        appendFrontendMessage(to: &packet, tag: 0x50, body: body)
    }

    private static func appendBind(to packet: inout Data, parameters: [OliphauntQueryParam]) throws {
        var body = Data()
        try appendCString(to: &body, "")
        try appendCString(to: &body, "")

        appendInt16(to: &body, Int16(parameters.count))
        for parameter in parameters {
            switch parameter {
            case .binary:
                appendInt16(to: &body, 1)
            case .null, .text:
                appendInt16(to: &body, 0)
            }
        }

        appendInt16(to: &body, Int16(parameters.count))
        for parameter in parameters {
            switch parameter {
            case .null:
                appendInt32(to: &body, -1)
            case .text(let value):
                try appendSizedValue(to: &body, Data(value.utf8))
            case .binary(let value):
                try appendSizedValue(to: &body, value)
            }
        }

        appendInt16(to: &body, 1)
        appendInt16(to: &body, 0)
        appendFrontendMessage(to: &packet, tag: 0x42, body: body)
    }

    private static func appendDescribePortal(to packet: inout Data) throws {
        var body = Data([0x50])
        try appendCString(to: &body, "")
        appendFrontendMessage(to: &packet, tag: 0x44, body: body)
    }

    private static func appendExecute(to packet: inout Data) throws {
        var body = Data()
        try appendCString(to: &body, "")
        appendInt32(to: &body, 0)
        appendFrontendMessage(to: &packet, tag: 0x45, body: body)
    }

    private static func appendFrontendMessage(to packet: inout Data, tag: UInt8, body: Data) {
        packet.append(tag)
        appendInt32(to: &packet, Int32(body.count + 4))
        packet.append(body)
    }

    private static func appendCString(to data: inout Data, _ value: String) throws {
        guard !value.utf8.contains(0) else {
            throw OliphauntError.engine("frontend protocol string must not contain NUL bytes")
        }
        data.append(Data(value.utf8))
        data.append(0)
    }

    private static func appendSizedValue(to data: inout Data, _ value: Data) throws {
        guard value.count <= Int(Int32.max) else {
            throw OliphauntError.engine("query parameter is too large")
        }
        appendInt32(to: &data, Int32(value.count))
        data.append(value)
    }

    private static func appendInt32(to data: inout Data, _ value: Int32) {
        let bits = UInt32(bitPattern: value)
        data.append(UInt8((bits >> 24) & 0xff))
        data.append(UInt8((bits >> 16) & 0xff))
        data.append(UInt8((bits >> 8) & 0xff))
        data.append(UInt8(bits & 0xff))
    }

    private static func appendInt16(to data: inout Data, _ value: Int16) {
        let bits = UInt16(bitPattern: value)
        data.append(UInt8((bits >> 8) & 0xff))
        data.append(UInt8(bits & 0xff))
    }
}

public func parseOliphauntQueryResponse(_ data: Data) throws -> OliphauntQueryResult {
    var cursor = OliphauntByteCursor(data)
    var fields: [OliphauntQueryField]?
    var rows: [OliphauntQueryRow] = []
    var commandTag: String?
    var sawReady = false

    while !cursor.isAtEnd {
        let tag = try cursor.readUInt8(label: "backend message tag")
        let length = try cursor.readInt32(label: "backend message length")
        guard length >= 4 else {
            throw OliphauntError.engine("invalid backend message length \(length)")
        }
        let body = try cursor.readData(count: Int(length - 4), label: "backend message body")
        var bodyCursor = OliphauntByteCursor(body)

        switch tag {
        case 0x54:
            if fields != nil {
                throw OliphauntError.engine(
                    "query() received multiple result sets; use execProtocolRaw for multi-statement row results"
                )
            }
            fields = try parseRowDescription(&bodyCursor)
            try bodyCursor.requireEnd(label: "RowDescription")
        case 0x44:
            guard let activeFields = fields else {
                throw OliphauntError.engine("DataRow arrived before RowDescription")
            }
            rows.append(try parseDataRow(&bodyCursor, expectedColumns: activeFields.count))
            try bodyCursor.requireEnd(label: "DataRow")
        case 0x43:
            commandTag = try bodyCursor.readCString(label: "CommandComplete tag")
            try bodyCursor.requireEnd(label: "CommandComplete")
        case 0x45:
            throw OliphauntError.postgres(parseErrorResponse(&bodyCursor))
        case 0x47, 0x48, 0x57, 0x64, 0x63:
            throw OliphauntError.engine(
                "query() does not support COPY protocol responses; use execProtocolRaw for COPY traffic"
            )
        case 0x5a:
            try validateReadyForQuery(body)
            sawReady = true
            if !cursor.isAtEnd {
                throw OliphauntError.engine("backend returned bytes after ReadyForQuery")
            }
        case 0x31:
            try bodyCursor.requireEnd(label: "ParseComplete")
        case 0x32:
            try bodyCursor.requireEnd(label: "BindComplete")
        case 0x33:
            try bodyCursor.requireEnd(label: "CloseComplete")
        case 0x49:
            try bodyCursor.requireEnd(label: "EmptyQueryResponse")
        case 0x6e:
            try bodyCursor.requireEnd(label: "NoData")
        case 0x53:
            try validateParameterStatus(&bodyCursor)
        case 0x4e:
            try validateFieldResponse(&bodyCursor, label: "NoticeResponse")
        case 0x41:
            try validateNotificationResponse(&bodyCursor)
        default:
            throw OliphauntError.engine(
                "query() received unexpected backend message tag \(hexBackendTag(tag))"
            )
        }
    }

    guard sawReady else {
        throw OliphauntError.engine("query response ended before ReadyForQuery")
    }

    return OliphauntQueryResult(
        fields: fields ?? [],
        rows: rows,
        commandTag: commandTag
    )
}

private func parseRowDescription(_ cursor: inout OliphauntByteCursor) throws -> [OliphauntQueryField] {
    let count = try cursor.readInt16(label: "RowDescription field count")
    guard count >= 0 else {
        throw OliphauntError.engine("invalid RowDescription field count \(count)")
    }
    var fields: [OliphauntQueryField] = []
    fields.reserveCapacity(Int(count))
    for _ in 0..<count {
        fields.append(OliphauntQueryField(
            name: try cursor.readCString(label: "field name"),
            tableOID: try cursor.readUInt32(label: "field table oid"),
            tableAttribute: try cursor.readInt16(label: "field table attribute"),
            typeOID: try cursor.readUInt32(label: "field type oid"),
            typeSize: try cursor.readInt16(label: "field type size"),
            typeModifier: try cursor.readInt32(label: "field type modifier"),
            format: OliphauntQueryFormat(code: try cursor.readInt16(label: "field format"))
        ))
    }
    return fields
}

private func parseDataRow(
    _ cursor: inout OliphauntByteCursor,
    expectedColumns: Int
) throws -> OliphauntQueryRow {
    let count = try cursor.readInt16(label: "DataRow column count")
    guard count >= 0 else {
        throw OliphauntError.engine("invalid DataRow column count \(count)")
    }
    guard Int(count) == expectedColumns else {
        throw OliphauntError.engine(
            "DataRow column count \(count) does not match RowDescription count \(expectedColumns)"
        )
    }
    var values: [Data?] = []
    values.reserveCapacity(Int(count))
    for _ in 0..<count {
        let length = try cursor.readInt32(label: "DataRow value length")
        if length == -1 {
            values.append(nil)
            continue
        }
        guard length >= 0 else {
            throw OliphauntError.engine("invalid DataRow value length \(length)")
        }
        values.append(try cursor.readData(count: Int(length), label: "DataRow value"))
    }
    return OliphauntQueryRow(values: values)
}

private func parseErrorResponse(_ cursor: inout OliphauntByteCursor) -> OliphauntPostgresError {
    var fields: [OliphauntPostgresErrorField] = []
    while !cursor.isAtEnd {
        guard let code = try? cursor.readUInt8(label: "ErrorResponse field code") else {
            return .fallback()
        }
        if code == 0 {
            break
        }
        guard let value = try? cursor.readCString(label: "ErrorResponse field") else {
            return .fallback()
        }
        fields.append(OliphauntPostgresErrorField(code: code, value: value))
    }
    return OliphauntPostgresError(fields: fields)
}

private func fieldValue(_ fields: [OliphauntPostgresErrorField], _ code: UInt8) -> String? {
    fields.first { $0.code == code }?.value
}

private func hexBackendTag(_ tag: UInt8) -> String {
    let hex = String(tag, radix: 16, uppercase: false)
    return "0x" + (hex.count == 1 ? "0\(hex)" : hex)
}

private func validateReadyForQuery(_ body: Data) throws {
    guard body.count == 1 else {
        throw OliphauntError.engine("ReadyForQuery contained \(body.count) bytes, expected 1")
    }
    switch body[body.startIndex] {
    case 0x49, 0x54, 0x45:
        return
    case let status:
        throw OliphauntError.engine(
            "ReadyForQuery contained invalid transaction status \(hexBackendTag(status))"
        )
    }
}

private func validateParameterStatus(_ cursor: inout OliphauntByteCursor) throws {
    _ = try cursor.readCString(label: "ParameterStatus name")
    _ = try cursor.readCString(label: "ParameterStatus value")
    try cursor.requireEnd(label: "ParameterStatus")
}

private func validateNotificationResponse(_ cursor: inout OliphauntByteCursor) throws {
    _ = try cursor.readInt32(label: "NotificationResponse process id")
    _ = try cursor.readCString(label: "NotificationResponse channel")
    _ = try cursor.readCString(label: "NotificationResponse payload")
    try cursor.requireEnd(label: "NotificationResponse")
}

private func validateFieldResponse(_ cursor: inout OliphauntByteCursor, label: String) throws {
    while true {
        guard !cursor.isAtEnd else {
            throw OliphauntError.engine("\(label) is missing terminator")
        }
        let code = try cursor.readUInt8(label: "\(label) field code")
        if code == 0 {
            try cursor.requireEnd(label: label)
            return
        }
        _ = try cursor.readCString(label: "\(label) field")
    }
}

private struct OliphauntByteCursor {
    private let bytes: [UInt8]
    private var offset: Int = 0

    init(_ data: Data) {
        self.bytes = Array(data)
    }

    var isAtEnd: Bool {
        offset >= bytes.count
    }

    mutating func requireEnd(label: String) throws {
        if !isAtEnd {
            throw OliphauntError.engine("\(label) contained trailing bytes")
        }
    }

    mutating func readUInt8(label: String) throws -> UInt8 {
        try take(count: 1, label: label)[0]
    }

    mutating func readUInt32(label: String) throws -> UInt32 {
        let bytes = try take(count: 4, label: label)
        return UInt32(bytes[0]) << 24
            | UInt32(bytes[1]) << 16
            | UInt32(bytes[2]) << 8
            | UInt32(bytes[3])
    }

    mutating func readInt32(label: String) throws -> Int32 {
        Int32(bitPattern: try readUInt32(label: label))
    }

    mutating func readInt16(label: String) throws -> Int16 {
        let bytes = try take(count: 2, label: label)
        return Int16(bitPattern: UInt16(bytes[0]) << 8 | UInt16(bytes[1]))
    }

    mutating func readData(count: Int, label: String) throws -> Data {
        Data(try take(count: count, label: label))
    }

    mutating func readCString(label: String) throws -> String {
        guard offset < bytes.count else {
            throw OliphauntError.engine("\(label) is missing null terminator")
        }
        guard let end = bytes[offset..<bytes.count].firstIndex(of: 0) else {
            throw OliphauntError.engine("\(label) is missing null terminator")
        }
        let raw = bytes[offset..<end]
        offset = end + 1
        guard let value = String(bytes: raw, encoding: .utf8) else {
            throw OliphauntError.engine("\(label) is not valid UTF-8")
        }
        return value
    }

    private mutating func take(count: Int, label: String) throws -> [UInt8] {
        guard count >= 0, offset + count <= bytes.count else {
            throw OliphauntError.engine("truncated \(label)")
        }
        let start = offset
        offset += count
        return Array(bytes[start..<offset])
    }
}
