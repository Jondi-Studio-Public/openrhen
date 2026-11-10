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

/** A device's own key: lowercase, random, kept by the app in its secure storage. */
export const DEVICE_INSTALL_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{7,63}$/;
/** A short lowercase word the app declares for what it runs on. */
export const DEVICE_PLATFORM_PATTERN = /^[a-z0-9_-]{1,16}$/;
/** A pairing secret and a device code last this long and work once. */
export const DEVICE_PAIRING_MINUTES = 10;
/** The least a polling device waits between polls of `code/token`, in seconds (RFC 8628's default). */
export const DEVICE_CODE_INTERVAL_SECONDS = 5;

export const deviceIdentitySchema = z.object({
  installId: z.string().regex(DEVICE_INSTALL_ID_PATTERN),
  platform: z.string().regex(DEVICE_PLATFORM_PATTERN)
});
export type DeviceIdentity = z.infer<typeof deviceIdentitySchema>;

export const ownerCredentialSummarySchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(["token", "browser"]),
  label: z.string(),
  createdAt: z.string().datetime({ offset: true }),
  lastUsedAt: z.string().datetime({ offset: true }).nullable(),
  expiresAt: z.string().datetime({ offset: true }).nullable(),
  revokedAt: z.string().datetime({ offset: true }).nullable(),
  /** True for the credential this very request used. */
  current: z.boolean().optional(),
  /** Set on a credential made by device sign-in. */
  device: deviceIdentitySchema.nullable().default(null),
  /** A limited credential is refused the `owner-admin` routes (it cannot add a phone or issue tokens). */
  limited: z.boolean().default(false),
  /** A web-view session's device credential. */
  parentCredentialId: z.string().uuid().nullable().default(null),
  /** The address the last request that used it came from. */
  lastUsedFrom: z.string().nullable().default(null)
});
export type OwnerCredentialSummary = z.infer<typeof ownerCredentialSummarySchema>;

const deviceName = z.string().trim().min(1).max(60);

/** `POST /api/owner/devices/pairings`: the owner asks for a QR. `origin` is read only when `PORTAL_PUBLIC_URL` is unset. */
export const startDevicePairingSchema = z.object({ origin: z.string().trim().max(200).optional() });
export type StartDevicePairing = z.infer<typeof startDevicePairingSchema>;

/** What the QR holds (as JSON text): the portal's public origin and the one-time pairing secret. */
export interface DevicePairingPayload {
  v: 1;
  origin: string;
  secret: string;
}

/** `POST /api/owner/devices/redeem`. */
export const redeemDevicePairingSchema = z.object({
  pairingSecret: z.string().trim().min(1).max(200),
  name: deviceName,
  installId: z.string().regex(DEVICE_INSTALL_ID_PATTERN),
  platform: z.string().regex(DEVICE_PLATFORM_PATTERN).default("other")
});
export type RedeemDevicePairing = z.infer<typeof redeemDevicePairingSchema>;

/** `POST /api/owner/devices/code`: a device with no signed-in screen asks for a code to be approved elsewhere. */
export const requestDeviceCodeSchema = z.object({
  name: deviceName,
  installId: z.string().regex(DEVICE_INSTALL_ID_PATTERN),
  platform: z.string().regex(DEVICE_PLATFORM_PATTERN).default("other")
});
export type RequestDeviceCode = z.infer<typeof requestDeviceCodeSchema>;

/** `POST /api/owner/devices/code/token`. */
export const pollDeviceCodeSchema = z.object({ deviceCode: z.string().trim().min(1).max(200) });

/** `POST /api/owner/devices/code/approve`: without `decision` it only looks the code up. */
export const approveDeviceCodeSchema = z.object({
  userCode: z.string().trim().min(1).max(32),
  decision: z.enum(["approve", "deny"]).optional()
});
export type ApproveDeviceCode = z.infer<typeof approveDeviceCodeSchema>;

/** RFC 8628's error names, as `code/token` answers them (HTTP 400). */
export const DEVICE_CODE_ERRORS = ["authorization_pending", "slow_down", "expired_token", "access_denied"] as const;
export type DeviceCodeError = (typeof DEVICE_CODE_ERRORS)[number];

export const ownerCredentialEventSchema = z.object({
  id: z.string().uuid(),
  occurredAt: z.string().datetime({ offset: true }),
  event: z.enum(["pairing_started", "code_started", "code_approved", "code_denied", "redeemed", "revoked"]),
  label: z.string().nullable(),
  device: deviceIdentitySchema.nullable(),
  address: z.string().nullable()
});
export type OwnerCredentialEvent = z.infer<typeof ownerCredentialEventSchema>;

/** What `GET /api/owner/session` answers, so the Settings card knows what to offer. */
export interface OwnerSessionInfo {
  mode: OwnerAuthMode;
  /** True when this request carries a valid owner credential. */
  signedIn: boolean;
  via: "cookie" | "header" | null;
  /** Whether this caller may manage credentials right now (signed in, or mode is not `require`). */
  canManage: boolean;
  /** True when the caller's credential is limited, so the page hides what it would refuse. */
  limited?: boolean;
}
