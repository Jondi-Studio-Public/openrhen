import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, extname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Built from parts: these names are the private repository's workflow folders, and a literal would be a pointer into
// them in the public tree. The checks that read them are skipped where the folders do not exist.
const AGENT_WORK = [".agent", "work"].join("-");
const ARCHIVE_DIR = ["docs", "archive"].join("/");
const DESIGN_GAPS_DOC = ["docs/delivery/design", "gaps.md"].join("-");

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ignoredDirectories = new Set([
  AGENT_WORK,
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
// The OpenRhen export has no scripts/extract; it carries its own, smaller documentation layout (extract/overlay/docs):
// no ledger, specifications or word budgets, so it keeps the link, root-file and routing checks and drops the rest.
const publicLayout = !existsSync(resolve(root, "scripts/extract/manifest.json"));
const rootMarkdownAllowlist = publicLayout ? new Set(["README.md"]) : new Set(["AGENTS.md", "CLAUDE.md", "README.md"]);
// Domain docs the engineering skills create lazily. Allowed at the root, but not required: the map
// appears the first time `/domain-modeling` resolves a term, and not before.
const rootMarkdownOptional = new Set(
  publicLayout
    ? ["CHANGELOG.md", "CODE_OF_CONDUCT.md", "CONTRIBUTING.md", "GOVERNANCE.md", "SECURITY.md"]
    : ["CONTEXT.md", "CONTEXT-MAP.md"]
);
// Vendored third-party trees whose documentation is not ours to police.
// extract/overlay is the public repository'"'"'s own documentation tree, copied out by the extract tool. It
// has its own link check (scripts/extract/overlay-links.mjs) and is not part of this repository'"'"'s ledger.
const ignoredPaths = new Set([resolve(root, "firmware", "lib"), resolve(root, "extract", "overlay")]);
/**
 * The specifications. These describe how the product behaves, so they should stay roughly stable:
 * a feature adds to them once and then stops. They share one budget, which is the ratchet against
 * the sprawl the consolidation removed.
 *
 * From 2026-09-08 each document also carries its own ceiling, sized to its role, rather than one
 * uniform 4,900 the other four shared. That number was inert for `blueprint.md` and `database-schema.md`,
 * neither of which had come within two thousand words of it, so it warned of nothing; and it was a
 * monthly nuisance for `logic-design.md`, raised four times in one day because the engine's rules are
 * simply longer than a product overview's. The ceilings below sum to 17,100 against an aggregate of
 * 16,500, so the aggregate still binds and is still the ratchet — what changes is that each
 * document's own number is now a real early warning instead of dead weight or a toll.
 */
const specificationDocuments = publicLayout
  ? []
  : [
      { path: "docs/product/blueprint.md", limit: 2_900 },
      /**
       * Documents whose charter is deliberately narrower than the general specification ceiling. The
       * behaviour contract holds invariants and the test proving each; if it approaches this number it has
       * started describing behaviour instead of constraining it, which is the user guide's job.
       *
       * Raised from 1,200 for two invariants §4 owed: a running session's own target is what the check-in
       * asks about, and prep pace / a running-late commitment / a renegotiate-tier disruption stay visible
       * regardless of session state (with the running-late fact compacted to a banner during one) — the
       * fix wave. Nothing superseded to cut in exchange; the check-in section simply grew by
       * two invariants the same way it already had two before them.
       */
      // The contract's ceiling rose from 1,300 on 2026-09-07 for the second portal's five invariants.
      //
      // Raised from 1,500 to 2,000 on 2026-09-09, an owner decision made ahead of the work rather than
      // at the wall: the contract stood at 1,493 with five design notes queued that each owe it at least
      // one invariant (calendar publish, session reconciliation, CLI deliverables, mail extraction,
      // external coordination). Seven words of headroom would have failed the first of them at its
      // documentation step. The aggregate ceiling below is unchanged and still binds first.
      // Raised from 2,000 by 70 on 2026-11-04: the stretch exception to the energy cut (`AT-C`) and the energy cost note.
      { path: "docs/product/behaviour-contract.md", limit: 2_070 },
      /**
       * Raised from 3,500 on 2026-09-04. The planning logic hit this ceiling exactly, and the next two
       * engine features — adherence health for maintenance projects, and prep pace — were each squeezed
       * into a parenthetical clause on an existing sentence because there was no room to state them. A
       * rule compressed until it is unreadable is not a saving. The aggregate ceiling is unchanged and is
       * still the ratchet: this raises the height of any one document, not the total.
       *
       * Raised again from 4,000 the same day: `logic-design.md` hit this ceiling exactly stating the
       * after-phase routine-step fix (a venue-context step chains from the commitment's own end; the
       * transition still counts with no return leg; sleep at home, not the next commitment, is the day's
       * terminal anchor) — the same "squeezed into a parenthetical" failure mode the note above describes,
       * one document over.
       *
       * Raised again from 4,100 the same day: `logic-design.md` had 102 words left, and §11 owed two rules
       * it could not state in them — how a wake routine is derived and displaced, and that a routine step
       * standing in for a practice both gates on and suppresses that practice. The aggregate ceiling below
       * is unchanged and is still the ratchet.
       *
       * Raised again from 4,300 the same day: §4 owed the `commitment` context kind its resolution rule,
       * its hold, and which caller deliberately resolves it unsatisfied. The aggregate ceiling is unchanged.
       *
       * Raised again from 4,900 on 2026-09-08, as this document's own ceiling rather than everyone's: the
       * four raises above are what a shared number costs the one document that genuinely keeps growing.
       *
       * Raised again from 5,000 by forecast-reservation: by the time its own compression pass landed,
       * concurrent work already at rest on `main` (unrelated design notes merged while this one was in
       * flight) had used the last of the headroom the plan was written against, leaving no room for even
       * a tightly compressed statement of tail-first reservation, per-slot band ledgers, cross-project
       * dependency bounds, the maximum-session break, the recurring standing pass or the cadence soft
       * pass — six engine rules gap 31/gap 32/gap 10 all cite. Every sentence touched was compressed
       * first (§6, §7, §8, §11 all read tighter per word than before); this raise is what stating six new
       * rules costs after that pass, not a substitute for it.
       */
      { path: "docs/engine/logic-design.md", limit: 5_260 },
      { path: "docs/architecture/system.md", limit: 4_500 },
      { path: "docs/architecture/database-schema.md", limit: 3_200 }
    ];
/**
 * The user guide is canonical for what a surface does, and it is the one document that grows with
 * every feature instead of settling once. Sharing the specifications' aggregate would let it eat
 * their headroom within a month, so it carries its own ceiling. Over budget means a feature was
 * appended where superseded prose should have been replaced.
 *
 * Raised from 12,500 on 2026-09-04, once for the `rhen` command line: a whole surface arrived
 * at once rather than a feature being added to an existing one, and describing what it is and what it
 * may do — the command table stays in `tools/cli/README.md` — left sixteen words of headroom after
 * the superseded prose had already been cut. Growth within a surface still has to be paid for by
 * replacement, not by this number.
 *
 * Raised again from 13,000 the same day for the wake routine: a new time of day the product now has
 * an opinion about, with nothing superseded to cut in exchange — the bedtime routine's prose stays
 * exactly as true as it was. The cadence-linked routine step and the live-updates dot rode along
 * inside the same raise at a sentence each.
 *
 * Raised again from 13,300 the same day for the `commitment` context kind: a fourth kind of context
 * the Contexts editor now offers, superseding nothing — the other three behave exactly as before.
 *
 * Raised again from 13,450 on 2026-09-07 for the roster integration: a new Connections
 * card and a new "shifts arrive automatically" paragraph, superseding nothing the calendar provider's own prose
 * already said. The Connections and provider-card paragraphs were compressed hard in exchange —
 * naming two providers costs one word beside naming a fourth provider card — but the two new
 * paragraphs still needed room of their own.
 *
 * Raised again from 13,600 on 2026-09-07 for a second portal: a People page, a new Inbox
 * review path (clash hold, person chips) and a whole second surface others use, decided by the
 * owner to be documented in full rather than squeezed beside the roster prose.
 *
 * Raised from 15,000 to 15,800 on 2026-09-08 by the documentation ledger remediation, and this is the
 * last raise. The 2026-09-08 audit found 13 errors and 24 shipped behaviours the guide never described;
 * correcting and adding them cost about 1,290 words after a real deletion, relocation and
 * deduplication pass had recovered 256. Two are new surfaces that supersede nothing — the handheld
 * device and the Settings AI group — and the rest is growth within existing surfaces that the pass
 * could not pay for without cutting meaning. The number includes the 150 words of headroom the
 * implementation skills require. The next overrun is not a seventh raise: it is the signal to split
 * the guide along "living the day" and "building the plan", each with its own ceiling and routing row.
 *
 * That overrun arrived on 2026-09-09 at 15,650 words, with the required 150 of headroom exhausted and
 * the calendar publish note owing the guide a Connections paragraph it had no room for, so the split
 * happened rather than a seventh raise. It is four documents, not the two the paragraph above guessed:
 * a front door that keeps the filename, and three guides divided by growth rate rather than by subject
 * alone. Living the day settles — Now, Today and History change when the day model changes, which is
 * rare; building the plan grows with every planning feature; settings and connections grows with every
 * provider connected, and is the fastest of the three. A guide over its own ceiling means the same
 * thing the single guide's did: a feature was appended where superseded prose should have been
 * replaced. Growth is paid for by replacement inside that guide, not by moving its number.
 */
const guideDocuments = publicLayout
  ? []
  : [
      // The 2026-11-05 restructure cut the front door to one daily path and moved opt-in detail into two
      // reference pages; each ceiling sits about 150 words above the page so growth is paid for by replacement.
      { path: "docs/product/user-guide.md", limit: 700 },
      { path: "docs/product/guide-living-the-day.md", limit: 2_450 },
      { path: "docs/product/reference-day-and-travel.md", limit: 4_980 },
      { path: "docs/product/guide-building-the-plan.md", limit: 3_540 },
      { path: "docs/product/guide-settings-and-connections.md", limit: 2_820 },
      { path: "docs/product/reference-import-and-agents.md", limit: 4_050 }
    ];
/**
 * Tracking, which grows and shrinks by design.
 * A ticked item keeps its claim and its evidence path and gives up its argument; a finished gate compresses to a line.
 * Budgeting it alongside the specifications meant the working set of whichever gate was being built
 * ate the specifications' headroom, and the wall arrived mid-feature rather than at rest.
 *
 * Two files, budgeted apart, because they move at different speeds. Status churns with whatever is in
 * flight; the design gaps are long-lived, cited from code comments, and must not be squeezed out by a
 * gate that happens to be busy — which is exactly what happened while they shared one ceiling.
 */
const trackingDocuments = publicLayout
  ? []
  : [
      // Raised from 1,500 on 2026-09-04: three landings in one evening (the wake-routine group, the
      // check-in placement fix, and the deliverable hold) plus the `commitment` context kind in flight.
      // Raised from 1,650 on 2026-09-07: a second portal lands as four packages at once.
      { path: "docs/delivery/status.md", limit: 1_950 },
      // Raised from 900 on 2026-09-04 for gap 15 and gap 16, two new long-lived gaps, after nine closed
      // entries had already been compressed by roughly 120 words to pay for them. This ceiling exists so
      // the gaps are not squeezed out; new gaps arriving is the growth it is meant to allow.
      // Raised again from 950 on 2026-09-04 for gap 17, the commitment-context readiness path the
      // Deliverables tab does not thread — a new long-lived gap, which is the growth this ceiling allows.
      // Raised from 1,050 on 2026-09-07 for gap 18 (monthly fixed commitments) and headroom for the
      // second portal's own gaps as it is used.
      // Raised from 1,200 on 2026-10-07 (owner decision): new design notes each add a gap, and a PR was stuck
      // trimming prose to fit. Do not loop on trimming; ask for a raise instead.
      { path: DESIGN_GAPS_DOC, limit: 2_000 }
    ];
const canonicalDocuments = [
  ...specificationDocuments.map((entry) => entry.path),
  ...trackingDocuments.map((entry) => entry.path),
  ...guideDocuments.map((entry) => entry.path)
];
// Every row of the routing table in docs/README.md, so the pass line counts what the index stands behind.
const routedDocuments = publicLayout
  ? publicRoutedDocuments()
  : [
      ...canonicalDocuments,
      "docs/architecture/repository-structure.md",
      "tools/cli/README.md",
      "docs/architecture/device-api.md",
      "docs/operations/postgres.md",
      "docs/operations/self-hosting.md",
      "docs/operations/development-workflow.md"
    ];

/** In the export, docs/README.md must route to every other Markdown file under docs/. */
function publicRoutedDocuments() {
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
// Raised from 15,000 on 2026-09-07: a second portal adds a process, a trust boundary, a role
// and an aggregate to the architecture documents, decided by the owner to be given room rather than
// paid for by compressing the roster and mail material that landed the same week.
// Raised from 16,500 by forecast-reservation's own `logic-design.md` raise above: the aggregate still
// binds and is still the ratchet, so a document's own ceiling can rise no further than this number
// allows — this raise is exactly that document's own raise, carried through, not a second increase.
// Raised from 16,760 by 100 on 2026-10-19, the owner's yes: the behaviour contract owed one invariant for catch-up.
// Raised from 16,860 by 40 on 2026-10-29, owner decision: pulse-on-plan archived its note and left its rules in the contract and schema.
// Raised from 17,000 by 90 on 2026-11-04: the stretch invariants above, with the restored contract prose.
const aggregateWordLimit = 17_090;
const errors = [];

function posix(path) {
  return path.split(sep).join("/");
}

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = resolve(directory, entry.name);
    if (entry.isDirectory() && (ignoredDirectories.has(entry.name) || ignoredPaths.has(absolute))) return [];
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
    if (canonicalDocuments.includes(source) && posix(relative(root, resolved)).startsWith(`${ARCHIVE_DIR}/`)) {
      errors.push(`${source} depends on archived material: ${match[1]}`);
    }
  }
}

// A proof named in the behaviour contract must be a file that exists: a renamed test otherwise leaves a row that
// claims an invariant is proven by something that cannot run. Only backticked `*.test.ts(x)` paths are checked.
const contractPath = "docs/product/behaviour-contract.md";
if (existsSync(resolve(root, contractPath))) {
  const contract = readFileSync(resolve(root, contractPath), "utf8");
  const proofPath = /`([A-Za-z0-9_./-]+\.test\.tsx?)`/g;
  for (const match of contract.matchAll(proofPath)) {
    if (!existsSync(resolve(root, match[1])))
      errors.push(`${contractPath} cites a test file that does not exist: ${match[1]}`);
  }
}

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

let aggregateWords = 0;
for (const { path: canonical, limit } of specificationDocuments) {
  const absolute = resolve(root, canonical);
  if (!existsSync(absolute)) {
    errors.push(`Missing canonical document: ${canonical}`);
    continue;
  }
  const words = readFileSync(absolute, "utf8").trim().split(/\s+/u).filter(Boolean).length;
  aggregateWords += words;
  if (words > limit) errors.push(`${canonical} has ${words} words; limit is ${limit}`);
}
if (aggregateWords > aggregateWordLimit) {
  errors.push(`Specification documents have ${aggregateWords} words; aggregate limit is ${aggregateWordLimit}`);
}

const guideCounts = [];
for (const { path, limit } of guideDocuments) {
  const absolute = resolve(root, path);
  if (!existsSync(absolute)) {
    errors.push(`Missing canonical document: ${path}`);
    continue;
  }
  const words = readFileSync(absolute, "utf8").trim().split(/\s+/u).filter(Boolean).length;
  guideCounts.push(`${words}/${limit}`);
  if (words > limit) {
    errors.push(
      `${path} has ${words} words; limit is ${limit}. Replace the prose a feature superseded rather than appending beside it.`
    );
  }
}

const trackingCounts = [];
for (const { path, limit } of trackingDocuments) {
  const absolute = resolve(root, path);
  if (!existsSync(absolute)) {
    errors.push(`Missing canonical document: ${path}`);
    continue;
  }
  const words = readFileSync(absolute, "utf8").trim().split(/\s+/u).filter(Boolean).length;
  trackingCounts.push(`${words}/${limit}`);
  // Over budget means a finished gate is still carrying its itemised evidence, or a closed design gap
  // is still carrying its argument. Compress it rather than raising this number.
  if (words > limit) {
    errors.push(
      `${path} has ${words} words; limit is ${limit}. Compress finished material rather than raising the limit.`
    );
  }
}

if (errors.length) {
  console.error("Documentation checks failed:\n" + errors.map((error) => `- ${error}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log(
    `Documentation checks passed: ${routedDocuments.length} routed documents of ${markdownFiles.length} maintained Markdown files, ${aggregateWords}/${aggregateWordLimit} specification words, guides ${guideCounts.join(", ")}, tracking ${trackingCounts.join(" and ")}.`
  );
}
