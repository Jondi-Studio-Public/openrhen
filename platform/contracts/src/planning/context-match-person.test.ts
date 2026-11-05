import { describe, expect, it } from "vitest";
import { conditionDefinitionSchema, currentSituationSchema, type ConditionDefinition } from "./context-model.js";
import { evaluateConditions, resolveSituation, type CommitmentWindow } from "./context-match.js";

const NOW = new Date("2026-08-11T02:00:00.000Z");
const define = (input: Record<string, unknown>): ConditionDefinition => conditionDefinitionSchema.parse(input);

const base = [
  define({ id: "garage", name: "Garage", kind: "location", grants: ["workbench"] }),
  define({ id: "campus", name: "Campus", kind: "location" }),
  define({ id: "workbench", name: "Workbench", kind: "capability" }),
  define({ id: "pete", name: "Pete", kind: "contact", channels: ["sync_remote"] }),
  define({ id: "pete-both", name: "Petra", kind: "contact", channels: ["in_person", "async"] }),
  define({ id: "sam", name: "Sam", kind: "contact", channels: ["in_person"] }),
  define({ id: "nobody", name: "Nobody", kind: "contact" }),
  define({ id: "mia", name: "Mia", kind: "contact", channels: ["sync_remote"] }),
  define({ id: "gone", name: "Gone", kind: "contact", channels: ["sync_remote"], status: "archived" })
];

const inGarage = { locationId: "garage", locationSetAt: "2026-08-11T01:30:00.000Z" } as const;

function resolver(
  situation: Record<string, unknown> = {},
  commitments: CommitmentWindow[] = [],
  extra: { timeZone?: string; now?: Date } = {}
) {
  return resolveSituation({
    situation: currentSituationSchema.parse(situation),
    definitions: base,
    now: extra.now ?? NOW,
    commitments,
    ...(extra.timeZone ? { timeZone: extra.timeZone } : {})
  });
}

const liveMeeting = (over: Partial<CommitmentWindow> = {}): CommitmentWindow => ({
  id: "c1",
  startsAt: "2026-08-11T01:00:00.000Z",
  endsAt: "2026-08-11T03:00:00.000Z",
  status: "confirmed",
  contactId: "pete",
  attendance: "in_person",
  title: "Hive day",
  ...over
});

const presence = (state: "here" | "away", setAt: string, until: string) => ({ pete: { state, setAt, until } });

describe("bare ids keep today's exact meaning", () => {
  it("resolves a bare contact exactly as before, whatever presence says", () => {
    const plain = resolver({});
    expect(plain.resolve("pete")).toBe("yes");
    expect(plain.resolve("sam")).toBe("unknown");
    expect(plain.resolve("nobody")).toBe("unknown");
    expect(plain.resolve("gone")).toBe("no");
    const withPresence = resolver({
      presence: presence("away", "2026-08-11T01:00:00.000Z", "2026-08-12T00:00:00.000Z")
    });
    expect(withPresence.resolve("pete")).toBe("yes");
    expect(resolver(inGarage).resolve("sam")).toBe("no");
    expect(resolver({ ...inGarage, overrides: { sam: "available" } }).resolve("sam")).toBe("yes");
  });

  it("reads old situations that have no presence at all", () => {
    expect(currentSituationSchema.parse({}).presence).toBeUndefined();
    expect(resolver({}).resolve("garage")).toBe("unknown");
  });
});

describe("pete@remote is today's reachable behaviour", () => {
  it.each([
    ["a remote channel", "pete@remote", "yes"],
    ["a mixed in-person and async contact", "pete-both@remote", "yes"],
    ["only an in-person channel", "sam@remote", "no"],
    ["no channel recorded", "nobody@remote", "unknown"],
    ["an archived contact", "gone@remote", "no"],
    ["an undefined contact", "ghost@remote", "no"]
  ])("%s: %s is %s", (_name, key, truth) => {
    expect(resolver(inGarage).resolve(key)).toBe(truth);
  });

  it("honours an unavailable override on the contact", () => {
    expect(resolver({ overrides: { pete: "unavailable" } }).resolve("pete@remote")).toBe("no");
  });

  it("ignores presence entirely", () => {
    const away = resolver({ presence: presence("away", "2026-08-11T01:00:00.000Z", "2026-08-12T00:00:00.000Z") });
    expect(away.resolve("pete@remote")).toBe("yes");
  });
});

describe("pete@with needs presence", () => {
  const live = presence("here", "2026-08-11T01:00:00.000Z", "2026-08-12T00:00:00.000Z");

  it("is unknown by default, even for a contact with a remote channel", () => {
    expect(resolver(inGarage).resolve("pete@with")).toBe("unknown");
    expect(resolver({}).resolve("pete@with")).toBe("unknown");
    expect(resolver(inGarage).resolve("nobody@with")).toBe("unknown");
    expect(resolver(inGarage).resolve("sam@with")).toBe("unknown");
  });

  it("is yes while the owner has said they are here", () => {
    expect(resolver({ presence: live }).resolve("pete@with")).toBe("yes");
    expect(resolver({ ...inGarage, presence: live }).resolve("sam@with")).toBe("unknown");
  });

  it("is no when the owner said they are away", () => {
    const away = presence("away", "2026-08-11T01:00:00.000Z", "2026-08-12T00:00:00.000Z");
    expect(resolver({ presence: away }).resolve("pete@with")).toBe("no");
  });

  it("is not satisfied by an override on the bare id", () => {
    expect(resolver({ overrides: { pete: "available" } }).resolve("pete@with")).toBe("unknown");
  });

  it("is still yes after the owner changes location, unlike an override", () => {
    const moved = resolver({ ...inGarage, presence: live });
    expect(moved.resolve("pete@with")).toBe("yes");
  });

  it("fails closed for archived, undefined and non-contact ids", () => {
    expect(resolver({}).resolve("gone@with")).toBe("no");
    expect(resolver({}).resolve("ghost@with")).toBe("no");
    expect(resolver({}).resolve("garage@with")).toBe("no");
  });

  it("reports where the verdict came from", () => {
    expect(resolver({ presence: live }).sourceOf?.("pete@with")).toEqual({ kind: "present", truth: "yes" });
    expect(resolver({}).sourceOf?.("pete@with")).toEqual({ kind: "presence-unknown", truth: "unknown" });
  });
});

describe("a live commitment with the contact", () => {
  it("makes pete@with yes while it runs", () => {
    expect(resolver({}, [liveMeeting()]).resolve("pete@with")).toBe("yes");
  });

  it("does not before it starts or after it ends", () => {
    expect(
      resolver({}, [liveMeeting({ startsAt: "2026-08-11T02:30:00.000Z", endsAt: "2026-08-11T04:00:00.000Z" })]).resolve(
        "pete@with"
      )
    ).toBe("unknown");
    expect(
      resolver({}, [liveMeeting({ startsAt: "2026-08-11T00:00:00.000Z", endsAt: "2026-08-11T02:00:00.000Z" })]).resolve(
        "pete@with"
      )
    ).toBe("unknown");
  });

  it("does not count a cancelled, tentative or status-less one", () => {
    for (const status of ["cancelled", "tentative", undefined]) {
      expect(resolver({}, [liveMeeting({ status })]).resolve("pete@with")).toBe("unknown");
    }
  });

  it("does not count a call (remote attendance), but a missing attendance means in person", () => {
    expect(resolver({}, [liveMeeting({ attendance: "remote" })]).resolve("pete@with")).toBe("unknown");
    expect(resolver({}, [liveMeeting({ attendance: undefined })]).resolve("pete@with")).toBe("yes");
  });

  it("does not count a commitment with someone else or with no contact", () => {
    expect(resolver({}, [liveMeeting({ contactId: "mia" })]).resolve("pete@with")).toBe("unknown");
    expect(resolver({}, [liveMeeting({ contactId: undefined })]).resolve("pete@with")).toBe("unknown");
  });

  it("is the same after the commitment moves out of the current moment", () => {
    const moved = liveMeeting({ startsAt: "2026-08-12T01:00:00.000Z", endsAt: "2026-08-12T03:00:00.000Z" });
    expect(resolver({}, [moved]).resolve("pete@with")).toBe("unknown");
  });

  it("is overruled by a known away", () => {
    const away = presence("away", "2026-08-11T01:00:00.000Z", "2026-08-12T00:00:00.000Z");
    expect(resolver({ presence: away }, [liveMeeting()]).resolve("pete@with")).toBe("no");
  });

  it("does not make pete@remote anything it was not", () => {
    expect(resolver({}, [liveMeeting()]).resolve("pete@remote")).toBe("yes");
    expect(resolver({}, [liveMeeting()]).resolve("sam@remote")).toBe("no");
  });
});

describe("expiry at the owner's local midnight", () => {
  const sayHere = (setAt: string, until: string) => ({ presence: presence("here", setAt, until) });

  it("expires to unknown, never carrying yes", () => {
    const s = sayHere("2026-08-11T01:00:00.000Z", "2026-08-11T12:00:00.000Z");
    expect(resolver(s, [], { now: new Date("2026-08-11T11:59:59.000Z") }).resolve("pete@with")).toBe("yes");
    expect(resolver(s, [], { now: new Date("2026-08-11T12:00:00.000Z") }).resolve("pete@with")).toBe("unknown");
    expect(resolver(s, [], { now: new Date("2026-08-14T12:00:00.000Z") }).resolve("pete@with")).toBe("unknown");
  });

  it("an expired away is unknown too, not no", () => {
    const s = { presence: presence("away", "2026-08-11T01:00:00.000Z", "2026-08-11T12:00:00.000Z") };
    expect(resolver(s, [], { now: new Date("2026-08-11T13:00:00.000Z") }).resolve("pete@with")).toBe("unknown");
  });

  it("ends at the local midnight of the day it was said even if until is later (timezone change)", () => {
    // Said at 22:00 Auckland time (UTC+12), recorded with an until a whole day on, as if made in UTC.
    const s = sayHere("2026-08-11T10:00:00.000Z", "2026-08-12T00:00:00.000Z");
    // Auckland midnight after 22:00 on 11 Aug is 2026-08-11T12:00Z.
    expect(
      resolver(s, [], { timeZone: "Pacific/Auckland", now: new Date("2026-08-11T11:00:00.000Z") }).resolve("pete@with")
    ).toBe("yes");
    expect(
      resolver(s, [], { timeZone: "Pacific/Auckland", now: new Date("2026-08-11T12:30:00.000Z") }).resolve("pete@with")
    ).toBe("unknown");
    // In UTC the same record is good until its own until.
    expect(resolver(s, [], { now: new Date("2026-08-11T12:30:00.000Z") }).resolve("pete@with")).toBe("yes");
  });

  it("handles a spring-forward day (23 hours long)", () => {
    // 2026-03-08 US DST starts; local midnight to midnight in New York is 23h.
    const setAt = "2026-03-08T15:00:00.000Z"; // 11:00 EDT
    const s = sayHere(setAt, "2026-03-10T00:00:00.000Z");
    const ny = "America/New_York";
    // Next local midnight is 2026-03-09T00:00 EDT = 04:00Z.
    expect(resolver(s, [], { timeZone: ny, now: new Date("2026-03-09T03:59:00.000Z") }).resolve("pete@with")).toBe(
      "yes"
    );
    expect(resolver(s, [], { timeZone: ny, now: new Date("2026-03-09T04:01:00.000Z") }).resolve("pete@with")).toBe(
      "unknown"
    );
  });

  it("handles a fall-back day (25 hours long)", () => {
    // 2026-11-01 US DST ends; midnight after 11:00 EDT on 1 Nov is 2026-11-02T00:00 EST = 05:00Z.
    const setAt = "2026-11-01T15:00:00.000Z";
    const s = sayHere(setAt, "2026-11-03T00:00:00.000Z");
    const ny = "America/New_York";
    expect(resolver(s, [], { timeZone: ny, now: new Date("2026-11-02T04:59:00.000Z") }).resolve("pete@with")).toBe(
      "yes"
    );
    expect(resolver(s, [], { timeZone: ny, now: new Date("2026-11-02T05:01:00.000Z") }).resolve("pete@with")).toBe(
      "unknown"
    );
  });

  it("treats a malformed or future-dated record as unknown, not yes", () => {
    const bad = {
      presence: { pete: { state: "here", setAt: "2026-08-11T01:00:00.000Z", until: "2026-08-10T00:00:00.000Z" } }
    };
    expect(resolver(bad).resolve("pete@with")).toBe("unknown");
  });
});

describe("pete@with together with a place", () => {
  const live = presence("here", "2026-08-11T01:00:00.000Z", "2026-08-12T00:00:00.000Z");
  const here = (pathways: string[], situation: Record<string, unknown>, commitments: CommitmentWindow[] = []) =>
    evaluateConditions({ pathways: [{ id: "p", contextIds: pathways }], resolved: resolver(situation, commitments) });

  it("yes only when both hold", () => {
    expect(here(["garage", "pete@with"], { ...inGarage, presence: live }).status).toBe("yes");
  });

  it("person yes, place unknown: unknown, never yes", () => {
    const m = here(["garage", "pete@with"], { presence: live });
    expect(m.status).toBe("unknown");
    expect(m.unknowns).toEqual(["garage"]);
  });

  it("person yes, place elsewhere: no (a live meeting elsewhere does not satisfy the garage)", () => {
    const m = here(["garage", "pete@with"], { locationId: "campus", locationSetAt: "2026-08-11T01:30:00.000Z" }, [
      liveMeeting()
    ]);
    expect(m.status).toBe("no");
    expect(m.missing).toEqual(["garage"]);
  });

  it("person unknown, place elsewhere: no, not a question", () => {
    const m = here(["garage", "pete@with"], { locationId: "campus", locationSetAt: "2026-08-11T01:30:00.000Z" });
    expect(m.status).toBe("no");
    expect(m.missing).toEqual(["garage"]);
    expect(m.personHold).toBeUndefined();
  });

  it("person unknown, place yes: unknown with a person hold naming the person", () => {
    const m = here(["garage", "pete@with"], inGarage);
    expect(m.status).toBe("unknown");
    expect(m.personHold).toMatchObject({
      people: [{ contactId: "pete", name: "Pete", state: "unknown" }],
      unavailableReason: "Waiting on Pete."
    });
  });

  it("a known away is a no hold", () => {
    const away = presence("away", "2026-08-11T01:00:00.000Z", "2026-08-12T00:00:00.000Z");
    const m = here(["garage", "pete@with"], { ...inGarage, presence: away });
    expect(m.status).toBe("no");
    expect(m.personHold?.people).toEqual([{ contactId: "pete", name: "Pete", state: "no" }]);
  });

  it("names the next in-person commitment with a single missing person", () => {
    const later = liveMeeting({ startsAt: "2026-08-11T05:00:00.000Z", endsAt: "2026-08-11T06:00:00.000Z" });
    const m = here(["garage", "pete@with"], inGarage, [later]);
    expect(m.personHold?.availableFrom).toBe("2026-08-11T05:00:00.000Z");
  });

  it("two people: all must be yes; one known no blocks at once", () => {
    const both = {
      pete: { state: "here", setAt: "2026-08-11T01:00:00.000Z", until: "2026-08-12T00:00:00.000Z" },
      mia: { state: "here", setAt: "2026-08-11T01:00:00.000Z", until: "2026-08-12T00:00:00.000Z" }
    };
    expect(here(["pete@with", "mia@with"], { presence: both }).status).toBe("yes");
    expect(here(["pete@with", "mia@with"], { presence: { pete: both.pete } }).status).toBe("unknown");
    const oneNo = { pete: both.pete, mia: { ...both.mia, state: "away" } };
    const blocked = here(["pete@with", "mia@with"], { presence: oneNo });
    expect(blocked.status).toBe("no");
    expect(blocked.personHold?.people).toEqual([{ contactId: "mia", name: "Mia", state: "no" }]);
    const bothMissing = here(["pete@with", "mia@with"], {});
    expect(bothMissing.personHold?.people.map((p) => p.contactId)).toEqual(["pete", "mia"]);
    expect(bothMissing.personHold?.unavailableReason).toBe("Waiting on Pete and Mia.");
  });

  it("another pathway can still satisfy it", () => {
    const m = evaluateConditions({
      pathways: [
        { id: "a", contextIds: ["garage", "pete@with"] },
        { id: "b", contextIds: ["garage"] }
      ],
      resolved: resolver(inGarage)
    });
    expect(m.status).toBe("yes");
    expect(m.satisfiedPathwayId).toBe("b");
  });

  it("an @remote person does not produce a hold", () => {
    const m = here(["campus", "pete@remote"], inGarage);
    expect(m.status).toBe("no");
    expect(m.personHold).toBeUndefined();
  });
});
