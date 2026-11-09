import { z } from "zod";

/**
 * The replay harness's vocabulary: what a reconciler is given, what it answers, and the golden-case
 * file format. A reconciler decides what one incoming message does to the plan; the harness scores
 * that decision against hand-written gold. Neutral names only: the source is `message-test`, every
 * address is `@example.test`.
 */

export const END_STATES = ["applied", "duplicate", "asked", "no_effect", "unresolved"] as const;
export type EndState = (typeof END_STATES)[number];

const isoInstant = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z$/);
const isoDateOrInstant = z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/), isoInstant]);
const id = z.string().min(1);

const planCommitment = z.strictObject({
  id,
  title: z.string().min(1),
  startsAt: isoInstant,
  endsAt: isoInstant.nullable().default(null),
  allDay: z.boolean().default(false),
  status: z.string().default("scheduled"),
  contactId: id.nullable().default(null)
});

const planAction = z.strictObject({
  id,
  title: z.string().min(1),
  deadlineAt: isoDateOrInstant.nullable(),
  status: z.enum(["open", "done", "cancelled"]).default("open")
});

const planProject = z.strictObject({
  id,
  title: z.string().min(1),
  deadlineAt: isoDateOrInstant.nullable(),
  status: z.enum(["open", "done", "cancelled"]).default("open")
});

const planContact = z.strictObject({ id, name: z.string().min(1), email: z.string().nullable() });

const planAlias = z.strictObject({ remoteTitleNorm: z.string(), localTitleNorm: z.string() });

const openFact = z.strictObject({
  id,
  title: z.string().min(1),
  conversationKey: z.string().nullable().default(null),
  icsUid: z.string().nullable().default(null)
});

export const FACT_TYPES = ["ask", "commitment", "event", "deadline"] as const;
export type FactType = (typeof FACT_TYPES)[number];

/** A fact is thin: no title, place or duration, only the words it was read from and when it points. */
const messageFact = z.strictObject({
  type: z.enum(FACT_TYPES),
  quote: z.string().min(1),
  /** Start (and optional end) as an instant, or a date for an all-day or date-only fact. */
  when: z.array(isoDateOrInstant).max(2).optional(),
  icsUid: z.string().optional(),
  conversationKey: z.string().min(1),
  /** The message withdraws what it names. */
  cancelled: z.boolean().default(false)
});

export const replayInputSchema = z.strictObject({
  now: isoInstant,
  timezone: z.string().min(1),
  plan: z.strictObject({
    commitments: z.array(planCommitment).default([]),
    actions: z.array(planAction).default([]),
    projects: z.array(planProject).default([]),
    contacts: z.array(planContact).default([]),
    aliases: z.array(planAlias).default([]),
    openFacts: z.array(openFact).default([])
  }),
  message: z.strictObject({
    source: z.literal("message-test"),
    from: z.string().min(1),
    to: z.string().min(1),
    sentAt: isoInstant,
    /** At most one fact in this version: the outcome is per message. Zero is a message that read as nothing. */
    facts: z.array(messageFact).max(1)
  })
});
export type ReplayInput = z.output<typeof replayInputSchema>;
export type ReplayFact = ReplayInput["message"]["facts"][number];

export const targetSchema = z.strictObject({
  kind: z.enum(["commitment", "action", "project", "fact"]),
  id
});
export type ReplayTarget = z.infer<typeof targetSchema>;

export const OPS = ["create", "update", "cancel"] as const;
export type ReplayOp = (typeof OPS)[number];

export const NO_EFFECT_REASONS = ["no_facts", "past"] as const;
export const UNRESOLVED_REASONS = ["no_start_time"] as const;

export const MUST_NOT = ["apply", "create"] as const;

export const goldSchema = z.strictObject({
  endState: z.enum(END_STATES),
  target: targetSchema.optional(),
  acceptableTargets: z.array(targetSchema).optional(),
  op: z.enum(OPS).optional(),
  reason: z.string().optional(),
  mustNot: z.array(z.enum(MUST_NOT)).optional(),
  /** A clear single match a person would Deny: it simulates the Confirm/Deny accuracy score. */
  deny: z.boolean().optional()
});
export type ReplayGold = z.infer<typeof goldSchema>;

export const replayCaseSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  tags: z.array(z.string().min(1)).min(1),
  note: z.string().optional(),
  input: replayInputSchema,
  gold: goldSchema
});
export type ReplayCase = z.output<typeof replayCaseSchema>;

export const MAX_CANDIDATES = 5;

export interface Candidate {
  id: string;
  /** 3 exact, 2 strong, 1 possible. */
  rank: number;
  score: number;
  lane: string;
}

export type ChoiceLabel = string;

/** What a chooser is shown: the quote and at most five cards the code built. It has no tools. */
export interface ChooserCard {
  label: string;
  id: string;
  title: string;
}
export interface ChooserRequest {
  quote: string;
  cards: readonly ChooserCard[];
}
/** `cN` for a card, `none` (none of them), or `unsure`. Anything else is read as `unsure`. */
export type Chooser = ((request: ChooserRequest) => ChoiceLabel) & {
  /** Set by the `never` chooser: a reconciler must not call it, and treats the case as needing a judge. */
  unavailable?: true;
};

export interface ReplayOutcome {
  endState: EndState;
  reason?: string;
  target?: ReplayTarget;
  op?: ReplayOp;
  candidates: Candidate[];
  tie: boolean;
  usedChooser: boolean;
  chooserPick?: string;
}

/** The unit under test: step D swaps in the real implementation without touching cases or scoring. */
export type Reconciler = (input: ReplayInput, deps: { chooser: Chooser }) => ReplayOutcome;

export function parseReplayCase(raw: unknown): ReplayCase {
  return replayCaseSchema.parse(raw);
}
