import { TIMEZONE } from "./demo-dates.js";
import type { Fields } from "./demo-data-planning.js";

/**
 * Fixed commitments, recurring rules, the trip and the backfilled history. Dates are anchored to the
 * fictional "today" of Tue 2026-10-27 and moved by `demo-dates.ts` at run time.
 */

/** `routinePresetId` is filled in with the stored id of the named preset once the presets exist. */
export const RULES: { fields: Fields; preset?: string }[] = [
  {
    preset: "Get ready for a shift",
    fields: {
      id: "rule-shift",
      title: "Harbor Mart shift",
      startDate: "2026-10-28",
      repeat: { unit: "weeks", intervalWeeks: 1, weekdays: [3, 5] },
      localStartTime: "07:00",
      localEndTime: "15:30",
      location: "Harbor Mart (Riverside Mall)",
      locationId: "ctx-work",
      setupBeforeMinutes: 0,
      transitionAfterMinutes: 10,
      presence: "blocking",
      routineSource: "preset",
      transportMode: "car"
    }
  },
  {
    preset: "Gym prep",
    fields: {
      id: "rule-gym",
      title: "Spin class",
      startDate: "2026-10-27",
      repeat: { unit: "weeks", intervalWeeks: 1, weekdays: [2, 4] },
      localStartTime: "18:00",
      localEndTime: "19:00",
      location: "Fit Hub Gym",
      locationId: "ctx-gym",
      setupBeforeMinutes: 0,
      transitionAfterMinutes: 10,
      presence: "blocking",
      routineSource: "preset",
      transportMode: "car"
    }
  },
  {
    fields: {
      id: "rule-college",
      title: "College: Networking class",
      startDate: "2026-10-29",
      repeat: { unit: "weeks", intervalWeeks: 1, weekdays: [4] },
      localStartTime: "09:00",
      localEndTime: "12:30",
      location: "Riverside Community College",
      locationId: "ctx-college",
      setupBeforeMinutes: 5,
      transitionAfterMinutes: 10,
      presence: "anchor",
      routineSource: "none",
      transportMode: "car",
      contactId: "con-tutor"
    }
  },
  {
    fields: {
      id: "rule-pickup",
      title: "School pickup (Mia and Noah)",
      startDate: "2026-10-27",
      repeat: { unit: "weeks", intervalWeeks: 1, weekdays: [2, 4] },
      localStartTime: "15:15",
      localEndTime: "15:50",
      location: "Maple Elementary School",
      locationId: "ctx-school",
      setupBeforeMinutes: 0,
      transitionAfterMinutes: 5,
      presence: "blocking",
      routineSource: "none",
      transportMode: "walk",
      shareToCalendar: true
    }
  }
].map((rule) => ({
  ...rule,
  fields: { timezone: TIMEZONE, status: "active", latenessMatters: true, ...rule.fields }
}));

const commitment = (fields: Fields): { fields: Fields; preset?: string } => ({
  fields: {
    status: "confirmed",
    presence: "blocking",
    setupBeforeMinutes: 0,
    transitionAfterMinutes: 10,
    ...fields
  }
});

/** One-off commitments, looked up by title. `preset` names the routine preset to attach. */
export const COMMITMENTS: { fields: Fields; preset?: string }[] = [
  commitment({
    id: "cm-dentist",
    title: "Dentist: check-up and clean",
    startsAt: "2026-10-27T14:00:00-04:00",
    endsAt: "2026-10-27T14:45:00-04:00",
    location: "Riverside Dental",
    locationId: "ctx-dentist",
    transportMode: "car",
    latenessMatters: true,
    setupBeforeMinutes: 5
  }),
  {
    preset: "Get ready for a shift",
    ...commitment({
      id: "cm-shift-sat",
      title: "Harbor Mart shift",
      startsAt: "2026-10-31T09:00:00-04:00",
      endsAt: "2026-10-31T17:30:00-04:00",
      location: "Harbor Mart (Riverside Mall)",
      locationId: "ctx-work",
      transportMode: "car",
      latenessMatters: true,
      routineSource: "preset"
    })
  },
  {
    preset: "Get ready for a shift",
    ...commitment({
      id: "cm-shift-mon",
      title: "Harbor Mart shift (closing)",
      startsAt: "2026-11-02T12:00:00-05:00",
      endsAt: "2026-11-02T20:30:00-05:00",
      location: "Harbor Mart (Riverside Mall)",
      locationId: "ctx-work",
      transportMode: "car",
      latenessMatters: true,
      routineSource: "preset"
    })
  },
  commitment({
    id: "cm-pt",
    title: "Parent-teacher interviews (Mia)",
    startsAt: "2026-10-28T16:30:00-04:00",
    endsAt: "2026-10-28T16:50:00-04:00",
    location: "Maple Elementary School",
    locationId: "ctx-school",
    transportMode: "car",
    latenessMatters: true,
    shareToCalendar: true
  }),
  commitment({
    id: "cm-dinner",
    title: "Dinner at Sam's parents",
    startsAt: "2026-11-01T17:30:00-05:00",
    endsAt: "2026-11-01T20:30:00-05:00",
    presence: "anchor",
    shareToCalendar: true,
    transportMode: "car"
  }),
  commitment({
    id: "cm-datenight",
    title: "Date night with Sam",
    startsAt: "2026-10-31T19:30:00-04:00",
    endsAt: "2026-10-31T22:00:00-04:00",
    status: "tentative",
    shareToCalendar: true
  })
];

export const SPAN = { title: "Mia's birthday weekend at the lake", start: "2026-11-07", end: "2026-11-08" };

export const SETUP_SETTINGS = {
  preferredBedtime: "22:30",
  preferredWakeTime: "06:15",
  timezone: TIMEZONE,
  lastWokeAt: "2026-10-26T06:15:00-04:00",
  // What the /setup page posts; the stored value is the timestamp `setupCompletedAt`.
  setupCompleted: true
};

export type HistoryNight = { sleepAt: string; wakeAt: string };
export type HistorySession = { action: string; start: string; end: string; minutes: number };

/**
 * Backfilled history, in strict chronological order (the portal rejects a past start that overlaps a
 * later session): night, three sessions, night, three sessions. A start more than 24 hours before the
 * run, or an end still in the future, is skipped at run time.
 */
export const HISTORY: ({ night: HistoryNight } | { session: HistorySession })[] = [
  { night: { sleepAt: "2026-10-25T22:50:00-04:00", wakeAt: "2026-10-26T06:15:00-04:00" } },
  {
    session: {
      action: "Review lab 7: VLAN trunking notes",
      start: "2026-10-26T13:00:00-04:00",
      end: "2026-10-26T13:48:00-04:00",
      minutes: 45
    }
  },
  {
    session: {
      action: "Read module 5 slides on threat modelling",
      start: "2026-10-26T14:30:00-04:00",
      end: "2026-10-26T15:00:00-04:00",
      minutes: 30
    }
  },
  {
    session: {
      action: "Order 2 TB NVMe SSD for the server",
      start: "2026-10-26T20:00:00-04:00",
      end: "2026-10-26T20:12:00-04:00",
      minutes: 10
    }
  },
  { night: { sleepAt: "2026-10-26T22:40:00-04:00", wakeAt: "2026-10-27T06:20:00-04:00" } },
  {
    session: {
      action: "Easy 5 km run",
      start: "2026-10-27T06:50:00-04:00",
      end: "2026-10-27T07:25:00-04:00",
      minutes: 35
    }
  },
  {
    session: {
      action: "Complete cash-handling refresher module online",
      start: "2026-10-27T08:30:00-04:00",
      end: "2026-10-27T09:05:00-04:00",
      minutes: 45
    }
  },
  {
    session: {
      action: "Image the old boot drive before the migration",
      start: "2026-10-27T09:30:00-04:00",
      end: "2026-10-27T10:15:00-04:00",
      minutes: 45
    }
  }
];

/** A session finish never completes its action, so the resulting states are set by hand. */
export const ACTION_OUTCOMES: { title: string; status: string; remainingMinutes: number }[] = [
  { title: "Review lab 7: VLAN trunking notes", status: "done", remainingMinutes: 0 },
  { title: "Easy 5 km run", status: "done", remainingMinutes: 0 },
  { title: "Order 2 TB NVMe SSD for the server", status: "done", remainingMinutes: 0 },
  { title: "Read module 5 slides on threat modelling", status: "active", remainingMinutes: 15 },
  { title: "Complete cash-handling refresher module online", status: "active", remainingMinutes: 20 },
  { title: "Image the old boot drive before the migration", status: "active", remainingMinutes: 25 }
];
