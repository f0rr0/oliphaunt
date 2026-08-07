# @oliphaunt/icu

Portable ICU data files for Oliphaunt runtimes.

Install this package only when an application needs PostgreSQL ICU collations.
Base Oliphaunt runtime packages do not include ICU data.

The published package stores the ICU tree once, under
`OliphauntICU.bundle/share/icu`. Node, Bun, and Deno consumers should resolve
that directory from `oliphaunt.dataRelativePath` in the package metadata rather
than hard-coding its location.

On Apple platforms, `OliphauntICU.podspec` installs the prebuilt
`OliphauntICU.bundle` as one resource. Copying the bundle atomically preserves
the ICU subdirectories and prevents locale files with the same basename from
colliding during the Xcode build.

The carrier deliberately disables React Native autolinking on iOS and Android.
The `@oliphaunt/react-native` config plugin stages selected ICU data through its
app-owned native payload instead.
