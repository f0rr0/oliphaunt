use std::str;
#[cfg(test)]
use std::sync::Arc;

use anyhow::{Result, anyhow};

#[cfg(test)]
use anyhow::{Context, ensure};

use crate::oliphaunt::query_core;

pub(crate) use crate::oliphaunt::query_core::ReadyStatus;
pub use crate::oliphaunt::query_core::{
    CommandResult, DecodeError, ExecResult, FromSql, IntoParameter, Parameter, PostgresError,
    PostgresErrorField, PostgresNotice, QueryField, QueryFormat, QueryResult, QueryRow, RowIndex,
    StatementDescription, StatementResult, TypeOid, ValueFormat, ValueRef,
};

pub(crate) fn simple_query(sql: &str) -> Result<Vec<u8>> {
    query_core_result(query_core::simple_query(sql))
}

impl QueryResult {
    /// Read a text-format value by row index and column name.
    pub fn get_text(&self, row: usize, column: &str) -> crate::Result<Option<&str>> {
        crate::error::public_result(self.get_text_inner(row, column))
    }

    fn get_text_inner(&self, row: usize, column: &str) -> Result<Option<&str>> {
        let column = column.resolve(self.fields()).map_err(anyhow::Error::new)?;
        let row = self
            .row(row)
            .ok_or_else(|| anyhow!("query result has no row at index {row}"))?;
        row.text_inner(column)
    }
}

impl QueryRow {
    /// Read a text-format value by column index.
    pub fn text(&self, column: usize) -> crate::Result<Option<&str>> {
        crate::error::public_result(self.text_inner(column))
    }

    pub(crate) fn text_inner(&self, column: usize) -> Result<Option<&str>> {
        let value = self
            .value(column)
            .ok_or_else(|| anyhow!("query row has no column at index {column}"))?;
        value
            .as_deref()
            .map(|bytes| str::from_utf8(bytes).map_err(anyhow::Error::from))
            .transpose()
    }
}
fn query_core_result<T>(result: query_core::Result<T>) -> Result<T> {
    result.map_err(query_core_error)
}

fn query_core_error(error: query_core::Error) -> anyhow::Error {
    match error {
        query_core::Error::Protocol(message) => anyhow!(message),
        query_core::Error::Postgres {
            diagnostic,
            notices,
        } => {
            let mut error = PostgresError::from_core(*diagnostic);
            error.notices = notices.into_iter().map(PostgresNotice::from_core).collect();
            anyhow::Error::new(error)
        }
    }
}

#[cfg(test)]
pub(crate) fn parse_command_response(bytes: &[u8]) -> Result<CommandResult> {
    query_core_result(query_core::parse_command_response(
        bytes,
        query_core::ExpectedProtocol::Either,
    ))
}

pub(crate) fn parse_extended_command_response(bytes: &[u8]) -> Result<CommandResult> {
    query_core_result(query_core::parse_command_response(
        bytes,
        query_core::ExpectedProtocol::Extended,
    ))
}

pub(crate) fn parse_simple_command_response(bytes: &[u8]) -> Result<CommandResult> {
    query_core_result(query_core::parse_command_response(
        bytes,
        query_core::ExpectedProtocol::Simple,
    ))
}

#[cfg(test)]
pub(crate) fn parse_query_response(bytes: &[u8]) -> Result<QueryResult> {
    query_core_result(query_core::parse_query_response(
        bytes,
        query_core::ExpectedProtocol::Either,
    ))
}

pub(crate) fn parse_extended_query_response(bytes: &[u8]) -> Result<QueryResult> {
    query_core_result(query_core::parse_query_response(
        bytes,
        query_core::ExpectedProtocol::Extended,
    ))
}

pub(crate) fn parse_exec_response(bytes: &[u8]) -> Result<ExecResult> {
    query_core_result(query_core::parse_exec_response(bytes))
}

pub(crate) fn parse_statement_description(bytes: &[u8]) -> Result<StatementDescription> {
    query_core_result(query_core::parse_statement_description(bytes))
}

pub(crate) fn extended_statement(
    sql: &str,
    params: &[Parameter],
    result_format: ValueFormat,
) -> Result<Vec<u8>> {
    query_core_result(query_core::extended_statement(
        sql,
        params,
        result_format.code(),
    ))
}

pub(crate) fn describe_statement(sql: &str, params: &[Parameter]) -> Result<Vec<u8>> {
    query_core_result(query_core::describe_statement(sql, params))
}

pub(crate) fn reject_copy_statements(sql: &str) -> Result<()> {
    query_core_result(query_core::reject_copy_statements(sql))
}

pub(crate) fn reject_transaction_chain(sql: &str) -> Result<()> {
    query_core_result(query_core::reject_transaction_chain(sql))
}

pub(crate) fn validate_managed_transaction_response(response: &[u8]) -> Result<ReadyStatus> {
    query_core_result(query_core::validate_managed_transaction_response(response))
}

pub(crate) fn response_ready_status(bytes: &[u8]) -> Result<ReadyStatus> {
    query_core_result(query_core::response_ready_status(bytes))
}

#[cfg(test)]
fn parse_postgres_error(body: &[u8]) -> Result<PostgresError> {
    let fields = query_core_result(query_core::parse_diagnostic_fields(body, "ErrorResponse"))?;
    Ok(PostgresError::from_core(query_core::diagnostic(
        fields,
        "PostgreSQL ErrorResponse",
    )))
}

#[cfg(test)]
fn parse_notice_response(body: &[u8]) -> Result<PostgresNotice> {
    let fields = query_core_result(query_core::parse_diagnostic_fields(body, "NoticeResponse"))?;
    Ok(PostgresNotice::from_core(query_core::diagnostic(
        fields,
        "PostgreSQL NoticeResponse",
    )))
}

#[cfg(test)]
fn read_u32(input: &mut &[u8], label: &str) -> Result<u32> {
    Ok(u32::from_be_bytes(
        take(input, 4, label)?.try_into().expect("four bytes"),
    ))
}

#[cfg(test)]
fn read_i32(input: &mut &[u8], label: &str) -> Result<i32> {
    Ok(i32::from_be_bytes(
        take(input, 4, label)?.try_into().expect("four bytes"),
    ))
}

#[cfg(test)]
fn read_i16(input: &mut &[u8], label: &str) -> Result<i16> {
    Ok(i16::from_be_bytes(
        take(input, 2, label)?.try_into().expect("two bytes"),
    ))
}

#[cfg(test)]
fn read_cstring<'a>(input: &mut &'a [u8], label: &str) -> Result<&'a str> {
    let nul = input
        .iter()
        .position(|byte| *byte == 0)
        .with_context(|| format!("{label} is missing null terminator"))?;
    let value = str::from_utf8(&input[..nul]).with_context(|| format!("{label} is not UTF-8"))?;
    *input = &input[nul + 1..];
    Ok(value)
}

#[cfg(test)]
fn take<'a>(input: &mut &'a [u8], length: usize, label: &str) -> Result<&'a [u8]> {
    ensure!(input.len() >= length, "truncated {label}");
    let (head, tail) = input.split_at(length);
    *input = tail;
    Ok(head)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn simple_query_encodes_one_postgres_message() {
        assert_eq!(
            simple_query("SELECT 1").expect("valid simple query"),
            b"Q\0\0\0\rSELECT 1\0".as_slice()
        );
    }

    #[test]
    fn simple_query_rejects_embedded_nul() {
        assert_eq!(
            simple_query("SELECT\0 1")
                .expect_err("embedded NUL must be rejected")
                .to_string(),
            "simple query SQL must not contain NUL bytes"
        );
    }

    #[test]
    fn postgres_error_preserves_ordered_fields() {
        let error = parse_postgres_error(
            b"SERREUR\0VERROR\0C23505\0Mduplicate key\0DKey already exists\0titems\0p12\0qSELECT broken\0Fparse_expr.c\0L123\0RtransformExpr\0\0",
        )
        .expect("valid ErrorResponse");

        assert_eq!(error.severity.as_deref(), Some("ERREUR"));
        assert_eq!(error.localized_severity.as_deref(), Some("ERREUR"));
        assert_eq!(error.nonlocalized_severity.as_deref(), Some("ERROR"));
        assert_eq!(error.sqlstate.as_deref(), Some("23505"));
        assert_eq!(error.message, "duplicate key");
        assert_eq!(error.detail.as_deref(), Some("Key already exists"));
        assert_eq!(error.table_name.as_deref(), Some("items"));
        assert_eq!(error.internal_position.as_deref(), Some("12"));
        assert_eq!(error.internal_query.as_deref(), Some("SELECT broken"));
        assert_eq!(error.file.as_deref(), Some("parse_expr.c"));
        assert_eq!(error.line.as_deref(), Some("123"));
        assert_eq!(error.routine.as_deref(), Some("transformExpr"));
        assert_eq!(
            error
                .fields
                .iter()
                .map(|field| field.code)
                .collect::<Vec<_>>(),
            [
                b'S', b'V', b'C', b'M', b'D', b't', b'p', b'q', b'F', b'L', b'R'
            ]
        );
        assert_eq!(error.to_string(), "ERREUR [23505]: duplicate key");
    }

    #[test]
    fn postgres_notice_exposes_finite_standard_diagnostic_fields() {
        let notice = parse_notice_response(
            b"SAVERTISSEMENT\0VWARNING\0Mcheck value\0p12\0qSELECT broken\0Fparse_expr.c\0L123\0RtransformExpr\0\0",
        )
        .expect("valid NoticeResponse");

        assert_eq!(notice.severity.as_deref(), Some("AVERTISSEMENT"));
        assert_eq!(notice.localized_severity.as_deref(), Some("AVERTISSEMENT"));
        assert_eq!(notice.nonlocalized_severity.as_deref(), Some("WARNING"));
        assert_eq!(notice.internal_position.as_deref(), Some("12"));
        assert_eq!(notice.internal_query.as_deref(), Some("SELECT broken"));
        assert_eq!(notice.file.as_deref(), Some("parse_expr.c"));
        assert_eq!(notice.line.as_deref(), Some("123"));
        assert_eq!(notice.routine.as_deref(), Some("transformExpr"));
        assert_eq!(
            notice
                .fields
                .iter()
                .map(|field| field.code)
                .collect::<Vec<_>>(),
            [b'S', b'V', b'M', b'p', b'q', b'F', b'L', b'R']
        );
    }

    #[test]
    fn postgres_error_display_handles_partial_identity() {
        let error = |severity: Option<&str>, sqlstate: Option<&str>| PostgresError {
            severity: severity.map(str::to_owned),
            localized_severity: severity.map(str::to_owned),
            nonlocalized_severity: None,
            sqlstate: sqlstate.map(str::to_owned),
            message: "failed".to_owned(),
            detail: None,
            hint: None,
            position: None,
            internal_position: None,
            internal_query: None,
            where_: None,
            schema_name: None,
            table_name: None,
            column_name: None,
            data_type_name: None,
            constraint_name: None,
            file: None,
            line: None,
            routine: None,
            fields: Vec::new(),
            notices: Vec::new(),
        };

        assert_eq!(error(Some("ERROR"), None).to_string(), "ERROR: failed");
        assert_eq!(error(None, Some("XX000")).to_string(), "[XX000]: failed");
        assert_eq!(error(None, None).to_string(), "failed");
    }

    #[test]
    fn parameter_conversions_feed_the_extended_protocol() {
        let owned = "owned".to_owned();
        let params = vec![
            Parameter::text("text"),
            Parameter::binary([1_u8, 2]),
            "borrowed".into_parameter(),
            owned.clone().into_parameter(),
            (&owned).into_parameter(),
            1_i16.into_parameter(),
            2_i32.into_parameter(),
            3_i64.into_parameter(),
            4.5_f32.into_parameter(),
            6.25_f64.into_parameter(),
            true.into_parameter(),
            (&[7_u8, 8][..]).into_parameter(),
            vec![9_u8].into_parameter(),
            Some("optional").into_parameter(),
            None::<&str>.into_parameter(),
        ];

        let packet = extended_statement("SELECT $1", &params, ValueFormat::Text)
            .expect("valid extended query");
        assert_eq!(packet.first(), Some(&b'P'));
        assert!(packet.contains(&b'B'));
        assert!(extended_statement("SELECT\0$1", &[], ValueFormat::Text).is_err());
        let too_many = vec![Parameter::null(); i16::MAX as usize + 1];
        assert!(extended_statement("SELECT 1", &too_many, ValueFormat::Text).is_err());
    }

    #[test]
    fn typed_parameters_encode_oids_formats_nulls_and_result_format() {
        let params = [
            Parameter::typed_null(TypeOid::INT4),
            7_i32.into_parameter(),
            Parameter::text("hello"),
        ];
        let packet = extended_statement("SELECT $1, $2, $3", &params, ValueFormat::Binary)
            .expect("valid typed statement");
        let messages = frontend_messages(&packet);
        assert_eq!(
            messages.iter().map(|(tag, _)| *tag).collect::<Vec<_>>(),
            [b'P', b'B', b'D', b'E', b'S']
        );

        let mut parse = messages[0].1;
        assert_eq!(read_cstring(&mut parse, "statement").unwrap(), "");
        assert_eq!(
            read_cstring(&mut parse, "SQL").unwrap(),
            "SELECT $1, $2, $3"
        );
        assert_eq!(read_i16(&mut parse, "OID count").unwrap(), 3);
        assert_eq!(read_u32(&mut parse, "OID").unwrap(), TypeOid::INT4.get());
        assert_eq!(read_u32(&mut parse, "OID").unwrap(), TypeOid::INT4.get());
        assert_eq!(read_u32(&mut parse, "OID").unwrap(), 0);
        assert!(parse.is_empty());

        let mut bind = messages[1].1;
        assert_eq!(read_cstring(&mut bind, "portal").unwrap(), "");
        assert_eq!(read_cstring(&mut bind, "statement").unwrap(), "");
        assert_eq!(read_i16(&mut bind, "format count").unwrap(), 3);
        assert_eq!(read_i16(&mut bind, "format").unwrap(), 0);
        assert_eq!(read_i16(&mut bind, "format").unwrap(), 1);
        assert_eq!(read_i16(&mut bind, "format").unwrap(), 0);
        assert_eq!(read_i16(&mut bind, "value count").unwrap(), 3);
        assert_eq!(read_i32(&mut bind, "null length").unwrap(), -1);
        assert_eq!(read_i32(&mut bind, "int length").unwrap(), 4);
        assert_eq!(take(&mut bind, 4, "int").unwrap(), &7_i32.to_be_bytes());
        assert_eq!(read_i32(&mut bind, "text length").unwrap(), 5);
        assert_eq!(take(&mut bind, 5, "text").unwrap(), b"hello");
        assert_eq!(read_i16(&mut bind, "result format count").unwrap(), 1);
        assert_eq!(read_i16(&mut bind, "result format").unwrap(), 1);
        assert!(bind.is_empty());
    }

    #[test]
    fn explicit_oid_zero_is_describe_only() {
        let parameter = Parameter::typed_text(TypeOid::new(0), "infer me");
        let error = extended_statement(
            "SELECT $1",
            std::slice::from_ref(&parameter),
            ValueFormat::Text,
        )
        .expect_err("execution rejects explicit OID 0");
        assert!(
            error
                .to_string()
                .contains("explicitly declares PostgreSQL type OID 0")
        );

        let packet = describe_statement("SELECT $1", &[parameter])
            .expect("describe permits OID 0 as PostgreSQL inference");
        let messages = frontend_messages(&packet);
        let mut parse = messages[0].1;
        assert_eq!(read_cstring(&mut parse, "statement").unwrap(), "");
        assert_eq!(read_cstring(&mut parse, "SQL").unwrap(), "SELECT $1");
        assert_eq!(read_i16(&mut parse, "OID count").unwrap(), 1);
        assert_eq!(read_u32(&mut parse, "OID").unwrap(), 0);
    }

    #[test]
    fn query_result_accessors_report_postgres_shapes() {
        let fields: Arc<[QueryField]> = vec![QueryField {
            name: "value".to_owned(),
            table_oid: 0,
            table_attribute: 0,
            type_oid: 25,
            type_size: -1,
            type_modifier: -1,
            format: QueryFormat::Text,
        }]
        .into();
        let result = QueryResult {
            fields: Arc::clone(&fields),
            rows: vec![QueryRow {
                fields,
                values: vec![Some(b"ok".to_vec())],
            }],
            command_tag: Some("SELECT 1".to_owned()),
            row_count: Some(1),
            notices: Vec::new(),
            ready_status: ReadyStatus::Idle,
        };

        assert_eq!(result.get_text(0, "value").expect("text value"), Some("ok"));
        assert!(result.get_text(0, "missing").is_err());
        assert!(result.get_text(1, "value").is_err());
        assert_eq!(result.rows()[0].values(), &[Some(b"ok".to_vec())]);
        assert_eq!(result.rows()[0].text(0).expect("row text"), Some("ok"));
        assert!(result.rows()[0].text(1).is_err());
        assert!(
            QueryRow {
                fields: Arc::from([]),
                values: vec![Some(vec![0xff])],
            }
            .text(0)
            .is_err()
        );
        assert_eq!(QueryFormat::from(0), QueryFormat::Text);
        assert_eq!(QueryFormat::from(1), QueryFormat::Binary);
        assert_eq!(QueryFormat::from(7), QueryFormat::Other(7));
    }

    #[test]
    fn typed_rows_validate_oids_nulls_and_duplicate_names() {
        let fields: Arc<[QueryField]> = vec![
            test_field("same", TypeOid::INT4, QueryFormat::Text),
            test_field("same", TypeOid::TEXT, QueryFormat::Text),
            test_field("bytes", TypeOid::BYTEA, QueryFormat::Binary),
            test_field("nullable", TypeOid::INT4, QueryFormat::Text),
        ]
        .into();
        let row = QueryRow {
            fields,
            values: vec![
                Some(b"42".to_vec()),
                Some(b"label".to_vec()),
                Some(vec![0, 255]),
                None,
            ],
        };
        assert_eq!(row.try_get::<i32, _>(0).unwrap(), 42);
        assert_eq!(row.try_get::<String, _>(1).unwrap(), "label");
        assert_eq!(row.try_get::<&[u8], _>("bytes").unwrap(), &[0, 255]);
        assert_eq!(row.try_get::<Option<i32>, _>("nullable").unwrap(), None);
        assert!(matches!(
            row.try_get::<Option<String>, _>("nullable"),
            Err(DecodeError::TypeMismatch { type_oid, .. }) if type_oid == TypeOid::INT4
        ));
        assert!(matches!(
            row.try_get::<String, _>("same"),
            Err(DecodeError::AmbiguousColumn(name)) if name == "same"
        ));

        let result = QueryResult {
            fields: Arc::clone(&row.fields),
            rows: vec![row],
            command_tag: Some("SELECT 1".to_owned()),
            row_count: Some(1),
            notices: Vec::new(),
            ready_status: ReadyStatus::Idle,
        };
        assert!(
            result
                .get_text(0, "same")
                .expect_err("text lookup must reject duplicate names")
                .to_string()
                .contains("more than one column")
        );
    }

    #[test]
    fn error_parser_drains_ready_and_attaches_notices() {
        let mut response = backend_message(b'N', b"SNOTICE\0Mbefore failure\0\0");
        response.extend(backend_message(b'E', b"SERROR\0C23505\0Mduplicate\0\0"));
        response.extend(backend_message(b'Z', b"I"));
        let error = parse_command_response(&response).unwrap_err();
        let postgres = error
            .downcast_ref::<PostgresError>()
            .expect("PostgreSQL error");
        assert_eq!(postgres.sqlstate.as_deref(), Some("23505"));
        assert_eq!(postgres.notices[0].message, "before failure");

        let missing_ready = backend_message(b'E', b"SERROR\0C42601\0Msyntax\0\0");
        assert!(
            parse_command_response(&missing_ready)
                .unwrap_err()
                .to_string()
                .contains("before ReadyForQuery")
        );
    }

    #[test]
    fn exec_preserves_ordered_command_and_row_results() {
        let mut response = backend_message(b'N', b"SNOTICE\0Minserted\0\0");
        response.extend(backend_message(b'C', b"INSERT 0 1\0"));
        response.extend(backend_message(b'N', b"SNOTICE\0Mselected\0\0"));
        response.extend(backend_message(
            b'T',
            &row_description_body(&[("answer", TypeOid::INT4)]),
        ));
        let mut row = 1_i16.to_be_bytes().to_vec();
        row.extend_from_slice(&2_i32.to_be_bytes());
        row.extend_from_slice(b"42");
        response.extend(backend_message(b'D', &row));
        response.extend(backend_message(b'C', b"SELECT 1\0"));
        response.extend(backend_message(b'Z', b"I"));

        let result = parse_exec_response(&response).expect("valid multi-statement response");
        assert_eq!(result.statements().len(), 2);
        let StatementResult::Command(command) = &result.statements()[0] else {
            panic!("INSERT result must remain a command");
        };
        assert_eq!(command.command_tag(), Some("INSERT 0 1"));
        assert_eq!(command.row_count(), Some(1));
        assert_eq!(command.notices()[0].message, "inserted");
        match &result.statements()[1] {
            StatementResult::Rows(query) => {
                assert_eq!(query.command_tag(), Some("SELECT 1"));
                assert_eq!(query.rows()[0].try_get::<i32, _>("answer").unwrap(), 42);
                assert_eq!(query.notices()[0].message, "selected");
            }
            StatementResult::Command(_) => panic!("SELECT result must retain its rows"),
        }
        assert_eq!(result.notices()[0].message, "inserted");
        assert_eq!(result.notices()[1].message, "selected");
    }

    #[test]
    fn extended_query_accepts_command_only_statement_as_empty_rows() {
        let mut response = backend_message(b'1', b"");
        response.extend(backend_message(b'2', b""));
        response.extend(backend_message(b'n', b""));
        response.extend(backend_message(b'C', b"UPDATE 2\0"));
        response.extend(backend_message(b'Z', b"I"));

        let result =
            parse_extended_query_response(&response).expect("command is a valid query result");
        assert!(result.fields().is_empty());
        assert!(result.rows().is_empty());
        assert_eq!(result.command_tag(), Some("UPDATE 2"));
        assert_eq!(result.row_count(), Some(2));
    }

    #[test]
    fn describe_returns_parameter_oids_fields_and_notices() {
        let mut parameters = 2_i16.to_be_bytes().to_vec();
        parameters.extend_from_slice(&TypeOid::INT4.get().to_be_bytes());
        parameters.extend_from_slice(&TypeOid::TEXT.get().to_be_bytes());
        let mut response = backend_message(b'1', b"");
        response.extend(backend_message(b't', &parameters));
        response.extend(backend_message(
            b'T',
            &row_description_body(&[("answer", TypeOid::INT8)]),
        ));
        response.extend(backend_message(b'N', b"SNOTICE\0Mdescribed\0\0"));
        response.extend(backend_message(b'Z', b"I"));

        let description =
            parse_statement_description(&response).expect("valid statement description");
        assert_eq!(
            description.parameter_types(),
            &[TypeOid::INT4, TypeOid::TEXT]
        );
        assert_eq!(
            description.fields().expect("row description")[0].type_oid_value(),
            TypeOid::INT8
        );
        assert_eq!(description.notices()[0].message, "described");
    }

    #[test]
    fn single_statement_parsers_reject_duplicate_or_incomplete_completion() {
        let mut duplicate = backend_message(b'C', b"UPDATE 1\0");
        duplicate.extend(backend_message(b'C', b"UPDATE 1\0"));
        duplicate.extend(backend_message(b'Z', b"I"));
        assert!(
            parse_command_response(&duplicate)
                .unwrap_err()
                .to_string()
                .contains("multiple CommandComplete")
        );

        let mut incomplete = Vec::new();
        let mut description = Vec::new();
        description.extend_from_slice(&1_i16.to_be_bytes());
        description.extend_from_slice(b"value\0");
        description.extend_from_slice(&0_u32.to_be_bytes());
        description.extend_from_slice(&0_i16.to_be_bytes());
        description.extend_from_slice(&TypeOid::INT4.get().to_be_bytes());
        description.extend_from_slice(&(-1_i16).to_be_bytes());
        description.extend_from_slice(&(-1_i32).to_be_bytes());
        description.extend_from_slice(&0_i16.to_be_bytes());
        incomplete.extend(backend_message(b'T', &description));
        incomplete.extend(backend_message(b'Z', b"I"));
        assert!(
            parse_query_response(&incomplete)
                .unwrap_err()
                .to_string()
                .contains("before CommandComplete")
        );
    }

    #[test]
    fn single_statement_parsers_require_exactly_one_completion_mode() {
        let ready_only = backend_message(b'Z', b"I");
        assert!(
            parse_command_response(&ready_only)
                .unwrap_err()
                .to_string()
                .contains("before CommandComplete or EmptyQueryResponse")
        );
        assert!(
            parse_query_response(&ready_only)
                .unwrap_err()
                .to_string()
                .contains("before CommandComplete or EmptyQueryResponse")
        );

        let mut empty = backend_message(b'I', b"");
        empty.extend(backend_message(b'Z', b"I"));
        assert_eq!(parse_command_response(&empty).unwrap().command_tag(), None);
        let query = parse_query_response(&empty).unwrap();
        assert_eq!(query.command_tag(), None);
        assert!(query.fields().is_empty());
        assert!(query.rows().is_empty());

        let mut command_then_empty = backend_message(b'C', b"UPDATE 1\0");
        command_then_empty.extend(backend_message(b'I', b""));
        command_then_empty.extend(backend_message(b'Z', b"I"));
        assert!(
            parse_query_response(&command_then_empty)
                .unwrap_err()
                .to_string()
                .contains("EmptyQueryResponse after CommandComplete")
        );

        let mut empty_then_command = backend_message(b'I', b"");
        empty_then_command.extend(backend_message(b'C', b"UPDATE 1\0"));
        empty_then_command.extend(backend_message(b'Z', b"I"));
        assert!(
            parse_command_response(&empty_then_command)
                .unwrap_err()
                .to_string()
                .contains("CommandComplete after EmptyQueryResponse")
        );

        let mut duplicate_empty = backend_message(b'I', b"");
        duplicate_empty.extend(backend_message(b'I', b""));
        duplicate_empty.extend(backend_message(b'Z', b"I"));
        assert!(
            parse_query_response(&duplicate_empty)
                .unwrap_err()
                .to_string()
                .contains("multiple EmptyQueryResponse")
        );
    }

    #[test]
    fn query_rejects_messages_after_completion_and_invalid_extended_order() {
        let mut response =
            backend_message(b'T', &row_description_body(&[("answer", TypeOid::INT4)]));
        response.extend(backend_message(b'C', b"SELECT 0\0"));
        let mut row = 1_i16.to_be_bytes().to_vec();
        row.extend_from_slice(&2_i32.to_be_bytes());
        row.extend_from_slice(b"42");
        response.extend(backend_message(b'D', &row));
        response.extend(backend_message(b'Z', b"I"));
        assert!(
            parse_query_response(&response)
                .unwrap_err()
                .to_string()
                .contains("DataRow after statement completion")
        );

        let mut parse_after_completion = backend_message(b'C', b"UPDATE 1\0");
        parse_after_completion.extend(backend_message(b'1', b""));
        parse_after_completion.extend(backend_message(b'Z', b"I"));
        assert!(
            parse_query_response(&parse_after_completion)
                .unwrap_err()
                .to_string()
                .contains("ParseComplete out of order")
        );

        let mut bind_before_parse = backend_message(b'2', b"");
        bind_before_parse.extend(backend_message(b'n', b""));
        bind_before_parse.extend(backend_message(b'C', b"UPDATE 1\0"));
        bind_before_parse.extend(backend_message(b'Z', b"I"));
        assert!(
            parse_query_response(&bind_before_parse)
                .unwrap_err()
                .to_string()
                .contains("BindComplete out of order")
        );

        let mut error_after_command = backend_message(b'C', b"UPDATE 1\0");
        error_after_command.extend(backend_message(b'E', b"SERROR\0CXX000\0Mtoo late\0\0"));
        error_after_command.extend(backend_message(b'Z', b"I"));
        assert!(
            parse_query_response(&error_after_command)
                .unwrap_err()
                .to_string()
                .contains("ErrorResponse after statement completion")
        );

        let mut error_after_empty = backend_message(b'I', b"");
        error_after_empty.extend(backend_message(b'E', b"SERROR\0CXX000\0Mtoo late\0\0"));
        error_after_empty.extend(backend_message(b'Z', b"I"));
        assert!(
            parse_command_response(&error_after_empty)
                .unwrap_err()
                .to_string()
                .contains("ErrorResponse after statement completion")
        );

        let mut close_complete = backend_message(b'3', b"");
        close_complete.extend(backend_message(b'C', b"UPDATE 1\0"));
        close_complete.extend(backend_message(b'Z', b"I"));
        assert!(
            parse_query_response(&close_complete)
                .unwrap_err()
                .to_string()
                .contains("unexpected backend message tag 0x33")
        );
        assert!(
            parse_command_response(&close_complete)
                .unwrap_err()
                .to_string()
                .contains("unexpected backend message tag 0x33")
        );
    }

    #[test]
    fn exec_accepts_but_omits_empty_statements_and_requires_a_completion() {
        let mut response = backend_message(b'I', b"");
        response.extend(backend_message(b'C', b"UPDATE 1\0"));
        response.extend(backend_message(b'I', b""));
        response.extend(backend_message(b'Z', b"I"));

        let result = parse_exec_response(&response).unwrap();
        assert_eq!(result.statements().len(), 1);
        assert!(matches!(
            &result.statements()[0],
            StatementResult::Command(command) if command.command_tag() == Some("UPDATE 1")
        ));

        let mut empty = backend_message(b'I', b"");
        empty.extend(backend_message(b'Z', b"I"));
        assert!(parse_exec_response(&empty).unwrap().statements().is_empty());

        assert!(
            parse_exec_response(&backend_message(b'Z', b"I"))
                .unwrap_err()
                .to_string()
                .contains("before CommandComplete or EmptyQueryResponse")
        );

        for tag in [b'1', b'2', b'3', b't', b'n'] {
            let mut extended_control = backend_message(tag, b"");
            extended_control.extend(backend_message(b'C', b"UPDATE 1\0"));
            extended_control.extend(backend_message(b'Z', b"I"));
            assert!(
                parse_exec_response(&extended_control)
                    .unwrap_err()
                    .to_string()
                    .contains("unexpected backend message tag")
            );
        }
    }

    #[test]
    fn describe_requires_parse_complete_and_protocol_order() {
        assert!(
            parse_statement_description(&backend_message(b'Z', b"I"))
                .unwrap_err()
                .to_string()
                .contains("omitted ParseComplete")
        );

        let parameters = 0_i16.to_be_bytes();
        let mut parameter_before_parse = backend_message(b't', &parameters);
        parameter_before_parse.extend(backend_message(b'1', b""));
        parameter_before_parse.extend(backend_message(b'n', b""));
        parameter_before_parse.extend(backend_message(b'Z', b"I"));
        assert!(
            parse_statement_description(&parameter_before_parse)
                .unwrap_err()
                .to_string()
                .contains("ParameterDescription out of order")
        );

        let mut duplicate_parse = backend_message(b'1', b"");
        duplicate_parse.extend(backend_message(b'1', b""));
        duplicate_parse.extend(backend_message(b't', &parameters));
        duplicate_parse.extend(backend_message(b'n', b""));
        duplicate_parse.extend(backend_message(b'Z', b"I"));
        assert!(
            parse_statement_description(&duplicate_parse)
                .unwrap_err()
                .to_string()
                .contains("ParseComplete out of order")
        );

        let mut result_before_parameters = backend_message(b'1', b"");
        result_before_parameters.extend(backend_message(
            b'T',
            &row_description_body(&[("answer", TypeOid::INT4)]),
        ));
        result_before_parameters.extend(backend_message(b't', &parameters));
        result_before_parameters.extend(backend_message(b'Z', b"I"));
        assert!(
            parse_statement_description(&result_before_parameters)
                .unwrap_err()
                .to_string()
                .contains("RowDescription out of order")
        );

        let mut error_after_result = backend_message(b'1', b"");
        error_after_result.extend(backend_message(b't', &parameters));
        error_after_result.extend(backend_message(b'n', b""));
        error_after_result.extend(backend_message(b'E', b"SERROR\0CXX000\0Mtoo late\0\0"));
        error_after_result.extend(backend_message(b'Z', b"I"));
        assert!(
            parse_statement_description(&error_after_result)
                .unwrap_err()
                .to_string()
                .contains("ErrorResponse after result description")
        );
    }

    #[test]
    fn structured_sql_preflight_matches_shared_corpus() {
        let source = crate::oliphaunt::test_fixtures::text(
            "protocol/structured-sql-cases.json",
            "protocol-structured-sql-cases.json",
        );
        let fixture: serde_json::Value = serde_json::from_str(&source).unwrap();
        assert_eq!(fixture["schemaVersion"], 2);
        for case in fixture["cases"].as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            let sql = case["sql"].as_str().unwrap();
            let expected = case["containsTopLevelCopy"].as_bool().unwrap();
            assert_eq!(reject_copy_statements(sql).is_err(), expected, "{name}");
            let expected = case["containsTransactionChain"].as_bool().unwrap();
            assert_eq!(reject_transaction_chain(sql).is_err(), expected, "{name}");
        }
    }

    #[test]
    fn describe_allows_copy_because_it_does_not_execute() {
        describe_statement("COPY public.items TO STDOUT", &[])
            .expect("Parse + Describe + Sync cannot enter COPY mode");
    }

    fn test_field(name: &str, type_oid: TypeOid, format: QueryFormat) -> QueryField {
        QueryField {
            name: name.to_owned(),
            table_oid: 0,
            table_attribute: 0,
            type_oid: type_oid.get(),
            type_size: -1,
            type_modifier: -1,
            format,
        }
    }

    fn row_description_body(fields: &[(&str, TypeOid)]) -> Vec<u8> {
        let mut body = (fields.len() as i16).to_be_bytes().to_vec();
        for (name, type_oid) in fields {
            body.extend_from_slice(name.as_bytes());
            body.push(0);
            body.extend_from_slice(&0_u32.to_be_bytes());
            body.extend_from_slice(&0_i16.to_be_bytes());
            body.extend_from_slice(&type_oid.get().to_be_bytes());
            body.extend_from_slice(&(-1_i16).to_be_bytes());
            body.extend_from_slice(&(-1_i32).to_be_bytes());
            body.extend_from_slice(&0_i16.to_be_bytes());
        }
        body
    }

    fn frontend_messages(mut packet: &[u8]) -> Vec<(u8, &[u8])> {
        let mut messages = Vec::new();
        while !packet.is_empty() {
            let tag = packet[0];
            let length = i32::from_be_bytes(packet[1..5].try_into().unwrap()) as usize;
            messages.push((tag, &packet[5..length + 1]));
            packet = &packet[length + 1..];
        }
        messages
    }

    fn backend_message(tag: u8, body: &[u8]) -> Vec<u8> {
        let mut message = Vec::new();
        message.push(tag);
        message.extend_from_slice(&((body.len() + 4) as i32).to_be_bytes());
        message.extend_from_slice(body);
        message
    }
}

#[cfg(test)]
mod query_fixture_tests;
