use std::{
    collections::BTreeMap,
    fmt::{Debug, Display},
};

use js_sys::{JsString, Uint8Array};

use wasm_bindgen::{JsCast, JsValue, prelude::wasm_bindgen};

/// Try to extract the most appropriate error message from a [`JsValue`],
/// falling back to a generic error message.
pub(crate) fn js_error(value: JsValue) -> anyhow::Error {
    if let Some(e) = value.dyn_ref::<js_sys::Error>() {
        anyhow::Error::msg(String::from(e.message()))
    } else if let Some(obj) = value.dyn_ref::<js_sys::Object>() {
        return anyhow::Error::msg(String::from(obj.to_string()));
    } else if let Some(s) = value.dyn_ref::<js_sys::JsString>() {
        return anyhow::Error::msg(String::from(s));
    } else {
        anyhow::anyhow!("An unknown error occurred: {value:?}")
    }
}

/// A wrapper around [`anyhow::Error`] that can be returned to JS to raise
/// an exception.
#[derive(Debug)]
pub enum Error {
    Rust(anyhow::Error),
    JavaScript(JsValue),
}

impl Error {
    pub(crate) fn js(error: impl Into<JsValue>) -> Self {
        Error::JavaScript(error.into())
    }

    pub(crate) fn into_anyhow(self) -> anyhow::Error {
        match self {
            Error::Rust(e) => e,
            Error::JavaScript(js) => js_error(js),
        }
    }
}

impl<E: Into<anyhow::Error>> From<E> for Error {
    fn from(value: E) -> Self {
        Error::Rust(value.into())
    }
}

impl From<Error> for JsValue {
    fn from(error: Error) -> Self {
        match error {
            Error::JavaScript(e) => e,
            Error::Rust(error) => {
                let message = error.to_string();
                let js_error = js_sys::Error::new(&message);

                let _ = js_sys::Reflect::set(
                    &js_error,
                    &JsString::from("message"),
                    &JsString::from(error.to_string()),
                );

                let _ = js_sys::Reflect::set(
                    &js_error,
                    &JsString::from("detailedMessage"),
                    &JsString::from(format!("{error:?}")),
                );

                let causes: js_sys::Array = std::iter::successors(error.source(), |e| e.source())
                    .map(|e| JsString::from(e.to_string()))
                    .collect();
                let _ = js_sys::Reflect::set(&js_error, &JsString::from("causes"), &causes);

                js_error.into()
            }
        }
    }
}

impl Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::Rust(e) => Display::fmt(e, f),
            Error::JavaScript(js) => {
                if let Some(e) = js.dyn_ref::<js_sys::Error>() {
                    write!(f, "{}", String::from(e.message()))
                } else if let Some(obj) = js.dyn_ref::<js_sys::Object>() {
                    write!(f, "{}", String::from(obj.to_string()))
                } else if let Some(s) = js.dyn_ref::<js_sys::JsString>() {
                    write!(f, "{}", String::from(s))
                } else {
                    write!(f, "A JavaScript error occurred")
                }
            }
        }
    }
}

pub(crate) fn object_entries(obj: &js_sys::Object) -> Result<BTreeMap<JsString, JsValue>, Error> {
    let mut entries = BTreeMap::new();

    for key in js_sys::Object::keys(obj) {
        let key: JsString = key
            .dyn_into()
            .map_err(|_| Error::js(js_sys::TypeError::new("Object keys should be strings")))?;
        let value = js_sys::Reflect::get(obj, &key).map_err(Error::js)?;
        entries.insert(key, value);
    }

    Ok(entries)
}

pub(crate) fn js_string_array(array: js_sys::Array) -> Result<Vec<String>, Error> {
    let mut parsed = Vec::new();

    for arg in array {
        match arg.dyn_into::<JsString>() {
            Ok(arg) => parsed.push(String::from(arg)),
            Err(_) => {
                return Err(Error::js(js_sys::TypeError::new(
                    "Expected an array of strings",
                )));
            }
        }
    }

    Ok(parsed)
}

pub(crate) fn js_record_of_strings(obj: &js_sys::Object) -> Result<Vec<(String, String)>, Error> {
    let mut parsed = Vec::new();

    for (key, value) in super::utils::object_entries(obj)? {
        let key: String = key.into();
        let value: String = value
            .dyn_into::<JsString>()
            .map_err(|_| {
                Error::js(js_sys::TypeError::new(
                    "Expected an object mapping strings to strings",
                ))
            })?
            .into();
        parsed.push((key, value));
    }

    Ok(parsed)
}

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(typescript_type = "string | Uint8Array")]
    pub type StringOrBytes;
}

impl StringOrBytes {
    pub fn as_bytes(&self) -> Vec<u8> {
        if let Some(s) = self.dyn_ref::<JsString>() {
            String::from(s).into()
        } else if let Some(buffer) = self.dyn_ref::<Uint8Array>() {
            buffer.to_vec()
        } else {
            unreachable!()
        }
    }
}
