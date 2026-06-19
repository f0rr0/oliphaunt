package dev.oliphaunt

public sealed class QueryFormat {
    public data object Text : QueryFormat()

    public data object Binary : QueryFormat()

    public data class Other(
        val code: Int,
    ) : QueryFormat()

    public companion object {
        public fun fromCode(code: Int): QueryFormat = when (code) {
            0 -> Text
            1 -> Binary
            else -> Other(code)
        }
    }
}

public sealed class QueryParam {
    public data object Null : QueryParam()

    public data class Text(
        val value: String,
    ) : QueryParam()

    public class Binary(
        public val value: ByteArray,
    ) : QueryParam() {
        override fun equals(other: Any?): Boolean = this === other || (other is Binary && value.contentEquals(other.value))

        override fun hashCode(): Int = value.contentHashCode()
    }

    public companion object {
        public fun text(value: String): QueryParam = Text(value)

        public fun binary(value: ByteArray): QueryParam = Binary(value)
    }
}

public data class QueryField(
    val name: String,
    val tableOid: UInt,
    val tableAttribute: Short,
    val typeOid: UInt,
    val typeSize: Short,
    val typeModifier: Int,
    val format: QueryFormat,
)

public class QueryRow(
    public val values: List<ByteArray?>,
) {
    public fun text(column: Int): String? {
        if (column !in values.indices) {
            throw OliphauntException("query row has no column at index $column")
        }
        return values[column]?.decodeUtf8Strict("query value")
    }

    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is QueryRow) return false
        if (values.size != other.values.size) return false
        return values.indices.all { index ->
            val left = values[index]
            val right = other.values[index]
            when {
                left == null && right == null -> true
                left == null || right == null -> false
                else -> left.contentEquals(right)
            }
        }
    }

    override fun hashCode(): Int = values.fold(1) { acc, value ->
        31 * acc + (value?.contentHashCode() ?: 0)
    }
}

public data class QueryResult(
    val fields: List<QueryField>,
    val rows: List<QueryRow>,
    val commandTag: String?,
) {
    public val rowCount: Int get() = rows.size

    public fun fieldIndex(name: String): Int? {
        val index = fields.indexOfFirst { it.name == name }
        return if (index >= 0) index else null
    }

    public fun getText(
        row: Int,
        column: String,
    ): String? {
        val columnIndex =
            fieldIndex(column)
                ?: throw OliphauntException("query result has no column named '$column'")
        if (row !in rows.indices) {
            throw OliphauntException("query result has no row at index $row")
        }
        return rows[row].text(columnIndex)
    }
}

public data class PostgresErrorField(
    val code: Int,
    val value: String,
)

public data class PostgresError(
    val severity: String?,
    val sqlstate: String?,
    val message: String,
    val detail: String?,
    val hint: String?,
    val position: String?,
    val whereText: String?,
    val schemaName: String?,
    val tableName: String?,
    val columnName: String?,
    val dataTypeName: String?,
    val constraintName: String?,
    val fields: List<PostgresErrorField>,
) {
    override fun toString(): String = when {
        severity != null && sqlstate != null -> "$severity [$sqlstate]: $message"
        severity != null -> "$severity: $message"
        sqlstate != null -> "[$sqlstate]: $message"
        else -> message
    }

    public companion object {
        public fun fromFields(fields: List<PostgresErrorField>): PostgresError = PostgresError(
            severity = fields.value('S'.code) ?: fields.value('V'.code),
            sqlstate = fields.value('C'.code),
            message = fields.value('M'.code) ?: "PostgreSQL ErrorResponse",
            detail = fields.value('D'.code),
            hint = fields.value('H'.code),
            position = fields.value('P'.code),
            whereText = fields.value('W'.code),
            schemaName = fields.value('s'.code),
            tableName = fields.value('t'.code),
            columnName = fields.value('c'.code),
            dataTypeName = fields.value('d'.code),
            constraintName = fields.value('n'.code),
            fields = fields,
        )

        public fun fallback(): PostgresError = fromFields(
            listOf(PostgresErrorField('M'.code, "PostgreSQL ErrorResponse")),
        )
    }
}

public suspend fun OliphauntDatabase.query(sql: String): QueryResult = parseQueryResponse(execProtocolRaw(ProtocolRequest.simpleQuery(sql)).bytes)

public suspend fun OliphauntDatabase.query(
    sql: String,
    parameters: List<QueryParam>,
): QueryResult = parseQueryResponse(execProtocolRaw(ProtocolRequest.extendedQuery(sql, parameters)).bytes)

public suspend fun OliphauntTransaction.query(sql: String): QueryResult = parseQueryResponse(execProtocolRaw(ProtocolRequest.simpleQuery(sql)).bytes)

public suspend fun OliphauntTransaction.query(
    sql: String,
    parameters: List<QueryParam>,
): QueryResult = parseQueryResponse(execProtocolRaw(ProtocolRequest.extendedQuery(sql, parameters)).bytes)

public fun ProtocolRequest.Companion.extendedQuery(
    sql: String,
    parameters: List<QueryParam>,
): ProtocolRequest {
    if (parameters.size > Short.MAX_VALUE.toInt()) {
        throw OliphauntException("extended query supports at most ${Short.MAX_VALUE} parameters, got ${parameters.size}")
    }
    if (sql.any { it.code == 0 }) {
        throw OliphauntException("extended query SQL must not contain NUL bytes")
    }

    val packet = mutableListOf<Byte>()
    packet.addParse(sql)
    packet.addBind(parameters)
    packet.addDescribePortal()
    packet.addExecute()
    packet.addFrontendMessage('S'.code, ByteArray(0))
    return ProtocolRequest(packet.toByteArray())
}

public fun parseQueryResponse(bytes: ByteArray): QueryResult {
    val cursor = ByteCursor(bytes)
    var fields: List<QueryField>? = null
    val rows = mutableListOf<QueryRow>()
    var commandTag: String? = null
    var sawReady = false

    while (!cursor.isAtEnd) {
        val tag = cursor.readUByte("backend message tag").toInt()
        val length = cursor.readInt("backend message length")
        if (length < 4) {
            throw OliphauntException("invalid backend message length $length")
        }
        val body = ByteCursor(cursor.readBytes(length - 4, "backend message body"))

        when (tag) {
            0x54 -> {
                if (fields != null) {
                    throw OliphauntException(
                        "query() received multiple result sets; use execProtocolRaw for multi-statement row results",
                    )
                }
                fields = parseRowDescription(body)
                body.requireEnd("RowDescription")
            }

            0x44 -> {
                val activeFields = fields ?: throw OliphauntException("DataRow arrived before RowDescription")
                rows += parseDataRow(body, activeFields.size)
                body.requireEnd("DataRow")
            }

            0x43 -> {
                commandTag = body.readCString("CommandComplete tag")
                body.requireEnd("CommandComplete")
            }

            0x45 -> {
                throw PostgresException(parseErrorResponse(body))
            }

            0x47, 0x48, 0x57, 0x64, 0x63 -> {
                throw OliphauntException(
                    "query() does not support COPY protocol responses; use execProtocolRaw for COPY traffic",
                )
            }

            0x5a -> {
                validateReadyForQuery(body)
                sawReady = true
                if (!cursor.isAtEnd) {
                    throw OliphauntException("backend returned bytes after ReadyForQuery")
                }
            }

            0x31 -> {
                body.requireEnd("ParseComplete")
            }

            0x32 -> {
                body.requireEnd("BindComplete")
            }

            0x33 -> {
                body.requireEnd("CloseComplete")
            }

            0x49 -> {
                body.requireEnd("EmptyQueryResponse")
            }

            0x6e -> {
                body.requireEnd("NoData")
            }

            0x53 -> {
                validateParameterStatus(body)
            }

            0x4e -> {
                validateFieldResponse(body, "NoticeResponse")
            }

            0x41 -> {
                validateNotificationResponse(body)
            }

            else -> {
                throw OliphauntException(
                    "query() received unexpected backend message tag ${tag.hexBackendTag()}",
                )
            }
        }
    }

    if (!sawReady) {
        throw OliphauntException("query response ended before ReadyForQuery")
    }

    return QueryResult(
        fields = fields.orEmpty(),
        rows = rows,
        commandTag = commandTag,
    )
}

private fun parseRowDescription(cursor: ByteCursor): List<QueryField> {
    val count = cursor.readShort("RowDescription field count").toInt()
    if (count < 0) {
        throw OliphauntException("invalid RowDescription field count $count")
    }
    return List(count) {
        QueryField(
            name = cursor.readCString("field name"),
            tableOid = cursor.readUInt("field table oid"),
            tableAttribute = cursor.readShort("field table attribute"),
            typeOid = cursor.readUInt("field type oid"),
            typeSize = cursor.readShort("field type size"),
            typeModifier = cursor.readInt("field type modifier"),
            format = QueryFormat.fromCode(cursor.readShort("field format").toInt()),
        )
    }
}

private fun parseDataRow(
    cursor: ByteCursor,
    expectedColumns: Int,
): QueryRow {
    val count = cursor.readShort("DataRow column count").toInt()
    if (count < 0) {
        throw OliphauntException("invalid DataRow column count $count")
    }
    if (count != expectedColumns) {
        throw OliphauntException(
            "DataRow column count $count does not match RowDescription count $expectedColumns",
        )
    }
    val values =
        List(count) {
            val length = cursor.readInt("DataRow value length")
            when {
                length == -1 -> null
                length < 0 -> throw OliphauntException("invalid DataRow value length $length")
                else -> cursor.readBytes(length, "DataRow value")
            }
        }
    return QueryRow(values)
}

private fun parseErrorResponse(cursor: ByteCursor): PostgresError {
    val fields = mutableListOf<PostgresErrorField>()
    while (!cursor.isAtEnd) {
        val code =
            runCatching { cursor.readUByte("ErrorResponse field code").toInt() }
                .getOrElse { return PostgresError.fallback() }
        if (code == 0) {
            break
        }
        val value =
            runCatching { cursor.readCString("ErrorResponse field") }
                .getOrElse { return PostgresError.fallback() }
        fields += PostgresErrorField(code, value)
    }
    return PostgresError.fromFields(fields)
}

private fun List<PostgresErrorField>.value(code: Int): String? = firstOrNull { it.code == code }?.value

private fun Int.hexBackendTag(): String = "0x" + toString(16).padStart(2, '0')

private fun validateReadyForQuery(cursor: ByteCursor) {
    val remaining = cursor.remainingBytes()
    if (remaining != 1) {
        throw OliphauntException("ReadyForQuery contained $remaining bytes, expected 1")
    }
    val status = cursor.readUByte("ReadyForQuery transaction status").toInt()
    if (status != 'I'.code && status != 'T'.code && status != 'E'.code) {
        throw OliphauntException(
            "ReadyForQuery contained invalid transaction status ${status.hexBackendTag()}",
        )
    }
}

private fun validateParameterStatus(cursor: ByteCursor) {
    cursor.readCString("ParameterStatus name")
    cursor.readCString("ParameterStatus value")
    cursor.requireEnd("ParameterStatus")
}

private fun validateNotificationResponse(cursor: ByteCursor) {
    cursor.readInt("NotificationResponse process id")
    cursor.readCString("NotificationResponse channel")
    cursor.readCString("NotificationResponse payload")
    cursor.requireEnd("NotificationResponse")
}

private fun validateFieldResponse(
    cursor: ByteCursor,
    label: String,
) {
    while (true) {
        if (cursor.isAtEnd) {
            throw OliphauntException("$label is missing terminator")
        }
        val code = cursor.readUByte("$label field code").toInt()
        if (code == 0) {
            cursor.requireEnd(label)
            return
        }
        cursor.readCString("$label field")
    }
}

private class ByteCursor(
    private val bytes: ByteArray,
) {
    private var offset = 0

    val isAtEnd: Boolean get() = offset == bytes.size

    fun remainingBytes(): Int = bytes.size - offset

    fun requireEnd(label: String) {
        if (!isAtEnd) {
            throw OliphauntException("$label contained trailing bytes")
        }
    }

    fun readUByte(label: String): UByte = readBytes(1, label)[0].toUByte()

    fun readUInt(label: String): UInt = (
        (readUByte(label).toUInt() shl 24) or
            (readUByte(label).toUInt() shl 16) or
            (readUByte(label).toUInt() shl 8) or
            readUByte(label).toUInt()
        )

    fun readInt(label: String): Int = readUInt(label).toInt()

    fun readShort(label: String): Short {
        val value = ((readUByte(label).toInt() shl 8) or readUByte(label).toInt())
        return value.toShort()
    }

    fun readCString(label: String): String {
        val end = bytes.indexOf(0, startIndex = offset)
        if (end < 0) {
            throw OliphauntException("$label is missing null terminator")
        }
        val raw = bytes.copyOfRange(offset, end)
        offset = end + 1
        return raw.decodeUtf8Strict(label)
    }

    fun readBytes(
        count: Int,
        label: String,
    ): ByteArray {
        if (count < 0 || offset + count > bytes.size) {
            throw OliphauntException("truncated $label")
        }
        val value = bytes.copyOfRange(offset, offset + count)
        offset += count
        return value
    }
}

private fun ByteArray.indexOf(
    byte: Byte,
    startIndex: Int,
): Int {
    for (index in startIndex until size) {
        if (this[index] == byte) {
            return index
        }
    }
    return -1
}

private fun MutableList<Byte>.addParse(sql: String) {
    val body = mutableListOf<Byte>()
    body.addCString("")
    body.addCString(sql)
    body.addInt16(0)
    addFrontendMessage('P'.code, body.toByteArray())
}

private fun MutableList<Byte>.addBind(parameters: List<QueryParam>) {
    val body = mutableListOf<Byte>()
    body.addCString("")
    body.addCString("")

    body.addInt16(parameters.size)
    for (parameter in parameters) {
        body.addInt16(
            when (parameter) {
                is QueryParam.Binary -> 1
                QueryParam.Null, is QueryParam.Text -> 0
            },
        )
    }

    body.addInt16(parameters.size)
    for (parameter in parameters) {
        when (parameter) {
            QueryParam.Null -> body.addInt32(-1)
            is QueryParam.Text -> body.addSizedValue(parameter.value.encodeToByteArray())
            is QueryParam.Binary -> body.addSizedValue(parameter.value)
        }
    }

    body.addInt16(1)
    body.addInt16(0)
    addFrontendMessage('B'.code, body.toByteArray())
}

private fun MutableList<Byte>.addDescribePortal() {
    val body = mutableListOf<Byte>()
    body.add('P'.code.toByte())
    body.addCString("")
    addFrontendMessage('D'.code, body.toByteArray())
}

private fun MutableList<Byte>.addExecute() {
    val body = mutableListOf<Byte>()
    body.addCString("")
    body.addInt32(0)
    addFrontendMessage('E'.code, body.toByteArray())
}

private fun MutableList<Byte>.addFrontendMessage(
    tag: Int,
    body: ByteArray,
) {
    add(tag.toByte())
    addInt32(body.size + 4)
    addAll(body.asIterable())
}

private fun MutableList<Byte>.addCString(value: String) {
    if (value.any { it.code == 0 }) {
        throw OliphauntException("frontend protocol string must not contain NUL bytes")
    }
    addAll(value.encodeToByteArray().asIterable())
    add(0)
}

private fun MutableList<Byte>.addSizedValue(value: ByteArray) {
    addInt32(value.size)
    addAll(value.asIterable())
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

private fun ByteArray.decodeUtf8Strict(label: String): String {
    try {
        return decodeToString(throwOnInvalidSequence = true)
    } catch (error: Exception) {
        val detail = error.message?.let { ": $it" }.orEmpty()
        throw OliphauntException("$label is not valid UTF-8$detail")
    }
}
