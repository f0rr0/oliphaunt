use std::collections::HashMap;
use std::str::FromStr;
use std::sync::Arc;
use std::sync::LazyLock;

use anyhow::{Result, anyhow};
use serde_json::{Value, json};

use super::interface::{ParserMap, Serializer, SerializerMap, TypeParser};

macro_rules! const_oid {
    ($name:ident = $value:expr) => {
        pub const $name: i32 = $value;
    };
}

const_oid!(BOOL = 16);
const_oid!(BYTEA = 17);
const_oid!(CHAR = 18);
const_oid!(INT8 = 20);
const_oid!(INT2 = 21);
const_oid!(INT4 = 23);
const_oid!(TEXT = 25);
const_oid!(OID = 26);
const_oid!(JSON = 114);
const_oid!(FLOAT4 = 700);
const_oid!(FLOAT8 = 701);
const_oid!(DATE = 1082);
const_oid!(TIMESTAMP = 1114);
const_oid!(TIMESTAMPTZ = 1184);
const_oid!(NUMERIC = 1700);
const_oid!(UUID = 2950);
const_oid!(JSONB = 3802);

pub static DEFAULT_PARSERS: LazyLock<ParserMap> = LazyLock::new(build_default_parsers);
pub static DEFAULT_SERIALIZERS: LazyLock<SerializerMap> = LazyLock::new(build_default_serializers);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ArrayTypeInfo {
    pub element_oid: i32,
    pub array_oid: i32,
    pub delimiter: char,
}

impl ArrayTypeInfo {
    pub const fn new(element_oid: i32, array_oid: i32, delimiter: char) -> Self {
        Self {
            element_oid,
            array_oid,
            delimiter,
        }
    }
}

pub struct ParserLookup<'a> {
    defaults: &'a ParserMap,
    overrides: &'a ParserMap,
}

impl<'a> ParserLookup<'a> {
    pub fn new(defaults: &'a ParserMap, overrides: &'a ParserMap) -> Self {
        Self {
            defaults,
            overrides,
        }
    }

    pub fn apply(&self, text: &str, type_id: i32) -> Value {
        let parser = self
            .overrides
            .get(&type_id)
            .or_else(|| self.defaults.get(&type_id));
        if let Some(parser) = parser {
            parser(text, type_id)
        } else {
            json!(text)
        }
    }
}

pub fn serialize_array_value(
    value: &Value,
    element_serializer: Option<Serializer>,
    delimiter: char,
) -> Result<String> {
    match value {
        Value::Array(items) => {
            if items.is_empty() {
                return Ok("{}".to_string());
            }

            let mut parts = Vec::with_capacity(items.len());
            for item in items {
                match item {
                    Value::Null => parts.push("null".to_string()),
                    Value::Array(_) => {
                        parts.push(serialize_array_value(
                            item,
                            element_serializer.clone(),
                            delimiter,
                        )?);
                    }
                    _ => {
                        let raw = if let Some(serializer) = element_serializer.as_ref() {
                            serializer(item)?
                        } else {
                            value_to_string(item)
                        };
                        let escaped = raw.replace('\\', "\\\\").replace('"', "\\\"");
                        parts.push(format!("\"{}\"", escaped));
                    }
                }
            }
            let joined = parts.join(&delimiter.to_string());
            Ok(format!("{{{}}}", joined))
        }
        Value::Null => Ok("null".to_string()),
        _ => Ok(value_to_string(value)),
    }
}

fn value_to_string(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        Value::Bool(b) => {
            if *b {
                "t".to_string()
            } else {
                "f".to_string()
            }
        }
        Value::Null => "null".to_string(),
        Value::Array(_) => value.to_string(),
        _ => value.to_string(),
    }
}

pub fn parse_array_text(
    text: &str,
    element_parser: Option<TypeParser>,
    element_type_id: i32,
    delimiter: char,
) -> Value {
    let Some(start) = text.find('{') else {
        return Value::Array(Vec::new());
    };
    let mut parser = ArrayTextParser {
        text,
        index: start,
        element_parser: element_parser.as_ref(),
        element_type_id,
        delimiter,
    };
    parser.parse_array()
}

struct ArrayTextParser<'a> {
    text: &'a str,
    index: usize,
    element_parser: Option<&'a TypeParser>,
    element_type_id: i32,
    delimiter: char,
}

impl ArrayTextParser<'_> {
    fn parse_array(&mut self) -> Value {
        if self.peek() != Some('{') {
            return Value::Array(Vec::new());
        }
        self.advance();

        let mut values = Vec::new();
        loop {
            match self.peek() {
                Some('}') => {
                    self.advance();
                    return Value::Array(values);
                }
                Some('{') => values.push(self.parse_array()),
                Some('"') => values.push(self.parse_quoted()),
                Some(_) => values.push(self.parse_unquoted()),
                None => return Value::Array(values),
            }

            match self.peek() {
                Some(ch) if ch == self.delimiter => {
                    self.advance();
                }
                Some('}') => {}
                Some(_) | None => {}
            }
        }
    }

    fn parse_quoted(&mut self) -> Value {
        self.advance();
        let mut value = String::new();

        while let Some(ch) = self.peek() {
            self.advance();
            match ch {
                '\\' => {
                    if let Some(escaped) = self.peek() {
                        self.advance();
                        value.push(escaped);
                    }
                }
                '"' => {
                    return apply_element_parser(
                        &value,
                        self.element_parser,
                        self.element_type_id,
                        true,
                    );
                }
                other => value.push(other),
            }
        }

        apply_element_parser(&value, self.element_parser, self.element_type_id, true)
    }

    fn parse_unquoted(&mut self) -> Value {
        let start = self.index;
        while let Some(ch) = self.peek() {
            if ch == self.delimiter || ch == '}' {
                break;
            }
            self.advance();
        }

        let slice = self.text[start..self.index].trim();
        apply_element_parser(slice, self.element_parser, self.element_type_id, false)
    }

    fn peek(&self) -> Option<char> {
        self.text[self.index..].chars().next()
    }

    fn advance(&mut self) {
        if let Some(ch) = self.peek() {
            self.index += ch.len_utf8();
        }
    }
}

fn apply_element_parser(
    slice: &str,
    parser: Option<&TypeParser>,
    element_type_id: i32,
    quoted: bool,
) -> Value {
    if let Some(p) = parser {
        p(slice, element_type_id)
    } else if !quoted && slice.eq_ignore_ascii_case("NULL") {
        Value::Null
    } else {
        Value::String(slice.to_string())
    }
}

fn build_default_parsers() -> ParserMap {
    let mut map: ParserMap = HashMap::new();

    map.insert(
        TEXT,
        Arc::new(|value: &str, _| json!(value.to_string())) as TypeParser,
    );
    map.insert(CHAR, Arc::new(|value: &str, _| json!(value.to_string())));

    map.insert(INT2, Arc::new(|value: &str, _| parse_int(value)));
    map.insert(INT4, Arc::new(|value: &str, _| parse_int(value)));
    map.insert(INT8, Arc::new(|value: &str, _| parse_bigint(value)));
    map.insert(OID, Arc::new(|value: &str, _| parse_int(value)));
    map.insert(NUMERIC, Arc::new(|value: &str, _| parse_numeric(value)));

    map.insert(FLOAT4, Arc::new(|value: &str, _| parse_float(value)));
    map.insert(FLOAT8, Arc::new(|value: &str, _| parse_float(value)));

    map.insert(BOOL, Arc::new(|value: &str, _| json!(value == "t")));

    map.insert(JSON, Arc::new(|value: &str, _| parse_json(value)));
    map.insert(JSONB, Arc::new(|value: &str, _| parse_json(value)));

    map.insert(BYTEA, Arc::new(|value: &str, _| parse_bytea(value)));

    map.insert(UUID, Arc::new(|value: &str, _| json!(value.to_string())));

    map.insert(
        TIMESTAMP,
        Arc::new(|value: &str, _| json!(value.to_string())),
    );
    map.insert(
        TIMESTAMPTZ,
        Arc::new(|value: &str, _| json!(value.to_string())),
    );
    map.insert(DATE, Arc::new(|value: &str, _| json!(value.to_string())));

    register_builtin_array_parsers(&mut map);
    map
}

fn build_default_serializers() -> SerializerMap {
    let mut map: SerializerMap = HashMap::new();

    map.insert(
        TEXT,
        Arc::new(|value: &Value| serialize_string(value)) as Serializer,
    );
    map.insert(CHAR, Arc::new(|value: &Value| serialize_string(value)));

    map.insert(INT2, Arc::new(|value: &Value| serialize_number(value)));
    map.insert(INT4, Arc::new(|value: &Value| serialize_number(value)));
    map.insert(INT8, Arc::new(|value: &Value| serialize_number(value)));
    map.insert(OID, Arc::new(|value: &Value| serialize_number(value)));
    map.insert(NUMERIC, Arc::new(|value: &Value| serialize_number(value)));
    map.insert(FLOAT4, Arc::new(|value: &Value| serialize_number(value)));
    map.insert(FLOAT8, Arc::new(|value: &Value| serialize_number(value)));

    map.insert(BOOL, Arc::new(|value: &Value| serialize_bool(value)));
    map.insert(JSON, Arc::new(|value: &Value| serialize_json(value)));
    map.insert(JSONB, Arc::new(|value: &Value| serialize_json(value)));
    map.insert(BYTEA, Arc::new(|value: &Value| serialize_bytea(value)));
    map.insert(UUID, Arc::new(|value: &Value| serialize_string(value)));
    map.insert(TIMESTAMP, Arc::new(|value: &Value| serialize_string(value)));
    map.insert(
        TIMESTAMPTZ,
        Arc::new(|value: &Value| serialize_string(value)),
    );
    map.insert(DATE, Arc::new(|value: &Value| serialize_string(value)));

    register_builtin_array_serializers(&mut map);
    map
}

pub fn register_array_type(
    parsers: &mut ParserMap,
    serializers: &mut SerializerMap,
    info: ArrayTypeInfo,
) {
    register_array_parser(parsers, info);
    register_array_serializer(serializers, info);
}

fn register_array_parser(parsers: &mut ParserMap, info: ArrayTypeInfo) {
    let element_parser = parsers.get(&info.element_oid).cloned();
    let element_oid = info.element_oid;
    let delimiter = info.delimiter;
    let array_parser: TypeParser = Arc::new(move |text: &str, _| {
        parse_array_text(text, element_parser.clone(), element_oid, delimiter)
    });
    parsers.insert(info.array_oid, array_parser);
}

fn register_array_serializer(serializers: &mut SerializerMap, info: ArrayTypeInfo) {
    let element_serializer = serializers.get(&info.element_oid).cloned();
    let delimiter = info.delimiter;
    let array_serializer: Serializer = Arc::new(move |value: &Value| {
        serialize_array_value(value, element_serializer.clone(), delimiter)
    });
    serializers.insert(info.array_oid, array_serializer);
}

fn register_builtin_array_parsers(parsers: &mut ParserMap) {
    for info in BUILTIN_ARRAY_TYPES {
        register_array_parser(parsers, *info);
    }
}

fn register_builtin_array_serializers(serializers: &mut SerializerMap) {
    for info in BUILTIN_ARRAY_TYPES {
        register_array_serializer(serializers, *info);
    }
}

// Generated from PostgreSQL's built-in pg_type.dat OID assignments for the
// default PGlite/Postgres 17 catalog. Keep this list to built-in types only:
// extension and runtime-created custom arrays are discovered through the direct
// client type cache when they are actually used.
const BUILTIN_ARRAY_TYPES: &[ArrayTypeInfo] = &[
    ArrayTypeInfo::new(16, 1000, ','),
    ArrayTypeInfo::new(17, 1001, ','),
    ArrayTypeInfo::new(18, 1002, ','),
    ArrayTypeInfo::new(19, 1003, ','),
    ArrayTypeInfo::new(20, 1016, ','),
    ArrayTypeInfo::new(21, 1005, ','),
    ArrayTypeInfo::new(22, 1006, ','),
    ArrayTypeInfo::new(23, 1007, ','),
    ArrayTypeInfo::new(24, 1008, ','),
    ArrayTypeInfo::new(25, 1009, ','),
    ArrayTypeInfo::new(26, 1028, ','),
    ArrayTypeInfo::new(27, 1010, ','),
    ArrayTypeInfo::new(28, 1011, ','),
    ArrayTypeInfo::new(29, 1012, ','),
    ArrayTypeInfo::new(30, 1013, ','),
    ArrayTypeInfo::new(114, 199, ','),
    ArrayTypeInfo::new(142, 143, ','),
    ArrayTypeInfo::new(600, 1017, ','),
    ArrayTypeInfo::new(601, 1018, ','),
    ArrayTypeInfo::new(602, 1019, ','),
    ArrayTypeInfo::new(603, 1020, ';'),
    ArrayTypeInfo::new(604, 1027, ','),
    ArrayTypeInfo::new(628, 629, ','),
    ArrayTypeInfo::new(700, 1021, ','),
    ArrayTypeInfo::new(701, 1022, ','),
    ArrayTypeInfo::new(718, 719, ','),
    ArrayTypeInfo::new(790, 791, ','),
    ArrayTypeInfo::new(829, 1040, ','),
    ArrayTypeInfo::new(869, 1041, ','),
    ArrayTypeInfo::new(650, 651, ','),
    ArrayTypeInfo::new(774, 775, ','),
    ArrayTypeInfo::new(1033, 1034, ','),
    ArrayTypeInfo::new(1042, 1014, ','),
    ArrayTypeInfo::new(1043, 1015, ','),
    ArrayTypeInfo::new(1082, 1182, ','),
    ArrayTypeInfo::new(1083, 1183, ','),
    ArrayTypeInfo::new(1114, 1115, ','),
    ArrayTypeInfo::new(1184, 1185, ','),
    ArrayTypeInfo::new(1186, 1187, ','),
    ArrayTypeInfo::new(1266, 1270, ','),
    ArrayTypeInfo::new(1560, 1561, ','),
    ArrayTypeInfo::new(1562, 1563, ','),
    ArrayTypeInfo::new(1700, 1231, ','),
    ArrayTypeInfo::new(1790, 2201, ','),
    ArrayTypeInfo::new(2202, 2207, ','),
    ArrayTypeInfo::new(2203, 2208, ','),
    ArrayTypeInfo::new(2204, 2209, ','),
    ArrayTypeInfo::new(2205, 2210, ','),
    ArrayTypeInfo::new(4191, 4192, ','),
    ArrayTypeInfo::new(2206, 2211, ','),
    ArrayTypeInfo::new(4096, 4097, ','),
    ArrayTypeInfo::new(4089, 4090, ','),
    ArrayTypeInfo::new(2950, 2951, ','),
    ArrayTypeInfo::new(3220, 3221, ','),
    ArrayTypeInfo::new(3614, 3643, ','),
    ArrayTypeInfo::new(3642, 3644, ','),
    ArrayTypeInfo::new(3615, 3645, ','),
    ArrayTypeInfo::new(3734, 3735, ','),
    ArrayTypeInfo::new(3769, 3770, ','),
    ArrayTypeInfo::new(3802, 3807, ','),
    ArrayTypeInfo::new(4072, 4073, ','),
    ArrayTypeInfo::new(2970, 2949, ','),
    ArrayTypeInfo::new(5038, 5039, ','),
    ArrayTypeInfo::new(3904, 3905, ','),
    ArrayTypeInfo::new(3906, 3907, ','),
    ArrayTypeInfo::new(3908, 3909, ','),
    ArrayTypeInfo::new(3910, 3911, ','),
    ArrayTypeInfo::new(3912, 3913, ','),
    ArrayTypeInfo::new(3926, 3927, ','),
    ArrayTypeInfo::new(4451, 6150, ','),
    ArrayTypeInfo::new(4532, 6151, ','),
    ArrayTypeInfo::new(4533, 6152, ','),
    ArrayTypeInfo::new(4534, 6153, ','),
    ArrayTypeInfo::new(4535, 6155, ','),
    ArrayTypeInfo::new(4536, 6157, ','),
    ArrayTypeInfo::new(2275, 1263, ','),
];

fn parse_int(value: &str) -> Value {
    match value.parse::<i64>() {
        Ok(int) => json!(int),
        Err(_) => json!(value.to_string()),
    }
}

fn parse_bigint(value: &str) -> Value {
    match value.parse::<i128>() {
        Ok(int) => json!(int),
        Err(_) => json!(value.to_string()),
    }
}

fn parse_numeric(value: &str) -> Value {
    serde_json::Number::from_str(value)
        .map(Value::Number)
        .unwrap_or_else(|_| json!(value.to_string()))
}

fn parse_float(value: &str) -> Value {
    match value.parse::<f64>() {
        Ok(float) => json!(float),
        Err(_) => json!(value.to_string()),
    }
}

fn parse_json(value: &str) -> Value {
    serde_json::from_str(value).unwrap_or_else(|_| json!(value.to_string()))
}

fn parse_bytea(value: &str) -> Value {
    value
        .strip_prefix("\\x")
        .and_then(|hex| hex::decode(hex).ok())
        .map(Value::from)
        .unwrap_or_else(|| json!(value.to_string()))
}

fn serialize_string(value: &Value) -> Result<String> {
    match value {
        Value::String(s) => Ok(s.clone()),
        other => Ok(other.to_string()),
    }
}

fn serialize_number(value: &Value) -> Result<String> {
    match value {
        Value::Number(num) => Ok(num.to_string()),
        Value::String(s) => Ok(s.clone()),
        other => Err(anyhow!("cannot serialize value {other} as number")),
    }
}

fn serialize_bool(value: &Value) -> Result<String> {
    match value {
        Value::Bool(b) => Ok(if *b { "t" } else { "f" }.to_string()),
        Value::Number(num) => Ok(if num.as_i64().unwrap_or(0) != 0 {
            "t"
        } else {
            "f"
        }
        .to_string()),
        Value::String(s) => Ok(match s.as_ref() {
            "true" | "t" | "1" => "t".to_string(),
            _ => "f".to_string(),
        }),
        other => Err(anyhow!("cannot serialize value {other} as boolean")),
    }
}

fn serialize_json(value: &Value) -> Result<String> {
    if let Some(value) = value.as_str() {
        Ok(value.to_string())
    } else {
        serde_json::to_string(value).map_err(|err| anyhow!(err))
    }
}

fn serialize_bytea(value: &Value) -> Result<String> {
    match value {
        Value::String(s) => Ok(s.clone()),
        Value::Array(arr) => {
            let bytes: Vec<u8> = arr
                .iter()
                .filter_map(|v| v.as_u64().map(|n| n as u8))
                .collect();
            Ok(format!("\\x{}", hex::encode(bytes)))
        }
        Value::Null => Ok("\\x".to_string()),
        _ => Err(anyhow!("unsupported value for bytea serialization")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_multidimensional_arrays_without_separator_artifacts() {
        let parser: TypeParser = Arc::new(|value, _| parse_float(value));
        let parsed = parse_array_text("{{1.5,2.5},{3.5,4.5}}", Some(parser), FLOAT8, ',');
        assert_eq!(parsed, json!([[1.5, 2.5], [3.5, 4.5]]));
    }

    #[test]
    fn parses_quoted_array_values_and_unquoted_nulls() {
        let parsed = parse_array_text(
            r#"{"comma,value","quote \" value",NULL,"NULL",""}"#,
            None,
            TEXT,
            ',',
        );
        assert_eq!(
            parsed,
            json!(["comma,value", "quote \" value", null, "NULL", ""])
        );
    }
}
