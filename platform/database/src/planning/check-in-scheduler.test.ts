import { describe, expect, it } from "vitest";
import {
  cadenceFor,
  CHECK_IN_COOLDOWN_MINUTES,
  CHECK_IN_TIMEOUT_MINUTES,
  checkInCooldownUntil,
  decideCheckInTick,
  deriveBeliefSnapshot,
  isSleepWindow,
  jitteredIntervalMinutes,
  type CheckInTickInput,
  type LatestCheckInRow
} from "./check-in-scheduler.js";

const NOW = new Date("2026-09-01T10:00:00.000Z");

function minutesAgo(minutes: number): Date {
  return new Date(NOW.getTime() - minutes * 60_000);
}

function pendingRow(overrides: Partial<LatestCheckInRow> = {}): LatestCheckInRow {
  return {
    id: "row-1",
    status: "pending",
    promptedAt: null,
    createdAt: minutesAgo(1),
    answeredAt: null,
    updatedAt: minutesAgo(1),
    slotAt: minutesAgo(1),
    directiveKind: "action",
    directiveTargetId: "action-1",
    ...overrides
  };
}

const baseInput: CheckInTickInput = {
  now: NOW,
  latest: null,
  sleeping: false,
  activeCommitmentPromptPolicy: null,
  hasActiveSession: false,
  belief: { kind: "action", targetId: "action-1", title: "Write the report", phase: null, toLocationId: null },
  activeSessionStartedAt: null,
  lastSessionEndedAt: null
};

describe("deriveBeliefSnapshot", () => {
  it("maps a directable currentDirective kind straight through", () => {
    const belief = deriveBeliefSnapshot({ kind: "action", targetId: "a1", title: "Write it" }, null, null);
    expect(belief).toEqual({ kind: "action", targetId: "a1", title: "Write it", phase: null, toLocationId: null });
  });

  it("reads a travel directive's target off `then`, since travel itself has no targetId", () => {
    const belief = deriveBeliefSnapshot(
      // oxlint-disable-next-line unicorn/no-thenable -- `then` is a domain field of the travel directive, not a promise continuation
      { kind: "travel", title: "Drive to Dentist", then: { targetId: "commitment-1" } },
      null,
      null
    );
    expect(belief).toMatchObject({ kind: "travel", targetId: "commitment-1", title: "Drive to Dentist" });
  });

  it("carries a travel directive's destination through as toLocationId, so the staleness guard can tell whether it has already been reached", () => {
    const belief = deriveBeliefSnapshot(
      // oxlint-disable-next-line unicorn/no-thenable -- `then` is a domain field of the travel directive, not a promise continuation
      { kind: "travel", title: "Drive to Dentist", toLocationId: "loc-dentist", then: { targetId: "commitment-1" } },
      null,
      null
    );
    expect(belief).toMatchObject({ kind: "travel", toLocationId: "loc-dentist" });
    // Any other kind never carries one, even if the raw JSON happened to have the field.
    const other = deriveBeliefSnapshot(
      { kind: "action", targetId: "a1", title: "Write it", toLocationId: "loc-should-be-ignored" } as never,
      null,
      null
    );
    expect(other?.toLocationId).toBeNull();
  });

  it("falls back to the protected commitment when currentDirective is a held 'none'", () => {
    const belief = deriveBeliefSnapshot(
      { kind: "none", title: "Preparing for Doctor" },
      { id: "commitment-1", title: "Doctor", phase: "setup" },
      null
    );
    expect(belief).toEqual({
      kind: "protected_commitment",
      targetId: "commitment-1",
      title: "Doctor",
      phase: "setup",
      toLocationId: null
    });
  });

  it("falls back to the open anchor when nothing else claims the moment", () => {
    const belief = deriveBeliefSnapshot({ kind: "recovery", title: "Take deliberate recovery" }, null, {
      id: "commitment-2",
      title: "On duty",
      phase: "active"
    });
    expect(belief).toEqual({
      kind: "open_anchor",
      targetId: "commitment-2",
      title: "On duty",
      phase: "active",
      toLocationId: null
    });
  });

  it("is null for a boundary/answer/bare-none directive with no commitment behind it", () => {
    expect(deriveBeliefSnapshot({ kind: "answer", title: "One answer would open up work" }, null, null)).toBeNull();
    expect(deriveBeliefSnapshot({ kind: "boundary", title: "Nothing fits" }, null, null)).toBeNull();
    expect(deriveBeliefSnapshot(null, null, null)).toBeNull();
  });

  it("prefers a running session's own target over the stored currentDirective when they disagree", () => {
    const belief = deriveBeliefSnapshot(
      { kind: "action", targetId: "stored-action", title: "Stored belief" },
      null,
      null,
      { targetType: "action", targetId: "actually-running-action", targetTitle: "Actually running" }
    );
    expect(belief).toEqual({
      kind: "action",
      targetId: "actually-running-action",
      title: "Actually running",
      phase: null,
      toLocationId: null
    });
  });

  it("maps a session on a fixed_commitment to protected_commitment, overriding a disagreeing stored protectedCommitment", () => {
    const belief = deriveBeliefSnapshot(
      { kind: "none", title: "Preparing for Doctor" },
      { id: "doctor-1", title: "Doctor (stored belief)", phase: "setup" },
      null,
      { targetType: "fixed_commitment", targetId: "dentist-1", targetTitle: "Dentist (actually running)" }
    );
    expect(belief).toEqual({
      kind: "protected_commitment",
      targetId: "dentist-1",
      title: "Dentist (actually running)",
      phase: null,
      toLocationId: null
    });
  });

  it("falls back to the stored belief when the session's own target has no directable belief representation (sleep)", () => {
    const belief = deriveBeliefSnapshot({ kind: "action", targetId: "a1", title: "Write it" }, null, null, {
      targetType: "sleep",
      targetId: "plan-1",
      targetTitle: "Sleep"
    });
    expect(belief).toEqual({ kind: "action", targetId: "a1", title: "Write it", phase: null, toLocationId: null });
  });

  it("falls back to the stored belief when there is no active session at all", () => {
    const belief = deriveBeliefSnapshot({ kind: "action", targetId: "a1", title: "Write it" }, null, null, null);
    expect(belief).toEqual({ kind: "action", targetId: "a1", title: "Write it", phase: null, toLocationId: null });
  });
});

describe("isSleepWindow", () => {
  it("is true when the current directive is sleep", () => {
    expect(isSleepWindow({ kind: "sleep", title: "Time to sleep" }, null)).toBe(true);
  });
  it("is true when the active session is tracking sleep even if the directive briefly says otherwise", () => {
    expect(isSleepWindow({ kind: "none", title: "x" }, "sleep")).toBe(true);
  });
  it("is false otherwise", () => {
    expect(isSleepWindow({ kind: "action", title: "x" }, "action")).toBe(false);
    expect(isSleepWindow(null, null)).toBe(false);
  });
});

describe("cadenceFor", () => {
  it("is hourly when the commitment's policy is reduced", () => {
    expect(cadenceFor("reduced", false)).toBe("hourly");
  });
  it("is hourly whenever a session is actively tracked, regardless of policy", () => {
    expect(cadenceFor("normal", true)).toBe("hourly");
  });
  it("is the base cadence otherwise", () => {
    expect(cadenceFor("normal", false)).toBe("base");
  });
});

describe("jitteredIntervalMinutes", () => {
  it("draws the base cadence from a 15-20 minute band plus a further ±5 minute jitter", () => {
    for (const seed of ["a", "b", "c", "row-1", "row-2", "cold-start"]) {
      const minutes = jitteredIntervalMinutes("base", seed);
      expect(minutes).toBeGreaterThanOrEqual(10);
      expect(minutes).toBeLessThanOrEqual(25);
    }
  });

  it("draws the hourly cadence from around 60 minutes", () => {
    for (const seed of ["a", "b", "c"]) {
      const minutes = jitteredIntervalMinutes("hourly", seed);
      expect(minutes).toBeGreaterThanOrEqual(55);
      expect(minutes).toBeLessThanOrEqual(65);
    }
  });

  it("is deterministic for the same seed, so a resolved row's next-due instant never drifts on re-check", () => {
    expect(jitteredIntervalMinutes("base", "row-42")).toBe(jitteredIntervalMinutes("base", "row-42"));
    expect(jitteredIntervalMinutes("hourly", "row-42")).toBe(jitteredIntervalMinutes("hourly", "row-42"));
  });

  it("varies with the seed, so slots cannot be anticipated from one interval alone", () => {
    const values = new Set(["a", "b", "c", "d", "e"].map((seed) => jitteredIntervalMinutes("base", seed)));
    expect(values.size).toBeGreaterThan(1);
  });
});

describe("decideCheckInTick", () => {
  it("waits while a pending slot is still inside its timeout window", () => {
    const input: CheckInTickInput = { ...baseInput, latest: pendingRow({ createdAt: minutesAgo(5) }) };
    expect(decideCheckInTick(input)).toEqual({ action: "wait" });
  });

  it("times out a pending slot once it has aged past the timeout, counted from prompted_at when set", () => {
    const input: CheckInTickInput = {
      ...baseInput,
      latest: pendingRow({ promptedAt: minutesAgo(CHECK_IN_TIMEOUT_MINUTES + 1), createdAt: minutesAgo(20) })
    };
    expect(decideCheckInTick(input)).toEqual({ action: "timeout", rowId: "row-1" });
  });

  it("counts the timeout from created_at when the slot was never actually shown", () => {
    const input: CheckInTickInput = {
      ...baseInput,
      latest: pendingRow({ promptedAt: null, createdAt: minutesAgo(CHECK_IN_TIMEOUT_MINUTES + 1) })
    };
    expect(decideCheckInTick(input)).toEqual({ action: "timeout", rowId: "row-1" });
  });

  it("does not time out right at the boundary", () => {
    const input: CheckInTickInput = {
      ...baseInput,
      latest: pendingRow({ promptedAt: minutesAgo(CHECK_IN_TIMEOUT_MINUTES - 0.01) })
    };
    expect(decideCheckInTick(input)).toEqual({ action: "wait" });
  });

  it("creates the first-ever slot immediately when there is no history at all", () => {
    expect(decideCheckInTick({ ...baseInput, latest: null })).toEqual({ action: "create", belief: baseInput.belief });
  });

  it("waits when the resolved row has not yet reached its next jittered due instant", () => {
    const resolved: LatestCheckInRow = {
      id: "row-9",
      status: "on_track",
      promptedAt: minutesAgo(2),
      createdAt: minutesAgo(2),
      answeredAt: minutesAgo(1),
      updatedAt: minutesAgo(1),
      slotAt: minutesAgo(2),
      directiveKind: "action",
      directiveTargetId: "action-1"
    };
    // One minute since resolution is never enough to clear even the shortest jittered interval (10 min).
    expect(decideCheckInTick({ ...baseInput, latest: resolved })).toEqual({ action: "wait" });
  });

  it("creates a new slot once enough time has passed since the last resolution", () => {
    const resolved: LatestCheckInRow = {
      id: "row-9",
      status: "unknown",
      promptedAt: minutesAgo(40),
      createdAt: minutesAgo(40),
      answeredAt: null,
      updatedAt: minutesAgo(30),
      slotAt: minutesAgo(40),
      directiveKind: "action",
      directiveTargetId: "action-1"
    };
    // 30 minutes since resolution clears even the longest base-cadence draw (25 min).
    expect(decideCheckInTick({ ...baseInput, latest: resolved })).toEqual({
      action: "create",
      belief: baseInput.belief
    });
  });

  it("skips (without disturbing the schedule) when the slot is due but the sleep window gates it", () => {
    const input: CheckInTickInput = { ...baseInput, latest: null, sleeping: true };
    expect(decideCheckInTick(input)).toEqual({ action: "skip" });
  });

  it("skips when the active commitment's policy is silent", () => {
    const input: CheckInTickInput = { ...baseInput, latest: null, activeCommitmentPromptPolicy: "silent" };
    expect(decideCheckInTick(input)).toEqual({ action: "skip" });
  });

  it("skips when there is nothing meaningful to ask about", () => {
    const input: CheckInTickInput = { ...baseInput, latest: null, belief: null };
    expect(decideCheckInTick(input)).toEqual({ action: "skip" });
  });

  it("never returns a second create while one row is already pending, however due the schedule looks", () => {
    // A pending row always takes the first branch regardless of `sleeping`/policy/belief — this is what
    // "never two pending" means at the decision level; the database's own unique index backstops a race.
    const input: CheckInTickInput = {
      ...baseInput,
      latest: pendingRow({ createdAt: minutesAgo(1) }),
      sleeping: true,
      belief: null
    };
    expect(decideCheckInTick(input)).toEqual({ action: "wait" });
  });
});

describe("checkInCooldownUntil", () => {
  const baseCooldownInput = {
    now: NOW,
    activeSessionStartedAt: null,
    lastSessionEndedAt: null,
    belief: baseInput.belief,
    latestBelief: null,
    latestBeliefAt: null
  };

  it("is the epoch (no floor at all) when none of the three anchors apply", () => {
    expect(checkInCooldownUntil(baseCooldownInput)).toEqual(new Date(0));
  });

  it("floors at CHECK_IN_COOLDOWN_MINUTES after the active session started", () => {
    const startedAt = minutesAgo(2);
    const until = checkInCooldownUntil({ ...baseCooldownInput, activeSessionStartedAt: startedAt });
    expect(until).toEqual(new Date(startedAt.getTime() + CHECK_IN_COOLDOWN_MINUTES * 60_000));
  });

  it("floors at CHECK_IN_COOLDOWN_MINUTES after the last session ended", () => {
    const endedAt = minutesAgo(1);
    const until = checkInCooldownUntil({ ...baseCooldownInput, lastSessionEndedAt: endedAt });
    expect(until).toEqual(new Date(endedAt.getTime() + CHECK_IN_COOLDOWN_MINUTES * 60_000));
  });

  it("floors at CHECK_IN_COOLDOWN_MINUTES after the belief changed, only when there is a prior belief to have changed from", () => {
    const changedAt = minutesAgo(1);
    const until = checkInCooldownUntil({
      ...baseCooldownInput,
      latestBelief: { kind: "action", targetId: "action-9" },
      latestBeliefAt: changedAt
    });
    expect(until).toEqual(new Date(changedAt.getTime() + CHECK_IN_COOLDOWN_MINUTES * 60_000));
  });

  it("does not floor on belief when the belief is unchanged from the latest row's", () => {
    const until = checkInCooldownUntil({
      ...baseCooldownInput,
      latestBelief: { kind: "action", targetId: "action-1" },
      latestBeliefAt: minutesAgo(1)
    });
    expect(until).toEqual(new Date(0));
  });

  it("takes the latest (furthest-future) of several anchors that apply at once", () => {
    const until = checkInCooldownUntil({
      ...baseCooldownInput,
      activeSessionStartedAt: minutesAgo(4),
      lastSessionEndedAt: minutesAgo(1)
    });
    // Session-ended anchor: 1 min ago + 5 = 4 min from now. Session-started anchor: 4 min ago + 5 = 1
    // min from now. The later of the two wins.
    expect(until).toEqual(new Date(minutesAgo(1).getTime() + CHECK_IN_COOLDOWN_MINUTES * 60_000));
  });
});

describe("decideCheckInTick — five-minute cooldown on session start/end and belief change", () => {
  // Resolved long enough ago (40 min) that the ordinary jittered cadence alone (10-25 min) is already
  // clear, so only the cooldown itself is under test.
  function longResolvedRow(overrides: Partial<LatestCheckInRow> = {}): LatestCheckInRow {
    return {
      id: "row-9",
      status: "unknown",
      promptedAt: minutesAgo(40),
      createdAt: minutesAgo(40),
      answeredAt: null,
      updatedAt: minutesAgo(40),
      slotAt: minutesAgo(40),
      directiveKind: "action",
      directiveTargetId: "action-1",
      ...overrides
    };
  }

  it("does not sample a slot when the active session started 2 minutes ago", () => {
    const input: CheckInTickInput = { ...baseInput, latest: longResolvedRow(), activeSessionStartedAt: minutesAgo(2) };
    expect(decideCheckInTick(input)).toEqual({ action: "wait" });
  });

  it("samples a slot once the active session started 6 minutes ago", () => {
    const input: CheckInTickInput = { ...baseInput, latest: longResolvedRow(), activeSessionStartedAt: minutesAgo(6) };
    expect(decideCheckInTick(input)).toEqual({ action: "create", belief: baseInput.belief });
  });

  it("does not sample a slot when the believed directive changed 3 minutes ago", () => {
    const input: CheckInTickInput = {
      ...baseInput,
      latest: longResolvedRow({ slotAt: minutesAgo(3), directiveTargetId: "action-9" })
    };
    expect(decideCheckInTick(input)).toEqual({ action: "wait" });
  });

  it("samples a slot once the believed directive changed 6 minutes ago", () => {
    const input: CheckInTickInput = {
      ...baseInput,
      latest: longResolvedRow({ slotAt: minutesAgo(6), directiveTargetId: "action-9" })
    };
    expect(decideCheckInTick(input)).toEqual({ action: "create", belief: baseInput.belief });
  });

  it("defers the next slot when a session ended 2 minutes ago, to at least 5 minutes after it ended", () => {
    const input: CheckInTickInput = { ...baseInput, latest: longResolvedRow(), lastSessionEndedAt: minutesAgo(2) };
    expect(decideCheckInTick(input)).toEqual({ action: "wait" });
  });

  it("samples a slot once 5 minutes have passed since the session ended", () => {
    const input: CheckInTickInput = { ...baseInput, latest: longResolvedRow(), lastSessionEndedAt: minutesAgo(6) };
    expect(decideCheckInTick(input)).toEqual({ action: "create", belief: baseInput.belief });
  });

  it("resumes the jittered cadence at its own later due instant rather than firing the moment an already-passed cooldown clears", () => {
    // The resolved row is recent enough (2 min) that the ordinary jittered cadence (10-25 min out) is
    // not yet due, while a session that ended 10 minutes ago already clears its own cooldown — the
    // later of the two must still govern.
    const input: CheckInTickInput = {
      ...baseInput,
      latest: {
        id: "row-9",
        status: "unknown",
        promptedAt: minutesAgo(2),
        createdAt: minutesAgo(2),
        answeredAt: null,
        updatedAt: minutesAgo(2),
        slotAt: minutesAgo(2),
        directiveKind: "action",
        directiveTargetId: "action-1"
      },
      lastSessionEndedAt: minutesAgo(10)
    };
    expect(decideCheckInTick(input)).toEqual({ action: "wait" });
  });
});
