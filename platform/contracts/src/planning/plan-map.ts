import { z } from "zod";
import { openQuestionSchema } from "../questions.js";

/**
 * Plan map link store. The vocabulary the stored tables
 * `plan_subjects`, `plan_links`, `plan_findings` and `plan_map_switches` share with their readers, and
 * the pure rules about what a link may join, when a suggestion lapses and when a pair may be proposed
 * again. Pure so the portal store, the sweep and later proposers agree by construction.
 */

/** A suggestion nobody has decided on lapses after this many days. */
export const PLAN_LINK_SUGGESTION_TTL_DAYS = 30;
/** `plan_shadow_log` rows older than this many days are pruned by the sweep. */
export const PLAN_SHADOW_LOG_RETENTION_DAYS = 60;

export const PLAN_LINK_KINDS = [
  "about",
  "counts_toward",
  "prepares",
  "before",
  "occurrence_of",
  "involves",
  "references"
] as const;
export const planLinkKindSchema = z.enum(PLAN_LINK_KINDS);
export type PlanLinkKind = z.infer<typeof planLinkKindSchema>;

export const PLAN_LINK_STATUSES = ["suggested", "confirmed", "rejected", "expired"] as const;
export const planLinkStatusSchema = z.enum(PLAN_LINK_STATUSES);
export type PlanLinkStatus = z.infer<typeof planLinkStatusSchema>;

/** `owner` (a link made by hand), `tga`, `reviewer`, or a named rule or model: `rule:<name>`, `model:<name>`. */
export const planLinkProposerSchema = z
  .string()
  .regex(/^(owner|tga|reviewer|rule:[A-Za-z0-9_.-]+|model:[A-Za-z0-9_.:-]+)$/, "Unknown proposer");
export type PlanLinkProposer = z.infer<typeof planLinkProposerSchema>;

/** The proposer a link made by hand stores. */
export const OWNER_PROPOSER = "owner";

/** Hand-made: `owner`. Any other value, including a retired spelling, is not hand-made. */
export function isOwnerProposer(proposer: string): boolean {
  return proposer === OWNER_PROPOSER;
}

export const PLAN_ITEM_TYPES = [
  "area",
  "outcome",
  "project",
  "deliverable",
  "action",
  "commitment",
  "contact",
  "place",
  "source",
  "subject"
] as const;
export const planItemTypeSchema = z.enum(PLAN_ITEM_TYPES);
export type PlanItemType = z.infer<typeof planItemTypeSchema>;

export const PLAN_MAP_ADDONS = [
  "proposers",
  "health_checks",
  "explorer",
  "executor",
  "nudge",
  "reviewer",
  "jev_subjects",
  "capture_placement",
  "backfill",
  "email_drafts",
  "email_needs_reply",
  "catch_up"
] as const;
/**
 * The retired `navigator` switch was never read: the map page and CLI use the navigator ungated. A stored
 * row (or a backup that carries one) is kept and ignored; nothing lists or sets it.
 */
export const RETIRED_ADDONS = ["navigator"] as const;
export const planMapAddonSchema = z.enum(PLAN_MAP_ADDONS);
export type PlanMapAddon = z.infer<typeof planMapAddonSchema>;

export const PLAN_MAP_MODES = ["off", "shadow", "on"] as const;
export const planMapModeSchema = z.enum(PLAN_MAP_MODES);
export type PlanMapMode = z.infer<typeof planMapModeSchema>;

/**
 * The only add-ons that keep a switch (owner decision, 2026-10-26): they change a plan or a ranking on their own, which he
 * asked to vet first (2026-10-01), plus two he turned off himself and has not yet said to turn on (`jev_subjects`,
 * `email_needs_reply`). Every other add-on is always on; a stored row for one is kept and ignored.
 */
export const SWITCHABLE_ADDONS = [
  "executor",
  "nudge",
  "capture_placement",
  "jev_subjects",
  "email_needs_reply"
] as const;
export const switchableAddonSchema = z.enum(SWITCHABLE_ADDONS);
export type SwitchableAddon = z.infer<typeof switchableAddonSchema>;

/** True for an add-on that has no switch: it always runs. */
export function isAlwaysOn(addon: PlanMapAddon): boolean {
  return !(SWITCHABLE_ADDONS as readonly string[]).includes(addon);
}

/** Switchable add-ons with no shadow mode: the panel offers only off and on. */
export const ON_OFF_ONLY_ADDONS: readonly PlanMapAddon[] = ["jev_subjects", "email_needs_reply"];

/**
 * The one place a stored switch becomes the mode that applies. An add-on without a switch is `on` whatever a
 * stored row says; a switchable one reads its stored mode, and an absent or unknown one is `defaultSwitchMode()`.
 * An on/off-only add-on never runs in shadow: a stored `shadow` reads as `on` for `jev_subjects` (where it behaved like on) and `off` for the other.
 */
export function effectiveMode(addon: PlanMapAddon, stored: PlanMapMode | string | null | undefined): PlanMapMode {
  if (isAlwaysOn(addon)) return "on";
  const mode = planMapModeSchema.safeParse(stored);
  if (!mode.success) return defaultSwitchMode();
  if (mode.data === "shadow" && ON_OFF_ONLY_ADDONS.includes(addon)) return addon === "jev_subjects" ? "on" : "off";
  return mode.data;
}

/** A switchable add-on is off until the owner sets it; an absent `plan_map_switches` row reads as this. */
export function defaultSwitchMode(): PlanMapMode {
  return "off";
}

export const planSubjectStatusSchema = z.enum(["active", "archived"]);

export const planSubjectSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().nullable(),
  status: planSubjectStatusSchema
});
export type PlanSubject = z.infer<typeof planSubjectSchema>;

const isoInstant = z.string();

export const planLinkSchema = z.object({
  id: z.string().uuid(),
  fromType: planItemTypeSchema,
  fromId: z.string().min(1),
  toType: planItemTypeSchema,
  toId: z.string().min(1),
  kind: planLinkKindSchema,
  weight: z.number().min(0).max(1).nullable(),
  status: planLinkStatusSchema,
  proposer: planLinkProposerSchema,
  evidence: z.array(z.string()),
  createdAt: isoInstant,
  decidedAt: isoInstant.nullable(),
  lastConfirmedAt: isoInstant.nullable()
});
export type PlanLink = z.infer<typeof planLinkSchema>;

/** What a person (or the import path) supplies to link by hand. */
export const planLinkInputSchema = z.object({
  fromType: planItemTypeSchema,
  fromId: z.string().min(1),
  toType: planItemTypeSchema,
  toId: z.string().min(1),
  kind: planLinkKindSchema,
  weight: z.number().min(0).max(1).nullable().optional(),
  evidence: z.array(z.string()).optional()
});
export type PlanLinkInput = z.infer<typeof planLinkInputSchema>;

export const planFindingStatusSchema = z.enum(["open", "accepted", "dismissed"]);
export type PlanFindingStatus = z.infer<typeof planFindingStatusSchema>;

export const planFindingSchema = z.object({
  id: z.string().uuid(),
  checkName: z.string().min(1),
  /** The items the finding is about, as `<type>:<id>` handles. */
  itemIds: z.array(z.string()),
  text: z.string().min(1),
  evidence: z.array(z.string()),
  /** Suggested links or plan changes; opened as an ordinary import preview when accepted. */
  suggestedChanges: z.array(z.unknown()),
  /** The shared open-question shape: a finding that asks the owner something is accepted only once it is answered. */
  questions: z.array(openQuestionSchema).default([]),
  status: planFindingStatusSchema,
  createdAt: isoInstant,
  decidedAt: isoInstant.nullable()
});
export type PlanFinding = z.infer<typeof planFindingSchema>;

export const planMapSwitchSchema = z.object({ addon: switchableAddonSchema, mode: planMapModeSchema });
export type PlanMapSwitch = z.infer<typeof planMapSwitchSchema>;

export const planMapSchema = z.object({
  subjects: z.array(planSubjectSchema),
  links: z.array(planLinkSchema),
  findings: z.array(planFindingSchema),
  /** One entry per switchable add-on, absent rows filled with `defaultSwitchMode()`. */
  switches: z.array(planMapSwitchSchema)
});
export type PlanMap = z.infer<typeof planMapSchema>;

/** `POST /api/plan-map/links/[id]`: what to do with one stored link. */
export const planMapLinkActionSchema = z.object({ action: z.enum(["confirm", "reject", "remove", "reopen"]) });
export type PlanMapLinkAction = z.infer<typeof planMapLinkActionSchema>;

/** `POST /api/plan-map/links/bulk`: confirm every still-suggested link from one proposer of one kind. */
export const planMapBulkConfirmSchema = z.object({ proposer: planLinkProposerSchema, kind: planLinkKindSchema });
export type PlanMapBulkConfirm = z.infer<typeof planMapBulkConfirmSchema>;

/** `POST /api/plan-map/findings/[id]`. */
export const planMapFindingActionSchema = z.object({
  action: z.enum(["accept", "dismiss", "reopen"]),
  /** Answers to the finding's questions, by question field; every question needs one to accept. */
  answers: z.record(z.string(), z.string()).optional()
});
export type PlanMapFindingAction = z.infer<typeof planMapFindingActionSchema>;

/** `PUT /api/plan-map/switches`: only a person's action sets a switch. */
export const planMapSwitchInputSchema = planMapSwitchSchema.refine(
  (input) => input.mode !== "shadow" || !ON_OFF_ONLY_ADDONS.includes(input.addon),
  { message: "This add-on has no shadow mode; set it off or on." }
);
export type PlanMapSwitchInput = z.infer<typeof planMapSwitchInputSchema>;

/** Items that are plan work: what a person plans, as opposed to a contact, place, source or subject. */
const WORK_TYPES: readonly PlanItemType[] = ["area", "outcome", "project", "deliverable", "action", "commitment"];
const ALL_ITEM_TYPES: readonly PlanItemType[] = PLAN_ITEM_TYPES.filter((type) => type !== "subject");

interface EndRule {
  from: readonly PlanItemType[];
  to: readonly PlanItemType[];
}

const END_RULES: Record<PlanLinkKind, EndRule> = {
  about: { from: ALL_ITEM_TYPES, to: ["subject"] },
  involves: { from: WORK_TYPES, to: ["contact"] },
  references: { from: WORK_TYPES, to: ["source"] },
  occurrence_of: { from: ["commitment"], to: ["project"] },
  before: { from: ["project"], to: ["project"] },
  prepares: { from: WORK_TYPES, to: [...WORK_TYPES, "subject"] },
  counts_toward: {
    from: ["project", "deliverable", "action", "commitment"],
    to: ["outcome", "project", "deliverable", "subject"]
  }
};

export type LinkEndsResult = { ok: true } | { ok: false; reason: string };

/** Whether a link of `kind` may run from an item of `fromType` to one of `toType`. */
export function validateLinkEnds(kind: PlanLinkKind, fromType: PlanItemType, toType: PlanItemType): LinkEndsResult {
  const rule = END_RULES[kind];
  if (!rule.from.includes(fromType)) return { ok: false, reason: `A "${kind}" link cannot start at a ${fromType}.` };
  if (!rule.to.includes(toType)) return { ok: false, reason: `A "${kind}" link cannot end at a ${toType}.` };
  return { ok: true };
}

/** `validateLinkEnds` plus the one rule that needs the ids: an item never links to itself. */
export function validateLink(
  link: Pick<PlanLinkInput, "kind" | "fromType" | "fromId" | "toType" | "toId">
): LinkEndsResult {
  if (link.fromType === link.toType && link.fromId === link.toId) {
    return { ok: false, reason: "An item cannot link to itself." };
  }
  return validateLinkEnds(link.kind, link.fromType, link.toType);
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** A suggestion nobody has decided on, older than 30 days. Decided links never expire. */
export function isExpirable(link: Pick<PlanLink, "status" | "createdAt">, now: Date): boolean {
  if (link.status !== "suggested") return false;
  const created = new Date(link.createdAt).getTime();
  if (Number.isNaN(created)) return false;
  return now.getTime() - created > PLAN_LINK_SUGGESTION_TTL_DAYS * DAY_MS;
}

type LinkPair = Pick<PlanLinkInput, "fromType" | "fromId" | "toType" | "toId" | "kind">;

export function sameLinkPair(a: LinkPair, b: LinkPair): boolean {
  return (
    a.kind === b.kind &&
    a.fromType === b.fromType &&
    a.fromId === b.fromId &&
    a.toType === b.toType &&
    a.toId === b.toId
  );
}

/**
 * Whether any proposer may suggest `candidate` now. A rejected pair is never proposed again, by any
 * proposer; an expired one only with new evidence; a pair already suggested or confirmed is not
 * proposed a second time.
 */
export function canPropose(
  existingLinks: readonly (LinkPair & Pick<PlanLink, "status">)[],
  candidate: LinkPair,
  evidenceChanged: boolean
): boolean {
  const existing = existingLinks.find((link) => sameLinkPair(link, candidate));
  if (!existing) return true;
  if (existing.status === "expired") return evidenceChanged;
  return false;
}
