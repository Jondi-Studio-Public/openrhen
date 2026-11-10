import { describe, expect, it, vi } from "vitest";
import { CLIENT_VIEW_TYPES } from "@openrhen/contracts";
import { createSeedState, type PortalState } from "@/state/portal-state";
import type { StoredCheckIn } from "@/server/persistence/postgres/readers/check-in-read";

const legs = vi.hoisted(() => ({ value: [] as unknown[] }));
vi.mock("@/server/device/device-now", () => ({ leaveByLegsNow: () => legs.value }));

const { buildClientView, clientViewETag, clientViewETagMatches, parseClientViewParts } = await import("./client-view");

const NOW = new Date("2026-11-10T09:00:00.000Z");
const iso = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000).toISOString();
const state = (overrides: Record<string, unknown> = {}) =>
  ({ ...createSeedState(NOW), ...overrides }) as unknown as PortalState;

const checkIn = (overrides: Partial<StoredCheckIn> = {}): StoredCheckIn => ({
  id: "6f0c2c1e-3f5b-4f3a-9b0e-2a6d5f0d9a11",
  version: 1,
  slotAt: iso(-5),
  promptedAt: null,
  answeredAt: null,
  directiveKind: "action",
  directiveTargetId: "a1",
  directivePhase: null,
  directiveTitle: "Write section 2",
  status: "pending",
  deviationCategory: null,
  deviationNote: null,
  deviationTargetId: null,
  answerSource: null,
  tags: [],
  ...overrides
});

describe("parseClientViewParts", () => {
  it("defaults to all three parts, in the response's order whatever order is asked", () => {
    expect(parseClientViewParts(null)).toEqual({ ok: true, parts: ["now", "day", "pending"] });
    expect(parseClientViewParts("pending, now")).toEqual({ ok: true, parts: ["now", "pending"] });
  });

  it("refuses an unknown or empty part by name", () => {
    expect(parseClientViewParts("now,week")).toMatchObject({ ok: false, error: expect.stringContaining('"week"') });
    expect(parseClientViewParts("")).toMatchObject({ ok: false });
  });
});

describe("buildClientView", () => {
  it("carries only the parts asked for, and every part validates against the published schema", () => {
    legs.value = [];
    const all = buildClientView(state(), NOW, ["now", "day", "pending"], null);
    expect(Object.keys(all).sort()).toEqual(
      ["day", "now", "pending", "planCurrent", "schemaVersion", "timezone", "validUntil"].sort()
    );
    expect(CLIENT_VIEW_TYPES.ClientView.safeParse(all).success).toBe(true);
    const nowOnly = buildClientView(state(), NOW, ["now"], null);
    expect(nowOnly).not.toHaveProperty("day");
    expect(nowOnly).not.toHaveProperty("pending");
  });

  it("holds the waiting check-in, the session, the leave-by leg and the place suggestion under pending", () => {
    legs.value = [
      {
        commitmentId: "c1",
        occurrenceStartsAt: iso(90),
        title: "Dentist",
        leaveBy: new Date(iso(60)),
        remindAt: new Date(iso(45)),
        typicalMinutes: 25,
        allowingMinutes: 30,
        originAssumed: false,
        phase: "remind"
      },
      // Suppressed and not-yet-due legs are not shown, as on the handheld.
      {
        commitmentId: "c2",
        leaveBy: new Date(iso(5)),
        remindAt: new Date(iso(-5)),
        phase: "leave",
        suppressedBy: "arrived"
      },
      { commitmentId: "c3", leaveBy: new Date(iso(500)), remindAt: new Date(iso(480)), phase: "upcoming" }
    ];
    const view = buildClientView(
      state({
        activeSession: {
          id: "s1",
          actionId: "a1",
          status: "running",
          targetType: "action",
          targetId: "a1",
          startedAt: iso(-10),
          plannedEndAt: iso(35),
          plannedMinutes: 45,
          remainingBeforeMinutes: 90,
          activeElapsedSeconds: 600
        },
        actions: [{ id: "a1", title: "Write section 2" }],
        pendingLocationSuggestion: { locationId: "studio", locationName: "Studio", observedAt: iso(-2) }
      }),
      NOW,
      ["pending"],
      checkIn()
    );
    expect(CLIENT_VIEW_TYPES.ClientView.safeParse(view).success).toBe(true);
    expect(view.pending).toMatchObject({
      checkIn: { id: "6f0c2c1e-3f5b-4f3a-9b0e-2a6d5f0d9a11", status: "pending", promptedAt: null },
      session: { id: "s1", title: "Write section 2", elapsedMinutes: 10, minutesLeft: 35 },
      leaveBy: { commitmentId: "c1", phase: "remind", leaveBy: iso(60) },
      placeSuggestion: { locationId: "studio" }
    });
  });

  it("shows a still-unanswered unknown slot, never an answered or superseded one, and nothing for none", () => {
    legs.value = [];
    expect(buildClientView(state(), NOW, ["pending"], checkIn({ status: "unknown" })).pending?.checkIn?.status).toBe(
      "unknown"
    );
    expect(buildClientView(state(), NOW, ["pending"], checkIn({ status: "on_track" })).pending?.checkIn).toBeNull();
    expect(buildClientView(state(), NOW, ["pending"], null).pending).toEqual({
      checkIn: null,
      session: null,
      leaveBy: null,
      placeSuggestion: null
    });
  });

  it("freezes a paused session's minutes left at what the pause stopped on", () => {
    legs.value = [];
    const view = buildClientView(
      state({
        activeSession: {
          id: "s1",
          actionId: "a1",
          status: "paused",
          startedAt: iso(-60),
          plannedEndAt: iso(-5),
          plannedMinutes: 45,
          remainingBeforeMinutes: 90,
          activeElapsedSeconds: 1800,
          pausedRemainingSeconds: 900
        }
      }),
      NOW,
      ["pending"],
      null
    );
    expect(view.pending?.session?.minutesLeft).toBe(15);
  });
});

describe("the ETag", () => {
  it("changes with any byte of the body and matches in the forms a proxy may send", () => {
    const tag = clientViewETag('{"a":1}');
    expect(clientViewETag('{"a":2}')).not.toBe(tag);
    expect(clientViewETagMatches(tag, tag)).toBe(true);
    expect(clientViewETagMatches(`W/${tag}`, tag)).toBe(true);
    expect(clientViewETagMatches(`"x", ${tag}`, tag)).toBe(true);
    expect(clientViewETagMatches("*", tag)).toBe(true);
    expect(clientViewETagMatches('"other"', tag)).toBe(false);
    expect(clientViewETagMatches(null, tag)).toBe(false);
  });
});
