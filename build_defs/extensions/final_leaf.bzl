"""Typed final extension files; imported bytes never replace member producers."""

ExtensionFinalLeafInfo = provider(fields = [
    "product", "owner", "version", "family", "target", "metadata",
    "github", "npm", "cargo", "manifest", "frozen", "spec", "validation", "receipt", "origin",
])
