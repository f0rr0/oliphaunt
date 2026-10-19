package dev.oliphaunt.android;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.nio.channels.SeekableByteChannel;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.OpenOption;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.BasicFileAttributes;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.text.Normalizer;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.Locale;
import java.util.Map;
import java.util.Properties;
import java.util.Set;
import java.util.zip.GZIPInputStream;
import org.gradle.api.GradleException;

/**
 * Validates the deliberately small gzip/ustar subset used by public Maven release artifacts before
 * Gradle's archive machinery sees their paths.
 */
final class PublicTarGzArchivePreflight {
  private static final int TAR_BLOCK_BYTES = 512;
  private static final int COPY_BUFFER_BYTES = 128 * 1024;
  private static final int MAX_ARCHIVE_PATH_BYTES = 256;
  private static final long MIB = 1024L * 1024L;
  private static final String EXTENSION_ARTIFACT_POLICY_RESOURCE =
      "/dev/oliphaunt/android/extension-artifact-archive-policy.properties";
  private static final Limits DEFAULT_LIMITS =
      new Limits(512L * MIB, 2L * 1024L * MIB, 1024L * MIB, 20_000, 200, 64L * MIB);
  private static final Limits EXTENSION_ARTIFACT_LIMITS = loadExtensionArtifactLimits();

  private PublicTarGzArchivePreflight() {}

  static String sourceIdentity(Path source) {
    final MessageDigest digest;
    try {
      digest = MessageDigest.getInstance("SHA-256");
    } catch (NoSuchAlgorithmException error) {
      throw new GradleException("JVM does not provide SHA-256", error);
    }
    digest.update("oliphaunt-public-tar-gz-source-path-v1\0".getBytes(StandardCharsets.UTF_8));
    digest.update(
        source.toAbsolutePath().normalize().toString().getBytes(StandardCharsets.UTF_8));
    StringBuilder result = new StringBuilder(64);
    for (byte value : digest.digest()) {
      result.append(String.format(Locale.ROOT, "%02x", value & 0xff));
    }
    return result.toString();
  }

  static Inspection snapshotAndValidate(Path source, Path snapshot) {
    return snapshotAndValidate(source, snapshot, DEFAULT_LIMITS);
  }

  static Inspection snapshotAndValidate(Path source, Path snapshot, Limits limits) {
    validateLimits(limits);
    BasicFileAttributes sourceAttributes = regularArchiveAttributes(source, limits);
    try {
      Path parent = snapshot.getParent();
      if (parent == null) {
        throw new GradleException("validated public archive snapshot has no parent: " + snapshot);
      }
      Files.createDirectories(parent);
      Files.deleteIfExists(snapshot);
      long copied = 0;
      Set<OpenOption> inputOptions =
          Set.of(StandardOpenOption.READ, LinkOption.NOFOLLOW_LINKS);
      try (SeekableByteChannel input = Files.newByteChannel(source, inputOptions);
          OutputStream output =
              Files.newOutputStream(
                  snapshot, StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE)) {
        byte[] bytes = new byte[COPY_BUFFER_BYTES];
        ByteBuffer buffer = ByteBuffer.wrap(bytes);
        while (true) {
          int count = input.read(buffer);
          if (count < 0) {
            break;
          }
          if (count == 0) {
            buffer.clear();
            continue;
          }
          copied = checkedAdd(copied, count, source, "compressed snapshot size");
          if (copied > limits.maxCompressedBytes()) {
            throw new GradleException(
                source
                    + " exceeds the "
                    + limits.maxCompressedBytes()
                    + "-byte compressed public archive limit");
          }
          output.write(bytes, 0, count);
          buffer.clear();
        }
      }
      if (copied != sourceAttributes.size()) {
        throw new GradleException(
            source
                + " changed while it was copied into the private validation area: expected "
                + sourceAttributes.size()
                + " bytes, copied "
                + copied);
      }
      return validate(snapshot, limits);
    } catch (GradleException error) {
      deletePartialSnapshot(snapshot);
      throw error;
    } catch (IOException | UnsupportedOperationException error) {
      deletePartialSnapshot(snapshot);
      throw new GradleException(
          "copy public archive " + source + " into the private validation area", error);
    }
  }

  static Inspection validate(Path archive) {
    return validate(archive, DEFAULT_LIMITS);
  }

  static Limits extensionArtifactLimits() {
    return EXTENSION_ARTIFACT_LIMITS;
  }

  static Inspection validate(Path archive, Limits limits) {
    validateLimits(limits);
    BasicFileAttributes attributes = regularArchiveAttributes(archive, limits);
    requireSupportedGzipHeader(archive);
    long expandedLimit = expansionLimit(attributes.size(), limits);
    ScanState state = new ScanState(archive, expandedLimit);
    LinkedHashSet<String> paths = new LinkedHashSet<>();
    Map<String, String> foldedPaths = new LinkedHashMap<>();
    Map<String, String> foldedFiles = new LinkedHashMap<>();
    Map<String, Member> members = new LinkedHashMap<>();
    int entries = 0;
    int regularFiles = 0;
    try (InputStream raw = Files.newInputStream(archive);
        GZIPInputStream gzip = new GZIPInputStream(raw, COPY_BUFFER_BYTES)) {
      byte[] header = new byte[TAR_BLOCK_BYTES];
      byte[] transfer = new byte[COPY_BUFFER_BYTES];
      while (true) {
        if (!readBlockOrEof(gzip, header, state, "ustar header")) {
          throw new GradleException(archive + " is missing its two-block ustar end marker");
        }
        if (isZeroBlock(header)) {
          if (!readBlockOrEof(gzip, header, state, "second ustar end-marker block")) {
            throw new GradleException(archive + " has a truncated ustar end marker");
          }
          if (!isZeroBlock(header)) {
            throw new GradleException(archive + " has an incomplete ustar end marker");
          }
          if (readBounded(gzip, transfer, 0, 1, state) != -1) {
            throw new GradleException(archive + " has data after its two-block ustar end marker");
          }
          break;
        }

        entries += 1;
        if (entries > limits.maxEntries()) {
          throw new GradleException(
              archive + " exceeds the " + limits.maxEntries() + "-entry public archive limit");
        }
        TarEntry entry = parseHeader(archive, header, limits);
        validatePathGraph(
            archive,
            entry.path(),
            entry.directory(),
            paths,
            foldedPaths,
            foldedFiles);
        members.put(
            entry.path(), new Member(entry.size(), entry.mode(), entry.directory()));
        if (!entry.directory()) {
          regularFiles += 1;
        }
        discardExact(gzip, transfer, entry.size(), state, entry.path() + " payload", false);
        int padding = (int) ((TAR_BLOCK_BYTES - (entry.size() % TAR_BLOCK_BYTES)) % TAR_BLOCK_BYTES);
        discardExact(gzip, transfer, padding, state, entry.path() + " padding", true);
      }
    } catch (GradleException error) {
      throw error;
    } catch (IOException error) {
      throw new GradleException(
          archive + " is not a readable, checksum-valid public gzip/ustar archive", error);
    }
    if (regularFiles == 0) {
      throw new GradleException(archive + " contains no regular release artifact files");
    }
    return new Inspection(
        attributes.size(),
        state.expandedBytes,
        entries,
        regularFiles,
        java.util.Collections.unmodifiableMap(new LinkedHashMap<>(members)));
  }

  private static BasicFileAttributes regularArchiveAttributes(Path archive, Limits limits) {
    final BasicFileAttributes attributes;
    try {
      attributes =
          Files.readAttributes(
              archive, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
    } catch (IOException error) {
      throw new GradleException("inspect public archive " + archive, error);
    }
    if (!attributes.isRegularFile() || attributes.isSymbolicLink()) {
      throw new GradleException(
          "public archive must be a regular non-symlink file: " + archive);
    }
    if (attributes.size() <= 0 || attributes.size() > limits.maxCompressedBytes()) {
      throw new GradleException(
          archive
              + " compressed size must be between 1 and "
              + limits.maxCompressedBytes()
              + " bytes, got "
              + attributes.size());
    }
    return attributes;
  }

  private static void requireSupportedGzipHeader(Path archive) {
    byte[] header = new byte[10];
    try (InputStream input = Files.newInputStream(archive)) {
      int offset = 0;
      while (offset < header.length) {
        int count = input.read(header, offset, header.length - offset);
        if (count < 0) {
          throw new GradleException(archive + " has a truncated gzip header");
        }
        offset += count;
      }
    } catch (GradleException error) {
      throw error;
    } catch (IOException error) {
      throw new GradleException("read public archive gzip header " + archive, error);
    }
    int flags = header[3] & 0xff;
    if ((header[0] & 0xff) != 0x1f
        || (header[1] & 0xff) != 0x8b
        || (header[2] & 0xff) != 0x08
        || flags != 0) {
      throw new GradleException(
          archive
              + " must use a single gzip deflate stream without optional header sections");
    }
  }

  private static TarEntry parseHeader(Path archive, byte[] header, Limits limits) {
    if (!matches(header, 257, new byte[] {'u', 's', 't', 'a', 'r', 0})
        || !matches(header, 263, new byte[] {'0', '0'})) {
      throw new GradleException(archive + " contains a non-POSIX-ustar header");
    }
    long expectedChecksum = parseOctal(header, 148, 8, archive, "header checksum");
    long actualChecksum = 0;
    for (int index = 0; index < header.length; index++) {
      actualChecksum += index >= 148 && index < 156 ? 0x20 : header[index] & 0xff;
    }
    if (expectedChecksum != actualChecksum) {
      throw new GradleException(
          archive
              + " has an invalid ustar header checksum: expected "
              + expectedChecksum
              + ", got "
              + actualChecksum);
    }
    String name = parseString(header, 0, 100, archive, "ustar name");
    String prefix = parseString(header, 345, 155, archive, "ustar prefix");
    String rawPath = prefix.isEmpty() ? name : prefix + "/" + name;
    int type = header[156] & 0xff;
    boolean directory;
    if (type == 0 || type == '0') {
      directory = false;
    } else if (type == '5') {
      directory = true;
    } else {
      String printable =
          type >= 0x20 && type <= 0x7e
              ? Character.toString((char) type)
              : "0x" + Integer.toHexString(type);
      throw new GradleException(
          archive
              + " contains a link or special ustar entry "
              + rawPath
              + " (type "
              + printable
              + ")");
    }
    long size = parseOctal(header, 124, 12, archive, "size for " + rawPath);
    long rawMode = parseOctal(header, 100, 8, archive, "mode for " + rawPath);
    if (rawMode > 07777) {
      throw new GradleException(
          archive + " has out-of-range ustar mode for " + rawPath + ": " + rawMode);
    }
    if (directory && size != 0) {
      throw new GradleException(archive + " contains non-empty directory entry " + rawPath);
    }
    if (size > limits.maxEntryBytes()) {
      throw new GradleException(
          archive
              + " entry "
              + rawPath
              + " exceeds the "
              + limits.maxEntryBytes()
              + "-byte per-entry limit");
    }
    String path = safePath(archive, rawPath, directory);
    return new TarEntry(path, size, (int) rawMode, directory);
  }

  private static String safePath(Path archive, String rawPath, boolean directory) {
    if (rawPath.isEmpty()
        || rawPath.startsWith("/")
        || rawPath.startsWith("\\")
        || rawPath.indexOf('\\') >= 0
        || rawPath.matches("^[A-Za-z]:.*")) {
      throw new GradleException(archive + " contains unsafe absolute archive path " + rawPath);
    }
    if (rawPath.getBytes(StandardCharsets.UTF_8).length > MAX_ARCHIVE_PATH_BYTES) {
      throw new GradleException(
          archive + " archive path exceeds " + MAX_ARCHIVE_PATH_BYTES + " UTF-8 bytes: " + rawPath);
    }
    String path = rawPath;
    if (path.endsWith("/")) {
      if (!directory) {
        throw new GradleException(archive + " regular file path has a directory suffix: " + rawPath);
      }
      path = path.substring(0, path.length() - 1);
    }
    if (path.equals(".")) {
      if (!directory) {
        throw new GradleException(archive + " regular file cannot replace the archive root");
      }
      return path;
    }
    String[] components = path.split("/", -1);
    for (String component : components) {
      if (component.isEmpty() || component.equals(".") || component.equals("..")) {
        throw new GradleException(archive + " contains unsafe or ambiguous archive path " + rawPath);
      }
      if (component.endsWith(" ")
          || component.endsWith(".")
          || containsWindowsInvalidCharacter(component)
          || isWindowsDeviceName(component)) {
        throw new GradleException(
            archive + " contains a path that is unsafe on supported build hosts: " + rawPath);
      }
    }
    return String.join("/", components);
  }

  private static boolean containsWindowsInvalidCharacter(String component) {
    for (int index = 0; index < component.length(); index++) {
      char value = component.charAt(index);
      if (value < 0x20
          || value == ':'
          || value == '*'
          || value == '?'
          || value == '"'
          || value == '<'
          || value == '>'
          || value == '|') {
        return true;
      }
    }
    return false;
  }

  private static boolean isWindowsDeviceName(String component) {
    String stem = component;
    int dot = stem.indexOf('.');
    if (dot >= 0) {
      stem = stem.substring(0, dot);
    }
    stem = stem.toUpperCase(Locale.ROOT);
    return stem.equals("CON")
        || stem.equals("PRN")
        || stem.equals("AUX")
        || stem.equals("NUL")
        || stem.matches("COM[1-9]")
        || stem.matches("LPT[1-9]");
  }

  private static void validatePathGraph(
      Path archive,
      String path,
      boolean directory,
      Set<String> paths,
      Map<String, String> foldedPaths,
      Map<String, String> foldedFiles) {
    String folded = folded(path);
    String foldedCollision = foldedPaths.get(folded);
    if (!paths.add(path) || foldedCollision != null) {
      throw new GradleException(
          archive
              + " contains duplicate or build-host-colliding archive paths: "
              + (foldedCollision == null ? path : foldedCollision + " and " + path));
    }
    String[] components = path.split("/");
    StringBuilder parent = new StringBuilder();
    for (int index = 0; index + 1 < components.length; index++) {
      if (index > 0) {
        parent.append('/');
      }
      parent.append(components[index]);
      String blockingFile = foldedFiles.get(folded(parent.toString()));
      if (blockingFile != null) {
        throw new GradleException(
            archive
                + " archive path conflict: regular file "
                + blockingFile
                + " is an ancestor of "
                + path);
      }
    }
    if (!directory) {
      String prefix = folded + "/";
      for (Map.Entry<String, String> previous : foldedPaths.entrySet()) {
        if (previous.getKey().startsWith(prefix)) {
          throw new GradleException(
              archive
                  + " archive path conflict: regular file "
                  + path
                  + " would replace parent of "
                  + previous.getValue());
        }
      }
      foldedFiles.put(folded, path);
    }
    foldedPaths.put(folded, path);
  }

  private static String folded(String path) {
    return Normalizer.normalize(path, Normalizer.Form.NFC).toLowerCase(Locale.ROOT);
  }

  private static String parseString(
      byte[] header, int offset, int length, Path archive, String label) {
    int end = offset;
    int limit = offset + length;
    while (end < limit && header[end] != 0) {
      end += 1;
    }
    for (int index = end; index < limit; index++) {
      if (header[index] != 0) {
        throw new GradleException(
            archive + " " + label + " contains bytes after its NUL terminator");
      }
    }
    try {
      return StandardCharsets.UTF_8
          .newDecoder()
          .onMalformedInput(CodingErrorAction.REPORT)
          .onUnmappableCharacter(CodingErrorAction.REPORT)
          .decode(ByteBuffer.wrap(header, offset, end - offset))
          .toString();
    } catch (CharacterCodingException error) {
      throw new GradleException(archive + " " + label + " is not valid UTF-8", error);
    }
  }

  private static long parseOctal(
      byte[] header, int offset, int length, Path archive, String label) {
    int start = offset;
    int end = offset + length;
    while (start < end && header[start] == ' ') {
      start += 1;
    }
    int terminator = start;
    while (terminator < end && header[terminator] >= '0' && header[terminator] <= '7') {
      terminator += 1;
    }
    if (terminator == start) {
      throw new GradleException(archive + " has invalid ustar " + label);
    }
    for (int index = terminator; index < end; index++) {
      if (header[index] != 0 && header[index] != ' ') {
        throw new GradleException(archive + " has invalid ustar " + label);
      }
    }
    long value = 0;
    for (int index = start; index < terminator; index++) {
      try {
        value = Math.addExact(Math.multiplyExact(value, 8), header[index] - '0');
      } catch (ArithmeticException error) {
        throw new GradleException(archive + " has overflowing ustar " + label, error);
      }
    }
    return value;
  }

  private static boolean matches(byte[] source, int offset, byte[] expected) {
    for (int index = 0; index < expected.length; index++) {
      if (source[offset + index] != expected[index]) {
        return false;
      }
    }
    return true;
  }

  private static boolean isZeroBlock(byte[] block) {
    for (byte value : block) {
      if (value != 0) {
        return false;
      }
    }
    return true;
  }

  private static boolean readBlockOrEof(
      InputStream input, byte[] block, ScanState state, String context) throws IOException {
    int offset = 0;
    while (offset < block.length) {
      int count = readBounded(input, block, offset, block.length - offset, state);
      if (count < 0) {
        if (offset == 0) {
          return false;
        }
        throw new GradleException(state.archive + " has a truncated " + context);
      }
      offset += count;
    }
    return true;
  }

  private static void discardExact(
      InputStream input,
      byte[] buffer,
      long count,
      ScanState state,
      String context,
      boolean requireZero)
      throws IOException {
    long remaining = count;
    while (remaining > 0) {
      int requested = (int) Math.min(buffer.length, remaining);
      int read = readBounded(input, buffer, 0, requested, state);
      if (read < 0) {
        throw new GradleException(state.archive + " has a truncated " + context);
      }
      if (requireZero) {
        for (int index = 0; index < read; index++) {
          if (buffer[index] != 0) {
            throw new GradleException(state.archive + " has nonzero bytes in " + context);
          }
        }
      }
      remaining -= read;
    }
  }

  private static int readBounded(
      InputStream input, byte[] buffer, int offset, int length, ScanState state)
      throws IOException {
    int count = input.read(buffer, offset, length);
    if (count > 0) {
      state.expandedBytes =
          checkedAdd(state.expandedBytes, count, state.archive, "expanded archive size");
      if (state.expandedBytes > state.expandedLimit) {
        throw new GradleException(
            state.archive
                + " expands beyond its "
                + state.expandedLimit
                + "-byte decompression-bomb limit");
      }
    }
    return count;
  }

  private static long expansionLimit(long compressedBytes, Limits limits) {
    long ratioLimit;
    try {
      ratioLimit = Math.multiplyExact(compressedBytes, limits.maxExpansionRatio());
    } catch (ArithmeticException ignored) {
      ratioLimit = Long.MAX_VALUE;
    }
    return Math.min(
        limits.maxExpandedBytes(), Math.max(limits.expansionRatioFloorBytes(), ratioLimit));
  }

  static long expansionLimitForContractTest(long compressedBytes, Limits limits) {
    return expansionLimit(compressedBytes, limits);
  }

  private static long checkedAdd(long left, long right, Path archive, String label) {
    try {
      return Math.addExact(left, right);
    } catch (ArithmeticException error) {
      throw new GradleException(archive + " has overflowing " + label, error);
    }
  }

  private static void validateLimits(Limits limits) {
    if (limits.maxCompressedBytes() <= 0
        || limits.maxExpandedBytes() <= 0
        || limits.maxEntryBytes() <= 0
        || limits.maxEntries() <= 0
        || limits.maxExpansionRatio() <= 0
        || limits.expansionRatioFloorBytes() <= 0
        || limits.expansionRatioFloorBytes() > limits.maxExpandedBytes()) {
      throw new IllegalArgumentException("public archive preflight limits must be positive and coherent");
    }
  }

  private static Limits loadExtensionArtifactLimits() {
    Properties properties = new Properties();
    try (InputStream input = PublicTarGzArchivePreflight.class.getResourceAsStream(
        EXTENSION_ARTIFACT_POLICY_RESOURCE)) {
      if (input == null) {
        throw new GradleException(
            "missing packaged extension artifact archive policy "
                + EXTENSION_ARTIFACT_POLICY_RESOURCE);
      }
      properties.load(input);
    } catch (IOException error) {
      throw new GradleException(
          "read packaged extension artifact archive policy "
              + EXTENSION_ARTIFACT_POLICY_RESOURCE,
          error);
    }
    Set<String> expected =
        Set.of("schema", "maxCompressedBytes", "maxExpandedBytes", "maxMemberBytes", "maxMembers");
    if (!properties.stringPropertyNames().equals(expected)) {
      throw new GradleException(
          "extension artifact archive policy keys must be exactly " + expected);
    }
    String schema = properties.getProperty("schema");
    if (!"oliphaunt-extension-artifact-archive-policy-v1".equals(schema)) {
      throw new GradleException(
          "extension artifact archive policy has unsupported schema " + schema);
    }
    long maxExpandedBytes = positiveLong(properties, "maxExpandedBytes");
    Limits limits =
        new Limits(
            positiveLong(properties, "maxCompressedBytes"),
            maxExpandedBytes,
            positiveLong(properties, "maxMemberBytes"),
            positiveInt(properties, "maxMembers"),
            1,
            maxExpandedBytes);
    validateLimits(limits);
    if (limits.maxEntryBytes() > limits.maxExpandedBytes()) {
      throw new GradleException(
          "extension artifact archive policy maxMemberBytes must not exceed maxExpandedBytes");
    }
    return limits;
  }

  private static long positiveLong(Properties properties, String key) {
    String raw = properties.getProperty(key, "");
    try {
      long value = Long.parseLong(raw);
      if (value <= 0 || !Long.toString(value).equals(raw)) {
        throw new NumberFormatException("not canonical and positive");
      }
      return value;
    } catch (NumberFormatException error) {
      throw new GradleException(
          "extension artifact archive policy " + key + " must be a canonical positive integer",
          error);
    }
  }

  private static int positiveInt(Properties properties, String key) {
    long value = positiveLong(properties, key);
    if (value > Integer.MAX_VALUE) {
      throw new GradleException(
          "extension artifact archive policy " + key + " exceeds the Java integer range");
    }
    return (int) value;
  }

  private static void deletePartialSnapshot(Path snapshot) {
    try {
      Files.deleteIfExists(snapshot);
    } catch (IOException ignored) {
      // Preserve the causal validation/copy failure.
    }
  }

  record Limits(
      long maxCompressedBytes,
      long maxExpandedBytes,
      long maxEntryBytes,
      int maxEntries,
      int maxExpansionRatio,
      long expansionRatioFloorBytes) {}

  record Inspection(
      long compressedBytes,
      long expandedBytes,
      int entries,
      int regularFiles,
      Map<String, Member> members) {}

  record Member(long bytes, int mode, boolean directory) {}

  private record TarEntry(String path, long size, int mode, boolean directory) {}

  private static final class ScanState {
    private final Path archive;
    private final long expandedLimit;
    private long expandedBytes;

    private ScanState(Path archive, long expandedLimit) {
      this.archive = archive;
      this.expandedLimit = expandedLimit;
    }
  }
}
