import { calendarEventSchema, type CalendarEvent, type ImportRecord } from "@openrhen/contracts";
import { hasOpenRhenMarker } from "@/server/imports/publish-marker";
import type {
  CalendarCreateContext,
  CalendarDiffProfile,
  CalendarDismissalRow,
  CalendarSource
} from "@/server/persistence/postgres/imports/calendar-diff";
import {
  importField,
  savedPlaceMatching,
  type CalendarDismissalInsert
} from "@/server/persistence/postgres/imports/calendar-diff-core";
import { registerDiffProfile } from "@/server/persistence/postgres/imports/calendar-diff-registry";
import { isPrimarySource, PRIMARY_OWNED_FIELDS } from "@/server/persistence/postgres/imports/primary-source";
import { isProposal, primaryOwnedFields } from "@/server/persistence/postgres/imports/source-match-records";

/**
 * The `fixed_blocks` diff profile: a feed of blocks that own their time and place (a work roster, a rota, a class
 * timetable), over the generic `CalendarEvent` contract with no provider-specific schema. A connection declares
 * `calendarSource.diffProfile: "fixed_blocks"` and a role:
 *
 * - `primary`: the feed is definitive on title, times and place. Joining a commitment another source made, those
 *   fields apply (the existing primary-source mechanism), and its own changes are never suppressed by other sources.
 * - `secondary`: it proposes like any calendar. Another source that is primary owns the fields, and a declined
 *   proposal is not made again.
 *
 * Decisions that differ from the `calendar` profile:
 * - The event key is the feed's own stable external id, unhashed and with no frame, so two events with the same title
 *   (every "Shift" on a roster) are separate links, never one.
 * - Absence is not deletion. A linked event the read does not return is only listed for removal when the read says it
 *   was complete (`CalendarDiffInput.complete`); the source's own cancellation always counts.
 * - Events a feed gives that do not parse are skipped one by one (`readFixedBlocks`), not a failed read.
 */

const remoteFields = ["title", "startsAt", "endsAt", "location"] as const;
type RemoteField = (typeof remoteFields)[number];

function instant(value: string | null | undefined): string | null {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

function remoteSnapshot(event: Pick<CalendarEvent, RemoteField>): Record<RemoteField, string | null> {
  return {
    title: event.title,
    startsAt: instant(event.startsAt),
    endsAt: instant(event.endsAt),
    location: event.location ?? null
  };
}

/** The part of an event a link's snapshot and hash are made of; a batch source that keeps only these can write the link. */
export type FixedBlockEvent = Pick<
  CalendarEvent,
  "externalEventId" | "title" | "startsAt" | "endsAt" | "allDay" | "location" | "status"
>;

/** What a link keeps of an event: the compared fields plus what the hash also watches, in a fixed key order. */
export function fixedBlockSnapshot(event: FixedBlockEvent): Record<string, unknown> {
  return {
    externalEventId: event.externalEventId,
    title: event.title,
    startsAt: instant(event.startsAt) ?? event.startsAt,
    endsAt: instant(event.endsAt) ?? event.endsAt,
    allDay: event.allDay,
    location: event.location,
    status: event.status
  };
}

/** The hash of what the diff watches on an event. */
export function fixedBlockHash(event: FixedBlockEvent): string {
  const view = remoteSnapshot(event);
  return JSON.stringify([...remoteFields.map((name) => view[name]), event.allDay, event.status]);
}

/** A feed's events, each checked on its own: the ones that parse, and the ones skipped with why. */
export interface FixedBlocksRead {
  events: CalendarEvent[];
  /**
   * Whether nothing was skipped. A skipped event is not read, so a link to it would look absent: the caller passes
   * `complete: transportComplete && read.complete` to the diff, never the transport's word alone.
   */
  complete: boolean;
  skipped: { index: number; externalEventId: string | null; reason: string }[];
}

/**
 * Reads a feed's raw events. One that fails the `CalendarEvent` contract, or whose end is not after its start (equal counts: `commitments_time_check` is `ends_at > starts_at`), or
 * whose id repeats an earlier one, is skipped and reported; the rest are the read. Only a feed with nothing
 * usable at all is a failure, and that is for the caller to decide from `events` being empty with `skipped` not.
 */
export function readFixedBlocks(raw: readonly unknown[]): FixedBlocksRead {
  const events: CalendarEvent[] = [];
  const skipped: FixedBlocksRead["skipped"] = [];
  const seen = new Set<string>();
  raw.forEach((item, index) => {
    const parsed = calendarEventSchema.safeParse(item);
    const id =
      typeof (item as { externalEventId?: unknown } | null)?.externalEventId === "string"
        ? (item as { externalEventId: string }).externalEventId
        : null;
    if (!parsed.success) {
      skipped.push({ index, externalEventId: id, reason: parsed.error.issues[0]?.message ?? "Not a calendar event" });
      return;
    }
    const event = parsed.data;
    const start = new Date(event.startsAt).getTime();
    const end = new Date(event.endsAt).getTime();
    if (Number.isNaN(start) || Number.isNaN(end) || end <= start) {
      skipped.push({
        index,
        externalEventId: event.externalEventId,
        reason: "Its end is not after its start"
      });
      return;
    }
    if (seen.has(event.externalEventId)) {
      skipped.push({ index, externalEventId: event.externalEventId, reason: "Its id repeats an earlier event" });
      return;
    }
    seen.add(event.externalEventId);
    events.push(event);
  });
  return { events, skipped, complete: skipped.length === 0 };
}

function isDismissed(event: CalendarEvent, dismissals: Map<string, CalendarDismissalRow>): boolean {
  const own = dismissals.get(event.externalEventId);
  return Boolean(own && own.title === event.title && instant(event.startsAt) === own.starts_at.toISOString());
}

/**
 * The dismissals a batch's create records call for, as the `calendar` profile's: only declined proposals. A series
 * create (a source that carries rule descriptors in `series`, which only the calendar feed does) is remembered as
 * `series:<stem>` with the title and first date it had; the diff reads that dismissal by the stem alone.
 */
function dismissalInserts(provider: string) {
  const prefix = `${provider}:event:`;
  const seriesPrefix = `${provider}:series:`;
  return (
    records: Pick<ImportRecord, "importKey" | "operation" | "removed" | "entityType" | "relationships">[],
    source: CalendarSource,
    mode: "deselected" | "all"
  ): CalendarDismissalInsert[] => {
    const out: CalendarDismissalInsert[] = [];
    const series = (source as { series?: Record<string, { title: string; startDate: string }> }).series;
    for (const record of records) {
      if (!isProposal(record) || (mode === "deselected" && !record.removed)) continue;
      if (record.entityType === "fixed_commitment" && record.importKey.startsWith(prefix)) {
        const key = record.importKey.slice(prefix.length);
        const event = source.events[key];
        if (event) out.push({ externalEventId: key, title: event.title, startsAt: event.startsAt });
      }
      if (record.entityType === "fixed_commitment_recurrence" && record.importKey.startsWith(seriesPrefix)) {
        const stem = record.importKey.slice(seriesPrefix.length);
        const descriptor = series?.[stem];
        if (descriptor)
          out.push({
            externalEventId: `series:${stem}`,
            title: descriptor.title,
            startsAt: new Date(`${descriptor.startDate}T00:00:00.000Z`).toISOString()
          });
      }
    }
    return out;
  };
}

function createFields(label: string) {
  return (event: CalendarEvent, context: CalendarCreateContext): ImportRecord["fields"] => {
    const evidence = [
      `${label}${context.calendarName ? ` · ${context.calendarName}` : ""}${event.allDay ? " · all-day" : ""}`
    ];
    const view = remoteSnapshot(event);
    return {
      title: importField(view.title, evidence),
      startsAt: importField(view.startsAt, evidence),
      endsAt: importField(view.endsAt, evidence),
      status: importField("confirmed", evidence),
      location: importField(view.location, evidence),
      setupBeforeMinutes: importField(0, evidence),
      transitionAfterMinutes: importField(0, evidence)
    };
  };
}

/** The profile for one provider: its id prefixes the link keys, its label words the evidence and removal text. */
export function fixedBlocksProfileFor(provider: string, label: string): CalendarDiffProfile {
  const primary = isPrimarySource(provider);
  return {
    provider,
    sourceLabel: label,
    relationshipPrefix: provider,
    missingWhy: `No longer in ${label} for this window`,
    remoteFields,
    allDayStartsUnselected: !primary,
    frameOf: (event) => event.calendarId ?? "",
    eventKey: (event) => event.externalEventId,
    linkKey: (_frameId, externalEventId) => externalEventId,
    seriesKey: () => null,
    remoteView: (event) => remoteSnapshot(event),
    priorView: (snapshot) => {
      const raw = (snapshot ?? {}) as Partial<Record<RemoteField, string | null>>;
      return remoteSnapshot({
        title: raw.title ?? "",
        startsAt: raw.startsAt ?? "",
        endsAt: raw.endsAt ?? "",
        location: raw.location ?? null
      });
    },
    storedSnapshot: fixedBlockSnapshot,
    remoteHash: fixedBlockHash,
    createFields: createFields(label),
    // A primary feed is definitive: joining a commitment another source made, its title, times and place apply.
    ...(primary ? { matchApplyFields: PRIMARY_OWNED_FIELDS } : {}),
    isRemoved: (event) => event.status === "cancelled",
    isEcho: (event, input) =>
      hasOpenRhenMarker(event.description) || (input.publishedRemoteIds?.has(event.externalEventId) ?? false),
    // A primary feed is definitive and keeps no dismissals; a secondary one does not repeat what was declined.
    ...(primary ? {} : { dismissals: { isDismissed, inserts: dismissalInserts(provider) } }),
    ownedFields: primary ? () => null : primaryOwnedFields,
    locationMatching: savedPlaceMatching,
    removal: { missingNeedsCompleteRead: true }
  };
}

registerDiffProfile("fixed_blocks", fixedBlocksProfileFor);
