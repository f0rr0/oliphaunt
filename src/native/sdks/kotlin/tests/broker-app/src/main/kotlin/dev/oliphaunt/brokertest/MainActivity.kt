package dev.oliphaunt.brokertest

import android.app.Activity
import android.os.Bundle
import android.os.Process
import android.util.Log
import dev.oliphaunt.*
import java.io.File
import java.util.UUID
import kotlinx.coroutines.*

class MainActivity : Activity() {
    private fun report(message: String) {
        Log.i("BROKER_TEST", message)
        File(filesDir, "broker-result.txt").appendText(message + "\n")
    }
    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        CoroutineScope(Dispatchers.IO).launch {
            try { run(intent.getStringExtra("mode") ?: "smoke"); report("PASS") }
            catch (error: Throwable) { report("FAIL: $error"); Log.e("BROKER_TEST", "failure", error) }
        }
    }
    private fun digest(file: File): ByteArray = file.inputStream().use { input ->
        val digest = java.security.MessageDigest.getInstance("SHA-256")
        val buffer = ByteArray(65536)
        while (true) {
            val count = input.read(buffer)
            if (count < 0) break
            digest.update(buffer, 0, count)
        }
        digest.digest()
    }
    private suspend fun open(name: String = "lifecycle", timeout: Long = 20_000) = OliphauntBroker.open(
        this, OliphauntConfig(storage = DatabaseStorage.ApplicationData(name)),
        OliphauntBrokerOptions(startupTimeoutMillis = 60_000, operationTimeoutMillis = timeout),
    )
    private suspend fun run(mode: String) = coroutineScope {
        report("START $mode")
        val walMarker = File(filesDir, "wal-marker.txt")
        if (mode == "open-death" || mode == "restore-death") {
            val name = "interrupted-" + UUID.randomUUID()
            val archive = File(filesDir, "backup.tar")
            report("KILL_NEW_WORKER_NOW")
            val failure = runCatching {
                if (mode == "open-death") open(name).close()
                else OliphauntBroker.restore(this@MainActivity, DatabaseStorage.ApplicationData(name), archive)
            }.exceptionOrNull()
            check(failure is OliphauntBrokerException && failure.requiresReopen) { "wrong interruption result: $failure" }
            report("INTERRUPTED $failure")
            if (mode == "restore-death") OliphauntBroker.restore(this@MainActivity, DatabaseStorage.ApplicationData(name), archive)
            val recovered = open(name)
            if (mode == "restore-death") check(recovered.query("SELECT count(*) AS n FROM lifecycle WHERE id=42").getText(0, "n") == "1")
            else recovered.query("SELECT 1")
            recovered.close(); report("RETRY_RECOVERY"); return@coroutineScope
        }
        val db = open(timeout = if (mode == "deadline") 300 else 20_000)
        report("OPEN")
        val worker = db.query("SELECT pg_backend_pid() AS pid").getText(0, "pid")!!.toInt()
        report("WORKER $worker HOST ${Process.myPid()}")
        check(!File("/proc/self/maps").readText().contains("/liboliphaunt.so")) { "runtime leaked into host" }
        report("PGDATA ${db.query("SHOW data_directory").getText(0, "data_directory")}")
        if (mode == "background") {
            report("BACKGROUND_NOW"); db.query("SELECT pg_sleep(5)"); db.query("SELECT 1"); db.close()
            report("FOREGROUND_RECOVERY"); return@coroutineScope
        }
        if (mode == "deadline") {
            val failure = runCatching { db.query("SELECT pg_sleep(60)") }.exceptionOrNull()
            check((failure is OliphauntBrokerException && failure.reason == BrokerFailureReason.Deadline) || (failure is PostgresException && failure.postgresError.sqlstate == "57014")) { "wrong deadline failure: $failure" }
            report("DEADLINE $failure")
            db.query("SELECT 1"); db.close(); report("DEADLINE_RECOVERY"); return@coroutineScope
        }
        if (mode == "recover") {
            check(db.query("SELECT count(*) AS n FROM lifecycle WHERE id = 42").getText(0, "n") == "1")
            check(db.query("SELECT marker FROM wal_probe").getText(0, "marker") == walMarker.readText()) { "new committed WAL marker lost" }
            db.close(); report("WAL_RECOVERY"); return@coroutineScope
        }
        db.exec("CREATE TABLE IF NOT EXISTS lifecycle(id integer PRIMARY KEY); INSERT INTO lifecycle VALUES (42) ON CONFLICT DO NOTHING")
        if (mode == "host-death" || mode == "worker-death") {
            val marker = UUID.randomUUID().toString()
            db.exec("CREATE TABLE IF NOT EXISTS wal_probe(marker text); TRUNCATE wal_probe; INSERT INTO wal_probe VALUES ('$marker')")
            walMarker.writeText(marker)
            report("COMMITTED_WAL_MARKER $marker")
        }
        if (mode == "host-death") { report("KILL_HOST_NOW"); delay(120_000); error("host was not terminated") }
        if (mode == "worker-death") {
            val query = async { runCatching { db.query("SELECT pg_sleep(60)") } }
            delay(250); Process.killProcess(worker)
            val error = query.await().exceptionOrNull()
            check(error is OliphauntBrokerException && error.requiresReopen) { "wrong worker-death result: $error" }
            report("WORKER_DEATH $error")
            runCatching { db.close() }
            val recovered = open()
            check(recovered.query("SELECT count(*) AS n FROM lifecycle WHERE id = 42").getText(0, "n") == "1")
            check(recovered.query("SELECT marker FROM wal_probe").getText(0, "marker") == walMarker.readText()) { "new committed WAL marker lost" }
            recovered.close(); report("WAL_RECOVERY"); return@coroutineScope
        }
        if (mode == "backup-death") {
            db.exec("CREATE TABLE IF NOT EXISTS backup_payload(value text); ALTER TABLE backup_payload ALTER value SET STORAGE EXTERNAL; TRUNCATE backup_payload; INSERT INTO backup_payload VALUES(repeat('x', 67108864))")
            val archive = File(filesDir, "interrupted.tar").also { it.delete() }
            val backup = async { runCatching { db.backup(archive) } }
            withTimeout(10_000) {
                while (filesDir.listFiles()?.none { it.name.startsWith(".oliphaunt-archive-") && it.length() > 1048576 } != false) delay(1)
            }
            report("BACKUP_STREAMING")
            Process.killProcess(worker)
            val failure = backup.await().exceptionOrNull()
            check(failure is OliphauntBrokerException && failure.requiresReopen) { "wrong backup interruption: $failure" }
            check(!archive.exists()) { "partial backup published" }
            report("BACKUP_INTERRUPTED")
            runCatching { db.close() }
            val recovered = open(); recovered.query("SELECT 1"); recovered.close()
            return@coroutineScope
        }
        db.exec("CREATE EXTENSION IF NOT EXISTS plpgsql; DO $$ BEGIN IF 1 <> 1 THEN RAISE EXCEPTION 'broken'; END IF; END $$")
        report("EXTENSION_ACTIVATION")
        check(runCatching { open() }.exceptionOrNull() is OliphauntBrokerException)
        report("OWNERSHIP_REJECTION")
        check(db.query("SELECT repeat('x', 8388608) AS value").getText(0, "value")!!.length == 8388608)
        report("LARGE_RESPONSE")
        val query = async { runCatching { db.query("SELECT pg_sleep(60)") } }
        delay(250); db.cancel()
        check(query.await().isFailure) { "cancel did not interrupt query" }
        db.query("SELECT 1"); report("CANCEL_RECOVERY")
        val archive = File(filesDir, "backup.tar")
        archive.delete()
        db.backup(archive)
        val backupDigest = digest(archive)
        check(runCatching { db.backup(archive) }.isFailure)
        check(digest(archive).contentEquals(backupDigest)) { "existing archive changed" }
        report("BACKUP_NO_CLOBBER")
        db.close(); db.close(); report("BACKUP_CLOSE")
        val restoredName = "restored-" + UUID.randomUUID()
        OliphauntBroker.restore(this@MainActivity, DatabaseStorage.ApplicationData(restoredName), archive)
        val restored = open(restoredName)
        check(restored.query("SELECT count(*) AS n FROM lifecycle WHERE id = 42").getText(0, "n") == "1")
        restored.close()
        val reopened = open(); runCatching { db.cancel() }; db.close(); reopened.query("SELECT 1"); reopened.close()
        report("RESTORE_REOPEN")
    }
}
