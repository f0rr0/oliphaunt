package dev.oliphaunt.android;

import java.io.File;
import java.io.IOException;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Properties;
import java.util.Set;
import java.util.TreeSet;
import javax.inject.Inject;
import org.gradle.api.DefaultTask;
import org.gradle.api.GradleException;
import org.gradle.api.file.ArchiveOperations;
import org.gradle.api.file.DirectoryProperty;
import org.gradle.api.file.FileSystemOperations;
import org.gradle.api.provider.ListProperty;
import org.gradle.api.provider.MapProperty;
import org.gradle.api.provider.Property;
import org.gradle.api.tasks.Input;
import org.gradle.api.tasks.OutputDirectory;
import org.gradle.api.tasks.TaskAction;
import org.gradle.work.DisableCachingByDefault;

@DisableCachingByDefault(because = "Downloads and verifies mutable remote release assets into an explicit local cache")
public abstract class ResolveOliphauntAndroidAssetsTask extends DefaultTask {
  private final ArchiveOperations archiveOperations;
  private final FileSystemOperations fileSystemOperations;

  @Inject
  public ResolveOliphauntAndroidAssetsTask(
      ArchiveOperations archiveOperations, FileSystemOperations fileSystemOperations) {
    this.archiveOperations = archiveOperations;
    this.fileSystemOperations = fileSystemOperations;
  }

  @Input
  public abstract Property<String> getVersion();

  @Input
  public abstract Property<String> getAssetBaseUrl();

  @Input
  public abstract ListProperty<String> getSelectedAbis();

  @Input
  public abstract ListProperty<String> getSelectedExtensions();

  @Input
  public abstract MapProperty<String, String> getExtensionVersions();

  @OutputDirectory
  public abstract DirectoryProperty getAssetCacheDir();

  @OutputDirectory
  public abstract DirectoryProperty getRuntimeResourcesDir();

  @OutputDirectory
  public abstract DirectoryProperty getJniLibsDir();

  @OutputDirectory
  public abstract DirectoryProperty getExtensionArchivesDir();

  @TaskAction
  public void resolve() {
    String releaseVersion = getVersion().get();
    validateReleaseVersion(releaseVersion);
    File cache = getAssetCacheDir().get().getAsFile();
    if (!cache.mkdirs() && !cache.isDirectory()) {
      throw new GradleException("could not create Oliphaunt release asset cache " + cache);
    }
    File checksumFile = downloadAsset("liboliphaunt-" + releaseVersion + "-release-assets.sha256", cache);
    Map<String, String> checksums = parseChecksums(checksumFile);

    LinkedHashSet<String> assets = new LinkedHashSet<>();
    assets.add("liboliphaunt-" + releaseVersion + "-runtime-resources.tar.gz");
    List<String> abis = effectiveAbis();
    for (String abi : abis) {
      assets.add(androidBaseAsset(releaseVersion, abi));
    }

    Map<String, File> downloaded = new LinkedHashMap<>();
    for (String asset : assets) {
      downloaded.put(asset, downloadAndVerify(asset, cache, checksums));
    }
    Map<String, File> extensionDownloaded = new LinkedHashMap<>();
    List<Map<String, String>> selectedRows = selectedExtensionRows(releaseVersion, cache, extensionDownloaded, abis);

    unpackRuntimeResources(downloaded.get("liboliphaunt-" + releaseVersion + "-runtime-resources.tar.gz"));
    mergeExtensionRuntimeArtifacts(extensionDownloaded, selectedRows);
    unpackAndroidJniLibs(downloaded, releaseVersion, abis);
    unpackAndroidExtensionArchives(extensionDownloaded);
  }

  private List<String> effectiveAbis() {
    List<String> abis = new ArrayList<>(getSelectedAbis().get());
    if (abis.isEmpty()) {
      abis.add("arm64-v8a");
      abis.add("x86_64");
    }
    for (String abi : abis) {
      if (!abi.equals("arm64-v8a") && !abi.equals("x86_64")) {
        throw new GradleException("liboliphaunt Android release assets are published for arm64-v8a and x86_64; got " + abi);
      }
    }
    return abis;
  }

  private static void validateReleaseVersion(String releaseVersion) {
    if (releaseVersion == null || releaseVersion.isBlank() || !releaseVersion.matches("[A-Za-z0-9._-]+")) {
      throw new GradleException("invalid liboliphaunt release version: " + releaseVersion);
    }
  }

  private static String androidBaseAsset(String releaseVersion, String abi) {
    return switch (abi) {
      case "arm64-v8a" -> "liboliphaunt-" + releaseVersion + "-android-arm64-v8a.tar.gz";
      case "x86_64" -> "liboliphaunt-" + releaseVersion + "-android-x86_64.tar.gz";
      default -> throw new GradleException("unsupported liboliphaunt Android ABI " + abi);
    };
  }

  private File downloadAndVerify(String asset, File cache, Map<String, String> checksums) {
    File file = downloadAsset(asset, cache);
    String expected = checksums.get(asset);
    if (expected == null) {
      throw new GradleException("liboliphaunt release checksum manifest does not cover " + asset);
    }
    String actual = sha256(file);
    if (!expected.equals(actual)) {
      throw new GradleException(
          "liboliphaunt release asset checksum mismatch for "
              + asset
              + ": expected "
              + expected
              + ", got "
              + actual);
    }
    return file;
  }

  private File downloadAsset(String asset, File cache) {
    if (asset.contains("/") || asset.contains("\\")) {
      throw new GradleException("release asset name must be a plain file name: " + asset);
    }
    File output = new File(cache, asset);
    if (output.isFile()) {
      return output;
    }
    File tmp = new File(cache, "." + asset + ".tmp");
    String url = trimTrailingSlash(getAssetBaseUrl().get()) + "/" + asset;
    try (var input = URI.create(url).toURL().openStream()) {
      Files.copy(input, tmp.toPath(), StandardCopyOption.REPLACE_EXISTING);
      Files.move(tmp.toPath(), output.toPath(), StandardCopyOption.REPLACE_EXISTING);
    } catch (IOException error) {
      throw new GradleException("download liboliphaunt release asset " + url + ": " + error.getMessage(), error);
    }
    return output;
  }

  private File downloadAndVerifyExtension(
      String product, String version, String asset, File cache, Map<String, String> checksums) {
    File file = downloadExtensionAsset(product, version, asset, cache);
    String expected = checksums.get(asset);
    if (expected == null) {
      throw new GradleException(product + " " + version + " checksum manifest does not cover " + asset);
    }
    String actual = sha256(file);
    if (!expected.equals(actual)) {
      throw new GradleException(
          product + " " + version + " asset checksum mismatch for " + asset + ": expected " + expected + ", got " + actual);
    }
    return file;
  }

  private File downloadExtensionAsset(String product, String version, String asset, File cache) {
    if (asset.contains("/") || asset.contains("\\")) {
      throw new GradleException("extension release asset name must be a plain file name: " + asset);
    }
    File output = new File(cache, asset);
    if (output.isFile()) {
      return output;
    }
    File tmp = new File(cache, "." + asset + ".tmp");
    String url = "https://github.com/f0rr0/oliphaunt/releases/download/" + product + "-v" + version + "/" + asset;
    try (var input = URI.create(url).toURL().openStream()) {
      Files.copy(input, tmp.toPath(), StandardCopyOption.REPLACE_EXISTING);
      Files.move(tmp.toPath(), output.toPath(), StandardCopyOption.REPLACE_EXISTING);
    } catch (IOException error) {
      throw new GradleException("download Oliphaunt extension release asset " + url + ": " + error.getMessage(), error);
    }
    return output;
  }

  private static String trimTrailingSlash(String value) {
    String out = value;
    while (out.endsWith("/")) {
      out = out.substring(0, out.length() - 1);
    }
    return out;
  }

  private static Map<String, String> parseChecksums(File file) {
    Map<String, String> checksums = new LinkedHashMap<>();
    try {
      for (String line : Files.readAllLines(file.toPath(), StandardCharsets.UTF_8)) {
        if (line.isBlank()) {
          continue;
        }
        String[] parts = line.trim().split("\\s+");
        if (parts.length != 2 || !parts[1].startsWith("./")) {
          throw new GradleException("malformed liboliphaunt checksum line in " + file + ": " + line);
        }
        checksums.put(parts[1].substring(2), parts[0]);
      }
    } catch (IOException error) {
      throw new GradleException("read " + file + ": " + error.getMessage(), error);
    }
    return checksums;
  }

  private static String sha256(File file) {
    try {
      MessageDigest digest = MessageDigest.getInstance("SHA-256");
      try (var input = Files.newInputStream(file.toPath())) {
        byte[] buffer = new byte[1024 * 1024];
        int read;
        while ((read = input.read(buffer)) >= 0) {
          digest.update(buffer, 0, read);
        }
      }
      StringBuilder out = new StringBuilder();
      for (byte value : digest.digest()) {
        out.append(String.format("%02x", value));
      }
      return out.toString();
    } catch (Exception error) {
      throw new GradleException("hash " + file + ": " + error.getMessage(), error);
    }
  }

  private List<Map<String, String>> selectedExtensionRows(
      String defaultVersion, File cache, Map<String, File> downloaded, List<String> abis) {
    if (getSelectedExtensions().get().isEmpty()) {
      return List.of();
    }
    Map<String, Map<String, String>> rows = new LinkedHashMap<>();
    for (String extension : getSelectedExtensions().get()) {
      selectExtension(defaultVersion, cache, downloaded, rows, extension, abis);
    }
    return rows.values().stream()
        .sorted(java.util.Comparator.comparing(row -> row.get("sql_name")))
        .toList();
  }

  private void selectExtension(
      String defaultVersion,
      File cache,
      Map<String, File> downloaded,
      Map<String, Map<String, String>> rows,
      String sqlName,
      List<String> abis) {
    if (rows.containsKey(sqlName)) {
      return;
    }
    String product = extensionProduct(sqlName);
    String version = extensionVersion(sqlName, product, defaultVersion);
    File extensionCache = new File(cache, product + "-" + version);
    if (!extensionCache.mkdirs() && !extensionCache.isDirectory()) {
      throw new GradleException("could not create Oliphaunt extension release asset cache " + extensionCache);
    }
    Map<String, String> extensionChecksums =
        parseChecksums(downloadExtensionAsset(product, version, product + "-" + version + "-release-assets.sha256", extensionCache));
    String manifestAsset = product + "-" + version + "-manifest.properties";
    File manifestFile = downloadAndVerifyExtension(product, version, manifestAsset, extensionCache, extensionChecksums);
    Properties manifest = readProperties(manifestFile);
    validateExtensionManifest(product, version, sqlName, manifest);

    for (String dependency : splitCsv(manifest.getProperty("dependencies"))) {
      selectExtension(defaultVersion, cache, downloaded, rows, dependency, abis);
    }

    LinkedHashSet<String> runtimeAssets = new LinkedHashSet<>();
    LinkedHashSet<String> archiveTargets = new LinkedHashSet<>();
    String nativeModuleStem = manifest.getProperty("nativeModuleStem", "").trim();
    for (String abi : abis) {
      String target = androidTarget(abi);
      String targetRuntimeAsset = requireExtensionAsset(manifest, product, target, "runtime", sqlName);
      runtimeAssets.add(targetRuntimeAsset);
      downloaded.computeIfAbsent(
          targetRuntimeAsset,
          asset -> downloadAndVerifyExtension(product, version, asset, extensionCache, extensionChecksums));
      if (!nativeModuleStem.isEmpty()) {
        String staticArchiveAsset = requireExtensionAsset(manifest, product, target, "android-static-archive", sqlName);
        downloaded.computeIfAbsent(
            staticArchiveAsset,
            asset -> downloadAndVerifyExtension(product, version, asset, extensionCache, extensionChecksums));
        archiveTargets.add(abi);
      }
    }
    if (runtimeAssets.isEmpty()) {
      throw new GradleException("selected extension " + sqlName + " did not resolve an Android runtime artifact");
    }
    validateEquivalentAndroidRuntimeAssets(product, version, sqlName, runtimeAssets, extensionChecksums);
    Map<String, String> row = new LinkedHashMap<>();
    row.put("sql_name", sqlName);
    row.put("runtime_artifact", runtimeAssets.iterator().next());
    row.put("native_module_stem", emptyToDash(manifest.getProperty("nativeModuleStem")));
    row.put("shared_preload", emptyToDash(manifest.getProperty("sharedPreloadLibraries")));
    row.put("dependencies", emptyToDash(manifest.getProperty("dependencies")));
    row.put("archive_targets", archiveTargets.isEmpty() ? "-" : String.join(",", archiveTargets));
    rows.put(sqlName, row);
  }

  private static void validateEquivalentAndroidRuntimeAssets(
      String product,
      String version,
      String sqlName,
      LinkedHashSet<String> runtimeAssets,
      Map<String, String> checksums) {
    if (runtimeAssets.size() <= 1) {
      return;
    }
    String expectedChecksum = null;
    String expectedAsset = null;
    for (String asset : runtimeAssets) {
      String checksum = checksums.get(asset);
      if (checksum == null) {
        throw new GradleException(product + " " + version + " checksum manifest does not cover " + asset);
      }
      if (expectedChecksum == null) {
        expectedChecksum = checksum;
        expectedAsset = asset;
      } else if (!expectedChecksum.equals(checksum)) {
        throw new GradleException(
            product
                + " "
                + version
                + " publishes different Android runtime artifacts for "
                + sqlName
                + ": "
                + expectedAsset
                + " and "
                + asset
                + ". Android extension runtime payloads must be ABI-independent; put ABI-specific code in static archives.");
      }
    }
  }

  private static String extensionProduct(String sqlName) {
    if (!sqlName.matches("[A-Za-z0-9._-]{1,128}")) {
      throw new GradleException("invalid Oliphaunt extension SQL name: " + sqlName);
    }
    return "oliphaunt-extension-" + sqlName.replace('_', '-');
  }

  private String extensionVersion(String sqlName, String product, String defaultVersion) {
    Map<String, String> versions = getExtensionVersions().get();
    String version = versions.get(sqlName);
    if (version == null) {
      version = versions.get(product);
    }
    if (version == null || version.isBlank()) {
      version = defaultVersion;
    }
    validateReleaseVersion(version);
    return version;
  }

  private static String androidTarget(String abi) {
    return switch (abi) {
      case "arm64-v8a" -> "android-arm64-v8a";
      case "x86_64" -> "android-x86_64";
      default -> throw new GradleException("unsupported liboliphaunt Android ABI " + abi);
    };
  }

  private static void validateExtensionManifest(String product, String version, String sqlName, Properties manifest) {
    if (!"oliphaunt-extension-release-manifest-v1".equals(manifest.getProperty("schema"))) {
      throw new GradleException(product + " " + version + " extension manifest has unsupported schema");
    }
    if (!product.equals(manifest.getProperty("product"))) {
      throw new GradleException(product + " " + version + " extension manifest declares product " + manifest.getProperty("product"));
    }
    if (!version.equals(manifest.getProperty("version"))) {
      throw new GradleException(product + " " + version + " extension manifest declares version " + manifest.getProperty("version"));
    }
    if (!sqlName.equals(manifest.getProperty("sqlName"))) {
      throw new GradleException(product + " " + version + " extension manifest declares sqlName " + manifest.getProperty("sqlName"));
    }
    if (!"true".equals(manifest.getProperty("mobileReleaseReady"))) {
      throw new GradleException(sqlName + " is not marked mobileReleaseReady in " + product + " " + version);
    }
  }

  private static String requireExtensionAsset(
      Properties manifest, String product, String target, String kind, String sqlName) {
    String key = "asset.native." + target + "." + kind;
    String value = manifest.getProperty(key);
    if (value == null || value.isBlank()) {
      throw new GradleException(product + " manifest has no " + kind + " asset for " + sqlName + " target " + target);
    }
    return value;
  }

  private void unpackRuntimeResources(File archive) {
    File output = getRuntimeResourcesDir().get().getAsFile();
    fileSystemOperations.delete(spec -> spec.delete(output));
    fileSystemOperations.copy(
        spec -> {
          spec.from(archiveOperations.tarTree(archiveOperations.gzip(archive)));
          spec.into(output);
        });
  }

  private void unpackAndroidJniLibs(Map<String, File> downloaded, String releaseVersion, List<String> abis) {
    File output = getJniLibsDir().get().getAsFile();
    fileSystemOperations.delete(spec -> spec.delete(output));
    for (String abi : abis) {
      String asset = androidBaseAsset(releaseVersion, abi);
      File extractRoot = new File(getTemporaryDir(), "jni-" + abi);
      fileSystemOperations.delete(spec -> spec.delete(extractRoot));
      fileSystemOperations.copy(
          spec -> {
            spec.from(archiveOperations.tarTree(archiveOperations.gzip(downloaded.get(asset))));
            spec.into(extractRoot);
          });
      File source = new File(extractRoot, "jni/" + abi);
      if (!source.isDirectory()) {
        throw new GradleException("liboliphaunt Android asset " + asset + " did not contain jni/" + abi);
      }
      fileSystemOperations.copy(
          spec -> {
            spec.from(source);
            spec.into(new File(output, abi));
          });
    }
  }

  private void unpackAndroidExtensionArchives(Map<String, File> downloaded) {
    File output = getExtensionArchivesDir().get().getAsFile();
    fileSystemOperations.delete(spec -> spec.delete(output));
    for (Map.Entry<String, File> entry : downloaded.entrySet()) {
      String asset = entry.getKey();
      String abi;
      if (asset.contains("-native-android-arm64-v8a-static.")) {
        abi = "arm64-v8a";
      } else if (asset.contains("-native-android-x86_64-static.")) {
        abi = "x86_64";
      } else {
        continue;
      }
      File extractRoot = new File(getTemporaryDir(), "extension-" + abi + "-" + entry.getValue().getName());
      fileSystemOperations.delete(spec -> spec.delete(extractRoot));
      fileSystemOperations.copy(
          spec -> {
            spec.from(archiveOperations.tarTree(archiveOperations.gzip(entry.getValue())));
            spec.into(extractRoot);
          });
      File source = new File(extractRoot, "extensions");
      if (!source.isDirectory()) {
        throw new GradleException("liboliphaunt Android extension asset " + asset + " did not contain extensions/");
      }
      fileSystemOperations.copy(
          spec -> {
            spec.from(source);
            spec.into(new File(output, abi + "/extensions"));
          });
    }
  }

  private void mergeExtensionRuntimeArtifacts(Map<String, File> downloaded, List<Map<String, String>> selectedRows) {
    if (selectedRows.isEmpty()) {
      return;
    }
    File root = runtimeResourcesRoot(getRuntimeResourcesDir().get().getAsFile());
    File runtimePackage = new File(root, "runtime");
    File runtimeFiles = new File(runtimePackage, "files");
    if (!runtimeFiles.isDirectory()) {
      throw new GradleException("liboliphaunt runtime resources did not contain oliphaunt/runtime/files");
    }
    List<ExtensionRuntimeArtifact> artifacts = new ArrayList<>();
    for (Map<String, String> row : selectedRows) {
      String sqlName = row.get("sql_name");
      File artifact = downloaded.get(row.get("runtime_artifact"));
      File artifactRoot = extractExtensionRuntimeArtifact(sqlName, artifact);
      copyTree(new File(artifactRoot, "files").toPath(), runtimeFiles.toPath());
      artifacts.add(
          new ExtensionRuntimeArtifact(
              sqlName,
              dashToNull(row.get("native_module_stem")),
              dashToNull(row.get("shared_preload")),
              splitCsv(row.get("archive_targets"))));
    }
    List<ExtensionRuntimeArtifact> nativeArtifacts =
        artifacts.stream().filter(artifact -> artifact.nativeModuleStem != null).toList();
    String staticRegistrySource = "";
    if (!nativeArtifacts.isEmpty()) {
      File staticRegistryDir = new File(root, "static-registry");
      if (!staticRegistryDir.mkdirs() && !staticRegistryDir.isDirectory()) {
        throw new GradleException("could not create " + staticRegistryDir);
      }
      writeText(new File(staticRegistryDir, "oliphaunt_static_registry.c"), staticRegistrySourceText(runtimeFiles, nativeArtifacts));
      writeStaticRegistryManifest(staticRegistryDir, nativeArtifacts);
      staticRegistrySource = "static-registry/oliphaunt_static_registry.c";
    }
    updateRuntimeManifest(new File(runtimePackage, "manifest.properties"), artifacts, staticRegistrySource);
  }

  private File extractExtensionRuntimeArtifact(String sqlName, File archive) {
    if (!archive.getName().endsWith(".tar.gz") && !archive.getName().endsWith(".tgz")) {
      throw new GradleException(
          "liboliphaunt release runtime artifact for "
              + sqlName
              + " must be a Gradle-native .tar.gz archive, got "
              + archive.getName());
    }
    File extractRoot = new File(getTemporaryDir(), "runtime-artifact-" + sqlName + "-" + archive.getName());
    fileSystemOperations.delete(spec -> spec.delete(extractRoot));
    fileSystemOperations.copy(
        spec -> {
          spec.from(archiveOperations.tarTree(archiveOperations.gzip(archive)));
          spec.into(extractRoot);
        });
    File artifactRoot = artifactRoot(extractRoot, archive);
    Properties manifest = readProperties(new File(artifactRoot, "manifest.properties"));
    if (!"oliphaunt-extension-artifact-v1".equals(manifest.getProperty("packageLayout"))) {
      throw new GradleException("liboliphaunt extension runtime artifact " + archive.getName() + " has unsupported packageLayout");
    }
    if (!sqlName.equals(manifest.getProperty("sqlName"))) {
      throw new GradleException(
          "liboliphaunt extension runtime artifact "
              + archive.getName()
              + " is for "
              + manifest.getProperty("sqlName")
              + ", expected "
              + sqlName);
    }
    if (!new File(artifactRoot, "files").isDirectory()) {
      throw new GradleException("liboliphaunt extension runtime artifact " + archive.getName() + " is missing files/");
    }
    return artifactRoot;
  }

  private static File artifactRoot(File extractRoot, File archive) {
    if (new File(extractRoot, "manifest.properties").isFile()) {
      return extractRoot;
    }
    File[] children =
        extractRoot.listFiles(file -> file.isDirectory() && new File(file, "manifest.properties").isFile());
    if (children != null && children.length == 1) {
      return children[0];
    }
    throw new GradleException(
        "liboliphaunt extension runtime artifact "
            + archive.getName()
            + " did not contain one manifest.properties root");
  }

  private static File runtimeResourcesRoot(File root) {
    File nested = new File(root, "oliphaunt");
    if (nested.isDirectory()) {
      return nested;
    }
    if (new File(root, "runtime").isDirectory()) {
      return root;
    }
    return nested;
  }

  private static void updateRuntimeManifest(
      File manifestFile, List<ExtensionRuntimeArtifact> artifacts, String staticRegistrySource) {
    Properties properties = manifestFile.isFile() ? readProperties(manifestFile) : new Properties();
    List<String> selectedExtensions = sorted(artifacts.stream().map(artifact -> artifact.sqlName).toList());
    List<String> sharedPreload =
        sorted(
            artifacts.stream()
                .flatMap(artifact -> splitCsv(artifact.sharedPreload).stream())
                .toList());
    List<String> nativeStems =
        sorted(
            artifacts.stream()
                .map(artifact -> artifact.nativeModuleStem)
                .filter(value -> value != null)
                .toList());
    List<String> registered =
        sorted(
            artifacts.stream()
                .filter(artifact -> artifact.nativeModuleStem != null)
                .map(artifact -> artifact.sqlName)
                .toList());
    properties.setProperty("schema", "oliphaunt-runtime-resources-v1");
    properties.setProperty("extensions", String.join(",", selectedExtensions));
    properties.setProperty("sharedPreloadLibraries", String.join(",", sharedPreload));
    properties.setProperty("mobileStaticRegistryState", nativeStems.isEmpty() ? "not-required" : "complete");
    properties.setProperty("mobileStaticRegistryRegistered", String.join(",", registered));
    properties.setProperty("mobileStaticRegistryPending", "");
    properties.setProperty("nativeModuleStems", String.join(",", nativeStems));
    properties.setProperty("mobileStaticRegistrySource", staticRegistrySource);
    writeOrderedProperties(manifestFile, properties);
  }

  private static void writeStaticRegistryManifest(File staticRegistryDir, List<ExtensionRuntimeArtifact> artifacts) {
    List<String> modules =
        sorted(
            artifacts.stream()
                .map(artifact -> artifact.nativeModuleStem)
                .filter(value -> value != null)
                .toList());
    List<String> archiveTargets =
        sorted(
            artifacts.stream()
                .filter(artifact -> artifact.nativeModuleStem != null)
                .flatMap(artifact -> artifact.archiveTargets.stream())
                .toList());
    List<String> lines = new ArrayList<>();
    lines.add("packageLayout=oliphaunt-static-registry-v1");
    lines.add("abiVersion=1");
    lines.add("state=complete");
    lines.add("source=oliphaunt_static_registry.c");
    lines.add("registeredExtensions=" + String.join(",", sorted(artifacts.stream().map(artifact -> artifact.sqlName).toList())));
    lines.add("pendingExtensions=");
    lines.add("nativeModuleStems=" + String.join(",", modules));
    lines.add("modules=" + String.join(",", modules));
    lines.add("archiveTargets=" + String.join(",", archiveTargets));
    for (ExtensionRuntimeArtifact artifact : artifacts.stream().filter(value -> value.nativeModuleStem != null).toList()) {
      String stem = artifact.nativeModuleStem;
      List<String> targets = sorted(artifact.archiveTargets);
      lines.add("module." + stem + ".extension=" + artifact.sqlName);
      lines.add("module." + stem + ".symbolPrefix=" + staticRegistrySymbolPrefix(stem));
      lines.add("module." + stem + ".sqlSymbols=");
      lines.add("module." + stem + ".archiveTargets=" + String.join(",", targets));
      for (String target : targets) {
        lines.add(
            "module."
                + stem
                + ".archive."
                + target
                + "=archives/"
                + target
                + "/extensions/"
                + stem
                + "/liboliphaunt_extension_"
                + stem
                + ".a");
      }
    }
    writeText(new File(staticRegistryDir, "manifest.properties"), String.join("\n", lines) + "\n");
  }

  private static String staticRegistrySourceText(File runtimeFiles, List<ExtensionRuntimeArtifact> artifacts) {
    StringBuilder out = new StringBuilder();
    out.append("/* Generated by Oliphaunt Android Gradle plugin. Do not edit by hand. */\n");
    out.append("#include <stddef.h>\n#include <stdint.h>\n#include \"oliphaunt.h\"\n\n");
    out.append("#if defined(__GNUC__) || defined(__clang__)\n#define OLIPHAUNT_STATIC_OPTIONAL __attribute__((weak))\n#else\n#define OLIPHAUNT_STATIC_OPTIONAL\n#endif\n\n");
    List<StaticRegistryModule> modules = new ArrayList<>();
    for (ExtensionRuntimeArtifact artifact : artifacts) {
      if (artifact.nativeModuleStem == null) {
        continue;
      }
      modules.add(
          new StaticRegistryModule(
              artifact.nativeModuleStem,
              staticRegistrySymbolPrefix(artifact.nativeModuleStem),
              collectExtensionSqlSymbols(runtimeFiles, artifact.sqlName)));
    }
    modules.sort(java.util.Comparator.comparing(module -> module.moduleStem));
    for (StaticRegistryModule module : modules) {
      out.append("extern const void *").append(module.symbolPrefix).append("_Pg_magic_func(void);\n");
      out.append("extern void ").append(module.symbolPrefix).append("__PG_init(void) OLIPHAUNT_STATIC_OPTIONAL;\n");
      for (String symbol : module.sqlSymbols) {
        out.append("extern void ").append(symbol).append("(void);\n");
        out.append("extern void pg_finfo_").append(symbol).append("(void);\n");
      }
      out.append('\n');
    }
    for (StaticRegistryModule module : modules) {
      out.append("static const OliphauntStaticExtensionSymbol ").append(module.symbolPrefix).append("_symbols[] = {\n");
      for (String symbol : module.sqlSymbols) {
        out.append("    { .name = ").append(cStringLiteral(symbol)).append(", .address = (void *)").append(symbol).append(" },\n");
        out.append("    { .name = ").append(cStringLiteral("pg_finfo_" + symbol)).append(", .address = (void *)pg_finfo_").append(symbol).append(" },\n");
      }
      out.append("};\n\n");
    }
    out.append("static const OliphauntStaticExtension liboliphaunt_static_extensions[] = {\n");
    for (StaticRegistryModule module : modules) {
      out.append("    {\n");
      out.append("        .abi_version = OLIPHAUNT_STATIC_EXTENSION_ABI_VERSION,\n");
      out.append("        .name = ").append(cStringLiteral(module.moduleStem)).append(",\n");
      out.append("        .magic = ").append(module.symbolPrefix).append("_Pg_magic_func,\n");
      out.append("        .init = ").append(module.symbolPrefix).append("__PG_init,\n");
      out.append("        .symbols = ").append(module.symbolPrefix).append("_symbols,\n");
      out.append("        .symbol_count = sizeof(").append(module.symbolPrefix).append("_symbols) / sizeof(").append(module.symbolPrefix).append("_symbols[0]),\n");
      out.append("        .reserved_flags = 0,\n");
      out.append("    },\n");
    }
    out.append("};\n\n");
    out.append("const OliphauntStaticExtension *liboliphaunt_selected_static_extensions(size_t *count) {\n");
    out.append("    if (count != NULL) {\n");
    out.append("        *count = sizeof(liboliphaunt_static_extensions) / sizeof(liboliphaunt_static_extensions[0]);\n");
    out.append("    }\n");
    out.append("    return liboliphaunt_static_extensions;\n");
    out.append("}\n");
    return out.toString();
  }

  private static List<String> collectExtensionSqlSymbols(File runtimeFiles, String sqlName) {
    File extensionDir = new File(runtimeFiles, "share/postgresql/extension");
    File[] sqlFiles =
        extensionDir.listFiles(
            file -> file.isFile() && file.getName().startsWith(sqlName + "--") && file.getName().endsWith(".sql"));
    if (sqlFiles == null || sqlFiles.length == 0) {
      throw new GradleException("selected extension " + sqlName + " has no packaged SQL files in " + extensionDir);
    }
    Arrays.sort(sqlFiles, java.util.Comparator.comparing(File::getName));
    TreeSet<String> symbols = new TreeSet<>();
    for (File file : sqlFiles) {
      try {
        symbols.addAll(modulePathnameCSymbols(Files.readString(file.toPath(), StandardCharsets.UTF_8)));
      } catch (IOException error) {
        throw new GradleException("read extension SQL " + file + ": " + error.getMessage(), error);
      }
    }
    return new ArrayList<>(symbols);
  }

  private static List<String> modulePathnameCSymbols(String sql) {
    TreeSet<String> symbols = new TreeSet<>();
    for (String statement : splitSqlStatements(stripSqlLineComments(sql))) {
      if (!containsIgnoreCase(statement, "module_pathname") || !hasLanguageC(statement)) {
        continue;
      }
      String symbol = explicitModulePathnameSymbol(statement);
      if (symbol == null) {
        symbol = implicitFunctionSymbol(statement);
      }
      if (symbol != null) {
        if (!symbol.matches("[A-Za-z_][A-Za-z0-9_]*")) {
          throw new GradleException("extension SQL references non-portable C symbol '" + symbol + "'");
        }
        symbols.add(symbol);
      }
    }
    return new ArrayList<>(symbols);
  }

  private static String stripSqlLineComments(String sql) {
    StringBuilder out = new StringBuilder(sql.length());
    boolean inString = false;
    for (int index = 0; index < sql.length(); index++) {
      char ch = sql.charAt(index);
      if (ch == '\'') {
        out.append(ch);
        if (inString && index + 1 < sql.length() && sql.charAt(index + 1) == '\'') {
          out.append(sql.charAt(++index));
        } else {
          inString = !inString;
        }
      } else if (!inString && ch == '-' && index + 1 < sql.length() && sql.charAt(index + 1) == '-') {
        index += 2;
        while (index < sql.length() && sql.charAt(index) != '\n') {
          index++;
        }
        if (index < sql.length()) {
          out.append('\n');
        }
      } else {
        out.append(ch);
      }
    }
    return out.toString();
  }

  private static List<String> splitSqlStatements(String sql) {
    List<String> statements = new ArrayList<>();
    int start = 0;
    boolean inString = false;
    for (int index = 0; index < sql.length(); index++) {
      char ch = sql.charAt(index);
      if (ch == '\'') {
        if (inString && index + 1 < sql.length() && sql.charAt(index + 1) == '\'') {
          index++;
        } else {
          inString = !inString;
        }
      } else if (!inString && ch == ';') {
        String statement = sql.substring(start, index).trim();
        if (!statement.isEmpty()) {
          statements.add(statement);
        }
        start = index + 1;
      }
    }
    if (start < sql.length()) {
      String statement = sql.substring(start).trim();
      if (!statement.isEmpty()) {
        statements.add(statement);
      }
    }
    return statements;
  }

  private static String explicitModulePathnameSymbol(String statement) {
    int moduleIndex = statement.toLowerCase(java.util.Locale.ROOT).indexOf("module_pathname");
    if (moduleIndex < 0) {
      return null;
    }
    String rest = statement.substring(moduleIndex + "module_pathname".length()).stripLeading();
    if (rest.startsWith("'")) {
      rest = rest.substring(1).stripLeading();
    }
    if (!rest.startsWith(",")) {
      return null;
    }
    return parseSqlSingleQuotedLiteral(rest.substring(1).stripLeading());
  }

  private static String implicitFunctionSymbol(String statement) {
    int functionIndex = statement.toLowerCase(java.util.Locale.ROOT).indexOf("function");
    if (functionIndex < 0) {
      return null;
    }
    String afterFunction = statement.substring(functionIndex + "function".length());
    int nameEnd = afterFunction.indexOf('(');
    if (nameEnd < 0) {
      return null;
    }
    return lastSqlIdentifier(afterFunction.substring(0, nameEnd).trim());
  }

  private static String parseSqlSingleQuotedLiteral(String value) {
    if (!value.startsWith("'")) {
      return null;
    }
    StringBuilder out = new StringBuilder();
    for (int index = 1; index < value.length(); index++) {
      char ch = value.charAt(index);
      if (ch == '\'') {
        if (index + 1 < value.length() && value.charAt(index + 1) == '\'') {
          out.append('\'');
          index++;
        } else {
          return out.toString();
        }
      } else {
        out.append(ch);
      }
    }
    return null;
  }

  private static String lastSqlIdentifier(String rawName) {
    List<String> parts = new ArrayList<>();
    int start = 0;
    boolean inQuotes = false;
    for (int index = 0; index < rawName.length(); index++) {
      char ch = rawName.charAt(index);
      if (ch == '"') {
        if (inQuotes && index + 1 < rawName.length() && rawName.charAt(index + 1) == '"') {
          index++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (!inQuotes && ch == '.') {
        parts.add(rawName.substring(start, index).trim());
        start = index + 1;
      }
    }
    parts.add(rawName.substring(start).trim());
    String part = parts.get(parts.size() - 1).trim();
    if (part.startsWith("\"") && part.endsWith("\"") && part.length() >= 2) {
      return part.substring(1, part.length() - 1).replace("\"\"", "\"");
    }
    return part;
  }

  private static boolean hasLanguageC(String statement) {
    List<String> tokens =
        Arrays.stream(statement.split("[^A-Za-z0-9_]+"))
            .filter(value -> !value.isEmpty())
            .map(value -> value.toLowerCase(java.util.Locale.ROOT))
            .toList();
    for (int index = 0; index + 1 < tokens.size(); index++) {
      if (tokens.get(index).equals("language") && tokens.get(index + 1).equals("c")) {
        return true;
      }
    }
    return false;
  }

  private static boolean containsIgnoreCase(String value, String needle) {
    return value.toLowerCase(java.util.Locale.ROOT).contains(needle.toLowerCase(java.util.Locale.ROOT));
  }

  private static String staticRegistrySymbolPrefix(String moduleStem) {
    StringBuilder out = new StringBuilder("oliphaunt_static_");
    for (int index = 0; index < moduleStem.length(); index++) {
      char ch = moduleStem.charAt(index);
      out.append((ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || ch == '_' ? ch : '_');
    }
    return out.toString();
  }

  private static String cStringLiteral(String value) {
    StringBuilder out = new StringBuilder("\"");
    for (int index = 0; index < value.length(); index++) {
      char ch = value.charAt(index);
      switch (ch) {
        case '\\' -> out.append("\\\\");
        case '"' -> out.append("\\\"");
        case '\n' -> out.append("\\n");
        case '\r' -> out.append("\\r");
        case '\t' -> out.append("\\t");
        default -> out.append(ch);
      }
    }
    out.append('"');
    return out.toString();
  }

  private static void copyTree(Path source, Path target) {
    try (var stream = Files.walk(source)) {
      for (Path path : stream.sorted().toList()) {
        if (Files.isSymbolicLink(path)) {
          throw new GradleException("Oliphaunt Android release assets do not support symlinks: " + path);
        }
        Path relative = source.relativize(path);
        Path destination = target.resolve(relative);
        if (Files.isDirectory(path)) {
          Files.createDirectories(destination);
        } else if (Files.isRegularFile(path)) {
          Files.createDirectories(destination.getParent());
          Files.copy(path, destination, StandardCopyOption.REPLACE_EXISTING);
        }
      }
    } catch (IOException error) {
      throw new GradleException("copy " + source + " to " + target + ": " + error.getMessage(), error);
    }
  }

  private static Properties readProperties(File file) {
    Properties properties = new Properties();
    try (var input = Files.newInputStream(file.toPath())) {
      properties.load(input);
      return properties;
    } catch (IOException error) {
      throw new GradleException("read " + file + ": " + error.getMessage(), error);
    }
  }

  private static void writeOrderedProperties(File file, Properties properties) {
    List<String> preferred =
        List.of(
            "schema",
            "cacheKey",
            "layout",
            "source",
            "extensions",
            "sharedPreloadLibraries",
            "mobileStaticRegistryState",
            "mobileStaticRegistryRegistered",
            "mobileStaticRegistryPending",
            "nativeModuleStems",
            "mobileStaticRegistrySource");
    LinkedHashSet<String> keys = new LinkedHashSet<>(preferred);
    keys.addAll(new TreeSet<>(properties.stringPropertyNames()));
    StringBuilder out = new StringBuilder();
    for (String key : keys) {
      String value = properties.getProperty(key);
      if (value != null) {
        out.append(key).append('=').append(value).append('\n');
      }
    }
    writeText(file, out.toString());
  }

  private static void writeText(File file, String text) {
    try {
      Files.createDirectories(file.toPath().getParent());
      Files.writeString(file.toPath(), text, StandardCharsets.UTF_8);
    } catch (IOException error) {
      throw new GradleException("write " + file + ": " + error.getMessage(), error);
    }
  }

  private static String dashToNull(String value) {
    return value == null || value.equals("-") || value.isBlank() ? null : value;
  }

  private static String emptyToDash(String value) {
    return value == null || value.isBlank() ? "-" : value;
  }

  private static List<String> splitCsv(String raw) {
    if (raw == null || raw.isBlank()) {
      return List.of();
    }
    return Arrays.stream(raw.split(",")).map(String::trim).filter(value -> !value.isEmpty()).toList();
  }

  private static List<String> sorted(List<String> values) {
    return new ArrayList<>(new TreeSet<>(values));
  }

  private record ExtensionRuntimeArtifact(
      String sqlName, String nativeModuleStem, String sharedPreload, List<String> archiveTargets) {}

  private record StaticRegistryModule(String moduleStem, String symbolPrefix, List<String> sqlSymbols) {}
}
