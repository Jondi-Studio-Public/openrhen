import { z } from "zod";
import { googleCalendarFailureReasonSchema } from "../integrations/google-calendar.js";
import { capabilityIdSchema } from "./capabilities.js";

/**
 * Every reason a connection can fail with. The first seven are Google Calendar's; the sign-in and reachability reasons
 * after them are shared by any connection that logs in to an upstream. A connection's own failure enum must be a
 * subset of this one (a connection test pins it).
 */
export const connectionFailureReasonSchema = z.enum([
  ...googleCalendarFailureReasonSchema.options,
  "session_expired",
  "forbidden",
  "unreachable",
  "invalid_credentials",
  "login_challenge",
  "login_failed",
  "unknown_connection",
  "unsupported_operation",
  "not_ready",
  "quota_exceeded",
  "rate_limited"
]);

export const capabilityFailureSchema = z.object({
  error: z.string(),
  reason: connectionFailureReasonSchema.optional()
});

export const connectionStatusSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  capabilities: z.array(capabilityIdSchema),
  ready: z.boolean(),
  /** Env names missing from the closest secret group; names only, never values. */
  missing: z.array(z.string())
});

export const connectionsResponseSchema = z.object({
  connections: z.array(connectionStatusSchema)
});

export type ConnectionFailureReason = z.infer<typeof connectionFailureReasonSchema>;
export type CapabilityFailure = z.infer<typeof capabilityFailureSchema>;
export type ConnectionStatus = z.infer<typeof connectionStatusSchema>;
export type ConnectionsResponse = z.infer<typeof connectionsResponseSchema>;
