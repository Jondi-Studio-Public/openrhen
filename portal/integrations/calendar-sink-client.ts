import {
  calendarSinkCreateRequestSchema,
  calendarSinkRemoveResponseSchema,
  calendarSinkStatusSchema,
  calendarSinkUpdateRequestSchema,
  calendarSinkWriteProofResultSchema,
  calendarSinkWriteResponseSchema,
  connectionManifest
} from "@openrhen/contracts";
import type { z } from "zod";
import { recordProviderCall } from "@/server/telemetry/provider-call-recorder";
import { callCapability, connectionHostConfigured, type CapabilityCall } from "./connection-host-client";

export type CalendarSinkCreateRequest = z.infer<typeof calendarSinkCreateRequestSchema>;
export type CalendarSinkUpdateRequest = z.infer<typeof calendarSinkUpdateRequestSchema>;
export type CalendarSinkWriteProofResult = z.infer<typeof calendarSinkWriteProofResultSchema>;

/**
 * The generic client for any `calendar_sink` connection, keyed by connection id. It records under the
 * manifest's `telemetryName` with the operation names the per-provider client always used.
 */
type Options = Pick<CapabilityCall, "env" | "fetcher" | "timeoutMs">;

const PROXY_ENV = "OUTBOUND_PROXY_URL, OUTBOUND_PROXY_TOKEN";

/** The operation names telemetry has always recorded for a sink's writes. */
const WRITE_OPERATION = {
  create: "calendar_event_create",
  update: "calendar_event_update",
  remove: "calendar_event_delete",
  write_proof: "write_proof"
} as const;

/**
 * A failed write that keeps what the publish sweep needs to classify it: `upstreamStatus` is the
 * provider's own HTTP status when the host relayed one (its 502 body carries it), otherwise the host's
 * status. Message text is never parsed.
 */
export class CalendarSinkError extends Error {
  /** True only when the host relayed a status the provider itself answered with; false for the host's own refusals (writes off, bad request). */
  readonly relayed: boolean;
  constructor(
    message: string,
    readonly upstreamStatus: number,
    relayed = false
  ) {
    super(message);
    this.name = "CalendarSinkError";
    this.relayed = relayed;
  }
}

function manifestFor(id: string) {
  const manifest = connectionManifest(id);
  if (!manifest?.capabilities.includes("calendar_sink")) throw new Error(`${id} is not a calendar sink.`);
  return manifest;
}

const telemetryNameOf = (manifest: { id: string; telemetryName?: string | undefined }) =>
  manifest.telemetryName ?? manifest.id;

function notConfigured(label: string): Error {
  return new Error(`${label} is not configured: ${PROXY_ENV}.`);
}

function writeFailure(
  response: { status: number; body: unknown; failure?: { error: string } | undefined },
  fallback: string
) {
  const status = (response.body as { status?: unknown } | null)?.status;
  const relayed = typeof status === "number";
  return new CalendarSinkError(response.failure?.error ?? fallback, relayed ? status : response.status, relayed);
}

/** The host's write gate and frame; throws when the host cannot be asked. */
export async function calendarSinkStatus(id: string, options: Options = {}) {
  const manifest = manifestFor(id);
  if (!connectionHostConfigured(options.env)) throw notConfigured(manifest.label);
  const response = await callCapability({
    connectionId: id,
    capability: "calendar_sink",
    op: "status",
    body: {},
    ...options
  });
  if (!response.ok) throw new Error(`The ${manifest.label} proxy service did not report its write status.`);
  return calendarSinkStatusSchema.parse(response.body);
}

async function write(id: string, op: keyof typeof WRITE_OPERATION, body: unknown, fallback: string, options: Options) {
  const manifest = manifestFor(id);
  if (!connectionHostConfigured(options.env)) throw notConfigured(manifest.label);
  return recordProviderCall(telemetryNameOf(manifest), WRITE_OPERATION[op], async () => {
    const response = await callCapability({ connectionId: id, capability: "calendar_sink", op, body, ...options });
    if (!response.ok) throw writeFailure(response, fallback);
    return response.body;
  });
}

/** Creates an event and returns the sink's id for it. Throws a `CalendarSinkError` on a refused or failed write. */
export async function createSinkEvent(
  id: string,
  request: CalendarSinkCreateRequest,
  options: Options = {}
): Promise<string> {
  const body = await write(id, "create", request, "Calendar event create failed.", options);
  return calendarSinkWriteResponseSchema.parse(body).data.id;
}

export async function updateSinkEvent(
  id: string,
  eventId: string,
  request: CalendarSinkUpdateRequest,
  options: Options = {}
): Promise<string> {
  const body = await write(id, "update", { ...request, eventId }, "Calendar event update failed.", options);
  return calendarSinkWriteResponseSchema.parse(body).data.id;
}

export async function removeSinkEvent(id: string, eventId: string, options: Options = {}): Promise<void> {
  const body = await write(id, "remove", { eventId }, "Calendar event delete failed.", options);
  calendarSinkRemoveResponseSchema.parse(body);
}

function failedProof(message: string): CalendarSinkWriteProofResult {
  return {
    status: "failed",
    checkedAt: new Date().toISOString(),
    remoteEventId: null,
    fields: [],
    failedStep: null,
    message,
    deleted: false
  };
}

/**
 * The write proof: creates a clearly-named test event, reads it back, updates it, reads again, then
 * deletes it. Never throws: an unset or unreachable host, or a sink with writes off (the host answers
 * 404 for the whole write surface), comes back as a normal `failed` result, since this is safe to call
 * from a button. `writesOffMessage` is the wording for that 404.
 */
export async function proveSinkWrite(
  id: string,
  frameId: string | undefined,
  writesOffMessage: string,
  options: Options = {}
): Promise<CalendarSinkWriteProofResult> {
  const manifest = manifestFor(id);
  if (!connectionHostConfigured(options.env)) return failedProof(`${manifest.label} is not configured: ${PROXY_ENV}.`);
  return recordProviderCall(
    telemetryNameOf(manifest),
    WRITE_OPERATION.write_proof,
    async () => {
      try {
        const response = await callCapability({
          connectionId: id,
          capability: "calendar_sink",
          op: "write_proof",
          body: frameId ? { frameId } : {},
          ...options
        });
        if (response.status === 404) return failedProof(writesOffMessage);
        return calendarSinkWriteProofResultSchema.parse(response.body);
      } catch (error) {
        return failedProof(
          error instanceof Error ? error.message : `Could not reach the ${manifest.label} proxy service.`
        );
      }
    },
    // The catch above turns a network failure into a normal "failed" result rather than a throw, so
    // success is judged from the result's own status rather than the recorder's default "did not throw".
    (result) => (result.status === "failed" ? { ok: false, detail: result.message } : { ok: true })
  );
}
