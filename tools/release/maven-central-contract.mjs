import path from "node:path";

function error(message) {
  return new Error(`maven-central-contract: ${message}`);
}

function xmlBlock(block, tag) {
  const match = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "u"));
  return match?.[1] ?? null;
}

function xmlText(block, tag) {
  const inner = xmlBlock(block, tag);
  if (inner === null) return null;
  return inner
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gu, "$1")
    .replace(/<[^>]+>/gu, "")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"")
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&")
    .trim();
}

function uniqueXmlText(block, tag, context, { required = true } = {}) {
  const matches = [...block.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "gu"))];
  if (matches.length === 0 && !required) return null;
  if (matches.length !== 1) {
    throw error(`${context} must define exactly one <${tag}>, found ${matches.length}`);
  }
  return xmlText(matches[0][0], tag);
}

function xmlBlocks(block, tag) {
  return [...block.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "gu"))]
    .map((match) => match[1]);
}

function requireText(block, tag, context) {
  const value = xmlText(block, tag);
  if (value === null || value.length === 0) {
    throw error(`${context} must define a nonempty <${tag}>`);
  }
  return value;
}

function requireSafeCoordinate(value, context) {
  if (!/^[A-Za-z0-9_.-]+$/u.test(value)) {
    throw error(`${context} is not a safe Maven coordinate segment: ${JSON.stringify(value)}`);
  }
  return value;
}

function normalizedFiles(files, context) {
  if (!Array.isArray(files) || files.length === 0) {
    throw error(`${context} must provide the complete publication file set`);
  }
  const names = new Map();
  for (const entry of files) {
    const name = typeof entry === "string" ? path.basename(entry) : path.basename(entry?.name ?? entry?.path ?? "");
    const size = typeof entry === "string" ? undefined : entry?.size;
    if (name.length === 0 || name === "." || name === "..") {
      throw error(`${context} contains an invalid publication filename`);
    }
    if (names.has(name)) {
      throw error(`${context} contains duplicate publication filename ${name}`);
    }
    if (size !== undefined && (!Number.isSafeInteger(size) || size <= 0)) {
      throw error(`${context} file ${name} must be nonempty`);
    }
    names.set(name, { name, size });
  }
  return names;
}

function requireMetadata(project, context) {
  const header = project.replace(
    /<(parent|dependencies|dependencyManagement|licenses|developers|scm|properties|build|profiles|repositories|distributionManagement)(?:\s[^>]*)?>[\s\S]*?<\/\1>/gu,
    "",
  );
  for (const tag of ["name", "description", "url"]) {
    const value = uniqueXmlText(header, tag, context);
    if (value === null || value.length === 0) throw error(`${context} must define a nonempty <${tag}>`);
  }

  const licenses = xmlBlock(project, "licenses");
  if (licenses === null) throw error(`${context} must define <licenses>`);
  const validLicense = xmlBlocks(licenses, "license").some((license) =>
    (xmlText(license, "name")?.length ?? 0) > 0 && (xmlText(license, "url")?.length ?? 0) > 0
  );
  if (!validLicense) {
    throw error(`${context} must define at least one license with nonempty name and url`);
  }

  const developers = xmlBlock(project, "developers");
  if (developers === null) throw error(`${context} must define <developers>`);
  const validDeveloper = xmlBlocks(developers, "developer").some((developer) =>
    (xmlText(developer, "name")?.length ?? 0) > 0
      && ((xmlText(developer, "email")?.length ?? 0) > 0 || (xmlText(developer, "url")?.length ?? 0) > 0)
  );
  if (!validDeveloper) {
    throw error(`${context} must define at least one developer with a nonempty name and email or url`);
  }

  const scm = xmlBlock(project, "scm");
  if (scm === null) throw error(`${context} must define <scm>`);
  for (const tag of ["connection", "developerConnection", "url"]) {
    requireText(scm, tag, `${context} <scm>`);
  }
}

/**
 * Validate the immutable files for one Maven Central coordinate before any
 * signing, upload, or GitHub release mutation occurs.
 */
export function validateMavenCentralPublication({ pomText, files, context = "Maven publication" }) {
  if (typeof pomText !== "string" || pomText.length === 0) {
    throw error(`${context} POM must be nonempty UTF-8 text`);
  }
  if (/<!DOCTYPE|<!ENTITY/iu.test(pomText)) {
    throw error(`${context} POM must not contain a DTD or entity declaration`);
  }
  const projectMatches = [...pomText.matchAll(/<project(?:\s[^>]*)?>([\s\S]*?)<\/project>/gu)];
  if (projectMatches.length !== 1) {
    throw error(`${context} POM must contain exactly one <project> document, found ${projectMatches.length}`);
  }
  const project = projectMatches[0][1];
  const coordinates = project.replace(
    /<(parent|dependencies|dependencyManagement|properties|build|profiles|repositories|distributionManagement)(?:\s[^>]*)?>[\s\S]*?<\/\1>/gu,
    "",
  );
  const modelVersion = uniqueXmlText(coordinates, "modelVersion", context);
  if (modelVersion !== "4.0.0") {
    throw error(`${context} must use Maven modelVersion 4.0.0`);
  }
  const groupId = requireSafeCoordinate(uniqueXmlText(coordinates, "groupId", context), `${context} groupId`);
  const artifactId = requireSafeCoordinate(uniqueXmlText(coordinates, "artifactId", context), `${context} artifactId`);
  const version = requireSafeCoordinate(uniqueXmlText(coordinates, "version", context), `${context} version`);
  const packaging = requireSafeCoordinate(uniqueXmlText(coordinates, "packaging", context, { required: false }) ?? "jar", `${context} packaging`);
  requireMetadata(project, context);

  const names = normalizedFiles(files, context);
  const prefix = `${artifactId}-${version}`;
  const required = [`${prefix}.pom`];
  if (packaging !== "pom") {
    required.push(`${prefix}.${packaging}`, `${prefix}-sources.jar`, `${prefix}-javadoc.jar`);
  }
  for (const name of required) {
    if (!names.has(name)) {
      throw error(`${context} (${groupId}:${artifactId}:${version}, packaging ${packaging}) is missing required file ${name}`);
    }
  }

  return { artifactId, groupId, packaging, version };
}
