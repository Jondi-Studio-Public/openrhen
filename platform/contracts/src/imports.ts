import { z } from "zod";
import { connectionIdSchema, extensionSourceIds } from "./connections/connection-id.js";
import { calendarSourceConnections } from "./connections/registry.js";

export const importEntityTypeSchema = z.enum([
  "area",
  "outcome",
  "project",
  "deliverable",
  "deliverable_dependency",
  "action",
  "dependency",
  // Every prerequisite edge `dependency` and `deliverable_dependency` cannot hold.
  "entity_prerequisite",
  "fixed_commitment",
  "fixed_commitment_recurrence",
  "condition_definition",
  // A stored plan-map link: create-only, written confirmed, never deletes.
  "plan_link"
]);
export const importFieldBasisSchema = z.enum(["explicit", "inferred", "default", "missing"]);
/**
 * Where a field's reading came from: a cell the source actually had (`cell`, blank or not), or a
 * column the source did not carry at all (`absent`). The distinction only matters when the value is
 * null — a blank cell clears the stored value on an update; an absent column leaves it untouched —
 * and a field that does not say is read as `cell`, which is what every source before this recorded.
 */
export const importFieldSourceSchema = z.enum(["cell", "absent"]);
export const importFieldSchema = z
  .object({
    value: z.unknown().nullable(),
    basis: importFieldBasisSchema,
    confidence: z.enum(["high", "medium", "low"]).nullable(),
    evidence: z.array(z.string().max(500)).default([]),
    needsReview: z.boolean(),
    source: importFieldSourceSchema.optional()
  })
  .superRefine((field, context) => {
    if (field.basis === "missing" && field.value !== null)
      context.addIssue({ code: "custom", message: "Missing fields must have a null value." });
    if (field.basis !== "missing" && field.value === null)
      context.addIssue({ code: "custom", message: "A null value must be marked missing." });
  });

export const importRecordSchema = z.object({
  id: z.string().uuid(),
  importKey: z.string().trim().min(1).max(120),
  entityType: importEntityTypeSchema,
  // `link` attaches a remote calendar event to a commitment OpenRhen already holds, and `unlink` drops
  // one source's link from a commitment that other sources still carry.
  operation: z.enum(["create", "update", "delete", "conflict", "rejected", "link", "unlink"]),
  expectedVersion: z.number().int().positive().nullable(),
  // Most entities are keyed by a generated UUID. condition_definition rows are the one exception:
  // their id is the human slug itself (see condition_definitions PK in the database schema), so this
  // cannot be constrained to UUID shape.
  matchedEntityId: z.string().min(1).nullable(),
  fields: z.record(z.string(), importFieldSchema),
  relationships: z.record(z.string(), z.string().nullable()).default({}),
  errors: z.array(z.string()).default([]),
  warnings: z.array(z.string()).default([]),
  removed: z.boolean().default(false),
  sortOrder: z.number().int().min(0)
});

export const importBatchSchema = z.object({
  id: z.string().uuid(),
  sourceType: z.union([
    z.enum(["csv", "xlsx", "ai_text", "ai_image", "fixture"]),
    connectionIdSchema,
    // A source an extension reserves (a feature the OpenRhen export leaves out): not a connection id, still a source.
    z.string().refine((id) => Object.hasOwn(extensionSourceIds(), id))
  ]),
  inputKind: z.enum([
    "planning_data",
    "assignment",
    "brain_dump",
    "task_list",
    "project_plan",
    "capacity_commitments",
    "calendar_events",
    "calendar_updates"
  ]),
  timezone: z.string().min(1),
  templateVersion: z.literal("1"),
  status: z.enum(["draft", "ready", "blocked", "committed", "failed"]),
  version: z.number().int().positive(),
  records: z.array(importRecordSchema).max(2000),
  source: z
    .object({
      text: z.string().max(100000).optional(),
      filename: z.string().max(255).optional(),
      mimeType: z.string().max(100).optional(),
      contentHash: z.string().max(128).optional(),
      files: z
        .array(
          z.object({ filename: z.string().max(255), mimeType: z.string().max(100), contentHash: z.string().max(128) })
        )
        .max(5)
        .optional()
    })
    .default({}),
  createdAt: z.string().datetime({ offset: true }).optional(),
  committedAt: z.string().datetime({ offset: true }).optional()
});

/** What a client may ask to preview. Stored batches carry the open `sourceType` union; this request does not. */
const USER_PREVIEW_SOURCE_TYPES: readonly string[] = ["csv", "xlsx", "ai_text", "ai_image", "fixture"];
/** The user-originated types plus every registered calendar source (a connection id), read when a request is parsed. */
export const previewSourceTypeSchema = z
  .string()
  .refine(
    (value) =>
      USER_PREVIEW_SOURCE_TYPES.includes(value) ||
      calendarSourceConnections().some((manifest) => manifest.id === value),
    "Unknown source type."
  );
export const previewImportSchema = importBatchSchema
  .pick({
    inputKind: true,
    timezone: true,
    templateVersion: true,
    records: true,
    source: true
  })
  .extend({ sourceType: previewSourceTypeSchema });
export const updateImportSchema = z.object({
  expectedVersion: z.number().int().positive(),
  records: z.array(importRecordSchema).max(2000)
});
export const commitImportSchema = z.object({ expectedVersion: z.number().int().positive() });
/**
 * A partial commit: the records with no blockers are committed and the blocked ones move, in the same
 * transaction, into a new draft batch. The response names both — the committed batch and the batch
 * the blockers went to, or null when nothing was blocked and it was a plain commit.
 */
export const commitReadyImportSchema = z.object({ expectedVersion: z.number().int().positive() });
export const commitReadyImportResultSchema = z.object({
  batch: importBatchSchema,
  deferred: importBatchSchema.nullable()
});

export type ImportEntityType = z.infer<typeof importEntityTypeSchema>;
export type ImportField = z.infer<typeof importFieldSchema>;
export type ImportFieldSource = z.infer<typeof importFieldSourceSchema>;
export type CommitReadyImportResult = z.infer<typeof commitReadyImportResultSchema>;
export type ImportRecord = z.infer<typeof importRecordSchema>;
export type ImportBatch = z.infer<typeof importBatchSchema>;
/** A preview as the store takes it: a request (narrow `sourceType`) or a server-built one (any stored source type). */
export type PreviewImport = Omit<z.infer<typeof previewImportSchema>, "sourceType"> & {
  sourceType: ImportBatch["sourceType"];
};
