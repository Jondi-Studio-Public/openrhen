import {
  calendarReadEventsResponseSchema,
  connectionManifest,
  type CalendarReadEventsRequest,
  type CalendarReadEventsResponse,
  type ConnectionFailureReason
} from "@openrhen/contracts";
import { z } from "zod";
import { recordProviderCall } from "@/server/telemetry/provider-call-recorder";
import {
  callCapability,
  connectionHostConfigured,
  ConnectionHostNotConfiguredError,
  type CapabilityCall
} from "./connection-host-client";

/**
 * The generic client for any `calendar_source` connection, keyed by connection id. It records under
 * the manifest's `telemetryName` with the operation names the per-provider clients always used.
 */
type Options = Pick<CapabilityCall, "env" | "fetcher" | "timeoutMs">;
type ReadOptions = Options & {
  /** What a failed read says when the host's answer carried no message; defaults to "<label> events request failed.". */
  failureMessage?: string;
};

/** A failed read, proof or calendar listing, keeping the host's message and its machine-readable `reason`. */
export class CalendarSourceError extends Error {
  constructor(
    message: string,
    readonly reason?: ConnectionFailureReason,
    /** The host's HTTP status, for a caller that classifies failures by it. */
    readonly status?: number
  ) {
    super(message);
    this.name = "CalendarSourceError";
  }
}

/** The proxy env names a sidecar that is not set up is missing. */
const PROXY_ENV = ["OUTBOUND_PROXY_URL", "OUTBOUND_PROXY_TOKEN"];

function manifestFor(id: string) {
  const manifest = connectionManifest(id);
  if (!manifest?.capabilities.includes("calendar_source"))
    throw new CalendarSourceError(`${id} is not a calendar source.`, "unknown_connection");
  return manifest;
}

function telemetryNameOf(manifest: { id: string; telemetryName?: string | undefined }) {
  return manifest.telemetryName ?? manifest.id;
}

/** Every source's proof answers one of these; the connected result carries provider-specific extras. */
export const calendarSourceProofSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("not_configured"), missing: z.array(z.string()) }),
  z.object({ status: z.literal("connected"), checkedAt: z.string() }).passthrough(),
  z.object({
    status: z.literal("failed"),
    checkedAt: z.string(),
    message: z.string(),
    reason: z.string().optional()
  })
]);
export type CalendarSourceProof = z.infer<typeof calendarSourceProofSchema>;

/**
 * Reads events in the request's window. Throws `ConnectionHostNotConfiguredError` when the sidecar is
 * not set up, and a `CalendarSourceError` on a non-2xx answer.
 */
export async function readCalendarEvents(
  id: string,
  request: CalendarReadEventsRequest & { timezone?: string },
  { failureMessage, ...options }: ReadOptions = {}
): Promise<CalendarReadEventsResponse> {
  const manifest = manifestFor(id);
  // An unset sidecar is a state, not a failed call, so it is refused before anything is recorded.
  if (!connectionHostConfigured(options.env)) throw new ConnectionHostNotConfiguredError();
  return recordProviderCall(telemetryNameOf(manifest), manifest.calendarSource?.readOperation ?? "events", async () => {
    const response = await callCapability({
      connectionId: id,
      capability: "calendar_source",
      op: "read_events",
      body: request,
      ...options
    });
    if (!response.ok)
      throw new CalendarSourceError(
        response.failure?.error ?? failureMessage ?? `${manifest.label} events request failed.`,
        response.failure?.reason,
        response.status
      );
    return calendarReadEventsResponseSchema.parse(response.body);
  });
}

/** The account's calendars for a source that declares `list_calendars`, as the connection lists them. */
export async function listSourceCalendars(id: string, options: Options = {}): Promise<unknown> {
  const manifest = manifestFor(id);
  if (!connectionHostConfigured(options.env)) throw new ConnectionHostNotConfiguredError();
  return recordProviderCall(telemetryNameOf(manifest), "calendars", async () => {
    const response = await callCapability({
      connectionId: id,
      capability: "calendar_source",
      op: "list_calendars",
      body: {},
      ...options
    });
    if (!response.ok)
      throw new CalendarSourceError(
        response.failure?.error ?? `${manifest.label} list request failed.`,
        response.failure?.reason
      );
    return (response.body as { calendars?: unknown } | null)?.calendars;
  });
}

/**
 * The connection's own connectivity proof. Never throws for an unreachable or stalled host: that is a
 * normal `failed` result. `record: false` is for the passive status probe, which must not count as a
 * real call.
 */
export async function proveCalendarSource(
  id: string,
  options: Options & { record?: boolean } = {}
): Promise<CalendarSourceProof> {
  const manifest = manifestFor(id);
  const { record = true, ...callOptions } = options;
  if (!connectionHostConfigured(callOptions.env)) return { status: "not_configured", missing: PROXY_ENV };
  const prove = async (): Promise<CalendarSourceProof> => {
    try {
      const response = await callCapability({
        connectionId: id,
        capability: "calendar_source",
        op: "proof",
        body: {},
        ...callOptions
      });
      const proof = calendarSourceProofSchema.safeParse(response.body);
      if (proof.success) return proof.data;
      // A host answer that is not a proof (a 504 upstream_timeout, a { error, reason }) is a failed proof.
      return {
        status: "failed",
        checkedAt: new Date().toISOString(),
        message: response.failure?.error ?? `${manifest.label} returned a connectivity result this app could not read.`,
        reason: response.failure?.reason ?? "upstream_error"
      };
    } catch (error) {
      return {
        status: "failed",
        checkedAt: new Date().toISOString(),
        message: error instanceof Error ? error.message : `Could not reach the ${manifest.label} proxy service.`,
        reason: "network_error"
      };
    }
  };
  if (!record) return prove();
  // A failure comes back as a normal result, so success is judged from its status, not from "did not throw".
  return recordProviderCall(telemetryNameOf(manifest), "proof", prove, (result) =>
    result.status === "failed" ? { ok: false, detail: result.message } : { ok: true }
  );
}
