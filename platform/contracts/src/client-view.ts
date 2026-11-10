import { z } from "zod";
import { withoutDatePatterns } from "./agent-sessions.js";
import { pendingLocationSuggestionSchema } from "./planning/location-observation.js";

/**
 * The client view: the read an installed app (or any other owner client) makes for "what is on, what is next, what
 * is waiting", `GET /api/client/view?parts=now,day,pending`, and the answer of `POST /api/check-ins/{id}/shown`.
 * The types here are the app's contract. They are exported as JSON Schema into
 * `platform/contracts/client-view-schema.v1.json` and each type has an example in
 * `platform/contracts/client-view-fixtures.v1.json`; `portal/server/client-view-schema.test.ts` fails when either
 * file is stale, and parses real route output with the schemas below.
 *
 * Every instant is ISO 8601 with an offset (`Z` is the zero offset). Objects may gain fields; a client ignores the
 * ones it does not know.
 */

export const CLIENT_VIEW_SCHEMA_VERSION = 1;

/** The parts a client may ask for, in the order the response carries them. */
export const CLIENT_VIEW_PARTS = ["now", "day", "pending"] as const;
export type ClientViewPart = (typeof CLIENT_VIEW_PARTS)[number];

const instant = z.string().datetime({ offset: true });

const thenSummarySchema = z.looseObject({
  kind: z.string(),
  targetId: z.string(),
  title: z.string(),
  recommendedMinutes: z.number()
});

const nextFitSchema = z.looseObject({
  kind: z.string(),
  targetId: z.string(),
  title: z.string(),
  recommendedMinutes: z.number(),
  at: instant
});

/** `NowAnswer.directive` (`planning/now-answer.ts`): what to do now, with the fields each kind adds. */
export const clientDirectiveSchema = z.looseObject({
  kind: z.string(),
  title: z.string(),
  recommendedMinutes: z.number(),
  targetId: z.string().optional(),
  /** An `action` directive only: the version the `start` command checks (the series template's for an occurrence). */
  expectedVersion: z.number().int().optional(),
  reason: z.string().optional(),
  tier: z.string().optional(),
  projectId: z.string().optional(),
  projectTitle: z.string().optional(),
  toLocationId: z.string().optional(),
  toLocationName: z.string().optional(),
  mode: z.string().optional(),
  leaveBy: instant.optional(),
  travelSource: z.string().optional(),
  typicalMinutes: z.number().optional(),
  originAssumed: z.boolean().optional(),
  notBefore: instant.optional(),
  // oxlint-disable-next-line unicorn/no-thenable -- `then` is a domain field of the travel directive, not a promise continuation
  then: thenSummarySchema.optional(),
  boundaryAt: instant.optional(),
  boundaryKind: z.string().optional(),
  boundaryTitle: z.string().optional(),
  boundaryEdge: z.string().optional(),
  nextFit: nextFitSchema.nullable().optional(),
  question: z.string().optional(),
  contextIds: z.array(z.string()).optional(),
  candidate: thenSummarySchema.nullable().optional(),
  sleep: z
    .looseObject({
      startsAt: instant,
      wakesAt: instant,
      preferredWakeTime: z.string(),
      explanation: z.string(),
      replannedFromMissedStart: z.boolean(),
      currentStep: z
        .looseObject({ id: z.string(), title: z.string(), durationMinutes: z.number(), status: z.string() })
        .optional(),
      wakeConstraint: z
        .looseObject({ commitmentId: z.string(), title: z.string().optional(), protectedStartAt: instant })
        .optional()
    })
    .optional()
});

const needSchema = z.looseObject({
  fact: z.enum(["wake", "session_end", "energy", "location", "date", "effort"]),
  subjectId: z.string().optional(),
  title: z.string(),
  question: z.string(),
  asOf: instant.optional(),
  blocksDirective: z.boolean(),
  answer: z.looseObject({
    tool: z.string(),
    action: z.string(),
    fields: z.array(z.string()),
    cli: z.string(),
    call: z.looseObject({ tool: z.string(), arguments: z.record(z.string(), z.unknown()) }),
    instructions: z.string().optional()
  })
});

/** `NowAnswer` (`planning/now-answer.ts`), exactly what the web's Now and `rhen status` are built from. */
export const clientNowSchema = z.looseObject({
  directive: clientDirectiveSchema.nullable(),
  anchors: z.object({ open: z.array(z.string()), engaged: z.array(z.string()) }),
  needs: z.array(needSchema),
  /** The offer to stretch a session; `text` is the sentence to show. Other fields are the engine's own. */
  stretchOffer: z.looseObject({ text: z.string(), endsAt: instant }).nullable(),
  /** The running stretch, today's count and the morning-after loan line. */
  stretch: z.looseObject({}).nullable(),
  /** What declared low energy is holding back; `text` is the sentence to show. */
  energyCost: z.looseObject({ text: z.string() }).nullable()
});

/** One entry of `buildDay` (`planning/recommendation-answer.ts`): the day plan through local midnight. */
export const clientDayEntrySchema = z.object({
  startsAt: instant,
  endsAt: instant,
  kind: z.string(),
  title: z.string(),
  targetId: z.string().nullable(),
  minutes: z.number(),
  /** `firm` is decided; `projected` is the engine's replay of what would follow. */
  confidence: z.string()
});

/** The waiting check-in. Reading it does not stamp `prompted_at`; `POST /api/check-ins/{id}/shown` does. */
export const clientCheckInSchema = z.object({
  id: z.string(),
  version: z.number().int(),
  slotAt: instant,
  /** Null until a surface reported showing it. */
  promptedAt: instant.nullable(),
  directiveKind: z.string(),
  directiveTargetId: z.string().nullable(),
  directivePhase: z.string().nullable(),
  directiveTitle: z.string(),
  /** `pending` is within its window; `unknown` is the latest slot that went unanswered while nobody was looking. */
  status: z.enum(["pending", "unknown"])
});

export const clientSessionSchema = z.object({
  id: z.string(),
  /** The version the pause, resume and finish commands check as `expectedVersion`. */
  version: z.number().int().optional(),
  status: z.enum(["running", "paused", "feedback"]),
  title: z.string(),
  targetType: z.string().optional(),
  targetId: z.string().optional(),
  startedAt: instant,
  plannedEndAt: instant,
  plannedMinutes: z.number(),
  elapsedMinutes: z.number(),
  /** What a pause froze while paused; otherwise the distance from the request time to `plannedEndAt`. */
  minutesLeft: z.number()
});

/** The leg to leave for (`leaveByPrompts`), only while its phase is `remind` or `leave` and nothing suppresses it. */
export const clientLeaveBySchema = z.object({
  commitmentId: z.string(),
  occurrenceStartsAt: instant,
  title: z.string(),
  leaveBy: instant,
  remindAt: instant,
  phase: z.enum(["remind", "leave"]),
  typicalMinutes: z.number(),
  allowingMinutes: z.number(),
  originAssumed: z.boolean()
});

export const clientPendingSchema = z.object({
  checkIn: clientCheckInSchema.nullable(),
  session: clientSessionSchema.nullable(),
  leaveBy: clientLeaveBySchema.nullable(),
  /** A "move" suggestion from a phone reading; the same one `/api/state` carries as `pendingLocationSuggestion`. */
  placeSuggestion: pendingLocationSuggestionSchema.nullable()
});

/**
 * The response of `GET /api/client/view`. A part appears only when asked for (`parts` defaults to all three). The
 * `ETag` covers the whole body, so a 304 means none of it changed. `validUntil` is when the plan behind `now` and
 * `day` stops being current, null when there is none; a client dims its widgets past it.
 */
export const clientViewSchema = z.looseObject({
  schemaVersion: z.literal(CLIENT_VIEW_SCHEMA_VERSION),
  timezone: z.string(),
  planCurrent: z.boolean(),
  validUntil: instant.nullable(),
  now: clientNowSchema.optional(),
  day: z.array(clientDayEntrySchema).optional(),
  pending: clientPendingSchema.optional()
});

/**
 * The response of `POST /api/check-ins/{id}/shown` (no request body). `stamped` is true on the call that recorded the
 * time and false on a repeat, which changes nothing and returns the first time.
 */
export const checkInShownSchema = z.object({
  id: z.string(),
  status: z.enum(["pending", "on_track", "deviated", "unknown", "superseded"]),
  promptedAt: instant.nullable(),
  stamped: z.boolean()
});

export type ClientView = z.infer<typeof clientViewSchema>;
export type ClientPending = z.infer<typeof clientPendingSchema>;
export type CheckInShown = z.infer<typeof checkInShownSchema>;

/** Every type the app uses for these two routes, by the name its fixture and its schema `$defs` entry share. */
export const CLIENT_VIEW_TYPES = {
  ClientView: clientViewSchema,
  CheckInShown: checkInShownSchema
} as const;

/**
 * The JSON Schema published for client authors (`platform/contracts/client-view-schema.v1.json`). Regenerate after a
 * change, from `platform/contracts`:
 * `../../engine/service/node_modules/.bin/tsx -e "import {clientViewJsonSchema as f} from './src/client-view.ts'; process.stdout.write(JSON.stringify(f(), null, 2) + '\n')" > client-view-schema.v1.json`
 */
export function clientViewJsonSchema(): Record<string, unknown> {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://openrhen.example/schemas/client-view.v1.json",
    title: "OpenRhen client view, version 1",
    description:
      "The types of GET /api/client/view and POST /api/check-ins/{id}/shown, one entry per type under $defs.",
    $defs: Object.fromEntries(
      Object.entries(CLIENT_VIEW_TYPES).map(([name, schema]) => [
        name,
        withoutDatePatterns(z.toJSONSchema(schema, { io: "output", unrepresentable: "any" }))
      ])
    )
  };
}

const T0 = "2026-11-10T09:00:00+11:00";

/**
 * One example per type, written to `platform/contracts/client-view-fixtures.v1.json`. A client decodes each with its
 * own types; the test parses each with the schema above, so the example and the schema cannot disagree. Regenerate:
 * `../../engine/service/node_modules/.bin/tsx -e "import {clientViewFixtures as f} from './src/client-view.ts'; process.stdout.write(JSON.stringify(f(), null, 2) + '\n')" > client-view-fixtures.v1.json`
 */
export function clientViewFixtures(): Record<keyof typeof CLIENT_VIEW_TYPES, unknown[]> {
  return {
    ClientView: [
      {
        schemaVersion: 1,
        timezone: "Australia/Sydney",
        planCurrent: true,
        validUntil: "2026-11-10T09:30:00+11:00",
        now: {
          directive: {
            kind: "action",
            title: "Write section 2",
            recommendedMinutes: 45,
            targetId: "action-1",
            expectedVersion: 3,
            reason: "Due Friday",
            projectId: "project-1",
            projectTitle: "Report"
          },
          anchors: { open: [], engaged: [] },
          needs: [],
          stretchOffer: null,
          stretch: null,
          energyCost: null
        },
        day: [
          {
            startsAt: T0,
            endsAt: "2026-11-10T09:45:00+11:00",
            kind: "action",
            title: "Write section 2",
            targetId: "action-1",
            minutes: 45,
            confidence: "firm"
          }
        ],
        pending: {
          checkIn: {
            id: "6f0c2c1e-3f5b-4f3a-9b0e-2a6d5f0d9a11",
            version: 1,
            slotAt: T0,
            promptedAt: null,
            directiveKind: "action",
            directiveTargetId: "action-1",
            directivePhase: null,
            directiveTitle: "Write section 2",
            status: "pending"
          },
          session: {
            id: "session-1",
            version: 2,
            status: "running",
            title: "Write section 2",
            targetType: "action",
            targetId: "action-1",
            startedAt: T0,
            plannedEndAt: "2026-11-10T09:45:00+11:00",
            plannedMinutes: 45,
            elapsedMinutes: 5,
            minutesLeft: 40
          },
          leaveBy: {
            commitmentId: "commitment-1",
            occurrenceStartsAt: "2026-11-10T11:00:00+11:00",
            title: "Dentist",
            leaveBy: "2026-11-10T10:30:00+11:00",
            remindAt: "2026-11-10T10:15:00+11:00",
            phase: "remind",
            typicalMinutes: 25,
            allowingMinutes: 30,
            originAssumed: false
          },
          placeSuggestion: { locationId: "studio", locationName: "Studio", observedAt: T0 }
        }
      },
      {
        schemaVersion: 1,
        timezone: "Australia/Sydney",
        planCurrent: false,
        validUntil: null,
        pending: { checkIn: null, session: null, leaveBy: null, placeSuggestion: null }
      }
    ],
    CheckInShown: [
      { id: "6f0c2c1e-3f5b-4f3a-9b0e-2a6d5f0d9a11", status: "pending", promptedAt: T0, stamped: true },
      { id: "6f0c2c1e-3f5b-4f3a-9b0e-2a6d5f0d9a11", status: "pending", promptedAt: T0, stamped: false }
    ]
  };
}
