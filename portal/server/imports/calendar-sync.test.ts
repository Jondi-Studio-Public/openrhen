import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  registerConnectionManifest,
  type GoogleCalendarEvent,
  ImportBatch,
  ImportRecord,
  PreviewImport
} from "@openrhen/contracts";

// A provider-free calendar sink, so a commit has somewhere to publish to wherever no provider is registered.
registerConnectionManifest({
  id: "example_sink",
  label: "Example Sink",
  capabilities: ["calendar_sink"],
  ops: { calendar_sink: ["create"] },
  secrets: { anyOf: [] },
  config: {}
});

const fetchGoogleCalendarProof = vi.fn();
const fetchGoogleCalendarEvents = vi.fn();
const listSelectedGoogleCalendars = vi.fn();
const withImportStore = vi.fn();
const requestCalendarPublish = vi.fn();
const sqlCalls: { text: string; values: unknown[] }[] = [];
const state = vi.hoisted(() => ({ env: {} as Record<string, string | undefined>, lockAvailable: true, released: 0 }));

vi.mock("@/integrations/google-calendar/google-calendar-proxy-client", () => ({
  fetchGoogleCalendarProof,
  fetchGoogleCalendarEvents
}));
vi.mock("@/server/persistence/postgres/calendar-source-selections", () => ({ listSelectedGoogleCalendars }));
vi.mock("@/server/persistence/postgres/import-store", () => ({ withImportStore }));
// The registered providers are not under test here: no publish trigger fires on its own and no adapter is registered.
vi.mock("./calendar-providers", () => ({ requestCalendarPublish, calendarSyncAdapterFor: () => undefined }));
vi.mock("@/server/persistence/postgres/ensure-user", () => ({ ensureUser: async () => "user-1" }));
vi.mock("@/server/persistence/postgres/sql-pool", () => ({
  sqlPool: () =>
    Object.assign(
      async (strings: TemplateStringsArray, ...values: unknown[]) => {
        sqlCalls.push({ text: strings.join("?"), values });
        return [{ timezone: "Australia/Sydney" }];
      },
      {
        json: (value: unknown) => value,
        reserve: async () =>
          Object.assign(
            async (strings: TemplateStringsArray, ...values: unknown[]) => {
              sqlCalls.push({ text: strings.join("?"), values });
              return strings.join("?").includes("pg_try_advisory_lock") ? [{ locked: state.lockAvailable }] : [];
            },
            { release: () => void (state.released += 1) }
          )
      }
    )
}));
vi.mock("@/server/runtime-env", () => ({
  databaseUrl: () => "postgres://test",
  runtimeEnv: () => state.env
}));

const { runCalendarSync, googleCalendarAdapter } = await import("./calendar-sync");
const { calendarDiffRecords, profileFor } = await import("@/server/persistence/postgres/imports/calendar-diff");
const { googleCalendarSourceText } = await import("@/server/persistence/postgres/imports/calendar-profiles/calendar");
const { toCalendarEvent } =
  await import("@/server/persistence/postgres/imports/calendar-profiles/google-event-fixtures");

const CAL = "jon@example.com";
const connected = { status: "connected", checkedAt: new Date().toISOString(), calendarCount: 1 };

function event(overrides: Partial<GoogleCalendarEvent> & { externalEventId: string }): GoogleCalendarEvent {
  return {
    calendarId: CAL,
    title: "Dentist",
    description: null,
    startsAt: "2026-10-10T09:00:00.000Z",
    endsAt: "2026-10-10T10:00:00.000Z",
    allDay: false,
    timezone: "Australia/Sydney",
    location: null,
    status: "confirmed",
    seriesId: null,
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...overrides
  };
}

function linkRow(e: GoogleCalendarEvent) {
  return {
    frame_id: e.calendarId,
    external_event_id: e.externalEventId,
    commitment_id: `commitment-${e.externalEventId}`,
    version: 2,
    last_remote_snapshot: e,
    title: e.title,
    starts_at: new Date(e.startsAt),
    ends_at: new Date(e.endsAt),
    status: "confirmed",
    location: e.location,
    setup_before_minutes: 0,
    transition_after_minutes: 0
  };
}

/** An in-memory stand-in for the import store: the real diff, no database. */
function fakeStore(options: {
  links?: ReturnType<typeof linkRow>[];
  fedElsewhere?: string[];
  openBatches?: { id: string; version: number; sourceText: string | null; removedKeys?: string[] }[];
  dismissals?: { external_event_id: string; title: string; starts_at: Date }[];
}) {
  const created: PreviewImport[] = [];
  const committed: string[] = [];
  const deleted: string[] = [];
  const superseded: string[] = [];
  let sequence = 0;
  const batchFor = (input: PreviewImport, id: string): ImportBatch =>
    ({
      id,
      version: 1,
      records: input.records,
      sourceType: input.sourceType,
      source: input.source
    }) as unknown as ImportBatch;
  const store = {
    async diffGoogleCalendar(args: {
      timeMin: string;
      timeMax: string;
      timezone: string;
      events: GoogleCalendarEvent[];
      calendars: { calendarId: string; summary: string }[];
    }) {
      const calendarNames = Object.fromEntries(args.calendars.map((c) => [c.calendarId, c.summary]));
      const events = args.events.map(toCalendarEvent);
      const records = calendarDiffRecords(
        {
          timezone: args.timezone,
          timeMin: args.timeMin,
          timeMax: args.timeMax,
          events,
          calendarNames,
          links: options.links ?? [],
          importedSeriesKeys: new Set(),
          dismissals: options.dismissals ?? [],
          locations: [],
          presetSteps: [],
          presetDependencies: []
        },
        profileFor("google_calendar")
      );
      return {
        records,
        previewFor: (subset: ImportRecord[]): PreviewImport => ({
          sourceType: "google_calendar",
          inputKind: "calendar_updates",
          timezone: args.timezone,
          templateVersion: "1",
          records: subset,
          source: { text: googleCalendarSourceText({ events, calendarNames, records: subset }) }
        })
      };
    },
    async commitmentsFedByOtherSources(ids: string[]) {
      return new Set(ids.filter((id) => (options.fedElsewhere ?? []).includes(id)));
    },
    async openBatches() {
      return (options.openBatches ?? []).filter((batch) => !deleted.includes(batch.id));
    },
    async get(id: string) {
      const open = options.openBatches?.find((batch) => batch.id === id);
      return {
        id,
        records: (open?.removedKeys ?? []).map((importKey) => ({ importKey, removed: true }))
      } as unknown as ImportBatch;
    },
    async preview(input: PreviewImport) {
      created.push(input);
      sequence += 1;
      return batchFor(input, `00000000-0000-4000-8000-00000000000${sequence}`);
    },
    async commitReady(id: string) {
      committed.push(id);
      const input = created[created.length - 1]!;
      return { batch: batchFor(input, id), deferred: null, extensionOutcomes: {} };
    },
    async delete(id: string) {
      deleted.push(id);
      return true;
    },
    async supersedeOpenBatches(_type: string, keep: string) {
      superseded.push(keep);
      return 0;
    }
  };
  return { store, created, committed, deleted, superseded };
}

function useStore(fake: ReturnType<typeof fakeStore>) {
  withImportStore.mockImplementation(async (operation: (store: unknown) => unknown) => operation(fake.store));
}

const runInserts = () => sqlCalls.filter((call) => call.text.includes("INSERT INTO integration_sync_runs"));

// The fixtures are dated October 2026 and the sync reads from now forward, so every test runs at a fixed
// time before them; on the real clock they drift out of the window and the tests start failing.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-01T00:00:00Z") });
  state.env = { APP_TIMEZONE: "Australia/Sydney" };
  state.lockAvailable = true;
  state.released = 0;
  fetchGoogleCalendarProof.mockReset().mockResolvedValue(connected);
  fetchGoogleCalendarEvents.mockReset().mockResolvedValue([]);
  listSelectedGoogleCalendars.mockReset().mockResolvedValue([{ calendarId: CAL, summary: "Jon", selected: true }]);
  withImportStore.mockReset();
  requestCalendarPublish.mockReset();
  sqlCalls.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("runCalendarSync (google_calendar)", () => {
  it("reports not_configured, not a clean sync, when nothing is ticked and the sign-in is missing", async () => {
    listSelectedGoogleCalendars.mockResolvedValue([]);
    fetchGoogleCalendarProof.mockResolvedValue({
      status: "not_configured",
      missing: ["GOOGLE_CALENDAR_REFRESH_TOKEN"]
    });
    const result = await runCalendarSync({ provider: "google_calendar", trigger: "manual" });
    expect(result).toEqual({ status: "not_configured", missing: ["GOOGLE_CALENDAR_REFRESH_TOKEN"] });
  });

  it("returns a synced result with zero events, and reads nothing, when no calendar is selected", async () => {
    listSelectedGoogleCalendars.mockResolvedValue([]);
    const result = await runCalendarSync({ provider: "google_calendar", trigger: "scheduled" });
    expect(result).toMatchObject({
      status: "synced",
      provider: "google_calendar",
      eventCount: 0,
      updated: 0,
      deleted: 0,
      heldForReview: 0,
      reviewBatchId: null,
      committedBatchId: null
    });
    expect(fetchGoogleCalendarProof).toHaveBeenCalled();
    expect(fetchGoogleCalendarEvents).not.toHaveBeenCalled();
    expect(withImportStore).not.toHaveBeenCalled();
    expect(runInserts()).toHaveLength(1);
  });

  it("reads only the selected calendars, over now to now plus 90 days", async () => {
    // Pinned to a window with no seed-zone DST change, so 90 calendar days is exactly 90 * 24 hours.
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-01T01:00:00Z") });
    try {
      const fake = fakeStore({});
      useStore(fake);
      const result = await runCalendarSync({ provider: "google_calendar", trigger: "manual" });
      expect(result.status).toBe("synced");
      const [calendarIds, timeMin, timeMax] = fetchGoogleCalendarEvents.mock.calls[0]!;
      expect(calendarIds).toEqual([CAL]);
      expect((new Date(timeMax).getTime() - new Date(timeMin).getTime()) / 86_400_000).toBe(90);
      if (result.status === "synced") {
        expect(result.timeMin).toBe(timeMin);
        expect(result.timeMax).toBe(timeMax);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("commits a change to a linked event on its own, and holds nothing", async () => {
    const prior = event({ externalEventId: "e1" });
    fetchGoogleCalendarEvents.mockResolvedValue([{ ...prior, title: "Dentist (moved)" }]);
    const fake = fakeStore({ links: [linkRow(prior)] });
    useStore(fake);
    const result = await runCalendarSync({ provider: "google_calendar", trigger: "scheduled" });
    expect(result).toMatchObject({
      status: "synced",
      eventCount: 1,
      updated: 1,
      deleted: 0,
      heldForReview: 0,
      reviewBatchId: null
    });
    expect(result.status === "synced" && result.committedBatchId).toBeTruthy();
    expect(requestCalendarPublish).toHaveBeenCalled();
    expect(fake.created).toHaveLength(1);
    expect(fake.created[0]!.records.map((record) => record.operation)).toEqual(["update"]);
    expect(fake.committed).toHaveLength(1);
    expect(runInserts()[0]!.values).toContain("google_calendar");
  });

  it("commits a cancellation of a linked event as a delete", async () => {
    const prior = event({ externalEventId: "e1" });
    fetchGoogleCalendarEvents.mockResolvedValue([{ ...prior, status: "cancelled" }]);
    const fake = fakeStore({ links: [linkRow(prior)] });
    useStore(fake);
    const result = await runCalendarSync({ provider: "google_calendar", trigger: "scheduled" });
    expect(result).toMatchObject({ status: "synced", updated: 0, deleted: 1, heldForReview: 0 });
  });

  it("holds a new event for review, counts it, and commits nothing", async () => {
    fetchGoogleCalendarEvents.mockResolvedValue([
      event({ externalEventId: "new1" }),
      event({ externalEventId: "new2" })
    ]);
    const fake = fakeStore({});
    useStore(fake);
    const result = await runCalendarSync({ provider: "google_calendar", trigger: "scheduled" });
    expect(result).toMatchObject({
      status: "needs_review",
      eventCount: 2,
      updated: 0,
      deleted: 0,
      heldForReview: 2,
      committedBatchId: null
    });
    expect(result.status === "needs_review" && result.reviewBatchId).toBeTruthy();
    expect(fake.committed).toEqual([]);
    expect(fake.created).toHaveLength(1);
    expect(fake.created[0]!.records.map((record) => record.operation)).toEqual(["create", "create"]);
    expect(fake.superseded).toHaveLength(1);
  });

  it("applies the linked change and holds the new event in the same run", async () => {
    const prior = event({ externalEventId: "e1" });
    fetchGoogleCalendarEvents.mockResolvedValue([
      { ...prior, title: "Dentist (moved)" },
      event({ externalEventId: "new1", title: "Brand new" })
    ]);
    const fake = fakeStore({ links: [linkRow(prior)] });
    useStore(fake);
    const result = await runCalendarSync({ provider: "google_calendar", trigger: "scheduled" });
    expect(result).toMatchObject({ status: "needs_review", updated: 1, heldForReview: 1 });
    expect(fake.created.map((input) => input.records.map((record) => record.operation))).toEqual([
      ["update"],
      ["create"]
    ]);
    expect(fake.committed).toHaveLength(1);
  });

  it("holds a conflict for review rather than committing it", async () => {
    const prior = event({ externalEventId: "e1" });
    fetchGoogleCalendarEvents.mockResolvedValue([{ ...prior, title: "Remote title" }]);
    const fake = fakeStore({ links: [{ ...linkRow(prior), title: "Local title" }] });
    useStore(fake);
    const result = await runCalendarSync({ provider: "google_calendar", trigger: "scheduled" });
    expect(result).toMatchObject({ status: "needs_review", updated: 0, heldForReview: 1, committedBatchId: null });
    expect(requestCalendarPublish).not.toHaveBeenCalled();
    expect(fake.committed).toEqual([]);
    expect(fake.created[0]!.records[0]!.operation).toBe("conflict");
  });

  describe("a commitment another source also feeds", () => {
    it("holds an update for review instead of committing it", async () => {
      const prior = event({ externalEventId: "e1" });
      fetchGoogleCalendarEvents.mockResolvedValue([{ ...prior, title: "Dentist (moved)" }]);
      const fake = fakeStore({ links: [linkRow(prior)], fedElsewhere: ["commitment-e1"] });
      useStore(fake);
      const result = await runCalendarSync({ provider: "google_calendar", trigger: "scheduled" });
      expect(result).toMatchObject({
        status: "needs_review",
        updated: 0,
        deleted: 0,
        heldForReview: 1,
        committedBatchId: null
      });
      expect(fake.committed).toEqual([]);
      expect(fake.created[0]!.records.map((record) => record.operation)).toEqual(["update"]);
    });

    it("holds a delete for review instead of committing it", async () => {
      const prior = event({ externalEventId: "e1" });
      fetchGoogleCalendarEvents.mockResolvedValue([{ ...prior, status: "cancelled" }]);
      const fake = fakeStore({ links: [linkRow(prior)], fedElsewhere: ["commitment-e1"] });
      useStore(fake);
      const result = await runCalendarSync({ provider: "google_calendar", trigger: "scheduled" });
      expect(result).toMatchObject({ status: "needs_review", deleted: 0, heldForReview: 1, committedBatchId: null });
      expect(fake.committed).toEqual([]);
    });

    it("still commits changes to commitments nothing else feeds", async () => {
      const a = event({ externalEventId: "a" });
      const b = event({
        externalEventId: "b",
        startsAt: "2026-10-11T09:00:00.000Z",
        endsAt: "2026-10-11T10:00:00.000Z"
      });
      fetchGoogleCalendarEvents.mockResolvedValue([
        { ...a, title: "A moved" },
        { ...b, title: "B moved" }
      ]);
      const fake = fakeStore({ links: [linkRow(a), linkRow(b)], fedElsewhere: ["commitment-b"] });
      useStore(fake);
      const result = await runCalendarSync({ provider: "google_calendar", trigger: "scheduled" });
      expect(result).toMatchObject({ status: "needs_review", updated: 1, heldForReview: 1 });
    });
  });

  describe("auto-applied deletes", () => {
    const cancelled = (id: string, day: number) =>
      event({
        externalEventId: id,
        startsAt: `2026-10-${String(day).padStart(2, "0")}T09:00:00.000Z`,
        endsAt: `2026-10-${String(day).padStart(2, "0")}T10:00:00.000Z`
      });

    it("holds a linked event that is only missing from the read, since it may have moved out of the window", async () => {
      const prior = event({ externalEventId: "e1" });
      fetchGoogleCalendarEvents.mockResolvedValue([]);
      const fake = fakeStore({ links: [linkRow(prior)] });
      useStore(fake);
      const result = await runCalendarSync({ provider: "google_calendar", trigger: "scheduled" });
      expect(result).toMatchObject({ status: "needs_review", deleted: 0, heldForReview: 1, committedBatchId: null });
      expect(fake.committed).toEqual([]);
      expect(fake.created[0]!.records.map((record) => record.operation)).toEqual(["delete"]);
    });

    it("still applies a delete for an event Google reports cancelled", async () => {
      const prior = event({ externalEventId: "e1" });
      fetchGoogleCalendarEvents.mockResolvedValue([{ ...prior, status: "cancelled" }]);
      const fake = fakeStore({ links: [linkRow(prior)] });
      useStore(fake);
      expect(await runCalendarSync({ provider: "google_calendar", trigger: "scheduled" })).toMatchObject({
        status: "synced",
        deleted: 1,
        heldForReview: 0
      });
    });

    it("applies up to ten cancelled deletes", async () => {
      const priors = Array.from({ length: 10 }, (_, index) => cancelled(`c${index}`, index + 1));
      fetchGoogleCalendarEvents.mockResolvedValue(priors.map((prior) => ({ ...prior, status: "cancelled" })));
      const fake = fakeStore({ links: priors.map(linkRow) });
      useStore(fake);
      expect(await runCalendarSync({ provider: "google_calendar", trigger: "scheduled" })).toMatchObject({
        status: "synced",
        deleted: 10,
        heldForReview: 0
      });
    });

    it("holds every delete of a run that would apply more than ten, but still applies its updates", async () => {
      const priors = Array.from({ length: 11 }, (_, index) => cancelled(`c${index}`, index + 1));
      const edited = event({
        externalEventId: "upd",
        startsAt: "2026-10-20T09:00:00.000Z",
        endsAt: "2026-10-20T10:00:00.000Z"
      });
      fetchGoogleCalendarEvents.mockResolvedValue([
        ...priors.map((prior) => ({ ...prior, status: "cancelled" as const })),
        { ...edited, title: "Moved" }
      ]);
      const fake = fakeStore({ links: [...priors, edited].map(linkRow) });
      useStore(fake);
      const result = await runCalendarSync({ provider: "google_calendar", trigger: "scheduled" });
      expect(result).toMatchObject({ status: "needs_review", updated: 1, deleted: 0, heldForReview: 11 });
      expect(fake.created[0]!.records.map((record) => record.operation)).toEqual(["update"]);
      expect(fake.created[1]!.records.every((record) => record.operation === "delete")).toBe(true);
    });

    it("can be given another threshold through CALENDAR_SYNC_MAX_DELETES", async () => {
      state.env.CALENDAR_SYNC_MAX_DELETES = "1";
      const priors = [cancelled("a", 1), cancelled("b", 2)];
      fetchGoogleCalendarEvents.mockResolvedValue(priors.map((prior) => ({ ...prior, status: "cancelled" })));
      const fake = fakeStore({ links: priors.map(linkRow) });
      useStore(fake);
      expect(await runCalendarSync({ provider: "google_calendar", trigger: "scheduled" })).toMatchObject({
        deleted: 0,
        heldForReview: 2
      });
    });

    it("holds a cancellation as a conflict when the commitment was edited in OpenRhen since the link", async () => {
      const prior = event({ externalEventId: "e1" });
      fetchGoogleCalendarEvents.mockResolvedValue([{ ...prior, status: "cancelled" }]);
      const fake = fakeStore({ links: [{ ...linkRow(prior), title: "Dentist (the owner's edit)" }] });
      useStore(fake);
      const result = await runCalendarSync({ provider: "google_calendar", trigger: "scheduled" });
      expect(result).toMatchObject({ status: "needs_review", deleted: 0, heldForReview: 1, committedBatchId: null });
      expect(fake.committed).toEqual([]);
      expect(fake.created[0]!.records[0]).toMatchObject({ operation: "conflict" });
    });
  });

  describe("the optional adapter hooks", () => {
    const cancelled = (id: string, day: number) =>
      event({
        externalEventId: id,
        startsAt: `2026-10-${String(day).padStart(2, "0")}T09:00:00.000Z`,
        endsAt: `2026-10-${String(day).padStart(2, "0")}T10:00:00.000Z`
      });
    /** The Google adapter with its diff's records rewritten by `mark`, to stand in for a feed adapter. */
    const withMarked = (mark: (record: ImportRecord) => ImportRecord, holds?: (record: ImportRecord) => boolean) => ({
      ...googleCalendarAdapter,
      ...(holds ? { holds } : {}),
      async read(args: Parameters<typeof googleCalendarAdapter.read>[0]) {
        const read = await googleCalendarAdapter.read(args);
        if (read.status !== "read") return read;
        return {
          ...read,
          diff: async (store: Parameters<typeof read.diff>[0]) => {
            const diff = await read.diff(store);
            return { ...diff, records: diff.records.map(mark) };
          }
        };
      }
    });
    const editedWorld = () => {
      const prior = event({ externalEventId: "upd" });
      fetchGoogleCalendarEvents.mockResolvedValue([{ ...prior, title: "Moved" }]);
      return fakeStore({ links: [linkRow(prior)] });
    };

    it("applies on its own what holds() leaves alone, and holds what it names", async () => {
      const fake = editedWorld();
      useStore(fake);
      const adapter = withMarked(
        (record) => record,
        (record) => record.operation === "update"
      );
      expect(await runCalendarSync({ provider: "google_calendar", trigger: "scheduled", adapter })).toMatchObject({
        status: "needs_review",
        updated: 0,
        heldForReview: 1,
        committedBatchId: null
      });
      expect(fake.committed).toEqual([]);
    });

    it("counts a date cancel against the same budget as deletes", async () => {
      state.env.CALENDAR_SYNC_MAX_DELETES = "2";
      const deletes = [cancelled("d1", 1)];
      const edits = [cancelled("u1", 2), cancelled("u2", 3)];
      fetchGoogleCalendarEvents.mockResolvedValue([
        ...deletes.map((prior) => ({ ...prior, status: "cancelled" as const })),
        ...edits.map((prior) => ({ ...prior, title: "Moved" }))
      ]);
      const links = [...deletes, ...edits].map(linkRow);
      const asCancel = (record: ImportRecord): ImportRecord =>
        record.operation === "update"
          ? { ...record, relationships: { ...record.relationships, feedCancel: "true" } }
          : record;

      // Unmarked: one delete and two updates is within the budget of two, so all three apply.
      const plain = fakeStore({ links });
      useStore(plain);
      expect(await runCalendarSync({ provider: "google_calendar", trigger: "scheduled" })).toMatchObject({
        updated: 2,
        deleted: 1,
        heldForReview: 0
      });

      // Two updates marked as cancels spend the budget with the delete: three is over two, all held.
      const marked = fakeStore({ links });
      useStore(marked);
      expect(
        await runCalendarSync({ provider: "google_calendar", trigger: "scheduled", adapter: withMarked(asCancel) })
      ).toMatchObject({ updated: 0, deleted: 0, heldForReview: 3, committedBatchId: null });
    });

    it("leaves a provider without the hooks exactly as it was (spy on the store boundary)", async () => {
      expect("holds" in googleCalendarAdapter).toBe(false);
      const run = async (adapter?: typeof googleCalendarAdapter) => {
        const fake = editedWorld();
        useStore(fake);
        const result = await runCalendarSync({ provider: "google_calendar", trigger: "scheduled", adapter });
        // Record ids are random per diff; everything else must match.
        const created = fake.created.map((input) => ({
          ...input,
          records: input.records.map((record) => ({ ...record, id: "-" }))
        }));
        return { result: { ...result, syncedAt: undefined }, created, committed: fake.committed.length };
      };
      const baseline = await run();
      const inert = await run({ ...googleCalendarAdapter, holds: () => false });
      expect(inert.result).toEqual(baseline.result);
      expect(inert.created).toEqual(baseline.created);
      expect(inert.committed).toEqual(baseline.committed);
      expect(baseline.result).toMatchObject({ updated: 1, heldForReview: 0 });
    });
  });

  describe("overlapping runs", () => {
    it("lets the run that cannot take the lock report it, reading and changing nothing and recording no run", async () => {
      state.lockAvailable = false;
      const fake = fakeStore({});
      useStore(fake);
      const result = await runCalendarSync({ provider: "google_calendar", trigger: "manual" });
      expect(result).toMatchObject({ status: "already_running", provider: "google_calendar" });
      expect(fetchGoogleCalendarProof).not.toHaveBeenCalled();
      expect(withImportStore).not.toHaveBeenCalled();
      expect(runInserts()).toEqual([]);
      expect(state.released).toBe(1);
    });

    it("takes a lock keyed by provider and user, and releases it after the run", async () => {
      useStore(fakeStore({}));
      await runCalendarSync({ provider: "google_calendar", trigger: "scheduled" });
      const lock = sqlCalls.find((call) => call.text.includes("pg_try_advisory_lock"))!;
      expect(lock.values).toContain("calendar_sync:google_calendar:user-1");
      expect(sqlCalls.some((call) => call.text.includes("pg_advisory_unlock"))).toBe(true);
      expect(state.released).toBe(1);
    });

    it("releases the lock when the run fails", async () => {
      fetchGoogleCalendarEvents.mockRejectedValue(new Error("boom"));
      await runCalendarSync({ provider: "google_calendar", trigger: "scheduled" });
      expect(sqlCalls.some((call) => call.text.includes("pg_advisory_unlock"))).toBe(true);
      expect(state.released).toBe(1);
    });
  });

  describe("the review batch", () => {
    it("is left alone when a fresh diff would hold exactly what it already holds", async () => {
      const events = [event({ externalEventId: "new1" })];
      fetchGoogleCalendarEvents.mockResolvedValue(events);
      const first = fakeStore({});
      useStore(first);
      await runCalendarSync({ provider: "google_calendar", trigger: "scheduled" });
      const heldText = first.created[0]!.source.text!;

      const second = fakeStore({ openBatches: [{ id: "open-1", version: 4, sourceText: heldText }] });
      useStore(second);
      const result = await runCalendarSync({ provider: "google_calendar", trigger: "scheduled" });
      expect(result).toMatchObject({ status: "needs_review", heldForReview: 1, reviewBatchId: "open-1" });
      expect(second.created).toEqual([]);
      expect(second.deleted).toEqual([]);
    });

    it("replaces the previous one when the held events changed, keeping what was deselected", async () => {
      fetchGoogleCalendarEvents.mockResolvedValue([
        event({ externalEventId: "new1" }),
        event({ externalEventId: "new2" })
      ]);
      const fake = fakeStore({
        openBatches: [
          { id: "old-1", version: 1, sourceText: "{}", removedKeys: ["google_calendar:event:jon@example.com:new1"] }
        ]
      });
      useStore(fake);
      const result = await runCalendarSync({ provider: "google_calendar", trigger: "scheduled" });
      expect(result.status).toBe("needs_review");
      const held = fake.created[0]!.records;
      expect(held.find((record) => record.importKey.endsWith(":new1"))!.removed).toBe(true);
      expect(held.find((record) => record.importKey.endsWith(":new2"))!.removed).toBe(false);
      expect(fake.superseded).toHaveLength(1);
    });

    it("is discarded when nothing is waiting for a decision any more", async () => {
      const fake = fakeStore({ openBatches: [{ id: "stale-1", version: 1, sourceText: "{}" }] });
      useStore(fake);
      const result = await runCalendarSync({ provider: "google_calendar", trigger: "scheduled" });
      expect(result).toMatchObject({ status: "synced", heldForReview: 0, reviewBatchId: null });
      expect(fake.deleted).toEqual(["stale-1"]);
    });
  });

  it("does not propose an event that was dismissed and has not changed", async () => {
    const e = event({ externalEventId: "e1" });
    fetchGoogleCalendarEvents.mockResolvedValue([e]);
    const fake = fakeStore({
      dismissals: [{ external_event_id: "jon@example.com:e1", title: "Dentist", starts_at: new Date(e.startsAt) }]
    });
    useStore(fake);
    const result = await runCalendarSync({ provider: "google_calendar", trigger: "scheduled" });
    expect(result).toMatchObject({ status: "synced", eventCount: 1, heldForReview: 0 });
    expect(fake.created).toEqual([]);
  });

  describe("failures", () => {
    it("records a failed run and changes nothing when reading the events fails, keeping the proxy's reason", async () => {
      fetchGoogleCalendarEvents.mockRejectedValue(
        Object.assign(new Error("Google rejected the token."), { reason: "invalid_grant" })
      );
      const fake = fakeStore({});
      useStore(fake);
      const result = await runCalendarSync({ provider: "google_calendar", trigger: "scheduled" });
      expect(result).toMatchObject({
        status: "failed",
        provider: "google_calendar",
        message: "Google rejected the token.",
        reason: "invalid_grant"
      });
      expect(withImportStore).not.toHaveBeenCalled();
      expect(fake.created).toEqual([]);
      expect(fake.committed).toEqual([]);
      const runs = runInserts();
      expect(runs).toHaveLength(1);
      expect(runs[0]!.values).toContain("failed");
      expect(runs[0]!.values).toContain("google_calendar");
    });

    it("returns failed with the proof's reason when the connection itself is broken", async () => {
      fetchGoogleCalendarProof.mockResolvedValue({
        status: "failed",
        checkedAt: new Date().toISOString(),
        message: "The refresh token was revoked.",
        reason: "invalid_grant"
      });
      const result = await runCalendarSync({ provider: "google_calendar", trigger: "scheduled" });
      expect(result).toMatchObject({
        status: "failed",
        reason: "invalid_grant",
        message: "The refresh token was revoked."
      });
      expect(fetchGoogleCalendarEvents).not.toHaveBeenCalled();
      expect(withImportStore).not.toHaveBeenCalled();
    });

    it("returns not_configured, and records it, when the proxy has no credential", async () => {
      fetchGoogleCalendarProof.mockResolvedValue({
        status: "not_configured",
        missing: ["GOOGLE_CALENDAR_REFRESH_TOKEN"]
      });
      const result = await runCalendarSync({ provider: "google_calendar", trigger: "manual" });
      expect(result).toEqual({ status: "not_configured", missing: ["GOOGLE_CALENDAR_REFRESH_TOKEN"] });
      expect(fetchGoogleCalendarEvents).not.toHaveBeenCalled();
      expect(runInserts()).toHaveLength(1);
    });

    it("never throws when the import store itself fails, and reports it as a failed run", async () => {
      fetchGoogleCalendarEvents.mockResolvedValue([event({ externalEventId: "e1" })]);
      withImportStore.mockRejectedValue(new Error("connection refused"));
      const result = await runCalendarSync({ provider: "google_calendar", trigger: "scheduled" });
      expect(result).toMatchObject({ status: "failed", message: "connection refused" });
    });

    it("also refuses Google when the list names only another provider", async () => {
      state.env.CALENDAR_SYNC_PROVIDERS = "another_provider";
      expect(await runCalendarSync({ provider: "google_calendar", trigger: "scheduled" })).toMatchObject({
        status: "not_enabled"
      });
      expect(fetchGoogleCalendarProof).not.toHaveBeenCalled();
    });

    it("treats a blank or unknown list as the default, Google only", async () => {
      state.env.CALENDAR_SYNC_PROVIDERS = "  ";
      useStore(fakeStore({}));
      expect((await runCalendarSync({ provider: "google_calendar", trigger: "scheduled" })).status).toBe("synced");
    });
  });
});
