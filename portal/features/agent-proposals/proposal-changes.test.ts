import { describe, expect, it } from "vitest";
import type { AgentProposal } from "@openrhen/contracts";
import { recordInState } from "@/shared/record-in-state";
import { proposalChanges, type ChangeGroup } from "./proposal-changes";

const NY = { timezone: "America/New_York", now: new Date("2026-11-03T14:00:00Z") };

const make = (kind: string, payload: Record<string, unknown>): AgentProposal => ({
  id: "11111111-1111-4111-8111-111111111111",
  agent: "scribe",
  kind,
  summary: "s",
  payload,
  basis: "stated",
  evidence: null,
  targetVersions: {},
  status: "pending",
  coalesceKey: null,
  revision: 1,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  resolvedAt: null,
  resolvedBy: null,
  resolutionNote: null
});

describe("proposalChanges", () => {
  it("describes a project create without its id, version or command id", () => {
    const groups = proposalChanges(
      make("entity_command", {
        command: "save_project",
        body: { project: { id: "p-1", version: 1, commandId: "c", title: " Thesis ", dueDate: null, priority: 3 } }
      })
    );
    expect(groups).toEqual([
      {
        title: 'Create project "Thesis"',
        rows: [
          { field: "title", value: " Thesis " },
          { field: "priority", value: "3" }
        ]
      }
    ]);
  });

  it("lists a stored field the update leaves out, since the save clears it, but not one it keeps", () => {
    const thesis = {
      id: "p1",
      outcomeId: "o1",
      title: "Thesis",
      status: "active",
      uncertainty: "some",
      consequence: 3,
      internalDeadlineAt: "2026-11-20T00:00:00.000Z",
      externalDeadlineAt: "2026-11-30T00:00:00.000Z",
      private: true,
      area: "Study"
    };
    const { internalDeadlineAt: _i, externalDeadlineAt: _e, private: _p, area: _a, ...sent } = thesis;
    const groups = proposalChanges(
      make("entity_command", { command: "save_project", body: { expectedVersion: 4, project: sent } }),
      (kind, id) => (kind === "project" && id === "p1" ? thesis : undefined),
      NY
    );
    expect(groups![0]!.rows).toEqual([
      {
        field: "internal deadline at",
        value: "Thu 19 Nov, 7:00 pm → none (not in the request, so it is cleared)"
      },
      { field: "external deadline at", value: "Sun 29 Nov, 7:00 pm → none (not in the request, so it is cleared)" }
    ]);
  });

  const stored = { id: "rent", text: "Pay rent", done: false, dueDate: "2026-11-01" };
  const find = (kind: string, id: unknown) => (kind === "action" && id === "rent" ? stored : undefined);

  it("names the stored record on an update and shows old to new, leaving unchanged rows out", () => {
    const groups = proposalChanges(
      make("entity_command", {
        command: "save_action",
        body: {
          expectedVersion: 2,
          action: { id: "rent", text: "Totally different", done: true, dueDate: "2026-11-01" }
        }
      }),
      find
    );
    expect(groups).toEqual([
      {
        title: 'Update action "Pay rent" (rent)',
        rows: [
          { field: "text", value: "Pay rent \u2192 Totally different" },
          { field: "done", value: "no \u2192 yes" }
        ]
      }
    ]);
  });

  it("says no field changes when nothing differs", () => {
    const groups = proposalChanges(
      make("entity_command", {
        command: "save_action",
        body: { expectedVersion: 2, action: { id: "rent", done: false } }
      }),
      find
    );
    expect(groups![0]!.rows).toEqual([{ field: "no field changes", value: "" }]);
  });

  it("says when the stored record is not in this portal's copy, never using the agent's title", () => {
    const groups = proposalChanges(
      make("entity_command", {
        command: "save_action",
        body: { expectedVersion: 2, action: { id: "gone", text: "New name" } }
      }),
      find
    );
    expect(groups).toEqual([
      { title: "Update action gone (not in this portal's copy)", rows: [{ field: "text", value: "New name" }] }
    ]);
    expect(
      proposalChanges(
        make("entity_command", { command: "save_action", body: { expectedVersion: 1, action: { id: "x" } } })
      )![0]!.title
    ).toBe("Update action x (not in this portal's copy)");
  });

  it("names the stored record on a remove and lists what it holds", () => {
    const span = { id: "rent", text: "Pay rent", done: false };
    const groups = proposalChanges(
      make("entity_command", {
        command: "save_entity",
        body: { expectedVersion: 2, entityType: "span", entity: { id: "rent", text: "Hidden", remove: true } }
      }),
      (kind, id) => (kind === "span" && id === "rent" ? span : undefined)
    );
    expect(groups![0]!.title).toBe('Remove span "Pay rent" (rent)');
    expect(groups![0]!.rows[0]).toEqual({ field: "text", value: "Pay rent" });
  });

  it("strips bidi and zero-width characters from titles, fields and values", () => {
    const groups = proposalChanges(
      make("entity_command", {
        command: "save_project",
        body: { project: { title: "A\u202EB\u200B", "no\u2066te": "x\uFEFFy" } }
      })
    );
    expect(groups![0]!.title).toBe('Create project "AB"');
    expect(groups![0]!.rows).toEqual([
      { field: "title", value: "AB" },
      { field: "note", value: "xy" }
    ]);
  });

  it("uses the entity type for save_entity, writes yes or no and plain lists", () => {
    const groups = proposalChanges(
      make("entity_command", {
        command: "save_entity",
        body: { entityType: "agent_setting", expectedVersion: 1, entity: { pulse_publish_enabled: true, tags: ["a"] } }
      })
    );
    expect(groups).toEqual([
      {
        title: "Update agent setting (not in this portal's copy)",
        rows: [
          { field: "pulse publish enabled", value: "yes" },
          { field: "tags", value: "a" }
        ]
      }
    ]);
  });

  it("truncates a long name in the title only", () => {
    const name = "n".repeat(120);
    const groups = proposalChanges(
      make("entity_command", { command: "save_project", body: { project: { title: name } } })
    );
    expect(groups![0]!.title).toBe(`Create project "${"n".repeat(80)}"`);
    expect(groups![0]!.rows[0]!.value).toBe(name);
  });

  it("gives one group per command in a batch", () => {
    const groups = proposalChanges(
      make("entity_command_batch", {
        commands: [
          { command: "save_project", body: { project: { title: "A" } } },
          { command: "save_action", body: { action: { text: "B" } } }
        ]
      })
    );
    expect(groups!.map((g) => g.title)).toEqual(['Create project "A"', 'Create action "B"']);
  });

  it("shows the verdict the applier will read when an entry verdict also carries a bulk key", () => {
    const groups = proposalChanges(
      make("settle_catch_up", { verdicts: [{ entryId: "occurrence:1", verdict: "done", bulk: "all_dropped" }] })
    );
    expect(groups![0]!.rows).toEqual([{ field: "occurrence:1", value: "done" }]);
  });

  it("describes a session ended with minutes left and a skip of everything older than N days", () => {
    const groups = proposalChanges(
      make("settle_catch_up", {
        verdicts: [
          { entryId: "session:s1", verdict: "ended", at: "2026-10-01T10:00:00Z", remainingMinutes: 20 },
          { bulk: "skip_older_than", days: 7 }
        ]
      }),
      undefined,
      NY
    );
    expect(groups![0]!.rows).toEqual([
      { field: "session:s1", value: "ended at Thu 1 Oct, 6:00 am with 20 min left" },
      { field: "everything older than 7 days", value: "skipped" }
    ]);
  });

  it("describes catch-up verdicts, bulk verdicts and closing the window", () => {
    const groups = proposalChanges(
      make("settle_catch_up", {
        verdicts: [
          { entryId: "occurrence:1", verdict: "done", at: "2026-10-01T10:00:00Z" },
          { entryId: "deadline:p", verdict: "dropped", becomes: "paused" },
          { entryId: "deadline:q", verdict: "pending", moveTo: "2026-11-01T00:00:00Z" },
          { bulk: "all_skipped", day: "2026-10-02" },
          { bulk: "all_dropped", projectId: "p9" }
        ],
        closeWindow: true
      }),
      undefined,
      NY
    );
    expect(groups).toEqual([
      {
        title: "Settle 5 catch-up entries",
        rows: [
          { field: "occurrence:1", value: "done at Thu 1 Oct, 6:00 am" },
          { field: "deadline:p", value: "dropped becomes paused" },
          { field: "deadline:q", value: "pending move to Sat 31 Oct, 8:00 pm" },
          { field: "all on 2026-10-02", value: "skipped" },
          { field: "all in project p9", value: "dropped" },
          { field: "catch-up window", value: "close" }
        ]
      }
    ]);
  });

  it("says entry in the singular", () => {
    const groups = proposalChanges(make("settle_catch_up", { verdicts: [{ entryId: "e", verdict: "skipped" }] }));
    expect(groups![0]!.title).toBe("Settle 1 catch-up entry");
  });

  it("returns null for an unknown kind and for a payload that does not parse", () => {
    expect(proposalChanges(make("mystery", { a: 1 }))).toBeNull();
    expect(proposalChanges(make("entity_command", { command: "nope", body: {} }))).toBeNull();
    expect(proposalChanges(make("entity_command_batch", { commands: [] }))).toBeNull();
    expect(proposalChanges(make("settle_catch_up", { verdicts: [{ nonsense: true }] }))).toBeNull();
  });

  it("shows a project save carrying remove as the edit it is, since the project schema drops remove", () => {
    const stored = { id: "p1", title: "Thesis", status: "active" };
    const groups = proposalChanges(
      make("entity_command", {
        command: "save_project",
        body: { expectedVersion: 2, project: { id: "p1", title: "Thesis", status: "cancelled", remove: true } }
      }),
      (kind, id) => (kind === "project" && id === "p1" ? stored : undefined)
    );
    expect(groups![0]!.title).toBe('Update project "Thesis" (p1)');
    expect(groups![0]!.rows).toContainEqual({ field: "status", value: "active \u2192 cancelled" });
  });

  it("shows a restated preferred place and preset as cleared when the save switches attendance and routine source", () => {
    const stored = {
      id: "c1",
      title: "Dentist",
      attendance: "remote",
      preferredLocationId: "loc-1",
      routineSource: "preset",
      routinePresetId: "p1"
    };
    const groups = proposalChanges(
      make("entity_command", {
        command: "save_entity",
        body: {
          expectedVersion: 3,
          entityType: "commitment",
          entity: { ...stored, attendance: "in_person", routineSource: "custom" }
        }
      }),
      (kind, id) => (kind === "commitment" && id === "c1" ? stored : undefined)
    );
    const rows = groups![0]!.rows;
    expect(rows).toContainEqual({ field: "attendance", value: "remote \u2192 in_person" });
    expect(rows.find((row) => row.field === "preferred location id")?.value).toMatch(
      /^loc-1 \u2192 none \(the save clears it/
    );
    expect(rows.find((row) => row.field === "routine preset id")?.value).toMatch(
      /^p1 \u2192 none \(the save clears it/
    );
    expect(rows.filter((row) => row.field === "preferred location id")).toHaveLength(1);
  });

  it("shows a commitment save carrying remove as the update it is, with its changed fields", () => {
    const dentist = { id: "c1", title: "Dentist", shareToCalendar: false };
    const groups = proposalChanges(
      make("entity_command", {
        command: "save_entity",
        body: {
          expectedVersion: 3,
          entityType: "commitment",
          entity: { id: "c1", title: "Dentist", shareToCalendar: true, remove: true }
        }
      }),
      (kind, id) => (kind === "commitment" && id === "c1" ? dentist : undefined)
    );
    expect(groups![0]!.title).toBe('Update commitment "Dentist" (c1)');
    expect(groups![0]!.rows).toContainEqual({ field: "share with family", value: "no \u2192 yes" });
  });

  it("reads a daily plan and the availability by their natural key, so omitted lists show as cleared", () => {
    const state = {
      dailyPlan: { id: "dp", localDate: "2026-10-28", desiredActionIds: ["a1"], deferredItems: [] },
      currentEnergy: "high",
      assertedConditions: ["home"],
      currentSituation: {}
    };
    const find = (kind: string, id: unknown, sent?: Record<string, unknown>) => recordInState(state, kind, id, sent);
    const plan = proposalChanges(
      make("entity_command", {
        command: "save_entity",
        body: { entityType: "daily_plan", entity: { localDate: "2026-10-28" } }
      }),
      find
    );
    expect(plan![0]!.title).toMatch(/^Update daily plan/);
    expect(plan![0]!.rows.map((row) => row.field)).toContain("desired action ids");
    const availability = proposalChanges(
      make("entity_command", {
        command: "save_entity",
        body: { entityType: "current_availability", entity: { currentEnergy: "low" } }
      }),
      find
    );
    expect(availability![0]!.title).toMatch(/^Update current availability/);
    expect(availability![0]!.rows.map((row) => row.field)).toEqual(expect.arrayContaining(["current energy"]));
  });

  it("finds a planning focus by its period, so an omitted project list shows as cleared on that period", () => {
    const state = {
      planningFocus: [
        { id: "f1", version: 3, kind: "weekly", periodStart: "2026-10-26", periodEnd: "2026-11-01", projectIds: ["p1"] }
      ]
    };
    const groups = proposalChanges(
      make("entity_command", {
        command: "save_entity",
        body: {
          expectedVersion: 3,
          entityType: "planning_focus",
          entity: { id: "other", kind: "weekly", periodStart: "2026-10-26", periodEnd: "2026-11-01" }
        }
      }),
      (kind, id, sent) => recordInState(state, kind, id, sent)
    );
    expect(groups![0]!.rows.map((row) => row.field)).toContain("project ids");
  });

  it("shows a capture restore as the status change it is, never the fields the restore ignores", () => {
    const capture = { id: "k1", text: "Learn the cello", status: "superseded", proposalType: "someday" };
    const groups = proposalChanges(
      make("entity_command", {
        command: "save_entity",
        body: {
          expectedVersion: 2,
          entityType: "capture",
          entity: { id: "k1", status: "pending", restore: true, proposedFields: { text: "Something else" } }
        }
      }),
      (kind, id) => (kind === "capture" && id === "k1" ? capture : undefined)
    );
    expect(groups).toEqual([
      {
        title: 'Restore capture "Learn the cello" (k1)',
        rows: [
          { field: "status", value: "superseded \u2192 pending" },
          { field: "other fields", value: "kept as stored (the rest of the request is ignored on restore)" }
        ]
      }
    ]);
  });
});

describe("proposalChanges in plain language", () => {
  const settingsProposal = (entity: Record<string, unknown>) =>
    make("entity_command", { command: "save_entity", body: { entityType: "settings", expectedVersion: 4, entity } });
  const rowMap = (groups: ChangeGroup[] | null) =>
    Object.fromEntries(groups![0]!.rows.map((row) => [row.field, row.value]));

  it("writes an event's times in the plan zone as one range, booleans as words, and drops ids and empty fields", () => {
    const groups = proposalChanges(
      make("entity_command", {
        command: "save_entity",
        body: {
          entityType: "commitment",
          entity: {
            title: "Dentist",
            startsAt: "2026-11-12T21:00:00Z",
            endsAt: "2026-11-12T21:45:00Z",
            shareToCalendar: true,
            tentative: true,
            setupBeforeMinutes: 0,
            projectId: "3040f868-dd69-50c8-ace2-7c1fc0c5",
            contexts: [],
            dependencyIds: [],
            notes: null,
            location: ""
          }
        }
      }),
      undefined,
      NY
    );
    const rows = rowMap(groups);
    expect(rows["when"]).toBe("Thu 12 Nov, 4:00-4:45 pm");
    expect(rows["share with family"]).toBe("yes");
    expect(rows["tentative"]).toBe("yes");
    expect(rows["setup before"]).toBe("0 min");
    for (const hidden of ["project id", "contexts", "dependency ids", "notes", "location", "starts at", "ends at"])
      expect(rows, hidden).not.toHaveProperty(hidden);
    expect(JSON.stringify(groups)).not.toMatch(/3040f868|T\d\d:\d\d|true|false|\[\]/);
    expect(rows["more"]).toMatch(/Exact request/);
  });

  it("keeps two times apart when they fall on different days, with the year only when it differs", () => {
    const rows = rowMap(
      proposalChanges(
        make("entity_command", {
          command: "save_entity",
          body: {
            entityType: "commitment",
            entity: { startsAt: "2026-11-12T23:30:00-05:00", endsAt: "2027-01-02T00:15:00-05:00" }
          }
        }),
        undefined,
        NY
      )
    );
    expect(rows["starts at"]).toBe("Thu 12 Nov, 11:30 pm");
    expect(rows["ends at"]).toBe("Sat 2 Jan 2027, 12:15 am");
  });

  it("reads a date-only value as that calendar day, whatever the zone", () => {
    const rows = rowMap(
      proposalChanges(
        make("entity_command", { command: "save_project", body: { project: { dueDate: "2026-11-12" } } }),
        undefined,
        { timezone: "Pacific/Auckland", now: NY.now }
      )
    );
    expect(rows["due date"]).toBe("Thu 12 Nov");
  });

  it("hides a changed id field on an update but says something else changed", () => {
    const stored = { id: "a1", text: "Pay rent", projectId: "p-old", done: false };
    const groups = proposalChanges(
      make("entity_command", {
        command: "save_action",
        body: { expectedVersion: 2, action: { id: "a1", text: "Pay rent", projectId: "p-new", done: true } }
      }),
      (kind, id) => (kind === "action" && id === "a1" ? stored : undefined),
      NY
    );
    expect(groups![0]!.rows.map((row) => row.field)).toEqual(["done", "more"]);
  });

  it("warns that a timezone change shifts the whole day, by how many hours", () => {
    const groups = proposalChanges(
      settingsProposal({ timezone: "Australia/Sydney" }),
      (kind) => (kind === "settings" ? { timezone: "America/New_York" } : undefined),
      NY
    );
    expect(groups![0]!.caution).toBe(
      "Times already set will read 16 h later. Routines, repeats and sleep keep their clock times, in the new zone."
    );
    const back = proposalChanges(
      settingsProposal({ timezone: "America/New_York" }),
      (kind) => (kind === "settings" ? { timezone: "Australia/Sydney" } : undefined),
      NY
    );
    expect(back![0]!.caution).toBe(
      "Times already set will read 16 h earlier. Routines, repeats and sleep keep their clock times, in the new zone."
    );
  });

  it("gives a settings change a general warning, and an unknown stored zone a general timezone one", () => {
    const other = proposalChanges(
      settingsProposal({ sessionBreakMinutes: 10 }),
      (kind) => (kind === "settings" ? { sessionBreakMinutes: 15 } : undefined),
      NY
    );
    expect(other![0]!.caution).toMatch(/setting/i);
    expect(other![0]!.rows).toEqual([{ field: "session break", value: "15 min \u2192 10 min" }]);
    expect(proposalChanges(settingsProposal({ timezone: "Australia/Sydney" }), undefined, NY)![0]!.caution).toMatch(
      /time zone/i
    );
  });

  it("says so when a zone change moves no clock today, instead of the general settings line", () => {
    const winter = { timezone: "America/New_York", now: new Date("2026-07-01T00:00:00Z") };
    const groups = proposalChanges(
      settingsProposal({ timezone: "Australia/Brisbane" }),
      (kind) => (kind === "settings" ? { timezone: "Australia/Sydney" } : undefined),
      { ...winter, now: new Date("2026-07-01T00:00:00Z") }
    );
    // The seed zone is UTC+10 in July, the same as Brisbane.
    expect(groups![0]!.caution).toMatch(/time zone changes.*daylight/i);
  });

  it("strips the unit from a cleared field's label as it does for a set one", () => {
    const stored = { id: "c1", title: "Dentist", setupBeforeMinutes: 15 };
    const groups = proposalChanges(
      make("entity_command", {
        command: "save_entity",
        body: { expectedVersion: 2, entityType: "commitment", entity: { id: "c1", title: "Dentist" } }
      }),
      (kind, id) => (kind === "commitment" && id === "c1" ? stored : undefined),
      NY
    );
    const fields = groups![0]!.rows.map((row) => row.field);
    expect(fields).not.toContain("setup before minutes");
  });

  it("names the project and dependencies an id points to, so two creates differing only by them look different", () => {
    const state = {
      projects: [
        { id: "pA", title: "Family" },
        { id: "pB", title: "Work" }
      ],
      actions: [
        { id: "d1", title: "Get the bill" },
        { id: "d2", title: "Ask the landlord" }
      ]
    };
    const find = (kind: string, id: unknown) => recordInState(state, kind, id);
    const create = (projectId: string, dependencyIds: string[]) =>
      proposalChanges(
        make("entity_command", {
          command: "save_action",
          body: { action: { title: "Pay rent", projectId, dependencyIds } }
        }),
        find,
        NY
      )![0]!;
    const a = create("pA", ["d1"]);
    const b = create("pB", ["d2"]);
    expect(a.rows).toContainEqual({ field: "project", value: "Family" });
    expect(a.rows).toContainEqual({ field: "depends on", value: "Get the bill" });
    expect(b.rows).toContainEqual({ field: "project", value: "Work" });
    expect(a.rows).not.toContainEqual(expect.objectContaining({ field: "more" }));
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });

  it("keeps the Exact request pointer for an id it cannot name, beside the ones it can", () => {
    const find = (kind: string, id: unknown) =>
      kind === "project" && id === "pA" ? { id: "pA", title: "Family" } : undefined;
    const rows = proposalChanges(
      make("entity_command", {
        command: "save_action",
        body: { action: { title: "Pay rent", projectId: "pA", dependencyIds: ["gone"] } }
      }),
      find,
      NY
    )![0]!.rows;
    expect(rows).toContainEqual({ field: "project", value: "Family" });
    expect(rows.map((row) => row.field)).not.toContain("depends on");
    expect(rows.find((row) => row.field === "more")?.value).toMatch(/Exact request/);
  });

  it("shows a changed project by name on an update", () => {
    const state = {
      projects: [
        { id: "pA", title: "Family" },
        { id: "pB", title: "Work" }
      ],
      actions: [{ id: "a1", title: "Pay rent", projectId: "pA" }]
    };
    const groups = proposalChanges(
      make("entity_command", {
        command: "save_action",
        body: { expectedVersion: 2, action: { id: "a1", title: "Pay rent", projectId: "pB" } }
      }),
      (kind, id) => recordInState(state, kind, id),
      NY
    );
    expect(groups![0]!.rows).toEqual([{ field: "project", value: "Family \u2192 Work" }]);
  });

  it("gives no warning to an ordinary record", () => {
    const groups = proposalChanges(
      make("entity_command", { command: "save_project", body: { project: { title: "A" } } }),
      undefined,
      NY
    );
    expect(groups![0]!.caution).toBeUndefined();
  });

  it("describes a held close with its reason and what goes with it", () => {
    const groups = proposalChanges(
      make("close_entity", {
        type: "project",
        verb: "cancel",
        id: "p1",
        do: "close",
        reason: "dropped",
        children: [
          { type: "action", id: "a1", version: 2 },
          { type: "action", id: "a2", version: 1 }
        ]
      }),
      undefined,
      NY
    );
    expect(groups).toEqual([
      {
        title: "Cancel project",
        rows: [
          { field: "project", value: "p1" },
          { field: "reason", value: "dropped" },
          { field: "action with it", value: "2" }
        ]
      }
    ]);
  });

  it("returns nothing for a close whose payload is no longer valid", () => {
    expect(proposalChanges(make("close_entity", { type: "nope" }), undefined, NY)).toBeNull();
  });
});
