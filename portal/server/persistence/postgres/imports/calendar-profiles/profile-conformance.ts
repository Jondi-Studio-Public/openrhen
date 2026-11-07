// Test support: the diff orchestration scenarios, run against any profile registered by name.
import { describe, expect, it } from "vitest";
import type { CalendarEvent } from "@openrhen/contracts";
import {
  calendarDiffRecords,
  registeredDiffProfile,
  type CalendarDiffInput,
  type CalendarDiffProfile,
  type CalendarLinkRow
} from "../calendar-diff";

/** One registered profile as a connection would use it, and the events the scenarios need it to accept. */
export interface ProfileUnderTest {
  /** The name the profile registered under (`registerDiffProfile`). */
  name: string;
  /** The provider id a connection would give it. */
  provider: string;
  /** The label a connection would give it. */
  label: string;
  /**
   * Builds an event this profile accepts (right frame, key and shape) from the scenarios' defaults and the overrides a
   * scenario sets. Required: a profile without a fixture cannot be run.
   */
  makeEvent: (overrides?: Partial<CalendarEvent>) => CalendarEvent;
  /**
   * An event the portal itself published, as this profile recognises one (a marker on the event, or its id in
   * `publishedRemoteIds`), so the echo scenario can check it is never proposed back.
   */
  makeEcho: () => { event: CalendarEvent; publishedRemoteIds?: ReadonlySet<string> };
  /**
   * Optional: inputs the scenarios start from in place of the defaults (date window, timezone, mapping inputs such as
   * locations or calendar names), for a profile that needs them. Each scenario still sets its own events and links.
   */
  input?: Partial<CalendarDiffInput>;
}

const base = (overrides: Partial<CalendarEvent> = {}): CalendarEvent => ({
  externalEventId: "e1",
  calendarId: null,
  title: "Block",
  description: null,
  startsAt: "2026-08-04T00:30:00.000Z",
  endsAt: "2026-08-04T05:30:00.000Z",
  allDay: false,
  timezone: "Australia/Adelaide",
  location: "Depot",
  status: "confirmed",
  seriesId: null,
  recurring: false,
  updatedAt: null,
  profileLabel: null,
  attributes: {},
  ...overrides
});

const baseInput = (overrides: Partial<CalendarDiffInput> = {}): CalendarDiffInput => ({
  timezone: "Australia/Adelaide",
  timeMin: "2026-08-01T00:00:00.000Z",
  timeMax: "2026-09-01T00:00:00.000Z",
  events: [],
  calendarNames: { feed: "Feed" },
  links: [],
  importedSeriesKeys: new Set(),
  dismissals: [],
  locations: [],
  presetSteps: [],
  presetDependencies: [],
  ...overrides
});

function linkFor(profile: CalendarDiffProfile, event: CalendarEvent): CalendarLinkRow {
  return {
    id: `link-${event.externalEventId}`,
    frame_id: profile.frameOf(event),
    external_event_id: event.externalEventId,
    commitment_id: `c-${event.externalEventId}`,
    version: 1,
    last_remote_snapshot: profile.storedSnapshot(event),
    title: event.title,
    starts_at: new Date(event.startsAt),
    ends_at: new Date(event.endsAt),
    status: "confirmed",
    location: event.location,
    setup_before_minutes: 0,
    transition_after_minutes: 0
  };
}

/** The scenarios' default event, for a `makeEvent` to move onto a frame its profile knows. */
export const defaultEvent = base;

/**
 * Runs the orchestration scenarios (creates, updates, removals, echoes, window edges) against each entry. Core's
 * `calendar-diff-orchestration.test.ts` calls it with the profiles core registers. Vitest isolates modules per test
 * file, so an extension (a private overlay) does not add to core's list: it calls this from a conformance test file of
 * its own, with its own entries, after importing the file that registers each profile. Each file covers only the
 * profiles registered in its own process.
 */
export function describeProfileConformance(entries: readonly ProfileUnderTest[]): void {
  describe.each(entries)(
    "diff orchestration through the registry: $name",
    ({ name, provider, label, makeEvent, makeEcho, input: profileInput }) => {
      const input = (overrides: Partial<CalendarDiffInput> = {}): CalendarDiffInput =>
        baseInput({ ...profileInput, ...overrides });
      const profile = registeredDiffProfile(name, provider, label)!;

      it("is registered", () => expect(profile).toBeDefined());

      it("offers a create under the profile's own key prefix for an event not yet linked", () => {
        const event = makeEvent();
        const records = calendarDiffRecords(input({ events: [event] }), profile);
        expect(records).toHaveLength(1);
        expect(records[0]?.operation).toBe("create");
        expect(records[0]?.importKey).toBe(
          `${profile.importKeyPrefix ?? `${profile.provider}:event:`}${profile.eventKey(event)}`
        );
      });

      it("writes nothing for a linked event that has not changed", () => {
        const event = makeEvent();
        expect(
          calendarDiffRecords(input({ events: [event], links: [linkFor(profile, event)], only: "updates" }), profile)
        ).toEqual([]);
      });

      it("writes an update when a linked event moved", () => {
        const before = makeEvent();
        const after = makeEvent({ startsAt: "2026-08-04T01:30:00.000Z" });
        const records = calendarDiffRecords(
          input({ events: [after], links: [linkFor(profile, before)], only: "updates" }),
          profile
        );
        expect(records.map((r) => r.operation)).toEqual(["update"]);
      });

      it("lists a linked event the read no longer returns, but not one outside the window", () => {
        const inside = makeEvent();
        const outside = makeEvent({
          externalEventId: "e2",
          startsAt: "2026-12-04T00:30:00.000Z",
          endsAt: "2026-12-04T05:30:00.000Z"
        });
        const records = calendarDiffRecords(
          input({
            events: [],
            complete: true,
            links: [linkFor(profile, inside), linkFor(profile, outside)],
            only: "updates"
          }),
          profile
        );
        expect(records).toHaveLength(1);
        expect(records[0]?.importKey).toContain(profile.eventKey(inside));
      });

      it("never proposes an event the portal itself published", () => {
        const { event, publishedRemoteIds } = makeEcho();
        expect(calendarDiffRecords(input({ events: [event], publishedRemoteIds }), profile)).toEqual([]);
      });
    }
  );
}
