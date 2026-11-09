import { z } from "zod";

/**
 * The data-flow registry's vocabulary: one entry per collector, shared pipe, reader and sink, with the datasets it
 * reads (`from`) and writes (`to`). The names borrow OpenLineage (job, dataset as `namespace:name`) and dbt (warn and
 * error hours); nothing here is a service. See docs/architecture/data-flow-registry.md.
 */

export const FLOW_ROLES = ["source", "pipe", "reader", "sink"] as const;
export type FlowRole = (typeof FLOW_ROLES)[number];

export const FLOW_METHODS = ["file-import", "api-pull", "push", "device-agent", "manual", "derived"] as const;
export type FlowMethod = (typeof FLOW_METHODS)[number];

export const FLOW_CATEGORIES = [
  "files",
  "calendar",
  "communications",
  "device",
  "manual",
  "agent",
  "derived",
  "engine",
  "operations"
] as const;
export type FlowCategory = (typeof FLOW_CATEGORIES)[number];

export const DATASET_SCHEMES = ["pg", "blob", "local", "ext", "surface"] as const;
export type DatasetScheme = (typeof DATASET_SCHEMES)[number];

/**
 * OpenLineage-style dataset name. A partition narrows a table to the rows of one source or kind:
 * `pg:commitments`, `pg:activity_events[source=timeline,kind=place_visit]`, `surface:page/review`.
 */
export type DatasetRef = `${DatasetScheme}:${string}`;
/** Core names `phone` and `pc`; an extension adds its own. */
export type DeviceId = string;

/** Free-text caps (check X2); every field below is scanned for private names in the nightly overlay job. */
export const FLOW_TEXT_CAPS = {
  name: 60,
  note: 80,
  gives: 80,
  potential: 120,
  incidentalReason: 120,
  noneReason: 120,
  datasetLabel: 120,
  datasetDead: 120,
  datasetInfrastructure: 120
} as const;

const kebab = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const FLOW_ID_PATTERN = kebab;

const strings = z.array(z.string()).readonly();
export const datasetRefSchema = z.templateLiteral([z.enum(DATASET_SCHEMES), ":", z.string().min(1)]);

export const triggerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("loop"), loop: z.string() }).strict(),
  z.object({ kind: z.literal("connection-schedule") }).strict(),
  z.object({ kind: z.literal("on-write") }).strict(),
  z.object({ kind: z.literal("none") }).strict(),
  z.object({ kind: z.literal("on-request"), by: z.enum(["owner", "agent", "device", "service", "guest"]) }).strict(),
  z.object({ kind: z.literal("manual-run"), where: z.enum(["cli", "powershell", "portal"]) }).strict()
]);
export type Trigger = z.infer<typeof triggerSchema>;

export const freshnessSchema = z
  .object({ warnAfterHours: z.number().positive(), errorAfterHours: z.number().positive() })
  .strict();
export type Freshness = z.infer<typeof freshnessSchema>;

const whereSchema = z.record(z.string(), z.union([z.string(), z.boolean()]));

export type HealthProbe =
  | { kind: "sync-runs"; provider: string; summaryMatch?: Record<string, string> }
  | { kind: "sync-status"; provider: string }
  | { kind: "activity"; source: string }
  | { kind: "extractor"; name: string }
  | { kind: "telemetry"; name: string }
  | { kind: "max"; table: string; column: string; where?: Record<string, string | boolean> }
  | { kind: "last-used"; table: "agent_tokens"; tokenName?: string }
  | { kind: "json-stamp"; table: "user_preferences"; column: string; path: readonly string[] }
  | { kind: "lag"; upstream: HealthProbe; downstream: HealthProbe; allowHours: number }
  | { kind: "none"; reason: string };

export const healthProbeSchema: z.ZodType<HealthProbe> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("sync-runs"),
        provider: z.string(),
        summaryMatch: z.record(z.string(), z.string()).optional()
      })
      .strict(),
    z.object({ kind: z.literal("sync-status"), provider: z.string() }).strict(),
    z.object({ kind: z.literal("activity"), source: z.string() }).strict(),
    z.object({ kind: z.literal("extractor"), name: z.string() }).strict(),
    z.object({ kind: z.literal("telemetry"), name: z.string() }).strict(),
    z.object({ kind: z.literal("max"), table: z.string(), column: z.string(), where: whereSchema.optional() }).strict(),
    z
      .object({ kind: z.literal("last-used"), table: z.literal("agent_tokens"), tokenName: z.string().optional() })
      .strict(),
    z
      .object({
        kind: z.literal("json-stamp"),
        table: z.literal("user_preferences"),
        column: z.string(),
        path: strings
      })
      .strict(),
    z
      .object({
        kind: z.literal("lag"),
        upstream: healthProbeSchema,
        downstream: healthProbeSchema,
        allowHours: z.number().positive()
      })
      .strict(),
    z.object({ kind: z.literal("none"), reason: z.string() }).strict()
  ])
) as z.ZodType<HealthProbe>;

/** What a planned entry will land as, so CI can tell when it has landed (2.6). */
export const landsAsSchema = z.union([
  z.object({ activitySource: z.string() }).strict(),
  z.object({ table: z.string() }).strict(),
  z.object({ route: z.string() }).strict()
]);

export const flowCodeSchema = z
  .object({
    /** Files; a directory only for `integrations/<name>/src/<sub>/`. */
    paths: strings.optional(),
    /** Exact `METHOD /api/x/[id]` as `listRoutes` prints it; no wildcards. */
    routes: strings.optional(),
    loops: strings.optional(),
    mcpTools: strings.optional(),
    /** `priorities-ios:Sources/LocationReporter.swift`: code in another repository; not existence-checked. */
    external: strings.optional()
  })
  .strict();
export type FlowCode = z.infer<typeof flowCodeSchema>;

export const flowEntrySchema = z
  .object({
    /** Kebab-case, stable. */
    id: z.string(),
    name: z.string(),
    role: z.enum(FLOW_ROLES),
    category: z.enum(FLOW_CATEGORIES),
    method: z.enum(FLOW_METHODS),
    trigger: triggerSchema,
    /** Not built here: no code, and its activity source or table does not exist yet. */
    planned: z.object({ landsAs: landsAsSchema }).strict().optional(),
    /** Present and accepted, but nothing posts it to the server in this build. */
    noProducer: z.literal(true).optional(),
    /** Readers only: one line on what the reader gives, e.g. "watch time by day and hour". */
    gives: z.string().optional(),
    /** Absent: learned from observed gaps for push sources, from the connection for pulls, none otherwise. */
    freshness: z.union([freshnessSchema, z.literal("from-connection")]).optional(),
    /** Names beyond the connection manifest's; never values. */
    credentials: strings.optional(),
    connection: z.string().optional(),
    syncProvider: z.string().optional(),
    /** `to` gains `pg:activity_events[source=<it>]` through its pipe. */
    activitySource: z.string().optional(),
    device: z.string().optional(),
    code: flowCodeSchema,
    from: z.array(datasetRefSchema).readonly(),
    to: z.array(datasetRefSchema).readonly(),
    /** Shared write pipes (2.3). */
    via: strings.optional(),
    /** In-process hand-offs with no dataset between. */
    feeds: strings.optional(),
    /** Writes that are not about this source. */
    incidentalWrites: z
      .array(z.object({ table: z.string(), reason: z.string() }).strict())
      .readonly()
      .optional(),
    /** The engine reader only: plan-input tables it does not consume, each with a reason (E1). */
    notRead: z
      .array(z.object({ table: z.string(), reason: z.string() }).strict())
      .readonly()
      .optional(),
    /** Backup, raw REST, eval: never counts as use. */
    passThrough: z.literal(true).optional(),
    value: z.object({ potential: z.string().optional(), note: z.string().optional() }).strict().optional(),
    health: healthProbeSchema,
    /** Stamped by the registry: `core` or the extension id. */
    owner: z.string().optional()
  })
  .strict();
export type FlowEntry = z.infer<typeof flowEntrySchema>;

export const datasetNoteSchema = z
  .object({
    ref: datasetRefSchema,
    label: z.string().optional(),
    /** "plan entities", "activity store", "gmail". */
    group: z.string().optional(),
    /** No writer and no reader, with the reason. */
    dead: z.string().optional(),
    /** Not data about the person's life, with the reason. */
    infrastructure: z.string().optional(),
    /** Required for non-Drizzle tables, so probes stay validated (S7). */
    columns: strings.optional()
  })
  .strict();
export type DatasetNote = z.infer<typeof datasetNoteSchema>;

/** What an extension's `dataFlow()` returns: the private overlay's share, without private names in core. */
export interface DataFlowContribution {
  entries?: FlowEntry[];
  datasets?: DatasetNote[];
  /** Overrides on core entries, by id: personal cadence, device, credentials, extra `code.external`, token name. */
  amend?: Record<
    string,
    Partial<Pick<FlowEntry, "freshness" | "device" | "credentials">> & { external?: string[]; tokenName?: string }
  >;
  composedBuild?: true;
}

/** A dataset name taken apart: `pg:activity_events[source=a,kind=b]` is scheme `pg`, name `activity_events`. */
export interface ParsedDataset {
  scheme: DatasetScheme;
  name: string;
  filters: Record<string, string>;
}

export function parseDatasetRef(ref: string): ParsedDataset | null {
  const match = /^(pg|blob|local|ext|surface):([^[\]]+)(?:\[([^\]]*)\])?$/.exec(ref);
  if (!match) return null;
  const filters: Record<string, string> = {};
  for (const part of (match[3] ?? "").split(",").filter(Boolean)) {
    const at = part.indexOf("=");
    if (at <= 0) return null;
    filters[part.slice(0, at)] = part.slice(at + 1);
  }
  return { scheme: match[1] as DatasetScheme, name: match[2]!, filters };
}

export function formatDatasetRef(parsed: ParsedDataset): DatasetRef {
  const filters = Object.entries(parsed.filters).map(([key, value]) => `${key}=${value}`);
  return `${parsed.scheme}:${parsed.name}${filters.length ? `[${filters.join(",")}]` : ""}`;
}
