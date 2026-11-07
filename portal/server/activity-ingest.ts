import { createHash } from "node:crypto";
import {
  ACTIVITY_DEVICE_MAX_CHARS,
  ACTIVITY_FILENAME_MAX_CHARS,
  ACTIVITY_KEY_MAX_CHARS,
  ACTIVITY_MAX_BATCH,
  ACTIVITY_SCHEMA_VERSION,
  describeTimeProblem,
  describeUnstorableText,
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

const fail = (error: string, path = ""): ParsedBody => ({ ok: false, error, issues: [{ path, message: error }] });

const SHAPE = `The body must be {"schema": ${ACTIVITY_SCHEMA_VERSION}, "events": [...]}, or one event with "source", "kind" and "start".`;
const SHA256 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The device name, or the plain reason it cannot be used. Absent is fine. */
function deviceOf(value: unknown): { device: string | undefined } | { problem: string } {
  if (value === undefined || value === null) return { device: undefined };
  if (typeof value !== "string" || value.length < 1 || value.length > ACTIVITY_DEVICE_MAX_CHARS)
    return {
      problem: `device must be text of 1 to ${ACTIVITY_DEVICE_MAX_CHARS} characters, such as "jondipc-ab12", or left out.`
    };
  const unstorable = describeUnstorableText("device", value);
  return unstorable ? { problem: unstorable } : { device: value };
}

/** Reads a request body as a batch, or as the single-event shorthand a phone shortcut posts. Never throws. */
export function parseActivityBody(body: unknown): ParsedBody {
  if (isActivityShorthand(body)) {
    const device = deviceOf(body.device);
    if ("problem" in device) return fail(device.problem, "device");
    const startProblem = describeTimeProblem("start", body.start);
    if (startProblem) return fail(startProblem, "start");
    const { id, device: _device, ...event } = body;
    if (id !== undefined && id !== null && typeof id !== "string")
      return fail(`id must be text of 1 to ${ACTIVITY_KEY_MAX_CHARS} characters, or left out.`, "id");
    let key: string;
    try {
      key =
        typeof id === "string" && id.length > 0
          ? id
          : shorthandKey({
              source: String(event.source),
              kind: String(event.kind),
              start: event.start as string,
              device: device.device,
              attrs:
                event.attrs !== null && typeof event.attrs === "object" && !Array.isArray(event.attrs)
                  ? (event.attrs as Record<string, unknown>)
                  : undefined
            });
    } catch {
      return fail("attrs nests too deeply to read. Keep attrs flat: small facts, not documents.", "attrs");
    }
    return { ok: true, shorthand: true, batch: { device: device.device, events: [{ ...event, id: key }] } };
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) return fail(SHAPE);
  const envelope = body as Record<string, unknown>;
  if (envelope.schema !== ACTIVITY_SCHEMA_VERSION) return fail(SHAPE, "schema");
  const events = envelope.events;
  if (!Array.isArray(events) || events.length < 1 || events.length > ACTIVITY_MAX_BATCH)
    return fail(
      `events must hold 1 to ${ACTIVITY_MAX_BATCH} events${Array.isArray(events) ? `; this has ${events.length}` : ""}. Send a list of events, split into batches of at most ${ACTIVITY_MAX_BATCH}.`,
      "events"
    );
  const device = deviceOf(envelope.device);
  if ("problem" in device) return fail(device.problem, "device");
  let importRef: ActivityBatch["import"];
  const rawImport = envelope.import;
  if (rawImport !== undefined && rawImport !== null) {
    const ref = (typeof rawImport === "object" ? rawImport : {}) as Record<string, unknown>;
    if (typeof ref.sha256 !== "string" || !SHA256.test(ref.sha256))
      return fail("import.sha256 must be 64 lowercase hex characters: the SHA-256 of the whole file.", "import.sha256");
    if (
      typeof ref.filename !== "string" ||
      ref.filename.length < 1 ||
      ref.filename.length > ACTIVITY_FILENAME_MAX_CHARS
    )
      return fail(
        `import.filename is missing or too long. Send the file's name as text of 1 to ${ACTIVITY_FILENAME_MAX_CHARS} characters.`,
        "import.filename"
      );
    const unstorable = describeUnstorableText("import.filename", ref.filename);
    if (unstorable) return fail(unstorable, "import.filename");
    if (ref.source !== undefined && typeof ref.source !== "string")
      return fail("import.source must be the source name as text, or left out.", "import.source");
    importRef = { sha256: ref.sha256, filename: ref.filename, source: ref.source };
  }
  const rawImportId = envelope.importId;
  if (rawImportId !== undefined && rawImportId !== null && (typeof rawImportId !== "string" || !UUID.test(rawImportId)))
    return fail("importId must be the id a first batch returned (a UUID), or left out.", "importId");
  return {
    ok: true,
    shorthand: false,
    batch: {
      device: device.device,
      import: importRef,
      importId: typeof rawImportId === "string" ? rawImportId : undefined,
      events
    }
  };
}
