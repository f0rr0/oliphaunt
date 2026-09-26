import Foundation

enum OliphauntReadyStatus: Equatable, Sendable {
    case idle
    case transaction
    case failedTransaction
}

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

public enum OliphauntValueFormat: Equatable, Sendable {
    case text
    case binary
}

public struct OliphauntQueryParam: Equatable, Sendable {
    public let typeOID: OliphauntPostgresOID?
    public let format: OliphauntValueFormat
    public let bytes: Data?

    public init(
        typeOID: OliphauntPostgresOID? = nil,
        format: OliphauntValueFormat = .text,
        bytes: Data?
    ) {
        self.typeOID = typeOID
        // PostgreSQL encodes every null Bind value with length -1, so a null
        // has no observable text-versus-binary representation.
        self.format = bytes == nil ? .text : format
        self.bytes = bytes
    }

    public static let null = OliphauntQueryParam(bytes: nil)

    public static func typedNull(_ typeOID: OliphauntPostgresOID) -> OliphauntQueryParam {
        OliphauntQueryParam(typeOID: typeOID, bytes: nil)
    }

    public static func text(
        _ value: String,
        typeOID: OliphauntPostgresOID? = nil
    ) -> OliphauntQueryParam {
        OliphauntQueryParam(typeOID: typeOID, bytes: Data(value.utf8))
    }

    public static func binary(
        _ value: Data,
        typeOID: OliphauntPostgresOID? = nil
    ) -> OliphauntQueryParam {
        OliphauntQueryParam(typeOID: typeOID, format: .binary, bytes: value)
    }

    public static func binary(
        _ bytes: [UInt8],
        typeOID: OliphauntPostgresOID? = nil
    ) -> OliphauntQueryParam {
        .binary(Data(bytes), typeOID: typeOID)
    }

    public static func string(_ value: String) -> OliphauntQueryParam {
        .text(value, typeOID: OliphauntPostgresOID.text)
    }

    public static func bool(_ value: Bool) -> OliphauntQueryParam {
        .text(value ? "t" : "f", typeOID: OliphauntPostgresOID.bool)
    }

    public static func int16(_ value: Int16) -> OliphauntQueryParam {
        .text(String(value), typeOID: OliphauntPostgresOID.int2)
    }

    public static func int32(_ value: Int32) -> OliphauntQueryParam {
        .text(String(value), typeOID: OliphauntPostgresOID.int4)
    }

    public static func int64(_ value: Int64) -> OliphauntQueryParam {
        .text(String(value), typeOID: OliphauntPostgresOID.int8)
    }

    public static func float(_ value: Float) -> OliphauntQueryParam {
        .text(String(value), typeOID: OliphauntPostgresOID.float4)
    }

    public static func double(_ value: Double) -> OliphauntQueryParam {
        .text(String(value), typeOID: OliphauntPostgresOID.float8)
    }

    public static func bytes(_ value: Data) -> OliphauntQueryParam {
        .binary(value, typeOID: OliphauntPostgresOID.bytea)
    }

    public static func uuid(_ value: UUID) -> OliphauntQueryParam {
        .text(value.uuidString.lowercased(), typeOID: OliphauntPostgresOID.uuid)
    }
}

public struct OliphauntQueryField: Equatable, Sendable {
    public let name: String
    public let tableOID: UInt32
    public let tableAttribute: Int16
    public let typeOID: OliphauntPostgresOID
    public let typeSize: Int16
    public let typeModifier: Int32
    public let format: OliphauntQueryFormat
}

public struct OliphauntQueryRow: Equatable, Sendable {
    public let values: [Data?]

    private let fields: [OliphauntQueryField]

    init(values: [Data?], fields: [OliphauntQueryField] = []) {
        self.values = values
        self.fields = fields
    }

    public static func == (lhs: OliphauntQueryRow, rhs: OliphauntQueryRow) -> Bool {
        lhs.values == rhs.values && lhs.fields == rhs.fields
    }

    public func raw(_ column: Int) throws -> Data? {
        guard values.indices.contains(column) else {
            throw OliphauntError.engine("query row has no column at index \(column)")
        }
        return values[column]
    }

    public func raw(_ column: String) throws -> Data? {
        try raw(resolveColumn(column))
    }

    public func text(_ column: Int) throws -> String? {
        guard let value = try raw(column) else {
            return nil
        }
        guard let text = String(data: value, encoding: .utf8) else {
            throw OliphauntError.engine("query value is not valid UTF-8")
        }
        return text
    }

    public func value<T: OliphauntPostgresDecodable>(
        at column: Int,
        as type: T.Type = T.self
    ) throws -> T? {
        guard fields.indices.contains(column) else {
            throw OliphauntError.engine("query row has no field metadata at index \(column)")
        }
        return try T.decodePostgres(try raw(column), field: fields[column])
    }

    public func value<T: OliphauntPostgresDecodable>(
        named column: String,
        as type: T.Type = T.self
    ) throws -> T? {
        try value(at: resolveColumn(column), as: type)
    }

    private func resolveColumn(_ name: String) throws -> Int {
        let matches = fields.indices.filter { fields[$0].name == name }
        guard let index = matches.first else {
            throw OliphauntError.engine("query row has no column named \(String(reflecting: name))")
        }
        guard matches.count == 1 else {
            throw OliphauntError.engine(
                "query row has multiple columns named \(String(reflecting: name)); use a column index"
            )
        }
        return index
    }
}

public struct OliphauntQueryResult: Equatable, Sendable {
    public let fields: [OliphauntQueryField]
    public let rows: [OliphauntQueryRow]
    public let commandTag: String?
    public let rowCount: Int?
    public let notices: [OliphauntPostgresNotice]
    let readyStatus: OliphauntReadyStatus

    init(
        fields: [OliphauntQueryField],
        rows: [OliphauntQueryRow],
        commandTag: String?,
        rowCount: Int?,
        notices: [OliphauntPostgresNotice],
        readyStatus: OliphauntReadyStatus = .idle
    ) {
        self.fields = fields
        self.rows = rows
        self.commandTag = commandTag
        self.rowCount = rowCount
        self.notices = notices
        self.readyStatus = readyStatus
    }

    public static func == (lhs: OliphauntQueryResult, rhs: OliphauntQueryResult) -> Bool {
        lhs.fields == rhs.fields &&
            lhs.rows == rhs.rows &&
            lhs.commandTag == rhs.commandTag &&
            lhs.rowCount == rhs.rowCount &&
            lhs.notices == rhs.notices
    }

    public func getText(row: Int, column: String) throws -> String? {
        guard rows.indices.contains(row) else {
            throw OliphauntError.engine("query result has no row at index \(row)")
        }
        guard let value = try rows[row].raw(column) else {
            return nil
        }
        guard let text = String(data: value, encoding: .utf8) else {
            throw OliphauntError.engine("query value is not valid UTF-8")
        }
        return text
    }
}

public struct OliphauntCommandResult: Equatable, Sendable {
    public let commandTag: String?
    public let rowCount: Int?
    public let notices: [OliphauntPostgresNotice]
    let readyStatus: OliphauntReadyStatus

    public init(
        commandTag: String?,
        rowCount: Int?,
        notices: [OliphauntPostgresNotice] = []
    ) {
        self.commandTag = commandTag
        self.rowCount = rowCount
        self.notices = notices
        self.readyStatus = .idle
    }

    init(
        commandTag: String?,
        rowCount: Int?,
        notices: [OliphauntPostgresNotice],
        readyStatus: OliphauntReadyStatus
    ) {
        self.commandTag = commandTag
        self.rowCount = rowCount
        self.notices = notices
        self.readyStatus = readyStatus
    }

    public static func == (lhs: OliphauntCommandResult, rhs: OliphauntCommandResult) -> Bool {
        lhs.commandTag == rhs.commandTag &&
            lhs.rowCount == rhs.rowCount &&
            lhs.notices == rhs.notices
    }
}

public struct OliphauntPostgresErrorField: Equatable, Sendable {
    public let code: UInt8
    public let value: String

    public init(code: UInt8, value: String) {
        self.code = code
        self.value = value
    }
}

public struct OliphauntPostgresDiagnostic: Equatable, Sendable, CustomStringConvertible {
    public let severity: String?
    public let sqlstate: String?
    public let message: String
    public let detail: String?
    public let hint: String?
    public let position: String?
    public let whereText: String?
    public let schemaName: String?
    public let tableName: String?
    public let columnName: String?
    public let dataTypeName: String?
    public let constraintName: String?
    public let fields: [OliphauntPostgresErrorField]

    public var localizedSeverity: String? { fieldValue(fields, 0x53) }
    public var nonlocalizedSeverity: String? { fieldValue(fields, 0x56) }
    public var internalPosition: String? { fieldValue(fields, 0x70) }
    public var internalQuery: String? { fieldValue(fields, 0x71) }
    public var file: String? { fieldValue(fields, 0x46) }
    public var line: String? { fieldValue(fields, 0x4c) }
    public var routine: String? { fieldValue(fields, 0x52) }

    public init(
        fields: [OliphauntPostgresErrorField],
        fallbackMessage: String = "PostgreSQL diagnostic"
    ) {
        self.fields = fields
        self.severity = fieldValue(fields, 0x53) ?? fieldValue(fields, 0x56)
        self.sqlstate = fieldValue(fields, 0x43)
        self.message = fieldValue(fields, 0x4d) ?? fallbackMessage
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

public typealias OliphauntPostgresNotice = OliphauntPostgresDiagnostic

public struct OliphauntPostgresError: Equatable, Sendable, CustomStringConvertible {
    public let diagnostic: OliphauntPostgresDiagnostic
    public let notices: [OliphauntPostgresNotice]

    public init(
        fields: [OliphauntPostgresErrorField],
        notices: [OliphauntPostgresNotice] = []
    ) {
        self.diagnostic = OliphauntPostgresDiagnostic(
            fields: fields,
            fallbackMessage: "PostgreSQL ErrorResponse"
        )
        self.notices = notices
    }

    init(
        diagnostic: OliphauntPostgresDiagnostic,
        notices: [OliphauntPostgresNotice]
    ) {
        self.diagnostic = diagnostic
        self.notices = notices
    }

    func attaching(notices: [OliphauntPostgresNotice]) -> OliphauntPostgresError {
        OliphauntPostgresError(diagnostic: diagnostic, notices: notices)
    }

    public var severity: String? { diagnostic.severity }
    public var localizedSeverity: String? { diagnostic.localizedSeverity }
    public var nonlocalizedSeverity: String? { diagnostic.nonlocalizedSeverity }
    public var sqlstate: String? { diagnostic.sqlstate }
    public var message: String { diagnostic.message }
    public var detail: String? { diagnostic.detail }
    public var hint: String? { diagnostic.hint }
    public var position: String? { diagnostic.position }
    public var internalPosition: String? { diagnostic.internalPosition }
    public var internalQuery: String? { diagnostic.internalQuery }
    public var whereText: String? { diagnostic.whereText }
    public var schemaName: String? { diagnostic.schemaName }
    public var tableName: String? { diagnostic.tableName }
    public var columnName: String? { diagnostic.columnName }
    public var dataTypeName: String? { diagnostic.dataTypeName }
    public var constraintName: String? { diagnostic.constraintName }
    public var file: String? { diagnostic.file }
    public var line: String? { diagnostic.line }
    public var routine: String? { diagnostic.routine }
    public var fields: [OliphauntPostgresErrorField] { diagnostic.fields }
    public var description: String { diagnostic.description }
}

public struct OliphauntQueryDescription: Equatable, Sendable {
    public let parameterTypes: [OliphauntPostgresOID]
    public let fields: [OliphauntQueryField]?
    public let notices: [OliphauntPostgresNotice]
    let readyStatus: OliphauntReadyStatus

    public init(
        parameterTypes: [OliphauntPostgresOID],
        fields: [OliphauntQueryField]?,
        notices: [OliphauntPostgresNotice] = []
    ) {
        self.parameterTypes = parameterTypes
        self.fields = fields
        self.notices = notices
        self.readyStatus = .idle
    }

    init(
        parameterTypes: [OliphauntPostgresOID],
        fields: [OliphauntQueryField]?,
        notices: [OliphauntPostgresNotice],
        readyStatus: OliphauntReadyStatus
    ) {
        self.parameterTypes = parameterTypes
        self.fields = fields
        self.notices = notices
        self.readyStatus = readyStatus
    }

    public static func == (lhs: OliphauntQueryDescription, rhs: OliphauntQueryDescription) -> Bool {
        lhs.parameterTypes == rhs.parameterTypes &&
            lhs.fields == rhs.fields &&
            lhs.notices == rhs.notices
    }
}

public enum OliphauntStatementResult: Equatable, Sendable {
    case command(OliphauntCommandResult)
    case rows(OliphauntQueryResult)
}

public struct OliphauntExecResult: Equatable, Sendable {
    public let statements: [OliphauntStatementResult]
    public let notices: [OliphauntPostgresNotice]
    let readyStatus: OliphauntReadyStatus

    public init(
        statements: [OliphauntStatementResult],
        notices: [OliphauntPostgresNotice] = []
    ) {
        self.statements = statements
        self.notices = notices
        self.readyStatus = .idle
    }

    init(
        statements: [OliphauntStatementResult],
        notices: [OliphauntPostgresNotice],
        readyStatus: OliphauntReadyStatus
    ) {
        self.statements = statements
        self.notices = notices
        self.readyStatus = readyStatus
    }

    public static func == (lhs: OliphauntExecResult, rhs: OliphauntExecResult) -> Bool {
        lhs.statements == rhs.statements && lhs.notices == rhs.notices
    }
}

public struct OliphauntPostgresOID: RawRepresentable, Hashable, Sendable, CustomStringConvertible {
    public let rawValue: UInt32

    public init(rawValue: UInt32) {
        self.rawValue = rawValue
    }

    public init(_ rawValue: UInt32) {
        self.rawValue = rawValue
    }

    public var description: String { String(rawValue) }

    public static let bool = OliphauntPostgresOID(16)
    public static let bytea = OliphauntPostgresOID(17)
    public static let char = OliphauntPostgresOID(18)
    public static let name = OliphauntPostgresOID(19)
    public static let int8 = OliphauntPostgresOID(20)
    public static let int2 = OliphauntPostgresOID(21)
    public static let int4 = OliphauntPostgresOID(23)
    public static let text = OliphauntPostgresOID(25)
    public static let oid = OliphauntPostgresOID(26)
    public static let json = OliphauntPostgresOID(114)
    public static let xml = OliphauntPostgresOID(142)
    public static let float4 = OliphauntPostgresOID(700)
    public static let float8 = OliphauntPostgresOID(701)
    public static let unknown = OliphauntPostgresOID(705)
    public static let bpchar = OliphauntPostgresOID(1_042)
    public static let varchar = OliphauntPostgresOID(1_043)
    public static let date = OliphauntPostgresOID(1_082)
    public static let time = OliphauntPostgresOID(1_083)
    public static let timestamp = OliphauntPostgresOID(1_114)
    public static let timestamptz = OliphauntPostgresOID(1_184)
    public static let interval = OliphauntPostgresOID(1_186)
    public static let timetz = OliphauntPostgresOID(1_266)
    public static let numeric = OliphauntPostgresOID(1_700)
    public static let uuid = OliphauntPostgresOID(2_950)
    public static let jsonb = OliphauntPostgresOID(3_802)

    public static let boolArray = OliphauntPostgresOID(1_000)
    public static let byteaArray = OliphauntPostgresOID(1_001)
    public static let charArray = OliphauntPostgresOID(1_002)
    public static let nameArray = OliphauntPostgresOID(1_003)
    public static let int2Array = OliphauntPostgresOID(1_005)
    public static let int4Array = OliphauntPostgresOID(1_007)
    public static let textArray = OliphauntPostgresOID(1_009)
    public static let bpcharArray = OliphauntPostgresOID(1_014)
    public static let varcharArray = OliphauntPostgresOID(1_015)
    public static let int8Array = OliphauntPostgresOID(1_016)
    public static let float4Array = OliphauntPostgresOID(1_021)
    public static let float8Array = OliphauntPostgresOID(1_022)
    public static let oidArray = OliphauntPostgresOID(1_028)
    public static let timestampArray = OliphauntPostgresOID(1_115)
    public static let dateArray = OliphauntPostgresOID(1_182)
    public static let timeArray = OliphauntPostgresOID(1_183)
    public static let timestamptzArray = OliphauntPostgresOID(1_185)
    public static let intervalArray = OliphauntPostgresOID(1_187)
    public static let timetzArray = OliphauntPostgresOID(1_270)
    public static let numericArray = OliphauntPostgresOID(1_231)
    public static let jsonArray = OliphauntPostgresOID(199)
    public static let xmlArray = OliphauntPostgresOID(143)
    public static let uuidArray = OliphauntPostgresOID(2_951)
    public static let jsonbArray = OliphauntPostgresOID(3_807)
}

public protocol OliphauntPostgresDecodable: Sendable {
    static func decodePostgres(
        _ bytes: Data?,
        field: OliphauntQueryField
    ) throws -> Self?
}

extension String: OliphauntPostgresDecodable {
    public static func decodePostgres(
        _ bytes: Data?,
        field: OliphauntQueryField
    ) throws -> String? {
        try requirePostgresOID(
            field,
            allowed: [
                OliphauntPostgresOID.bool,
                OliphauntPostgresOID.char,
                OliphauntPostgresOID.name,
                OliphauntPostgresOID.int8,
                OliphauntPostgresOID.int2,
                OliphauntPostgresOID.int4,
                OliphauntPostgresOID.text,
                OliphauntPostgresOID.oid,
                OliphauntPostgresOID.json,
                OliphauntPostgresOID.xml,
                OliphauntPostgresOID.float4,
                OliphauntPostgresOID.float8,
                OliphauntPostgresOID.unknown,
                OliphauntPostgresOID.bpchar,
                OliphauntPostgresOID.varchar,
                OliphauntPostgresOID.date,
                OliphauntPostgresOID.time,
                OliphauntPostgresOID.timetz,
                OliphauntPostgresOID.timestamp,
                OliphauntPostgresOID.timestamptz,
                OliphauntPostgresOID.interval,
                OliphauntPostgresOID.numeric,
                OliphauntPostgresOID.uuid,
                OliphauntPostgresOID.jsonb,
            ],
            target: "String"
        )
        try requirePostgresFormat(field, allowed: [.text], target: "String")
        guard let bytes else { return nil }
        return try decodePostgresUTF8(bytes, field: field, target: "String")
    }
}

extension Bool: OliphauntPostgresDecodable {
    public static func decodePostgres(
        _ bytes: Data?,
        field: OliphauntQueryField
    ) throws -> Bool? {
        try requirePostgresOID(field, allowed: [OliphauntPostgresOID.bool], target: "Bool")
        try requirePostgresFormat(field, allowed: [.text, .binary], target: "Bool")
        guard let bytes else { return nil }
        switch field.format {
        case .text:
            switch try decodePostgresUTF8(bytes, field: field, target: "Bool") {
            case "t": return true
            case "f": return false
            default: throw invalidPostgresValue(field, target: "Bool")
            }
        case .binary:
            guard bytes.count == 1 else { throw invalidPostgresValue(field, target: "Bool") }
            switch bytes[bytes.startIndex] {
            case 0: return false
            case 1: return true
            default: throw invalidPostgresValue(field, target: "Bool")
            }
        case .other:
            throw unsupportedPostgresFormat(field, target: "Bool")
        }
    }
}

extension Int16: OliphauntPostgresDecodable {
    public static func decodePostgres(
        _ bytes: Data?,
        field: OliphauntQueryField
    ) throws -> Int16? {
        try requirePostgresOID(field, allowed: [OliphauntPostgresOID.int2], target: "Int16")
        try requirePostgresFormat(field, allowed: [.text, .binary], target: "Int16")
        guard let bytes else { return nil }
        switch field.format {
        case .text:
            guard let value = Int16(try decodePostgresUTF8(bytes, field: field, target: "Int16")) else {
                throw invalidPostgresValue(field, target: "Int16")
            }
            return value
        case .binary:
            let value = try postgresUnsigned(bytes, count: 2, field: field, target: "Int16")
            return Int16(bitPattern: UInt16(value))
        case .other:
            throw unsupportedPostgresFormat(field, target: "Int16")
        }
    }
}

extension Int32: OliphauntPostgresDecodable {
    public static func decodePostgres(
        _ bytes: Data?,
        field: OliphauntQueryField
    ) throws -> Int32? {
        try requirePostgresOID(field, allowed: [OliphauntPostgresOID.int4], target: "Int32")
        try requirePostgresFormat(field, allowed: [.text, .binary], target: "Int32")
        guard let bytes else { return nil }
        switch field.format {
        case .text:
            guard let value = Int32(try decodePostgresUTF8(bytes, field: field, target: "Int32")) else {
                throw invalidPostgresValue(field, target: "Int32")
            }
            return value
        case .binary:
            let value = try postgresUnsigned(bytes, count: 4, field: field, target: "Int32")
            return Int32(bitPattern: UInt32(value))
        case .other:
            throw unsupportedPostgresFormat(field, target: "Int32")
        }
    }
}

extension Int64: OliphauntPostgresDecodable {
    public static func decodePostgres(
        _ bytes: Data?,
        field: OliphauntQueryField
    ) throws -> Int64? {
        try requirePostgresOID(field, allowed: [OliphauntPostgresOID.int8], target: "Int64")
        try requirePostgresFormat(field, allowed: [.text, .binary], target: "Int64")
        guard let bytes else { return nil }
        switch field.format {
        case .text:
            guard let value = Int64(try decodePostgresUTF8(bytes, field: field, target: "Int64")) else {
                throw invalidPostgresValue(field, target: "Int64")
            }
            return value
        case .binary:
            let value = try postgresUnsigned(bytes, count: 8, field: field, target: "Int64")
            return Int64(bitPattern: value)
        case .other:
            throw unsupportedPostgresFormat(field, target: "Int64")
        }
    }
}

extension Float: OliphauntPostgresDecodable {
    public static func decodePostgres(
        _ bytes: Data?,
        field: OliphauntQueryField
    ) throws -> Float? {
        try requirePostgresOID(field, allowed: [OliphauntPostgresOID.float4], target: "Float")
        try requirePostgresFormat(field, allowed: [.text, .binary], target: "Float")
        guard let bytes else { return nil }
        switch field.format {
        case .text:
            guard let value = Float(try decodePostgresUTF8(bytes, field: field, target: "Float")) else {
                throw invalidPostgresValue(field, target: "Float")
            }
            return value
        case .binary:
            let bits = try postgresUnsigned(bytes, count: 4, field: field, target: "Float")
            return Float(bitPattern: UInt32(bits))
        case .other:
            throw unsupportedPostgresFormat(field, target: "Float")
        }
    }
}

extension Double: OliphauntPostgresDecodable {
    public static func decodePostgres(
        _ bytes: Data?,
        field: OliphauntQueryField
    ) throws -> Double? {
        try requirePostgresOID(field, allowed: [OliphauntPostgresOID.float8], target: "Double")
        try requirePostgresFormat(field, allowed: [.text, .binary], target: "Double")
        guard let bytes else { return nil }
        switch field.format {
        case .text:
            guard let value = Double(try decodePostgresUTF8(bytes, field: field, target: "Double")) else {
                throw invalidPostgresValue(field, target: "Double")
            }
            return value
        case .binary:
            let bits = try postgresUnsigned(bytes, count: 8, field: field, target: "Double")
            return Double(bitPattern: bits)
        case .other:
            throw unsupportedPostgresFormat(field, target: "Double")
        }
    }
}

extension Data: OliphauntPostgresDecodable {
    public static func decodePostgres(
        _ bytes: Data?,
        field: OliphauntQueryField
    ) throws -> Data? {
        try requirePostgresOID(field, allowed: [OliphauntPostgresOID.bytea], target: "Data")
        try requirePostgresFormat(field, allowed: [.text, .binary], target: "Data")
        guard let bytes else { return nil }
        switch field.format {
        case .binary:
            return bytes
        case .text:
            return try decodePostgresBytea(bytes, field: field)
        case .other:
            throw unsupportedPostgresFormat(field, target: "Data")
        }
    }
}

extension UUID: OliphauntPostgresDecodable {
    public static func decodePostgres(
        _ bytes: Data?,
        field: OliphauntQueryField
    ) throws -> UUID? {
        try requirePostgresOID(field, allowed: [OliphauntPostgresOID.uuid], target: "UUID")
        try requirePostgresFormat(field, allowed: [.text, .binary], target: "UUID")
        guard let bytes else { return nil }
        switch field.format {
        case .text:
            guard let value = UUID(uuidString: try decodePostgresUTF8(bytes, field: field, target: "UUID")) else {
                throw invalidPostgresValue(field, target: "UUID")
            }
            return value
        case .binary:
            let raw = [UInt8](bytes)
            guard raw.count == 16 else { throw invalidPostgresValue(field, target: "UUID") }
            return UUID(uuid: (
                raw[0], raw[1], raw[2], raw[3], raw[4], raw[5], raw[6], raw[7],
                raw[8], raw[9], raw[10], raw[11], raw[12], raw[13], raw[14], raw[15]
            ))
        case .other:
            throw unsupportedPostgresFormat(field, target: "UUID")
        }
    }
}

private func requirePostgresOID(
    _ field: OliphauntQueryField,
    allowed: Set<OliphauntPostgresOID>,
    target: String
) throws {
    guard allowed.contains(field.typeOID) else {
        throw OliphauntError.engine(
            "cannot decode PostgreSQL type OID \(field.typeOID.rawValue) as \(target) for column \(String(reflecting: field.name))"
        )
    }
}

private func requirePostgresFormat(
    _ field: OliphauntQueryField,
    allowed: [OliphauntQueryFormat],
    target: String
) throws {
    guard allowed.contains(field.format) else {
        throw unsupportedPostgresFormat(field, target: target)
    }
}

private func decodePostgresUTF8(
    _ bytes: Data,
    field: OliphauntQueryField,
    target: String
) throws -> String {
    guard field.format == .text || field.format == .binary else {
        throw unsupportedPostgresFormat(field, target: target)
    }
    guard let value = String(data: bytes, encoding: .utf8) else {
        throw invalidPostgresValue(field, target: target)
    }
    return value
}

private func postgresUnsigned(
    _ data: Data,
    count: Int,
    field: OliphauntQueryField,
    target: String
) throws -> UInt64 {
    guard data.count == count else {
        throw invalidPostgresValue(field, target: target)
    }
    return data.reduce(UInt64(0)) { ($0 << 8) | UInt64($1) }
}

private func decodePostgresBytea(
    _ data: Data,
    field: OliphauntQueryField
) throws -> Data {
    let input = [UInt8](data)
    if input.count >= 2, input[0] == 0x5c, input[1] == 0x78 {
        let hex = input.dropFirst(2)
        guard hex.count.isMultiple(of: 2) else {
            throw invalidPostgresValue(field, target: "Data")
        }
        var output = Data()
        output.reserveCapacity(hex.count / 2)
        var index = hex.startIndex
        while index < hex.endIndex {
            let next = hex.index(after: index)
            guard let high = hexNibble(hex[index]), let low = hexNibble(hex[next]) else {
                throw invalidPostgresValue(field, target: "Data")
            }
            output.append(high << 4 | low)
            index = hex.index(after: next)
        }
        return output
    }

    var output = Data()
    var index = 0
    while index < input.count {
        guard input[index] == 0x5c else {
            output.append(input[index])
            index += 1
            continue
        }
        guard index + 1 < input.count else {
            throw invalidPostgresValue(field, target: "Data")
        }
        if input[index + 1] == 0x5c {
            output.append(0x5c)
            index += 2
            continue
        }
        guard index + 3 < input.count,
              let first = byteaFirstOctalDigit(input[index + 1]),
              let second = octalDigit(input[index + 2]),
              let third = octalDigit(input[index + 3])
        else {
            throw invalidPostgresValue(field, target: "Data")
        }
        output.append(first << 6 | second << 3 | third)
        index += 4
    }
    return output
}

private func hexNibble(_ byte: UInt8) -> UInt8? {
    switch byte {
    case 0x30...0x39: byte - 0x30
    case 0x41...0x46: byte - 0x41 + 10
    case 0x61...0x66: byte - 0x61 + 10
    default: nil
    }
}

private func octalDigit(_ byte: UInt8) -> UInt8? {
    guard byte >= 0x30, byte <= 0x37 else { return nil }
    return byte - 0x30
}

private func byteaFirstOctalDigit(_ byte: UInt8) -> UInt8? {
    guard byte >= 0x30, byte <= 0x33 else { return nil }
    return byte - 0x30
}

private func invalidPostgresValue(
    _ field: OliphauntQueryField,
    target: String
) -> OliphauntError {
    .engine(
        "invalid PostgreSQL value for \(target) in column \(String(reflecting: field.name)) " +
            "(type OID \(field.typeOID.rawValue), format \(field.format))"
    )
}

private func unsupportedPostgresFormat(
    _ field: OliphauntQueryField,
    target: String
) -> OliphauntError {
    .engine(
        "cannot decode PostgreSQL format \(field.format) as \(target) for column \(String(reflecting: field.name)) " +
            "(type OID \(field.typeOID.rawValue))"
    )
}

func containsOliphauntTopLevelCopy(_ sql: String) -> Bool {
    oliphauntStructuredSQLFacts(sql).containsTopLevelCopy
}

func containsOliphauntTransactionChain(_ sql: String) -> Bool {
    oliphauntStructuredSQLFacts(sql).containsTransactionChain
}

private struct OliphauntStructuredSQLFacts {
    var containsTopLevelCopy = false
    var containsTransactionChain = false

    mutating func formUnion(_ other: OliphauntStructuredSQLFacts) {
        containsTopLevelCopy = containsTopLevelCopy || other.containsTopLevelCopy
        containsTransactionChain = containsTransactionChain || other.containsTransactionChain
    }
}

private enum OliphauntTransactionChainState {
    case none
    case afterRollback
    case afterOptionalKind
    case afterAnd
}

private func oliphauntStructuredSQLFacts(_ sql: String) -> OliphauntStructuredSQLFacts {
    var facts = scanOliphauntStructuredSQL(sql, plainStringBackslashEscapes: false)
    facts.formUnion(scanOliphauntStructuredSQL(sql, plainStringBackslashEscapes: true))
    return facts
}

private func rejectOliphauntStructuredSQL(
    _ sql: String,
    managedTransaction: Bool = false
) throws {
    let facts = oliphauntStructuredSQLFacts(sql)
    if facts.containsTopLevelCopy {
        throw OliphauntError.engine(
            "structured SQL does not support COPY because it requires streaming protocol ownership; " +
                "use execProtocolRaw or execProtocolRawStream"
        )
    }
    if managedTransaction, facts.containsTransactionChain {
        throw OliphauntError.engine(
            "managed transactions do not support ROLLBACK or ABORT AND CHAIN; " +
                "return from or throw inside the transaction callback instead"
        )
    }
}

private func scanOliphauntStructuredSQL(
    _ sql: String,
    plainStringBackslashEscapes: Bool
) -> OliphauntStructuredSQLFacts {
    let bytes = Array(sql.utf8)
    var index = 0
    var statementStart = true
    var chainState = OliphauntTransactionChainState.none
    var facts = OliphauntStructuredSQLFacts()

    while index < bytes.count {
        let byte = bytes[index]
        if isOliphauntSQLWhitespace(byte) {
            index += 1
        } else if byte == 0x3b {
            statementStart = true
            chainState = .none
            index += 1
        } else if index + 1 < bytes.count, byte == 0x2d, bytes[index + 1] == 0x2d {
            index += 2
            while index < bytes.count, bytes[index] != 0x0a, bytes[index] != 0x0d {
                index += 1
            }
        } else if index + 1 < bytes.count, byte == 0x2f, bytes[index + 1] == 0x2a {
            index = skipOliphauntBlockComment(bytes, from: index)
        } else if byte == 0x27 {
            statementStart = false
            chainState = .none
            index = skipOliphauntQuotedSQL(
                bytes,
                from: index,
                quote: 0x27,
                backslashEscapes: plainStringBackslashEscapes ||
                    oliphauntQuoteHasEscapePrefix(bytes, quoteIndex: index)
            )
        } else if byte == 0x22 {
            statementStart = false
            chainState = .none
            index = skipOliphauntQuotedSQL(
                bytes,
                from: index,
                quote: 0x22,
                backslashEscapes: false
            )
        } else if byte == 0x24 {
            statementStart = false
            chainState = .none
            guard let delimiter = oliphauntDollarQuoteDelimiter(bytes, from: index) else {
                index += 1
                continue
            }
            let contentStart = index + delimiter.count
            if let closing = oliphauntIndex(of: delimiter, in: bytes, from: contentStart) {
                index = closing + delimiter.count
            } else {
                index = bytes.count
            }
        } else if isOliphauntSQLIdentifierStart(byte) {
            let start = index
            index += 1
            while index < bytes.count, isOliphauntSQLIdentifierContinuation(bytes[index]) {
                index += 1
            }
            let token = bytes[start..<index]
            if statementStart {
                if isOliphauntSQLKeyword(token, "COPY") {
                    facts.containsTopLevelCopy = true
                }
                if isOliphauntSQLKeyword(token, "ROLLBACK") ||
                    isOliphauntSQLKeyword(token, "ABORT") {
                    chainState = .afterRollback
                } else {
                    chainState = .none
                }
            } else {
                switch chainState {
                case .none:
                    break
                case .afterRollback:
                    if isOliphauntSQLKeyword(token, "WORK") ||
                        isOliphauntSQLKeyword(token, "TRANSACTION") {
                        chainState = .afterOptionalKind
                    } else if isOliphauntSQLKeyword(token, "AND") {
                        chainState = .afterAnd
                    } else {
                        chainState = .none
                    }
                case .afterOptionalKind:
                    chainState = isOliphauntSQLKeyword(token, "AND") ? .afterAnd : .none
                case .afterAnd:
                    if isOliphauntSQLKeyword(token, "CHAIN") {
                        facts.containsTransactionChain = true
                    }
                    chainState = .none
                }
            }
            statementStart = false
        } else {
            statementStart = false
            chainState = .none
            index += 1
        }
    }
    return facts
}

private func skipOliphauntBlockComment(
    _ bytes: [UInt8],
    from start: Int
) -> Int {
    var index = start + 2
    var depth = 1
    while index < bytes.count, depth > 0 {
        if index + 1 < bytes.count, bytes[index] == 0x2f, bytes[index + 1] == 0x2a {
            depth += 1
            index += 2
        } else if index + 1 < bytes.count, bytes[index] == 0x2a, bytes[index + 1] == 0x2f {
            depth -= 1
            index += 2
        } else {
            index += 1
        }
    }
    return index
}

private func skipOliphauntQuotedSQL(
    _ bytes: [UInt8],
    from start: Int,
    quote: UInt8,
    backslashEscapes: Bool
) -> Int {
    var index = start + 1
    while index < bytes.count {
        if backslashEscapes, bytes[index] == 0x5c, index + 1 < bytes.count {
            index += 2
        } else if bytes[index] == quote {
            if index + 1 < bytes.count, bytes[index + 1] == quote {
                index += 2
            } else {
                return index + 1
            }
        } else {
            index += 1
        }
    }
    return bytes.count
}

private func oliphauntQuoteHasEscapePrefix(_ bytes: [UInt8], quoteIndex: Int) -> Bool {
    guard quoteIndex > 0, bytes[quoteIndex - 1] == 0x45 || bytes[quoteIndex - 1] == 0x65 else {
        return false
    }
    return quoteIndex < 2 || !isOliphauntSQLIdentifierContinuation(bytes[quoteIndex - 2])
}

private func oliphauntDollarQuoteDelimiter(_ bytes: [UInt8], from start: Int) -> [UInt8]? {
    var index = start + 1
    guard index < bytes.count else { return nil }
    if bytes[index] == 0x24 { return [0x24, 0x24] }
    guard isOliphauntSQLIdentifierStart(bytes[index]) else { return nil }
    index += 1
    while index < bytes.count, isOliphauntSQLIdentifierContinuation(bytes[index]), bytes[index] != 0x24 {
        index += 1
    }
    guard index < bytes.count, bytes[index] == 0x24 else { return nil }
    return Array(bytes[start...index])
}

private func oliphauntIndex(
    of needle: [UInt8],
    in bytes: [UInt8],
    from start: Int
) -> Int? {
    guard !needle.isEmpty, start <= bytes.count - needle.count else { return nil }
    for index in start...(bytes.count - needle.count) {
        if bytes[index..<(index + needle.count)].elementsEqual(needle) { return index }
    }
    return nil
}

private func isOliphauntSQLWhitespace(_ byte: UInt8) -> Bool {
    byte == 0x20 || (0x09...0x0d).contains(byte)
}

private func isOliphauntSQLIdentifierStart(_ byte: UInt8) -> Bool {
    byte == 0x5f || (0x41...0x5a).contains(byte) || (0x61...0x7a).contains(byte) || byte >= 0x80
}

private func isOliphauntSQLIdentifierContinuation(_ byte: UInt8) -> Bool {
    isOliphauntSQLIdentifierStart(byte) || (0x30...0x39).contains(byte) || byte == 0x24
}

private func isOliphauntSQLKeyword(_ bytes: ArraySlice<UInt8>, _ keyword: StaticString) -> Bool {
    let expectedBytes = keyword.withUTF8Buffer { Array($0) }
    guard bytes.count == expectedBytes.count else { return false }
    return zip(bytes, expectedBytes).allSatisfy { byte, expected in
        byte == expected || byte == expected + 0x20
    }
}

public extension OliphauntDatabase {
    func execute(
        _ sql: String,
        parameters: [OliphauntQueryParam] = []
    ) async throws -> OliphauntCommandResult {
        try rejectOliphauntStructuredSQL(sql)
        let request = try OliphauntProtocol.extendedQuery(sql, parameters: parameters)
        return try await runTypedOperation(request, transactionToken: nil) { response in
            let result = try parseOliphauntCommandResponse(response, expectedProtocol: .extended)
            return (result, result.readyStatus)
        }
    }

    func query(
        _ sql: String,
        parameters: [OliphauntQueryParam] = []
    ) async throws -> OliphauntQueryResult {
        try rejectOliphauntStructuredSQL(sql)
        let request = try OliphauntProtocol.extendedQuery(sql, parameters: parameters)
        return try await runTypedOperation(request, transactionToken: nil) { response in
            let result = try parseOliphauntQueryResponse(response, expectedProtocol: .extended)
            return (result, result.readyStatus)
        }
    }

    func exec(_ sql: String) async throws -> OliphauntExecResult {
        try rejectOliphauntStructuredSQL(sql)
        let request = try OliphauntProtocol.simpleQuery(sql)
        return try await runTypedOperation(request, transactionToken: nil) { response in
            let result = try parseOliphauntExecResponse(response)
            return (result, result.readyStatus)
        }
    }

    func describe(
        _ sql: String,
        parameterTypes: [OliphauntPostgresOID] = []
    ) async throws -> OliphauntQueryDescription {
        let request = try OliphauntProtocol.describeQuery(sql, parameterTypes: parameterTypes)
        return try await runTypedOperation(request, transactionToken: nil) { response in
            let result = try parseOliphauntDescribeResponse(response)
            return (result, result.readyStatus)
        }
    }
}

public extension OliphauntTransaction {
    func execute(
        _ sql: String,
        parameters: [OliphauntQueryParam] = []
    ) async throws -> OliphauntCommandResult {
        try rejectOliphauntStructuredSQL(sql, managedTransaction: true)
        let request = try OliphauntProtocol.extendedQuery(sql, parameters: parameters)
        return try await runTypedOperation(request) { response in
            let result = try parseOliphauntCommandResponse(response, expectedProtocol: .extended)
            return (result, result.readyStatus)
        }
    }

    func query(
        _ sql: String,
        parameters: [OliphauntQueryParam] = []
    ) async throws -> OliphauntQueryResult {
        try rejectOliphauntStructuredSQL(sql, managedTransaction: true)
        let request = try OliphauntProtocol.extendedQuery(sql, parameters: parameters)
        return try await runTypedOperation(request) { response in
            let result = try parseOliphauntQueryResponse(response, expectedProtocol: .extended)
            return (result, result.readyStatus)
        }
    }

    func exec(_ sql: String) async throws -> OliphauntExecResult {
        try rejectOliphauntStructuredSQL(sql, managedTransaction: true)
        let request = try OliphauntProtocol.simpleQuery(sql)
        return try await runTypedOperation(request) { response in
            let result = try parseOliphauntExecResponse(response)
            return (result, result.readyStatus)
        }
    }

    func describe(
        _ sql: String,
        parameterTypes: [OliphauntPostgresOID] = []
    ) async throws -> OliphauntQueryDescription {
        let request = try OliphauntProtocol.describeQuery(sql, parameterTypes: parameterTypes)
        return try await runTypedOperation(request) { response in
            let result = try parseOliphauntDescribeResponse(response)
            return (result, result.readyStatus)
        }
    }
}

enum OliphauntProtocol {
    static func simpleQuery(_ sql: String) throws -> Data {
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

    static func extendedQuery(
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
        if let index = parameters.firstIndex(where: { $0.typeOID?.rawValue == 0 }) {
            throw OliphauntError.engine(
                "extended query parameter \(index + 1) has explicit PostgreSQL type OID 0; " +
                    "omit typeOID to request PostgreSQL inference"
            )
        }

        var packet = Data()
        try appendParse(
            to: &packet,
            sql: sql,
            parameterTypes: parameters.map { $0.typeOID ?? OliphauntPostgresOID(0) }
        )
        try appendBind(to: &packet, parameters: parameters)
        try appendDescribePortal(to: &packet)
        try appendExecute(to: &packet)
        appendFrontendMessage(to: &packet, tag: 0x53, body: Data())
        return packet
    }

    static func describeQuery(
        _ sql: String,
        parameterTypes: [OliphauntPostgresOID]
    ) throws -> Data {
        guard parameterTypes.count <= Int(Int16.max) else {
            throw OliphauntError.engine(
                "describe supports at most \(Int16.max) parameter types, got \(parameterTypes.count)"
            )
        }
        guard !sql.utf8.contains(0) else {
            throw OliphauntError.engine("describe SQL must not contain NUL bytes")
        }

        var packet = Data()
        try appendParse(to: &packet, sql: sql, parameterTypes: parameterTypes)
        try appendDescribeStatement(to: &packet)
        appendFrontendMessage(to: &packet, tag: 0x53, body: Data())
        return packet
    }

    private static func appendParse(
        to packet: inout Data,
        sql: String,
        parameterTypes: [OliphauntPostgresOID]
    ) throws {
        var body = Data()
        try appendCString(to: &body, "")
        try appendCString(to: &body, sql)
        appendInt16(to: &body, Int16(parameterTypes.count))
        for typeOID in parameterTypes {
            appendInt32(to: &body, Int32(bitPattern: typeOID.rawValue))
        }
        appendFrontendMessage(to: &packet, tag: 0x50, body: body)
    }

    private static func appendBind(to packet: inout Data, parameters: [OliphauntQueryParam]) throws {
        var body = Data()
        try appendCString(to: &body, "")
        try appendCString(to: &body, "")

        appendInt16(to: &body, Int16(parameters.count))
        for parameter in parameters {
            switch parameter.format {
            case .binary:
                appendInt16(to: &body, 1)
            case .text:
                appendInt16(to: &body, 0)
            }
        }

        appendInt16(to: &body, Int16(parameters.count))
        for parameter in parameters {
            if let value = parameter.bytes {
                try appendSizedValue(to: &body, value)
            } else {
                appendInt32(to: &body, -1)
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

    private static func appendDescribeStatement(to packet: inout Data) throws {
        var body = Data([0x53])
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

enum OliphauntExpectedProtocol {
    case extended
    case simple
    case either
}

private enum OliphauntSingleStatementPhase {
    case detect
    case parse
    case bind
    case description
    case rows
    case noData
    case complete
}

private extension OliphauntExpectedProtocol {
    var initialSingleStatementPhase: OliphauntSingleStatementPhase {
        switch self {
        case .extended: .parse
        case .simple, .either: .detect
        }
    }
}

func parseOliphauntCommandResponse(
    _ data: Data,
    expectedProtocol: OliphauntExpectedProtocol = .extended
) throws -> OliphauntCommandResult {
    var cursor = OliphauntByteCursor(data)
    var sawReady = false
    var commandTag: String?
    var phase = expectedProtocol.initialSingleStatementPhase
    var notices: [OliphauntPostgresNotice] = []
    var readyStatus: OliphauntReadyStatus?
    var postgresError: OliphauntPostgresError?

    while !cursor.isAtEnd {
        let tag = try cursor.readUInt8(label: "backend message tag")
        let length = try cursor.readInt32(label: "backend message length")
        guard length >= 4 else {
            throw OliphauntError.engine("invalid backend message length \(length)")
        }
        let body = try cursor.readData(count: Int(length - 4), label: "backend message body")

        try rejectBackendMessageAfterError(tag, postgresError: postgresError, operation: "execute()")

        if phase == .complete, ![UInt8(0x53), 0x4e, 0x41, 0x5a].contains(tag) {
            throw OliphauntError.engine("execute() received backend message after statement completion")
        }

        var bodyCursor = OliphauntByteCursor(body)
        switch tag {
        case 0x45:
            let parsed = try parseErrorResponse(&bodyCursor)
            if postgresError == nil { postgresError = parsed }
        case 0x43:
            let validCompletion = phase == .noData ||
                (phase == .detect && expectedProtocol != .extended)
            guard validCompletion else {
                throw OliphauntError.engine(
                    "execute() received CommandComplete before complete statement metadata"
                )
            }
            commandTag = try bodyCursor.readCString(label: "CommandComplete tag")
            try bodyCursor.requireEnd(label: "CommandComplete")
            phase = .complete
        case 0x54, 0x44:
            throw OliphauntError.engine(
                "execute() received rows; use query() for row results"
            )
        case 0x47, 0x48, 0x57, 0x64, 0x63:
            throw OliphauntError.engine(
                "execute() does not support COPY protocol responses; use execProtocolRaw or execProtocolRawStream for COPY traffic"
            )
        case 0x5a:
            readyStatus = try parseReadyForQuery(body)
            sawReady = true
            if !cursor.isAtEnd {
                throw OliphauntError.engine("backend returned bytes after ReadyForQuery")
            }
        case 0x31:
            let validParse = phase == .parse ||
                (phase == .detect && expectedProtocol == .either)
            guard validParse else {
                throw OliphauntError.engine("execute() received ParseComplete out of order")
            }
            try bodyCursor.requireEnd(label: "ParseComplete")
            phase = .bind
        case 0x32:
            guard phase == .bind else {
                throw OliphauntError.engine("execute() received BindComplete before ParseComplete")
            }
            try bodyCursor.requireEnd(label: "BindComplete")
            phase = .description
        case 0x33:
            throw OliphauntError.engine("execute() received unsolicited CloseComplete")
        case 0x49:
            let validCompletion = phase == .noData ||
                (phase == .detect && expectedProtocol != .extended)
            guard validCompletion else {
                throw OliphauntError.engine(
                    "execute() received EmptyQueryResponse before complete statement metadata"
                )
            }
            try bodyCursor.requireEnd(label: "EmptyQueryResponse")
            phase = .complete
        case 0x6e:
            guard phase == .description else {
                throw OliphauntError.engine("execute() received NoData out of order")
            }
            try bodyCursor.requireEnd(label: "NoData")
            phase = .noData
        case 0x53:
            try validateParameterStatus(&bodyCursor)
        case 0x4e:
            notices.append(try parseNoticeResponse(&bodyCursor))
        case 0x41:
            try validateNotificationResponse(&bodyCursor)
        default:
            throw OliphauntError.engine(
                "execute() received unexpected backend message tag \(hexBackendTag(tag))"
            )
        }
    }

    guard sawReady else {
        throw OliphauntError.engine("query response ended before ReadyForQuery")
    }
    if let postgresError {
        throw OliphauntError.postgres(postgresError.attaching(notices: notices))
    }
    guard phase == .complete else {
        throw OliphauntError.engine("execute response ended before statement completion")
    }
    return OliphauntCommandResult(
        commandTag: commandTag,
        rowCount: commandTag.flatMap(oliphauntCommandTagRowCount),
        notices: notices,
        readyStatus: readyStatus ?? .idle
    )
}

func parseOliphauntQueryResponse(
    _ data: Data,
    expectedProtocol: OliphauntExpectedProtocol = .extended
) throws -> OliphauntQueryResult {
    var cursor = OliphauntByteCursor(data)
    var fields: [OliphauntQueryField]?
    var rows: [OliphauntQueryRow] = []
    var commandTag: String?
    var phase = expectedProtocol.initialSingleStatementPhase
    var sawReady = false
    var notices: [OliphauntPostgresNotice] = []
    var readyStatus: OliphauntReadyStatus?
    var postgresError: OliphauntPostgresError?

    while !cursor.isAtEnd {
        let tag = try cursor.readUInt8(label: "backend message tag")
        let length = try cursor.readInt32(label: "backend message length")
        guard length >= 4 else {
            throw OliphauntError.engine("invalid backend message length \(length)")
        }
        let body = try cursor.readData(count: Int(length - 4), label: "backend message body")
        try rejectBackendMessageAfterError(tag, postgresError: postgresError, operation: "query()")
        if phase == .complete, ![UInt8(0x53), 0x4e, 0x41, 0x5a].contains(tag) {
            throw OliphauntError.engine("query() received backend message after statement completion")
        }
        var bodyCursor = OliphauntByteCursor(body)

        switch tag {
        case 0x54:
            let validDescription = phase == .description ||
                (phase == .detect && expectedProtocol != .extended)
            guard validDescription else {
                throw OliphauntError.engine("query() received RowDescription out of order")
            }
            fields = try parseRowDescription(&bodyCursor)
            try bodyCursor.requireEnd(label: "RowDescription")
            phase = .rows
        case 0x44:
            guard phase == .rows else {
                throw OliphauntError.engine("DataRow arrived before RowDescription")
            }
            guard let activeFields = fields else {
                throw OliphauntError.engine("DataRow arrived before RowDescription")
            }
            rows.append(try parseDataRow(&bodyCursor, fields: activeFields))
            try bodyCursor.requireEnd(label: "DataRow")
        case 0x43:
            let validCompletion = phase == .rows || phase == .noData ||
                (phase == .detect && expectedProtocol != .extended)
            guard validCompletion else {
                throw OliphauntError.engine(
                    "query() received CommandComplete before complete statement metadata"
                )
            }
            commandTag = try bodyCursor.readCString(label: "CommandComplete tag")
            try bodyCursor.requireEnd(label: "CommandComplete")
            phase = .complete
        case 0x45:
            let parsed = try parseErrorResponse(&bodyCursor)
            if postgresError == nil { postgresError = parsed }
        case 0x47, 0x48, 0x57, 0x64, 0x63:
            throw OliphauntError.engine(
                "query() does not support COPY protocol responses; use execProtocolRaw or execProtocolRawStream for COPY traffic"
            )
        case 0x5a:
            readyStatus = try parseReadyForQuery(body)
            sawReady = true
            if !cursor.isAtEnd {
                throw OliphauntError.engine("backend returned bytes after ReadyForQuery")
            }
        case 0x31:
            let validParse = phase == .parse ||
                (phase == .detect && expectedProtocol == .either)
            guard validParse else {
                throw OliphauntError.engine("query() received ParseComplete out of order")
            }
            try bodyCursor.requireEnd(label: "ParseComplete")
            phase = .bind
        case 0x32:
            guard phase == .bind else {
                throw OliphauntError.engine("query() received BindComplete before ParseComplete")
            }
            try bodyCursor.requireEnd(label: "BindComplete")
            phase = .description
        case 0x33:
            throw OliphauntError.engine("query() received unsolicited CloseComplete")
        case 0x49:
            let validCompletion = phase == .noData ||
                (phase == .detect && expectedProtocol != .extended)
            guard validCompletion else {
                throw OliphauntError.engine(
                    "query() received EmptyQueryResponse before complete statement metadata"
                )
            }
            try bodyCursor.requireEnd(label: "EmptyQueryResponse")
            phase = .complete
        case 0x6e:
            guard phase == .description else {
                throw OliphauntError.engine("query() received NoData out of order")
            }
            try bodyCursor.requireEnd(label: "NoData")
            phase = .noData
        case 0x53:
            try validateParameterStatus(&bodyCursor)
        case 0x4e:
            notices.append(try parseNoticeResponse(&bodyCursor))
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
    if let postgresError {
        throw OliphauntError.postgres(postgresError.attaching(notices: notices))
    }
    guard phase == .complete else {
        throw OliphauntError.engine("query response ended before statement completion")
    }

    return OliphauntQueryResult(
        fields: fields ?? [],
        rows: rows,
        commandTag: commandTag,
        rowCount: commandTag.flatMap(oliphauntCommandTagRowCount),
        notices: notices,
        readyStatus: readyStatus ?? .idle
    )
}

func parseOliphauntExecResponse(_ data: Data) throws -> OliphauntExecResult {
    var cursor = OliphauntByteCursor(data)
    var fields: [OliphauntQueryField]?
    var rows: [OliphauntQueryRow] = []
    var notices: [OliphauntPostgresNotice] = []
    var statementNotices: [OliphauntPostgresNotice] = []
    var results: [OliphauntStatementResult] = []
    var sawCompletion = false
    var sawReady = false
    var readyStatus: OliphauntReadyStatus?
    var postgresError: OliphauntPostgresError?

    while !cursor.isAtEnd {
        let tag = try cursor.readUInt8(label: "backend message tag")
        let length = try cursor.readInt32(label: "backend message length")
        guard length >= 4 else {
            throw OliphauntError.engine("invalid backend message length \(length)")
        }
        let body = try cursor.readData(count: Int(length - 4), label: "backend message body")
        try rejectBackendMessageAfterError(tag, postgresError: postgresError, operation: "exec()")
        var bodyCursor = OliphauntByteCursor(body)

        switch tag {
        case 0x54:
            guard fields == nil, rows.isEmpty else {
                throw OliphauntError.engine("exec() received a new result set before CommandComplete")
            }
            fields = try parseRowDescription(&bodyCursor)
            try bodyCursor.requireEnd(label: "RowDescription")
        case 0x44:
            guard let activeFields = fields else {
                throw OliphauntError.engine("DataRow arrived before RowDescription")
            }
            rows.append(try parseDataRow(&bodyCursor, fields: activeFields))
            try bodyCursor.requireEnd(label: "DataRow")
        case 0x43:
            let commandTag = try bodyCursor.readCString(label: "CommandComplete tag")
            try bodyCursor.requireEnd(label: "CommandComplete")
            if let fields {
                results.append(.rows(OliphauntQueryResult(
                    fields: fields,
                    rows: rows,
                    commandTag: commandTag,
                    rowCount: oliphauntCommandTagRowCount(commandTag),
                    notices: statementNotices
                )))
            } else {
                results.append(.command(OliphauntCommandResult(
                    commandTag: commandTag,
                    rowCount: oliphauntCommandTagRowCount(commandTag),
                    notices: statementNotices
                )))
            }
            fields = nil
            rows = []
            statementNotices = []
            sawCompletion = true
        case 0x49:
            guard fields == nil, rows.isEmpty else {
                throw OliphauntError.engine(
                    "exec() received EmptyQueryResponse while a row result was pending"
                )
            }
            try bodyCursor.requireEnd(label: "EmptyQueryResponse")
            statementNotices = []
            sawCompletion = true
        case 0x45:
            let parsed = try parseErrorResponse(&bodyCursor)
            if postgresError == nil { postgresError = parsed }
        case 0x47, 0x48, 0x57, 0x64, 0x63:
            throw OliphauntError.engine(
                "exec() does not support COPY protocol responses; use execProtocolRaw or execProtocolRawStream for COPY traffic"
            )
        case 0x5a:
            readyStatus = try parseReadyForQuery(body)
            guard fields == nil, rows.isEmpty else {
                throw OliphauntError.engine("exec response ended before CommandComplete")
            }
            sawReady = true
            if !cursor.isAtEnd {
                throw OliphauntError.engine("backend returned bytes after ReadyForQuery")
            }
        case 0x31, 0x32, 0x33, 0x6e:
            throw OliphauntError.engine(
                "exec() received extended-protocol control message tag \(hexBackendTag(tag))"
            )
        case 0x53:
            try validateParameterStatus(&bodyCursor)
        case 0x4e:
            let notice = try parseNoticeResponse(&bodyCursor)
            notices.append(notice)
            statementNotices.append(notice)
        case 0x41:
            try validateNotificationResponse(&bodyCursor)
        default:
            throw OliphauntError.engine(
                "exec() received unexpected backend message tag \(hexBackendTag(tag))"
            )
        }
    }

    guard sawReady else {
        throw OliphauntError.engine("exec response ended before ReadyForQuery")
    }
    if let postgresError {
        throw OliphauntError.postgres(postgresError.attaching(notices: notices))
    }
    guard sawCompletion else {
        throw OliphauntError.engine("exec response ended before statement completion")
    }
    return OliphauntExecResult(
        statements: results,
        notices: notices,
        readyStatus: readyStatus ?? .idle
    )
}

func parseOliphauntDescribeResponse(_ data: Data) throws -> OliphauntQueryDescription {
    var cursor = OliphauntByteCursor(data)
    var parameterTypes: [OliphauntPostgresOID]?
    var fields: [OliphauntQueryField]?
    var sawParseComplete = false
    var sawDescription = false
    var notices: [OliphauntPostgresNotice] = []
    var sawReady = false
    var readyStatus: OliphauntReadyStatus?
    var postgresError: OliphauntPostgresError?

    while !cursor.isAtEnd {
        let tag = try cursor.readUInt8(label: "backend message tag")
        let length = try cursor.readInt32(label: "backend message length")
        guard length >= 4 else {
            throw OliphauntError.engine("invalid backend message length \(length)")
        }
        let body = try cursor.readData(count: Int(length - 4), label: "backend message body")
        try rejectBackendMessageAfterError(tag, postgresError: postgresError, operation: "describe()")
        if sawDescription, ![UInt8(0x53), 0x4e, 0x41, 0x5a].contains(tag) {
            throw OliphauntError.engine(
                "describe() received backend message after statement description"
            )
        }
        var bodyCursor = OliphauntByteCursor(body)

        switch tag {
        case 0x31:
            guard !sawParseComplete, parameterTypes == nil, !sawDescription else {
                throw OliphauntError.engine("describe() received ParseComplete out of order")
            }
            try bodyCursor.requireEnd(label: "ParseComplete")
            sawParseComplete = true
        case 0x74:
            guard sawParseComplete else {
                throw OliphauntError.engine("describe() received ParameterDescription before ParseComplete")
            }
            guard parameterTypes == nil else {
                throw OliphauntError.engine("describe() received multiple ParameterDescription messages")
            }
            let count = try bodyCursor.readInt16(label: "ParameterDescription count")
            guard count >= 0 else {
                throw OliphauntError.engine("invalid ParameterDescription count \(count)")
            }
            var parsed: [OliphauntPostgresOID] = []
            parsed.reserveCapacity(Int(count))
            for _ in 0..<count {
                parsed.append(OliphauntPostgresOID(
                    try bodyCursor.readUInt32(label: "parameter type oid")
                ))
            }
            try bodyCursor.requireEnd(label: "ParameterDescription")
            parameterTypes = parsed
        case 0x54:
            guard sawParseComplete, parameterTypes != nil else {
                throw OliphauntError.engine("describe() received RowDescription before statement metadata")
            }
            guard !sawDescription else {
                throw OliphauntError.engine("describe() received multiple RowDescription messages")
            }
            fields = try parseRowDescription(&bodyCursor)
            sawDescription = true
            try bodyCursor.requireEnd(label: "RowDescription")
        case 0x6e:
            guard sawParseComplete, parameterTypes != nil else {
                throw OliphauntError.engine("describe() received NoData before statement metadata")
            }
            guard !sawDescription else {
                throw OliphauntError.engine("describe() received both RowDescription and NoData")
            }
            try bodyCursor.requireEnd(label: "NoData")
            fields = nil
            sawDescription = true
        case 0x45:
            let parsed = try parseErrorResponse(&bodyCursor)
            if postgresError == nil { postgresError = parsed }
        case 0x5a:
            readyStatus = try parseReadyForQuery(body)
            sawReady = true
            if !cursor.isAtEnd {
                throw OliphauntError.engine("backend returned bytes after ReadyForQuery")
            }
        case 0x53:
            try validateParameterStatus(&bodyCursor)
        case 0x4e:
            notices.append(try parseNoticeResponse(&bodyCursor))
        case 0x41:
            try validateNotificationResponse(&bodyCursor)
        default:
            throw OliphauntError.engine(
                "describe() received unexpected backend message tag \(hexBackendTag(tag))"
            )
        }
    }

    guard sawReady else {
        throw OliphauntError.engine("describe response ended before ReadyForQuery")
    }
    if let postgresError {
        throw OliphauntError.postgres(postgresError.attaching(notices: notices))
    }
    guard sawParseComplete else {
        throw OliphauntError.engine("describe response did not include ParseComplete")
    }
    guard let parameterTypes else {
        throw OliphauntError.engine("describe response did not include ParameterDescription")
    }
    guard sawDescription else {
        throw OliphauntError.engine("describe response did not include RowDescription or NoData")
    }
    return OliphauntQueryDescription(
        parameterTypes: parameterTypes,
        fields: fields,
        notices: notices,
        readyStatus: readyStatus ?? .idle
    )
}

private func oliphauntCommandTagRowCount(_ commandTag: String) -> Int? {
    let parts = commandTag.split(whereSeparator: { $0 == " " || $0 == "\t" })
    guard let command = parts.first?.uppercased(),
          ["SELECT", "INSERT", "UPDATE", "DELETE", "MERGE", "MOVE", "FETCH", "COPY"].contains(command),
          let value = parts.last,
          let count = UInt64(String(value)),
          count <= UInt64(Int.max)
    else {
        return nil
    }
    return Int(count)
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
            typeOID: OliphauntPostgresOID(try cursor.readUInt32(label: "field type oid")),
            typeSize: try cursor.readInt16(label: "field type size"),
            typeModifier: try cursor.readInt32(label: "field type modifier"),
            format: OliphauntQueryFormat(code: try cursor.readInt16(label: "field format"))
        ))
    }
    return fields
}

private func parseDataRow(
    _ cursor: inout OliphauntByteCursor,
    fields: [OliphauntQueryField]
) throws -> OliphauntQueryRow {
    let count = try cursor.readInt16(label: "DataRow column count")
    guard count >= 0 else {
        throw OliphauntError.engine("invalid DataRow column count \(count)")
    }
    guard Int(count) == fields.count else {
        throw OliphauntError.engine(
            "DataRow column count \(count) does not match RowDescription count \(fields.count)"
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
    return OliphauntQueryRow(values: values, fields: fields)
}

private func parseErrorResponse(
    _ cursor: inout OliphauntByteCursor
) throws -> OliphauntPostgresError {
    var fields: [OliphauntPostgresErrorField] = []
    while true {
        guard !cursor.isAtEnd else {
            throw OliphauntError.engine("ErrorResponse is missing terminator")
        }
        let code = try cursor.readUInt8(label: "ErrorResponse field code")
        if code == 0 {
            try cursor.requireEnd(label: "ErrorResponse")
            return OliphauntPostgresError(fields: fields)
        }
        fields.append(OliphauntPostgresErrorField(
            code: code,
            value: try cursor.readCString(label: "ErrorResponse field")
        ))
    }
}

private func parseNoticeResponse(
    _ cursor: inout OliphauntByteCursor
) throws -> OliphauntPostgresNotice {
    var fields: [OliphauntPostgresErrorField] = []
    while true {
        guard !cursor.isAtEnd else {
            throw OliphauntError.engine("NoticeResponse is missing terminator")
        }
        let code = try cursor.readUInt8(label: "NoticeResponse field code")
        if code == 0 {
            try cursor.requireEnd(label: "NoticeResponse")
            return OliphauntPostgresNotice(
                fields: fields,
                fallbackMessage: "PostgreSQL NoticeResponse"
            )
        }
        fields.append(OliphauntPostgresErrorField(
            code: code,
            value: try cursor.readCString(label: "NoticeResponse field")
        ))
    }
}

private func fieldValue(_ fields: [OliphauntPostgresErrorField], _ code: UInt8) -> String? {
    fields.first { $0.code == code }?.value
}

private func hexBackendTag(_ tag: UInt8) -> String {
    let hex = String(tag, radix: 16, uppercase: false)
    return "0x" + (hex.count == 1 ? "0\(hex)" : hex)
}

func inspectOliphauntTerminalReadyStatus(_ data: Data) throws -> OliphauntReadyStatus {
    var cursor = OliphauntByteCursor(data)
    var readyStatus: OliphauntReadyStatus?

    while !cursor.isAtEnd {
        guard readyStatus == nil else {
            throw OliphauntError.engine("backend returned bytes after ReadyForQuery")
        }
        let tag = try cursor.readUInt8(label: "backend message tag")
        let length = try cursor.readInt32(label: "backend message length")
        guard length >= 4 else {
            throw OliphauntError.engine("invalid backend message length \(length)")
        }
        let body = try cursor.readData(count: Int(length - 4), label: "backend message body")
        if tag == 0x5a {
            readyStatus = try parseReadyForQuery(body)
        }
    }

    guard let readyStatus else {
        throw OliphauntError.engine("backend response ended before ReadyForQuery")
    }
    return readyStatus
}

struct OliphauntStructuredTransactionProtocolOutcome: Sendable {
    var readyStatus: OliphauntReadyStatus
    var lifecycleCommandTag: String?
}

func inspectOliphauntStructuredTransactionProtocolOutcome(
    _ data: Data
) throws -> OliphauntStructuredTransactionProtocolOutcome {
    var cursor = OliphauntByteCursor(data)
    var readyStatus: OliphauntReadyStatus?
    var lifecycleCommandTag: String?

    while !cursor.isAtEnd {
        guard readyStatus == nil else {
            throw OliphauntError.engine("backend returned bytes after ReadyForQuery")
        }
        let tag = try cursor.readUInt8(label: "backend message tag")
        let length = try cursor.readInt32(label: "backend message length")
        guard length >= 4 else {
            throw OliphauntError.engine("invalid backend message length \(length)")
        }
        let body = try cursor.readData(count: Int(length - 4), label: "backend message body")
        if tag == 0x43 {
            var bodyCursor = OliphauntByteCursor(body)
            let commandTag = try bodyCursor.readCString(label: "CommandComplete tag")
            try bodyCursor.requireEnd(label: "CommandComplete")
            if lifecycleCommandTag == nil,
               oliphauntStructuredTransactionLifecycleCommandTags.contains(commandTag) {
                lifecycleCommandTag = commandTag
            }
        } else if tag == 0x5a {
            readyStatus = try parseReadyForQuery(body)
        }
    }

    guard let readyStatus else {
        throw OliphauntError.engine("backend response ended before ReadyForQuery")
    }
    return OliphauntStructuredTransactionProtocolOutcome(
        readyStatus: readyStatus,
        lifecycleCommandTag: lifecycleCommandTag
    )
}

private let oliphauntStructuredTransactionLifecycleCommandTags: Set<String> = [
    "BEGIN",
    "START TRANSACTION",
    "COMMIT",
    "PREPARE TRANSACTION",
    "COMMIT PREPARED",
    "ROLLBACK PREPARED",
]

private func rejectBackendMessageAfterError(
    _ tag: UInt8,
    postgresError: OliphauntPostgresError?,
    operation: String
) throws {
    guard postgresError != nil else { return }
    guard [UInt8(0x4e), 0x53, 0x41, 0x5a].contains(tag) else {
        throw OliphauntError.engine(
            "\(operation) received backend message tag \(hexBackendTag(tag)) after ErrorResponse"
        )
    }
}

private func parseReadyForQuery(_ body: Data) throws -> OliphauntReadyStatus {
    guard body.count == 1 else {
        throw OliphauntError.engine("ReadyForQuery contained \(body.count) bytes, expected 1")
    }
    switch body[body.startIndex] {
    case 0x49:
        return .idle
    case 0x54:
        return .transaction
    case 0x45:
        return .failedTransaction
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
