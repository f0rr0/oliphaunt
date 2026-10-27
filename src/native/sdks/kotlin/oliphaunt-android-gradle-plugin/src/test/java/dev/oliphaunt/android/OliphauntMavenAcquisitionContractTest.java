package dev.oliphaunt.android;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import org.gradle.api.GradleException;
import org.gradle.api.Project;
import org.gradle.api.artifacts.Configuration;
import org.gradle.testfixtures.ProjectBuilder;
import org.gradle.testfixtures.internal.ProjectBuilderImpl;

/** Real Gradle module resolution against a private local Maven repository. */
final class OliphauntMavenAcquisitionContractTest {
  private OliphauntMavenAcquisitionContractTest() {}

  static void run() throws Exception {
    Path root = Files.createTempDirectory("oliphaunt-maven-acquisition-");
    Project project = null;
    try {
      Path repository = root.resolve("repository");
      for (String target : List.of("android-arm64-v8a", "android-x86_64")) {
        String contrib = "oliphaunt-extension-contrib-pg18-" + target;
        publish(repository, contrib, "4.5.6", "");
        publish(repository, "oliphaunt-extension-postgis-" + target, "3.5.3", "");
        publish(repository, "oliphaunt-extension-postgis-" + target, "3.6.4",
            "<dependencies><dependency><groupId>dev.oliphaunt.extensions</groupId>"
                + "<artifactId>" + contrib + "</artifactId><version>4.5.6</version>"
                + "<type>tar.gz</type><scope>runtime</scope></dependency></dependencies>");
      }
      project = ProjectBuilder.builder()
          .withProjectDir(Files.createDirectories(root.resolve("project")).toFile()).build();
      project.getRepositories().maven(repo -> {
        repo.setUrl(repository.toUri());
        repo.metadataSources(sources -> sources.mavenPom());
      });

      // Today's catalog declares PostGIS -> fuzzystrmatch. The old POM does not.
      Configuration old = resolve(project, "oldCarriers", "3.5.3");
      equal(2, old.getFiles().size(), "old PostGIS must not prefetch today's contrib owner");
      equal(Map.of("oliphaunt-extension-postgis", "3.5.3"),
          versions(old, "3.5.3", "4.5.6"), "old resolved release owners");
      System.out.println("Local Maven acquisition: old PostGIS resolved without contrib");

      Configuration current = resolve(project, "currentCarriers", "3.6.4");
      equal(4, current.getFiles().size(), "both same-ABI transitive contrib carriers");
      equal(Map.of("oliphaunt-extension-postgis", "3.6.4", "liboliphaunt-native", "4.5.6"),
          versions(current, "3.6.4", "4.5.6"), "POM-owned resolved release versions");
      System.out.println("Local Maven acquisition: new PostGIS resolved same-ABI contrib dependencies");
      if (current.getFiles().stream().anyMatch(file -> !file.getName().endsWith(".tar.gz"))) {
        throw new AssertionError("carrier resolution must select tar.gz artifacts, never companion jars");
      }
      try {
        versions(current, "3.6.4", "4.5.7");
        throw new AssertionError("a transitive carrier must retain its frozen runtime pin");
      } catch (GradleException expected) {
        if (!expected.getMessage().contains("must use liboliphaunt version 4.5.7")) throw expected;
      }
    } finally {
      // Real resolution starts Gradle services; ProjectBuilder does not own their shutdown.
      if (project != null) ProjectBuilderImpl.stop(project);
      System.out.println("Local Maven acquisition: Gradle fixture services stopped");
      try (var paths = Files.walk(root)) {
        for (Path path : paths.sorted(Comparator.reverseOrder()).toList()) Files.deleteIfExists(path);
      }
    }
  }

  private static Configuration resolve(Project project, String name, String version) {
    Configuration configuration = project.getConfigurations().create(name);
    configuration.setCanBeConsumed(false);
    configuration.setCanBeResolved(true);
    OliphauntAndroidPlugin.addExtensionArtifactDependencies(project, configuration,
        OliphauntExtensionCatalog.resolveOwners(List.of("postgis"),
            Map.of("oliphaunt-extension-postgis", version), "4.5.6"),
        List.of("arm64-v8a", "x86_64"));
    return configuration;
  }

  private static Map<String, String> versions(
      Configuration configuration, String postgisVersion, String runtimeVersion) {
    return OliphauntAndroidPlugin.resolvedExtensionOwnerVersions(configuration,
        OliphauntExtensionCatalog.resolveOwners(List.of("postgis"),
            Map.of("oliphaunt-extension-postgis", postgisVersion), runtimeVersion), runtimeVersion);
  }

  private static void publish(Path repository, String artifact, String version, String dependencies)
      throws Exception {
    Path directory = repository.resolve("dev/oliphaunt/extensions").resolve(artifact).resolve(version);
    Files.createDirectories(directory);
    String prefix = artifact + "-" + version;
    Files.writeString(directory.resolve(prefix + ".pom"),
        "<project><modelVersion>4.0.0</modelVersion><groupId>dev.oliphaunt.extensions</groupId>"
            + "<artifactId>" + artifact + "</artifactId><version>" + version + "</version>"
            + "<packaging>tar.gz</packaging>" + dependencies + "</project>\n", StandardCharsets.UTF_8);
    Files.writeString(directory.resolve(prefix + ".tar.gz"), prefix, StandardCharsets.UTF_8);
  }

  private static void equal(Object expected, Object actual, String label) {
    if (!expected.equals(actual)) throw new AssertionError(label + ": expected " + expected + ", got " + actual);
  }
}
