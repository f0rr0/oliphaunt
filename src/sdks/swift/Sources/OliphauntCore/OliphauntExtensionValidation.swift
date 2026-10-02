import Foundation

package func validateOliphauntExtensionIds(_ values: [String]) throws -> Set<String> {
    var result = Set<String>()
    for value in values.map({ $0.trimmingCharacters(in: .whitespacesAndNewlines) }) where !value.isEmpty {
        guard value.utf8.allSatisfy({ (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0) || [46, 95, 45].contains($0) }) else {
            throw OliphauntError.engine("Swift Oliphaunt extension id '\(value)' must contain only ASCII letters, digits, '.', '_' or '-'")
        }
        result.insert(value)
    }
    return result
}
