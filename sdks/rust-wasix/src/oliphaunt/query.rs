use anyhow::{Result, anyhow};

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
mod tests {
    use super::*;
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

    fn backend_message(tag: u8, body: &[u8]) -> Vec<u8> {
        let mut message = Vec::new();
        message.push(tag);
        message.extend_from_slice(&((body.len() + 4) as i32).to_be_bytes());
        message.extend_from_slice(body);
        message
    }
}
