import {
  canPropose,
  isOwnerProposer,
  validateLink,
  type PlanItemType,
  type PlanLink,
  type PlanLinkInput,
  type PlanLinkKind
} from "./plan-map.js";
import { codesIn } from "./plan-code-pattern.js";

/**
 * Rule proposers for the plan map. Pure: they read a snapshot of
 * item titles and return candidate links, and the store decides what to write. A rule only ever suggests;
 * nothing here confirms a link, and a suggested link changes nothing in the engine.
 */

/** The add-on switch these proposers answer to. */
export const RULE_PROPOSER_NAMES = ["unit-code-occurrence", "unit-code-reference", "subject-words"] as const;
export type RuleProposerName = (typeof RULE_PROPOSER_NAMES)[number];

/** A suggestion batch is capped so a first run over a large plan cannot flood the Links and findings window. */
export const MAX_SUGGESTIONS_PER_RUN = 100;

/** The design's bar for considering a proposer: this many decisions at this accept rate. */
export const PROPOSER_BAR_MIN_DECISIONS = 30;
export const PROPOSER_BAR_ACCEPT_RATE = 0.8;

export interface ProposerItem {
  type: PlanItemType;
  id: string;
  title: string;
}

/**
 * What the rules read. A commitment item is a recurrence rule, or a one-off commitment that belongs to no
 * rule, never a single occurrence of a series: a link on a repeating class sits on the class and so applies
 * to every date of it.
 */
export interface ProposerSnapshot {
  projects: readonly ProposerItem[];
  deliverables: readonly ProposerItem[];
  actions: readonly ProposerItem[];
  commitments: readonly ProposerItem[];
  sources: readonly ProposerItem[];
  /** Ids of active subjects: a rule only suggests a subject that exists. */
  subjectIds: readonly string[];
  /** The owner's code pattern; absent or null turns the code rules off. */
  codePattern?: string | null;
}

export interface LinkCandidate extends PlanLinkInput {
  proposer: `rule:${RuleProposerName}`;
  evidence: string[];
}

/** Reference codes such as course or unit codes, as the owner's pattern defines them; none without a pattern. */
export function unitCodesIn(text: string, pattern: string | null | undefined): string[] {
  return codesIn(text, pattern);
}

/** Words that put a piece of work under a starting subject. Hand-curated, matched whole-word and case-blind. */
export const SUBJECT_WORDS: Readonly<Record<string, readonly string[]>> = {
  maths: ["maths", "math", "algebra", "calculus", "geometry", "trigonometry", "statistics", "arithmetic"],
  drafting: ["drafting", "autocad", "floor plan", "site plan", "cad"],
  meals: ["meal", "meals", "meal prep", "dinner", "lunch", "breakfast", "cooking", "groceries", "grocery"],
  exercise: ["exercise", "gym", "workout", "running", "swim", "swimming", "walking", "stretching"],
  money: ["budget", "tax", "invoice", "rent", "bills", "savings", "mortgage", "superannuation"]
};

function mentionsWord(title: string, word: string): boolean {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+");
  return new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, "i").test(title);
}

function quote(title: string): string {
  return title.length > 60 ? `${title.slice(0, 57)}...` : title;
}

/** A commitment whose title names a reference code is an occurrence of the project that names the same code. */
function unitCodeOccurrence(snapshot: ProposerSnapshot): LinkCandidate[] {
  const out: LinkCandidate[] = [];
  for (const commitment of snapshot.commitments) {
    for (const code of unitCodesIn(commitment.title, snapshot.codePattern)) {
      for (const project of snapshot.projects) {
        if (!unitCodesIn(project.title, snapshot.codePattern).includes(code)) continue;
        out.push({
          fromType: "commitment",
          fromId: commitment.id,
          toType: "project",
          toId: project.id,
          kind: "occurrence_of",
          proposer: "rule:unit-code-occurrence",
          evidence: [
            `Unit code ${code} in the commitment "${quote(commitment.title)}" and the project "${quote(project.title)}".`
          ]
        });
      }
    }
  }
  return out;
}

/** Work that names a reference code references the source (unit guide, assessment brief) that names the same code. */
function unitCodeReference(snapshot: ProposerSnapshot): LinkCandidate[] {
  const out: LinkCandidate[] = [];
  const work: [PlanItemType, readonly ProposerItem[]][] = [
    ["project", snapshot.projects],
    ["deliverable", snapshot.deliverables],
    ["action", snapshot.actions],
    ["commitment", snapshot.commitments]
  ];
  for (const [type, items] of work) {
    for (const item of items) {
      for (const code of unitCodesIn(item.title, snapshot.codePattern)) {
        for (const source of snapshot.sources) {
          if (!unitCodesIn(source.title, snapshot.codePattern).includes(code)) continue;
          out.push({
            fromType: type,
            fromId: item.id,
            toType: "source",
            toId: source.id,
            kind: "references",
            proposer: "rule:unit-code-reference",
            evidence: [`Unit code ${code} in "${quote(item.title)}" and in the source "${quote(source.title)}".`]
          });
        }
      }
    }
  }
  return out;
}

/** A title containing one of a subject's words is `about` that subject. */
function subjectWords(snapshot: ProposerSnapshot): LinkCandidate[] {
  const out: LinkCandidate[] = [];
  const active = new Set(snapshot.subjectIds);
  const work: [PlanItemType, readonly ProposerItem[]][] = [
    ["project", snapshot.projects],
    ["deliverable", snapshot.deliverables],
    ["action", snapshot.actions],
    ["commitment", snapshot.commitments]
  ];
  for (const [subject, words] of Object.entries(SUBJECT_WORDS)) {
    if (!active.has(subject)) continue;
    for (const [type, items] of work) {
      for (const item of items) {
        const hit = words.find((word) => mentionsWord(item.title, word));
        if (!hit) continue;
        out.push({
          fromType: type,
          fromId: item.id,
          toType: "subject",
          toId: subject,
          kind: "about",
          proposer: "rule:subject-words",
          evidence: [`"${hit}" in "${quote(item.title)}".`]
        });
      }
    }
  }
  return out;
}

/** Every candidate the rules see in `snapshot`, in a stable order and with valid ends only. */
export function proposeRuleLinks(snapshot: ProposerSnapshot): LinkCandidate[] {
  return [...unitCodeOccurrence(snapshot), ...unitCodeReference(snapshot), ...subjectWords(snapshot)].filter(
    (candidate) => validateLink(candidate).ok
  );
}

export interface ExistingLink extends Pick<
  PlanLink,
  "fromType" | "fromId" | "toType" | "toId" | "kind" | "status" | "evidence"
> {}

/**
 * The candidates worth writing now. A pair already stored is skipped unless it expired and its evidence
 * changed; a rejected pair never comes back. Duplicate candidates for one pair merge their evidence.
 */
export function selectNewSuggestions(
  candidates: readonly LinkCandidate[],
  existing: readonly ExistingLink[],
  limit: number = MAX_SUGGESTIONS_PER_RUN
): LinkCandidate[] {
  const merged = new Map<string, LinkCandidate>();
  for (const candidate of candidates) {
    const key = [candidate.kind, candidate.fromType, candidate.fromId, candidate.toType, candidate.toId].join("|");
    const seen = merged.get(key);
    if (seen) seen.evidence = [...new Set([...seen.evidence, ...candidate.evidence])];
    else merged.set(key, { ...candidate, evidence: [...candidate.evidence] });
  }
  const out: LinkCandidate[] = [];
  for (const candidate of merged.values()) {
    const stored = existing.find(
      (link) =>
        link.kind === candidate.kind &&
        link.fromType === candidate.fromType &&
        link.fromId === candidate.fromId &&
        link.toType === candidate.toType &&
        link.toId === candidate.toId
    );
    const evidenceChanged = stored !== undefined && candidate.evidence.some((line) => !stored.evidence.includes(line));
    if (!canPropose(existing, candidate, evidenceChanged)) continue;
    out.push(candidate);
    if (out.length >= limit) break;
  }
  return out;
}

export interface ProposerScore {
  proposer: string;
  kind: PlanLinkKind;
  accepted: number;
  rejected: number;
  pending: number;
  expired: number;
  decisions: number;
  /** accepted / decisions, or null before the first decision. */
  acceptRate: number | null;
  /** Whether it clears the design's bar (80% over at least 30 decisions); guidance for the owner, never automatic. */
  meetsBar: boolean;
}

/** Accept rate per proposer and kind, from the links as stored (a confirmed link keeps its proposer). */
export function scoreProposers(links: readonly Pick<PlanLink, "proposer" | "kind" | "status">[]): ProposerScore[] {
  const scores = new Map<string, ProposerScore>();
  for (const link of links) {
    if (isOwnerProposer(link.proposer)) continue;
    const key = `${link.proposer}|${link.kind}`;
    const score = scores.get(key) ?? {
      proposer: link.proposer,
      kind: link.kind,
      accepted: 0,
      rejected: 0,
      pending: 0,
      expired: 0,
      decisions: 0,
      acceptRate: null,
      meetsBar: false
    };
    if (link.status === "confirmed") score.accepted += 1;
    else if (link.status === "rejected") score.rejected += 1;
    else if (link.status === "suggested") score.pending += 1;
    else score.expired += 1;
    scores.set(key, score);
  }
  return [...scores.values()]
    .map((score) => {
      const decisions = score.accepted + score.rejected;
      const acceptRate = decisions === 0 ? null : score.accepted / decisions;
      return {
        ...score,
        decisions,
        acceptRate,
        meetsBar:
          decisions >= PROPOSER_BAR_MIN_DECISIONS && acceptRate !== null && acceptRate >= PROPOSER_BAR_ACCEPT_RATE
      };
    })
    .sort((a, b) => a.proposer.localeCompare(b.proposer) || a.kind.localeCompare(b.kind));
}
