/**
 * The publishing and delivery family of the data health check: the calendar provider
 * publication, push delivery and the pulse publish. Pure over a status-only slice: provider, state, since and
 * count, never an error body, subject, address, endpoint or device token.
 */
import type { DoctorItem } from "./doctor.js";

const HOUR_MS = 3_600_000;
/** Failing for longer than this is blocking (the same bar as a failing sync). */
const BLOCKING_AFTER_HOURS = 24;
/** A push device needs this many failures before it is blocking, and none for this long is likely retired. */
const BLOCKING_FAILURES = 5;
const RETIRED_AFTER_DAYS = 30;

export interface DoctorPublishingSlice {
  /** The shared-calendar publication rows that are not healthy, counted by state. Null when none are failing. */
  calendarSink: {
    /** The publishing connection's id (its handle and check ids are named by it) and the label the person knows it by. */
    id: string;
    label: string;
    failed: number;
    /** Failed rows with no next attempt scheduled: they will not retry on their own. */
    failedPermanent: number;
    /** Remote copies still ahead of us that were deleted from the calendar provider. */
    remoteMissing: number;
    /** Highest attempt count among failed rows. */
    maxAttempts: number;
    /** Oldest `updated_at` among failed rows, ISO; null when none failed. */
    failingSince: string | null;
    /** Oldest `updated_at` among remote-missing rows, ISO. */
    missingSince: string | null;
  } | null;
  /**
   * Push devices, from every registered push transport, whose latest delivery failed. Ids are row ids, never
   * tokens. `kind` is the transport's id; `label` and `handleKind` are how that transport names its device in the
   * item title and handle, so this file knows no transport.
   */
  pushDevices: {
    id: string;
    kind: string;
    /** What the device is called in the title: "browser", "iPhone app". */
    label: string;
    /** The handle namespace for the device row: `push_subscription:<id>`. */
    handleKind: string;
    failureCount: number;
    lastSuccessAt: string | null;
    lastFailureAt: string;
    createdAt: string;
  }[];
  /** Pulse publish state; null when publishing is off or nothing has been tried. */
  pulse: {
    outcome: string;
    lastPublishedAt: string | null;
  } | null;
}

const hoursSince = (iso: string | null, nowMs: number): number | null =>
  iso === null ? null : (nowMs - Date.parse(iso)) / HOUR_MS;

export function publishingItems(slice: DoctorPublishingSlice, nowMs: number): DoctorItem[] {
  const items: DoctorItem[] = [];

  const sky = slice.calendarSink;
  if (sky && sky.failed > 0) {
    const age = hoursSince(sky.failingSince, nowMs);
    const blocking = sky.failedPermanent > 0 || (age !== null && age > BLOCKING_AFTER_HOURS);
    items.push({
      id: `calendar_publish_failing:${sky.id}`,
      check: "calendar_publish_failing",
      tier: blocking ? "blocking" : "degrading",
      area: "integrations",
      title: `${sky.failed} calendar ${sky.failed === 1 ? "event is" : "events are"} failing to publish to ${sky.label}`,
      why: `The family calendar on ${sky.label} no longer matches the plan, so shared events can be missing or stale.`,
      handles: [`integration:${sky.id}`],
      ...(sky.failingSince ? { since: sky.failingSince } : {}),
      fix: {
        who: "person",
        question: `Is ${sky.label} still signed in? Should it be signed in again so publishing can retry?`
      }
    });
  }
  if (sky && sky.remoteMissing > 0) {
    items.push({
      id: `calendar_remote_missing:${sky.id}`,
      check: "calendar_remote_missing",
      tier: "degrading",
      area: "integrations",
      title: `${sky.remoteMissing} published ${sky.remoteMissing === 1 ? "event was" : "events were"} deleted from ${sky.label}`,
      why: "Upcoming events the plan shared are gone from the family calendar, so the family will not see them.",
      handles: [`integration:${sky.id}`],
      ...(sky.missingSince ? { since: sky.missingSince } : {}),
      fix: { who: "person", question: "Was that deletion on purpose? Publish them again, or stop sharing them?" }
    });
  }

  for (const device of slice.pushDevices) {
    const lastSuccessMs = device.lastSuccessAt === null ? null : Date.parse(device.lastSuccessAt);
    // Failures must post-date the last success; a device that has since delivered is healthy.
    if (device.failureCount <= 0 || (lastSuccessMs !== null && lastSuccessMs >= Date.parse(device.lastFailureAt))) {
      continue;
    }
    const since = device.lastSuccessAt ?? device.createdAt;
    const age = hoursSince(since, nowMs) ?? 0;
    // No first-failure column exists, so the failing span runs from the last success (or creation) to the last failure.
    const spanHours = (Date.parse(device.lastFailureAt) - Date.parse(since)) / HOUR_MS;
    const tier =
      age > RETIRED_AFTER_DAYS * 24
        ? "tidy"
        : device.failureCount >= BLOCKING_FAILURES && spanHours > BLOCKING_AFTER_HOURS
          ? "blocking"
          : "degrading";
    items.push({
      id: `push_failing:${device.id}`,
      check: "push_failing",
      tier,
      area: "integrations",
      title: `Notifications to a ${device.label} device keep failing (${device.failureCount} in a row)`,
      why: "Leave-by and check-in nudges never reach that device, so the plan cannot reach you when it matters.",
      handles: [`${device.handleKind}:${device.id}`],
      since,
      fix: {
        who: "person",
        question: "Is that device still in use? Sign in and allow notifications again, or remove it?"
      }
    });
  }

  const pulse = slice.pulse;
  if (pulse && pulse.outcome !== "delivered") {
    const age = hoursSince(pulse.lastPublishedAt, nowMs);
    const blocking = pulse.outcome === "rejected" || (age !== null && age > BLOCKING_AFTER_HOURS);
    items.push({
      id: "pulse_publish_failing:pulse",
      check: "pulse_publish_failing",
      tier: blocking ? "blocking" : "degrading",
      area: "integrations",
      title: `Publishing the public pulse is ${pulse.outcome === "rejected" ? "being rejected" : "failing"}`,
      why: "The status other people see is out of date, so it can show you as somewhere or something you are not.",
      handles: ["integration:pulse"],
      ...(pulse.lastPublishedAt ? { since: pulse.lastPublishedAt } : {}),
      fix: {
        who: "person",
        question: "Is the pulse publishing connection still set up? Reconnect it, or turn publishing off?"
      }
    });
  }

  return items;
}
