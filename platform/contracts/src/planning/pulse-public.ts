/**
 * `pulse-criteria-and-publish`: waking-hours shares over recorded pulse segments, and the redacted
 * public object handed to the outbound proxy for publishing. The shares and the object itself are
 * built by pure functions (no zod, no I/O); `publicPulseV1Schema` below is the one piece of zod this
 * module carries, since the proxy validates the wire body against a schema *from contracts*
 * (Decision "Publish", P4/Q4 — "so the proxy refuses anything with extra fields").
 */

import { z } from "zod";
import type { PulseReason, PulseState, PulseTarget } from "./pulse-judge.js";

/** A state the pulse shows people and the tracker: the judge's four, plus `unknown` (the state machine's
    contact axis, the pulse on plan design note). */
export type PublicPulseState = PulseState | "unknown";
/** Why a recorded segment is in its state: the judge's reasons, plus the state machine's (`lapsed` for
    `off`, `scheduled`/`disrupted`/`reentered` for `on`). */
export type PulseSegmentReason = PulseReason | "lapsed" | "scheduled" | "disrupted" | "reentered";

export interface PulseSegment {
  startedAt: Date;
  endedAt: Date | null;
  state: PublicPulseState | "gap";
  reason?: PulseSegmentReason;
}

export interface Share {
  onPercent: number | null;
  countedMinutes: number;
}

export interface PulseShares {
  today: Share;
  days7: Share;
  days30: Share;
}

/** Below this many counted minutes in a window, the share is `null` rather than a misleadingly
    precise (or "0%") percentage — Decision "Shares" (P2). */
const MINIMUM_COUNTED_MINUTES = 15;

/** The offset (minutes east of UTC) `timeZone` is at for the given instant, DST-aware. */
export function offsetMinutesAt(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" }).formatToParts(date);
  const raw = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT+00:00";
  const match = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(raw);
  if (!match) return 0;
  const sign = match[1] === "-" ? -1 : 1;
  const hours = Number(match[2]);
  const minutes = Number(match[3] ?? "0");
  return sign * (hours * 60 + minutes);
}

/** The start of the local calendar day (in `timeZone`) that contains `date`, as a UTC instant. */
export function localMidnightUtc(date: Date, timeZone: string): Date {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const year = Number(parts.find((p) => p.type === "year")?.value);
  const month = Number(parts.find((p) => p.type === "month")?.value);
  const day = Number(parts.find((p) => p.type === "day")?.value);
  const offsetMinutes = offsetMinutesAt(date, timeZone);
  return new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0) - offsetMinutes * 60_000);
}

/**
 * Minutes of `segments` with state `on` or `off`, clipped to `[windowStart, now]`. `unknown` is uncounted,
 * like `gap`: neither numerator nor denominator, until it resolves to `on` (the recorder repaints it) or
 * `off` (it stays unknown, and the lapse that follows is the `off` time).
 */
function countedAndOnMinutes(segments: PulseSegment[], windowStart: Date, now: Date): { counted: number; on: number } {
  let counted = 0;
  let on = 0;
  for (const segment of segments) {
    if (segment.state !== "on" && segment.state !== "off") continue;
    const start = segment.startedAt.getTime();
    const end = (segment.endedAt ?? now).getTime();
    const clippedStart = Math.max(start, windowStart.getTime());
    const clippedEnd = Math.min(end, now.getTime());
    if (clippedEnd <= clippedStart) continue;
    const minutes = (clippedEnd - clippedStart) / 60_000;
    counted += minutes;
    if (segment.state === "on") on += minutes;
  }
  return { counted, on };
}

function shareFor(segments: PulseSegment[], windowStart: Date, now: Date): Share {
  const { counted, on } = countedAndOnMinutes(segments, windowStart, now);
  const countedMinutes = Math.round(counted);
  if (countedMinutes < MINIMUM_COUNTED_MINUTES) return { onPercent: null, countedMinutes };
  const onPercent = Math.round((on / counted) * 100);
  return { onPercent, countedMinutes };
}

/**
 * `{ today, days7, days30 }`, each over `on` and `off` segments only (free/asleep/gap excluded),
 * clipped to the window, rounded half-up — Decision "Shares" (P2).
 */
export function pulseShares(segments: PulseSegment[], now: Date, timeZone: string): PulseShares {
  const todayStart = localMidnightUtc(now, timeZone);
  const days7Start = new Date(now.getTime() - 7 * 24 * 60 * 60_000);
  const days30Start = new Date(now.getTime() - 30 * 24 * 60 * 60_000);
  return {
    today: shareFor(segments, todayStart, now),
    days7: shareFor(segments, days7Start, now),
    days30: shareFor(segments, days30Start, now)
  };
}

export type PublicDoingKind = "action" | "deliverable" | "commitment" | "step" | "sleep" | "journey";

export interface PublicPulseV1 {
  v: 1;
  seq: number;
  generatedAt: string;
  state: PublicPulseState;
  since: string;
  doing?: { kind: PublicDoingKind; title: string };
  private: boolean;
  lastConfirmedAt?: string;
  shares: PulseShares;
}

const MAX_TITLE_LENGTH = 60;

/**
 * The redacted object published to the tracker: no ids, no locations, no segments, no reasons.
 * `doing` appears only when on plan and not private (Decision "The public object").
 */
export function publicPulse(
  judgement: { state: PublicPulseState; doing?: PulseTarget; private: boolean; confirmedAt?: Date },
  since: Date,
  shares: PulseShares,
  seq: number,
  now: Date
): PublicPulseV1 {
  const includeDoing = judgement.state === "on" && !judgement.private && judgement.doing !== undefined;
  return {
    v: 1,
    seq,
    generatedAt: now.toISOString(),
    state: judgement.state,
    since: since.toISOString(),
    ...(includeDoing
      ? {
          doing: {
            kind: judgement.doing!.kind as PublicDoingKind,
            title: judgement.doing!.title.slice(0, MAX_TITLE_LENGTH)
          }
        }
      : {}),
    private: judgement.private,
    ...(judgement.confirmedAt ? { lastConfirmedAt: judgement.confirmedAt.toISOString() } : {}),
    shares
  };
}

/** The fields a change in state should be judged by — excludes `generatedAt`, `seq` and `shares`,
    which drift on their own (Decision "Publish", the publisher's hash test). */
export function publicPulseChangeKey(pulse: PublicPulseV1): string {
  return JSON.stringify({
    state: pulse.state,
    since: pulse.since,
    doing: pulse.doing,
    private: pulse.private,
    lastConfirmedAt: pulse.lastConfirmedAt
  });
}

const shareSchema = z.object({ onPercent: z.number().nullable(), countedMinutes: z.number() }).strict();

/**
 * The wire shape `POST /pulse/publish` (the outbound proxy) validates the body against, `.strict()`
 * at every level so an extra field is refused rather than silently forwarded (Decision "Publish").
 * Kept in step with `PublicPulseV1` by hand — the interface stays the source of truth for the pure
 * builders above, since they have no zod dependency of their own.
 */
export const publicPulseV1Schema = z
  .object({
    v: z.literal(1),
    seq: z.number().int().nonnegative(),
    generatedAt: z.string().datetime({ offset: true }),
    state: z.enum(["on", "unknown", "off", "free", "asleep"]),
    since: z.string().datetime({ offset: true }),
    doing: z
      .object({
        kind: z.enum(["action", "deliverable", "commitment", "step", "sleep", "journey"]),
        title: z.string().max(MAX_TITLE_LENGTH)
      })
      .strict()
      .optional(),
    private: z.boolean(),
    lastConfirmedAt: z.string().datetime({ offset: true }).optional(),
    shares: z.object({ today: shareSchema, days7: shareSchema, days30: shareSchema }).strict()
  })
  .strict();

/** `GET /pulse/config` on the outbound proxy — `host` is the tracker's own host only, never the
    full URL, so the portal can say "Sending to <host>" without holding the secret-bearing path. */
export const pulsePublishConfigResultSchema = z.object({ configured: z.boolean(), host: z.string().nullable() });
export type PulsePublishConfigResult = z.infer<typeof pulsePublishConfigResultSchema>;

/** `POST /pulse/publish` on the outbound proxy. */
export const pulsePublishOutcomeSchema = z.enum(["delivered", "rejected", "failed"]);
export type PulsePublishOutcome = z.infer<typeof pulsePublishOutcomeSchema>;
export const pulsePublishResultSchema = z.object({
  outcome: pulsePublishOutcomeSchema,
  httpStatus: z.number().int().optional()
});
export type PulsePublishResult = z.infer<typeof pulsePublishResultSchema>;
