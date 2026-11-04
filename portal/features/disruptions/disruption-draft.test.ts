import { describe, expect, it } from "vitest";
import { defaultPlanningSettings, type StoredSleepPlan } from "@/state/portal-state";
import {
  disruptionEntityFrom,
  disruptionIsLiveNow,
  disruptionRemainingMinutes,
  emptyDisruptionDraft,
  pessimisticEndAt,
  validateDisruptionDraft,
  type DisruptionContext,
  type DisruptionDraft
} from "./disruption-draft";

// 14:00 in Australia/Sydney, which is on standard time all August, so no offset moves under the test.
const NOW = new Date("2026-08-30T04:00:00.000Z");

const contextOf = (overrides: Partial<DisruptionContext> = {}): DisruptionContext => ({
  sleepPlans: [],
  settings: defaultPlanningSettings(),
  timezone: "Australia/Sydney",
  now: NOW,
  ...overrides
});

const draftOf = (overrides: Partial<DisruptionDraft> = {}): DisruptionDraft => ({
  ...emptyDisruptionDraft(contextOf()),
  title: "Driving Mum to the shops",
  ...overrides
});

const sleepPlan = (plannedStartAt: string, status: StoredSleepPlan["status"] = "planned") =>
  [{ id: `sleep-${plannedStartAt}`, plannedStartAt, status }] as unknown as StoredSleepPlan[];

const entity = (draft: DisruptionDraft, context = contextOf()) => disruptionEntityFrom(draft, "id", context);

describe("emptyDisruptionDraft", () => {
  it("defaults everything but the name, and opens the retro time at the current wall clock", () => {
    expect(emptyDisruptionDraft(contextOf())).toEqual({
      title: "",
      source: "other",
      when: "now",
      earlierTime: "14:00",
      duration: "1h",
      locationId: "",
      location: "",
      contactId: ""
    });
  });

  it("seeds the contact from a preset, when one is given", () => {
    expect(emptyDisruptionDraft(contextOf())).toMatchObject({ contactId: "" });
    expect(emptyDisruptionDraft(contextOf(), { contactId: "sam" })).toMatchObject({ contactId: "sam" });
  });
});

describe("disruptionEntityFrom", () => {
  it("writes a confirmed commitment with disruption provenance and no buffers", () => {
    expect(entity(draftOf({ source: "family" }))).toMatchObject({
      id: "id",
      title: "Driving Mum to the shops",
      status: "confirmed",
      origin: "disruption",
      disruptionSource: "family",
      disruptionOpenEnded: false,
      landedAt: NOW.toISOString(),
      setupBeforeMinutes: 0,
      transitionAfterMinutes: 0,
      presence: "blocking"
    });
  });

  it("starts the block where the When bucket says", () => {
    expect(entity(draftOf({ when: "now" })).startsAt).toBe("2026-08-30T04:00:00.000Z");
    expect(entity(draftOf({ when: "in_15" })).startsAt).toBe("2026-08-30T04:15:00.000Z");
    expect(entity(draftOf({ when: "in_30" })).startsAt).toBe("2026-08-30T04:30:00.000Z");
    expect(entity(draftOf({ when: "in_60" })).startsAt).toBe("2026-08-30T05:00:00.000Z");
  });

  it("ends it a bucket later", () => {
    expect(entity(draftOf({ duration: "30m" })).endsAt).toBe("2026-08-30T04:30:00.000Z");
    expect(entity(draftOf({ duration: "1h" })).endsAt).toBe("2026-08-30T05:00:00.000Z");
    expect(entity(draftOf({ duration: "2h" })).endsAt).toBe("2026-08-30T06:00:00.000Z");
    expect(entity(draftOf({ duration: "3h" })).endsAt).toBe("2026-08-30T07:00:00.000Z");
    // The bucket is measured from the start, not from now.
    expect(entity(draftOf({ when: "in_60", duration: "2h" })).endsAt).toBe("2026-08-30T07:00:00.000Z");
  });

  it("guesses Rest of day and No idea out to the bedtime the sleep plan already holds", () => {
    const context = contextOf({ sleepPlans: sleepPlan("2026-08-30T11:30:00.000Z") });
    expect(entity(draftOf({ duration: "rest_of_day" }), context).endsAt).toBe("2026-08-30T11:30:00.000Z");
    expect(entity(draftOf({ duration: "unknown" }), context).endsAt).toBe("2026-08-30T11:30:00.000Z");
  });

  it("falls back to the preferred bedtime on the local day when no plan reaches past the start", () => {
    // 22:00 in the seed zone. The plan already behind the disruption says nothing about when tonight ends.
    const context = contextOf({ sleepPlans: sleepPlan("2026-08-29T12:00:00.000Z") });
    expect(entity(draftOf({ duration: "unknown" }), context).endsAt).toBe("2026-08-30T12:00:00.000Z");
    expect(entity(draftOf({ duration: "unknown" })).endsAt).toBe("2026-08-30T12:00:00.000Z");
  });

  it("keeps a guessed end after the start when the day is already past bedtime", () => {
    const context = contextOf({ now: new Date("2026-08-30T13:20:00.000Z") });
    expect(entity(draftOf({ duration: "rest_of_day" }), context).endsAt).toBe("2026-08-30T13:21:00.000Z");
  });

  it("marks only a live No idea open-ended, because that is the one that might still be running", () => {
    expect(entity(draftOf({ duration: "unknown" })).disruptionOpenEnded).toBe(true);
    expect(entity(draftOf({ duration: "rest_of_day" })).disruptionOpenEnded).toBe(false);
    expect(entity(draftOf({ when: "earlier", earlierTime: "11:30", duration: "unknown" })).disruptionOpenEnded).toBe(
      false
    );
  });

  it("logs an earlier one in the past, an hour long when its length is forgotten, landing now", () => {
    const logged = entity(draftOf({ when: "earlier", earlierTime: "11:30", duration: "unknown" }));
    expect(logged.startsAt).toBe("2026-08-30T01:30:00.000Z");
    expect(logged.endsAt).toBe("2026-08-30T02:30:00.000Z");
    expect(logged.landedAt).toBe(NOW.toISOString());
  });

  it("takes a remembered length for an earlier one over the hour it guesses", () => {
    const logged = entity(draftOf({ when: "earlier", earlierTime: "11:30", duration: "2h" }));
    expect(logged.endsAt).toBe("2026-08-30T03:30:00.000Z");
  });

  it("omits the place when none was chosen and sends both halves when one was", () => {
    expect(entity(draftOf())).not.toHaveProperty("locationId");
    expect(entity(draftOf({ locationId: "shops", location: "Harbor Mart, Riverside" }))).toMatchObject({
      locationId: "shops",
      location: "Harbor Mart, Riverside"
    });
  });

  it("omits the contact when none was chosen and sends it when one was", () => {
    expect(entity(draftOf())).not.toHaveProperty("contactId");
    expect(entity(draftOf({ contactId: "sam" }))).toMatchObject({ contactId: "sam" });
  });
});

describe("disruptionIsLiveNow", () => {
  it("is live when the window has started and not yet ended", () => {
    expect(disruptionIsLiveNow(draftOf({ when: "now", duration: "1h" }), contextOf())).toBe(true);
  });

  it("is not live before the window starts", () => {
    expect(disruptionIsLiveNow(draftOf({ when: "in_60", duration: "1h" }), contextOf())).toBe(false);
  });

  it("is not live once a retro-logged window has already ended", () => {
    expect(disruptionIsLiveNow(draftOf({ when: "earlier", earlierTime: "02:00", duration: "1h" }), contextOf())).toBe(
      false
    );
  });

  it("is live for a retro-logged window still running", () => {
    expect(disruptionIsLiveNow(draftOf({ when: "earlier", earlierTime: "13:50", duration: "1h" }), contextOf())).toBe(
      true
    );
  });

  it("is live for an open-ended guess that has not yet reached its pessimistic end", () => {
    expect(disruptionIsLiveNow(draftOf({ when: "now", duration: "unknown" }), contextOf())).toBe(true);
  });
});

describe("disruptionRemainingMinutes", () => {
  it("reads the whole window when it has just started", () => {
    expect(disruptionRemainingMinutes(draftOf({ when: "now", duration: "1h" }), contextOf())).toBe(60);
  });

  it("reads what is left, not the window's full length", () => {
    // Started at 13:00 local, an hour long (ends 14:00 = NOW's 04:00 UTC); 15 minutes left at 13:45.
    const draft = draftOf({ when: "earlier", earlierTime: "13:00", duration: "1h" });
    const context = contextOf({ now: new Date("2026-08-30T03:45:00.000Z") });
    expect(disruptionRemainingMinutes(draft, context)).toBe(15);
  });

  it("clamps to at least one minute once the window has run out", () => {
    const draft = draftOf({ when: "earlier", earlierTime: "13:00", duration: "1h" });
    const context = contextOf({ now: new Date("2026-08-30T04:30:00.000Z") });
    expect(disruptionRemainingMinutes(draft, context)).toBe(1);
  });
});

describe("pessimisticEndAt", () => {
  it("ignores a sleep plan that has been cancelled or already slept", () => {
    const context = contextOf({ sleepPlans: sleepPlan("2026-08-30T11:30:00.000Z", "cancelled") });
    expect(pessimisticEndAt(NOW, context).toISOString()).toBe("2026-08-30T12:00:00.000Z");
  });
});

describe("validateDisruptionDraft", () => {
  it("only ever asks for the name", () => {
    expect(validateDisruptionDraft(draftOf(), contextOf())).toBe("");
    expect(validateDisruptionDraft(draftOf({ title: "  " }), contextOf())).toBe("A disruption needs a name.");
  });

  it("wants the time an earlier one started, and refuses one that has not come round yet", () => {
    expect(validateDisruptionDraft(draftOf({ when: "earlier", earlierTime: "" }), contextOf())).toBe(
      "Say what time it started."
    );
    expect(validateDisruptionDraft(draftOf({ when: "earlier", earlierTime: "16:00" }), contextOf())).toBe(
      "That time has not come round yet. Use Now or one of the +minute buckets."
    );
    expect(validateDisruptionDraft(draftOf({ when: "earlier", earlierTime: "11:30" }), contextOf())).toBe("");
  });
});
