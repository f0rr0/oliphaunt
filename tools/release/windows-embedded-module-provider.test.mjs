import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "../..");
const BUILD_SCRIPT = path.join(
  ROOT,
  "src/runtimes/liboliphaunt/native/bin/build-postgres18-windows.ps1",
);
const PATCH = path.join(
  ROOT,
  "src/runtimes/liboliphaunt/native/patches/postgresql-18.4/0019-liboliphaunt-link-windows-embedded-modules-to-host.patch",
);
const SIGNAL_BOUNDARY_PATCH = path.join(
  ROOT,
  "src/runtimes/liboliphaunt/native/patches/postgresql-18.4/0020-liboliphaunt-enforce-embedded-signal-boundary.patch",
);
const EMBEDDED_OPTION_PATCH = path.join(
  ROOT,
  "src/runtimes/liboliphaunt/native/patches/postgresql-18.4/0015-liboliphaunt-add-embedded-meson-option.patch",
);

describe("Windows embedded extension module provider", () => {
  test("patches PostgreSQL to replace the standalone module provider only for embedded MSVC builds", async () => {
    const source = await readFile(PATCH, "utf8");
    expect(source).toContain(
      "option('oliphaunt_embedded_module_provider', type: 'string', value: ''",
    );
    expect(source).toContain(
      "oliphaunt_embedded_module_provider requires an embedded MSVC Windows build",
    );
    expect(source).toContain(
      "pg_mod_link_args += oliphaunt_embedded_module_provider",
    );
    expect(source).toContain(
      "pg_mod_link_depend += oliphaunt_embedded_module_provider",
    );
    expect(source).toContain(
      "if oliphaunt_embedded_module_provider == '' and mod_link_args_fmt.length() > 0",
    );
  });

  test("creates the provider before compiling and staging every selected embedded module without overwriting server modules", async () => {
    const source = await readFile(BUILD_SCRIPT, "utf8");
    const linkHost = source.lastIndexOf("Link-LiboliphauntDll $objects");
    const buildModules = source.lastIndexOf("Build-EmbeddedModules");
    const stageRuntime = source.lastIndexOf("Stage-VcRuntimeClosure");
    expect(linkHost).toBeGreaterThan(-1);
    expect(buildModules).toBeGreaterThan(linkHost);
    expect(stageRuntime).toBeGreaterThan(buildModules);

    expect(source).toContain(
      'meson configure $EmbeddedBuildDir "-Doliphaunt_embedded_module_provider=$provider"',
    );
    expect(source).toContain("meson compile -C $EmbeddedBuildDir @targetNames");
    expect(source).toContain("$selectedModules = @(Get-SelectedEmbeddedExtensionModules)");
    expect(source).not.toContain(
      'Copy-Item -LiteralPath $staged -Destination $installed -Force',
    );
    expect(source).toContain("Assert-CompatibleModuleProfiles $server $embedded");
  });

  test("classifies selected modules by imports, rejects crossed providers, and permits only neutral identical profiles", async () => {
    const source = await readFile(BUILD_SCRIPT, "utf8");
    expect(source).toContain("function Get-ModuleHostBinding");
    expect(source).toContain("function Test-EmbeddedModuleHostContract");
    expect(source).toContain("function Test-ServerModuleHostContract");
    expect(source).toContain("function Test-CompatibleModuleProfiles");
    expect(source).toContain("function Assert-CompatibleModuleProfiles");
    expect(source).toMatch(/dumpbin\.exe \/dependents \$Binary/u);
    expect(source).toMatch(/oliphaunt\\\.dll/u);
    expect(source).toMatch(/postgres\\\.exe/u);
    expect(source).toContain('return "crossed"');
    expect(source).toContain('return "neutral"');
    expect(source).toContain(
      'Assert-EmbeddedModuleHostContract $plpgsqlSource $true',
    );
    expect(source).not.toContain('$stem -eq "plpgsql"');
    expect(source).toContain("Assert-EmbeddedModuleHostContract $source");
    expect(source).toContain(
      "Test-EmbeddedModuleHostContract $EmbeddedPlpgsqlDllOut $true",
    );
    expect(source).toContain(
      "may be host-neutral or import postgres.exe",
    );
    expect(source).toContain("$serverSha256 = Get-FileSha256 $ServerBinary");
    expect(source).toContain("$embeddedSha256 = Get-FileSha256 $EmbeddedBinary");
    expect(source).toContain('(Get-ModuleHostBinding $ServerBinary) -eq "neutral"');
    expect(source).toContain('(Get-ModuleHostBinding $EmbeddedBinary) -eq "neutral"');
    expect(source).toContain("-not (Embedded-ModulesReady)");
  });

  test("exports embedded signal shims through the host import library", async () => {
    const patch = await readFile(SIGNAL_BOUNDARY_PATCH, "utf8");
    const optionPatch = await readFile(EMBEDDED_OPTION_PATCH, "utf8");
    const source = await readFile(BUILD_SCRIPT, "utf8");

    expect(patch).toContain(
      "extern PGDLLIMPORT int oliphaunt_embedded_kill(pid_t pid, int signo);",
    );
    expect(patch).toContain("extern PGDLLIMPORT int oliphaunt_embedded_raise(int signo);");
    expect(optionPatch).toContain(
      "add_project_arguments('-DOLIPHAUNT_EMBEDDED', language: 'c')",
    );
    expect(source).toContain('"-Doliphaunt_embedded=true"');
    expect(source).toContain('$postgresDef = First-File $EmbeddedBuildDir "postgres.def"');
    expect(source).toContain('"/DEF:$postgresDef"');
    expect(source.match(/"oliphaunt_embedded_kill"/gu) ?? []).toHaveLength(2);
    expect(source.match(/"oliphaunt_embedded_raise"/gu) ?? []).toHaveLength(2);
  });
});
