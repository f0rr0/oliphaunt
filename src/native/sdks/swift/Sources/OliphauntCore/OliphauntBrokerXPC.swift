#if canImport(XPC)
    import Foundation
    import XPC

    @available(iOS 26, macOS 26, *)
    package enum OliphauntBrokerXPC {
        package static func strings(_ values: [String]) -> xpc_object_t {
            let array = xpc_array_create(nil, 0)
            for value in values { xpc_array_set_string(array, XPC_ARRAY_APPEND, value) }
            return array
        }

        package static func strings(_ message: XPCDictionary, _ key: String) throws -> [String] {
            guard let array: xpc_object_t = message[key], xpc_get_type(array) == XPC_TYPE_ARRAY,
                xpc_array_get_count(array) <= 1024
            else { throw invalid("invalid \(key)") }
            return try (0..<xpc_array_get_count(array)).map { index in
                guard let value = xpc_array_get_string(array, index) else {
                    throw invalid("invalid \(key)")
                }
                return String(cString: value)
            }
        }

        package static func generation(_ message: XPCDictionary) throws -> Data {
            guard let text: String = message["generation"], let data = Data(base64Encoded: text),
                data.count == 16
            else {
                throw invalid("invalid worker generation")
            }
            return data
        }

        package static func invalid(_ detail: String) -> OliphauntBrokerError {
            .init(reason: .invalidRequest, detail: detail)
        }
    }
#endif
