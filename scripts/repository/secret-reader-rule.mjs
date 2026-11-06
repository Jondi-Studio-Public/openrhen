// A saved password or key is opened by `readSecret` (portal/server/secrets/read-secret.ts) and sealed or opened with
// `secrets-crypto.ts`; nothing else may reach either. Only the proxy-call helper may import the reader, so no route,
// page, job or log line can get a plaintext: the helper hands the key to the outbound proxy in one request body and
// returns only an outcome. The crypto module is limited to the store, the reader and the policy. A new importer needs a
// new line here, and a reviewer's eyes on it.
//
// Imports that cannot be read statically would walk round this, so in portal server and app source a dynamic `import()` or
// `require()` whose argument is not a plain string literal is refused too, and so is the folder itself
// (`@/server/secrets`), which would be a barrel re-exporting both.
export const SECRET_READER_MODULE = "portal/server/secrets/read-secret.ts";
export const ALLOWED_SECRET_READERS = ["portal/integrations/youtube/youtube-proxy-client.ts"];
export const SECRET_CRYPTO_MODULE = "portal/server/secrets/secrets-crypto.ts";
export const ALLOWED_SECRET_CRYPTO_USERS = [
  "portal/server/persistence/postgres/app-secrets-store.ts",
  "portal/server/secrets/read-secret.ts",
  "portal/server/secrets/secrets-policy.ts"
];
const SECRETS_FOLDER = "portal/server/secrets";

const isTest = (source) => /\.(?:integration\.)?test\.(?:ts|tsx|mjs)$/.test(source);

/** The text with comments removed and string and template literals kept, so a specifier in a comment is not read. */
export function withoutComments(text) {
  return text.replace(
    /("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
    (match, literal) => literal ?? ""
  );
}

// `from "x"`, `import "x"`, `import("x")`, `require("x")` and `export ... from "x"`, with ", ' or ` quotes.
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)(["'`])([^"'`\n]+)\1/g;
// `import(` or `require(` followed by anything but a plain literal (no `${}`) and a closing bracket or comma.
const NON_LITERAL_LOAD = /\b(?:import|require)\s*\(\s*(?!(?:"[^"\n$]*"|'[^'\n$]*'|`[^`$\n]*`)\s*[,)])/;

/** The repository-relative path (no extension) a specifier written in `source` names, or null for a package name. */
function resolveSpecifier(source, specifier) {
  let target;
  if (specifier.startsWith("@/")) target = `portal/${specifier.slice(2)}`;
  else if (specifier.startsWith(".")) target = `${source.split("/").slice(0, -1).join("/")}/${specifier}`;
  else return null;
  const parts = [];
  for (const part of target.split("/")) {
    if (part === "..") parts.pop();
    else if (part !== "." && part !== "") parts.push(part);
  }
  return parts.join("/").replace(/\.(?:js|ts|tsx|mjs)$/, "");
}

const stem = (file) => file.replace(/\.ts$/, "");

/** Every module a file imports, as resolved paths. */
function importsOf(source, text) {
  return [...withoutComments(text).matchAll(SPECIFIER)]
    .map((match) => resolveSpecifier(source, match[2]))
    .filter(Boolean);
}

/**
 * Errors for every maintained, non-test file that imports a restricted module without being allowed to, that imports
 * the secrets folder as a barrel, or (in portal source) loads a module by a computed name.
 * `files` is `[{ source, text }]` with `source` a repository-relative posix path.
 */
export function findSecretReaderViolations(
  files,
  allowed = ALLOWED_SECRET_READERS,
  allowedCrypto = ALLOWED_SECRET_CRYPTO_USERS
) {
  const errors = [];
  for (const { source, text } of files) {
    if (isTest(source)) continue;
    for (const target of importsOf(source, text)) {
      if (target === stem(SECRET_READER_MODULE) && source !== SECRET_READER_MODULE && !allowed.includes(source))
        errors.push(
          `${source} imports the secret reader (${SECRET_READER_MODULE}); only ${allowed.join(", ")} may: a saved key is read only to be sent to the outbound proxy`
        );
      if (target === stem(SECRET_CRYPTO_MODULE) && source !== SECRET_CRYPTO_MODULE && !allowedCrypto.includes(source))
        errors.push(
          `${source} imports the secrets crypto module (${SECRET_CRYPTO_MODULE}); only ${allowedCrypto.join(", ")} may`
        );
      if (target === SECRETS_FOLDER || target === `${SECRETS_FOLDER}/index`)
        errors.push(
          `${source} imports ${SECRETS_FOLDER} as a barrel, which would reach the secret reader; import the one module you need`
        );
    }
    // `portal/scripts/` is build tooling run by node, never bundled into the server.
    if (
      source.startsWith("portal/") &&
      !source.startsWith("portal/scripts/") &&
      NON_LITERAL_LOAD.test(withoutComments(text))
    )
      errors.push(
        `${source} loads a module with import() or require() on a computed name; the secret-reader rule cannot see it, so name the module as a plain string`
      );
  }
  return errors;
}

/** Errors when an allowed file no longer exists or no longer imports its module (the rule has gone stale). */
export function findStaleSecretReaderAllowances(
  files,
  allowed = ALLOWED_SECRET_READERS,
  allowedCrypto = ALLOWED_SECRET_CRYPTO_USERS
) {
  const bySource = new Map(files.map((file) => [file.source, file.text]));
  const stale = (list, module, what) =>
    list.flatMap((source) => {
      const text = bySource.get(source);
      if (text === undefined) return [`${source} is allowed to import the ${what} but does not exist`];
      return importsOf(source, text).includes(stem(module))
        ? []
        : [`${source} no longer imports the ${what}: remove it from its allowed list`];
    });
  return [
    ...stale(allowed, SECRET_READER_MODULE, "secret reader"),
    ...stale(allowedCrypto, SECRET_CRYPTO_MODULE, "secrets crypto module")
  ];
}
