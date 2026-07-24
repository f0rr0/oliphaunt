# Windows Visual C++ runtime release contract

Oliphaunt's Windows release carriers are self-contained on a clean supported
Windows x64 host. They do not assume that a system-wide Visual C++
Redistributable has already been installed.

## Redistribution source and terms

Release builds may copy production runtime DLLs only from the developer shell's
exact `VCToolsRedistDir/x64/Microsoft.VC145.CRT` directory. The closure tool
rejects another CRT generation, non-x64 or PE32 files, symlinks, debug runtime
imports, and unapproved future CRT families. The DLL bytes are copied unchanged;
the binary-strip step explicitly preserves Microsoft redistributables and closure
verification runs after stripping.

Microsoft permits licensed Visual Studio users to redistribute unmodified files
from the Visual Studio `VC/redist` directory subject to the Visual Studio license.
Maintainers must review the current [Visual Studio 2026 redistribution
terms](https://learn.microsoft.com/visualstudio/releases/2026/redistribution)
before publishing. Debug and `debug_nonredist` files must never be published.
Application-local placement follows Microsoft's [application-local deployment
guidance](https://learn.microsoft.com/cpp/windows/walkthrough-deploying-a-visual-cpp-application-to-an-application-local-folder?view=msvc-170).

The installed `Microsoft.VC145.CRT` directory normally contains redistributable
payload files rather than a separate notice. If a future installed toolchain
ships a notice or license that its terms require distributors to carry, the
release must stop until that file is preserved in every derived carrier and its
presence is added to the package contract. Repository license metadata does not
relicense Microsoft's DLLs.

## Carrier model

- `liboliphaunt-native` is the one shared provider for native extensions. Its
  `provider` profile is the exact union required by the base runtime and every
  supported Windows extension: `msvcp140.dll`, `vcruntime140.dll`, and
  `vcruntime140_1.dll`. Separately versioned extension packages depend on the
  exact native-runtime product/version and do not duplicate these bytes.
- `oliphaunt-tools` and `oliphaunt-broker` are independently installable. Each
  carries only the transitive CRT closure derived from its own normal and
  delay-load PE imports.
- `oliphaunt-node-direct` currently imports no app-local VC runtime. Adding such
  an import requires its independently installed npm carrier to add and verify
  the corresponding exact closure.

Every carrier places required DLLs in the executable/DLL search directory and
ships `windows-vc-runtime.sha256`. Receipt lines are lowercase, bytewise sorted,
LF-terminated SHA-256 bindings. Repackagers read the receipt, copy exactly those
members, and rerun the PE/import and digest verifier; they must not maintain an
independent blind list. The native provider is the deliberate exception: its
named profile requires the full supported-extension union even when an affected
PR builds only a subset of extensions.

## Release evidence

The MSVC setup step fails before a long build unless `VCToolsRedistDir` resolves
the exact x64 VC145 directory and all audited production files. Windows build
and packaging then:

1. inspect normal and delay-import tables without relying on host PATH state;
2. strip Oliphaunt-produced binaries before staging redistributables;
3. atomically copy unmodified source bytes and write the digest receipt;
4. verify the exact carrier/profile closure and receipt after optimization;
5. preserve the receipt and DLLs through GitHub, npm, and Cargo carriers; and
6. run a clean-host smoke test with no preinstalled redistributable assumption.

For native extensions, the aggregate extension build is evidence for the
provider union: every supported Windows module import must be covered by the
provider profile, while the package graph enforces the exact native-runtime
dependency. A new CRT import fails policy until the audited profile, legal
review, carrier checks, and clean-host evidence are deliberately updated.
