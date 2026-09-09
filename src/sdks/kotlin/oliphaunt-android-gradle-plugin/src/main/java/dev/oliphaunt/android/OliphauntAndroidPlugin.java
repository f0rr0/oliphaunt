package dev.oliphaunt.android;

import com.android.build.api.variant.AndroidComponentsExtension;
import com.android.build.api.variant.Variant;
import org.gradle.api.Action;
import org.gradle.api.artifacts.result.ResolvedComponentResult;
import org.gradle.api.artifacts.result.ResolvedDependencyResult;
import java.util.ArrayDeque;
import java.util.HashSet;
import java.util.TreeSet;
import java.util.TreeMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import org.gradle.api.GradleException;
import org.gradle.api.Plugin;
import org.gradle.api.Project;
import org.gradle.api.artifacts.Configuration;
import org.gradle.api.file.Directory;
import org.gradle.api.provider.Provider;
import org.gradle.api.tasks.TaskProvider;

public final class OliphauntAndroidPlugin implements Plugin<Project> {
  @Override
  public void apply(Project project) {
    OliphauntAndroidExtension extension =
        project.getExtensions().create("oliphaunt", OliphauntAndroidExtension.class);
    String defaultVersion = defaultLiboliphauntVersion();
    extension
        .getLiboliphauntVersion()
        .convention(
            project
                .getProviders()
                .gradleProperty("oliphauntLiboliphauntVersion")
                .orElse(project.getProviders().environmentVariable("OLIPHAUNT_LIBOLIPHAUNT_VERSION"))
                .orElse(defaultVersion));
    extension
        .getIcu()
        .convention(
            project
                .getProviders()
                .gradleProperty("oliphauntIcu")
                .orElse(project.getProviders().environmentVariable("OLIPHAUNT_ANDROID_ICU"))
                .map(OliphauntAndroidPlugin::parseBoolean)
                .orElse(false));
    extension
        .getSelectedExtensions()
        .convention(
            project
                .getProviders()
                .gradleProperty("oliphauntExtensions")
                .orElse(project.getProviders().environmentVariable("OLIPHAUNT_ANDROID_EXTENSIONS"))
                .map(OliphauntAndroidPlugin::parsePortableList)
                .orElse(List.of()));
    extension
        .getExtensionVersions()
        .convention(
            project
                .getProviders()
                .gradleProperty("oliphauntExtensionVersions")
                .orElse(project.getProviders().environmentVariable("OLIPHAUNT_ANDROID_EXTENSION_VERSIONS"))
                .map(OliphauntAndroidPlugin::parseVersionMap)
                .orElse(Map.of()));
    extension
        .getAndroidAbis()
        .convention(
            project
                .getProviders()
                .gradleProperty("oliphauntAndroidAbiFilters")
                .orElse(project.getProviders().gradleProperty("oliphauntAndroidAbis"))
                .orElse(project.getProviders().environmentVariable("OLIPHAUNT_ANDROID_ABI_FILTERS"))
                .map(OliphauntAndroidPlugin::parseAndroidAbis)
                .orElse(List.of("arm64-v8a", "x86_64")));

    for (String plugin : List.of("com.android.application", "com.android.library")) {
      project.getPluginManager().withPlugin(plugin, ignored -> configureAndroid(project, extension));
    }
  }

  @SuppressWarnings({"rawtypes", "unchecked"})
  private static void configureAndroid(Project project, OliphauntAndroidExtension extension) {
    AndroidComponentsExtension components = project.getExtensions().getByType(AndroidComponentsExtension.class);
    components.onVariants(components.selector().all(), (Action<Variant>) variant -> configureVariant(project, extension, components, variant));
  }

  private static void configureVariant(Project project, OliphauntAndroidExtension extension, AndroidComponentsExtension<?, ?, ?> components, Variant variant) {
    String suffix = Character.toUpperCase(variant.getName().charAt(0)) + variant.getName().substring(1);
    Provider<Selection> selection = variant.getRuntimeConfiguration().getIncoming().getResolutionResult().getRootComponent()
        .map(root -> resolvedSelection(root, extension.getSelectedExtensions().get(), extension.getExtensionVersions().get(), extension.getIcu().get()));
    Provider<Directory> extensionJniRoot =
        project
            .getLayout()
            .getBuildDirectory()
            .dir("generated/oliphaunt-android-extension-jniLibs/" + variant.getName());
    Provider<Directory> resolvedRoot =
        project.getLayout().getBuildDirectory().dir("oliphaunt/resolved-artifacts/" + variant.getName());
    Configuration runtimeArtifacts =
        project
            .getConfigurations()
            .create(
                "oliphauntAndroidRuntimeArtifacts" + suffix,
                configuration -> {
                  configuration.setCanBeConsumed(false);
                  configuration.setCanBeResolved(true);
                  configuration.setDescription("Oliphaunt Android runtime artifact files resolved from Maven.");
                });
    Configuration extensionArtifacts =
        project
            .getConfigurations()
            .create(
                "oliphauntAndroidExtensionArtifacts" + suffix,
                configuration -> {
                  configuration.setCanBeConsumed(false);
                  configuration.setCanBeResolved(true);
                  configuration.setDescription("Oliphaunt Android extension artifact files resolved from Maven.");
                });
    Configuration icuArtifacts =
        project
            .getConfigurations()
            .create(
                "oliphauntAndroidIcuArtifacts" + suffix,
                configuration -> {
                  configuration.setCanBeConsumed(false);
                  configuration.setCanBeResolved(true);
                  configuration.setDescription("Optional Oliphaunt Android ICU data artifact resolved from Maven.");
                });

    runtimeArtifacts.defaultDependencies(dependencies -> {
      String version = extension.getLiboliphauntVersion().get();
      dependencies.add(project.getDependencies().create("dev.oliphaunt.runtime:liboliphaunt-runtime-resources-android-datum64:" + version + "@tar.gz"));
      for (String abi : extension.getAndroidAbis().get()) {
        dependencies.add(project.getDependencies().create("dev.oliphaunt.runtime:liboliphaunt-" + androidTarget(abi) + ":" + version + "@tar.gz"));
      }
    });
    extensionArtifacts.defaultDependencies(dependencies -> {
      Selection selected = selection.get();
      for (OliphauntExtensionCatalog.Owner owner : OliphauntExtensionCatalog.resolveOwners(selected.extensions(), selected.versions(), extension.getLiboliphauntVersion().get())) {
        for (String abi : extension.getAndroidAbis().get()) {
          dependencies.add(project.getDependencies().create(owner.mavenGroup() + ":" + owner.mavenArtifact() + "-" + androidTarget(abi) + ":" + owner.version() + "@tar.gz"));
        }
      }
    });
    icuArtifacts.defaultDependencies(dependencies -> {
      if (selection.get().icu()) dependencies.add(project.getDependencies().create("dev.oliphaunt.runtime:oliphaunt-icu:" + extension.getLiboliphauntVersion().get() + "@tar.gz"));
    });

    TaskProvider<ResolveOliphauntAndroidAssetsTask> resolve =
        project
            .getTasks()
            .register(
                "resolveOliphauntAndroidAssets" + suffix,
                ResolveOliphauntAndroidAssetsTask.class,
                task -> {
                  task.getVersion().set(extension.getLiboliphauntVersion());
                  task.getSelectedExtensions().set(selection.map(Selection::extensions));
                  task.getExtensionOwnerVersions()
                      .set(
                          project.provider(
                              () ->
                                  OliphauntExtensionCatalog.ownerVersions(
                                      selection.map(Selection::extensions).get(),
                                      selection.map(Selection::versions).get(),
                                      extension.getLiboliphauntVersion().get())));
                  task.getIcu().set(selection.map(Selection::icu));
                  task.getSelectedAbis().set(extension.getAndroidAbis());
                  task.getRuntimeArtifacts().from(runtimeArtifacts);
                  task.getExtensionArtifacts().from(extensionArtifacts);
                  task.getIcuArtifacts().from(icuArtifacts);
                  task.getRuntimeResourcesDir().set(resolvedRoot.map(dir -> dir.dir("runtime-resources")));
                  task.getJniLibsDir().set(resolvedRoot.map(dir -> dir.dir("jniLibs")));
                  task.getExtensionArchivesDir().set(resolvedRoot.map(dir -> dir.dir("extensionArchives")));
                });

    TaskProvider<LinkOliphauntAndroidExtensionsTask> linkExtensions =
        project
            .getTasks()
            .register(
                "linkOliphauntAndroidExtensions" + suffix,
                LinkOliphauntAndroidExtensionsTask.class,
                task -> {
                  task.setDescription(
                      "Links selected Oliphaunt Android static extensions into a packaged support library.");
                  task.dependsOn(resolve);
                  task.getSelectedAbis().set(extension.getAndroidAbis());
                  task.getRuntimeResourcesDir()
                      .set(resolve.flatMap(ResolveOliphauntAndroidAssetsTask::getRuntimeResourcesDir));
                  task.getJniLibsDir()
                      .set(resolve.flatMap(ResolveOliphauntAndroidAssetsTask::getJniLibsDir));
                  task.getExtensionArchivesDir()
                      .set(resolve.flatMap(ResolveOliphauntAndroidAssetsTask::getExtensionArchivesDir));
                  task.getOutputDirectory().set(extensionJniRoot);
                });


    linkExtensions.configure(task -> task.getNdkDirectory().set(components.getSdkComponents().getNdkDirectory()));
    if (variant.getSources().getAssets() == null || variant.getSources().getJniLibs() == null) {
      throw new GradleException("Oliphaunt requires Android assets and JNI source directories");
    }
    variant.getSources().getAssets().addGeneratedSourceDirectory(resolve, ResolveOliphauntAndroidAssetsTask::getRuntimeResourcesDir);
    variant.getSources().getJniLibs().addGeneratedSourceDirectory(resolve, ResolveOliphauntAndroidAssetsTask::getJniLibsDir);
    variant.getSources().getJniLibs().addGeneratedSourceDirectory(linkExtensions, LinkOliphauntAndroidExtensionsTask::getOutputDirectory);
  }

  private record Selection(List<String> extensions, Map<String, String> versions, boolean icu) implements java.io.Serializable {}

  private static Selection resolvedSelection(ResolvedComponentResult root, List<String> supplied, Map<String, String> suppliedVersions, boolean suppliedIcu) {
    TreeSet<String> selected = new TreeSet<>(supplied);
    TreeMap<String, String> versions = new TreeMap<>(suppliedVersions);
    selected.addAll(OliphauntExtensionCatalog.artifactProductMembers("oliphaunt-extension-contrib-pg18"));
    boolean icu = suppliedIcu;
    var queue = new ArrayDeque<ResolvedComponentResult>();
    var visited = new HashSet<org.gradle.api.artifacts.component.ComponentIdentifier>();
    queue.add(root);
    while (!queue.isEmpty()) {
      ResolvedComponentResult component = queue.remove();
      if (!visited.add(component.getId())) continue;
      var module = component.getModuleVersion();
      if (module != null && module.getGroup().equals("dev.oliphaunt.extensions")) {
        String product = module.getName();
        selected.addAll(OliphauntExtensionCatalog.artifactProductMembers(product));
        String owner = OliphauntExtensionCatalog.releaseProductForArtifactProduct(product);
        String previous = versions.put(owner, module.getVersion());
        if (previous != null && !previous.equals(module.getVersion())) throw new GradleException("conflicting resolved versions for " + owner);
      }
      if (module != null && module.getGroup().equals("dev.oliphaunt.runtime") && module.getName().equals("oliphaunt-icu")) icu = true;
      for (var dependency : component.getDependencies()) {
        if (dependency instanceof ResolvedDependencyResult resolved) queue.add(resolved.getSelected());
      }
    }
    return new Selection(List.copyOf(selected), Map.copyOf(versions), icu);
  }

  private static List<String> parsePortableList(String raw) {
    if (raw == null || raw.isBlank()) {
      return List.of();
    }
    return java.util.Arrays.stream(raw.split(","))
        .map(String::trim)
        .filter(value -> !value.isEmpty())
        .distinct()
        .sorted()
        .peek(
            value -> {
              if (!value.matches("[A-Za-z0-9._-]{1,128}")) {
                throw new GradleException(
                    "Oliphaunt Android extension or selector '"
                        + value
                        + "' must contain only ASCII letters, digits, '.', '_' or '-'");
              }
            })
        .toList();
  }

  private static List<String> parseAndroidAbis(String raw) {
    if (raw == null || raw.isBlank() || raw.trim().equalsIgnoreCase("all")) {
      return List.of("arm64-v8a", "x86_64");
    }
    List<String> values = parsePortableList(raw);
    for (String value : values) {
      String normalized = value.toLowerCase(Locale.ROOT);
      if (!normalized.equals("arm64-v8a") && !normalized.equals("x86_64")) {
        throw new GradleException("Oliphaunt release assets currently publish Android arm64-v8a and x86_64, got " + value);
      }
    }
    return values;
  }

  private static Map<String, String> parseVersionMap(String raw) {
    if (raw == null || raw.isBlank()) {
      return Map.of();
    }
    java.util.LinkedHashMap<String, String> values = new java.util.LinkedHashMap<>();
    for (String item : raw.split(",")) {
      String trimmed = item.trim();
      if (trimmed.isEmpty()) {
        continue;
      }
      String[] parts = trimmed.split("=", 2);
      if (parts.length != 2 || parts[0].isBlank() || parts[1].isBlank()) {
        throw new GradleException("oliphauntExtensionVersions entries must use extension=version, got " + trimmed);
      }
      values.put(parts[0].trim(), parts[1].trim());
    }
    return values;
  }

  private static Boolean parseBoolean(String raw) {
    if (raw == null || raw.isBlank()) {
      return false;
    }
    return switch (raw.trim().toLowerCase(Locale.ROOT)) {
      case "1", "true", "yes", "on" -> true;
      case "0", "false", "no", "off" -> false;
      default -> throw new GradleException("oliphauntIcu must be a boolean value, got " + raw);
    };
  }

  private static String androidTarget(String abi) {
    return switch (abi) {
      case "arm64-v8a" -> "android-arm64-v8a";
      case "x86_64" -> "android-x86_64";
      default -> throw new GradleException("Oliphaunt Android artifacts are published for arm64-v8a and x86_64, got " + abi);
    };
  }

  private static String defaultLiboliphauntVersion() {
    try (java.io.InputStream stream =
        OliphauntAndroidPlugin.class.getResourceAsStream("/dev/oliphaunt/android/liboliphaunt.version")) {
      if (stream == null) {
        throw new GradleException("Oliphaunt Android plugin is missing liboliphaunt.version");
      }
      return new String(stream.readAllBytes(), java.nio.charset.StandardCharsets.UTF_8).trim();
    } catch (java.io.IOException error) {
      throw new GradleException("failed to read embedded liboliphaunt version", error);
    }
  }
}
