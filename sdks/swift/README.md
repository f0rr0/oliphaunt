# Swift SDK

Future home of the Swift package for `libpglite`.

Target shape:

```text
sdks/swift/
├── Package.swift
├── Sources/
│   ├── PGLiteCore/
│   └── CLibPGLite/
└── Tests/
    └── PGLiteCoreTests/
```

Swift resources and binary artifacts should be target-scoped so the package can
ship selected runtime assets and extension packs without root-level plumbing.
