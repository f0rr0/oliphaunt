use std::ffi::{c_int, c_void};
use std::io::{Read, Write};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::Path;

use super::ffi::{
    ABI_VERSION, NativeErrorCapture, NativeRestoreStreamOptions, NativeSymbols, path_to_cstring,
};
use super::{NativeSession, captured_native_error};
use crate::{Error, Result};

impl NativeSession {
    /// Write an archive without buffering its contents in the native runtime.
    /// A sink failure still settles PostgreSQL backup mode before returning.
    pub fn backup_to(&mut self, writer: &mut dyn Write) -> Result<()> {
        let backup = self.symbols.backup_stream()?;
        let guard = self
            .handle
            .handle
            .read()
            .map_err(|_| Error::Engine("native handle lock poisoned".into()))?;
        if guard.is_null() {
            return Err(Error::EngineStopped);
        }
        let mut context = WriteContext {
            writer,
            error: None,
        };
        let mut error = NativeErrorCapture::zeroed();
        // SAFETY: the runtime borrows the handle and callback context only for
        // this synchronous call. The read guard excludes handle teardown.
        let rc = unsafe {
            backup(
                *guard,
                write_archive,
                (&mut context as *mut WriteContext<'_>).cast(),
                &mut error,
            )
        };
        archive_result(rc, &error, context.error, "oliphaunt_backup_stream")
    }

    pub fn restore_reader(destination: &Path, reader: &mut dyn Read) -> Result<()> {
        restore(NativeSymbols::load()?, destination, reader)
    }

    pub fn restore_reader_from_library(
        library: &Path,
        destination: &Path,
        reader: &mut dyn Read,
    ) -> Result<()> {
        restore(NativeSymbols::load_path(library)?, destination, reader)
    }

    pub fn restore_reader_from_current_process(
        destination: &Path,
        reader: &mut dyn Read,
    ) -> Result<()> {
        restore(NativeSymbols::load_current_process()?, destination, reader)
    }
}

fn restore(symbols: NativeSymbols, destination: &Path, reader: &mut dyn Read) -> Result<()> {
    let restore = symbols.restore_stream()?;
    let destination = path_to_cstring(destination, "restore destination")?;
    let mut context = ReadContext {
        reader,
        error: None,
    };
    let options = NativeRestoreStreamOptions {
        abi_version: ABI_VERSION,
        destination: destination.as_ptr(),
        read: read_archive,
        context: (&mut context as *mut ReadContext<'_>).cast(),
    };
    let mut error = NativeErrorCapture::zeroed();
    // SAFETY: all pointers remain live until the synchronous restore completes.
    let rc = unsafe { restore(&options, &mut error) };
    archive_result(rc, &error, context.error, "oliphaunt_restore_stream")
}

fn archive_result(
    rc: c_int,
    capture: &NativeErrorCapture,
    callback: Option<String>,
    operation: &str,
) -> Result<()> {
    if rc == 0 && callback.is_none() {
        return Ok(());
    }
    let mut detail = captured_native_error(capture, operation, rc);
    if let Some(callback) = callback {
        detail.push_str(": ");
        detail.push_str(&callback);
    }
    // Keep native backup-cleanup failures authoritative even when the sink
    // first failed: a write error alone does not prove a reusable session.
    Err(Error::Engine(detail))
}

struct WriteContext<'a> {
    writer: &'a mut dyn Write,
    error: Option<String>,
}
struct ReadContext<'a> {
    reader: &'a mut dyn Read,
    error: Option<String>,
}

unsafe extern "C" fn write_archive(context: *mut c_void, data: *const u8, len: usize) -> c_int {
    // SAFETY: native invokes this only with the live context and borrowed slice.
    let context = unsafe { &mut *context.cast::<WriteContext<'_>>() };
    let data = unsafe { std::slice::from_raw_parts(data, len) };
    match catch_unwind(AssertUnwindSafe(|| context.writer.write_all(data))) {
        Ok(Ok(())) => 0,
        result => {
            context.error = Some(match result {
                Ok(Err(error)) => error.to_string(),
                _ => "archive writer panicked".into(),
            });
            -1
        }
    }
}

unsafe extern "C" fn read_archive(
    context: *mut c_void,
    data: *mut u8,
    capacity: usize,
    read_len: *mut usize,
) -> c_int {
    // SAFETY: native provides a writable buffer/count and the live context.
    let context = unsafe { &mut *context.cast::<ReadContext<'_>>() };
    let data = unsafe { std::slice::from_raw_parts_mut(data, capacity) };
    let result = catch_unwind(AssertUnwindSafe(|| {
        loop {
            match context.reader.read(data) {
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                result => break result,
            }
        }
    }));
    match result {
        Ok(Ok(count)) if count <= capacity => {
            unsafe {
                *read_len = count;
            }
            0
        }
        result => {
            context.error = Some(match result {
                Ok(Err(error)) => error.to_string(),
                Ok(Ok(_)) => "archive reader returned an invalid length".into(),
                Err(_) => "archive reader panicked".into(),
            });
            -1
        }
    }
}
