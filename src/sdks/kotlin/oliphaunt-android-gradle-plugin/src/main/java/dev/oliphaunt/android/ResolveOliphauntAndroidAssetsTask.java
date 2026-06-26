package dev.oliphaunt.android;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
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
import org.gradle.api.file.ConfigurableFileCollection;
import org.gradle.api.file.DirectoryProperty;
import org.gradle.api.file.FileSystemOperations;
import org.gradle.api.provider.ListProperty;
import org.gradle.api.provider.Property;
import org.gradle.api.tasks.Input;
import org.gradle.api.tasks.InputFiles;
import org.gradle.api.tasks.OutputDirectory;
import org.gradle.api.tasks.PathSensitive;
import org.gradle.api.tasks.PathSensitivity;
import org.gradle.api.tasks.TaskAction;
import org.gradle.work.DisableCachingByDefault;

@DisableCachingByDefault(because = "Copies resolved runtime artifacts into generated Android source sets")
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
  public abstract ListProperty<String> getSelectedAbis();

  @Input
  public abstract ListProperty<String> getSelectedExtensions();

  @Input
  public abstract Property<Boolean> getIcu();

  @InputFiles
  @PathSensitive(PathSensitivity.RELATIVE)
  public abstract ConfigurableFileCollection getRuntimeArtifacts();

  @InputFiles
  @PathSensitive(PathSensitivity.RELATIVE)
  public abstract ConfigurableFileCollection getExtensionArtifacts();

  @InputFiles
  @PathSensitive(PathSensitivity.RELATIVE)
  public abstract ConfigurableFileCollection getIcuArtifacts();

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
    List<String> abis = effectiveAbis();
    List<File> runtimeArtifacts = sortedFiles(getRuntimeArtifacts().getFiles());
    File runtimeResources = findRuntimeResourcesArtifact(runtimeArtifacts, releaseVersion);
    Map<String, File> androidRuntimeArtifacts = new LinkedHashMap<>();
    for (String abi : abis) {
      androidRuntimeArtifacts.put(abi, findAndroidRuntimeArtifact(runtimeArtifacts, releaseVersion, abi));
    }

    List<File> extensionArtifacts = sortedFiles(getExtensionArtifacts().getFiles());
    Map<String, File> selectedExtensionFiles = new LinkedHashMap<>();
    List<Map<String, String>> selectedRows = selectedExtensionRows(extensionArtifacts, selectedExtensionFiles, abis);
    List<File> icuArtifacts = sortedFiles(getIcuArtifacts().getFiles());
    boolean includeIcu = Boolean.TRUE.equals(getIcu().get()) || !icuArtifacts.isEmpty();
    File icuArtifact = includeIcu ? findIcuDataArtifact(icuArtifacts, releaseVersion) : null;

    unpackRuntimeResources(runtimeResources);
    if (icuArtifact != null) {
      mergeIcuDataArtifact(icuArtifact);
    }
    mergeExtensionRuntimeArtifacts(selectedExtensionFiles, selectedRows);
    unpackAndroidJniLibs(androidRuntimeArtifacts, abis);
    unpackAndroidExtensionArchives(selectedExtensionFiles);
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

  private static File findRuntimeResourcesArtifact(List<File> artifacts, String version) {
    return findArtifact(
        artifacts,
        List.of("liboliphaunt-" + version + "-runtime-resources.tar.gz", "liboliphaunt-runtime-resources-" + version + ".tar.gz"),
        List.of("runtime-resources"),
        "liboliphaunt runtime resources");
  }

  private static File findAndroidRuntimeArtifact(List<File> artifacts, String version, String abi) {
    String target = androidTarget(abi);
    return findArtifact(
        artifacts,
        List.of("liboliphaunt-" + version + "-" + target + ".tar.gz", "liboliphaunt-" + target + "-" + version + ".tar.gz"),
        List.of(target),
        "liboliphaunt Android runtime for " + abi);
  }

  private static File findIcuDataArtifact(List<File> artifacts, String version) {
    return findArtifact(
        artifacts,
        List.of("liboliphaunt-" + version + "-icu-data.tar.gz", "oliphaunt-icu-" + version + ".tar.gz"),
        List.of("icu"),
        "Oliphaunt ICU data");
  }

  private static List<File> sortedFiles(Set<File> files) {
    return files.stream()
        .filter(File::isFile)
        .sorted(java.util.Comparator.comparing(File::getName).thenComparing(file -> file.getAbsolutePath()))
        .toList();
  }

  private static File findArtifact(
      List<File> artifacts, List<String> exactNames, List<String> nameFragments, String label) {
    List<File> exactMatches = artifacts.stream().filter(file -> exactNames.contains(file.getName())).toList();
    if (exactMatches.size() == 1) {
      return exactMatches.get(0);
    }
    if (exactMatches.size() > 1) {
      throw new GradleException("multiple Maven-resolved artifacts match " + label + ": " + fileNames(exactMatches));
    }
    List<File> fragmentMatches =
        artifacts.stream()
            .filter(file -> nameFragments.stream().allMatch(fragment -> file.getName().contains(fragment)))
            .toList();
    if (fragmentMatches.size() == 1) {
      return fragmentMatches.get(0);
    }
    if (fragmentMatches.isEmpty()) {
      throw new GradleException(
          "missing Maven-resolved artifact for "
              + label
              + "; expected one of "
              + exactNames
              + " or a file containing "
              + nameFragments
              + " in "
              + fileNames(artifacts));
    }
    throw new GradleException("multiple Maven-resolved artifacts match " + label + ": " + fileNames(fragmentMatches));
  }

  private static String fileNames(List<File> files) {
    return files.stream().map(File::getName).sorted().toList().toString();
  }

  private List<Map<String, String>> selectedExtensionRows(
      List<File> artifacts, Map<String, File> selectedFiles, List<String> abis) {
    if (getSelectedExtensions().get().isEmpty()) {
      return List.of();
    }
    Map<String, Map<String, ExtensionArchive>> archives = extensionArchives(artifacts);
    Map<String, Map<String, String>> rows = new LinkedHashMap<>();
    LinkedHashSet<String> visiting = new LinkedHashSet<>();
    for (String extension : getSelectedExtensions().get()) {
      selectExtension(archives, selectedFiles, rows, visiting, extension, abis);
    }
    return rows.values().stream()
        .sorted(java.util.Comparator.comparing(row -> row.get("sql_name")))
        .toList();
  }

  private void selectExtension(
      Map<String, Map<String, ExtensionArchive>> archives,
      Map<String, File> selectedFiles,
      Map<String, Map<String, String>> rows,
      LinkedHashSet<String> visiting,
      String sqlName,
      List<String> abis) {
    if (rows.containsKey(sqlName)) {
      return;
    }
    if (!visiting.add(sqlName)) {
      throw new GradleException("cyclic Oliphaunt Android extension dependency involving " + sqlName);
    }
    String product = extensionProduct(sqlName);
    LinkedHashSet<String> dependencies = new LinkedHashSet<>();
    LinkedHashSet<String> archiveTargets = new LinkedHashSet<>();
    LinkedHashSet<String> dependencyArchives = new LinkedHashSet<>();
    LinkedHashSet<String> runtimeAssets = new LinkedHashSet<>();
    String nativeModuleStem = "";
    String sharedPreload = "";
    for (String abi : abis) {
      String target = androidTarget(abi);
      ExtensionArchive archive = requireExtensionArchive(archives, product, sqlName, target);
      validateExtensionArchive(product, sqlName, target, archive);
      dependencies.addAll(splitCsv(archive.manifest().getProperty("dependencies")));
      String archiveNativeModuleStem = archive.manifest().getProperty("nativeModuleStem", "").trim();
      if (nativeModuleStem.isEmpty()) {
        nativeModuleStem = archiveNativeModuleStem;
      } else if (!nativeModuleStem.equals(archiveNativeModuleStem)) {
        throw new GradleException(product + " declares inconsistent nativeModuleStem values across Android targets");
      }
      String archiveSharedPreload = archive.manifest().getProperty("sharedPreloadLibraries", "").trim();
      if (sharedPreload.isEmpty()) {
        sharedPreload = archiveSharedPreload;
      } else if (!sharedPreload.equals(archiveSharedPreload)) {
        throw new GradleException(product + " declares inconsistent sharedPreloadLibraries values across Android targets");
      }
      runtimeAssets.add(archive.assetName());
      selectedFiles.putIfAbsent(archive.assetName(), archive.archive());
      if (!archiveNativeModuleStem.isEmpty()) {
        requireMobileStaticArchive(product, sqlName, target, archive, archiveNativeModuleStem);
        dependencyArchives.addAll(requireMobileStaticDependencyArchives(product, target, archive));
        archiveTargets.add(abi);
      }
    }
    for (String dependency : dependencies) {
      selectExtension(archives, selectedFiles, rows, visiting, dependency, abis);
    }
    if (runtimeAssets.isEmpty()) {
      throw new GradleException("selected extension " + sqlName + " did not resolve an Android runtime artifact");
    }
    Map<String, String> row = new LinkedHashMap<>();
    row.put("sql_name", sqlName);
    row.put("runtime_artifact", runtimeAssets.iterator().next());
    row.put("native_module_stem", emptyToDash(nativeModuleStem));
    row.put("shared_preload", emptyToDash(sharedPreload));
    row.put("dependencies", dependencies.isEmpty() ? "-" : String.join(",", sorted(new ArrayList<>(dependencies))));
    row.put("archive_targets", archiveTargets.isEmpty() ? "-" : String.join(",", archiveTargets));
    row.put("dependency_archives", dependencyArchives.isEmpty() ? "-" : String.join(",", sorted(new ArrayList<>(dependencyArchives))));
    rows.put(sqlName, row);
    visiting.remove(sqlName);
  }

  private static String extensionProduct(String sqlName) {
    if (!sqlName.matches("[A-Za-z0-9._-]{1,128}")) {
      throw new GradleException("invalid Oliphaunt extension SQL name: " + sqlName);
    }
    return "oliphaunt-extension-" + sqlName.replace('_', '-');
  }

  private static String androidTarget(String abi) {
    return switch (abi) {
      case "arm64-v8a" -> "android-arm64-v8a";
      case "x86_64" -> "android-x86_64";
      default -> throw new GradleException("unsupported liboliphaunt Android ABI " + abi);
    };
  }

  private Map<String, Map<String, ExtensionArchive>> extensionArchives(List<File> artifacts) {
    Map<String, Map<String, ExtensionArchive>> archives = new LinkedHashMap<>();
    for (File artifact : artifacts) {
      if (!artifact.getName().endsWith(".tar.gz") && !artifact.getName().endsWith(".tgz")) {
        continue;
      }
      File root = extractExtensionArchive(artifact);
      Properties manifest = readProperties(new File(root, "manifest.properties"));
      if (!"oliphaunt-extension-artifact-v1".equals(manifest.getProperty("packageLayout"))) {
        throw new GradleException("Maven-resolved Oliphaunt extension artifact " + artifact.getName() + " has unsupported packageLayout");
      }
      String sqlName = manifest.getProperty("sqlName", "").trim();
      String target = manifest.getProperty("nativeTarget", "").trim();
      if (sqlName.isEmpty() || target.isEmpty()) {
        throw new GradleException("Maven-resolved Oliphaunt extension artifact " + artifact.getName() + " is missing sqlName or nativeTarget");
      }
      ExtensionArchive archive = new ExtensionArchive(artifact.getName(), artifact, root, manifest);
      Map<String, ExtensionArchive> targetArchives = archives.computeIfAbsent(sqlName, ignored -> new LinkedHashMap<>());
      ExtensionArchive previous = targetArchives.put(target, archive);
      if (previous != null) {
        throw new GradleException("multiple Maven-resolved artifacts declare extension " + sqlName + " for target " + target);
      }
    }
    return archives;
  }

  private static ExtensionArchive requireExtensionArchive(
      Map<String, Map<String, ExtensionArchive>> archives, String product, String sqlName, String target) {
    Map<String, ExtensionArchive> targetArchives = archives.get(sqlName);
    if (targetArchives == null || targetArchives.get(target) == null) {
      throw new GradleException(
          "selected extension "
              + sqlName
              + " is missing Maven-resolved artifact "
              + product
              + "-"
              + target
              + " in oliphauntAndroidExtensionArtifacts");
    }
    return targetArchives.get(target);
  }

  private static void validateExtensionArchive(String product, String sqlName, String target, ExtensionArchive archive) {
    Properties manifest = archive.manifest();
    if (!"oliphaunt-extension-artifact-v1".equals(manifest.getProperty("packageLayout"))) {
      throw new GradleException(product + " Android artifact " + archive.assetName() + " has unsupported packageLayout");
    }
    if (!sqlName.equals(manifest.getProperty("sqlName"))) {
      throw new GradleException(product + " Android artifact " + archive.assetName() + " declares sqlName " + manifest.getProperty("sqlName"));
    }
    if (!target.equals(manifest.getProperty("nativeTarget"))) {
      throw new GradleException(product + " Android artifact " + archive.assetName() + " declares nativeTarget " + manifest.getProperty("nativeTarget"));
    }
  }

  private static void requireMobileStaticArchive(
      String product, String sqlName, String target, ExtensionArchive archive, String nativeModuleStem) {
    List<MobileStaticArchive> entries =
        splitCsv(archive.manifest().getProperty("mobileStaticArchives")).stream()
            .map(ResolveOliphauntAndroidAssetsTask::parseMobileStaticArchive)
            .toList();
    String suffix = "extensions/" + nativeModuleStem + "/liboliphaunt_extension_" + nativeModuleStem + ".a";
    MobileStaticArchive staticArchive =
        entries.stream()
            .filter(entry -> entry.target().equals(target) && entry.relativePath().endsWith(suffix))
            .findFirst()
            .orElse(null);
    if (staticArchive == null) {
      throw new GradleException(product + " artifact " + archive.assetName() + " has no mobile static archive for " + sqlName + " target " + target);
    }
    requireArtifactFile(archive, staticArchive.relativePath(), product + " mobile static archive for " + sqlName + " target " + target);
  }

  private static List<String> requireMobileStaticDependencyArchives(String product, String target, ExtensionArchive archive) {
    List<String> dependencies = new ArrayList<>();
    for (String entry : splitCsv(archive.manifest().getProperty("mobileStaticDependencyArchives"))) {
      MobileStaticDependencyArchive dependency = parseMobileStaticDependencyArchive(entry);
      if (!dependency.target().equals(target)) {
        continue;
      }
      requireArtifactFile(
          archive,
          dependency.relativePath(),
          product + " mobile static dependency archive " + dependency.name() + " target " + target);
      dependencies.add(dependency.target() + ":" + dependency.name() + ":" + dependency.relativePath());
    }
    return dependencies;
  }

  private static void requireArtifactFile(ExtensionArchive archive, String relativePath, String label) {
    File file = artifactRelativeFile(archive, relativePath);
    if (!file.isFile()) {
      throw new GradleException(label + " is declared but missing from " + archive.assetName() + ": " + relativePath);
    }
  }

  private static File artifactRelativeFile(ExtensionArchive archive, String relativePath) {
    Path root = archive.root().toPath().toAbsolutePath().normalize();
    Path relative = Path.of(relativePath);
    if (relative.isAbsolute() || relative.normalize().startsWith("..")) {
      throw new GradleException("Oliphaunt extension artifact " + archive.assetName() + " declares unsafe relative path " + relativePath);
    }
    Path resolved = root.resolve(relative).normalize();
    if (!resolved.startsWith(root)) {
      throw new GradleException("Oliphaunt extension artifact " + archive.assetName() + " declares unsafe relative path " + relativePath);
    }
    return resolved.toFile();
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

  private void mergeIcuDataArtifact(File archive) {
    File extractRoot = new File(getTemporaryDir(), "icu-artifact-" + archive.getName());
    fileSystemOperations.delete(spec -> spec.delete(extractRoot));
    fileSystemOperations.copy(
        spec -> {
          spec.from(archiveOperations.tarTree(archiveOperations.gzip(archive)));
          spec.into(extractRoot);
        });
    File icuRoot = findIcuDataRoot(extractRoot);
    if (icuRoot == null) {
      throw new GradleException("Oliphaunt ICU artifact " + archive.getName() + " does not contain share/icu/icudt* data");
    }
    File root = runtimeResourcesRoot(getRuntimeResourcesDir().get().getAsFile());
    File runtimePackage = new File(root, "runtime");
    File runtimeFiles = new File(runtimePackage, "files");
    if (!runtimeFiles.isDirectory()) {
      throw new GradleException("liboliphaunt runtime resources did not contain oliphaunt/runtime/files");
    }
    File destination = new File(runtimeFiles, "share/icu");
    fileSystemOperations.delete(spec -> spec.delete(destination));
    copyTree(icuRoot.toPath(), destination.toPath());
    updateRuntimeFeatures(new File(runtimePackage, "manifest.properties"), List.of("icu"));
  }

  private void unpackAndroidJniLibs(Map<String, File> runtimeArtifacts, List<String> abis) {
    File output = getJniLibsDir().get().getAsFile();
    fileSystemOperations.delete(spec -> spec.delete(output));
    for (String abi : abis) {
      File archive = runtimeArtifacts.get(abi);
      if (archive == null) {
        throw new GradleException("missing Maven-resolved liboliphaunt Android runtime artifact for " + abi);
      }
      File extractRoot = new File(getTemporaryDir(), "jni-" + abi);
      fileSystemOperations.delete(spec -> spec.delete(extractRoot));
      fileSystemOperations.copy(
          spec -> {
            spec.from(archiveOperations.tarTree(archiveOperations.gzip(archive)));
            spec.into(extractRoot);
          });
      File source = new File(extractRoot, "jni/" + abi);
      if (!source.isDirectory()) {
        throw new GradleException("liboliphaunt Android artifact " + archive.getName() + " did not contain jni/" + abi);
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
      File artifactRoot = extractExtensionArchive(entry.getValue());
      Properties manifest = readProperties(new File(artifactRoot, "manifest.properties"));
      String target = manifest.getProperty("nativeTarget", "").trim();
      if (!target.startsWith("android-")) {
        continue;
      }
      String abi = switch (target) {
        case "android-arm64-v8a" -> "arm64-v8a";
        case "android-x86_64" -> "x86_64";
        default -> throw new GradleException("unsupported Oliphaunt Android extension target " + target);
      };
      copyMobileStaticTree(new File(artifactRoot, "mobile-static/" + target + "/extensions"), new File(output, "android-" + abi + "/extensions"));
      copyMobileStaticTree(new File(artifactRoot, "mobile-static/" + target + "/dependencies"), new File(output, "android-" + abi + "/dependencies"));
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
              splitCsv(row.get("archive_targets")),
              splitCsv(row.get("dependency_archives"))));
    }
    validateSelectedExtensionRuntimeFiles(runtimeFiles, artifacts);
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
    File artifactRoot = extractExtensionArchive(archive);
    Properties manifest = readProperties(new File(artifactRoot, "manifest.properties"));
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

  private static void validateSelectedExtensionRuntimeFiles(File runtimeFiles, List<ExtensionRuntimeArtifact> artifacts) {
    File extensionDir = new File(runtimeFiles, "share/postgresql/extension");
    for (ExtensionRuntimeArtifact artifact : artifacts) {
      File control = new File(extensionDir, artifact.sqlName + ".control");
      if (!control.isFile()) {
        throw new GradleException(
            "selected extension " + artifact.sqlName + " is missing packaged control file " + control);
      }
      extensionSqlFiles(runtimeFiles, artifact.sqlName);
    }
  }

  private File extractExtensionArchive(File archive) {
    if (!archive.getName().endsWith(".tar.gz") && !archive.getName().endsWith(".tgz")) {
      throw new GradleException(
          "liboliphaunt extension runtime artifact must be a Gradle-native .tar.gz archive, got "
              + archive.getName());
    }
    File extractRoot = new File(getTemporaryDir(), "runtime-artifact-" + archive.getName());
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

  private static File findIcuDataRoot(File extractRoot) {
    File direct = new File(extractRoot, "share/icu");
    if (icuDataRootContainsData(direct)) {
      return direct;
    }
    if (icuDataRootContainsData(extractRoot)) {
      return extractRoot;
    }
    try (var stream = Files.walk(extractRoot.toPath())) {
      List<Path> candidates =
          stream
              .filter(Files::isDirectory)
              .filter(path -> icuDataRootContainsData(path.toFile()))
              .sorted()
              .toList();
      return candidates.isEmpty() ? null : candidates.get(0).toFile();
    } catch (IOException error) {
      throw new GradleException("inspect Oliphaunt ICU artifact " + extractRoot + ": " + error.getMessage(), error);
    }
  }

  private static boolean icuDataRootContainsData(File root) {
    File[] children = root.listFiles();
    if (children == null) {
      return false;
    }
    for (File child : children) {
      String name = child.getName();
      if (child.isFile() && name.startsWith("icudt") && name.endsWith(".dat")) {
        return true;
      }
      if (child.isDirectory() && name.startsWith("icudt") && directoryContainsFile(child)) {
        return true;
      }
    }
    return false;
  }

  private static boolean directoryContainsFile(File root) {
    try (var stream = Files.walk(root.toPath())) {
      return stream.anyMatch(Files::isRegularFile);
    } catch (IOException error) {
      throw new GradleException("inspect ICU data directory " + root + ": " + error.getMessage(), error);
    }
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

  private static void updateRuntimeFeatures(File manifestFile, List<String> features) {
    Properties properties = manifestFile.isFile() ? readProperties(manifestFile) : new Properties();
    TreeSet<String> selected = new TreeSet<>(splitCsv(properties.getProperty("runtimeFeatures")));
    selected.addAll(features);
    properties.setProperty("schema", "oliphaunt-runtime-resources-v1");
    properties.setProperty("runtimeFeatures", String.join(",", selected));
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
    List<String> dependencyArchives =
        sorted(
            artifacts.stream()
                .filter(artifact -> artifact.nativeModuleStem != null)
                .flatMap(artifact -> artifact.dependencyArchives.stream())
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
    lines.add("dependencyArchives=" + String.join(",", dependencyArchives));
    for (ExtensionRuntimeArtifact artifact : artifacts.stream().filter(value -> value.nativeModuleStem != null).toList()) {
      String stem = artifact.nativeModuleStem;
      List<String> targets = sorted(artifact.archiveTargets);
      lines.add("module." + stem + ".extension=" + artifact.sqlName);
      lines.add("module." + stem + ".symbolPrefix=" + staticRegistrySymbolPrefix(stem));
      lines.add("module." + stem + ".sqlSymbols=");
      lines.add("module." + stem + ".archiveTargets=" + String.join(",", targets));
      lines.add("module." + stem + ".dependencyArchives=" + String.join(",", sorted(artifact.dependencyArchives)));
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

  private void copyMobileStaticTree(File source, File target) {
    if (!source.isDirectory()) {
      return;
    }
    copyTree(source.toPath(), target.toPath());
  }

  private static List<String> collectExtensionSqlSymbols(File runtimeFiles, String sqlName) {
    List<File> sqlFiles = extensionSqlFiles(runtimeFiles, sqlName);
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

  private static List<File> extensionSqlFiles(File runtimeFiles, String sqlName) {
    File extensionDir = new File(runtimeFiles, "share/postgresql/extension");
    File[] sqlFiles =
        extensionDir.listFiles(
            file -> file.isFile() && file.getName().startsWith(sqlName + "--") && file.getName().endsWith(".sql"));
    if (sqlFiles == null || sqlFiles.length == 0) {
      throw new GradleException("selected extension " + sqlName + " has no packaged SQL files in " + extensionDir);
    }
    Arrays.sort(sqlFiles, java.util.Comparator.comparing(File::getName));
    return Arrays.asList(sqlFiles);
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
            "runtimeFeatures",
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

  private static MobileStaticArchive parseMobileStaticArchive(String value) {
    String[] parts = value.split(":", 2);
    if (parts.length != 2 || parts[0].isBlank() || parts[1].isBlank()) {
      throw new GradleException("invalid mobileStaticArchives entry: " + value);
    }
    return new MobileStaticArchive(parts[0].trim(), parts[1].trim());
  }

  private static MobileStaticDependencyArchive parseMobileStaticDependencyArchive(String value) {
    String[] parts = value.split(":", 3);
    if (parts.length != 3 || parts[0].isBlank() || parts[1].isBlank() || parts[2].isBlank()) {
      throw new GradleException("invalid mobileStaticDependencyArchives entry: " + value);
    }
    return new MobileStaticDependencyArchive(parts[0].trim(), parts[1].trim(), parts[2].trim());
  }

  private record ExtensionArchive(String assetName, File archive, File root, Properties manifest) {}

  private record ExtensionRuntimeArtifact(
      String sqlName,
      String nativeModuleStem,
      String sharedPreload,
      List<String> archiveTargets,
      List<String> dependencyArchives) {}

  private record StaticRegistryModule(String moduleStem, String symbolPrefix, List<String> sqlSymbols) {}

  private record MobileStaticArchive(String target, String relativePath) {}

  private record MobileStaticDependencyArchive(String target, String name, String relativePath) {}
}
