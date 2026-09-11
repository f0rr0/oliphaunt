package dev.oliphaunt

@JvmInline
public value class PostgresOid(
    public val value: UInt,
) {
    public companion object {
        public val bool: PostgresOid = PostgresOid(16u)
        public val bytea: PostgresOid = PostgresOid(17u)
        public val char: PostgresOid = PostgresOid(18u)
        public val name: PostgresOid = PostgresOid(19u)
        public val int8: PostgresOid = PostgresOid(20u)
        public val int2: PostgresOid = PostgresOid(21u)
        public val int4: PostgresOid = PostgresOid(23u)
        public val text: PostgresOid = PostgresOid(25u)
        public val oid: PostgresOid = PostgresOid(26u)
        public val json: PostgresOid = PostgresOid(114u)
        public val xml: PostgresOid = PostgresOid(142u)
        public val float4: PostgresOid = PostgresOid(700u)
        public val float8: PostgresOid = PostgresOid(701u)
        public val unknown: PostgresOid = PostgresOid(705u)
        public val bpchar: PostgresOid = PostgresOid(1_042u)
        public val varchar: PostgresOid = PostgresOid(1_043u)
        public val date: PostgresOid = PostgresOid(1_082u)
        public val time: PostgresOid = PostgresOid(1_083u)
        public val timestamp: PostgresOid = PostgresOid(1_114u)
        public val timestamptz: PostgresOid = PostgresOid(1_184u)
        public val interval: PostgresOid = PostgresOid(1_186u)
        public val timetz: PostgresOid = PostgresOid(1_266u)
        public val numeric: PostgresOid = PostgresOid(1_700u)
        public val uuid: PostgresOid = PostgresOid(2_950u)
        public val jsonb: PostgresOid = PostgresOid(3_802u)

        public val boolArray: PostgresOid = PostgresOid(1_000u)
        public val byteaArray: PostgresOid = PostgresOid(1_001u)
        public val charArray: PostgresOid = PostgresOid(1_002u)
        public val nameArray: PostgresOid = PostgresOid(1_003u)
        public val int2Array: PostgresOid = PostgresOid(1_005u)
        public val int4Array: PostgresOid = PostgresOid(1_007u)
        public val textArray: PostgresOid = PostgresOid(1_009u)
        public val bpcharArray: PostgresOid = PostgresOid(1_014u)
        public val varcharArray: PostgresOid = PostgresOid(1_015u)
        public val int8Array: PostgresOid = PostgresOid(1_016u)
        public val float4Array: PostgresOid = PostgresOid(1_021u)
        public val float8Array: PostgresOid = PostgresOid(1_022u)
        public val oidArray: PostgresOid = PostgresOid(1_028u)
        public val timestampArray: PostgresOid = PostgresOid(1_115u)
        public val dateArray: PostgresOid = PostgresOid(1_182u)
        public val timeArray: PostgresOid = PostgresOid(1_183u)
        public val timestamptzArray: PostgresOid = PostgresOid(1_185u)
        public val intervalArray: PostgresOid = PostgresOid(1_187u)
        public val timetzArray: PostgresOid = PostgresOid(1_270u)
        public val numericArray: PostgresOid = PostgresOid(1_231u)
        public val jsonArray: PostgresOid = PostgresOid(199u)
        public val xmlArray: PostgresOid = PostgresOid(143u)
        public val uuidArray: PostgresOid = PostgresOid(2_951u)
        public val jsonbArray: PostgresOid = PostgresOid(3_807u)
    }
}

public sealed class QueryFormat {
    public data object Text : QueryFormat()

    public data object Binary : QueryFormat()

    public data class Other(
        val code: Int,
    ) : QueryFormat()

    public companion object {
        internal fun fromCode(code: Int): QueryFormat = when (code) {
            0 -> Text
            1 -> Binary
            else -> Other(code)
        }
    }
}

public enum class ValueFormat {
    Text,
    Binary,
}

public open class QueryParam(
    public val typeOid: PostgresOid? = null,
    format: ValueFormat = ValueFormat.Text,
    bytes: ByteArray?,
) {
    private val ownedBytes: ByteArray? = bytes?.copyOf()

    public val format: ValueFormat = if (bytes == null) ValueFormat.Text else format

    public val bytes: ByteArray? get() = ownedBytes?.copyOf()

    internal val encodedBytes: ByteArray? get() = ownedBytes

    public data object Null : QueryParam(bytes = null)

    public class Text(
        public val value: String,
        typeOid: PostgresOid? = null,
    ) : QueryParam(typeOid = typeOid, bytes = value.encodeToByteArray())

    public class Binary(
        value: ByteArray,
        typeOid: PostgresOid? = null,
    ) : QueryParam(typeOid = typeOid, format = ValueFormat.Binary, bytes = value) {
        public val value: ByteArray get() = requireNotNull(bytes)
    }

    override fun equals(other: Any?): Boolean = this === other || (
        other is QueryParam &&
            typeOid == other.typeOid &&
            format == other.format &&
            when {
                ownedBytes == null && other.ownedBytes == null -> true
                ownedBytes == null || other.ownedBytes == null -> false
                else -> ownedBytes.contentEquals(other.ownedBytes)
            }
        )

    override fun hashCode(): Int {
        var result = typeOid?.hashCode() ?: 0
        result = 31 * result + format.hashCode()
        return 31 * result + (ownedBytes?.contentHashCode() ?: 0)
    }

    public companion object {
        public fun typedNull(typeOid: PostgresOid): QueryParam = QueryParam(typeOid = typeOid, bytes = null)

        public fun text(
            value: String,
            typeOid: PostgresOid? = null,
        ): QueryParam = Text(value, typeOid)

        public fun binary(
            value: ByteArray,
            typeOid: PostgresOid? = null,
        ): QueryParam = Binary(value, typeOid)

        public fun string(value: String): QueryParam = Text(value, PostgresOid.text)

        public fun boolean(value: Boolean): QueryParam = Text(if (value) "t" else "f", PostgresOid.bool)

        public fun short(value: Short): QueryParam = Text(value.toString(), PostgresOid.int2)

        public fun int(value: Int): QueryParam = Text(value.toString(), PostgresOid.int4)

        public fun long(value: Long): QueryParam = Text(value.toString(), PostgresOid.int8)

        public fun float(value: Float): QueryParam = Text(value.toString(), PostgresOid.float4)

        public fun double(value: Double): QueryParam = Text(value.toString(), PostgresOid.float8)

        public fun bytes(value: ByteArray): QueryParam = Binary(value, PostgresOid.bytea)

        public fun uuid(value: String): QueryParam = Text(value.lowercase(), PostgresOid.uuid)
    }
}

public data class QueryField(
    val name: String,
    val tableOid: UInt,
    val tableAttribute: Short,
    val typeOid: PostgresOid,
    val typeSize: Short,
    val typeModifier: Int,
    val format: QueryFormat,
)

public fun interface PostgresDecoder<T> {
    public fun decode(
        bytes: ByteArray?,
        field: QueryField,
    ): T?
}

public object PostgresDecoders {
    public val string: PostgresDecoder<String> = PostgresDecoder { bytes, field ->
        requirePostgresOid(
            field,
            setOf(
                PostgresOid.char,
                PostgresOid.name,
                PostgresOid.bool,
                PostgresOid.int2,
                PostgresOid.int4,
                PostgresOid.int8,
                PostgresOid.text,
                PostgresOid.oid,
                PostgresOid.json,
                PostgresOid.xml,
                PostgresOid.float4,
                PostgresOid.float8,
                PostgresOid.unknown,
                PostgresOid.bpchar,
                PostgresOid.varchar,
                PostgresOid.date,
                PostgresOid.time,
                PostgresOid.timetz,
                PostgresOid.timestamp,
                PostgresOid.timestamptz,
                PostgresOid.interval,
                PostgresOid.numeric,
                PostgresOid.uuid,
                PostgresOid.jsonb,
            ),
            "String",
        )
        if (field.format != QueryFormat.Text) unsupportedPostgresFormat(field, "String")
        bytes?.decodeUtf8Strict("PostgreSQL String value")
    }

    public val boolean: PostgresDecoder<Boolean> = PostgresDecoder { bytes, field ->
        requirePostgresOid(field, setOf(PostgresOid.bool), "Boolean")
        requirePostgresFormat(field, "Boolean")
        bytes?.let { value ->
            when (field.format) {
                QueryFormat.Text -> when (value.decodeUtf8Strict("PostgreSQL Boolean value")) {
                    "t" -> true
                    "f" -> false
                    else -> invalidPostgresValue(field, "Boolean")
                }

                QueryFormat.Binary -> when {
                    value.contentEquals(byteArrayOf(0)) -> false
                    value.contentEquals(byteArrayOf(1)) -> true
                    else -> invalidPostgresValue(field, "Boolean")
                }

                is QueryFormat.Other -> unsupportedPostgresFormat(field, "Boolean")
            }
        }
    }

    public val short: PostgresDecoder<Short> = fixedIntegerDecoder(
        PostgresOid.int2,
        2,
        "Short",
        String::toShortOrNull,
    ) { it.toShort() }

    public val int: PostgresDecoder<Int> = fixedIntegerDecoder(
        PostgresOid.int4,
        4,
        "Int",
        String::toIntOrNull,
    ) { it.toInt() }

    public val long: PostgresDecoder<Long> = fixedIntegerDecoder(
        PostgresOid.int8,
        8,
        "Long",
        String::toLongOrNull,
    ) { it.toLong() }

    public val float: PostgresDecoder<Float> = PostgresDecoder { bytes, field ->
        requirePostgresOid(field, setOf(PostgresOid.float4), "Float")
        requirePostgresFormat(field, "Float")
        bytes?.let { value ->
            when (field.format) {
                QueryFormat.Text -> value.decodeUtf8Strict("PostgreSQL Float value").toFloatOrNull()
                    ?: invalidPostgresValue(field, "Float")

                QueryFormat.Binary -> Float.fromBits(postgresUnsigned(value, 4, field, "Float").toInt())

                is QueryFormat.Other -> unsupportedPostgresFormat(field, "Float")
            }
        }
    }

    public val double: PostgresDecoder<Double> = PostgresDecoder { bytes, field ->
        requirePostgresOid(field, setOf(PostgresOid.float8), "Double")
        requirePostgresFormat(field, "Double")
        bytes?.let { value ->
            when (field.format) {
                QueryFormat.Text -> value.decodeUtf8Strict("PostgreSQL Double value").toDoubleOrNull()
                    ?: invalidPostgresValue(field, "Double")

                QueryFormat.Binary -> Double.fromBits(postgresUnsigned(value, 8, field, "Double").toLong())

                is QueryFormat.Other -> unsupportedPostgresFormat(field, "Double")
            }
        }
    }

    public val bytes: PostgresDecoder<ByteArray> = PostgresDecoder { bytes, field ->
        requirePostgresOid(field, setOf(PostgresOid.bytea), "ByteArray")
        requirePostgresFormat(field, "ByteArray")
        bytes?.let { value ->
            when (field.format) {
                QueryFormat.Text -> decodePostgresBytea(value, field)
                QueryFormat.Binary -> value.copyOf()
                is QueryFormat.Other -> unsupportedPostgresFormat(field, "ByteArray")
            }
        }
    }

    public val uuidString: PostgresDecoder<String> = PostgresDecoder { bytes, field ->
        requirePostgresOid(field, setOf(PostgresOid.uuid), "UUID")
        requirePostgresFormat(field, "UUID")
        bytes?.let { value ->
            when (field.format) {
                QueryFormat.Text -> value.decodeUtf8Strict("PostgreSQL UUID value").also(::requireCanonicalUuid)
                QueryFormat.Binary -> binaryUuidString(value, field)
                is QueryFormat.Other -> unsupportedPostgresFormat(field, "UUID")
            }
        }
    }
}

public class QueryRow internal constructor(
    values: List<ByteArray?>,
    private val fields: List<QueryField>,
) {
    private val ownedValues: List<ByteArray?> = values.toList()

    public val values: List<ByteArray?> get() = ownedValues.map { it?.copyOf() }

    public fun raw(column: Int): ByteArray? {
        if (column !in ownedValues.indices) {
            throw OliphauntException("query row has no column at index $column")
        }
        return ownedValues[column]?.copyOf()
    }

    public fun raw(column: String): ByteArray? = raw(resolveColumn(column))

    public fun text(column: Int): String? = borrowedRaw(column)?.decodeUtf8Strict("query value")

    public fun text(column: String): String? = borrowedRaw(resolveColumn(column))?.decodeUtf8Strict("query value")

    public fun <T> value(
        column: Int,
        decoder: PostgresDecoder<T>,
    ): T? {
        if (column !in fields.indices) {
            throw OliphauntException("query row has no field metadata at index $column")
        }
        return decoder.decode(raw(column), fields[column])
    }

    public fun <T> value(
        column: String,
        decoder: PostgresDecoder<T>,
    ): T? = value(resolveColumn(column), decoder)

    private fun resolveColumn(name: String): Int {
        val matches = fields.indices.filter { fields[it].name == name }
        if (matches.isEmpty()) throw OliphauntException("query row has no column named '$name'")
        if (matches.size != 1) {
            throw OliphauntException("query row has multiple columns named '$name'; use a column index")
        }
        return matches.single()
    }

    private fun borrowedRaw(column: Int): ByteArray? {
        if (column !in ownedValues.indices) {
            throw OliphauntException("query row has no column at index $column")
        }
        return ownedValues[column]
    }

    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is QueryRow || fields != other.fields || ownedValues.size != other.ownedValues.size) return false
        return ownedValues.indices.all { index ->
            val left = ownedValues[index]
            val right = other.ownedValues[index]
            when {
                left == null && right == null -> true
                left == null || right == null -> false
                else -> left.contentEquals(right)
            }
        }
    }

    override fun hashCode(): Int = 31 * fields.hashCode() + ownedValues.fold(1) { acc, value ->
        31 * acc + (value?.contentHashCode() ?: 0)
    }
}

public data class PostgresErrorField(
    val code: Int,
    val value: String,
)

public data class PostgresDiagnostic(
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
    public val localizedSeverity: String? get() = fields.value('S'.code)
    public val nonlocalizedSeverity: String? get() = fields.value('V'.code)
    public val internalPosition: String? get() = fields.value('p'.code)
    public val internalQuery: String? get() = fields.value('q'.code)
    public val file: String? get() = fields.value('F'.code)
    public val line: String? get() = fields.value('L'.code)
    public val routine: String? get() = fields.value('R'.code)

    override fun toString(): String = when {
        severity != null && sqlstate != null -> "$severity [$sqlstate]: $message"
        severity != null -> "$severity: $message"
        sqlstate != null -> "[$sqlstate]: $message"
        else -> message
    }

    internal companion object {
        fun fromFields(
            fields: List<PostgresErrorField>,
            fallbackMessage: String,
        ): PostgresDiagnostic = PostgresDiagnostic(
            severity = fields.value('S'.code) ?: fields.value('V'.code),
            sqlstate = fields.value('C'.code),
            message = fields.value('M'.code) ?: fallbackMessage,
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
    }
}

public data class PostgresNotice(
    val diagnostic: PostgresDiagnostic,
) {
    public val severity: String? get() = diagnostic.severity
    public val localizedSeverity: String? get() = diagnostic.localizedSeverity
    public val nonlocalizedSeverity: String? get() = diagnostic.nonlocalizedSeverity
    public val sqlstate: String? get() = diagnostic.sqlstate
    public val message: String get() = diagnostic.message
    public val detail: String? get() = diagnostic.detail
    public val hint: String? get() = diagnostic.hint
    public val position: String? get() = diagnostic.position
    public val internalPosition: String? get() = diagnostic.internalPosition
    public val internalQuery: String? get() = diagnostic.internalQuery
    public val whereText: String? get() = diagnostic.whereText
    public val schemaName: String? get() = diagnostic.schemaName
    public val tableName: String? get() = diagnostic.tableName
    public val columnName: String? get() = diagnostic.columnName
    public val dataTypeName: String? get() = diagnostic.dataTypeName
    public val constraintName: String? get() = diagnostic.constraintName
    public val file: String? get() = diagnostic.file
    public val line: String? get() = diagnostic.line
    public val routine: String? get() = diagnostic.routine
    public val fields: List<PostgresErrorField> get() = diagnostic.fields

    override fun toString(): String = diagnostic.toString()
}

public data class PostgresError(
    val diagnostic: PostgresDiagnostic,
    val notices: List<PostgresNotice> = emptyList(),
) {
    public val severity: String? get() = diagnostic.severity
    public val localizedSeverity: String? get() = diagnostic.localizedSeverity
    public val nonlocalizedSeverity: String? get() = diagnostic.nonlocalizedSeverity
    public val sqlstate: String? get() = diagnostic.sqlstate
    public val message: String get() = diagnostic.message
    public val detail: String? get() = diagnostic.detail
    public val hint: String? get() = diagnostic.hint
    public val position: String? get() = diagnostic.position
    public val internalPosition: String? get() = diagnostic.internalPosition
    public val internalQuery: String? get() = diagnostic.internalQuery
    public val whereText: String? get() = diagnostic.whereText
    public val schemaName: String? get() = diagnostic.schemaName
    public val tableName: String? get() = diagnostic.tableName
    public val columnName: String? get() = diagnostic.columnName
    public val dataTypeName: String? get() = diagnostic.dataTypeName
    public val constraintName: String? get() = diagnostic.constraintName
    public val file: String? get() = diagnostic.file
    public val line: String? get() = diagnostic.line
    public val routine: String? get() = diagnostic.routine
    public val fields: List<PostgresErrorField> get() = diagnostic.fields

    override fun toString(): String = diagnostic.toString()

    public companion object {
        internal fun fromFields(
            fields: List<PostgresErrorField>,
            notices: List<PostgresNotice> = emptyList(),
        ): PostgresError = PostgresError(
            PostgresDiagnostic.fromFields(fields, "PostgreSQL ErrorResponse"),
            notices,
        )
    }
}

public data class QueryResult(
    val fields: List<QueryField>,
    val rows: List<QueryRow>,
    val commandTag: String?,
    val rowCount: Long?,
    val notices: List<PostgresNotice> = emptyList(),
) {
    internal var readyStatus: ReadyStatus = ReadyStatus.Idle

    public fun getText(
        row: Int,
        column: String,
    ): String? {
        if (row !in rows.indices) throw OliphauntException("query result has no row at index $row")
        return rows[row].text(column)
    }
}

public data class CommandResult(
    val commandTag: String?,
    val rowCount: Long?,
    val notices: List<PostgresNotice> = emptyList(),
) {
    internal var readyStatus: ReadyStatus = ReadyStatus.Idle
}

public sealed interface StatementResult {
    public data class Command(val result: CommandResult) : StatementResult

    public data class Rows(val result: QueryResult) : StatementResult
}

public data class ExecResult(
    val statements: List<StatementResult>,
    val notices: List<PostgresNotice> = emptyList(),
) {
    internal var readyStatus: ReadyStatus = ReadyStatus.Idle
}

public data class QueryDescription(
    val parameterTypes: List<PostgresOid>,
    val fields: List<QueryField>?,
    val notices: List<PostgresNotice> = emptyList(),
) {
    internal var readyStatus: ReadyStatus = ReadyStatus.Idle
}

internal enum class ReadyStatus {
    Idle,
    Transaction,
    FailedTransaction,
}

public suspend fun OliphauntDatabase.execute(
    sql: String,
    parameters: List<QueryParam> = emptyList(),
): CommandResult {
    rejectStructuredSql(sql)
    return runTypedOperation(extendedQueryProtocol(sql, parameters), null) { response ->
        parseCommandResponse(response, ExpectedProtocol.Extended).let { it to it.readyStatus }
    }
}

public suspend fun OliphauntDatabase.query(
    sql: String,
    parameters: List<QueryParam> = emptyList(),
): QueryResult {
    rejectStructuredSql(sql)
    return runTypedOperation(extendedQueryProtocol(sql, parameters), null) { response ->
        parseQueryResponse(response, ExpectedProtocol.Extended).let { it to it.readyStatus }
    }
}

public suspend fun OliphauntDatabase.exec(sql: String): ExecResult {
    rejectStructuredSql(sql)
    return runTypedOperation(simpleQueryProtocol(sql), null) { response ->
        parseExecResponse(response).let { it to it.readyStatus }
    }
}

public suspend fun OliphauntDatabase.describe(
    sql: String,
    parameterTypes: List<PostgresOid> = emptyList(),
): QueryDescription = runTypedOperation(describeQueryProtocol(sql, parameterTypes), null) { response ->
    parseDescribeResponse(response).let { it to it.readyStatus }
}

public suspend fun OliphauntTransaction.execute(
    sql: String,
    parameters: List<QueryParam> = emptyList(),
): CommandResult {
    rejectStructuredSql(sql, managedTransaction = true)
    return runTypedOperation(extendedQueryProtocol(sql, parameters)) { response ->
        parseCommandResponse(response, ExpectedProtocol.Extended).let { it to it.readyStatus }
    }
}

public suspend fun OliphauntTransaction.query(
    sql: String,
    parameters: List<QueryParam> = emptyList(),
): QueryResult {
    rejectStructuredSql(sql, managedTransaction = true)
    return runTypedOperation(extendedQueryProtocol(sql, parameters)) { response ->
        parseQueryResponse(response, ExpectedProtocol.Extended).let { it to it.readyStatus }
    }
}

public suspend fun OliphauntTransaction.exec(sql: String): ExecResult {
    rejectStructuredSql(sql, managedTransaction = true)
    return runTypedOperation(simpleQueryProtocol(sql)) { response ->
        parseExecResponse(response).let { it to it.readyStatus }
    }
}

public suspend fun OliphauntTransaction.describe(
    sql: String,
    parameterTypes: List<PostgresOid> = emptyList(),
): QueryDescription = runTypedOperation(describeQueryProtocol(sql, parameterTypes)) { response ->
    parseDescribeResponse(response).let { it to it.readyStatus }
}

internal fun extendedQueryProtocol(
    sql: String,
    parameters: List<QueryParam>,
): ByteArray {
    requireParameterCount(parameters.size, "extended query")
    requireSqlWithoutNul(sql, "extended query")
    parameters.forEachIndexed { index, parameter ->
        if (parameter.typeOid?.value == 0u) {
            throw OliphauntException(
                "extended query parameter ${index + 1} type OID must be a positive uint32; " +
                    "omit it to let PostgreSQL infer the type",
            )
        }
    }
    val packet = mutableListOf<Byte>()
    packet.addParse(sql, parameters.map { it.typeOid ?: PostgresOid(0u) })
    packet.addBind(parameters)
    packet.addDescribe('P')
    packet.addExecute()
    packet.addFrontendMessage('S'.code, ByteArray(0))
    return packet.toByteArray()
}

internal fun describeQueryProtocol(
    sql: String,
    parameterTypes: List<PostgresOid>,
): ByteArray {
    requireParameterCount(parameterTypes.size, "describe")
    requireSqlWithoutNul(sql, "describe")
    val packet = mutableListOf<Byte>()
    packet.addParse(sql, parameterTypes)
    packet.addDescribe('S')
    packet.addFrontendMessage('S'.code, ByteArray(0))
    return packet.toByteArray()
}

internal enum class ExpectedProtocol {
    Extended,
    Simple,
    Either,
}

private enum class SingleStatementPhase {
    Detect,
    Parse,
    Bind,
    Description,
    Rows,
    NoData,
    Complete,
}

private fun ExpectedProtocol.initialSingleStatementPhase(): SingleStatementPhase = when (this) {
    ExpectedProtocol.Extended -> SingleStatementPhase.Parse
    ExpectedProtocol.Simple, ExpectedProtocol.Either -> SingleStatementPhase.Detect
}

internal fun parseCommandResponse(
    bytes: ByteArray,
    expectedProtocol: ExpectedProtocol = ExpectedProtocol.Extended,
): CommandResult {
    var commandTag: String? = null
    var phase = expectedProtocol.initialSingleStatementPhase()
    val metadata = parseBackendResponse(
        bytes,
        "execute()",
        validate = { tag ->
            if (phase == SingleStatementPhase.Complete && tag !in postErrorTags) {
                throw OliphauntException("execute() received backend message after statement completion")
            }
        },
    ) { tag, body ->
        when (tag) {
            0x43 -> {
                val validCompletion = phase == SingleStatementPhase.NoData ||
                    (phase == SingleStatementPhase.Detect && expectedProtocol != ExpectedProtocol.Extended)
                if (!validCompletion) {
                    throw OliphauntException("execute() received CommandComplete before complete statement metadata")
                }
                commandTag = body.readCString("CommandComplete tag")
                body.requireEnd("CommandComplete")
                phase = SingleStatementPhase.Complete
            }

            0x54, 0x44 -> throw OliphauntException("execute() received rows; use query() for row results")

            in copyResponseTags -> unsupportedCopy("execute()")

            0x31 -> {
                val validParse = phase == SingleStatementPhase.Parse ||
                    (phase == SingleStatementPhase.Detect && expectedProtocol == ExpectedProtocol.Either)
                if (!validParse) throw OliphauntException("execute() received ParseComplete out of order")
                body.requireEnd("ParseComplete")
                phase = SingleStatementPhase.Bind
            }

            0x32 -> {
                if (phase != SingleStatementPhase.Bind) {
                    throw OliphauntException("execute() received BindComplete before ParseComplete")
                }
                body.requireEnd("BindComplete")
                phase = SingleStatementPhase.Description
            }

            0x33 -> throw OliphauntException("execute() received unsolicited CloseComplete")

            0x49 -> {
                val validCompletion = phase == SingleStatementPhase.NoData ||
                    (phase == SingleStatementPhase.Detect && expectedProtocol != ExpectedProtocol.Extended)
                if (!validCompletion) {
                    throw OliphauntException("execute() received EmptyQueryResponse before complete statement metadata")
                }
                body.requireEnd("EmptyQueryResponse")
                phase = SingleStatementPhase.Complete
            }

            0x6e -> {
                if (phase != SingleStatementPhase.Description) {
                    throw OliphauntException("execute() received NoData out of order")
                }
                body.requireEnd("NoData")
                phase = SingleStatementPhase.NoData
            }

            else -> unexpectedTag("execute()", tag)
        }
    }
    if (phase != SingleStatementPhase.Complete) {
        throw OliphauntException("execute response ended before statement completion")
    }
    return CommandResult(commandTag, commandTag?.commandTagRowCount(), metadata.notices).also {
        it.readyStatus = metadata.readyStatus
    }
}

internal fun parseQueryResponse(
    bytes: ByteArray,
    expectedProtocol: ExpectedProtocol = ExpectedProtocol.Extended,
): QueryResult {
    var fields: List<QueryField>? = null
    val rows = mutableListOf<QueryRow>()
    var commandTag: String? = null
    var phase = expectedProtocol.initialSingleStatementPhase()
    val metadata = parseBackendResponse(
        bytes,
        "query()",
        validate = { tag ->
            if (phase == SingleStatementPhase.Complete && tag !in postErrorTags) {
                throw OliphauntException("query() received backend message after statement completion")
            }
        },
    ) { tag, body ->
        when (tag) {
            0x54 -> {
                val validDescription = phase == SingleStatementPhase.Description ||
                    (phase == SingleStatementPhase.Detect && expectedProtocol != ExpectedProtocol.Extended)
                if (!validDescription) {
                    throw OliphauntException("query() received RowDescription out of order")
                }
                fields = parseRowDescription(body)
                body.requireEnd("RowDescription")
                phase = SingleStatementPhase.Rows
            }

            0x44 -> {
                if (phase != SingleStatementPhase.Rows) {
                    throw OliphauntException("DataRow arrived before RowDescription")
                }
                val activeFields = fields ?: throw OliphauntException("DataRow arrived before RowDescription")
                rows += parseDataRow(body, activeFields)
                body.requireEnd("DataRow")
            }

            0x43 -> {
                val validCompletion = phase == SingleStatementPhase.Rows ||
                    phase == SingleStatementPhase.NoData ||
                    (phase == SingleStatementPhase.Detect && expectedProtocol != ExpectedProtocol.Extended)
                if (!validCompletion) {
                    throw OliphauntException("query() received CommandComplete before complete statement metadata")
                }
                commandTag = body.readCString("CommandComplete tag")
                body.requireEnd("CommandComplete")
                phase = SingleStatementPhase.Complete
            }

            in copyResponseTags -> unsupportedCopy("query()")

            0x31 -> {
                val validParse = phase == SingleStatementPhase.Parse ||
                    (phase == SingleStatementPhase.Detect && expectedProtocol == ExpectedProtocol.Either)
                if (!validParse) throw OliphauntException("query() received ParseComplete out of order")
                body.requireEnd("ParseComplete")
                phase = SingleStatementPhase.Bind
            }

            0x32 -> {
                if (phase != SingleStatementPhase.Bind) {
                    throw OliphauntException("query() received BindComplete before ParseComplete")
                }
                body.requireEnd("BindComplete")
                phase = SingleStatementPhase.Description
            }

            0x33 -> throw OliphauntException("query() received unsolicited CloseComplete")

            0x49 -> {
                val validCompletion = phase == SingleStatementPhase.NoData ||
                    (phase == SingleStatementPhase.Detect && expectedProtocol != ExpectedProtocol.Extended)
                if (!validCompletion) {
                    throw OliphauntException("query() received EmptyQueryResponse before complete statement metadata")
                }
                body.requireEnd("EmptyQueryResponse")
                phase = SingleStatementPhase.Complete
            }

            0x6e -> {
                if (phase != SingleStatementPhase.Description) {
                    throw OliphauntException("query() received NoData out of order")
                }
                body.requireEnd("NoData")
                phase = SingleStatementPhase.NoData
            }

            else -> unexpectedTag("query()", tag)
        }
    }
    if (phase != SingleStatementPhase.Complete) {
        throw OliphauntException("query response ended before statement completion")
    }
    return QueryResult(
        fields.orEmpty(),
        rows,
        commandTag,
        commandTag?.commandTagRowCount(),
        metadata.notices,
    ).also { it.readyStatus = metadata.readyStatus }
}

internal fun parseExecResponse(bytes: ByteArray): ExecResult {
    var fields: List<QueryField>? = null
    val rows = mutableListOf<QueryRow>()
    val statementNotices = mutableListOf<PostgresNotice>()
    val statements = mutableListOf<StatementResult>()
    var sawCompletion = false
    val metadata = parseBackendResponse(
        bytes,
        "exec()",
        onNotice = statementNotices::add,
    ) { tag, body ->
        when (tag) {
            0x54 -> {
                if (fields != null || rows.isNotEmpty()) {
                    throw OliphauntException("exec() received a new result set before CommandComplete")
                }
                fields = parseRowDescription(body)
                body.requireEnd("RowDescription")
            }

            0x44 -> {
                val activeFields = fields ?: throw OliphauntException("DataRow arrived before RowDescription")
                rows += parseDataRow(body, activeFields)
                body.requireEnd("DataRow")
            }

            0x43 -> {
                val commandTag = body.readCString("CommandComplete tag")
                body.requireEnd("CommandComplete")
                val activeFields = fields
                statements += if (activeFields == null) {
                    StatementResult.Command(
                        CommandResult(commandTag, commandTag.commandTagRowCount(), statementNotices.toList()),
                    )
                } else {
                    StatementResult.Rows(
                        QueryResult(
                            activeFields,
                            rows.toList(),
                            commandTag,
                            commandTag.commandTagRowCount(),
                            statementNotices.toList(),
                        ),
                    )
                }
                fields = null
                rows.clear()
                statementNotices.clear()
                sawCompletion = true
            }

            0x49 -> {
                if (fields != null || rows.isNotEmpty()) {
                    throw OliphauntException("exec() received EmptyQueryResponse while a row result was pending")
                }
                body.requireEnd("EmptyQueryResponse")
                statementNotices.clear()
                sawCompletion = true
            }

            in copyResponseTags -> unsupportedCopy("exec()")

            0x31, 0x32, 0x33, 0x6e -> throw OliphauntException(
                "exec() received extended-protocol control message tag ${tag.hexBackendTag()}",
            )

            else -> unexpectedTag("exec()", tag)
        }
    }
    if (fields != null || rows.isNotEmpty()) throw OliphauntException("exec response ended before CommandComplete")
    if (!sawCompletion) throw OliphauntException("exec response ended before statement completion")
    return ExecResult(statements, metadata.notices).also { it.readyStatus = metadata.readyStatus }
}

internal fun parseDescribeResponse(bytes: ByteArray): QueryDescription {
    var parameterTypes: List<PostgresOid>? = null
    var fields: List<QueryField>? = null
    var sawParseComplete = false
    var sawDescription = false
    val metadata = parseBackendResponse(
        bytes,
        "describe()",
        validate = { tag ->
            if (sawDescription && tag !in postErrorTags) {
                throw OliphauntException("describe() received backend message after statement description")
            }
        },
    ) { tag, body ->
        when (tag) {
            0x31 -> {
                if (sawParseComplete || parameterTypes != null || sawDescription) {
                    throw OliphauntException("describe() received ParseComplete out of order")
                }
                body.requireEnd("ParseComplete")
                sawParseComplete = true
            }

            0x74 -> {
                if (!sawParseComplete) {
                    throw OliphauntException("describe() received ParameterDescription before ParseComplete")
                }
                if (parameterTypes != null) {
                    throw OliphauntException("describe() received multiple ParameterDescription messages")
                }
                val count = body.readShort("ParameterDescription count").toInt()
                if (count < 0) throw OliphauntException("invalid ParameterDescription count $count")
                parameterTypes = List(count) { PostgresOid(body.readUInt("parameter type oid")) }
                body.requireEnd("ParameterDescription")
            }

            0x54 -> {
                if (!sawParseComplete || parameterTypes == null) {
                    throw OliphauntException("describe() received RowDescription before statement metadata")
                }
                if (sawDescription) throw OliphauntException("describe() received multiple row descriptions")
                fields = parseRowDescription(body)
                body.requireEnd("RowDescription")
                sawDescription = true
            }

            0x6e -> {
                if (!sawParseComplete || parameterTypes == null) {
                    throw OliphauntException("describe() received NoData before statement metadata")
                }
                if (sawDescription) throw OliphauntException("describe() received both RowDescription and NoData")
                body.requireEnd("NoData")
                fields = null
                sawDescription = true
            }

            else -> unexpectedTag("describe()", tag)
        }
    }
    if (!sawParseComplete) throw OliphauntException("describe response did not include ParseComplete")
    val types = parameterTypes ?: throw OliphauntException("describe response did not include ParameterDescription")
    if (!sawDescription) throw OliphauntException("describe response did not include RowDescription or NoData")
    return QueryDescription(types, fields, metadata.notices).also { it.readyStatus = metadata.readyStatus }
}

internal fun inspectTerminalReadyStatus(bytes: ByteArray): ReadyStatus = decodeBackendFrames(bytes).lastOrNull().let { frame ->
    if (frame == null) throw OliphauntException("backend response ended before ReadyForQuery")
    if (frame.tag != 0x5a) throw OliphauntException("backend response ended before ReadyForQuery")
    parseReadyForQuery(ByteCursor(frame.body))
}

internal data class StructuredTransactionProtocolOutcome(
    val readyStatus: ReadyStatus,
    val lifecycleCommandTag: String?,
)

internal fun inspectStructuredTransactionProtocolOutcome(bytes: ByteArray): StructuredTransactionProtocolOutcome {
    val frames = decodeBackendFrames(bytes)
    val terminal = frames.lastOrNull()
        ?: throw OliphauntException("backend response ended before ReadyForQuery")
    if (terminal.tag != 0x5a) throw OliphauntException("backend response ended before ReadyForQuery")

    var lifecycleCommandTag: String? = null
    var readyCount = 0
    for (frame in frames) {
        if (frame.tag == 0x5a) readyCount++
        if (frame.tag != 0x43) continue
        val body = ByteCursor(frame.body)
        val commandTag = body.readCString("CommandComplete tag")
        body.requireEnd("CommandComplete")
        if (lifecycleCommandTag == null && commandTag in structuredTransactionLifecycleCommandTags) {
            lifecycleCommandTag = commandTag
        }
    }
    if (readyCount != 1) {
        throw OliphauntException("backend response must contain exactly one terminal ReadyForQuery")
    }
    return StructuredTransactionProtocolOutcome(
        readyStatus = parseReadyForQuery(ByteCursor(terminal.body)),
        lifecycleCommandTag = lifecycleCommandTag,
    )
}

private val structuredTransactionLifecycleCommandTags = setOf(
    "BEGIN",
    "START TRANSACTION",
    "COMMIT",
    "PREPARE TRANSACTION",
    "COMMIT PREPARED",
    "ROLLBACK PREPARED",
)

private data class BackendFrame(val tag: Int, val body: ByteArray)

private data class ResponseMetadata(
    val readyStatus: ReadyStatus,
    val notices: List<PostgresNotice>,
)

private fun parseBackendResponse(
    bytes: ByteArray,
    operation: String,
    validate: (Int) -> Unit = {},
    onNotice: (PostgresNotice) -> Unit = {},
    handle: (Int, ByteCursor) -> Unit,
): ResponseMetadata {
    val frames = decodeBackendFrames(bytes)
    val notices = mutableListOf<PostgresNotice>()
    var postgresError: PostgresError? = null
    var readyStatus: ReadyStatus? = null

    for (frame in frames) {
        validate(frame.tag)
        if (postgresError != null && frame.tag !in postErrorTags) {
            throw OliphauntException(
                "$operation received backend message tag ${frame.tag.hexBackendTag()} after ErrorResponse",
            )
        }
        val body = ByteCursor(frame.body)
        when (frame.tag) {
            0x45 -> if (postgresError == null) postgresError = PostgresError.fromFields(parseDiagnosticFields(body, "ErrorResponse"))

            0x4e -> {
                val notice = PostgresNotice(
                    PostgresDiagnostic.fromFields(
                        parseDiagnosticFields(body, "NoticeResponse"),
                        "PostgreSQL NoticeResponse",
                    ),
                )
                notices += notice
                onNotice(notice)
            }

            0x53 -> validateParameterStatus(body)

            0x41 -> validateNotificationResponse(body)

            0x5a -> readyStatus = parseReadyForQuery(body)

            else -> handle(frame.tag, body)
        }
    }

    val terminalStatus = readyStatus ?: throw OliphauntException("backend response ended before ReadyForQuery")
    postgresError?.let { throw PostgresException(it.copy(notices = notices.toList())) }
    return ResponseMetadata(terminalStatus, notices)
}

private fun decodeBackendFrames(bytes: ByteArray): List<BackendFrame> {
    val cursor = ByteCursor(bytes)
    val frames = mutableListOf<BackendFrame>()
    var sawReady = false
    while (!cursor.isAtEnd) {
        if (sawReady) throw OliphauntException("backend returned bytes after ReadyForQuery")
        val tag = cursor.readUByte("backend message tag").toInt()
        val length = cursor.readInt("backend message length")
        if (length < 4) throw OliphauntException("invalid backend message length $length")
        val body = cursor.readBytes(length - 4, "backend message body")
        frames += BackendFrame(tag, body)
        if (tag == 0x5a) {
            parseReadyForQuery(ByteCursor(body))
            sawReady = true
        }
    }
    return frames
}

private fun parseRowDescription(cursor: ByteCursor): List<QueryField> {
    val count = cursor.readShort("RowDescription field count").toInt()
    if (count < 0) throw OliphauntException("invalid RowDescription field count $count")
    return List(count) {
        QueryField(
            name = cursor.readCString("field name"),
            tableOid = cursor.readUInt("field table oid"),
            tableAttribute = cursor.readShort("field table attribute"),
            typeOid = PostgresOid(cursor.readUInt("field type oid")),
            typeSize = cursor.readShort("field type size"),
            typeModifier = cursor.readInt("field type modifier"),
            format = QueryFormat.fromCode(cursor.readShort("field format").toInt()),
        )
    }
}

private fun parseDataRow(
    cursor: ByteCursor,
    fields: List<QueryField>,
): QueryRow {
    val count = cursor.readShort("DataRow column count").toInt()
    if (count < 0) throw OliphauntException("invalid DataRow column count $count")
    if (count != fields.size) {
        throw OliphauntException("DataRow column count $count does not match RowDescription count ${fields.size}")
    }
    val values = List(count) {
        val length = cursor.readInt("DataRow value length")
        when {
            length == -1 -> null
            length < 0 -> throw OliphauntException("invalid DataRow value length $length")
            else -> cursor.readBytes(length, "DataRow value")
        }
    }
    return QueryRow(values, fields)
}

private fun parseDiagnosticFields(
    cursor: ByteCursor,
    label: String,
): List<PostgresErrorField> {
    val fields = mutableListOf<PostgresErrorField>()
    while (true) {
        if (cursor.isAtEnd) throw OliphauntException("$label is missing terminator")
        val code = cursor.readUByte("$label field code").toInt()
        if (code == 0) {
            cursor.requireEnd(label)
            return fields
        }
        fields += PostgresErrorField(code, cursor.readCString("$label field"))
    }
}

private fun List<PostgresErrorField>.value(code: Int): String? = firstOrNull { it.code == code }?.value

private fun parseReadyForQuery(cursor: ByteCursor): ReadyStatus {
    if (cursor.remainingBytes() != 1) {
        throw OliphauntException("ReadyForQuery contained ${cursor.remainingBytes()} bytes, expected 1")
    }
    return when (val status = cursor.readUByte("ReadyForQuery transaction status").toInt()) {
        'I'.code -> ReadyStatus.Idle
        'T'.code -> ReadyStatus.Transaction
        'E'.code -> ReadyStatus.FailedTransaction
        else -> throw OliphauntException("ReadyForQuery contained invalid transaction status ${status.hexBackendTag()}")
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

private fun String.commandTagRowCount(): Long? {
    val parts = trim().split(Regex("\\s+")).filter(String::isNotEmpty)
    if (parts.isEmpty() || parts.first().uppercase() !in rowCountCommands) return null
    return parts.last().toLongOrNull()?.takeIf { it >= 0 }
}

private fun requirePostgresOid(
    field: QueryField,
    allowed: Set<PostgresOid>,
    target: String,
) {
    if (field.typeOid !in allowed) {
        throw OliphauntException(
            "cannot decode PostgreSQL type OID ${field.typeOid.value} as $target for column '${field.name}'",
        )
    }
}

private fun requirePostgresFormat(
    field: QueryField,
    target: String,
) {
    if (field.format is QueryFormat.Other) unsupportedPostgresFormat(field, target)
}

private fun invalidPostgresValue(
    field: QueryField,
    target: String,
): Nothing = throw OliphauntException(
    "invalid PostgreSQL value for $target in column '${field.name}' " +
        "(type OID ${field.typeOid.value}, format ${field.format})",
)

private fun unsupportedPostgresFormat(
    field: QueryField,
    target: String,
): Nothing = throw OliphauntException(
    "cannot decode PostgreSQL format ${field.format} as $target for column '${field.name}' " +
        "(type OID ${field.typeOid.value})",
)

private fun <T> fixedIntegerDecoder(
    oid: PostgresOid,
    byteCount: Int,
    target: String,
    parseText: (String) -> T?,
    parseBinary: (ULong) -> T,
): PostgresDecoder<T> = PostgresDecoder { bytes, field ->
    requirePostgresOid(field, setOf(oid), target)
    requirePostgresFormat(field, target)
    bytes?.let { value ->
        when (field.format) {
            QueryFormat.Text -> parseText(value.decodeUtf8Strict("PostgreSQL $target value"))
                ?: invalidPostgresValue(field, target)

            QueryFormat.Binary -> parseBinary(postgresUnsigned(value, byteCount, field, target))

            is QueryFormat.Other -> unsupportedPostgresFormat(field, target)
        }
    }
}

private fun postgresUnsigned(
    bytes: ByteArray,
    count: Int,
    field: QueryField,
    target: String,
): ULong {
    if (bytes.size != count) invalidPostgresValue(field, target)
    return bytes.fold(0uL) { value, byte -> (value shl 8) or byte.toUByte().toULong() }
}

private fun decodePostgresBytea(
    bytes: ByteArray,
    field: QueryField,
): ByteArray {
    if (bytes.size >= 2 && bytes[0] == '\\'.code.toByte() && bytes[1] == 'x'.code.toByte()) {
        val hex = bytes.copyOfRange(2, bytes.size)
        if (hex.size % 2 != 0) invalidPostgresValue(field, "ByteArray")
        return ByteArray(hex.size / 2) { index ->
            val high = hexNibble(hex[index * 2]) ?: invalidPostgresValue(field, "ByteArray")
            val low = hexNibble(hex[index * 2 + 1]) ?: invalidPostgresValue(field, "ByteArray")
            ((high shl 4) or low).toByte()
        }
    }

    val output = mutableListOf<Byte>()
    var index = 0
    while (index < bytes.size) {
        if (bytes[index] != '\\'.code.toByte()) {
            output += bytes[index++]
            continue
        }
        if (index + 1 >= bytes.size) invalidPostgresValue(field, "ByteArray")
        if (bytes[index + 1] == '\\'.code.toByte()) {
            output += '\\'.code.toByte()
            index += 2
            continue
        }
        if (index + 3 >= bytes.size) invalidPostgresValue(field, "ByteArray")
        val first = firstOctalDigit(bytes[index + 1]) ?: invalidPostgresValue(field, "ByteArray")
        val second = octalDigit(bytes[index + 2]) ?: invalidPostgresValue(field, "ByteArray")
        val third = octalDigit(bytes[index + 3]) ?: invalidPostgresValue(field, "ByteArray")
        output += ((first shl 6) or (second shl 3) or third).toByte()
        index += 4
    }
    return output.toByteArray()
}

private fun hexNibble(byte: Byte): Int? = when (byte.toInt().toChar()) {
    in '0'..'9' -> byte - '0'.code.toByte()
    in 'A'..'F' -> byte - 'A'.code.toByte() + 10
    in 'a'..'f' -> byte - 'a'.code.toByte() + 10
    else -> null
}

private fun octalDigit(byte: Byte): Int? = byte.toInt().toChar().takeIf { it in '0'..'7' }?.digitToInt()

private fun firstOctalDigit(byte: Byte): Int? = byte.toInt().toChar().takeIf { it in '0'..'3' }?.digitToInt()

private fun requireCanonicalUuid(value: String) {
    if (!uuidPattern.matches(value)) throw OliphauntException("invalid PostgreSQL UUID value")
}

private fun binaryUuidString(
    bytes: ByteArray,
    field: QueryField,
): String {
    if (bytes.size != 16) invalidPostgresValue(field, "UUID")
    val hex = bytes.joinToString("") { it.toUByte().toString(16).padStart(2, '0') }
    return listOf(hex.substring(0, 8), hex.substring(8, 12), hex.substring(12, 16), hex.substring(16, 20), hex.substring(20))
        .joinToString("-")
}

internal fun containsTopLevelCopy(sql: String): Boolean = structuredSqlFacts(sql).containsTopLevelCopy

internal fun containsTransactionChain(sql: String): Boolean = structuredSqlFacts(sql).containsTransactionChain

private data class StructuredSqlFacts(
    val containsTopLevelCopy: Boolean = false,
    val containsTransactionChain: Boolean = false,
) {
    fun union(other: StructuredSqlFacts): StructuredSqlFacts = StructuredSqlFacts(
        containsTopLevelCopy || other.containsTopLevelCopy,
        containsTransactionChain || other.containsTransactionChain,
    )
}

private enum class TransactionChainState {
    None,
    AfterRollback,
    AfterOptionalKind,
    AfterAnd,
}

private fun structuredSqlFacts(sql: String): StructuredSqlFacts = scanStructuredSql(sql, plainStringBackslashEscapes = false)
    .union(scanStructuredSql(sql, plainStringBackslashEscapes = true))

private fun scanStructuredSql(
    sql: String,
    plainStringBackslashEscapes: Boolean,
): StructuredSqlFacts {
    var index = 0
    var statementStart = true
    var chainState = TransactionChainState.None
    var containsTopLevelCopy = false
    var containsTransactionChain = false
    while (index < sql.length) {
        val character = sql[index]
        when {
            character.isWhitespace() -> index++

            character == ';' -> {
                statementStart = true
                chainState = TransactionChainState.None
                index++
            }

            sql.startsWith("--", index) -> {
                index = sql.indexOfAny(charArrayOf('\r', '\n'), index + 2).takeIf { it >= 0 } ?: sql.length
            }

            sql.startsWith("/*", index) -> index = skipNestedBlockComment(sql, index)

            character == '\'' -> {
                statementStart = false
                chainState = TransactionChainState.None
                index = skipQuoted(
                    sql,
                    index,
                    '\'',
                    backslashEscapes = plainStringBackslashEscapes || precedingEscapePrefix(sql, index),
                )
            }

            character == '"' -> {
                statementStart = false
                chainState = TransactionChainState.None
                index = skipQuoted(sql, index, '"', backslashEscapes = false)
            }

            character == '$' -> {
                val delimiter = dollarQuoteDelimiter(sql, index)
                if (delimiter == null) {
                    statementStart = false
                    chainState = TransactionChainState.None
                    index++
                } else {
                    statementStart = false
                    chainState = TransactionChainState.None
                    val end = sql.indexOf(delimiter, index + delimiter.length)
                    index = if (end < 0) sql.length else end + delimiter.length
                }
            }

            isPostgresIdentifierStart(character) -> {
                val start = index
                index++
                while (index < sql.length && isPostgresIdentifierContinuation(sql[index])) {
                    index++
                }
                val token = sql.substring(start, index)
                if (statementStart) {
                    if (token.equals("COPY", ignoreCase = true)) containsTopLevelCopy = true
                    chainState = if (
                        token.equals("ROLLBACK", ignoreCase = true) || token.equals("ABORT", ignoreCase = true)
                    ) {
                        TransactionChainState.AfterRollback
                    } else {
                        TransactionChainState.None
                    }
                } else {
                    chainState = when (chainState) {
                        TransactionChainState.None -> TransactionChainState.None

                        TransactionChainState.AfterRollback -> when {
                            token.equals("WORK", ignoreCase = true) ||
                                token.equals("TRANSACTION", ignoreCase = true) -> TransactionChainState.AfterOptionalKind

                            token.equals("AND", ignoreCase = true) -> TransactionChainState.AfterAnd

                            else -> TransactionChainState.None
                        }

                        TransactionChainState.AfterOptionalKind -> if (token.equals("AND", ignoreCase = true)) {
                            TransactionChainState.AfterAnd
                        } else {
                            TransactionChainState.None
                        }

                        TransactionChainState.AfterAnd -> {
                            if (token.equals("CHAIN", ignoreCase = true)) containsTransactionChain = true
                            TransactionChainState.None
                        }
                    }
                }
                statementStart = false
            }

            else -> {
                statementStart = false
                chainState = TransactionChainState.None
                index++
            }
        }
    }
    return StructuredSqlFacts(containsTopLevelCopy, containsTransactionChain)
}

private fun rejectStructuredSql(
    sql: String,
    managedTransaction: Boolean = false,
) {
    val facts = structuredSqlFacts(sql)
    if (facts.containsTopLevelCopy) {
        throw OliphauntException(
            "structured SQL does not support COPY because it requires streaming protocol ownership; " +
                "use execProtocolRaw or execProtocolRawStream",
        )
    }
    if (managedTransaction && facts.containsTransactionChain) {
        throw OliphauntException(
            "managed transactions do not support ROLLBACK or ABORT AND CHAIN; " +
                "return from or throw inside the transaction callback instead",
        )
    }
}

private fun skipNestedBlockComment(
    sql: String,
    start: Int,
): Int {
    var index = start + 2
    var depth = 1
    while (index < sql.length && depth > 0) {
        when {
            sql.startsWith("/*", index) -> {
                depth++
                index += 2
            }

            sql.startsWith("*/", index) -> {
                depth--
                index += 2
            }

            else -> index++
        }
    }
    return index
}

private fun skipQuoted(
    sql: String,
    start: Int,
    quote: Char,
    backslashEscapes: Boolean,
): Int {
    var index = start + 1
    while (index < sql.length) {
        if (backslashEscapes && sql[index] == '\\' && index + 1 < sql.length) {
            index += 2
        } else if (sql[index] == quote) {
            if (index + 1 < sql.length && sql[index + 1] == quote) {
                index += 2
            } else {
                return index + 1
            }
        } else {
            index++
        }
    }
    return sql.length
}

private fun precedingEscapePrefix(
    sql: String,
    quoteIndex: Int,
): Boolean = quoteIndex > 0 && sql[quoteIndex - 1].equals('E', ignoreCase = true) &&
    (quoteIndex < 2 || !isPostgresIdentifierContinuation(sql[quoteIndex - 2]))

private fun dollarQuoteDelimiter(
    sql: String,
    start: Int,
): String? {
    var index = start + 1
    if (index < sql.length && sql[index] == '$') return "$$"
    if (index >= sql.length || !isPostgresIdentifierStart(sql[index])) return null
    index++
    while (index < sql.length && sql[index] != '$' && isPostgresIdentifierContinuation(sql[index])) index++
    return if (index < sql.length && sql[index] == '$') sql.substring(start, index + 1) else null
}

private fun isPostgresIdentifierStart(character: Char): Boolean = character == '_' || character in 'A'..'Z' || character in 'a'..'z' || character.code >= 0x80

private fun isPostgresIdentifierContinuation(character: Char): Boolean = isPostgresIdentifierStart(character) || character in '0'..'9' || character == '$'

private class ByteCursor(
    private val bytes: ByteArray,
) {
    private var offset = 0

    val isAtEnd: Boolean get() = offset == bytes.size

    fun remainingBytes(): Int = bytes.size - offset

    fun requireEnd(label: String) {
        if (!isAtEnd) throw OliphauntException("$label contained trailing bytes")
    }

    fun readUByte(label: String): UByte = readBytes(1, label)[0].toUByte()

    fun readUInt(label: String): UInt = (readUByte(label).toUInt() shl 24) or
        (readUByte(label).toUInt() shl 16) or
        (readUByte(label).toUInt() shl 8) or
        readUByte(label).toUInt()

    fun readInt(label: String): Int = readUInt(label).toInt()

    fun readShort(label: String): Short = ((readUByte(label).toInt() shl 8) or readUByte(label).toInt()).toShort()

    fun readCString(label: String): String {
        val end = bytes.indexOf(0, startIndex = offset)
        if (end < 0) throw OliphauntException("$label is missing null terminator")
        val raw = bytes.copyOfRange(offset, end)
        offset = end + 1
        return raw.decodeUtf8Strict(label)
    }

    fun readBytes(
        count: Int,
        label: String,
    ): ByteArray {
        if (count < 0 || offset + count > bytes.size) throw OliphauntException("truncated $label")
        return bytes.copyOfRange(offset, offset + count).also { offset += count }
    }
}

private fun ByteArray.indexOf(
    byte: Byte,
    startIndex: Int,
): Int {
    for (index in startIndex until size) if (this[index] == byte) return index
    return -1
}

private fun MutableList<Byte>.addParse(
    sql: String,
    parameterTypes: List<PostgresOid>,
) {
    val body = mutableListOf<Byte>()
    body.addCString("")
    body.addCString(sql)
    body.addInt16(parameterTypes.size)
    parameterTypes.forEach { body.addUInt32(it.value) }
    addFrontendMessage('P'.code, body.toByteArray())
}

private fun MutableList<Byte>.addBind(parameters: List<QueryParam>) {
    val body = mutableListOf<Byte>()
    body.addCString("")
    body.addCString("")
    body.addInt16(parameters.size)
    parameters.forEach { body.addInt16(if (it.format == ValueFormat.Binary) 1 else 0) }
    body.addInt16(parameters.size)
    parameters.forEach { parameter ->
        parameter.encodedBytes?.let(body::addSizedValue) ?: body.addInt32(-1)
    }
    body.addInt16(1)
    body.addInt16(0)
    addFrontendMessage('B'.code, body.toByteArray())
}

private fun MutableList<Byte>.addDescribe(kind: Char) {
    val body = mutableListOf(kind.code.toByte())
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
    if (value.any { it.code == 0 }) throw OliphauntException("frontend protocol string must not contain NUL bytes")
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

private fun MutableList<Byte>.addInt32(value: Int) = addUInt32(value.toUInt())

private fun MutableList<Byte>.addInt16(value: Int) {
    val bits = value and 0xffff
    add(((bits ushr 8) and 0xff).toByte())
    add((bits and 0xff).toByte())
}

private fun requireParameterCount(
    count: Int,
    operation: String,
) {
    if (count > Short.MAX_VALUE.toInt()) {
        throw OliphauntException("$operation supports at most ${Short.MAX_VALUE} parameters, got $count")
    }
}

private fun requireSqlWithoutNul(
    sql: String,
    operation: String,
) {
    if (sql.any { it.code == 0 }) throw OliphauntException("$operation SQL must not contain NUL bytes")
}

private fun unsupportedCopy(operation: String): Nothing = throw OliphauntException(
    "$operation does not support COPY protocol responses; use execProtocolRaw or execProtocolRawStream for COPY traffic",
)

private fun unexpectedTag(
    operation: String,
    tag: Int,
): Nothing = throw OliphauntException("$operation received unexpected backend message tag ${tag.hexBackendTag()}")

private fun Int.hexBackendTag(): String = "0x" + toString(16).padStart(2, '0')

private fun ByteArray.decodeUtf8Strict(label: String): String = try {
    decodeToString(throwOnInvalidSequence = true)
} catch (error: Exception) {
    throw OliphauntException("$label is not valid UTF-8${error.message?.let { ": $it" }.orEmpty()}")
}

private val copyResponseTags = setOf(0x47, 0x48, 0x57, 0x64, 0x63)
private val postErrorTags = setOf(0x4e, 0x53, 0x41, 0x5a)
private val rowCountCommands = setOf("SELECT", "INSERT", "UPDATE", "DELETE", "MERGE", "MOVE", "FETCH", "COPY")
private val uuidPattern = Regex("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")
