import { InvalidCommandError } from "@/server/persistence/postgres/command-errors";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSeedState, type PortalState } from "@/state/portal-state";
import { fitDeviceText } from "@/server/device/device-now";

/**
 * The state store is replaced with plain mocks per method — what's under test is which method the
 * route calls, with what command, not the store's own behaviour. The check-in read is stubbed the
 * same way the GET route's test stubs it, so no test here needs a database.
 */
const store = vi.hoisted(() => ({
  get: vi.fn(),
  runActivityCommand: vi.fn(),
  runSessionCommand: vi.fn(),
  saveEntity: vi.fn(),
  runCheckInCommand: vi.fn(),
  hasCommandReceipt: vi.fn()
}));
vi.mock("@/server/persistence/state-store", () => ({ getStateStore: () => store }));

vi.mock("@/server/runtime-env", () => ({ databaseUrl: () => undefined }));
vi.mock("@/server/persistence/postgres/sql-pool", () => ({ sqlPool: () => ({}) }));
vi.mock("@/server/persistence/postgres/ensure-user", () => ({ ensureUser: async () => "user-1" }));
vi.mock("@/server/persistence/postgres/readers/check-in-read", () => ({ readCurrentCheckIn: async () => null }));

/** Spied rather than left real: what's under test is that a successful action invalidates the poll
 * cache, not the cache module's own behaviour (covered in `now/route.test.ts`). */
const deviceStateCache = vi.hoisted(() => ({ clearCachedDeviceState: vi.fn() }));
vi.mock("@/server/device/device-state-cache", () => deviceStateCache);

const { POST } = await import("./route");

const NOW = new Date("2026-09-02T10:00:00.000Z");
const iso = (offsetMinutes: number) => new Date(NOW.getTime() + offsetMinutes * 60_000).toISOString();

function baseState(overrides: Record<string, unknown> = {}): PortalState {
  return { ...createSeedState(NOW), ...overrides } as unknown as PortalState;
}

const post = (body: unknown) =>
  POST(
    new Request("http://portal.test/api/device/action", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    }),
    {}
  );

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  store.get.mockReset();
  store.runActivityCommand.mockReset();
  store.runSessionCommand.mockReset();
  store.saveEntity.mockReset();
  store.runCheckInCommand.mockReset();
  store.hasCommandReceipt.mockReset();
  store.runActivityCommand.mockResolvedValue(baseState({ commitments: [] }));
  store.runSessionCommand.mockResolvedValue(baseState({ commitments: [] }));
  store.saveEntity.mockResolvedValue(baseState({ commitments: [] }));
  store.runCheckInCommand.mockResolvedValue(baseState({ commitments: [] }));
  store.hasCommandReceipt.mockResolvedValue(false);
  deviceStateCache.clearCachedDeviceState.mockReset();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
});

const PROMPT_ID = "0b1d6a52-3c0e-4a47-9c1f-6d1f2a7b9e10";

describe("POST /api/device/action", () => {
  it("starts the active protected commitment when one is holding the clock", async () => {
    store.get.mockResolvedValue(
      baseState({
        commitments: [
          {
            id: "meeting",
            title: "Client meeting",
            startsAt: iso(-5),
            endsAt: iso(30),
            status: "confirmed",
            setupBeforeMinutes: 0,
            transitionAfterMinutes: 0,
            version: 3
          }
        ],
        planning: {
          status: "current",
          result: {
            currentDirective: { kind: "none", title: "Nothing else fits", recommendedMinutes: 0 },
            recommendation: {
              primary: null,
              protectedCommitment: {
                id: "meeting",
                title: "Client meeting",
                phase: "active",
                startsAt: iso(-5),
                endsAt: iso(30),
                protectedStartAt: iso(-5),
                protectedEndAt: iso(30),
                phaseStartsAt: iso(-5),
                phaseEndsAt: iso(30)
              }
            }
          }
        }
      })
    );

    const response = await post({ type: "start" });
    expect(response.status).toBe(200);
    expect(store.runActivityCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        commandId: expect.any(String),
        expectedVersion: 3,
        type: "start_activity",
        targetType: "fixed_commitment",
        targetId: "meeting",
        plannedMinutes: 30,
        phase: "active"
      })
    );
    expect(store.runSessionCommand).not.toHaveBeenCalled();
  });

  it("starts the engine's primary recommendation as an ordinary session when nothing is protected", async () => {
    store.get.mockResolvedValue(
      baseState({
        commitments: [],
        currentRecommendationId: "11111111-1111-4111-8111-111111111111",
        planning: {
          status: "current",
          result: {
            currentDirective: { kind: "none", title: "Nothing else fits", recommendedMinutes: 0 },
            recommendation: {
              primary: { action: { id: "room-floor", title: "Sort the bedroom floor" }, recommendedMinutes: 45 }
            }
          }
        }
      })
    );

    const response = await post({ type: "start" });
    expect(response.status).toBe(200);
    expect(store.runSessionCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        commandId: expect.any(String),
        expectedVersion: null,
        type: "start",
        actionId: "room-floor",
        plannedMinutes: 45,
        recommendationId: "11111111-1111-4111-8111-111111111111"
      })
    );
    expect(store.runActivityCommand).not.toHaveBeenCalled();
  });

  it("refuses to start when nothing is startable", async () => {
    store.get.mockResolvedValue(baseState({ commitments: [], sleepPlans: [] }));
    const response = await post({ type: "start" });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "Nothing to start right now." });
    expect(store.runActivityCommand).not.toHaveBeenCalled();
    expect(store.runSessionCommand).not.toHaveBeenCalled();
    expect(deviceStateCache.clearCachedDeviceState).not.toHaveBeenCalled();
  });

  it("shows the pending prep step instead of the commitment when it is running late", async () => {
    // Mirrors now-model.ts's `routineStepsRunDespiteCommitment`: a `late` commitment
    // still occupies `protectedCommitment`, but its own overdue before-phase step is what should be
    // offered, not "start the commitment itself".
    store.get.mockResolvedValue(
      baseState({
        commitments: [
          {
            id: "dinner",
            title: "Dinner and reset",
            startsAt: iso(-10),
            endsAt: iso(60),
            status: "confirmed",
            setupBeforeMinutes: 0,
            transitionAfterMinutes: 0,
            version: 5
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
            status: "pending",
            version: 2
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
      })
    );

    const response = await post({ type: "start" });
    expect(response.status).toBe(200);
    expect(store.runActivityCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedVersion: 2,
        type: "start_activity",
        targetType: "routine_step",
        targetId: "step-uniform",
        plannedMinutes: 10
      })
    );
    expect(store.runSessionCommand).not.toHaveBeenCalled();
  });

  it("refuses to start a late commitment whose window has already elapsed rather than opening a 1-minute session", async () => {
    // Report: `Math.max(1, …)` on an already-past `phaseEndsAt` used to hand the device a technically
    // valid but meaningless 1-minute commitment session.
    store.get.mockResolvedValue(
      baseState({
        commitments: [
          {
            id: "meeting",
            title: "Client meeting",
            startsAt: iso(-90),
            endsAt: iso(-5),
            status: "confirmed",
            setupBeforeMinutes: 0,
            transitionAfterMinutes: 0,
            version: 3
          }
        ],
        planning: {
          status: "current",
          result: {
            currentDirective: { kind: "none", title: "Nothing else fits", recommendedMinutes: 0 },
            recommendation: {
              primary: null,
              protectedCommitment: {
                id: "meeting",
                title: "Client meeting",
                phase: "setup",
                late: true,
                startsAt: iso(-90),
                endsAt: iso(-5),
                protectedStartAt: iso(-90),
                protectedEndAt: iso(-5),
                phaseStartsAt: iso(-90),
                phaseEndsAt: iso(-5)
              }
            }
          }
        }
      })
    );

    const response = await post({ type: "start" });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "The commitment window has passed." });
    expect(store.runActivityCommand).not.toHaveBeenCalled();
    expect(store.runSessionCommand).not.toHaveBeenCalled();
    expect(deviceStateCache.clearCachedDeviceState).not.toHaveBeenCalled();
  });

  it("clears the poll state cache after a successful start", async () => {
    store.get.mockResolvedValue(
      baseState({
        commitments: [],
        currentRecommendationId: "11111111-1111-4111-8111-111111111111",
        planning: {
          status: "current",
          result: {
            currentDirective: { kind: "none", title: "Nothing else fits", recommendedMinutes: 0 },
            recommendation: {
              primary: { action: { id: "room-floor", title: "Sort the bedroom floor" }, recommendedMinutes: 45 }
            }
          }
        }
      })
    );
    const response = await post({ type: "start" });
    expect(response.status).toBe(200);
    expect(deviceStateCache.clearCachedDeviceState).toHaveBeenCalledTimes(1);
  });

  it("finishes a plain action session with 'finish', honouring the requested outcome", async () => {
    store.get.mockResolvedValue(
      baseState({
        commitments: [],
        activeSession: {
          id: "session-1",
          actionId: "networking-section-one",
          status: "running",
          startedAt: iso(-5),
          plannedEndAt: iso(20),
          plannedMinutes: 25,
          remainingBeforeMinutes: 90,
          activeElapsedSeconds: 300,
          version: 2
        }
      })
    );

    const response = await post({ type: "stop", outcome: "completed" });
    expect(response.status).toBe(200);
    expect(store.runSessionCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        commandId: expect.any(String),
        expectedVersion: 2,
        type: "finish",
        sessionId: "session-1",
        outcome: "completed"
      })
    );
    expect(store.runActivityCommand).not.toHaveBeenCalled();
  });

  it("finishes a fixed-commitment session with 'finish_activity', defaulting to 'stopped'", async () => {
    store.get.mockResolvedValue(
      baseState({
        commitments: [],
        activeSession: {
          id: "session-1",
          actionId: "meeting",
          targetType: "fixed_commitment",
          targetId: "meeting",
          status: "running",
          startedAt: iso(-5),
          plannedEndAt: iso(20),
          plannedMinutes: 25,
          remainingBeforeMinutes: 0,
          activeElapsedSeconds: 300,
          version: 4
        }
      })
    );

    const response = await post({ type: "stop" });
    expect(response.status).toBe(200);
    expect(store.runActivityCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        commandId: expect.any(String),
        expectedVersion: 4,
        type: "finish_activity",
        sessionId: "session-1",
        outcome: "stopped"
      })
    );
    expect(store.runSessionCommand).not.toHaveBeenCalled();
  });

  it("refuses to stop when nothing is being tracked", async () => {
    store.get.mockResolvedValue(baseState({ commitments: [], activeSession: null }));
    const response = await post({ type: "stop" });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "Nothing is being tracked." });
    expect(store.runSessionCommand).not.toHaveBeenCalled();
    expect(store.runActivityCommand).not.toHaveBeenCalled();
  });

  it("builds the same save_entity shape as the browser's arrival button", async () => {
    const seedSettings = createSeedState(NOW).settings;
    store.get.mockResolvedValue(
      baseState({
        commitments: [
          {
            id: "meeting",
            title: "Client meeting",
            startsAt: iso(-5),
            endsAt: iso(30),
            status: "confirmed",
            setupBeforeMinutes: 0,
            transitionAfterMinutes: 0,
            locationId: "loc-campus"
          }
        ],
        conditionDefinitions: [{ id: "loc-campus", name: "Campus" }],
        currentSituation: { locationId: null, overrides: {}, carrying: {}, transportModes: ["car"], travel: {} },
        currentEnergy: "medium",
        assertedConditions: ["home", "laptop"],
        settings: { ...seedSettings, version: 7 },
        planning: {
          status: "current",
          result: {
            currentDirective: { kind: "none", title: "Nothing else fits", recommendedMinutes: 0 },
            recommendation: {
              primary: null,
              protectedCommitment: {
                id: "meeting",
                title: "Client meeting",
                phase: "active",
                startsAt: iso(-5),
                endsAt: iso(30),
                protectedStartAt: iso(-5),
                protectedEndAt: iso(30),
                phaseStartsAt: iso(-5),
                phaseEndsAt: iso(30)
              }
            }
          }
        }
      })
    );

    const response = await post({ type: "arrived" });
    expect(response.status).toBe(200);
    expect(store.saveEntity).toHaveBeenCalledWith(
      expect.objectContaining({
        commandId: expect.any(String),
        expectedVersion: 7,
        type: "save_entity",
        entityType: "current_availability",
        entity: {
          currentEnergy: "medium",
          assertedConditions: ["home", "laptop"],
          currentSituation: { locationId: "loc-campus" }
        }
      })
    );
  });

  it("refuses to record an arrival when none is pending", async () => {
    store.get.mockResolvedValue(baseState({ commitments: [] }));
    const response = await post({ type: "arrived" });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "No arrival is pending." });
    expect(store.saveEntity).not.toHaveBeenCalled();
  });

  describe("on_my_way / at_origin", () => {
    function leaveByState(originAssumed: boolean): PortalState {
      const seedSettings = createSeedState(NOW).settings;
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
        settings: { ...seedSettings, version: 9, leaveByLeadMinutes: 10 },
        currentSituation: {
          locationId: "loc-home",
          locationSetAt: iso(-30),
          overrides: {},
          carrying: {},
          transportModes: ["car"],
          travel: {}
        },
        currentEnergy: "medium",
        assertedConditions: [],
        planning: {
          status: "current",
          result: {
            derivedState: {
              commitmentTimelines: [
                {
                  id: "dentist",
                  startsAt: iso(40),
                  leaveBy: iso(8),
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

    it("records underway with the leave-by leg's own origin when the origin is confirmed", async () => {
      store.get.mockResolvedValue(leaveByState(false));
      const response = await post({ type: "on_my_way" });
      expect(response.status).toBe(200);
      expect(store.saveEntity).toHaveBeenCalledWith(
        expect.objectContaining({
          expectedVersion: 9,
          type: "save_entity",
          entityType: "current_availability",
          entity: expect.objectContaining({
            currentSituation: {
              underway: expect.objectContaining({
                commitmentId: "dentist",
                occurrenceStartsAt: iso(40),
                fromLocationId: "loc-home"
              })
            }
          })
        })
      );
    });

    it("refuses on_my_way when the origin is still assumed", async () => {
      store.get.mockResolvedValue(leaveByState(true));
      const response = await post({ type: "on_my_way" });
      expect(response.status).toBe(409);
      expect(store.saveEntity).not.toHaveBeenCalled();
    });

    it("refuses on_my_way when there is no leave-by leg to confirm", async () => {
      store.get.mockResolvedValue(baseState({ commitments: [] }));
      const response = await post({ type: "on_my_way" });
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: "No leave-by leg to confirm." });
      expect(store.saveEntity).not.toHaveBeenCalled();
    });

    it("asserts the resolved place on at_origin, never one the device names", async () => {
      store.get.mockResolvedValue(leaveByState(true));
      const response = await post({ type: "at_origin" });
      expect(response.status).toBe(200);
      expect(store.saveEntity).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "save_entity",
          entityType: "current_availability",
          entity: expect.objectContaining({ currentSituation: { locationId: "loc-home" } })
        })
      );
    });

    it("refuses at_origin when the origin is already confirmed", async () => {
      store.get.mockResolvedValue(leaveByState(false));
      const response = await post({ type: "at_origin" });
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: "No assumed origin to confirm." });
      expect(store.saveEntity).not.toHaveBeenCalled();
    });
  });

  it.each([
    ["yes", "on_track"],
    ["no", "deviated"],
    ["unsure", "unknown"]
  ] as const)("maps a %s check-in answer to status %s", async (answer, status) => {
    store.get.mockResolvedValue(baseState({ commitments: [] }));
    const response = await post({ type: "check_in", promptId: PROMPT_ID, answer });
    expect(response.status).toBe(200);
    expect(store.runCheckInCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        commandId: expect.any(String),
        expectedVersion: null,
        type: "answer_check_in",
        checkInId: PROMPT_ID,
        status,
        answerSource: "in_app_banner"
      })
    );
  });

  it("refuses a promptId that is not a uuid with 400 before touching the store", async () => {
    const response = await post({ type: "check_in", promptId: "prompt-1", answer: "yes" });
    expect(response.status).toBe(400);
    expect(store.get).not.toHaveBeenCalled();
  });

  it("answers 409, not 400, for a check-in that has timed out or been answered", async () => {
    store.get.mockResolvedValue(baseState({ commitments: [] }));
    store.runCheckInCommand.mockRejectedValue(new InvalidCommandError("This check-in has already been answered."));
    const response = await post({ type: "check_in", promptId: PROMPT_ID, answer: "yes" });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "This check-in has already been answered." });
  });

  it("refuses a body that does not match any known action", async () => {
    const response = await post({ type: "unknown" });
    expect(response.status).toBe(400);
    expect(store.get).not.toHaveBeenCalled();
  });

  describe("client-minted commandId", () => {
    // A canonical uuid string passes `stableUuid`'s fold unchanged (report: client-minted commandId on
    // the device action route), so asserting on it directly proves the device's own id reached the
    // command rather than a fresh server-minted one — without this test needing to know the private
    // namespace `resolveDeviceCommandId` folds a non-uuid client id through.
    const CLIENT_COMMAND_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

    it("honours a client-supplied commandId on the command it issues", async () => {
      store.get.mockResolvedValue(
        baseState({
          commitments: [],
          activeSession: {
            id: "session-1",
            actionId: "networking-section-one",
            status: "running",
            startedAt: iso(-5),
            plannedEndAt: iso(20),
            plannedMinutes: 25,
            remainingBeforeMinutes: 90,
            activeElapsedSeconds: 300,
            version: 2
          }
        })
      );

      const response = await post({ type: "stop", outcome: "completed", commandId: CLIENT_COMMAND_ID });
      expect(response.status).toBe(200);
      expect(store.runSessionCommand).toHaveBeenCalledWith(
        expect.objectContaining({ commandId: CLIENT_COMMAND_ID, type: "finish" })
      );
    });

    it("replays a retried commandId as a fresh 200 instead of re-evaluating state preconditions", async () => {
      // Mirrors the real failure this fixes: by the time of the retry, `activeSession` is already gone
      // (the first POST's write landed), so the route's own "nothing is being tracked" precondition
      // would otherwise refuse the retry with a 409 even though the exact same command already
      // succeeded.
      store.get.mockResolvedValue(baseState({ commitments: [], activeSession: null }));
      store.hasCommandReceipt.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

      const body = { type: "stop" as const, outcome: "completed" as const, commandId: CLIENT_COMMAND_ID };
      // The first POST 409s here (nothing tracked in this mock's fixed state, proving the precondition
      // still holds normally) — what matters is the second, replayed POST: it must not repeat that
      // refusal even though nothing about the mocked state changed between the two calls.
      const first = await post(body);
      expect(first.status).toBe(409);
      const replay = await post(body);
      expect(replay.status).toBe(200);
      expect(store.runSessionCommand).not.toHaveBeenCalled();
      expect(store.runActivityCommand).not.toHaveBeenCalled();
    });

    it.each(["short7", "has a space here", "bad$char!", "x".repeat(65)])(
      "rejects an invalid commandId (%s) with 400",
      async (commandId) => {
        const response = await post({ type: "check_in", promptId: PROMPT_ID, answer: "yes", commandId });
        expect(response.status).toBe(400);
        expect(store.get).not.toHaveBeenCalled();
      }
    );
  });

  describe("fitDeviceText", () => {
    it("keeps a surrogate-pair emoji intact when it falls at the truncation boundary", () => {
      // 6 A's + one emoji (1 code point, 2 UTF-16 units) + 4 B's: a unit-based cut at 7 units lands
      // inside the emoji's surrogate pair, producing a lone surrogate. A code-point-based cut at 7
      // code points includes the whole emoji.
      const text = "AAAAAA\u{1F600}BBBB";
      const result = fitDeviceText(text, 10);
      expect(result).toBe("AAAAAA\u{1F600}...");
      // No lone surrogate: re-spreading the string by code point round-trips it exactly.
      expect(Array.from(result).join("")).toBe(result);
    });
  });

  it("excludes a tentative commitment from `next`, matching the Now page's confirmed-only test", async () => {
    store.get.mockResolvedValue(
      baseState({
        commitments: [
          {
            id: "maybe-dinner",
            title: "Maybe dinner with the Ross family",
            startsAt: iso(120),
            endsAt: iso(180),
            status: "tentative",
            setupBeforeMinutes: 0,
            transitionAfterMinutes: 0
          }
        ]
      })
    );
    const response = await post({ type: "check_in", promptId: PROMPT_ID, answer: "yes" });
    expect(response.status).toBe(200);
    expect((await response.json()).next).toBeNull();
  });
});
