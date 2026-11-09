import { z } from "zod";
import {
  geocodeRequestSchema,
  geocodeResultSchema,
  travelMatrixRequestSchema,
  travelMatrixResultSchema
} from "../integrations/travel.js";
import { publicPulseV1Schema } from "../planning/pulse-public.js";
import { videoDurationsRequestSchema, videoDurationsResponseSchema } from "../watch-history.js";
import { CAPABILITY_OPS, type CapabilityId } from "./capabilities.js";
import { calendarReadEventsRequestSchema, calendarReadEventsResponseSchema } from "./events.js";
import {
  calendarSinkCreateRequestSchema,
  calendarSinkRemoveResponseSchema,
  calendarSinkStatusSchema,
  calendarSinkUpdateRequestSchema,
  calendarSinkWriteProofRequestSchema,
  calendarSinkWriteProofResultSchema,
  calendarSinkWriteResponseSchema
} from "./sink.js";
import { connectionFailureReasonSchema } from "./wire.js";

// The wire contract of every capability op, as one table. `CAPABILITY_OPS` says which ops exist; this says what each one
// is sent and what it answers, so a connection and its caller share one definition and a new op cannot ship without
// one. The table is typed over `CAPABILITY_OPS`, so adding an op there is a type error here until its entry exists, and
// `capability-schemas.test.ts` fails on an entry that is neither a pair of schemas nor a listed pending op.

/** An op's request body and its success body, both zod schemas. */
export interface OpSchemas {
  request: z.ZodType;
  response: z.ZodType;
}

/** An op whose schemas are not written yet. The pending list only shrinks: the test names every pending op. */
export interface PendingOpSchemas {
  pending: true;
  reason: string;
}

export type OpSchemaEntry = OpSchemas | PendingOpSchemas;

export type CapabilityOpSchemas = {
  [C in CapabilityId]: { [O in (typeof CAPABILITY_OPS)[C][number]]: OpSchemaEntry };
};

/** The body of an op that takes nothing. A caller sends `{}`. */
export const emptyOpRequestSchema = z.object({});

/** A calendar the account can read. */
export const calendarListEntrySchema = z.object({
  calendarId: z.string().min(1),
  summary: z.string().min(1),
  primary: z.boolean(),
  accessRole: z.string().min(1),
  timezone: z.string().min(1).max(100)
});

export const calendarListResponseSchema = z.object({ calendars: z.array(calendarListEntrySchema) });

/**
 * What a `proof` op answers: nothing configured, a working connection, or a failure with the shared reason. A connected
 * connection may add its own fields (a count, the host it reached); the status and the check time are the contract.
 */
export const connectionProofResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("not_configured"), missing: z.array(z.string()) }),
  z.looseObject({ status: z.literal("connected"), checkedAt: z.string().datetime({ offset: true }) }),
  z.object({
    status: z.literal("failed"),
    checkedAt: z.string().datetime({ offset: true }),
    message: z.string(),
    reason: connectionFailureReasonSchema.optional()
  })
]);

export const statusPublishConfigResponseSchema = z.object({
  configured: z.boolean(),
  host: z.string().nullable()
});

export const statusPublishResultSchema = z.object({
  outcome: z.enum(["delivered", "rejected", "failed"]),
  httpStatus: z.number().int().optional()
});

const calendarSinkEventIdSchema = z.object({ eventId: z.string().min(1) });

const MODEL_PROVIDER_PENDING: PendingOpSchemas = {
  pending: true,
  reason: "The model-provider ops are reshaped by the model-provider seam slice; their schemas land with it."
};

export const CAPABILITY_OP_SCHEMAS: CapabilityOpSchemas = {
  calendar_source: {
    proof: { request: emptyOpRequestSchema, response: connectionProofResultSchema },
    list_calendars: { request: emptyOpRequestSchema, response: calendarListResponseSchema },
    read_events: { request: calendarReadEventsRequestSchema, response: calendarReadEventsResponseSchema }
  },
  calendar_sink: {
    status: { request: emptyOpRequestSchema, response: calendarSinkStatusSchema },
    create: { request: calendarSinkCreateRequestSchema, response: calendarSinkWriteResponseSchema },
    update: {
      request: calendarSinkUpdateRequestSchema.extend(calendarSinkEventIdSchema.shape),
      response: calendarSinkWriteResponseSchema
    },
    remove: { request: calendarSinkEventIdSchema, response: calendarSinkRemoveResponseSchema },
    write_proof: { request: calendarSinkWriteProofRequestSchema, response: calendarSinkWriteProofResultSchema }
  },
  travel_time: {
    matrix: { request: travelMatrixRequestSchema, response: travelMatrixResultSchema }
  },
  geocoding: {
    geocode: { request: geocodeRequestSchema, response: geocodeResultSchema }
  },
  model_provider: {
    extract: MODEL_PROVIDER_PENDING,
    stream: MODEL_PROVIDER_PENDING,
    embed: MODEL_PROVIDER_PENDING,
    complete: MODEL_PROVIDER_PENDING,
    probe: MODEL_PROVIDER_PENDING
  },
  status_publish: {
    config: { request: emptyOpRequestSchema, response: statusPublishConfigResponseSchema },
    publish: { request: publicPulseV1Schema, response: statusPublishResultSchema }
  },
  video_metadata: {
    durations: { request: videoDurationsRequestSchema, response: videoDurationsResponseSchema }
  }
};

export function isPendingOp(entry: OpSchemaEntry | undefined): entry is PendingOpSchemas {
  return entry !== undefined && "pending" in entry && entry.pending === true;
}

/**
 * `capability.op` for every op in `ops` that has no entry in `table`, or an entry that is neither a pair of schemas nor
 * a pending marker. Takes both as arguments so a test can hand it a fixture op.
 */
export function opsMissingSchemas(
  ops: Readonly<Record<string, readonly string[]>>,
  table: Readonly<Record<string, Readonly<Record<string, unknown>> | undefined>>
): string[] {
  const missing: string[] = [];
  for (const [capability, names] of Object.entries(ops)) {
    for (const op of names) {
      const entry = table[capability]?.[op] as Partial<OpSchemas & PendingOpSchemas> | undefined;
      const hasSchemas = entry?.request instanceof z.ZodType && entry.response instanceof z.ZodType;
      if (!hasSchemas && entry?.pending !== true) missing.push(`${capability}.${op}`);
    }
  }
  return missing;
}

/** `capability.op` for every pending op in the table. */
export function pendingOps(table: Readonly<Record<string, Readonly<Record<string, unknown>> | undefined>>): string[] {
  return Object.entries(table).flatMap(([capability, ops]) =>
    Object.entries(ops ?? {})
      .filter(([, entry]) => isPendingOp(entry as OpSchemaEntry))
      .map(([op]) => `${capability}.${op}`)
  );
}
