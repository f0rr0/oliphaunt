package dev.oliphaunt

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.nio.file.Files
import java.nio.file.Path
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class SharedProtocolFixtureTest {
    @Test
    fun queryParserMatchesSharedProtocolFixtures() {
        val path = sharedProtocolFixturePath() ?: return
        val corpus = Json.parseToJsonElement(Files.readString(path)).jsonObject
        assertEquals(1, corpus.requiredInt("schemaVersion"))
        assertEquals("postgres-backend-query-response", corpus.requiredString("kind"))

        val names = mutableSetOf<String>()
        for (fixture in parseFixtures(corpus.requiredArray("cases"))) {
            assertTrue(names.add(fixture.name), "duplicate shared protocol fixture ${fixture.name}")
            val expectation = fixture.queryExpectation ?: continue
            val bytes = hexToBytes(fixture.responseHex)
            when {
                expectation.ok != null -> {
                    assertOkFixture(fixture, expectation.ok, bytes)
                }

                expectation.postgresError != null -> {
                    assertPostgresErrorFixture(
                        fixture,
                        expectation.postgresError,
                        bytes,
                    )
                }

                expectation.engineErrorContains != null -> {
                    assertEngineErrorFixture(
                        fixture,
                        expectation.engineErrorContains,
                        bytes,
                    )
                }

                else -> {
                    error("shared protocol fixture ${fixture.name} has no query expectation")
                }
            }
        }
    }

    private fun assertOkFixture(
        fixture: SharedProtocolFixture,
        expected: SharedProtocolOkExpectation,
        bytes: ByteArray,
    ) {
        val result = parseQueryResponse(bytes)
        assertEquals(expected.rowCount, result.rowCount, "${fixture.name} row count")
        assertEquals(expected.commandTag, result.commandTag, "${fixture.name} command tag")
        assertEquals(expected.fields.size, result.fields.size, "${fixture.name} field count")
        assertEquals(expected.rows.size, result.rows.size, "${fixture.name} rows size")

        expected.fields.forEachIndexed { index, expectedField ->
            val actual = result.fields[index]
            assertEquals(expectedField.name, actual.name, "${fixture.name} field name")
            assertEquals(expectedField.typeOid, actual.typeOid, "${fixture.name} type OID")
            if (expectedField.format == "text") {
                assertEquals(QueryFormat.Text, actual.format, "${fixture.name} field format")
            }
        }

        expected.rows.forEachIndexed { rowIndex, row ->
            assertEquals(expected.fields.size, row.size, "${fixture.name} expected row width")
            row.forEachIndexed { columnIndex, expectedValue ->
                val field = expected.fields[columnIndex]
                assertEquals(
                    expectedValue,
                    result.getText(rowIndex, field.name),
                    "${fixture.name} row $rowIndex column ${field.name}",
                )
            }
        }
    }

    private fun assertPostgresErrorFixture(
        fixture: SharedProtocolFixture,
        expected: SharedProtocolPostgresErrorExpectation,
        bytes: ByteArray,
    ) {
        val error =
            assertFailsWith<PostgresException>("${fixture.name} should fail") {
                parseQueryResponse(bytes)
            }.postgresError
        assertEquals(expected.severity, error.severity, "${fixture.name} severity")
        assertEquals(expected.sqlstate, error.sqlstate, "${fixture.name} SQLSTATE")
        assertEquals(expected.message, error.message, "${fixture.name} message")
    }

    private fun assertEngineErrorFixture(
        fixture: SharedProtocolFixture,
        expected: String,
        bytes: ByteArray,
    ) {
        val error =
            assertFailsWith<OliphauntException>("${fixture.name} should fail") {
                parseQueryResponse(bytes)
            }
        assertTrue(
            error.message.orEmpty().contains(expected),
            "${fixture.name} error ${error.message} did not contain $expected",
        )
    }
}

private fun sharedProtocolFixturePath(): Path? {
    val configured =
        System
            .getProperty("oliphaunt.sharedFixturesDir")
            ?.takeIf(String::isNotBlank)
            ?.let { Path.of(it, "protocol", "query-response-cases.json") }
    val cwdCandidate =
        Path
            .of("")
            .toAbsolutePath()
            .resolve("../../shared/fixtures/protocol/query-response-cases.json")
            .normalize()
    return listOfNotNull(configured, cwdCandidate).firstOrNull(Files::isRegularFile)
}

private fun parseFixtures(cases: JsonArray): List<SharedProtocolFixture> = cases.map { element ->
    val obj = element.jsonObject
    SharedProtocolFixture(
        name = obj.requiredString("name"),
        responseHex = obj.requiredString("responseHex"),
        queryExpectation = obj["queryExpectation"]?.jsonObject?.let(::parseQueryExpectation),
    )
}

private fun parseQueryExpectation(obj: JsonObject): SharedProtocolQueryExpectation = SharedProtocolQueryExpectation(
    ok = obj["ok"]?.jsonObject?.let(::parseOkExpectation),
    postgresError = obj["postgresError"]?.jsonObject?.let(::parsePostgresErrorExpectation),
    engineErrorContains = obj["engineErrorContains"]?.jsonPrimitive?.contentOrNull,
)

private fun parseOkExpectation(obj: JsonObject): SharedProtocolOkExpectation = SharedProtocolOkExpectation(
    fields =
    obj.requiredArray("fields").map { field ->
        val fieldObject = field.jsonObject
        SharedProtocolFieldExpectation(
            name = fieldObject.requiredString("name"),
            typeOid = fieldObject.requiredInt("typeOid").toUInt(),
            format = fieldObject["format"]?.jsonPrimitive?.contentOrNull,
        )
    },
    rows =
    obj.requiredArray("rows").map { row ->
        row.jsonArray.map { cell ->
            if (cell is JsonNull) null else cell.jsonPrimitive.content
        }
    },
    commandTag = obj["commandTag"]?.jsonPrimitive?.contentOrNull,
    rowCount = obj.requiredInt("rowCount"),
)

private fun parsePostgresErrorExpectation(obj: JsonObject): SharedProtocolPostgresErrorExpectation = SharedProtocolPostgresErrorExpectation(
    severity = obj.requiredString("severity"),
    sqlstate = obj.requiredString("sqlstate"),
    message = obj.requiredString("message"),
)

private fun JsonObject.requiredArray(name: String): JsonArray = this[name]?.jsonArray ?: error("missing shared protocol fixture array $name")

private fun JsonObject.requiredInt(name: String): Int = this[name]?.jsonPrimitive?.int ?: error("missing shared protocol fixture integer $name")

private fun JsonObject.requiredString(name: String): String = this[name]?.jsonPrimitive?.content ?: error("missing shared protocol fixture string $name")

private fun hexToBytes(hex: String): ByteArray {
    val compact = hex.filterNot(Char::isWhitespace)
    require(compact.length % 2 == 0) { "hex fixture must have an even digit count" }
    return ByteArray(compact.length / 2) { index ->
        compact.substring(index * 2, index * 2 + 2).toInt(16).toByte()
    }
}

private data class SharedProtocolFixture(
    val name: String,
    val responseHex: String,
    val queryExpectation: SharedProtocolQueryExpectation?,
)

private data class SharedProtocolQueryExpectation(
    val ok: SharedProtocolOkExpectation?,
    val postgresError: SharedProtocolPostgresErrorExpectation?,
    val engineErrorContains: String?,
)

private data class SharedProtocolOkExpectation(
    val fields: List<SharedProtocolFieldExpectation>,
    val rows: List<List<String?>>,
    val commandTag: String?,
    val rowCount: Int,
)

private data class SharedProtocolFieldExpectation(
    val name: String,
    val typeOid: UInt,
    val format: String?,
)

private data class SharedProtocolPostgresErrorExpectation(
    val severity: String,
    val sqlstate: String,
    val message: String,
)
