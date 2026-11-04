import { describe, expect, it } from "vitest";
import type { PulseJudgement } from "./pulse-judge.js";
import {
  advancePulse,
  DEFAULT_CHECK_IN_EXTRA_MINUTES,
  missingDisruptionFields,
  reentryTier,
  resolveCheckInExtraMinutes,
  resolveExpectedSilence,
  type ContactEvent,
  type Disruption,
  type ExpectedSilenceWindow,
  type PulseMachineConfig,
  type PulseEvidence,
  type PulseMachineResult
} from "./pulse-state.js";

const T0 = new Date("2026-10-28T09:00:00.000Z");
const at = (minutes: number, from: Date = T0) => new Date(from.getTime() + minutes * 60_000);

const ON: PulseJudgement = { state: "on", reason: "confirmed", confirmedAt: T0, private: false };
const UNCONFIRMED: PulseJudgement = { state: "off", reason: "unconfirmed", private: false };
const DEVIATED: PulseJudgement = { state: "off", reason: "deviated", private: false };
const UNSANCTIONED: PulseJudgement = { state: "off", reason: "unsanctioned", private: false };
const FREE: PulseJudgement = { state: "free", reason: "free", private: false };
const ASLEEP: PulseJudgement = { state: "asleep", reason: "asleep", private: false };

function evidence(overrides: Partial<PulseEvidence> = {}): PulseEvidence {
  return { contact: null, reentered: null, promptsSentAt: [], promptTimedOut: true, ...overrides };
}

const person = (minutes: number): ContactEvent => ({ at: at(minutes), source: "person" });

/** Run ticks in order; each tick is [minutes after T0, judgement, evidence?, silence?]. */
function run(
  ticks: Array<[number, PulseJudgement, Partial<PulseEvidence>?, (ExpectedSilenceWindow | null)?, PulseMachineConfig?]>,
  start: PulseMachineResult | null = null
): PulseMachineResult[] {
  const out: PulseMachineResult[] = [];
  let prev: PulseMachineResult | null = start;
  for (const [minutes, judgement, ev, silence, config] of ticks) {
    prev = advancePulse(prev, judgement, evidence(ev), silence ?? null, at(minutes), config);
    out.push(prev);
  }
  return out;
}

const last = (results: PulseMachineResult[]) => results[results.length - 1]!;

/** An `on` state confirmed at T0, ready to degrade. */
function confirmedOn(): PulseMachineResult {
  return advancePulse(null, ON, evidence({ contact: person(0) }), null, T0);
}

describe("advancePulse: base cadence", () => {
  it("one missed check-in is unknown, not off", () => {
    const [onTick, timeout] = run([
      [0, ON, { contact: person(0) }],
      [10, UNCONFIRMED]
    ]);
    expect(onTick!.state).toBe("on");
    expect(timeout!.state).toBe("unknown");
    expect(timeout!.unknownSince).toEqual(at(10));
    expect(timeout!.lastConfirmedAt).toEqual(T0);
  });

  it("two misses in a row: 30 min unknown plus a further unanswered prompt is off/lapsed", () => {
    const prompts = [at(20)];
    const results = run(
      [
        [10, UNCONFIRMED, { promptsSentAt: [at(0)] }],
        [25, UNCONFIRMED, { promptsSentAt: [at(0), ...prompts] }],
        [39, UNCONFIRMED, { promptsSentAt: [at(0), ...prompts] }],
        [40, UNCONFIRMED, { promptsSentAt: [at(0), ...prompts] }]
      ],
      confirmedOn()
    );
    expect(results.map((r) => r.state)).toEqual(["unknown", "unknown", "unknown", "off"]);
    expect(last(results).offReason).toBe("lapsed");
    expect(last(results).enteredLapsed).toBe(true);
  });

  it("30 minutes unknown without a further prompt is not yet off", () => {
    const results = run(
      [
        [10, UNCONFIRMED],
        [45, UNCONFIRMED],
        [69, UNCONFIRMED]
      ],
      confirmedOn()
    );
    expect(results.map((r) => r.state)).toEqual(["unknown", "unknown", "unknown"]);
  });

  it("60 minutes unknown goes off/lapsed with no further prompt", () => {
    const results = run(
      [
        [10, UNCONFIRMED],
        [69, UNCONFIRMED],
        [70, UNCONFIRMED]
      ],
      confirmedOn()
    );
    expect(results.map((r) => r.state)).toEqual(["unknown", "unknown", "off"]);
    expect(last(results).offReason).toBe("lapsed");
  });

  it("enteredLapsed is true on the transition only, never repeated", () => {
    const results = run(
      [
        [10, UNCONFIRMED],
        [70, UNCONFIRMED],
        [80, UNCONFIRMED]
      ],
      confirmedOn()
    );
    expect(results.map((r) => r.enteredLapsed)).toEqual([false, true, false]);
  });

  it("a confirming answer while unknown returns to on and clears the clock", () => {
    const results = run(
      [
        [10, UNCONFIRMED],
        [20, { ...ON, confirmedAt: at(20) }, { contact: person(20) }]
      ],
      confirmedOn()
    );
    const resolved = last(results);
    expect(resolved.state).toBe("on");
    expect(resolved.onReason).toBe("confirmed");
    expect(resolved.unknownSince).toBeNull();
    expect(resolved.unknownMinutes).toBe(0);
    expect(resolved.lastConfirmedAt).toEqual(at(20));
  });
});

describe("advancePulse: hourly cadence", () => {
  it("caps unknown at 60 minutes when no further prompt goes out", () => {
    const results = run(
      [
        [60, UNCONFIRMED, { promptsSentAt: [at(0)] }],
        [100, UNCONFIRMED, { promptsSentAt: [at(0)] }],
        [119, UNCONFIRMED, { promptsSentAt: [at(0)] }],
        [120, UNCONFIRMED, { promptsSentAt: [at(0)] }]
      ],
      confirmedOn()
    );
    expect(results.map((r) => r.state)).toEqual(["unknown", "unknown", "unknown", "off"]);
  });

  it("counts only prompts sent after the unknown began", () => {
    const results = run(
      [
        [10, UNCONFIRMED, { promptsSentAt: [at(0)] }],
        [45, UNCONFIRMED, { promptsSentAt: [at(0)] }]
      ],
      confirmedOn()
    );
    expect(last(results).state).toBe("unknown");
  });
});

const DISRUPTION: Disruption = {
  doing: "Dentist emergency",
  until: at(120),
  locationId: "loc-dentist",
  contexts: ["phone"],
  exclusive: true
};

describe("advancePulse: disruptions", () => {
  it("a deviated answer with a complete disruption stays on, reason disrupted, no lapse", () => {
    const [result] = run([[5, DEVIATED, { contact: person(5), disruption: DISRUPTION }]], confirmedOn());
    expect(result!.state).toBe("on");
    expect(result!.onReason).toBe("disrupted");
    expect(result!.disruption?.doing).toBe("Dentist emergency");
    expect(result!.enteredLapsed).toBe(false);
    expect(result!.lastConfirmedAt).toEqual(T0);
  });

  it("a bare deviated answer goes straight to off/lapsed", () => {
    const [result] = run([[5, DEVIATED, { contact: person(5) }]], confirmedOn());
    expect(result!.state).toBe("off");
    expect(result!.offReason).toBe("lapsed");
    expect(result!.enteredLapsed).toBe(true);
  });

  it.each(["doing", "until", "locationId", "contexts", "exclusive"] as const)(
    "a disruption missing %s is off/lapsed",
    (field) => {
      const partial: Disruption = { ...DISRUPTION, [field]: null };
      expect(missingDisruptionFields(partial)).toEqual([field]);
      const [result] = run([[5, DEVIATED, { disruption: partial }]], confirmedOn());
      expect(result!.state).toBe("off");
      expect(result!.offReason).toBe("lapsed");
    }
  );

  it("names every missing field, and treats empty contexts and blank text as missing", () => {
    expect(missingDisruptionFields(null)).toEqual(["doing", "until", "locationId", "contexts", "exclusive"]);
    expect(missingDisruptionFields({ ...DISRUPTION, contexts: [], doing: " " })).toEqual(["doing", "contexts"]);
    expect(missingDisruptionFields({ ...DISRUPTION, exclusive: false })).toEqual([]);
  });

  it("an unsanctioned session with no detail, from unknown, is off/lapsed; with detail it is on/disrupted", () => {
    const bare = run(
      [
        [10, UNCONFIRMED],
        [15, UNSANCTIONED]
      ],
      confirmedOn()
    );
    expect(last(bare).offReason).toBe("lapsed");
    const detailed = run(
      [
        [10, UNCONFIRMED],
        [15, UNSANCTIONED, { disruption: DISRUPTION }]
      ],
      confirmedOn()
    );
    expect(last(detailed).onReason).toBe("disrupted");
    expect(last(detailed).unknownSince).toBeNull();
  });

  it("the unknown that follows a disruption's until carries on while the same deviation stands, then lapses", () => {
    const results = run(
      [
        [5, DEVIATED, { contact: person(5), disruption: DISRUPTION }],
        [121, DEVIATED, { disruption: DISRUPTION }],
        [130, DEVIATED, { disruption: DISRUPTION }],
        [185, DEVIATED, { disruption: DISRUPTION }]
      ],
      confirmedOn()
    );
    expect(results.map((r) => r.state)).toEqual(["on", "unknown", "unknown", "off"]);
    expect(results[2]!.unknownSince).toEqual(at(120));
  });

  describe("overran session", () => {
    const overran: PulseJudgement = { state: "off", reason: "overran", private: false };
    const fresh = { promptTimedOut: false };

    it("one minute past sanction holds on, with no disruption needed", () => {
      const [result] = run([[1, overran, fresh]], confirmedOn());
      expect(result!.state).toBe("on");
      expect(result!.onReason).toBe("confirmed");
      expect(result!.lastConfirmedAt).toEqual(T0);
    });

    it("holds on across many ticks while the session is not stale", () => {
      const results = run(
        [
          [30, overran, fresh],
          [90, overran, fresh]
        ],
        confirmedOn()
      );
      expect(results.map((r) => r.state)).toEqual(["on", "on"]);
    });

    it("past its freshness limit becomes unknown, then lapses by the normal thresholds", () => {
      const stale = { ...fresh, sessionStale: true };
      const results = run(
        [
          [100, overran, stale],
          [129, overran, { ...stale, promptsSentAt: [at(110)] }],
          [130, overran, { ...stale, promptsSentAt: [at(110)] }]
        ],
        confirmedOn()
      );
      expect(results.map((r) => r.state)).toEqual(["unknown", "unknown", "off"]);
      expect(last(results).offReason).toBe("lapsed");
    });

    it("an unknown caused by a stale session lapses at the hard limit with no further prompt", () => {
      const stale = { ...fresh, sessionStale: true };
      const results = run(
        [
          [100, overran, stale],
          [160, overran, stale]
        ],
        confirmedOn()
      );
      expect(last(results).state).toBe("off");
    });
  });

  it("holds through later judge ticks until its until, then the confirmation has lapsed (unknown)", () => {
    const results = run(
      [
        [5, DEVIATED, { disruption: DISRUPTION }],
        [60, UNCONFIRMED],
        [119, DEVIATED],
        [130, UNCONFIRMED]
      ],
      confirmedOn()
    );
    expect(results.map((r) => r.state)).toEqual(["on", "on", "on", "unknown"]);
    expect(last(results).unknownSince).toEqual(at(120));
  });

  it("a disruption already past its until is not usable", () => {
    const stale: Disruption = { ...DISRUPTION, until: at(1) };
    expect(run([[5, DEVIATED, { disruption: stale }]], confirmedOn())[0]!.offReason).toBe("lapsed");
  });

  it("an expired disruption's unknown clock excludes silence minutes", () => {
    const shift: ExpectedSilenceWindow = { startsAt: at(130), endsAt: at(290), kind: "shift" };
    const results = run(
      [
        [5, DEVIATED, { disruption: DISRUPTION }],
        [300, UNCONFIRMED, { promptTimedOut: true }, shift]
      ],
      confirmedOn()
    );
    // 180 minutes since until(120), 160 of them inside the shift.
    expect(last(results).state).toBe("unknown");
    expect(last(results).unknownMinutes).toBeCloseTo(20, 5);
  });

  it("returns to on/confirmed when the judge confirms again", () => {
    const results = run(
      [
        [5, DEVIATED, { disruption: DISRUPTION }],
        [15, { ...ON, confirmedAt: at(15) }, { contact: person(15) }]
      ],
      confirmedOn()
    );
    expect(last(results).onReason).toBe("confirmed");
    expect(last(results).disruption).toBeNull();
  });
});

describe("advancePulse: thresholds and per-commitment allowance", () => {
  const prompts = [at(0), at(20)];

  it("uses the thresholds it is given", () => {
    const config = { thresholds: { unknownToOffMinutes: 10, furtherPrompts: 2, unknownHardOffMinutes: 20 } };
    const results = run(
      [
        [10, UNCONFIRMED, { promptsSentAt: [at(0), at(12), at(15)] }, null, config],
        [20, UNCONFIRMED, { promptsSentAt: [at(0), at(12), at(15)] }, null, config],
        [31, UNCONFIRMED, {}, null, config]
      ],
      confirmedOn()
    );
    expect(results.map((r) => r.state)).toEqual(["unknown", "off", "off"]);
  });

  it("two further prompts are required when furtherPrompts is 2", () => {
    const config = { thresholds: { furtherPrompts: 2 } };
    const results = run(
      [
        [10, UNCONFIRMED, { promptsSentAt: prompts }, null, config],
        [41, UNCONFIRMED, { promptsSentAt: prompts }, null, config]
      ],
      confirmedOn()
    );
    expect(last(results).state).toBe("unknown");
  });

  it("the default +15 lengthens 30 to 45 and 60 to 75", () => {
    const config = { extraMinutes: DEFAULT_CHECK_IN_EXTRA_MINUTES };
    const early = run(
      [
        [10, UNCONFIRMED, { promptsSentAt: prompts }, null, config],
        [54, UNCONFIRMED, { promptsSentAt: prompts }, null, config]
      ],
      confirmedOn()
    );
    expect(last(early).state).toBe("unknown");
    const lapsed = run([[55, UNCONFIRMED, { promptsSentAt: prompts }, null, config]], last(early));
    expect(lapsed[0]!.state).toBe("off");
    const hard = run(
      [
        [10, UNCONFIRMED, {}, null, config],
        [84, UNCONFIRMED, {}, null, config],
        [85, UNCONFIRMED, {}, null, config]
      ],
      confirmedOn()
    );
    expect(hard.map((r) => r.state)).toEqual(["unknown", "unknown", "off"]);
  });

  it("a custom allowance is used as given", () => {
    expect(resolveCheckInExtraMinutes({ checkInExtraMinutes: 40 })).toBe(40);
    expect(resolveCheckInExtraMinutes({ checkInExtraMinutes: 0 })).toBe(0);
    const config = { extraMinutes: 40 };
    const results = run(
      [
        [10, UNCONFIRMED, {}, null, config],
        [109, UNCONFIRMED, {}, null, config],
        [110, UNCONFIRMED, {}, null, config]
      ],
      confirmedOn()
    );
    expect(results.map((r) => r.state)).toEqual(["unknown", "unknown", "off"]);
  });

  it("resolves the allowance: default when unset, 0 with no commitment in force", () => {
    expect(resolveCheckInExtraMinutes({})).toBe(15);
    expect(resolveCheckInExtraMinutes({ checkInExtraMinutes: null })).toBe(15);
    expect(resolveCheckInExtraMinutes(null)).toBe(0);
  });
});

describe("advancePulse: off/lapsed", () => {
  function lapsed(): PulseMachineResult {
    return last(
      run(
        [
          [10, UNCONFIRMED],
          [70, UNCONFIRMED]
        ],
        confirmedOn()
      )
    );
  }

  it("is not healed by the judge saying on, nor by a bare contact", () => {
    const state = lapsed();
    expect(state.state).toBe("off");
    const results = run([[100, { ...ON, confirmedAt: at(100) }, { contact: person(100) }]], state);
    expect(last(results).state).toBe("off");
    expect(last(results).offReason).toBe("lapsed");
    expect(last(results).lastConfirmedAt).toEqual(T0);
  });

  it("is not healed by a deviated judgement, even with a complete disruption", () => {
    const disruption = { ...DISRUPTION, until: at(300) };
    const result = last(run([[100, DEVIATED, { contact: person(100), disruption }]], lapsed()));
    expect(result.state).toBe("off");
    expect(result.offReason).toBe("lapsed");
  });

  it("is healed by an explicit re-entry, which sets lastConfirmedAt", () => {
    const results = run([[100, ON, { reentered: person(100) }]], lapsed());
    const healed = last(results);
    expect(healed.state).toBe("on");
    expect(healed.onReason).toBe("reentered");
    expect(healed.lastConfirmedAt).toEqual(at(100));
    expect(healed.enteredLapsed).toBe(false);
  });

  it("a re-entry by an agent is recorded as confirmed by the agent", () => {
    const healed = last(run([[100, ON, { reentered: { at: at(100), source: "agent" } }]], lapsed()));
    expect(healed.confirmedBy).toBe("agent");
  });

  it("is not healed by a work shift that follows it", () => {
    const shift: ExpectedSilenceWindow = { startsAt: at(120), endsAt: at(120 + 480), kind: "shift" };
    const results = run(
      [
        [130, UNCONFIRMED, {}, shift],
        [300, UNCONFIRMED, {}, shift],
        [700, UNCONFIRMED, {}, shift]
      ],
      lapsed()
    );
    expect(results.map((r) => [r.state, r.offReason])).toEqual([
      ["off", "lapsed"],
      ["off", "lapsed"],
      ["off", "lapsed"]
    ]);
  });
});

describe("advancePulse: work shift (silent commitment)", () => {
  const shift: ExpectedSilenceWindow = { startsAt: at(60), endsAt: at(60 + 480), kind: "shift" };

  it("holds on/scheduled for the whole 8 h shift with no degradation and no lastConfirmedAt movement", () => {
    const results = run(
      [
        [60, UNCONFIRMED, {}, shift],
        [180, UNCONFIRMED, {}, shift],
        [300, UNCONFIRMED, {}, shift],
        [539, UNCONFIRMED, {}, shift]
      ],
      confirmedOn()
    );
    for (const r of results) {
      expect(r.state).toBe("on");
      expect(r.onReason).toBe("scheduled");
      expect(r.lastConfirmedAt).toEqual(T0);
      expect(r.silenceUntil).toEqual(shift.endsAt);
    }
  });

  it("holds through the grace after the shift, then is a hard off/lapsed with no unknown phase", () => {
    const results = run(
      [
        [300, UNCONFIRMED, {}, shift],
        [540 + 30, UNCONFIRMED, {}, shift],
        [540 + 59, UNCONFIRMED, {}, shift],
        [540 + 61, UNCONFIRMED, {}, shift]
      ],
      confirmedOn()
    );
    expect(results.map((r) => r.state)).toEqual(["on", "on", "on", "off"]);
    expect(results[1]!.silenceUntil).toBeNull();
    expect(last(results).offReason).toBe("lapsed");
    expect(last(results).enteredLapsed).toBe(true);
    expect(results.some((r) => r.state === "unknown")).toBe(false);
  });

  it("a shift extended in the system (a longer window) keeps holding", () => {
    const extended: ExpectedSilenceWindow = { ...shift, endsAt: at(540 + 120) };
    const results = run(
      [
        [300, UNCONFIRMED, {}, shift],
        [540 + 61, UNCONFIRMED, { contact: person(540 + 30) }, extended]
      ],
      confirmedOn()
    );
    expect(last(results).onReason).toBe("scheduled");
  });

  it("a contact after the shift satisfies the grace: no hard lapse, the usual unknown path follows", () => {
    const results = run(
      [
        [300, UNCONFIRMED, {}, shift],
        [540 + 20, UNCONFIRMED, { contact: person(540 + 20) }, shift],
        [540 + 61, UNCONFIRMED, {}, shift]
      ],
      confirmedOn()
    );
    expect(results.map((r) => r.state)).toEqual(["on", "on", "unknown"]);
  });

  it("a contact during the shift does not satisfy the post-shift grace", () => {
    const results = run(
      [
        [200, UNCONFIRMED, { contact: person(200) }, shift],
        [540 + 61, UNCONFIRMED, {}, shift]
      ],
      confirmedOn()
    );
    expect(last(results).offReason).toBe("lapsed");
  });

  it("an answer after the shift is on/confirmed and lastConfirmedAt moves", () => {
    const results = run(
      [
        [300, UNCONFIRMED, {}, shift],
        [540 + 10, { ...ON, confirmedAt: at(550) }, { contact: person(550) }, shift]
      ],
      confirmedOn()
    );
    expect(last(results).onReason).toBe("confirmed");
    expect(last(results).lastConfirmedAt).toEqual(at(550));
  });

  it("an unknown that runs into a shift freezes rather than lapsing, then resumes", () => {
    const overlapShift: ExpectedSilenceWindow = { startsAt: at(20), endsAt: at(20 + 480), kind: "shift" };
    const results = run(
      [
        [10, UNCONFIRMED],
        [300, UNCONFIRMED, {}, overlapShift],
        [500 + 10, UNCONFIRMED, {}, overlapShift]
      ],
      confirmedOn()
    );
    expect(results.map((r) => r.state)).toEqual(["unknown", "unknown", "unknown"]);
    // 10 minutes before the shift started, 10 after it ended; the 480 in between do not count.
    expect(last(results).unknownMinutes).toBeCloseTo(20, 5);
  });

  it("a bare deviated answer inside a shift is off/lapsed; with a disruption it is on/disrupted", () => {
    const bare = run([[100, DEVIATED, { contact: person(100) }, shift]], confirmedOn());
    expect(bare[0]!.offReason).toBe("lapsed");
    const detailed = run(
      [[100, DEVIATED, { contact: person(100), disruption: { ...DISRUPTION, until: at(200) } }, shift]],
      confirmedOn()
    );
    expect(detailed[0]!.onReason).toBe("disrupted");
  });

  it("voluntary contact inside the shift counts as contact and does not unfreeze the clocks", () => {
    const results = run(
      [
        [100, UNCONFIRMED, {}, shift],
        [200, { ...ON, confirmedAt: at(200) }, { contact: person(200) }, shift],
        [300, UNCONFIRMED, {}, shift]
      ],
      confirmedOn()
    );
    expect(results[1]!.lastContact?.at).toEqual(at(200));
    expect(results[1]!.lastConfirmedAt).toEqual(at(200));
    expect(last(results).state).toBe("on");
    expect(last(results).onReason).toBe("scheduled");
    expect(last(results).lastConfirmedAt).toEqual(at(200));
  });

  it("contact is never required: a whole shift with none stays on/scheduled", () => {
    expect(run([[500, UNCONFIRMED, {}, shift]], confirmedOn())[0]!.onReason).toBe("scheduled");
  });
});

describe("advancePulse: sleep", () => {
  const night: ExpectedSilenceWindow = { startsAt: at(-60), endsAt: at(420), kind: "sleep" };

  it("stays asleep inside the night and clears any unknown", () => {
    const results = run(
      [
        [0, UNCONFIRMED],
        [30, ASLEEP, {}, night]
      ],
      confirmedOn()
    );
    expect(last(results).state).toBe("asleep");
    expect(last(results).unknownSince).toBeNull();
  });

  it("stays asleep through the 60 minute grace after planned wake", () => {
    const [result] = run([[420 + 59, ASLEEP, {}, night]], null);
    expect(result!.state).toBe("asleep");
  });

  it("no post-window lapse applies while the judge says asleep, however long after planned wake", () => {
    const [result] = run([[420 + 600, ASLEEP, {}, night]], null);
    expect(result!.state).toBe("asleep");
  });

  it("early bed: a prior-night window ended hours ago is not a lapse", () => {
    const priorNight = { startsAt: at(-60 - 1440), endsAt: at(420 - 1440), kind: "sleep" as const };
    // The resolver no longer returns it, and even if a caller passed it the machine does not lapse.
    const resolved = resolveExpectedSilence({
      commitments: [],
      sleepNight: priorNight,
      now: at(900)
    });
    expect(resolved).toBeNull();
    const [viaResolver] = run([[900, ASLEEP, {}, resolved]], confirmedOn());
    expect(viaResolver!.state).toBe("asleep");
    const [viaStale] = run([[900, ASLEEP, {}, priorNight]], confirmedOn());
    expect(viaStale!.state).toBe("asleep");
    expect(viaStale!.offReason).toBeNull();
  });

  it("an ended window beyond the lookback is not returned; one within grace still is", () => {
    const shift = { startsAt: at(0), endsAt: at(480), promptPolicy: "silent" };
    expect(resolveExpectedSilence({ commitments: [shift], sleepNight: null, now: at(480 + 61) })?.kind).toBe("shift");
    expect(resolveExpectedSilence({ commitments: [shift], sleepNight: null, now: at(480 + 300) })).toBeNull();
    expect(
      resolveExpectedSilence({ commitments: [shift], sleepNight: null, now: at(480 + 140), extraMinutes: 15 })
    ).toBeNull();
  });

  it("a wake (judge no longer asleep) leaves asleep without going unknown", () => {
    const [result] = run([[420 + 90, { ...ON, confirmedAt: at(510) }, { contact: person(510) }, night]], null);
    expect(result!.state).toBe("on");
  });

  it("free and asleep are untouched by silence windows", () => {
    expect(run([[10, FREE]], confirmedOn())[0]!.state).toBe("free");
  });
});

describe("advancePulse: agent-sourced contact", () => {
  it("records an agent confirmation as confirmed by the agent", () => {
    const [result] = run(
      [[15, { ...ON, confirmedAt: at(15) }, { contact: { at: at(15), source: "agent" } }]],
      confirmedOn()
    );
    expect(result!.state).toBe("on");
    expect(result!.confirmedBy).toBe("agent");
    expect(result!.lastConfirmedAt).toEqual(at(15));
  });

  it("a schedule-sourced contact is never recorded as a person or agent confirmation", () => {
    const [result] = run([[15, ON, { contact: { at: at(15), source: "schedule" } }]], confirmedOn());
    expect(result!.confirmedBy).toBe("person");
    expect(result!.lastContact?.source).toBe("schedule");
  });

  it("does not move lastConfirmedAt backwards", () => {
    const start = confirmedOn();
    const [result] = run([[15, { ...ON, confirmedAt: at(-30) }]], start);
    expect(result!.lastConfirmedAt).toEqual(T0);
  });
});

describe("resolveExpectedSilence", () => {
  const shift = { startsAt: at(60), endsAt: at(540), promptPolicy: "silent" };

  it("returns the silent commitment window containing now", () => {
    expect(resolveExpectedSilence({ commitments: [shift], sleepNight: null, now: at(100) })).toEqual({
      startsAt: shift.startsAt,
      endsAt: shift.endsAt,
      kind: "shift"
    });
  });

  it("ignores reduced, normal and unset prompt policies", () => {
    const commitments = [
      { ...shift, promptPolicy: "reduced" },
      { ...shift, promptPolicy: "normal" },
      { ...shift, promptPolicy: undefined }
    ];
    expect(resolveExpectedSilence({ commitments, sleepNight: null, now: at(100) })).toBeNull();
  });

  it("returns the most recent ended window when none contains now", () => {
    const older = { startsAt: at(-600), endsAt: at(-300), promptPolicy: "silent" };
    const result = resolveExpectedSilence({ commitments: [older, shift], sleepNight: null, now: at(600) });
    expect(result?.endsAt).toEqual(shift.endsAt);
  });

  it("never returns a window that has not started", () => {
    expect(resolveExpectedSilence({ commitments: [shift], sleepNight: null, now: at(10) })).toBeNull();
  });

  it("treats the end instant as outside the window", () => {
    const result = resolveExpectedSilence({ commitments: [shift], sleepNight: null, now: at(540) });
    expect(result?.endsAt).toEqual(shift.endsAt);
    const state = advancePulse(null, UNCONFIRMED, evidence(), result, at(540));
    expect(state.silenceUntil).toBeNull();
  });

  it("includes the sleep night", () => {
    const result = resolveExpectedSilence({
      commitments: [],
      sleepNight: { startsAt: at(-120), endsAt: at(420) },
      now: at(0)
    });
    expect(result?.kind).toBe("sleep");
  });

  it("prefers the containing window ending last when several overlap", () => {
    const result = resolveExpectedSilence({
      commitments: [shift],
      sleepNight: { startsAt: at(0), endsAt: at(900) },
      now: at(100)
    });
    expect(result?.kind).toBe("sleep");
  });
});

describe("advancePulse: no confirmation yet is not a missed one", () => {
  const quiet = { promptTimedOut: false };

  it("holds on/reentered on the next tick after a re-entry", () => {
    const lapsedState = last(
      run(
        [
          [10, UNCONFIRMED],
          [70, UNCONFIRMED]
        ],
        confirmedOn()
      )
    );
    const results = run(
      [
        [100, ON, { reentered: person(100) }],
        [101, UNCONFIRMED, quiet],
        [115, UNCONFIRMED, quiet]
      ],
      lapsedState
    );
    expect(results.map((r) => [r.state, r.onReason])).toEqual([
      ["on", "reentered"],
      ["on", "reentered"],
      ["on", "reentered"]
    ]);
    expect(results[1]!.lastConfirmedAt).toEqual(at(100));
  });

  it("a freshly started block with no prompt yet holds on", () => {
    const [result] = run([[200, UNCONFIRMED, { ...quiet, blockStartedAt: at(199) }]], confirmedOn());
    expect(result!.state).toBe("on");
  });

  it("a first tick with a fresh block start is on, not unknown", () => {
    const [result] = run([[5, UNCONFIRMED, { ...quiet, blockStartedAt: at(0) }]], null);
    expect(result!.state).toBe("on");
  });

  it("a missed prompt still starts unknown, even with fresh contact", () => {
    const [result] = run([[10, UNCONFIRMED, { promptTimedOut: true }]], confirmedOn());
    expect(result!.state).toBe("unknown");
  });

  it("a stale session starts unknown", () => {
    const [result] = run([[10, UNCONFIRMED, { ...quiet, sessionStale: true }]], confirmedOn());
    expect(result!.state).toBe("unknown");
  });

  it("base cadence: held until 30 minutes since contact, unknown from then on", () => {
    const results = run(
      [
        [29, UNCONFIRMED, quiet],
        [30, UNCONFIRMED, quiet]
      ],
      confirmedOn()
    );
    expect(results.map((r) => r.state)).toEqual(["on", "unknown"]);
  });

  it("hourly cadence: held until 70 minutes since contact", () => {
    const hourly = { ...quiet, cadenceMinutes: 60 };
    const results = run(
      [
        [69, UNCONFIRMED, hourly],
        [70, UNCONFIRMED, hourly]
      ],
      confirmedOn()
    );
    expect(results.map((r) => r.state)).toEqual(["on", "unknown"]);
  });

  it("the commitment allowance lengthens the window", () => {
    const results = run([[44, UNCONFIRMED, quiet, null, { extraMinutes: 15 }]], confirmedOn());
    expect(results[0]!.state).toBe("on");
  });

  it("schedule-sourced contact does not keep it fresh", () => {
    const [result] = run([[5, UNCONFIRMED, { ...quiet, contact: { at: at(4), source: "schedule" } }]], null);
    expect(result!.state).toBe("unknown");
  });
});

describe("reentryTier", () => {
  it.each([
    [0, "none"],
    [119, "none"],
    [120, "today"],
    [36 * 60 - 1, "today"],
    [36 * 60, "days"],
    [7 * 24 * 60 - 1, "days"],
    [7 * 24 * 60, "projects"],
    [30 * 24 * 60, "projects"]
  ])("a gap of %i minutes is %s", (gap, tier) => {
    expect(reentryTier(gap)).toBe(tier);
  });
});

describe("advancePulse: a complete disruption over an unconfirmed judgement", () => {
  const complete: Disruption = {
    doing: "Hospital visit",
    until: at(120),
    locationId: "hospital",
    contexts: ["phone"],
    exclusive: true
  };

  it("holds on/disrupted from unknown, from a missed prompt, from a stale session and from nothing running", () => {
    const fromUnknown = run(
      [
        [0, UNCONFIRMED, { promptTimedOut: true }],
        [5, UNCONFIRMED, { disruption: complete }]
      ],
      confirmedOn()
    );
    expect(fromUnknown[0]!.state).toBe("unknown");
    expect(last(fromUnknown).state).toBe("on");
    expect(last(fromUnknown).onReason).toBe("disrupted");
    expect(last(fromUnknown).disruption?.doing).toBe("Hospital visit");
    expect(last(fromUnknown).unknownSince).toBeNull();

    const stale = run(
      [[5, UNCONFIRMED, { promptTimedOut: false, sessionStale: true, disruption: complete }]],
      confirmedOn()
    );
    expect(last(stale).onReason).toBe("disrupted");

    // A user with no history at all and nothing running: recording what he is doing is the confirmation.
    const fresh = run([[5, UNCONFIRMED, { promptTimedOut: false, disruption: complete }]], null);
    expect(last(fresh).state).toBe("on");
    expect(last(fresh).onReason).toBe("disrupted");
  });

  it("holds through an expected-silence window too", () => {
    const shift: ExpectedSilenceWindow = { startsAt: at(-10), endsAt: at(60), kind: "shift" };
    const [result] = run([[5, UNCONFIRMED, { disruption: complete }, shift]], confirmedOn());
    expect(result!.onReason).toBe("disrupted");
  });

  it("goes unknown from its until, then lapses by the usual rules", () => {
    const results = run(
      [
        [5, UNCONFIRMED, { disruption: complete }],
        [100, UNCONFIRMED, { disruption: complete }],
        [121, UNCONFIRMED, { disruption: complete }],
        [160, UNCONFIRMED, { disruption: complete }],
        [185, UNCONFIRMED, { disruption: complete }]
      ],
      confirmedOn()
    );
    expect(results.map((r) => r.state)).toEqual(["on", "on", "unknown", "unknown", "off"]);
    expect(results[2]!.unknownSince).toEqual(at(120));
    expect(last(results).offReason).toBe("lapsed");
  });

  it.each([
    ["until already past", { ...complete, until: at(-1) }],
    ["a field missing", { ...complete, locationId: null }],
    ["no contexts", { ...complete, contexts: [] }],
    ["exclusive not given", { ...complete, exclusive: null }]
  ])("does nothing with %s: the unknown path runs as before", (_name, partial) => {
    const [result] = run([[10, UNCONFIRMED, { disruption: partial as Disruption }]], confirmedOn());
    expect(result!.state).toBe("unknown");
  });

  it("never overrides asleep or free", () => {
    expect(run([[5, ASLEEP, { disruption: complete }]], confirmedOn())[0]!.state).toBe("asleep");
    expect(run([[5, FREE, { disruption: complete }]], confirmedOn())[0]!.state).toBe("free");
  });

  it("does not heal off/lapsed: only re-entry does", () => {
    const lapsed = run(
      [
        [10, UNCONFIRMED],
        [75, UNCONFIRMED]
      ],
      confirmedOn()
    );
    expect(last(lapsed).offReason).toBe("lapsed");
    const [stillLapsed] = run([[110, UNCONFIRMED, { disruption: complete }]], last(lapsed));
    expect(stillLapsed!.state).toBe("off");
    expect(stillLapsed!.offReason).toBe("lapsed");
    const [back] = run([[111, UNCONFIRMED, { disruption: complete, reentered: person(111) }]], last(lapsed));
    expect(back!.onReason).toBe("reentered");
  });
});
