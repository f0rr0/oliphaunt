package dev.oliphaunt.android;

import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Properties;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;
import org.gradle.api.GradleException;

final class OliphauntExtensionCatalog {
  private static final String RESOURCE = "/dev/oliphaunt/android/extensions.properties";
  private static final String SCHEMA = "oliphaunt-android-extension-catalog-v1";
  private static final String SQL_NAME_PATTERN = "[A-Za-z0-9._-]{1,128}";
  private static final String VERSION_PATTERN =
      "(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)";
  private static final Map<String, Entry> ENTRIES = loadBundled();

  private OliphauntExtensionCatalog() {}

  static Entry require(String sqlName) {
    Entry entry = ENTRIES.get(sqlName);
    if (entry == null) {
      throw new GradleException("unknown Oliphaunt Android extension SQL name: " + sqlName);
    }
    return entry;
  }

  static List<String> sqlNames() {
    return List.copyOf(ENTRIES.keySet());
  }

  static List<String> releaseProductMembers(String releaseProduct) {
    List<String> members =
        ENTRIES.values().stream()
            .filter(entry -> entry.releaseProduct().equals(releaseProduct))
            .map(Entry::sqlName)
            .sorted()
            .toList();
    if (members.isEmpty()) {
      throw new GradleException(
          "unknown Oliphaunt Android extension release product: " + releaseProduct);
    }
    return members;
  }

  static List<Owner> resolveOwners(
      List<String> requestedSqlNames, Map<String, String> overrides, String runtimeVersion) {
    validateVersion(runtimeVersion, "liboliphaunt runtime");
    LinkedHashSet<String> closure = new LinkedHashSet<>();
    LinkedHashSet<String> visiting = new LinkedHashSet<>();
    for (String sqlName : requestedSqlNames) {
      addClosure(sqlName, closure, visiting);
    }

    TreeMap<String, OwnerBuilder> builders = new TreeMap<>();
    for (String sqlName : closure) {
      Entry entry = require(sqlName);
      String coordinate = entry.mavenCoordinate();
      OwnerBuilder builder = builders.computeIfAbsent(coordinate, ignored -> new OwnerBuilder(entry));
      builder.add(entry);
    }

    Map<String, OwnerBuilder> aliases = new LinkedHashMap<>();
    for (OwnerBuilder builder : builders.values()) {
      for (String alias : builder.aliases()) {
        OwnerBuilder previous = aliases.put(alias, builder);
        if (previous != null && previous != builder) {
          throw new GradleException(
              "generated Oliphaunt extension catalog has ambiguous release-owner alias " + alias);
        }
      }
    }

    Map<OwnerBuilder, Set<String>> overrideValues = new LinkedHashMap<>();
    for (Map.Entry<String, String> override : overrides.entrySet()) {
      String alias = override.getKey().trim();
      String version = override.getValue().trim();
      OwnerBuilder owner = aliases.get(alias);
      if (owner == null) {
        throw new GradleException(
            "oliphauntExtensionVersions key "
                + alias
                + " does not identify a selected extension release owner");
      }
      validateVersion(version, "Oliphaunt extension release owner " + owner.entry.releaseProduct());
      overrideValues.computeIfAbsent(owner, ignored -> new TreeSet<>()).add(version);
    }

    List<Owner> result = new ArrayList<>();
    for (OwnerBuilder builder : builders.values()) {
      Set<String> values = overrideValues.getOrDefault(builder, Set.of());
      if (values.size() > 1) {
        throw new GradleException(
            "conflicting versions "
                + values
                + " were supplied for Oliphaunt extension release owner "
                + builder.entry.releaseProduct());
      }
      String version;
      if (values.isEmpty()) {
        if (!builder.entry.runtimeBound()) {
          throw new GradleException(
              "external Oliphaunt extension release owner "
                  + builder.entry.releaseProduct()
                  + " requires an explicit oliphauntExtensionVersions entry");
        }
        version = runtimeVersion;
      } else {
        version = values.iterator().next();
      }
      if (builder.entry.runtimeBound() && !version.equals(runtimeVersion)) {
        throw new GradleException(
            "runtime-bound Oliphaunt extension release owner "
                + builder.entry.releaseProduct()
                + " must use liboliphaunt version "
                + runtimeVersion
                + ", got "
                + version);
      }
      result.add(builder.build(version));
    }
    return List.copyOf(result);
  }

  static Map<String, String> ownerVersions(
      List<String> requestedSqlNames, Map<String, String> overrides, String runtimeVersion) {
    LinkedHashMap<String, String> result = new LinkedHashMap<>();
    for (Owner owner : resolveOwners(requestedSqlNames, overrides, runtimeVersion)) {
      result.put(owner.releaseProduct(), owner.version());
    }
    return Collections.unmodifiableMap(result);
  }

  static Map<String, Entry> load(InputStream stream) {
    if (stream == null) {
      throw new GradleException("Oliphaunt Android plugin is missing " + RESOURCE);
    }
    Properties properties = new Properties();
    try (stream) {
      properties.load(stream);
    } catch (IOException error) {
      throw new GradleException("failed to read bundled Oliphaunt extension catalog", error);
    }
    if (!SCHEMA.equals(properties.getProperty("schema"))) {
      throw new GradleException("bundled Oliphaunt extension catalog has an unsupported schema");
    }
    String catalogSha256 = required(properties, "catalogSha256");
    if (!catalogSha256.matches("[0-9a-f]{64}")) {
      throw new GradleException("bundled Oliphaunt extension catalog has an invalid digest");
    }

    TreeSet<String> sqlNames = new TreeSet<>();
    for (String key : properties.stringPropertyNames()) {
      if (key.startsWith("extension.") && key.endsWith(".releaseProduct")) {
        sqlNames.add(key.substring("extension.".length(), key.length() - ".releaseProduct".length()));
      }
    }
    if (sqlNames.isEmpty()) {
      throw new GradleException("bundled Oliphaunt extension catalog is empty");
    }

    LinkedHashMap<String, Entry> entries = new LinkedHashMap<>();
    for (String sqlName : sqlNames) {
      if (!sqlName.matches(SQL_NAME_PATTERN)) {
        throw new GradleException("bundled Oliphaunt extension catalog has invalid SQL name " + sqlName);
      }
      String prefix = "extension." + sqlName + ".";
      String releaseProduct = required(properties, prefix + "releaseProduct");
      String mavenGroup = required(properties, prefix + "mavenGroup");
      String mavenArtifact = required(properties, prefix + "mavenArtifact");
      String rawRuntimeBound = required(properties, prefix + "runtimeBound");
      boolean runtimeBound = switch (rawRuntimeBound) {
        case "true" -> true;
        case "false" -> false;
        default ->
            throw new GradleException(
                "bundled Oliphaunt extension catalog has invalid runtimeBound for " + sqlName);
      };
      if (!releaseProduct.matches("oliphaunt-extension-[A-Za-z0-9._-]+")) {
        throw new GradleException(
            "bundled Oliphaunt extension catalog has invalid release product for " + sqlName);
      }
      if (!mavenGroup.matches("[A-Za-z0-9_.-]+")
          || !mavenArtifact.matches("[A-Za-z0-9_.-]+")) {
        throw new GradleException(
            "bundled Oliphaunt extension catalog has invalid Maven coordinates for " + sqlName);
      }
      List<String> dependencies = portableList(properties.getProperty(prefix + "dependencies", ""));
      entries.put(
          sqlName,
          new Entry(
              sqlName,
              releaseProduct,
              mavenGroup,
              mavenArtifact,
              runtimeBound,
              dependencies));
    }
    for (Entry entry : entries.values()) {
      for (String dependency : entry.dependencies()) {
        if (!entries.containsKey(dependency)) {
          throw new GradleException(
              "bundled Oliphaunt extension catalog entry "
                  + entry.sqlName()
                  + " references unknown dependency "
                  + dependency);
        }
      }
    }
    return Collections.unmodifiableMap(entries);
  }

  private static Map<String, Entry> loadBundled() {
    return load(OliphauntExtensionCatalog.class.getResourceAsStream(RESOURCE));
  }

  private static void addClosure(
      String sqlName, LinkedHashSet<String> closure, LinkedHashSet<String> visiting) {
    if (closure.contains(sqlName)) {
      return;
    }
    if (!visiting.add(sqlName)) {
      throw new GradleException(
          "cyclic generated Oliphaunt extension dependency involving " + sqlName);
    }
    Entry entry = require(sqlName);
    for (String dependency : entry.dependencies()) {
      addClosure(dependency, closure, visiting);
    }
    visiting.remove(sqlName);
    closure.add(sqlName);
  }

  private static List<String> portableList(String raw) {
    if (raw == null || raw.isBlank()) {
      return List.of();
    }
    List<String> values =
        Arrays.stream(raw.split(","))
            .map(String::trim)
            .filter(value -> !value.isEmpty())
            .distinct()
            .sorted()
            .toList();
    for (String value : values) {
      if (!value.matches(SQL_NAME_PATTERN)) {
        throw new GradleException(
            "bundled Oliphaunt extension catalog has invalid dependency " + value);
      }
    }
    return values;
  }

  private static String required(Properties properties, String key) {
    String value = properties.getProperty(key);
    if (value == null || value.isBlank()) {
      throw new GradleException("bundled Oliphaunt extension catalog is missing " + key);
    }
    return value.trim();
  }

  private static void validateVersion(String version, String label) {
    if (version == null || version.isBlank() || !version.matches(VERSION_PATTERN)) {
      throw new GradleException(
          label
              + " version must be canonical stable SemVer X.Y.Z, got "
              + version);
    }
  }

  record Entry(
      String sqlName,
      String releaseProduct,
      String mavenGroup,
      String mavenArtifact,
      boolean runtimeBound,
      List<String> dependencies) {
    String mavenCoordinate() {
      return mavenGroup + ":" + mavenArtifact;
    }
  }

  record Owner(
      String releaseProduct,
      String mavenGroup,
      String mavenArtifact,
      boolean runtimeBound,
      String version,
      List<String> members) {}

  private static final class OwnerBuilder {
    private final Entry entry;
    private final TreeSet<String> members = new TreeSet<>();

    private OwnerBuilder(Entry entry) {
      this.entry = entry;
    }

    private void add(Entry candidate) {
      if (!entry.releaseProduct().equals(candidate.releaseProduct())
          || !entry.mavenCoordinate().equals(candidate.mavenCoordinate())
          || entry.runtimeBound() != candidate.runtimeBound()) {
        throw new GradleException(
            "generated Oliphaunt extension catalog has inconsistent release-owner metadata for "
                + entry.mavenCoordinate());
      }
      members.add(candidate.sqlName());
    }

    private Set<String> aliases() {
      LinkedHashSet<String> aliases = new LinkedHashSet<>();
      aliases.add(entry.releaseProduct());
      aliases.add(entry.mavenArtifact());
      aliases.add(entry.mavenCoordinate());
      aliases.addAll(members);
      return aliases;
    }

    private Owner build(String version) {
      return new Owner(
          entry.releaseProduct(),
          entry.mavenGroup(),
          entry.mavenArtifact(),
          entry.runtimeBound(),
          version,
          List.copyOf(members));
    }
  }
}
