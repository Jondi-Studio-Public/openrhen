import { z } from "zod";

/**
 * A condition is one of four semantically different things, and the distinction is the whole
 * point: a location describes where you are, a capability describes what you can use, a contact
 * describes who you can reach, and a commitment describes what is live right now. Treating them as
 * one undifferentiated set is what made `home` and `desktop` behave identically.
 *
 * `live` is deliberately narrow: it is satisfied only while now falls inside the actual
 * window of a confirmed, non-cancelled occurrence of the named recurrence rule (or the named
 * one-off commitment) — never its setup, travel, or transition buffers. It exists for a
 * requirement that can only ever be true while a specific class or meeting is actually in
 * progress ("only while the class is running"), which a location or a portable capability
 * cannot express: a location says where you are, not whether something is currently happening
 * there, and a portable capability travels with the person rather than gating on a live event.
 */
export const conditionKindSchema = z.enum(["location", "capability", "contact", "live"]);
export type ConditionKind = z.infer<typeof conditionKindSchema>;

/**
 * Fixed capabilities are inferred from the current location's grants. Portable ones travel with you
 * and hold their own state, so moving from home to campus must never silently drop the laptop you
 * carried there.
 */
export const conditionPortabilitySchema = z.enum(["fixed", "portable"]);
export type ConditionPortability = z.infer<typeof conditionPortabilitySchema>;

/**
 * Gates matching for contacts: a contact carrying any remote channel is reachable wherever you are,
 * while an `in_person`-only contact is inferred from the current location's grants like a fixed
 * capability. Declaring no channel leaves the contact unknown rather than unreachable.
 */
/**
 * One asserted fact — where you are — plus the exceptions to what that normally implies.
 * `overrides` are momentary and are cleared when the location changes; `carrying` is deliberately
 * durable across location changes because a portable device does not stop being with you.
 */
export const transportModeSchema = z.enum(["car", "bike", "walk"]);
export type TransportMode = z.infer<typeof transportModeSchema>;

export const contactChannelSchema = z.enum(["in_person", "sync_remote", "async"]);
export type ContactChannel = z.infer<typeof contactChannelSchema>;

export const conditionStatusSchema = z.enum(["active", "archived"]);
export type ConditionStatus = z.infer<typeof conditionStatusSchema>;

/**
 * Capabilities are instances, not classes. `desktop` is that specific machine with its files and
 * software; `laptop` is a different machine with different capability. There is deliberately no
 * generic `computer` condition, because it would assert an interchangeability that does not exist.
 * Where several routes genuinely do the same job, express that as a composite named for what it
 * enables, such as `video-call-capable`, rather than as a device class.
 */
const conditionDefinitionObjectSchema = z.object({
  id: z.string().min(1),
  version: z.number().int().positive().optional(),
  name: z.string().min(1),
  kind: conditionKindSchema,
  status: conditionStatusSchema.default("active"),

  /**
   * Capability only. Empty means primitive: availability is asserted or inferred, never derived.
   * Non-empty makes the capability composite, available when ANY pathway is fully satisfied.
   */
  pathways: z.array(z.array(z.string().min(1)).min(1)).default([]),
  /** Capability only. Ignored for composites, whose availability comes from their pathways. */
  portability: conditionPortabilitySchema.default("fixed"),

  /** Location only. Fixed capabilities and contacts normally available here. */
  grants: z.array(z.string().min(1)).default([]),
  /**
   * Location only. The fallback travel cost, used when no live estimate covers this place. A live
   * estimate is preferred where one exists because it knows which way you can actually travel today.
   */
  travelMinutes: z.number().finite().min(0).optional(),
  /** Location only. Where the place actually is, so travel can be measured rather than guessed. */
  latitude: z.number().finite().min(-90).max(90).optional(),
  longitude: z.number().finite().min(-180).max(180).optional(),
  /**
   * Location only. The address the coordinates came from, kept solely so a person can recognise the
   * place. It is never read back as a location — the coordinates are the truth — and it exists only
   * alongside them, because a label describing coordinates that are gone or hand-changed is a lie.
   */
  address: z.string().min(1).optional(),
  /** Location only. Carried over from the former location_profiles table. */
  setupBeforeMinutes: z.number().finite().min(0).default(0),
  transitionAfterMinutes: z.number().finite().min(0).default(0),
  /**
   * Location only. How you usually get here, read by `resolveMode` ahead of the user's default
   * Persisted by a later task; declared here,
   * minimally, so the engine's mode order can read it as soon as it is set.
   */
  usualTransportMode: transportModeSchema.optional(),
  defaultRoutinePresetId: z.string().min(1).optional(),
  /**
   * Location only. Created quietly from a one-off place search on a commitment. It exists for the
   * commitment(s) referencing it, stays out of the normal place pickers and the settings list, and
   * is archived automatically once nothing upcoming refers to it.
   */
  oneOff: z.boolean().optional(),

  /** Contact only. */
  channels: z.array(contactChannelSchema).default([]),
  /**
   * Contact only. Where a prefilled text or email is addressed.
   * Nothing is ever sent to either from OpenRhen: they only fill in a compose the person sends.
   */
  phone: z.string().min(1).optional(),
  email: z.string().min(1).optional(),

  /**
   * Live only. Names the recurring series this condition tracks — satisfied while now falls
   * inside the live window of any confirmed, non-cancelled occurrence of this rule. Exactly one of
   * `recurrenceRuleId`/`commitmentId` is required when `kind` is `live`, and neither is
   * accepted otherwise (enforced below).
   */
  recurrenceRuleId: z.string().min(1).optional(),
  /** Live only. Names a single one-off commitment instead of a recurring series. */
  commitmentId: z.string().min(1).optional()
});

/**
 * Refined so a `live` condition always names exactly one of a rule or a one-off commitment,
 * and every other kind names neither — the reference is meaningless (and, worse, silently ignored)
 * outside the one kind that resolves it.
 */
export const conditionDefinitionSchema = conditionDefinitionObjectSchema.superRefine((definition, context) => {
  if (definition.kind === "live") {
    const set = [definition.recurrenceRuleId, definition.commitmentId].filter((value) => value !== undefined);
    if (set.length !== 1) {
      context.addIssue({
        code: "custom",
        path: ["recurrenceRuleId"],
        message: "A live condition needs exactly one of recurrenceRuleId or commitmentId."
      });
    }
  } else {
    if (definition.recurrenceRuleId !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["recurrenceRuleId"],
        message: "recurrenceRuleId only applies to a live condition."
      });
    }
    if (definition.commitmentId !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["commitmentId"],
        message: "commitmentId only applies to a live condition."
      });
    }
  }
});
export type ConditionDefinition = z.infer<typeof conditionDefinitionSchema>;

/**
 * Requirements are AND within a pathway. An action is eligible when ANY pathway is satisfied.
 * `contextIds` is the requirement side's own field name (see `context-match.ts`'s matcher and
 * `action_requirements`/`action_requirement_pathways`) and is unchanged by this rename: the
 * requirement side already has its correct vocabulary and stays untouched.
 */
export const requirementPathwaySchema = z.object({
  id: z.string().min(1),
  contextIds: z.array(z.string().min(1)).min(1)
});
export type RequirementPathway = z.infer<typeof requirementPathwaySchema>;

/**
 * One journey to a place, by the quickest mode currently available to you. `measured` (the default)
 * came from the routing proxy; `assumed_reverse` is the leg you just travelled, seeded backwards on
 * arrival so the way home is known without another measurement.
 */
export const travelEstimateSourceSchema = z.enum(["measured", "assumed_reverse"]);
export type TravelEstimateSource = z.infer<typeof travelEstimateSourceSchema>;
export const travelEstimateSchema = z.object({
  minutes: z.number().finite().min(0),
  mode: transportModeSchema,
  refreshedAt: z.string().datetime({ offset: true }),
  source: travelEstimateSourceSchema.optional()
});
export type TravelEstimate = z.infer<typeof travelEstimateSchema>;

export const currentSituationSchema = z.object({
  locationId: z.string().min(1).nullable().default(null),
  locationSetAt: z.string().datetime({ offset: true }).optional(),
  /**
   * When `currentEnergy` was last said: set by the server when the value changes or the person asserts
   * it again, never by a write that merely resends it. Absent reads as
   * stale, so the engine plans on the window's energy until it is said.
   */
  energySetAt: z.string().datetime({ offset: true }).optional(),
  overrides: z.record(z.string().min(1), z.enum(["available", "unavailable"])).default({}),
  carrying: z.record(z.string().min(1), z.boolean()).default({}),
  /**
   * How you can travel right now. Empty means you cannot get anywhere, and nothing elsewhere is
   * offered as a trip — which is the point: without a car, a bike or the ability to walk, work that
   * needs another place is not a choice you have, and showing it as one is noise.
   * Defaults to all three so that unticking is the deliberate act.
   */
  transportModes: z.array(transportModeSchema).default(["car", "bike", "walk"]),
  /**
   * Measured travel to each location, keyed by location id. Retired by the journey store
   * a live reading now comes from the request's journey summary
   * instead. Kept only so an old stored situation still parses; the engine no longer reads either
   * field.
   */
  travel: z.record(z.string().min(1), travelEstimateSchema).default({}),
  travelRefreshedAt: z.string().datetime({ offset: true }).optional(),
  /**
   * Stops directed trips only: plan-required legs to a commitment or home are still planned
   * Persisted by a later task; declared
   * here, minimally, so the engine can read it as soon as it is set.
   */
  travelOff: z.boolean().default(false),
  /**
   * On my way: a pulse confirmation of the journey to a
   * commitment, written through this same situation command. Cleared only by an assertion of a place
   * other than `fromLocationId` — a same-place refresh (e.g. a phone ping that only bumps
   * `locationSetAt`) must not clear it.
   */
  underway: z
    .object({
      commitmentId: z.string().min(1),
      occurrenceStartsAt: z.string().datetime({ offset: true }),
      fromLocationId: z.string().min(1),
      departedAt: z.string().datetime({ offset: true })
    })
    .nullable()
    .optional()
});
export type CurrentSituation = z.infer<typeof currentSituationSchema>;

/**
 * Three-valued, because most requirements are simply undetermined most of the time. Collapsing
 * unknown to false hides work you could have done; collapsing it to true is the bug this replaces.
 */
export const truthSchema = z.enum(["yes", "no", "unknown"]);
export type Truth = z.infer<typeof truthSchema>;

export const conditionReachSchema = z.object({
  locationId: z.string().min(1),
  travelMinutes: z.number().finite().min(0),
  /** Absent when the figure is the location's stored fallback rather than a measured journey. */
  mode: transportModeSchema.optional()
});
export type ConditionReach = z.infer<typeof conditionReachSchema>;

export const liveHoldSchema = z.object({
  /** Ready-to-show copy, e.g. "Only during class.", mirroring `reachableVia`'s role for a location hold. */
  unavailableReason: z.string().min(1),
  /** The next matching confirmed occurrence's start, when one is already known to the caller's commitments. */
  availableFrom: z.string().datetime({ offset: true }).optional()
});
export type LiveHold = z.infer<typeof liveHoldSchema>;

export const conditionMatchSchema = z.object({
  status: truthSchema,
  /** Set only when status is "yes". */
  satisfiedPathwayId: z.string().min(1).optional(),
  /** Known-unavailable requirements from the best pathway. */
  missing: z.array(z.string().min(1)).default([]),
  /** Undetermined requirements from the best pathway; each is a question worth asking. */
  unknowns: z.array(z.string().min(1)).default([]),
  /** Soft misses. These never affect eligibility, only ranking. */
  unmetPreferences: z.array(z.string().min(1)).default([]),
  /** Present when the only thing standing in the way is being somewhere else. */
  reachableVia: conditionReachSchema.optional(),
  /** Present when the only thing standing in the way is a commitment not currently live. */
  commitmentHold: liveHoldSchema.optional()
});
export type ConditionMatch = z.infer<typeof conditionMatchSchema>;

export {
  ACTIVITY_STALE_GRACE_HOURS,
  DEFAULT_LOCATION_STALE_AFTER_MINUTES,
  EFFORT_STALE_DAYS,
  ENERGY_STALE_HOURS,
  PAUSED_SESSION_STALE_HOURS,
  SESSION_STALE_MIN_GRACE_MINUTES,
  WAKE_STALE_GRACE_HOURS
} from "./context-constants.js";
