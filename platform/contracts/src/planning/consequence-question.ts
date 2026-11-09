import type { AgentCall } from "../agent-error.js";
import { dateOrdinal } from "./cadence-due.js";

/**
 * The question a consequence comparison asks, and the shapes the portal, `rhen rank` and an agent share for it
 * (comparison-consequence-ranking design, 3.7 and decision 1). Pure; the database package reads the wording names from
 * here so the two cannot drift.
 *
 * The two wordings alternate by the person's local calendar day, so the same day always asks the same question and a
 * week gives both about equally. Each answer is stored with the wording it was asked under.
 */

export const CONSEQUENCE_WORDINGS = ["only_finish_one", "most_regret_not_doing"] as const;
export type ConsequenceWording = (typeof CONSEQUENCE_WORDINGS)[number];

/** Projects compare with projects; actions with siblings of the same project. */
export const CONSEQUENCE_POOL_NAMES = ["project", "action"] as const;
export type ConsequencePoolName = (typeof CONSEQUENCE_POOL_NAMES)[number];

export const CONSEQUENCE_QUESTION_TEXT: Record<ConsequenceWording, string> = {
  only_finish_one: "If you could only get one of these done, which would you do?",
  most_regret_not_doing: "A year from now, which of these would you most regret never having done?"
};

/** The wording for a local calendar day (`YYYY-MM-DD`): an even day number asks "only one", an odd one asks the regret question. */
export function consequenceWordingForDay(localDay: string): ConsequenceWording {
  const ordinal = dateOrdinal(localDay);
  return CONSEQUENCE_WORDINGS[Math.abs(ordinal) % 2 === 0 ? 0 : 1] as ConsequenceWording;
}

export function isConsequenceWording(value: unknown): value is ConsequenceWording {
  return typeof value === "string" && (CONSEQUENCE_WORDINGS as readonly string[]).includes(value);
}

/** One item of a group as shown: `n` is the number a person types to rank it (`rhen rank 2 1 4 3`). */
export interface ConsequenceGroupItemView {
  n: number;
  id: string;
  title: string;
  /** The item's own 1-5 stars (never the refined value, so the question is not anchored by the last answer). */
  stars: number;
}

/** A group handed out, ready to show or to answer. */
export interface ConsequenceGroupView {
  groupId: string;
  pool: ConsequencePoolName;
  wording: ConsequenceWording;
  question: string;
  items: ConsequenceGroupItemView[];
  /** An earlier unanswered group handed out again rather than a new one. */
  reissued: boolean;
  /** The exact call that answers it, with the ids in the order shown (reorder them, best first). */
  answerCall: AgentCall;
  /** What to do, in words, for a reader that shows text. */
  instructions: string;
}

/** The read that issues (or re-issues) the next group. */
export const CONSEQUENCE_NEXT_CALL: AgentCall = {
  tool: "rhen_inbox",
  arguments: { room: "compare" },
  note: "read-only for the plan; hands out the next group to rank, or the one still waiting for an answer"
};

/** The call that answers `groupId`: `itemIds` in any order (the caller reorders them, best first), or `tie` instead. */
export function consequenceAnswerCall(groupId: string, itemIds: readonly string[]): AgentCall {
  return {
    tool: "rhen_save",
    arguments: {
      entityType: "comparison",
      fields: { groupId, rankedIds: [...itemIds] },
      basis: "stated",
      evidence: "<the person's own words>"
    },
    note: 'rankedIds: every id once, best first (or fields {"groupId": ..., "tie": true} when the person says they are equal); only a person\'s answer is "stated"'
  };
}

/** Builds the group as shown from the ids the database issued and the titles the portal read. */
export function buildConsequenceGroupView(input: {
  groupId: string;
  pool: ConsequencePoolName;
  wording: ConsequenceWording;
  reissued: boolean;
  items: readonly { id: string; title: string; stars: number }[];
}): ConsequenceGroupView {
  const items = input.items.map((item, index) => ({ n: index + 1, id: item.id, title: item.title, stars: item.stars }));
  const question = CONSEQUENCE_QUESTION_TEXT[input.wording];
  return {
    groupId: input.groupId,
    pool: input.pool,
    wording: input.wording,
    question,
    items,
    reissued: input.reissued,
    answerCall: consequenceAnswerCall(
      input.groupId,
      items.map((item) => item.id)
    ),
    instructions:
      `Ask the person: "${question}" Have them put the ${items.length} items in order, best first, or say they are equal. ` +
      "Save only what they said, with their words as evidence; never rank them on your own say-so unless you mark the answer inferred, which counts for half."
  };
}
