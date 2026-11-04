import { describe, expect, it } from "vitest";
import type { PlanningSettings, StoredCommitment, StoredCommitmentRecurrenceRule } from "@/state/portal-state";
import {
  commitmentEditorFrom,
  commitmentEditorFromRule,
  commitmentEditorIsBlank,
  commitmentEntityFrom,
  commitmentRuleFrom,
  emptyCommitmentEditor,
  hasContext,
  parseContexts,
  toggleContext,
  validateCommitmentDraft
} from "./today-drafts";

const settings = {
  defaultUsableFraction: 0.85,
  defaultSetupBufferMinutes: 10,
  defaultTransitionBufferMinutes: 15
} as unknown as PlanningSettings;

describe("Today editor drafts", () => {
  it("seeds a blank commitment editor from the buffer defaults, repeats off", () => {
    expect(emptyCommitmentEditor(settings)).toMatchObject({
      repeats: false,
      status: "confirmed",
      ruleStatus: "active",
      intervalDays: 7,
      localStartTime: "09:00",
      localEndTime: "10:00",
      endDate: "",
      setupBeforeMinutes: 10,
      transitionAfterMinutes: 15,
      presence: "blocking",
      promptPolicy: "normal"
    });
    expect(commitmentEditorIsBlank(emptyCommitmentEditor(settings))).toBe(true);
  });

  it("treats a draft the user has started as no longer blank", () => {
    expect(commitmentEditorIsBlank({ ...emptyCommitmentEditor(settings), title: "Class" })).toBe(false);
    expect(commitmentEditorIsBlank({ ...emptyCommitmentEditor(settings), startDate: "2026-08-18" })).toBe(false);
  });

  it("loads stored commitments and rules into the one editor draft", () => {
    const commitment = {
      id: "class",
      title: "Class",
      startsAt: "2026-08-18T04:00:00.000Z",
      endsAt: "2026-08-18T06:00:00.000Z",
      status: "tentative",
      location: "Room 2.14",
      locationId: "campus",
      setupBeforeMinutes: 5,
      transitionAfterMinutes: 20
    } as unknown as StoredCommitment;
    expect(commitmentEditorFrom(commitment, settings)).toMatchObject({
      id: "class",
      repeats: false,
      title: "Class",
      status: "tentative",
      location: "Room 2.14",
      locationId: "campus",
      projectId: ""
    });

    const rule = {
      id: "weekly",
      title: "Weekly class",
      startDate: "2026-08-18",
      endDate: "2026-12-01",
      localStartTime: "09:00",
      localEndTime: "11:00",
      repeat: { unit: "days" as const, intervalDays: 7 },
      locationId: "campus",
      setupBeforeMinutes: 0,
      transitionAfterMinutes: 0,
      status: "active",
      timezone: "Australia/Sydney"
    } as unknown as StoredCommitmentRecurrenceRule;
    expect(commitmentEditorFromRule(rule, settings)).toMatchObject({
      id: "weekly",
      repeats: true,
      projectId: "",
      location: "",
      locationId: "campus",
      intervalDays: 7,
      endDate: "2026-12-01",
      ruleStatus: "active"
    });
  });

  it("sends the chosen place with the commitment, and omits every field left empty", () => {
    const chosen = {
      ...emptyCommitmentEditor(settings),
      title: "  Networking class  ",
      startsAt: "2026-08-18T14:00",
      endsAt: "2026-08-18T16:00",
      location: " Room 2.14 ",
      locationId: "campus"
    };
    expect(commitmentEntityFrom(chosen, "class", "Australia/Sydney")).toMatchObject({
      id: "class",
      title: "Networking class",
      location: "Room 2.14",
      locationId: "campus",
      setupBeforeMinutes: 10
    });
    expect(
      commitmentEntityFrom({ ...chosen, location: "", locationId: "", projectId: "" }, "class", "Australia/Sydney")
    ).not.toHaveProperty("locationId");
    expect(commitmentEntityFrom({ ...chosen, location: "" }, "class", "Australia/Sydney")).not.toHaveProperty(
      "location"
    );
  });

  it("sends attendance always, and a preferred location only for a remote commitment", () => {
    const chosen = {
      ...emptyCommitmentEditor(settings),
      title: "Camp",
      startsAt: "2026-08-18T14:00",
      endsAt: "2026-08-18T16:00",
      preferredLocationId: "desk"
    };
    expect(commitmentEntityFrom({ ...chosen, attendance: "remote" }, "camp", "Australia/Sydney")).toMatchObject({
      attendance: "remote",
      preferredLocationId: "desk"
    });
    expect(commitmentEntityFrom(chosen, "camp", "Australia/Sydney")).toMatchObject({
      attendance: "in_person",
      preferredLocationId: ""
    });
    const stored = { attendance: "remote", preferredLocationId: "desk" } as unknown as StoredCommitment;
    expect(
      commitmentEditorFrom(
        {
          ...stored,
          title: "t",
          startsAt: "2026-08-18T04:00:00.000Z",
          endsAt: "2026-08-18T05:00:00.000Z"
        } as StoredCommitment,
        settings
      )
    ).toMatchObject({
      attendance: "remote",
      preferredLocationId: "desk"
    });
  });

  // The commitment editor has no opinion about how a commitment came to exist, and the store reads
  // that silence as "leave it alone" (COALESCE). The moment this payload started naming the fields,
  // editing a disruption's end time would quietly demote it to an ordinary planned commitment.
  it("says nothing about disruption provenance, which is what preserves it through an ordinary edit", () => {
    const entity = commitmentEntityFrom(
      {
        ...emptyCommitmentEditor(settings),
        title: "Drive Mum to the shops",
        startsAt: "2026-08-18T14:00",
        endsAt: "2026-08-18T16:00"
      },
      "errand",
      "Australia/Sydney"
    );
    for (const field of ["origin", "disruptionSource", "disruptionOpenEnded", "landedAt"])
      expect(entity).not.toHaveProperty(field);
  });

  // `promptPolicy` lives only on the stored commitment row (see `entity-commands.ts`'s commitment
  // branch), not on the recurrence rule, so a repeating series has nowhere of its own to hold it —
  // `commitmentRuleFrom` must never send the field even though the shared draft always carries one.
  it("round-trips prompt policy on a one-off commitment and omits it from a recurrence rule", () => {
    const stored = {
      id: "class",
      title: "Class",
      startsAt: "2026-08-18T04:00:00.000Z",
      endsAt: "2026-08-18T06:00:00.000Z",
      status: "confirmed",
      setupBeforeMinutes: 5,
      transitionAfterMinutes: 20,
      promptPolicy: "silent"
    } as unknown as StoredCommitment;
    expect(commitmentEditorFrom(stored, settings)).toMatchObject({ promptPolicy: "silent" });
    expect(commitmentEditorFrom({ ...stored, promptPolicy: undefined } as StoredCommitment, settings)).toMatchObject({
      promptPolicy: "normal"
    });

    const chosen = {
      ...emptyCommitmentEditor(settings),
      title: "Class",
      startsAt: "2026-08-18T14:00",
      endsAt: "2026-08-18T16:00",
      promptPolicy: "reduced" as const
    };
    expect(commitmentEntityFrom(chosen, "class", "Australia/Sydney")).toMatchObject({ promptPolicy: "reduced" });
    expect(commitmentRuleFrom(chosen, "weekly", "Australia/Sydney")).not.toHaveProperty("promptPolicy");
  });

  it("sends the chosen place with the recurrence rule too, and the end date only when set", () => {
    const chosen = {
      ...emptyCommitmentEditor(settings),
      repeats: true,
      title: "Weekly class",
      startDate: "2026-08-18",
      locationId: "campus"
    };
    expect(commitmentRuleFrom(chosen, "weekly", "Australia/Sydney")).toMatchObject({
      id: "weekly",
      timezone: "Australia/Sydney",
      startDate: "2026-08-18",
      locationId: "campus",
      status: "active"
    });
    expect(commitmentRuleFrom(chosen, "weekly", "Australia/Sydney")).not.toHaveProperty("endDate");
    expect(commitmentRuleFrom({ ...chosen, endDate: "2026-12-01" }, "weekly", "Australia/Sydney")).toMatchObject({
      endDate: "2026-12-01"
    });
    expect(commitmentRuleFrom({ ...chosen, locationId: "" }, "weekly", "Australia/Sydney")).not.toHaveProperty(
      "locationId"
    );
  });

  it("builds a monthly repeat from the draft's unit fields, and rejects an anchor that doesn't fit", () => {
    const monthly = {
      ...emptyCommitmentEditor(settings),
      repeats: true,
      title: "Book club",
      startDate: "2026-01-31",
      repeatUnit: "months" as const,
      intervalMonths: 1,
      monthAnchor: "last_day" as const
    };
    expect(commitmentRuleFrom(monthly, "book-club", "Australia/Sydney")).toMatchObject({
      repeat: { unit: "months", intervalMonths: 1, anchor: "last_day" }
    });
    expect(validateCommitmentDraft(monthly)).toBe("");
    // 2026-01-31 is the 5th Saturday of January, so nth_weekday cannot match its own start date.
    expect(validateCommitmentDraft({ ...monthly, monthAnchor: "nth_weekday" })).toBe(
      "This repeat does not match its own start date."
    );
  });

  it("builds a weekly repeat that always includes the start date's weekday, and round-trips it", () => {
    const weekly = {
      ...emptyCommitmentEditor(settings),
      repeats: true,
      title: "Class",
      startDate: "2026-09-29", // a Tuesday
      repeatUnit: "weeks" as const,
      intervalWeeks: 2,
      weekdays: [4, 1]
    };
    const rule = commitmentRuleFrom(weekly, "class", "Australia/Sydney");
    expect(rule.repeat).toEqual({ unit: "weeks", intervalWeeks: 2, weekdays: [1, 2, 4] });
    expect(validateCommitmentDraft(weekly)).toBe("");
    expect(commitmentRuleFrom({ ...weekly, weekdays: [] }, "class", "Australia/Sydney").repeat).toEqual({
      unit: "weeks",
      intervalWeeks: 2,
      weekdays: [2]
    });
    expect(validateCommitmentDraft({ ...weekly, intervalWeeks: 0 })).toBe(
      "Repeat every needs a whole number of weeks."
    );
    const loaded = commitmentEditorFromRule(
      {
        ...rule,
        status: "active",
        localStartTime: "09:00",
        localEndTime: "10:00"
      } as unknown as StoredCommitmentRecurrenceRule,
      settings
    );
    expect(loaded).toMatchObject({ repeatUnit: "weeks", intervalWeeks: 2, weekdays: [1, 2, 4] });
  });

  // Both travel fields are always sent, never omitted:
  // the editor always has a definite answer, so there is no "no opinion" case to leave out here the
  // way an untouched place or project is.
  it("round-trips lateness and transport mode, and sends an explicit null to clear the mode back to usual", () => {
    const stored = {
      id: "class",
      title: "Class",
      startsAt: "2026-08-18T04:00:00.000Z",
      endsAt: "2026-08-18T06:00:00.000Z",
      status: "confirmed",
      setupBeforeMinutes: 5,
      transitionAfterMinutes: 20,
      latenessMatters: false,
      transportMode: "bike"
    } as unknown as StoredCommitment;
    expect(commitmentEditorFrom(stored, settings)).toMatchObject({ latenessMatters: false, transportMode: "bike" });
    expect(
      commitmentEditorFrom(
        { ...stored, latenessMatters: undefined, transportMode: undefined } as StoredCommitment,
        settings
      )
    ).toMatchObject({ latenessMatters: true, transportMode: "" });

    const chosen = {
      ...emptyCommitmentEditor(settings),
      title: "Class",
      startsAt: "2026-08-18T14:00",
      endsAt: "2026-08-18T16:00",
      latenessMatters: false,
      transportMode: "bike" as const
    };
    expect(commitmentEntityFrom(chosen, "class", "Australia/Sydney")).toMatchObject({
      latenessMatters: false,
      transportMode: "bike"
    });
    expect(commitmentEntityFrom({ ...chosen, transportMode: "" }, "class", "Australia/Sydney")).toMatchObject({
      transportMode: null
    });
    expect(commitmentRuleFrom(chosen, "weekly", "Australia/Sydney")).toMatchObject({
      latenessMatters: false,
      transportMode: "bike"
    });
    expect(commitmentRuleFrom({ ...chosen, transportMode: "" }, "weekly", "Australia/Sydney")).toMatchObject({
      transportMode: null
    });
  });

  it("round-trips the contact and always sends it, even empty, so it can be explicitly cleared", () => {
    const stored = { ...emptyCommitmentEditor(settings), contactId: "sam" } as unknown as StoredCommitment;
    expect(commitmentEditorFrom(stored, settings)).toMatchObject({ contactId: "sam" });
    expect(commitmentEditorFrom({ ...stored, contactId: undefined } as StoredCommitment, settings)).toMatchObject({
      contactId: ""
    });

    const chosen = {
      ...emptyCommitmentEditor(settings),
      title: "Class",
      startsAt: "2026-08-18T14:00",
      endsAt: "2026-08-18T16:00",
      contactId: "sam"
    };
    expect(commitmentEntityFrom(chosen, "class", "Australia/Sydney")).toMatchObject({ contactId: "sam" });
    expect(commitmentEntityFrom({ ...chosen, contactId: "" }, "class", "Australia/Sydney")).toMatchObject({
      contactId: ""
    });
    expect(commitmentRuleFrom(chosen, "weekly", "Australia/Sydney")).toMatchObject({ contactId: "sam" });
    expect(commitmentRuleFrom({ ...chosen, contactId: "" }, "weekly", "Australia/Sydney")).toMatchObject({
      contactId: ""
    });
  });

  it("keeps the comma-separated context field deduplicated", () => {
    expect(parseContexts(" home , laptop ,, home ")).toEqual(["home", "laptop"]);
    expect(hasContext("home, laptop", "laptop")).toBe(true);
    expect(hasContext("home, laptop", "car")).toBe(false);
    expect(toggleContext("home", "laptop", true)).toBe("home, laptop");
    expect(toggleContext("home, laptop", "laptop", true)).toBe("home, laptop");
    expect(toggleContext("home, laptop", "home", false)).toBe("laptop");
  });
  // One validator behind both the quick form on Today and the editor on a commitment's own page,
  // so the two refuse the same drafts in the same words.
  it("refuses the drafts neither the quick form nor the detail page may save", () => {
    const settings = { defaultSetupBufferMinutes: 10, defaultTransitionBufferMinutes: 10 } as PlanningSettings;
    const one = {
      ...emptyCommitmentEditor(settings),
      title: "Swim",
      startsAt: "2026-08-19T09:00",
      endsAt: "2026-08-19T10:00"
    };
    expect(validateCommitmentDraft(one)).toBe("");
    expect(validateCommitmentDraft({ ...one, title: " " })).toBe("Commitment title, start, and end are required.");
    expect(validateCommitmentDraft({ ...one, endsAt: one.startsAt })).toBe("A commitment must end after it starts.");
    expect(validateCommitmentDraft({ ...one, setupBeforeMinutes: -1 })).toBe("Transition buffers cannot be negative.");
    const series = { ...emptyCommitmentEditor(settings), repeats: true, title: "Squad", startDate: "2026-08-19" };
    expect(validateCommitmentDraft(series)).toBe("");
    expect(validateCommitmentDraft({ ...series, startDate: "" })).toBe(
      "Recurring commitment title and start date are required."
    );
    expect(validateCommitmentDraft({ ...series, localEndTime: series.localStartTime })).toBe(
      "A recurring commitment must end after it starts."
    );
    expect(validateCommitmentDraft({ ...series, endDate: "2026-08-01" })).toBe(
      "A recurring commitment cannot end before its first occurrence."
    );
  });
});
