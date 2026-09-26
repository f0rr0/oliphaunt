# Native mobile resource assembly

This unpublished crate assembles already-built native runtime files and selected
extension artifacts for mobile packages. Its only command is
`cargo run -p oliphaunt-native-packaging --bin oliphaunt-resources -- --help`.
The native mobile archive producer and React Native mobile fixture use it.

Extension products own artifact creation and release downloads. This consumer
validates explicit local artifacts, runtime compatibility, archive limits and
legal inventories before assembling resources and a static extension registry.
ICU is included only when explicitly selected. The extension catalog comes from
the canonical generated inventory.
