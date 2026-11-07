import { createHash } from "node:crypto";
import {
  ACTIVITY_SCHEMA_VERSION,
  activityEnvelopeSchema,
  activityShorthandSchema,
  isActivityShorthand
} from "@openrhen/contracts";
import type { ActivityBatch } from "@/server/persistence/postgres/activity-store";

/** JSON with object keys sorted at every depth, so the same facts always hash alike. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

/** The key the server gives a shorthand event that names none: a hash of source, kind, start (to the second, in UTC), device and attrs. */
export function shorthandKey(event: {
  source: string;
  kind: string;
  start: string;
  device?: string | undefined;
  attrs?: Record<string, unknown> | undefined;
}): string {
  const second = new Date(event.start).toISOString().slice(0, 19);
  const text = [event.source, event.kind, second, event.device ?? "", stableJson(event.attrs ?? {})].join("\u0000");
  return `h:${createHash("sha256").update(text).digest("hex").slice(0, 40)}`;
}

export type ParsedBody =
  | { ok: true; batch: ActivityBatch; shorthand: boolean }
  | { ok: false; error: string; issues?: { path: string; message: string }[] };

/** Reads a request body as a batch, or as the single-event shorthand a phone shortcut posts. Never throws. */
export function parseActivityBody(body: unknown): ParsedBody {
  if (isActivityShorthand(body)) {
    const parsed = activityShorthandSchema.safeParse(body);
    if (!parsed.success)
      return {
        ok: false,
        error: `That event is not valid: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "event"}: ${issue.message}`).join("; ")}`,
        issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }))
      };
    const { id, device, ...event } = parsed.data;
    return {
      ok: true,
      shorthand: true,
      batch: {
        device,
        events: [{ id: id ?? shorthandKey({ ...event, device: device ?? undefined } as never), ...event }]
      }
    };
  }
  const parsed = activityEnvelopeSchema.safeParse(body);
  if (!parsed.success) {
    const schemaIssue =
      body === null || typeof body !== "object" || (body as { schema?: unknown }).schema !== ACTIVITY_SCHEMA_VERSION;
    return {
      ok: false,
      error: schemaIssue
        ? `The body must have "schema": ${ACTIVITY_SCHEMA_VERSION} and an "events" list, or be one event with "source", "kind" and "start".`
        : `The batch is not valid: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; ")}`,
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }))
    };
  }
  const { device, import: importRef, importId, events } = parsed.data;
  return { ok: true, shorthand: false, batch: { device, import: importRef, importId, events } };
}
