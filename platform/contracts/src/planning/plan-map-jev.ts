import {
  PROPOSER_BAR_ACCEPT_RATE,
  PROPOSER_BAR_MIN_DECISIONS,
  scoreProposers,
  type ProposerScore
} from "./plan-map-proposers.js";
import type { PlanLink } from "./plan-map.js";

/**
 * The Jev subject-assignment proposer. Pure: it reads one choice
 * answer and decides whether to suggest a subject or escalate, counts the weekly question cap, and scores
 * the proposer against the rules on the owner's decisions. The hosted call and the writes are the reasoner service's.
 * Advisory only: nothing here confirms a link.
 */

/** The add-on switch name; absent or `off` means the proposer does nothing. */
export const JEV_ADDON = "jev_subjects";
/** The proposer name stored on its suggested links. */
export const JEV_PROPOSER = "model:jev-subjects";
/** The choice option that means no subject fits. */
export const JEV_NONE_OPTION = "none";

/** An answer below this probability, or with a runner-up this close, is escalated rather than suggested. */
export const JEV_MIN_CONFIDENCE = 0.6;
export const JEV_MIN_MARGIN = 0.2;
/** At most this many "ask the owner" findings in any rolling seven days, so new items cannot flood him. */
export const JEV_WEEKLY_QUESTION_CAP = 5;
/** Item titles sent to the vendor in one daily run. */
export const JEV_MAX_ITEMS_PER_RUN = 40;

export interface JevChoice {
  chosen: string;
  /** Probability per option, 0..1. */
  probabilities: Record<string, number>;
  confidence: number | null;
}

/**
 * Reads one question's answer out of a Jev response. The response shape is read tolerantly (answers keyed by
 * question id, either under `answers` or at the top level), but the probabilities must cover exactly the options
 * sent and the chosen one must lead; anything else returns null, which the
 * runner logs and skips: a malformed answer never becomes a suggestion.
 */
export function parseJevChoice(response: unknown, questionId: string, options: readonly string[]): JevChoice | null {
  if (typeof response !== "object" || response === null) return null;
  const root = response as Record<string, unknown>;
  const answers =
    typeof root.answers === "object" && root.answers !== null ? (root.answers as Record<string, unknown>) : root;
  const answer = answers[questionId];
  if (typeof answer !== "object" || answer === null) return null;
  const record = answer as Record<string, unknown>;
  const chosen = [record.chosen, record.choice, record.answer].find((value) => typeof value === "string");
  const rawProbs = record.probabilities ?? record.probs;
  if (typeof chosen !== "string" || typeof rawProbs !== "object" || rawProbs === null) return null;
  const probabilities: Record<string, number> = {};
  for (const [option, value] of Object.entries(rawProbs as Record<string, unknown>)) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) return null;
    probabilities[option] = value;
  }
  // The map must cover exactly the options we sent, and the chosen one must be the most probable.
  const keys = Object.keys(probabilities);
  if (keys.length !== options.length || !options.every((option) => option in probabilities)) return null;
  if (!(chosen in probabilities) || Object.values(probabilities).some((value) => value > probabilities[chosen]!)) {
    return null;
  }
  const confidence =
    typeof record.confidence === "number" && Number.isFinite(record.confidence) ? record.confidence : null;
  return { chosen, probabilities, confidence };
}

export type JevDecision =
  | { kind: "assign"; subject: string; probability: number }
  | { kind: "escalate"; reason: "none" | "low_confidence" | "spread"; probability: number };

/**
 * A subject is suggested only when it is a real option, clearly the leader, and not "none". "none", a low
 * probability, or a runner-up within the margin goes to the escalation path instead.
 */
export function decideSubject(choice: JevChoice, subjects: readonly string[]): JevDecision {
  const probability = choice.probabilities[choice.chosen] ?? 0;
  if (choice.chosen === JEV_NONE_OPTION || !subjects.includes(choice.chosen)) {
    return { kind: "escalate", reason: "none", probability };
  }
  if (probability < JEV_MIN_CONFIDENCE) return { kind: "escalate", reason: "low_confidence", probability };
  const runnerUp = Object.entries(choice.probabilities)
    .filter(([option]) => option !== choice.chosen)
    .reduce((best, [, value]) => Math.max(best, value), 0);
  if (probability - runnerUp < JEV_MIN_MARGIN) return { kind: "escalate", reason: "spread", probability };
  return { kind: "assign", subject: choice.chosen, probability };
}

/** How many more questions may be asked this week. */
export function jevQuestionsLeft(askedThisWeek: number, cap: number = JEV_WEEKLY_QUESTION_CAP): number {
  return Math.max(0, cap - askedThisWeek);
}

export interface JevScore {
  jev: ProposerScore | null;
  rules: ProposerScore | null;
  /** The 80%-over-30-decisions bar, on `about` links. */
  meetsAcceptBar: boolean;
  /** Jev's accept rate is strictly above the subject-words rules' on `about` links. */
  beatsRules: boolean;
  /** Both bars; only then is promotion past `shadow` worth considering. The owner decides. */
  clearsBar: boolean;
  summary: string;
}

/**
 * Jev against the rule proposer on the owner's accept and reject decisions for `about` links. "Beats the rules"
 * needs Jev's rate strictly above the rules' and at least one rules decision to compare with; the two sets
 * of items overlap only partly, so it is a comparison of rates, not a paired test.
 */
export function scoreJevAgainstRules(links: readonly Pick<PlanLink, "proposer" | "kind" | "status">[]): JevScore {
  const about = scoreProposers(links.filter((link) => link.kind === "about"));
  const jev = about.find((score) => score.proposer === "model:jev-subjects") ?? null;
  const rules = about.find((score) => score.proposer === "rule:subject-words") ?? null;
  const meetsAcceptBar = jev?.meetsBar ?? false;
  const beatsRules =
    jev?.acceptRate != null && rules?.acceptRate != null && rules.decisions > 0 && jev.acceptRate > rules.acceptRate;
  const pct = (score: ProposerScore | null): string =>
    score === null || score.acceptRate === null
      ? "no decisions"
      : `${Math.round(score.acceptRate * 100)}% of ${score.decisions}`;
  return {
    jev,
    rules,
    meetsAcceptBar,
    beatsRules,
    clearsBar: meetsAcceptBar && beatsRules,
    summary: `Jev ${pct(jev)}; rules ${pct(rules)}; bar ${Math.round(PROPOSER_BAR_ACCEPT_RATE * 100)}% over ${PROPOSER_BAR_MIN_DECISIONS} decisions and above the rules.`
  };
}
