import { z } from "zod";
import { AGENT_PROPOSAL_EVIDENCE_MAX, agentBasisSchema } from "../agent-proposals.js";
import { BULK_PROPOSAL_THRESHOLD } from "../agent-scopes.js";

/**
 * One message of facts as one write. The CLI turns an agent's intents into the
 * commands their own tools would send; the portal runs them all in one transaction, kept (`apply`) or rolled back
 * (`preview`).
 */

/** The command routes a changeset may carry, each run through the same handler as its own route. */
export const CHANGESET_ROUTES = [
  "/api/commands/entity",
  "/api/commands/project",
  "/api/commands/action",
  "/api/commands/commitment-recurrence",
  "/api/commands/session"
] as const;
export type ChangesetRoute = (typeof CHANGESET_ROUTES)[number];

/** At most this many commands in one changeset: a message's worth, not an import. */
export const CHANGESET_MAX_ITEMS = 60;

/** The agent's doubt about one fact, kept with the write so the person can see it. */
export const CHANGESET_QUESTION_MAX = 300;

export const changesetItemSchema = z.object({
  /** Where this command came from in the agent's list (0-based), so every outcome names the intent. */
  intent: z.number().int().nonnegative(),
  path: z.enum(CHANGESET_ROUTES),
  /** The command exactly as its route takes it; the route's own schema checks it. */
  payload: z.record(z.string(), z.unknown()),
  /** What a create made, for the duplicate check: the plan-search kind and the id the record is stored under. */
  creates: z.object({ kind: z.string().min(1), id: z.string().min(1) }).optional(),
  basis: agentBasisSchema.optional(),
  evidence: z.string().trim().min(1).max(AGENT_PROPOSAL_EVIDENCE_MAX).optional(),
  question: z.string().trim().min(1).max(CHANGESET_QUESTION_MAX).optional()
});
export type ChangesetItem = z.infer<typeof changesetItemSchema>;

export const changesetCommandSchema = z
  .object({
    commandId: z.string().uuid(),
    mode: z.enum(["preview", "apply"]),
    /**
     * Apply nothing: answer with what an apply under this command id already kept, or refuse. A retried apply whose
     * answer was lost rebuilds against the plan it changed, so its commands differ; this finds the receipt instead.
     */
    replay: z.boolean().optional(),
    /**
     * SHA-256 of what the agent submitted (its intents as typed), not of the commands built from them. Those are rebuilt
     * against the plan on a retry and so differ; the intents do not. The receipt keeps it, so the same id with other
     * intents is refused (409) while an honest retry replays.
     */
    inputHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    items: z.array(changesetItemSchema).max(CHANGESET_MAX_ITEMS)
  })
  .superRefine((command, context) => {
    if (command.replay !== true && command.items.length === 0)
      context.addIssue({ code: "custom", message: "A changeset needs at least one command.", path: ["items"] });
    // Each command is its own write, kept and undone by its id: a repeat would be a no-op reported as applied,
    // listed twice in the set, and the set could then never be undone.
    const seen = new Set<string>([command.commandId]);
    command.items.forEach((item, index) => {
      const id = item.payload.commandId;
      if (typeof id !== "string") return;
      if (seen.has(id))
        context.addIssue({
          code: "custom",
          message: "Each command needs its own commandId, different from the changeset's.",
          path: ["items", index, "payload", "commandId"]
        });
      seen.add(id);
    });
  });
export type ChangesetCommand = z.infer<typeof changesetCommandSchema>;

/** A record plan search finds like the one a create would make. */
export interface ChangesetDuplicate {
  kind: string;
  id: string;
  title: string;
  status?: string;
  /** True when the record is another create in this same changeset. */
  inThisChangeset?: boolean;
}

export type ChangesetOutcome =
  /** It applies (preview: it would). */
  | { intent: number; outcome: "applies"; commandId: string; undoable: boolean }
  /** The hard floor or the token's `directWrites` files it for the person; `instead` names what the agent can do. */
  | { intent: number; outcome: "proposal"; commandId: string; reason: string; instead?: string; proposalId?: string }
  /** The record changed since it was read. */
  | { intent: number; outcome: "conflict"; commandId: string; message: string }
  /** The command was refused: its handler's own message. */
  | { intent: number; outcome: "invalid"; commandId: string; message: string };

export interface ChangesetItemResult {
  intent: number;
  outcome: ChangesetOutcome["outcome"];
  commandId: string;
  undoable?: boolean;
  reason?: string;
  instead?: string;
  proposalId?: string;
  message?: string;
  /** For a write the proposal store refused: its HTTP status (409 already pending, 429 too many waiting). */
  status?: number;
  likelyDuplicates?: ChangesetDuplicate[];
}

export interface ChangesetResult {
  mode: "preview" | "apply";
  /** True when every item applies or is filed as a proposal (apply: and the set was kept). */
  ok: boolean;
  /** The changeset's own id: what `undo` reverts as one write. Present once applied. */
  changesetId?: string;
  items: ChangesetItemResult[];
}

/** The routes a proposal can hold: the three saves `entity_command_batch` replays. Session and recurrence commands cannot be filed. */
export const CHANGESET_PROPOSABLE_ROUTES: readonly string[] = [
  "/api/commands/entity",
  "/api/commands/project",
  "/api/commands/action"
];

/** Why a whole changeset is the owner's to confirm, and what it takes to file it. */
export interface ChangesetFloor {
  /** Written for the agent: the problem and the next call. */
  reason: string;
  /** Where the owner confirms it. */
  instead: string;
  /** Updates, status changes and removals in the set (creates are not counted). */
  changes: number;
  touchesPeople: boolean;
  /** Intents on routes a proposal cannot hold; when any, the set is refused and must be split. */
  unfileable: number[];
}

/**
 * The hard floor applied to a changeset as a whole (the per-command floor judges each item alone and never sees
 * the count). More than `BULK_PROPOSAL_THRESHOLD` updates, status changes or removals, or any command that touches
 * another person, floors the entire set: nothing applies on its own, and the owner confirms all of it or none.
 */
export function changesetFloor(
  items: readonly { intent: number; path: string; creates?: unknown; touchesPeople?: boolean | undefined }[]
): ChangesetFloor | null {
  const changes = items.filter((item) => !item.creates).length;
  const touchesPeople = items.some((item) => item.touchesPeople === true);
  const bulk = changes > BULK_PROPOSAL_THRESHOLD;
  if (!bulk && !touchesPeople) return null;
  const unfileable = items
    .filter((item) => !CHANGESET_PROPOSABLE_ROUTES.includes(item.path))
    .map((item) => item.intent);
  const why = [
    ...(bulk
      ? [`it changes ${changes} existing records, over the ${BULK_PROPOSAL_THRESHOLD} an agent may change in one set`]
      : []),
    ...(touchesPeople
      ? ["at least one command touches another person (the family calendar or something sent outward)"]
      : [])
  ].join(" and ");
  const reason =
    `changeset: ${why}, so the whole set waits for the owner and none of it applies on its own. ` +
    (unfileable.length > 0
      ? `This set cannot be filed as one proposal because intents ${unfileable.join(", ")} are session or recurrence commands, ` +
        "which a proposal cannot hold. Nothing was done, so split it: send those intents in a changeset of their own " +
        `(kept under ${BULK_PROPOSAL_THRESHOLD} changes and without anything that touches people), then send the rest again.`
      : "It is filed as one all-or-nothing proposal: the owner confirms every command together in Inbox > Captured > From agents, " +
        "and if any record has changed since you read it none of them is applied. Do not send it again; " +
        "check the outcome later with `rhen proposals`.");
  return { reason, instead: "Inbox > Captured > From agents", changes, touchesPeople, unfileable };
}
