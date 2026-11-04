// Read and edit a dotenv file without losing its comments, order or unknown lines.
// Dependency-free (`node:` built-ins only). Used by init-env.mjs and check-env.mjs; the self-host
// smoke script (P3-06) imports it to set ports in a temp .env.
//
// Exports:
//   readEnvText(path)              -> string   file text, "" when the file is missing
//   writeEnvText(path, text)       -> void     writes text as is (creates parent folders)
//   parseEnvText(text)             -> object   KEY -> value, same rules as readDotenv
//   readEnvValues(path)            -> object   readDotenv(path), re-exported by name
//   getValue(text, key)            -> string | undefined   the active value of KEY
//   hasActiveKey(text, key)        -> boolean  KEY= appears on a non-comment line
//   setValue(text, key, value)     -> string   replace first active KEY=, else uncomment the first
//                                              `# KEY=`, else append; returns the new text
//   isBlank(value)                 -> boolean  undefined, empty or whitespace
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { readDotenv } from "../deploy/required-secrets.mjs";

function escape(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const ACTIVE = (key) => new RegExp(`^(\\s*(?:export\\s+)?)${escape(key)}(\\s*=)(.*)$`);
const COMMENTED = (key) => new RegExp(`^\\s*#\\s*${escape(key)}\\s*=`);

export function readEnvText(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

export function writeEnvText(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/** Same line grammar as `readDotenv` (scripts/deploy/required-secrets.mjs), over text. */
export function parseEnvText(text) {
  const env = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const raw = match[2].trim();
    env[match[1]] = /^(["']).*\1$/.test(raw) ? raw.slice(1, -1) : raw.replace(/\s+#.*$/, "");
  }
  return env;
}

export const readEnvValues = readDotenv;

export function getValue(text, key) {
  return parseEnvText(text)[key];
}

export function hasActiveKey(text, key) {
  const active = ACTIVE(key);
  return text.split(/\r?\n/).some((line) => active.test(line));
}

export function isBlank(value) {
  return value === undefined || value.trim() === "";
}

/** Values with spaces, `#` or quotes are double-quoted so `parseEnvText` reads them back. */
function format(value) {
  return /[\s#"']/.test(value) ? `"${value}"` : value;
}

export function setValue(text, key, value) {
  if (/[\r\n]/.test(value)) throw new Error(`Value for ${key} must be a single line.`);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const active = ACTIVE(key);
  const commented = COMMENTED(key);
  let index = lines.findIndex((line) => active.test(line));
  if (index >= 0) {
    const [, prefix, equals] = active.exec(lines[index]);
    lines[index] = `${prefix}${key}${equals.trim()}${format(value)}`;
    return lines.join(eol);
  }
  index = lines.findIndex((line) => commented.test(line));
  if (index >= 0) {
    lines[index] = `${key}=${format(value)}`;
    return lines.join(eol);
  }
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  lines.push(`${key}=${format(value)}`, "");
  return lines.join(eol);
}
