import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, extname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ARCHIVE_DIR = "docs/archive";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ignoredDirectories = new Set([
  ".agent-work",
  ".claude",
  ".git",
  ".next",
  ".pnpm-store",
  ".vinext",
  "backups",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "outputs",
  "var"
]);
const rootMarkdownAllowlist = new Set(["README.md"]);
const rootMarkdownOptional = new Set([
  "CHANGELOG.md",
  "CODE_OF_CONDUCT.md",
  "CONTRIBUTING.md",
  "GOVERNANCE.md",
  "SECURITY.md"
]);
const vendoredFirmware = resolve(root, "firmware", "lib");

// The documentation index routes to every maintained Markdown file under docs/.
function findRoutedDocuments() {
  const docs = resolve(root, "docs");
  if (!existsSync(docs)) return [];
  const found = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = resolve(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (extname(entry.name).toLowerCase() === ".md" && absolute !== resolve(docs, "README.md"))
        found.push(posix(relative(root, absolute)));
    }
  };
  visit(docs);
  return found.sort();
}
const formerRootNames = [
  "ARCHITECTURE.md",
  "BLUEPRINT.md",
  "DATABASE_SCHEMA.md",
  "DELIVERY_CHECKLIST.md",
  "ENGINE_REVIEW.md",
  "LOGIC_DESIGN.md",
  "MVP_SPEC.md",
  "POSTGRES_SETUP.md",
  "USER_GUIDE.md"
];
const errors = [];

function posix(path) {
  return path.split(sep).join("/");
}

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = resolve(directory, entry.name);
    if (entry.isDirectory() && (ignoredDirectories.has(entry.name) || absolute === vendoredFirmware)) return [];
    if (entry.isDirectory()) return walk(absolute);
    return extname(entry.name).toLowerCase() === ".md" ? [absolute] : [];
  });
}

const rootMarkdown = readdirSync(root, { withFileTypes: true })
  .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === ".md")
  .map((entry) => entry.name)
  .sort();
for (const name of rootMarkdown) {
  if (!rootMarkdownAllowlist.has(name) && !rootMarkdownOptional.has(name)) {
    errors.push(`Unexpected root Markdown file: ${name}`);
  }
}
for (const required of rootMarkdownAllowlist) {
  if (!rootMarkdown.includes(required)) errors.push(`Missing root Markdown entrypoint: ${required}`);
}

const markdownFiles = walk(root);
const markdownLink = /\[[^\]]*\]\(([^)]+)\)/g;
for (const absolute of markdownFiles) {
  const source = posix(relative(root, absolute));
  const text = readFileSync(absolute, "utf8");
  for (const oldName of formerRootNames) {
    if (text.includes(oldName)) errors.push(`${source} references former root document ${oldName}`);
  }
  for (const match of text.matchAll(markdownLink)) {
    let target = match[1].trim();
    if (target.startsWith("<") && target.endsWith(">")) target = target.slice(1, -1);
    if (!target || target.startsWith("#") || target.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
    target = target.split("#", 1)[0].split("?", 1)[0];
    if (!target) continue;
    try {
      target = decodeURIComponent(target);
    } catch {
      errors.push(`${source} contains an invalid encoded link: ${target}`);
      continue;
    }
    const resolved = resolve(dirname(absolute), target);
    if (!existsSync(resolved)) errors.push(`${source} has a broken local link: ${match[1]}`);
  }
}

// A proof named in the behaviour contract must be a file that exists: a renamed test otherwise leaves a row that
// claims an invariant is proven by something that cannot run. Only backticked `*.test.ts(x)` citations are checked.
// A citation with a `/` is a path from the repository root; a bare name matches a test file of that name anywhere in
// the source trees.
const contractPath = "docs/product/behaviour-contract.md";
if (existsSync(resolve(root, contractPath))) {
  const contract = readFileSync(resolve(root, contractPath), "utf8");
  const testNames = new Set();
  const collectTests = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) collectTests(resolve(directory, entry.name));
      } else if (/\.test\.tsx?$/u.test(entry.name)) testNames.add(entry.name);
    }
  };
  for (const tree of ["engine", "portal", "platform", "tools", "integrations", "overlay", "scripts"]) {
    if (existsSync(resolve(root, tree))) collectTests(resolve(root, tree));
  }
  const proofPath = /`([A-Za-z0-9_./-]+\.test\.tsx?)`/g;
  for (const match of contract.matchAll(proofPath)) {
    const cited = match[1];
    const found = cited.includes("/") ? existsSync(resolve(root, cited)) : testNames.has(cited);
    if (!found) errors.push(`${contractPath} cites a test file that does not exist: ${cited}`);
  }
}

const routedDocuments = findRoutedDocuments();
const indexPath = resolve(root, "docs/README.md");
if (!existsSync(indexPath)) {
  errors.push("Missing docs/README.md");
} else {
  const index = readFileSync(indexPath, "utf8");
  for (const document of routedDocuments) {
    const fromDocs = document.replace(/^docs\//, "");
    if (!index.includes(fromDocs)) errors.push(`docs/README.md does not route to ${document}`);
  }
}

/**
 * A design note is a proposal until the delivery status says it shipped, and the status line on its
 * third line is what says which. The term decides where the note lives, so the term and the directory
 * are checked together: a `Shipped` note left under the design notes is the drift this rule exists to
 * catch, because the canonical documents now carry its rules and a second copy of them is a liability.
 */
const designStatusLine = /^> Status: (Design|In build|Built|Shipped), \d{4}-\d{2}-\d{2}(?![\d-])/;
const designStatusForm = "> Status: <Design|In build|Built>, <YYYY-MM-DD>";

function markdownNames(directory) {
  const absolute = resolve(root, directory);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute, { withFileTypes: true })
    .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === ".md")
    .map((entry) => entry.name)
    .sort();
}

for (const name of markdownNames("docs/design")) {
  const source = `docs/design/${name}`;
  const text = readFileSync(resolve(root, source), "utf8");
  const line = text.split(/\r?\n/).find((candidate) => candidate.startsWith("> Status:"));
  const match = line?.match(designStatusLine);
  if (!match) {
    errors.push(`${source} has no status line in the required form. Its third line must read \`${designStatusForm}\`.`);
    continue;
  }
  if (match[1] === "Shipped") {
    errors.push(
      `${source} is marked Shipped but still lives under docs/design/. Move it to ${ARCHIVE_DIR}/design/${name}, list it in that directory's README.md with the ship date, and remove every canonical link to it in the same change.`
    );
  }
}

for (const name of markdownNames(`${ARCHIVE_DIR}/design`)) {
  if (name === "README.md") continue;
  const source = `${ARCHIVE_DIR}/design/${name}`;
  const text = readFileSync(resolve(root, source), "utf8");
  const line = text.split(/\r?\n/).find((candidate) => candidate.startsWith("> Status:"));
  if (!line || !designStatusLine.test(line)) {
    errors.push(
      `${source} has no status line in the required form. Its third line must read \`> Status: <Design|In build|Built|Shipped>, <YYYY-MM-DD>\`.`
    );
  }
}

if (errors.length) {
  console.error("Documentation checks failed:\n" + errors.map((error) => `- ${error}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log(
    `Documentation checks passed: ${routedDocuments.length} routed documents of ${markdownFiles.length} maintained Markdown files.`
  );
}
