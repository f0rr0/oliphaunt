"""Typed final extension files; imported bytes never replace member producers."""

ExtensionFinalLeafInfo = provider(fields = [
    "product", "owner", "version", "family", "target", "metadata",
    "github", "npm", "cargo", "manifest", "frozen", "spec", "validation", "receipt", "origin",
    "original_files",
])

# A source-owned projection of actual original Apple inputs, rather than a
# claim that a copied historical document was built at this checkout.
NativeAppleBaseInfo = provider(fields = ["version", "file", "archives", "archive_files"])
