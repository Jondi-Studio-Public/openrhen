import { z } from "zod";
import { CAPABILITY_OPS, capabilityIdSchema, opIdSchema, type CapabilityId } from "./capabilities.js";
import { connectionFailureReasonSchema } from "./wire.js";
import { connectionIdSchema, sourceIdSchema } from "./connection-id.js";

const envNameSchema = z.string().regex(/^[A-Z][A-Z0-9_]*$/);

export const calendarSourceSchema = z.object({
  role: z.enum(["primary", "secondary"]),
  /** A `sources.source_type` value. */
  sourceType: sourceIdSchema,
  /**
   * Behaviour-named diff profile: never selected by connection id. `calendar` is the one name core owns; any other
   * name is a profile an extension registers (`registerDiffProfile` in the portal), so the schema cannot list them.
   */
  diffProfile: z.string().min(1),
  /** The prefix of the conflict relationship names this source's diff writes (`<prefix>ConflictFields`); absent: the connection id. */
  relationshipPrefix: z.string().min(1).optional(),
  /** The operation name telemetry records for this source's event read; absent: `events`. Stored, so it never follows a rename. */
  readOperation: z.string().min(1).optional(),
  /**
   * The sync runs for this source when `CALENDAR_SYNC_PROVIDERS` is unset or blank. Absent or false: it runs only once
   * the setting names it, which is right for any source whose login is not yet known to work or that needs a URL first.
   */
  syncByDefault: z.boolean().optional(),
  authFailure: z.object({ anyFailure: z.boolean(), reasons: z.array(connectionFailureReasonSchema) }),
  schedule: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("interval"), minutesEnv: envNameSchema, defaultMinutes: z.number().int().positive() }),
    z.object({
      kind: z.literal("daily"),
      localTimeEnv: envNameSchema,
      defaultLocalTime: z.string().regex(/^\d{2}:\d{2}$/)
    })
  ])
});

/** The newest manifest `version` the connection host understands. The host rejects a manifest above it. */
export const CONNECTION_MANIFEST_VERSION = 1;

export const connectionManifestSchema = z
  .object({
    /** The manifest format version; absent reads as 1. */
    version: z.number().int().positive().default(1),
    id: connectionIdSchema,
    label: z.string().min(1),
    capabilities: z
      .array(capabilityIdSchema)
      .min(1)
      .refine((c) => new Set(c).size === c.length, "duplicate capability"),
    /** A subset of a capability's ops, when the connection implements only part of it. */
    ops: z.partialRecord(capabilityIdSchema, z.array(opIdSchema).min(1)).optional(),
    /** Ready when every name in one group is set and not `replace-before-lan-use`. Empty exactly when each request carries its own credential. */
    secrets: z.object({ anyOf: z.array(z.array(envNameSchema).min(1)) }),
    /**
     * Where the credential comes from. `env` (the default): the proxy's environment, and readiness follows it.
     * `request`: the caller sends it in the body of each call (a key the person typed into the app), the proxy holds
     * none, `secrets.anyOf` is empty and the connection is always ready.
     */
    credentialSource: z.enum(["env", "request"]).default("env"),
    /** Non-secret env the connection reads. */
    config: z.record(envNameSchema, z.object({ required: z.boolean(), default: z.string().optional() })),
    telemetryName: z.string().min(1).optional(),
    calendarSource: calendarSourceSchema.optional()
  })
  .superRefine((manifest, ctx) => {
    for (const [capability, ops] of Object.entries(manifest.ops ?? {})) {
      const cap = capability as CapabilityId;
      if (!manifest.capabilities.includes(cap)) {
        ctx.addIssue({ code: "custom", message: `ops names undeclared capability ${cap}` });
        continue;
      }
      for (const op of ops) {
        if (!(CAPABILITY_OPS[cap] as readonly string[]).includes(op)) {
          ctx.addIssue({ code: "custom", message: `${op} is not an op of ${cap}` });
        }
      }
    }
    if ((manifest.credentialSource === "request") !== (manifest.secrets.anyOf.length === 0)) {
      ctx.addIssue({
        code: "custom",
        message: "secrets.anyOf must be empty exactly when credentialSource is request"
      });
    }
    if (manifest.capabilities.includes("calendar_source") !== (manifest.calendarSource !== undefined)) {
      ctx.addIssue({ code: "custom", message: "calendarSource is required exactly for calendar_source" });
    }
  });

/** `version` and `credentialSource` are optional on the type so in-code manifests need not state them; the schema fills in 1 and `env` when parsing. */
export type ConnectionManifest = Omit<z.infer<typeof connectionManifestSchema>, "version" | "credentialSource"> & {
  version?: number;
  credentialSource?: "env" | "request";
};
