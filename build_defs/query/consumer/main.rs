fn main() {
    let frame = oliphaunt_query::simple_query("SELECT 42").unwrap();
    assert_eq!(frame[0], b'Q');
    assert_eq!(&frame[5..frame.len() - 1], b"SELECT 42");
}
