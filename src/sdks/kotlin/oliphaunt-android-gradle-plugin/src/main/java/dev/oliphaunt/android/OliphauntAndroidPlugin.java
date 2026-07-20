package dev.oliphaunt.android;

import java.lang.reflect.Method;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import org.gradle.api.GradleException;
import org.gradle.api.Plugin;
import org.gradle.api.Project;
import org.gradle.api.artifacts.Configuration;
import org.gradle.api.file.Directory;
import org.gradle.api.provider.Provider;
import org.gradle.api.tasks.Sync;
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

    Provider<Directory> assetRoot =
        project.getLayout().getBuildDirectory().dir("generated/oliphaunt-android-assets");
    Provider<Directory> jniRoot =
        project.getLayout().getBuildDirectory().dir("generated/oliphaunt-android-jniLibs");
    Provider<Directory> extensionJniRoot =
        project
            .getLayout()
            .getBuildDirectory()
            .dir("generated/oliphaunt-android-extension-jniLibs");
    Provider<Directory> resolvedRoot =
        project.getLayout().getBuildDirectory().dir("oliphaunt/resolved-artifacts");
    Configuration runtimeArtifacts =
        project
            .getConfigurations()
            .create(
                "oliphauntAndroidRuntimeArtifacts",
                configuration -> {
                  configuration.setCanBeConsumed(false);
                  configuration.setCanBeResolved(true);
                  configuration.setDescription("Oliphaunt Android runtime artifact files resolved from Maven.");
                });
    Configuration extensionArtifacts =
        project
            .getConfigurations()
            .create(
                "oliphauntAndroidExtensionArtifacts",
                configuration -> {
                  configuration.setCanBeConsumed(false);
                  configuration.setCanBeResolved(true);
                  configuration.setDescription("Oliphaunt Android extension artifact files resolved from Maven.");
                });
    Configuration icuArtifacts =
        project
            .getConfigurations()
            .create(
                "oliphauntAndroidIcuArtifacts",
                configuration -> {
                  configuration.setCanBeConsumed(false);
                  configuration.setCanBeResolved(true);
                  configuration.setDescription("Optional Oliphaunt Android ICU data artifact resolved from Maven.");
                });

    project.afterEvaluate(ignored -> addDefaultArtifactDependencies(project, extension, runtimeArtifacts, extensionArtifacts, icuArtifacts));

    TaskProvider<ResolveOliphauntAndroidAssetsTask> resolve =
        project
            .getTasks()
            .register(
                "resolveOliphauntAndroidAssets",
                ResolveOliphauntAndroidAssetsTask.class,
                task -> {
                  task.getVersion().set(extension.getLiboliphauntVersion());
                  task.getSelectedExtensions().set(extension.getSelectedExtensions());
                  task.getExtensionOwnerVersions()
                      .set(
                          project.provider(
                              () ->
                                  OliphauntExtensionCatalog.ownerVersions(
                                      extension.getSelectedExtensions().get(),
                                      extension.getExtensionVersions().get(),
                                      extension.getLiboliphauntVersion().get())));
                  task.getIcu().set(extension.getIcu());
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
                "linkOliphauntAndroidExtensions",
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

    TaskProvider<Sync> prepareAssets =
        project
            .getTasks()
            .register(
                "prepareOliphauntAndroidAssets",
                Sync.class,
                task -> {
                  task.dependsOn(resolve);
                  task.from(resolve.flatMap(ResolveOliphauntAndroidAssetsTask::getRuntimeResourcesDir));
                  task.into(assetRoot);
                });
    TaskProvider<Sync> prepareJniLibs =
        project
            .getTasks()
            .register(
                "prepareOliphauntAndroidJniLibs",
                Sync.class,
                task -> {
                  task.dependsOn(resolve);
                  task.from(resolve.flatMap(ResolveOliphauntAndroidAssetsTask::getJniLibsDir));
                  task.into(jniRoot);
                });

    project
        .getPluginManager()
        .withPlugin(
            "com.android.application",
            ignored ->
                configureAndroid(
                    project,
                    assetRoot,
                    jniRoot,
                    extensionJniRoot,
                    prepareAssets,
                    prepareJniLibs,
                    linkExtensions));
    project
        .getPluginManager()
        .withPlugin(
            "com.android.library",
            ignored ->
                configureAndroid(
                    project,
                    assetRoot,
                    jniRoot,
                    extensionJniRoot,
                    prepareAssets,
                    prepareJniLibs,
                    linkExtensions));
  }

  private static void configureAndroid(
      Project project,
      Provider<Directory> assetRoot,
      Provider<Directory> jniRoot,
      Provider<Directory> extensionJniRoot,
      TaskProvider<Sync> prepareAssets,
      TaskProvider<Sync> prepareJniLibs,
      TaskProvider<LinkOliphauntAndroidExtensionsTask> linkExtensions) {
    Object android = project.getExtensions().findByName("android");
    if (android == null) {
      throw new GradleException("dev.oliphaunt.android requires the Android application or library plugin");
    }
    Object sourceSets = invoke(android, "getSourceSets");
    Object main = invoke(sourceSets, "getByName", "main");
    invoke(invoke(main, "getAssets"), "srcDir", assetRoot.get().getAsFile());
    invoke(invoke(main, "getJniLibs"), "srcDir", jniRoot.get().getAsFile());
    invoke(invoke(main, "getJniLibs"), "srcDir", extensionJniRoot);
    Object androidComponents = project.getExtensions().findByName("androidComponents");
    if (androidComponents == null) {
      throw new GradleException(
          "dev.oliphaunt.android requires an Android Gradle Plugin version exposing androidComponents");
    }
    setNdkDirectoryProvider(
        linkExtensions, invoke(invoke(androidComponents, "getSdkComponents"), "getNdkDirectory"));
    project
        .getTasks()
        .matching(task -> task.getName().equals("preBuild"))
        .configureEach(
            task -> {
              task.dependsOn(prepareAssets);
              task.dependsOn(prepareJniLibs);
              task.dependsOn(linkExtensions);
            });
  }

  @SuppressWarnings("unchecked")
  private static void setNdkDirectoryProvider(
      TaskProvider<LinkOliphauntAndroidExtensionsTask> task, Object candidate) {
    if (!(candidate instanceof Provider<?>)) {
      throw new GradleException(
          "Android Gradle Plugin sdkComponents.ndkDirectory is not a Gradle Provider");
    }
    Provider<Directory> provider = (Provider<Directory>) candidate;
    task.configure(link -> link.getNdkDirectory().set(provider));
  }

  private static Object invoke(Object target, String method, Object... args) {
    Method candidate = null;
    for (Method methodCandidate : target.getClass().getMethods()) {
      if (methodCandidate.getName().equals(method) && methodCandidate.getParameterCount() == args.length) {
        candidate = methodCandidate;
        break;
      }
    }
    if (candidate == null) {
      throw new GradleException("Android Gradle Plugin API no longer exposes " + method + " on " + target.getClass());
    }
    try {
      return candidate.invoke(target, args);
    } catch (ReflectiveOperationException error) {
      throw new GradleException("failed to call Android Gradle Plugin API " + method, error);
    }
  }

  private static void addDefaultArtifactDependencies(
      Project project,
      OliphauntAndroidExtension extension,
      Configuration runtimeArtifacts,
      Configuration extensionArtifacts,
      Configuration icuArtifacts) {
    String runtimeVersion = extension.getLiboliphauntVersion().get();
    project
        .getDependencies()
        .add(runtimeArtifacts.getName(), "dev.oliphaunt.runtime:liboliphaunt-runtime-resources:" + runtimeVersion + "@tar.gz");
    for (String abi : extension.getAndroidAbis().get()) {
      String artifact = switch (abi) {
        case "arm64-v8a" -> "liboliphaunt-android-arm64-v8a";
        case "x86_64" -> "liboliphaunt-android-x86_64";
        default -> throw new GradleException("Oliphaunt Android runtime artifacts are published for arm64-v8a and x86_64, got " + abi);
      };
      project.getDependencies().add(runtimeArtifacts.getName(), "dev.oliphaunt.runtime:" + artifact + ":" + runtimeVersion + "@tar.gz");
    }
    if (extension.getIcu().get()) {
      project
          .getDependencies()
          .add(icuArtifacts.getName(), "dev.oliphaunt.runtime:oliphaunt-icu:" + runtimeVersion + "@tar.gz");
    }
    List<OliphauntExtensionCatalog.Owner> extensionOwners =
        OliphauntExtensionCatalog.resolveOwners(
            extension.getSelectedExtensions().get(),
            extension.getExtensionVersions().get(),
            runtimeVersion);
    for (OliphauntExtensionCatalog.Owner owner : extensionOwners) {
      for (String abi : extension.getAndroidAbis().get()) {
        project
            .getDependencies()
            .add(
                extensionArtifacts.getName(),
                owner.mavenGroup()
                    + ":"
                    + owner.mavenArtifact()
                    + "-"
                    + androidTarget(abi)
                    + ":"
                    + owner.version()
                    + "@tar.gz");
      }
    }
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
