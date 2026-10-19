actor AsyncStringSignal {
    private var result: String?
    private var waiters: [CheckedContinuation<String, Never>] = []

    func complete(_ value: String) {
        guard result == nil else { return }
        result = value
        let current = waiters
        waiters.removeAll()
        current.forEach { $0.resume(returning: value) }
    }

    func wait() async -> String {
        if let result { return result }
        return await withCheckedContinuation { continuation in
            waiters.append(continuation)
        }
    }

    func current() -> String? { result }
}
