import { describe, expect, it } from "vitest";
import type { ChangesetCommand, ChangesetResult } from "@openrhen/contracts";
import { runCli } from "../src/cli.js";
import { assumedFields } from "../src/commands/changeset.js";
import { EXIT } from "../src/errors.js";
import { memoryJournal, type Journal } from "../src/undo-journal.js";
import { fakeFetch, type RecordedCall } from "./fake-fetch.js";
import { fixtureActiveSession, fixtureActiveSessionId, fixtureNow, fixtureRawState } from "./fixture-state.js";

interface Run {
  exitCode: number;
  stderr: string;
  calls: RecordedCall[];
  json: Record<string, unknown> | undefined;
}

/** A portal that answers a changeset as if every command applied (and kept row images). */
function okChangeset(call: RecordedCall) {
  const body = call.body as ChangesetCommand;
  // Nothing has been applied under any command id yet.
  if (body.replay) return { status: 404, body: { error: "No changeset was applied under that command id." } };
  const result: ChangesetResult = {
    mode: body.mode,
    ok: true,
    ...(body.mode === "apply" ? { changesetId: body.commandId } : {}),
    items: body.items.map((item) => ({
      intent: item.intent,
      outcome: "applies",
      commandId: String(item.payload.commandId),
      undoable: true
    }))
  };
  return { body: { result, ...(body.mode === "apply" ? { revertible: body.commandId } : {}) } };
}

/** A night the sleep log holds beyond what state carries: last night, logged with a wake of 06:20. */
const lastNight = {
  id: "sleep-last-night",
  plannedStartAt: "2026-09-02T22:30:00+10:00",
  plannedWakeAt: "2026-09-03T06:30:00+10:00",
  actualStartAt: "2026-09-02T23:00:00+10:00",
  actualWakeAt: "2026-09-03T06:20:00+10:00",
  desiredMinutes: 480,
  allowedMinutes: 440,
  sleepDeficitMinutes: 40,
  anchorDeviationMinutes: 0,
  hardErrors: [],
  explanation: "Logged.",
  status: "completed",
  version: 3
};

async function run(
  argv: string[],
  changeset: (call: RecordedCall) => { status?: number; body: unknown } = okChangeset,
  journal?: Journal,
  state: Record<string, unknown> = {}
): Promise<Run> {
  const calls: RecordedCall[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const fetchImpl = fakeFetch(
    {
      "/api/state": { body: { state: { ...fixtureRawState(), ...state } } },
      "/api/sleep-log": { body: { sleepPlans: [lastNight] } },
      "/api/commands/changeset": changeset
    },
    calls
  );
  const exitCode = await runCli(["changeset", ...argv], {
    ...(journal ? { journal } : {}),
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    env: {},
    readConfigFile: () => null,
    now: () => fixtureNow,
    fetchImpl
  });
  let json: Record<string, unknown> | undefined;
  try {
    json = JSON.parse(out.join("\n"));
  } catch {
    json = undefined;
  }
  return { exitCode, stderr: err.join("\n"), calls, json };
}

/** The changeset a run sent to be previewed or applied (not a replay lookup). */
const sent = (result: Run) =>
  result.calls.find((call) => call.url.endsWith("/api/commands/changeset") && !(call.body as ChangesetCommand).replay)
    ?.body as ChangesetCommand | undefined;

const message = JSON.stringify([
  {
    op: "complete",
    kind: "action",
    id: "action-draft",
    at: "2026-09-01T18:00:00+10:00",
    evidence: "drafted it Monday"
  },
  {
    op: "create",
    kind: "action",
    ref: "mum",
    fields: { title: "Call mum", projectId: "project-garden" },
    question: "Sunday afternoon clashes with the shift"
  },
  { op: "update", kind: "action", id: "@mum", fields: { expectedMinutes: 45 } },
  { op: "update", kind: "commitment", id: "commitment-dentist", fields: { title: "Dentist (moved)" } }
]);

describe("changeset: building", () => {
  it("sends one preview holding one command per record, refs resolved and folded", async () => {
    const result = await run(["preview", "--changes", message, "--command-id", "0b0e3c58-55a1-4f53-9a51-2d0a0f8f3c11"]);
    expect(result.exitCode).toBe(EXIT.ok);
    const body = sent(result)!;
    expect(body.mode).toBe("preview");
    expect(body.commandId).toBe("0b0e3c58-55a1-4f53-9a51-2d0a0f8f3c11");
    expect(body.items.map((item) => [item.intent, item.path])).toEqual([
      [0, "/api/commands/action"],
      [1, "/api/commands/action"],
      [3, "/api/commands/entity"]
    ]);
    const [done, created] = body.items as unknown as [
      { payload: { action: Record<string, unknown> }; evidence?: string },
      { payload: { action: Record<string, unknown>; expectedVersion: null }; creates?: { kind: string; id: string } }
    ];
    expect(done.payload.action).toMatchObject({
      id: "action-draft",
      status: "done",
      completedAt: "2026-09-01T18:00:00+10:00"
    });
    expect(done.evidence).toBe("drafted it Monday");
    // The create and the update of its ref are one create, with the id the ref names.
    expect(created.payload.expectedVersion).toBeNull();
    expect(created.payload.action).toMatchObject({ title: "Call mum", expectedMinutes: 45 });
    expect(created.creates).toEqual({ kind: "action", id: created.payload.action.id });
    expect(String(created.payload.action.id)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-/);

    const intents = result.json!.intents as Record<string, unknown>[];
    expect(intents.map((entry) => entry.intents)).toEqual([[0], [1, 2], [3]]);
    expect(intents[1]).toMatchObject({
      op: "create",
      outcome: "applies",
      question: "Sunday afternoon clashes with the shift"
    });
    // Filled in from the estimate given, with no range of its own: the expected 45.
    expect((intents[1]!.assumed as Record<string, unknown>).optimisticMinutes).toBe(45);
    expect(intents[1]!.assumed).not.toHaveProperty("assumedFields");
    expect(intents[3 - 1]!.changes).toEqual({ title: { before: "Dentist", after: "Dentist (moved)" } });
    expect(Object.keys(result.json!).filter((key) => key.startsWith("checkWith"))).toEqual(["checkWithOwner"]);
    expect(result.json!.checkWithOwner).toEqual({
      needed: true,
      why: ["intent 1+2 has a question: Sunday afternoon clashes with the shift"]
    });
    expect(result.json!.apply).toEqual({
      "command-id": "0b0e3c58-55a1-4f53-9a51-2d0a0f8f3c11",
      expect: result.json!.previewHash
    });
  });

  it("names the same records and hash in a preview and its apply", async () => {
    const setId = "1c4c2a8e-7a0e-4b1b-8c7e-9d2f8c7b6a51";
    const preview = await run(["preview", "--changes", message, "--command-id", setId]);
    const apply = await run([
      "apply",
      "--changes",
      message,
      "--command-id",
      setId,
      "--expect",
      String(preview.json!.previewHash)
    ]);
    expect(apply.exitCode).toBe(EXIT.ok);
    expect(sent(apply)!.items.map((item) => item.payload)).toEqual(sent(preview)!.items.map((item) => item.payload));
    expect(apply.json).toMatchObject({ mode: "apply", ok: true, changesetId: setId });
  });

  it("refuses an apply whose commands differ from the preview it names", async () => {
    const result = await run(["apply", "--changes", message, "--expect", "0000000000000000"]);
    expect(result.exitCode).toBe(EXIT.conflict);
    expect(result.stderr).toContain("Preview again");
    expect(sent(result)).toBeUndefined();
  });

  it("journals an applied changeset as one undo entry", async () => {
    const journal = memoryJournal();
    const result = await run(["apply", "--changes", message], okChangeset, journal);
    expect(result.exitCode).toBe(EXIT.ok);
    const entries = journal.read();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.undo).toMatchObject({
      path: "/api/commands/revert",
      payload: { target: sent(result)!.commandId, direction: "undo" }
    });
  });

  it("reports an intent its tool refuses, and applies nothing while one is refused", async () => {
    const bad = JSON.stringify([
      { op: "update", kind: "action", id: "action-draft", fields: { colour: "red" } },
      { op: "create", kind: "capture", fields: { text: "Rego runs out 9 Nov" } }
    ]);
    const preview = await run(["preview", "--changes", bad]);
    const intents = preview.json!.intents as Record<string, unknown>[];
    expect(intents[0]).toMatchObject({ outcome: "invalid" });
    expect(String(intents[0]!.message)).toContain('no field "colour"');
    expect(intents[1]).toMatchObject({ outcome: "applies" });
    expect(sent(preview)!.items).toHaveLength(1);

    const apply = await run(["apply", "--changes", bad]);
    expect(apply.exitCode).toBe(EXIT.validation);
    expect(sent(apply)).toBeUndefined();
  });

  it("refuses a ref no create names, and an update without an id", async () => {
    const unknownRef = await run([
      "preview",
      "--changes",
      JSON.stringify([{ op: "update", kind: "action", id: "@nope", fields: {} }])
    ]);
    expect(unknownRef.exitCode).toBe(EXIT.validation);
    expect(unknownRef.stderr).toContain("@nope");
    const noId = await run([
      "preview",
      "--changes",
      JSON.stringify([{ op: "update", kind: "action", fields: { title: "x" } }])
    ]);
    expect(noId.exitCode).toBe(EXIT.validation);
    expect(noId.stderr).toContain("needs the id");
  });

  it("keeps a comparison out of a changeset: it answers one group on its own route", async () => {
    const result = await run([
      "preview",
      "--changes",
      JSON.stringify([{ op: "create", kind: "comparison", fields: { groupId: "g-1", tie: true } }])
    ]);
    expect(result.exitCode).toBe(EXIT.validation);
    expect(result.stderr).toContain("is not part of a changeset");
    expect(result.stderr).toContain("rhen_save");
    for (const part of ['"entityType":"comparison"', "groupId", "rankedIds", "tie", "wording", "basis", "evidence"])
      expect(result.stderr, part).toContain(part);
  });
});

describe("changeset: answers to review", () => {
  it("names a recurring action's new recurrence and windows the same in a preview and its apply", async () => {
    const yoga = JSON.stringify([
      {
        op: "create",
        kind: "action",
        fields: {
          title: "Yoga",
          projectId: "project-thesis",
          schedulingMode: "recurring",
          recurrence: {
            timezone: "Australia/Sydney",
            startDate: "2026-09-10",
            intervalDays: 1,
            windows: [{ name: "Morning", anchor: "local_time", localStartTime: "07:00", localEndTime: "08:00" }]
          }
        }
      }
    ]);
    const setId = "3e7b9c1d-2f4a-4b6c-8d0e-1f2a3b4c5d6e";
    const preview = await run(["preview", "--changes", yoga, "--command-id", setId]);
    expect(preview.exitCode).toBe(EXIT.ok);
    const again = await run(["preview", "--changes", yoga, "--command-id", setId]);
    expect(again.json!.previewHash).toBe(preview.json!.previewHash);
    const recurrence = (sent(preview)!.items[0]!.payload.action as { recurrence: Record<string, unknown> }).recurrence;
    expect(String(recurrence.id)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5/);
    expect(String((recurrence.windows as Record<string, unknown>[])[0]!.id)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5/);
  });

  it("lets a later intent name an earlier create as a prerequisite", async () => {
    const result = await run([
      "preview",
      "--changes",
      JSON.stringify([
        { op: "create", kind: "project", ref: "move", fields: { title: "Move house", outcomeId: "outcome-thesis" } },
        {
          op: "create",
          kind: "action",
          fields: {
            title: "Book the van",
            projectId: "project-thesis",
            prerequisites: [{ kind: "project", id: "@move" }]
          }
        }
      ])
    ]);
    const intents = result.json!.intents as Record<string, unknown>[];
    expect(intents.map((entry) => entry.outcome)).toEqual(["applies", "applies"]);
  });

  it("folds two settings intents into one write, and refuses settings beside where he is", async () => {
    const folded = await run([
      "preview",
      "--changes",
      JSON.stringify([
        { op: "update", kind: "settings", fields: { sessionBreakMinutes: 10 } },
        { op: "update", kind: "settings", fields: { startByWarningMinutes: 20 } }
      ])
    ]);
    expect(sent(folded)!.items).toHaveLength(1);
    expect(sent(folded)!.items[0]!.payload.entity).toMatchObject({
      sessionBreakMinutes: 10,
      startByWarningMinutes: 20
    });
    const shared = await run([
      "preview",
      "--changes",
      JSON.stringify([
        { op: "update", kind: "settings", fields: { sessionBreakMinutes: 10 } },
        { op: "update", kind: "current_availability", fields: { currentEnergy: "low" } }
      ])
    ]);
    expect(shared.exitCode).toBe(EXIT.validation);
    expect(shared.stderr).toContain("one stored record");
  });

  it("keeps two days' plans apart, and merges two intents on one nested object rather than replacing it", async () => {
    const days = await run([
      "preview",
      "--changes",
      JSON.stringify([
        { op: "update", kind: "daily_plan", fields: { localDate: "2026-10-28", recoverySkipped: true } },
        { op: "update", kind: "daily_plan", fields: { localDate: "2026-10-29", recoverySkipped: true } },
        { op: "update", kind: "daily_plan", fields: { localDate: "2026-10-28", desiredActionIds: [] } }
      ])
    ]);
    expect(sent(days)!.items.map((item) => (item.payload.entity as { localDate: string }).localDate)).toEqual([
      "2026-10-28",
      "2026-10-29"
    ]);
    expect(sent(days)!.items[0]!.payload.entity).toMatchObject({ recoverySkipped: true, desiredActionIds: [] });
    const place = await run([
      "preview",
      "--changes",
      JSON.stringify([
        { op: "update", kind: "current_availability", fields: { currentSituation: { locationId: "ctx-gym" } } },
        { op: "update", kind: "current_availability", fields: { currentSituation: { transportModes: ["walk"] } } }
      ])
    ]);
    expect(sent(place)!.items).toHaveLength(1);
    expect(sent(place)!.items[0]!.payload.entity).toMatchObject({
      currentSituation: { locationId: "ctx-gym", transportModes: ["walk"] }
    });
  });

  it("keeps a place before the arrival that names it, and moves only a sleep log after the preferences row", async () => {
    const result = await run([
      "preview",
      "--changes",
      JSON.stringify([
        {
          op: "update",
          kind: "sleep_log_entry",
          fields: { sleepAt: "2026-10-27T22:30:00+11:00", wakeAt: "2026-10-28T06:30:00+11:00" }
        },
        { op: "create", kind: "place", ref: "pool", fields: { name: "Pool", kind: "location" } },
        { op: "update", kind: "current_availability", fields: { currentSituation: { locationId: "@pool" } } }
      ])
    ]);
    const entities = sent(result)!.items.map((item) => item.payload.entityType);
    expect(entities).toEqual(["condition_definition", "current_availability", "sleep_log_entry"]);
  });

  it("answers a retried apply from what already landed, though the plan it changed now hashes differently", async () => {
    const setId = "4a5b6c7d-8e9f-4a0b-9c1d-2e3f4a5b6c7d";
    const landed: ChangesetResult = {
      mode: "apply",
      ok: true,
      changesetId: setId,
      items: [{ intent: 0, outcome: "applies", commandId: "c0ffee00-0000-4000-8000-000000000001", undoable: true }]
    };
    const journal = memoryJournal();
    const portal = (call: RecordedCall) =>
      (call.body as { replay?: boolean }).replay
        ? { body: { result: landed, revertible: setId } }
        : { body: { error: "should not apply again" } };
    const result = await run(
      ["apply", "--changes", message, "--command-id", setId, "--expect", "0000000000000000"],
      portal,
      journal
    );
    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.json).toMatchObject({ ok: true, replayed: true, changesetId: setId });
    expect(sent(result)).toBeUndefined();
    expect(result.calls.find((call) => call.url.endsWith("/api/commands/changeset"))?.body).toMatchObject({
      commandId: setId,
      replay: true,
      items: []
    });
    expect(journal.read()).toHaveLength(1);

    const none = await run(
      ["apply", "--changes", message, "--command-id", setId, "--expect", "0000000000000000"],
      () => ({ status: 404, body: { error: "No changeset was applied under that command id, so nothing landed." } })
    );
    expect(none.exitCode).toBe(EXIT.conflict);
    expect(none.stderr).toContain("Preview again");
  });
});

describe("changeset: what happened, and repeating commitments", () => {
  const observed = JSON.stringify([
    {
      op: "observe",
      kind: "sleep",
      fields: { sleepAt: "2026-09-02T23:40:00+10:00", wakeAt: "2026-09-03T07:30:00+10:00" },
      evidence: "bed at 11:40, up at 7:30"
    },
    { op: "observe", kind: "session", fields: { outcome: "progress", remaining: 40 }, at: "2026-09-03T09:20:00+10:00" },
    { op: "update", kind: "action", id: "action-draft", fields: { notes: "Chapter 3 half drafted" } },
    { op: "observe", kind: "place", fields: { place: "Gym" } },
    { op: "observe", kind: "energy", fields: { energy: "low" } }
  ]);

  it("corrects the logged night, finishes the session, and records place and energy as one write, before the night", async () => {
    const result = await run(["preview", "--changes", observed], okChangeset, undefined, fixtureActiveSession());
    expect(result.exitCode).toBe(EXIT.ok);
    const items = sent(result)!.items;
    // The night moves to just after where he is (it moves the preferences row's version), and the session goes last.
    expect(items.map((item) => [item.intent, item.path])).toEqual([
      [2, "/api/commands/action"],
      [3, "/api/commands/entity"],
      [0, "/api/commands/entity"],
      [1, "/api/commands/session"]
    ]);
    const [, situation, night, session] = items.map((item) => item.payload) as Record<string, unknown>[];
    expect(situation).toMatchObject({
      entityType: "current_availability",
      entity: { currentEnergy: "low", currentSituation: { locationId: "ctx-gym" } }
    });
    // The night already logged is corrected in place, not logged twice.
    expect(night).toMatchObject({
      entityType: "sleep_log_entry",
      expectedVersion: 3,
      entity: { id: "sleep-last-night", sleepAt: "2026-09-02T23:40:00+10:00", wakeAt: "2026-09-03T07:30:00+10:00" }
    });
    expect(items[2]!.evidence).toBe("bed at 11:40, up at 7:30");
    expect(session).toMatchObject({
      type: "finish",
      sessionId: fixtureActiveSessionId,
      outcome: "progress",
      remainingMinutes: 40,
      endedAt: "2026-09-03T09:20:00+10:00"
    });

    const intents = result.json!.intents as Record<string, unknown>[];
    expect(intents[1]).toMatchObject({
      intents: [3, 4],
      op: "observe",
      kind: "place",
      changes: {
        currentSituation: { before: { locationId: "ctx-home" }, after: { locationId: "ctx-gym" } },
        currentEnergy: { before: "high", after: "low" }
      }
    });
    expect(intents[2]).toMatchObject({
      kind: "sleep",
      id: "sleep-last-night",
      changes: {
        sleepAt: { before: "2026-09-02T23:00:00+10:00", after: "2026-09-02T23:40:00+10:00" },
        wakeAt: { before: "2026-09-03T06:20:00+10:00", after: "2026-09-03T07:30:00+10:00" }
      }
    });
  });

  it("logs a night nothing overlaps as a new one, and still sends a place he is already at, which dates it afresh", async () => {
    const result = await run([
      "preview",
      "--changes",
      JSON.stringify([
        {
          op: "observe",
          kind: "sleep",
          fields: { sleepAt: "2026-08-20T23:00:00+10:00", wakeAt: "2026-08-21T07:00:00+10:00" }
        },
        { op: "observe", kind: "place", fields: { place: "Home" } }
      ])
    ]);
    expect(result.exitCode).toBe(EXIT.ok);
    const items = sent(result)!.items;
    expect(items).toHaveLength(2);
    const night = items.find((item) => item.payload.entityType === "sleep_log_entry")!;
    expect(night.payload).toMatchObject({ expectedVersion: null });
    expect((night.payload.entity as Record<string, unknown>).id).toBeUndefined();
    const where = items.find((item) => item.payload.entityType === "current_availability")!;
    expect(where.payload.entity).toMatchObject({ currentSituation: { locationId: "ctx-home" } });
  });

  it("sends an energy that matches the stored one as said now", async () => {
    const result = await run([
      "preview",
      "--changes",
      JSON.stringify([{ op: "observe", kind: "energy", fields: { energy: "medium" } }])
    ]);
    expect(result.exitCode).toBe(EXIT.ok);
    expect(sent(result)!.items[0]!.payload.entity).toMatchObject({ currentEnergy: "medium", energyAsserted: true });
  });

  it("observes a place the same changeset creates, by its ref", async () => {
    const result = await run([
      "preview",
      "--changes",
      JSON.stringify([
        { op: "create", kind: "place", ref: "pool", fields: { name: "Pool", kind: "location" } },
        { op: "observe", kind: "place", fields: { place: "@pool" } }
      ])
    ]);
    expect(result.exitCode).toBe(EXIT.ok);
    const [place, where] = sent(result)!.items.map((item) => item.payload.entity) as Record<string, unknown>[];
    expect(where).toMatchObject({ currentSituation: { locationId: place!.id } });
  });

  it("finishes the running session once when two intents report it", async () => {
    const result = await run(
      [
        "preview",
        "--changes",
        JSON.stringify([
          { op: "observe", kind: "session", fields: { outcome: "progress", remaining: 40 } },
          { op: "observe", kind: "session", fields: { note: "Stopped for lunch" } }
        ])
      ],
      okChangeset,
      undefined,
      fixtureActiveSession()
    );
    const items = sent(result)!.items;
    expect(items).toHaveLength(1);
    expect(items[0]!.payload).toMatchObject({ outcome: "progress", note: "Stopped for lunch" });
    expect((result.json!.intents as Record<string, unknown>[])[0]).toMatchObject({ intents: [0, 1] });
  });

  it("refuses an observe it cannot place: an unknown field, a place not saved, no session running", async () => {
    const field = await run([
      "preview",
      "--changes",
      JSON.stringify([{ op: "observe", kind: "energy", fields: { energy: "low", mood: "flat" } }])
    ]);
    expect(field.exitCode).toBe(EXIT.validation);
    expect(field.stderr).toContain("not mood");
    const place = await run([
      "preview",
      "--changes",
      JSON.stringify([
        { op: "observe", kind: "place", fields: { place: "Moon" } },
        { op: "observe", kind: "sleep", fields: { sleepAt: "2026-08-20T23:00:00+10:00" } }
      ])
    ]);
    // A place not saved refuses that intent alone; the rest of the preview still runs.
    expect(place.exitCode).toBe(EXIT.ok);
    const placed = place.json!.intents as Record<string, unknown>[];
    expect(placed.find((entry) => entry.kind === "place")).toMatchObject({ outcome: "invalid" });
    expect(placed.find((entry) => entry.kind === "place")!.message).toContain("Moon");
    const session = await run([
      "preview",
      "--changes",
      JSON.stringify([{ op: "observe", kind: "session", fields: { outcome: "completed" } }])
    ]);
    const intents = session.json!.intents as Record<string, unknown>[];
    expect(intents[0]).toMatchObject({ kind: "session", outcome: "invalid" });
    expect(sent(session)).toBeUndefined();
  });

  const gym = JSON.stringify([
    {
      op: "create",
      kind: "commitment_rule",
      fields: {
        title: "Gym",
        timezone: "Australia/Sydney",
        startDate: "2026-09-08",
        repeat: { unit: "weeks", intervalWeeks: 1, weekdays: [2, 4] },
        localStartTime: "18:00",
        localEndTime: "19:00",
        setupBeforeMinutes: 0,
        transitionAfterMinutes: 0
      }
    },
    { op: "update", kind: "commitment_rule", id: "rule-gym", fields: { localEndTime: "18:30" } }
  ]);

  it("creates a repeating commitment with a stable id, flags a rule of the same name, and updates a stored rule", async () => {
    const setId = "2d6a1f0e-3b4c-4d5e-8f60-718293a4b5c6";
    const preview = await run(["preview", "--changes", gym, "--command-id", setId]);
    expect(preview.exitCode).toBe(EXIT.ok);
    const items = sent(preview)!.items;
    expect(items.map((item) => item.path)).toEqual([
      "/api/commands/commitment-recurrence",
      "/api/commands/commitment-recurrence"
    ]);
    const created = items[0]!.payload as { rule: Record<string, unknown>; expectedVersion: unknown };
    expect(created.expectedVersion).toBeNull();
    expect(created.rule).toMatchObject({ title: "Gym", repeat: { unit: "weeks", weekdays: [2, 4] } });
    const intents = preview.json!.intents as Record<string, unknown>[];
    expect(intents[0]).toMatchObject({
      kind: "commitment rule",
      op: "create",
      likelyDuplicates: [{ kind: "commitment-rule", id: "rule-gym", title: "Gym" }]
    });
    expect(intents[1]).toMatchObject({ changes: { localEndTime: { before: "18:00", after: "18:30" } } });

    const apply = await run([
      "apply",
      "--changes",
      gym,
      "--command-id",
      setId,
      "--expect",
      String(preview.json!.previewHash),
      "--wait",
      "0"
    ]);
    expect(apply.exitCode).toBe(EXIT.ok);
    expect(sent(apply)!.items.map((item) => item.payload.rule)).toEqual(items.map((item) => item.payload.rule));
    // The apply answers with what Now says after it.
    expect(apply.json!.now).toMatchObject({ plan: expect.any(String), next: expect.any(Array) });
  });

  it("refuses to complete a rule, and an update of a rule that does not exist", async () => {
    const complete = await run([
      "preview",
      "--changes",
      JSON.stringify([{ op: "complete", kind: "commitment_rule", id: "rule-gym" }])
    ]);
    expect(complete.exitCode).toBe(EXIT.validation);
    expect(complete.stderr).toContain("not completed");
    const missing = await run([
      "preview",
      "--changes",
      JSON.stringify([{ op: "update", kind: "commitment_rule", id: "rule-swim", fields: { title: "Swim" } }])
    ]);
    expect(missing.exitCode).toBe(EXIT.validation);
    expect(missing.stderr).toContain("rule-swim");
  });
});

describe("assumedFields", () => {
  it("lists what the create carries that the agent did not give", () => {
    expect(assumedFields({ title: "Call mum" }, { id: "x", title: "Call mum", expectedMinutes: 60 })).toEqual({
      expectedMinutes: 60
    });
  });
});
