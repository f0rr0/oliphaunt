package dev.oliphaunt

// liboliphaunt-doc-example:kotlin-typed-query
// liboliphaunt-doc-example:kotlin-setup

import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class OliphauntDatabaseTest {
    @Test
    fun executeReturnsPostgresCommandMetadata() = runTest {
        val session = TestSession(commandResponse("UPDATE 3"))
        val database = OliphauntDatabase.open(EngineConfig(), TestEngine(session))
        val result = database.execute("UPDATE widgets SET ready = true")
        assertEquals("UPDATE 3", result.commandTag)
        assertEquals(3L, result.rowCount)
        assertEquals('P'.code.toByte(), session.requests.single().first())
    }

    @Test
    fun executeUsesExtendedProtocolForParameters() = runTest {
        val session = TestSession(commandResponse("INSERT 0 1"))
        val database = OliphauntDatabase.open(EngineConfig(), TestEngine(session))
        val result = database.execute(
            "INSERT INTO widgets(value) VALUES ($1)",
            listOf(QueryParam.Text("hello")),
        )
        assertEquals(1L, result.rowCount)
        assertEquals('P'.code.toByte(), session.requests.single().first())
    }

    @Test
    fun executeRejectsRows() {
        assertFailsWith<OliphauntException> {
            parseCommandResponse(rowResponse("1", "SELECT 1"))
        }
    }

    @Test
    fun queryUsesCommandTagRowCount() {
        val result = parseQueryResponse(rowResponse("1", "SELECT 7"))
        assertEquals(1, result.rows.size)
        assertEquals(7L, result.rowCount)
        assertEquals(2_147_483_648L, parseQueryResponse(commandResponse("SELECT 2147483648")).rowCount)
        assertEquals("1", result.getText(0, "value"))
    }

    @Test
    fun commandsWithoutAffectedRowsReturnNull() {
        val result = parseCommandResponse(commandResponse("CREATE TABLE"))
        assertNull(result.rowCount)
    }

    @Test
    fun postgresErrorPrefersNonlocalizedSeverity() {
        val error = PostgresError.fromFields(
            listOf(
                PostgresErrorField('S'.code, "ERROR"),
                PostgresErrorField('V'.code, "ERREUR"),
                PostgresErrorField('M'.code, "bad query"),
            ),
        )
        assertEquals("ERREUR", error.severity)
    }

    @Test
    fun backupAndRestoreUsePhysicalBytesDirectly() = runTest {
        val session = TestSession(commandResponse("OK"), byteArrayOf(1, 2, 3))
        val engine = TestEngine(session)
        val database = OliphauntDatabase.open(EngineConfig(), engine)
        assertContentEquals(byteArrayOf(1, 2, 3), database.backup())
        OliphauntDatabase.restore("/tmp/restored", byteArrayOf(4, 5), engine)
        assertEquals("/tmp/restored", engine.restoredDestination)
        assertContentEquals(byteArrayOf(4, 5), engine.restoredBytes)
    }

    @Test
    fun rawProtocolStreamingForwardsOwnedChunks() = runTest {
        val response = commandResponse("SELECT 1")
        val database = OliphauntDatabase.open(EngineConfig(), TestEngine(TestSession(response)))
        val chunks = mutableListOf<ByteArray>()
        database.execProtocolStream(byteArrayOf('Q'.code.toByte(), 0, 0, 0, 5, 0)) {
            chunks += it
        }
        assertEquals(1, chunks.size)
        assertContentEquals(response, chunks.single())
    }

    @Test
    fun transactionCommitsAndPinsPhysicalSession() = runTest {
        val session = TestSession(commandResponse("OK"))
        val database = OliphauntDatabase.open(EngineConfig(), TestEngine(session))
        val value = database.transaction { transaction ->
            assertFailsWith<OliphauntException> { database.execute("SELECT 1") }
            transaction.execute("UPDATE widgets SET ready = true")
            transaction.query("SELECT $1", listOf(QueryParam.Text("value")))
            42
        }
        assertEquals(42, value)
        assertEquals(listOf("BEGIN", "COMMIT"), session.simpleQueries())
        assertTrue(session.requests.any { it.firstOrNull() == 'P'.code.toByte() })
    }

    @Test
    fun transactionRollsBackOriginalFailure() = runTest {
        class Expected : RuntimeException()
        val session = TestSession(commandResponse("OK"))
        val database = OliphauntDatabase.open(EngineConfig(), TestEngine(session))
        assertFailsWith<Expected> {
            database.transaction<Unit> { throw Expected() }
        }
        assertEquals(listOf("BEGIN", "ROLLBACK"), session.simpleQueries())
    }

    @Test
    fun commitRequiresExactCommitTag() = runTest {
        val session = TestSession(commandResponse("UPDATE 1"), commitTag = "ROLLBACK")
        val database = OliphauntDatabase.open(
            EngineConfig(),
            TestEngine(session),
        )
        val error = assertFailsWith<OliphauntException> { database.transaction { 1 } }
        assertTrue(error.message.orEmpty().contains("COMMIT returned unexpected"))
        database.execute("SELECT 1")
        assertEquals(listOf("BEGIN", "COMMIT"), session.simpleQueries())
    }

    @Test
    fun commitTransportFailureDoesNotRollbackAndPoisonsFacade() = runTest {
        val session = TestSession(commandResponse("UPDATE 1"), failCommit = true)
        val database = OliphauntDatabase.open(EngineConfig(), TestEngine(session))
        val primary = assertFailsWith<OliphauntException> { database.transaction { 1 } }
        assertTrue(primary.message.orEmpty().contains("commit transport failed"))
        assertEquals(listOf("BEGIN", "COMMIT"), session.simpleQueries())
        val poison = assertFailsWith<OliphauntException> { database.execute("SELECT 1") }
        assertTrue(poison.message.orEmpty().contains("COMMIT outcome is unknown"))
        database.close()
    }

    @Test
    fun rollbackFailurePoisonsFacadeUntilClose() = runTest {
        class Expected : RuntimeException()
        val session = TestSession(commandResponse("UPDATE 1"), failRollback = true)
        val database = OliphauntDatabase.open(EngineConfig(), TestEngine(session))
        assertFailsWith<Expected> { database.transaction<Unit> { throw Expected() } }
        val poison = assertFailsWith<OliphauntException> { database.execute("SELECT 1") }
        assertTrue(poison.message.orEmpty().contains("rollback failed"))
        database.close()
    }

    @Test
    fun closeIsIdempotentAndRejectsFurtherWork() = runTest {
        val session = TestSession(commandResponse("OK"))
        val database = OliphauntDatabase.open(EngineConfig(), TestEngine(session))
        database.close()
        database.close()
        assertEquals(1, session.closeCount)
        assertFailsWith<OliphauntException> { database.execute("SELECT 1") }
    }

    @Test
    fun configurationForwardsOnlyExplicitPostgresSettings() = runTest {
        val engine = TestEngine(TestSession(commandResponse("OK")))
        OliphauntDatabase.open(
            EngineConfig(
                startupGucs = listOf(PostgresStartupGuc("shared_buffers", "16MB")),
                username = "alice",
                database = "app",
            ),
            engine,
        )
        val config = requireNotNull(engine.openedConfig)
        assertEquals("alice", config.username)
        assertEquals("app", config.database)
        assertEquals(listOf("-c", "shared_buffers=16MB"), config.postgresStartupArgs())
    }

    @Test
    fun queryValueTypesAreStrictAndValueSemantic() {
        assertEquals(QueryFormat.Binary, QueryFormat.fromCode(1))
        assertEquals(QueryFormat.Other(7), QueryFormat.fromCode(7))
        assertEquals(QueryParam.Text("x"), QueryParam.text("x"))
        val binary = QueryParam.binary(byteArrayOf(1, 2))
        assertEquals(binary, QueryParam.Binary(byteArrayOf(1, 2)))
        assertNotEquals(binary, QueryParam.Binary(byteArrayOf(2, 1)))
        assertEquals(binary.hashCode(), QueryParam.Binary(byteArrayOf(1, 2)).hashCode())

        val row = QueryRow(listOf("x".encodeToByteArray(), null))
        assertEquals(row, row)
        assertEquals(row, QueryRow(listOf("x".encodeToByteArray(), null)))
        assertNotEquals(row, QueryRow(listOf("x".encodeToByteArray())))
        assertNotEquals(row, QueryRow(listOf(null, null)))
        assertTrue(!row.equals("row"))
        row.hashCode()
        assertNull(row.text(1))
        assertFailsWith<OliphauntException> { row.text(2) }
        assertFailsWith<OliphauntException> { QueryRow(listOf(byteArrayOf(0xc3.toByte()))).text(0) }

        val result = QueryResult(emptyList(), emptyList(), null, null)
        assertFailsWith<OliphauntException> { result.getText(0, "missing") }
        val fieldOnly = QueryResult(
            listOf(QueryField("value", 0u, 0, 25u, -1, -1, QueryFormat.Text)),
            emptyList(),
            null,
            null,
        )
        assertFailsWith<OliphauntException> { fieldOnly.getText(0, "value") }
    }

    @Test
    fun extendedProtocolSupportsNullTextAndBinaryAndValidatesInputs() {
        val request = extendedQueryProtocol(
            "SELECT $1, $2, $3",
            listOf(QueryParam.Null, QueryParam.Text("text"), QueryParam.Binary(byteArrayOf(1, 2))),
        )
        assertEquals('P'.code.toByte(), request.first())
        assertFailsWith<OliphauntException> {
            extendedQueryProtocol("SELECT \u0000", emptyList())
        }
        assertFailsWith<OliphauntException> {
            extendedQueryProtocol("SELECT 1", List(Short.MAX_VALUE.toInt() + 1) { QueryParam.Null })
        }
        assertFailsWith<OliphauntException> { simpleQueryProtocol("SELECT \u0000") }
    }

    @Test
    fun commandParserAcceptsPostgresControlMessages() {
        val controls =
            backendMessage('1', ByteArray(0)) +
                backendMessage('2', ByteArray(0)) +
                backendMessage('3', ByteArray(0)) +
                backendMessage('I', ByteArray(0)) +
                backendMessage('n', ByteArray(0)) +
                backendMessage('S', cstrings("server_version", "18")) +
                backendMessage('N', byteArrayOf('M'.code.toByte()) + cstrings("notice") + byteArrayOf(0)) +
                backendMessage('A', byteArrayOf(0, 0, 0, 1) + cstrings("channel", "payload")) +
                commandResponse("DELETE 2")
        assertEquals(2L, parseCommandResponse(controls).rowCount)
    }

    @Test
    fun commandParserRejectsMalformedAndUnsupportedResponses() {
        val cases = listOf(
            byteArrayOf('C'.code.toByte(), 0, 0, 0, 3),
            backendMessage('C', "UPDATE 1".encodeToByteArray()),
            backendMessage('G', ByteArray(0)),
            backendMessage('Y', ByteArray(0)),
            backendMessage('Z', byteArrayOf('I'.code.toByte())) + backendMessage('I', ByteArray(0)),
            backendMessage('Z', ByteArray(0)),
            backendMessage('Z', byteArrayOf('X'.code.toByte())),
            backendMessage('N', byteArrayOf('M'.code.toByte()) + "unterminated".encodeToByteArray()),
            backendMessage('I', ByteArray(0)),
        )
        cases.forEach { bytes -> assertFailsWith<OliphauntException> { parseCommandResponse(bytes) } }
        val postgres = backendMessage(
            'E',
            byteArrayOf('S'.code.toByte()) + cstrings("ERROR") +
                byteArrayOf('C'.code.toByte()) + cstrings("22000") +
                byteArrayOf('M'.code.toByte()) + cstrings("bad") + byteArrayOf(0),
        )
        assertFailsWith<PostgresException> { parseCommandResponse(postgres) }
    }

    @Test
    fun configurationValidationRejectsInvalidValuesBeforeOpen() = runTest {
        val engine = TestEngine(TestSession(commandResponse("OK")))
        val invalid = listOf(
            EngineConfig(username = " "),
            EngineConfig(database = "bad\u0000name"),
            EngineConfig(storage = EngineStorage.Directory("")),
            EngineConfig(startupGucs = listOf(PostgresStartupGuc("", "1"))),
            EngineConfig(startupGucs = listOf(PostgresStartupGuc("bad-name", "1"))),
            EngineConfig(startupGucs = listOf(PostgresStartupGuc("1name", "1"))),
            EngineConfig(startupGucs = listOf(PostgresStartupGuc(".foo", "1"))),
            EngineConfig(startupGucs = listOf(PostgresStartupGuc("a..b", "1"))),
            EngineConfig(startupGucs = listOf(PostgresStartupGuc("a.1b", "1"))),
            EngineConfig(startupGucs = listOf(PostgresStartupGuc("ext.\$name", "1"))),
            EngineConfig(startupGucs = listOf(PostgresStartupGuc("good", "bad\u0000value"))),
            EngineConfig(extensions = listOf("bad/name")),
            EngineConfig(extensions = listOf("not_in_generated_catalog")),
        )
        invalid.forEach { config ->
            assertFailsWith<OliphauntException> { OliphauntDatabase.open(config, engine) }
        }
        assertEquals(
            listOf("-c", "_name=", "-c", "ext.name\$1=on", "-c", "shared_preload_libraries=a,z"),
            EngineConfig(
                startupGucs = listOf(
                    PostgresStartupGuc(" _name ", ""),
                    PostgresStartupGuc("ext.name\$1", "on"),
                ),
            )
                .postgresStartupArgs(listOf("z", "a", "z")),
        )
    }

    @Test
    fun checkpointAndCancelDelegateToSession() = runTest {
        val session = TestSession(commandResponse("CHECKPOINT"))
        val database = OliphauntDatabase.open(EngineConfig(), TestEngine(session))
        database.checkpoint()
        database.cancel()
        assertEquals(1, session.cancelCount)
        assertTrue(session.simpleQueries().isEmpty())
        assertEquals('P'.code.toByte(), session.requests.single().first())
    }
}

private class TestEngine(
    private val session: OliphauntSession,
) : OliphauntEngine {
    var openedConfig: EngineConfig? = null
    var restoredDestination: String? = null
    var restoredBytes: ByteArray? = null

    override suspend fun open(config: EngineConfig): OliphauntSession {
        openedConfig = config
        return session
    }

    override suspend fun restore(destination: String, bytes: ByteArray) {
        restoredDestination = destination
        restoredBytes = bytes
    }
}

private class TestSession(
    private val response: ByteArray,
    private val backupBytes: ByteArray = ByteArray(0),
    private val commitTag: String = "COMMIT",
    private val failCommit: Boolean = false,
    private val failRollback: Boolean = false,
) : OliphauntSession {
    val requests = mutableListOf<ByteArray>()
    var closeCount = 0
    var cancelCount = 0

    override suspend fun execProtocolRaw(request: ByteArray): ByteArray {
        requests += request
        val sql = request.takeIf { it.firstOrNull() == 'Q'.code.toByte() && it.size >= 6 }
            ?.copyOfRange(5, request.size - 1)
            ?.decodeToString()
        if (sql == "COMMIT" && failCommit) throw OliphauntException("commit transport failed")
        if (sql == "ROLLBACK" && failRollback) throw OliphauntException("rollback transport failed")
        if (sql in listOf("BEGIN", "COMMIT", "ROLLBACK")) {
            return commandResponse(if (sql == "COMMIT") commitTag else requireNotNull(sql))
        }
        return response
    }

    override suspend fun execProtocolStream(request: ByteArray, onChunk: (ByteArray) -> Unit) {
        onChunk(execProtocolRaw(request))
    }

    override suspend fun backup(): ByteArray = backupBytes
    override suspend fun cancel() {
        cancelCount += 1
    }
    override suspend fun close() {
        closeCount += 1
    }

    fun simpleQueries(): List<String> = requests.mapNotNull { request ->
        if (request.firstOrNull() != 'Q'.code.toByte() || request.size < 6) {
            null
        } else {
            request.copyOfRange(5, request.size - 1).decodeToString()
        }
    }
}

private fun cstrings(vararg values: String): ByteArray = values.fold(ByteArray(0)) { bytes, value -> bytes + value.encodeToByteArray() + byteArrayOf(0) }

private fun backendMessage(tag: Char, body: ByteArray): ByteArray {
    val length = body.size + 4
    return byteArrayOf(
        tag.code.toByte(),
        (length ushr 24).toByte(),
        (length ushr 16).toByte(),
        (length ushr 8).toByte(),
        length.toByte(),
    ) + body
}

private fun commandResponse(tag: String): ByteArray = backendMessage('C', tag.encodeToByteArray() + byteArrayOf(0)) + backendMessage('Z', byteArrayOf('I'.code.toByte()))

private fun rowResponse(value: String, commandTag: String): ByteArray {
    val rowDescription = byteArrayOf(0, 1) + "value".encodeToByteArray() + byteArrayOf(0) +
        ByteArray(6) + byteArrayOf(0, 0, 0, 25, -1, -1, -1, -1, -1, -1, 0, 0)
    val encoded = value.encodeToByteArray()
    val length = encoded.size
    val dataRow = byteArrayOf(
        0,
        1,
        (length ushr 24).toByte(),
        (length ushr 16).toByte(),
        (length ushr 8).toByte(),
        length.toByte(),
    ) + encoded
    return backendMessage('T', rowDescription) + backendMessage('D', dataRow) + commandResponse(commandTag)
}
