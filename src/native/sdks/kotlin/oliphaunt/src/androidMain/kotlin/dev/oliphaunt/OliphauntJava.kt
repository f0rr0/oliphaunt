package dev.oliphaunt

import android.content.Context
import kotlinx.coroutines.runBlocking

/** Blocking Java access to the Kotlin SDK. Invoke on application worker threads. */
public object OliphauntJava {
    @JvmStatic
    @JvmOverloads
    public fun open(context: Context, config: OliphauntConfig = OliphauntConfig()): BlockingOliphauntDatabase = BlockingOliphauntDatabase(runBlocking { Oliphaunt.open(context, config) })
}

/** Owns the same native session as [OliphauntDatabase] and supports try-with-resources. */
public class BlockingOliphauntDatabase internal constructor(private val database: OliphauntDatabase) : AutoCloseable {
    @JvmOverloads
    public fun execute(sql: String, parameters: List<QueryParam> = emptyList()): CommandResult = runBlocking { database.execute(sql, parameters) }

    @JvmOverloads
    public fun query(sql: String, parameters: List<QueryParam> = emptyList()): QueryResult = runBlocking { database.query(sql, parameters) }

    public fun exec(sql: String): ExecResult = runBlocking { database.exec(sql) }

    public fun backup(): ByteArray = runBlocking { database.backup() }

    public fun cancel(): Unit = runBlocking { database.cancel() }

    override fun close(): Unit = runBlocking { database.close() }
}
