package dev.oliphaunt.consumer

import android.content.Context
import dev.oliphaunt.CommandResult
import dev.oliphaunt.DatabaseStorage
import dev.oliphaunt.ExecResult
import dev.oliphaunt.Oliphaunt
import dev.oliphaunt.OliphauntConfig
import dev.oliphaunt.OliphauntDatabase
import dev.oliphaunt.OliphauntTransaction
import dev.oliphaunt.OliphauntTransactionDatabaseException
import dev.oliphaunt.OliphauntTransactionRollbackException
import dev.oliphaunt.PostgresDecoders
import dev.oliphaunt.PostgresDiagnostic
import dev.oliphaunt.PostgresError
import dev.oliphaunt.PostgresErrorField
import dev.oliphaunt.PostgresException
import dev.oliphaunt.PostgresNotice
import dev.oliphaunt.PostgresOid
import dev.oliphaunt.PostgresStartupGuc
import dev.oliphaunt.QueryDescription
import dev.oliphaunt.QueryParam
import dev.oliphaunt.QueryResult
import dev.oliphaunt.StatementResult
import dev.oliphaunt.describe
import dev.oliphaunt.exec
import dev.oliphaunt.execute
import dev.oliphaunt.query
import java.io.File

/**
 * Compile-only proof that an Android application can consume the packaged AAR's stable API.
 *
 * Nothing calls this function: the consumer project is compiled, never installed or run.
 */
internal suspend fun compileOliphauntPublicApi(
    context: Context,
    databaseDirectory: File,
    restoreDirectory: File,
    runtimeDirectory: File,
    resourceRoot: File,
    protocolRequest: ByteArray,
) {
    val temporaryStorage: DatabaseStorage = DatabaseStorage.TemporaryDirectory
    val persistentStorage: DatabaseStorage = DatabaseStorage.Directory(databaseDirectory)
    consume(temporaryStorage)

    val config =
        OliphauntConfig(
            storage = persistentStorage,
            startupGucs = listOf(PostgresStartupGuc("application_name", "public-api-consumer")),
            username = "postgres",
            database = "postgres",
            extensions = listOf("vector"),
        )
    val database: OliphauntDatabase =
        Oliphaunt.open(
            context = context,
            config = config,
            runtimeDirectory = runtimeDirectory,
            resourceRoot = resourceRoot,
        )

    try {
        exerciseTypedDatabaseApi(database)

        val bufferedResponse: ByteArray = database.execProtocolRaw(protocolRequest)
        database.execProtocolRawStream(protocolRequest) { chunk -> consume(chunk) }

        database.transaction { transaction: OliphauntTransaction ->
            val queryResult: QueryResult =
                transaction.query("SELECT $1::int4 AS value", listOf(QueryParam.int(42)))
            val commandResult: CommandResult =
                transaction.execute("CREATE TEMP TABLE consumer_probe(value int4)")
            val execResult: ExecResult = transaction.exec("SELECT 1; SELECT 2")
            val description: QueryDescription =
                transaction.describe("SELECT $1::int4", listOf(PostgresOid.int4))

            consume(
                queryResult.rows.firstOrNull()?.value("value", PostgresDecoders.int),
                commandResult,
                execResult,
                description,
                transaction.isClosed,
            )
            transaction.rollback()
            consume(transaction.isClosed)
        }

        database.cancel()
        val backup: ByteArray = database.backup()
        consume(bufferedResponse, backup, database.isClosed)
        database.close()
        consume(database.isClosed)

        Oliphaunt.restore(
            context = context,
            destination = restoreDirectory,
            bytes = backup,
        )
    } catch (error: PostgresException) {
        inspectPostgresException(error)
    } catch (error: OliphauntTransactionRollbackException) {
        inspectRollbackException(error)
    } catch (error: OliphauntTransactionDatabaseException) {
        inspectTransactionDatabaseException(error)
    } finally {
        database.close()
    }
}

private suspend fun exerciseTypedDatabaseApi(database: OliphauntDatabase) {
    val commandResult: CommandResult =
        database.execute("CREATE TEMP TABLE consumer_probe(value int4)")
    val queryResult: QueryResult =
        database.query("SELECT $1::int4 AS value", listOf(QueryParam.int(42)))
    val execResult: ExecResult = database.exec("SELECT 1; SELECT 2")
    val description: QueryDescription =
        database.describe("SELECT $1::int4", listOf(PostgresOid.int4))

    val decoded: Int? = queryResult.rows.firstOrNull()?.value("value", PostgresDecoders.int)
    val raw: ByteArray? = queryResult.rows.firstOrNull()?.raw("value")
    val statements: List<StatementResult> = execResult.statements
    consume(
        commandResult.commandTag,
        commandResult.rowCount,
        commandResult.notices,
        queryResult.fields,
        queryResult.rows,
        queryResult.commandTag,
        queryResult.rowCount,
        queryResult.notices,
        queryResult.getText(0, "value"),
        decoded,
        raw,
        statements,
        execResult.notices,
        description.parameterTypes,
        description.fields,
        description.notices,
    )
}

private fun inspectPostgresException(error: PostgresException) {
    val postgresError: PostgresError = error.postgresError
    val diagnostic: PostgresDiagnostic = postgresError.diagnostic
    val fields: List<PostgresErrorField> = diagnostic.fields
    val notices: List<PostgresNotice> = postgresError.notices
    consume(
        diagnostic.severity,
        diagnostic.sqlstate,
        diagnostic.message,
        diagnostic.detail,
        diagnostic.hint,
        fields,
        notices.map(PostgresNotice::diagnostic),
    )
}

private fun inspectRollbackException(error: OliphauntTransactionRollbackException) {
    val callbackError: Throwable = error.callbackError
    val rollbackError: Throwable = error.rollbackError
    consume(callbackError, rollbackError, error.cause, error.suppressed)
}

private fun inspectTransactionDatabaseException(error: OliphauntTransactionDatabaseException) {
    val callbackError: Throwable = error.callbackError
    val databaseError: Throwable = error.databaseError
    consume(callbackError, databaseError, error.cause, error.suppressed)
}

private fun consume(vararg values: Any?) {
    @Suppress("UNUSED_VARIABLE")
    val retained = values
}
