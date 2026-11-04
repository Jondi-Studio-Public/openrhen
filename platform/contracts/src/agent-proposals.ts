import { z } from "zod";

/**
 * Agent proposals: a write an agent wants made, held for the
 * person to confirm in the portal. The store is generic; `kind` picks the applier that replays `payload`.
 */

/** Where an agent's claim comes from. Missing means `inferred`. */
export const AGENT_BASES = ["stated", "inferred", "observed"] as const;
export const agentBasisSchema = z.enum(AGENT_BASES);
export type AgentBasis = z.infer<typeof agentBasisSchema>;

export const AGENT_PROPOSAL_STATUSES = ["pending", "confirmed", "rejected", "expired", "stale"] as const;
export const agentProposalStatusSchema = z.enum(AGENT_PROPOSAL_STATUSES);
export type AgentProposalStatus = z.infer<typeof agentProposalStatusSchema>;

export const AGENT_PROPOSAL_SUMMARY_MAX = 300;
export const AGENT_PROPOSAL_EVIDENCE_MAX = 300;
/** The serialized payload of one proposal; a save is far smaller, and the Inbox renders what is stored. */
export const AGENT_PROPOSAL_PAYLOAD_MAX_CHARS = 64 * 1024;

/** An agent may hold this many pending proposals at once; past it the write is refused, not dropped. */
export const AGENT_PROPOSAL_PENDING_CAP = 50;
/** A pending proposal older than this expires when next read. */
export const AGENT_PROPOSAL_EXPIRY_DAYS = 14;

export const proposeAgentChangeSchema = z.object({
  /** The applier that replays `payload` on confirmation, such as `entity_command`. */
  kind: z
    .string()
    .trim()
    .regex(/^[a-z][a-z0-9_]{0,63}$/, "kind must be a lower-case route key such as entity_command."),
  /**
   * Accepted from older clients and ignored on `POST /api/agent-proposals`: the portal writes the line the person
   * reads from the payload itself, so a card cannot say one thing while confirming does another.
   */
  summary: z.string().trim().min(1).max(AGENT_PROPOSAL_SUMMARY_MAX).optional(),
  payload: z
    .record(z.string(), z.unknown())
    .refine((payload) => JSON.stringify(payload).length <= AGENT_PROPOSAL_PAYLOAD_MAX_CHARS, {
      message: "payload is over the 64 KB limit."
    }),
  basis: agentBasisSchema.default("inferred"),
  /** For `stated`, the person's own words. */
  evidence: z.string().trim().min(1).max(AGENT_PROPOSAL_EVIDENCE_MAX).optional(),
  /** Pending proposals from one agent with the same key merge, latest wins. */
  coalesceKey: z.string().trim().min(1).max(200).optional(),
  /** Retrying with the same id returns the stored proposal instead of a second one. */
  commandId: z.string().uuid().optional(),
  /** Entity id to its version when the agent read it; the applier fills this in when it can. */
  targetVersions: z.record(z.string(), z.number().int().nullable()).optional()
});
export type ProposeAgentChange = z.infer<typeof proposeAgentChangeSchema>;

export const agentProposalSchema = z.object({
  id: z.string().uuid(),
  agent: z.string(),
  kind: z.string(),
  summary: z.string(),
  payload: z.record(z.string(), z.unknown()),
  basis: agentBasisSchema,
  evidence: z.string().nullable(),
  targetVersions: z.record(z.string(), z.number().int().nullable()),
  status: agentProposalStatusSchema,
  coalesceKey: z.string().nullable(),
  /** How many times a coalescing proposal was replaced; 1 for one that never was. */
  revision: z.number().int().min(1),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  resolvedAt: z.string().datetime({ offset: true }).nullable(),
  resolvedBy: z.string().nullable(),
  resolutionNote: z.string().nullable(),
  /** Present and true for a write a `directWrites: shadow` setting held back: it would have applied directly. */
  shadow: z.boolean().optional()
});
export type AgentProposal = z.infer<typeof agentProposalSchema>;

export const resolveAgentProposalSchema = z
  .object({
    decision: z.enum(["confirm", "reject"]),
    note: z.string().trim().min(1).max(1000).optional(),
    /**
     * The `revision` of the card the person decided on. A confirm needs it: an agent can replace a pending proposal in
     * place (coalescing), and the person must confirm what they read, not what replaced it while the card was open.
     */
    revision: z.number().int().min(1).optional()
  })
  .refine((input) => input.decision !== "confirm" || input.revision !== undefined, {
    message: "A confirm names the revision it was shown.",
    path: ["revision"]
  });
export type ResolveAgentProposal = z.infer<typeof resolveAgentProposalSchema>;

/** One entity whose version moved since the agent proposed, shown when a confirm is refused as stale. */
export const agentProposalConflictSchema = z.object({
  entity: z.string(),
  proposedAgainst: z.number().int().nullable(),
  current: z.number().int().nullable()
});
export type AgentProposalConflict = z.infer<typeof agentProposalConflictSchema>;

/** The payload of the built-in `entity_command` kind: which write path to replay, and its exact body. */
export const entityCommandPayloadSchema = z.object({
  command: z.enum(["save_entity", "save_project", "save_action"]),
  body: z.record(z.string(), z.unknown())
});
export type EntityCommandPayload = z.infer<typeof entityCommandPayloadSchema>;

/** Most rows one batch proposal may carry; each is validated when it is proposed. */
export const ENTITY_COMMAND_BATCH_MAX = 500;

/** The payload of the `entity_command_batch` kind: a bulk write held as one proposal, confirmed once. */
export const entityCommandBatchPayloadSchema = z.object({
  commands: z.array(entityCommandPayloadSchema).min(1).max(ENTITY_COMMAND_BATCH_MAX),
  /**
   * All or nothing: confirming applies every row in one transaction, each target checked at the version the agent
   * read, and any failure rolls the whole batch back. Without it rows apply one by one and a failure keeps the earlier
   * rows. A floored changeset is filed this way.
   */
  atomic: z.boolean().optional()
});
export type EntityCommandBatchPayload = z.infer<typeof entityCommandBatchPayloadSchema>;
