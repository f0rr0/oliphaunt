// Runtime-neutral PostgreSQL query protocol core shared by the Rust SDKs.
//
// This module deliberately has no dependencies outside `std`. It owns the
// public query data model and diagnostics re-exported by both Rust facades;
// runtime-specific request transport and outer error mapping stay at the
// facade boundary.

use std::sync::Arc;
use std::{fmt, str};

/// PostgreSQL object identifier used for parameter and result types.
#[repr(transparent)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct TypeOid(u32);

impl TypeOid {
    /// PostgreSQL bool.
    pub const BOOL: Self = Self(16);
    /// PostgreSQL bytea.
    pub const BYTEA: Self = Self(17);
    /// PostgreSQL internal single-byte char.
    pub const CHAR: Self = Self(18);
    /// PostgreSQL name.
    pub const NAME: Self = Self(19);
    /// PostgreSQL int8.
    pub const INT8: Self = Self(20);
    /// PostgreSQL int2.
    pub const INT2: Self = Self(21);
    /// PostgreSQL int4.
    pub const INT4: Self = Self(23);
    /// PostgreSQL text.
    pub const TEXT: Self = Self(25);
    /// PostgreSQL oid.
    pub const OID: Self = Self(26);
    /// PostgreSQL json.
    pub const JSON: Self = Self(114);
    /// PostgreSQL xml.
    pub const XML: Self = Self(142);
    /// PostgreSQL xml array.
    pub const XML_ARRAY: Self = Self(143);
    /// PostgreSQL json array.
    pub const JSON_ARRAY: Self = Self(199);
    /// PostgreSQL float4.
    pub const FLOAT4: Self = Self(700);
    /// PostgreSQL float8.
    pub const FLOAT8: Self = Self(701);
    /// PostgreSQL pseudo-type unknown.
    pub const UNKNOWN: Self = Self(705);
    /// PostgreSQL bool array.
    pub const BOOL_ARRAY: Self = Self(1000);
    /// PostgreSQL bytea array.
    pub const BYTEA_ARRAY: Self = Self(1001);
    /// PostgreSQL internal single-byte char array.
    pub const CHAR_ARRAY: Self = Self(1002);
    /// PostgreSQL name array.
    pub const NAME_ARRAY: Self = Self(1003);
    /// PostgreSQL int2 array.
    pub const INT2_ARRAY: Self = Self(1005);
    /// PostgreSQL int4 array.
    pub const INT4_ARRAY: Self = Self(1007);
    /// PostgreSQL text array.
    pub const TEXT_ARRAY: Self = Self(1009);
    /// PostgreSQL bpchar array.
    pub const BPCHAR_ARRAY: Self = Self(1014);
    /// PostgreSQL varchar array.
    pub const VARCHAR_ARRAY: Self = Self(1015);
    /// PostgreSQL int8 array.
    pub const INT8_ARRAY: Self = Self(1016);
    /// PostgreSQL float4 array.
    pub const FLOAT4_ARRAY: Self = Self(1021);
    /// PostgreSQL float8 array.
    pub const FLOAT8_ARRAY: Self = Self(1022);
    /// PostgreSQL oid array.
    pub const OID_ARRAY: Self = Self(1028);
    /// PostgreSQL bpchar.
    pub const BPCHAR: Self = Self(1042);
    /// PostgreSQL varchar.
    pub const VARCHAR: Self = Self(1043);
    /// PostgreSQL date.
    pub const DATE: Self = Self(1082);
    /// PostgreSQL time without time zone.
    pub const TIME: Self = Self(1083);
    /// PostgreSQL timestamp without time zone.
    pub const TIMESTAMP: Self = Self(1114);
    /// PostgreSQL timestamp array.
    pub const TIMESTAMP_ARRAY: Self = Self(1115);
    /// PostgreSQL date array.
    pub const DATE_ARRAY: Self = Self(1182);
    /// PostgreSQL time array.
    pub const TIME_ARRAY: Self = Self(1183);
    /// PostgreSQL timestamp with time zone.
    pub const TIMESTAMPTZ: Self = Self(1184);
    /// PostgreSQL timestamptz array.
    pub const TIMESTAMPTZ_ARRAY: Self = Self(1185);
    /// PostgreSQL interval.
    pub const INTERVAL: Self = Self(1186);
    /// PostgreSQL interval array.
    pub const INTERVAL_ARRAY: Self = Self(1187);
    /// PostgreSQL numeric array.
    pub const NUMERIC_ARRAY: Self = Self(1231);
    /// PostgreSQL time with time zone.
    pub const TIMETZ: Self = Self(1266);
    /// PostgreSQL timetz array.
    pub const TIMETZ_ARRAY: Self = Self(1270);
    /// PostgreSQL numeric.
    pub const NUMERIC: Self = Self(1700);
    /// PostgreSQL uuid.
    pub const UUID: Self = Self(2950);
    /// PostgreSQL uuid array.
    pub const UUID_ARRAY: Self = Self(2951);
    /// PostgreSQL jsonb.
    pub const JSONB: Self = Self(3802);
    /// PostgreSQL jsonb array.
    pub const JSONB_ARRAY: Self = Self(3807);

    /// Construct an OID, including an extension or application-defined type OID.
    pub const fn new(oid: u32) -> Self {
        Self(oid)
    }

    /// Return the numeric PostgreSQL OID.
    pub const fn get(self) -> u32 {
        self.0
    }
}

impl From<u32> for TypeOid {
    fn from(value: u32) -> Self {
        Self::new(value)
    }
}

impl From<TypeOid> for u32 {
    fn from(value: TypeOid) -> Self {
        value.get()
    }
}

/// PostgreSQL text or binary value format.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ValueFormat {
    /// PostgreSQL text representation.
    Text,
    /// PostgreSQL binary representation.
    Binary,
}

impl ValueFormat {
    pub(crate) fn code(self) -> i16 {
        match self {
            Self::Text => 0,
            Self::Binary => 1,
        }
    }
}

/// Owned, optionally typed PostgreSQL bind parameter.
///
/// An absent type OID asks PostgreSQL to infer the parameter type. A None
/// value is SQL NULL; it is independent of the parameter format and type hint.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Parameter {
    type_oid: Option<TypeOid>,
    format: ValueFormat,
    value: Option<Vec<u8>>,
}

impl Parameter {
    /// Construct an untyped SQL NULL whose type PostgreSQL will infer.
    pub fn null() -> Self {
        Self {
            type_oid: None,
            format: ValueFormat::Text,
            value: None,
        }
    }

    /// Construct an untyped text-format value.
    pub fn text(value: impl Into<String>) -> Self {
        Self {
            type_oid: None,
            format: ValueFormat::Text,
            value: Some(value.into().into_bytes()),
        }
    }

    /// Construct an untyped binary-format value.
    pub fn binary(value: impl Into<Vec<u8>>) -> Self {
        Self {
            type_oid: None,
            format: ValueFormat::Binary,
            value: Some(value.into()),
        }
    }

    /// Attach an explicit PostgreSQL type OID.
    ///
    /// OID 0 is PostgreSQL's inference sentinel. It is accepted when describing
    /// a statement, but execution rejects an explicitly attached zero; leave
    /// the OID unset to request execution-time inference.
    pub fn with_type_oid(mut self, type_oid: TypeOid) -> Self {
        self.type_oid = Some(type_oid);
        self
    }

    /// Construct a typed SQL NULL.
    pub fn typed_null(type_oid: TypeOid) -> Self {
        Self::null().with_type_oid(type_oid)
    }

    /// Construct a typed text-format value.
    pub fn typed_text(type_oid: TypeOid, value: impl Into<String>) -> Self {
        Self::text(value).with_type_oid(type_oid)
    }

    /// Construct a typed binary-format value.
    pub fn typed_binary(type_oid: TypeOid, value: impl Into<Vec<u8>>) -> Self {
        Self::binary(value).with_type_oid(type_oid)
    }

    /// Return the declared PostgreSQL type, or None for server inference.
    pub fn type_oid(&self) -> Option<TypeOid> {
        self.type_oid
    }

    /// Return the frontend parameter format.
    pub fn format(&self) -> ValueFormat {
        self.format
    }

    /// Return the encoded bytes, or None for SQL NULL.
    pub fn value(&self) -> Option<&[u8]> {
        self.value.as_deref()
    }
}

/// Conversion into an owned, typed PostgreSQL bind parameter.
pub trait IntoParameter: Sized {
    /// Type OID retained when `Option<Self>` is bound as SQL NULL.
    const TYPE_OID: Option<TypeOid>;

    /// Encode this value as one PostgreSQL parameter.
    fn into_parameter(self) -> Parameter;
}

impl IntoParameter for Parameter {
    const TYPE_OID: Option<TypeOid> = None;

    fn into_parameter(self) -> Parameter {
        self
    }
}

impl IntoParameter for &str {
    const TYPE_OID: Option<TypeOid> = Some(TypeOid::TEXT);

    fn into_parameter(self) -> Parameter {
        Parameter::typed_text(TypeOid::TEXT, self)
    }
}

impl IntoParameter for String {
    const TYPE_OID: Option<TypeOid> = Some(TypeOid::TEXT);

    fn into_parameter(self) -> Parameter {
        Parameter::typed_text(TypeOid::TEXT, self)
    }
}

impl IntoParameter for &String {
    const TYPE_OID: Option<TypeOid> = Some(TypeOid::TEXT);

    fn into_parameter(self) -> Parameter {
        Parameter::typed_text(TypeOid::TEXT, self)
    }
}

macro_rules! binary_parameter {
    ($type:ty, $oid:expr, $encode:expr) => {
        impl IntoParameter for $type {
            const TYPE_OID: Option<TypeOid> = Some($oid);

            fn into_parameter(self) -> Parameter {
                Parameter::typed_binary($oid, $encode(self))
            }
        }
    };
}

binary_parameter!(i16, TypeOid::INT2, i16::to_be_bytes);
binary_parameter!(i32, TypeOid::INT4, i32::to_be_bytes);
binary_parameter!(i64, TypeOid::INT8, i64::to_be_bytes);
binary_parameter!(f32, TypeOid::FLOAT4, |value: f32| value
    .to_bits()
    .to_be_bytes());
binary_parameter!(f64, TypeOid::FLOAT8, |value: f64| value
    .to_bits()
    .to_be_bytes());

impl IntoParameter for bool {
    const TYPE_OID: Option<TypeOid> = Some(TypeOid::BOOL);

    fn into_parameter(self) -> Parameter {
        Parameter::typed_binary(TypeOid::BOOL, [u8::from(self)])
    }
}

impl IntoParameter for &[u8] {
    const TYPE_OID: Option<TypeOid> = Some(TypeOid::BYTEA);

    fn into_parameter(self) -> Parameter {
        Parameter::typed_binary(TypeOid::BYTEA, self)
    }
}

impl IntoParameter for Vec<u8> {
    const TYPE_OID: Option<TypeOid> = Some(TypeOid::BYTEA);

    fn into_parameter(self) -> Parameter {
        Parameter::typed_binary(TypeOid::BYTEA, self)
    }
}

impl<T> IntoParameter for Option<T>
where
    T: IntoParameter,
{
    const TYPE_OID: Option<TypeOid> = T::TYPE_OID;

    fn into_parameter(self) -> Parameter {
        self.map(IntoParameter::into_parameter)
            .unwrap_or_else(|| match Self::TYPE_OID {
                Some(type_oid) => Parameter::typed_null(type_oid),
                None => Parameter::null(),
            })
    }
}

/// Metadata for one PostgreSQL result column.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QueryField {
    /// Column name.
    pub name: String,
    /// Table OID reported by PostgreSQL, or 0 when not tied to a table.
    pub table_oid: u32,
    /// Table attribute number reported by PostgreSQL.
    pub table_attribute: i16,
    /// PostgreSQL type OID.
    pub type_oid: u32,
    /// PostgreSQL type size.
    pub type_size: i16,
    /// PostgreSQL type modifier.
    pub type_modifier: i32,
    /// Format used for values in this column.
    pub format: QueryFormat,
}

impl QueryField {
    /// PostgreSQL type OID as the typed API value.
    pub fn type_oid_value(&self) -> TypeOid {
        TypeOid::new(self.type_oid)
    }
}

/// PostgreSQL result-column value format.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QueryFormat {
    /// Text format.
    Text,
    /// Binary format.
    Binary,
    /// Unknown or extension format code.
    Other(i16),
}

impl QueryFormat {
    fn value_format(self) -> Option<ValueFormat> {
        match self {
            Self::Text => Some(ValueFormat::Text),
            Self::Binary => Some(ValueFormat::Binary),
            Self::Other(_) => None,
        }
    }
}

impl From<i16> for QueryFormat {
    fn from(value: i16) -> Self {
        match value {
            0 => Self::Text,
            1 => Self::Binary,
            other => Self::Other(other),
        }
    }
}

/// Fallible row-column index accepted by row decoding APIs.
pub trait RowIndex {
    /// Resolve this index against result field metadata.
    fn resolve(&self, fields: &[QueryField]) -> std::result::Result<usize, DecodeError>;
}

impl RowIndex for usize {
    fn resolve(&self, fields: &[QueryField]) -> std::result::Result<usize, DecodeError> {
        if *self < fields.len() {
            Ok(*self)
        } else {
            Err(DecodeError::ColumnOutOfBounds {
                index: *self,
                len: fields.len(),
            })
        }
    }
}

impl RowIndex for str {
    fn resolve(&self, fields: &[QueryField]) -> std::result::Result<usize, DecodeError> {
        let mut matches = fields
            .iter()
            .enumerate()
            .filter_map(|(index, field)| (field.name == self).then_some(index));
        let first = matches
            .next()
            .ok_or_else(|| DecodeError::ColumnNotFound(self.to_owned()))?;
        if matches.next().is_some() {
            Err(DecodeError::AmbiguousColumn(self.to_owned()))
        } else {
            Ok(first)
        }
    }
}

impl RowIndex for &str {
    fn resolve(&self, fields: &[QueryField]) -> std::result::Result<usize, DecodeError> {
        <str as RowIndex>::resolve(self, fields)
    }
}

impl RowIndex for String {
    fn resolve(&self, fields: &[QueryField]) -> std::result::Result<usize, DecodeError> {
        <str as RowIndex>::resolve(self.as_str(), fields)
    }
}

impl RowIndex for &String {
    fn resolve(&self, fields: &[QueryField]) -> std::result::Result<usize, DecodeError> {
        <str as RowIndex>::resolve(self.as_str(), fields)
    }
}

/// Borrowed PostgreSQL value with its column metadata.
#[derive(Debug, Clone, Copy)]
pub struct ValueRef<'a> {
    column: usize,
    field: &'a QueryField,
    value: Option<&'a [u8]>,
}

impl<'a> ValueRef<'a> {
    pub(crate) fn new(column: usize, field: &'a QueryField, value: Option<&'a [u8]>) -> Self {
        Self {
            column,
            field,
            value,
        }
    }

    /// Zero-based column position.
    pub fn column(&self) -> usize {
        self.column
    }

    /// Column metadata.
    pub fn field(&self) -> &'a QueryField {
        self.field
    }

    /// PostgreSQL type OID.
    pub fn type_oid(&self) -> TypeOid {
        TypeOid::new(self.field.type_oid)
    }

    /// PostgreSQL result format, when recognized.
    pub fn format(&self) -> Option<ValueFormat> {
        self.field.format.value_format()
    }

    /// Whether this value is SQL NULL.
    pub fn is_null(&self) -> bool {
        self.value.is_none()
    }

    /// Borrow encoded value bytes, or None for SQL NULL.
    pub fn as_bytes(&self) -> Option<&'a [u8]> {
        self.value
    }

    fn require_bytes(self, target: &'static str) -> std::result::Result<&'a [u8], DecodeError> {
        self.value.ok_or(DecodeError::UnexpectedNull {
            column: self.column,
            target,
        })
    }
}

/// Decode one PostgreSQL value into a Rust type.
pub trait FromSql<'a>: Sized {
    /// Validate column metadata before decoding, including for SQL NULL.
    ///
    /// Custom decoders may leave the default when they accept arbitrary
    /// PostgreSQL types. Built-in decoders use this hook so `Option<T>` does
    /// not silently accept a null value of the wrong database type.
    fn check_type(_value: ValueRef<'_>) -> std::result::Result<(), DecodeError> {
        Ok(())
    }

    /// Decode a possibly-null text or binary value.
    fn from_sql(value: ValueRef<'a>) -> std::result::Result<Self, DecodeError>;
}

/// Error produced while locating or decoding a row value.
#[non_exhaustive]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DecodeError {
    /// No result column had the requested name.
    ColumnNotFound(String),
    /// More than one result column had the requested name.
    AmbiguousColumn(String),
    /// A positional index exceeded the row width.
    ColumnOutOfBounds {
        /// Requested index.
        index: usize,
        /// Number of result columns.
        len: usize,
    },
    /// SQL NULL cannot be decoded into the requested non-optional type.
    UnexpectedNull {
        /// Column index.
        column: usize,
        /// Requested Rust target.
        target: &'static str,
    },
    /// PostgreSQL returned a type incompatible with the requested Rust target.
    TypeMismatch {
        /// Column index.
        column: usize,
        /// Actual PostgreSQL type OID.
        type_oid: TypeOid,
        /// Requested Rust target.
        target: &'static str,
    },
    /// PostgreSQL returned an unsupported value format.
    UnsupportedFormat {
        /// Column index.
        column: usize,
        /// Raw PostgreSQL format code.
        format: i16,
    },
    /// Encoded bytes were not a valid value for the requested Rust target.
    InvalidValue {
        /// Column index.
        column: usize,
        /// Requested Rust target.
        target: &'static str,
        /// Decoder detail.
        message: String,
    },
}

impl fmt::Display for DecodeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ColumnNotFound(name) => {
                write!(formatter, "query result has no column named {name:?}")
            }
            Self::AmbiguousColumn(name) => write!(
                formatter,
                "query result has more than one column named {name:?}; use a positional index"
            ),
            Self::ColumnOutOfBounds { index, len } => write!(
                formatter,
                "query row has no column at index {index}; row has {len} columns"
            ),
            Self::UnexpectedNull { column, target } => {
                write!(
                    formatter,
                    "column {column} is NULL and cannot decode as {target}"
                )
            }
            Self::TypeMismatch {
                column,
                type_oid,
                target,
            } => write!(
                formatter,
                "column {column} has PostgreSQL type OID {} and cannot decode as {target}",
                type_oid.get()
            ),
            Self::UnsupportedFormat { column, format } => write!(
                formatter,
                "column {column} uses unsupported PostgreSQL format code {format}"
            ),
            Self::InvalidValue {
                column,
                target,
                message,
            } => write!(
                formatter,
                "column {column} could not decode as {target}: {message}"
            ),
        }
    }
}

impl std::error::Error for DecodeError {}

impl<'a> FromSql<'a> for &'a str {
    fn check_type(value: ValueRef<'_>) -> std::result::Result<(), DecodeError> {
        require_text_compatible(value, "&str")
    }

    fn from_sql(value: ValueRef<'a>) -> std::result::Result<Self, DecodeError> {
        Self::check_type(value)?;
        let raw = value.require_bytes("&str")?;
        str::from_utf8(raw).map_err(|error| DecodeError::InvalidValue {
            column: value.column,
            target: "&str",
            message: error.to_string(),
        })
    }
}

impl FromSql<'_> for String {
    fn check_type(value: ValueRef<'_>) -> std::result::Result<(), DecodeError> {
        <&str as FromSql>::check_type(value)
    }

    fn from_sql(value: ValueRef<'_>) -> std::result::Result<Self, DecodeError> {
        <&str as FromSql>::from_sql(value).map(str::to_owned)
    }
}

impl<'a> FromSql<'a> for &'a [u8] {
    fn check_type(value: ValueRef<'_>) -> std::result::Result<(), DecodeError> {
        require_type(value, TypeOid::BYTEA, "&[u8]")?;
        if value.format() == Some(ValueFormat::Binary) {
            Ok(())
        } else {
            invalid_value(
                value,
                "&[u8]",
                "borrowed bytea requires binary result format; use Vec<u8> for text bytea",
            )
        }
    }

    fn from_sql(value: ValueRef<'a>) -> std::result::Result<Self, DecodeError> {
        Self::check_type(value)?;
        value.require_bytes("&[u8]")
    }
}

impl FromSql<'_> for Vec<u8> {
    fn check_type(value: ValueRef<'_>) -> std::result::Result<(), DecodeError> {
        require_type(value, TypeOid::BYTEA, "Vec<u8>")
    }

    fn from_sql(value: ValueRef<'_>) -> std::result::Result<Self, DecodeError> {
        Self::check_type(value)?;
        let raw = value.require_bytes("Vec<u8>")?;
        match value.format() {
            Some(ValueFormat::Binary) => Ok(raw.to_vec()),
            Some(ValueFormat::Text) => decode_text_bytea(value, raw),
            None => unsupported_format(value),
        }
    }
}

impl FromSql<'_> for bool {
    fn check_type(value: ValueRef<'_>) -> std::result::Result<(), DecodeError> {
        require_type(value, TypeOid::BOOL, "bool")
    }

    fn from_sql(value: ValueRef<'_>) -> std::result::Result<Self, DecodeError> {
        Self::check_type(value)?;
        let raw = value.require_bytes("bool")?;
        match value.format() {
            Some(ValueFormat::Text) => match raw {
                b"t" | b"true" => Ok(true),
                b"f" | b"false" => Ok(false),
                _ => invalid_value(value, "bool", "expected t or f"),
            },
            Some(ValueFormat::Binary) => match raw {
                [0] => Ok(false),
                [1] => Ok(true),
                _ => invalid_value(value, "bool", "expected one binary byte containing 0 or 1"),
            },
            None => unsupported_format(value),
        }
    }
}

macro_rules! integer_from_sql {
    ($type:ty, $oid:expr, $width:literal) => {
        impl FromSql<'_> for $type {
            fn check_type(value: ValueRef<'_>) -> std::result::Result<(), DecodeError> {
                require_type(value, $oid, stringify!($type))
            }

            fn from_sql(value: ValueRef<'_>) -> std::result::Result<Self, DecodeError> {
                Self::check_type(value)?;
                let raw = value.require_bytes(stringify!($type))?;
                match value.format() {
                    Some(ValueFormat::Text) => {
                        let text =
                            str::from_utf8(raw).map_err(|error| DecodeError::InvalidValue {
                                column: value.column,
                                target: stringify!($type),
                                message: error.to_string(),
                            })?;
                        text.parse::<$type>()
                            .map_err(|error| DecodeError::InvalidValue {
                                column: value.column,
                                target: stringify!($type),
                                message: error.to_string(),
                            })
                    }
                    Some(ValueFormat::Binary) => {
                        let bytes: [u8; $width] =
                            raw.try_into().map_err(|_| DecodeError::InvalidValue {
                                column: value.column,
                                target: stringify!($type),
                                message: format!(
                                    "expected {} binary bytes, got {}",
                                    $width,
                                    raw.len()
                                ),
                            })?;
                        Ok(<$type>::from_be_bytes(bytes))
                    }
                    None => unsupported_format(value),
                }
            }
        }
    };
}

integer_from_sql!(i16, TypeOid::INT2, 2);
integer_from_sql!(i32, TypeOid::INT4, 4);
integer_from_sql!(i64, TypeOid::INT8, 8);

macro_rules! float_from_sql {
    ($type:ty, $bits:ty, $oid:expr, $width:literal) => {
        impl FromSql<'_> for $type {
            fn check_type(value: ValueRef<'_>) -> std::result::Result<(), DecodeError> {
                require_type(value, $oid, stringify!($type))
            }

            fn from_sql(value: ValueRef<'_>) -> std::result::Result<Self, DecodeError> {
                Self::check_type(value)?;
                let raw = value.require_bytes(stringify!($type))?;
                match value.format() {
                    Some(ValueFormat::Text) => {
                        let text =
                            str::from_utf8(raw).map_err(|error| DecodeError::InvalidValue {
                                column: value.column,
                                target: stringify!($type),
                                message: error.to_string(),
                            })?;
                        text.parse::<$type>()
                            .map_err(|error| DecodeError::InvalidValue {
                                column: value.column,
                                target: stringify!($type),
                                message: error.to_string(),
                            })
                    }
                    Some(ValueFormat::Binary) => {
                        let bytes: [u8; $width] =
                            raw.try_into().map_err(|_| DecodeError::InvalidValue {
                                column: value.column,
                                target: stringify!($type),
                                message: format!(
                                    "expected {} binary bytes, got {}",
                                    $width,
                                    raw.len()
                                ),
                            })?;
                        Ok(<$type>::from_bits(<$bits>::from_be_bytes(bytes)))
                    }
                    None => unsupported_format(value),
                }
            }
        }
    };
}

float_from_sql!(f32, u32, TypeOid::FLOAT4, 4);
float_from_sql!(f64, u64, TypeOid::FLOAT8, 8);

impl<'a, T> FromSql<'a> for Option<T>
where
    T: FromSql<'a>,
{
    fn check_type(value: ValueRef<'_>) -> std::result::Result<(), DecodeError> {
        T::check_type(value)
    }

    fn from_sql(value: ValueRef<'a>) -> std::result::Result<Self, DecodeError> {
        T::check_type(value)?;
        if value.is_null() {
            Ok(None)
        } else {
            T::from_sql(value).map(Some)
        }
    }
}

fn require_type(
    value: ValueRef<'_>,
    expected: TypeOid,
    target: &'static str,
) -> std::result::Result<(), DecodeError> {
    if value.type_oid() == expected {
        Ok(())
    } else {
        Err(DecodeError::TypeMismatch {
            column: value.column,
            type_oid: value.type_oid(),
            target,
        })
    }
}

fn require_text_compatible(
    value: ValueRef<'_>,
    target: &'static str,
) -> std::result::Result<(), DecodeError> {
    if value.format() != Some(ValueFormat::Text) {
        return invalid_value(
            value,
            target,
            "string decoding requires PostgreSQL text format",
        );
    }
    let oid = value.type_oid();
    if matches!(
        oid,
        TypeOid::CHAR
            | TypeOid::NAME
            | TypeOid::TEXT
            | TypeOid::UNKNOWN
            | TypeOid::BPCHAR
            | TypeOid::VARCHAR
            | TypeOid::JSON
            | TypeOid::JSONB
            | TypeOid::XML
            | TypeOid::NUMERIC
            | TypeOid::DATE
            | TypeOid::TIME
            | TypeOid::TIMETZ
            | TypeOid::TIMESTAMP
            | TypeOid::TIMESTAMPTZ
            | TypeOid::INTERVAL
            | TypeOid::UUID
    ) || oid.get() >= 16_384
    {
        Ok(())
    } else {
        Err(DecodeError::TypeMismatch {
            column: value.column,
            type_oid: oid,
            target,
        })
    }
}

fn decode_text_bytea(value: ValueRef<'_>, raw: &[u8]) -> std::result::Result<Vec<u8>, DecodeError> {
    if let Some(hex) = raw.strip_prefix(b"\\x") {
        if hex.len() % 2 != 0 {
            return invalid_value(value, "Vec<u8>", "hex bytea has odd length");
        }
        return hex
            .chunks_exact(2)
            .map(|pair| {
                let digit = |byte: u8| match byte {
                    b'0'..=b'9' => Some(byte - b'0'),
                    b'a'..=b'f' => Some(byte - b'a' + 10),
                    b'A'..=b'F' => Some(byte - b'A' + 10),
                    _ => None,
                };
                let high = digit(pair[0]).ok_or_else(|| DecodeError::InvalidValue {
                    column: value.column,
                    target: "Vec<u8>",
                    message: "hex bytea contains a non-hex digit".to_owned(),
                })?;
                let low = digit(pair[1]).ok_or_else(|| DecodeError::InvalidValue {
                    column: value.column,
                    target: "Vec<u8>",
                    message: "hex bytea contains a non-hex digit".to_owned(),
                })?;
                Ok((high << 4) | low)
            })
            .collect();
    }

    let mut decoded = Vec::with_capacity(raw.len());
    let mut index = 0;
    while index < raw.len() {
        if raw[index] != b'\\' {
            decoded.push(raw[index]);
            index += 1;
            continue;
        }
        match raw.get(index + 1..) {
            Some([b'\\', ..]) => {
                decoded.push(b'\\');
                index += 2;
            }
            Some([a @ b'0'..=b'3', b @ b'0'..=b'7', c @ b'0'..=b'7', ..]) => {
                decoded.push((a - b'0') * 64 + (b - b'0') * 8 + (c - b'0'));
                index += 4;
            }
            _ => return invalid_value(value, "Vec<u8>", "invalid escaped bytea sequence"),
        }
    }
    Ok(decoded)
}

fn invalid_value<T>(
    value: ValueRef<'_>,
    target: &'static str,
    message: impl Into<String>,
) -> std::result::Result<T, DecodeError> {
    Err(DecodeError::InvalidValue {
        column: value.column,
        target,
        message: message.into(),
    })
}

fn unsupported_format<T>(value: ValueRef<'_>) -> std::result::Result<T, DecodeError> {
    let QueryFormat::Other(format) = value.field.format else {
        unreachable!("known formats are handled before unsupported_format")
    };
    Err(DecodeError::UnsupportedFormat {
        column: value.column,
        format,
    })
}

/// One raw field from a PostgreSQL ErrorResponse.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PostgresErrorField {
    /// Single-byte PostgreSQL field code.
    pub code: u8,
    /// Field value decoded as UTF-8.
    pub value: String,
}

/// Structured PostgreSQL NoticeResponse diagnostic.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PostgresNotice {
    /// Backend severity, such as NOTICE or WARNING.
    pub severity: Option<String>,
    /// Localized severity reported in PostgreSQL field S.
    pub localized_severity: Option<String>,
    /// Locale-independent severity reported in PostgreSQL field V.
    pub nonlocalized_severity: Option<String>,
    /// SQLSTATE code when PostgreSQL supplied one.
    pub sqlstate: Option<String>,
    /// Primary human-readable notice message.
    pub message: String,
    /// Optional detailed explanation.
    pub detail: Option<String>,
    /// Optional hint.
    pub hint: Option<String>,
    /// Optional source statement position.
    pub position: Option<String>,
    /// Optional position within an internally generated query.
    pub internal_position: Option<String>,
    /// Optional text of an internally generated query.
    pub internal_query: Option<String>,
    /// Optional context stack.
    pub where_: Option<String>,
    /// Optional schema name.
    pub schema_name: Option<String>,
    /// Optional table name.
    pub table_name: Option<String>,
    /// Optional column name.
    pub column_name: Option<String>,
    /// Optional data type name.
    pub data_type_name: Option<String>,
    /// Optional constraint name.
    pub constraint_name: Option<String>,
    /// PostgreSQL source file that emitted the diagnostic.
    pub file: Option<String>,
    /// PostgreSQL source line that emitted the diagnostic.
    pub line: Option<String>,
    /// PostgreSQL source routine that emitted the diagnostic.
    pub routine: Option<String>,
    /// Raw diagnostic fields in backend order.
    pub fields: Vec<PostgresErrorField>,
}

/// Structured PostgreSQL ErrorResponse decoded from backend protocol bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PostgresError {
    /// Backend severity, such as ERROR or FATAL.
    pub severity: Option<String>,
    /// Localized severity reported in PostgreSQL field S.
    pub localized_severity: Option<String>,
    /// Locale-independent severity reported in PostgreSQL field V.
    pub nonlocalized_severity: Option<String>,
    /// SQLSTATE code, such as 23505 for unique violations.
    pub sqlstate: Option<String>,
    /// Primary human-readable PostgreSQL error message.
    pub message: String,
    /// Optional detailed explanation from PostgreSQL.
    pub detail: Option<String>,
    /// Optional hint from PostgreSQL.
    pub hint: Option<String>,
    /// Optional source statement position.
    pub position: Option<String>,
    /// Optional position within an internally generated query.
    pub internal_position: Option<String>,
    /// Optional text of an internally generated query.
    pub internal_query: Option<String>,
    /// Optional context stack, exposed as where by PostgreSQL.
    pub where_: Option<String>,
    /// Optional schema name reported by PostgreSQL.
    pub schema_name: Option<String>,
    /// Optional table name reported by PostgreSQL.
    pub table_name: Option<String>,
    /// Optional column name reported by PostgreSQL.
    pub column_name: Option<String>,
    /// Optional data type name reported by PostgreSQL.
    pub data_type_name: Option<String>,
    /// Optional constraint name reported by PostgreSQL.
    pub constraint_name: Option<String>,
    /// PostgreSQL source file that emitted the diagnostic.
    pub file: Option<String>,
    /// PostgreSQL source line that emitted the diagnostic.
    pub line: Option<String>,
    /// PostgreSQL source routine that emitted the diagnostic.
    pub routine: Option<String>,
    /// Raw ErrorResponse fields in backend order.
    pub fields: Vec<PostgresErrorField>,
    /// Notices emitted earlier in the same structured operation.
    pub notices: Vec<PostgresNotice>,
}

impl fmt::Display for PostgresError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match (&self.severity, &self.sqlstate) {
            (Some(severity), Some(sqlstate)) => {
                write!(formatter, "{severity} [{sqlstate}]: {}", self.message)
            }
            (Some(severity), None) => write!(formatter, "{severity}: {}", self.message),
            (None, Some(sqlstate)) => write!(formatter, "[{sqlstate}]: {}", self.message),
            (None, None) => formatter.write_str(&self.message),
        }
    }
}

impl std::error::Error for PostgresError {}

/// One PostgreSQL query row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QueryRow {
    pub(crate) fields: Arc<[QueryField]>,
    pub(crate) values: Vec<Option<Vec<u8>>>,
}

impl QueryRow {
    pub(crate) fn new(fields: Arc<[QueryField]>, values: Vec<Option<Vec<u8>>>) -> Self {
        Self { fields, values }
    }

    /// Field metadata in column order.
    pub fn fields(&self) -> &[QueryField] {
        &self.fields
    }

    /// Raw column values in result-column order.
    pub fn values(&self) -> &[Option<Vec<u8>>] {
        &self.values
    }

    /// Number of columns in the row.
    pub fn len(&self) -> usize {
        self.values.len()
    }

    /// Whether the row contains no columns.
    pub fn is_empty(&self) -> bool {
        self.values.is_empty()
    }

    /// Read nullable raw wire bytes by column index or name.
    pub fn try_get_raw<I>(&self, index: I) -> std::result::Result<Option<&[u8]>, DecodeError>
    where
        I: RowIndex,
    {
        let index = index.resolve(&self.fields)?;
        Ok(self.values[index].as_deref())
    }

    /// Decode a value by column index or name.
    pub fn try_get<'a, T, I>(&'a self, index: I) -> std::result::Result<T, DecodeError>
    where
        T: FromSql<'a>,
        I: RowIndex,
    {
        let index = index.resolve(&self.fields)?;
        T::from_sql(ValueRef::new(
            index,
            &self.fields[index],
            self.values[index].as_deref(),
        ))
    }

    pub(crate) fn value(&self, column: usize) -> Option<&Option<Vec<u8>>> {
        self.values.get(column)
    }
}

/// Result of a PostgreSQL command that does not expose rows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandResult {
    pub(crate) command_tag: Option<String>,
    pub(crate) row_count: Option<u64>,
    pub(crate) notices: Vec<PostgresNotice>,
    pub(crate) ready_status: ReadyStatus,
}

impl CommandResult {
    /// PostgreSQL command tag returned by the command.
    pub fn command_tag(&self) -> Option<&str> {
        self.command_tag.as_deref()
    }

    /// Affected-row count encoded by PostgreSQL in the command tag.
    pub fn row_count(&self) -> Option<u64> {
        self.row_count
    }

    /// Notices emitted while PostgreSQL processed this command.
    pub fn notices(&self) -> &[PostgresNotice] {
        &self.notices
    }

    pub(crate) fn ready_status(&self) -> ReadyStatus {
        self.ready_status
    }
}

/// Result of one PostgreSQL row-producing execution.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QueryResult {
    pub(crate) fields: Arc<[QueryField]>,
    pub(crate) rows: Vec<QueryRow>,
    pub(crate) command_tag: Option<String>,
    pub(crate) row_count: Option<u64>,
    pub(crate) notices: Vec<PostgresNotice>,
    pub(crate) ready_status: ReadyStatus,
}

impl QueryResult {
    /// Field metadata in result-column order.
    pub fn fields(&self) -> &[QueryField] {
        &self.fields
    }

    /// Rows returned by the query.
    pub fn rows(&self) -> &[QueryRow] {
        &self.rows
    }

    /// PostgreSQL command tag returned by the query.
    pub fn command_tag(&self) -> Option<&str> {
        self.command_tag.as_deref()
    }

    /// Row count encoded by PostgreSQL in the command tag.
    pub fn row_count(&self) -> Option<u64> {
        self.row_count
    }

    /// Notices emitted while PostgreSQL processed this query.
    pub fn notices(&self) -> &[PostgresNotice] {
        &self.notices
    }

    pub(crate) fn ready_status(&self) -> ReadyStatus {
        self.ready_status
    }

    pub(crate) fn row(&self, index: usize) -> Option<&QueryRow> {
        self.rows.get(index)
    }
}

/// Metadata returned by PostgreSQL for a parsed statement.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StatementDescription {
    pub(crate) parameter_types: Vec<TypeOid>,
    pub(crate) fields: Option<Vec<QueryField>>,
    pub(crate) notices: Vec<PostgresNotice>,
    pub(crate) ready_status: ReadyStatus,
}

impl StatementDescription {
    /// Server-resolved parameter type OIDs in placeholder order.
    pub fn parameter_types(&self) -> &[TypeOid] {
        &self.parameter_types
    }

    /// Result fields, or None when PostgreSQL returned NoData.
    pub fn fields(&self) -> Option<&[QueryField]> {
        self.fields.as_deref()
    }

    /// Notices emitted while PostgreSQL parsed and described the statement.
    pub fn notices(&self) -> &[PostgresNotice] {
        &self.notices
    }

    pub(crate) fn ready_status(&self) -> ReadyStatus {
        self.ready_status
    }
}

/// One ordered result from PostgreSQL simple-query execution.
#[non_exhaustive]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StatementResult {
    /// A command that did not return rows.
    Command(CommandResult),
    /// A row-producing statement.
    Rows(QueryResult),
}

/// Ordered results from PostgreSQL simple-query execution.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecResult {
    pub(crate) statements: Vec<StatementResult>,
    pub(crate) notices: Vec<PostgresNotice>,
    pub(crate) ready_status: ReadyStatus,
}

impl ExecResult {
    /// Results in source-statement order.
    pub fn statements(&self) -> &[StatementResult] {
        &self.statements
    }

    /// Notices emitted while PostgreSQL executed the input.
    pub fn notices(&self) -> &[PostgresNotice] {
        &self.notices
    }

    pub(crate) fn ready_status(&self) -> ReadyStatus {
        self.ready_status
    }
}

pub(crate) type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Error {
    Protocol(String),
    Postgres {
        diagnostic: Box<Diagnostic>,
        notices: Vec<Diagnostic>,
    },
}

fn protocol(message: impl Into<String>) -> Error {
    Error::Protocol(message.into())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DiagnosticField {
    pub code: u8,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Diagnostic {
    pub severity: Option<String>,
    pub localized_severity: Option<String>,
    pub nonlocalized_severity: Option<String>,
    pub sqlstate: Option<String>,
    pub message: String,
    pub detail: Option<String>,
    pub hint: Option<String>,
    pub position: Option<String>,
    pub internal_position: Option<String>,
    pub internal_query: Option<String>,
    pub where_: Option<String>,
    pub schema_name: Option<String>,
    pub table_name: Option<String>,
    pub column_name: Option<String>,
    pub data_type_name: Option<String>,
    pub constraint_name: Option<String>,
    pub file: Option<String>,
    pub line: Option<String>,
    pub routine: Option<String>,
    pub fields: Vec<DiagnosticField>,
}

pub(crate) fn diagnostic(fields: Vec<DiagnosticField>, fallback_message: &str) -> Diagnostic {
    let localized_severity = diagnostic_field_value(&fields, b'S');
    let nonlocalized_severity = diagnostic_field_value(&fields, b'V');
    Diagnostic {
        severity: localized_severity
            .clone()
            .or_else(|| nonlocalized_severity.clone()),
        localized_severity,
        nonlocalized_severity,
        sqlstate: diagnostic_field_value(&fields, b'C'),
        message: diagnostic_field_value(&fields, b'M')
            .unwrap_or_else(|| fallback_message.to_owned()),
        detail: diagnostic_field_value(&fields, b'D'),
        hint: diagnostic_field_value(&fields, b'H'),
        position: diagnostic_field_value(&fields, b'P'),
        internal_position: diagnostic_field_value(&fields, b'p'),
        internal_query: diagnostic_field_value(&fields, b'q'),
        where_: diagnostic_field_value(&fields, b'W'),
        schema_name: diagnostic_field_value(&fields, b's'),
        table_name: diagnostic_field_value(&fields, b't'),
        column_name: diagnostic_field_value(&fields, b'c'),
        data_type_name: diagnostic_field_value(&fields, b'd'),
        constraint_name: diagnostic_field_value(&fields, b'n'),
        file: diagnostic_field_value(&fields, b'F'),
        line: diagnostic_field_value(&fields, b'L'),
        routine: diagnostic_field_value(&fields, b'R'),
        fields,
    }
}

fn diagnostic_field_value(fields: &[DiagnosticField], code: u8) -> Option<String> {
    fields
        .iter()
        .find(|field| field.code == code)
        .map(|field| field.value.clone())
}

impl PostgresError {
    pub(crate) fn from_core(diagnostic: Diagnostic) -> Self {
        Self {
            severity: diagnostic.severity,
            localized_severity: diagnostic.localized_severity,
            nonlocalized_severity: diagnostic.nonlocalized_severity,
            sqlstate: diagnostic.sqlstate,
            message: diagnostic.message,
            detail: diagnostic.detail,
            hint: diagnostic.hint,
            position: diagnostic.position,
            internal_position: diagnostic.internal_position,
            internal_query: diagnostic.internal_query,
            where_: diagnostic.where_,
            schema_name: diagnostic.schema_name,
            table_name: diagnostic.table_name,
            column_name: diagnostic.column_name,
            data_type_name: diagnostic.data_type_name,
            constraint_name: diagnostic.constraint_name,
            file: diagnostic.file,
            line: diagnostic.line,
            routine: diagnostic.routine,
            fields: diagnostic_fields_from_core(diagnostic.fields),
            notices: Vec::new(),
        }
    }
}

impl PostgresNotice {
    pub(crate) fn from_core(diagnostic: Diagnostic) -> Self {
        Self {
            severity: diagnostic.severity,
            localized_severity: diagnostic.localized_severity,
            nonlocalized_severity: diagnostic.nonlocalized_severity,
            sqlstate: diagnostic.sqlstate,
            message: diagnostic.message,
            detail: diagnostic.detail,
            hint: diagnostic.hint,
            position: diagnostic.position,
            internal_position: diagnostic.internal_position,
            internal_query: diagnostic.internal_query,
            where_: diagnostic.where_,
            schema_name: diagnostic.schema_name,
            table_name: diagnostic.table_name,
            column_name: diagnostic.column_name,
            data_type_name: diagnostic.data_type_name,
            constraint_name: diagnostic.constraint_name,
            file: diagnostic.file,
            line: diagnostic.line,
            routine: diagnostic.routine,
            fields: diagnostic_fields_from_core(diagnostic.fields),
        }
    }
}

fn diagnostic_fields_from_core(fields: Vec<DiagnosticField>) -> Vec<PostgresErrorField> {
    fields
        .into_iter()
        .map(|field| PostgresErrorField {
            code: field.code,
            value: field.value,
        })
        .collect()
}

pub(crate) fn parse_diagnostic_fields(
    mut body: &[u8],
    label: &str,
) -> Result<Vec<DiagnosticField>> {
    let mut fields = Vec::new();
    loop {
        let Some((&code, rest)) = body.split_first() else {
            return Err(protocol(format!("{label} is missing terminator")));
        };
        body = rest;
        if code == 0 {
            if body.is_empty() {
                return Ok(fields);
            }
            return Err(protocol(format!("{label} contained trailing bytes")));
        }
        fields.push(DiagnosticField {
            code,
            value: read_cstring(&mut body, &format!("{label} field"))?.to_owned(),
        });
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ReadyStatus {
    Idle,
    InTransaction,
    FailedTransaction,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ExpectedProtocol {
    #[cfg(test)]
    Either,
    Simple,
    Extended,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Row {
    pub values: Vec<Option<Vec<u8>>>,
}

pub(crate) fn simple_query(sql: &str) -> Result<Vec<u8>> {
    if sql.as_bytes().contains(&0) {
        return Err(protocol("simple query SQL must not contain NUL bytes"));
    }
    let mut body = Vec::with_capacity(sql.len() + 1);
    body.extend_from_slice(sql.as_bytes());
    body.push(0);
    let mut packet = Vec::with_capacity(body.len() + 5);
    push_frontend_message(&mut packet, b'Q', &body)?;
    Ok(packet)
}

pub(crate) fn extended_statement(
    sql: &str,
    params: &[Parameter],
    result_format_code: i16,
) -> Result<Vec<u8>> {
    reject_copy_statements(sql)?;
    validate_statement_input(sql, params.len())?;
    validate_execution_parameters(params)?;
    let mut packet = Vec::new();
    push_parse(&mut packet, sql, params)?;
    push_bind(&mut packet, params, result_format_code)?;
    push_frontend_message(&mut packet, b'D', &[b'P', 0])?;
    push_frontend_message(&mut packet, b'E', &[0, 0, 0, 0, 0])?;
    push_frontend_message(&mut packet, b'S', &[])?;
    Ok(packet)
}

pub(crate) fn describe_statement(sql: &str, params: &[Parameter]) -> Result<Vec<u8>> {
    validate_statement_input(sql, params.len())?;
    let mut packet = Vec::new();
    push_parse(&mut packet, sql, params)?;
    push_frontend_message(&mut packet, b'D', &[b'S', 0])?;
    push_frontend_message(&mut packet, b'S', &[])?;
    Ok(packet)
}

fn validate_statement_input(sql: &str, parameter_count: usize) -> Result<()> {
    if sql.as_bytes().contains(&0) {
        return Err(protocol("extended query SQL must not contain NUL bytes"));
    }
    if parameter_count > i16::MAX as usize {
        return Err(protocol(format!(
            "extended query supports at most {} parameters, got {parameter_count}",
            i16::MAX
        )));
    }
    Ok(())
}

fn validate_execution_parameters(params: &[Parameter]) -> Result<()> {
    if let Some(index) = params
        .iter()
        .position(|parameter| parameter.type_oid().is_some_and(|oid| oid.get() == 0))
    {
        return Err(protocol(format!(
            "execution parameter {index} explicitly declares PostgreSQL type OID 0; omit the type OID to request server inference"
        )));
    }
    Ok(())
}

fn push_parse(out: &mut Vec<u8>, sql: &str, params: &[Parameter]) -> Result<()> {
    let mut body = Vec::new();
    push_cstring(&mut body, "")?;
    push_cstring(&mut body, sql)?;
    body.extend_from_slice(&(params.len() as i16).to_be_bytes());
    for parameter in params {
        body.extend_from_slice(
            &parameter
                .type_oid()
                .map(TypeOid::get)
                .unwrap_or_default()
                .to_be_bytes(),
        );
    }
    push_frontend_message(out, b'P', &body)
}

fn push_bind(out: &mut Vec<u8>, params: &[Parameter], result_format_code: i16) -> Result<()> {
    let mut body = Vec::new();
    push_cstring(&mut body, "")?;
    push_cstring(&mut body, "")?;
    body.extend_from_slice(&(params.len() as i16).to_be_bytes());
    for parameter in params {
        body.extend_from_slice(&parameter.format().code().to_be_bytes());
    }
    body.extend_from_slice(&(params.len() as i16).to_be_bytes());
    for parameter in params {
        match parameter.value() {
            None => body.extend_from_slice(&(-1_i32).to_be_bytes()),
            Some(value) => push_sized_value(&mut body, value)?,
        }
    }
    body.extend_from_slice(&1_i16.to_be_bytes());
    body.extend_from_slice(&result_format_code.to_be_bytes());
    push_frontend_message(out, b'B', &body)
}

fn push_frontend_message(out: &mut Vec<u8>, tag: u8, body: &[u8]) -> Result<()> {
    let len = i32::try_from(body.len() + 4)
        .map_err(|_| protocol("frontend protocol message is too large"))?;
    out.push(tag);
    out.extend_from_slice(&len.to_be_bytes());
    out.extend_from_slice(body);
    Ok(())
}

fn push_cstring(out: &mut Vec<u8>, value: &str) -> Result<()> {
    if value.as_bytes().contains(&0) {
        return Err(protocol(
            "frontend protocol string must not contain NUL bytes",
        ));
    }
    out.extend_from_slice(value.as_bytes());
    out.push(0);
    Ok(())
}

fn push_sized_value(out: &mut Vec<u8>, value: &[u8]) -> Result<()> {
    let len = i32::try_from(value.len()).map_err(|_| protocol("query parameter is too large"))?;
    out.extend_from_slice(&len.to_be_bytes());
    out.extend_from_slice(value);
    Ok(())
}

pub(crate) fn reject_copy_statements(sql: &str) -> Result<()> {
    if contains_top_level_copy(sql, false) || contains_top_level_copy(sql, true) {
        return Err(protocol(
            "COPY is not supported by buffered SQL APIs; use exec_protocol_raw or exec_protocol_raw_stream with a complete COPY protocol flow",
        ));
    }
    Ok(())
}

pub(crate) fn reject_transaction_chain(sql: &str) -> Result<()> {
    if contains_transaction_chain(sql, false) || contains_transaction_chain(sql, true) {
        return Err(protocol(
            "ROLLBACK ... AND CHAIN and ABORT ... AND CHAIN are not allowed inside an SDK-managed callback transaction; roll back through the transaction handle and start a new transaction explicitly",
        ));
    }
    Ok(())
}

fn contains_top_level_copy(sql: &str, ordinary_backslash_escapes: bool) -> bool {
    let mut statement_start = true;
    for token in TopLevelSqlTokens::new(sql, ordinary_backslash_escapes) {
        match token {
            TopLevelSqlToken::StatementBoundary => statement_start = true,
            TopLevelSqlToken::Word(word) => {
                if statement_start && word.eq_ignore_ascii_case(b"COPY") {
                    return true;
                }
                statement_start = false;
            }
            TopLevelSqlToken::Other => statement_start = false,
        }
    }
    false
}

#[derive(Clone, Copy)]
enum TransactionChainState {
    StatementStart,
    AfterControl,
    AfterQualifier,
    AfterAnd,
    Ineligible,
}

fn contains_transaction_chain(sql: &str, ordinary_backslash_escapes: bool) -> bool {
    let mut state = TransactionChainState::StatementStart;
    for token in TopLevelSqlTokens::new(sql, ordinary_backslash_escapes) {
        state = match token {
            TopLevelSqlToken::StatementBoundary => TransactionChainState::StatementStart,
            TopLevelSqlToken::Other => TransactionChainState::Ineligible,
            TopLevelSqlToken::Word(word) => match state {
                TransactionChainState::StatementStart
                    if word.eq_ignore_ascii_case(b"ROLLBACK")
                        || word.eq_ignore_ascii_case(b"ABORT") =>
                {
                    TransactionChainState::AfterControl
                }
                TransactionChainState::AfterControl
                    if word.eq_ignore_ascii_case(b"WORK")
                        || word.eq_ignore_ascii_case(b"TRANSACTION") =>
                {
                    TransactionChainState::AfterQualifier
                }
                TransactionChainState::AfterControl | TransactionChainState::AfterQualifier
                    if word.eq_ignore_ascii_case(b"AND") =>
                {
                    TransactionChainState::AfterAnd
                }
                TransactionChainState::AfterAnd if word.eq_ignore_ascii_case(b"CHAIN") => {
                    return true;
                }
                _ => TransactionChainState::Ineligible,
            },
        };
    }
    false
}

#[derive(Clone, Copy)]
enum TopLevelSqlToken<'a> {
    StatementBoundary,
    Word(&'a [u8]),
    Other,
}

struct TopLevelSqlTokens<'a> {
    bytes: &'a [u8],
    index: usize,
    depth: usize,
    ordinary_backslash_escapes: bool,
}

impl<'a> TopLevelSqlTokens<'a> {
    fn new(sql: &'a str, ordinary_backslash_escapes: bool) -> Self {
        Self {
            bytes: sql.as_bytes(),
            index: 0,
            depth: 0,
            ordinary_backslash_escapes,
        }
    }
}

impl<'a> Iterator for TopLevelSqlTokens<'a> {
    type Item = TopLevelSqlToken<'a>;

    fn next(&mut self) -> Option<Self::Item> {
        while self.index < self.bytes.len() {
            match self.bytes[self.index] {
                byte if byte.is_ascii_whitespace() => self.index += 1,
                b'-' if self.bytes.get(self.index + 1) == Some(&b'-') => {
                    self.index += 2;
                    while self.index < self.bytes.len()
                        && !matches!(self.bytes[self.index], b'\n' | b'\r')
                    {
                        self.index += 1;
                    }
                }
                b'/' if self.bytes.get(self.index + 1) == Some(&b'*') => {
                    self.index = skip_block_comment(self.bytes, self.index);
                }
                b'\'' => {
                    let top_level = self.depth == 0;
                    self.index = skip_quoted(
                        self.bytes,
                        self.index,
                        b'\'',
                        self.ordinary_backslash_escapes,
                    );
                    if top_level {
                        return Some(TopLevelSqlToken::Other);
                    }
                }
                b'"' => {
                    let top_level = self.depth == 0;
                    self.index = skip_quoted(self.bytes, self.index, b'"', false);
                    if top_level {
                        return Some(TopLevelSqlToken::Other);
                    }
                }
                b'$' if dollar_quote_delimiter(self.bytes, self.index).is_some() => {
                    let top_level = self.depth == 0;
                    self.index = skip_dollar_quote(self.bytes, self.index);
                    if top_level {
                        return Some(TopLevelSqlToken::Other);
                    }
                }
                b'(' => {
                    let top_level = self.depth == 0;
                    self.depth += 1;
                    self.index += 1;
                    if top_level {
                        return Some(TopLevelSqlToken::Other);
                    }
                }
                b')' if self.depth > 0 => {
                    self.depth -= 1;
                    self.index += 1;
                }
                b';' if self.depth == 0 => {
                    self.index += 1;
                    return Some(TopLevelSqlToken::StatementBoundary);
                }
                byte if is_postgres_identifier_start(byte) => {
                    let start = self.index;
                    self.index += 1;
                    while self
                        .bytes
                        .get(self.index)
                        .is_some_and(|byte| is_postgres_identifier_continuation(*byte))
                    {
                        self.index += 1;
                    }
                    let word = &self.bytes[start..self.index];
                    if word.eq_ignore_ascii_case(b"E") && self.bytes.get(self.index) == Some(&b'\'')
                    {
                        self.index = skip_quoted(self.bytes, self.index, b'\'', true);
                        if self.depth == 0 {
                            return Some(TopLevelSqlToken::Other);
                        }
                    } else if self.depth == 0 {
                        return Some(TopLevelSqlToken::Word(word));
                    }
                }
                _ => {
                    self.index += 1;
                    if self.depth == 0 {
                        return Some(TopLevelSqlToken::Other);
                    }
                }
            }
        }
        None
    }
}

fn skip_quoted(bytes: &[u8], mut index: usize, quote: u8, backslash_escapes: bool) -> usize {
    index += 1;
    while index < bytes.len() {
        if bytes[index] == quote {
            if bytes.get(index + 1) == Some(&quote) {
                index += 2;
                continue;
            }
            return index + 1;
        }
        if backslash_escapes && bytes[index] == b'\\' && index + 1 < bytes.len() {
            index += 2;
        } else {
            index += 1;
        }
    }
    index
}

fn skip_block_comment(bytes: &[u8], mut index: usize) -> usize {
    index += 2;
    let mut depth = 1_usize;
    while index < bytes.len() && depth > 0 {
        if bytes.get(index..index + 2) == Some(b"/*") {
            depth += 1;
            index += 2;
        } else if bytes.get(index..index + 2) == Some(b"*/") {
            depth -= 1;
            index += 2;
        } else {
            index += 1;
        }
    }
    index
}

fn dollar_quote_delimiter(bytes: &[u8], index: usize) -> Option<&[u8]> {
    if bytes.get(index) != Some(&b'$') {
        return None;
    }
    let tail = &bytes[index + 1..];
    let end = tail.iter().position(|byte| *byte == b'$')?;
    let tag = &tail[..end];
    (tag.is_empty()
        || (is_postgres_identifier_start(tag[0])
            && tag[1..]
                .iter()
                .all(|byte| is_postgres_identifier_continuation(*byte) && *byte != b'$')))
    .then_some(&bytes[index..index + end + 2])
}

fn is_postgres_identifier_start(byte: u8) -> bool {
    byte.is_ascii_alphabetic() || byte == b'_' || byte >= 0x80
}

fn is_postgres_identifier_continuation(byte: u8) -> bool {
    is_postgres_identifier_start(byte) || byte.is_ascii_digit() || byte == b'$'
}

fn skip_dollar_quote(bytes: &[u8], index: usize) -> usize {
    let Some(delimiter) = dollar_quote_delimiter(bytes, index) else {
        return index + 1;
    };
    let content = index + delimiter.len();
    bytes[content..]
        .windows(delimiter.len())
        .position(|window| window == delimiter)
        .map_or(bytes.len(), |offset| content + offset + delimiter.len())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SingleStatementCompletion {
    Command,
    Empty,
}

pub(crate) fn parse_command_response(
    bytes: &[u8],
    expected_protocol: ExpectedProtocol,
) -> Result<CommandResult> {
    let mut input = bytes;
    let mut ready_status = None;
    let mut command_tag = None;
    let mut completion = None;
    let mut saw_parse_complete = false;
    let mut saw_bind_complete = false;
    let mut saw_no_data = false;
    let mut notices = Vec::new();
    let mut postgres_error = None;

    while !input.is_empty() {
        let (tag, body, rest) = read_backend_message(input)?;
        input = rest;
        if expected_protocol == ExpectedProtocol::Simple && matches!(tag, b'1' | b'2' | b'n') {
            return Err(protocol(format!(
                "execute() simple-query response received extended-protocol message tag 0x{tag:02x}"
            )));
        }
        if postgres_error.is_some() && !matches!(tag, b'N' | b'S' | b'A' | b'Z') {
            return Err(protocol(format!(
                "execute() received backend message 0x{tag:02x} after ErrorResponse"
            )));
        }
        match tag {
            b'E' => {
                if completion.is_some() {
                    return Err(protocol(
                        "execute() received ErrorResponse after statement completion",
                    ));
                }
                postgres_error = Some(parse_error_response(body)?);
            }
            b'C' => {
                match completion {
                    Some(SingleStatementCompletion::Command) => {
                        return Err(protocol(
                            "execute() received multiple CommandComplete messages",
                        ));
                    }
                    Some(SingleStatementCompletion::Empty) => {
                        return Err(protocol(
                            "execute() received CommandComplete after EmptyQueryResponse",
                        ));
                    }
                    None => {}
                }
                if saw_parse_complete != saw_bind_complete {
                    return Err(protocol(
                        "execute() received CommandComplete before the extended-query controls completed",
                    ));
                }
                if saw_bind_complete && !saw_no_data {
                    return Err(protocol("execute() received CommandComplete before NoData"));
                }
                command_tag = Some(parse_command_complete(body)?);
                completion = Some(SingleStatementCompletion::Command);
            }
            b'Z' => {
                ready_status = Some(parse_ready_for_query(body)?);
                if !input.is_empty() {
                    return Err(protocol("backend returned bytes after ReadyForQuery"));
                }
            }
            b'1' => {
                require_empty_backend_message(body, "ParseComplete")?;
                if completion.is_some() || saw_parse_complete || saw_bind_complete || saw_no_data {
                    return Err(protocol("execute() received ParseComplete out of order"));
                }
                saw_parse_complete = true;
            }
            b'2' => {
                require_empty_backend_message(body, "BindComplete")?;
                if completion.is_some() || !saw_parse_complete || saw_bind_complete || saw_no_data {
                    return Err(protocol("execute() received BindComplete out of order"));
                }
                saw_bind_complete = true;
            }
            b'I' => {
                require_empty_backend_message(body, "EmptyQueryResponse")?;
                match completion {
                    Some(SingleStatementCompletion::Command) => {
                        return Err(protocol(
                            "execute() received EmptyQueryResponse after CommandComplete",
                        ));
                    }
                    Some(SingleStatementCompletion::Empty) => {
                        return Err(protocol(
                            "execute() received multiple EmptyQueryResponse messages",
                        ));
                    }
                    None => {}
                }
                if saw_parse_complete != saw_bind_complete {
                    return Err(protocol(
                        "execute() received EmptyQueryResponse before the extended-query controls completed",
                    ));
                }
                if saw_bind_complete && !saw_no_data {
                    return Err(protocol(
                        "execute() received EmptyQueryResponse before NoData",
                    ));
                }
                completion = Some(SingleStatementCompletion::Empty);
            }
            b'n' => {
                require_empty_backend_message(body, "NoData")?;
                if completion.is_some() || !saw_bind_complete || saw_no_data {
                    return Err(protocol("execute() received NoData out of order"));
                }
                saw_no_data = true;
            }
            b'S' => validate_parameter_status(body)?,
            b'N' => notices.push(parse_notice_response(body)?),
            b'A' => validate_notification_response(body)?,
            b'T' | b'D' => {
                return Err(protocol(
                    "execute() received rows; use query() for row results",
                ));
            }
            b'G' | b'H' | b'W' | b'd' | b'c' => {
                return Err(protocol(
                    "execute() does not support COPY protocol responses; use exec_protocol_raw or exec_protocol_raw_stream for COPY traffic",
                ));
            }
            _ => {
                return Err(protocol(format!(
                    "execute() received unexpected backend message tag 0x{tag:02x}"
                )));
            }
        }
    }

    let ready_status =
        ready_status.ok_or_else(|| protocol("execute response ended before ReadyForQuery"))?;
    if postgres_error.is_none()
        && expected_protocol == ExpectedProtocol::Extended
        && (!saw_parse_complete || !saw_bind_complete)
    {
        return Err(protocol(
            "execute() extended-query response omitted ParseComplete or BindComplete",
        ));
    }
    if let Some(diagnostic) = postgres_error {
        return Err(Error::Postgres {
            diagnostic: Box::new(diagnostic),
            notices,
        });
    }
    if completion.is_none() {
        return Err(protocol(
            "execute response ended before CommandComplete or EmptyQueryResponse",
        ));
    }

    let row_count = command_tag.as_deref().and_then(command_tag_row_count);
    Ok(CommandResult {
        command_tag,
        row_count,
        notices: notices.into_iter().map(PostgresNotice::from_core).collect(),
        ready_status,
    })
}

pub(crate) fn parse_query_response(
    bytes: &[u8],
    expected_protocol: ExpectedProtocol,
) -> Result<QueryResult> {
    let mut input = bytes;
    let mut fields = None;
    let mut rows = Vec::new();
    let mut command_tag = None;
    let mut completion = None;
    let mut saw_parse_complete = false;
    let mut saw_bind_complete = false;
    let mut saw_no_data = false;
    let mut ready_status = None;
    let mut notices = Vec::new();
    let mut postgres_error = None;

    while !input.is_empty() {
        let (tag, body, rest) = read_backend_message(input)?;
        input = rest;
        if expected_protocol == ExpectedProtocol::Simple && matches!(tag, b'1' | b'2' | b'n') {
            return Err(protocol(format!(
                "query() simple-query response received extended-protocol message tag 0x{tag:02x}"
            )));
        }
        if postgres_error.is_some() && !matches!(tag, b'N' | b'S' | b'A' | b'Z') {
            return Err(protocol(format!(
                "query() received backend message 0x{tag:02x} after ErrorResponse"
            )));
        }
        match tag {
            b'T' => {
                if fields.is_some() {
                    return Err(protocol(
                        "query() received multiple result sets; use exec_protocol_raw for multi-statement row results",
                    ));
                }
                if completion.is_some() {
                    return Err(protocol(
                        "query() received a result after statement completion",
                    ));
                }
                if saw_no_data || (saw_parse_complete && !saw_bind_complete) {
                    return Err(protocol("query() received RowDescription out of order"));
                }
                fields = Some(parse_row_description(body)?);
            }
            b'D' => {
                if completion.is_some() {
                    return Err(protocol(
                        "query() received DataRow after statement completion",
                    ));
                }
                let field_count = fields
                    .as_ref()
                    .ok_or_else(|| protocol("DataRow arrived before RowDescription"))?
                    .len();
                rows.push(parse_data_row(body, field_count)?);
            }
            b'C' => {
                match completion {
                    Some(SingleStatementCompletion::Command) => {
                        return Err(protocol(
                            "query() received multiple CommandComplete messages",
                        ));
                    }
                    Some(SingleStatementCompletion::Empty) => {
                        return Err(protocol(
                            "query() received CommandComplete after EmptyQueryResponse",
                        ));
                    }
                    None => {}
                }
                if saw_parse_complete != saw_bind_complete {
                    return Err(protocol(
                        "query() received CommandComplete before the extended-query controls completed",
                    ));
                }
                if saw_bind_complete && fields.is_none() && !saw_no_data {
                    return Err(protocol(
                        "query() received CommandComplete before RowDescription or NoData",
                    ));
                }
                command_tag = Some(parse_command_complete(body)?);
                completion = Some(SingleStatementCompletion::Command);
            }
            b'E' => {
                if completion.is_some() {
                    return Err(protocol(
                        "query() received ErrorResponse after statement completion",
                    ));
                }
                postgres_error = Some(parse_error_response(body)?);
            }
            b'G' | b'H' | b'W' | b'd' | b'c' => {
                return Err(protocol(
                    "query() does not support COPY protocol responses; use exec_protocol_raw or exec_protocol_raw_stream",
                ));
            }
            b'Z' => {
                ready_status = Some(parse_ready_for_query(body)?);
                if !input.is_empty() {
                    return Err(protocol("backend returned bytes after ReadyForQuery"));
                }
            }
            b'1' => {
                require_empty_backend_message(body, "ParseComplete")?;
                if completion.is_some()
                    || saw_parse_complete
                    || saw_bind_complete
                    || fields.is_some()
                    || saw_no_data
                {
                    return Err(protocol("query() received ParseComplete out of order"));
                }
                saw_parse_complete = true;
            }
            b'2' => {
                require_empty_backend_message(body, "BindComplete")?;
                if completion.is_some()
                    || !saw_parse_complete
                    || saw_bind_complete
                    || fields.is_some()
                    || saw_no_data
                {
                    return Err(protocol("query() received BindComplete out of order"));
                }
                saw_bind_complete = true;
            }
            b'I' => {
                require_empty_backend_message(body, "EmptyQueryResponse")?;
                match completion {
                    Some(SingleStatementCompletion::Command) => {
                        return Err(protocol(
                            "query() received EmptyQueryResponse after CommandComplete",
                        ));
                    }
                    Some(SingleStatementCompletion::Empty) => {
                        return Err(protocol(
                            "query() received multiple EmptyQueryResponse messages",
                        ));
                    }
                    None => {}
                }
                if fields.is_some() || !rows.is_empty() {
                    return Err(protocol(
                        "query() received EmptyQueryResponse after a row result",
                    ));
                }
                if saw_parse_complete != saw_bind_complete {
                    return Err(protocol(
                        "query() received EmptyQueryResponse before the extended-query controls completed",
                    ));
                }
                if saw_bind_complete && !saw_no_data {
                    return Err(protocol(
                        "query() received EmptyQueryResponse before RowDescription or NoData",
                    ));
                }
                completion = Some(SingleStatementCompletion::Empty);
            }
            b'n' => {
                require_empty_backend_message(body, "NoData")?;
                if completion.is_some() || !saw_bind_complete || fields.is_some() || saw_no_data {
                    return Err(protocol("query() received NoData out of order"));
                }
                saw_no_data = true;
            }
            b'S' => validate_parameter_status(body)?,
            b'N' => notices.push(parse_notice_response(body)?),
            b'A' => validate_notification_response(body)?,
            _ => {
                return Err(protocol(format!(
                    "query() received unexpected backend message tag 0x{tag:02x}"
                )));
            }
        }
    }

    let ready_status =
        ready_status.ok_or_else(|| protocol("query response ended before ReadyForQuery"))?;
    if postgres_error.is_none()
        && expected_protocol == ExpectedProtocol::Extended
        && (!saw_parse_complete || !saw_bind_complete)
    {
        return Err(protocol(
            "query() extended-query response omitted ParseComplete or BindComplete",
        ));
    }
    if let Some(diagnostic) = postgres_error {
        return Err(Error::Postgres {
            diagnostic: Box::new(diagnostic),
            notices,
        });
    }
    if completion.is_none() {
        return Err(protocol(
            "query response ended before CommandComplete or EmptyQueryResponse",
        ));
    }

    let row_count = command_tag.as_deref().and_then(command_tag_row_count);
    let fields: Arc<[QueryField]> = fields.unwrap_or_default().into();
    let rows = rows
        .into_iter()
        .map(|row| QueryRow::new(Arc::clone(&fields), row.values))
        .collect();
    Ok(QueryResult {
        fields,
        rows,
        command_tag,
        row_count,
        notices: notices.into_iter().map(PostgresNotice::from_core).collect(),
        ready_status,
    })
}

pub(crate) fn parse_exec_response(bytes: &[u8]) -> Result<ExecResult> {
    let mut input = bytes;
    let mut fields = None;
    let mut rows = Vec::new();
    let mut statements = Vec::new();
    let mut saw_completion = false;
    let mut notices = Vec::new();
    let mut statement_notices = Vec::new();
    let mut ready_status = None;
    let mut postgres_error = None;

    while !input.is_empty() {
        let (tag, body, rest) = read_backend_message(input)?;
        input = rest;
        if postgres_error.is_some() && !matches!(tag, b'N' | b'S' | b'A' | b'Z') {
            return Err(protocol(format!(
                "exec() received backend message 0x{tag:02x} after ErrorResponse"
            )));
        }
        match tag {
            b'T' => {
                if fields.is_some() {
                    return Err(protocol(
                        "exec() received RowDescription before the prior result completed",
                    ));
                }
                fields = Some(parse_row_description(body)?);
            }
            b'D' => {
                let expected = fields
                    .as_ref()
                    .ok_or_else(|| protocol("DataRow arrived before RowDescription"))?
                    .len();
                rows.push(parse_data_row(body, expected)?);
            }
            b'C' => {
                let command_tag = parse_command_complete(body)?;
                let row_count = command_tag_row_count(&command_tag);
                if let Some(result_fields) = fields.take() {
                    let fields: Arc<[QueryField]> = result_fields.into();
                    let rows = std::mem::take(&mut rows)
                        .into_iter()
                        .map(|row| QueryRow::new(Arc::clone(&fields), row.values))
                        .collect();
                    statements.push(StatementResult::Rows(QueryResult {
                        fields,
                        rows,
                        command_tag: Some(command_tag),
                        row_count,
                        notices: take_notices(&mut statement_notices),
                        ready_status: ReadyStatus::Idle,
                    }));
                } else {
                    if !rows.is_empty() {
                        return Err(protocol("exec() retained rows without field metadata"));
                    }
                    statements.push(StatementResult::Command(CommandResult {
                        command_tag: Some(command_tag),
                        row_count,
                        notices: take_notices(&mut statement_notices),
                        ready_status: ReadyStatus::Idle,
                    }));
                }
                saw_completion = true;
            }
            b'I' => {
                require_empty_backend_message(body, "EmptyQueryResponse")?;
                if fields.is_some() || !rows.is_empty() {
                    return Err(protocol(
                        "exec() received EmptyQueryResponse before the prior row result completed",
                    ));
                }
                statement_notices.clear();
                saw_completion = true;
            }
            b'E' => postgres_error = Some(parse_error_response(body)?),
            b'N' => {
                let notice = parse_notice_response(body)?;
                statement_notices.push(notice.clone());
                notices.push(notice);
            }
            b'S' => validate_parameter_status(body)?,
            b'A' => validate_notification_response(body)?,
            b'Z' => {
                ready_status = Some(parse_ready_for_query(body)?);
                if !input.is_empty() {
                    return Err(protocol("backend returned bytes after ReadyForQuery"));
                }
            }
            b'G' | b'H' | b'W' | b'd' | b'c' => {
                return Err(protocol(
                    "exec() does not support COPY protocol responses; use exec_protocol_raw or exec_protocol_raw_stream",
                ));
            }
            _ => {
                return Err(protocol(format!(
                    "exec() received unexpected backend message tag 0x{tag:02x}"
                )));
            }
        }
    }

    let ready_status =
        ready_status.ok_or_else(|| protocol("exec response ended before ReadyForQuery"))?;
    if let Some(diagnostic) = postgres_error {
        return Err(Error::Postgres {
            diagnostic: Box::new(diagnostic),
            notices,
        });
    }
    if fields.is_some() || !rows.is_empty() {
        return Err(protocol("exec response ended before CommandComplete"));
    }
    if !saw_completion {
        return Err(protocol(
            "exec response ended before CommandComplete or EmptyQueryResponse",
        ));
    }

    Ok(ExecResult {
        statements,
        notices: notices.into_iter().map(PostgresNotice::from_core).collect(),
        ready_status,
    })
}

fn take_notices(notices: &mut Vec<Diagnostic>) -> Vec<PostgresNotice> {
    std::mem::take(notices)
        .into_iter()
        .map(PostgresNotice::from_core)
        .collect()
}

pub(crate) fn parse_statement_description(bytes: &[u8]) -> Result<StatementDescription> {
    let mut input = bytes;
    let mut parameter_types = None;
    let mut fields = None;
    let mut saw_no_data = false;
    let mut saw_parse_complete = false;
    let mut ready_status = None;
    let mut notices = Vec::new();
    let mut postgres_error = None;

    while !input.is_empty() {
        let (tag, body, rest) = read_backend_message(input)?;
        input = rest;
        if postgres_error.is_some() && !matches!(tag, b'N' | b'S' | b'A' | b'Z') {
            return Err(protocol(format!(
                "describe() received backend message 0x{tag:02x} after ErrorResponse"
            )));
        }
        match tag {
            b'1' => {
                require_empty_backend_message(body, "ParseComplete")?;
                if saw_parse_complete
                    || parameter_types.is_some()
                    || fields.is_some()
                    || saw_no_data
                {
                    return Err(protocol("describe() received ParseComplete out of order"));
                }
                saw_parse_complete = true;
            }
            b't' => {
                if !saw_parse_complete
                    || parameter_types.is_some()
                    || fields.is_some()
                    || saw_no_data
                {
                    return Err(protocol(
                        "describe() received ParameterDescription out of order",
                    ));
                }
                parameter_types = Some(parse_parameter_description(body)?);
            }
            b'T' => {
                if parameter_types.is_none() || fields.is_some() || saw_no_data {
                    return Err(protocol("describe() received RowDescription out of order"));
                }
                fields = Some(parse_row_description(body)?);
            }
            b'n' => {
                require_empty_backend_message(body, "NoData")?;
                if parameter_types.is_none() || fields.is_some() || saw_no_data {
                    return Err(protocol("describe() received NoData out of order"));
                }
                saw_no_data = true;
            }
            b'E' => {
                if fields.is_some() || saw_no_data {
                    return Err(protocol(
                        "describe() received ErrorResponse after result description",
                    ));
                }
                postgres_error = Some(parse_error_response(body)?);
            }
            b'N' => notices.push(parse_notice_response(body)?),
            b'S' => validate_parameter_status(body)?,
            b'A' => validate_notification_response(body)?,
            b'Z' => {
                ready_status = Some(parse_ready_for_query(body)?);
                if !input.is_empty() {
                    return Err(protocol("backend returned bytes after ReadyForQuery"));
                }
            }
            _ => {
                return Err(protocol(format!(
                    "describe() received unexpected backend message tag 0x{tag:02x}"
                )));
            }
        }
    }

    let ready_status =
        ready_status.ok_or_else(|| protocol("describe response ended before ReadyForQuery"))?;
    if let Some(diagnostic) = postgres_error {
        return Err(Error::Postgres {
            diagnostic: Box::new(diagnostic),
            notices,
        });
    }
    if !saw_parse_complete {
        return Err(protocol("describe response omitted ParseComplete"));
    }
    let parameter_types = parameter_types
        .ok_or_else(|| protocol("describe response omitted ParameterDescription"))?;
    if fields.is_none() && !saw_no_data {
        return Err(protocol(
            "describe response omitted RowDescription or NoData",
        ));
    }

    Ok(StatementDescription {
        parameter_types: parameter_types.into_iter().map(TypeOid::new).collect(),
        fields,
        notices: notices.into_iter().map(PostgresNotice::from_core).collect(),
        ready_status,
    })
}

pub(crate) fn response_ready_status(bytes: &[u8]) -> Result<ReadyStatus> {
    let mut input = bytes;
    let mut ready = None;
    while !input.is_empty() {
        let (tag, body, rest) = read_backend_message(input)?;
        input = rest;
        if tag == b'Z' {
            if ready.is_some() {
                return Err(protocol("backend returned multiple ReadyForQuery messages"));
            }
            ready = Some(parse_ready_for_query(body)?);
            if !input.is_empty() {
                return Err(protocol("backend returned bytes after ReadyForQuery"));
            }
        }
    }
    ready.ok_or_else(|| protocol("response ended before ReadyForQuery"))
}

/// Validate that a structured operation kept ownership of a callback-scoped
/// transaction. This works from raw backend frames so an earlier
/// CommandComplete cannot be hidden by a later ErrorResponse.
pub(crate) fn validate_managed_transaction_response(bytes: &[u8]) -> Result<ReadyStatus> {
    let mut input = bytes;
    let mut ready = None;
    let mut escaped_command = None;
    while !input.is_empty() {
        let (message, body, rest) = read_backend_message(input)?;
        input = rest;
        match message {
            b'C' => {
                let mut command = body;
                let tag = read_cstring(&mut command, "CommandComplete tag")?;
                if !command.is_empty() {
                    return Err(protocol("CommandComplete contained trailing bytes"));
                }
                if matches!(
                    tag,
                    "BEGIN"
                        | "START TRANSACTION"
                        | "COMMIT"
                        | "PREPARE TRANSACTION"
                        | "COMMIT PREPARED"
                        | "ROLLBACK PREPARED"
                ) {
                    escaped_command.get_or_insert_with(|| tag.to_owned());
                }
            }
            b'Z' => {
                if ready.is_some() {
                    return Err(protocol("backend returned multiple ReadyForQuery messages"));
                }
                ready = Some(parse_ready_for_query(body)?);
                if !input.is_empty() {
                    return Err(protocol("backend returned bytes after ReadyForQuery"));
                }
            }
            _ => {}
        }
    }
    let ready = ready.ok_or_else(|| protocol("response ended before ReadyForQuery"))?;
    if let Some(command) = escaped_command {
        return Err(protocol(format!(
            "PostgreSQL completed {command}, which changed the SDK-managed transaction lifecycle"
        )));
    }
    if ready == ReadyStatus::Idle {
        return Err(protocol(
            "PostgreSQL returned idle readiness after SDK-managed transaction work",
        ));
    }
    Ok(ready)
}

fn parse_parameter_description(mut body: &[u8]) -> Result<Vec<u32>> {
    let count = read_i16(&mut body, "ParameterDescription parameter count")?;
    if count < 0 {
        return Err(protocol(format!(
            "invalid ParameterDescription parameter count {count}"
        )));
    }
    let mut types = Vec::with_capacity(count as usize);
    for _ in 0..count {
        types.push(read_u32(&mut body, "ParameterDescription type OID")?);
    }
    if !body.is_empty() {
        return Err(protocol("ParameterDescription contained trailing bytes"));
    }
    Ok(types)
}

fn command_tag_row_count(tag: &str) -> Option<u64> {
    let mut parts = tag.split_ascii_whitespace();
    let command = parts.next()?;
    if !matches!(
        command,
        "SELECT" | "INSERT" | "UPDATE" | "DELETE" | "MERGE" | "MOVE" | "FETCH" | "COPY"
    ) {
        return None;
    }
    parts.last().or(Some(command))?.parse().ok()
}

fn read_backend_message(bytes: &[u8]) -> Result<(u8, &[u8], &[u8])> {
    if bytes.len() < 5 {
        return Err(protocol("truncated backend message header"));
    }
    let tag = bytes[0];
    let len = i32::from_be_bytes([bytes[1], bytes[2], bytes[3], bytes[4]]);
    if len < 4 {
        return Err(protocol(format!("invalid backend message length {len}")));
    }
    let total = 1usize
        .checked_add(len as usize)
        .ok_or_else(|| protocol("backend message length overflow"))?;
    if bytes.len() < total {
        return Err(protocol("truncated backend message body"));
    }
    Ok((tag, &bytes[5..total], &bytes[total..]))
}

fn parse_row_description(mut body: &[u8]) -> Result<Vec<QueryField>> {
    let count = read_i16(&mut body, "RowDescription field count")?;
    if count < 0 {
        return Err(protocol(format!(
            "invalid RowDescription field count {count}"
        )));
    }
    let mut fields = Vec::with_capacity(count as usize);
    for _ in 0..count {
        fields.push(QueryField {
            name: read_cstring(&mut body, "field name")?.to_owned(),
            table_oid: read_u32(&mut body, "field table oid")?,
            table_attribute: read_i16(&mut body, "field table attribute")?,
            type_oid: read_u32(&mut body, "field type oid")?,
            type_size: read_i16(&mut body, "field type size")?,
            type_modifier: read_i32(&mut body, "field type modifier")?,
            format: QueryFormat::from(read_i16(&mut body, "field format")?),
        });
    }
    if !body.is_empty() {
        return Err(protocol("RowDescription contained trailing bytes"));
    }
    Ok(fields)
}

fn parse_data_row(mut body: &[u8], expected_columns: usize) -> Result<Row> {
    let count = read_i16(&mut body, "DataRow column count")?;
    if count < 0 {
        return Err(protocol(format!("invalid DataRow column count {count}")));
    }
    if count as usize != expected_columns {
        return Err(protocol(format!(
            "DataRow column count {count} does not match RowDescription count {expected_columns}"
        )));
    }
    let mut values = Vec::with_capacity(count as usize);
    for _ in 0..count {
        let len = read_i32(&mut body, "DataRow value length")?;
        if len == -1 {
            values.push(None);
            continue;
        }
        if len < 0 {
            return Err(protocol(format!("invalid DataRow value length {len}")));
        }
        let len = len as usize;
        if body.len() < len {
            return Err(protocol("truncated DataRow value"));
        }
        values.push(Some(body[..len].to_vec()));
        body = &body[len..];
    }
    if !body.is_empty() {
        return Err(protocol("DataRow contained trailing bytes"));
    }
    Ok(Row { values })
}

fn parse_command_complete(mut body: &[u8]) -> Result<String> {
    let tag = read_cstring(&mut body, "CommandComplete tag")?.to_owned();
    if !body.is_empty() {
        return Err(protocol("CommandComplete contained trailing bytes"));
    }
    Ok(tag)
}

fn parse_error_response(body: &[u8]) -> Result<Diagnostic> {
    parse_diagnostic_fields(body, "ErrorResponse")
        .map(|fields| diagnostic(fields, "PostgreSQL ErrorResponse"))
}

fn parse_notice_response(body: &[u8]) -> Result<Diagnostic> {
    parse_diagnostic_fields(body, "NoticeResponse")
        .map(|fields| diagnostic(fields, "PostgreSQL NoticeResponse"))
}

fn require_empty_backend_message(body: &[u8], label: &str) -> Result<()> {
    if body.is_empty() {
        return Ok(());
    }
    Err(protocol(format!("{label} contained trailing bytes")))
}

fn parse_ready_for_query(body: &[u8]) -> Result<ReadyStatus> {
    match body {
        [b'I'] => Ok(ReadyStatus::Idle),
        [b'T'] => Ok(ReadyStatus::InTransaction),
        [b'E'] => Ok(ReadyStatus::FailedTransaction),
        [status] => Err(protocol(format!(
            "ReadyForQuery contained invalid transaction status 0x{status:02x}"
        ))),
        _ => Err(protocol(format!(
            "ReadyForQuery contained {} bytes, expected 1",
            body.len()
        ))),
    }
}

fn validate_parameter_status(mut body: &[u8]) -> Result<()> {
    read_cstring(&mut body, "ParameterStatus name")?;
    read_cstring(&mut body, "ParameterStatus value")?;
    if !body.is_empty() {
        return Err(protocol("ParameterStatus contained trailing bytes"));
    }
    Ok(())
}

fn validate_notification_response(mut body: &[u8]) -> Result<()> {
    read_i32(&mut body, "NotificationResponse process id")?;
    read_cstring(&mut body, "NotificationResponse channel")?;
    read_cstring(&mut body, "NotificationResponse payload")?;
    if !body.is_empty() {
        return Err(protocol("NotificationResponse contained trailing bytes"));
    }
    Ok(())
}

fn read_u32(input: &mut &[u8], label: &str) -> Result<u32> {
    let bytes = take(input, 4, label)?;
    Ok(u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
}

fn read_i32(input: &mut &[u8], label: &str) -> Result<i32> {
    let bytes = take(input, 4, label)?;
    Ok(i32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
}

fn read_i16(input: &mut &[u8], label: &str) -> Result<i16> {
    let bytes = take(input, 2, label)?;
    Ok(i16::from_be_bytes([bytes[0], bytes[1]]))
}

fn read_cstring<'a>(input: &mut &'a [u8], label: &str) -> Result<&'a str> {
    let nul = input
        .iter()
        .position(|byte| *byte == 0)
        .ok_or_else(|| protocol(format!("{label} is missing null terminator")))?;
    let raw = &input[..nul];
    let value = str::from_utf8(raw)
        .map_err(|error| protocol(format!("{label} is not valid UTF-8: {error}")))?;
    *input = &input[nul + 1..];
    Ok(value)
}

fn take<'a>(input: &mut &'a [u8], len: usize, label: &str) -> Result<&'a [u8]> {
    if input.len() < len {
        return Err(protocol(format!("truncated {label}")));
    }
    let (head, tail) = input.split_at(len);
    *input = tail;
    Ok(head)
}
