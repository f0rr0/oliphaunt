use anyhow::Result;

use super::postgres_mod::PostgresMod;

/// Protocol transport for the WASIX Oliphaunt backend.
pub enum Transport {
    Wasix,
}

impl Transport {
    pub fn prepare(_pg: &mut PostgresMod) -> Result<Self> {
        Ok(Self::Wasix)
    }

    pub fn send(&self, pg: &mut PostgresMod, payload: &[u8]) -> Result<Vec<u8>> {
        pg.send_protocol(payload)
    }
}
