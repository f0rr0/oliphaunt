package dev.oliphaunt.android;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
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
import java.util.Comparator;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Properties;
import java.util.Set;
import java.util.TreeSet;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import org.gradle.api.DefaultTask;
import org.gradle.api.GradleException;
import org.gradle.api.file.DirectoryProperty;
import org.gradle.api.provider.ListProperty;
import org.gradle.api.tasks.Input;
import org.gradle.api.tasks.InputDirectory;
import org.gradle.api.tasks.Internal;
import org.gradle.api.tasks.OutputDirectory;
import org.gradle.api.tasks.PathSensitive;
import org.gradle.api.tasks.PathSensitivity;
import org.gradle.api.tasks.TaskAction;
import org.gradle.api.tasks.UntrackedTask;

/** Links selected Android extension archives into the support library loaded by the SDK. */
@UntrackedTask(
    because =
        "the native output depends on the complete selected Android NDK toolchain, and native linking must never reuse stale output across NDK revisions")
public abstract class LinkOliphauntAndroidExtensionsTask extends DefaultTask {
  private static final String HEADER_RESOURCE = "/dev/oliphaunt/android/oliphaunt.h";
  private static final String LIBRARY_NAME = "liboliphaunt_extensions.so";
  private static final int ANDROID_MIN_SDK = 24;
  private static final int MAX_TOOL_OUTPUT_BYTES = 4 * 1024 * 1024;
  private static final int MAX_REGISTRY_MANIFEST_BYTES = 1024 * 1024;
  private static final long MAX_TOOL_RUNTIME_SECONDS = 300;

  @Input
  public abstract ListProperty<String> getSelectedAbis();

  @InputDirectory
  @PathSensitive(PathSensitivity.RELATIVE)
  public abstract DirectoryProperty getRuntimeResourcesDir();

  @InputDirectory
  @PathSensitive(PathSensitivity.RELATIVE)
  public abstract DirectoryProperty getJniLibsDir();

  @InputDirectory
  @PathSensitive(PathSensitivity.RELATIVE)
  public abstract DirectoryProperty getExtensionArchivesDir();

  @Internal
  public abstract DirectoryProperty getNdkDirectory();

  @OutputDirectory
  public abstract DirectoryProperty getOutputDirectory();

  @Input
  public String getBundledHeaderSha256() {
    try (InputStream input = getClass().getResourceAsStream(HEADER_RESOURCE)) {
      if (input == null) {
        throw new GradleException("Oliphaunt Android plugin is missing " + HEADER_RESOURCE);
      }
      return sha256(input.readAllBytes());
    } catch (IOException error) {
      throw new GradleException("read bundled Oliphaunt C header", error);
    }
  }

  @TaskAction
  public void link() {
    Path output = getOutputDirectory().get().getAsFile().toPath();
    deleteTree(output);
    createDirectories(output);
    Registry registry = registry();
    if (registry.modules().isEmpty()) {
      return;
    }

    Toolchain toolchain = toolchain(requiredNdkDirectory());
    Path include = getTemporaryDir().toPath().resolve("include");
    deleteTree(include);
    createDirectories(include);
    Path header = include.resolve("oliphaunt.h");
    copyBundledHeader(header);

    List<String> abis = canonicalAbis(getSelectedAbis().get());
    for (String abi : abis) {
      linkAbi(toolchain, include, registry, abi, output);
    }
  }

  private void linkAbi(
      Toolchain toolchain, Path include, Registry registry, String abi, Path outputRoot) {
    String target = androidTarget(abi);
    String compilerTarget = compilerTarget(abi);
    Path baseLibrary =
        getJniLibsDir().get().getAsFile().toPath().resolve(abi).resolve("liboliphaunt.so");
    requireRegularFile(baseLibrary, "liboliphaunt runtime for " + abi);

    Path archiveAbiRoot =
        getExtensionArchivesDir()
            .get()
            .getAsFile()
            .toPath()
            .resolve("android-" + abi);
    List<Path> extensionArchives = new ArrayList<>();
    TreeSet<Path> expectedArchives = new TreeSet<>();
    for (String stem : registry.modules()) {
      Path archive =
          archiveAbiRoot
              .resolve("extensions")
              .resolve(stem)
              .resolve("liboliphaunt_extension_" + stem + ".a");
      requireRegularFile(archive, "selected Android extension archive " + stem + " for " + abi);
      extensionArchives.add(archive);
      expectedArchives.add(archive.toAbsolutePath().normalize());
    }

    List<Path> dependencyArchives = new ArrayList<>();
    for (DependencyArchive dependency : registry.dependencyArchives()) {
      if (!target.equals(dependency.target())) {
        continue;
      }
      String basename = Path.of(dependency.relativePath()).getFileName().toString();
      Path archive =
          archiveAbiRoot.resolve("dependencies").resolve(dependency.name()).resolve(basename);
      requireRegularFile(
          archive,
          "selected Android static dependency " + dependency.name() + " for " + abi);
      if (expectedArchives.add(archive.toAbsolutePath().normalize())) {
        dependencyArchives.add(archive);
      }
    }
    requireExactArchiveFiles(archiveAbiRoot, expectedArchives, abi);

    Path abiOutput = outputRoot.resolve(abi);
    createDirectories(abiOutput);
    Path abiTemporary = getTemporaryDir().toPath().resolve("link").resolve(abi);
    deleteTree(abiTemporary);
    createDirectories(abiTemporary);
    Path registryObject = abiTemporary.resolve("oliphaunt_static_registry.o");
    Path temporary = abiOutput.resolve(LIBRARY_NAME + ".partial");
    Path destination = abiOutput.resolve(LIBRARY_NAME);
    deleteIfExists(temporary);
    deleteIfExists(destination);

    List<String> compile = new ArrayList<>();
    compile.add(toolchain.clang().toString());
    compile.add("--target=" + compilerTarget + ANDROID_MIN_SDK);
    compile.add("--sysroot=" + toolchain.sysroot());
    compile.add("-std=c11");
    compile.add("-fPIC");
    compile.add("-O2");
    compile.add("-g0");
    compile.add("-DANDROID");
    compile.add("-D_FORTIFY_SOURCE=2");
    compile.add("-fstack-protector-strong");
    compile.add("-I" + include);
    compile.add("-c");
    compile.add(registry.source().toString());
    compile.add("-o");
    compile.add(registryObject.toString());
    runTool(compile, "compile the Oliphaunt Android static registry for " + abi);

    List<String> command = new ArrayList<>();
    command.add(toolchain.clangxx().toString());
    command.add("--target=" + compilerTarget + ANDROID_MIN_SDK);
    command.add("--sysroot=" + toolchain.sysroot());
    command.add("-shared");
    command.add("-static-libstdc++");
    command.add("-Wl,--build-id=sha1");
    command.add("-Wl,--no-undefined");
    command.add("-Wl,--fatal-warnings");
    command.add("-Wl,-z,max-page-size=16384");
    command.add("-Wl,-soname," + LIBRARY_NAME);
    command.add("-o");
    command.add(temporary.toString());
    command.add(registryObject.toString());
    command.add("-Wl,--start-group");
    command.add("-Wl,--whole-archive");
    extensionArchives.stream().map(Path::toString).forEach(command::add);
    command.add("-Wl,--no-whole-archive");
    dependencyArchives.stream().map(Path::toString).forEach(command::add);
    command.add("-Wl,--end-group");
    command.add("-Wl,--no-as-needed");
    command.add(baseLibrary.toString());
    command.add("-Wl,--as-needed");
    command.add("-latomic");
    command.add("-lm");
    runTool(command, "link selected Oliphaunt Android extensions for " + abi);
    runTool(
        List.of(toolchain.strip().toString(), "--strip-unneeded", temporary.toString()),
        "strip selected Oliphaunt Android extensions for " + abi);
    validateLinkedLibrary(toolchain, temporary, abi);
    try {
      Files.move(temporary, destination, StandardCopyOption.ATOMIC_MOVE);
    } catch (java.nio.file.AtomicMoveNotSupportedException ignored) {
      try {
        Files.move(temporary, destination);
      } catch (IOException error) {
        throw new GradleException("install linked Oliphaunt Android extension library", error);
      }
    } catch (IOException error) {
      throw new GradleException("install linked Oliphaunt Android extension library", error);
    }
  }

  private Registry registry() {
    Path root = getRuntimeResourcesDir().get().getAsFile().toPath();
    Path nested = root.resolve("oliphaunt");
    Path resourceRoot = Files.isDirectory(nested) ? nested : root;
    Path registryRoot = resourceRoot.resolve("static-registry");
    Path manifestFile = registryRoot.resolve("manifest.properties");
    if (!Files.exists(manifestFile, LinkOption.NOFOLLOW_LINKS)) {
      requireNoFilesWithoutRegistry(
          registryRoot, "runtime static-registry directory without manifest.properties");
      requireNoFilesWithoutRegistry(
          getExtensionArchivesDir().get().getAsFile().toPath(),
          "selected Android extension archives without a static-registry manifest");
      return new Registry(List.of(), List.of(), registryRoot.resolve("oliphaunt_static_registry.c"));
    }
    Properties manifest = readProperties(manifestFile);
    requireProperty(manifest, "packageLayout", "oliphaunt-static-registry-v1", manifestFile);
    requireProperty(manifest, "abiVersion", "1", manifestFile);
    String state = requiredProperty(manifest, "state", manifestFile);
    List<String> modules = canonicalPortableList(manifest.getProperty("modules", ""), "modules");
    if (modules.isEmpty()) {
      requireProperty(manifest, "state", "not-required", manifestFile);
      Set<String> emptyRegistryProperties =
          Set.of(
              "packageLayout",
              "abiVersion",
              "state",
              "source",
              "registeredExtensions",
              "pendingExtensions",
              "nativeModuleStems",
              "modules",
              "archiveTargets",
              "dependencyArchiveTargets",
              "dependencyArchives");
      if (!manifest.stringPropertyNames().equals(emptyRegistryProperties)) {
        throw new GradleException(
            manifestFile
                + " empty registry must contain exactly "
                + new TreeSet<>(emptyRegistryProperties)
                + ", got "
                + new TreeSet<>(manifest.stringPropertyNames()));
      }
      for (String key :
          List.of(
              "source",
              "registeredExtensions",
              "pendingExtensions",
              "nativeModuleStems",
              "modules",
              "archiveTargets",
              "dependencyArchiveTargets",
              "dependencyArchives")) {
        requirePropertyAllowingEmpty(manifest, key, "", manifestFile);
      }
      requireNoFilesExcept(
          registryRoot,
          Set.of(manifestFile.toAbsolutePath().normalize()),
          "empty runtime static-registry directory");
      requireNoFilesWithoutRegistry(
          getExtensionArchivesDir().get().getAsFile().toPath(),
          "selected Android extension archives for an empty static registry");
      return new Registry(List.of(), List.of(), registryRoot.resolve("oliphaunt_static_registry.c"));
    }
    if (!"complete".equals(state)) {
      throw new GradleException(manifestFile + " must declare state=complete for native modules");
    }
    requireProperty(manifest, "source", "oliphaunt_static_registry.c", manifestFile);
    Path source = registryRoot.resolve("oliphaunt_static_registry.c");
    requireRegularFile(source, "generated Oliphaunt static registry source");
    List<String> selectedAbis = canonicalAbis(getSelectedAbis().get());
    if (selectedAbis.isEmpty()) {
      throw new GradleException(
          "native Oliphaunt Android extensions require at least one selected Android ABI");
    }
    List<String> selectedTargets =
        selectedAbis.stream()
            .map(LinkOliphauntAndroidExtensionsTask::androidTarget)
            .sorted()
            .toList();
    List<String> archiveTargets =
        canonicalAndroidTargets(
            requiredProperty(manifest, "archiveTargets", manifestFile), "archiveTargets");
    if (!archiveTargets.equals(selectedTargets)) {
      throw new GradleException(
          manifestFile
              + " archiveTargets must exactly match selected Android ABIs; expected="
              + selectedTargets
              + ", got="
              + archiveTargets);
    }
    for (String module : modules) {
      String extension =
          requiredProperty(manifest, "module." + module + ".extension", manifestFile);
      if (!extension.matches("[A-Za-z0-9._-]{1,128}")) {
        throw new GradleException(manifestFile + " has invalid extension for module " + module);
      }
      String prefix =
          requiredProperty(manifest, "module." + module + ".symbolPrefix", manifestFile);
      if (!prefix.matches("[A-Za-z_][A-Za-z0-9_]*")) {
        throw new GradleException(manifestFile + " has invalid symbolPrefix for module " + module);
      }
      List<String> moduleTargets =
          canonicalAndroidTargets(
              requiredProperty(
                  manifest, "module." + module + ".archiveTargets", manifestFile),
              "archiveTargets for module " + module);
      if (!moduleTargets.equals(selectedTargets)) {
        throw new GradleException(
            manifestFile
                + " module "
                + module
                + " archiveTargets must exactly match selected Android ABIs");
      }
      for (String target : moduleTargets) {
        String expectedPath =
            "archives/"
                + target
                + "/extensions/"
                + module
                + "/liboliphaunt_extension_"
                + module
                + ".a";
        requireProperty(
            manifest, "module." + module + ".archive." + target, expectedPath, manifestFile);
      }
    }

    List<String> dependencyNames =
        canonicalPortableList(
            manifest.getProperty("dependencyArchives", ""), "dependencyArchives");
    List<DependencyArchive> dependencies = new ArrayList<>();
    TreeSet<String> dependencyTargets = new TreeSet<>();
    for (String dependency : dependencyNames) {
      List<String> targets =
          canonicalAndroidTargets(
              requiredProperty(
                  manifest, "dependency." + dependency + ".archiveTargets", manifestFile),
              "archiveTargets for dependency " + dependency);
      // Dependencies are target-scoped: a producer may need one only on a subset of ABIs.
      if (!selectedTargets.containsAll(targets)) {
        throw new GradleException(
            manifestFile
                + " dependency "
                + dependency
                + " declares an unselected Android target");
      }
      for (String target : targets) {
        String path =
            requiredProperty(
                manifest, "dependency." + dependency + ".archive." + target, manifestFile);
        dependencies.add(registryDependencyArchive(target, dependency, path, manifestFile));
        dependencyTargets.add(target);
      }
    }
    List<String> declaredDependencyTargets =
        canonicalAndroidTargets(
            manifest.getProperty("dependencyArchiveTargets", ""),
            "dependencyArchiveTargets");
    if (!declaredDependencyTargets.equals(List.copyOf(dependencyTargets))) {
      throw new GradleException(
          manifestFile
              + " dependencyArchiveTargets do not exactly match dependency archive declarations");
    }
    dependencies.sort(
        Comparator.comparing(DependencyArchive::target)
            .thenComparing(DependencyArchive::name)
            .thenComparing(DependencyArchive::relativePath));
    return new Registry(modules, List.copyOf(dependencies), source);
  }

  void validateRegistryForContractTest() {
    registry();
  }

  private static void requireExactArchiveFiles(
      Path abiRoot, Set<Path> expected, String abi) {
    TreeSet<Path> actual = new TreeSet<>();
    if (!Files.isDirectory(abiRoot, LinkOption.NOFOLLOW_LINKS)) {
      throw new GradleException("missing selected Android extension archive root for " + abi);
    }
    try (var paths = Files.walk(abiRoot)) {
      for (Path path : paths.toList()) {
        BasicFileAttributes attributes =
            Files.readAttributes(path, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
        if (attributes.isSymbolicLink()
            || (!attributes.isDirectory() && !attributes.isRegularFile())) {
          throw new GradleException(
              "selected Android extension archives contain a symlink or special file: " + path);
        }
        if (attributes.isRegularFile()) {
          actual.add(path.toAbsolutePath().normalize());
        }
      }
    } catch (GradleException error) {
      throw error;
    } catch (IOException error) {
      throw new GradleException("inspect selected Android extension archives for " + abi, error);
    }
    if (!actual.equals(new TreeSet<>(expected))) {
      TreeSet<Path> missing = new TreeSet<>(expected);
      missing.removeAll(actual);
      TreeSet<Path> unexpected = new TreeSet<>(actual);
      unexpected.removeAll(expected);
      throw new GradleException(
          "selected Android extension archives for "
              + abi
              + " are not exact; missing="
              + missing
              + ", unexpected="
              + unexpected);
    }
  }

  private static void requireNoFilesWithoutRegistry(Path root, String label) {
    requireNoFilesExcept(root, Set.of(), label);
  }

  private static void requireNoFilesExcept(Path root, Set<Path> allowedFiles, String label) {
    if (!Files.exists(root, LinkOption.NOFOLLOW_LINKS)) {
      return;
    }
    try (var paths = Files.walk(root)) {
      for (Path path : paths.toList()) {
        BasicFileAttributes attributes =
            Files.readAttributes(path, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
        if (attributes.isSymbolicLink()
            || (!attributes.isDirectory() && !attributes.isRegularFile())) {
          throw new GradleException(label + " contains a symlink or special file: " + path);
        }
        if (attributes.isRegularFile()
            && !allowedFiles.contains(path.toAbsolutePath().normalize())) {
          throw new GradleException(label + " contains undeclared file " + path);
        }
      }
    } catch (GradleException error) {
      throw error;
    } catch (IOException error) {
      throw new GradleException("inspect " + label + " " + root, error);
    }
  }

  private static void validateLinkedLibrary(Toolchain toolchain, Path library, String abi) {
    requireRegularFile(library, "linked Oliphaunt Android extension library for " + abi);
    byte[] header;
    try (InputStream input = Files.newInputStream(library)) {
      header = input.readNBytes(20);
    } catch (IOException error) {
      throw new GradleException("read linked Oliphaunt Android extension ELF header", error);
    }
    int expectedMachine = abi.equals("arm64-v8a") ? 183 : 62;
    if (header.length != 20
        || header[0] != 0x7f
        || header[1] != 'E'
        || header[2] != 'L'
        || header[3] != 'F'
        || header[4] != 2
        || header[5] != 1
        || (header[18] & 0xff) + ((header[19] & 0xff) << 8) != expectedMachine) {
      throw new GradleException(
          "linked Oliphaunt Android extension library has the wrong ELF ABI for " + abi);
    }
    String dynamic =
        runTool(
            List.of(toolchain.readelf().toString(), "--dynamic", library.toString()),
            "inspect linked Oliphaunt Android extension dependencies for " + abi);
    if (!dynamic.contains("(SONAME)") || !dynamic.contains("[" + LIBRARY_NAME + "]")) {
      throw new GradleException(
          "linked Oliphaunt Android extension library has no exact " + LIBRARY_NAME + " SONAME");
    }
    if (!dynamic.contains("(NEEDED)") || !dynamic.contains("[liboliphaunt.so]")) {
      throw new GradleException(
          "linked Oliphaunt Android extension library does not require liboliphaunt.so");
    }
    String symbols =
        runTool(
            List.of(
                toolchain.nm().toString(),
                "-D",
                "--defined-only",
                library.toString()),
            "inspect linked Oliphaunt Android extension symbols for " + abi);
    if (!symbols.matches("(?s).*\\b[TD]\\s+liboliphaunt_selected_static_extensions\\b.*")) {
      throw new GradleException(
          "linked Oliphaunt Android extension library does not export the registry selector");
    }
  }

  private static Toolchain toolchain(Path ndk) {
    Path prebuilt = ndk.resolve("toolchains/llvm/prebuilt");
    List<Path> roots;
    try (var children = Files.list(prebuilt)) {
      roots =
          children
              .filter(path -> Files.isDirectory(path, LinkOption.NOFOLLOW_LINKS))
              .sorted()
              .toList();
    } catch (IOException error) {
      throw new GradleException("inspect Android NDK LLVM toolchains under " + prebuilt, error);
    }
    List<Toolchain> candidates = new ArrayList<>();
    for (Path root : roots) {
      Path bin = root.resolve("bin");
      Path clang = executable(bin, "clang");
      Path clangxx = executable(bin, "clang++");
      Path strip = executable(bin, "llvm-strip");
      Path readelf = executable(bin, "llvm-readelf");
      Path nm = executable(bin, "llvm-nm");
      if (isSafeToolchainExecutable(clang, root)
          && isSafeToolchainExecutable(clangxx, root)
          && isSafeToolchainExecutable(strip, root)
          && isSafeToolchainExecutable(readelf, root)
          && isSafeToolchainExecutable(nm, root)
          && Files.isDirectory(root.resolve("sysroot"), LinkOption.NOFOLLOW_LINKS)) {
        candidates.add(
            new Toolchain(root, root.resolve("sysroot"), clang, clangxx, strip, readelf, nm));
      }
    }
    if (candidates.size() != 1) {
      throw new GradleException(
          "Android NDK must expose exactly one complete host LLVM toolchain under "
              + prebuilt
              + ", got "
              + candidates.stream().map(value -> value.root().toString()).toList());
    }
    return candidates.get(0);
  }

  private static Path executable(Path bin, String name) {
    String suffix =
        System.getProperty("os.name", "").toLowerCase(Locale.ROOT).contains("win") ? ".exe" : "";
    return bin.resolve(name + suffix);
  }

  private static boolean isSafeToolchainExecutable(Path executable, Path toolchainRoot) {
    try {
      Path realRoot = toolchainRoot.toRealPath();
      Path realExecutable = executable.toRealPath();
      return realExecutable.startsWith(realRoot)
          && Files.isRegularFile(realExecutable, LinkOption.NOFOLLOW_LINKS);
    } catch (IOException error) {
      return false;
    }
  }

  private Path requiredNdkDirectory() {
    if (!getNdkDirectory().isPresent()) {
      throw new GradleException(
          "selected native Oliphaunt Android extensions require an installed Android NDK; "
              + "configure android.ndkVersion or android.ndkPath");
    }
    Path ndk = getNdkDirectory().get().getAsFile().toPath();
    if (!Files.isDirectory(ndk, LinkOption.NOFOLLOW_LINKS)) {
      throw new GradleException("Android NDK directory is missing or unsafe: " + ndk);
    }
    return ndk.toAbsolutePath().normalize();
  }

  private void copyBundledHeader(Path destination) {
    try (InputStream input = getClass().getResourceAsStream(HEADER_RESOURCE)) {
      if (input == null) {
        throw new GradleException("Oliphaunt Android plugin is missing " + HEADER_RESOURCE);
      }
      Files.copy(input, destination, StandardCopyOption.REPLACE_EXISTING);
    } catch (IOException error) {
      throw new GradleException("materialize bundled Oliphaunt C header", error);
    }
  }

  private static String runTool(List<String> command, String label) {
    Process process;
    try {
      process = new ProcessBuilder(command).redirectErrorStream(true).start();
    } catch (IOException error) {
      throw new GradleException(label + ": could not start " + command.get(0), error);
    }
    ExecutorService outputReader =
        Executors.newSingleThreadExecutor(
            runnable -> {
              Thread thread = new Thread(runnable, "oliphaunt-android-tool-output");
              thread.setDaemon(true);
              return thread;
            });
    Future<byte[]> outputFuture =
        outputReader.submit(
            () -> {
              try (InputStream input = process.getInputStream()) {
                return readBounded(input, MAX_TOOL_OUTPUT_BYTES, label);
              }
            });
    final int status;
    try {
      long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(MAX_TOOL_RUNTIME_SECONDS);
      while (!process.waitFor(100, TimeUnit.MILLISECONDS)) {
        if (outputFuture.isDone()) {
          try {
            completedToolOutput(outputFuture, label);
          } catch (RuntimeException error) {
            process.destroyForcibly();
            throw error;
          }
        }
        if (System.nanoTime() >= deadline) {
          process.destroyForcibly();
          process.waitFor(10, TimeUnit.SECONDS);
          throw new GradleException(
              label + " exceeded the " + MAX_TOOL_RUNTIME_SECONDS + " second timeout");
        }
      }
      status = process.exitValue();
    } catch (InterruptedException error) {
      process.destroyForcibly();
      Thread.currentThread().interrupt();
      throw new GradleException(label + " was interrupted", error);
    } finally {
      outputReader.shutdown();
    }
    byte[] output = completedToolOutput(outputFuture, label);
    String text = new String(output, StandardCharsets.UTF_8);
    if (status != 0) {
      throw new GradleException(
          label + " failed with exit status " + status + ":\n" + text.trim());
    }
    return text;
  }

  private static byte[] completedToolOutput(Future<byte[]> output, String label) {
    try {
      return output.get(10, TimeUnit.SECONDS);
    } catch (ExecutionException error) {
      Throwable cause = error.getCause();
      if (cause instanceof GradleException gradleError) {
        throw gradleError;
      }
      if (cause instanceof IOException ioError) {
        throw new GradleException(label + ": read tool output", ioError);
      }
      throw new GradleException(label + ": read tool output", cause);
    } catch (TimeoutException error) {
      throw new GradleException(label + ": output reader did not finish", error);
    } catch (InterruptedException error) {
      Thread.currentThread().interrupt();
      throw new GradleException(label + ": output reader was interrupted", error);
    }
  }

  private static byte[] readBounded(InputStream input, int limit, String label) throws IOException {
    ByteArrayOutputStream output = new ByteArrayOutputStream();
    byte[] buffer = new byte[16 * 1024];
    int read;
    while ((read = input.read(buffer)) >= 0) {
      if (read == 0) {
        continue;
      }
      if (output.size() + read > limit) {
        throw new GradleException(label + " produced more than " + limit + " bytes of output");
      }
      output.write(buffer, 0, read);
    }
    return output.toByteArray();
  }

  private static Properties readProperties(Path file) {
    requireRegularFile(file, "Oliphaunt static registry manifest");
    Properties result =
        new Properties() {
          @Override
          public synchronized Object put(Object key, Object value) {
            if (containsKey(key)) {
              throw new GradleException(
                  "Oliphaunt static registry manifest "
                      + file
                      + " declares duplicate property "
                      + key);
            }
            return super.put(key, value);
          }
        };
    try (InputStream input = Files.newInputStream(file)) {
      byte[] bytes =
          readBounded(input, MAX_REGISTRY_MANIFEST_BYTES, "read static registry manifest " + file);
      result.load(new ByteArrayInputStream(bytes));
      return result;
    } catch (IOException error) {
      throw new GradleException("read Oliphaunt static registry manifest " + file, error);
    }
  }

  private static String requiredProperty(Properties properties, String key, Path source) {
    String value = properties.getProperty(key);
    if (value == null || value.isBlank()) {
      throw new GradleException(source + " must declare non-empty " + key);
    }
    return value;
  }

  private static void requireProperty(
      Properties properties, String key, String expected, Path source) {
    String value = requiredProperty(properties, key, source);
    if (expected != null && !expected.equals(value)) {
      throw new GradleException(
          source + " must declare " + key + "=" + expected + ", got " + value);
    }
  }

  private static void requirePropertyAllowingEmpty(
      Properties properties, String key, String expected, Path source) {
    String value = properties.getProperty(key);
    if (value == null) {
      throw new GradleException(source + " must declare " + key);
    }
    if (!expected.equals(value)) {
      throw new GradleException(
          source + " must declare " + key + "=" + expected + ", got " + value);
    }
  }

  private static List<String> canonicalPortableList(String raw, String label) {
    List<String> result = canonicalCsv(raw, label);
    for (String value : result) {
      if (!value.matches("[A-Za-z0-9._-]{1,128}")) {
        throw new GradleException("invalid " + label + " entry " + value);
      }
    }
    return result;
  }

  private static List<String> canonicalAndroidTargets(String raw, String label) {
    List<String> result = canonicalCsv(raw, label);
    for (String target : result) {
      if (!target.equals("android-arm64-v8a") && !target.equals("android-x86_64")) {
        throw new GradleException("invalid " + label + " entry " + target);
      }
    }
    return result;
  }

  private static List<String> canonicalCsv(String raw, String label) {
    if (raw == null || raw.isEmpty()) {
      return List.of();
    }
    List<String> values = Arrays.asList(raw.split(",", -1));
    List<String> sorted = new ArrayList<>(new LinkedHashSet<>(values));
    sorted.sort(String::compareTo);
    if (values.stream().anyMatch(value -> value.isEmpty() || !value.equals(value.trim()))
        || !values.equals(sorted)) {
      throw new GradleException(label + " must be a sorted unique canonical CSV list");
    }
    return List.copyOf(values);
  }

  private static DependencyArchive registryDependencyArchive(
      String target, String name, String value, Path manifestFile) {
    Path relative = Path.of(value);
    String normalized = relative.normalize().toString().replace(File.separatorChar, '/');
    String requiredPrefix = "archives/" + target + "/dependencies/" + name + "/";
    String basename = relative.getFileName() == null ? "" : relative.getFileName().toString();
    if (relative.isAbsolute()
        || relative.normalize().startsWith("..")
        || !normalized.equals(value)
        || !normalized.startsWith(requiredPrefix)
        || normalized.substring(requiredPrefix.length()).contains("/")
        || !basename.matches("[A-Za-z0-9._-]{1,128}")
        || !basename.endsWith(".a")) {
      throw new GradleException(
          manifestFile + " has unsafe Android static dependency archive " + value);
    }
    return new DependencyArchive(target, name, normalized);
  }

  private static List<String> canonicalAbis(List<String> raw) {
    List<String> result = new ArrayList<>(new LinkedHashSet<>(raw));
    for (String abi : result) {
      if (!abi.equals("arm64-v8a") && !abi.equals("x86_64")) {
        throw new GradleException("unsupported Oliphaunt Android ABI " + abi);
      }
    }
    if (result.size() != raw.size()) {
      throw new GradleException("selected Oliphaunt Android ABIs must be unique");
    }
    return List.copyOf(result);
  }

  private static String androidTarget(String abi) {
    return switch (abi) {
      case "arm64-v8a" -> "android-arm64-v8a";
      case "x86_64" -> "android-x86_64";
      default -> throw new GradleException("unsupported Oliphaunt Android ABI " + abi);
    };
  }

  private static String compilerTarget(String abi) {
    return switch (abi) {
      case "arm64-v8a" -> "aarch64-linux-android";
      case "x86_64" -> "x86_64-linux-android";
      default -> throw new GradleException("unsupported Oliphaunt Android ABI " + abi);
    };
  }

  private static void requireRegularFile(Path path, String label) {
    final BasicFileAttributes attributes;
    try {
      attributes = Files.readAttributes(path, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
    } catch (IOException error) {
      throw new GradleException(label + " is missing: " + path, error);
    }
    if (!attributes.isRegularFile() || attributes.isSymbolicLink()) {
      throw new GradleException(label + " must be a regular non-symlink file: " + path);
    }
  }

  private static void createDirectories(Path path) {
    try {
      Files.createDirectories(path);
    } catch (IOException error) {
      throw new GradleException("create directory " + path, error);
    }
  }

  private static void deleteIfExists(Path path) {
    try {
      Files.deleteIfExists(path);
    } catch (IOException error) {
      throw new GradleException("delete " + path, error);
    }
  }

  private static void deleteTree(Path root) {
    if (!Files.exists(root, LinkOption.NOFOLLOW_LINKS)) {
      return;
    }
    try (var paths = Files.walk(root)) {
      for (Path path : paths.sorted(Comparator.reverseOrder()).toList()) {
        Files.delete(path);
      }
    } catch (IOException error) {
      throw new GradleException("delete directory tree " + root, error);
    }
  }

  private static String sha256(byte[] bytes) {
    try {
      return hex(MessageDigest.getInstance("SHA-256").digest(bytes));
    } catch (NoSuchAlgorithmException error) {
      throw new GradleException("JVM does not provide SHA-256", error);
    }
  }

  private static String hex(byte[] bytes) {
    StringBuilder result = new StringBuilder(bytes.length * 2);
    for (byte value : bytes) {
      result.append(String.format(Locale.ROOT, "%02x", value & 0xff));
    }
    return result.toString();
  }

  private record Registry(
      List<String> modules, List<DependencyArchive> dependencyArchives, Path source) {}

  private record DependencyArchive(String target, String name, String relativePath) {}

  private record Toolchain(
      Path root, Path sysroot, Path clang, Path clangxx, Path strip, Path readelf, Path nm) {}
}
