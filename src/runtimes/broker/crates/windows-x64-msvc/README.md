# oliphaunt-broker-windows-x64-msvc

Cargo artifact crate for the `windows-x64-msvc` `oliphaunt-broker` helper
binary. Applications do not depend on this crate directly; `oliphaunt` selects
it for matching Cargo targets.

The packaged helper includes only its import-derived, app-local Microsoft Visual
C++ runtime DLL closure plus a SHA-256 receipt. Those unmodified files come from
the initialized Visual Studio `VC/Redist/MSVC/.../x64/Microsoft.VC145.CRT`
directory and remain subject to the Microsoft Visual Studio redistribution
terms: <https://learn.microsoft.com/visualstudio/releases/2026/redistribution>.
