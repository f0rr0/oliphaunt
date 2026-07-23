package dev.oliphaunt.android;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Properties;
import java.util.Set;
import java.util.TreeSet;
import org.gradle.api.GradleException;

/** Exact legal-member digests shipped with the Android consumer. */
final class OliphauntExtensionLegalCatalog {
  private static final String RESOURCE =
      "/dev/oliphaunt/android/extension-legal-catalog.json";
  private static final String EXTENSION_CATALOG_RESOURCE =
      "/dev/oliphaunt/android/extensions.properties";
  private static final String SCHEMA =
      "oliphaunt-android-extension-legal-catalog-v1";
  private static final int MAX_RESOURCE_BYTES = 1024 * 1024;
  private static final Set<String> TARGETS =
      Set.of("android-arm64-v8a", "android-x86_64");
  private static final Set<String> PROFILES =
      Set.of("contrib-native", "contrib-native-openssl", "external-native");
  private static final Map<ContractKey, Contract> CONTRACTS = loadBundled();

  private OliphauntExtensionLegalCatalog() {}

  static Contract requireLeaf(String sqlName, String target) {
    return require("leaf", sqlName, target);
  }

  static Contract requireAggregate(String product, String target) {
    return require("aggregate", product, target);
  }

  private static Contract require(String scope, String identity, String target) {
    Contract result = CONTRACTS.get(new ContractKey(scope, identity, target));
    if (result == null) {
      throw new GradleException(
          "bundled Oliphaunt Android legal catalog has no "
              + scope
              + " contract for "
              + identity
              + " on "
              + target);
    }
    return result;
  }

  static Map<ContractKey, Contract> parseForContractTest(byte[] bytes) {
    return parse(bytes, bundledSourceCatalogSha256());
  }

  private static Map<ContractKey, Contract> loadBundled() {
    byte[] bytes;
    try (InputStream input =
        OliphauntExtensionLegalCatalog.class.getResourceAsStream(RESOURCE)) {
      if (input == null) {
        throw new GradleException("Oliphaunt Android plugin is missing " + RESOURCE);
      }
      bytes = input.readNBytes(MAX_RESOURCE_BYTES + 1);
    } catch (IOException error) {
      throw new GradleException("read bundled Oliphaunt Android legal catalog", error);
    }
    if (bytes.length == 0 || bytes.length > MAX_RESOURCE_BYTES) {
      throw new GradleException(
          "bundled Oliphaunt Android legal catalog must be between 1 and "
              + MAX_RESOURCE_BYTES
              + " bytes");
    }
    return parse(bytes, bundledSourceCatalogSha256());
  }

  private static String bundledSourceCatalogSha256() {
    Properties properties = new Properties();
    try (InputStream input =
        OliphauntExtensionLegalCatalog.class.getResourceAsStream(
            EXTENSION_CATALOG_RESOURCE)) {
      if (input == null) {
        throw new GradleException(
            "Oliphaunt Android plugin is missing " + EXTENSION_CATALOG_RESOURCE);
      }
      properties.load(input);
    } catch (IOException error) {
      throw new GradleException("read bundled Oliphaunt Android extension catalog", error);
    }
    String digest = properties.getProperty("catalogSha256", "");
    if (!digest.matches("[0-9a-f]{64}")) {
      throw new GradleException(
          "bundled Oliphaunt Android extension catalog has an invalid digest");
    }
    return digest;
  }

  private static Map<ContractKey, Contract> parse(
      byte[] bytes, String expectedSourceCatalogSha256) {
    Map<String, Object> root =
        StrictJsonObjectParser.parseObject(
            bytes, "bundled Oliphaunt Android legal catalog");
    requireExactFields(
        root,
        Set.of("schema", "sourceCatalogSha256", "contracts"),
        "legal catalog root");
    requireString(root, "schema", "legal catalog root", SCHEMA);
    String sourceCatalogSha256 =
        requireString(root, "sourceCatalogSha256", "legal catalog root", null);
    if (!sourceCatalogSha256.matches("[0-9a-f]{64}")) {
      throw failure("sourceCatalogSha256 must be one lowercase SHA-256 digest");
    }
    if (!expectedSourceCatalogSha256.equals(sourceCatalogSha256)) {
      throw failure(
          "sourceCatalogSha256 "
              + sourceCatalogSha256
              + " does not match extensions.properties "
              + expectedSourceCatalogSha256);
    }
    Object rawContracts = root.get("contracts");
    if (!(rawContracts instanceof List<?> contracts) || contracts.isEmpty()) {
      throw failure("contracts must be a non-empty array");
    }

    LinkedHashMap<ContractKey, Contract> result = new LinkedHashMap<>();
    String previousKey = null;
    for (int index = 0; index < contracts.size(); index++) {
      Object raw = contracts.get(index);
      if (!(raw instanceof Map<?, ?> value)) {
        throw failure("contracts[" + index + "] must be an object");
      }
      Contract contract = parseContract(value, index);
      String sortKey = contract.key().sortKey();
      if (previousKey != null && previousKey.compareTo(sortKey) >= 0) {
        throw failure("contracts must be sorted and unique by scope, identity, and target");
      }
      previousKey = sortKey;
      if (result.put(contract.key(), contract) != null) {
        throw failure("contracts repeat " + contract.key());
      }
    }
    requireCompleteCoverage(result);
    return Collections.unmodifiableMap(result);
  }

  private static Contract parseContract(Map<?, ?> value, int index) {
    String label = "contracts[" + index + "]";
    requireExactFields(
        value,
        Set.of(
            "scope",
            "identity",
            "product",
            "target",
            "profile",
            "licenseFiles",
            "members"),
        label);
    String scope = requireString(value, "scope", label, null);
    if (!Set.of("aggregate", "leaf").contains(scope)) {
      throw failure(label + " scope must be aggregate or leaf");
    }
    String identity = requirePortableId(value, "identity", label);
    String product = requirePortableId(value, "product", label);
    if (!product.startsWith("oliphaunt-extension-")) {
      throw failure(label + " product is not an Oliphaunt extension release product");
    }
    String target = requireString(value, "target", label, null);
    if (!TARGETS.contains(target)) {
      throw failure(label + " has unsupported Android target " + target);
    }
    String profile = requireString(value, "profile", label, null);
    if (!PROFILES.contains(profile)) {
      throw failure(label + " has unsupported legal profile " + profile);
    }
    List<String> licenseFiles = stringList(value.get("licenseFiles"), label + " licenseFiles");
    for (String path : licenseFiles) {
      requireSafeLegalPath(path, label + " licenseFiles");
      if (!path.startsWith("share/licenses/")) {
        throw failure(label + " licenseFiles must live under share/licenses/");
      }
    }
    List<LegalMember> members = legalMembers(value.get("members"), label);

    List<String> sqlNames;
    if (scope.equals("leaf")) {
      OliphauntExtensionCatalog.Entry entry = OliphauntExtensionCatalog.require(identity);
      if (!entry.releaseProduct().equals(product)) {
        throw failure(label + " leaf product does not own " + identity);
      }
      sqlNames = List.of(identity);
    } else {
      if (!identity.equals(product)) {
        throw failure(label + " aggregate identity must equal product");
      }
      sqlNames = OliphauntExtensionCatalog.releaseProductMembers(product);
    }
    String expectedProfile = expectedProfile(scope, product, sqlNames);
    if (!profile.equals(expectedProfile)) {
      throw failure(
          label + " profile must be " + expectedProfile + ", got " + profile);
    }
    requireExactLegalNamespace(scope, profile, licenseFiles, members, label);
    return new Contract(
        new ContractKey(scope, identity, target),
        product,
        profile,
        List.copyOf(licenseFiles),
        List.copyOf(members));
  }

  private static String expectedProfile(
      String scope, String product, List<String> sqlNames) {
    if (!product.equals("oliphaunt-extension-contrib-pg18")) {
      return "external-native";
    }
    boolean embedsOpenSsl =
        scope.equals("aggregate") ? sqlNames.contains("pgcrypto") : sqlNames.equals(List.of("pgcrypto"));
    return embedsOpenSsl ? "contrib-native-openssl" : "contrib-native";
  }

  private static void requireExactLegalNamespace(
      String scope,
      String profile,
      List<String> licenseFiles,
      List<LegalMember> members,
      String label) {
    TreeSet<String> expected =
        new TreeSet<>(List.of("LICENSE", "THIRD_PARTY_NOTICES.md"));
    if (profile.startsWith("contrib-native")) {
      if (!licenseFiles.isEmpty()) {
        throw failure(label + " contrib contract must not declare upstream licenseFiles");
      }
      expected.add("THIRD_PARTY_LICENSES/PostgreSQL-COPYRIGHT");
      if (profile.endsWith("-openssl")) {
        expected.add("THIRD_PARTY_LICENSES/OpenSSL-LICENSE.txt");
      }
    } else {
      if (licenseFiles.isEmpty()) {
        throw failure(label + " external contract must declare upstream licenseFiles");
      }
      for (String path : licenseFiles) {
        expected.add(scope.equals("leaf") ? "files/" + path : path);
      }
    }
    TreeSet<String> actual = new TreeSet<>();
    for (LegalMember member : members) {
      actual.add(member.path());
    }
    if (!actual.equals(expected)) {
      throw failure(
          label
              + " legal members do not match profile/licenseFiles; expected="
              + expected
              + ", actual="
              + actual);
    }
  }

  private static List<LegalMember> legalMembers(Object raw, String label) {
    if (!(raw instanceof List<?> values) || values.isEmpty()) {
      throw failure(label + " members must be a non-empty array");
    }
    List<LegalMember> result = new ArrayList<>();
    String previous = null;
    for (int index = 0; index < values.size(); index++) {
      Object rawMember = values.get(index);
      if (!(rawMember instanceof Map<?, ?> member)) {
        throw failure(label + " members[" + index + "] must be an object");
      }
      String memberLabel = label + " members[" + index + "]";
      requireExactFields(member, Set.of("path", "bytes", "sha256", "mode"), memberLabel);
      String path = requireString(member, "path", memberLabel, null);
      requireSafeLegalPath(path, memberLabel);
      if (previous != null && previous.compareTo(path) >= 0) {
        throw failure(label + " members must be sorted and unique by path");
      }
      previous = path;
      Object rawBytes = member.get("bytes");
      if (!(rawBytes instanceof Long bytes) || bytes <= 0) {
        throw failure(memberLabel + " bytes must be a positive integer");
      }
      String sha256 = requireString(member, "sha256", memberLabel, null);
      if (!sha256.matches("[0-9a-f]{64}")) {
        throw failure(memberLabel + " sha256 must be one lowercase SHA-256 digest");
      }
      requireString(member, "mode", memberLabel, "0644");
      result.add(new LegalMember(path, bytes, sha256, 0644));
    }
    return result;
  }

  private static List<String> stringList(Object raw, String label) {
    if (!(raw instanceof List<?> values)) {
      throw failure(label + " must be an array");
    }
    List<String> result = new ArrayList<>();
    String previous = null;
    for (Object value : values) {
      if (!(value instanceof String text) || text.isEmpty()) {
        throw failure(label + " must contain non-empty strings");
      }
      if (previous != null && previous.compareTo(text) >= 0) {
        throw failure(label + " must be sorted and unique");
      }
      previous = text;
      result.add(text);
    }
    return result;
  }

  private static void requireCompleteCoverage(Map<ContractKey, Contract> contracts) {
    TreeSet<ContractKey> expected = new TreeSet<>((left, right) -> left.sortKey().compareTo(right.sortKey()));
    LinkedHashSet<String> products = new LinkedHashSet<>();
    for (String sqlName : OliphauntExtensionCatalog.sqlNames()) {
      String product = OliphauntExtensionCatalog.require(sqlName).releaseProduct();
      products.add(product);
      for (String target : TARGETS) {
        expected.add(new ContractKey("leaf", sqlName, target));
      }
    }
    for (String product : products) {
      for (String target : TARGETS) {
        expected.add(new ContractKey("aggregate", product, target));
      }
    }
    TreeSet<ContractKey> actual = new TreeSet<>((left, right) -> left.sortKey().compareTo(right.sortKey()));
    actual.addAll(contracts.keySet());
    if (!actual.equals(expected)) {
      TreeSet<ContractKey> missing = new TreeSet<>(expected.comparator());
      missing.addAll(expected);
      missing.removeAll(actual);
      TreeSet<ContractKey> extra = new TreeSet<>(expected.comparator());
      extra.addAll(actual);
      extra.removeAll(expected);
      throw failure("contract coverage is not exact; missing=" + missing + ", extra=" + extra);
    }
  }

  private static String requirePortableId(
      Map<?, ?> value, String key, String label) {
    String result = requireString(value, key, label, null);
    if (!result.matches("[A-Za-z0-9._-]{1,128}")) {
      throw failure(label + " " + key + " is not a portable identifier");
    }
    return result;
  }

  private static String requireString(
      Map<?, ?> value, String key, String label, String expected) {
    Object raw = value.get(key);
    if (!(raw instanceof String result) || result.isEmpty()) {
      throw failure(label + " must declare non-empty " + key);
    }
    if (expected != null && !expected.equals(result)) {
      throw failure(label + " must declare " + key + "=" + expected + ", got " + result);
    }
    return result;
  }

  private static void requireExactFields(
      Map<?, ?> value, Set<String> expected, String label) {
    TreeSet<String> actual = new TreeSet<>();
    for (Object key : value.keySet()) {
      if (!(key instanceof String text)) {
        throw failure(label + " has a non-string field");
      }
      actual.add(text);
    }
    if (!actual.equals(new TreeSet<>(expected))) {
      throw failure(label + " fields must be exactly " + new TreeSet<>(expected) + ", got " + actual);
    }
  }

  private static void requireSafeLegalPath(String value, String label) {
    if (
      !value.matches("[A-Za-z0-9._/-]{1,256}")
      || value.startsWith("/")
      || value.endsWith("/")
      || value.contains("//")
      || value.contains("/./")
      || value.contains("../")
      || value.contains("/..")
    ) {
      throw failure(label + " has unsafe legal member path " + value);
    }
  }

  private static GradleException failure(String message) {
    return new GradleException("bundled Oliphaunt Android legal catalog " + message);
  }

  record ContractKey(String scope, String identity, String target) {
    String sortKey() {
      return scope + "\u0000" + identity + "\u0000" + target;
    }
  }

  record LegalMember(String path, long bytes, String sha256, int mode) {}

  record Contract(
      ContractKey key,
      String product,
      String profile,
      List<String> licenseFiles,
      List<LegalMember> members) {
    Map<String, LegalMember> membersByPath() {
      LinkedHashMap<String, LegalMember> result = new LinkedHashMap<>();
      for (LegalMember member : members) {
        result.put(member.path(), member);
      }
      return Collections.unmodifiableMap(result);
    }
  }
}
