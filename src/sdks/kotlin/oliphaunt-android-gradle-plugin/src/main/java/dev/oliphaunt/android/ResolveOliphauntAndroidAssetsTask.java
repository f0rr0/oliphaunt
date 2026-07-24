package dev.oliphaunt.android;

import java.io.File;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.BasicFileAttributes;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
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
import org.gradle.api.provider.MapProperty;
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
  private static final int MAX_EXTENSION_ARTIFACT_MANIFEST_BYTES = 64 * 1024;
  private static final int MAX_EXTENSION_BUNDLE_MANIFEST_BYTES = 1024 * 1024;
  private static final String PORTABLE_ID_PATTERN = "[A-Za-z0-9._-]{1,128}";
  private static final String C_IDENTIFIER_PATTERN = "[A-Za-z_][A-Za-z0-9_]*";
  private static final Set<String> EXTENSION_ARTIFACT_PROPERTY_KEYS =
      Set.of(
          "packageLayout",
          "pgMajor",
          "sqlName",
          "createsExtension",
          "nativeModuleStem",
          "nativeModuleFile",
          "nativeTarget",
          "nativeRuntimeProduct",
          "nativeRuntimeVersion",
          "dependencies",
          "dataFiles",
          "extensionSqlFileNames",
          "extensionSqlFilePrefixes",
          "sharedPreloadLibraries",
          "mobilePrebuilt",
          "mobileStaticArchives",
          "mobileStaticDependencyArchives",
          "staticSymbolPrefix",
          "staticSymbolAliases",
          "licenseFiles",
          "licenseProfile",
          "files");
  private static final List<String> TARGET_INVARIANT_EXTENSION_PROPERTY_KEYS =
      List.of(
          "packageLayout",
          "pgMajor",
          "sqlName",
          "createsExtension",
          "nativeModuleStem",
          "nativeModuleFile",
          "nativeRuntimeProduct",
          "nativeRuntimeVersion",
          "dependencies",
          "dataFiles",
          "extensionSqlFileNames",
          "extensionSqlFilePrefixes",
          "sharedPreloadLibraries",
          "mobilePrebuilt",
          "staticSymbolPrefix",
          "staticSymbolAliases",
          "licenseFiles",
          "licenseProfile",
          "files");
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
  public abstract MapProperty<String, String> getExtensionOwnerVersions();

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
    List<ExtensionRuntimeArtifact> selectedRuntimeArtifacts =
        mergeExtensionRuntimeArtifacts(selectedExtensionFiles, selectedRows);
    unpackAndroidJniLibs(androidRuntimeArtifacts, abis);
    unpackAndroidExtensionArchives(selectedExtensionFiles);
    File resourceRoot = runtimeResourcesRoot(getRuntimeResourcesDir().get().getAsFile());
    refreshRuntimeCacheKey(resourceRoot);
    writeRuntimeResourceSizeReport(resourceRoot, selectedRuntimeArtifacts);
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
    if (new LinkedHashSet<>(abis).size() != abis.size()) {
      throw new GradleException("selected Oliphaunt Android ABIs must be unique");
    }
    return List.copyOf(abis);
  }

  static void validateReleaseVersion(String releaseVersion) {
    if (releaseVersion == null
        || !releaseVersion.matches("(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)")) {
      throw new GradleException(
          "liboliphaunt release version must be canonical stable SemVer X.Y.Z: "
              + releaseVersion);
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
    if (new LinkedHashSet<>(getSelectedExtensions().get()).size()
        != getSelectedExtensions().get().size()) {
      throw new GradleException("selected Oliphaunt Android extensions must be unique");
    }
    Map<String, Map<String, ExtensionArchiveSource>> archives = extensionArchives(artifacts);
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
      Map<String, Map<String, ExtensionArchiveSource>> archives,
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
    String product = OliphauntExtensionCatalog.require(sqlName).releaseProduct();
    LinkedHashSet<String> dependencies = new LinkedHashSet<>();
    LinkedHashSet<String> archiveTargets = new LinkedHashSet<>();
    LinkedHashSet<String> dependencyArchives = new LinkedHashSet<>();
    LinkedHashSet<String> runtimeAssets = new LinkedHashSet<>();
    String nativeModuleStem = "";
    String sharedPreload = "";
    String createsExtension = "";
    String staticSymbolPrefix = "";
    String staticSymbolAliases = "";
    Map<String, String> invariantProperties = null;
    Map<String, String> invariantRuntimeFiles = null;
    Map<String, String> invariantLegalFiles = null;
    String invariantTarget = null;
    boolean firstTarget = true;
    for (String abi : abis) {
      String target = androidTarget(abi);
      ExtensionArchive archive = requireExtensionArchive(archives, product, sqlName, target);
      validateExtensionArchive(product, sqlName, target, archive, getVersion().get());
      Map<String, String> currentInvariantProperties =
          targetInvariantExtensionProperties(archive.manifest());
      Map<String, String> currentInvariantRuntimeFiles =
          targetInvariantRuntimeFiles(archive);
      Map<String, String> currentInvariantLegalFiles =
          targetInvariantLegalFiles(sqlName, target, archive);
      if (invariantProperties == null) {
        invariantProperties = currentInvariantProperties;
        invariantRuntimeFiles = currentInvariantRuntimeFiles;
        invariantLegalFiles = currentInvariantLegalFiles;
        invariantTarget = target;
      } else {
        if (!invariantProperties.equals(currentInvariantProperties)) {
          throw new GradleException(
              product
                  + " declares inconsistent target-independent manifest metadata for "
                  + sqlName
                  + " across "
                  + invariantTarget
                  + " and "
                  + target);
        }
        if (!invariantRuntimeFiles.equals(currentInvariantRuntimeFiles)) {
          throw new GradleException(
              product
                  + " declares inconsistent target-independent runtime files for "
                  + sqlName
                  + " across "
                  + invariantTarget
                  + " and "
                  + target);
        }
        if (!invariantLegalFiles.equals(currentInvariantLegalFiles)) {
          throw new GradleException(
              product
                  + " declares inconsistent exact legal files for "
                  + sqlName
                  + " across "
                  + invariantTarget
                  + " and "
                  + target);
        }
      }
      dependencies.addAll(splitCsv(archive.manifest().getProperty("dependencies")));
      String archiveNativeModuleStem = archive.manifest().getProperty("nativeModuleStem", "").trim();
      if (firstTarget) {
        nativeModuleStem = archiveNativeModuleStem;
      } else if (!nativeModuleStem.equals(archiveNativeModuleStem)) {
        throw new GradleException(product + " declares inconsistent nativeModuleStem values across Android targets");
      }
      String archiveSharedPreload = archive.manifest().getProperty("sharedPreloadLibraries", "").trim();
      String archiveCreatesExtension = archive.manifest().getProperty("createsExtension", "");
      String archiveStaticSymbolPrefix = archive.manifest().getProperty("staticSymbolPrefix", "");
      String archiveStaticSymbolAliases = archive.manifest().getProperty("staticSymbolAliases", "");
      if (firstTarget) {
        sharedPreload = archiveSharedPreload;
        createsExtension = archiveCreatesExtension;
        staticSymbolPrefix = archiveStaticSymbolPrefix;
        staticSymbolAliases = archiveStaticSymbolAliases;
        firstTarget = false;
      } else if (!sharedPreload.equals(archiveSharedPreload)) {
        throw new GradleException(product + " declares inconsistent sharedPreloadLibraries values across Android targets");
      } else if (!createsExtension.equals(archiveCreatesExtension)) {
        throw new GradleException(
            product + " declares inconsistent createsExtension values across Android targets");
      } else if (!staticSymbolPrefix.equals(archiveStaticSymbolPrefix)) {
        throw new GradleException(
            product + " declares inconsistent staticSymbolPrefix values across Android targets");
      } else if (!staticSymbolAliases.equals(archiveStaticSymbolAliases)) {
        throw new GradleException(
            product + " declares inconsistent staticSymbolAliases values across Android targets");
      }
      runtimeAssets.add(archive.assetName());
      selectedFiles.putIfAbsent(archive.assetName(), archive.archive());
      if (!archiveNativeModuleStem.isEmpty()) {
        requireMobileStaticArchive(product, sqlName, target, archive, archiveNativeModuleStem);
        dependencyArchives.addAll(requireMobileStaticDependencyArchives(product, target, archive));
        archiveTargets.add(target);
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
    row.put("creates_extension", createsExtension);
    row.put("static_symbol_prefix", emptyToDash(staticSymbolPrefix));
    row.put("static_symbol_aliases", emptyToDash(staticSymbolAliases));
    row.put("runtime_files", String.join(",", invariantRuntimeFiles.keySet()));
    row.put("dependencies", dependencies.isEmpty() ? "-" : String.join(",", sorted(new ArrayList<>(dependencies))));
    row.put("archive_targets", archiveTargets.isEmpty() ? "-" : String.join(",", archiveTargets));
    row.put("dependency_archives", dependencyArchives.isEmpty() ? "-" : String.join(",", sorted(new ArrayList<>(dependencyArchives))));
    rows.put(sqlName, row);
    visiting.remove(sqlName);
  }

  private static String androidTarget(String abi) {
    return switch (abi) {
      case "arm64-v8a" -> "android-arm64-v8a";
      case "x86_64" -> "android-x86_64";
      default -> throw new GradleException("unsupported liboliphaunt Android ABI " + abi);
    };
  }

  private Map<String, Map<String, ExtensionArchiveSource>> extensionArchives(List<File> artifacts) {
    Map<String, Map<String, ExtensionArchiveSource>> archives = new LinkedHashMap<>();
    for (File artifact : artifacts) {
      if (!artifact.getName().endsWith(".tar.gz") && !artifact.getName().endsWith(".tgz")) {
        continue;
      }
      ExtractedTarGz extracted =
          extractTarGzDetailed(
              artifact,
              "carrier-",
              PublicTarGzArchivePreflight.extensionArtifactLimits());
      File extractRoot = extracted.root();
      File bundleRoot = bundleRoot(extractRoot);
      if (bundleRoot != null) {
        for (ExtensionArchiveSource source :
            bundleSources(
                artifact,
                bundleRoot,
                extracted.inspection(),
                archivePrefix(extractRoot, bundleRoot))) {
          addExtensionArchiveSource(archives, source);
        }
      } else {
        File root = artifactRoot(extractRoot, artifact);
        Properties manifest =
            readExtensionArtifactProperties(new File(root, "manifest.properties"));
        if (!"oliphaunt-extension-artifact-v1".equals(manifest.getProperty("packageLayout"))) {
          throw new GradleException(
              "Maven-resolved Oliphaunt extension artifact "
                  + artifact.getName()
                  + " has unsupported packageLayout");
        }
        validateExtensionArtifactInventory(
            root,
            manifest,
            artifact.getName(),
            extracted.inspection(),
            archivePrefix(extractRoot, root));
        String sqlName = manifest.getProperty("sqlName", "").trim();
        String target = manifest.getProperty("nativeTarget", "").trim();
        if (sqlName.isEmpty() || target.isEmpty()) {
          throw new GradleException(
              "Maven-resolved Oliphaunt extension artifact "
                  + artifact.getName()
                  + " is missing sqlName or nativeTarget");
        }
        String product = OliphauntExtensionCatalog.require(sqlName).releaseProduct();
        addExtensionArchiveSource(
            archives,
            new ExtensionArchiveSource(
                artifact.getName(),
                artifact,
                root,
                manifest,
                product,
                null,
                null,
                sqlName,
                target));
      }
    }
    return archives;
  }

  private void addExtensionArchiveSource(
      Map<String, Map<String, ExtensionArchiveSource>> archives, ExtensionArchiveSource source) {
    Map<String, ExtensionArchiveSource> targetArchives =
        archives.computeIfAbsent(source.sqlName(), ignored -> new LinkedHashMap<>());
    ExtensionArchiveSource previous = targetArchives.put(source.target(), source);
    if (previous != null) {
      throw new GradleException(
          "multiple Maven-resolved artifacts declare extension "
              + source.sqlName()
              + " for target "
              + source.target());
    }
  }

  private ExtensionArchive requireExtensionArchive(
      Map<String, Map<String, ExtensionArchiveSource>> archives,
      String product,
      String sqlName,
      String target) {
    Map<String, ExtensionArchiveSource> targetArchives = archives.get(sqlName);
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
    ExtensionArchiveSource source = targetArchives.get(target);
    if (!product.equals(source.product())) {
      throw new GradleException(
          "selected extension "
              + sqlName
              + " resolved release owner "
              + source.product()
              + ", expected "
              + product);
    }
    return materializeExtensionArchive(source);
  }

  private List<ExtensionArchiveSource> bundleSources(
      File carrier,
      File root,
      PublicTarGzArchivePreflight.Inspection inspection,
      String archivePrefix) {
    return bundleSources(
        carrier,
        root,
        getExtensionOwnerVersions().get(),
        getVersion().get(),
        inspection,
        archivePrefix);
  }

  private static List<ExtensionArchiveSource> bundleSources(
      File carrier,
      File root,
      Map<String, String> extensionOwnerVersions,
      String selectedRuntimeVersion,
      PublicTarGzArchivePreflight.Inspection inspection,
      String archivePrefix) {
    File manifestFile = new File(root, "bundle-manifest.json");
    Map<?, ?> manifest =
        StrictJsonObjectParser.readObject(
            manifestFile.toPath(),
            MAX_EXTENSION_BUNDLE_MANIFEST_BYTES,
            "Oliphaunt extension bundle manifest");
    requireJsonString(manifest, "schema", manifestFile, "oliphaunt-extension-bundle-v1");
    requireExactJsonFields(
        manifest,
        Set.of(
            "schema",
            "product",
            "version",
            "family",
            "target",
            "compatibility",
            "licenseFiles",
            "licenseProfile",
            "members"),
        manifestFile,
        "top-level bundle manifest");
    String product = requireJsonString(manifest, "product", manifestFile, null);
    String version = requireJsonString(manifest, "version", manifestFile, null);
    validateReleaseVersion(version);
    requireJsonString(manifest, "family", manifestFile, "native");
    String target = requireJsonString(manifest, "target", manifestFile, null);
    if (!Set.of("android-arm64-v8a", "android-x86_64").contains(target)) {
      throw new GradleException(
          "Maven-resolved Oliphaunt extension bundle "
              + carrier.getName()
              + " must target a supported Android ABI (android-arm64-v8a or android-x86_64), got "
              + target);
    }
    String expectedVersion = extensionOwnerVersions.get(product);
    if (expectedVersion == null) {
      throw new GradleException(
          "Maven-resolved Oliphaunt extension bundle "
              + carrier.getName()
              + " has unselected release owner "
              + product);
    }
    if (!expectedVersion.equals(version)) {
      throw new GradleException(
          "Maven-resolved Oliphaunt extension bundle "
              + carrier.getName()
              + " version "
              + version
              + " does not match selected release-owner version "
              + expectedVersion);
    }
    OliphauntExtensionLegalCatalog.Contract legalContract =
        OliphauntExtensionLegalCatalog.requireAggregate(product, target);
    requireJsonString(
        manifest, "licenseProfile", manifestFile, legalContract.profile());
    List<String> declaredLicenseFiles =
        requireJsonStringList(manifest, "licenseFiles", manifestFile);
    if (!declaredLicenseFiles.equals(legalContract.licenseFiles())) {
      throw new GradleException(
          "Oliphaunt extension bundle manifest "
              + manifestFile
              + " licenseFiles do not match the exact legal contract: expected="
              + legalContract.licenseFiles()
              + ", actual="
              + declaredLicenseFiles);
    }
    validateBundleCompatibility(manifest, manifestFile, selectedRuntimeVersion);
    Object rawMembers = manifest.get("members");
    if (!(rawMembers instanceof List<?> members) || members.isEmpty()) {
      throw new GradleException(
          "Oliphaunt extension bundle manifest " + manifestFile + " must contain members");
    }

    List<ExtensionArchiveSource> result = new ArrayList<>();
    LinkedHashSet<String> canonicalMembers = new LinkedHashSet<>();
    LinkedHashSet<String> memberPaths = new LinkedHashSet<>();
    String previousSortKey = null;
    for (int index = 0; index < members.size(); index++) {
      Object value = members.get(index);
      if (!(value instanceof Map<?, ?> member)) {
        throw new GradleException(
            "Oliphaunt extension bundle manifest "
                + manifestFile
                + " members["
                + index
                + "] must be an object");
      }
      String sqlName = requireJsonString(member, "sqlName", manifestFile, null);
      String kind = requireJsonString(member, "kind", manifestFile, "runtime");
      requireRuntimeBundleIdentity(member, sqlName, manifestFile);
      requireExactJsonFields(
          member,
          Set.of("sqlName", "kind", "identity", "path", "sha256", "bytes"),
          manifestFile,
          "runtime member " + sqlName);
      String relativePath = requireJsonString(member, "path", manifestFile, null);
      String expectedSha256 = requireJsonString(member, "sha256", manifestFile, null);
      long expectedBytes = requireJsonPositiveLong(member, "bytes", manifestFile);
      if (!sqlName.matches("[A-Za-z0-9._-]{1,128}")) {
        throw new GradleException(
            "Oliphaunt extension bundle manifest " + manifestFile + " has invalid SQL name " + sqlName);
      }
      OliphauntExtensionCatalog.Entry catalogEntry = OliphauntExtensionCatalog.require(sqlName);
      if (!product.equals(catalogEntry.releaseProduct())) {
        throw new GradleException(
            "Oliphaunt extension bundle "
                + product
                + " contains member "
                + sqlName
                + " owned by "
                + catalogEntry.releaseProduct());
      }
      if (!expectedSha256.matches("[0-9a-f]{64}")) {
        throw new GradleException(
            "Oliphaunt extension bundle manifest "
                + manifestFile
                + " has invalid sha256 for "
                + sqlName);
      }
      Path checkedPath = checkedBundleMemberPath(root.toPath(), relativePath, sqlName, manifestFile);
      File memberArchive = checkedPath.toFile();
      if (!memberArchive.isFile()
          || (!memberArchive.getName().endsWith(".tar.gz")
              && !memberArchive.getName().endsWith(".tgz"))) {
        throw new GradleException(
            "Oliphaunt extension bundle member "
                + sqlName
                + " is not a packaged .tar.gz archive: "
                + relativePath);
      }
      String canonicalMember = sqlName + "\u0000" + kind + "\u0000" + relativePath;
      if (!canonicalMembers.add(canonicalMember) || !memberPaths.add(relativePath)) {
        throw new GradleException(
            "Oliphaunt extension bundle manifest "
                + manifestFile
                + " repeats a canonical member or archive path");
      }
      String sortKey = canonicalMember;
      if (previousSortKey != null && previousSortKey.compareTo(sortKey) >= 0) {
        throw new GradleException(
            "Oliphaunt extension bundle manifest " + manifestFile + " members are not sorted");
      }
      previousSortKey = sortKey;
      result.add(
          new ExtensionArchiveSource(
              carrier.getName() + "::" + target + "::" + sqlName + "::" + kind,
              memberArchive,
              null,
              null,
              product,
              expectedSha256,
              expectedBytes,
              sqlName,
              target));
    }
    List<String> actualMembers =
        result.stream().map(ExtensionArchiveSource::sqlName).toList();
    List<String> expectedMembers = OliphauntExtensionCatalog.releaseProductMembers(product);
    if (!actualMembers.equals(expectedMembers)) {
      throw new GradleException(
          "Oliphaunt extension bundle manifest "
              + manifestFile
              + " members must exactly match release product "
              + product
              + ": expected="
              + expectedMembers
              + ", actual="
              + actualMembers);
    }
    requireExactBundleFiles(root, memberPaths, legalContract, manifestFile);
    validateExactLegalMemberFiles(root, legalContract, manifestFile.toString());
    validateExactLegalArchiveMembers(
        legalContract, inspection, archivePrefix, manifestFile.toString());
    return result;
  }

  static int validateBundleSourcesForContractTest(
      File carrier,
      File root,
      Map<String, String> extensionOwnerVersions,
      String selectedRuntimeVersion) {
    return bundleSources(
            carrier,
            root,
            extensionOwnerVersions,
            selectedRuntimeVersion,
            null,
            "")
        .size();
  }

  private ExtensionArchive materializeExtensionArchive(ExtensionArchiveSource source) {
    if (source.root() != null && source.manifest() != null) {
      return new ExtensionArchive(
          source.assetName(), source.archive(), source.root(), source.manifest());
    }
    if (source.expectedBytes() == null || source.expectedSha256() == null) {
      throw new GradleException(
          "Oliphaunt extension archive source " + source.assetName() + " is incomplete");
    }
    long actualBytes = source.archive().length();
    if (actualBytes != source.expectedBytes()) {
      throw new GradleException(
          "Oliphaunt extension bundle member "
              + source.assetName()
              + " byte length mismatch: expected "
              + source.expectedBytes()
              + ", got "
              + actualBytes);
    }
    String actualSha256 = sha256(source.archive());
    if (!actualSha256.equals(source.expectedSha256())) {
      throw new GradleException(
          "Oliphaunt extension bundle member "
              + source.assetName()
              + " checksum mismatch: expected "
              + source.expectedSha256()
              + ", got "
              + actualSha256);
    }
    File root = extractExtensionArchive(source.archive());
    Properties manifest =
        readExtensionArtifactProperties(new File(root, "manifest.properties"));
    return new ExtensionArchive(source.assetName(), source.archive(), root, manifest);
  }

  private static File bundleRoot(File extractRoot) {
    if (new File(extractRoot, "bundle-manifest.json").isFile()) {
      return extractRoot;
    }
    File[] children =
        extractRoot.listFiles(
            file -> file.isDirectory() && new File(file, "bundle-manifest.json").isFile());
    if (children == null || children.length != 1) {
      return null;
    }
    requireOnlyCarrierWrapper(
        extractRoot, children[0], "Oliphaunt extension bundle carrier");
    return children[0];
  }

  static File bundleRootForContractTest(File extractRoot) {
    return bundleRoot(extractRoot);
  }

  private static void requireOnlyCarrierWrapper(File extractRoot, File wrapper, String label) {
    File[] children = extractRoot.listFiles();
    if (children == null) {
      throw new GradleException("inspect extracted " + label + " " + extractRoot);
    }
    if (children.length != 1 || !children[0].equals(wrapper)) {
      throw new GradleException(
          label
              + " must contain exactly one top-level wrapper directory and no undeclared siblings: "
              + extractRoot);
    }
  }

  private static String requireJsonString(
      Map<?, ?> value, String key, File source, String expected) {
    Object raw = value.get(key);
    if (!(raw instanceof String result) || result.isBlank()) {
      throw new GradleException(source + " must declare non-empty " + key);
    }
    if (expected != null && !expected.equals(result)) {
      throw new GradleException(
          source + " must declare " + key + "=" + expected + ", got " + result);
    }
    return result;
  }

  private static long requireJsonPositiveLong(Map<?, ?> value, String key, File source) {
    Object raw = value.get(key);
    if (!(raw instanceof Number number)) {
      throw new GradleException(source + " must declare numeric " + key);
    }
    long result = number.longValue();
    if (result <= 0 || number.doubleValue() != (double) result) {
      throw new GradleException(source + " must declare positive integer " + key);
    }
    return result;
  }

  private static List<String> requireJsonStringList(
      Map<?, ?> value, String key, File source) {
    Object raw = value.get(key);
    if (!(raw instanceof List<?> values)) {
      throw new GradleException(source + " must declare array " + key);
    }
    List<String> result = new ArrayList<>();
    String previous = null;
    for (int index = 0; index < values.size(); index++) {
      Object item = values.get(index);
      if (!(item instanceof String text) || text.isEmpty()) {
        throw new GradleException(
            source + " " + key + "[" + index + "] must be a non-empty string");
      }
      if (previous != null && previous.compareTo(text) >= 0) {
        throw new GradleException(source + " " + key + " must be sorted and unique");
      }
      previous = text;
      result.add(text);
    }
    return List.copyOf(result);
  }

  private static void requireRuntimeBundleIdentity(
      Map<?, ?> member, String sqlName, File source) {
    if (!member.containsKey("identity") || member.get("identity") != null) {
      throw new GradleException(
          "Oliphaunt extension bundle manifest "
              + source
              + " runtime member "
              + sqlName
              + " must declare identity=null");
    }
  }

  private static void requireExactJsonFields(
      Map<?, ?> value, Set<String> expectedFields, File source, String label) {
    TreeSet<String> actualFields = new TreeSet<>();
    for (Object key : value.keySet()) {
      if (!(key instanceof String stringKey)) {
        throw new GradleException(source + " " + label + " has a non-string field");
      }
      actualFields.add(stringKey);
    }
    TreeSet<String> expected = new TreeSet<>(expectedFields);
    if (!actualFields.equals(expected)) {
      throw new GradleException(
          source
              + " "
              + label
              + " fields must be exactly "
              + expected
              + ", got "
              + actualFields);
    }
  }

  static void validateBundleCompatibility(
      Map<?, ?> manifest, File source, String expectedRuntimeVersion) {
    Object raw = manifest.get("compatibility");
    if (!(raw instanceof Map<?, ?> compatibility)) {
      throw new GradleException(source + " must declare compatibility metadata");
    }
    Set<String> expectedKeys =
        Set.of(
            "extensionRuntimeContract",
            "nativeRuntimeProduct",
            "nativeRuntimeVersion",
            "postgresMajor",
            "wasixRuntimeProduct",
            "wasixRuntimeVersion");
    requireExactJsonFields(compatibility, expectedKeys, source, "compatibility metadata");
    requireJsonString(compatibility, "postgresMajor", source, "18");
    requireJsonString(
        compatibility,
        "extensionRuntimeContract",
        source,
        "src/shared/extension-runtime-contract/contract.toml");
    requireJsonString(compatibility, "nativeRuntimeProduct", source, "liboliphaunt-native");
    String runtimeVersion =
        requireJsonString(compatibility, "nativeRuntimeVersion", source, null);
    validateReleaseVersion(runtimeVersion);
    if (!expectedRuntimeVersion.equals(runtimeVersion)) {
      throw new GradleException(
          source
              + " pins liboliphaunt-native "
              + runtimeVersion
              + ", but the selected Android runtime is "
              + expectedRuntimeVersion);
    }
    requireJsonString(compatibility, "wasixRuntimeProduct", source, "liboliphaunt-wasix");
    validateReleaseVersion(
        requireJsonString(compatibility, "wasixRuntimeVersion", source, null));
  }

  private static Path checkedBundleMemberPath(
      Path root, String rawPath, String sqlName, File manifestFile) {
    String normalized = rawPath.replace('\\', '/');
    Path relative = Path.of(normalized);
    if (normalized.startsWith("/")
        || normalized.indexOf('\0') >= 0
        || relative.isAbsolute()
        || relative.normalize().startsWith("..")
        || !normalized.startsWith("extensions/" + sqlName + "/")) {
      throw new GradleException(
          "Oliphaunt extension bundle manifest "
              + manifestFile
              + " has unsafe member path "
              + rawPath);
    }
    Path normalizedRoot = root.toAbsolutePath().normalize();
    Path resolved = normalizedRoot.resolve(relative).normalize();
    if (!resolved.startsWith(normalizedRoot)) {
      throw new GradleException(
          "Oliphaunt extension bundle manifest "
              + manifestFile
              + " has escaping member path "
              + rawPath);
    }
    return resolved;
  }

  private static void requireExactBundleFiles(
      File root,
      Set<String> memberPaths,
      OliphauntExtensionLegalCatalog.Contract legalContract,
      File manifestFile) {
    TreeSet<String> expected = new TreeSet<>(memberPaths);
    expected.add("bundle-manifest.json");
    for (OliphauntExtensionLegalCatalog.LegalMember member : legalContract.members()) {
      expected.add(member.path());
    }
    TreeSet<String> actual = new TreeSet<>();
    TreeSet<String> actualDirectories = new TreeSet<>();
    Path rootPath = root.toPath().toAbsolutePath().normalize();
    try (var stream = Files.walk(root.toPath())) {
      for (Path path : stream.sorted().toList()) {
        BasicFileAttributes attributes =
            Files.readAttributes(path, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
        if (attributes.isSymbolicLink()
            || (!attributes.isDirectory() && !attributes.isRegularFile())) {
          throw new GradleException(
              "Oliphaunt extension bundles do not support symlinks or special files: " + path);
        }
        String relative =
            rootPath.relativize(path.toAbsolutePath().normalize()).toString().replace(File.separatorChar, '/');
        if (attributes.isRegularFile()) {
          actual.add(relative);
        } else if (!relative.isEmpty()) {
          actualDirectories.add(relative);
        }
      }
    } catch (IOException error) {
      throw new GradleException("inspect Oliphaunt extension bundle " + root, error);
    }
    if (!actual.equals(expected)) {
      TreeSet<String> missing = new TreeSet<>(expected);
      missing.removeAll(actual);
      TreeSet<String> unexpected = new TreeSet<>(actual);
      unexpected.removeAll(expected);
      throw new GradleException(
          "Oliphaunt extension bundle "
              + manifestFile
              + " files do not match its manifest; missing="
              + missing
              + ", unexpected="
              + unexpected);
    }
    TreeSet<String> expectedDirectories = parentDirectories(expected);
    if (!actualDirectories.equals(expectedDirectories)) {
      TreeSet<String> unexpectedDirectories = new TreeSet<>(actualDirectories);
      unexpectedDirectories.removeAll(expectedDirectories);
      TreeSet<String> missingDirectories = new TreeSet<>(expectedDirectories);
      missingDirectories.removeAll(actualDirectories);
      throw new GradleException(
          "Oliphaunt extension bundle "
              + manifestFile
              + " directory inventory is not exact; missing="
              + missingDirectories
              + ", unexpected="
              + unexpectedDirectories);
    }
  }

  private static void validateExactLegalMemberFiles(
      File root,
      OliphauntExtensionLegalCatalog.Contract legalContract,
      String source) {
    Path normalizedRoot = root.toPath().toAbsolutePath().normalize();
    for (OliphauntExtensionLegalCatalog.LegalMember member : legalContract.members()) {
      Path file = normalizedRoot.resolve(member.path()).normalize();
      if (!file.startsWith(normalizedRoot)) {
        throw new GradleException(
            "Oliphaunt extension legal member escapes its artifact root: " + member.path());
      }
      final BasicFileAttributes attributes;
      try {
        attributes =
            Files.readAttributes(file, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
      } catch (IOException error) {
        throw new GradleException(
            source + " is missing exact legal member " + member.path(), error);
      }
      if (!attributes.isRegularFile()
          || attributes.isSymbolicLink()
          || attributes.size() != member.bytes()) {
        throw new GradleException(
            source
                + " legal member "
                + member.path()
                + " must be a regular non-symlink file of exactly "
                + member.bytes()
                + " bytes, got "
                + attributes.size());
      }
      String actualSha256 = sha256(file.toFile());
      if (!actualSha256.equals(member.sha256())) {
        throw new GradleException(
            source
                + " legal member "
                + member.path()
                + " does not match its canonical SHA-256: expected "
                + member.sha256()
                + ", got "
                + actualSha256);
      }
    }
  }

  private static void validateExactLegalArchiveMembers(
      OliphauntExtensionLegalCatalog.Contract legalContract,
      PublicTarGzArchivePreflight.Inspection inspection,
      String archivePrefix,
      String source) {
    if (inspection == null) {
      return;
    }
    String prefix = archivePrefix == null || archivePrefix.isEmpty() ? "" : archivePrefix + "/";
    for (OliphauntExtensionLegalCatalog.LegalMember legalMember : legalContract.members()) {
      String archivePath = prefix + legalMember.path();
      PublicTarGzArchivePreflight.Member member = inspection.members().get(archivePath);
      if (member == null
          || member.directory()
          || member.bytes() != legalMember.bytes()
          || member.mode() != legalMember.mode()) {
        throw new GradleException(
            source
                + " legal member "
                + archivePath
                + " must be one regular ustar mode="
                + String.format(java.util.Locale.ROOT, "%04o", legalMember.mode())
                + " file of exactly "
                + legalMember.bytes()
                + " bytes");
      }
    }
  }

  static void validateLegalArchiveMembersForContractTest(
      String identity,
      String target,
      String scope,
      PublicTarGzArchivePreflight.Inspection inspection,
      String archivePrefix) {
    OliphauntExtensionLegalCatalog.Contract contract =
        scope.equals("leaf")
            ? OliphauntExtensionLegalCatalog.requireLeaf(identity, target)
            : OliphauntExtensionLegalCatalog.requireAggregate(identity, target);
    validateExactLegalArchiveMembers(
        contract, inspection, archivePrefix, "contract-test archive");
  }

  private static TreeSet<String> parentDirectories(Set<String> files) {
    TreeSet<String> result = new TreeSet<>();
    for (String file : files) {
      int separator = file.lastIndexOf('/');
      while (separator > 0) {
        String parent = file.substring(0, separator);
        result.add(parent);
        separator = parent.lastIndexOf('/');
      }
    }
    return result;
  }

  private static String sha256(File file) {
    final MessageDigest digest;
    try {
      digest = MessageDigest.getInstance("SHA-256");
    } catch (NoSuchAlgorithmException error) {
      throw new GradleException("JVM does not provide SHA-256", error);
    }
    try (var input = Files.newInputStream(file.toPath())) {
      byte[] buffer = new byte[128 * 1024];
      int read;
      while ((read = input.read(buffer)) >= 0) {
        if (read > 0) {
          digest.update(buffer, 0, read);
        }
      }
    } catch (IOException error) {
      throw new GradleException("hash Oliphaunt extension bundle member " + file, error);
    }
    StringBuilder result = new StringBuilder(64);
    for (byte value : digest.digest()) {
      result.append(String.format(java.util.Locale.ROOT, "%02x", value & 0xff));
    }
    return result.toString();
  }

  private static Map<String, String> targetInvariantExtensionProperties(
      Properties manifest) {
    Map<String, String> result = new LinkedHashMap<>();
    for (String key : TARGET_INVARIANT_EXTENSION_PROPERTY_KEYS) {
      result.put(key, manifest.getProperty(key, ""));
    }
    return Collections.unmodifiableMap(result);
  }

  private static Map<String, String> targetInvariantRuntimeFiles(
      ExtensionArchive archive) {
    Path filesRoot = archive.root().toPath().resolve("files").toAbsolutePath().normalize();
    String nativeModuleFile = archive.manifest().getProperty("nativeModuleFile", "");
    String targetSpecificModule =
        nativeModuleFile.isEmpty() ? null : "lib/postgresql/" + nativeModuleFile;
    Map<String, String> result = new java.util.TreeMap<>();
    if (!Files.exists(filesRoot, LinkOption.NOFOLLOW_LINKS)) {
      return Collections.unmodifiableMap(result);
    }
    if (!Files.isDirectory(filesRoot, LinkOption.NOFOLLOW_LINKS)) {
      throw new GradleException(
          "extension artifact " + archive.assetName() + " files path is not a directory");
    }
    try (var stream = Files.walk(filesRoot)) {
      for (Path file : stream.sorted().toList()) {
        if (!Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS)) {
          continue;
        }
        String relative =
            filesRoot.relativize(file.toAbsolutePath().normalize()).toString()
                .replace(File.separatorChar, '/');
        if (relative.equals(targetSpecificModule)) {
          continue;
        }
        if (relative.startsWith("share/licenses/")) {
          continue;
        }
        result.put(relative, sha256(file.toFile()));
      }
    } catch (IOException error) {
      throw new GradleException(
          "inspect target-independent runtime files in " + archive.assetName(), error);
    }
    return Collections.unmodifiableMap(result);
  }

  private static Map<String, String> targetInvariantLegalFiles(
      String sqlName, String target, ExtensionArchive archive) {
    OliphauntExtensionLegalCatalog.Contract contract =
        OliphauntExtensionLegalCatalog.requireLeaf(sqlName, target);
    Map<String, String> result = new java.util.TreeMap<>();
    Path root = archive.root().toPath().toAbsolutePath().normalize();
    for (OliphauntExtensionLegalCatalog.LegalMember member : contract.members()) {
      Path file = root.resolve(member.path()).normalize();
      if (!file.startsWith(root) || !Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS)) {
        throw new GradleException(
            "extension artifact "
                + archive.assetName()
                + " is missing exact legal member "
                + member.path());
      }
      result.put(member.path(), sha256(file.toFile()));
    }
    return Collections.unmodifiableMap(result);
  }

  private static void validateExtensionArchive(
      String product,
      String sqlName,
      String target,
      ExtensionArchive archive,
      String expectedRuntimeVersion) {
    validateExtensionManifest(
        product,
        sqlName,
        target,
        archive.manifest(),
        archive.assetName(),
        expectedRuntimeVersion);
  }

  static void validateExtensionManifestForContractTest(
      String product,
      String sqlName,
      String target,
      Properties manifest,
      String expectedRuntimeVersion) {
    validateExtensionManifest(
        product, sqlName, target, manifest, "contract-test.tar.gz", expectedRuntimeVersion);
  }

  private static void validateExtensionManifest(
      String product,
      String sqlName,
      String target,
      Properties manifest,
      String assetName,
      String expectedRuntimeVersion) {
    TreeSet<String> actualKeys = new TreeSet<>(manifest.stringPropertyNames());
    TreeSet<String> expectedKeys = new TreeSet<>(EXTENSION_ARTIFACT_PROPERTY_KEYS);
    if (!actualKeys.equals(expectedKeys)) {
      throw new GradleException(
          product
              + " Android artifact "
              + assetName
              + " property fields must be exactly "
              + expectedKeys
              + ", got "
              + actualKeys);
    }
    if (!"oliphaunt-extension-artifact-v1".equals(manifest.getProperty("packageLayout"))) {
      throw new GradleException(product + " Android artifact " + assetName + " has unsupported packageLayout");
    }
    if (!"18".equals(manifest.getProperty("pgMajor"))) {
      throw new GradleException(product + " Android artifact " + assetName + " must declare pgMajor=18");
    }
    if (!sqlName.equals(manifest.getProperty("sqlName"))) {
      throw new GradleException(
          product
              + " Android artifact "
              + assetName
              + " declares sqlName "
              + manifest.getProperty("sqlName"));
    }
    OliphauntExtensionCatalog.Entry catalogEntry = OliphauntExtensionCatalog.require(sqlName);
    if (!product.equals(catalogEntry.releaseProduct())) {
      throw new GradleException(
          product
              + " Android artifact "
              + assetName
              + " belongs to release product "
              + catalogEntry.releaseProduct());
    }
    String expectedDependencies = String.join(",", catalogEntry.dependencies());
    if (!expectedDependencies.equals(manifest.getProperty("dependencies"))) {
      throw new GradleException(
          product
              + " Android artifact "
              + assetName
              + " must declare dependencies="
              + expectedDependencies
              + ", got "
              + manifest.getProperty("dependencies"));
    }
    if (!target.equals(manifest.getProperty("nativeTarget"))) {
      throw new GradleException(
          product
              + " Android artifact "
              + assetName
              + " declares nativeTarget "
              + manifest.getProperty("nativeTarget"));
    }
    if (!Set.of("yes", "no").contains(manifest.getProperty("createsExtension"))) {
      throw new GradleException(
          product + " Android artifact " + assetName + " must declare createsExtension=yes|no");
    }
    if (!Set.of("yes", "no").contains(manifest.getProperty("mobilePrebuilt"))) {
      throw new GradleException(
          product + " Android artifact " + assetName + " must declare mobilePrebuilt=yes|no");
    }
    if (!"files".equals(manifest.getProperty("files"))) {
      throw new GradleException(product + " Android artifact " + assetName + " must declare files=files");
    }
    if (!"liboliphaunt-native".equals(manifest.getProperty("nativeRuntimeProduct"))) {
      throw new GradleException(
          product
              + " Android artifact "
              + assetName
              + " must declare nativeRuntimeProduct=liboliphaunt-native");
    }
    String runtimeVersion = manifest.getProperty("nativeRuntimeVersion", "").trim();
    validateReleaseVersion(runtimeVersion);
    if (!expectedRuntimeVersion.equals(runtimeVersion)) {
      throw new GradleException(
          product
              + " Android artifact "
              + assetName
              + " pins liboliphaunt-native "
              + runtimeVersion
              + ", but the selected Android runtime is "
              + expectedRuntimeVersion);
    }
    validateExtensionLegalManifest(product, sqlName, target, manifest, assetName);
    validateExtensionManifestSemantics(manifest, assetName, target);
  }

  private static OliphauntExtensionLegalCatalog.Contract validateExtensionLegalManifest(
      String product,
      String sqlName,
      String target,
      Properties manifest,
      String assetName) {
    OliphauntExtensionLegalCatalog.Contract legalContract =
        OliphauntExtensionLegalCatalog.requireLeaf(sqlName, target);
    if (!product.equals(legalContract.product())) {
      throw new GradleException(
          product
              + " Android artifact "
              + assetName
              + " legal contract belongs to "
              + legalContract.product());
    }
    String profile = manifest.getProperty("licenseProfile", "");
    if (!profile.equals(legalContract.profile())) {
      throw new GradleException(
          product
              + " Android artifact "
              + assetName
              + " must declare licenseProfile="
              + legalContract.profile()
              + ", got "
              + profile);
    }
    List<String> licenseFiles = strictManifestCsv(manifest, "licenseFiles", assetName);
    requireSortedManifestList(licenseFiles, assetName, "licenseFiles");
    if (!licenseFiles.equals(legalContract.licenseFiles())) {
      throw new GradleException(
          product
              + " Android artifact "
              + assetName
              + " licenseFiles do not match the exact legal contract: expected="
              + legalContract.licenseFiles()
              + ", actual="
              + licenseFiles);
    }
    for (String licenseFile : licenseFiles) {
      String canonical = canonicalDeclaredPath(licenseFile, assetName, "licenseFiles");
      if (!canonical.startsWith("share/licenses/")) {
        throw new GradleException(
            product
                + " Android artifact "
                + assetName
                + " licenseFiles must live under share/licenses/: "
                + licenseFile);
      }
    }
    return legalContract;
  }

  private static void validateExtensionManifestSemantics(
      Properties manifest, String assetName, String target) {
    String stem = manifest.getProperty("nativeModuleStem");
    String moduleFile = manifest.getProperty("nativeModuleFile");
    String mobilePrebuilt = manifest.getProperty("mobilePrebuilt");
    String symbolPrefix = manifest.getProperty("staticSymbolPrefix");
    List<String> staticArchiveValues =
        strictManifestCsv(manifest, "mobileStaticArchives", assetName);
    List<String> dependencyArchiveValues =
        strictManifestCsv(manifest, "mobileStaticDependencyArchives", assetName);
    List<String> extensionSqlFileNames =
        strictManifestCsv(manifest, "extensionSqlFileNames", assetName);
    List<String> extensionSqlFilePrefixes =
        strictManifestCsv(manifest, "extensionSqlFilePrefixes", assetName);
    List<StaticSymbolAlias> aliases =
        parseStaticSymbolAliases(manifest.getProperty("staticSymbolAliases"), assetName);
    requireSortedManifestList(staticArchiveValues, assetName, "mobileStaticArchives");
    requireSortedMobileStaticDependencyArchives(dependencyArchiveValues, assetName);
    requireSortedManifestList(
        strictManifestCsv(manifest, "dataFiles", assetName), assetName, "dataFiles");
    requireSortedManifestList(
        extensionSqlFileNames, assetName, "extensionSqlFileNames");
    requireSortedManifestList(
        extensionSqlFilePrefixes, assetName, "extensionSqlFilePrefixes");
    requireSortedManifestList(
        strictManifestCsv(manifest, "sharedPreloadLibraries", assetName),
        assetName,
        "sharedPreloadLibraries");
    for (String fileName : extensionSqlFileNames) {
      if (!fileName.matches("[A-Za-z0-9._-]{1,128}\\.sql")) {
        throw new GradleException(
            "Oliphaunt extension artifact "
                + assetName
                + " extensionSqlFileNames must contain portable SQL basenames, got "
                + fileName);
      }
    }
    for (String prefix : extensionSqlFilePrefixes) {
      if (!prefix.matches(PORTABLE_ID_PATTERN) || prefix.indexOf('.') >= 0) {
        throw new GradleException(
            "Oliphaunt extension artifact "
                + assetName
                + " extensionSqlFilePrefixes must contain portable basename prefixes, got "
                + prefix);
      }
    }

    if (stem.isEmpty()) {
      if (!moduleFile.isEmpty()
          || !staticArchiveValues.isEmpty()
          || !dependencyArchiveValues.isEmpty()
          || !symbolPrefix.isEmpty()
          || !aliases.isEmpty()
          || !"no".equals(mobilePrebuilt)) {
        throw new GradleException(
            "Oliphaunt extension artifact "
                + assetName
                + " without nativeModuleStem must have no native module/static metadata and mobilePrebuilt=no");
      }
      return;
    }
    if (!stem.matches(PORTABLE_ID_PATTERN)) {
      throw new GradleException(
          "Oliphaunt extension artifact " + assetName + " has invalid nativeModuleStem " + stem);
    }
    if (!moduleFile.matches(PORTABLE_ID_PATTERN) || !moduleFile.endsWith(".so")) {
      throw new GradleException(
          "Oliphaunt extension artifact "
              + assetName
              + " nativeModuleFile must be one portable Android .so filename, got "
              + moduleFile);
    }
    if (!"yes".equals(mobilePrebuilt) || staticArchiveValues.size() != 1) {
      throw new GradleException(
          "Oliphaunt extension artifact "
              + assetName
              + " with nativeModuleStem must declare mobilePrebuilt=yes and exactly one target static archive");
    }
    MobileStaticArchive staticArchive = parseMobileStaticArchive(staticArchiveValues.get(0));
    String expectedSuffix =
        "/extensions/" + stem + "/liboliphaunt_extension_" + stem + ".a";
    if (!target.equals(staticArchive.target())
        || !staticArchive.relativePath().endsWith(expectedSuffix)) {
      throw new GradleException(
          "Oliphaunt extension artifact "
              + assetName
              + " static archive must bind nativeModuleStem "
              + stem
              + " to target "
              + target);
    }
    if (!symbolPrefix.isEmpty() && !symbolPrefix.matches(C_IDENTIFIER_PATTERN)) {
      throw new GradleException(
          "Oliphaunt extension artifact "
              + assetName
              + " has invalid staticSymbolPrefix "
              + symbolPrefix);
    }
  }

  private static void requireSortedManifestList(
      List<String> values, String assetName, String field) {
    List<String> sorted = new ArrayList<>(values);
    Collections.sort(sorted);
    if (!values.equals(sorted)) {
      throw new GradleException(
          "Oliphaunt extension artifact "
              + assetName
              + " must declare sorted canonical "
              + field);
    }
  }

  private static void requireSortedMobileStaticDependencyArchives(
      List<String> values, String assetName) {
    List<MobileStaticDependencyArchive> parsed =
        values.stream()
            .map(ResolveOliphauntAndroidAssetsTask::parseMobileStaticDependencyArchive)
            .toList();
    List<MobileStaticDependencyArchive> sorted = new ArrayList<>(parsed);
    sorted.sort(
        java.util.Comparator.comparing(MobileStaticDependencyArchive::target)
            .thenComparing(MobileStaticDependencyArchive::name)
            .thenComparing(MobileStaticDependencyArchive::relativePath));
    if (!parsed.equals(sorted)) {
      throw new GradleException(
          "Oliphaunt extension artifact "
              + assetName
              + " must declare sorted canonical mobileStaticDependencyArchives");
    }
    LinkedHashSet<String> identities = new LinkedHashSet<>();
    for (MobileStaticDependencyArchive dependency : parsed) {
      if (!identities.add(dependency.target + "\u0000" + dependency.name)) {
        throw new GradleException(
            "Oliphaunt extension artifact "
                + assetName
                + " repeats mobileStaticDependencyArchives identity "
                + dependency.target
                + ":"
                + dependency.name);
      }
    }
  }

  private static List<StaticSymbolAlias> parseStaticSymbolAliases(
      String raw, String assetName) {
    if (raw == null || raw.isEmpty()) {
      return List.of();
    }
    List<StaticSymbolAlias> result = new ArrayList<>();
    LinkedHashSet<String> sqlSymbols = new LinkedHashSet<>();
    String previous = null;
    for (String value : raw.split(",", -1)) {
      if (!value.equals(value.trim())) {
        throw new GradleException(
            "Oliphaunt extension artifact "
                + assetName
                + " has noncanonical staticSymbolAliases="
                + raw);
      }
      String[] parts = value.split(":", -1);
      if (parts.length != 2
          || !parts[0].matches(C_IDENTIFIER_PATTERN)
          || !parts[1].matches(C_IDENTIFIER_PATTERN)) {
        throw new GradleException(
            "Oliphaunt extension artifact "
                + assetName
                + " has invalid staticSymbolAliases entry "
                + value);
      }
      if (!sqlSymbols.add(parts[0])) {
        throw new GradleException(
            "Oliphaunt extension artifact "
                + assetName
                + " repeats staticSymbolAliases SQL symbol "
                + parts[0]);
      }
      if (previous != null && previous.compareTo(value) >= 0) {
        throw new GradleException(
            "Oliphaunt extension artifact "
                + assetName
                + " staticSymbolAliases must be sorted and unique");
      }
      previous = value;
      result.add(new StaticSymbolAlias(parts[0], parts[1]));
    }
    return List.copyOf(result);
  }

  static void validateExtensionArtifactInventoryForContractTest(
      File root, Properties manifest) {
    validateExtensionArtifactInventory(root, manifest, "contract-test.tar.gz");
  }

  private static void validateExtensionArtifactInventory(
      File root, Properties manifest, String assetName) {
    validateExtensionArtifactInventory(root, manifest, assetName, null, "");
  }

  private static void validateExtensionArtifactInventory(
      File root,
      Properties manifest,
      String assetName,
      PublicTarGzArchivePreflight.Inspection inspection,
      String archivePrefix) {
    String sqlName = manifest.getProperty("sqlName", "");
    if (!sqlName.matches("[A-Za-z0-9._-]{1,128}")) {
      throw new GradleException(
          "Oliphaunt extension artifact " + assetName + " has invalid sqlName " + sqlName);
    }
    String createsExtension = manifest.getProperty("createsExtension", "");
    if (!Set.of("yes", "no").contains(createsExtension)) {
      throw new GradleException(
          "Oliphaunt extension artifact "
              + assetName
              + " must declare createsExtension=yes|no");
    }
    List<String> extensionSqlFileNames =
        strictManifestCsv(manifest, "extensionSqlFileNames", assetName);
    List<String> extensionSqlFilePrefixes =
        strictManifestCsv(manifest, "extensionSqlFilePrefixes", assetName);

    String nativeTarget = manifest.getProperty("nativeTarget", "");
    String product = OliphauntExtensionCatalog.require(sqlName).releaseProduct();
    OliphauntExtensionLegalCatalog.Contract legalContract =
        validateExtensionLegalManifest(
            product, sqlName, nativeTarget, manifest, assetName);

    TreeSet<String> declaredFiles = new TreeSet<>();
    addDeclaredArtifactFile(declaredFiles, "manifest.properties", assetName, "manifest");
    for (OliphauntExtensionLegalCatalog.LegalMember legalMember : legalContract.members()) {
      addDeclaredArtifactFile(
          declaredFiles, legalMember.path(), assetName, "exact legal contract");
    }
    String nativeModuleFile = manifest.getProperty("nativeModuleFile", "");
    if (!nativeModuleFile.isEmpty()) {
      String canonicalNativeModule =
          canonicalDeclaredPath(nativeModuleFile, assetName, "nativeModuleFile");
      if (canonicalNativeModule.indexOf('/') >= 0) {
        throw new GradleException(
            "Oliphaunt extension artifact "
                + assetName
                + " nativeModuleFile must be one filename, got "
                + nativeModuleFile);
      }
      addDeclaredArtifactFile(
          declaredFiles,
          "files/lib/postgresql/" + canonicalNativeModule,
          assetName,
          "nativeModuleFile");
    }
    for (String dataFile : strictManifestCsv(manifest, "dataFiles", assetName)) {
      String canonicalDataFile = canonicalDeclaredPath(dataFile, assetName, "dataFiles");
      if (canonicalDataFile.startsWith("extension/")) {
        throw new GradleException(
            "Oliphaunt extension artifact "
                + assetName
                + " dataFiles must not alias extension SQL/control inventory: "
                + dataFile);
      }
      addDeclaredArtifactFile(
          declaredFiles,
          "files/share/postgresql/" + canonicalDataFile,
          assetName,
          "dataFiles");
    }
    for (String value : strictManifestCsv(manifest, "mobileStaticArchives", assetName)) {
      MobileStaticArchive archive = parseMobileStaticArchive(value);
      String archivePath =
          canonicalDeclaredPath(
              archive.relativePath(), assetName, "mobileStaticArchives");
      requireMobileDeclarationTarget(
          assetName,
          "mobileStaticArchives",
          nativeTarget,
          archive.target(),
          archivePath,
          "extensions");
      addDeclaredArtifactFile(
          declaredFiles,
          archivePath,
          assetName,
          "mobileStaticArchives");
    }
    for (String value :
        strictManifestCsv(manifest, "mobileStaticDependencyArchives", assetName)) {
      MobileStaticDependencyArchive archive = parseMobileStaticDependencyArchive(value);
      String archivePath =
          canonicalDeclaredPath(
              archive.relativePath(), assetName, "mobileStaticDependencyArchives");
      requireMobileDeclarationTarget(
          assetName,
          "mobileStaticDependencyArchives",
          nativeTarget,
          archive.target(),
          archivePath,
          "dependencies");
      addDeclaredArtifactFile(
          declaredFiles,
          archivePath,
          assetName,
          "mobileStaticDependencyArchives");
    }

    TreeSet<String> actualFiles = new TreeSet<>();
    TreeSet<String> actualDirectories = new TreeSet<>();
    Path rootPath = root.toPath().toAbsolutePath().normalize();
    try (var stream = Files.walk(rootPath)) {
      for (Path path : stream.sorted().toList()) {
        BasicFileAttributes attributes =
            Files.readAttributes(path, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
        if (attributes.isSymbolicLink() || (!attributes.isDirectory() && !attributes.isRegularFile())) {
          throw new GradleException(
              "Oliphaunt extension artifact "
                  + assetName
                  + " contains a symlink or special file: "
                  + path);
        }
        if (attributes.isRegularFile()) {
          actualFiles.add(
              rootPath.relativize(path).toString().replace(File.separatorChar, '/'));
        } else if (!path.equals(rootPath)) {
          actualDirectories.add(
              rootPath.relativize(path).toString().replace(File.separatorChar, '/'));
        }
      }
    } catch (GradleException error) {
      throw error;
    } catch (IOException error) {
      throw new GradleException(
          "inspect Oliphaunt extension artifact " + assetName + " file inventory", error);
    }

    String extensionDirectory = "files/share/postgresql/extension/";
    String controlFile = extensionDirectory + sqlName + ".control";
    boolean hasControl = actualFiles.contains(controlFile);
    boolean hasInstallSql = false;
    boolean hasMainExtensionCreationFile = false;
    TreeSet<String> unexpected = new TreeSet<>();
    TreeSet<String> expectedFiles = new TreeSet<>(declaredFiles);
    for (String actual : actualFiles) {
      if (declaredFiles.contains(actual)) {
        continue;
      }
      if (isOwnedExtensionSqlOrControl(
          actual, sqlName, extensionSqlFileNames, extensionSqlFilePrefixes)) {
        expectedFiles.add(actual);
        hasInstallSql |= isInstallSql(actual, sqlName);
        hasMainExtensionCreationFile |= isMainExtensionCreationFile(actual, sqlName);
        continue;
      }
      unexpected.add(actual);
    }
    if (createsExtension.equals("yes") && (!hasControl || !hasInstallSql)) {
      throw new GradleException(
          "Oliphaunt extension artifact "
              + assetName
              + " declares createsExtension=yes but must contain "
              + controlFile
              + " and a canonical install SQL file for "
              + sqlName);
    }
    if (createsExtension.equals("no") && hasMainExtensionCreationFile) {
      throw new GradleException(
          "Oliphaunt extension artifact "
              + assetName
              + " declares createsExtension=no but contains extension creation files for "
              + sqlName);
    }
    TreeSet<String> missing = new TreeSet<>(declaredFiles);
    missing.removeAll(actualFiles);
    if (!missing.isEmpty() || !unexpected.isEmpty()) {
      throw new GradleException(
          "Oliphaunt extension artifact "
              + assetName
              + " files do not exactly match its manifest; missing="
              + missing
              + ", unexpected="
              + unexpected);
    }
    TreeSet<String> expectedDirectories = parentDirectories(expectedFiles);
    if (!actualDirectories.equals(expectedDirectories)) {
      TreeSet<String> unexpectedDirectories = new TreeSet<>(actualDirectories);
      unexpectedDirectories.removeAll(expectedDirectories);
      TreeSet<String> missingDirectories = new TreeSet<>(expectedDirectories);
      missingDirectories.removeAll(actualDirectories);
      throw new GradleException(
          "Oliphaunt extension artifact "
              + assetName
              + " directory inventory is not exact; missing="
              + missingDirectories
              + ", unexpected="
              + unexpectedDirectories);
    }
    validateExactLegalMemberFiles(root, legalContract, "Oliphaunt extension artifact " + assetName);
    validateExactLegalArchiveMembers(
        legalContract,
        inspection,
        archivePrefix,
        "Oliphaunt extension artifact " + assetName);
  }

  private static void addDeclaredArtifactFile(
      Set<String> declared, String path, String assetName, String field) {
    if (!declared.add(path)) {
      throw new GradleException(
          "Oliphaunt extension artifact "
              + assetName
              + " repeats declared file "
              + path
              + " through "
              + field);
    }
  }

  private static List<String> strictManifestCsv(
      Properties manifest, String field, String assetName) {
    String raw = manifest.getProperty(field);
    if (raw == null) {
      throw new GradleException(
          "Oliphaunt extension artifact " + assetName + " is missing " + field);
    }
    if (raw.isEmpty()) {
      return List.of();
    }
    List<String> result = Arrays.asList(raw.split(",", -1));
    LinkedHashSet<String> unique = new LinkedHashSet<>();
    for (String value : result) {
      if (value.isEmpty() || !value.equals(value.trim())) {
        throw new GradleException(
            "Oliphaunt extension artifact "
                + assetName
                + " has a noncanonical "
                + field
                + " list: "
                + raw);
      }
      if (!unique.add(value)) {
        throw new GradleException(
            "Oliphaunt extension artifact "
                + assetName
                + " repeats "
                + field
                + " entry "
                + value);
      }
    }
    return List.copyOf(result);
  }

  private static void requireMobileDeclarationTarget(
      String assetName,
      String field,
      String nativeTarget,
      String declaredTarget,
      String path,
      String roleDirectory) {
    String requiredPrefix = "mobile-static/" + nativeTarget + "/" + roleDirectory + "/";
    if (!declaredTarget.equals(nativeTarget) || !path.startsWith(requiredPrefix)) {
      throw new GradleException(
          "Oliphaunt extension artifact "
              + assetName
              + " "
              + field
              + " entry must bind target/path to "
              + nativeTarget
              + " under "
              + requiredPrefix
              + ", got "
              + declaredTarget
              + ":"
              + path);
    }
  }

  private static String canonicalDeclaredPath(
      String raw, String assetName, String field) {
    if (raw == null
        || raw.isEmpty()
        || raw.startsWith("/")
        || raw.startsWith("\\")
        || raw.indexOf('\\') >= 0
        || raw.indexOf('\0') >= 0
        || raw.contains("//")) {
      throw new GradleException(
          "Oliphaunt extension artifact "
              + assetName
              + " declares unsafe "
              + field
              + " path "
              + raw);
    }
    Path relative = Path.of(raw);
    String normalized =
        relative.normalize().toString().replace(File.separatorChar, '/');
    if (relative.isAbsolute()
        || relative.normalize().startsWith("..")
        || !normalized.equals(raw)) {
      throw new GradleException(
          "Oliphaunt extension artifact "
              + assetName
              + " declares unsafe or ambiguous "
              + field
              + " path "
              + raw);
    }
    return normalized;
  }

  private static boolean isOwnedExtensionSqlOrControl(
      String path,
      String sqlName,
      List<String> extensionSqlFileNames,
      List<String> extensionSqlFilePrefixes) {
    String prefix = "files/share/postgresql/extension/";
    if (!path.startsWith(prefix)) {
      return false;
    }
    String name = path.substring(prefix.length());
    if (name.indexOf('/') >= 0) {
      return false;
    }
    if (name.equals(sqlName + ".control")) {
      return true;
    }
    if (!name.endsWith(".sql")) {
      return false;
    }
    return name.equals(sqlName + ".sql")
        || name.startsWith(sqlName + "--")
        || extensionSqlFileNames.contains(name)
        || extensionSqlFilePrefixes.stream().anyMatch(name::startsWith);
  }

  private static boolean isMainExtensionCreationFile(String path, String sqlName) {
    String name = path.substring(path.lastIndexOf('/') + 1);
    return name.equals(sqlName + ".control")
        || name.equals(sqlName + ".sql")
        || (name.startsWith(sqlName + "--") && name.endsWith(".sql"));
  }

  private static boolean isInstallSql(String path, String sqlName) {
    String name = path.substring(path.lastIndexOf('/') + 1);
    if (name.equals(sqlName + ".sql")) {
      return true;
    }
    String prefix = sqlName + "--";
    if (!name.startsWith(prefix) || !name.endsWith(".sql")) {
      return false;
    }
    String version = name.substring(prefix.length(), name.length() - ".sql".length());
    return version.matches("[0-9][A-Za-z0-9._-]*") && !version.contains("--");
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
    File validatedArchive = validatedTarGzSnapshot(archive);
    fileSystemOperations.delete(spec -> spec.delete(output));
    fileSystemOperations.copy(
        spec -> {
          spec.from(archiveOperations.tarTree(archiveOperations.gzip(validatedArchive)));
          spec.into(output);
        });
  }

  private void mergeIcuDataArtifact(File archive) {
    File validatedArchive = validatedTarGzSnapshot(archive);
    File extractRoot = new File(getTemporaryDir(), "icu-artifact-" + archive.getName());
    fileSystemOperations.delete(spec -> spec.delete(extractRoot));
    fileSystemOperations.copy(
        spec -> {
          spec.from(archiveOperations.tarTree(archiveOperations.gzip(validatedArchive)));
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
      File validatedArchive = validatedTarGzSnapshot(archive);
      File extractRoot = new File(getTemporaryDir(), "jni-" + abi);
      fileSystemOperations.delete(spec -> spec.delete(extractRoot));
      fileSystemOperations.copy(
          spec -> {
            spec.from(archiveOperations.tarTree(archiveOperations.gzip(validatedArchive)));
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
    if (!output.mkdirs() && !output.isDirectory()) {
      throw new GradleException("could not create " + output);
    }
    for (Map.Entry<String, File> entry : downloaded.entrySet()) {
      File artifactRoot = extractExtensionArchive(entry.getValue());
      Properties manifest =
          readExtensionArtifactProperties(new File(artifactRoot, "manifest.properties"));
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

  private List<ExtensionRuntimeArtifact> mergeExtensionRuntimeArtifacts(
      Map<String, File> downloaded, List<Map<String, String>> selectedRows) {
    if (selectedRows.isEmpty()) {
      return List.of();
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
      Properties artifactManifest =
          readExtensionArtifactProperties(new File(artifactRoot, "manifest.properties"));
      mergeTargetInvariantExtensionRuntimeFiles(
          artifactRoot, artifactManifest, runtimeFiles, sqlName);
      artifacts.add(
          new ExtensionRuntimeArtifact(
              sqlName,
              "yes".equals(row.get("creates_extension")),
              dashToNull(row.get("native_module_stem")),
              dashToNull(row.get("shared_preload")),
              splitCsv(row.get("runtime_files")),
              dashToNull(row.get("static_symbol_prefix")),
              parseStaticSymbolAliases(
                  dashToNull(row.get("static_symbol_aliases")) == null
                      ? ""
                      : dashToNull(row.get("static_symbol_aliases")),
                  "selected " + sqlName + " Android artifact"),
              splitCsv(dashToNull(row.get("archive_targets"))),
              splitCsv(dashToNull(row.get("dependency_archives")))));
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
      List<StaticRegistryModule> modules =
          staticRegistryModules(runtimeFiles, nativeArtifacts);
      writeText(
          new File(staticRegistryDir, "oliphaunt_static_registry.c"),
          staticRegistrySourceText(modules));
      writeStaticRegistryManifest(staticRegistryDir, nativeArtifacts, modules);
      staticRegistrySource = "static-registry/oliphaunt_static_registry.c";
    }
    updateRuntimeManifest(new File(runtimePackage, "manifest.properties"), artifacts, staticRegistrySource);
    return List.copyOf(artifacts);
  }

  private static void mergeTargetInvariantExtensionRuntimeFiles(
      File artifactRoot,
      Properties manifest,
      File runtimeFiles,
      String sqlName) {
    Path sourceRoot = new File(artifactRoot, "files").toPath();
    if (!Files.exists(sourceRoot, LinkOption.NOFOLLOW_LINKS)) {
      return;
    }
    String nativeModuleFile = manifest.getProperty("nativeModuleFile", "");
    String targetSpecificModule =
        nativeModuleFile.isEmpty() ? null : "lib/postgresql/" + nativeModuleFile;
    try (var stream = Files.walk(sourceRoot)) {
      for (Path source : stream.sorted().toList()) {
        if (!Files.isRegularFile(source, LinkOption.NOFOLLOW_LINKS)) {
          continue;
        }
        String relative =
            sourceRoot.relativize(source).toString().replace(File.separatorChar, '/');
        if (relative.equals(targetSpecificModule)) {
          continue;
        }
        copyFileWithoutConflict(
            source,
            runtimeFiles.toPath().resolve(relative),
            "selected extension runtime file " + relative + " for " + sqlName);
      }
    } catch (IOException error) {
      throw new GradleException(
          "merge target-independent runtime files for selected extension " + sqlName, error);
    }
  }

  private File extractExtensionRuntimeArtifact(String sqlName, File archive) {
    File artifactRoot = extractExtensionArchive(archive);
    Properties manifest =
        readExtensionArtifactProperties(new File(artifactRoot, "manifest.properties"));
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
      if (!artifact.createsExtension) {
        continue;
      }
      File control = new File(extensionDir, artifact.sqlName + ".control");
      if (!control.isFile()) {
        throw new GradleException(
            "selected extension " + artifact.sqlName + " is missing packaged control file " + control);
      }
      extensionSqlFiles(runtimeFiles, artifact.sqlName);
    }
  }

  private File extractExtensionArchive(File archive) {
    ExtractedTarGz extracted =
        extractTarGzDetailed(
            archive,
            "runtime-artifact-",
            PublicTarGzArchivePreflight.extensionArtifactLimits());
    File extractRoot = extracted.root();
    File artifactRoot = artifactRoot(extractRoot, archive);
    Properties manifest =
        readExtensionArtifactProperties(new File(artifactRoot, "manifest.properties"));
    if (!"oliphaunt-extension-artifact-v1".equals(manifest.getProperty("packageLayout"))) {
      throw new GradleException(
          "liboliphaunt extension runtime artifact "
              + archive.getName()
              + " has unsupported packageLayout");
    }
    validateExtensionArtifactInventory(
        artifactRoot,
        manifest,
        archive.getName(),
        extracted.inspection(),
        archivePrefix(extractRoot, artifactRoot));
    return artifactRoot;
  }

  private File extractTarGz(File archive, String prefix) {
    return extractTarGz(archive, prefix, null);
  }

  private File extractTarGz(
      File archive, String prefix, PublicTarGzArchivePreflight.Limits limits) {
    return extractTarGzDetailed(archive, prefix, limits).root();
  }

  private ExtractedTarGz extractTarGzDetailed(
      File archive, String prefix, PublicTarGzArchivePreflight.Limits limits) {
    ValidatedTarGz validated = validatedTarGzSnapshotDetailed(archive, limits);
    String identity = PublicTarGzArchivePreflight.sourceIdentity(archive.toPath());
    File extractRoot = new File(getTemporaryDir(), prefix + identity);
    fileSystemOperations.delete(spec -> spec.delete(extractRoot));
    fileSystemOperations.copy(
        spec -> {
          spec.from(archiveOperations.tarTree(archiveOperations.gzip(validated.archive())));
          spec.into(extractRoot);
        });
    return new ExtractedTarGz(extractRoot, validated.inspection());
  }

  private File validatedTarGzSnapshot(File archive) {
    return validatedTarGzSnapshot(archive, null);
  }

  private File validatedTarGzSnapshot(
      File archive, PublicTarGzArchivePreflight.Limits limits) {
    return validatedTarGzSnapshotDetailed(archive, limits).archive();
  }

  private ValidatedTarGz validatedTarGzSnapshotDetailed(
      File archive, PublicTarGzArchivePreflight.Limits limits) {
    if (!archive.getName().endsWith(".tar.gz") && !archive.getName().endsWith(".tgz")) {
      throw new GradleException(
          "liboliphaunt release artifact must be a Gradle-native .tar.gz archive, got "
              + archive.getName());
    }
    String identity = PublicTarGzArchivePreflight.sourceIdentity(archive.toPath());
    File validatedArchive =
        new File(getTemporaryDir(), "validated-archives/" + identity + ".tar.gz");
    PublicTarGzArchivePreflight.Inspection inspection =
        limits == null
            ? PublicTarGzArchivePreflight.snapshotAndValidate(
                archive.toPath(), validatedArchive.toPath())
            : PublicTarGzArchivePreflight.snapshotAndValidate(
                archive.toPath(), validatedArchive.toPath(), limits);
    return new ValidatedTarGz(validatedArchive, inspection);
  }

  private static String archivePrefix(File extractRoot, File artifactRoot) {
    Path root = extractRoot.toPath().toAbsolutePath().normalize();
    Path artifact = artifactRoot.toPath().toAbsolutePath().normalize();
    if (!artifact.startsWith(root)) {
      throw new GradleException("extracted artifact root escapes its private validation area");
    }
    String relative = root.relativize(artifact).toString().replace(File.separatorChar, '/');
    return relative.equals(".") ? "" : relative;
  }

  private static File artifactRoot(File extractRoot, File archive) {
    if (new File(extractRoot, "manifest.properties").isFile()) {
      return extractRoot;
    }
    File[] children =
        extractRoot.listFiles(file -> file.isDirectory() && new File(file, "manifest.properties").isFile());
    if (children != null && children.length == 1) {
      requireOnlyCarrierWrapper(
          extractRoot, children[0], "liboliphaunt extension runtime artifact " + archive.getName());
      return children[0];
    }
    throw new GradleException(
        "liboliphaunt extension runtime artifact "
            + archive.getName()
            + " did not contain one manifest.properties root");
  }

  static File artifactRootForContractTest(File extractRoot) {
    return artifactRoot(extractRoot, new File("contract-test.tar.gz"));
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
    List<String> createableExtensions =
        sorted(
            artifacts.stream()
                .filter(artifact -> artifact.createsExtension)
                .map(artifact -> artifact.sqlName)
                .toList());
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
    properties.setProperty("selectedExtensions", String.join(",", selectedExtensions));
    properties.setProperty("extensions", String.join(",", createableExtensions));
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

  private static void writeStaticRegistryManifest(
      File staticRegistryDir,
      List<ExtensionRuntimeArtifact> artifacts,
      List<StaticRegistryModule> modules) {
    writeText(
        new File(staticRegistryDir, "manifest.properties"),
        staticRegistryManifestText(artifacts, modules));
  }

  private static String staticRegistryManifestText(
      List<ExtensionRuntimeArtifact> artifacts, List<StaticRegistryModule> modules) {
    List<String> moduleNames =
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
    Map<String, MobileStaticDependencyArchive> dependenciesByTargetAndName =
        new java.util.TreeMap<>();
    for (String value :
        artifacts.stream()
            .filter(artifact -> artifact.nativeModuleStem != null)
            .flatMap(artifact -> artifact.dependencyArchives.stream())
            .toList()) {
      MobileStaticDependencyArchive dependency = parseMobileStaticDependencyArchive(value);
      String key = dependency.name + "\u0000" + dependency.target;
      MobileStaticDependencyArchive previous =
          dependenciesByTargetAndName.putIfAbsent(key, dependency);
      if (previous != null && !previous.relativePath.equals(dependency.relativePath)) {
        throw new GradleException(
            "selected Android extensions disagree on static dependency "
                + dependency.name
                + " for "
                + dependency.target);
      }
    }
    List<MobileStaticDependencyArchive> dependencies =
        List.copyOf(dependenciesByTargetAndName.values());
    List<String> dependencyNames =
        sorted(dependencies.stream().map(MobileStaticDependencyArchive::name).toList());
    List<String> dependencyTargets =
        sorted(dependencies.stream().map(MobileStaticDependencyArchive::target).toList());
    List<String> lines = new ArrayList<>();
    lines.add("packageLayout=oliphaunt-static-registry-v1");
    lines.add("abiVersion=1");
    lines.add("state=complete");
    lines.add("source=oliphaunt_static_registry.c");
    lines.add("registeredExtensions=" + String.join(",", sorted(artifacts.stream().map(artifact -> artifact.sqlName).toList())));
    lines.add("pendingExtensions=");
    lines.add("nativeModuleStems=" + String.join(",", moduleNames));
    lines.add("modules=" + String.join(",", moduleNames));
    lines.add("archiveTargets=" + String.join(",", archiveTargets));
    lines.add("dependencyArchiveTargets=" + String.join(",", dependencyTargets));
    lines.add("dependencyArchives=" + String.join(",", dependencyNames));
    Map<String, ExtensionRuntimeArtifact> artifactsByStem = new LinkedHashMap<>();
    for (ExtensionRuntimeArtifact artifact : artifacts) {
      if (artifact.nativeModuleStem != null) {
        artifactsByStem.put(artifact.nativeModuleStem, artifact);
      }
    }
    for (StaticRegistryModule module : modules) {
      String stem = module.moduleStem;
      ExtensionRuntimeArtifact artifact = artifactsByStem.get(stem);
      List<String> targets = sorted(artifact.archiveTargets);
      lines.add("module." + stem + ".extension=" + artifact.sqlName);
      lines.add("module." + stem + ".symbolPrefix=" + module.symbolPrefix);
      lines.add("module." + stem + ".sqlSymbols=" + String.join(",", module.sqlSymbols));
      lines.add(
          "module."
              + stem
              + ".symbolAliases="
              + module.symbolAliases.entrySet().stream()
                  .map(entry -> entry.getKey() + ":" + entry.getValue())
                  .collect(java.util.stream.Collectors.joining(",")));
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
    for (String dependencyName : dependencyNames) {
      List<MobileStaticDependencyArchive> namedDependencies =
          dependencies.stream()
              .filter(dependency -> dependency.name.equals(dependencyName))
              .toList();
      List<String> targets =
          sorted(namedDependencies.stream().map(MobileStaticDependencyArchive::target).toList());
      lines.add(
          "dependency."
              + dependencyName
              + ".archiveTargets="
              + String.join(",", targets));
      for (MobileStaticDependencyArchive dependency : namedDependencies) {
        String basename = Path.of(dependency.relativePath).getFileName().toString();
        lines.add(
            "dependency."
                + dependencyName
                + ".archive."
                + dependency.target
                + "=archives/"
                + dependency.target
                + "/dependencies/"
                + dependencyName
                + "/"
                + basename);
      }
    }
    return String.join("\n", lines) + "\n";
  }

  private static List<StaticRegistryModule> staticRegistryModules(
      File runtimeFiles, List<ExtensionRuntimeArtifact> artifacts) {
    List<StaticRegistryModule> modules = new ArrayList<>();
    TreeSet<String> moduleStems = new TreeSet<>();
    TreeSet<String> prefixes = new TreeSet<>();
    for (ExtensionRuntimeArtifact artifact : artifacts) {
      if (artifact.nativeModuleStem == null) {
        continue;
      }
      if (!moduleStems.add(artifact.nativeModuleStem)) {
        throw new GradleException(
            "selected Android extensions declare duplicate native module stem "
                + artifact.nativeModuleStem);
      }
      String prefix =
          artifact.staticSymbolPrefix == null
              ? staticRegistrySymbolPrefix(artifact.nativeModuleStem)
              : artifact.staticSymbolPrefix;
      if (!prefixes.add(prefix)) {
        throw new GradleException(
            "selected Android extensions generate duplicate static symbol prefix " + prefix);
      }
      LinkedHashMap<String, String> aliases = new LinkedHashMap<>();
      for (StaticSymbolAlias alias : artifact.staticSymbolAliases) {
        aliases.put(alias.sqlSymbol, alias.linkedSymbol);
      }
      modules.add(
          new StaticRegistryModule(
              artifact.nativeModuleStem,
              prefix,
              artifact.createsExtension
                  ? collectExtensionSqlSymbols(
                      runtimeFiles, artifact.sqlName, artifact.nativeModuleStem)
                  : List.of(),
              Collections.unmodifiableMap(aliases)));
    }
    modules.sort(java.util.Comparator.comparing(module -> module.moduleStem));
    return List.copyOf(modules);
  }

  private static String staticRegistryLinkedSymbol(
      StaticRegistryModule module, String sqlSymbol) {
    return module.symbolAliases.getOrDefault(sqlSymbol, sqlSymbol);
  }

  private static TreeSet<String> staticRegistrySqlSymbolNames(StaticRegistryModule module) {
    TreeSet<String> result = new TreeSet<>();
    for (String symbol : module.sqlSymbols) {
      result.add(symbol);
      result.add("pg_finfo_" + symbol);
    }
    return result;
  }

  private static boolean staticRegistryHasSymbols(StaticRegistryModule module) {
    return !module.sqlSymbols.isEmpty() || !module.symbolAliases.isEmpty();
  }

  private static String staticRegistrySourceText(List<StaticRegistryModule> modules) {
    StringBuilder out = new StringBuilder();
    out.append("/* Generated by Oliphaunt Android Gradle plugin. Do not edit by hand. */\n");
    out.append("#include <stddef.h>\n#include <stdint.h>\n#include \"oliphaunt.h\"\n\n");
    out.append("#if defined(__GNUC__) || defined(__clang__)\n#define OLIPHAUNT_STATIC_OPTIONAL __attribute__((weak))\n#else\n#define OLIPHAUNT_STATIC_OPTIONAL\n#endif\n\n");
    for (StaticRegistryModule module : modules) {
      out.append("extern const void *").append(module.symbolPrefix).append("_Pg_magic_func(void);\n");
      out.append("extern void ").append(module.symbolPrefix).append("__PG_init(void) OLIPHAUNT_STATIC_OPTIONAL;\n");
      for (String symbol : module.sqlSymbols) {
        out.append("extern void ")
            .append(staticRegistryLinkedSymbol(module, symbol))
            .append("(void);\n");
        out.append("extern void ")
            .append(staticRegistryLinkedSymbol(module, "pg_finfo_" + symbol))
            .append("(void);\n");
      }
      TreeSet<String> sqlSymbolNames = staticRegistrySqlSymbolNames(module);
      for (Map.Entry<String, String> alias : module.symbolAliases.entrySet()) {
        if (!sqlSymbolNames.contains(alias.getKey())) {
          out.append("extern void ").append(alias.getValue()).append("(void);\n");
        }
      }
      out.append('\n');
    }
    for (StaticRegistryModule module : modules) {
      if (!staticRegistryHasSymbols(module)) {
        continue;
      }
      out.append("static const OliphauntStaticExtensionSymbol ").append(module.symbolPrefix).append("_symbols[] = {\n");
      for (String symbol : module.sqlSymbols) {
        out.append("    { .name = ")
            .append(cStringLiteral(symbol))
            .append(", .address = (void *)")
            .append(staticRegistryLinkedSymbol(module, symbol))
            .append(" },\n");
        out.append("    { .name = ")
            .append(cStringLiteral("pg_finfo_" + symbol))
            .append(", .address = (void *)")
            .append(staticRegistryLinkedSymbol(module, "pg_finfo_" + symbol))
            .append(" },\n");
      }
      TreeSet<String> sqlSymbolNames = staticRegistrySqlSymbolNames(module);
      for (Map.Entry<String, String> alias : module.symbolAliases.entrySet()) {
        if (!sqlSymbolNames.contains(alias.getKey())) {
          out.append("    { .name = ")
              .append(cStringLiteral(alias.getKey()))
              .append(", .address = (void *)")
              .append(alias.getValue())
              .append(" },\n");
        }
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
      if (staticRegistryHasSymbols(module)) {
        out.append("        .symbols = ").append(module.symbolPrefix).append("_symbols,\n");
        out.append("        .symbol_count = sizeof(").append(module.symbolPrefix).append("_symbols) / sizeof(").append(module.symbolPrefix).append("_symbols[0]),\n");
      } else {
        out.append("        .symbols = NULL,\n");
        out.append("        .symbol_count = 0,\n");
      }
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

  static String staticRegistrySourceForContractTest(
      File runtimeFiles,
      String sqlName,
      boolean createsExtension,
      String moduleStem,
      String symbolPrefix,
      String symbolAliases) {
    ExtensionRuntimeArtifact artifact =
        new ExtensionRuntimeArtifact(
            sqlName,
            createsExtension,
            moduleStem,
            null,
            List.of(),
            symbolPrefix,
            parseStaticSymbolAliases(symbolAliases, "contract-test " + sqlName),
            List.of(),
            List.of());
    return staticRegistrySourceText(staticRegistryModules(runtimeFiles, List.of(artifact)));
  }

  static String staticRegistryManifestForContractTest(
      File runtimeFiles,
      String sqlName,
      boolean createsExtension,
      String moduleStem,
      String symbolPrefix,
      String symbolAliases,
      List<String> archiveTargets,
      List<String> dependencyArchives) {
    ExtensionRuntimeArtifact artifact =
        new ExtensionRuntimeArtifact(
            sqlName,
            createsExtension,
            moduleStem,
            null,
            List.of(),
            symbolPrefix,
            parseStaticSymbolAliases(symbolAliases, "contract-test " + sqlName),
            archiveTargets,
            dependencyArchives);
    List<StaticRegistryModule> modules =
        staticRegistryModules(runtimeFiles, List.of(artifact));
    return staticRegistryManifestText(List.of(artifact), modules);
  }

  private void copyMobileStaticTree(File source, File target) {
    if (!source.isDirectory()) {
      return;
    }
    Path sourceRoot = source.toPath();
    try (var stream = Files.walk(sourceRoot)) {
      for (Path file : stream.sorted().toList()) {
        if (!Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS)) {
          continue;
        }
        Path relative = sourceRoot.relativize(file);
        copyFileWithoutConflict(
            file,
            target.toPath().resolve(relative),
            "mobile static archive " + relative.toString().replace(File.separatorChar, '/'));
      }
    } catch (IOException error) {
      throw new GradleException("merge mobile static archives from " + source, error);
    }
  }

  private static List<String> collectExtensionSqlSymbols(
      File runtimeFiles, String sqlName, String moduleStem) {
    List<File> sqlFiles = extensionSqlFiles(runtimeFiles, sqlName);
    TreeSet<String> symbols = new TreeSet<>();
    for (File file : sqlFiles) {
      try {
        symbols.addAll(
            moduleCSymbols(
                Files.readString(file.toPath(), StandardCharsets.UTF_8), moduleStem));
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

  private static List<String> moduleCSymbols(String sql, String moduleStem) {
    TreeSet<String> symbols = new TreeSet<>();
    for (String statement : splitSqlStatements(stripSqlLineComments(sql))) {
      if (!hasLanguageC(statement)) {
        continue;
      }
      String moduleRemainder = matchingModuleReferenceRemainder(statement, moduleStem);
      if (moduleRemainder == null) {
        continue;
      }
      String symbol = explicitModuleSymbol(moduleRemainder);
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

  private static String matchingModuleReferenceRemainder(
      String statement, String moduleStem) {
    String explicitModule = "$libdir/" + moduleStem;
    int searchStart = 0;
    while (searchStart < statement.length()) {
      int asIndex = findSqlKeyword(statement, "as", searchStart);
      if (asIndex < 0) {
        return null;
      }
      ParsedSqlLiteral literal =
          parseSqlSingleQuotedLiteral(statement.substring(asIndex + "as".length()).stripLeading());
      if (literal == null) {
        searchStart = asIndex + "as".length();
        continue;
      }
      if (literal.value.equalsIgnoreCase("module_pathname")
          || literal.value.equals(explicitModule)) {
        return literal.remainder;
      }
      searchStart = asIndex + "as".length();
    }
    return null;
  }

  private static int findSqlKeyword(String statement, String keyword, int start) {
    boolean inString = false;
    for (int index = 0; index < statement.length(); index++) {
      char ch = statement.charAt(index);
      if (ch == '\'') {
        if (inString && index + 1 < statement.length() && statement.charAt(index + 1) == '\'') {
          index++;
        } else {
          inString = !inString;
        }
        continue;
      }
      if (inString || index < start || index + keyword.length() > statement.length()) {
        continue;
      }
      if (!statement.regionMatches(true, index, keyword, 0, keyword.length())) {
        continue;
      }
      boolean hasIdentifierBefore = index > 0 && isSqlIdentifierChar(statement.charAt(index - 1));
      boolean hasIdentifierAfter =
          index + keyword.length() < statement.length()
              && isSqlIdentifierChar(statement.charAt(index + keyword.length()));
      if (!hasIdentifierBefore && !hasIdentifierAfter) {
        return index;
      }
    }
    return -1;
  }

  private static boolean isSqlIdentifierChar(char ch) {
    return (ch >= 'A' && ch <= 'Z')
        || (ch >= 'a' && ch <= 'z')
        || (ch >= '0' && ch <= '9')
        || ch == '_'
        || ch == '$';
  }

  private static String explicitModuleSymbol(String moduleRemainder) {
    String rest = moduleRemainder.stripLeading();
    if (!rest.startsWith(",")) {
      return null;
    }
    ParsedSqlLiteral literal =
        parseSqlSingleQuotedLiteral(rest.substring(1).stripLeading());
    return literal == null ? null : literal.value;
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

  private static ParsedSqlLiteral parseSqlSingleQuotedLiteral(String value) {
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
          return new ParsedSqlLiteral(out.toString(), value.substring(index + 1));
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

  private static void refreshRuntimeCacheKey(File resourceRoot) {
    File runtimePackage = new File(resourceRoot, "runtime");
    File manifestFile = new File(runtimePackage, "manifest.properties");
    if (!manifestFile.isFile() || !new File(runtimePackage, "files").isDirectory()) {
      throw new GradleException(
          "liboliphaunt runtime resources must contain runtime/manifest.properties and runtime/files");
    }
    Properties properties = readProperties(manifestFile);
    MessageDigest digest = newSha256Digest();
    for (String key : new TreeSet<>(properties.stringPropertyNames())) {
      if (key.equals("cacheKey")) {
        continue;
      }
      updateDigestString(digest, key);
      updateDigestString(digest, properties.getProperty(key));
    }
    for (String relativeRoot :
        List.of("runtime/files", "template-pgdata/files", "static-registry")) {
      updateDigestTree(digest, resourceRoot.toPath(), relativeRoot);
    }
    properties.setProperty("cacheKey", "android-" + hex(digest.digest()));
    writeOrderedProperties(manifestFile, properties);
  }

  private static void updateDigestTree(
      MessageDigest digest, Path resourceRoot, String relativeRoot) {
    Path filesRoot = resourceRoot.resolve(relativeRoot).toAbsolutePath().normalize();
    updateDigestString(digest, relativeRoot);
    if (!Files.exists(filesRoot, LinkOption.NOFOLLOW_LINKS)) {
      updateDigestString(digest, "absent");
      return;
    }
    updateDigestString(digest, "present");
    try (var stream = Files.walk(filesRoot)) {
      for (Path file : stream.sorted().toList()) {
        BasicFileAttributes attributes =
            Files.readAttributes(file, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
        if (attributes.isDirectory()) {
          continue;
        }
        if (!attributes.isRegularFile() || attributes.isSymbolicLink()) {
          throw new GradleException(
              "Oliphaunt Android runtime cache does not support symlinks or special files: "
                  + file);
        }
        updateDigestString(
            digest,
            relativeRoot
                + "/"
                + filesRoot.relativize(file.toAbsolutePath().normalize()).toString()
                    .replace(File.separatorChar, '/'));
        digest.update(ByteBuffer.allocate(Long.BYTES).putLong(attributes.size()).array());
        try (var input = Files.newInputStream(file)) {
          byte[] buffer = new byte[128 * 1024];
          int read;
          while ((read = input.read(buffer)) >= 0) {
            if (read > 0) {
              digest.update(buffer, 0, read);
            }
          }
        }
      }
    } catch (GradleException error) {
      throw error;
    } catch (IOException error) {
      throw new GradleException(
          "compute Oliphaunt Android runtime cache key from " + relativeRoot, error);
    }
  }

  private static void updateDigestString(MessageDigest digest, String value) {
    byte[] bytes = value.getBytes(StandardCharsets.UTF_8);
    digest.update(ByteBuffer.allocate(Integer.BYTES).putInt(bytes.length).array());
    digest.update(bytes);
  }

  private static MessageDigest newSha256Digest() {
    try {
      return MessageDigest.getInstance("SHA-256");
    } catch (NoSuchAlgorithmException error) {
      throw new GradleException("JVM does not provide SHA-256", error);
    }
  }

  private static String hex(byte[] bytes) {
    StringBuilder result = new StringBuilder(bytes.length * 2);
    for (byte value : bytes) {
      result.append(String.format(java.util.Locale.ROOT, "%02x", value & 0xff));
    }
    return result.toString();
  }

  private static void writeRuntimeResourceSizeReport(
      File root, List<ExtensionRuntimeArtifact> artifacts) {
    Path runtimeFiles =
        new File(root, "runtime/files").toPath().toAbsolutePath().normalize();
    long runtimeBytes = treeBytes(runtimeFiles, "runtime/files");
    long templateBytes =
        treeBytes(
            new File(root, "template-pgdata/files").toPath().toAbsolutePath().normalize(),
            "template-pgdata/files");
    long staticRegistryBytes =
        treeBytes(
            new File(root, "static-registry").toPath().toAbsolutePath().normalize(),
            "static-registry");
    long packageBytes = addBytes(addBytes(runtimeBytes, templateBytes), staticRegistryBytes);
    TreeSet<Path> selectedFiles = new TreeSet<>();
    List<String> extensionRows = new ArrayList<>();
    for (ExtensionRuntimeArtifact artifact :
        artifacts.stream()
            .sorted(java.util.Comparator.comparing(ExtensionRuntimeArtifact::sqlName))
            .toList()) {
      TreeSet<Path> extensionFiles = new TreeSet<>();
      for (String relative : artifact.runtimeFiles) {
        Path file = runtimeFiles.resolve(relative).normalize();
        if (!file.startsWith(runtimeFiles)
            || !Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS)) {
          throw new GradleException(
              "selected extension "
                  + artifact.sqlName
                  + " size report is missing runtime file "
                  + relative);
        }
        extensionFiles.add(file);
      }
      selectedFiles.addAll(extensionFiles);
      extensionRows.add(
          "extension\t"
              + artifact.sqlName
              + "\t-\t"
              + extensionFiles.size()
              + "\t"
              + fileBytes(extensionFiles));
    }
    List<String> lines = new ArrayList<>();
    lines.add("kind\tid\textensions\tfiles\tbytes");
    lines.add("package\ttotal\t-\t-\t" + packageBytes);
    lines.add("package\truntime\t-\t-\t" + runtimeBytes);
    lines.add("package\ttemplate-pgdata\t-\t-\t" + templateBytes);
    lines.add("package\tstatic-registry\t-\t-\t" + staticRegistryBytes);
    lines.add("extensions\tselected\t-\t-\t" + fileBytes(selectedFiles));
    lines.addAll(extensionRows);
    writeText(new File(root, "package-size.tsv"), String.join("\n", lines) + "\n");
  }

  private static long treeBytes(Path root, String label) {
    if (!Files.exists(root, LinkOption.NOFOLLOW_LINKS)) {
      return 0L;
    }
    long total = 0L;
    try (var stream = Files.walk(root)) {
      for (Path path : stream.sorted().toList()) {
        BasicFileAttributes attributes =
            Files.readAttributes(path, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
        if (attributes.isDirectory()) {
          continue;
        }
        if (!attributes.isRegularFile() || attributes.isSymbolicLink()) {
          throw new GradleException(
              "Oliphaunt Android " + label + " contains a symlink or special file: " + path);
        }
        total = addBytes(total, attributes.size());
      }
    } catch (GradleException error) {
      throw error;
    } catch (IOException error) {
      throw new GradleException("measure Oliphaunt Android " + label, error);
    }
    return total;
  }

  private static long fileBytes(Iterable<Path> files) {
    long total = 0L;
    for (Path file : files) {
      try {
        total = addBytes(total, Files.size(file));
      } catch (IOException error) {
        throw new GradleException("measure Oliphaunt Android runtime file " + file, error);
      }
    }
    return total;
  }

  private static long addBytes(long left, long right) {
    try {
      return Math.addExact(left, right);
    } catch (ArithmeticException error) {
      throw new GradleException("Oliphaunt Android package size exceeds signed 64-bit bytes", error);
    }
  }

  private static void copyFileWithoutConflict(Path source, Path destination, String label) {
    try {
      Files.createDirectories(destination.getParent());
      if (Files.exists(destination, LinkOption.NOFOLLOW_LINKS)) {
        if (!Files.isRegularFile(destination, LinkOption.NOFOLLOW_LINKS)
            || Files.isSymbolicLink(destination)
            || Files.mismatch(source, destination) != -1L) {
          throw new GradleException(
              "conflicting " + label + " would overwrite " + destination);
        }
        return;
      }
      Files.copy(source, destination);
    } catch (GradleException error) {
      throw error;
    } catch (IOException error) {
      throw new GradleException("copy " + label + " to " + destination, error);
    }
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

  private static Properties readExtensionArtifactProperties(File file) {
    Path path = file.toPath();
    final BasicFileAttributes attributes;
    final byte[] bytes;
    try {
      attributes =
          Files.readAttributes(path, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
      if (!attributes.isRegularFile() || attributes.isSymbolicLink()) {
        throw new GradleException(
            "extension artifact manifest must be a regular non-symlink file: " + file);
      }
      if (attributes.size() <= 0 || attributes.size() > MAX_EXTENSION_ARTIFACT_MANIFEST_BYTES) {
        throw new GradleException(
            "extension artifact manifest "
                + file
                + " must be between 1 and "
                + MAX_EXTENSION_ARTIFACT_MANIFEST_BYTES
                + " bytes, got "
                + attributes.size());
      }
      bytes = Files.readAllBytes(path);
    } catch (GradleException error) {
      throw error;
    } catch (IOException error) {
      throw new GradleException("read extension artifact manifest " + file, error);
    }
    if (bytes.length != attributes.size()) {
      throw new GradleException(
          "extension artifact manifest " + file + " changed while it was being read");
    }
    return parseExtensionArtifactProperties(bytes, file.toString());
  }

  static Properties parseExtensionArtifactPropertiesForContractTest(byte[] bytes) {
    return parseExtensionArtifactProperties(bytes, "contract-test manifest.properties");
  }

  private static Properties parseExtensionArtifactProperties(byte[] bytes, String source) {
    if (bytes.length <= 0 || bytes.length > MAX_EXTENSION_ARTIFACT_MANIFEST_BYTES) {
      throw new GradleException(
          source
              + " must be between 1 and "
              + MAX_EXTENSION_ARTIFACT_MANIFEST_BYTES
              + " bytes, got "
              + bytes.length);
    }
    final String text;
    try {
      text =
          StandardCharsets.UTF_8
              .newDecoder()
              .onMalformedInput(CodingErrorAction.REPORT)
              .onUnmappableCharacter(CodingErrorAction.REPORT)
              .decode(ByteBuffer.wrap(bytes))
              .toString();
    } catch (CharacterCodingException error) {
      throw new GradleException(source + " is not valid UTF-8", error);
    }
    if (text.indexOf('\0') >= 0) {
      throw new GradleException(source + " contains a NUL byte");
    }
    Properties result = new Properties();
    String[] lines = text.split("\n", -1);
    for (int index = 0; index < lines.length; index++) {
      String line = lines[index];
      if (index == lines.length - 1 && line.isEmpty()) {
        continue;
      }
      if (line.endsWith("\r")) {
        line = line.substring(0, line.length() - 1);
      }
      int lineNumber = index + 1;
      if (line.isEmpty() || line.indexOf('\r') >= 0) {
        throw new GradleException(
            source + " has a malformed physical line " + lineNumber);
      }
      if (line.indexOf('\\') >= 0) {
        throw new GradleException(
            source
                + " physical line "
                + lineNumber
                + " uses a forbidden property escape or continuation");
      }
      for (int charIndex = 0; charIndex < line.length(); charIndex++) {
        if (Character.isISOControl(line.charAt(charIndex))) {
          throw new GradleException(
              source + " physical line " + lineNumber + " contains a control character");
        }
      }
      int separator = line.indexOf('=');
      if (separator <= 0 || separator != line.lastIndexOf('=')) {
        throw new GradleException(
            source
                + " physical line "
                + lineNumber
                + " must use one literal key=value assignment");
      }
      String key = line.substring(0, separator);
      String value = line.substring(separator + 1);
      if (!key.matches("[A-Za-z][A-Za-z0-9]*")) {
        throw new GradleException(
            source
                + " physical line "
                + lineNumber
                + " has a malformed property key "
                + key);
      }
      if (!EXTENSION_ARTIFACT_PROPERTY_KEYS.contains(key)) {
        throw new GradleException(
            source + " physical line " + lineNumber + " has unknown property key " + key);
      }
      if (result.containsKey(key)) {
        throw new GradleException(
            source + " repeats property key " + key + " on physical line " + lineNumber);
      }
      result.setProperty(key, value);
    }
    return result;
  }

  private static void writeOrderedProperties(File file, Properties properties) {
    List<String> preferred =
        List.of(
            "schema",
            "cacheKey",
            "layout",
            "source",
            "selectedExtensions",
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

  private record ValidatedTarGz(
      File archive, PublicTarGzArchivePreflight.Inspection inspection) {}

  private record ExtractedTarGz(
      File root, PublicTarGzArchivePreflight.Inspection inspection) {}

  private record ExtensionArchiveSource(
      String assetName,
      File archive,
      File root,
      Properties manifest,
      String product,
      String expectedSha256,
      Long expectedBytes,
      String sqlName,
      String target) {}

  private record ExtensionRuntimeArtifact(
      String sqlName,
      boolean createsExtension,
      String nativeModuleStem,
      String sharedPreload,
      List<String> runtimeFiles,
      String staticSymbolPrefix,
      List<StaticSymbolAlias> staticSymbolAliases,
      List<String> archiveTargets,
      List<String> dependencyArchives) {}

  private record StaticRegistryModule(
      String moduleStem,
      String symbolPrefix,
      List<String> sqlSymbols,
      Map<String, String> symbolAliases) {}

  private record StaticSymbolAlias(String sqlSymbol, String linkedSymbol) {}

  private record ParsedSqlLiteral(String value, String remainder) {}

  private record MobileStaticArchive(String target, String relativePath) {}

  private record MobileStaticDependencyArchive(String target, String name, String relativePath) {}
}
