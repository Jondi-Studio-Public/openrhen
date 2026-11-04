import { z } from "zod";

/**
 * The owner's credentials (the design notes, decision D2): what the portal lists and
 * what it accepts. A secret is shown once, when it is made; nothing here ever holds a hash.
 */

/** An owner token, for the CLI and scripts. Sent as `X-OpenRhen-Owner`. */
export const OWNER_TOKEN_PREFIX = "pri_own_";
/** The secret behind an enrolled browser's cookie. */
export const OWNER_SESSION_PREFIX = "pri_ses_";
export const OWNER_HEADER = "X-OpenRhen-Owner";
/** The worker's credential for the routes only it calls (`WORKER_TOKEN_HASH` on the portal). */
export const WORKER_HEADER = "X-OpenRhen-Worker";
/** The ESP32 handheld's credential for the two device routes (`DEVICE_TOKEN_HASH` on the portal). */
export const DEVICE_HEADER = "X-OpenRhen-Device";
export const OWNER_COOKIE = "openrhen_owner";
/** A browser session lasts this long from its last use. */
export const OWNER_SESSION_DAYS = 30;
export const OWNER_AUTH_MODES = ["off", "shadow", "require"] as const;
export type OwnerAuthMode = (typeof OWNER_AUTH_MODES)[number];

const label = z.string().trim().min(1).max(60);

export const createOwnerTokenSchema = z.object({ label: label.default("Owner token") });
export type CreateOwnerToken = z.infer<typeof createOwnerTokenSchema>;

/** Enrolling a browser. `secret` (an owner token or the recovery token) is needed only once owner auth is `require` and this browser has no credential yet. */
export const enrollBrowserSchema = z.object({
  label: label.default("This browser"),
  secret: z.string().trim().min(1).max(200).optional()
});
export type EnrollBrowser = z.infer<typeof enrollBrowserSchema>;

export const ownerCredentialSummarySchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(["token", "browser"]),
  label: z.string(),
  createdAt: z.string().datetime({ offset: true }),
  lastUsedAt: z.string().datetime({ offset: true }).nullable(),
  expiresAt: z.string().datetime({ offset: true }).nullable(),
  revokedAt: z.string().datetime({ offset: true }).nullable(),
  /** True for the credential this very request used. */
  current: z.boolean().optional()
});
export type OwnerCredentialSummary = z.infer<typeof ownerCredentialSummarySchema>;

/** What `GET /api/owner/session` answers, so the Settings card knows what to offer. */
export interface OwnerSessionInfo {
  mode: OwnerAuthMode;
  /** True when this request carries a valid owner credential. */
  signedIn: boolean;
  via: "cookie" | "header" | null;
  /** Whether this caller may manage credentials right now (signed in, or mode is not `require`). */
  canManage: boolean;
}
