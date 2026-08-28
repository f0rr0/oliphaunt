package dev.oliphaunt

// liboliphaunt-doc-example:kotlin-typed-query
// liboliphaunt-doc-example:kotlin-setup

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withTimeoutOrNull
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNotEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertSame
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
        val result =
            database.execute(
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
    fun parametersCarryOidsFormatsNullsAndOwnedBytes() {
        val source = byteArrayOf(1, 2)
        val binary = QueryParam.binary(source, PostgresOid.bytea)
        source[0] = 9
        assertContentEquals(byteArrayOf(1, 2), binary.bytes)
        assertEquals(PostgresOid.bytea, binary.typeOid)
        assertEquals(ValueFormat.Binary, binary.format)
        assertNull(QueryParam.typedNull(PostgresOid.uuid).bytes)
        assertEquals(ValueFormat.Text, QueryParam.typedNull(PostgresOid.uuid).format)

        val request =
            extendedQueryProtocol(
                "SELECT $1, $2, $3",
                listOf(QueryParam.int(42), QueryParam.typedNull(PostgresOid.uuid), QueryParam.bytes(byteArrayOf(0))),
            )
        assertEquals(listOf(PostgresOid.int4, PostgresOid.uuid, PostgresOid.bytea), parseParameterOids(request))
        assertEquals(1_266u, PostgresOid.timetz.value)
        assertEquals(1_270u, PostgresOid.timetzArray.value)
    }

    @Test
    fun explicitZeroParameterOidsAreRejectedButOmittedOidsRemainInferable() {
        assertEquals(
            listOf(PostgresOid(0u), PostgresOid(0u)),
            parseParameterOids(
                extendedQueryProtocol(
                    "SELECT $1, $2",
                    listOf(QueryParam.Text("value"), QueryParam.Null),
                ),
            ),
        )
        assertTrue(parseParameterOids(describeQueryProtocol("SELECT $1::int4", emptyList())).isEmpty())
        assertEquals(
            listOf(PostgresOid(0u), PostgresOid.int4),
            parseParameterOids(
                describeQueryProtocol(
                    "SELECT $1, $2::int4",
                    listOf(PostgresOid(0u), PostgresOid.int4),
                ),
            ),
        )

        listOf(
            QueryParam.Text("value", PostgresOid(0u)),
            QueryParam.Binary(byteArrayOf(1), PostgresOid(0u)),
            QueryParam.typedNull(PostgresOid(0u)),
        ).forEach { parameter ->
            val failure =
                assertFailsWith<OliphauntException> {
                    extendedQueryProtocol("SELECT $1", listOf(parameter))
                }
            assertTrue(failure.message.orEmpty().contains("parameter 1 type OID"))
        }
    }

    @Test
    fun rowsOfferLosslessRawAndExtensibleOidAwareDecoding() {
        val intField = queryField("value", PostgresOid.int4)
        val row = QueryRow(listOf("-2147483648".encodeToByteArray()), listOf(intField))
        assertContentEquals("-2147483648".encodeToByteArray(), row.raw("value"))
        assertEquals(Int.MIN_VALUE, row.value("value", PostgresDecoders.int))
        assertEquals("-2147483648", row.value("value", PostgresDecoders.string))
        val timeWithZone =
            QueryRow(
                listOf("04:05:06+02".encodeToByteArray()),
                listOf(queryField("value", PostgresOid.timetz)),
            )
        assertEquals("04:05:06+02", timeWithZone.value("value", PostgresDecoders.string))
        val binaryTimeWithZone =
            QueryRow(
                listOf(ByteArray(12)),
                listOf(queryField("value", PostgresOid.timetz, QueryFormat.Binary)),
            )
        assertFailsWith<OliphauntException> {
            binaryTimeWithZone.value("value", PostgresDecoders.string)
        }

        val nullBytes = QueryRow(listOf(null), listOf(queryField("value", PostgresOid.bytea)))
        assertFailsWith<OliphauntException> { nullBytes.value(0, PostgresDecoders.string) }
        val custom =
            PostgresDecoder { bytes: ByteArray?, field ->
                if (field.typeOid != PostgresOid.int4) throw OliphauntException("wrong OID")
                bytes?.decodeToString()?.reversed()
            }
        assertEquals("8463847412-", row.value(0, custom))

        val mutatingDecoder =
            PostgresDecoder { bytes: ByteArray?, _ ->
                bytes?.fill(0)
                "decoded"
            }
        assertEquals("decoded", row.value(0, mutatingDecoder))
        assertContentEquals("-2147483648".encodeToByteArray(), row.raw(0))

        val parsedRow = QueryRow(listOf("owned".encodeToByteArray()), listOf(queryField("value", PostgresOid.text)))
        val exposedValues = parsedRow.values
        exposedValues[0]?.fill(0)
        val exposedRaw = requireNotNull(parsedRow.raw(0))
        exposedRaw.fill(0)
        assertEquals("owned", parsedRow.text(0))

        val duplicateFields =
            listOf(queryField("value", PostgresOid.text), queryField("value", PostgresOid.text))
        val duplicate =
            QueryRow(
                listOf("a".encodeToByteArray(), "b".encodeToByteArray()),
                duplicateFields,
            )
        assertFailsWith<OliphauntException> { duplicate.raw("value") }
        val duplicateResult = QueryResult(duplicateFields, listOf(duplicate), null, null)
        assertFailsWith<OliphauntException> { duplicateResult.getText(0, "value") }
    }

    @Test
    fun noticesRemainStructuredAndAttachToPostgresErrors() {
        val response =
            noticeResponse("NOTICE", "before failure") +
                errorResponse("22000", "bad query") +
                backendMessage('Z', byteArrayOf('I'.code.toByte()))
        val error = assertFailsWith<PostgresException> { parseCommandResponse(response) }.postgresError
        assertEquals("22000", error.sqlstate)
        assertEquals(listOf("before failure"), error.notices.map(PostgresNotice::message))
    }

    @Test
    fun execAndDescribePreserveStatementShapeAndMetadata() {
        val rowMessages = rowResultMessages("1".encodeToByteArray(), PostgresOid.text)
        val exec =
            parseExecResponse(
                noticeResponse("NOTICE", "created") +
                    backendMessage('C', cstrings("CREATE TABLE")) +
                    noticeResponse("NOTICE", "selected") +
                    rowMessages +
                    backendMessage('C', cstrings("SELECT 1")) +
                    backendMessage('I', ByteArray(0)) +
                    backendMessage('I', ByteArray(0)) +
                    backendMessage('Z', byteArrayOf('I'.code.toByte())),
            )
        assertEquals(2, exec.statements.size)
        assertTrue(exec.statements[0] is StatementResult.Command)
        assertEquals(
            listOf("created"),
            (exec.statements[0] as StatementResult.Command).result.notices.map(PostgresNotice::message),
        )
        val rows = (exec.statements[1] as StatementResult.Rows).result
        assertEquals("1", rows.rows.single().text(0))
        assertEquals(listOf("selected"), rows.notices.map(PostgresNotice::message))
        assertEquals(listOf("created", "selected"), exec.notices.map(PostgresNotice::message))

        val description =
            parseDescribeResponse(
                backendMessage('1', ByteArray(0)) +
                    parameterDescription(listOf(PostgresOid.int4)) +
                    rowDescription("value", PostgresOid.text) +
                    backendMessage('Z', byteArrayOf('I'.code.toByte())),
            )
        assertEquals(listOf(PostgresOid.int4), description.parameterTypes)
        assertEquals(listOf("value"), description.fields?.map(QueryField::name))
        val noData =
            parseDescribeResponse(
                backendMessage('1', ByteArray(0)) +
                    parameterDescription() +
                    backendMessage('n', ByteArray(0)) +
                    backendMessage('Z', byteArrayOf('I'.code.toByte())),
            )
        assertNull(noData.fields)

        listOf('1', '2', '3', 'n').forEach { tag ->
            val response =
                backendMessage(tag, ByteArray(0)) +
                    backendMessage('Z', byteArrayOf('I'.code.toByte()))
            assertFailsWith<OliphauntException> { parseExecResponse(response) }
        }
        assertFailsWith<OliphauntException> {
            parseExecResponse(backendMessage('Z', byteArrayOf('I'.code.toByte())))
        }
        assertFailsWith<OliphauntException> {
            parseExecResponse(
                rowResultMessages("pending".encodeToByteArray(), PostgresOid.text) +
                    backendMessage('I', ByteArray(0)) +
                    backendMessage('C', cstrings("SELECT 1")) +
                    backendMessage('Z', byteArrayOf('I'.code.toByte())),
            )
        }
    }

    @Test
    fun structuredCopyIsRejectedBeforeSessionDispatch() = runTest {
        val session = TestSession(commandResponse("OK"))
        val database = OliphauntDatabase.open(EngineConfig(), TestEngine(session))
        assertFailsWith<OliphauntException> { database.exec("SELECT 1; COPY items TO STDOUT") }
        assertFailsWith<OliphauntException> { database.execute("/* nested /* x */ */ COPY items FROM STDIN") }
        assertTrue(session.requests.isEmpty())
    }

    @Test
    fun transactionChainIsRejectedBeforeSessionDispatch() = runTest {
        val session = TestSession(commandResponse("OK"))
        val database = OliphauntDatabase.open(EngineConfig(), TestEngine(session))

        database.transaction { transaction ->
            val requestCount = session.requests.size
            assertFailsWith<OliphauntException> {
                transaction.exec("ROLLBACK WORK /* keep ownership */ AND CHAIN")
            }
            assertEquals(requestCount, session.requests.size)
        }

        assertEquals(listOf("BEGIN", "COMMIT"), session.simpleQueries())
    }

    @Test
    fun commandsWithoutAffectedRowsReturnNull() {
        val result = parseCommandResponse(commandResponse("CREATE TABLE"))
        assertNull(result.rowCount)
    }

    @Test
    fun postgresErrorUsesProtocolSeverityAndRetainsNonlocalizedSeverity() {
        val error =
            PostgresError.fromFields(
                listOf(
                    PostgresErrorField('S'.code, "ERROR"),
                    PostgresErrorField('V'.code, "ERREUR"),
                    PostgresErrorField('p'.code, "12"),
                    PostgresErrorField('q'.code, "SELECT bad"),
                    PostgresErrorField('F'.code, "parse.c"),
                    PostgresErrorField('L'.code, "42"),
                    PostgresErrorField('R'.code, "parse_query"),
                    PostgresErrorField('M'.code, "bad query"),
                ),
            )
        assertEquals("ERROR", error.severity)
        assertEquals("ERROR", error.localizedSeverity)
        assertEquals("ERREUR", error.nonlocalizedSeverity)
        assertEquals("12", error.internalPosition)
        assertEquals("SELECT bad", error.internalQuery)
        assertEquals("parse.c", error.file)
        assertEquals("42", error.line)
        assertEquals("parse_query", error.routine)
    }

    @Test
    fun backupAndRestoreReturnAndAcceptOwnedBytes() = runTest {
        val session = TestSession(commandResponse("OK"), byteArrayOf(1, 2, 3))
        val engine = TestEngine(session)
        val database = OliphauntDatabase.open(EngineConfig(), engine)
        val backup = database.backup()
        assertContentEquals(byteArrayOf(1, 2, 3), backup)
        backup[0] = 9
        assertContentEquals(byteArrayOf(1, 2, 3), database.backup())

        val restoreBytes = byteArrayOf(4, 5)
        OliphauntDatabase.restore("/tmp/restored", restoreBytes, engine)
        restoreBytes[0] = 9
        assertEquals("/tmp/restored", engine.restoredDestination)
        assertContentEquals(byteArrayOf(4, 5), engine.restoredBytes)
    }

    @Test
    fun rawProtocolOwnsDatabaseRequestsResponsesAndChunks() = runTest {
        val response = commandResponse("SELECT 1")
        val session = TestSession(response)
        val database = OliphauntDatabase.open(EngineConfig(), TestEngine(session))

        val request = byteArrayOf(1, 2)
        val raw = database.execProtocolRaw(request)
        request.fill(0)
        raw.fill(0)
        assertContentEquals(byteArrayOf(1, 2), session.requests.last())
        assertEquals(response.first(), database.execProtocolRaw(byteArrayOf(3)).first())

        val streamRequest = byteArrayOf(4, 5)
        database.execProtocolRawStream(streamRequest) { chunk -> chunk.fill(0) }
        streamRequest.fill(0)
        assertContentEquals(byteArrayOf(4, 5), session.requests.last())
        assertEquals(response.first(), database.execProtocolRaw(byteArrayOf(6)).first())
    }

    @Test
    fun rawProtocolTransportFailurePoisonsDatabase() = runTest {
        val session = TestSession(commandResponse("OK"), failRawRequest = byteArrayOf(1))
        val database = OliphauntDatabase.open(EngineConfig(), TestEngine(session))

        val failure = assertFailsWith<OliphauntException> { database.execProtocolRaw(byteArrayOf(1)) }
        assertEquals("raw transport failed", failure.message)
        assertFailsWith<OliphauntException> { database.execProtocolRaw(byteArrayOf(2)) }
        assertEquals(1, session.requests.size)
    }

    @Test
    fun rawProtocolStreamTransportFailurePoisonsDatabase() = runTest {
        val session = TestSession(commandResponse("OK"), failRawRequest = byteArrayOf(1))
        val database = OliphauntDatabase.open(EngineConfig(), TestEngine(session))

        val failure =
            assertFailsWith<OliphauntException> {
                database.execProtocolRawStream(byteArrayOf(1)) {}
            }
        assertEquals("raw transport failed", failure.message)
        assertFailsWith<OliphauntException> { database.execProtocolRaw(byteArrayOf(2)) }
        assertEquals(1, session.requests.size)
    }

    @Test
    fun rawProtocolStreamRecoveryFailureWinsOverCallbackAndPoisonsDatabase() = runTest {
        class CallbackFailure : RuntimeException()
        val session =
            TestSession(
                commandResponse("OK"),
                failStreamAfterCallback = true,
            )
        val database = OliphauntDatabase.open(EngineConfig(), TestEngine(session))

        val failure =
            assertFailsWith<OliphauntException> {
                database.execProtocolRawStream(byteArrayOf(1)) { throw CallbackFailure() }
            }
        assertEquals("stream recovery failed", failure.message)
        assertFailsWith<OliphauntException> { database.execProtocolRaw(byteArrayOf(2)) }
        assertEquals(1, session.requests.size)
    }

    @Test
    fun transactionCommitsAndPinsPhysicalSession() = runTest {
        val session = TestSession(commandResponse("OK"))
        val database = OliphauntDatabase.open(EngineConfig(), TestEngine(session))
        val value =
            database.transaction { transaction ->
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
    fun structuredTransactionOutcomeClassifierUsesExactTagsAndTerminalReady() {
        val forbidden = listOf(
            "BEGIN",
            "START TRANSACTION",
            "COMMIT",
            "PREPARE TRANSACTION",
            "COMMIT PREPARED",
            "ROLLBACK PREPARED",
        )
        forbidden.forEach { tag ->
            val outcome = inspectStructuredTransactionProtocolOutcome(simpleCommandResponse(tag, 'T'))
            assertEquals(tag, outcome.lifecycleCommandTag)
            assertEquals(ReadyStatus.Transaction, outcome.readyStatus)
        }

        listOf(
            "ROLLBACK",
            "SAVEPOINT",
            "RELEASE",
            "SET",
            "PREPARE",
            "CREATE FUNCTION",
            "CALL",
            "DO",
        ).forEach { tag ->
            val outcome = inspectStructuredTransactionProtocolOutcome(simpleCommandResponse(tag, 'T'))
            assertNull(outcome.lifecycleCommandTag, tag)
        }
        assertNull(
            inspectStructuredTransactionProtocolOutcome(simpleCommandResponse("ROLLBACK", 'E')).lifecycleCommandTag,
        )
        assertFailsWith<OliphauntException> {
            inspectStructuredTransactionProtocolOutcome(
                simpleCommandResponse("SELECT 1", 'T') + backendMessage('Z', byteArrayOf('T'.code.toByte())),
            )
        }
        assertFailsWith<OliphauntException> {
            inspectStructuredTransactionProtocolOutcome(
                backendMessage('C', "COMMIT".encodeToByteArray()) + backendMessage('Z', byteArrayOf('T'.code.toByte())),
            )
        }
    }

    @Test
    fun everyStructuredTransactionOperationRejectsLifecycleCommandTagsAndSkipsSettlement() = runTest {
        val cases = listOf<Pair<ByteArray, suspend (OliphauntTransaction) -> Unit>>(
            commandResponse("BEGIN", 'T') to { transaction ->
                transaction.execute("BEGIN")
            },
            commandResponse("COMMIT", 'T') to { transaction ->
                transaction.query("COMMIT")
            },
            simpleCommandResponse("PREPARE TRANSACTION", 'T') to { transaction ->
                transaction.exec("PREPARE TRANSACTION 'owned'")
            },
        )

        cases.forEach { (response, operation) ->
            val session = TestSession(response, preserveResponseStatus = true)
            val database = OliphauntDatabase.open(EngineConfig(), TestEngine(session))
            val failure = assertFailsWith<OliphauntException> {
                database.transaction { transaction -> operation(transaction) }
            }
            assertTrue(failure.message.orEmpty().contains("unsupported lifecycle command"))
            assertTrue(session.simpleQueries().none { it == "COMMIT" || it == "ROLLBACK" })
            val requestCount = session.requests.size
            assertFailsWith<OliphauntException> { database.execute("SELECT 1") }
            assertEquals(requestCount, session.requests.size)
        }
    }

    @Test
    fun lifecyclePoisonClosesTheSharedTransactionLeaseImmediately() = runTest {
        val session = TestSession(commandResponse("COMMIT", 'T'), preserveResponseStatus = true)
        val database = OliphauntDatabase.open(EngineConfig(), TestEngine(session))

        val failure =
            assertFailsWith<OliphauntException> {
                database.transaction { transaction ->
                    val lifecycleFailure =
                        assertFailsWith<OliphauntException> {
                            transaction.execute("COMMIT")
                        }
                    assertTrue(transaction.isClosed)
                    assertFailsWith<OliphauntException> { transaction.execute("SELECT never_runs") }
                    throw lifecycleFailure
                }
            }
        assertTrue(failure.message.orEmpty().contains("unsupported lifecycle command COMMIT"))
        assertEquals(2, session.requests.size)
        assertTrue(session.simpleQueries().none { it == "ROLLBACK" })
        database.close()
    }

    @Test
    fun lifecycleTagBeforeLaterPostgresErrorWinsAndLeavesDatabaseCloseOnly() = runTest {
        val response =
            backendMessage('C', cstrings("COMMIT")) +
                errorResponse("22000", "later failure") +
                backendMessage('Z', byteArrayOf('T'.code.toByte()))
        val session = TestSession(response, preserveResponseStatus = true)
        val database = OliphauntDatabase.open(EngineConfig(), TestEngine(session))

        val failure = assertFailsWith<OliphauntException> {
            database.transaction { transaction -> transaction.exec("COMMIT; SELECT invalid") }
        }
        assertTrue(failure.message.orEmpty().contains("unsupported lifecycle command COMMIT"))
        assertTrue(failure.message.orEmpty().contains("later failure"))
        assertTrue(failure.cause != null)
        assertTrue(session.simpleQueries().none { it == "ROLLBACK" })
    }

    @Test
    fun transactionReadyStatusDistinguishesFullFromSavepointRollback() = runTest {
        val escapedSession = TestSession(
            commandResponse("ROLLBACK", 'I'),
            preserveResponseStatus = true,
        )
        val escapedDatabase = OliphauntDatabase.open(EngineConfig(), TestEngine(escapedSession))
        val escaped = assertFailsWith<OliphauntException> {
            escapedDatabase.transaction { transaction -> transaction.execute("ROLLBACK") }
        }
        assertTrue(escaped.message.orEmpty().contains("left PostgreSQL idle"))
        assertTrue(escapedSession.simpleQueries().none { it == "ROLLBACK" })

        val savepointSession = TestSession(commandResponse("ROLLBACK", 'T'))
        val savepointDatabase = OliphauntDatabase.open(EngineConfig(), TestEngine(savepointSession))
        val result = savepointDatabase.transaction { transaction ->
            transaction.execute("ROLLBACK TO SAVEPOINT nested")
        }
        assertEquals("ROLLBACK", result.commandTag)
        assertEquals(listOf("BEGIN", "COMMIT"), savepointSession.simpleQueries())
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
    fun explicitRollbackRunsOnceExpiresHandleAndSkipsCommit() = runTest {
        val session = TestSession(commandResponse("UPDATE 1"))
        val database = OliphauntDatabase.open(EngineConfig(), TestEngine(session))
        val value =
            database.transaction { transaction ->
                assertFalse(transaction.isClosed)
                transaction.rollback()
                assertTrue(transaction.isClosed)
                assertFailsWith<OliphauntException> { transaction.rollback() }
                42
            }
        assertEquals(42, value)
        assertEquals(listOf("BEGIN", "ROLLBACK"), session.simpleQueries())
    }

    @Test
    fun commitExpiresEscapedHandleBeforeWaitingForProtocol() = runTest {
        val session = TestSession(commandResponse("UPDATE 1"), blockedControl = "COMMIT")
        val database = OliphauntDatabase.open(EngineConfig(), TestEngine(session))
        val transactionReady = CompletableDeferred<OliphauntTransaction>()
        val outer =
            async {
                database.transaction { transaction ->
                    transactionReady.complete(transaction)
                    1
                }
            }
        session.awaitBlockedControl()
        val transaction = transactionReady.await()
        assertTrue(transaction.isClosed)
        assertFailsWith<OliphauntException> { transaction.execute("SELECT 1") }
        session.releaseBlockedControl()
        assertEquals(1, outer.await())
    }

    @Test
    fun rollbackExpiresHandleBeforeWaitingForProtocol() = runTest {
        val session = TestSession(commandResponse("UPDATE 1"), blockedControl = "ROLLBACK")
        val database = OliphauntDatabase.open(EngineConfig(), TestEngine(session))
        val transactionReady = CompletableDeferred<OliphauntTransaction>()
        val outer =
            async {
                database.transaction { transaction ->
                    transactionReady.complete(transaction)
                    transaction.rollback()
                    1
                }
            }
        session.awaitBlockedControl()
        val transaction = transactionReady.await()
        assertTrue(transaction.isClosed)
        assertFailsWith<OliphauntException> { transaction.execute("SELECT 1") }
        session.releaseBlockedControl()
        assertEquals(1, outer.await())
    }

    @Test
    fun transactionWaitsForInFlightExplicitRollbackBeforeReturningNormally() = runTest {
        val session = TestSession(commandResponse("UPDATE 1"), blockedControl = "ROLLBACK")
        val database = OliphauntDatabase.open(EngineConfig(), TestEngine(session))
        lateinit var rollback: Deferred<Unit>
        lateinit var transaction: OliphauntTransaction

        val outer =
            async(start = CoroutineStart.UNDISPATCHED) {
                database.transaction { active ->
                    transaction = active
                    rollback =
                        async(start = CoroutineStart.UNDISPATCHED) {
                            active.rollback()
                        }
                    session.awaitBlockedControl()
                    7
                }
            }

        assertTrue(transaction.isClosed)
        assertFalse(outer.isCompleted)
        session.releaseBlockedControl()
        rollback.await()
        assertEquals(7, outer.await())
        assertEquals(listOf("BEGIN", "ROLLBACK"), session.simpleQueries())
        assertEquals("UPDATE 1", database.execute("UPDATE widgets SET ready = true").commandTag)
        database.close()
    }

    @Test
    fun transactionWaitsForInFlightExplicitRollbackBeforeRethrowingCallbackFailure() = runTest {
        class Expected : RuntimeException()

        val callbackError = Expected()
        val session = TestSession(commandResponse("UPDATE 1"), blockedControl = "ROLLBACK")
        val database = OliphauntDatabase.open(EngineConfig(), TestEngine(session))
        lateinit var rollback: Deferred<Unit>

        val outer =
            async(start = CoroutineStart.UNDISPATCHED) {
                runCatching {
                    database.transaction<Unit> { transaction ->
                        rollback =
                            backgroundScope.async(start = CoroutineStart.UNDISPATCHED) {
                                transaction.rollback()
                            }
                        session.awaitBlockedControl()
                        throw callbackError
                    }
                }.exceptionOrNull()
            }

        assertFalse(outer.isCompleted)
        session.releaseBlockedControl()
        rollback.await()
        val failure = assertNotNull(outer.await())
        assertTrue(generateSequence<Throwable>(failure) { it.cause }.any { it === callbackError })
        assertEquals(listOf("BEGIN", "ROLLBACK"), session.simpleQueries())
        assertEquals("UPDATE 1", database.execute("UPDATE widgets SET ready = true").commandTag)
        database.close()
    }

    @Test
    fun callbackAndInFlightExplicitRollbackFailuresAreBothPreserved() = runTest {
        class Expected : RuntimeException()

        val callbackError = Expected()
        val session =
            TestSession(
                commandResponse("UPDATE 1"),
                failRollback = true,
                blockedControl = "ROLLBACK",
            )
        val database = OliphauntDatabase.open(EngineConfig(), TestEngine(session))
        lateinit var rollback: Deferred<Result<Unit>>

        val outer =
            async(start = CoroutineStart.UNDISPATCHED) {
                runCatching {
                    database.transaction<Unit> { transaction ->
                        rollback =
                            backgroundScope.async(start = CoroutineStart.UNDISPATCHED) {
                                runCatching { transaction.rollback() }
                            }
                        session.awaitBlockedControl()
                        throw callbackError
                    }
                }.exceptionOrNull()
            }

        assertFalse(outer.isCompleted)
        session.releaseBlockedControl()
        assertTrue(rollback.await().exceptionOrNull() is OliphauntException)
        val failure = assertNotNull(outer.await())
        val composite = assertIs<OliphauntTransactionRollbackException>(failure)
        assertTrue(generateSequence(composite.callbackError) { it.cause }.any { it === callbackError })
        assertEquals("rollback transport failed", composite.rollbackError.message)
        assertEquals(listOf("BEGIN", "ROLLBACK"), session.simpleQueries())
        assertFailsWith<OliphauntException> { database.execute("SELECT never_runs") }
        database.close()
    }

    @Test
    fun callbackAndCompletedExplicitRollbackFailuresAreBothPreserved() = runTest {
        class Expected : RuntimeException()

        val callbackError = Expected()
        val session = TestSession(commandResponse("UPDATE 1"), failRollback = true)
        val database = OliphauntDatabase.open(EngineConfig(), TestEngine(session))

        val failure =
            assertFailsWith<OliphauntTransactionRollbackException> {
                database.transaction<Unit> { transaction ->
                    assertFailsWith<OliphauntException> { transaction.rollback() }
                    throw callbackError
                }
            }

        assertTrue(failure.callbackError === callbackError)
        assertEquals("rollback transport failed", failure.rollbackError.message)
        assertEquals(listOf("BEGIN", "ROLLBACK"), session.simpleQueries())
        assertFailsWith<OliphauntException> { database.execute("SELECT never_runs") }
        database.close()
    }

    @Test
    fun propagatedExplicitRollbackFailureIsNotWrappedAsComposite() = runTest {
        val session = TestSession(commandResponse("UPDATE 1"), failRollback = true)
        val database = OliphauntDatabase.open(EngineConfig(), TestEngine(session))

        val failure =
            assertFailsWith<OliphauntException> {
                database.transaction<Unit> { transaction -> transaction.rollback() }
            }

        assertFalse(failure is OliphauntTransactionRollbackException)
        assertFalse(failure is OliphauntTransactionDatabaseException)
        assertEquals("rollback transport failed", failure.message)
        assertEquals(listOf("BEGIN", "ROLLBACK"), session.simpleQueries())
        assertFailsWith<OliphauntException> { database.execute("SELECT never_runs") }
        database.close()
    }

    @Test
    fun caughtExplicitRollbackFailureStillEscapesWithOriginalError() = runTest {
        val session = TestSession(commandResponse("UPDATE 1"), failRollback = true)
        val database = OliphauntDatabase.open(EngineConfig(), TestEngine(session))
        lateinit var rollbackFailure: OliphauntException

        val failure =
            assertFailsWith<OliphauntException> {
                database.transaction { transaction ->
                    rollbackFailure = assertFailsWith<OliphauntException> { transaction.rollback() }
                    7
                }
            }

        val rollbackFailureChain = generateSequence<Throwable>(rollbackFailure) { it.cause }.toList()
        assertTrue(
            generateSequence<Throwable>(failure) { it.cause }
                .any { outer -> rollbackFailureChain.any { inner -> outer === inner } },
        )
        assertEquals("rollback transport failed", failure.message)
        assertEquals(listOf("BEGIN", "ROLLBACK"), session.simpleQueries())
        assertFailsWith<OliphauntException> { database.execute("SELECT never_runs") }
        database.close()
    }

    @Test
    fun cancelledQueuedExplicitRollbackStillSettlesAndReportsCancellation() = runTest {
        val session = AdmissionOrderSession()
        val database = OliphauntDatabase.open(EngineConfig(), TestEngine(session))

        val value =
            database.transaction { transaction ->
                val earlier =
                    async(start = CoroutineStart.UNDISPATCHED) {
                        transaction.execute("UPDATE records SET value = 1")
                    }
                session.awaitFirstRaw()
                val rollback =
                    async(start = CoroutineStart.UNDISPATCHED) {
                        transaction.rollback()
                    }

                rollback.cancel()
                assertFalse(rollback.isCompleted)
                session.releaseFirstRaw()
                assertEquals("UPDATE 1", earlier.await().commandTag)
                rollback.join()
                assertTrue(rollback.isCancelled)
                7
            }

        assertEquals(7, value)
        assertEquals(listOf("BEGIN", "typed:1", "ROLLBACK"), session.events)
        assertContentEquals(byteArrayOf(2), database.execProtocolRaw(byteArrayOf(2)))
        database.close()
    }

    @Test
    fun rollbackCutoffDrainsEarlierTransactionAdmissions() = runTest {
        val session = AdmissionOrderSession()
        val database = OliphauntDatabase.open(EngineConfig(), TestEngine(session))

        val value =
            database.transaction { transaction ->
                val first =
                    async(start = CoroutineStart.UNDISPATCHED) {
                        transaction.execute("UPDATE records SET value = 1")
                    }
                session.awaitFirstRaw()
                val second =
                    async(start = CoroutineStart.UNDISPATCHED) {
                        transaction.execute("UPDATE records SET value = 2")
                    }
                val rollback =
                    async(start = CoroutineStart.UNDISPATCHED) {
                        transaction.rollback()
                    }

                assertFailsWith<OliphauntException> {
                    transaction.execute("UPDATE records SET value = 3")
                }
                session.releaseFirstRaw()
                assertEquals("UPDATE 1", first.await().commandTag)
                assertEquals("UPDATE 1", second.await().commandTag)
                rollback.await()
                7
            }

        assertEquals(7, value)
        assertEquals(listOf("BEGIN", "typed:1", "typed:2", "ROLLBACK"), session.events)
    }

    @Test
    fun commitCutoffDrainsEarlierTransactionAdmissions() = runTest {
        val session = AdmissionOrderSession()
        val database = OliphauntDatabase.open(EngineConfig(), TestEngine(session))
        val callbackReturned = CompletableDeferred<OliphauntTransaction>()
        lateinit var first: Deferred<CommandResult>
        lateinit var second: Deferred<CommandResult>

        val outer =
            async(start = CoroutineStart.UNDISPATCHED) {
                database.transaction { transaction ->
                    first =
                        async(start = CoroutineStart.UNDISPATCHED) {
                            transaction.execute("UPDATE records SET value = 1")
                        }
                    session.awaitFirstRaw()
                    second =
                        async(start = CoroutineStart.UNDISPATCHED) {
                            transaction.execute("UPDATE records SET value = 2")
                        }
                    callbackReturned.complete(transaction)
                    7
                }
            }

        val transaction = callbackReturned.await()
        assertTrue(transaction.isClosed)
        assertFailsWith<OliphauntException> {
            transaction.execute("UPDATE records SET value = 3")
        }
        session.releaseFirstRaw()
        assertEquals("UPDATE 1", first.await().commandTag)
        assertEquals("UPDATE 1", second.await().commandTag)
        assertEquals(7, outer.await())
        assertEquals(listOf("BEGIN", "typed:1", "typed:2", "COMMIT"), session.events)
    }

    @Test
    fun commitRequiresExactCommitTag() = runTest {
        val session = TestSession(commandResponse("UPDATE 1"), commitTag = "ROLLBACK")
        val database =
            OliphauntDatabase.open(
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
    fun beginTransportFailureDoesNotAttemptBlindRollback() = runTest {
        val session = TestSession(commandResponse("UPDATE 1"), failBegin = true)
        val database = OliphauntDatabase.open(EngineConfig(), TestEngine(session))
        assertFailsWith<OliphauntException> { database.transaction { 1 } }
        assertEquals(listOf("BEGIN"), session.simpleQueries())
        assertFailsWith<OliphauntException> { database.execute("SELECT 1") }
        database.close()
    }

    @Test
    fun beginWithoutTerminalReadyDoesNotAttemptBlindRollback() = runTest {
        val session = TestSession(commandResponse("UPDATE 1"), omitBeginReady = true)
        val database = OliphauntDatabase.open(EngineConfig(), TestEngine(session))
        assertFailsWith<OliphauntException> { database.transaction { 1 } }
        assertEquals(listOf("BEGIN"), session.simpleQueries())
        assertFailsWith<OliphauntException> { database.execute("SELECT 1") }
        database.close()
    }

    @Test
    fun cancellationDeliveredAfterBeginBoundaryRollsBackBeforeReleasingOwnership() = runTest {
        val session = TestSession(commandResponse("UPDATE 1"), blockedControl = "BEGIN")
        val database = OliphauntDatabase.open(EngineConfig(), TestEngine(session))
        var callbackCalled = false
        val outer =
            async(start = CoroutineStart.UNDISPATCHED) {
                database.transaction {
                    callbackCalled = true
                }
            }

        session.awaitBlockedControl()
        outer.cancel()
        session.releaseBlockedControl()
        outer.join()

        assertFalse(callbackCalled)
        assertEquals(listOf("BEGIN", "ROLLBACK"), session.simpleQueries())
        assertEquals("UPDATE 1", database.execute("UPDATE widgets SET ready = true").commandTag)
        database.close()
    }

    @Test
    fun cancellationRequestedAtCallbackReturnRollsBackInsteadOfCommitting() = runTest {
        val session = TestSession(commandResponse("UPDATE 1"))
        val database = OliphauntDatabase.open(EngineConfig(), TestEngine(session))
        lateinit var transaction: OliphauntTransaction
        val outer =
            async(start = CoroutineStart.UNDISPATCHED) {
                database.transaction { active ->
                    transaction = active
                    currentCoroutineContext()[Job]?.cancel()
                    7
                }
            }

        outer.join()

        assertTrue(outer.isCancelled)
        assertTrue(transaction.isClosed)
        assertEquals(listOf("BEGIN", "ROLLBACK"), session.simpleQueries())
        assertEquals(9, database.transaction { 9 })
        database.close()
    }

    @Test
    fun failedBeginWithKnownTransactionStatusRollsBackAndReleasesOwnership() = runTest {
        val beginResponse =
            errorResponse("XX000", "BEGIN failed") +
                backendMessage('Z', byteArrayOf('E'.code.toByte()))
        val session = TestSession(commandResponse("UPDATE 1"), beginResponse = beginResponse)
        val database = OliphauntDatabase.open(EngineConfig(), TestEngine(session))

        assertFailsWith<PostgresException> { database.transaction { 1 } }
        assertEquals(listOf("BEGIN", "ROLLBACK"), session.simpleQueries())
        assertEquals("UPDATE 1", database.execute("UPDATE widgets SET ready = true").commandTag)
        database.close()
    }

    @Test
    fun failedBeginWithKnownIdleStatusSkipsRollbackAndReleasesOwnership() = runTest {
        val beginResponse =
            errorResponse("XX000", "BEGIN failed before opening a transaction") +
                backendMessage('Z', byteArrayOf('I'.code.toByte()))
        val session = TestSession(commandResponse("UPDATE 1"), beginResponse = beginResponse)
        val database = OliphauntDatabase.open(EngineConfig(), TestEngine(session))

        assertFailsWith<PostgresException> { database.transaction { 1 } }
        assertEquals(listOf("BEGIN"), session.simpleQueries())
        assertEquals("UPDATE 1", database.execute("UPDATE widgets SET ready = true").commandTag)
        database.close()
    }

    @Test
    fun malformedSuccessfulBeginRollsBackBeforeReturningTheError() = runTest {
        val session =
            TestSession(
                commandResponse("UPDATE 1"),
                beginResponse = simpleCommandResponse("SELECT 0", 'T'),
            )
        val database = OliphauntDatabase.open(EngineConfig(), TestEngine(session))

        val failure = assertFailsWith<OliphauntException> { database.transaction { 1 } }
        assertTrue(failure.message.orEmpty().contains("BEGIN returned command tag SELECT 0"))
        assertEquals(listOf("BEGIN", "ROLLBACK"), session.simpleQueries())
        assertEquals("UPDATE 1", database.execute("UPDATE widgets SET ready = true").commandTag)
        database.close()
    }

    @Test
    fun failedBeginRollbackFailurePoisonsDatabaseAndPreservesBothErrors() = runTest {
        val beginResponse =
            errorResponse("XX000", "BEGIN failed") +
                backendMessage('Z', byteArrayOf('E'.code.toByte()))
        val session =
            TestSession(
                commandResponse("UPDATE 1"),
                failRollback = true,
                beginResponse = beginResponse,
            )
        val database = OliphauntDatabase.open(EngineConfig(), TestEngine(session))

        val failure = assertFailsWith<OliphauntException> { database.transaction { 1 } }
        assertTrue(failure.message.orEmpty().contains("automatic ROLLBACK failed"))
        assertFalse(failure is OliphauntTransactionDatabaseException)
        val failureChain = generateSequence<Throwable>(failure) { it.cause }.toList()
        assertTrue(failureChain.any { it is PostgresException })
        assertEquals(
            listOf("rollback transport failed"),
            failureChain.flatMap(Throwable::suppressedExceptions).map(Throwable::message),
        )
        assertEquals(listOf("BEGIN", "ROLLBACK"), session.simpleQueries())

        val requestCount = session.requests.size
        val poison = assertFailsWith<OliphauntException> { database.execute("SELECT never_runs") }
        assertTrue(poison.message.orEmpty().contains("automatic ROLLBACK failed"))
        assertEquals(requestCount, session.requests.size)
        database.close()
    }

    @Test
    fun rollbackFailurePoisonsFacadeUntilClose() = runTest {
        class Expected : RuntimeException()
        val callbackError = Expected()
        val session = TestSession(commandResponse("UPDATE 1"), failRollback = true)
        val database = OliphauntDatabase.open(EngineConfig(), TestEngine(session))
        val failure =
            assertFailsWith<OliphauntTransactionRollbackException> {
                database.transaction<Unit> { throw callbackError }
            }
        assertTrue(failure.callbackError === callbackError)
        assertEquals("rollback transport failed", failure.rollbackError.message)
        assertTrue(failure.cause === callbackError)
        assertEquals(listOf(failure.rollbackError), failure.suppressedExceptions)
        assertEquals(listOf("BEGIN", "ROLLBACK"), session.simpleQueries())
        val poison = assertFailsWith<OliphauntException> { database.execute("SELECT 1") }
        assertTrue(poison.message.orEmpty().contains("rollback failed"))
        database.close()
    }

    @Test
    fun callbackAndIndependentDatabaseFailuresAreBothPreserved() = runTest {
        class Expected : RuntimeException()
        val callbackError = Expected()
        val failedRequest = extendedQueryProtocol("SELECT transport_failure", emptyList())
        val session =
            TestSession(
                commandResponse("UPDATE 1"),
                failRawRequest = failedRequest,
            )
        val database = OliphauntDatabase.open(EngineConfig(), TestEngine(session))

        val failure =
            assertFailsWith<OliphauntTransactionDatabaseException> {
                database.transaction<Unit> { transaction ->
                    try {
                        transaction.execute("SELECT transport_failure")
                    } catch (_: Throwable) {
                        // Replace the independently poisoning transport error
                        // with a distinct business failure.
                        assertTrue(transaction.isClosed)
                    }
                    throw callbackError
                }
            }
        assertSame(callbackError, failure.callbackError)
        assertEquals("raw transport failed", failure.databaseError.message)
        assertSame(callbackError, failure.cause)
        assertEquals(listOf(failure.databaseError), failure.suppressedExceptions)
        assertTrue(failure.message.orEmpty().contains("independent database failure"))
        assertEquals(listOf("BEGIN"), session.simpleQueries())

        val requestCount = session.requests.size
        assertFailsWith<OliphauntException> { database.execute("SELECT never_runs") }
        assertEquals(requestCount, session.requests.size)
        database.close()
    }

    @Test
    fun propagatedDatabaseFailureIsNotMisclassifiedAsAnIndependentCallbackFailure() = runTest {
        val failedRequest = extendedQueryProtocol("SELECT transport_failure", emptyList())
        val session =
            TestSession(
                commandResponse("UPDATE 1"),
                failRawRequest = failedRequest,
            )
        val database = OliphauntDatabase.open(EngineConfig(), TestEngine(session))

        val failure =
            assertFailsWith<OliphauntException> {
                database.transaction { transaction ->
                    transaction.execute("SELECT transport_failure")
                }
            }
        assertFalse(failure is OliphauntTransactionDatabaseException)
        assertEquals("raw transport failed", failure.message)
        assertTrue(failure.cause?.message == "raw transport failed" || failure.cause == null)
        database.close()
    }

    @Test
    fun closeIsIdempotentAndRejectsFurtherWork() = runTest {
        val session = TestSession(commandResponse("OK"))
        val database = OliphauntDatabase.open(EngineConfig(), TestEngine(session))
        assertFalse(database.isClosed)
        database.close()
        assertTrue(database.isClosed)
        database.close()
        assertEquals(1, session.closeCount)
        assertFailsWith<OliphauntException> { database.execute("SELECT 1") }
    }

    @Test
    fun cancellationWhileQueuedSkipsQueryWithoutBreakingFifo() = runTest {
        val session = AdmissionOrderSession()
        val database = OliphauntDatabase.open(EngineConfig(), TestEngine(session))
        val first =
            async(start = CoroutineStart.UNDISPATCHED) {
                database.execProtocolRaw(byteArrayOf(1))
            }
        session.awaitFirstRaw()
        val skipped =
            async(start = CoroutineStart.UNDISPATCHED) {
                database.query("SELECT never_runs")
            }
        val successor =
            async(start = CoroutineStart.UNDISPATCHED) {
                database.execProtocolRaw(byteArrayOf(2))
            }

        skipped.cancel()
        skipped.join()

        assertTrue(skipped.isCancelled)
        assertFalse(successor.isCompleted)
        assertEquals(listOf("raw:1"), session.events)

        session.releaseFirstRaw()
        assertContentEquals(byteArrayOf(1), first.await())
        assertContentEquals(byteArrayOf(2), successor.await())
        assertEquals(listOf("raw:1", "raw:2"), session.events)
        database.close()
    }

    @Test
    fun cancellationAfterRawStartsDrainsBeforeSuccessorRuns() = runTest {
        val session = AdmissionOrderSession()
        val database = OliphauntDatabase.open(EngineConfig(), TestEngine(session))
        val first =
            async(start = CoroutineStart.UNDISPATCHED) {
                database.execProtocolRaw(byteArrayOf(1))
            }
        session.awaitFirstRaw()

        first.cancel()
        val successor =
            async(start = CoroutineStart.UNDISPATCHED) {
                database.execProtocolRaw(byteArrayOf(2))
            }

        assertFalse(first.isCompleted)
        assertFalse(successor.isCompleted)
        assertEquals(listOf("raw:1"), session.events)

        session.releaseFirstRaw()
        first.join()
        assertTrue(first.isCancelled)
        assertContentEquals(byteArrayOf(2), successor.await())
        assertEquals(listOf("raw:1", "raw:2"), session.events)
        database.close()
    }

    @Test
    fun rawFailureAfterCancellationPoisonsBeforeSuccessorReachesNative() = runTest {
        val session = AdmissionOrderSession(failFirstRaw = true)
        val database = OliphauntDatabase.open(EngineConfig(), TestEngine(session))
        var firstFailure: Throwable? = null
        val first =
            async(start = CoroutineStart.UNDISPATCHED) {
                try {
                    database.execProtocolRaw(byteArrayOf(1))
                } catch (error: Throwable) {
                    firstFailure = error
                }
            }
        session.awaitFirstRaw()

        first.cancel()
        val successor =
            async(start = CoroutineStart.UNDISPATCHED) {
                runCatching { database.execProtocolRaw(byteArrayOf(2)) }.exceptionOrNull()
            }

        assertFalse(first.isCompleted)
        assertFalse(successor.isCompleted)
        assertEquals(listOf("raw:1"), session.events)

        session.releaseFirstRaw()
        first.join()
        assertTrue(first.isCancelled)
        assertEquals("raw transport failed", assertNotNull(firstFailure).message)
        val successorFailure = assertNotNull(successor.await())
        assertTrue(successorFailure.message.orEmpty().contains("outcome is unknown"))
        assertEquals(listOf("raw:1"), session.events)
        database.close()
    }

    @Test
    fun queuedBackupSkipsNativeCallAfterPredecessorPoisonsDatabase() = runTest {
        val session = AdmissionOrderSession(failFirstRaw = true)
        val database = OliphauntDatabase.open(EngineConfig(), TestEngine(session))
        val first =
            async(start = CoroutineStart.UNDISPATCHED) {
                runCatching { database.execProtocolRaw(byteArrayOf(1)) }.exceptionOrNull()
            }
        session.awaitFirstRaw()
        val backup =
            async(start = CoroutineStart.UNDISPATCHED) {
                runCatching { database.backup() }.exceptionOrNull()
            }

        session.releaseFirstRaw()

        assertEquals("raw transport failed", assertNotNull(first.await()).message)
        assertTrue(assertNotNull(backup.await()).message.orEmpty().contains("outcome is unknown"))
        assertEquals(0, session.backupCount)
        database.close()
    }

    @Test
    fun cancellationWhileQueuedSkipsBeginAndReleasesOwnership() = runTest {
        val session = AdmissionOrderSession()
        val database = OliphauntDatabase.open(EngineConfig(), TestEngine(session))
        val first =
            async(start = CoroutineStart.UNDISPATCHED) {
                database.execProtocolRaw(byteArrayOf(1))
            }
        session.awaitFirstRaw()
        var callbackCalled = false
        val skipped =
            async(start = CoroutineStart.UNDISPATCHED) {
                database.transaction {
                    callbackCalled = true
                }
            }

        skipped.cancel()
        skipped.join()
        val successor =
            async(start = CoroutineStart.UNDISPATCHED) {
                database.execProtocolRaw(byteArrayOf(2))
            }

        assertTrue(skipped.isCancelled)
        assertFalse(callbackCalled)
        assertFalse(successor.isCompleted)
        assertEquals(listOf("raw:1"), session.events)

        session.releaseFirstRaw()
        assertContentEquals(byteArrayOf(1), first.await())
        assertContentEquals(byteArrayOf(2), successor.await())
        assertEquals(listOf("raw:1", "raw:2"), session.events)
        database.close()
    }

    @Test
    fun cancellationWhileQueuedSkipsCloseAndReleasesOwnership() = runTest {
        val session = AdmissionOrderSession()
        val database = OliphauntDatabase.open(EngineConfig(), TestEngine(session))
        val first =
            async(start = CoroutineStart.UNDISPATCHED) {
                database.execProtocolRaw(byteArrayOf(1))
            }
        session.awaitFirstRaw()
        val skipped = async(start = CoroutineStart.UNDISPATCHED) { database.close() }

        skipped.cancel()
        skipped.join()
        val successor =
            async(start = CoroutineStart.UNDISPATCHED) {
                database.execProtocolRaw(byteArrayOf(2))
            }

        assertTrue(skipped.isCancelled)
        assertFalse(database.isClosed)
        assertFalse(successor.isCompleted)
        assertEquals(listOf("raw:1"), session.events)

        session.releaseFirstRaw()
        assertContentEquals(byteArrayOf(1), first.await())
        assertContentEquals(byteArrayOf(2), successor.await())
        assertEquals(listOf("raw:1", "raw:2"), session.events)
        database.close()
    }

    @Test
    fun closeCutsOffLaterCallsButDrainsEveryEarlierAdmission() = runTest {
        val session = AdmissionOrderSession()
        val database = OliphauntDatabase.open(EngineConfig(), TestEngine(session))

        val first =
            async(start = CoroutineStart.UNDISPATCHED) {
                database.execProtocolRaw(byteArrayOf(1))
            }
        session.awaitFirstRaw()
        val second =
            async(start = CoroutineStart.UNDISPATCHED) {
                database.execProtocolRaw(byteArrayOf(2))
            }
        val closing = async(start = CoroutineStart.UNDISPATCHED) { database.close() }

        assertFailsWith<OliphauntException> { database.execProtocolRaw(byteArrayOf(3)) }

        session.releaseFirstRaw()
        assertContentEquals(byteArrayOf(1), first.await())
        assertContentEquals(byteArrayOf(2), second.await())
        closing.await()
        assertEquals(listOf("raw:1", "raw:2", "close"), session.events)
    }

    @Test
    fun transactionPinningDoesNotRevokeEarlierAdmissions() = runTest {
        val session = AdmissionOrderSession()
        val database = OliphauntDatabase.open(EngineConfig(), TestEngine(session))

        val first =
            async(start = CoroutineStart.UNDISPATCHED) {
                database.execProtocolRaw(byteArrayOf(1))
            }
        session.awaitFirstRaw()
        val second =
            async(start = CoroutineStart.UNDISPATCHED) {
                database.execProtocolRaw(byteArrayOf(2))
            }
        val transaction =
            async(start = CoroutineStart.UNDISPATCHED) {
                database.transaction { 7 }
            }

        assertFailsWith<OliphauntException> { database.execProtocolRaw(byteArrayOf(3)) }

        session.releaseFirstRaw()
        assertContentEquals(byteArrayOf(1), first.await())
        assertContentEquals(byteArrayOf(2), second.await())
        assertEquals(7, transaction.await())
        assertEquals(listOf("raw:1", "raw:2", "BEGIN", "COMMIT"), session.events)
    }

    @Test
    fun cancellationCannotStrandCloseOwnership() = runTest {
        val session = TestSession(commandResponse("OK"), blockClose = true)
        val database = OliphauntDatabase.open(EngineConfig(), TestEngine(session))
        val closing = async { database.close() }

        session.awaitClose()
        closing.cancel()
        session.releaseClose()
        closing.join()

        assertEquals(1, session.closeCount)
        assertTrue(database.isClosed)
    }

    @Test
    fun rawStreamCallbackFailureRejectsAndReleasesTheSession() = runTest {
        class Expected(val marker: Any) : RuntimeException("expected callback failure")
        val session = TestSession(commandResponse("OK"))
        val database = OliphauntDatabase.open(EngineConfig(), TestEngine(session))
        val expected = Expected(Any())

        val failure =
            assertFailsWith<Expected> {
                database.execProtocolRawStream(byteArrayOf(1)) { throw expected }
            }
        assertSame(expected, failure)
        database.execProtocolRaw(byteArrayOf(2))

        assertEquals(2, session.requests.size)
    }

    @Test
    fun rawStreamCallbackRejectsSameHandleReentryButAllowsCancellation() = runTest {
        val session = TestSession(commandResponse("OK"))
        val database = OliphauntDatabase.open(EngineConfig(), TestEngine(session))
        val failures = mutableListOf<Deferred<Throwable?>>()
        lateinit var cancellation: Deferred<Throwable?>

        database.execProtocolRawStream(byteArrayOf(1)) {
            val forbidden =
                listOf<suspend () -> Unit>(
                    { database.execProtocolRaw(byteArrayOf(2)) },
                    { database.execProtocolRawStream(byteArrayOf(3)) {} },
                    { database.query("SELECT 1") },
                    { database.backup() },
                    { database.transaction { } },
                    { database.close() },
                )
            forbidden.forEach { operation ->
                failures +=
                    async(start = CoroutineStart.UNDISPATCHED) {
                        runCatching { operation() }.exceptionOrNull()
                    }
            }
            cancellation =
                async(start = CoroutineStart.UNDISPATCHED) {
                    runCatching { database.cancel() }.exceptionOrNull()
                }
        }

        failures.forEach { failure ->
            assertTrue(
                failure.await()?.message.orEmpty().contains(
                    "must not reenter the same Oliphaunt database or transaction",
                ),
            )
        }
        assertNull(cancellation.await())
        assertEquals(1, session.cancelCount)
        assertEquals(1, session.requests.size)
        database.close()
    }

    @Test
    fun rawStreamCallbackReentryIsRejectedAfterDispatchingToAnotherThread() = runTest {
        val session = TestSession(commandResponse("OK"))
        val database = OliphauntDatabase.open(EngineConfig(), TestEngine(session))
        var failure: Throwable? = null
        var completedDuringCallback = false
        lateinit var reentry: Deferred<Throwable?>

        database.execProtocolRawStream(byteArrayOf(1)) {
            reentry =
                backgroundScope.async(Dispatchers.Default) {
                    runCatching { database.query("SELECT 1") }.exceptionOrNull()
                }
            val completed =
                runBlocking {
                    withTimeoutOrNull(5_000) {
                        Unit to reentry.await()
                    }
                }
            completedDuringCallback = completed != null
            failure = completed?.second
        }

        if (!completedDuringCallback) reentry.await()
        assertTrue(completedDuringCallback, "cross-thread reentry waited on the active raw stream")
        assertNotNull(failure)
        assertTrue(
            failure?.message.orEmpty().contains(
                "must not reenter the same Oliphaunt database or transaction",
            ),
        )
        database.execProtocolRaw(byteArrayOf(2))
        assertEquals(2, session.requests.size)
        database.close()
    }

    @Test
    fun cancellationRemainsAvailableUntilCloseStartsNativeTeardown() = runTest {
        val session = AdmissionOrderSession(blockClose = true)
        val database = OliphauntDatabase.open(EngineConfig(), TestEngine(session))
        val first =
            async(start = CoroutineStart.UNDISPATCHED) {
                database.execProtocolRaw(byteArrayOf(1))
            }
        session.awaitFirstRaw()
        val closing = async(start = CoroutineStart.UNDISPATCHED) { database.close() }

        database.cancel()
        assertEquals(1, session.cancelCount)
        session.releaseFirstRaw()
        first.await()
        session.awaitClose()
        assertFailsWith<OliphauntException> { database.cancel() }

        session.releaseClose()
        closing.await()
        assertEquals(listOf("raw:1", "cancel", "close"), session.events)
    }

    @Test
    @OptIn(ExperimentalCoroutinesApi::class)
    fun closeDrainsCancellationAdmittedBeforeNativeTeardown() = runTest {
        val session = AdmissionOrderSession(blockCancel = true)
        val database = OliphauntDatabase.open(EngineConfig(), TestEngine(session))
        val first =
            async(start = CoroutineStart.UNDISPATCHED) {
                database.execProtocolRaw(byteArrayOf(1))
            }
        session.awaitFirstRaw()
        val closing = async(start = CoroutineStart.UNDISPATCHED) { database.close() }
        val cancellation = async(start = CoroutineStart.UNDISPATCHED) { database.cancel() }
        session.awaitCancel()

        session.releaseFirstRaw()
        first.await()
        runCurrent()
        assertEquals(listOf("raw:1", "cancel:start"), session.events)

        session.releaseCancel()
        cancellation.await()
        closing.await()
        assertEquals(listOf("raw:1", "cancel:start", "cancel:end", "close"), session.events)
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
    fun openSnapshotsMutableConfigurationBeforeEngineSuspends() = runTest {
        val startupGucs = mutableListOf(PostgresStartupGuc("shared_buffers", "16MB"))
        val extensions = mutableListOf("pgtap")
        val openStarted = CompletableDeferred<EngineConfig>()
        val openRelease = CompletableDeferred<Unit>()
        val session = TestSession(commandResponse("OK"))
        val engine =
            object : OliphauntEngine {
                override suspend fun open(config: EngineConfig): OliphauntSession {
                    openStarted.complete(config)
                    openRelease.await()
                    return session
                }

                override suspend fun restore(
                    destination: String,
                    bytes: ByteArray,
                ) = Unit
            }
        val opening =
            async(start = CoroutineStart.UNDISPATCHED) {
                OliphauntDatabase.open(
                    EngineConfig(startupGucs = startupGucs, extensions = extensions),
                    engine,
                )
            }
        val retained = openStarted.await()

        startupGucs[0] = PostgresStartupGuc("work_mem", "64MB")
        extensions[0] = "vector"

        assertEquals(listOf(PostgresStartupGuc("shared_buffers", "16MB")), retained.startupGucs)
        assertEquals(listOf("pgtap"), retained.extensions)
        openRelease.complete(Unit)
        opening.await().close()
    }

    @Test
    fun restoreSnapshotsMutableBytesBeforeEngineSuspends() = runTest {
        val restoreStarted = CompletableDeferred<ByteArray>()
        val restoreRelease = CompletableDeferred<Unit>()
        val engine =
            object : OliphauntEngine {
                override suspend fun open(config: EngineConfig): OliphauntSession = TestSession(commandResponse("OK"))

                override suspend fun restore(
                    destination: String,
                    bytes: ByteArray,
                ) {
                    restoreStarted.complete(bytes)
                    restoreRelease.await()
                }
            }
        val source = byteArrayOf(1, 2, 3)
        val restoring =
            async(start = CoroutineStart.UNDISPATCHED) {
                OliphauntDatabase.restore("/tmp/restored-snapshot", source, engine)
            }
        val retained = restoreStarted.await()

        source.fill(9)

        assertContentEquals(byteArrayOf(1, 2, 3), retained)
        restoreRelease.complete(Unit)
        restoring.await()
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

        val row = QueryRow(listOf("x".encodeToByteArray(), null), emptyList())
        assertEquals(row, row)
        assertEquals(row, QueryRow(listOf("x".encodeToByteArray(), null), emptyList()))
        assertNotEquals(row, QueryRow(listOf("x".encodeToByteArray()), emptyList()))
        assertNotEquals(row, QueryRow(listOf(null, null), emptyList()))
        assertTrue(!row.equals("row"))
        row.hashCode()
        assertNull(row.text(1))
        assertFailsWith<OliphauntException> { row.text(2) }
        assertFailsWith<OliphauntException> {
            QueryRow(listOf(byteArrayOf(0xc3.toByte())), emptyList()).text(0)
        }

        val result = QueryResult(emptyList(), emptyList(), null, null)
        assertFailsWith<OliphauntException> { result.getText(0, "missing") }
        val fieldOnly =
            QueryResult(
                listOf(QueryField("value", 0u, 0, PostgresOid.text, -1, -1, QueryFormat.Text)),
                emptyList(),
                null,
                null,
            )
        assertFailsWith<OliphauntException> { fieldOnly.getText(0, "value") }
    }

    @Test
    fun extendedProtocolSupportsNullTextAndBinaryAndValidatesInputs() {
        val request =
            extendedQueryProtocol(
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
                backendMessage('n', ByteArray(0)) +
                backendMessage('S', cstrings("server_version", "18")) +
                backendMessage('N', byteArrayOf('M'.code.toByte()) + cstrings("notice") + byteArrayOf(0)) +
                backendMessage('A', byteArrayOf(0, 0, 0, 1) + cstrings("channel", "payload")) +
                simpleCommandResponse("DELETE 2")
        assertEquals(2L, parseCommandResponse(controls).rowCount)
    }

    @Test
    fun commandParserRejectsMalformedAndUnsupportedResponses() {
        val completion = simpleCommandResponse("UPDATE 1")
        val cases =
            listOf(
                byteArrayOf('C'.code.toByte(), 0, 0, 0, 3),
                backendMessage('C', "UPDATE 1".encodeToByteArray()),
                backendMessage('G', ByteArray(0)),
                backendMessage('Y', ByteArray(0)),
                backendMessage('Z', byteArrayOf('I'.code.toByte())) + backendMessage('I', ByteArray(0)),
                backendMessage('Z', ByteArray(0)),
                backendMessage('Z', byteArrayOf('X'.code.toByte())),
                backendMessage('N', byteArrayOf('M'.code.toByte()) + "unterminated".encodeToByteArray()),
                backendMessage('I', ByteArray(0)),
                backendMessage('Z', byteArrayOf('I'.code.toByte())),
                backendMessage('2', ByteArray(0)) +
                    backendMessage('1', ByteArray(0)) +
                    backendMessage('n', ByteArray(0)) +
                    completion,
                backendMessage('1', ByteArray(0)) +
                    backendMessage('1', ByteArray(0)) +
                    backendMessage('2', ByteArray(0)) +
                    backendMessage('n', ByteArray(0)) +
                    completion,
                backendMessage('1', ByteArray(0)) +
                    backendMessage('2', ByteArray(0)) +
                    completion,
                backendMessage('1', ByteArray(0)) +
                    backendMessage('2', ByteArray(0)) +
                    backendMessage('n', ByteArray(0)) +
                    backendMessage('3', ByteArray(0)) +
                    completion,
                backendMessage('1', ByteArray(0)) +
                    backendMessage('2', ByteArray(0)) +
                    backendMessage('n', ByteArray(0)) +
                    backendMessage('C', cstrings("UPDATE 2")) +
                    backendMessage('1', ByteArray(0)) +
                    backendMessage('Z', byteArrayOf('I'.code.toByte())),
                backendMessage('1', ByteArray(0)) +
                    backendMessage('2', ByteArray(0)) +
                    backendMessage('n', ByteArray(0)) +
                    backendMessage('C', cstrings("UPDATE 1")) +
                    errorResponse("22000", "late") +
                    backendMessage('Z', byteArrayOf('I'.code.toByte())),
            )
        cases.forEach { bytes -> assertFailsWith<OliphauntException> { parseCommandResponse(bytes) } }
        val postgres =
            backendMessage(
                'E',
                byteArrayOf('S'.code.toByte()) + cstrings("ERROR") +
                    byteArrayOf('C'.code.toByte()) + cstrings("22000") +
                    byteArrayOf('M'.code.toByte()) + cstrings("bad") + byteArrayOf(0),
            ) + backendMessage('Z', byteArrayOf('I'.code.toByte()))
        assertFailsWith<PostgresException> { parseCommandResponse(postgres) }
    }

    @Test
    fun queryParserRejectsDuplicateCompletionAndIncompleteRowSets() {
        val duplicate =
            backendMessage('1', ByteArray(0)) +
                backendMessage('2', ByteArray(0)) +
                backendMessage('n', ByteArray(0)) +
                backendMessage('C', cstrings("SELECT 1")) +
                backendMessage('C', cstrings("SELECT 2")) +
                backendMessage('Z', byteArrayOf('I'.code.toByte()))
        assertFailsWith<OliphauntException> { parseQueryResponse(duplicate) }

        val incomplete =
            backendMessage('1', ByteArray(0)) +
                backendMessage('2', ByteArray(0)) +
                rowDescription("value", PostgresOid.text) +
                backendMessage('Z', byteArrayOf('I'.code.toByte()))
        assertFailsWith<OliphauntException> { parseQueryResponse(incomplete) }

        val controlsOnly =
            backendMessage('1', ByteArray(0)) +
                backendMessage('2', ByteArray(0)) +
                backendMessage('n', ByteArray(0)) +
                backendMessage('Z', byteArrayOf('I'.code.toByte()))
        assertFailsWith<OliphauntException> { parseQueryResponse(controlsOnly) }

        val lateRow =
            backendMessage('1', ByteArray(0)) +
                backendMessage('2', ByteArray(0)) +
                rowDescription("value", PostgresOid.text) +
                backendMessage('C', cstrings("SELECT 0")) +
                dataRow("late".encodeToByteArray()) +
                backendMessage('Z', byteArrayOf('I'.code.toByte()))
        assertFailsWith<OliphauntException> { parseQueryResponse(lateRow) }

        val adversarial =
            listOf(
                backendMessage('2', ByteArray(0)) + commandResponse("SELECT 0"),
                backendMessage('1', ByteArray(0)) +
                    backendMessage('1', ByteArray(0)) +
                    backendMessage('2', ByteArray(0)) +
                    backendMessage('n', ByteArray(0)) +
                    simpleCommandResponse("SELECT 0"),
                backendMessage('1', ByteArray(0)) +
                    backendMessage('2', ByteArray(0)) +
                    simpleCommandResponse("SELECT 0"),
                backendMessage('1', ByteArray(0)) +
                    backendMessage('2', ByteArray(0)) +
                    backendMessage('n', ByteArray(0)) +
                    rowDescription("value", PostgresOid.text) +
                    simpleCommandResponse("SELECT 0"),
                backendMessage('1', ByteArray(0)) +
                    backendMessage('2', ByteArray(0)) +
                    rowDescription("value", PostgresOid.text) +
                    backendMessage('n', ByteArray(0)) +
                    simpleCommandResponse("SELECT 0"),
                backendMessage('1', ByteArray(0)) +
                    backendMessage('2', ByteArray(0)) +
                    backendMessage('n', ByteArray(0)) +
                    backendMessage('3', ByteArray(0)) +
                    simpleCommandResponse("SELECT 0"),
                commandResponse("SELECT 0").dropLast(6).toByteArray() +
                    errorResponse("22000", "late") +
                    backendMessage('Z', byteArrayOf('I'.code.toByte())),
            )
        adversarial.forEach { response ->
            assertFailsWith<OliphauntException> { parseQueryResponse(response) }
        }
    }

    @Test
    fun describeParserRequiresOrderedParseMetadata() {
        val missingParse =
            parameterDescription() +
                backendMessage('n', ByteArray(0)) +
                backendMessage('Z', byteArrayOf('I'.code.toByte()))
        assertFailsWith<OliphauntException> { parseDescribeResponse(missingParse) }

        val parameterDescriptionAfterNoData =
            backendMessage('1', ByteArray(0)) +
                backendMessage('n', ByteArray(0)) +
                parameterDescription() +
                backendMessage('Z', byteArrayOf('I'.code.toByte()))
        assertFailsWith<OliphauntException> { parseDescribeResponse(parameterDescriptionAfterNoData) }

        val completeDescription =
            backendMessage('1', ByteArray(0)) +
                parameterDescription() +
                backendMessage('n', ByteArray(0))
        val lateError =
            completeDescription +
                errorResponse("22000", "late") +
                backendMessage('Z', byteArrayOf('I'.code.toByte()))
        assertFailsWith<OliphauntException> { parseDescribeResponse(lateError) }

        val unsolicitedClose =
            backendMessage('1', ByteArray(0)) +
                parameterDescription() +
                backendMessage('3', ByteArray(0)) +
                backendMessage('n', ByteArray(0)) +
                backendMessage('Z', byteArrayOf('I'.code.toByte()))
        assertFailsWith<OliphauntException> { parseDescribeResponse(unsolicitedClose) }
    }

    @Test
    fun configurationValidationRejectsInvalidValuesBeforeOpen() = runTest {
        val engine = TestEngine(TestSession(commandResponse("OK")))
        val invalid =
            listOf(
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
                EngineConfig(startupGucs = listOf(PostgresStartupGuc("CONFIG_FILE", "/tmp/other"))),
                EngineConfig(startupGucs = listOf(PostgresStartupGuc("data_directory", "/tmp/other"))),
                EngineConfig(extensions = listOf("bad/name")),
                EngineConfig(extensions = listOf("not_in_generated_catalog")),
            )
        invalid.forEach { config ->
            assertFailsWith<OliphauntException> { OliphauntDatabase.open(config, engine) }
        }
        assertEquals(
            listOf(
                "-c",
                "_name=",
                "-c",
                "ext.name\$1=on",
                "-c",
                "shared_preload_libraries=auto_explain,a,z",
            ),
            EngineConfig(
                startupGucs =
                listOf(
                    PostgresStartupGuc(" _name ", ""),
                    PostgresStartupGuc("ext.name\$1", "on"),
                    PostgresStartupGuc("SHARED_PRELOAD_LIBRARIES", "auto_explain,a"),
                ),
            ).postgresStartupArgs(listOf("z", "a", "z")),
        )
    }

    @Test
    fun cancelDelegatesToSession() = runTest {
        val session = TestSession(byteArrayOf())
        val database = OliphauntDatabase.open(EngineConfig(), TestEngine(session))
        database.cancel()
        assertEquals(1, session.cancelCount)
        assertTrue(session.simpleQueries().isEmpty())
        assertTrue(session.requests.isEmpty())
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

    override suspend fun restore(
        destination: String,
        bytes: ByteArray,
    ) {
        restoredDestination = destination
        restoredBytes = bytes
    }
}

private class TestSession(
    private val response: ByteArray,
    private val backupBytes: ByteArray = ByteArray(0),
    private val commitTag: String = "COMMIT",
    private val failBegin: Boolean = false,
    private val failCommit: Boolean = false,
    private val failRollback: Boolean = false,
    private val failRawRequest: ByteArray? = null,
    private val failStreamAfterCallback: Boolean = false,
    private val omitBeginReady: Boolean = false,
    private val beginResponse: ByteArray? = null,
    private val blockedControl: String? = null,
    private val blockClose: Boolean = false,
    private val preserveResponseStatus: Boolean = false,
) : OliphauntSession {
    val requests = mutableListOf<ByteArray>()
    var closeCount = 0
    var cancelCount = 0
    private var inTransaction = false
    private val blockedControlStarted = CompletableDeferred<Unit>()
    private val blockedControlRelease = CompletableDeferred<Unit>()
    private val closeStarted = CompletableDeferred<Unit>()
    private val closeRelease = CompletableDeferred<Unit>()

    override suspend fun execProtocolRaw(request: ByteArray): ByteArray {
        requests += request
        if (failRawRequest?.contentEquals(request) == true) {
            throw OliphauntException("raw transport failed")
        }
        val sql =
            request
                .takeIf { it.firstOrNull() == 'Q'.code.toByte() && it.size >= 6 }
                ?.copyOfRange(5, request.size - 1)
                ?.decodeToString()
        if (sql in listOf("BEGIN", "COMMIT", "ROLLBACK")) {
            if (sql == blockedControl) {
                blockedControlStarted.complete(Unit)
                blockedControlRelease.await()
            }
            if (sql == "BEGIN" && failBegin) throw OliphauntException("begin transport failed")
            if (sql == "COMMIT" && failCommit) throw OliphauntException("commit transport failed")
            if (sql == "ROLLBACK" && failRollback) throw OliphauntException("rollback transport failed")
            if (sql == "BEGIN") {
                inTransaction = true
                if (omitBeginReady) return backendMessage('C', cstrings("BEGIN"))
                beginResponse?.let { configured ->
                    inTransaction = configured.lastOrNull() != 'I'.code.toByte()
                    return configured
                }
            } else {
                inTransaction = false
            }
            return simpleCommandResponse(
                if (sql == "COMMIT") commitTag else requireNotNull(sql),
                if (inTransaction) 'T' else 'I',
            )
        }
        if (preserveResponseStatus || !inTransaction || response.lastOrNull() != 'I'.code.toByte()) return response
        return response.copyOf().also { it[it.lastIndex] = 'T'.code.toByte() }
    }

    override suspend fun execProtocolRawStream(
        request: ByteArray,
        onChunk: (ByteArray) -> Unit,
    ): ProtocolStreamOutcome {
        val outcome = captureProtocolStreamCallback(execProtocolRaw(request), onChunk)
        if (failStreamAfterCallback) throw OliphauntException("stream recovery failed")
        return outcome
    }

    override suspend fun backup(): ByteArray = backupBytes

    override suspend fun cancel() {
        cancelCount += 1
    }

    override suspend fun close() {
        if (blockClose) {
            closeStarted.complete(Unit)
            closeRelease.await()
        }
        closeCount += 1
    }

    suspend fun awaitBlockedControl() {
        blockedControlStarted.await()
    }

    fun releaseBlockedControl() {
        blockedControlRelease.complete(Unit)
    }

    suspend fun awaitClose() {
        closeStarted.await()
    }

    fun releaseClose() {
        closeRelease.complete(Unit)
    }

    fun simpleQueries(): List<String> = requests.mapNotNull { request ->
        if (request.firstOrNull() != 'Q'.code.toByte() || request.size < 6) {
            null
        } else {
            request.copyOfRange(5, request.size - 1).decodeToString()
        }
    }
}

private class AdmissionOrderSession(
    private val blockClose: Boolean = false,
    private val blockCancel: Boolean = false,
    private val failFirstRaw: Boolean = false,
) : OliphauntSession {
    private val firstRawStarted = CompletableDeferred<Unit>()
    private val firstRawRelease = CompletableDeferred<Unit>()
    private val closeStarted = CompletableDeferred<Unit>()
    private val closeRelease = CompletableDeferred<Unit>()
    private val cancelStarted = CompletableDeferred<Unit>()
    private val cancelRelease = CompletableDeferred<Unit>()
    val events = mutableListOf<String>()
    var cancelCount = 0
    var backupCount = 0
    private var typedOperationCount = 0

    override suspend fun execProtocolRaw(request: ByteArray): ByteArray {
        val sql =
            request
                .takeIf { it.firstOrNull() == 'Q'.code.toByte() && it.size >= 6 }
                ?.copyOfRange(5, request.size - 1)
                ?.decodeToString()
        if (sql in listOf("BEGIN", "COMMIT", "ROLLBACK")) {
            val control = requireNotNull(sql)
            events += control
            return simpleCommandResponse(control, if (control == "BEGIN") 'T' else 'I')
        }

        if (request.firstOrNull() == 'P'.code.toByte()) {
            typedOperationCount += 1
            events += "typed:$typedOperationCount"
            if (typedOperationCount == 1) {
                firstRawStarted.complete(Unit)
                firstRawRelease.await()
            }
            return commandResponse("UPDATE 1", 'T')
        }

        val marker = request.firstOrNull()?.toUByte()?.toString() ?: "empty"
        events += "raw:$marker"
        if (request.contentEquals(byteArrayOf(1))) {
            firstRawStarted.complete(Unit)
            firstRawRelease.await()
            if (failFirstRaw) throw OliphauntException("raw transport failed")
        }
        return request.copyOf()
    }

    override suspend fun execProtocolRawStream(
        request: ByteArray,
        onChunk: (ByteArray) -> Unit,
    ): ProtocolStreamOutcome = captureProtocolStreamCallback(execProtocolRaw(request), onChunk)

    override suspend fun backup(): ByteArray {
        backupCount += 1
        return ByteArray(0)
    }

    override suspend fun cancel() {
        cancelCount += 1
        if (blockCancel) {
            events += "cancel:start"
            cancelStarted.complete(Unit)
            cancelRelease.await()
            events += "cancel:end"
        } else {
            events += "cancel"
        }
    }

    override suspend fun close() {
        events += "close"
        if (blockClose) {
            closeStarted.complete(Unit)
            closeRelease.await()
        }
    }

    suspend fun awaitFirstRaw() {
        firstRawStarted.await()
    }

    fun releaseFirstRaw() {
        firstRawRelease.complete(Unit)
    }

    suspend fun awaitClose() {
        closeStarted.await()
    }

    fun releaseClose() {
        closeRelease.complete(Unit)
    }

    suspend fun awaitCancel() {
        cancelStarted.await()
    }

    fun releaseCancel() {
        cancelRelease.complete(Unit)
    }
}

private fun captureProtocolStreamCallback(
    chunk: ByteArray,
    onChunk: (ByteArray) -> Unit,
): ProtocolStreamOutcome = try {
    onChunk(chunk)
    ProtocolStreamOutcome.Complete
} catch (error: Throwable) {
    ProtocolStreamOutcome.CallbackAborted(error)
}

private fun cstrings(vararg values: String): ByteArray = values.fold(ByteArray(0)) { bytes, value ->
    bytes + value.encodeToByteArray() +
        byteArrayOf(0)
}

private fun backendMessage(
    tag: Char,
    body: ByteArray,
): ByteArray {
    val length = body.size + 4
    return byteArrayOf(
        tag.code.toByte(),
        (length ushr 24).toByte(),
        (length ushr 16).toByte(),
        (length ushr 8).toByte(),
        length.toByte(),
    ) + body
}

private fun commandResponse(
    tag: String,
    status: Char = 'I',
): ByteArray = backendMessage('1', ByteArray(0)) +
    backendMessage('2', ByteArray(0)) +
    backendMessage('n', ByteArray(0)) +
    simpleCommandResponse(tag, status)

private fun simpleCommandResponse(
    tag: String,
    status: Char = 'I',
): ByteArray = backendMessage('C', tag.encodeToByteArray() + byteArrayOf(0)) +
    backendMessage('Z', byteArrayOf(status.code.toByte()))

private fun queryField(
    name: String,
    typeOid: PostgresOid,
    format: QueryFormat = QueryFormat.Text,
): QueryField = QueryField(name, 0u, 0, typeOid, -1, -1, format)

private fun rowDescription(
    name: String,
    typeOid: PostgresOid,
    format: Int = 0,
): ByteArray {
    val body = mutableListOf<Byte>()
    body += byteArrayOf(0, 1).asIterable()
    body += name.encodeToByteArray().asIterable()
    body += 0
    body += ByteArray(6).asIterable()
    body +=
        byteArrayOf(
            (typeOid.value shr 24).toByte(),
            (typeOid.value shr 16).toByte(),
            (typeOid.value shr 8).toByte(),
            typeOid.value.toByte(),
            -1,
            -1,
            -1,
            -1,
            -1,
            -1,
            (format ushr 8).toByte(),
            format.toByte(),
        ).asIterable()
    return backendMessage('T', body.toByteArray())
}

private fun rowResultMessages(
    encoded: ByteArray,
    typeOid: PostgresOid,
): ByteArray = rowDescription("value", typeOid) + dataRow(encoded)

private fun dataRow(encoded: ByteArray): ByteArray {
    val length = encoded.size
    val body =
        byteArrayOf(
            0,
            1,
            (length ushr 24).toByte(),
            (length ushr 16).toByte(),
            (length ushr 8).toByte(),
            length.toByte(),
        ) + encoded
    return backendMessage('D', body)
}

private fun rowResponse(
    value: String,
    commandTag: String,
): ByteArray = backendMessage('1', ByteArray(0)) +
    backendMessage('2', ByteArray(0)) +
    rowResultMessages(value.encodeToByteArray(), PostgresOid.text) +
    simpleCommandResponse(commandTag)

private fun noticeResponse(
    severity: String,
    message: String,
): ByteArray = backendMessage(
    'N',
    byteArrayOf('S'.code.toByte()) + cstrings(severity) +
        byteArrayOf('M'.code.toByte()) + cstrings(message) + byteArrayOf(0),
)

private fun errorResponse(
    sqlstate: String,
    message: String,
): ByteArray = backendMessage(
    'E',
    byteArrayOf('S'.code.toByte()) + cstrings("ERROR") +
        byteArrayOf('C'.code.toByte()) + cstrings(sqlstate) +
        byteArrayOf('M'.code.toByte()) + cstrings(message) + byteArrayOf(0),
)

private fun parameterDescription(types: List<PostgresOid> = emptyList()): ByteArray {
    val body = mutableListOf<Byte>()
    body += ((types.size ushr 8) and 0xff).toByte()
    body += (types.size and 0xff).toByte()
    types.forEach { type ->
        body += (type.value shr 24).toByte()
        body += (type.value shr 16).toByte()
        body += (type.value shr 8).toByte()
        body += type.value.toByte()
    }
    return backendMessage('t', body.toByteArray())
}

private fun parseParameterOids(request: ByteArray): List<PostgresOid> {
    require(request.firstOrNull() == 'P'.code.toByte())
    var offset = 5
    repeat(2) {
        while (request[offset] != 0.toByte()) offset++
        offset++
    }
    val count = ((request[offset].toInt() and 0xff) shl 8) or (request[offset + 1].toInt() and 0xff)
    offset += 2
    return List(count) {
        val value =
            ((request[offset].toUInt() and 0xffu) shl 24) or
                ((request[offset + 1].toUInt() and 0xffu) shl 16) or
                ((request[offset + 2].toUInt() and 0xffu) shl 8) or
                (request[offset + 3].toUInt() and 0xffu)
        offset += 4
        PostgresOid(value)
    }
}
