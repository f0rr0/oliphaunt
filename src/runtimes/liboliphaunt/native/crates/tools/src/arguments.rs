const PG_DUMP_SHORT_OPTIONS: &str = "abBcCd:e:E:f:F:h:j:n:N:Op:RsS:t:T:U:vwWxXZ:";
const PSQL_SHORT_OPTIONS: &str = "aAbc:d:eEf:F:h:HlL:no:p:P:qR:sStT:U:v:VwWxXz?01";
const PG_DUMP_VALUE_OPTIONS: &[&str] = &[
    "--extension",
    "--schema",
    "--exclude-schema",
    "--superuser",
    "--table",
    "--exclude-table",
    "--exclude-table-data",
    "--extra-float-digits",
    "--lock-wait-timeout",
    "--role",
    "--section",
    "--snapshot",
    "--rows-per-insert",
    "--include-foreign-data",
    "--table-and-children",
    "--exclude-table-and-children",
    "--exclude-table-data-and-children",
    "--sync-method",
    "--exclude-extension",
    "--restrict-key",
];
const PSQL_VALUE_OPTIONS: &[&str] = &[
    "--field-separator",
    "--pset",
    "--record-separator",
    "--table-attr",
    "--set",
    "--variable",
];

pub(crate) fn validate_pg_dump_arguments(arguments: &[String]) -> Result<(), String> {
    validate_arguments(
        arguments,
        disallowed_pg_dump_flag,
        PG_DUMP_SHORT_OPTIONS,
        PG_DUMP_VALUE_OPTIONS,
    )
}

pub(crate) fn validate_psql_arguments(arguments: &[String]) -> Result<(), String> {
    validate_arguments(
        arguments,
        disallowed_psql_flag,
        PSQL_SHORT_OPTIONS,
        PSQL_VALUE_OPTIONS,
    )
}

fn validate_arguments(
    arguments: &[String],
    disallowed: fn(&str) -> Option<&'static str>,
    short_options: &str,
    value_options: &[&str],
) -> Result<(), String> {
    let mut expects_value = false;
    for argument in arguments {
        if argument.as_bytes().contains(&0) {
            return Err("argument must not contain NUL bytes".to_owned());
        }
        if expects_value {
            expects_value = false;
            continue;
        }
        if let Some(managed) = disallowed(argument) {
            return Err(format!(
                "argument {argument:?} conflicts with Oliphaunt-managed {managed}"
            ));
        }
        if argument == "-" || !argument.starts_with('-') {
            return Err(format!(
                "argument {argument:?} conflicts with Oliphaunt-managed database or username"
            ));
        }
        expects_value = option_consumes_next(argument, short_options, value_options);
    }
    if expects_value {
        return Err(format!(
            "argument {:?} requires a value",
            arguments.last().expect("a pending option has an argument")
        ));
    }
    Ok(())
}

fn option_consumes_next(argument: &str, short_options: &str, value_options: &[&str]) -> bool {
    if argument.starts_with("--") {
        return !argument.contains('=')
            && value_options
                .iter()
                .any(|option| option.starts_with(argument));
    }
    let bytes = argument.as_bytes();
    let option_spec = short_options.as_bytes();
    for (index, option) in bytes[1..].iter().enumerate() {
        let Some(position) = option_spec.iter().position(|candidate| candidate == option) else {
            return false;
        };
        if option_spec.get(position + 1) == Some(&b':') {
            return index + 2 == bytes.len();
        }
    }
    false
}

fn disallowed_pg_dump_flag(argument: &str) -> Option<&'static str> {
    if argument == "--" {
        return Some("option terminator");
    }
    disallowed_flag(
        argument,
        &[
            ("--filter", "input file"),
            ("--file", "output"),
            ("--format", "plain format"),
            ("--compress", "compression"),
            ("--encoding", "UTF-8 encoding"),
            ("--host", "connection"),
            ("--port", "connection"),
            ("--username", "connection"),
            ("--dbname", "connection"),
            ("--jobs", "job count"),
            ("--password", "password prompting"),
        ],
        &[
            ("-f", "output"),
            ("-F", "plain format"),
            ("-Z", "compression"),
            ("-E", "UTF-8 encoding"),
            ("-h", "connection"),
            ("-p", "connection"),
            ("-U", "connection"),
            ("-d", "connection"),
            ("-j", "job count"),
            ("-W", "password prompting"),
        ],
        PG_DUMP_SHORT_OPTIONS,
    )
}

fn disallowed_psql_flag(argument: &str) -> Option<&'static str> {
    if argument == "--" {
        return Some("option terminator");
    }
    disallowed_flag(
        argument,
        &[
            ("--single-step", "interactive prompting"),
            ("--host", "connection"),
            ("--port", "connection"),
            ("--username", "connection"),
            ("--dbname", "connection"),
            ("--output", "stdout capture"),
            ("--log-file", "stderr capture"),
            ("--command", "input"),
            ("--file", "input"),
            ("--password", "password prompting"),
        ],
        &[
            ("-s", "interactive prompting"),
            ("-h", "connection"),
            ("-p", "connection"),
            ("-U", "connection"),
            ("-d", "connection"),
            ("-o", "stdout capture"),
            ("-L", "stderr capture"),
            ("-c", "input"),
            ("-f", "input"),
            ("-W", "password prompting"),
        ],
        PSQL_SHORT_OPTIONS,
    )
}

fn disallowed_flag(
    argument: &str,
    long: &[(&'static str, &'static str)],
    short: &[(&'static str, &'static str)],
    short_options: &str,
) -> Option<&'static str> {
    let long_name = argument.split_once('=').map_or(argument, |(name, _)| name);
    for (flag, label) in long {
        // Native getopt_long accepts unique prefixes while PostgreSQL's
        // bundled fallback requires exact names. Reject either spelling
        // consistently so a managed option cannot become host-dependent.
        if long_name.len() > 2 && long_name.starts_with("--") && flag.starts_with(long_name) {
            return Some(label);
        }
    }
    let bytes = argument.as_bytes();
    if bytes.len() < 2 || bytes[0] != b'-' || bytes[1] == b'-' {
        return None;
    }
    let option_spec = short_options.as_bytes();
    for option in &bytes[1..] {
        let position = option_spec
            .iter()
            .position(|candidate| candidate == option)?;
        if let Some((_, label)) = short
            .iter()
            .find(|(flag, _)| flag.as_bytes() == [b'-', *option])
        {
            return Some(label);
        }
        if option_spec.get(position + 1) == Some(&b':') {
            return None;
        }
    }
    None
}
