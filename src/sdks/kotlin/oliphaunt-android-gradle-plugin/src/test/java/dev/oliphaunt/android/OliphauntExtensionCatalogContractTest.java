package dev.oliphaunt.android;

import groovy.json.JsonOutput;
import groovy.json.JsonSlurper;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Properties;
import java.util.TreeSet;
import java.util.concurrent.TimeUnit;
import java.util.zip.GZIPOutputStream;
import org.gradle.api.GradleException;
import org.gradle.testfixtures.ProjectBuilder;

public final class OliphauntExtensionCatalogContractTest {
  private OliphauntExtensionCatalogContractTest() {}

  public static void main(String[] args) throws Exception {
    createsManagedPluginExtensionWithoutGradleNameCollision();
    resolvesRuntimeBoundBundleOnceWithDependencyClosure();
    acceptsProductionShapedRuntimeBundlesForBothAndroidAbis();
    validatesExactNestedArtifactContract();
    validatesGeneratedExtensionLegalCatalog();
    validatesStrictExtensionManifestParser();
    validatesStrictBundleJsonParser();
    rejectsCarrierWrapperSiblings();
    validatesExactExtensionArtifactInventory();
    validatesPgcryptoAndPostgisLegalArtifacts();
    replaysExactReleaseArtifactsWhenConfigured();
    validatesCarrierBoundAncillaryExtensionSqlInventory();
    resolvesCanonicalEmptyAndSqlOnlyRegistriesEndToEnd();
    resolvesExternalAggregateWithoutStaticDependenciesEndToEnd();
    rejectsCrossAbiTargetInvariantDrift();
    rejectsConflictingSharedStaticDependencyArchives();
    rejectsDuplicateAndroidSelections();
    rejectsDuplicateNativeModuleStems();
    validatesNoCreateExtensionInventoryAndStaticRegistry();
    validatesStaticRegistrySymbolAliases();
    validatesExactLibdirStaticRegistrySymbols();
    validatesLinkTaskNdkBoundary();
    validatesMultiTargetRegistryDependencies();
    validatesRealNdkLinkWhenAvailable();
    validatesConfiguredCarrierLinkWhenRequested();
    validatesPublicTarGzArchivePreflight();
    rejectsNoncanonicalLegalUstarMode();
    requiresIndependentExternalVersion();
    rejectsConflictingOrUnlinkedVersions();
    rejectsMalformedTaskRuntimeVersions();
    rejectsIncompatibleExternalAndroidCarrier();
    rejectsMalformedGeneratedCatalog();
  }

  private static void createsManagedPluginExtensionWithoutGradleNameCollision()
      throws Exception {
    Path projectDir = Files.createTempDirectory("oliphaunt-managed-extension-");
    try {
      OliphauntAndroidExtension extension =
          ProjectBuilder.builder()
              .withProjectDir(projectDir.toFile())
              .build()
              .getExtensions()
              .create("oliphauntFixture", OliphauntAndroidExtension.class);
      extension.getSelectedExtensions().add("vector");
      equal(
          List.of("vector"),
          extension.getSelectedExtensions().get(),
          "managed selected-extension property");
    } finally {
      deleteRecursively(projectDir);
    }
  }

  private static void validatesPublicTarGzArchivePreflight() throws Exception {
    Path root = Files.createTempDirectory("oliphaunt-extension-archive-preflight-");
    try {
      PublicTarGzArchivePreflight.Limits extensionLimits =
          PublicTarGzArchivePreflight.extensionArtifactLimits();
      equal(134_217_728L, extensionLimits.maxCompressedBytes(), "extension compressed limit");
      equal(536_870_912L, extensionLimits.maxExpandedBytes(), "extension expanded limit");
      equal(268_435_456L, extensionLimits.maxEntryBytes(), "extension member limit");
      equal(4_096, extensionLimits.maxEntries(), "extension member-count limit");
      equal(
          extensionLimits.maxExpandedBytes(),
          PublicTarGzArchivePreflight.expansionLimitForContractTest(1, extensionLimits),
          "extension policy must not add a Java-only compression-ratio limit");
      if (!(64_676_748L <= extensionLimits.maxCompressedBytes()
          && 345_621_694L <= extensionLimits.maxExpandedBytes()
          && 154_827_564L <= extensionLimits.maxEntryBytes()
          && 27 <= extensionLimits.maxEntries())) {
        throw new AssertionError(
            "shared extension archive policy must admit the observed Android ARM64 PostGIS leaf shape");
      }
      List<TarFixtureEntry> validEntries =
          List.of(
              tarDirectory("extension-root/"),
              tarFile("extension-root/manifest.properties", "packageLayout=test\n"),
              tarFile("extension-root/files/control", "control\n"));
      Path valid = writeTarGz(root.resolve("valid-leaf.tar.gz"), tarBytes(validEntries));
      PublicTarGzArchivePreflight.Inspection validInspection =
          PublicTarGzArchivePreflight.validate(valid);
      equal(3, validInspection.entries(), "preflight entry count");
      equal(2, validInspection.regularFiles(), "preflight regular file count");
      Path validatedSnapshot = root.resolve("private/validated-leaf.tar.gz");
      PublicTarGzArchivePreflight.Inspection snapshotInspection =
          PublicTarGzArchivePreflight.snapshotAndValidate(valid, validatedSnapshot);
      equal(validInspection, snapshotInspection, "validated private snapshot inspection");
      equal(
          true,
          java.util.Arrays.equals(
              Files.readAllBytes(valid), Files.readAllBytes(validatedSnapshot)),
          "validated private snapshot bytes");
      Path collidingA = root.resolve("Aa/archive.tar.gz").toAbsolutePath().normalize();
      Path collidingB = root.resolve("BB/archive.tar.gz").toAbsolutePath().normalize();
      equal(
          collidingA.toString().hashCode(),
          collidingB.toString().hashCode(),
          "fixture must exercise the former 32-bit path hash collision");
      if (PublicTarGzArchivePreflight.sourceIdentity(collidingA)
          .equals(PublicTarGzArchivePreflight.sourceIdentity(collidingB))) {
        throw new AssertionError("SHA-256 archive path identities must not alias Aa and BB");
      }

      Path aggregate =
          writeTarGz(
              root.resolve("valid-aggregate.tar.gz"),
              tarBytes(
                  List.of(
                      tarFile("carrier/bundle-manifest.json", "{}\n"),
                      tarFile("carrier/extensions/cube/cube.tar.gz", "nested-carrier"))));
      equal(
          2,
          PublicTarGzArchivePreflight.validate(aggregate).regularFiles(),
          "aggregate preflight regular file count");

      for (char type : new char[] {'1', '2', '3', '4', '6'}) {
        Path malicious =
            writeTarGz(
                root.resolve("entry-type-" + type + ".tar.gz"),
                tarBytes(List.of(new TarFixtureEntry("root/payload", type, new byte[0]))));
        expectFailure(
            () -> PublicTarGzArchivePreflight.validate(malicious),
            "link or special ustar entry");
      }

      for (String path :
          List.of(
              "../escape",
              "root/../../escape",
              "/absolute",
              "C:/drive-escape",
              "root\\windows-escape",
              "root//ambiguous",
              "root/./ambiguous",
              "root/NUL.txt")) {
        Path malicious =
            writeTarGz(
                root.resolve("unsafe-" + Integer.toUnsignedString(path.hashCode()) + ".tar.gz"),
                tarBytes(List.of(tarFile(path, "malicious"))));
        expectFailure(() -> PublicTarGzArchivePreflight.validate(malicious), "unsafe");
      }

      for (List<TarFixtureEntry> entries :
          List.of(
              List.of(tarFile("root/file", "first"), tarFile("root/file", "second")),
              List.of(tarFile("root/File", "first"), tarFile("root/file", "second")),
              List.of(tarFile("root/file", "first"), tarFile("root/file/child", "second")),
              List.of(tarFile("root/file/child", "first"), tarFile("root/file", "second")))) {
        Path malicious =
            writeTarGz(
                root.resolve("path-conflict-" + entries.hashCode() + ".tar.gz"),
                tarBytes(entries));
        expectFailure(
            () -> PublicTarGzArchivePreflight.validate(malicious),
            entries.get(0).path().equalsIgnoreCase(entries.get(1).path())
                ? "duplicate or build-host-colliding"
                : "archive path conflict");
      }

      PublicTarGzArchivePreflight.Limits smallExpandedLimit =
          new PublicTarGzArchivePreflight.Limits(
              1024 * 1024, 1024, 1024 * 1024, 100, 1000, 1024);
      expectFailure(
          () -> PublicTarGzArchivePreflight.validate(valid, smallExpandedLimit),
          "decompression-bomb limit");

      PublicTarGzArchivePreflight.Limits oneEntryLimit =
          new PublicTarGzArchivePreflight.Limits(
              1024 * 1024, 1024 * 1024, 1024 * 1024, 1, 1000, 1024 * 1024);
      expectFailure(
          () -> PublicTarGzArchivePreflight.validate(aggregate, oneEntryLimit),
          "1-entry public archive limit");

      PublicTarGzArchivePreflight.Limits threeByteEntryLimit =
          new PublicTarGzArchivePreflight.Limits(
              1024 * 1024, 1024 * 1024, 3, 100, 1000, 1024 * 1024);
      expectFailure(
          () -> PublicTarGzArchivePreflight.validate(aggregate, threeByteEntryLimit),
          "3-byte per-entry limit");

      PublicTarGzArchivePreflight.Limits compressedLimit =
          new PublicTarGzArchivePreflight.Limits(
              Files.size(valid) - 1, 1024 * 1024, 1024 * 1024, 100, 1000, 1024 * 1024);
      expectFailure(
          () -> PublicTarGzArchivePreflight.validate(valid, compressedLimit),
          "compressed size must be between");

      byte[] nonzeroPadding = tarBytes(List.of(tarFile("root/one-byte", "x")));
      nonzeroPadding[512 + 1] = 1;
      Path badPadding = writeTarGz(root.resolve("nonzero-padding.tar.gz"), nonzeroPadding);
      expectFailure(
          () -> PublicTarGzArchivePreflight.validate(badPadding), "nonzero bytes in root/one-byte padding");

      byte[] badChecksumBytes = tarBytes(List.of(tarFile("root/checksum", "x")));
      badChecksumBytes[0] ^= 1;
      Path badChecksum = writeTarGz(root.resolve("bad-checksum.tar.gz"), badChecksumBytes);
      expectFailure(
          () -> PublicTarGzArchivePreflight.validate(badChecksum),
          "invalid ustar header checksum");

      byte[] trailingData = tarBytes(List.of(tarFile("root/trailing", "x")));
      byte[] withTrailingData = java.util.Arrays.copyOf(trailingData, trailingData.length + 1);
      withTrailingData[withTrailingData.length - 1] = 1;
      Path trailing = writeTarGz(root.resolve("trailing-data.tar.gz"), withTrailingData);
      expectFailure(
          () -> PublicTarGzArchivePreflight.validate(trailing),
          "data after its two-block ustar end marker");

      byte[] truncatedEndMarker = tarBytes(List.of(tarFile("root/truncated", "x")));
      truncatedEndMarker =
          java.util.Arrays.copyOf(truncatedEndMarker, truncatedEndMarker.length - 512);
      Path truncated = writeTarGz(root.resolve("truncated-end.tar.gz"), truncatedEndMarker);
      expectFailure(
          () -> PublicTarGzArchivePreflight.validate(truncated), "truncated ustar end marker");

      Path symlink = root.resolve("archive-symlink.tar.gz");
      try {
        Files.createSymbolicLink(symlink, valid.getFileName());
        expectFailure(
            () -> PublicTarGzArchivePreflight.validate(symlink),
            "regular non-symlink file");
      } catch (UnsupportedOperationException error) {
        // The tar-entry symlink case above remains portable to hosts without filesystem symlinks.
      } catch (java.io.IOException error) {
        if (!System.getProperty("os.name", "").toLowerCase(java.util.Locale.ROOT).contains("win")) {
          throw error;
        }
      }
    } finally {
      deleteRecursively(root);
    }
  }

  private static void rejectsNoncanonicalLegalUstarMode() throws Exception {
    Path root = Files.createTempDirectory("oliphaunt-legal-mode-");
    try {
      List<TarFixtureEntry> entries =
          canonicalLegalTarEntries(
              "oliphaunt-extension-contrib-pg18",
              "android-arm64-v8a",
              "aggregate",
              "carrier/");
      List<TarFixtureEntry> wrongMode = new ArrayList<>();
      for (TarFixtureEntry entry : entries) {
        wrongMode.add(
            entry.path().equals("carrier/LICENSE")
                ? new TarFixtureEntry(entry.path(), entry.type(), entry.bytes(), 0600)
                : entry);
      }
      Path archive =
          writeTarGz(root.resolve("wrong-legal-mode.tar.gz"), tarBytes(wrongMode));
      PublicTarGzArchivePreflight.Inspection inspection =
          PublicTarGzArchivePreflight.validate(archive);
      expectFailure(
          () ->
              ResolveOliphauntAndroidAssetsTask.validateLegalArchiveMembersForContractTest(
                  "oliphaunt-extension-contrib-pg18",
                  "android-arm64-v8a",
                  "aggregate",
                  inspection,
                  "carrier"),
          "must be one regular ustar mode=0644");
    } finally {
      deleteRecursively(root);
    }
  }

  private static TarFixtureEntry tarFile(String path, String contents) {
    return new TarFixtureEntry(path, '0', contents.getBytes(StandardCharsets.UTF_8));
  }

  private static TarFixtureEntry tarDirectory(String path) {
    return new TarFixtureEntry(path, '5', new byte[0]);
  }

  private static byte[] tarBytes(List<TarFixtureEntry> entries) throws Exception {
    ByteArrayOutputStream output = new ByteArrayOutputStream();
    for (TarFixtureEntry entry : entries) {
      byte[] header = new byte[512];
      byte[] path = entry.path().getBytes(StandardCharsets.UTF_8);
      if (path.length > 100) {
        throw new AssertionError("test fixture path exceeds the ustar name field: " + entry.path());
      }
      System.arraycopy(path, 0, header, 0, path.length);
      writeTarOctal(header, 100, 8, entry.mode());
      writeTarOctal(header, 108, 8, 0);
      writeTarOctal(header, 116, 8, 0);
      writeTarOctal(header, 124, 12, entry.bytes().length);
      writeTarOctal(header, 136, 12, 0);
      java.util.Arrays.fill(header, 148, 156, (byte) 0x20);
      header[156] = (byte) entry.type();
      if (entry.type() == '1' || entry.type() == '2') {
        byte[] link = "target".getBytes(StandardCharsets.UTF_8);
        System.arraycopy(link, 0, header, 157, link.length);
      }
      System.arraycopy("ustar\0".getBytes(StandardCharsets.US_ASCII), 0, header, 257, 6);
      System.arraycopy("00".getBytes(StandardCharsets.US_ASCII), 0, header, 263, 2);
      long checksum = 0;
      for (byte value : header) {
        checksum += value & 0xff;
      }
      String checksumText = String.format(java.util.Locale.ROOT, "%06o\0 ", checksum);
      System.arraycopy(
          checksumText.getBytes(StandardCharsets.US_ASCII), 0, header, 148, 8);
      output.write(header);
      output.write(entry.bytes());
      int padding = (512 - (entry.bytes().length % 512)) % 512;
      output.write(new byte[padding]);
    }
    output.write(new byte[1024]);
    return output.toByteArray();
  }

  private static void writeTarOctal(
      byte[] header, int offset, int length, long value) {
    String octal =
        String.format(java.util.Locale.ROOT, "%0" + (length - 1) + "o", value) + "\0";
    byte[] bytes = octal.getBytes(StandardCharsets.US_ASCII);
    if (bytes.length != length) {
      throw new AssertionError("test fixture octal field overflow: " + value);
    }
    System.arraycopy(bytes, 0, header, offset, length);
  }

  private static Path writeTarGz(Path archive, byte[] tar) throws Exception {
    try (GZIPOutputStream output = new GZIPOutputStream(Files.newOutputStream(archive))) {
      output.write(tar);
    }
    return archive;
  }

  private static void validatesStrictExtensionManifestParser() {
    Properties expected = cubeArtifactManifest();
    expected.setProperty("dataFiles", "extension/résumé.sql");
    String valid = artifactManifestText(expected);
    equal(
        expected,
        ResolveOliphauntAndroidAssetsTask.parseExtensionArtifactPropertiesForContractTest(
            valid.getBytes(StandardCharsets.UTF_8)),
        "strict UTF-8 manifest parse");
    equal(
        expected,
        ResolveOliphauntAndroidAssetsTask.parseExtensionArtifactPropertiesForContractTest(
            valid.replace("\n", "\r\n").getBytes(StandardCharsets.UTF_8)),
        "strict UTF-8 CRLF manifest parse");

    expectFailure(
        () ->
            ResolveOliphauntAndroidAssetsTask.parseExtensionArtifactPropertiesForContractTest(
                (valid + "sqlName=cube\n").getBytes(StandardCharsets.UTF_8)),
        "repeats property key sqlName");
    expectFailure(
        () ->
            ResolveOliphauntAndroidAssetsTask.parseExtensionArtifactPropertiesForContractTest(
                valid
                    .replace("dependencies=\n", "dependencies=cube\\\n")
                    .getBytes(StandardCharsets.UTF_8)),
        "forbidden property escape or continuation");
    expectFailure(
        () ->
            ResolveOliphauntAndroidAssetsTask.parseExtensionArtifactPropertiesForContractTest(
                valid
                    .replace("sqlName=cube\n", "sqlName=cu\\u0062e\n")
                    .getBytes(StandardCharsets.UTF_8)),
        "forbidden property escape or continuation");
    expectFailure(
        () ->
            ResolveOliphauntAndroidAssetsTask.parseExtensionArtifactPropertiesForContractTest(
                valid
                    .replace("sqlName=cube\n", "sqlName:cube\n")
                    .getBytes(StandardCharsets.UTF_8)),
        "literal key=value assignment");
    expectFailure(
        () ->
            ResolveOliphauntAndroidAssetsTask.parseExtensionArtifactPropertiesForContractTest(
                valid
                    .replace("sqlName=cube\n", "sqlName=cube=alias\n")
                    .getBytes(StandardCharsets.UTF_8)),
        "literal key=value assignment");
    expectFailure(
        () ->
            ResolveOliphauntAndroidAssetsTask.parseExtensionArtifactPropertiesForContractTest(
                valid
                    .replace("sqlName=cube\n", "sql_name=cube\n")
                    .getBytes(StandardCharsets.UTF_8)),
        "malformed property key sql_name");
    expectFailure(
        () ->
            ResolveOliphauntAndroidAssetsTask.parseExtensionArtifactPropertiesForContractTest(
                valid
                    .replace("sqlName=cube\n", "sqlname=cube\n")
                    .getBytes(StandardCharsets.UTF_8)),
        "unknown property key sqlname");
    expectFailure(
        () ->
            ResolveOliphauntAndroidAssetsTask.parseExtensionArtifactPropertiesForContractTest(
                (valid + "\n").getBytes(StandardCharsets.UTF_8)),
        "malformed physical line");
    expectFailure(
        () ->
            ResolveOliphauntAndroidAssetsTask.parseExtensionArtifactPropertiesForContractTest(
                (valid + "\0").getBytes(StandardCharsets.UTF_8)),
        "contains a NUL byte");
    expectFailure(
        () ->
            ResolveOliphauntAndroidAssetsTask.parseExtensionArtifactPropertiesForContractTest(
                new byte[] {(byte) 0xc3, 0x28}),
        "is not valid UTF-8");
  }

  private static void validatesStrictBundleJsonParser() throws Exception {
    Map<String, Object> parsed =
        StrictJsonObjectParser.parseObject(
            "{\"name\":\"cube\",\"bytes\":42,\"nested\":{\"enabled\":true}}"
                .getBytes(StandardCharsets.UTF_8),
            "contract-test JSON");
    equal("cube", parsed.get("name"), "strict JSON string");
    equal(Long.valueOf(42), parsed.get("bytes"), "strict JSON integer type");
    expectFailure(
        () ->
            StrictJsonObjectParser.parseObject(
                "{\"name\":\"cube\",\"name\":\"hstore\"}"
                    .getBytes(StandardCharsets.UTF_8),
                "contract-test JSON"),
        "repeats object key name");
    expectFailure(
        () ->
            StrictJsonObjectParser.parseObject(
                "{\"nested\":{\"key\":1,\"key\":2}}".getBytes(StandardCharsets.UTF_8),
                "contract-test JSON"),
        "repeats object key key");
    expectFailure(
        () ->
            StrictJsonObjectParser.parseObject(
                "{\"name\":\"cube\"} trailing".getBytes(StandardCharsets.UTF_8),
                "contract-test JSON"),
        "has trailing data");
    expectFailure(
        () ->
            StrictJsonObjectParser.parseObject(
                "\ufeff{\"name\":\"cube\"}".getBytes(StandardCharsets.UTF_8),
                "contract-test JSON"),
        "must not contain a UTF-8 BOM");

    Path root = Files.createTempDirectory("oliphaunt-strict-json-");
    try {
      Path oversized = root.resolve("bundle-manifest.json");
      Files.writeString(oversized, "{\"name\":\"cube\"}", StandardCharsets.UTF_8);
      expectFailure(
          () -> StrictJsonObjectParser.readObject(oversized, 4, "contract-test JSON"),
          "must be between 1 and 4 bytes");
    } finally {
      deleteRecursively(root);
    }
  }

  private static void validatesGeneratedExtensionLegalCatalog() throws Exception {
    for (String target : List.of("android-arm64-v8a", "android-x86_64")) {
      equal(
          "contrib-native",
          OliphauntExtensionLegalCatalog.requireLeaf("cube", target).profile(),
          target + " contrib legal profile");
      equal(
          "contrib-native-openssl",
          OliphauntExtensionLegalCatalog.requireLeaf("pgcrypto", target).profile(),
          target + " pgcrypto legal profile");
      equal(
          "contrib-native-openssl",
          OliphauntExtensionLegalCatalog
              .requireAggregate("oliphaunt-extension-contrib-pg18", target)
              .profile(),
          target + " contrib aggregate legal profile");
      OliphauntExtensionLegalCatalog.Contract postgis =
          OliphauntExtensionLegalCatalog.requireLeaf("postgis", target);
      equal("external-native", postgis.profile(), target + " PostGIS legal profile");
      equal(16, postgis.licenseFiles().size(), target + " PostGIS upstream license count");
      equal(18, postgis.members().size(), target + " PostGIS exact legal member count");
      for (OliphauntExtensionLegalCatalog.LegalMember member : postgis.members()) {
        equal(0644, member.mode(), target + " PostGIS legal mode " + member.path());
      }
    }

    for (String identity : List.of("cube", "pgcrypto", "postgis")) {
      OliphauntExtensionLegalCatalog.Contract arm =
          OliphauntExtensionLegalCatalog.requireLeaf(identity, "android-arm64-v8a");
      OliphauntExtensionLegalCatalog.Contract x86 =
          OliphauntExtensionLegalCatalog.requireLeaf(identity, "android-x86_64");
      equal(arm.product(), x86.product(), identity + " cross-ABI legal product");
      equal(arm.profile(), x86.profile(), identity + " cross-ABI legal profile");
      equal(arm.licenseFiles(), x86.licenseFiles(), identity + " cross-ABI licenseFiles");
      equal(arm.members(), x86.members(), identity + " cross-ABI legal members");
    }

    byte[] bundled;
    try (var input =
        OliphauntExtensionLegalCatalog.class.getResourceAsStream(
            "/dev/oliphaunt/android/extension-legal-catalog.json")) {
      if (input == null) {
        throw new AssertionError("missing packaged Android extension legal catalog");
      }
      bundled = input.readAllBytes();
    }
    String text = new String(bundled, StandardCharsets.UTF_8);
    expectFailure(
        () ->
            OliphauntExtensionLegalCatalog.parseForContractTest(
                text.replaceFirst(
                        "\\\"profile\\\": \\\"contrib-native-openssl\\\"",
                        "\\\"profile\\\": \\\"external-native\\\"")
                    .getBytes(StandardCharsets.UTF_8)),
        "profile must be contrib-native-openssl");
    expectFailure(
        () ->
            OliphauntExtensionLegalCatalog.parseForContractTest(
                text.replaceFirst("\\\"path\\\": \\\"LICENSE\\\"", "\\\"path\\\": \\\"../LICENSE\\\"")
                    .getBytes(StandardCharsets.UTF_8)),
        "unsafe legal member path");
    expectFailure(
        () ->
            OliphauntExtensionLegalCatalog.parseForContractTest(
                text.replaceFirst(
                        "\\\"sourceCatalogSha256\\\": \\\"[0-9a-f]{64}\\\"",
                        "\\\"sourceCatalogSha256\\\": \\\"" + "0".repeat(64) + "\\\"")
                    .getBytes(StandardCharsets.UTF_8)),
        "does not match extensions.properties");
  }

  private static void rejectsCarrierWrapperSiblings() throws Exception {
    Path root = Files.createTempDirectory("oliphaunt-wrapper-inventory-");
    try {
      Path bundleWrapper = root.resolve("bundle");
      Files.createDirectories(bundleWrapper);
      Files.writeString(bundleWrapper.resolve("bundle-manifest.json"), "{}", StandardCharsets.UTF_8);
      Files.writeString(root.resolve("undeclared.txt"), "fault", StandardCharsets.UTF_8);
      expectFailure(
          () -> ResolveOliphauntAndroidAssetsTask.bundleRootForContractTest(root.toFile()),
          "no undeclared siblings");

      Files.delete(bundleWrapper.resolve("bundle-manifest.json"));
      Files.writeString(bundleWrapper.resolve("manifest.properties"), "packageLayout=test\n");
      expectFailure(
          () -> ResolveOliphauntAndroidAssetsTask.artifactRootForContractTest(root.toFile()),
          "no undeclared siblings");
    } finally {
      deleteRecursively(root);
    }
  }

  private static void validatesExactExtensionArtifactInventory() throws Exception {
    Path root = Files.createTempDirectory("oliphaunt-extension-inventory-");
    Properties manifest = cubeArtifactManifest();
    try {
      writeInventoryFile(root, "manifest.properties", artifactManifestText(manifest));
      writeInventoryFile(root, "files/lib/postgresql/cube.so", "native");
      writeInventoryFile(
          root, "files/share/postgresql/extension/cube.control", "default_version='1.0'\n");
      writeInventoryFile(
          root, "files/share/postgresql/extension/cube--1.0.sql", "CREATE TYPE cube;\n");
      writeInventoryFile(
          root,
          "mobile-static/android-arm64-v8a/extensions/cube/liboliphaunt_extension_cube.a",
          "archive");
      stageCanonicalLegalFiles(root, "cube", "android-arm64-v8a");
      ResolveOliphauntAndroidAssetsTask.validateExtensionArtifactInventoryForContractTest(
          root.toFile(), manifest);

      Path license = root.resolve("LICENSE");
      byte[] tamperedLicense = Files.readAllBytes(license);
      tamperedLicense[0] ^= 1;
      Files.write(license, tamperedLicense);
      expectFailure(
          () ->
              ResolveOliphauntAndroidAssetsTask
                  .validateExtensionArtifactInventoryForContractTest(root.toFile(), manifest),
          "legal member LICENSE does not match its canonical SHA-256");
      stageCanonicalLegalFiles(root, "cube", "android-arm64-v8a");
      Files.delete(root.resolve("THIRD_PARTY_NOTICES.md"));
      expectFailure(
          () ->
              ResolveOliphauntAndroidAssetsTask
                  .validateExtensionArtifactInventoryForContractTest(root.toFile(), manifest),
          "missing=[THIRD_PARTY_NOTICES.md]");
      stageCanonicalLegalFiles(root, "cube", "android-arm64-v8a");
      Path extraLegal =
          writeInventoryFile(
              root, "THIRD_PARTY_LICENSES/UNDECLARED-LICENSE", "undeclared\n");
      expectFailure(
          () ->
              ResolveOliphauntAndroidAssetsTask
                  .validateExtensionArtifactInventoryForContractTest(root.toFile(), manifest),
          "unexpected=[THIRD_PARTY_LICENSES/UNDECLARED-LICENSE]");
      Files.delete(extraLegal);

      Properties wrongProfile = new Properties();
      wrongProfile.putAll(manifest);
      wrongProfile.setProperty("licenseProfile", "external-native");
      expectFailure(
          () ->
              ResolveOliphauntAndroidAssetsTask.validateExtensionManifestForContractTest(
                  "oliphaunt-extension-contrib-pg18",
                  "cube",
                  "android-arm64-v8a",
                  wrongProfile,
                  "1.2.3"),
          "must declare licenseProfile=contrib-native");
      Properties unsafeLicenseFile = new Properties();
      unsafeLicenseFile.putAll(manifest);
      unsafeLicenseFile.setProperty("licenseFiles", "../LICENSE");
      expectFailure(
          () ->
              ResolveOliphauntAndroidAssetsTask.validateExtensionManifestForContractTest(
                  "oliphaunt-extension-contrib-pg18",
                  "cube",
                  "android-arm64-v8a",
                  unsafeLicenseFile,
                  "1.2.3"),
          "licenseFiles do not match the exact legal contract");

      Path unrelated =
          writeInventoryFile(
              root,
              "files/share/postgresql/extension/hstore.control",
              "default_version='1.0'\n");
      expectFailure(
          () ->
              ResolveOliphauntAndroidAssetsTask
                  .validateExtensionArtifactInventoryForContractTest(root.toFile(), manifest),
          "unexpected=[files/share/postgresql/extension/hstore.control]");
      Properties aliasedDataFile = new Properties();
      aliasedDataFile.putAll(manifest);
      aliasedDataFile.setProperty("dataFiles", "extension/hstore.control");
      expectFailure(
          () ->
              ResolveOliphauntAndroidAssetsTask
                  .validateExtensionArtifactInventoryForContractTest(
                      root.toFile(), aliasedDataFile),
          "dataFiles must not alias extension SQL/control inventory");
      Files.delete(unrelated);

      Path nativeModule = root.resolve("files/lib/postgresql/cube.so");
      Files.delete(nativeModule);
      expectFailure(
          () ->
              ResolveOliphauntAndroidAssetsTask
                  .validateExtensionArtifactInventoryForContractTest(root.toFile(), manifest),
          "missing=[files/lib/postgresql/cube.so]");
      writeInventoryFile(root, "files/lib/postgresql/cube.so", "native");

      Path control = root.resolve("files/share/postgresql/extension/cube.control");
      Files.delete(control);
      expectFailure(
          () ->
              ResolveOliphauntAndroidAssetsTask
                  .validateExtensionArtifactInventoryForContractTest(root.toFile(), manifest),
          "must contain files/share/postgresql/extension/cube.control");
      writeInventoryFile(root, "files/share/postgresql/extension/cube.control", "control\n");

      Path installSql = root.resolve("files/share/postgresql/extension/cube--1.0.sql");
      Files.delete(installSql);
      expectFailure(
          () ->
              ResolveOliphauntAndroidAssetsTask
                  .validateExtensionArtifactInventoryForContractTest(root.toFile(), manifest),
          "and a canonical install SQL file for cube");
    } finally {
      deleteRecursively(root);
    }
  }

  private static Path writeInventoryFile(Path root, String relative, String contents)
      throws Exception {
    Path file = root.resolve(relative);
    Files.createDirectories(file.getParent());
    Files.writeString(file, contents, StandardCharsets.UTF_8);
    return file;
  }

  private static void validatesPgcryptoAndPostgisLegalArtifacts() throws Exception {
    Path root = Files.createTempDirectory("oliphaunt-special-legal-artifacts-");
    try {
      Path pgcryptoRoot = Files.createDirectories(root.resolve("pgcrypto"));
      Properties pgcrypto = cubeArtifactManifest();
      pgcrypto.setProperty("sqlName", "pgcrypto");
      pgcrypto.setProperty("nativeModuleStem", "pgcrypto");
      pgcrypto.setProperty("nativeModuleFile", "pgcrypto.so");
      pgcrypto.setProperty("staticSymbolPrefix", "oliphaunt_static_pgcrypto");
      pgcrypto.setProperty(
          "mobileStaticArchives",
          "android-arm64-v8a:mobile-static/android-arm64-v8a/extensions/pgcrypto/liboliphaunt_extension_pgcrypto.a");
      pgcrypto.setProperty(
          "mobileStaticDependencyArchives",
          "android-arm64-v8a:openssl:mobile-static/android-arm64-v8a/dependencies/openssl/libcrypto.a");
      applyCanonicalLegalManifest(pgcrypto, "pgcrypto", "android-arm64-v8a");
      writeInventoryFile(pgcryptoRoot, "manifest.properties", artifactManifestText(pgcrypto));
      writeInventoryFile(pgcryptoRoot, "files/lib/postgresql/pgcrypto.so", "native\n");
      writeInventoryFile(
          pgcryptoRoot,
          "files/share/postgresql/extension/pgcrypto.control",
          "default_version='1.0'\n");
      writeInventoryFile(
          pgcryptoRoot,
          "files/share/postgresql/extension/pgcrypto--1.0.sql",
          "CREATE TYPE pgcrypto_fixture;\n");
      writeInventoryFile(
          pgcryptoRoot,
          "mobile-static/android-arm64-v8a/extensions/pgcrypto/liboliphaunt_extension_pgcrypto.a",
          "archive\n");
      writeInventoryFile(
          pgcryptoRoot,
          "mobile-static/android-arm64-v8a/dependencies/openssl/libcrypto.a",
          "openssl archive\n");
      stageCanonicalLegalFiles(pgcryptoRoot, "pgcrypto", "android-arm64-v8a");
      ResolveOliphauntAndroidAssetsTask.validateExtensionManifestForContractTest(
          "oliphaunt-extension-contrib-pg18",
          "pgcrypto",
          "android-arm64-v8a",
          pgcrypto,
          "1.2.3");
      ResolveOliphauntAndroidAssetsTask.validateExtensionArtifactInventoryForContractTest(
          pgcryptoRoot.toFile(), pgcrypto);
      equal(
          true,
          Files.isRegularFile(
              pgcryptoRoot.resolve("THIRD_PARTY_LICENSES/OpenSSL-LICENSE.txt")),
          "pgcrypto OpenSSL legal member");

      Path postgisRoot = Files.createDirectories(root.resolve("postgis"));
      Properties postgis = cubeArtifactManifest();
      postgis.setProperty("sqlName", "postgis");
      postgis.setProperty("nativeModuleStem", "postgis-3");
      postgis.setProperty("nativeModuleFile", "postgis-3.so");
      postgis.setProperty("staticSymbolPrefix", "oliphaunt_static_postgis_3");
      postgis.setProperty(
          "mobileStaticArchives",
          "android-arm64-v8a:mobile-static/android-arm64-v8a/extensions/postgis-3/liboliphaunt_extension_postgis-3.a");
      applyCanonicalLegalManifest(postgis, "postgis", "android-arm64-v8a");
      writeInventoryFile(postgisRoot, "manifest.properties", artifactManifestText(postgis));
      writeInventoryFile(postgisRoot, "files/lib/postgresql/postgis-3.so", "native\n");
      writeInventoryFile(
          postgisRoot,
          "files/share/postgresql/extension/postgis.control",
          "default_version='3.6.3'\n");
      writeInventoryFile(
          postgisRoot,
          "files/share/postgresql/extension/postgis--3.6.3.sql",
          "CREATE TYPE postgis_fixture;\n");
      writeInventoryFile(
          postgisRoot,
          "mobile-static/android-arm64-v8a/extensions/postgis-3/liboliphaunt_extension_postgis-3.a",
          "archive\n");
      stageCanonicalLegalFiles(postgisRoot, "postgis", "android-arm64-v8a");
      ResolveOliphauntAndroidAssetsTask.validateExtensionManifestForContractTest(
          "oliphaunt-extension-postgis",
          "postgis",
          "android-arm64-v8a",
          postgis,
          "1.2.3");
      ResolveOliphauntAndroidAssetsTask.validateExtensionArtifactInventoryForContractTest(
          postgisRoot.toFile(), postgis);
      long upstreamFiles;
      try (var files = Files.walk(postgisRoot.resolve("files/share/licenses"))) {
        upstreamFiles = files.filter(Files::isRegularFile).count();
      }
      equal(16L, upstreamFiles, "PostGIS exact upstream legal file count");
    } finally {
      deleteRecursively(root);
    }
  }

  private static void replaysExactReleaseArtifactsWhenConfigured() throws Exception {
    String extensionRootValue = System.getenv("OLIPHAUNT_ANDROID_EXTENSION_REPLAY_ROOT");
    String runtimeRootValue = System.getenv("OLIPHAUNT_ANDROID_RUNTIME_REPLAY_ROOT");
    if (extensionRootValue == null && runtimeRootValue == null) {
      return;
    }
    if (extensionRootValue == null || runtimeRootValue == null) {
      throw new AssertionError(
          "exact Android replay requires both OLIPHAUNT_ANDROID_EXTENSION_REPLAY_ROOT and "
              + "OLIPHAUNT_ANDROID_RUNTIME_REPLAY_ROOT");
    }

    Path extensionRoot = Path.of(extensionRootValue).toAbsolutePath().normalize();
    Path runtimeRoot = Path.of(runtimeRootValue).toAbsolutePath().normalize();
    if (!Files.isDirectory(extensionRoot) || !Files.isDirectory(runtimeRoot)) {
      throw new AssertionError(
          "exact Android replay roots must both be existing directories: "
              + extensionRoot
              + ", "
              + runtimeRoot);
    }

    List<Path> extensionArtifacts;
    try (var paths = Files.walk(extensionRoot)) {
      extensionArtifacts =
          paths
              .filter(Files::isRegularFile)
              .filter(path -> path.getParent().getFileName().toString().equals("release-assets"))
              .filter(
                  path ->
                      path.getFileName()
                          .toString()
                          .matches(
                              "oliphaunt-extension-.*-0\\.0\\.0-native-android-"
                                  + "(arm64-v8a|x86_64)-(bundle|runtime)\\.tar\\.gz"))
              .sorted()
              .toList();
    }
    equal(16, extensionArtifacts.size(), "exact replay Android release carrier count");

    List<Path> runtimeArtifacts =
        List.of(
            runtimeRoot.resolve("liboliphaunt-0.0.0-runtime-resources.tar.gz"),
            runtimeRoot.resolve("liboliphaunt-0.0.0-android-arm64-v8a.tar.gz"),
            runtimeRoot.resolve("liboliphaunt-0.0.0-android-x86_64.tar.gz"));
    for (Path artifact : runtimeArtifacts) {
      if (!Files.isRegularFile(artifact)) {
        throw new AssertionError("exact replay is missing runtime carrier " + artifact);
      }
    }

    List<String> sqlNames = OliphauntExtensionCatalog.sqlNames();
    equal(39, sqlNames.size(), "exact replay selected extension count");
    LinkedHashMap<String, String> ownerVersions = new LinkedHashMap<>();
    for (String sqlName : sqlNames) {
      ownerVersions.put(OliphauntExtensionCatalog.require(sqlName).releaseProduct(), "0.0.0");
    }
    equal(8, ownerVersions.size(), "exact replay release owner count");

    Path root = Files.createTempDirectory("oliphaunt-exact-android-release-replay-");
    try {
      Path projectDir = Files.createDirectories(root.resolve("project"));
      ResolveOliphauntAndroidAssetsTask resolve =
          ProjectBuilder.builder()
              .withProjectDir(projectDir.toFile())
              .build()
              .getTasks()
              .create("exactReleaseReplay", ResolveOliphauntAndroidAssetsTask.class);
      resolve.getVersion().set("0.0.0");
      resolve.getSelectedAbis().set(List.of("arm64-v8a", "x86_64"));
      resolve.getSelectedExtensions().set(sqlNames);
      resolve.getExtensionOwnerVersions().set(ownerVersions);
      resolve.getIcu().set(false);
      resolve.getRuntimeArtifacts().from(runtimeArtifacts.stream().map(Path::toFile).toList());
      resolve.getExtensionArtifacts().from(extensionArtifacts.stream().map(Path::toFile).toList());
      Path runtimeOutput = root.resolve("runtime-resources");
      Path jniOutput = root.resolve("jniLibs");
      Path archiveOutput = root.resolve("extensionArchives");
      resolve.getRuntimeResourcesDir().set(runtimeOutput.toFile());
      resolve.getJniLibsDir().set(jniOutput.toFile());
      resolve.getExtensionArchivesDir().set(archiveOutput.toFile());
      resolve.resolve();

      String runtimeManifest =
          Files.readString(
              runtimeOutput.resolve("oliphaunt/runtime/manifest.properties"),
              StandardCharsets.UTF_8);
      requireContains(
          runtimeManifest,
          "selectedExtensions=" + String.join(",", sqlNames) + "\n",
          "exact replay selected extension closure");
      String registryManifest =
          Files.readString(
              runtimeOutput.resolve("oliphaunt/static-registry/manifest.properties"),
              StandardCharsets.UTF_8);
      requireContains(registryManifest, "postgis-3", "exact replay PostGIS static module");
      requireContains(
          registryManifest,
          "archiveTargets=android-arm64-v8a,android-x86_64\n",
          "exact replay cross-ABI archive targets");
      for (String target : List.of("android-arm64-v8a", "android-x86_64")) {
        equal(
            true,
            Files.isRegularFile(
                archiveOutput
                    .resolve(target)
                    .resolve("extensions/postgis-3/liboliphaunt_extension_postgis-3.a")),
            "exact replay PostGIS archive " + target);
      }
      equal(
          true,
          Files.isRegularFile(
              runtimeOutput.resolve(
                  "oliphaunt/runtime/files/share/licenses/postgis/COPYING")),
          "exact replay PostGIS upstream license payload");
    } finally {
      deleteRecursively(root);
    }
  }

  private static void validatesCarrierBoundAncillaryExtensionSqlInventory()
      throws Exception {
    Path root = Files.createTempDirectory("oliphaunt-ancillary-sql-inventory-");
    Properties manifest = cubeArtifactManifest();
    manifest.setProperty("sqlName", "pgtap");
    manifest.setProperty("nativeModuleStem", "");
    manifest.setProperty("nativeModuleFile", "");
    manifest.setProperty("mobilePrebuilt", "no");
    manifest.setProperty("mobileStaticArchives", "");
    manifest.setProperty("staticSymbolPrefix", "");
    manifest.setProperty("extensionSqlFileNames", "uninstall_legacy_pgtap.sql");
    manifest.setProperty("extensionSqlFilePrefixes", "legacy-pgtap-helper");
    applyCanonicalLegalManifest(manifest, "pgtap", "android-arm64-v8a");
    try {
      writeInventoryFile(root, "manifest.properties", artifactManifestText(manifest));
      writeInventoryFile(
          root,
          "files/share/postgresql/extension/pgtap.control",
          "default_version='1.0'\n");
      stageCanonicalLegalFiles(root, "pgtap", "android-arm64-v8a");
      Path ancillary =
          writeInventoryFile(
              root,
              "files/share/postgresql/extension/legacy-pgtap-helper--fixture.sql",
              "SELECT 1;\n");
      expectFailure(
          () ->
              ResolveOliphauntAndroidAssetsTask
                  .validateExtensionArtifactInventoryForContractTest(root.toFile(), manifest),
          "and a canonical install SQL file for pgtap");

      writeInventoryFile(
          root,
          "files/share/postgresql/extension/pgtap--1.0.sql",
          "CREATE TYPE pgtap_fixture;\n");
      writeInventoryFile(
          root,
          "files/share/postgresql/extension/uninstall_legacy_pgtap.sql",
          "DROP TYPE pgtap_fixture;\n");
      ResolveOliphauntAndroidAssetsTask.validateExtensionArtifactInventoryForContractTest(
          root.toFile(), manifest);

      Files.delete(ancillary);
      Path lookalike =
          writeInventoryFile(
              root,
              "files/share/postgresql/extension/pgtap-undeclared.sql",
              "SELECT 1;\n");
      expectFailure(
          () ->
              ResolveOliphauntAndroidAssetsTask
                  .validateExtensionArtifactInventoryForContractTest(root.toFile(), manifest),
          "unexpected=[files/share/postgresql/extension/pgtap-undeclared.sql]");
      Files.delete(lookalike);
    } finally {
      deleteRecursively(root);
    }
  }

  private static void resolvesCanonicalEmptyAndSqlOnlyRegistriesEndToEnd()
      throws Exception {
    Path root = Files.createTempDirectory("oliphaunt-empty-sql-only-resolve-");
    try {
      Path carriers = Files.createDirectories(root.resolve("carriers"));
      RuntimeCarrierSet runtimeCarriers = writeCanonicalRuntimeCarrierSet(carriers);
      Path projectDir = Files.createDirectories(root.resolve("project"));
      var project = ProjectBuilder.builder().withProjectDir(projectDir.toFile()).build();

      ResolveOliphauntAndroidAssetsTask emptyResolve =
          project
              .getTasks()
              .create("resolveEmptySelectionFixture", ResolveOliphauntAndroidAssetsTask.class);
      emptyResolve.getVersion().set("1.2.3");
      emptyResolve.getSelectedAbis().set(List.of("x86_64"));
      emptyResolve.getSelectedExtensions().set(List.of());
      emptyResolve.getExtensionOwnerVersions().set(Map.of());
      emptyResolve.getIcu().set(false);
      emptyResolve
          .getRuntimeArtifacts()
          .from(runtimeCarriers.resources(), runtimeCarriers.x86Runtime());
      Path emptyRuntimeOutput = root.resolve("empty/runtime-resources");
      Path emptyJniOutput = root.resolve("empty/jniLibs");
      Path emptyArchiveOutput = root.resolve("empty/extensionArchives");
      emptyResolve.getRuntimeResourcesDir().set(emptyRuntimeOutput.toFile());
      emptyResolve.getJniLibsDir().set(emptyJniOutput.toFile());
      emptyResolve.getExtensionArchivesDir().set(emptyArchiveOutput.toFile());
      emptyResolve.resolve();
      equal(
          canonicalEmptyStaticRegistryManifest(),
          Files.readString(
              emptyRuntimeOutput.resolve("oliphaunt/static-registry/manifest.properties"),
              StandardCharsets.UTF_8),
          "canonical empty selection registry");
      String emptyCacheKey =
          assertRuntimeResourceAccounting(
              emptyRuntimeOutput, Map.of(), "canonical-runtime-fixture");

      LinkOliphauntAndroidExtensionsTask emptyLink =
          project
              .getTasks()
              .create("linkEmptySelectionFixture", LinkOliphauntAndroidExtensionsTask.class);
      emptyLink.getSelectedAbis().set(List.of("x86_64"));
      emptyLink.getRuntimeResourcesDir().set(emptyRuntimeOutput.toFile());
      emptyLink.getJniLibsDir().set(emptyJniOutput.toFile());
      emptyLink.getExtensionArchivesDir().set(emptyArchiveOutput.toFile());
      emptyLink.getOutputDirectory().set(root.resolve("empty/linked").toFile());
      emptyLink.link();
      equal(false, emptyLink.getNdkDirectory().isPresent(), "empty selection NDK absence");

      Path pgtapCarrier =
          writeSingleMemberAggregateCarrier(
              carriers,
              "android-x86_64",
              "pgtap",
              "oliphaunt-extension-pgtap",
              "0.9.0",
              null);
      ResolveOliphauntAndroidAssetsTask sqlOnlyResolve =
          project
              .getTasks()
              .create("resolveSqlOnlySelectionFixture", ResolveOliphauntAndroidAssetsTask.class);
      sqlOnlyResolve.getVersion().set("1.2.3");
      sqlOnlyResolve.getSelectedAbis().set(List.of("x86_64"));
      sqlOnlyResolve.getSelectedExtensions().set(List.of("pgtap"));
      sqlOnlyResolve
          .getExtensionOwnerVersions()
          .set(Map.of("oliphaunt-extension-pgtap", "0.9.0"));
      sqlOnlyResolve.getIcu().set(false);
      sqlOnlyResolve
          .getRuntimeArtifacts()
          .from(runtimeCarriers.resources(), runtimeCarriers.x86Runtime());
      sqlOnlyResolve.getExtensionArtifacts().from(pgtapCarrier);
      Path sqlOnlyRuntimeOutput = root.resolve("sql-only/runtime-resources");
      Path sqlOnlyJniOutput = root.resolve("sql-only/jniLibs");
      Path sqlOnlyArchiveOutput = root.resolve("sql-only/extensionArchives");
      sqlOnlyResolve.getRuntimeResourcesDir().set(sqlOnlyRuntimeOutput.toFile());
      sqlOnlyResolve.getJniLibsDir().set(sqlOnlyJniOutput.toFile());
      sqlOnlyResolve.getExtensionArchivesDir().set(sqlOnlyArchiveOutput.toFile());
      sqlOnlyResolve.resolve();
      equal(
          canonicalEmptyStaticRegistryManifest(),
          Files.readString(
              sqlOnlyRuntimeOutput.resolve("oliphaunt/static-registry/manifest.properties"),
              StandardCharsets.UTF_8),
          "canonical SQL-only selection registry");
      requireContains(
          Files.readString(
              sqlOnlyRuntimeOutput.resolve("oliphaunt/runtime/manifest.properties"),
              StandardCharsets.UTF_8),
          "selectedExtensions=pgtap\n",
          "SQL-only full runtime selection");
      requireContains(
          Files.readString(
              sqlOnlyRuntimeOutput.resolve("oliphaunt/runtime/manifest.properties"),
              StandardCharsets.UTF_8),
          "extensions=pgtap\n",
          "SQL-only createable runtime selection");
      equal(
          true,
          Files.isRegularFile(
              sqlOnlyRuntimeOutput
                  .resolve("oliphaunt/runtime/files/share/postgresql/extension/pgtap.control")),
          "SQL-only extension control file");
      String sqlOnlyCacheKey =
          assertRuntimeResourceAccounting(
              sqlOnlyRuntimeOutput,
              Map.of(
                  "pgtap",
                  List.of(
                      "share/postgresql/extension/pgtap--1.0.sql",
                      "share/postgresql/extension/pgtap.control")),
              "canonical-runtime-fixture");
      if (emptyCacheKey.equals(sqlOnlyCacheKey)) {
        throw new AssertionError(
            "empty and SQL-only Android runtime selections must not share a cache key");
      }

      LinkOliphauntAndroidExtensionsTask sqlOnlyLink =
          project
              .getTasks()
              .create("linkSqlOnlySelectionFixture", LinkOliphauntAndroidExtensionsTask.class);
      sqlOnlyLink.getSelectedAbis().set(List.of("x86_64"));
      sqlOnlyLink.getRuntimeResourcesDir().set(sqlOnlyRuntimeOutput.toFile());
      sqlOnlyLink.getJniLibsDir().set(sqlOnlyJniOutput.toFile());
      sqlOnlyLink.getExtensionArchivesDir().set(sqlOnlyArchiveOutput.toFile());
      sqlOnlyLink.getOutputDirectory().set(root.resolve("sql-only/linked").toFile());
      sqlOnlyLink.link();
      equal(false, sqlOnlyLink.getNdkDirectory().isPresent(), "SQL-only selection NDK absence");
    } finally {
      deleteRecursively(root);
    }
  }

  private static RuntimeCarrierSet writeCanonicalRuntimeCarrierSet(Path carriers)
      throws Exception {
    Path resources =
        writeTarGz(
            carriers.resolve("liboliphaunt-1.2.3-runtime-resources.tar.gz"),
            tarBytes(
                List.of(
                    tarFile(
                        "oliphaunt/runtime/manifest.properties",
                        "schema=oliphaunt-runtime-resources-v1\n"
                            + "cacheKey=canonical-runtime-fixture\n"
                            + "layout=postgres-runtime-files-v1\n"
                            + "extensions=\n"
                            + "runtimeFeatures=\n"
                            + "sharedPreloadLibraries=\n"
                            + "mobileStaticRegistryState=not-required\n"
                            + "mobileStaticRegistryRegistered=\n"
                            + "mobileStaticRegistryPending=\n"
                            + "nativeModuleStems=\n"
                            + "mobileStaticRegistrySource=\n"),
                    tarFile("oliphaunt/runtime/files/README.fixture", "runtime\n"),
                    tarFile(
                        "oliphaunt/static-registry/manifest.properties",
                        canonicalEmptyStaticRegistryManifest()))));
    Path armRuntime =
        writeTarGz(
            carriers.resolve("liboliphaunt-1.2.3-android-arm64-v8a.tar.gz"),
            tarBytes(
                List.of(
                    tarFile("jni/arm64-v8a/liboliphaunt.so", "arm64 runtime fixture\n"))));
    Path x86Runtime =
        writeTarGz(
            carriers.resolve("liboliphaunt-1.2.3-android-x86_64.tar.gz"),
            tarBytes(
                List.of(tarFile("jni/x86_64/liboliphaunt.so", "x86 runtime fixture\n"))));
    return new RuntimeCarrierSet(resources, armRuntime, x86Runtime);
  }

  private static void resolvesExternalAggregateWithoutStaticDependenciesEndToEnd()
      throws Exception {
    Path root = Files.createTempDirectory("oliphaunt-external-aggregate-resolve-");
    try {
      Path carriers = Files.createDirectories(root.resolve("carriers"));
      Path runtimeResources =
          writeTarGz(
              carriers.resolve("liboliphaunt-1.2.3-runtime-resources.tar.gz"),
              tarBytes(
                  List.of(
                      tarFile(
                          "oliphaunt/runtime/manifest.properties",
                          "schema=oliphaunt-runtime-resources-v1\n"
                              + "cacheKey=aggregate-resolve-fixture\n"
                              + "layout=postgres-runtime-files-v1\n"
                              + "extensions=\n"
                              + "runtimeFeatures=\n"
                              + "sharedPreloadLibraries=\n"
                              + "mobileStaticRegistryState=not-required\n"
                              + "mobileStaticRegistryRegistered=\n"
                              + "mobileStaticRegistryPending=\n"
                              + "nativeModuleStems=\n"
                              + "mobileStaticRegistrySource=\n"),
                      tarFile("oliphaunt/runtime/files/README.fixture", "runtime\n"),
                      tarFile(
                          "oliphaunt/static-registry/manifest.properties",
                          canonicalEmptyStaticRegistryManifest()))));
      Path armRuntime =
          writeTarGz(
              carriers.resolve("liboliphaunt-1.2.3-android-arm64-v8a.tar.gz"),
              tarBytes(
                  List.of(
                      tarFile("jni/arm64-v8a/liboliphaunt.so", "arm64 runtime fixture\n"))));
      Path x86Runtime =
          writeTarGz(
              carriers.resolve("liboliphaunt-1.2.3-android-x86_64.tar.gz"),
              tarBytes(
                  List.of(tarFile("jni/x86_64/liboliphaunt.so", "x86 runtime fixture\n"))));
      Path armExtension = writeVectorAggregateCarrier(carriers, "android-arm64-v8a");
      Path x86Extension = writeVectorAggregateCarrier(carriers, "android-x86_64");

      Path projectDir = Files.createDirectories(root.resolve("project"));
      var project = ProjectBuilder.builder().withProjectDir(projectDir.toFile()).build();
      ResolveOliphauntAndroidAssetsTask resolve =
          project
              .getTasks()
              .create("resolveExternalAggregateFixture", ResolveOliphauntAndroidAssetsTask.class);
      resolve.getVersion().set("1.2.3");
      // A caller's ABI order is not a carrier-identity order and must not affect canonical output.
      resolve.getSelectedAbis().set(List.of("x86_64", "arm64-v8a"));
      resolve.getSelectedExtensions().set(List.of("vector"));
      resolve
          .getExtensionOwnerVersions()
          .set(Map.of("oliphaunt-extension-vector", "0.8.1"));
      resolve.getIcu().set(false);
      resolve.getRuntimeArtifacts().from(runtimeResources, armRuntime, x86Runtime);
      resolve.getExtensionArtifacts().from(armExtension, x86Extension);
      Path runtimeOutput = root.resolve("resolved/runtime-resources");
      Path jniOutput = root.resolve("resolved/jniLibs");
      Path archiveOutput = root.resolve("resolved/extensionArchives");
      resolve.getRuntimeResourcesDir().set(runtimeOutput.toFile());
      resolve.getJniLibsDir().set(jniOutput.toFile());
      resolve.getExtensionArchivesDir().set(archiveOutput.toFile());
      resolve.resolve();

      Path registryRoot = runtimeOutput.resolve("oliphaunt/static-registry");
      String registryManifest =
          Files.readString(registryRoot.resolve("manifest.properties"), StandardCharsets.UTF_8);
      requireContains(
          registryManifest,
          "modules=vector\n",
          "resolved external aggregate registry module");
      requireContains(
          registryManifest,
          "archiveTargets=android-arm64-v8a,android-x86_64\n",
          "resolved external aggregate canonical targets");
      requireContains(
          registryManifest,
          "dependencyArchives=\n",
          "resolved external aggregate empty static dependencies");
      requireNotContains(
          registryManifest,
          "dependency.-",
          "resolved external aggregate sentinel must not become a dependency");
      equal(
          true,
          Files.isRegularFile(registryRoot.resolve("oliphaunt_static_registry.c")),
          "resolved external aggregate registry source");
      for (String abi : List.of("arm64-v8a", "x86_64")) {
        equal(
            true,
            Files.isRegularFile(
                archiveOutput
                    .resolve("android-" + abi)
                    .resolve("extensions/vector/liboliphaunt_extension_vector.a")),
            "resolved external aggregate archive for " + abi);
      }
      equal(
          false,
          Files.exists(
              runtimeOutput.resolve("oliphaunt/runtime/files/lib/postgresql/vector.so")),
          "ABI-specific extension shared object must not leak into shared Android assets");
      assertRuntimeResourceAccounting(
          runtimeOutput,
          Map.of(
              "vector",
              List.of(
                  "share/postgresql/extension/vector--1.0.sql",
                  "share/postgresql/extension/vector.control")),
          "aggregate-resolve-fixture");

      LinkOliphauntAndroidExtensionsTask link =
          project
              .getTasks()
              .create("validateResolvedExternalAggregate", LinkOliphauntAndroidExtensionsTask.class);
      link.getSelectedAbis().set(List.of("x86_64", "arm64-v8a"));
      link.getRuntimeResourcesDir().set(runtimeOutput.toFile());
      link.getJniLibsDir().set(jniOutput.toFile());
      link.getExtensionArchivesDir().set(archiveOutput.toFile());
      link.getOutputDirectory().set(root.resolve("linked").toFile());
      link.validateRegistryForContractTest();
    } finally {
      deleteRecursively(root);
    }
  }

  private static Path writeVectorAggregateCarrier(Path carriers, String target) throws Exception {
    return writeSingleMemberAggregateCarrier(
        carriers,
        target,
        "vector",
        "oliphaunt-extension-vector",
        "0.8.1",
        "vector");
  }

  private static void rejectsCrossAbiTargetInvariantDrift() throws Exception {
    Path root = Files.createTempDirectory("oliphaunt-cross-abi-drift-");
    try {
      Path carriers = Files.createDirectories(root.resolve("carriers"));
      RuntimeCarrierSet runtimeCarriers = writeCanonicalRuntimeCarrierSet(carriers);
      Path armExtension = writeVectorAggregateCarrier(carriers, "android-arm64-v8a");
      Path x86Extension =
          writeSingleMemberAggregateCarrier(
              carriers,
              "android-x86_64",
              "vector",
              "oliphaunt-extension-vector",
              "0.8.1",
              "vector",
              "CREATE TYPE vector_inconsistent;\n");

      var project =
          ProjectBuilder.builder()
              .withProjectDir(Files.createDirectories(root.resolve("project")).toFile())
              .build();
      ResolveOliphauntAndroidAssetsTask resolve =
          project
              .getTasks()
              .create("rejectCrossAbiDriftFixture", ResolveOliphauntAndroidAssetsTask.class);
      resolve.getVersion().set("1.2.3");
      resolve.getSelectedAbis().set(List.of("arm64-v8a", "x86_64"));
      resolve.getSelectedExtensions().set(List.of("vector"));
      resolve
          .getExtensionOwnerVersions()
          .set(Map.of("oliphaunt-extension-vector", "0.8.1"));
      resolve.getIcu().set(false);
      resolve
          .getRuntimeArtifacts()
          .from(
              runtimeCarriers.resources(),
              runtimeCarriers.armRuntime(),
              runtimeCarriers.x86Runtime());
      resolve.getExtensionArtifacts().from(armExtension, x86Extension);
      resolve.getRuntimeResourcesDir().set(root.resolve("resolved/runtime").toFile());
      resolve.getJniLibsDir().set(root.resolve("resolved/jni").toFile());
      resolve.getExtensionArchivesDir().set(root.resolve("resolved/archives").toFile());
      expectFailure(resolve::resolve, "inconsistent target-independent runtime files");

      Path metadataDrift =
          writeSingleMemberAggregateCarrierWithAncillaryContract(
              carriers,
              "android-x86_64",
              "vector",
              "oliphaunt-extension-vector",
              "0.8.1",
              "vector",
              "",
              "legacy-vector-helper");
      ResolveOliphauntAndroidAssetsTask metadataResolve =
          project
              .getTasks()
              .create(
                  "rejectCrossAbiMetadataDriftFixture",
                  ResolveOliphauntAndroidAssetsTask.class);
      metadataResolve.getVersion().set("1.2.3");
      metadataResolve.getSelectedAbis().set(List.of("arm64-v8a", "x86_64"));
      metadataResolve.getSelectedExtensions().set(List.of("vector"));
      metadataResolve
          .getExtensionOwnerVersions()
          .set(Map.of("oliphaunt-extension-vector", "0.8.1"));
      metadataResolve.getIcu().set(false);
      metadataResolve
          .getRuntimeArtifacts()
          .from(
              runtimeCarriers.resources(),
              runtimeCarriers.armRuntime(),
              runtimeCarriers.x86Runtime());
      metadataResolve.getExtensionArtifacts().from(armExtension, metadataDrift);
      metadataResolve
          .getRuntimeResourcesDir()
          .set(root.resolve("metadata-drift/runtime").toFile());
      metadataResolve.getJniLibsDir().set(root.resolve("metadata-drift/jni").toFile());
      metadataResolve
          .getExtensionArchivesDir()
          .set(root.resolve("metadata-drift/archives").toFile());
      expectFailure(
          metadataResolve::resolve,
          "inconsistent target-independent manifest metadata");
    } finally {
      deleteRecursively(root);
    }
  }

  private static void rejectsConflictingSharedStaticDependencyArchives() throws Exception {
    Path root = Files.createTempDirectory("oliphaunt-static-dependency-conflict-");
    try {
      Path carriers = Files.createDirectories(root.resolve("carriers"));
      RuntimeCarrierSet runtimeCarriers = writeCanonicalRuntimeCarrierSet(carriers);
      Path vector =
          writeSingleMemberAggregateCarrierWithStaticDependency(
              carriers,
              "android-x86_64",
              "vector",
              "oliphaunt-extension-vector",
              "0.8.1",
              "vector",
              "shared",
              "vector dependency bytes\n");
      Path pgHashids =
          writeSingleMemberAggregateCarrierWithStaticDependency(
              carriers,
              "android-x86_64",
              "pg_hashids",
              "oliphaunt-extension-pg-hashids",
              "1.3.0",
              "pg_hashids",
              "shared",
              "pg_hashids dependency bytes\n");

      var project =
          ProjectBuilder.builder()
              .withProjectDir(Files.createDirectories(root.resolve("project")).toFile())
              .build();
      ResolveOliphauntAndroidAssetsTask resolve =
          project
              .getTasks()
              .create(
                  "rejectStaticDependencyConflictFixture",
                  ResolveOliphauntAndroidAssetsTask.class);
      resolve.getVersion().set("1.2.3");
      resolve.getSelectedAbis().set(List.of("x86_64"));
      resolve.getSelectedExtensions().set(List.of("vector", "pg_hashids"));
      resolve
          .getExtensionOwnerVersions()
          .set(
              Map.of(
                  "oliphaunt-extension-vector",
                  "0.8.1",
                  "oliphaunt-extension-pg-hashids",
                  "1.3.0"));
      resolve.getIcu().set(false);
      resolve
          .getRuntimeArtifacts()
          .from(runtimeCarriers.resources(), runtimeCarriers.x86Runtime());
      resolve.getExtensionArtifacts().from(vector, pgHashids);
      resolve.getRuntimeResourcesDir().set(root.resolve("resolved/runtime").toFile());
      resolve.getJniLibsDir().set(root.resolve("resolved/jni").toFile());
      resolve.getExtensionArchivesDir().set(root.resolve("resolved/archives").toFile());
      expectFailure(
          resolve::resolve,
          "conflicting mobile static archive shared/libshared-fixture.a would overwrite");
    } finally {
      deleteRecursively(root);
    }
  }

  private static void rejectsDuplicateAndroidSelections() throws Exception {
    Path root = Files.createTempDirectory("oliphaunt-duplicate-selections-");
    try {
      Path carriers = Files.createDirectories(root.resolve("carriers"));
      RuntimeCarrierSet runtimeCarriers = writeCanonicalRuntimeCarrierSet(carriers);
      Path vector = writeVectorAggregateCarrier(carriers, "android-x86_64");
      var project =
          ProjectBuilder.builder()
              .withProjectDir(Files.createDirectories(root.resolve("project")).toFile())
              .build();

      ResolveOliphauntAndroidAssetsTask duplicateAbi =
          project
              .getTasks()
              .create("rejectDuplicateAbiFixture", ResolveOliphauntAndroidAssetsTask.class);
      duplicateAbi.getVersion().set("1.2.3");
      duplicateAbi.getSelectedAbis().set(List.of("x86_64", "x86_64"));
      duplicateAbi.getSelectedExtensions().set(List.of());
      duplicateAbi.getExtensionOwnerVersions().set(Map.of());
      duplicateAbi.getIcu().set(false);
      duplicateAbi.getRuntimeArtifacts().from(runtimeCarriers.resources());
      duplicateAbi.getRuntimeResourcesDir().set(root.resolve("duplicate-abi/runtime").toFile());
      duplicateAbi.getJniLibsDir().set(root.resolve("duplicate-abi/jni").toFile());
      duplicateAbi
          .getExtensionArchivesDir()
          .set(root.resolve("duplicate-abi/archives").toFile());
      expectFailure(duplicateAbi::resolve, "selected Oliphaunt Android ABIs must be unique");

      ResolveOliphauntAndroidAssetsTask duplicateExtension =
          project
              .getTasks()
              .create(
                  "rejectDuplicateExtensionFixture", ResolveOliphauntAndroidAssetsTask.class);
      duplicateExtension.getVersion().set("1.2.3");
      duplicateExtension.getSelectedAbis().set(List.of("x86_64"));
      duplicateExtension.getSelectedExtensions().set(List.of("vector", "vector"));
      duplicateExtension
          .getExtensionOwnerVersions()
          .set(Map.of("oliphaunt-extension-vector", "0.8.1"));
      duplicateExtension.getIcu().set(false);
      duplicateExtension
          .getRuntimeArtifacts()
          .from(runtimeCarriers.resources(), runtimeCarriers.x86Runtime());
      duplicateExtension.getExtensionArtifacts().from(vector);
      duplicateExtension
          .getRuntimeResourcesDir()
          .set(root.resolve("duplicate-extension/runtime").toFile());
      duplicateExtension
          .getJniLibsDir()
          .set(root.resolve("duplicate-extension/jni").toFile());
      duplicateExtension
          .getExtensionArchivesDir()
          .set(root.resolve("duplicate-extension/archives").toFile());
      expectFailure(
          duplicateExtension::resolve,
          "selected Oliphaunt Android extensions must be unique");
    } finally {
      deleteRecursively(root);
    }
  }

  private static void rejectsDuplicateNativeModuleStems() throws Exception {
    Path root = Files.createTempDirectory("oliphaunt-duplicate-module-stems-");
    try {
      Path carriers = Files.createDirectories(root.resolve("carriers"));
      RuntimeCarrierSet runtimeCarriers = writeCanonicalRuntimeCarrierSet(carriers);
      Path vector =
          writeSingleMemberAggregateCarrier(
              carriers,
              "android-x86_64",
              "vector",
              "oliphaunt-extension-vector",
              "0.8.1",
              "shared_stem");
      Path pgHashids =
          writeSingleMemberAggregateCarrier(
              carriers,
              "android-x86_64",
              "pg_hashids",
              "oliphaunt-extension-pg-hashids",
              "1.3.0",
              "shared_stem");
      var project =
          ProjectBuilder.builder()
              .withProjectDir(Files.createDirectories(root.resolve("project")).toFile())
              .build();
      ResolveOliphauntAndroidAssetsTask resolve =
          project
              .getTasks()
              .create("rejectDuplicateModuleStemFixture", ResolveOliphauntAndroidAssetsTask.class);
      resolve.getVersion().set("1.2.3");
      resolve.getSelectedAbis().set(List.of("x86_64"));
      resolve.getSelectedExtensions().set(List.of("vector", "pg_hashids"));
      resolve
          .getExtensionOwnerVersions()
          .set(
              Map.of(
                  "oliphaunt-extension-vector",
                  "0.8.1",
                  "oliphaunt-extension-pg-hashids",
                  "1.3.0"));
      resolve.getIcu().set(false);
      resolve
          .getRuntimeArtifacts()
          .from(runtimeCarriers.resources(), runtimeCarriers.x86Runtime());
      resolve.getExtensionArtifacts().from(vector, pgHashids);
      resolve.getRuntimeResourcesDir().set(root.resolve("resolved/runtime").toFile());
      resolve.getJniLibsDir().set(root.resolve("resolved/jni").toFile());
      resolve.getExtensionArchivesDir().set(root.resolve("resolved/archives").toFile());
      expectFailure(
          resolve::resolve, "selected Android extensions declare duplicate native module stem");
    } finally {
      deleteRecursively(root);
    }
  }

  private static String assertRuntimeResourceAccounting(
      Path runtimeOutput,
      Map<String, List<String>> extensionFiles,
      String originalCacheKey)
      throws Exception {
    Path resourceRoot = runtimeOutput.resolve("oliphaunt");
    Properties runtimeManifest = new Properties();
    try (var reader = Files.newBufferedReader(
        resourceRoot.resolve("runtime/manifest.properties"), StandardCharsets.UTF_8)) {
      runtimeManifest.load(reader);
    }
    String cacheKey = runtimeManifest.getProperty("cacheKey", "");
    if (!cacheKey.matches("android-[0-9a-f]{64}")) {
      throw new AssertionError("Android runtime cache key is not content-derived: " + cacheKey);
    }
    if (cacheKey.equals(originalCacheKey)) {
      throw new AssertionError("Android resolver retained the base runtime cache key " + cacheKey);
    }

    Path runtimeFiles = resourceRoot.resolve("runtime/files");
    long runtimeBytes = fixtureTreeBytes(runtimeFiles);
    long templateBytes = fixtureTreeBytes(resourceRoot.resolve("template-pgdata/files"));
    long registryBytes = fixtureTreeBytes(resourceRoot.resolve("static-registry"));
    TreeSet<Path> selectedFiles = new TreeSet<>();
    List<String> rows = new ArrayList<>();
    for (Map.Entry<String, List<String>> extension :
        extensionFiles.entrySet().stream()
            .sorted(Map.Entry.comparingByKey())
            .toList()) {
      TreeSet<Path> files = new TreeSet<>();
      for (String relative : extension.getValue()) {
        Path file = runtimeFiles.resolve(relative);
        if (!Files.isRegularFile(file)) {
          throw new AssertionError(
              "package-size fixture is missing " + extension.getKey() + " file " + relative);
        }
        files.add(file);
      }
      selectedFiles.addAll(files);
      rows.add(
          "extension\t"
              + extension.getKey()
              + "\t-\t"
              + files.size()
              + "\t"
              + fixtureFileBytes(files));
    }
    List<String> expected = new ArrayList<>();
    expected.add("kind\tid\textensions\tfiles\tbytes");
    expected.add("package\ttotal\t-\t-\t" + (runtimeBytes + templateBytes + registryBytes));
    expected.add("package\truntime\t-\t-\t" + runtimeBytes);
    expected.add("package\ttemplate-pgdata\t-\t-\t" + templateBytes);
    expected.add("package\tstatic-registry\t-\t-\t" + registryBytes);
    expected.add("extensions\tselected\t-\t-\t" + fixtureFileBytes(selectedFiles));
    expected.addAll(rows);
    equal(
        String.join("\n", expected) + "\n",
        Files.readString(resourceRoot.resolve("package-size.tsv"), StandardCharsets.UTF_8),
        "Android runtime package-size report");
    return cacheKey;
  }

  private static long fixtureTreeBytes(Path root) throws Exception {
    if (!Files.exists(root)) {
      return 0L;
    }
    try (var stream = Files.walk(root)) {
      return fixtureFileBytes(stream.filter(Files::isRegularFile).sorted().toList());
    }
  }

  private static long fixtureFileBytes(Iterable<Path> files) throws Exception {
    long total = 0L;
    for (Path file : files) {
      total = Math.addExact(total, Files.size(file));
    }
    return total;
  }

  private static Path writeSingleMemberAggregateCarrier(
      Path carriers,
      String target,
      String sqlName,
      String product,
      String productVersion,
      String nativeModuleStem)
      throws Exception {
    return writeSingleMemberAggregateCarrier(
        carriers,
        target,
        sqlName,
        product,
        productVersion,
        nativeModuleStem,
        "CREATE TYPE " + sqlName + ";\n");
  }

  private static Path writeSingleMemberAggregateCarrier(
      Path carriers,
      String target,
      String sqlName,
      String product,
      String productVersion,
      String nativeModuleStem,
      String installSql)
      throws Exception {
    byte[] memberBytes =
        singleMemberExtensionArtifact(target, sqlName, nativeModuleStem, installSql);
    return writeSingleMemberAggregateCarrierFromBytes(
        carriers, target, sqlName, product, productVersion, memberBytes);
  }

  private static Path writeSingleMemberAggregateCarrierWithStaticDependency(
      Path carriers,
      String target,
      String sqlName,
      String product,
      String productVersion,
      String nativeModuleStem,
      String dependencyName,
      String dependencyBytes)
      throws Exception {
    byte[] memberBytes =
        singleMemberExtensionArtifact(
            target,
            sqlName,
            nativeModuleStem,
            "CREATE TYPE " + sqlName + ";\n",
            dependencyName,
            dependencyBytes,
            "",
            "");
    return writeSingleMemberAggregateCarrierFromBytes(
        carriers, target, sqlName, product, productVersion, memberBytes);
  }

  private static Path writeSingleMemberAggregateCarrierWithAncillaryContract(
      Path carriers,
      String target,
      String sqlName,
      String product,
      String productVersion,
      String nativeModuleStem,
      String extensionSqlFileNames,
      String extensionSqlFilePrefixes)
      throws Exception {
    byte[] memberBytes =
        singleMemberExtensionArtifact(
            target,
            sqlName,
            nativeModuleStem,
            "CREATE TYPE " + sqlName + ";\n",
            null,
            null,
            extensionSqlFileNames,
            extensionSqlFilePrefixes);
    return writeSingleMemberAggregateCarrierFromBytes(
        carriers, target, sqlName, product, productVersion, memberBytes);
  }

  private static Path writeSingleMemberAggregateCarrierFromBytes(
      Path carriers,
      String target,
      String sqlName,
      String product,
      String productVersion,
      byte[] memberBytes)
      throws Exception {
    String memberName = sqlName + ".tar.gz";
    String memberPath = "extensions/" + sqlName + "/" + memberName;

    Map<String, Object> compatibility = new LinkedHashMap<>();
    compatibility.put(
        "extensionRuntimeContract", "src/shared/extension-runtime-contract/contract.toml");
    compatibility.put("nativeRuntimeProduct", "liboliphaunt-native");
    compatibility.put("nativeRuntimeVersion", "1.2.3");
    compatibility.put("postgresMajor", "18");
    compatibility.put("wasixRuntimeProduct", "liboliphaunt-wasix");
    compatibility.put("wasixRuntimeVersion", "1.2.3");

    Map<String, Object> member = new LinkedHashMap<>();
    member.put("sqlName", sqlName);
    member.put("kind", "runtime");
    member.put("identity", null);
    member.put("path", memberPath);
    member.put("sha256", sha256(memberBytes));
    member.put("bytes", memberBytes.length);

    Map<String, Object> manifest = new LinkedHashMap<>();
    manifest.put("schema", "oliphaunt-extension-bundle-v1");
    manifest.put("product", product);
    manifest.put("version", productVersion);
    manifest.put("family", "native");
    manifest.put("target", target);
    manifest.put("compatibility", compatibility);
    OliphauntExtensionLegalCatalog.Contract legalContract =
        OliphauntExtensionLegalCatalog.requireAggregate(product, target);
    manifest.put("licenseProfile", legalContract.profile());
    manifest.put("licenseFiles", legalContract.licenseFiles());
    manifest.put("members", List.of(member));

    String wrapper = sqlName + "-" + target;
    List<TarFixtureEntry> entries = new ArrayList<>();
    entries.add(
        new TarFixtureEntry(
            wrapper + "/bundle-manifest.json",
            '0',
            (JsonOutput.prettyPrint(JsonOutput.toJson(manifest)) + "\n")
                .getBytes(StandardCharsets.UTF_8)));
    entries.add(new TarFixtureEntry(wrapper + "/" + memberPath, '0', memberBytes));
    entries.addAll(canonicalLegalTarEntries(product, target, "aggregate", wrapper + "/"));
    entries.sort(Comparator.comparing(TarFixtureEntry::path));
    return writeTarGz(
        carriers.resolve(product + "-" + productVersion + "-native-" + target + "-bundle.tar.gz"),
        tarBytes(entries));
  }

  private static byte[] singleMemberExtensionArtifact(
      String target, String sqlName, String nativeModuleStem, String installSql)
      throws Exception {
    return singleMemberExtensionArtifact(
        target, sqlName, nativeModuleStem, installSql, null, null, "", "");
  }

  private static byte[] singleMemberExtensionArtifact(
      String target,
      String sqlName,
      String nativeModuleStem,
      String installSql,
      String dependencyName,
      String dependencyBytes,
      String extensionSqlFileNames,
      String extensionSqlFilePrefixes)
      throws Exception {
    Properties manifest = cubeArtifactManifest();
    manifest.setProperty("sqlName", sqlName);
    manifest.setProperty("nativeTarget", target);
    applyCanonicalLegalManifest(manifest, sqlName, target);
    manifest.setProperty("extensionSqlFileNames", extensionSqlFileNames);
    manifest.setProperty("extensionSqlFilePrefixes", extensionSqlFilePrefixes);
    List<TarFixtureEntry> entries = new ArrayList<>();
    if (nativeModuleStem == null) {
      manifest.setProperty("nativeModuleStem", "");
      manifest.setProperty("nativeModuleFile", "");
      manifest.setProperty("mobilePrebuilt", "no");
      manifest.setProperty("mobileStaticArchives", "");
      manifest.setProperty("mobileStaticDependencyArchives", "");
      manifest.setProperty("staticSymbolPrefix", "");
      manifest.setProperty("staticSymbolAliases", "");
    } else {
      manifest.setProperty("nativeModuleStem", nativeModuleStem);
      manifest.setProperty("nativeModuleFile", nativeModuleStem + ".so");
      manifest.setProperty("staticSymbolPrefix", "oliphaunt_static_" + nativeModuleStem);
      manifest.setProperty(
          "mobileStaticArchives",
          target
              + ":mobile-static/"
              + target
              + "/extensions/"
              + nativeModuleStem
              + "/liboliphaunt_extension_"
              + nativeModuleStem
              + ".a");
      entries.add(
          tarFile(
              "files/lib/postgresql/" + nativeModuleStem + ".so",
              "native module fixture\n"));
      entries.add(
          tarFile(
              "mobile-static/"
                  + target
                  + "/extensions/"
                  + nativeModuleStem
                  + "/liboliphaunt_extension_"
                  + nativeModuleStem
                  + ".a",
              "static archive fixture\n"));
      if (dependencyName != null) {
        String dependencyPath =
            "mobile-static/"
                + target
                + "/dependencies/"
                + dependencyName
                + "/libshared-fixture.a";
        manifest.setProperty(
            "mobileStaticDependencyArchives",
            target + ":" + dependencyName + ":" + dependencyPath);
        entries.add(tarFile(dependencyPath, dependencyBytes));
      }
    }
    entries.add(
        tarFile(
            "files/share/postgresql/extension/" + sqlName + ".control",
            "default_version='1.0'\n"));
    entries.add(
        tarFile(
            "files/share/postgresql/extension/" + sqlName + "--1.0.sql",
            installSql));
    entries.add(
        0,
        new TarFixtureEntry(
            "manifest.properties",
            '0',
            artifactManifestText(manifest).getBytes(StandardCharsets.UTF_8)));
    entries.addAll(canonicalLegalTarEntries(sqlName, target, "leaf", ""));
    entries.sort(Comparator.comparing(TarFixtureEntry::path));
    return gzipBytes(tarBytes(entries));
  }

  private static String canonicalEmptyStaticRegistryManifest() {
    return "packageLayout=oliphaunt-static-registry-v1\n"
        + "abiVersion=1\n"
        + "state=not-required\n"
        + "source=\n"
        + "registeredExtensions=\n"
        + "pendingExtensions=\n"
        + "nativeModuleStems=\n"
        + "modules=\n"
        + "archiveTargets=\n"
        + "dependencyArchiveTargets=\n"
        + "dependencyArchives=\n";
  }

  private static byte[] gzipBytes(byte[] bytes) throws Exception {
    ByteArrayOutputStream output = new ByteArrayOutputStream();
    try (GZIPOutputStream gzip = new GZIPOutputStream(output)) {
      gzip.write(bytes);
    }
    return output.toByteArray();
  }

  private static void validatesNoCreateExtensionInventoryAndStaticRegistry() throws Exception {
    Path root = Files.createTempDirectory("oliphaunt-auto-explain-");
    try {
      Properties manifest = cubeArtifactManifest();
      manifest.setProperty("sqlName", "auto_explain");
      manifest.setProperty("createsExtension", "no");
      manifest.setProperty("nativeModuleStem", "auto_explain");
      manifest.setProperty("nativeModuleFile", "auto_explain.so");
      manifest.setProperty("staticSymbolPrefix", "oliphaunt_static_auto_explain");
      manifest.setProperty(
          "mobileStaticArchives",
          "android-arm64-v8a:mobile-static/android-arm64-v8a/extensions/auto_explain/liboliphaunt_extension_auto_explain.a");
      writeInventoryFile(root, "manifest.properties", artifactManifestText(manifest));
      writeInventoryFile(root, "files/lib/postgresql/auto_explain.so", "native");
      writeInventoryFile(
          root,
          "mobile-static/android-arm64-v8a/extensions/auto_explain/liboliphaunt_extension_auto_explain.a",
          "archive");
      stageCanonicalLegalFiles(root, "auto_explain", "android-arm64-v8a");

      ResolveOliphauntAndroidAssetsTask.validateExtensionManifestForContractTest(
          "oliphaunt-extension-contrib-pg18",
          "auto_explain",
          "android-arm64-v8a",
          manifest,
          "1.2.3");
      ResolveOliphauntAndroidAssetsTask.validateExtensionArtifactInventoryForContractTest(
          root.toFile(), manifest);
      String source =
          ResolveOliphauntAndroidAssetsTask.staticRegistrySourceForContractTest(
              root.resolve("files").toFile(),
              "auto_explain",
              false,
              "auto_explain",
              "oliphaunt_static_auto_explain",
              "");
      requireContains(
          source,
          "oliphaunt_static_auto_explain_Pg_magic_func",
          "no-create registry magic symbol");
      requireContains(
          source,
          "liboliphaunt_selected_static_extensions",
          "no-create registry selector");
      requireContains(source, ".symbols = NULL,", "no-create registry null symbol table");
      requireContains(source, ".symbol_count = 0,", "no-create registry zero symbol count");
      requireNotContains(
          source,
          "oliphaunt_static_auto_explain_symbols[]",
          "no-create zero-length symbol array");
    } finally {
      deleteRecursively(root);
    }
  }

  private static void validatesStaticRegistrySymbolAliases() throws Exception {
    Path root = Files.createTempDirectory("oliphaunt-static-aliases-");
    try {
      writeInventoryFile(
          root,
          "share/postgresql/extension/postgis--3.6.3.sql",
          "CREATE FUNCTION public.difference() RETURNS integer AS 'MODULE_PATHNAME', 'difference' LANGUAGE C;\n");
      String source =
          ResolveOliphauntAndroidAssetsTask.staticRegistrySourceForContractTest(
              root.toFile(),
              "postgis",
              true,
              "postgis-3",
              "oliphaunt_static_postgis_3",
              "difference:oliphaunt_static_postgis_3_difference,pg_finfo_difference:pg_finfo_oliphaunt_static_postgis_3_difference");
      requireContains(
          source,
          "extern void oliphaunt_static_postgis_3_difference(void);",
          "aliased SQL symbol declaration");
      requireContains(
          source,
          ".name = \"difference\", .address = (void *)oliphaunt_static_postgis_3_difference",
          "aliased SQL symbol registry entry");
      requireContains(
          source,
          ".name = \"pg_finfo_difference\", .address = (void *)pg_finfo_oliphaunt_static_postgis_3_difference",
          "aliased pg_finfo registry entry");
      requireNotContains(
          source, "extern void difference(void);", "unlinked PostGIS SQL symbol declaration");

      Properties invalidPrefix = cubeArtifactManifest();
      invalidPrefix.setProperty("staticSymbolPrefix", "not-a-c-identifier");
      expectFailure(
          () ->
              ResolveOliphauntAndroidAssetsTask.validateExtensionManifestForContractTest(
                  "oliphaunt-extension-contrib-pg18",
                  "cube",
                  "android-arm64-v8a",
                  invalidPrefix,
                  "1.2.3"),
          "invalid staticSymbolPrefix");
      Properties unsortedAliases = cubeArtifactManifest();
      unsortedAliases.setProperty("staticSymbolAliases", "z:z,a:a");
      expectFailure(
          () ->
              ResolveOliphauntAndroidAssetsTask.validateExtensionManifestForContractTest(
                  "oliphaunt-extension-contrib-pg18",
                  "cube",
                  "android-arm64-v8a",
                  unsortedAliases,
                  "1.2.3"),
          "staticSymbolAliases must be sorted and unique");
    } finally {
      deleteRecursively(root);
    }
  }

  private static void validatesExactLibdirStaticRegistrySymbols() throws Exception {
    Path root = Files.createTempDirectory("oliphaunt-static-libdir-symbols-");
    try {
      writeInventoryFile(
          root,
          "share/postgresql/extension/postgis--3.6.3.sql",
          "CREATE OR REPLACE FUNCTION public.spheroid_in(cstring) RETURNS spheroid "
              + "AS '$libdir/postgis-3', 'ellipsoid_in' LANGUAGE 'c' IMMUTABLE STRICT;\n"
              + "CREATE FUNCTION public.postgis_implicit(integer) RETURNS integer "
              + "AS '$libdir/postgis-3' LANGUAGE C;\n"
              + "CREATE FUNCTION public.default_literal_decoy(text DEFAULT '$libdir/postgis-3') "
              + "RETURNS integer AS '$libdir/not-postgis-3', "
              + "'default_literal_must_not_be_registered' LANGUAGE C;\n"
              + "CREATE FUNCTION public.as_keyword_decoy("
              + "text DEFAULT 'AS ''$libdir/postgis-3'', ''also_not_registered''') "
              + "RETURNS integer AS '$libdir/not-postgis-3', "
              + "'as_literal_must_not_be_registered' LANGUAGE C;\n"
              + "CREATE FUNCTION public.foreign_module(integer) RETURNS integer "
              + "AS '$libdir/not-postgis-3', 'must_not_be_registered' LANGUAGE C;\n");
      String source =
          ResolveOliphauntAndroidAssetsTask.staticRegistrySourceForContractTest(
              root.toFile(),
              "postgis",
              true,
              "postgis-3",
              "oliphaunt_static_postgis_3",
              "");
      requireContains(
          source,
          ".name = \"ellipsoid_in\", .address = (void *)ellipsoid_in",
          "exact PostGIS libdir C symbol");
      requireContains(
          source,
          ".name = \"pg_finfo_ellipsoid_in\", .address = (void *)pg_finfo_ellipsoid_in",
          "exact PostGIS libdir pg_finfo symbol");
      requireContains(
          source,
          ".name = \"postgis_implicit\", .address = (void *)postgis_implicit",
          "exact PostGIS libdir implicit symbol");
      requireNotContains(
          source, "must_not_be_registered", "foreign libdir module symbol");
      requireNotContains(source, "foreign_module", "foreign libdir implicit symbol");
      requireNotContains(
          source, "default_literal_must_not_be_registered", "default-literal module decoy");
      requireNotContains(
          source, "as_literal_must_not_be_registered", "quoted AS module decoy");
      requireNotContains(source, "also_not_registered", "quoted AS symbol decoy");
    } finally {
      deleteRecursively(root);
    }
  }

  private static void validatesLinkTaskNdkBoundary() throws Exception {
    Path root = Files.createTempDirectory("oliphaunt-link-task-");
    try {
      Path runtime = Files.createDirectories(root.resolve("runtime"));
      Path jni = Files.createDirectories(root.resolve("jni"));
      Path archives = Files.createDirectories(root.resolve("archives"));
      Path projectDir = Files.createDirectories(root.resolve("project"));
      Path output = root.resolve("output");
      LinkOliphauntAndroidExtensionsTask task =
          ProjectBuilder.builder()
              .withProjectDir(projectDir.toFile())
              .build()
              .getTasks()
              .create("linkFixture", LinkOliphauntAndroidExtensionsTask.class);
      task.getSelectedAbis().set(List.of("x86_64"));
      task.getRuntimeResourcesDir().set(runtime.toFile());
      task.getJniLibsDir().set(jni.toFile());
      task.getExtensionArchivesDir().set(archives.toFile());
      task.getOutputDirectory().set(output.toFile());
      task.link();
      equal(true, Files.isDirectory(output), "no-module link output directory");
      equal(false, task.getNdkDirectory().isPresent(), "no-module fixture NDK absence");
      equal(64, task.getBundledHeaderSha256().length(), "bundled canonical header digest");

      Path orphanArchive =
          writeInventoryFile(
              archives,
              "android-x86_64/extensions/cube/liboliphaunt_extension_cube.a",
              "orphan");
      expectFailure(task::link, "archives without a static-registry manifest contains undeclared file");
      Files.delete(orphanArchive);
      Files.delete(orphanArchive.getParent());
      Files.delete(orphanArchive.getParent().getParent());
      Files.delete(orphanArchive.getParent().getParent().getParent());

      Path registry = Files.createDirectories(runtime.resolve("static-registry"));
      String emptyRegistryManifest =
          "packageLayout=oliphaunt-static-registry-v1\n"
              + "abiVersion=1\n"
              + "state=not-required\n"
              + "source=\n"
              + "registeredExtensions=\n"
              + "pendingExtensions=\n"
              + "nativeModuleStems=\n"
              + "modules=\n"
              + "archiveTargets=\n"
              + "dependencyArchiveTargets=\n"
              + "dependencyArchives=\n";
      Files.writeString(
          registry.resolve("manifest.properties"), emptyRegistryManifest, StandardCharsets.UTF_8);
      task.link();
      equal(false, task.getNdkDirectory().isPresent(), "explicit empty registry NDK absence");

      Files.writeString(
          registry.resolve("manifest.properties"),
          emptyRegistryManifest + "modules=\n",
          StandardCharsets.UTF_8);
      expectFailure(task::link, "declares duplicate property modules");
      Files.writeString(
          registry.resolve("manifest.properties"), emptyRegistryManifest, StandardCharsets.UTF_8);
      Path staleRegistrySource =
          Files.writeString(
              registry.resolve("oliphaunt_static_registry.c"),
              "/* stale fixture */\n",
              StandardCharsets.UTF_8);
      expectFailure(task::link, "empty runtime static-registry directory contains undeclared file");
      Files.delete(staleRegistrySource);
      Path staleEmptyRegistryArchive =
          writeInventoryFile(
              archives,
              "android-x86_64/extensions/cube/liboliphaunt_extension_cube.a",
              "stale");
      expectFailure(
          task::link,
          "archives for an empty static registry contains undeclared file");
      Files.delete(staleEmptyRegistryArchive);
      Files.delete(staleEmptyRegistryArchive.getParent());
      Files.delete(staleEmptyRegistryArchive.getParent().getParent());
      Files.delete(staleEmptyRegistryArchive.getParent().getParent().getParent());

      Files.writeString(
          registry.resolve("manifest.properties"),
          "packageLayout=oliphaunt-static-registry-v1\n"
              + "abiVersion=1\n"
              + "state=complete\n"
              + "source=oliphaunt_static_registry.c\n"
              + "modules=cube\n"
              + "archiveTargets=android-x86_64\n"
              + "dependencyArchiveTargets=\n"
              + "dependencyArchives=\n"
              + "module.cube.extension=cube\n"
              + "module.cube.symbolPrefix=oliphaunt_static_cube\n"
              + "module.cube.archiveTargets=android-x86_64\n"
              + "module.cube.archive.android-x86_64=archives/android-x86_64/extensions/cube/liboliphaunt_extension_cube.a\n",
          StandardCharsets.UTF_8);
      Files.writeString(
          registry.resolve("oliphaunt_static_registry.c"), "/* fixture */\n", StandardCharsets.UTF_8);
      task.getSelectedAbis().set(List.of());
      expectFailure(
          task::validateRegistryForContractTest,
          "require at least one selected Android ABI");
      task.getSelectedAbis().set(List.of("x86_64"));
      expectFailure(task::link, "require an installed Android NDK");
    } finally {
      deleteRecursively(root);
    }
  }

  private static void validatesRealNdkLinkWhenAvailable() throws Exception {
    String configuredNdk = System.getenv("ANDROID_NDK_HOME");
    if (configuredNdk == null || configuredNdk.isBlank()) {
      return;
    }
    Path ndk = Path.of(configuredNdk).toAbsolutePath().normalize();
    Path prebuilt = ndk.resolve("toolchains/llvm/prebuilt");
    List<Path> toolchains;
    try (var children = Files.list(prebuilt)) {
      toolchains = children.filter(Files::isDirectory).sorted().toList();
    }
    equal(1, toolchains.size(), "NDK host toolchain count");
    Path bin = toolchains.get(0).resolve("bin");
    String executableSuffix =
        System.getProperty("os.name", "")
                .toLowerCase(java.util.Locale.ROOT)
                .contains("win")
            ? ".exe"
            : "";
    Path clang = bin.resolve("clang" + executableSuffix);
    Path ar = bin.resolve("llvm-ar" + executableSuffix);

    Path root = Files.createTempDirectory("oliphaunt-real-ndk-link-");
    try {
      Path projectDir = Files.createDirectories(root.resolve("project"));
      Path runtime = Files.createDirectories(root.resolve("runtime"));
      Path jni = Files.createDirectories(root.resolve("jni/x86_64"));
      Path archives =
          Files.createDirectories(
              root.resolve("archives/android-x86_64/extensions/auto_explain"));
      Path output = root.resolve("output");
      Path nativeSources = Files.createDirectories(root.resolve("native"));
      Path baseSource = nativeSources.resolve("base.c");
      Path extensionSource = nativeSources.resolve("auto_explain.c");
      Path extensionObject = nativeSources.resolve("auto_explain.o");
      Path baseLibrary = jni.resolve("liboliphaunt.so");
      Path extensionArchive = archives.resolve("liboliphaunt_extension_auto_explain.a");
      Files.writeString(baseSource, "void oliphaunt_fixture(void) {}\n", StandardCharsets.UTF_8);
      Files.writeString(
          extensionSource,
          "const void *oliphaunt_static_auto_explain_Pg_magic_func(void) { return 0; }\n"
              + "void oliphaunt_static_auto_explain__PG_init(void) {}\n",
          StandardCharsets.UTF_8);
      runFixtureTool(
          List.of(
              clang.toString(),
              "--target=x86_64-linux-android24",
              "--sysroot=" + toolchains.get(0).resolve("sysroot"),
              "-shared",
              "-fPIC",
              "-Wl,-soname,liboliphaunt.so",
              baseSource.toString(),
              "-o",
              baseLibrary.toString()));
      runFixtureTool(
          List.of(
              clang.toString(),
              "--target=x86_64-linux-android24",
              "--sysroot=" + toolchains.get(0).resolve("sysroot"),
              "-fPIC",
              "-c",
              extensionSource.toString(),
              "-o",
              extensionObject.toString()));
      runFixtureTool(
          List.of(
              ar.toString(),
              "rcs",
              extensionArchive.toString(),
              extensionObject.toString()));

      Path registry = Files.createDirectories(runtime.resolve("static-registry"));
      Files.writeString(
          registry.resolve("oliphaunt_static_registry.c"),
          ResolveOliphauntAndroidAssetsTask.staticRegistrySourceForContractTest(
              runtime.toFile(),
              "auto_explain",
              false,
              "auto_explain",
              "oliphaunt_static_auto_explain",
              ""),
          StandardCharsets.UTF_8);
      Files.writeString(
          registry.resolve("manifest.properties"),
          "packageLayout=oliphaunt-static-registry-v1\n"
              + "abiVersion=1\n"
              + "state=complete\n"
              + "source=oliphaunt_static_registry.c\n"
              + "modules=auto_explain\n"
              + "archiveTargets=android-x86_64\n"
              + "dependencyArchiveTargets=\n"
              + "dependencyArchives=\n"
              + "module.auto_explain.extension=auto_explain\n"
              + "module.auto_explain.symbolPrefix=oliphaunt_static_auto_explain\n"
              + "module.auto_explain.archiveTargets=android-x86_64\n"
              + "module.auto_explain.archive.android-x86_64=archives/android-x86_64/extensions/auto_explain/liboliphaunt_extension_auto_explain.a\n",
          StandardCharsets.UTF_8);

      LinkOliphauntAndroidExtensionsTask task =
          ProjectBuilder.builder()
              .withProjectDir(projectDir.toFile())
              .build()
              .getTasks()
              .create("realNdkLinkFixture", LinkOliphauntAndroidExtensionsTask.class);
      task.getSelectedAbis().set(List.of("x86_64"));
      task.getRuntimeResourcesDir().set(runtime.toFile());
      task.getJniLibsDir().set(root.resolve("jni").toFile());
      task.getExtensionArchivesDir().set(root.resolve("archives").toFile());
      task.getNdkDirectory().set(ndk.toFile());
      task.getOutputDirectory().set(output.toFile());
      task.link();
      equal(
          true,
          Files.isRegularFile(output.resolve("x86_64/liboliphaunt_extensions.so")),
          "real NDK-linked extension support library");
    } finally {
      deleteRecursively(root);
    }
  }

  private static void validatesMultiTargetRegistryDependencies() throws Exception {
    Path root = Files.createTempDirectory("oliphaunt-postgis-registry-");
    try {
      Path projectDir = Files.createDirectories(root.resolve("project"));
      Path runtime = Files.createDirectories(root.resolve("runtime/static-registry"));
      Path jni = Files.createDirectories(root.resolve("jni"));
      Path archives = Files.createDirectories(root.resolve("archives"));
      writeInventoryFile(
          root.resolve("runtime"),
          "share/postgresql/extension/postgis--3.6.3.sql",
          "CREATE FUNCTION difference() RETURNS integer AS 'MODULE_PATHNAME', 'difference' LANGUAGE C;\n");
      Files.writeString(
          runtime.resolve("oliphaunt_static_registry.c"), "/* fixture */\n", StandardCharsets.UTF_8);
      Path manifest = runtime.resolve("manifest.properties");
      String rendered =
          ResolveOliphauntAndroidAssetsTask.staticRegistryManifestForContractTest(
              root.resolve("runtime").toFile(),
              "postgis",
              true,
              "postgis-3",
              "oliphaunt_static_postgis_3",
              "difference:oliphaunt_static_postgis_3_difference,pg_finfo_difference:pg_finfo_oliphaunt_static_postgis_3_difference",
              List.of("android-arm64-v8a", "android-x86_64"),
              List.of(
                  "android-arm64-v8a:geos:mobile-static/android-arm64-v8a/dependencies/geos/libgeos.a",
                  "android-x86_64:geos:mobile-static/android-x86_64/dependencies/geos/libgeos.a",
                  "android-arm64-v8a:proj:mobile-static/android-arm64-v8a/dependencies/proj/libproj.a",
                  "android-x86_64:proj:mobile-static/android-x86_64/dependencies/proj/libproj.a"));
      requireContains(
          rendered,
          "archiveTargets=android-arm64-v8a,android-x86_64\n",
          "writer canonical Android targets");
      requireContains(
          rendered,
          "dependencyArchives=geos,proj\n",
          "writer canonical dependency names");
      requireContains(
          rendered,
          "dependency.proj.archive.android-x86_64=archives/android-x86_64/dependencies/proj/libproj.a\n",
          "writer canonical target dependency path");
      String valid =
          "packageLayout=oliphaunt-static-registry-v1\n"
              + "abiVersion=1\n"
              + "state=complete\n"
              + "source=oliphaunt_static_registry.c\n"
              + "modules=postgis-3\n"
              + "archiveTargets=android-arm64-v8a,android-x86_64\n"
              + "dependencyArchiveTargets=android-arm64-v8a,android-x86_64\n"
              + "dependencyArchives=geos,proj\n"
              + "module.postgis-3.extension=postgis\n"
              + "module.postgis-3.symbolPrefix=oliphaunt_static_postgis_3\n"
              + "module.postgis-3.archiveTargets=android-arm64-v8a,android-x86_64\n"
              + "module.postgis-3.archive.android-arm64-v8a=archives/android-arm64-v8a/extensions/postgis-3/liboliphaunt_extension_postgis-3.a\n"
              + "module.postgis-3.archive.android-x86_64=archives/android-x86_64/extensions/postgis-3/liboliphaunt_extension_postgis-3.a\n"
              + "dependency.geos.archiveTargets=android-arm64-v8a,android-x86_64\n"
              + "dependency.geos.archive.android-arm64-v8a=archives/android-arm64-v8a/dependencies/geos/libgeos.a\n"
              + "dependency.geos.archive.android-x86_64=archives/android-x86_64/dependencies/geos/libgeos.a\n"
              + "dependency.proj.archiveTargets=android-arm64-v8a,android-x86_64\n"
              + "dependency.proj.archive.android-arm64-v8a=archives/android-arm64-v8a/dependencies/proj/libproj.a\n"
              + "dependency.proj.archive.android-x86_64=archives/android-x86_64/dependencies/proj/libproj.a\n";
      Files.writeString(manifest, valid, StandardCharsets.UTF_8);
      LinkOliphauntAndroidExtensionsTask task =
          ProjectBuilder.builder()
              .withProjectDir(projectDir.toFile())
              .build()
              .getTasks()
              .create("postgisRegistryFixture", LinkOliphauntAndroidExtensionsTask.class);
      task.getSelectedAbis().set(List.of("arm64-v8a", "x86_64"));
      task.getRuntimeResourcesDir().set(root.resolve("runtime").toFile());
      task.getJniLibsDir().set(jni.toFile());
      task.getExtensionArchivesDir().set(archives.toFile());
      task.getOutputDirectory().set(root.resolve("output").toFile());
      task.validateRegistryForContractTest();

      String targetSpecificDependency =
          valid
              .replace(
                  "dependency.geos.archiveTargets=android-arm64-v8a,android-x86_64\n",
                  "dependency.geos.archiveTargets=android-arm64-v8a\n")
              .replace(
                  "dependency.geos.archive.android-x86_64=archives/android-x86_64/dependencies/geos/libgeos.a\n",
                  "");
      Files.writeString(manifest, targetSpecificDependency, StandardCharsets.UTF_8);
      task.validateRegistryForContractTest();

      Files.writeString(
          manifest,
          valid.replace(
              "archives/android-x86_64/dependencies/proj/libproj.a",
              "archives/android-arm64-v8a/dependencies/proj/libproj.a"),
          StandardCharsets.UTF_8);
      expectFailure(
          task::validateRegistryForContractTest,
          "unsafe Android static dependency archive");
    } finally {
      deleteRecursively(root);
    }
  }

  private static void runFixtureTool(List<String> command) throws Exception {
    Process process = new ProcessBuilder(command).redirectErrorStream(true).start();
    byte[] output = process.getInputStream().readAllBytes();
    if (!process.waitFor(60, TimeUnit.SECONDS)) {
      process.destroyForcibly();
      throw new AssertionError("fixture tool timed out: " + command.get(0));
    }
    if (process.exitValue() != 0) {
      throw new AssertionError(
          "fixture tool failed: "
              + command
              + "\n"
              + new String(output, StandardCharsets.UTF_8));
    }
  }

  private static void validatesConfiguredCarrierLinkWhenRequested() throws Exception {
    String runtime = System.getenv("OLIPHAUNT_ANDROID_LINK_REHEARSAL_RUNTIME");
    if (runtime == null || runtime.isBlank()) {
      return;
    }
    String jni = requiredEnvironment("OLIPHAUNT_ANDROID_LINK_REHEARSAL_JNI");
    String archives = requiredEnvironment("OLIPHAUNT_ANDROID_LINK_REHEARSAL_ARCHIVES");
    String ndk = requiredEnvironment("ANDROID_NDK_HOME");
    String abi =
        System.getenv().getOrDefault("OLIPHAUNT_ANDROID_LINK_REHEARSAL_ABI", "arm64-v8a");
    Path root = Files.createTempDirectory("oliphaunt-carrier-link-rehearsal-");
    try {
      LinkOliphauntAndroidExtensionsTask task =
          ProjectBuilder.builder()
              .withProjectDir(Files.createDirectories(root.resolve("project")).toFile())
              .build()
              .getTasks()
              .create("carrierLinkRehearsal", LinkOliphauntAndroidExtensionsTask.class);
      task.getSelectedAbis().set(List.of(abi));
      task.getRuntimeResourcesDir().set(Path.of(runtime).toFile());
      task.getJniLibsDir().set(Path.of(jni).toFile());
      task.getExtensionArchivesDir().set(Path.of(archives).toFile());
      task.getNdkDirectory().set(Path.of(ndk).toFile());
      task.getOutputDirectory().set(root.resolve("output").toFile());
      task.link();
      equal(
          true,
          Files.isRegularFile(
              root.resolve("output").resolve(abi).resolve("liboliphaunt_extensions.so")),
          "configured real carrier link output");
    } finally {
      deleteRecursively(root);
    }
  }

  private static String requiredEnvironment(String name) {
    String value = System.getenv(name);
    if (value == null || value.isBlank()) {
      throw new AssertionError(name + " must be set for the configured carrier link rehearsal");
    }
    return value;
  }

  private static String artifactManifestText(Properties properties) {
    StringBuilder result = new StringBuilder();
    for (String key : new java.util.TreeSet<>(properties.stringPropertyNames())) {
      result.append(key).append('=').append(properties.getProperty(key)).append('\n');
    }
    return result.toString();
  }

  private static void validatesExactNestedArtifactContract() {
    Properties manifest = cubeArtifactManifest();

    ResolveOliphauntAndroidAssetsTask.validateExtensionManifestForContractTest(
        "oliphaunt-extension-contrib-pg18",
        "cube",
        "android-arm64-v8a",
        manifest,
        "1.2.3");

    Properties earthdistance = extensionManifestFor(manifest, "earthdistance", "cube");
    ResolveOliphauntAndroidAssetsTask.validateExtensionManifestForContractTest(
        "oliphaunt-extension-contrib-pg18",
        "earthdistance",
        "android-arm64-v8a",
        earthdistance,
        "1.2.3");

    Properties omittedDependency = extensionManifestFor(manifest, "earthdistance", "");
    expectFailure(
        () ->
            ResolveOliphauntAndroidAssetsTask.validateExtensionManifestForContractTest(
                "oliphaunt-extension-contrib-pg18",
                "earthdistance",
                "android-arm64-v8a",
                omittedDependency,
                "1.2.3"),
        "must declare dependencies=cube");

    Properties addedDependency = extensionManifestFor(manifest, "cube", "earthdistance");
    expectFailure(
        () ->
            ResolveOliphauntAndroidAssetsTask.validateExtensionManifestForContractTest(
                "oliphaunt-extension-contrib-pg18",
                "cube",
                "android-arm64-v8a",
                addedDependency,
                "1.2.3"),
        "must declare dependencies=, got earthdistance");

    Properties duplicateDependency =
        extensionManifestFor(manifest, "earthdistance", "cube,cube");
    expectFailure(
        () ->
            ResolveOliphauntAndroidAssetsTask.validateExtensionManifestForContractTest(
                "oliphaunt-extension-contrib-pg18",
                "earthdistance",
                "android-arm64-v8a",
                duplicateDependency,
                "1.2.3"),
        "must declare dependencies=cube, got cube,cube");

    expectFailure(
        () ->
            ResolveOliphauntAndroidAssetsTask.validateExtensionManifestForContractTest(
                "oliphaunt-extension-vector",
                "cube",
                "android-arm64-v8a",
                manifest,
                "1.2.3"),
        "belongs to release product oliphaunt-extension-contrib-pg18");

    Properties missing = new Properties();
    missing.putAll(manifest);
    missing.remove("staticSymbolAliases");
    expectFailure(
        () ->
            ResolveOliphauntAndroidAssetsTask.validateExtensionManifestForContractTest(
                "oliphaunt-extension-contrib-pg18",
                "cube",
                "android-arm64-v8a",
                missing,
                "1.2.3"),
        "property fields must be exactly");

    Properties unknown = new Properties();
    unknown.putAll(manifest);
    unknown.setProperty("futureField", "value");
    expectFailure(
        () ->
            ResolveOliphauntAndroidAssetsTask.validateExtensionManifestForContractTest(
                "oliphaunt-extension-contrib-pg18",
                "cube",
                "android-arm64-v8a",
                unknown,
                "1.2.3"),
        "futureField");

    Properties noncanonicalBoolean = new Properties();
    noncanonicalBoolean.putAll(manifest);
    noncanonicalBoolean.setProperty("mobilePrebuilt", "true");
    expectFailure(
        () ->
            ResolveOliphauntAndroidAssetsTask.validateExtensionManifestForContractTest(
                "oliphaunt-extension-contrib-pg18",
                "cube",
                "android-arm64-v8a",
                noncanonicalBoolean,
                "1.2.3"),
        "mobilePrebuilt=yes|no");

    Properties punctuationOrderedDependencies = new Properties();
    punctuationOrderedDependencies.putAll(manifest);
    punctuationOrderedDependencies.setProperty(
        "mobileStaticDependencyArchives",
        "android-arm64-v8a:geos:mobile-static/android-arm64-v8a/dependencies/geos/libgeos.a,"
            + "android-arm64-v8a:geos-c:mobile-static/android-arm64-v8a/dependencies/geos-c/libgeos_c.a");
    ResolveOliphauntAndroidAssetsTask.validateExtensionManifestForContractTest(
        "oliphaunt-extension-contrib-pg18",
        "cube",
        "android-arm64-v8a",
        punctuationOrderedDependencies,
        "1.2.3");
    Properties reversedPunctuationDependencies = new Properties();
    reversedPunctuationDependencies.putAll(punctuationOrderedDependencies);
    reversedPunctuationDependencies.setProperty(
        "mobileStaticDependencyArchives",
        "android-arm64-v8a:geos-c:mobile-static/android-arm64-v8a/dependencies/geos-c/libgeos_c.a,"
            + "android-arm64-v8a:geos:mobile-static/android-arm64-v8a/dependencies/geos/libgeos.a");
    expectFailure(
        () ->
            ResolveOliphauntAndroidAssetsTask.validateExtensionManifestForContractTest(
                "oliphaunt-extension-contrib-pg18",
                "cube",
                "android-arm64-v8a",
                reversedPunctuationDependencies,
                "1.2.3"),
        "sorted canonical mobileStaticDependencyArchives");

    Properties unsortedAncillaryNames = new Properties();
    unsortedAncillaryNames.putAll(manifest);
    unsortedAncillaryNames.setProperty(
        "extensionSqlFileNames", "uninstall_z.sql,uninstall_a.sql");
    expectFailure(
        () ->
            ResolveOliphauntAndroidAssetsTask.validateExtensionManifestForContractTest(
                "oliphaunt-extension-contrib-pg18",
                "cube",
                "android-arm64-v8a",
                unsortedAncillaryNames,
                "1.2.3"),
        "sorted canonical extensionSqlFileNames");

    Properties duplicateAncillaryPrefix = new Properties();
    duplicateAncillaryPrefix.putAll(manifest);
    duplicateAncillaryPrefix.setProperty(
        "extensionSqlFilePrefixes", "legacy-helper,legacy-helper");
    expectFailure(
        () ->
            ResolveOliphauntAndroidAssetsTask.validateExtensionManifestForContractTest(
                "oliphaunt-extension-contrib-pg18",
                "cube",
                "android-arm64-v8a",
                duplicateAncillaryPrefix,
                "1.2.3"),
        "repeats extensionSqlFilePrefixes entry legacy-helper");

    Properties unsafeAncillaryName = new Properties();
    unsafeAncillaryName.putAll(manifest);
    unsafeAncillaryName.setProperty("extensionSqlFileNames", "../uninstall_cube.sql");
    expectFailure(
        () ->
            ResolveOliphauntAndroidAssetsTask.validateExtensionManifestForContractTest(
                "oliphaunt-extension-contrib-pg18",
                "cube",
                "android-arm64-v8a",
                unsafeAncillaryName,
                "1.2.3"),
        "must contain portable SQL basenames");

    Properties dottedAncillaryPrefix = new Properties();
    dottedAncillaryPrefix.putAll(manifest);
    dottedAncillaryPrefix.setProperty("extensionSqlFilePrefixes", "legacy.helper");
    expectFailure(
        () ->
            ResolveOliphauntAndroidAssetsTask.validateExtensionManifestForContractTest(
                "oliphaunt-extension-contrib-pg18",
                "cube",
                "android-arm64-v8a",
                dottedAncillaryPrefix,
                "1.2.3"),
        "must contain portable basename prefixes");
  }

  private static Properties extensionManifestFor(
      Properties template, String sqlName, String dependencies) {
    Properties result = new Properties();
    result.putAll(template);
    result.setProperty("sqlName", sqlName);
    result.setProperty("dependencies", dependencies);
    result.setProperty("nativeModuleStem", sqlName);
    result.setProperty("nativeModuleFile", sqlName + ".so");
    result.setProperty("staticSymbolPrefix", "oliphaunt_static_" + sqlName);
    result.setProperty(
        "mobileStaticArchives",
        "android-arm64-v8a:mobile-static/android-arm64-v8a/extensions/"
            + sqlName
            + "/liboliphaunt_extension_"
            + sqlName
            + ".a");
    applyCanonicalLegalManifest(result, sqlName, result.getProperty("nativeTarget"));
    return result;
  }

  private static void applyCanonicalLegalManifest(
      Properties manifest, String sqlName, String target) {
    OliphauntExtensionLegalCatalog.Contract contract =
        OliphauntExtensionLegalCatalog.requireLeaf(sqlName, target);
    manifest.setProperty("licenseProfile", contract.profile());
    manifest.setProperty("licenseFiles", String.join(",", contract.licenseFiles()));
  }

  private static List<TarFixtureEntry> canonicalLegalTarEntries(
      String identity, String target, String scope, String prefix) throws Exception {
    OliphauntExtensionLegalCatalog.Contract contract =
        scope.equals("leaf")
            ? OliphauntExtensionLegalCatalog.requireLeaf(identity, target)
            : OliphauntExtensionLegalCatalog.requireAggregate(identity, target);
    List<TarFixtureEntry> result = new ArrayList<>();
    for (OliphauntExtensionLegalCatalog.LegalMember member : contract.members()) {
      byte[] bytes = canonicalLegalBytes(contract, member.path());
      equal(member.bytes(), (long) bytes.length, member.path() + " canonical legal byte count");
      equal(member.sha256(), sha256(bytes), member.path() + " canonical legal digest");
      result.add(new TarFixtureEntry(prefix + member.path(), '0', bytes));
    }
    return result;
  }

  private static void stageCanonicalLegalFiles(
      Path root, String sqlName, String target) throws Exception {
    OliphauntExtensionLegalCatalog.Contract contract =
        OliphauntExtensionLegalCatalog.requireLeaf(sqlName, target);
    stageCanonicalLegalContractFiles(root, contract);
  }

  private static void stageCanonicalLegalContractFiles(
      Path root, OliphauntExtensionLegalCatalog.Contract contract) throws Exception {
    for (OliphauntExtensionLegalCatalog.LegalMember member : contract.members()) {
      Path file = root.resolve(member.path());
      Files.createDirectories(file.getParent());
      Files.write(file, canonicalLegalBytes(contract, member.path()));
    }
  }

  private static byte[] canonicalLegalBytes(
      OliphauntExtensionLegalCatalog.Contract contract, String memberPath) throws Exception {
    String logicalPath =
        memberPath.startsWith("files/") ? memberPath.substring("files/".length()) : memberPath;
    Path repository = repositoryRoot();
    return switch (logicalPath) {
      case "LICENSE" -> Files.readAllBytes(repository.resolve("LICENSE"));
      case "THIRD_PARTY_NOTICES.md" ->
          Files.readAllBytes(repository.resolve("THIRD_PARTY_NOTICES.md"));
      case "THIRD_PARTY_LICENSES/PostgreSQL-COPYRIGHT" ->
          Files.readAllBytes(
              repository.resolve(
                  "src/runtimes/liboliphaunt/licenses/postgresql-18.4-COPYRIGHT"));
      case "THIRD_PARTY_LICENSES/OpenSSL-LICENSE.txt" ->
          Files.readAllBytes(
              repository.resolve(
                  "src/runtimes/liboliphaunt/licenses/openssl-3.5.6-LICENSE.txt"));
      default -> canonicalUpstreamLegalBytes(repository, contract.product(), logicalPath);
    };
  }

  private static byte[] canonicalUpstreamLegalBytes(
      Path repository, String product, String logicalPath) throws Exception {
    for (String sqlName : OliphauntExtensionCatalog.releaseProductMembers(product)) {
      Path dataFile =
          repository.resolve(
              "src/extensions/external/" + sqlName + "/upstream-license-data.json");
      if (!Files.isRegularFile(dataFile)) {
        continue;
      }
      @SuppressWarnings("unchecked")
      Map<String, Object> data =
          (Map<String, Object>) new JsonSlurper().parse(dataFile.toFile(), "UTF-8");
      @SuppressWarnings("unchecked")
      Map<String, Object> extension = (Map<String, Object>) data.get("extension");
      @SuppressWarnings("unchecked")
      List<Map<String, Object>> files =
          (List<Map<String, Object>>) extension.get("files");
      for (Map<String, Object> file : files) {
        if (!logicalPath.equals(file.get("destination"))) {
          continue;
        }
        @SuppressWarnings("unchecked")
        Map<String, String> blobs = (Map<String, String>) data.get("blobs");
        String encoded = blobs.get(file.get("sha256"));
        if (encoded == null) {
          throw new AssertionError(
              "missing canonical legal blob for " + sqlName + " " + logicalPath);
        }
        return Base64.getDecoder().decode(encoded);
      }
    }
    throw new AssertionError(
        "no canonical upstream legal bytes for " + product + " " + logicalPath);
  }

  private static Path repositoryRoot() {
    Path candidate = Path.of("").toAbsolutePath().normalize();
    while (candidate != null) {
      if (Files.isRegularFile(candidate.resolve("src/extensions/generated/sdk/kotlin.json"))) {
        return candidate;
      }
      candidate = candidate.getParent();
    }
    throw new AssertionError("cannot locate the Oliphaunt repository root");
  }

  private static Properties cubeArtifactManifest() {
    Properties manifest = new Properties();
    manifest.setProperty("packageLayout", "oliphaunt-extension-artifact-v1");
    manifest.setProperty("pgMajor", "18");
    manifest.setProperty("sqlName", "cube");
    manifest.setProperty("createsExtension", "yes");
    manifest.setProperty("nativeModuleStem", "cube");
    manifest.setProperty("nativeModuleFile", "cube.so");
    manifest.setProperty("nativeTarget", "android-arm64-v8a");
    manifest.setProperty("nativeRuntimeProduct", "liboliphaunt-native");
    manifest.setProperty("nativeRuntimeVersion", "1.2.3");
    manifest.setProperty("dependencies", "");
    manifest.setProperty("dataFiles", "");
    manifest.setProperty("extensionSqlFileNames", "");
    manifest.setProperty("extensionSqlFilePrefixes", "");
    manifest.setProperty("sharedPreloadLibraries", "");
    manifest.setProperty("mobilePrebuilt", "yes");
    manifest.setProperty(
        "mobileStaticArchives",
        "android-arm64-v8a:mobile-static/android-arm64-v8a/extensions/cube/liboliphaunt_extension_cube.a");
    manifest.setProperty("mobileStaticDependencyArchives", "");
    manifest.setProperty("staticSymbolPrefix", "oliphaunt_static_cube");
    manifest.setProperty("staticSymbolAliases", "");
    manifest.setProperty("licenseFiles", "");
    manifest.setProperty("licenseProfile", "contrib-native");
    manifest.setProperty("files", "files");
    return manifest;
  }

  private static void acceptsProductionShapedRuntimeBundlesForBothAndroidAbis()
      throws Exception {
    Map<String, String> extensionOwnerVersions =
        Map.of("oliphaunt-extension-contrib-pg18", "1.2.3");
    List<String> contribMembers =
        OliphauntExtensionCatalog.releaseProductMembers("oliphaunt-extension-contrib-pg18");

    for (String target : List.of("android-arm64-v8a", "android-x86_64")) {
      Path root = Files.createTempDirectory("oliphaunt-android-bundle-");
      try {
        List<Map<String, Object>> members = new ArrayList<>();
        for (String sqlName : contribMembers) {
          byte[] bytes = (sqlName + "-" + target).getBytes(StandardCharsets.UTF_8);
          writeMemberArchive(root, sqlName, bytes);
          members.add(runtimeBundleMember(sqlName, bytes));
        }
        Map<String, Object> manifest = runtimeBundleManifest(target, members);
        stageCanonicalLegalContractFiles(
            root,
            OliphauntExtensionLegalCatalog.requireAggregate(
                "oliphaunt-extension-contrib-pg18", target));
        writeBundleManifest(root, manifest);

        equal(
            contribMembers.size(),
            ResolveOliphauntAndroidAssetsTask.validateBundleSourcesForContractTest(
                new File("oliphaunt-extension-contrib-pg18-" + target + ".tar.gz"),
                root.toFile(),
                extensionOwnerVersions,
                "1.2.3"),
            target + " runtime member count");

        manifest.put("licenseProfile", "contrib-native");
        writeBundleManifest(root, manifest);
        expectFailure(
            () ->
                ResolveOliphauntAndroidAssetsTask.validateBundleSourcesForContractTest(
                    new File("oliphaunt-extension-contrib-pg18-" + target + ".tar.gz"),
                    root.toFile(),
                    extensionOwnerVersions,
                    "1.2.3"),
            "must declare licenseProfile=contrib-native-openssl");
        manifest.put("licenseProfile", "contrib-native-openssl");
        manifest.put("licenseFiles", List.of("../LICENSE"));
        writeBundleManifest(root, manifest);
        expectFailure(
            () ->
                ResolveOliphauntAndroidAssetsTask.validateBundleSourcesForContractTest(
                    new File("oliphaunt-extension-contrib-pg18-" + target + ".tar.gz"),
                    root.toFile(),
                    extensionOwnerVersions,
                    "1.2.3"),
            "licenseFiles do not match the exact legal contract");
        manifest.put("licenseFiles", List.of());
        writeBundleManifest(root, manifest);

        Path license = root.resolve("LICENSE");
        byte[] tamperedLicense = Files.readAllBytes(license);
        tamperedLicense[tamperedLicense.length - 1] ^= 1;
        Files.write(license, tamperedLicense);
        expectFailure(
            () ->
                ResolveOliphauntAndroidAssetsTask.validateBundleSourcesForContractTest(
                    new File("oliphaunt-extension-contrib-pg18-" + target + ".tar.gz"),
                    root.toFile(),
                    extensionOwnerVersions,
                    "1.2.3"),
            "legal member LICENSE does not match its canonical SHA-256");
        stageCanonicalLegalContractFiles(
            root,
            OliphauntExtensionLegalCatalog.requireAggregate(
                "oliphaunt-extension-contrib-pg18", target));
        Files.delete(root.resolve("THIRD_PARTY_LICENSES/PostgreSQL-COPYRIGHT"));
        expectFailure(
            () ->
                ResolveOliphauntAndroidAssetsTask.validateBundleSourcesForContractTest(
                    new File("oliphaunt-extension-contrib-pg18-" + target + ".tar.gz"),
                    root.toFile(),
                    extensionOwnerVersions,
                    "1.2.3"),
            "missing=[THIRD_PARTY_LICENSES/PostgreSQL-COPYRIGHT]");
        stageCanonicalLegalContractFiles(
            root,
            OliphauntExtensionLegalCatalog.requireAggregate(
                "oliphaunt-extension-contrib-pg18", target));
        Path extraLegal =
            writeInventoryFile(root, "THIRD_PARTY_LICENSES/UNDECLARED", "extra\n");
        expectFailure(
            () ->
                ResolveOliphauntAndroidAssetsTask.validateBundleSourcesForContractTest(
                    new File("oliphaunt-extension-contrib-pg18-" + target + ".tar.gz"),
                    root.toFile(),
                    extensionOwnerVersions,
                    "1.2.3"),
            "unexpected=[THIRD_PARTY_LICENSES/UNDECLARED]");
        Files.delete(extraLegal);

        manifest.put("target", "android-riscv64");
        writeBundleManifest(root, manifest);
        expectFailure(
            () ->
                ResolveOliphauntAndroidAssetsTask.validateBundleSourcesForContractTest(
                    new File("oliphaunt-extension-contrib-pg18-android-riscv64.tar.gz"),
                    root.toFile(),
                    extensionOwnerVersions,
                    "1.2.3"),
            "must target a supported Android ABI");
        manifest.put("target", target);
        writeBundleManifest(root, manifest);

        Map<String, Object> cube = requireMember(members, "cube");
        manifest.put("unexpected", "fault");
        writeBundleManifest(root, manifest);
        expectFailure(
            () ->
                ResolveOliphauntAndroidAssetsTask.validateBundleSourcesForContractTest(
                    new File("oliphaunt-extension-contrib-pg18-" + target + ".tar.gz"),
                    root.toFile(),
                    extensionOwnerVersions,
                    "1.2.3"),
            "top-level bundle manifest fields must be exactly");
        manifest.remove("unexpected");

        cube.put("unexpected", "fault");
        writeBundleManifest(root, manifest);
        expectFailure(
            () ->
                ResolveOliphauntAndroidAssetsTask.validateBundleSourcesForContractTest(
                    new File("oliphaunt-extension-contrib-pg18-" + target + ".tar.gz"),
                    root.toFile(),
                    extensionOwnerVersions,
                    "1.2.3"),
            "runtime member cube fields must be exactly");
        cube.remove("unexpected");

        Object cubeSha256 = cube.remove("sha256");
        writeBundleManifest(root, manifest);
        expectFailure(
            () ->
                ResolveOliphauntAndroidAssetsTask.validateBundleSourcesForContractTest(
                    new File("oliphaunt-extension-contrib-pg18-" + target + ".tar.gz"),
                    root.toFile(),
                    extensionOwnerVersions,
                    "1.2.3"),
            "runtime member cube fields must be exactly");
        cube.put("sha256", cubeSha256);

        cube.put("identity", "cube-" + target);
        writeBundleManifest(root, manifest);
        expectFailure(
            () ->
                ResolveOliphauntAndroidAssetsTask.validateBundleSourcesForContractTest(
                    new File("oliphaunt-extension-contrib-pg18-" + target + ".tar.gz"),
                    root.toFile(),
                    extensionOwnerVersions,
                    "1.2.3"),
            "runtime member cube must declare identity=null");

        cube.remove("identity");
        writeBundleManifest(root, manifest);
        expectFailure(
            () ->
                ResolveOliphauntAndroidAssetsTask.validateBundleSourcesForContractTest(
                    new File("oliphaunt-extension-contrib-pg18-" + target + ".tar.gz"),
                    root.toFile(),
                    extensionOwnerVersions,
                    "1.2.3"),
            "runtime member cube must declare identity=null");

        cube.put("identity", null);
        Map<String, Object> secondMember = members.get(1);
        members.set(1, new LinkedHashMap<>(members.get(0)));
        writeBundleManifest(root, manifest);
        expectFailure(
            () ->
                ResolveOliphauntAndroidAssetsTask.validateBundleSourcesForContractTest(
                    new File("oliphaunt-extension-contrib-pg18-" + target + ".tar.gz"),
                    root.toFile(),
                    extensionOwnerVersions,
                    "1.2.3"),
            "repeats a canonical member or archive path");

        members.set(1, secondMember);
        members.remove(members.size() - 1);
        writeBundleManifest(root, manifest);
        expectFailure(
            () ->
                ResolveOliphauntAndroidAssetsTask.validateBundleSourcesForContractTest(
                    new File("oliphaunt-extension-contrib-pg18-" + target + ".tar.gz"),
                    root.toFile(),
                    extensionOwnerVersions,
                    "1.2.3"),
            "members must exactly match release product oliphaunt-extension-contrib-pg18");
      } finally {
        deleteRecursively(root);
      }
    }
  }

  private static Map<String, Object> runtimeBundleManifest(
      String target, List<Map<String, Object>> members) {
    Map<String, Object> compatibility = new LinkedHashMap<>();
    compatibility.put(
        "extensionRuntimeContract", "src/shared/extension-runtime-contract/contract.toml");
    compatibility.put("nativeRuntimeProduct", "liboliphaunt-native");
    compatibility.put("nativeRuntimeVersion", "1.2.3");
    compatibility.put("postgresMajor", "18");
    compatibility.put("wasixRuntimeProduct", "liboliphaunt-wasix");
    compatibility.put("wasixRuntimeVersion", "1.2.3");

    Map<String, Object> manifest = new LinkedHashMap<>();
    manifest.put("schema", "oliphaunt-extension-bundle-v1");
    manifest.put("product", "oliphaunt-extension-contrib-pg18");
    manifest.put("version", "1.2.3");
    manifest.put("family", "native");
    manifest.put("target", target);
    manifest.put("compatibility", compatibility);
    OliphauntExtensionLegalCatalog.Contract legalContract =
        OliphauntExtensionLegalCatalog.requireAggregate(
            "oliphaunt-extension-contrib-pg18", target);
    manifest.put("licenseProfile", legalContract.profile());
    manifest.put("licenseFiles", legalContract.licenseFiles());
    manifest.put("members", members);
    return manifest;
  }

  private static Map<String, Object> runtimeBundleMember(String sqlName, byte[] bytes)
      throws Exception {
    Map<String, Object> member = new LinkedHashMap<>();
    member.put("sqlName", sqlName);
    member.put("kind", "runtime");
    member.put("identity", null);
    member.put("path", "extensions/" + sqlName + "/" + sqlName + ".tar.gz");
    member.put("sha256", sha256(bytes));
    member.put("bytes", bytes.length);
    return member;
  }

  private static Map<String, Object> requireMember(
      List<Map<String, Object>> members, String sqlName) {
    return members.stream()
        .filter(member -> sqlName.equals(member.get("sqlName")))
        .findFirst()
        .orElseThrow(() -> new AssertionError("missing fixture member " + sqlName));
  }

  private static void writeMemberArchive(Path root, String sqlName, byte[] bytes)
      throws Exception {
    Path archive = root.resolve("extensions/" + sqlName + "/" + sqlName + ".tar.gz");
    Files.createDirectories(archive.getParent());
    Files.write(archive, bytes);
  }

  private static void writeBundleManifest(Path root, Map<String, Object> manifest)
      throws Exception {
    Files.writeString(
        root.resolve("bundle-manifest.json"),
        JsonOutput.prettyPrint(JsonOutput.toJson(manifest)) + "\n",
        StandardCharsets.UTF_8);
  }

  private static String sha256(byte[] bytes) throws Exception {
    byte[] digest = MessageDigest.getInstance("SHA-256").digest(bytes);
    StringBuilder result = new StringBuilder(64);
    for (byte value : digest) {
      result.append(String.format(java.util.Locale.ROOT, "%02x", value & 0xff));
    }
    return result.toString();
  }

  private static void deleteRecursively(Path root) throws Exception {
    try (var paths = Files.walk(root)) {
      for (Path path : paths.sorted(Comparator.reverseOrder()).toList()) {
        Files.deleteIfExists(path);
      }
    }
  }

  private static void resolvesRuntimeBoundBundleOnceWithDependencyClosure() {
    List<OliphauntExtensionCatalog.Owner> owners =
        OliphauntExtensionCatalog.resolveOwners(List.of("earthdistance"), Map.of(), "1.2.3");
    equal(1, owners.size(), "earthdistance and cube must share one release owner");
    OliphauntExtensionCatalog.Owner owner = owners.get(0);
    equal(
        "oliphaunt-extension-contrib-pg18",
        owner.releaseProduct(),
        "contrib release owner");
    equal("dev.oliphaunt.extensions", owner.mavenGroup(), "contrib Maven group");
    equal(
        "oliphaunt-extension-contrib-pg18", owner.mavenArtifact(), "contrib Maven artifact");
    equal("1.2.3", owner.version(), "runtime-bound version");
    equal(List.of("cube", "earthdistance"), owner.members(), "exact dependency closure");
  }

  private static void requiresIndependentExternalVersion() {
    expectFailure(
        () -> OliphauntExtensionCatalog.resolveOwners(List.of("vector"), Map.of(), "1.2.3"),
        "requires an explicit oliphauntExtensionVersions entry");
    List<OliphauntExtensionCatalog.Owner> owners =
        OliphauntExtensionCatalog.resolveOwners(
            List.of("vector"), Map.of("oliphaunt-extension-vector", "0.8.1"), "1.2.3");
    equal(1, owners.size(), "vector owner count");
    equal("0.8.1", owners.get(0).version(), "independent vector version");
  }

  private static void rejectsConflictingOrUnlinkedVersions() {
    expectFailure(
        () ->
            OliphauntExtensionCatalog.resolveOwners(
                List.of("hstore"), Map.of("hstore", "1.2.3", "oliphaunt-extension-contrib-pg18", "1.2.4"), "1.2.3"),
        "conflicting versions");
    expectFailure(
        () ->
            OliphauntExtensionCatalog.resolveOwners(
                List.of("hstore"), Map.of("oliphaunt-extension-contrib-pg18", "1.2.4"), "1.2.3"),
        "must use liboliphaunt version 1.2.3");
    expectFailure(
        () ->
            OliphauntExtensionCatalog.resolveOwners(
                List.of("hstore"), Map.of("not-selected", "1.2.3"), "1.2.3"),
        "does not identify a selected extension release owner");
    expectFailure(
        () -> OliphauntExtensionCatalog.resolveOwners(List.of("hstore"), Map.of(), "01.2.3"),
        "must be canonical stable SemVer X.Y.Z");
    expectFailure(
        () ->
            OliphauntExtensionCatalog.resolveOwners(
                List.of("vector"), Map.of("vector", "1.2"), "1.2.3"),
        "must be canonical stable SemVer X.Y.Z");
  }

  private static void rejectsMalformedGeneratedCatalog() {
    String invalid =
        String.join(
                "\n",
                "schema=oliphaunt-android-extension-catalog-v1",
                "catalogSha256=" + "0".repeat(64),
                "extension.alpha.releaseProduct=oliphaunt-extension-alpha",
                "extension.alpha.mavenGroup=dev.oliphaunt.extensions",
                "extension.alpha.mavenArtifact=oliphaunt-extension-alpha",
                "extension.alpha.runtimeBound=false",
                "extension.alpha.dependencies=missing")
            + "\n";
    expectFailure(
        () ->
            OliphauntExtensionCatalog.load(
                new ByteArrayInputStream(invalid.getBytes(StandardCharsets.UTF_8))),
        "references unknown dependency missing");
  }

  private static void rejectsMalformedTaskRuntimeVersions() {
    ResolveOliphauntAndroidAssetsTask.validateReleaseVersion("1.2.3");
    for (String invalid : List.of("01.2.3", "1.02.3", "1.2.03", "1.2", "1.2.3-rc.1")) {
      expectFailure(
          () -> ResolveOliphauntAndroidAssetsTask.validateReleaseVersion(invalid),
          "canonical stable SemVer X.Y.Z");
    }
  }

  private static void rejectsIncompatibleExternalAndroidCarrier() {
    Map<String, Object> compatible =
        Map.of(
            "extensionRuntimeContract",
            "src/shared/extension-runtime-contract/contract.toml",
            "nativeRuntimeProduct",
            "liboliphaunt-native",
            "nativeRuntimeVersion",
            "1.2.3",
            "postgresMajor",
            "18",
            "wasixRuntimeProduct",
            "liboliphaunt-wasix",
            "wasixRuntimeVersion",
            "1.2.3");
    ResolveOliphauntAndroidAssetsTask.validateBundleCompatibility(
        Map.of("compatibility", compatible), new File("vector-bundle-manifest.json"), "1.2.3");
    Map<String, Object> incompatible = new java.util.LinkedHashMap<>(compatible);
    incompatible.put("nativeRuntimeVersion", "1.2.4");
    expectFailure(
        () ->
            ResolveOliphauntAndroidAssetsTask.validateBundleCompatibility(
                Map.of("compatibility", incompatible),
                new File("vector-bundle-manifest.json"),
                "1.2.3"),
        "pins liboliphaunt-native 1.2.4, but the selected Android runtime is 1.2.3");
  }

  private static void expectFailure(Runnable runnable, String message) {
    try {
      runnable.run();
    } catch (GradleException error) {
      if (error.getMessage() != null && error.getMessage().contains(message)) {
        return;
      }
      throw new AssertionError(
          "expected failure containing '" + message + "', got '" + error.getMessage() + "'", error);
    }
    throw new AssertionError("expected failure containing '" + message + "'");
  }

  private static void equal(Object expected, Object actual, String label) {
    if (!expected.equals(actual)) {
      throw new AssertionError(label + ": expected=" + expected + ", actual=" + actual);
    }
  }

  private static void requireContains(String value, String expected, String label) {
    if (!value.contains(expected)) {
      throw new AssertionError(label + ": missing " + expected + " in:\n" + value);
    }
  }

  private static void requireNotContains(String value, String unexpected, String label) {
    if (value.contains(unexpected)) {
      throw new AssertionError(label + ": unexpectedly found " + unexpected + " in:\n" + value);
    }
  }

  private record RuntimeCarrierSet(Path resources, Path armRuntime, Path x86Runtime) {}

  private record TarFixtureEntry(String path, char type, byte[] bytes, int mode) {
    private TarFixtureEntry(String path, char type, byte[] bytes) {
      this(path, type, bytes, type == '5' ? 0755 : 0644);
    }
  }
}
