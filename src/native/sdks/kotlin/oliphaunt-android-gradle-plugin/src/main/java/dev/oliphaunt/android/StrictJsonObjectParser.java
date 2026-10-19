package dev.oliphaunt.android;

import java.math.BigDecimal;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.gradle.api.GradleException;

/** A bounded, duplicate-key-rejecting JSON reader for public carrier manifests. */
final class StrictJsonObjectParser {
  private static final int MAX_DEPTH = 32;
  private static final int MAX_VALUES = 100_000;

  private final String text;
  private final String source;
  private int offset;
  private int values;

  private StrictJsonObjectParser(String text, String source) {
    this.text = text;
    this.source = source;
  }

  static Map<String, Object> readObject(Path path, int maxBytes, String label) {
    if (maxBytes <= 0) {
      throw new IllegalArgumentException("strict JSON byte limit must be positive");
    }
    final BasicFileAttributes attributes;
    final byte[] bytes;
    try {
      attributes =
          Files.readAttributes(path, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
      if (!attributes.isRegularFile() || attributes.isSymbolicLink()) {
        throw new GradleException(label + " must be a regular non-symlink file: " + path);
      }
      if (attributes.size() <= 0 || attributes.size() > maxBytes) {
        throw new GradleException(
            label
                + " "
                + path
                + " must be between 1 and "
                + maxBytes
                + " bytes, got "
                + attributes.size());
      }
      bytes = Files.readAllBytes(path);
    } catch (GradleException error) {
      throw error;
    } catch (java.io.IOException error) {
      throw new GradleException("read " + label + " " + path, error);
    }
    if (bytes.length != attributes.size()) {
      throw new GradleException(label + " " + path + " changed while it was being read");
    }
    return parseObject(bytes, label + " " + path);
  }

  static Map<String, Object> parseObject(byte[] bytes, String source) {
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
    if (text.startsWith("\ufeff")) {
      throw new GradleException(source + " must not contain a UTF-8 BOM");
    }
    StrictJsonObjectParser parser = new StrictJsonObjectParser(text, source);
    parser.skipWhitespace();
    Object value = parser.parseValue(0);
    parser.skipWhitespace();
    if (parser.offset != text.length()) {
      throw parser.error("has trailing data");
    }
    if (!(value instanceof Map<?, ?> raw)) {
      throw parser.error("must contain one JSON object");
    }
    LinkedHashMap<String, Object> result = new LinkedHashMap<>();
    for (Map.Entry<?, ?> entry : raw.entrySet()) {
      result.put((String) entry.getKey(), entry.getValue());
    }
    return result;
  }

  private Object parseValue(int depth) {
    if (depth > MAX_DEPTH) {
      throw error("exceeds the maximum JSON nesting depth");
    }
    values += 1;
    if (values > MAX_VALUES) {
      throw error("contains too many JSON values");
    }
    if (offset >= text.length()) {
      throw error("ends before a JSON value");
    }
    return switch (text.charAt(offset)) {
      case '{' -> parseObjectValue(depth + 1);
      case '[' -> parseArray(depth + 1);
      case '"' -> parseString();
      case 't' -> parseLiteral("true", Boolean.TRUE);
      case 'f' -> parseLiteral("false", Boolean.FALSE);
      case 'n' -> parseLiteral("null", null);
      default -> parseNumber();
    };
  }

  private Map<String, Object> parseObjectValue(int depth) {
    expect('{');
    skipWhitespace();
    LinkedHashMap<String, Object> result = new LinkedHashMap<>();
    if (consume('}')) {
      return result;
    }
    while (true) {
      if (offset >= text.length() || text.charAt(offset) != '"') {
        throw error("object keys must be JSON strings");
      }
      String key = parseString();
      if (result.containsKey(key)) {
        throw error("repeats object key " + key);
      }
      skipWhitespace();
      expect(':');
      skipWhitespace();
      result.put(key, parseValue(depth));
      skipWhitespace();
      if (consume('}')) {
        return result;
      }
      expect(',');
      skipWhitespace();
    }
  }

  private List<Object> parseArray(int depth) {
    expect('[');
    skipWhitespace();
    List<Object> result = new ArrayList<>();
    if (consume(']')) {
      return result;
    }
    while (true) {
      result.add(parseValue(depth));
      skipWhitespace();
      if (consume(']')) {
        return result;
      }
      expect(',');
      skipWhitespace();
    }
  }

  private String parseString() {
    expect('"');
    StringBuilder result = new StringBuilder();
    while (offset < text.length()) {
      char value = text.charAt(offset++);
      if (value == '"') {
        return result.toString();
      }
      if (value < 0x20) {
        throw error("contains an unescaped control character in a JSON string");
      }
      if (value != '\\') {
        if (Character.isHighSurrogate(value)) {
          if (offset >= text.length() || !Character.isLowSurrogate(text.charAt(offset))) {
            throw error("contains an unpaired high surrogate in a JSON string");
          }
          result.append(value).append(text.charAt(offset++));
        } else if (Character.isLowSurrogate(value)) {
          throw error("contains an unpaired low surrogate in a JSON string");
        } else {
          result.append(value);
        }
        continue;
      }
      if (offset >= text.length()) {
        throw error("ends in a JSON string escape");
      }
      char escaped = text.charAt(offset++);
      switch (escaped) {
        case '"', '\\', '/' -> result.append(escaped);
        case 'b' -> result.append('\b');
        case 'f' -> result.append('\f');
        case 'n' -> result.append('\n');
        case 'r' -> result.append('\r');
        case 't' -> result.append('\t');
        case 'u' -> appendUnicodeEscape(result);
        default -> throw error("contains an invalid JSON string escape");
      }
    }
    throw error("has an unterminated JSON string");
  }

  private void appendUnicodeEscape(StringBuilder result) {
    char value = parseUnicodeCodeUnit();
    if (Character.isHighSurrogate(value)) {
      if (offset + 2 > text.length()
          || text.charAt(offset) != '\\'
          || text.charAt(offset + 1) != 'u') {
        throw error("contains an unpaired escaped high surrogate");
      }
      offset += 2;
      char low = parseUnicodeCodeUnit();
      if (!Character.isLowSurrogate(low)) {
        throw error("contains an unpaired escaped high surrogate");
      }
      result.append(value).append(low);
    } else if (Character.isLowSurrogate(value)) {
      throw error("contains an unpaired escaped low surrogate");
    } else {
      result.append(value);
    }
  }

  private char parseUnicodeCodeUnit() {
    if (offset + 4 > text.length()) {
      throw error("has a truncated JSON Unicode escape");
    }
    int value = 0;
    for (int index = 0; index < 4; index++) {
      int digit = Character.digit(text.charAt(offset++), 16);
      if (digit < 0) {
        throw error("contains a non-hexadecimal JSON Unicode escape");
      }
      value = value * 16 + digit;
    }
    return (char) value;
  }

  private Object parseNumber() {
    int start = offset;
    consume('-');
    if (consume('0')) {
      if (offset < text.length() && Character.isDigit(text.charAt(offset))) {
        throw error("contains a JSON number with a leading zero");
      }
    } else {
      requireDigit('1', '9', "must contain a JSON value");
      while (offset < text.length() && Character.isDigit(text.charAt(offset))) {
        offset += 1;
      }
    }
    boolean decimal = false;
    if (consume('.')) {
      decimal = true;
      requireDigit('0', '9', "has a JSON number without a fractional digit");
      while (offset < text.length() && Character.isDigit(text.charAt(offset))) {
        offset += 1;
      }
    }
    if (offset < text.length() && (text.charAt(offset) == 'e' || text.charAt(offset) == 'E')) {
      decimal = true;
      offset += 1;
      if (offset < text.length() && (text.charAt(offset) == '+' || text.charAt(offset) == '-')) {
        offset += 1;
      }
      requireDigit('0', '9', "has a JSON number without an exponent digit");
      while (offset < text.length() && Character.isDigit(text.charAt(offset))) {
        offset += 1;
      }
    }
    String raw = text.substring(start, offset);
    try {
      return decimal ? new BigDecimal(raw) : Long.valueOf(raw);
    } catch (NumberFormatException error) {
      throw new GradleException(source + " has an out-of-range JSON number at offset " + start, error);
    }
  }

  private Object parseLiteral(String literal, Object result) {
    if (!text.startsWith(literal, offset)) {
      throw error("must contain a JSON value");
    }
    offset += literal.length();
    return result;
  }

  private void requireDigit(char minimum, char maximum, String message) {
    if (offset >= text.length()) {
      throw error(message);
    }
    char value = text.charAt(offset);
    if (value < minimum || value > maximum) {
      throw error(message);
    }
    offset += 1;
  }

  private void skipWhitespace() {
    while (offset < text.length()) {
      char value = text.charAt(offset);
      if (value != ' ' && value != '\t' && value != '\r' && value != '\n') {
        return;
      }
      offset += 1;
    }
  }

  private void expect(char expected) {
    if (!consume(expected)) {
      throw error("expected '" + expected + "'");
    }
  }

  private boolean consume(char expected) {
    if (offset < text.length() && text.charAt(offset) == expected) {
      offset += 1;
      return true;
    }
    return false;
  }

  private GradleException error(String message) {
    return new GradleException(source + " " + message + " at character offset " + offset);
  }
}
