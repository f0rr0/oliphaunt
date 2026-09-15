use crate::Result;
pub(crate) use oliphaunt_broker::ipc::{RequestFrame, ResponseFrame};
use std::io::{Read, Write};
pub(crate) fn write_request(writer: &mut impl Write, frame: RequestFrame) -> Result<()> {
    oliphaunt_broker::ipc::write_request(writer, frame).map_err(Into::into)
}
pub(crate) fn read_response(reader: &mut impl Read) -> Result<ResponseFrame> {
    oliphaunt_broker::ipc::read_response(reader).map_err(Into::into)
}
