import Foundation

/// An explicitly selected extension supplied by a package or the SDK's contrib distribution.
public struct OliphauntExtension: Equatable, Sendable {
    public let sqlName: String
    public let product: String
    public let version: String?
    private let prepareResources: @Sendable () throws -> Void

    public init(
        sqlName: String,
        product: String,
        version: String? = nil,
        prepare: @escaping @Sendable () throws -> Void = {}
    ) {
        self.sqlName = sqlName
        self.product = product
        self.version = version
        self.prepareResources = prepare
    }

    public static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.sqlName == rhs.sqlName && lhs.product == rhs.product && lhs.version == rhs.version
    }

    func prepare() throws {
        _ = try OliphauntRuntimeResources.validateExtensionIds([sqlName])
        guard product.hasPrefix("oliphaunt-extension-"),
              product == "oliphaunt-extension-contrib-pg18" || version?.isEmpty == false else {
            throw OliphauntError.engine("extension descriptor must identify its release product and version")
        }
        #if OLIPHAUNT_PACKAGED_CONTRIB
        if product == "oliphaunt-extension-contrib-pg18" { try prepareBundledContrib(sqlName) }
        #endif
        try prepareResources()
    }
}

/// Optional ICU resources; the package owns their version and bundle location.
public struct OliphauntIcuData: Equatable, Sendable {
    public let version: String
    public let resourceDirectory: URL?

    public init(version: String, resourceDirectory: URL? = nil) {
        self.version = version
        self.resourceDirectory = resourceDirectory
    }
}

extension OliphauntConfiguration {
    var extensionSqlNames: [String] { extensions.map(\.sqlName) }

    func prepareExtensionResources() throws {
        var selected: [String: OliphauntExtension] = [:]
        for value in extensions {
            if let existing = selected[value.sqlName], existing != value {
                throw OliphauntError.engine("conflicting extension descriptors for '\(value.sqlName)'")
            }
            selected[value.sqlName] = value
        }
        for name in selected.keys.sorted() {
            try selected[name]?.prepare()
        }
    }
}

func selectedOliphauntExtensions(_ names: [String]) throws -> Set<String> {
    var selected = Set<String>()
    func visit(_ name: String) throws {
        guard selected.insert(name).inserted else { return }
        guard let contract = oliphauntExtensionRuntimeContracts[name] else {
            throw OliphauntError.engine("unknown extension '\(name)'")
        }
        for dependency in contract.dependencies { try visit(dependency) }
    }
    for name in names { try visit(name) }
    return selected
}

func includeSelectedOliphauntRuntimeFile(_ path: String, extensions: Set<String>, icu: Bool) -> Bool {
    if !icu && (path == "share/icu" || path.hasPrefix("share/icu/")) { return false }
    let file = path.split(separator: "/").last.map(String.init) ?? ""
    if path.hasPrefix("share/postgresql/extension/") {
        if let owner = oliphauntExtensionRuntimeContracts.keys.first(where: {
            file == "\($0).control" || file == "\($0).sql" || file.hasPrefix("\($0)--")
        }), !extensions.contains(owner) { return false }
    }
    if path.hasPrefix("lib/postgresql/") {
        let owners = oliphauntExtensionRuntimeContracts.filter { _, contract in
            contract.module.map { file == "\($0).so" || file == "\($0).dylib" } ?? false
        }.keys
        if !owners.isEmpty && !owners.contains(where: { extensions.contains($0) }) { return false }
    }
    return true
}
