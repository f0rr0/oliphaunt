import UIKit
import Foundation
import Darwin
import CryptoKit
import OliphauntBroker

@main
final class App: UIResponder, UIApplicationDelegate {
    var window: UIWindow?
    func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        let window = UIWindow(frame: UIScreen.main.bounds)
        window.rootViewController = UIViewController()
        window.makeKeyAndVisible()
        self.window = window
        Task {
            do { try await run(); report("PASS") }
            catch { report("FAIL: \(error)") }
        }
        return true
    }

    func report(_ message: String) {
        print("BROKER_TEST \(message)")
        let file = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("broker-result.txt")
        try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        let previous = (try? String(contentsOf: file, encoding: .utf8)) ?? ""
        try? (previous + message + "\n").write(to: file, atomically: true, encoding: .utf8)
    }

    func open(_ name: String = "lifecycle", timeout: Duration = .seconds(20)) async throws -> OliphauntDatabase {
        try await OliphauntBroker.open(configuration: .init(storage: .applicationData(name: name)), options: .init(startupTimeout: .seconds(60), operationTimeout: timeout))
    }

    func run() async throws {
        let mode = CommandLine.arguments.dropFirst().first ?? "smoke"
        let walMarker = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("wal-marker.txt")
        report("START \(mode)")
        if mode == "open-death" || mode == "restore-death" {
            let name = "interrupted-" + UUID().uuidString
            let archive = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("backup.tar")
            report("KILL_NEW_WORKER_NOW")
            do {
                if mode == "open-death" { let db = try await open(name); try await db.close() }
                else { try await OliphauntBroker.restore(storage: .applicationData(name: name), from: archive) }
                throw Failure("interrupted operation succeeded")
            } catch let error as OliphauntBrokerError {
                guard error.requiresReopen else { throw error }
                report("INTERRUPTED \(error)")
            }
            if mode == "restore-death" {
                try await OliphauntBroker.restore(storage: .applicationData(name: name), from: archive)
                let restored = try await open(name)
                guard try await restored.query("SELECT count(*) AS n FROM lifecycle WHERE id=42").getText(row: 0, column: "n") == "1" else { throw Failure("restore retry lost data") }
                try await restored.close()
            } else {
                let recovered = try await open(name)
                _ = try await recovered.query("SELECT 1")
                try await recovered.close()
            }
            report("RETRY_RECOVERY")
            return
        }
        let db = try await open(timeout: mode == "deadline" ? .milliseconds(300) : .seconds(20))
        report("OPEN")
        let pid = try await db.query("SELECT pg_backend_pid() AS pid")
        report("WORKER \(try pid.getText(row: 0, column: "pid")!) HOST \(getpid())")
        guard dlsym(dlopen(nil, RTLD_NOW), "oliphaunt_version") == nil else { throw Failure("runtime leaked into host") }
        report("PGDATA \(try await db.query("SHOW data_directory").getText(row: 0, column: "data_directory")!)")
        if mode == "background" {
            report("BACKGROUND_NOW")
            _ = try await db.query("SELECT pg_sleep(5)")
            _ = try await db.query("SELECT 1")
            try await db.close()
            report("FOREGROUND_RECOVERY")
            return
        }
        if mode == "deadline" {
            do { _ = try await db.query("SELECT pg_sleep(60)"); throw Failure("deadline ignored") }
            catch let error as OliphauntBrokerError { guard error.reason == .deadline else { throw error } }
            catch OliphauntError.postgres(let error) { guard error.sqlstate == "57014" else { throw Failure(error.description) } }
            _ = try await db.query("SELECT 1")
            try await db.close()
            report("DEADLINE_RECOVERY")
            return
        }
        if mode == "recover" {
            let result = try await db.query("SELECT count(*) AS n FROM lifecycle WHERE id = 42")
            guard try result.getText(row: 0, column: "n") == "1" else { throw Failure("WAL recovery lost committed row") }
            guard try await db.query("SELECT marker FROM wal_probe").getText(row: 0, column: "marker") == String(contentsOf: walMarker, encoding: .utf8) else { throw Failure("new committed WAL marker lost") }
            try await db.close()
            report("WAL_RECOVERY")
            return
        }
        _ = try await db.exec("CREATE TABLE IF NOT EXISTS lifecycle(id integer PRIMARY KEY); INSERT INTO lifecycle VALUES (42) ON CONFLICT DO NOTHING")
        if mode == "host-death" || mode == "worker-death" {
            let marker = UUID().uuidString
            _ = try await db.exec("CREATE TABLE IF NOT EXISTS wal_probe(marker text); TRUNCATE wal_probe; INSERT INTO wal_probe VALUES ('\(marker)')")
            try marker.write(to: walMarker, atomically: true, encoding: .utf8)
            report("COMMITTED_WAL_MARKER \(marker)")
        }
        if mode == "host-death" {
            report("KILL_HOST_NOW")
            try await Task.sleep(for: .seconds(120))
            throw Failure("host was not terminated")
        }
        if mode == "worker-death" {
            let worker = Int32(try pid.getText(row: 0, column: "pid")!)!
            let query = Task { try await db.query("SELECT pg_sleep(60)") }
            try await Task.sleep(for: .milliseconds(250))
            guard kill(worker, SIGKILL) == 0 else { throw Failure("kill worker errno \(errno)") }
            do { _ = try await query.value; throw Failure("worker death query succeeded") }
            catch let error as OliphauntBrokerError { guard error.requiresReopen else { throw error }; report("WORKER_DEATH \(error)") }
            try? await db.close()
            let recovered = try await open()
            let row = try await recovered.query("SELECT count(*) AS n FROM lifecycle WHERE id = 42")
            guard try row.getText(row: 0, column: "n") == "1" else { throw Failure("worker WAL recovery lost row") }
            guard try await recovered.query("SELECT marker FROM wal_probe").getText(row: 0, column: "marker") == String(contentsOf: walMarker, encoding: .utf8) else { throw Failure("new committed WAL marker lost") }
            try await recovered.close()
            report("WAL_RECOVERY")
            return
        }
        if mode == "backup-death" {
            _ = try await db.exec("CREATE TABLE IF NOT EXISTS backup_payload(value text); ALTER TABLE backup_payload ALTER value SET STORAGE EXTERNAL; TRUNCATE backup_payload; INSERT INTO backup_payload VALUES(repeat('x', 67108864))")
            let archive = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("interrupted.tar")
            try? FileManager.default.removeItem(at: archive)
            let backup = Task { try await db.backup(to: archive) }
            let deadline = ContinuousClock.now.advanced(by: .seconds(10))
            while ContinuousClock.now < deadline {
                let files = try FileManager.default.contentsOfDirectory(at: archive.deletingLastPathComponent(), includingPropertiesForKeys: [.fileSizeKey])
                if try files.contains(where: { url in
                    guard url.lastPathComponent.hasPrefix(".oliphaunt-archive-") else { return false }
                    return try (url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0) > 1048576
                }) { break }
                try await Task.sleep(for: .milliseconds(1))
            }
            guard ContinuousClock.now < deadline else { throw Failure("backup never streamed") }
            report("BACKUP_STREAMING")
            guard kill(Int32(try pid.getText(row: 0, column: "pid")!)!, SIGKILL) == 0 else { throw Failure("kill worker failed") }
            do { try await backup.value; throw Failure("interrupted backup succeeded") }
            catch let error as OliphauntBrokerError { guard error.requiresReopen else { throw error }; report("BACKUP_INTERRUPTED") }
            guard !FileManager.default.fileExists(atPath: archive.path) else { throw Failure("partial backup published") }
            try? await db.close()
            let recovered = try await open()
            _ = try await recovered.query("SELECT 1")
            try await recovered.close()
            return
        }
        _ = try await db.exec("CREATE EXTENSION IF NOT EXISTS plpgsql; DO $$ BEGIN IF 1 <> 1 THEN RAISE EXCEPTION 'broken'; END IF; END $$")
        report("EXTENSION_ACTIVATION")
        do { _ = try await open(); throw Failure("second handle opened") }
        catch let error as OliphauntBrokerError { guard error.reason == .databaseInUse else { throw error } }
        report("OWNERSHIP_REJECTION")
        let large = try await db.query("SELECT repeat('x', 8388608) AS value")
        guard try large.getText(row: 0, column: "value")?.count == 8388608 else { throw Failure("large response truncated") }
        report("LARGE_RESPONSE")
        let sleeping = Task { try await db.query("SELECT pg_sleep(60)") }
        try await Task.sleep(for: .milliseconds(250))
        try await db.cancel()
        do { _ = try await sleeping.value; throw Failure("cancel did not interrupt query") }
        catch OliphauntError.postgres(let error) { guard error.sqlstate == "57014" else { throw Failure(error.description) } }
        _ = try await db.query("SELECT 1")
        report("CANCEL_RECOVERY")
        let archive = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("backup.tar")
        try? FileManager.default.removeItem(at: archive)
        try await db.backup(to: archive)
        let backupDigest = try SHA256.hash(data: Data(contentsOf: archive, options: .mappedIfSafe))
        do { try await db.backup(to: archive); throw Failure("backup overwrote destination") }
        catch is Failure { throw Failure("backup overwrote destination") }
        catch { guard try SHA256.hash(data: Data(contentsOf: archive, options: .mappedIfSafe)) == backupDigest else { throw Failure("existing archive changed") } }
        report("BACKUP_NO_CLOBBER")
        try await db.close()
        try await db.close()
        report("BACKUP_CLOSE")
        let restoredName = "restored-" + UUID().uuidString
        try await OliphauntBroker.restore(storage: .applicationData(name: restoredName), from: archive)
        let restored = try await open(restoredName)
        let result = try await restored.query("SELECT count(*) AS n FROM lifecycle WHERE id = 42")
        guard try result.getText(row: 0, column: "n") == "1" else { throw Failure("backup restore lost data") }
        try await restored.close()
        let reopened = try await open()
        try? await db.cancel()
        try await db.close()
        _ = try await reopened.query("SELECT 1")
        try await reopened.close()
        report("RESTORE_REOPEN")
    }
}
struct Failure: Error { let message: String; init(_ message: String) { self.message = message } }
