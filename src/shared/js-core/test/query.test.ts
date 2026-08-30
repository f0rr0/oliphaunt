import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";

import {
  PostgresError,
  array,
  binary,
  containsTopLevelCopy,
  containsTransactionChain,
  decodeQueryResult,
  describeQuery,
  inspectManagedTransactionResponse,
  inspectReadyForQuery,
  json,
  parseDescribeResponse,
  parseExecResponse,
  parseQueryRawResponse,
  planQuery,
  postgresOids,
  responseTransactionStatus,
  text,
  typedNull,
} from "../src/query.js";

test("parameter plans infer OIDs without exposing mutable values across the await", () => {
  const value = { stable: 1 };
  const plan = planQuery("SELECT $1::jsonb", [value]);
  assert.equal(plan.kind, "describe");
  value.stable = 2;
  if (plan.kind !== "describe") throw new Error("expected describe plan");
  const bind = frontendMessages(plan.bind([postgresOids.jsonb]));
  assert.deepEqual(
    bind.map((message) => message.tag),
    ["P", "B", "D", "E", "S"],
  );
  assert.match(new TextDecoder().decode(bind[1]!.body), /"stable":1/);

  assert.throws(
    () => plan.bind([postgresOids.text]),
    /cannot safely encode object/,
  );
  assert.throws(
    () => planQuery("SELECT $1", [undefined as never]),
    /must not be undefined/,
  );
});

test("typed helpers make a one-exchange OID-aware plan", () => {
  const plan = planQuery("SELECT $1, $2, $3, $4, $5", [
    json({ ok: true }),
    array([1, null, 2], postgresOids.int4Array),
    text("550e8400-e29b-41d4-a716-446655440000", postgresOids.uuid),
    binary(Uint8Array.of(0, 255), postgresOids.bytea),
    typedNull(postgresOids.int8),
  ]);
  assert.equal(plan.kind, "complete");
  if (plan.kind !== "complete") throw new Error("expected complete plan");
  const messages = frontendMessages(plan.input);
  assert.deepEqual(
    messages.map((message) => message.tag),
    ["P", "B", "D", "E", "S"],
  );
  assert.deepEqual(readParseTypeOids(messages[0]!.body), [
    postgresOids.jsonb,
    postgresOids.int4Array,
    postgresOids.uuid,
    postgresOids.bytea,
    postgresOids.int8,
  ]);
  assert.equal(Object.isFrozen(postgresOids), true);
});

test("sparse parameter and PostgreSQL arrays reject their undefined holes", () => {
  assert.throws(
    () => planQuery("SELECT $1", Array(1)),
    /query parameters must not be undefined/,
  );
  assert.throws(
    () => array(Array(1), postgresOids.textArray),
    /PostgreSQL arrays cannot contain undefined/,
  );
  assert.throws(
    () => planQuery("SELECT $1", [Array(1)]),
    /query parameters must not be undefined/,
  );
});

test("array helpers reject explicit element OID mismatches", () => {
  for (const value of [
    text("1", postgresOids.int4),
    typedNull(postgresOids.int4),
    binary(Uint8Array.of(1), postgresOids.bytea),
  ]) {
    assert.throws(
      () => array([value], postgresOids.textArray),
      /array element declares PostgreSQL OID .* resolves element OID/,
    );
  }

  assert.equal(array([text("raw")], postgresOids.textArray).value, '{"raw"}');
  assert.equal(
    array([binary(Uint8Array.of(0xff))], postgresOids.byteaArray).value,
    '{"\\\\xff"}',
  );
});

test("decoded rows reject ambiguous object fields and preserve them in array mode", () => {
  const response = queryResponse(
    [
      field("__proto__", postgresOids.text),
      field("constructor", postgresOids.int4),
      field("constructor", postgresOids.int8),
      field("payload", postgresOids.jsonb),
      field("bytes", postgresOids.bytea),
      field("dates", postgresOids.dateArray),
    ],
    [
      [
        "safe",
        "7",
        "9007199254740993",
        '{"ok":true}',
        "\\x00ff",
        "{2026-01-01,NULL}",
      ],
    ],
    "SELECT 1",
  );
  const raw = parseQueryRawResponse(response);
  assert.throws(() => raw.getText(0, "constructor"), /more than one column/);
  assert.throws(
    () => decodeQueryResult(raw),
    /cannot represent more than one column named "constructor"; use \{ rowMode: 'array' \}/,
  );

  const custom = decodeQueryResult(raw, {
    rowMode: "array",
    valueMode: "text",
    decoders: { [postgresOids.int4]: (value) => "int:" + value },
  });
  assert.deepEqual(custom.rows[0], [
    "safe",
    "int:7",
    "9007199254740993",
    '{"ok":true}',
    "\\x00ff",
    "{2026-01-01,NULL}",
  ]);
});

test("decoded object rows remain prototype safe when field names are unique", () => {
  const decoded = decodeQueryResult(
    parseQueryRawResponse(
      queryResponse(
        [field("__proto__", postgresOids.text), field("constructor", postgresOids.int4)],
        [["safe", "7"]],
        "SELECT 1",
      ),
    ),
  );
  const row = decoded.rows[0]!;
  assert.equal(Object.prototype.hasOwnProperty.call(row, "__proto__"), true);
  assert.equal(row.__proto__, "safe");
  assert.equal(row.constructor, 7);
});

test("decoded floating-point scalars and arrays preserve PostgreSQL non-finite values", () => {
  const decoded = decodeQueryResult(
    parseQueryRawResponse(
      queryResponse(
        [
          field("nan", postgresOids.float4),
          field("positive", postgresOids.float8),
          field("negative", postgresOids.float8),
          field("values", postgresOids.float8Array),
        ],
        [["NaN", "Infinity", "-Infinity", "{NaN,Infinity,-Infinity,NULL}"]],
        "SELECT 1",
      ),
    ),
  );

  const row = decoded.rows[0]!;
  assert.equal(Number.isNaN(row.nan), true);
  assert.equal(row.positive, Number.POSITIVE_INFINITY);
  assert.equal(row.negative, Number.NEGATIVE_INFINITY);
  const values = row.values as unknown[];
  assert.equal(Number.isNaN(values[0]), true);
  assert.deepEqual(values.slice(1), [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, null]);
});

test("built-in ORM OIDs and text-fallback arrays stay portable", () => {
  assert.deepEqual(
    {
      char: postgresOids.char,
      name: postgresOids.name,
      xml: postgresOids.xml,
      unknown: postgresOids.unknown,
      bpchar: postgresOids.bpchar,
      charArray: postgresOids.charArray,
      nameArray: postgresOids.nameArray,
      bpcharArray: postgresOids.bpcharArray,
      xmlArray: postgresOids.xmlArray,
    },
    {
      char: 18,
      name: 19,
      xml: 142,
      unknown: 705,
      bpchar: 1042,
      charArray: 1002,
      nameArray: 1003,
      bpcharArray: 1014,
      xmlArray: 143,
    },
  );

  const decoded = decodeQueryResult(
    parseQueryRawResponse(
      queryResponse(
        [
          field("chars", postgresOids.charArray),
          field("names", postgresOids.nameArray),
          field("fixed", postgresOids.bpcharArray),
          field("xml", postgresOids.xmlArray),
          field("literal", postgresOids.unknown),
        ],
        [["{a,b}", "{one,two}", "{fixed,padded}", "{<a/>,<b/>}", "value"]],
        "SELECT 1",
      ),
    ),
  );
  assert.deepEqual(decoded.rows, [
    {
      chars: ["a", "b"],
      names: ["one", "two"],
      fixed: ["fixed", "padded"],
      xml: ["<a/>", "<b/>"],
      literal: "value",
    },
  ]);
  assert.equal(
    array(["a"], postgresOids.charArray).typeOid,
    postgresOids.charArray,
  );
});

test("exec attributes notices to each statement and retains aggregate operation notices", () => {
  const response = backendResponse([
    [0x4e, diagnostic("NOTICE", "00000", "before create")],
    [0x43, cstring("CREATE TABLE")],
    [0x49, []],
    [0x4e, diagnostic("NOTICE", "00000", "before select")],
    [0x54, rowDescription([field("value", postgresOids.int4)])],
    [0x44, dataRow(["42"])],
    [0x43, cstring("SELECT 1")],
    [0x4e, diagnostic("NOTICE", "00000", "after statements")],
    [0x5a, [0x49]],
  ]);
  const result = parseExecResponse(response);
  assert.equal(result.statements.length, 2);
  assert.equal(result.statements[0]!.kind, "command");
  assert.equal(result.statements[1]!.kind, "rows");
  assert.deepEqual(result.statements[1]!.rows, [{ value: 42 }]);
  assert.deepEqual(
    result.statements.map((statement) =>
      statement.notices.map((notice) => notice.message),
    ),
    [["before create"], ["before select"]],
  );
  assert.deepEqual(
    result.notices.map((notice) => notice.message),
    ["before create", "before select", "after statements"],
  );
});

test("exec validates the complete response before decoding and snapshots options once", () => {
  const validResponse = backendResponse([
    [0x54, rowDescription([field("value", postgresOids.int4)])],
    [0x44, dataRow(["1"])],
    [0x43, cstring("SELECT 1")],
    [0x54, rowDescription([field("value", postgresOids.int4)])],
    [0x44, dataRow(["2"])],
    [0x43, cstring("SELECT 1")],
    [0x5a, [0x49]],
  ]);
  let optionReads = 0;
  let decoderCalls = 0;
  const result = parseExecResponse(validResponse, {
    get decoders() {
      optionReads += 1;
      return {
        [postgresOids.int4]: (value: string) => {
          decoderCalls += 1;
          return Number(value);
        },
      };
    },
  });
  assert.equal(optionReads, 1);
  assert.equal(decoderCalls, 2);
  assert.deepEqual(
    result.statements.map((statement) => statement.rows),
    [[{ value: 1 }], [{ value: 2 }]],
  );

  let emptyOptionReads = 0;
  const empty = parseExecResponse(
    backendResponse([
      [0x49, []],
      [0x5a, [0x49]],
    ]),
    {
      get decoders() {
        emptyOptionReads += 1;
        return undefined;
      },
    },
  );
  assert.equal(empty.statements.length, 0);
  assert.equal(emptyOptionReads, 0);

  decoderCalls = 0;
  assert.throws(
    () =>
      parseExecResponse(
        backendResponse([
          [0x54, rowDescription([field("value", postgresOids.int4)])],
          [0x44, dataRow(["1"])],
          [0x43, cstring("SELECT 1")],
          [0x31, []],
          [0x5a, [0x49]],
        ]),
        {
          decoders: {
            [postgresOids.int4]: (value) => {
              decoderCalls += 1;
              return Number(value);
            },
          },
        },
      ),
    /simple-query response contained ParseComplete/,
  );
  assert.equal(decoderCalls, 0);
});

test("exec decoder failures stop later decoding but retain all operation notices", () => {
  let decoderCalls = 0;
  const failure = thrownBy(() =>
    parseExecResponse(
      backendResponse([
        [0x4e, diagnostic("NOTICE", "00000", "before first")],
        [0x54, rowDescription([field("value", postgresOids.int4)])],
        [0x44, dataRow(["1"])],
        [0x43, cstring("SELECT 1")],
        [0x4e, diagnostic("NOTICE", "00000", "before second")],
        [0x54, rowDescription([field("value", postgresOids.int4)])],
        [0x44, dataRow(["2"])],
        [0x43, cstring("SELECT 1")],
        [0x4e, diagnostic("NOTICE", "00000", "after statements")],
        [0x5a, [0x49]],
      ]),
      {
        decoders: {
          [postgresOids.int4]: () => {
            decoderCalls += 1;
            throw new Error("decoder stopped");
          },
        },
      },
    ),
  );
  assert.equal(decoderCalls, 1);
  assert.deepEqual(
    (failure as Error & { notices: Array<{ message: string }> }).notices.map(
      (notice) => notice.message,
    ),
    ["before first", "before second", "after statements"],
  );
  assert.equal(responseTransactionStatus(failure as object), "idle");
});

test("exec extracts row counts without narrowing backend whitespace semantics", () => {
  const commandTags = [
    "SELECT 42",
    " INSERT 0 7 ",
    "\u00a0UPDATE\t0003\u3000",
    "FETCH FORWARD 9",
    "COPY 10",
    "CREATE TABLE",
    "SELECT 9007199254740992",
    "SELECT +1",
    "SELECT",
  ];
  const result = parseExecResponse(
    backendResponse([
      ...commandTags.map((tag) => [0x43, cstring(tag)] as const),
      [0x5a, [0x49]],
    ]),
  );
  assert.deepEqual(
    result.statements.map((statement) => statement.rowCount),
    [42, 7, 3, 9, 10, null, null, null, null],
  );
});

test("describe is structured and errors drain through ReadyForQuery with notices", () => {
  const described = parseDescribeResponse(
    backendResponse([
      [0x31, []],
      [0x74, [...i16(1), ...i32(postgresOids.jsonb)]],
      [0x54, rowDescription([field("payload", postgresOids.jsonb)])],
      [0x5a, [0x49]],
    ]),
  );
  assert.deepEqual(described.parameterTypeOids, [postgresOids.jsonb]);
  assert.equal(described.fields?.[0]?.name, "payload");
  assert.deepEqual(
    frontendMessages(describeQuery("SELECT $1", [0])).map(
      (message) => message.tag,
    ),
    ["P", "D", "S"],
  );

  const failure = thrownBy(() =>
    parseQueryRawResponse(
      backendResponse([
        [0x4e, diagnostic("NOTICE", "00000", "before error")],
        [0x45, diagnostic("ERROR", "22023", "bad value")],
        [0x53, [...cstring("application_name"), ...cstring("test")]],
        [0x5a, [0x45]],
      ]),
    ),
  );
  assert.ok(failure instanceof PostgresError);
  assert.equal(failure.notices[0]!.message, "before error");
  assert.equal(responseTransactionStatus(failure), "failed");
  assert.equal(failure.sqlstate, "22023");
  assert.equal(failure.message, "bad value");
});

test("diagnostics promote standard PostgreSQL fields and preserve unknown fields", () => {
  const noticeFields: Array<readonly [number, string]> = [
    [0x53, "AVERTISSEMENT"],
    [0x56, "WARNING"],
    [0x43, "01000"],
    [0x4d, "notice message"],
    [0x70, "3"],
    [0x71, "SELECT notice"],
    [0x57, "PL/pgSQL function notice_fn() line 1"],
    [0x46, "pl_exec.c"],
    [0x4c, "100"],
    [0x52, "exec_stmt_raise"],
  ];
  const errorFields: Array<readonly [number, string]> = [
    [0x53, "ERREUR"],
    [0x56, "ERROR"],
    [0x43, "XX000"],
    [0x4d, "error message"],
    [0x70, "7"],
    [0x71, "SELECT broken"],
    [0x57, "PL/pgSQL function broken_fn() line 2"],
    [0x46, "postgres.c"],
    [0x4c, "200"],
    [0x52, "exec_simple_query"],
    [0x58, "future diagnostic"],
  ];

  const failure = thrownBy(() =>
    parseQueryRawResponse(
      backendResponse([
        [0x4e, diagnosticFields(noticeFields)],
        [0x45, diagnosticFields(errorFields)],
        [0x5a, [0x49]],
      ]),
    ),
  );
  assert.ok(failure instanceof PostgresError);
  assert.deepEqual(
    {
      severity: failure.severity,
      localizedSeverity: failure.localizedSeverity,
      nonlocalizedSeverity: failure.nonlocalizedSeverity,
      internalPosition: failure.internalPosition,
      internalQuery: failure.internalQuery,
      whereText: failure.whereText,
      file: failure.file,
      line: failure.line,
      routine: failure.routine,
    },
    {
      severity: "ERREUR",
      localizedSeverity: "ERREUR",
      nonlocalizedSeverity: "ERROR",
      internalPosition: "7",
      internalQuery: "SELECT broken",
      whereText: "PL/pgSQL function broken_fn() line 2",
      file: "postgres.c",
      line: "200",
      routine: "exec_simple_query",
    },
  );
  assert.deepEqual(failure.fields.at(-1), {
    code: 0x58,
    value: "future diagnostic",
  });

  const notice = failure.notices[0]!;
  assert.deepEqual(
    {
      severity: notice.severity,
      localizedSeverity: notice.localizedSeverity,
      nonlocalizedSeverity: notice.nonlocalizedSeverity,
      internalPosition: notice.internalPosition,
      internalQuery: notice.internalQuery,
      whereText: notice.whereText,
      file: notice.file,
      line: notice.line,
      routine: notice.routine,
    },
    {
      severity: "AVERTISSEMENT",
      localizedSeverity: "AVERTISSEMENT",
      nonlocalizedSeverity: "WARNING",
      internalPosition: "3",
      internalQuery: "SELECT notice",
      whereText: "PL/pgSQL function notice_fn() line 1",
      file: "pl_exec.c",
      line: "100",
      routine: "exec_stmt_raise",
    },
  );
});

test("custom decoder failures retain query notices and normalize unattachable throws", () => {
  const queryRaw = parseQueryRawResponse(
    backendResponse([
      [0x31, []],
      [0x32, []],
      [0x54, rowDescription([field("value", postgresOids.int4)])],
      [0x4e, diagnostic("NOTICE", "00000", "query notice")],
      [0x44, dataRow(["42"])],
      [0x43, cstring("SELECT 1")],
      [0x5a, [0x49]],
    ]),
  );
  const extensible = new Error("extensible decoder failure");
  const queryFailure = thrownBy(() =>
    decodeQueryResult(queryRaw, {
      decoders: {
        [postgresOids.int4]: () => {
          throw extensible;
        },
      },
    }),
  );
  assert.equal(queryFailure, extensible);
  assert.deepEqual(
    (queryFailure as { notices: Array<{ message: string }> }).notices.map(
      (notice) => notice.message,
    ),
    ["query notice"],
  );
  assert.equal(responseTransactionStatus(queryFailure as object), "idle");

  const frozen = Object.freeze(new Error("frozen decoder failure"));
  const execFailure = thrownBy(() =>
    parseExecResponse(
      backendResponse([
        [0x54, rowDescription([field("value", postgresOids.int4)])],
        [0x4e, diagnostic("NOTICE", "00000", "exec notice")],
        [0x44, dataRow(["42"])],
        [0x43, cstring("SELECT 1")],
        [0x5a, [0x49]],
      ]),
      {
        decoders: {
          [postgresOids.int4]: () => {
            throw frozen;
          },
        },
      },
    ),
  );
  assert.ok(execFailure instanceof Error);
  assert.notEqual(execFailure, frozen);
  assert.equal(execFailure.cause, frozen);
  assert.deepEqual(
    (
      execFailure as Error & { notices: Array<{ message: string }> }
    ).notices.map((notice) => notice.message),
    ["exec notice"],
  );
  assert.equal(responseTransactionStatus(execFailure), "idle");

  const primitiveFailure = thrownBy(() =>
    decodeQueryResult(queryRaw, {
      decoders: {
        [postgresOids.int4]: () => {
          throw "primitive decoder failure";
        },
      },
    }),
  );
  assert.ok(primitiveFailure instanceof Error);
  assert.equal(primitiveFailure.message, "primitive decoder failure");
  assert.equal(primitiveFailure.cause, "primitive decoder failure");
  assert.deepEqual(
    (
      primitiveFailure as Error & { notices: Array<{ message: string }> }
    ).notices.map((notice) => notice.message),
    ["query notice"],
  );

  const frozenWithoutNotices = Object.freeze(
    new Error("frozen failure without notices"),
  );
  const noNoticeRaw = parseQueryRawResponse(
    queryResponse([field("value", postgresOids.int4)], [["42"]], "SELECT 1"),
  );
  const noNoticeFailure = thrownBy(() =>
    decodeQueryResult(noNoticeRaw, {
      decoders: {
        [postgresOids.int4]: () => {
          throw frozenWithoutNotices;
        },
      },
    }),
  );
  assert.equal(noNoticeFailure, frozenWithoutNotices);

  const primitiveWithoutNotices = thrownBy(() =>
    decodeQueryResult(noNoticeRaw, {
      decoders: {
        [postgresOids.int4]: () => {
          throw "primitive failure without notices";
        },
      },
    }),
  );
  assert.ok(primitiveWithoutNotices instanceof Error);
  assert.equal(
    primitiveWithoutNotices.cause,
    "primitive failure without notices",
  );
  assert.equal(responseTransactionStatus(primitiveWithoutNotices), "idle");
});

test("readiness inspection is decode-independent and malformed errors stay protocol errors", () => {
  assert.equal(
    inspectReadyForQuery(backendResponse([[0x5a, [0x54]]])),
    "transaction",
  );
  assert.throws(
    () =>
      inspectReadyForQuery(
        backendResponse([
          [0x5a, [0x49]],
          [0x49, []],
        ]),
      ),
    /bytes after ReadyForQuery/,
  );
  assert.throws(
    () => inspectReadyForQuery(backendResponse([[0x43, cstring("SELECT 0")]])),
    /before ReadyForQuery/,
  );
  assert.equal(
    inspectReadyForQuery(
      backendResponse([
        [0x43, cstring("SÉLECT 0")],
        [0x5a, [0x49]],
      ]),
    ),
    "idle",
  );
  assert.throws(
    () =>
      inspectReadyForQuery(
        backendResponse([
          [0x43, [0xc0, 0]],
          [0x5a, [0x49]],
        ]),
    ),
    /CommandComplete tag is not valid UTF-8/,
  );
  assert.throws(
    () =>
      inspectReadyForQuery(
        backendResponse([
          [0x43, [0x53]],
          [0x5a, [0x49]],
        ]),
      ),
    /CommandComplete tag is missing null terminator/,
  );
  assert.throws(
    () =>
      inspectReadyForQuery(
        backendResponse([
          [0x43, [...cstring("SELECT 0"), 0x53]],
          [0x5a, [0x49]],
        ]),
      ),
    /CommandComplete contained trailing bytes/,
  );
  assert.throws(
    () =>
      inspectReadyForQuery(
        backendResponse([
          [0x43, [0xc0, 0, 0x53]],
          [0x5a, [0x49]],
        ]),
      ),
    /CommandComplete tag is not valid UTF-8/,
  );

  const malformed = thrownBy(() =>
    parseQueryRawResponse(
      backendResponse([
        [0x45, [0x4d, 0xc0, 0, 0]],
        [0x5a, [0x49]],
      ]),
    ),
  );
  assert.ok(malformed instanceof Error);
  assert.equal(malformed instanceof PostgresError, false);
  assert.match(malformed.message, /ErrorResponse field is not valid UTF-8/);
  assert.equal(responseTransactionStatus(malformed), "idle");
});

test("managed transaction inspection uses every protocol tag and final readiness boundary", () => {
  for (const tag of [
    "BEGIN",
    "START TRANSACTION",
    "COMMIT",
    "PREPARE TRANSACTION",
    "COMMIT PREPARED",
    "ROLLBACK PREPARED",
  ]) {
    assert.throws(
      () =>
        inspectManagedTransactionResponse(
          backendResponse([
            [0x43, cstring(tag)],
            [0x5a, [0x54]],
          ]),
        ),
      /violated callback transaction ownership/,
      tag,
    );
  }

  assert.throws(
    () =>
      inspectManagedTransactionResponse(
        backendResponse([
          [0x43, cstring("COMMIT")],
          [0x43, cstring("BEGIN")],
          [0x45, diagnostic("ERROR", "XX000", "later failure")],
          [0x5a, [0x54]],
        ]),
      ),
    /command tag COMMIT/,
  );
  assert.throws(
    () =>
      inspectManagedTransactionResponse(
        backendResponse([
          [0x43, cstring("ROLLBACK")],
          [0x43, cstring("BEGIN")],
          [0x5a, [0x54]],
        ]),
      ),
    /command tag BEGIN/,
  );
  assert.throws(
    () =>
      inspectManagedTransactionResponse(
        backendResponse([
          [0x43, cstring("ROLLBACK")],
          [0x5a, [0x49]],
        ]),
      ),
    /ended PostgreSQL transaction ownership/,
  );

  for (const [tag, status] of [
    ["ROLLBACK", 0x54],
    ["ROLLBACK", 0x45],
    ["SAVEPOINT", 0x54],
    ["RELEASE", 0x54],
    ["SET", 0x54],
    ["PREPARE", 0x54],
    ["CREATE FUNCTION", 0x54],
    ["CALL", 0x54],
    ["DO", 0x54],
  ] as const) {
    assert.equal(
      inspectManagedTransactionResponse(
        backendResponse([
          [0x43, cstring(tag)],
          [0x5a, [status]],
        ]),
      ),
      status === 0x45 ? "failed" : "transaction",
      tag,
    );
  }
});

test("structured parsers require exact completion and reject post-completion rows", () => {
  const readyOnly = backendResponse([[0x5a, [0x49]]]);
  assert.throws(
    () => parseQueryRawResponse(readyOnly),
    /omitted CommandComplete or EmptyQueryResponse/,
  );
  assert.throws(
    () => parseExecResponse(readyOnly),
    /omitted CommandComplete or EmptyQueryResponse/,
  );
  assert.throws(
    () =>
      parseQueryRawResponse(
        backendResponse([
          [0x43, cstring("UPDATE 1")],
          [0x5a, [0x49]],
        ]),
      ),
    /before the extended-query result description/,
  );
  assert.throws(
    () =>
      parseQueryRawResponse(
        backendResponse([
          [0x49, []],
          [0x5a, [0x49]],
        ]),
      ),
    /before the extended-query result description/,
  );

  assert.throws(
    () =>
      parseQueryRawResponse(
        backendResponse([
          [0x31, []],
          [0x32, []],
          [0x6e, []],
          [0x43, cstring("UPDATE 1")],
          [0x43, cstring("UPDATE 1")],
          [0x5a, [0x49]],
        ]),
      ),
    /multiple result completions/,
  );
  assert.throws(
    () =>
      parseQueryRawResponse(
        backendResponse([
          [0x31, []],
          [0x32, []],
          [0x6e, []],
          [0x43, cstring("SELECT 1")],
          [0x44, dataRow(["late"])],
          [0x5a, [0x49]],
        ]),
      ),
    /DataRow arrived after statement completion/,
  );

  const empty = parseQueryRawResponse(
    backendResponse([
      [0x31, []],
      [0x32, []],
      [0x6e, []],
      [0x49, []],
      [0x5a, [0x49]],
    ]),
  );
  assert.equal(empty.kind, "command");
  assert.equal(empty.commandTag, undefined);

  const multi = parseExecResponse(
    backendResponse([
      [0x43, cstring("UPDATE 1")],
      [0x49, []],
      [0x43, cstring("DELETE 2")],
      [0x5a, [0x49]],
    ]),
  );
  assert.deepEqual(
    multi.statements.map((statement) => statement.commandTag),
    ["UPDATE 1", "DELETE 2"],
  );

  assert.throws(
    () =>
      parseDescribeResponse(
        backendResponse([
          [0x74, [...i16(0)]],
          [0x6e, []],
          [0x5a, [0x49]],
        ]),
      ),
    /before ParseComplete|omitted ParseComplete/,
  );
  assert.throws(
    () =>
      parseDescribeResponse(
        backendResponse([
          [0x31, []],
          [0x74, [...i16(0)]],
          [0x6e, []],
          [0x45, diagnostic("ERROR", "XX000", "late describe error")],
          [0x5a, [0x49]],
        ]),
      ),
    /ErrorResponse arrived after describe completion/,
  );

  assert.throws(
    () =>
      parseQueryRawResponse(
        backendResponse([
          [0x32, []],
          [0x6e, []],
          [0x43, cstring("UPDATE 1")],
          [0x5a, [0x49]],
        ]),
      ),
    /BindComplete arrived before ParseComplete/,
  );
  assert.throws(
    () =>
      parseQueryRawResponse(
        backendResponse([
          [0x31, []],
          [0x32, []],
          [0x6e, []],
          [0x43, cstring("UPDATE 1")],
          [0x33, []],
          [0x5a, [0x49]],
        ]),
      ),
    /unsolicited CloseComplete/,
  );
  assert.throws(
    () =>
      parseExecResponse(
        backendResponse([
          [0x31, []],
          [0x43, cstring("UPDATE 1")],
          [0x5a, [0x49]],
        ]),
      ),
    /simple-query response contained ParseComplete/,
  );
  assert.throws(
    () =>
      parseQueryRawResponse(
        backendResponse([
          [0x31, []],
          [0x32, []],
          [0x6e, []],
          [0x43, cstring("UPDATE 1")],
          [0x45, diagnostic("ERROR", "XX000", "late error")],
          [0x5a, [0x49]],
        ]),
      ),
    /ErrorResponse arrived after statement completion/,
  );
});

test("structured SQL scanners match the shared lexical corpus", () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL(
        "../../fixtures/protocol/structured-sql-cases.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as {
    schemaVersion: number;
    cases: Array<{
      name: string;
      sql: string;
      containsTopLevelCopy: boolean;
      containsTransactionChain: boolean;
    }>;
  };
  assert.equal(fixture.schemaVersion, 2);
  for (const entry of fixture.cases) {
    assert.equal(
      containsTopLevelCopy(entry.sql),
      entry.containsTopLevelCopy,
      entry.name,
    );
    assert.equal(
      containsTransactionChain(entry.sql),
      entry.containsTransactionChain,
      entry.name,
    );
  }
});

type FieldInput = { name: string; typeOid: number };

function field(name: string, typeOid: number): FieldInput {
  return { name, typeOid };
}

function queryResponse(
  fields: FieldInput[],
  rows: string[][],
  commandTag: string,
): Uint8Array {
  return backendResponse([
    [0x31, []],
    [0x32, []],
    [0x54, rowDescription(fields)],
    ...rows.map((row) => [0x44, dataRow(row)] as const),
    [0x43, cstring(commandTag)],
    [0x5a, [0x49]],
  ]);
}

function rowDescription(fields: FieldInput[]): number[] {
  return [
    ...i16(fields.length),
    ...fields.flatMap((entry) => [
      ...cstring(entry.name),
      ...i32(0),
      ...i16(0),
      ...i32(entry.typeOid),
      ...i16(-1),
      ...i32(-1),
      ...i16(0),
    ]),
  ];
}

function dataRow(values: string[]): number[] {
  return [
    ...i16(values.length),
    ...values.flatMap((value) => {
      const bytes = new TextEncoder().encode(value);
      return [...i32(bytes.length), ...bytes];
    }),
  ];
}

function diagnostic(
  severity: string,
  sqlstate: string,
  message: string,
): number[] {
  return diagnosticFields([
    [0x53, severity],
    [0x43, sqlstate],
    [0x4d, message],
  ]);
}

function diagnosticFields(
  fields: ReadonlyArray<readonly [number, string]>,
): number[] {
  return [...fields.flatMap(([code, value]) => [code, ...cstring(value)]), 0];
}

function backendResponse(
  messages: ReadonlyArray<readonly [number, readonly number[]]>,
): Uint8Array {
  return Uint8Array.from(
    messages.flatMap(([tag, body]) => [tag, ...i32(body.length + 4), ...body]),
  );
}

function cstring(value: string): number[] {
  return [...new TextEncoder().encode(value), 0];
}

function i16(value: number): number[] {
  const bits = value & 0xffff;
  return [(bits >>> 8) & 0xff, bits & 0xff];
}

function i32(value: number): number[] {
  const bits = value >>> 0;
  return [
    (bits >>> 24) & 0xff,
    (bits >>> 16) & 0xff,
    (bits >>> 8) & 0xff,
    bits & 0xff,
  ];
}

function frontendMessages(
  bytes: Uint8Array,
): Array<{ tag: string; body: Uint8Array }> {
  const messages: Array<{ tag: string; body: Uint8Array }> = [];
  let offset = 0;
  while (offset < bytes.length) {
    const length = readI32(bytes, offset + 1);
    messages.push({
      tag: String.fromCharCode(bytes[offset]!),
      body: bytes.slice(offset + 5, offset + 1 + length),
    });
    offset += length + 1;
  }
  return messages;
}

function readParseTypeOids(body: Uint8Array): number[] {
  let offset = 1;
  while (body[offset] !== 0) offset += 1;
  offset += 1;
  const count = readI16(body, offset);
  offset += 2;
  const oids: number[] = [];
  for (let index = 0; index < count; index += 1) {
    oids.push(readI32(body, offset) >>> 0);
    offset += 4;
  }
  return oids;
}

function readI16(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! << 8) | bytes[offset + 1]!;
}

function readI32(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset]! * 0x1000000 +
      (bytes[offset + 1]! << 16) +
      (bytes[offset + 2]! << 8) +
      bytes[offset + 3]!) >>>
    0
  );
}

function thrownBy(callback: () => unknown): unknown {
  try {
    callback();
  } catch (error) {
    return error;
  }
  throw new Error("expected callback to throw");
}
