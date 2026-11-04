import { z } from "zod";
import { AGENT_ENTITY_TYPES, validateGrantableScopes } from "./agent-scopes.js";

/**
 * Scoped agent tokens: what an owner sends to create one and what
 * the portal lists back. The token itself is shown once, at creation; nothing here ever holds a hash.
 */

/** Every token starts with this, so a leaked one is recognisable in a log or a repository scan. */
export const AGENT_TOKEN_PREFIX = "pri_";
export const AGENT_TOKEN_DEFAULT_EXPIRY_DAYS = 90;
export const AGENT_TOKEN_MAX_EXPIRY_DAYS = 365;

export const DIRECT_WRITE_MODES = ["off", "shadow", "on"] as const;
export type DirectWriteMode = (typeof DIRECT_WRITE_MODES)[number];

/** The entity classes `directWrites` can promote: those with a write scope (capture and settings never apply directly as facts). */
export const DIRECT_WRITE_CLASSES = AGENT_ENTITY_TYPES.filter((type) => type !== "settings" && type !== "capture");
export type DirectWriteClass = (typeof DIRECT_WRITE_CLASSES)[number];

/** Entity class to mode; a class that is absent is `off`. */
export type DirectWrites = Partial<Record<DirectWriteClass, DirectWriteMode>>;

/**
 * The mode for one class; `off` unless the token says otherwise. Settings has no class of its own: a plan
 * preference applies directly only for a token with every class on (an approved OAuth client, or the Settings
 * switch), so a token made for one job never changes settings.
 */
export function directWriteMode(directWrites: DirectWrites | undefined, entityClass: string): DirectWriteMode {
  if (entityClass === "settings") return hasAllDirectWritesOn(directWrites) ? "on" : "off";
  return (directWrites as Record<string, DirectWriteMode> | undefined)?.[entityClass] ?? "off";
}

/** `directWrites` with every class on: what OAuth approval, `--direct-writes on` and the Settings switch set. */
export function allDirectWritesOn(): DirectWrites {
  return Object.fromEntries(DIRECT_WRITE_CLASSES.map((type) => [type, "on"])) as DirectWrites;
}

/** True when every class applies directly (the Settings switch shows on only then). */
export function hasAllDirectWritesOn(directWrites: Readonly<Record<string, string>> | undefined): boolean {
  return DIRECT_WRITE_CLASSES.every((type) => directWrites?.[type] === "on");
}

export const directWritesSchema = z
  .record(z.string(), z.enum(DIRECT_WRITE_MODES))
  .superRefine((value, context) => {
    for (const key of Object.keys(value))
      if (!(DIRECT_WRITE_CLASSES as readonly string[]).includes(key))
        context.addIssue({ code: "custom", message: `"${key}" is not an entity class that can write directly.` });
  })
  .transform((value) => value as DirectWrites);

/** The name `rhen agent-token create --scopes` accepts in place of a list. */
export const AGENT_SCOPE_PRESETS: Record<string, readonly string[]> = {
  /** Reads the plan, the change feed and its own proposals; writes nothing. */
  "read-only": ["read:plan", "read:changes", "read:proposals"],
  /** Posts session records for agent time and can do nothing else. */
  "agent-time": ["write:agent-session"],
  /** Reads, and can only file things for the owner: captures, proposals, and save/bulk downgraded to proposals. */
  scribe: [
    "read:plan",
    "read:changes",
    "read:proposals",
    "propose:capture",
    "propose:agent-change",
    "propose:entity",
    "propose:catch-up"
  ],
  /** A scribe that can also log everyday facts: sessions, activity, check-ins, arrivals, and undo, recalculate and inbox actions. Entity saves still need `directWrites`. */
  assistant: [
    "read:plan",
    "read:changes",
    "read:proposals",
    "propose:capture",
    "propose:agent-change",
    "propose:catch-up",
    "write:entity",
    "write:session",
    "write:activity",
    "write:check-in",
    "write:arrival",
    // Every write result ends "undo with rhen_undo {}", and an agent that cannot undo, recalculate or
    // settle its own capture is stuck holding a hint it cannot follow.
    "write:undo",
    "write:recalculate",
    "write:inbox",
    // The "running late" recipe logs a disruption, and breakdowns, criteria and steps are deliverables.
    "write:disruption",
    "write:deliverable"
  ]
};

export const agentNameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9_-]{1,32}$/, "name must be 1 to 32 characters of a-z, 0-9, _ or -.")
  .refine((name) => name !== "system" && name !== "human", { message: "That name is reserved." });

export const createAgentTokenSchema = z.object({
  name: agentNameSchema,
  scopes: z
    .array(z.string())
    .min(1, "Grant at least one scope.")
    .max(64)
    .superRefine((scopes, context) => {
      for (const error of validateGrantableScopes(scopes).errors) context.addIssue({ code: "custom", message: error });
    })
    .transform((scopes) => validateGrantableScopes(scopes).scopes),
  directWrites: directWritesSchema.default({}),
  expiresInDays: z.number().int().min(1).max(AGENT_TOKEN_MAX_EXPIRY_DAYS).default(AGENT_TOKEN_DEFAULT_EXPIRY_DAYS)
});
export type CreateAgentToken = z.infer<typeof createAgentTokenSchema>;

/** A token as the list shows it: never the secret and never its hash. */
export const agentTokenSummarySchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  scopes: z.array(z.string()),
  directWrites: z.record(z.string(), z.enum(DIRECT_WRITE_MODES)),
  expiresAt: z.string().datetime({ offset: true }),
  createdAt: z.string().datetime({ offset: true }),
  lastUsedAt: z.string().datetime({ offset: true }).nullable(),
  revokedAt: z.string().datetime({ offset: true }).nullable()
});
export type AgentTokenSummary = z.infer<typeof agentTokenSummarySchema>;

/** Resolves `--scopes`: a preset name, or a comma list. Returns the scope list or a reason. */
export function resolveScopeList(raw: string): { ok: true; scopes: string[] } | { ok: false; reason: string } {
  const text = raw.trim();
  const preset = AGENT_SCOPE_PRESETS[text];
  if (preset) return { ok: true, scopes: [...preset] };
  const list = text
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (list.length === 0) return { ok: false, reason: "Name a preset or a comma list of scopes." };
  const checked = validateGrantableScopes(list);
  return checked.errors.length > 0
    ? { ok: false, reason: checked.errors.join(" ") }
    : { ok: true, scopes: checked.scopes };
}
