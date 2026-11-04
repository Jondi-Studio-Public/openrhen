import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSeedState, type PortalState } from "@/state/portal-state";

/**
 * The state store and the check-in read are both replaced wholesale — the store with a plain holder
 * (like `deliverables/[id]/chat/route.test.ts`), the check-in read with a stub that never touches a
 * database, per the task's own note that the device routes must be testable without one.
 */
const holder = vi.hoisted(() => ({ current: null as PortalState | null }));
vi.mock("@/server/persistence/state-store", () => ({ getStateStore: () => ({ get: async () => holder.current }) }));

const checkInHolder = vi.hoisted(() => ({
  value: null as { id: string; status: string; directiveTitle: string } | null
}));
vi.mock("@/server/runtime-env", () => ({ databaseUrl: () => "postgres://test" }));
vi.mock("@/server/persistence/postgres/sql-pool", () => ({ sqlPool: () => ({}) }));
vi.mock("@/server/persistence/postgres/ensure-user", () => ({ ensureUser: async () => "user-1" }));
vi.mock("@/server/persistence/postgres/readers/check-in-read", () => ({
  readCurrentCheckIn: async () => checkInHolder.value
}));

const { GET } = await import("./route");
const { DEFAULT_LOCATION_STALE_AFTER_MINUTES } = await import("@openrhen/contracts");
const { buildDeviceSnapshot, DEVICE_TEXT_BUDGET } = await import("@/server/device/device-now");
const { clearCachedDeviceState } = await import("@/server/device/device-state-cache");

const NOW = new Date("2026-09-02T10:00:00.000Z");
const iso = (offsetMinutes: number) => new Date(NOW.getTime() + offsetMinutes * 60_000).toISOString();

function baseState(overrides: Record<string, unknown> = {}): PortalState {
  const seed = createSeedState(NOW);
  // The stored display format that the signed-in owner's state carries.
  return { ...seed, settings: { ...seed.settings, locale: "en-AU" }, ...overrides } as unknown as PortalState;
}

const get = (headers?: HeadersInit) =>
  GET(new Request("http://portal.test/api/device/now", headers ? { headers } : {}), {});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  holder.current = null;
  checkInHolder.value = null;
  // The route caches the hydrated state for a few seconds (`device-state-cache.ts`) so a real device's
  // polling doesn't re-run the full hydration every time; with the fake clock pinned to `NOW` for every
  // test, that cache would otherwise never expire and would leak one test's `holder.current` into the
  // next.
  clearCachedDeviceState();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
});

describe("GET /api/device/now", () => {
  it("describes an active running session, counting down to its planned end", async () => {
    holder.current = baseState({
      commitments: [],
      activeSession: {
        id: "session-1",
        actionId: "networking-section-one",
        status: "running",
        startedAt: iso(-10),
        plannedEndAt: iso(15),
        plannedMinutes: 25,
        remainingBeforeMinutes: 90,
        activeElapsedSeconds: 600
      }
    });
    const body = (await (await get()).json()) as ReturnType<typeof buildDeviceSnapshot>;
    expect(body.activity).toEqual({
      kind: "session",
      id: "session-1",
      title: "Draft networking assignment section 1",
      startsAt: new Date(iso(-10)).getTime(),
      endsAt: new Date(iso(15)).getTime(),
      countdown: true
    });
    expect(body.tracking).toEqual({ active: true, paused: false, kind: "session", id: "session-1" });
    expect(body.actions).toEqual({ canStart: false, canStop: true, canArrive: false, onMyWay: false, atOrigin: false });
  });

  it("stops the countdown for a paused session and reports it paused", async () => {
    holder.current = baseState({
      commitments: [],
      activeSession: {
        id: "session-1",
        actionId: "networking-section-one",
        status: "paused",
        startedAt: iso(-10),
        plannedEndAt: iso(15),
        plannedMinutes: 25,
        remainingBeforeMinutes: 90,
        activeElapsedSeconds: 600,
        pausedRemainingSeconds: 300
      }
    });
    const body = (await (await get()).json()) as ReturnType<typeof buildDeviceSnapshot>;
    expect(body.activity?.countdown).toBe(false);
    expect(body.tracking).toEqual({ active: true, paused: true, kind: "session", id: "session-1" });
  });

  it("reports a fixed-commitment session as tracking kind 'commitment'", async () => {
    holder.current = baseState({
      commitments: [],
      activeSession: {
        id: "session-1",
        actionId: "meeting",
        targetType: "fixed_commitment",
        targetId: "meeting",
        targetTitle: "Team meeting",
        status: "running",
        startedAt: iso(-5),
        plannedEndAt: iso(10),
        plannedMinutes: 15,
        remainingBeforeMinutes: 0,
        activeElapsedSeconds: 300
      }
    });
    const body = (await (await get()).json()) as ReturnType<typeof buildDeviceSnapshot>;
    expect(body.activity?.kind).toBe("session");
    expect(body.activity?.title).toBe("Team meeting");
    expect(body.tracking.kind).toBe("commitment");
  });

  it("surfaces a late protected commitment with lateness and a pending arrival", async () => {
    holder.current = baseState({
      commitments: [
        {
          id: "meeting",
          title: "Client meeting",
          startsAt: iso(-10),
          endsAt: iso(50),
          status: "confirmed",
          setupBeforeMinutes: 0,
          transitionAfterMinutes: 0,
          locationId: "loc-campus"
        }
      ],
      conditionDefinitions: [{ id: "loc-campus", name: "Campus" }],
      currentSituation: { locationId: null, overrides: {}, carrying: {}, transportModes: ["car"], travel: {} },
      planning: {
        status: "current",
        result: {
          currentDirective: { kind: "none", title: "Nothing fits", recommendedMinutes: 0 },
          recommendation: {
            primary: null,
            protectedCommitment: {
              id: "meeting",
              title: "Client meeting",
              phase: "active",
              startsAt: iso(-10),
              endsAt: iso(50),
              protectedStartAt: iso(-10),
              protectedEndAt: iso(50),
              phaseStartsAt: iso(-10),
              phaseEndsAt: iso(50),
              late: true
            }
          }
        }
      }
    });
    const body = (await (await get()).json()) as ReturnType<typeof buildDeviceSnapshot>;
    expect(body.activity).toMatchObject({
      kind: "commitment",
      id: "meeting",
      title: "Client meeting",
      countdown: true
    });
    expect(body.late).toEqual({ isLate: true, lateByMin: 10 });
    expect(body.arrival).toEqual({ pending: true, commitmentId: "meeting", label: "I'm at Campus" });
    expect(body.actions.canStart).toBe(true);
    expect(body.actions.canArrive).toBe(true);
  });

  it("directs the pending prep step instead of the commitment when it is running late", async () => {
    // Mirrors now-model.ts's `routineStepsRunDespiteCommitment`: a `late` commitment
    // still occupies `protectedCommitment`, but its own overdue before-phase step is what the device
    // should offer, not "start the commitment itself" — the whole point of `late` is that the
    // before-phase step is exactly what is overdue.
    holder.current = baseState({
      commitments: [
        {
          id: "dinner",
          title: "Dinner and reset",
          startsAt: iso(-10),
          endsAt: iso(60),
          status: "confirmed",
          setupBeforeMinutes: 0,
          transitionAfterMinutes: 0
        }
      ],
      routineSteps: [
        {
          id: "step-uniform",
          commitmentId: "dinner",
          title: "Prepare uniform",
          durationMinutes: 10,
          sequence: 1,
          timingRule: "flexible",
          energy: "low",
          contexts: [],
          dependencyIds: [],
          phase: "before",
          status: "pending"
        }
      ],
      planning: {
        status: "current",
        result: {
          currentDirective: {
            kind: "routine_step",
            targetId: "step-uniform",
            title: "Prepare uniform",
            recommendedMinutes: 10
          },
          recommendation: {
            primary: null,
            protectedCommitment: {
              id: "dinner",
              title: "Dinner and reset",
              phase: "setup",
              late: true,
              startsAt: iso(-10),
              endsAt: iso(60),
              protectedStartAt: iso(-10),
              protectedEndAt: iso(70),
              phaseStartsAt: iso(-10),
              phaseEndsAt: iso(60)
            }
          }
        }
      }
    });
    const body = (await (await get()).json()) as ReturnType<typeof buildDeviceSnapshot>;
    expect(body.activity).toMatchObject({ kind: "routine_step", id: "step-uniform", title: "Prepare uniform" });
    // The commitment is still reported as late (for the lateness banner) even though the routine
    // step, not the commitment, is what's offered as the activity to start.
    expect(body.late).toEqual({ isLate: true, lateByMin: 10 });
    expect(body.actions.canStart).toBe(true);
  });

  it("directs a pending routine step when the engine's directive names one", async () => {
    holder.current = baseState({
      commitments: [],
      routineSteps: [
        {
          id: "step-1",
          commitmentId: "meeting",
          title: "Get dressed",
          durationMinutes: 10,
          sequence: 0,
          timingRule: "contiguous",
          energy: "low",
          contexts: [],
          dependencyIds: [],
          phase: "before",
          status: "pending",
          scheduledStartAt: iso(-5),
          scheduledEndAt: iso(5)
        }
      ],
      planning: {
        status: "current",
        result: {
          currentDirective: { kind: "routine_step", targetId: "step-1", title: "Get dressed", recommendedMinutes: 10 },
          recommendation: { primary: null }
        }
      }
    });
    const body = (await (await get()).json()) as ReturnType<typeof buildDeviceSnapshot>;
    expect(body.activity).toEqual({
      kind: "routine_step",
      id: "step-1",
      title: "Get dressed",
      startsAt: new Date(iso(-5)).getTime(),
      endsAt: new Date(iso(5)).getTime(),
      countdown: true
    });
    expect(body.actions.canStart).toBe(true);
  });

  it("names travel as the activity, with no clock either side", async () => {
    holder.current = baseState({
      commitments: [],
      planning: {
        status: "current",
        result: {
          currentDirective: {
            kind: "travel",
            toLocationId: "loc-campus",
            title: "Drive to campus",
            recommendedMinutes: 20,
            source: "measured"
          },
          recommendation: { primary: null }
        }
      }
    });
    const body = (await (await get()).json()) as ReturnType<typeof buildDeviceSnapshot>;
    expect(body.activity).toEqual({
      kind: "travel",
      id: "loc-campus",
      title: "Drive to campus",
      startsAt: null,
      endsAt: null,
      countdown: false
    });
    expect(body.actions).toEqual({
      canStart: false,
      canStop: false,
      canArrive: false,
      onMyWay: false,
      atOrigin: false
    });
  });

  it("shows sleep once its window has opened", async () => {
    holder.current = baseState({
      commitments: [],
      sleepPlans: [
        {
          id: "sleep-1",
          plannedStartAt: iso(-5),
          plannedWakeAt: iso(8 * 60),
          desiredMinutes: 480,
          allowedMinutes: 480,
          sleepDeficitMinutes: 0,
          anchorDeviationMinutes: 0,
          hardErrors: [],
          explanation: "",
          status: "planned"
        }
      ]
    });
    const body = (await (await get()).json()) as ReturnType<typeof buildDeviceSnapshot>;
    expect(body.activity).toEqual({
      kind: "sleep",
      id: "sleep-1",
      title: "Sleep",
      startsAt: new Date(iso(-5)).getTime(),
      endsAt: new Date(iso(8 * 60)).getTime(),
      countdown: true
    });
    expect(body.actions).toEqual({
      canStart: false,
      canStop: false,
      canArrive: false,
      onMyWay: false,
      atOrigin: false
    });
  });

  it("falls back to the engine's primary recommendation", async () => {
    holder.current = baseState({
      commitments: [],
      planning: {
        status: "current",
        result: {
          currentDirective: { kind: "none", title: "Nothing else fits", recommendedMinutes: 0 },
          recommendation: {
            primary: { action: { id: "room-floor", title: "Sort the bedroom floor" }, recommendedMinutes: 30 }
          }
        }
      }
    });
    const body = (await (await get()).json()) as ReturnType<typeof buildDeviceSnapshot>;
    expect(body.activity).toEqual({
      kind: "recommended",
      id: "room-floor",
      title: "Sort the bedroom floor",
      startsAt: null,
      endsAt: null,
      countdown: false
    });
    expect(body.actions).toEqual({ canStart: true, canStop: false, canArrive: false, onMyWay: false, atOrigin: false });
  });

  it("says the break before resting work, starting when it ends, with Start still offered", async () => {
    holder.current = baseState({
      commitments: [],
      planning: {
        status: "current",
        result: {
          currentDirective: {
            kind: "action",
            targetId: "room-floor",
            title: "Sort the bedroom floor",
            recommendedMinutes: 30,
            notBefore: iso(10)
          },
          recommendation: {
            primary: { action: { id: "room-floor", title: "Sort the bedroom floor" }, recommendedMinutes: 30 }
          }
        }
      }
    });
    const body = (await (await get()).json()) as ReturnType<typeof buildDeviceSnapshot>;
    expect(body.activity?.kind).toBe("recommended");
    expect(body.activity?.title).toMatch(/^Break until \d{1,2}:\d{2}\s?[ap]m · Sort/);
    expect(body.activity?.startsAt).toBe(new Date(iso(10)).getTime());
    expect(body.actions.canStart).toBe(true);
  });

  it("says the break before a resting deliverable, matched by its real id", async () => {
    holder.current = baseState({
      commitments: [],
      planning: {
        status: "current",
        result: {
          currentDirective: {
            kind: "deliverable",
            targetId: "essay",
            title: "Essay",
            recommendedMinutes: 30,
            notBefore: iso(10)
          },
          recommendation: {
            primary: {
              action: { id: "deliverable:essay", title: "Essay", deliverableId: "essay" },
              recommendedMinutes: 30
            }
          }
        }
      }
    });
    const body = (await (await get()).json()) as ReturnType<typeof buildDeviceSnapshot>;
    expect(body.activity?.title).toMatch(/^Break until \d{1,2}:\d{2}\s?[ap]m · Essay/);
    expect(body.activity?.startsAt).toBe(new Date(iso(10)).getTime());
  });

  it("never shows another item's break on the recommended work", async () => {
    holder.current = baseState({
      commitments: [],
      planning: {
        status: "current",
        result: {
          currentDirective: {
            kind: "action",
            targetId: "someone-else",
            title: "Other work",
            recommendedMinutes: 30,
            notBefore: iso(10)
          },
          recommendation: {
            primary: { action: { id: "room-floor", title: "Sort the bedroom floor" }, recommendedMinutes: 30 }
          }
        }
      }
    });
    const body = (await (await get()).json()) as ReturnType<typeof buildDeviceSnapshot>;
    expect(body.activity).toMatchObject({ kind: "recommended", title: "Sort the bedroom floor", startsAt: null });
  });

  it("reports free/null when nothing at all is on the clock", async () => {
    holder.current = baseState({ commitments: [], sleepPlans: [] });
    const body = (await (await get()).json()) as ReturnType<typeof buildDeviceSnapshot>;
    expect(body.activity).toBeNull();
    expect(body.actions).toEqual({
      canStart: false,
      canStop: false,
      canArrive: false,
      onMyWay: false,
      atOrigin: false
    });
    expect(body.arrival).toEqual({ pending: false, commitmentId: null, label: null });
  });

  it("answers 304 with no body when If-None-Match matches the current stateVersion", async () => {
    holder.current = baseState({ commitments: [], sleepPlans: [] });
    const first = await get();
    const etag = first.headers.get("ETag");
    expect(etag).toBeTruthy();
    const second = await get({ "if-none-match": etag! });
    expect(second.status).toBe(304);
    expect(await second.text()).toBe("");
    expect(second.headers.get("ETag")).toBe(etag);
  });

  it("serves a cached state on a poll inside the TTL, even if the backing store changes underneath it", async () => {
    holder.current = baseState({ commitments: [] });
    const first = (await (await get()).json()) as ReturnType<typeof buildDeviceSnapshot>;
    expect(first.activity).toBeNull();
    holder.current = baseState({
      commitments: [],
      activeSession: {
        id: "session-1",
        actionId: "networking-section-one",
        status: "running",
        startedAt: iso(-1),
        plannedEndAt: iso(20),
        plannedMinutes: 25,
        remainingBeforeMinutes: 90,
        activeElapsedSeconds: 60
      }
    });
    // Still well inside the cache's TTL, so this poll must not have re-hydrated from the store.
    const second = (await (await get()).json()) as ReturnType<typeof buildDeviceSnapshot>;
    expect(second.activity).toBeNull();
  });

  it("re-hydrates once the cached state has aged past its TTL", async () => {
    holder.current = baseState({ commitments: [] });
    await get();
    holder.current = baseState({
      commitments: [],
      activeSession: {
        id: "session-1",
        actionId: "networking-section-one",
        status: "running",
        startedAt: iso(-1),
        plannedEndAt: iso(20),
        plannedMinutes: 25,
        remainingBeforeMinutes: 90,
        activeElapsedSeconds: 60
      }
    });
    vi.setSystemTime(new Date(NOW.getTime() + 10_000));
    const body = (await (await get()).json()) as ReturnType<typeof buildDeviceSnapshot>;
    expect(body.activity?.kind).toBe("session");
  });

  it("keeps the ETag stable when only the wall clock has moved", async () => {
    const state = baseState({ commitments: [], sleepPlans: [] });
    const checkIn = { pending: false, promptId: null, question: null };
    const first = buildDeviceSnapshot(state, new Date("2026-09-02T10:00:00.000Z"), checkIn);
    const second = buildDeviceSnapshot(state, new Date("2026-09-02T10:05:00.000Z"), checkIn);
    expect(second.stateVersion).toBe(first.stateVersion);
    expect(second.serverTime).not.toBe(first.serverTime);
  });

  /**
   * `next` must agree with the Now page's own `nextCommitment` (`features/now/now-model.ts`), the
   * field behind the "Next commitment: X at Y" line `recommendation-panel.tsx` renders — not with
   * `resolveNowActivity`'s stricter `confirmed`-only test for what currently *owns* the clock. A
   * previous revision conflated the two and made the handheld hide a tentative "next" the phone was
   * still showing for the same row.
   */
  it("names a merely tentative commitment as next, the same as the Now page's own 'Next commitment' line", async () => {
    const state = baseState({
      commitments: [
        {
          id: "maybe-dinner",
          title: "Dinner with Sam",
          startsAt: iso(120),
          endsAt: iso(180),
          status: "tentative",
          setupBeforeMinutes: 0,
          transitionAfterMinutes: 0
        }
      ]
    });
    const checkIn = { pending: false, promptId: null, question: null };
    const body = buildDeviceSnapshot(state, NOW, checkIn);
    expect(body.next).toEqual({ title: "Dinner with Sam", startsAt: new Date(iso(120)).getTime() });
  });

  it("still omits a cancelled commitment from next", async () => {
    const state = baseState({
      commitments: [
        {
          id: "called-off",
          title: "Cancelled catch-up",
          startsAt: iso(120),
          endsAt: iso(180),
          status: "cancelled",
          setupBeforeMinutes: 0,
          transitionAfterMinutes: 0
        }
      ]
    });
    const checkIn = { pending: false, promptId: null, question: null };
    const body = buildDeviceSnapshot(state, NOW, checkIn);
    expect(body.next).toBeNull();
  });

  it("prefers the earlier of a tentative and a confirmed upcoming commitment, same as nextCommitment's own sort", async () => {
    const state = baseState({
      commitments: [
        {
          id: "later-confirmed",
          title: "Confirmed later",
          startsAt: iso(180),
          endsAt: iso(210),
          status: "confirmed",
          setupBeforeMinutes: 0,
          transitionAfterMinutes: 0
        },
        {
          id: "sooner-tentative",
          title: "Tentative sooner",
          startsAt: iso(60),
          endsAt: iso(90),
          status: "tentative",
          setupBeforeMinutes: 0,
          transitionAfterMinutes: 0
        }
      ]
    });
    const checkIn = { pending: false, promptId: null, question: null };
    const body = buildDeviceSnapshot(state, NOW, checkIn);
    expect(body.next).toEqual({ title: "Tentative sooner", startsAt: new Date(iso(60)).getTime() });
  });
});

/**
 * The guarantees the ESP32 firmware is written against, asserted here rather than described in a
 * comment: a field budget it does not have to enforce itself, a freshness flag it can trust to wake
 * it, and a conditional request that still saves the body after a proxy has touched the tag.
 * the design notes is the prose form of exactly these.
 */
describe("GET /api/device/now contract", () => {
  const LONG_TITLE = "Prepare the uniform, pack the bag and check the timetable before leaving";

  it("truncates every text field to the declared budget, at a word boundary", async () => {
    holder.current = baseState({
      commitments: [
        {
          id: "later",
          title: LONG_TITLE,
          startsAt: iso(120),
          endsAt: iso(180),
          status: "confirmed",
          setupBeforeMinutes: 0,
          transitionAfterMinutes: 0
        }
      ],
      planning: {
        status: "current",
        result: {
          currentDirective: { kind: "none", title: "Nothing fits", recommendedMinutes: 0 },
          recommendation: { primary: { action: { id: "room-floor", title: LONG_TITLE }, recommendedMinutes: 30 } }
        }
      }
    });
    checkInHolder.value = { id: "prompt-1", status: "pending", directiveTitle: LONG_TITLE };
    const body = (await (await get()).json()) as ReturnType<typeof buildDeviceSnapshot>;
    expect(body.activity!.title.length).toBeLessThanOrEqual(DEVICE_TEXT_BUDGET);
    expect(body.activity!.title).toBe("Prepare the uniform, pack the bag and...");
    expect(body.next!.title.length).toBeLessThanOrEqual(DEVICE_TEXT_BUDGET);
    expect(body.checkIn.question!.length).toBeLessThanOrEqual(DEVICE_TEXT_BUDGET);
    expect(body.checkIn.question!.endsWith("...")).toBe(true);
  });

  it("truncates the arrival label too, and leaves a short title exactly as it is", async () => {
    holder.current = baseState({
      commitments: [
        {
          id: "meeting",
          title: "Client meeting",
          startsAt: iso(-10),
          endsAt: iso(50),
          status: "confirmed",
          setupBeforeMinutes: 0,
          transitionAfterMinutes: 0,
          locationId: "loc-campus"
        }
      ],
      conditionDefinitions: [{ id: "loc-campus", name: "the Bourke Street campus reception desk" }],
      currentSituation: { locationId: null, overrides: {}, carrying: {}, transportModes: ["car"], travel: {} },
      planning: {
        status: "current",
        result: {
          currentDirective: { kind: "none", title: "Nothing fits", recommendedMinutes: 0 },
          recommendation: {
            primary: null,
            protectedCommitment: {
              id: "meeting",
              title: "Client meeting",
              phase: "active",
              startsAt: iso(-10),
              endsAt: iso(50),
              protectedStartAt: iso(-10),
              protectedEndAt: iso(50),
              phaseStartsAt: iso(-10),
              phaseEndsAt: iso(50)
            }
          }
        }
      }
    });
    const body = (await (await get()).json()) as ReturnType<typeof buildDeviceSnapshot>;
    expect(body.arrival.label!.length).toBeLessThanOrEqual(DEVICE_TEXT_BUDGET);
    expect(body.arrival.label).toBe("I'm at the Bourke Street campus...");
    expect(body.activity!.title).toBe("Client meeting");
  });

  it("reports planFresh, and flips it — with the ETag — once the plan has expired", async () => {
    const planned = (validUntil: string) => ({
      status: "current",
      validUntil,
      result: {
        currentDirective: { kind: "none", title: "Nothing fits", recommendedMinutes: 0 },
        recommendation: { primary: null }
      }
    });
    holder.current = baseState({ commitments: [], sleepPlans: [], planning: planned(iso(30)) });
    const freshBody = (await (await get()).json()) as ReturnType<typeof buildDeviceSnapshot>;
    expect(freshBody.planFresh).toBe(true);

    clearCachedDeviceState();
    holder.current = baseState({ commitments: [], sleepPlans: [], planning: planned(iso(-30)) });
    const staleBody = (await (await get()).json()) as ReturnType<typeof buildDeviceSnapshot>;
    expect(staleBody.planFresh).toBe(false);
    // Hashed into the state version on purpose: the device sleeps between polls, and a flag that
    // changed without changing the tag would never reach it.
    expect(staleBody.stateVersion).not.toBe(freshBody.stateVersion);
  });

  it("wakes the device when an asserted location goes stale, even before the plan expires", async () => {
    const staleAfterMs = DEFAULT_LOCATION_STALE_AFTER_MINUTES * 60_000;
    const setAt = new Date(NOW.getTime() - staleAfterMs + 20 * 60_000);
    holder.current = baseState({
      commitments: [],
      sleepPlans: [],
      currentSituation: {
        ...createSeedState(NOW).currentSituation,
        locationId: "home",
        locationSetAt: setAt.toISOString()
      },
      planning: {
        status: "current",
        validUntil: iso(600),
        result: {
          currentDirective: { kind: "none", title: "Nothing fits", recommendedMinutes: 0 },
          recommendation: { primary: null }
        }
      }
    });
    const body = (await (await get()).json()) as ReturnType<typeof buildDeviceSnapshot>;
    expect(body.nextChangeAt).toBe(setAt.getTime() + staleAfterMs);
  });

  it("quotes the ETag, forbids stored copies, and honours a weakened If-None-Match", async () => {
    holder.current = baseState({ commitments: [], sleepPlans: [] });
    const first = await get();
    const etag = first.headers.get("ETag")!;
    const body = (await first.json()) as ReturnType<typeof buildDeviceSnapshot>;
    expect(etag).toBe(`"${body.stateVersion}"`);
    expect(first.headers.get("Cache-Control")).toBe("no-store");

    for (const header of [etag, `W/${etag}`, body.stateVersion, `"nonsense", ${etag}`]) {
      const conditional = await get({ "if-none-match": header });
      expect(conditional.status, header).toBe(304);
      expect(await conditional.text()).toBe("");
      expect(conditional.headers.get("ETag")).toBe(etag);
      expect(conditional.headers.get("Cache-Control")).toBe("no-store");
    }
    const changed = await get({ "if-none-match": '"0000000000000000"' });
    expect(changed.status).toBe(200);
  });

  describe("leaveBy / wakeAt", () => {
    function leaveByState(leaveByOffsetMinutes: number, originAssumed = false): PortalState {
      return baseState({
        commitments: [
          {
            id: "dentist",
            title: "Dentist",
            startsAt: iso(40),
            endsAt: iso(70),
            status: "confirmed",
            setupBeforeMinutes: 0,
            transitionAfterMinutes: 0
          }
        ],
        settings: { ...createSeedState(NOW).settings, leaveByLeadMinutes: 10 },
        currentSituation: {
          locationId: "loc-home",
          locationSetAt: iso(-30),
          overrides: {},
          carrying: {},
          transportModes: ["car"],
          travel: {}
        },
        planning: {
          status: "current",
          result: {
            derivedState: {
              commitmentTimelines: [
                {
                  id: "dentist",
                  startsAt: iso(40),
                  leaveBy: iso(leaveByOffsetMinutes),
                  journeyBefore: {
                    fromLocationId: "loc-home",
                    toLocationId: "loc-dentist",
                    minutes: 28,
                    typicalMinutes: 22,
                    source: "fallback",
                    sampleCount: 0,
                    ...(originAssumed ? { originAssumed: true } : {})
                  }
                }
              ]
            },
            currentDirective: { kind: "none", title: "Nothing else fits", recommendedMinutes: 0 },
            recommendation: { primary: null }
          }
        }
      });
    }

    it("carries a leaveBy leg in remind phase, with its actions and origin label", async () => {
      // leaveBy at +8 min, lead 10 min: remindAt is 2 min in the past, so it's already in `remind`.
      holder.current = leaveByState(8);
      const body = (await (await get()).json()) as ReturnType<typeof buildDeviceSnapshot>;
      expect(body.leaveBy).toMatchObject({
        commitmentId: "dentist",
        title: "Leave for Dentist",
        phase: "remind",
        assumedOrigin: false,
        originLabel: null
      });
      expect(body.leaveBy!.leaveAt).toBe(new Date(iso(8)).getTime());
      expect(body.actions.onMyWay).toBe(true);
      expect(body.actions.atOrigin).toBe(false);
      expect(body.wakeAt).not.toBeNull();
    });

    it("moves to leave phase once leaveBy has arrived, and null once past the grace window", async () => {
      holder.current = leaveByState(0);
      const atLeaveBy = (await (await get()).json()) as ReturnType<typeof buildDeviceSnapshot>;
      expect(atLeaveBy.leaveBy?.phase).toBe("leave");

      clearCachedDeviceState();
      holder.current = leaveByState(-10);
      const pastGrace = (await (await get()).json()) as ReturnType<typeof buildDeviceSnapshot>;
      expect(pastGrace.leaveBy).toBeNull();
      expect(pastGrace.actions.onMyWay).toBe(false);
      expect(pastGrace.actions.atOrigin).toBe(false);
    });

    it("offers atOrigin, not onMyWay, with the fixed origin label when the origin is assumed", async () => {
      holder.current = leaveByState(8, true);
      const body = (await (await get()).json()) as ReturnType<typeof buildDeviceSnapshot>;
      expect(body.leaveBy).toMatchObject({ assumedOrigin: true, originLabel: "Yes, I'm home" });
      expect(body.actions.onMyWay).toBe(false);
      expect(body.actions.atOrigin).toBe(true);
    });

    it("offers no 'I'm home' confirm when the assumed origin has no place (no current location, no home)", async () => {
      const state = leaveByState(8, true);
      holder.current = {
        ...state,
        settings: { ...state.settings, homeLocationId: undefined },
        currentSituation: { ...state.currentSituation, locationId: undefined, locationSetAt: undefined }
      } as unknown as PortalState;
      const body = (await (await get()).json()) as ReturnType<typeof buildDeviceSnapshot>;
      expect(body.leaveBy).toMatchObject({ assumedOrigin: true, originLabel: null });
      expect(body.actions.atOrigin).toBe(false);
    });

    it("offers neither On my way nor 'I'm home' when the leg's origin is unknown", async () => {
      const state = leaveByState(8);
      const result = state.planning!.result!;
      const [timeline] = result.derivedState!.commitmentTimelines!;
      holder.current = {
        ...state,
        settings: { ...state.settings, homeLocationId: undefined },
        currentSituation: { ...state.currentSituation, locationId: undefined, locationSetAt: undefined },
        planning: {
          ...state.planning!,
          result: {
            ...result,
            derivedState: {
              ...result.derivedState!,
              commitmentTimelines: [
                { ...timeline!, journeyBefore: { ...timeline!.journeyBefore!, fromLocationId: "" } }
              ]
            }
          }
        }
      } as unknown as PortalState;
      const body = (await (await get()).json()) as ReturnType<typeof buildDeviceSnapshot>;
      expect(body.leaveBy).toMatchObject({ assumedOrigin: false, originLabel: null });
      expect(body.actions.onMyWay).toBe(false);
      expect(body.actions.atOrigin).toBe(false);
    });

    it("clears the leg once underway matches it, and hashes leaveBy/wakeAt into stateVersion", async () => {
      const notUnderway = leaveByState(8);
      holder.current = notUnderway;
      const before = (await (await get()).json()) as ReturnType<typeof buildDeviceSnapshot>;
      expect(before.leaveBy).not.toBeNull();

      clearCachedDeviceState();
      holder.current = {
        ...notUnderway,
        currentSituation: {
          ...notUnderway.currentSituation,
          underway: {
            commitmentId: "dentist",
            occurrenceStartsAt: iso(40),
            fromLocationId: "loc-home",
            departedAt: iso(-1)
          }
        }
      };
      const after = (await (await get()).json()) as ReturnType<typeof buildDeviceSnapshot>;
      expect(after.leaveBy).toBeNull();
      expect(after.stateVersion).not.toBe(before.stateVersion);
    });

    it("has no leaveBy or wakeAt when nothing is eligible", async () => {
      holder.current = baseState({ commitments: [], sleepPlans: [] });
      const body = (await (await get()).json()) as ReturnType<typeof buildDeviceSnapshot>;
      expect(body.leaveBy).toBeNull();
      expect(body.wakeAt).toBeNull();
      expect(body.actions.onMyWay).toBe(false);
      expect(body.actions.atOrigin).toBe(false);
    });
  });
});
