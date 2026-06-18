package dev.oliphaunt.android;

import java.lang.reflect.Method;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import org.gradle.api.GradleException;
import org.gradle.api.Plugin;
import org.gradle.api.Project;
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
        .getAssetBaseUrl()
        .convention(
            extension
                .getLiboliphauntVersion()
                .map(
                    version ->
                        "https://github.com/f0rr0/oliphaunt/releases/download/liboliphaunt-native-v"
                            + version));
    extension
        .getExtensions()
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
    Provider<Directory> resolvedRoot =
        project.getLayout().getBuildDirectory().dir("oliphaunt/release-assets");

    TaskProvider<ResolveOliphauntAndroidAssetsTask> resolve =
        project
            .getTasks()
            .register(
                "resolveOliphauntAndroidAssets",
                ResolveOliphauntAndroidAssetsTask.class,
                task -> {
                  task.getVersion().set(extension.getLiboliphauntVersion());
                  task.getAssetBaseUrl().set(extension.getAssetBaseUrl());
                  task.getSelectedExtensions().set(extension.getExtensions());
                  task.getExtensionVersions().set(extension.getExtensionVersions());
                  task.getSelectedAbis().set(extension.getAndroidAbis());
                  task.getAssetCacheDir().set(resolvedRoot.map(dir -> dir.dir("cache")));
                  task.getRuntimeResourcesDir().set(resolvedRoot.map(dir -> dir.dir("runtime-resources")));
                  task.getJniLibsDir().set(resolvedRoot.map(dir -> dir.dir("jniLibs")));
                  task.getExtensionArchivesDir().set(resolvedRoot.map(dir -> dir.dir("extensionArchives")));
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
            ignored -> configureAndroid(project, assetRoot, jniRoot, prepareAssets, prepareJniLibs));
    project
        .getPluginManager()
        .withPlugin(
            "com.android.library",
            ignored -> configureAndroid(project, assetRoot, jniRoot, prepareAssets, prepareJniLibs));
  }

  private static void configureAndroid(
      Project project,
      Provider<Directory> assetRoot,
      Provider<Directory> jniRoot,
      TaskProvider<Sync> prepareAssets,
      TaskProvider<Sync> prepareJniLibs) {
    Object android = project.getExtensions().findByName("android");
    if (android == null) {
      throw new GradleException("dev.oliphaunt.android requires the Android application or library plugin");
    }
    Object sourceSets = invoke(android, "getSourceSets");
    Object main = invoke(sourceSets, "getByName", "main");
    invoke(invoke(main, "getAssets"), "srcDir", assetRoot.get().getAsFile());
    invoke(invoke(main, "getJniLibs"), "srcDir", jniRoot.get().getAsFile());
    project
        .getTasks()
        .matching(task -> task.getName().equals("preBuild"))
        .configureEach(
            task -> {
              task.dependsOn(prepareAssets);
              task.dependsOn(prepareJniLibs);
            });
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
