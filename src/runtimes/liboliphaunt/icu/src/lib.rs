#![deny(unsafe_code)]

include!(concat!(env!("OUT_DIR"), "/generated_icu.rs"));

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn packaged_identities_track_the_embedded_payload() {
        assert_eq!(HAS_ICU_DATA, icu_data_archive().is_some());
        assert_eq!(HAS_ICU_DATA, ICU_DATA_ARCHIVE_SHA256.is_some());
        assert_eq!(HAS_ICU_DATA, ICU_DATA_TREE_SHA256.is_some());
    }
}
