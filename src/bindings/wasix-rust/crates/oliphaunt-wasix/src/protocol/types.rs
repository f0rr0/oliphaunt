#[derive(Debug, Copy, Clone, PartialEq, Eq)]
pub enum Mode {
    Text = 0,
    Binary = 1,
}

impl Mode {
    pub fn as_i16(self) -> i16 {
        match self {
            Mode::Text => 0,
            Mode::Binary => 1,
        }
    }
}

impl TryFrom<i16> for Mode {
    type Error = &'static str;

    fn try_from(value: i16) -> Result<Self, Self::Error> {
        match value {
            0 => Ok(Mode::Text),
            1 => Ok(Mode::Binary),
            _ => Err("invalid mode"),
        }
    }
}

pub struct Modes;

impl Modes {
    pub const TEXT: Mode = Mode::Text;
    pub const BINARY: Mode = Mode::Binary;
}

pub type BufferParameter<'a> = &'a [u8];

#[cfg(test)]
mod tests {
    use super::{Mode, Modes};

    #[test]
    fn mode_round_trips_wire_format_codes() {
        assert_eq!(Modes::TEXT.as_i16(), 0);
        assert_eq!(Modes::BINARY.as_i16(), 1);
        assert_eq!(Mode::try_from(0), Ok(Mode::Text));
        assert_eq!(Mode::try_from(1), Ok(Mode::Binary));
        assert_eq!(Mode::try_from(2), Err("invalid mode"));
    }
}
