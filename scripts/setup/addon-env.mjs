// Add-on env fragments: `addons/<id>/env.example` files that init-env.mjs folds into `.env`.
// An add-on lists the variables it needs in dotenv syntax; core never has to know their names.
// Dependency-free (`node:` built-ins only).
//
// Fragment format (a subset of `.env.example`):
//   # comment lines directly above a KEY= line travel with it into .env (a blank line ends the block)
//   KEY=default            an ordinary setting, appended when .env has no active KEY=
//   # @secret              marker line above a KEY=: a blank or `replace-before-lan-use` value is
//   KEY=                   replaced by a generated 64-character hex token (never printed)
//   Other lines are ignored. `process.env` already carries every name, so the portal and worker
//   need no core change; the add-on passes the names to its services in `compose.addon.yaml`.
//
// Rules: add-ons are visited in sorted id order and keys in file order (deterministic); a value
// already set in .env is never touched; a second run changes nothing. Duplicate keys across
// add-ons: the first add-on (sorted) wins and later ones are reported in `conflicts`.
//
// Exports:
//   SECRET_MARKER                       -> "@secret"
//   parseFragment(text)                 -> [{ key, line, comments, secret }]
//   findFragments(cwd)                  -> [{ id, path }]   sorted by id
//   applyAddonEnv({ cwd, text, makeSecret }) -> { text, generated, kept, conflicts }
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PLACEHOLDER } from "../deploy/required-secrets.mjs";
import { getValue, hasActiveKey, isBlank, setValue } from "./env-file.mjs";

export const SECRET_MARKER = "@secret";
const KEY_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

export function parseFragment(text) {
  const entries = [];
  let comments = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (line.trim() === "") {
      comments = [];
      continue;
    }
    if (/^\s*#/.test(line)) {
      comments.push(line);
      continue;
    }
    const match = KEY_LINE.exec(line);
    if (match) {
      const secret = comments.some((c) => c.replace(/^\s*#\s*/, "").trim() === SECRET_MARKER);
      entries.push({ key: match[1], line, comments, secret });
    }
    comments = [];
  }
  return entries;
}

export function findFragments(cwd) {
  const root = join(cwd, "addons");
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(root, d.name, "env.example")))
    .map((d) => ({ id: d.name, path: join(root, d.name, "env.example") }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

const needsValue = (value) => isBlank(value) || value.trim() === PLACEHOLDER;

export function applyAddonEnv({ cwd, text, makeSecret = () => randomBytes(32).toString("hex") }) {
  const generated = [];
  const kept = [];
  const conflicts = [];
  const seen = new Map();
  for (const { id, path } of findFragments(cwd)) {
    const entries = parseFragment(readFileSync(path, "utf8"));
    const missing = [];
    for (const entry of entries) {
      if (seen.has(entry.key)) {
        conflicts.push(`${entry.key} is set by add-ons ${seen.get(entry.key)} and ${id}; ${seen.get(entry.key)} wins.`);
        continue;
      }
      seen.set(entry.key, id);
      if (!hasActiveKey(text, entry.key)) missing.push(entry);
    }
    if (missing.length) {
      const eol = text.includes("\r\n") ? "\r\n" : "\n";
      const block = [`# add-on ${id}`];
      for (const entry of missing) block.push(...entry.comments, entry.line);
      text = text.replace(/(\r?\n)*$/, "") + eol + eol + block.join(eol) + eol;
    }
    for (const entry of entries) {
      if (seen.get(entry.key) !== id || !entry.secret) continue;
      if (needsValue(getValue(text, entry.key))) {
        text = setValue(text, entry.key, makeSecret());
        generated.push(entry.key);
      } else kept.push(entry.key);
    }
  }
  return { text, generated, kept, conflicts };
}
