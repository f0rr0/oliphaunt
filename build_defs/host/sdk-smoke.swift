import Foundation

let value = UUID(uuidString: "12345678-1234-5678-9abc-123456789abc")!
precondition(value.uuidString.lowercased() == "12345678-1234-5678-9abc-123456789abc")
precondition(URL(fileURLWithPath: "/native/sdk").lastPathComponent == "sdk")
print("Swift SDK compile, link and execution passed")
