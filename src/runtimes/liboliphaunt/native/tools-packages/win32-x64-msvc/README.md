# @oliphaunt/tools-win32-x64-msvc

Platform PostgreSQL client tools for Oliphaunt on Windows x64 MSVC.
Applications do not depend on this package directly; `@oliphaunt/ts` selects it
as an optional package for the current platform.

The package includes only the tools' import-derived app-local Microsoft Visual
C++ runtime closure, with a SHA-256 receipt. The unmodified DLLs remain subject
to the [Microsoft Visual Studio redistribution
terms](https://learn.microsoft.com/visualstudio/releases/2022/redistribution).
