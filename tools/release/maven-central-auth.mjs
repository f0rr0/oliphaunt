import { Buffer } from "node:buffer";

export function mavenCentralAuthorization(username, password) {
  if (typeof username !== "string" || username.length === 0) {
    throw new TypeError("Maven Central username must be a non-empty string");
  }
  if (typeof password !== "string" || password.length === 0) {
    throw new TypeError("Maven Central password must be a non-empty string");
  }
  return `Bearer ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}
