import { describe, expect, it, vi } from "vitest";
import type { PortalState } from "@/state/portal-state";
import { createSeedState } from "@/state/portal-state";
import { emptyCommitmentEditor, type CommitmentEditorDraft } from "./today-drafts";
import { createContact, createOneOffPlace, findCommitmentMatch, saveCommitmentDraft } from "./commitment-save";

const NOW = new Date("2026-08-19T00:00:00.000Z");

function deps(overrides: Partial<PortalState> = {}) {
  const state = { ...createSeedState(NOW), ...overrides } as PortalState;
  return {
    state,
    saveEntityCommand: vi.fn().mockResolvedValue(undefined),
    saveCommitmentRecurrenceRuleCommand: vi.fn().mockResolvedValue(undefined)
  };
}

const draftOf = (state: PortalState, overrides: Partial<CommitmentEditorDraft> = {}): CommitmentEditorDraft => ({
  ...emptyCommitmentEditor(state.settings),
  title: "Standing meeting",
  startsAt: "2026-08-20T09:00",
  endsAt: "2026-08-20T10:00",
  ...overrides
});

/**
 * The one branch three surfaces share: Today's quick add, the sheet on a commitment's own page, and
 * the rule editor on Schedule. What `repeats` selects decides which table is written, and getting it
 * wrong writes a one-off into the rule store or the reverse.
 */
describe("saveCommitmentDraft", () => {
  it("sends a one-off down the entity command", async () => {
    const d = deps();
    expect(await saveCommitmentDraft(draftOf(d.state), null, d)).toBe("");
    expect(d.saveCommitmentRecurrenceRuleCommand).not.toHaveBeenCalled();
    expect(d.saveEntityCommand.mock.calls[0]![0]).toMatchObject({
      type: "save_entity",
      entityType: "commitment",
      expectedVersion: null,
      entity: { title: "Standing meeting" }
    });
  });

  it("sends a repeating one down the commitment-recurrence command, with the settings timezone", async () => {
    const d = deps();
    const draft = draftOf(d.state, { repeats: true, startDate: "2026-08-20", intervalDays: 14 });
    expect(await saveCommitmentDraft(draft, null, d)).toBe("");
    expect(d.saveEntityCommand).not.toHaveBeenCalled();
    expect(d.saveCommitmentRecurrenceRuleCommand.mock.calls[0]![0]).toMatchObject({
      expectedVersion: null,
      rule: {
        title: "Standing meeting",
        repeat: { unit: "days", intervalDays: 14 },
        timezone: d.state.settings.timezone
      }
    });
  });

  it("mints an id for a new record and keeps the one an existing record already has", async () => {
    const d = deps();
    await saveCommitmentDraft(draftOf(d.state), null, d);
    expect(d.saveEntityCommand.mock.calls[0]![0].entity.id).toBeTruthy();
    await saveCommitmentDraft(draftOf(d.state, { id: "dinner" }), 7, d);
    expect(d.saveEntityCommand.mock.calls[1]![0].entity.id).toBe("dinner");
  });

  it("uses the id minted when the draft opened, so a retry after a lost response reuses it", async () => {
    const d = deps();
    d.saveEntityCommand.mockRejectedValueOnce(new Error("lost"));
    await saveCommitmentDraft(draftOf(d.state), null, d, { newId: "minted" });
    await saveCommitmentDraft(draftOf(d.state), null, d, { newId: "minted" });
    expect(d.saveEntityCommand.mock.calls.map((c) => c[0].entity.id)).toEqual(["minted", "minted"]);
    await saveCommitmentDraft(draftOf(d.state, { id: "dinner" }), 7, d, { newId: "minted" });
    expect(d.saveEntityCommand.mock.calls[2]![0].entity.id).toBe("dinner");
  });

  // the expected version is a fact the caller supplies from when its draft was seeded, not
  // something this function may re-derive from `state` at submit time — a live read at submit,
  // after the body was composed earlier, is exactly the stale-version bug this closes.
  it("sends whatever expected version it is given, verbatim, regardless of what state contains", async () => {
    const d = deps({
      commitments: [
        { id: "dinner", title: "Dinner", startsAt: "", endsAt: "", status: "confirmed", version: 7 }
      ] as unknown as PortalState["commitments"],
      commitmentRecurrenceRules: [{ id: "weekly", version: 2 }] as unknown as PortalState["commitmentRecurrenceRules"]
    });
    await saveCommitmentDraft(draftOf(d.state, { id: "dinner" }), 41, d);
    expect(d.saveEntityCommand.mock.calls[0]![0].expectedVersion).toBe(41);
    await saveCommitmentDraft(draftOf(d.state, { id: "weekly", repeats: true, startDate: "2026-08-20" }), 99, d);
    expect(d.saveCommitmentRecurrenceRuleCommand.mock.calls[0]![0].expectedVersion).toBe(99);
  });

  it("refuses an invalid draft with the shared wording, and sends nothing", async () => {
    const d = deps();
    expect(await saveCommitmentDraft(draftOf(d.state, { title: "  " }), null, d)).toBe(
      "Commitment title, start, and end are required."
    );
    expect(d.saveEntityCommand).not.toHaveBeenCalled();
  });

  it("returns the server's reason when the command is rejected", async () => {
    const d = deps();
    d.saveEntityCommand.mockRejectedValue(new Error("That commitment changed. Reload before editing."));
    expect(await saveCommitmentDraft(draftOf(d.state), null, d)).toBe(
      "That commitment changed. Reload before editing."
    );
  });

  it("falls back to a sentence naming the right half when the rejection is not an Error", async () => {
    const one = deps();
    one.saveEntityCommand.mockRejectedValue("nope");
    expect(await saveCommitmentDraft(draftOf(one.state), null, one)).toBe("Commitment was not saved.");
    const many = deps();
    many.saveCommitmentRecurrenceRuleCommand.mockRejectedValue("nope");
    const draft = draftOf(many.state, { repeats: true, startDate: "2026-08-20" });
    expect(await saveCommitmentDraft(draft, null, many)).toBe("Recurring commitment was not saved.");
  });
});

describe("createContact", () => {
  it("reactivates an archived contact matched by name instead of returning it still archived", async () => {
    const definitions = [
      { id: "sam", name: "Sam", kind: "contact", status: "archived", channels: [], version: 3 }
    ] as unknown as PortalState["conditionDefinitions"];
    const saveEntityCommand = vi.fn().mockResolvedValue(undefined);
    const contact = await createContact("Sam", definitions, saveEntityCommand);
    // The same id and name come back — a fresh "Sam" cannot be created alongside it either way,
    // since `condition_definitions_user_name_unique` covers (user_id, name) regardless of status.
    expect(contact).toEqual({ id: "sam", name: "Sam" });
    expect(saveEntityCommand).toHaveBeenCalledTimes(1);
    expect(saveEntityCommand.mock.calls[0]![0]).toMatchObject({
      entityType: "condition_definition",
      expectedVersion: 3,
      entity: { id: "sam", name: "Sam", kind: "contact", status: "active" }
    });
  });

  it("leaves an already-active match untouched: no command, same id and name back", async () => {
    const definitions = [
      { id: "sam", name: "Sam", kind: "contact", status: "active", channels: [] }
    ] as unknown as PortalState["conditionDefinitions"];
    const saveEntityCommand = vi.fn().mockResolvedValue(undefined);
    const contact = await createContact("Sam", definitions, saveEntityCommand);
    expect(contact).toEqual({ id: "sam", name: "Sam" });
    expect(saveEntityCommand).not.toHaveBeenCalled();
  });
});

describe("createOneOffPlace", () => {
  it("stores the picked result as a one-off location and hands back its id and name", async () => {
    const saveEntityCommand = vi.fn().mockResolvedValue(undefined);
    const place = await createOneOffPlace(
      { label: "Riverside CC", latitude: -33.88, longitude: 151.19 },
      saveEntityCommand
    );
    expect(place.name).toBe("Riverside CC");
    expect(saveEntityCommand.mock.calls[0]![0]).toMatchObject({
      entityType: "condition_definition",
      expectedVersion: null,
      entity: { id: place.id, name: "Riverside CC", kind: "location", oneOff: true, latitude: -33.88 }
    });
  });
});

describe("findCommitmentMatch", () => {
  const tz = "Australia/Sydney";
  const draft = () => draftOf({ ...createSeedState(NOW) } as PortalState);
  const answer = (body: unknown, ok = true) => vi.fn().mockResolvedValue({ ok, json: async () => body });

  it("asks the server about a new one-off, in instants, and returns its match", async () => {
    const match = { kind: "strong", id: "c1", title: "Standing meeting", startsAt: "2026-08-19T23:00:00.000Z" };
    const fetcher = answer({ match });
    expect(await findCommitmentMatch(draft(), tz, fetcher)).toEqual(match);
    const url = new URL(String(fetcher.mock.calls[0]![0]), "http://portal.test");
    expect(url.pathname).toBe("/api/commitments/matches");
    expect(url.searchParams.get("title")).toBe("Standing meeting");
    expect(url.searchParams.get("startsAt")).toBe("2026-08-19T23:00:00.000Z");
    expect(url.searchParams.get("endsAt")).toBe("2026-08-20T00:00:00.000Z");
  });

  it("never asks about an existing commitment, a repeating rule or an unfinished draft", async () => {
    const fetcher = answer({ match: { kind: "strong", id: "x", title: "x", startsAt: "2026-08-19T23:00:00.000Z" } });
    expect(await findCommitmentMatch({ ...draft(), id: "existing" }, tz, fetcher)).toBeNull();
    expect(await findCommitmentMatch({ ...draft(), repeats: true }, tz, fetcher)).toBeNull();
    expect(await findCommitmentMatch({ ...draft(), title: " " }, tz, fetcher)).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("reads a failed check as no match, so the save is never blocked", async () => {
    expect(await findCommitmentMatch(draft(), tz, answer({ error: "no" }, false))).toBeNull();
    expect(await findCommitmentMatch(draft(), tz, vi.fn().mockRejectedValue(new Error("offline")))).toBeNull();
    expect(await findCommitmentMatch(draft(), tz, answer({ match: null }))).toBeNull();
  });
});
