import Foundation

#if canImport(Darwin)
import Darwin
#elseif canImport(Glibc)
import Glibc
#endif

func validateOliphauntCompletePgdata(_ pgdata: URL) throws {
    try requireOliphauntRealDirectory(pgdata, label: "root")
    let version = pgdata.appendingPathComponent("PG_VERSION")
    try requireOliphauntRealRegularFile(version, label: "PG_VERSION", nonEmpty: true)
    guard try String(contentsOf: version, encoding: .utf8)
        .trimmingCharacters(in: .whitespacesAndNewlines) == "18"
    else {
        throw OliphauntError.engine("PGDATA PostgreSQL major must be 18: \(version.path)")
    }
    try requireOliphauntRealDirectory(
        pgdata.appendingPathComponent("global", isDirectory: true),
        label: "global"
    )
    try requireOliphauntRealRegularFile(
        pgdata.appendingPathComponent("global/pg_control"),
        label: "global/pg_control",
        nonEmpty: true
    )
    try requireOliphauntRealDirectory(
        pgdata.appendingPathComponent("pg_wal", isDirectory: true),
        label: "pg_wal"
    )
}

enum OliphauntPgdataPublication: Equatable {
    case published
    case existing
}

@discardableResult
func publishOliphauntPreparedPgdata(
    _ staging: URL,
    to destination: URL,
    didPublishDestination: () -> Void = {}
) throws -> OliphauntPgdataPublication {
    if FileManager.default.fileExists(atPath: destination.path),
       (try? validateOliphauntCompletePgdata(destination)) != nil
    {
        return .existing
    }
    try hardenOliphauntPgdataPermissions(at: staging)
    try validateOliphauntCompletePgdata(staging)
    try makeOliphauntPublicationTreeDurable(staging)
    try removeOliphauntEmptyDirectoryIfPresent(destination)

    do {
        try FileManager.default.moveItem(at: staging, to: destination)
    } catch let publicationError {
        if (try? validateOliphauntCompletePgdata(destination)) != nil {
            return .existing
        }
        throw publicationError
    }
    didPublishDestination()
    try syncOliphauntDirectory(destination.deletingLastPathComponent())
    try validateOliphauntCompletePgdata(destination)
    return .published
}

func recoverOliphauntManagedRootPublicationFailure(
    _ publicationError: Error,
    ownsPublishedPgdata: Bool,
    descriptorDefinitelyAbsent: () throws -> Bool,
    removePublishedPgdata: () throws -> Void,
    syncRoot: () throws -> Void
) throws -> Never {
    guard ownsPublishedPgdata else {
        throw publicationError
    }
    let descriptorIsAbsent: Bool
    do {
        descriptorIsAbsent = try descriptorDefinitelyAbsent()
    } catch let inspectionError {
        throw OliphauntError.engine(
            "database root descriptor publication failed (\(publicationError)); "
                + "preserved PGDATA because descriptor publication is uncertain (\(inspectionError))"
        )
    }
    guard descriptorIsAbsent else {
        throw publicationError
    }
    do {
        try removePublishedPgdata()
        try syncRoot()
    } catch let cleanupError {
        throw OliphauntError.engine(
            "database root descriptor publication failed (\(publicationError)); "
                + "failed to clean uncommitted PGDATA (\(cleanupError))"
        )
    }
    throw publicationError
}

func isOliphauntPathDefinitelyAbsent(_ path: URL) throws -> Bool {
    var metadata = stat()
    let result = path.path.withCString { lstat($0, &metadata) }
    if result == 0 {
        return false
    }
    let inspectionErrno = errno
    if inspectionErrno == ENOENT {
        return true
    }
    throw OliphauntError.engine(
        "failed to inspect \(path.path): \(String(cString: strerror(inspectionErrno)))"
    )
}

func finishOliphauntStaging<T>(
    _ result: Result<T, Error>,
    operation: String,
    cleanup: () throws -> Void
) throws -> T {
    do {
        try cleanup()
    } catch let cleanupError {
        switch result {
        case .success:
            throw OliphauntError.engine(
                "\(operation) staging cleanup failed (\(cleanupError))"
            )
        case .failure(let primaryError):
            throw OliphauntError.engine(
                "\(operation) failed (\(primaryError)); "
                    + "staging cleanup failed (\(cleanupError))"
            )
        }
    }
    return try result.get()
}

func removeOliphauntStagingIfPresent(_ staging: URL) throws {
    guard !(try isOliphauntPathDefinitelyAbsent(staging)) else {
        return
    }
    try FileManager.default.removeItem(at: staging)
    try syncOliphauntDirectory(staging.deletingLastPathComponent())
}

func hardenOliphauntPgdataPermissions(at pgdata: URL) throws {
    let fileManager = FileManager.default
    try fileManager.setAttributes([.posixPermissions: 0o700], ofItemAtPath: pgdata.path)
    guard let enumerator = fileManager.enumerator(
        at: pgdata,
        includingPropertiesForKeys: [.isDirectoryKey, .isSymbolicLinkKey],
        options: []
    ) else {
        return
    }

    for case let url as URL in enumerator {
        let values = try url.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
        if values.isSymbolicLink == true {
            continue
        }
        let permissions = values.isDirectory == true ? 0o700 : 0o600
        try fileManager.setAttributes([.posixPermissions: permissions], ofItemAtPath: url.path)
    }
}

private func removeOliphauntEmptyDirectoryIfPresent(_ directory: URL) throws {
    guard FileManager.default.fileExists(atPath: directory.path) else {
        return
    }
    try requireOliphauntRealDirectory(directory, label: "destination")
    let removalResult = directory.path.withCString { rmdir($0) }
    if removalResult == 0 || errno == ENOENT {
        return
    }
    if errno == ENOTEMPTY || errno == EEXIST {
        try validateOliphauntCompletePgdata(directory)
        return
    }
    throw OliphauntError.engine(
        "failed to remove empty PGDATA destination \(directory.path): \(String(cString: strerror(errno)))"
    )
}

func makeOliphauntPublicationTreeDurable(_ root: URL) throws {
    let fileManager = FileManager.default
    var directories = [root]
    guard let enumerator = fileManager.enumerator(
        at: root,
        includingPropertiesForKeys: [.isDirectoryKey, .isRegularFileKey, .isSymbolicLinkKey],
        options: []
    ) else {
        return
    }
    for case let url as URL in enumerator {
        let values = try url.resourceValues(
            forKeys: [.isDirectoryKey, .isRegularFileKey, .isSymbolicLinkKey]
        )
        if values.isSymbolicLink == true {
            throw OliphauntError.engine("publication tree contains a symbolic link: \(url.path)")
        }
        if values.isDirectory == true {
            directories.append(url)
        } else if values.isRegularFile == true {
            let handle = try FileHandle(forWritingTo: url)
            try handle.synchronize()
            try handle.close()
        } else {
            throw OliphauntError.engine("publication tree contains a special entry: \(url.path)")
        }
    }
    for directory in directories.reversed() {
        try syncOliphauntDirectory(directory)
    }
}

func syncOliphauntDirectory(_ directory: URL) throws {
    let descriptor = directory.path.withCString { open($0, O_RDONLY) }
    guard descriptor >= 0 else {
        throw OliphauntError.engine("failed to open publication directory for fsync: \(directory.path)")
    }
    let result = fsync(descriptor)
    let savedError = errno
    _ = close(descriptor)
    guard result == 0 else {
        throw OliphauntError.engine(
            "failed to fsync publication directory \(directory.path): \(String(cString: strerror(savedError)))"
        )
    }
}

private func requireOliphauntRealDirectory(_ url: URL, label: String) throws {
    let values = try url.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
    guard values.isDirectory == true, values.isSymbolicLink != true else {
        throw OliphauntError.engine("PGDATA \(label) must be a real directory: \(url.path)")
    }
}

private func requireOliphauntRealRegularFile(
    _ url: URL,
    label: String,
    nonEmpty: Bool
) throws {
    let values = try url.resourceValues(
        forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey]
    )
    guard values.isRegularFile == true,
          values.isSymbolicLink != true,
          !nonEmpty || (values.fileSize ?? 0) > 0
    else {
        throw OliphauntError.engine("PGDATA \(label) must be a nonempty real file: \(url.path)")
    }
}
