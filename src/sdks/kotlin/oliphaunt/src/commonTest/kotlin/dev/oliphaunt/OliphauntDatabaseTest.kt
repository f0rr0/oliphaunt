package dev.oliphaunt

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class OliphauntDatabaseTest {
    @Test
    fun opensAndExecutesThroughInjectedEngine() = runTest {
        val database =
            OliphauntDatabase.open(
                config = OliphauntConfig(mode = EngineMode.NativeDirect),
                engine = MockEngine(EngineMode.NativeDirect),
            )

        val response = database.execProtocolRaw(ProtocolRequest(byteArrayOf(0x51)))
        assertEquals(listOf(1, 0x51), response.bytes.map(Byte::toInt))
    }

    @Test
    fun queryParsesSimpleQueryResultsThroughInjectedEngine() = runTest {
        val database =
            OliphauntDatabase.open(
                config = OliphauntConfig(mode = EngineMode.NativeDirect),
                engine = MockEngine(EngineMode.NativeDirect),
            )

        // liboliphaunt-doc-example:kotlin-typed-query
        val result = database.query("SELECT 1::text AS value, NULL AS empty")

        assertEquals(listOf("value", "empty"), result.fields.map { it.name })
        assertEquals(25u, result.fields[0].typeOid)
        assertEquals(1, result.rowCount)
        assertEquals("SELECT 1", result.commandTag)
        assertEquals("1", result.getText(0, "value"))
        assertEquals(null, result.getText(0, "empty"))
    }

    @Test
    fun queryParametersUseExtendedProtocolThroughInjectedEngine() = runTest {
        val database =
            OliphauntDatabase.open(
                config = OliphauntConfig(mode = EngineMode.NativeDirect),
                engine = MockEngine(EngineMode.NativeDirect),
            )

        val request =
            ProtocolRequest.extendedQuery(
                "SELECT \$1::text AS value, \$2::text AS empty",
                listOf(QueryParam.Text("1"), QueryParam.Null),
            )
        assertEquals('P'.code.toByte(), request.bytes.first())
        assertTrue(request.bytes.contains('B'.code.toByte()))
        assertTrue(request.bytes.contains('E'.code.toByte()))

        // liboliphaunt-doc-example:kotlin-parameterized-query
        val result =
            database.query(
                "SELECT \$1::text AS value, \$2::text AS empty",
                listOf(QueryParam.Text("1"), QueryParam.Null),
            )

        assertEquals("1", result.getText(0, "value"))
        assertEquals(null, result.getText(0, "empty"))
    }

    @Test
    fun queryValueTypesExposeStableEqualityAndHelpers() {
        assertEquals(QueryFormat.Binary, QueryFormat.fromCode(1))
        assertEquals(QueryFormat.Other(7), QueryFormat.fromCode(7))
        assertEquals(QueryParam.Text("hello"), QueryParam.text("hello"))
        assertEquals(QueryParam.Binary(byteArrayOf(1, 2)), QueryParam.binary(byteArrayOf(1, 2)))
        assertEquals(QueryParam.Binary(byteArrayOf(1, 2)).hashCode(), QueryParam.Binary(byteArrayOf(1, 2)).hashCode())

        val row = QueryRow(listOf("hello".encodeToByteArray(), null))
        assertEquals("hello", row.text(0))
        assertEquals(null, row.text(1))
        assertEquals(QueryRow(listOf("hello".encodeToByteArray(), null)), row)
        assertEquals(row.hashCode(), QueryRow(listOf("hello".encodeToByteArray(), null)).hashCode())
        assertTrue(row != QueryRow(listOf(null, "hello".encodeToByteArray())))

        val rowError =
            assertFailsWith<OliphauntException> {
                row.text(2)
            }
        assertTrue(rowError.message.orEmpty().contains("query row has no column at index 2"))

        val result =
            QueryResult(
                fields =
                listOf(
                    QueryField(
                        name = "value",
                        tableOid = 0u,
                        tableAttribute = 0,
                        typeOid = 25u,
                        typeSize = -1,
                        typeModifier = -1,
                        format = QueryFormat.Text,
                    ),
                ),
                rows = listOf(row),
                commandTag = "SELECT 1",
            )
        val missingColumn =
            assertFailsWith<OliphauntException> {
                result.getText(0, "missing")
            }
        assertTrue(missingColumn.message.orEmpty().contains("no column named 'missing'"))
        val missingRow =
            assertFailsWith<OliphauntException> {
                result.getText(3, "value")
            }
        assertTrue(missingRow.message.orEmpty().contains("query result has no row at index 3"))
    }

    @Test
    fun simpleQueryRejectsNulSqlBeforeBuildingProtocol() {
        val error =
            assertFailsWith<OliphauntException> {
                ProtocolRequest.simpleQuery("SELECT 1\u0000SELECT 2")
            }
        assertEquals("simple query SQL must not contain NUL bytes", error.message)
    }

    @Test
    fun extendedQueryRejectsInvalidFrontendInputsBeforeBuildingProtocol() {
        val nulError =
            assertFailsWith<OliphauntException> {
                ProtocolRequest.extendedQuery("SELECT \u0000", listOf(QueryParam.Null))
            }
        assertEquals("extended query SQL must not contain NUL bytes", nulError.message)

        val tooMany = List(Short.MAX_VALUE.toInt() + 1) { QueryParam.Null }
        val parameterCountError =
            assertFailsWith<OliphauntException> {
                ProtocolRequest.extendedQuery("SELECT 1", tooMany)
            }
        assertEquals(
            "extended query supports at most ${Short.MAX_VALUE} parameters, got ${Short.MAX_VALUE.toInt() + 1}",
            parameterCountError.message,
        )

        val binary = ProtocolRequest.extendedQuery("SELECT \$1::bytea", listOf(QueryParam.binary(byteArrayOf(1, 2, 3))))
        assertEquals('P'.code.toByte(), binary.bytes.first())
        assertTrue(binary.bytes.contains(1.toByte()))
        assertTrue(binary.bytes.contains(3.toByte()))
    }

    @Test
    fun transactionCommitsAndRejectsUnpinnedInterleaving() = runTest {
        val session = MockSession(EngineMode.NativeDirect)
        val database =
            OliphauntDatabase.open(
                config = OliphauntConfig(mode = EngineMode.NativeDirect),
                engine = FixedSessionEngine(session),
            )

        val value =
            database.transaction { transaction ->
                val error =
                    assertFailsWith<OliphauntException> {
                        database.execute("SELECT outside_transaction")
                    }
                assertTrue(error.message.orEmpty().contains("active OliphauntTransaction"))
                val checkpointError =
                    assertFailsWith<OliphauntException> {
                        database.checkpoint()
                    }
                assertTrue(checkpointError.message.orEmpty().contains("active OliphauntTransaction"))
                transaction.execute("INSERT INTO kotlin_tx VALUES (1)")
                val chunks = mutableListOf<List<Byte>>()
                transaction.execProtocolStream(ProtocolRequest(byteArrayOf('R'.code.toByte()))) {
                    chunks += it.bytes.toList()
                }
                assertEquals(listOf(listOf(3.toByte(), 'R'.code.toByte())), chunks)
                7
            }

        database.checkpoint()
        assertEquals(7, value)
        val requests = session.requestTexts()
        assertTrue(requests.any { it.contains("BEGIN") })
        assertTrue(requests.any { it.contains("INSERT INTO kotlin_tx") })
        assertTrue(requests.any { it.contains("COMMIT") })
        assertTrue(requests.any { it.contains("CHECKPOINT") })
        assertFalse(requests.any { it.contains("ROLLBACK") })

        val escaped = database.transaction { transaction -> transaction }
        val error =
            assertFailsWith<OliphauntException> {
                escaped.execute("SELECT after_commit")
            }
        assertTrue(error.message.orEmpty().contains("transaction is no longer active"))
    }

    @Test
    fun transactionRollsBackWhenBodyThrows() = runTest {
        val session = MockSession(EngineMode.NativeDirect)
        val database =
            OliphauntDatabase.open(
                config = OliphauntConfig(mode = EngineMode.NativeDirect),
                engine = FixedSessionEngine(session),
            )

        var captured: OliphauntTransaction? = null
        val error =
            assertFailsWith<OliphauntException> {
                database.transaction { transaction ->
                    captured = transaction
                    transaction.execute("INSERT INTO kotlin_tx VALUES (2)")
                    throw OliphauntException("boom")
                }
            }
        assertEquals("boom", error.message)

        val requests = session.requestTexts()
        assertTrue(requests.any { it.contains("BEGIN") })
        assertTrue(requests.any { it.contains("INSERT INTO kotlin_tx") })
        assertTrue(requests.any { it.contains("ROLLBACK") })
        val inactive =
            assertFailsWith<OliphauntException> {
                captured?.execute("SELECT after_rollback") ?: error("transaction was not captured")
            }
        assertTrue(inactive.message.orEmpty().contains("transaction is no longer active"))
    }

    @Test
    fun closeDuringTransactionClosesSessionAndRejectsPinnedWork() = runTest {
        val session = MockSession(EngineMode.NativeDirect)
        val database =
            OliphauntDatabase.open(
                config = OliphauntConfig(mode = EngineMode.NativeDirect),
                engine = FixedSessionEngine(session),
            )

        val error =
            assertFailsWith<OliphauntException> {
                database.transaction { transaction ->
                    database.close()
                    transaction.execute("SELECT after_close")
                }
            }
        assertTrue(error.message.orEmpty().contains("database is closed"))

        val afterClose =
            assertFailsWith<OliphauntException> {
                database.execute("SELECT after_closed_database")
            }
        assertTrue(afterClose.message.orEmpty().contains("database is closed"))

        val requests = session.requestTexts()
        assertTrue(requests.any { it.contains("BEGIN") })
        assertFalse(requests.any { it.contains("SELECT after_close") })
        assertFalse(requests.any { it.contains("COMMIT") })
    }

    @Test
    fun rawProtocolStreamFallsBackToOwnedResponseThroughInjectedEngine() = runTest {
        val database =
            OliphauntDatabase.open(
                config = OliphauntConfig(mode = EngineMode.NativeDirect),
                engine = MockEngine(EngineMode.NativeDirect),
            )

        val chunks = mutableListOf<ProtocolResponse>()
        database.execProtocolStream(ProtocolRequest(byteArrayOf(0x51))) { chunk ->
            chunks += chunk
        }

        assertEquals(listOf(listOf(1, 0x51)), chunks.map { chunk -> chunk.bytes.map(Byte::toInt) })
    }

    @Test
    fun querySurfacesPostgresErrors() {
        val error =
            assertFailsWith<PostgresException> {
                parseQueryResponse(backendErrorResponse("ERROR", "42P01", "relation does not exist"))
            }
        assertEquals("ERROR", error.postgresError.severity)
        assertEquals("42P01", error.postgresError.sqlstate)
        assertEquals("relation does not exist", error.postgresError.message)
    }

    @Test
    fun queryNormalizesCancellationPostgresErrors() {
        val error =
            assertFailsWith<PostgresException> {
                parseQueryResponse(backendErrorResponse("ERROR", "57014", "canceling statement due to user request"))
            }
        assertEquals("ERROR", error.postgresError.severity)
        assertEquals("57014", error.postgresError.sqlstate)
        assertEquals("canceling statement due to user request", error.postgresError.message)
    }

    @Test
    fun queryParserRejectsInvalidUtf8FieldNames() {
        val response =
            buildList<Byte> {
                addRawRowDescription(listOf(byteArrayOf(0xff.toByte()) to 25u))
                addReadyForQuery()
            }.toByteArray()

        val error =
            assertFailsWith<OliphauntException> {
                parseQueryResponse(response)
            }
        assertTrue(error.message.orEmpty().contains("field name is not valid UTF-8"))
    }

    @Test
    fun queryTextAccessorsRejectInvalidUtf8Values() {
        val response =
            buildList<Byte> {
                addRowDescription(listOf("value" to 25u))
                addDataRow(listOf(byteArrayOf(0xff.toByte())))
                addCommandComplete("SELECT 1")
                addReadyForQuery()
            }.toByteArray()

        val result = parseQueryResponse(response)
        val error =
            assertFailsWith<OliphauntException> {
                result.getText(0, "value")
            }
        assertTrue(error.message.orEmpty().contains("query value is not valid UTF-8"))
    }

    @Test
    fun queryParserAcceptsExtendedQueryControlMessages() {
        val response =
            buildList<Byte> {
                addBackendMessage('1'.code, byteArrayOf())
                addBackendMessage('2'.code, byteArrayOf())
                addBackendMessage('3'.code, byteArrayOf())
                addBackendMessage('n'.code, byteArrayOf())
                addBackendMessage('I'.code, byteArrayOf())
                addCommandComplete("INSERT 0 0")
                addReadyForQuery()
            }.toByteArray()

        val result = parseQueryResponse(response)
        assertTrue(result.fields.isEmpty())
        assertTrue(result.rows.isEmpty())
        assertEquals("INSERT 0 0", result.commandTag)
    }

    @Test
    fun queryParserAcceptsAsyncBackendControlMessages() {
        val response =
            buildList<Byte> {
                addParameterStatus("client_encoding", "UTF8")
                addNoticeResponse("NOTICE", "hello")
                addNotificationResponse(123, "channel", "payload")
                addCommandComplete("SELECT 0")
                addReadyForQuery()
            }.toByteArray()

        val result = parseQueryResponse(response)
        assertEquals("SELECT 0", result.commandTag)
    }

    @Test
    fun queryParserRejectsMalformedEmptyControlMessages() {
        val response =
            buildList<Byte> {
                addBackendMessage('1'.code, byteArrayOf(0))
                addReadyForQuery()
            }.toByteArray()

        val error =
            assertFailsWith<OliphauntException> {
                parseQueryResponse(response)
            }
        assertTrue(error.message.orEmpty().contains("ParseComplete contained trailing bytes"))
    }

    @Test
    fun queryParserRejectsMalformedResultSequencing() {
        val missingReady =
            buildList<Byte> {
                addCommandComplete("SELECT 0")
            }.toByteArray()
        val missingReadyError =
            assertFailsWith<OliphauntException> {
                parseQueryResponse(missingReady)
            }
        assertTrue(missingReadyError.message.orEmpty().contains("ended before ReadyForQuery"))

        val duplicateResult =
            buildList<Byte> {
                addRowDescription(listOf("one" to 25u))
                addRowDescription(listOf("two" to 25u))
                addReadyForQuery()
            }.toByteArray()
        val duplicateResultError =
            assertFailsWith<OliphauntException> {
                parseQueryResponse(duplicateResult)
            }
        assertTrue(duplicateResultError.message.orEmpty().contains("multiple result sets"))

        val invalidLength =
            byteArrayOf('Z'.code.toByte(), 0, 0, 0, 3)
        val invalidLengthError =
            assertFailsWith<OliphauntException> {
                parseQueryResponse(invalidLength)
            }
        assertTrue(invalidLengthError.message.orEmpty().contains("invalid backend message length 3"))
    }

    @Test
    fun queryParserRejectsInvalidRowCounts() {
        val invalidRowDescription =
            buildList<Byte> {
                addBackendMessage('T'.code, byteArrayOf(0xff.toByte(), 0xff.toByte()))
            }.toByteArray()
        val rowDescriptionError =
            assertFailsWith<OliphauntException> {
                parseQueryResponse(invalidRowDescription)
            }
        assertTrue(rowDescriptionError.message.orEmpty().contains("invalid RowDescription field count -1"))

        val invalidDataRow =
            buildList<Byte> {
                addRowDescription(listOf("value" to 25u))
                addBackendMessage('D'.code, byteArrayOf(0xff.toByte(), 0xff.toByte()))
            }.toByteArray()
        val dataRowError =
            assertFailsWith<OliphauntException> {
                parseQueryResponse(invalidDataRow)
            }
        assertTrue(dataRowError.message.orEmpty().contains("invalid DataRow column count -1"))

        val mismatchedDataRow =
            buildList<Byte> {
                addRowDescription(listOf("value" to 25u))
                addBackendMessage('D'.code, byteArrayOf(0, 0))
            }.toByteArray()
        val mismatchError =
            assertFailsWith<OliphauntException> {
                parseQueryResponse(mismatchedDataRow)
            }
        assertTrue(mismatchError.message.orEmpty().contains("does not match RowDescription count 1"))
    }

    @Test
    fun queryParserRejectsMalformedAsyncBackendControlMessages() {
        val malformedParameter =
            buildList<Byte> {
                addBackendMessage('S'.code, "client_encoding\u0000".encodeToByteArray())
                addReadyForQuery()
            }.toByteArray()
        val parameterError =
            assertFailsWith<OliphauntException> {
                parseQueryResponse(malformedParameter)
            }
        assertTrue(parameterError.message.orEmpty().contains("ParameterStatus value is missing null terminator"))

        val malformedNotice =
            buildList<Byte> {
                addBackendMessage('N'.code, byteArrayOf('S'.code.toByte()) + "NOTICE\u0000".encodeToByteArray())
                addReadyForQuery()
            }.toByteArray()
        val noticeError =
            assertFailsWith<OliphauntException> {
                parseQueryResponse(malformedNotice)
            }
        assertTrue(noticeError.message.orEmpty().contains("NoticeResponse is missing terminator"))

        val malformedNotification =
            buildList<Byte> {
                val body =
                    buildList<Byte> {
                        addInt32(123)
                        addAll("channel".encodeToByteArray().asIterable())
                    }.toByteArray()
                addBackendMessage('A'.code, body)
                addReadyForQuery()
            }.toByteArray()
        val notificationError =
            assertFailsWith<OliphauntException> {
                parseQueryResponse(malformedNotification)
            }
        assertTrue(
            notificationError.message
                .orEmpty()
                .contains("NotificationResponse channel is missing null terminator"),
        )
    }

    @Test
    fun queryParserRejectsUnexpectedBackendMessageTags() {
        val response =
            buildList<Byte> {
                addBackendMessage('R'.code, byteArrayOf(0, 0, 0, 0))
                addReadyForQuery()
            }.toByteArray()

        val error =
            assertFailsWith<OliphauntException> {
                parseQueryResponse(response)
            }
        assertTrue(error.message.orEmpty().contains("unexpected backend message tag 0x52"))
    }

    @Test
    fun queryParserAcceptsReadyForQueryTransactionStates() {
        for (status in listOf('I'.code.toByte(), 'T'.code.toByte(), 'E'.code.toByte())) {
            val response =
                buildList<Byte> {
                    addCommandComplete("SELECT 0")
                    addReadyForQuery(status)
                }.toByteArray()

            val result = parseQueryResponse(response)
            assertEquals("SELECT 0", result.commandTag)
        }
    }

    @Test
    fun queryParserRejectsMalformedReadyForQueryStatus() {
        val missing =
            buildList<Byte> {
                addBackendMessage('Z'.code, byteArrayOf())
            }.toByteArray()
        val missingError =
            assertFailsWith<OliphauntException> {
                parseQueryResponse(missing)
            }
        assertTrue(missingError.message.orEmpty().contains("ReadyForQuery contained 0 bytes, expected 1"))

        val invalid =
            buildList<Byte> {
                addReadyForQuery(0.toByte())
            }.toByteArray()
        val invalidError =
            assertFailsWith<OliphauntException> {
                parseQueryResponse(invalid)
            }
        assertTrue(
            invalidError.message
                .orEmpty()
                .contains("ReadyForQuery contained invalid transaction status 0x00"),
        )
    }

    @Test
    fun serverCapabilitiesExposeConnectionString() = runTest {
        val database =
            OliphauntDatabase.open(
                config = OliphauntConfig(mode = EngineMode.NativeServer),
                engine = MockEngine(EngineMode.NativeServer),
            )

        val capabilities = database.capabilities()
        assertTrue(capabilities.independentSessions)
        assertEquals(false, capabilities.multiRoot)
        assertTrue(capabilities.queryCancel)
        assertTrue(capabilities.backupRestore)
        assertEquals(
            listOf(BackupFormat.Sql, BackupFormat.PhysicalArchive),
            capabilities.backupFormats,
        )
        assertEquals(listOf(BackupFormat.PhysicalArchive), capabilities.restoreFormats)
        assertTrue(capabilities.supportsBackupFormat(BackupFormat.Sql))
        assertTrue(capabilities.supportsBackupFormat(BackupFormat.PhysicalArchive))
        assertFalse(capabilities.supportsBackupFormat(BackupFormat.OliphauntArchive))
        assertTrue(capabilities.supportsRestoreFormat(BackupFormat.PhysicalArchive))
        assertFalse(capabilities.supportsRestoreFormat(BackupFormat.Sql))
        assertTrue(database.supportsBackupFormat(BackupFormat.Sql))
        assertTrue(database.supportsRestoreFormat(BackupFormat.PhysicalArchive))
        assertFalse(database.supportsRestoreFormat(BackupFormat.Sql))
        assertTrue(capabilities.simpleQuery)
        assertEquals("postgres://postgres@127.0.0.1:55432/template1", capabilities.connectionString)
    }

    @Test
    fun connectionStringIsOnlyPresentForServerCapabilities() = runTest {
        listOf(EngineMode.NativeDirect, EngineMode.NativeBroker).forEach { mode ->
            val database =
                OliphauntDatabase.open(
                    config = OliphauntConfig(mode = mode),
                    engine = MockEngine(mode),
                )
            assertEquals(null, database.connectionString())
            assertFalse(database.capabilities().independentSessions)
        }

        val server =
            OliphauntDatabase.open(
                config = OliphauntConfig(mode = EngineMode.NativeServer),
                engine = MockEngine(EngineMode.NativeServer),
            )
        assertEquals("postgres://postgres@127.0.0.1:55432/template1", server.connectionString())
        assertTrue(server.capabilities().independentSessions)
    }

    @Test
    fun runtimeSupportPublishesExplicitModeContract() {
        val support = OliphauntDatabase.supportedModes(SupportingDirectEngine())

        assertEquals(
            listOf(EngineMode.NativeDirect, EngineMode.NativeBroker, EngineMode.NativeServer),
            support.map { it.mode },
        )
        assertTrue(support[0].available)
        assertEquals(1, support[0].capabilities.maxClientSessions)
        assertEquals(listOf(BackupFormat.PhysicalArchive), support[0].capabilities.backupFormats)
        assertTrue(support[0].capabilities.supportsBackupFormat(BackupFormat.PhysicalArchive))
        assertFalse(support[0].capabilities.supportsBackupFormat(BackupFormat.Sql))
        assertEquals(false, support[0].capabilities.independentSessions)
        assertEquals(false, support[0].capabilities.multiRoot)
        assertTrue(support[0].capabilities.reopenable)
        assertTrue(support[0].capabilities.sameRootLogicalReopen)
        assertFalse(support[0].capabilities.rootSwitchable)
        assertFalse(support[0].capabilities.crashRestartable)
        assertEquals(false, support[1].available)
        assertTrue(support[1].capabilities.processIsolated)
        assertTrue(support[1].capabilities.multiRoot)
        assertTrue(support[1].capabilities.reopenable)
        assertFalse(support[1].capabilities.sameRootLogicalReopen)
        assertTrue(support[1].capabilities.rootSwitchable)
        assertTrue(support[1].capabilities.crashRestartable)
        assertTrue(support[1].unavailableReason.orEmpty().contains("broker"))
        assertEquals(false, support[2].available)
        assertTrue(support[2].capabilities.independentSessions)
        assertEquals(false, support[2].capabilities.multiRoot)
        assertTrue(support[2].capabilities.reopenable)
        assertFalse(support[2].capabilities.sameRootLogicalReopen)
        assertTrue(support[2].capabilities.rootSwitchable)
        assertFalse(support[2].capabilities.crashRestartable)
        assertEquals(
            listOf(BackupFormat.Sql, BackupFormat.PhysicalArchive),
            support[2].capabilities.backupFormats,
        )
        assertTrue(support[2].capabilities.supportsBackupFormat(BackupFormat.Sql))
        assertTrue(support[2].capabilities.supportsRestoreFormat(BackupFormat.PhysicalArchive))
        assertTrue(support[2].unavailableReason.orEmpty().contains("server"))
    }

    @Test
    fun defaultRuntimeSupportPublishesConcreteModeList() {
        val support = OliphauntDatabase.supportedModes()

        assertEquals(
            listOf(EngineMode.NativeDirect, EngineMode.NativeBroker, EngineMode.NativeServer),
            support.map { it.mode },
        )
        assertTrue(support.filterNot { it.available }.all { it.unavailableReason.orEmpty().isNotBlank() })
    }

    @Test
    fun backupUsesCanonicalFormats() = runTest {
        val database =
            OliphauntDatabase.open(
                config = OliphauntConfig(mode = EngineMode.NativeServer),
                engine = MockEngine(EngineMode.NativeServer),
            )

        val artifact = database.backup(BackupRequest(BackupFormat.Sql))
        assertEquals(BackupFormat.Sql, artifact.format)
        assertEquals("sql-backup", artifact.bytes.decodeToString())
    }

    @Test
    fun backupRejectsUnsupportedFormatsBeforeEngineCall() = runTest {
        val database =
            OliphauntDatabase.open(
                config = OliphauntConfig(mode = EngineMode.NativeDirect),
                engine = MockEngine(EngineMode.NativeDirect),
            )

        val error =
            assertFailsWith<OliphauntException> {
                database.backup(BackupRequest(BackupFormat.Sql))
            }
        assertTrue(error.message.orEmpty().contains("Sql backup is not supported by NativeDirect"))
    }

    @Test
    fun openRejectsBlankRootBeforeEngineCall() = runTest {
        val engine = CountingEngine()
        val error =
            assertFailsWith<OliphauntException> {
                OliphauntDatabase.open(
                    config = OliphauntConfig(mode = EngineMode.NativeDirect, root = " \t"),
                    engine = engine,
                )
            }

        assertTrue(error.message.orEmpty().contains("database root must not be empty"))
        assertEquals(0, engine.openCalls)
    }

    @Test
    fun openRejectsNulRootBeforeEngineCall() = runTest {
        val engine = CountingEngine()
        val error =
            assertFailsWith<OliphauntException> {
                OliphauntDatabase.open(
                    config = OliphauntConfig(mode = EngineMode.NativeDirect, root = "/tmp/oliphaunt\u0000root"),
                    engine = engine,
                )
            }

        assertTrue(error.message.orEmpty().contains("database root must not contain NUL bytes"))
        assertEquals(0, engine.openCalls)
    }

    @Test
    fun openForwardsConnectionIdentityAndRejectsInvalidIdentityBeforeEngineCall() = runTest {
        val engine = CountingEngine()
        val blankUser =
            assertFailsWith<OliphauntException> {
                OliphauntDatabase.open(
                    config = OliphauntConfig(username = " \n"),
                    engine = engine,
                )
            }
        assertTrue(blankUser.message.orEmpty().contains("username must not be empty"))
        assertEquals(0, engine.openCalls)

        val nulDatabase =
            assertFailsWith<OliphauntException> {
                OliphauntDatabase.open(
                    config = OliphauntConfig(database = "app\u0000db"),
                    engine = engine,
                )
            }
        assertTrue(nulDatabase.message.orEmpty().contains("database must not contain NUL bytes"))
        assertEquals(0, engine.openCalls)

        val database =
            OliphauntDatabase.open(
                config =
                OliphauntConfig(
                    username = "app_user",
                    database = "app_db",
                ),
                engine = engine,
            )
        assertEquals("app_user", engine.openedConfigs.single().username)
        assertEquals("app_db", engine.openedConfigs.single().database)
        database.close()
    }

    @Test
    fun restoreUsesCanonicalPhysicalArchiveShape() = runTest {
        val artifact =
            BackupArtifact(
                BackupFormat.PhysicalArchive,
                "physical-backup".encodeToByteArray(),
            )
        val root =
            OliphauntDatabase.restore(
                RestoreRequest(
                    artifact = artifact,
                    root = "/tmp/oliphaunt-restore",
                ).replaceExisting(),
                engine = MockEngine(EngineMode.NativeDirect),
            )

        assertEquals("/tmp/oliphaunt-restore", root)
    }

    @Test
    fun restoreRejectsUnsupportedFormatsBeforeEngineCall() = runTest {
        val error =
            assertFailsWith<OliphauntException> {
                OliphauntDatabase.restore(
                    RestoreRequest(
                        artifact =
                        BackupArtifact(
                            BackupFormat.Sql,
                            "sql-backup".encodeToByteArray(),
                        ),
                        root = "/tmp/oliphaunt-restore-sql",
                    ),
                    engine = MockEngine(EngineMode.NativeDirect),
                )
            }

        assertTrue(
            error.message
                .orEmpty()
                .contains("restore currently requires a PhysicalArchive artifact, got Sql"),
        )
    }

    @Test
    fun restoreRejectsBlankRootBeforeEngineCall() = runTest {
        val engine = CountingEngine()
        val error =
            assertFailsWith<OliphauntException> {
                OliphauntDatabase.restore(
                    RestoreRequest(
                        artifact =
                        BackupArtifact(
                            BackupFormat.PhysicalArchive,
                            "physical-backup".encodeToByteArray(),
                        ),
                        root = "\n",
                    ),
                    engine = engine,
                )
            }

        assertTrue(error.message.orEmpty().contains("restore root must not be empty"))
        assertEquals(0, engine.restoreCalls)
    }

    @Test
    fun restoreRejectsNulRootBeforeEngineCall() = runTest {
        val engine = CountingEngine()
        val error =
            assertFailsWith<OliphauntException> {
                OliphauntDatabase.restore(
                    RestoreRequest(
                        artifact =
                        BackupArtifact(
                            BackupFormat.PhysicalArchive,
                            "physical-backup".encodeToByteArray(),
                        ),
                        root = "/tmp/oliphaunt\u0000restore",
                    ),
                    engine = engine,
                )
            }

        assertTrue(error.message.orEmpty().contains("restore root must not contain NUL bytes"))
        assertEquals(0, engine.restoreCalls)
    }

    @Test
    fun openValidatesExtensionIdsBeforeEngineCall() = runTest {
        val engine = CountingEngine()
        val error =
            assertFailsWith<OliphauntException> {
                OliphauntDatabase.open(
                    config = OliphauntConfig(extensions = listOf("mobile/vector")),
                    engine = engine,
                )
            }
        assertTrue(error.message.orEmpty().contains("extension id 'mobile/vector'"))
        assertEquals(0, engine.openCalls)

        val unknownError =
            assertFailsWith<OliphauntException> {
                OliphauntDatabase.open(
                    config = OliphauntConfig(extensions = listOf("pg_search")),
                    engine = engine,
                )
            }
        assertTrue(
            unknownError.message.orEmpty().contains("unknown Kotlin Oliphaunt extension id 'pg_search'"),
        )
        assertEquals(0, engine.openCalls)

        val database =
            OliphauntDatabase.open(
                config = OliphauntConfig(extensions = listOf(" pg_trgm ", "", "vector", "hstore")),
                engine = engine,
            )
        assertEquals(1, engine.openCalls)
        assertEquals(listOf("pg_trgm", "vector", "hstore"), engine.openedConfigs.single().extensions)
        database.close()
    }

    @Test
    fun openForwardsFootprintAndStartupGucsAndRejectsInvalidGucsBeforeEngineCall() = runTest {
        val engine = CountingEngine()
        val error =
            assertFailsWith<OliphauntException> {
                OliphauntDatabase.open(
                    config =
                    OliphauntConfig(
                        startupGucs = listOf(PostgresStartupGuc("shared-buffers", "16MB")),
                    ),
                    engine = engine,
                )
            }
        assertTrue(error.message.orEmpty().contains("startup GUC name 'shared-buffers'"))
        assertEquals(0, engine.openCalls)

        val database =
            OliphauntDatabase.open(
                config =
                OliphauntConfig(
                    runtimeFootprint = RuntimeFootprintProfile.BalancedMobile,
                    startupGucs =
                    listOf(
                        PostgresStartupGuc("shared_buffers", "16MB"),
                        PostgresStartupGuc("wal_buffers", "256kB"),
                    ),
                ),
                engine = engine,
            )
        assertEquals(1, engine.openCalls)
        assertEquals(RuntimeFootprintProfile.BalancedMobile, engine.openedConfigs.single().runtimeFootprint)
        assertEquals(
            listOf(
                PostgresStartupGuc("shared_buffers", "16MB"),
                PostgresStartupGuc("wal_buffers", "256kB"),
            ),
            engine.openedConfigs.single().startupGucs,
        )
        database.close()
    }

    @Test
    fun runtimeFootprintProfilesBuildTheMobileStartupGucContract() {
        assertEquals(
            listOf(
                "max_connections=1",
                "superuser_reserved_connections=0",
                "reserved_connections=0",
                "autovacuum_worker_slots=1",
                "max_wal_senders=0",
                "max_replication_slots=0",
                "shared_buffers=32MB",
                "wal_buffers=-1",
                "min_wal_size=32MB",
                "max_wal_size=64MB",
                "io_method=sync",
                "io_max_concurrency=1",
                "fsync=on",
                "full_page_writes=on",
                "synchronous_commit=off",
                "shared_buffers=16MB",
            ),
            startupAssignments(
                OliphauntConfig(
                    durability = DurabilityProfile.Balanced,
                    runtimeFootprint = RuntimeFootprintProfile.BalancedMobile,
                    startupGucs = listOf(PostgresStartupGuc(" shared_buffers ", "16MB")),
                ).postgresStartupArgs(),
            ),
        )
        assertEquals(
            listOf(
                "max_connections=1",
                "superuser_reserved_connections=0",
                "reserved_connections=0",
                "autovacuum_worker_slots=1",
                "max_wal_senders=0",
                "max_replication_slots=0",
                "shared_buffers=32MB",
                "wal_buffers=-1",
                "min_wal_size=32MB",
                "max_wal_size=64MB",
                "io_method=sync",
                "io_max_concurrency=1",
                "fsync=on",
                "full_page_writes=on",
                "synchronous_commit=off",
                "shared_buffers=16MB",
                "shared_preload_libraries=auto_explain,pg_search",
            ),
            startupAssignments(
                OliphauntConfig(
                    durability = DurabilityProfile.Balanced,
                    runtimeFootprint = RuntimeFootprintProfile.BalancedMobile,
                    startupGucs = listOf(PostgresStartupGuc(" shared_buffers ", "16MB")),
                ).postgresStartupArgs(setOf("pg_search", "auto_explain", "pg_search")),
            ),
        )
        assertEquals(
            listOf(
                "max_connections=1",
                "superuser_reserved_connections=0",
                "reserved_connections=0",
                "autovacuum_worker_slots=1",
                "max_wal_senders=0",
                "max_replication_slots=0",
                "shared_buffers=8MB",
                "wal_buffers=256kB",
                "min_wal_size=32MB",
                "max_wal_size=64MB",
                "work_mem=1MB",
                "maintenance_work_mem=16MB",
                "io_method=sync",
                "io_max_concurrency=1",
                "fsync=on",
                "full_page_writes=on",
                "synchronous_commit=off",
            ),
            startupAssignments(
                OliphauntConfig(runtimeFootprint = RuntimeFootprintProfile.SmallMobile)
                    .postgresStartupArgs(),
            ),
        )
    }

    @Test
    fun closeIsIdempotentAndRejectsFurtherExecution() = runTest {
        val database =
            OliphauntDatabase.open(
                config = OliphauntConfig(mode = EngineMode.NativeDirect),
                engine = MockEngine(EngineMode.NativeDirect),
            )

        database.close()
        database.close()

        assertFailsWith<OliphauntException> {
            database.execProtocolRaw(ProtocolRequest(ByteArray(0)))
        }
    }

    @Test
    fun closeDoesNotIssueSpuriousCancelBeforeClosing() = runTest {
        val session = BlockingSession()
        val database =
            OliphauntDatabase.open(
                config = OliphauntConfig(mode = EngineMode.NativeDirect),
                engine = FixedSessionEngine(session),
            )

        database.close()

        assertFalse(session.cancelled.isCompleted)
        assertTrue(session.closed.isCompleted)
        assertFailsWith<OliphauntException> {
            database.cancel()
        }
    }

    @Test
    fun prepareForBackgroundCheckpointsWhenIdleAndResumeProbesSession() = runTest {
        val session = MockSession(EngineMode.NativeDirect)
        val database =
            OliphauntDatabase.open(
                config = OliphauntConfig(mode = EngineMode.NativeDirect),
                engine = FixedSessionEngine(session),
            )

        val prepared = database.prepareForBackground()
        database.resumeFromBackground()

        assertEquals(
            BackgroundPreparationResult(
                cancelledActiveWork = false,
                checkpointed = true,
            ),
            prepared,
        )
        val requests = session.requestTexts()
        assertTrue(requests.any { it.contains("CHECKPOINT") })
        assertTrue(requests.any { it.contains("SELECT 1") })
    }

    @Test
    fun prepareForBackgroundCancelsActiveWorkAndSkipsCheckpoint() = runTest {
        val session = BlockingOperationSession()
        val database =
            OliphauntDatabase.open(
                config = OliphauntConfig(mode = EngineMode.NativeDirect),
                engine = FixedSessionEngine(session),
            )
        val running =
            async {
                database.execProtocolRaw(ProtocolRequest.simpleQuery("SELECT pg_sleep(5)"))
            }
        session.started.await()

        val prepared = database.prepareForBackground()

        assertEquals(
            BackgroundPreparationResult(
                cancelledActiveWork = true,
                checkpointed = false,
                skippedCheckpointReason = BackgroundCheckpointSkipReason.ActiveWork,
            ),
            prepared,
        )
        assertTrue(session.cancelled.isCompleted)
        assertEquals("cancelled", running.await().bytes.decodeToString())
    }

    @Test
    fun prepareForBackgroundSkipsCheckpointDuringTransaction() = runTest {
        val session = MockSession(EngineMode.NativeDirect)
        val database =
            OliphauntDatabase.open(
                config = OliphauntConfig(mode = EngineMode.NativeDirect),
                engine = FixedSessionEngine(session),
            )

        val prepared =
            database.transaction {
                database.prepareForBackground()
            }

        assertEquals(
            BackgroundPreparationResult(
                cancelledActiveWork = false,
                checkpointed = false,
                skippedCheckpointReason = BackgroundCheckpointSkipReason.TransactionActive,
            ),
            prepared,
        )
        assertFalse(session.requestTexts().any { it.contains("CHECKPOINT") })
    }
}

private class MockEngine(
    private val mode: EngineMode,
) : OliphauntEngine {
    override suspend fun open(config: OliphauntConfig): OliphauntSession {
        assertEquals(mode, config.mode)
        return MockSession(mode)
    }

    override suspend fun restore(request: RestoreRequest): String {
        assertEquals(BackupFormat.PhysicalArchive, request.artifact.format)
        assertEquals(RestoreTargetPolicy.ReplaceExisting, request.targetPolicy)
        return request.root
    }
}

private class SupportingDirectEngine : OliphauntEngine {
    override fun supportedModes(): List<EngineModeSupport> = OliphauntRuntimeSupport.nativeDirectOnly(
        brokerReason = "broker adapter is unavailable",
        serverReason = "server adapter is unavailable",
    )

    override suspend fun open(config: OliphauntConfig): OliphauntSession = throw OliphauntException("not used")

    override suspend fun restore(request: RestoreRequest): String = throw OliphauntException("not used")
}

private class CountingEngine : OliphauntEngine {
    var openCalls = 0
    var restoreCalls = 0
    val openedConfigs = mutableListOf<OliphauntConfig>()

    override suspend fun open(config: OliphauntConfig): OliphauntSession {
        openCalls += 1
        openedConfigs += config
        return MockSession(config.mode)
    }

    override suspend fun restore(request: RestoreRequest): String {
        restoreCalls += 1
        return request.root
    }
}

private class MockSession(
    private val mode: EngineMode,
) : OliphauntSession {
    private var calls = 0
    private val requests = mutableListOf<ByteArray>()

    override suspend fun capabilities(): EngineCapabilities = when (mode) {
        EngineMode.NativeDirect -> {
            EngineCapabilities(
                mode = mode,
                processIsolated = false,
                independentSessions = false,
                maxClientSessions = 1,
            )
        }

        EngineMode.NativeBroker -> {
            EngineCapabilities(
                mode = mode,
                processIsolated = true,
                independentSessions = false,
                maxClientSessions = 1,
            )
        }

        EngineMode.NativeServer -> {
            EngineCapabilities(
                mode = mode,
                processIsolated = true,
                independentSessions = true,
                maxClientSessions = 32,
                backupFormats = listOf(BackupFormat.Sql, BackupFormat.PhysicalArchive),
                connectionString = "postgres://postgres@127.0.0.1:55432/template1",
            )
        }
    }

    override suspend fun execProtocolRaw(request: ProtocolRequest): ProtocolResponse {
        calls += 1
        requests += request.bytes
        if (
            request.bytes.size > 5 &&
            (request.bytes[0] == 'Q'.code.toByte() || request.bytes[0] == 'P'.code.toByte())
        ) {
            return ProtocolResponse(backendSelectResponse())
        }
        return ProtocolResponse(byteArrayOf(calls.toByte()) + request.bytes)
    }

    fun requestTexts(): List<String> = requests.map { it.decodeToString() }

    override suspend fun backup(request: BackupRequest): BackupArtifact = when (request.format) {
        BackupFormat.Sql -> {
            BackupArtifact(BackupFormat.Sql, "sql-backup".encodeToByteArray())
        }

        BackupFormat.PhysicalArchive -> {
            BackupArtifact(
                BackupFormat.PhysicalArchive,
                "physical-backup".encodeToByteArray(),
            )
        }

        BackupFormat.OliphauntArchive -> {
            throw OliphauntException("oliphaunt archive is not available")
        }
    }

    override suspend fun cancel() = Unit

    override suspend fun close() = Unit
}

private class FixedSessionEngine(
    private val session: OliphauntSession,
) : OliphauntEngine {
    override suspend fun open(config: OliphauntConfig): OliphauntSession = session

    override suspend fun restore(request: RestoreRequest): String = request.root
}

private class BlockingSession : OliphauntSession {
    val started = CompletableDeferred<Unit>()
    val cancelled = CompletableDeferred<Unit>()
    val closed = CompletableDeferred<Unit>()

    override suspend fun capabilities(): EngineCapabilities = EngineCapabilities(
        mode = EngineMode.NativeDirect,
        processIsolated = false,
        independentSessions = false,
        maxClientSessions = 1,
    )

    override suspend fun execProtocolRaw(request: ProtocolRequest): ProtocolResponse {
        started.complete(Unit)
        return ProtocolResponse(request.bytes)
    }

    override suspend fun backup(request: BackupRequest): BackupArtifact = throw OliphauntException("backup blocked")

    override suspend fun cancel() {
        cancelled.complete(Unit)
    }

    override suspend fun close() {
        closed.complete(Unit)
    }
}

private class BlockingOperationSession : OliphauntSession {
    val started = CompletableDeferred<Unit>()
    val cancelled = CompletableDeferred<Unit>()
    private val response = CompletableDeferred<ProtocolResponse>()

    override suspend fun capabilities(): EngineCapabilities = EngineCapabilities(
        mode = EngineMode.NativeDirect,
        processIsolated = false,
        independentSessions = false,
        maxClientSessions = 1,
    )

    override suspend fun execProtocolRaw(request: ProtocolRequest): ProtocolResponse {
        started.complete(Unit)
        return response.await()
    }

    override suspend fun backup(request: BackupRequest): BackupArtifact = throw OliphauntException("backup blocked")

    override suspend fun cancel() {
        cancelled.complete(Unit)
        response.complete(ProtocolResponse("cancelled".encodeToByteArray()))
    }

    override suspend fun close() = Unit
}

private fun backendSelectResponse(): ByteArray = buildList<Byte> {
    addRowDescription(listOf("value" to 25u, "empty" to 25u))
    addDataRow(listOf("1".encodeToByteArray(), null))
    addCommandComplete("SELECT 1")
    addReadyForQuery()
}.toByteArray()

private fun backendErrorResponse(
    severity: String,
    sqlstate: String,
    message: String,
): ByteArray = buildList<Byte> {
    val body =
        buildList<Byte> {
            add('S'.code.toByte())
            addAll(severity.encodeToByteArray().asIterable())
            add(0)
            add('C'.code.toByte())
            addAll(sqlstate.encodeToByteArray().asIterable())
            add(0)
            add('M'.code.toByte())
            addAll(message.encodeToByteArray().asIterable())
            add(0)
            add(0)
        }.toByteArray()
    addBackendMessage('E'.code, body)
    addReadyForQuery()
}.toByteArray()

private fun MutableList<Byte>.addRowDescription(fields: List<Pair<String, UInt>>) {
    addRawRowDescription(fields.map { (name, typeOid) -> name.encodeToByteArray() to typeOid })
}

private fun MutableList<Byte>.addRawRowDescription(fields: List<Pair<ByteArray, UInt>>) {
    val body =
        buildList<Byte> {
            addInt16(fields.size)
            for ((name, typeOid) in fields) {
                addAll(name.asIterable())
                add(0)
                addUInt32(0u)
                addInt16(0)
                addUInt32(typeOid)
                addInt16(-1)
                addInt32(-1)
                addInt16(0)
            }
        }.toByteArray()
    addBackendMessage('T'.code, body)
}

private fun MutableList<Byte>.addDataRow(values: List<ByteArray?>) {
    val body =
        buildList<Byte> {
            addInt16(values.size)
            for (value in values) {
                if (value == null) {
                    addInt32(-1)
                } else {
                    addInt32(value.size)
                    addAll(value.asIterable())
                }
            }
        }.toByteArray()
    addBackendMessage('D'.code, body)
}

private fun MutableList<Byte>.addCommandComplete(tag: String) {
    val body =
        buildList<Byte> {
            addAll(tag.encodeToByteArray().asIterable())
            add(0)
        }.toByteArray()
    addBackendMessage('C'.code, body)
}

private fun MutableList<Byte>.addNoticeResponse(
    severity: String,
    message: String,
) {
    val body =
        buildList<Byte> {
            add('S'.code.toByte())
            addAll(severity.encodeToByteArray().asIterable())
            add(0)
            add('M'.code.toByte())
            addAll(message.encodeToByteArray().asIterable())
            add(0)
            add(0)
        }.toByteArray()
    addBackendMessage('N'.code, body)
}

private fun MutableList<Byte>.addParameterStatus(
    name: String,
    value: String,
) {
    val body =
        buildList<Byte> {
            addAll(name.encodeToByteArray().asIterable())
            add(0)
            addAll(value.encodeToByteArray().asIterable())
            add(0)
        }.toByteArray()
    addBackendMessage('S'.code, body)
}

private fun MutableList<Byte>.addNotificationResponse(
    pid: Int,
    channel: String,
    payload: String,
) {
    val body =
        buildList<Byte> {
            addInt32(pid)
            addAll(channel.encodeToByteArray().asIterable())
            add(0)
            addAll(payload.encodeToByteArray().asIterable())
            add(0)
        }.toByteArray()
    addBackendMessage('A'.code, body)
}

private fun MutableList<Byte>.addReadyForQuery(status: Byte = 'I'.code.toByte()) {
    addBackendMessage('Z'.code, byteArrayOf(status))
}

private fun startupAssignments(args: List<String>): List<String> {
    val assignments = mutableListOf<String>()
    var index = 0
    while (index < args.size) {
        require(args[index] == "-c") { "unexpected startup flag ${args[index]}" }
        require(index + 1 < args.size) { "missing startup assignment after -c" }
        assignments += args[index + 1]
        index += 2
    }
    return assignments
}

private fun MutableList<Byte>.addBackendMessage(
    tag: Int,
    body: ByteArray,
) {
    add(tag.toByte())
    addInt32(body.size + 4)
    addAll(body.asIterable())
}

private fun MutableList<Byte>.addUInt32(value: UInt) {
    add(((value shr 24) and 0xffu).toByte())
    add(((value shr 16) and 0xffu).toByte())
    add(((value shr 8) and 0xffu).toByte())
    add((value and 0xffu).toByte())
}

private fun MutableList<Byte>.addInt32(value: Int) {
    addUInt32(value.toUInt())
}

private fun MutableList<Byte>.addInt16(value: Int) {
    val bits = value and 0xffff
    add(((bits ushr 8) and 0xff).toByte())
    add((bits and 0xff).toByte())
}
