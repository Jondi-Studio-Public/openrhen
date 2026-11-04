import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { findEntityType, reverseOfCreate } from "../src/commands/save.js";
import type { PortalState } from "../src/client.js";
import { EXIT } from "../src/errors.js";
import { JOURNAL_LIMIT, currentVersion, memoryJournal, recordWrite, type Journal } from "../src/undo-journal.js";
import { fakeFetch, type RecordedCall } from "./fake-fetch.js";
import { fixtureActiveSession, fixtureNow, fixtureRawState } from "./fixture-state.js";

interface Run {
  exitCode: number;
  stdout: string;
  stderr: string;
  calls: RecordedCall[];
}

/**
 * A stand-in for the portal that keeps state: every routine step carries a version, a command is refused with
 * a 409 when its `expectedVersion` is not the stored one (like the real command handlers), and every applied
 * command bumps the version. That is what lets a test edit a record "elsewhere" between a write and its undo.
 */
function statefulPortal(base: Record<string, unknown> = fixtureRawState()) {
  const raw: Record<string, unknown> = {
    ...base,
    routineSteps: (base.routineSteps as Record<string, unknown>[]).map((step) => ({ ...step, version: 3 }))
  };
  const steps = () => raw.routineSteps as Record<string, unknown>[];
  const step = (id: string) => steps().find((item) => item.id === id)!;
  /** Runs once, just before the next command is checked: an edit that lands between the CLI's read and its write. */
  let beforeNextCommand: (() => void) | undefined;
  /** Runs once, just after the next command commits and before its answer reads the state back. */
  let afterNextCommit: (() => void) | undefined;
  const commands = (call: { body: unknown }) => {
    beforeNextCommand?.();
    beforeNextCommand = undefined;
    const body = call.body as Record<string, unknown>;
    const entity = body.entity as Record<string, unknown> | undefined;
    const target = step(String(body.stepId ?? entity?.id));
    if (body.expectedVersion !== target.version)
      return { status: 409, body: { error: "This record changed elsewhere. Reload before saving." } };
    if (body.type === "skip_routine_step") target.status = "skipped";
    else if (body.type === "reopen_routine_step") target.status = "pending";
    else if (entity) Object.assign(target, entity, { version: target.version });
    target.version = (target.version as number) + 1;
    afterNextCommit?.();
    afterNextCommit = undefined;
    return { body: { state: raw } };
  };
  return {
    raw,
    step,
    /** Someone else edits the step (the portal, another tool): its version moves on. */
    edit(id: string, fields: Record<string, unknown>) {
      Object.assign(step(id), fields, { version: (step(id).version as number) + 1 });
    },
    editBeforeNextCommand(callback: () => void) {
      beforeNextCommand = callback;
    },
    editAfterNextCommit(callback: () => void) {
      afterNextCommit = callback;
    },
    routes: {
      "/api/state": () => ({ body: { state: raw } }),
      "/api/commands/activity": commands,
      "/api/commands/entity": commands
    }
  };
}

async function run(
  argv: string[],
  journal: Journal,
  raw: Record<string, unknown> = fixtureRawState(),
  options: { routes?: Parameters<typeof fakeFetch>[0]; env?: Record<string, string>; byOwner?: boolean } = {}
): Promise<Run> {
  const calls: RecordedCall[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const exitCode = await runCli(argv, {
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    env: options.env ?? {},
    readConfigFile: () => null,
    now: () => fixtureNow,
    journal,
    byOwner: options.byOwner,
    fetchImpl: fakeFetch(
      options.routes ?? {
        "/api/state": { body: { state: raw } },
        "/api/commands/activity": { body: { state: raw } },
        "/api/commands/entity": { body: { state: raw } }
      },
      calls
    )
  });
  return { exitCode, stdout: out.join("\n"), stderr: err.join("\n"), calls };
}

const posts = (calls: RecordedCall[]) => calls.filter((call) => call.method === "POST");
const sentBody = (calls: RecordedCall[]) => (posts(calls)[0]?.body ?? {}) as Record<string, unknown>;

/**
 * A portal that creates what it is sent and keeps it: a record is keyed like the real handlers key it (the
 * entity's id, else the command id; a non-uuid id is hashed to a uuid), starts at version 1, and a command
 * whose `expectedVersion` is not the stored one is refused with a 409.
 */
function createPortal() {
  const raw: Record<string, unknown> = { ...fixtureRawState(), commitments: [], routinePresets: [], spans: [] };
  const hash = (id: string) =>
    /^[0-9a-f]{8}-/.test(id) ? id : `00000000-0000-4000-8000-${String(id.length).padStart(12, "0")}`;
  const rows = (key: string): Record<string, unknown>[] => (raw[key] ??= []) as Record<string, unknown>[];
  const command = (stateKey: string, wrapper: string) => (call: { body: unknown }) => {
    const body = call.body as Record<string, unknown>;
    const entity = body[wrapper] as Record<string, unknown>;
    const id = hash(typeof entity.id === "string" ? entity.id : String(body.commandId));
    const list = rows(stateKey);
    const found = list.find((row) => row.id === id);
    if (entity.remove === true) {
      if (found) list.splice(list.indexOf(found), 1);
    } else if (!found) {
      if (body.expectedVersion !== null)
        return { status: 409, body: { error: "This record no longer exists. Reload before saving." } };
      list.push({ ...entity, id, version: 1 });
    } else {
      if (body.expectedVersion !== found.version)
        return { status: 409, body: { error: "This record changed elsewhere. Reload before saving." } };
      Object.assign(found, entity, { id, version: (found.version as number) + 1 });
    }
    return { body: { state: raw } };
  };
  /** The close route: archive or cancel one row (remembering where it came from), or put it back; versions as the portal bumps them. */
  const close = (call: { body: unknown }) => {
    const body = call.body as Record<string, unknown>;
    const keys: Record<string, string> = { area: "areas", outcome: "outcomes", project: "projects", action: "actions" };
    const found = rows(keys[String(body.type)] ?? "none").find((row) => row.id === hash(String(body.id)));
    if (!found) return { status: 404, body: { error: "No such row." } };
    if (body.expectedVersion !== null && body.expectedVersion !== found.version)
      return { status: 409, body: { error: "This record changed elsewhere. Reload before saving." } };
    if (body.do === "close") {
      found.closedFrom = found.status;
      found.status = body.verb === "archive" ? "archived" : "cancelled";
    } else found.status = found.closedFrom ?? "active";
    found.version = (found.version as number) + 1;
    return { body: { state: raw, closed: { version: found.version, status: found.status } } };
  };
  const stateKeys: Record<string, string> = {
    capture: "captures",
    area: "areas",
    commitment: "commitments",
    span: "spans"
  };
  return {
    raw,
    rows,
    routes: {
      "/api/state": () => ({ body: { state: raw } }),
      "/api/commands/entity": (call: { body: unknown }) =>
        command(stateKeys[(call.body as { entityType: string }).entityType] ?? "planningFocus", "entity")(call),
      "/api/commands/project": command("projects", "project"),
      "/api/commands/action": command("actions", "action"),
      "/api/commands/close": close
    }
  };
}

describe("undo and redo", () => {
  it("has nothing to undo on an empty journal", async () => {
    const { exitCode } = await run(["undo"], memoryJournal());
    expect(exitCode).toBe(EXIT.notFound);
    expect((await run(["undo", "--redo"], memoryJournal())).exitCode).toBe(EXIT.notFound);
  });

  it("records a skip, undoes it, redoes it, and refuses redo after a new write", async () => {
    const journal = memoryJournal();
    const portal = statefulPortal();
    const go = (argv: string[]) => run(argv, journal, portal.raw, { routes: portal.routes });
    const skipped = await go(["activity", "skip-step", "--step", "step-pack"]);
    expect(skipped.exitCode).toBe(EXIT.ok);
    expect(skipped.stderr).toContain("rhen undo");
    expect(journal.read()).toHaveLength(1);

    const undone = await go(["undo"]);
    expect(undone.exitCode).toBe(EXIT.ok);
    const undoPost = posts(undone.calls)[0]?.body as Record<string, unknown>;
    expect(undoPost.type).toBe("reopen_routine_step");
    expect(undoPost.stepId).toBe("step-pack");
    expect(journal.read()[0]?.status).toBe("undone");
    expect((await go(["undo"])).exitCode).toBe(EXIT.notFound);

    const redone = await go(["undo", "--redo"]);
    expect(redone.exitCode).toBe(EXIT.ok);
    expect(((posts(redone.calls)[0]?.body ?? {}) as Record<string, unknown>).type).toBe("skip_routine_step");
    expect(journal.read()[0]?.status).toBe("applied");

    await go(["undo"]);
    await go(["activity", "skip-step", "--step", "step-shower"]);
    expect(journal.read().map((entry) => entry.status)).toEqual(["superseded", "applied"]);
    expect((await go(["undo", "--redo"])).exitCode).toBe(EXIT.notFound);
  });

  it("records no restating entry, and promises no undo, in a journal that keeps only server-checked ones", async () => {
    const journal: Journal = { ...memoryJournal(), serverCheckedOnly: true };
    const raw = fixtureRawState();
    const step = (raw.routineSteps as Record<string, unknown>[])[0]!;
    const saved = await run(
      ["save", "routine-step", "--id", String(step.id), "--set", "title=Changed title"],
      journal,
      raw
    );
    expect(saved.exitCode).toBe(EXIT.ok);
    expect(journal.read()).toEqual([]);
    expect(saved.stderr).not.toContain("rhen undo");
  });

  it("undoes a save by restoring the stored record", async () => {
    const journal = memoryJournal();
    const raw = fixtureRawState();
    const step = (raw.routineSteps as Record<string, unknown>[])[0]!;
    const saved = await run(
      ["save", "routine-step", "--id", String(step.id), "--set", "title=Changed title"],
      journal,
      raw
    );
    expect(saved.exitCode).toBe(EXIT.ok);
    const entry = journal.read()[0];
    expect(entry).toBeDefined();
    expect(((entry as NonNullable<typeof entry>).undo.payload.entity as Record<string, unknown>).title).toBe(
      step.title
    );
    expect(((entry as NonNullable<typeof entry>).redo.payload.entity as Record<string, unknown>).title).toBe(
      "Changed title"
    );
  });

  it("records when the person woke on its own, and undoes it to the time it was", async () => {
    const journal = memoryJournal();
    const raw = fixtureRawState();
    raw.settings = { ...(raw.settings as Record<string, unknown>), lastWokeAt: "2026-10-06T22:00:00.000Z" };
    const saved = await run(["save", "settings", "--set", "lastWokeAt=2026-10-27T20:30:00.000Z"], journal, raw);
    expect(saved.exitCode).toBe(EXIT.ok);
    // Only the wake time is sent, never the preferences an agent may not touch.
    expect(sentBody(saved.calls).entity).toEqual({ lastWokeAt: "2026-10-27T20:30:00.000Z" });
    const entry = journal.read()[0]!;
    expect(entry.undo.payload.entity).toEqual({ lastWokeAt: "2026-10-06T22:00:00.000Z" });
    expect(entry.redo.payload.entity).toEqual({ lastWokeAt: "2026-10-27T20:30:00.000Z" });
    expect(entry.target).toEqual({ stateKey: "settings" });

    // Any other settings change also sends only what it names, never the owner-only fields, so a proposal of
    // it can be confirmed; its undo restates just those fields.
    const otherJournal = memoryJournal();
    const other = await run(["save", "settings", "--set", "desiredSleepMinutes=420"], otherJournal, raw);
    expect(sentBody(other.calls).entity).toEqual({ desiredSleepMinutes: 420 });
    expect(otherJournal.read()[0]!.undo.payload.entity).toEqual({
      desiredSleepMinutes: (raw.settings as Record<string, unknown>).desiredSleepMinutes
    });
  });

  it("keeps the stored siblings of a dotted settings field", async () => {
    const raw = fixtureRawState();
    const meanings = (raw.settings as Record<string, unknown>).energyMeanings as Record<string, unknown>;
    expect(Object.keys(meanings).length).toBeGreaterThan(1);
    const journal = memoryJournal();
    const saved = await run(["save", "settings", "--set", "energyMeanings.high=Fresh and sharp"], journal, raw);
    expect(saved.exitCode, saved.stderr).toBe(EXIT.ok);
    expect(sentBody(saved.calls).entity).toEqual({ energyMeanings: { ...meanings, high: "Fresh and sharp" } });
    expect(journal.read()[0]!.undo.payload.entity).toEqual({ energyMeanings: meanings });
  });

  it("clears a settings field that was unset when the save is undone", async () => {
    const raw = fixtureRawState();
    delete (raw.settings as Record<string, unknown>).homeLocationId;
    const journal = memoryJournal();
    const saved = await run(["save", "settings", "--set", "homeLocationId=ctx-home"], journal, raw);
    expect(saved.exitCode, saved.stderr).toBe(EXIT.ok);
    expect(sentBody(saved.calls).entity).toEqual({ homeLocationId: "ctx-home" });
    expect(journal.read()[0]!.undo.payload.entity).toEqual({ homeLocationId: null });
  });

  it("moves a sleep plan with both times when one is given, and undoes only what the save named", async () => {
    const raw = fixtureRawState();
    const night = (raw.sleepPlans as Record<string, unknown>[])[0]!;
    night.version = 2;
    const journal = memoryJournal();
    const moved = await run(
      ["save", "sleep-plan", "--id", "sleep-tonight", "--set", "plannedWakeAt=2026-09-04T07:00:00+10:00"],
      journal,
      raw
    );
    expect(moved.exitCode, moved.stderr).toBe(EXIT.ok);
    expect(sentBody(moved.calls).entity).toEqual({
      id: "sleep-tonight",
      plannedStartAt: night.plannedStartAt,
      plannedWakeAt: "2026-09-04T07:00:00+10:00"
    });
    const entry = journal.read()[0]!;
    expect(entry.undo.payload.entity).toEqual({
      id: "sleep-tonight",
      plannedStartAt: night.plannedStartAt,
      plannedWakeAt: night.plannedWakeAt
    });
    expect(entry.target).toEqual({ stateKey: "sleepPlans", id: "sleep-tonight" });

    // A placement choice is undone to the one it replaced; a first choice has nothing to go back to.
    night.placementChoice = "near";
    const choiceJournal = memoryJournal();
    const chosen = await run(
      ["save", "sleep-plan", "--id", "sleep-tonight", "--set", "placementChoice=early"],
      choiceJournal,
      raw
    );
    expect(sentBody(chosen.calls).entity).toEqual({ id: "sleep-tonight", placementChoice: "early" });
    expect(choiceJournal.read()[0]!.undo.payload.entity).toEqual({ id: "sleep-tonight", placementChoice: "near" });
    delete night.placementChoice;
    const firstJournal = memoryJournal();
    await run(["save", "sleep-plan", "--id", "sleep-tonight", "--set", "placementChoice=early"], firstJournal, raw);
    expect(firstJournal.read()).toHaveLength(0);
  });

  it("does not record a create of a type with no status that hides it", async () => {
    const journal = memoryJournal();
    const portal = createPortal();
    const added = await run(
      [
        "save",
        "planning-focus",
        "--set",
        "kind=week",
        "--set",
        "periodStart=2026-09-07",
        "--set",
        "periodEnd=2026-09-13"
      ],
      journal,
      portal.raw,
      { routes: portal.routes }
    );
    expect(added.exitCode).toBe(EXIT.ok);
    expect(journal.read()).toHaveLength(0);
  });

  it("lists the journal and supports --dry-run", async () => {
    const journal = memoryJournal();
    const portal = statefulPortal();
    const go = (argv: string[]) => run(argv, journal, portal.raw, { routes: portal.routes });
    await go(["activity", "skip-step", "--step", "step-pack"]);
    expect((await go(["undo", "--list"])).stdout).toContain("applied");
    expect((await go(["undo", "--list"])).stdout).toContain("[unlabeled]");
    const dry = await go(["undo", "--dry-run"]);
    expect(posts(dry.calls)).toHaveLength(0);
    expect(journal.read()[0]?.status).toBe("applied");
  });

  it("covers pause, arrive and span writes", async () => {
    const journal = memoryJournal();
    const withSession = { ...fixtureRawState(), ...fixtureActiveSession() };
    await run(["activity", "pause"], journal, withSession);
    await run(["arrive", "ctx-gym"], journal);
    const spans = [{ id: "span-trip", version: 2, title: "Trip", startDate: "2026-09-27", endDate: "2026-09-29" }];
    await run(["span", "set", "span-trip", "--end", "2026-09-30"], journal, { ...fixtureRawState(), spans });
    await run(["span", "add", "--title", "Away", "--start", "2026-10-01"], journal);
    const undoPayloads = journal.read().map((entry) => entry.undo.payload);
    expect(undoPayloads[0]?.type).toBe("resume_activity");
    expect(((undoPayloads[1]?.entity ?? {}) as Record<string, unknown>).currentSituation).toEqual({
      locationId: "ctx-home"
    });
    expect(((undoPayloads[2]?.entity ?? {}) as Record<string, unknown>).endDate).toBe("2026-09-29");
    expect(((undoPayloads[3]?.entity ?? {}) as Record<string, unknown>).remove).toBe(true);
  });
});

describe("undo is guarded by the version the write left (audit L4)", () => {
  const setup = (env: Record<string, string> = {}) => {
    const journal = memoryJournal();
    const portal = statefulPortal();
    const go = (argv: string[], extraEnv: Record<string, string> = env) =>
      run(argv, journal, portal.raw, { routes: portal.routes, env: extraEnv });
    return { journal, portal, go };
  };
  const skip = ["activity", "skip-step", "--step", "step-pack"];

  it("records the post-write version and the owner, and sends the version on undo", async () => {
    const { journal, portal, go } = setup();
    await go(skip);
    expect(journal.read()[0]).toMatchObject({ version: 4, owner: "unlabeled" });
    const undone = await go(["undo"]);
    expect(((posts(undone.calls)[0]?.body ?? {}) as Record<string, unknown>).expectedVersion).toBe(4);
    expect(portal.step("step-pack").status).toBe("pending");
    // The undo bumped the record again; redo must match that version, not the first one.
    expect(journal.read()[0]?.version).toBe(5);
    const redone = await go(["undo", "--redo"]);
    expect(redone.exitCode).toBe(EXIT.ok);
    expect(((posts(redone.calls)[0]?.body ?? {}) as Record<string, unknown>).expectedVersion).toBe(5);
    expect(portal.step("step-pack").status).toBe("skipped");
  });

  it("refuses to undo over an edit made after the write, and changes nothing", async () => {
    const { journal, portal, go } = setup();
    await go(skip);
    // The owner works the step in the portal afterwards.
    portal.edit("step-pack", { status: "completed", title: "Packed and done" });
    const undone = await go(["undo"]);
    expect(undone.exitCode).toBe(EXIT.conflict);
    expect(undone.stderr).toContain("changed since it was written");
    expect(undone.stderr).toContain("Not undone");
    expect(posts(undone.calls)).toHaveLength(0);
    expect(portal.step("step-pack")).toMatchObject({ status: "completed", title: "Packed and done" });
    expect(journal.read()[0]?.status).toBe("applied");
  });

  it("reports a conflict from the portal when the edit lands between the read and the undo", async () => {
    const { journal, portal, go } = setup();
    await go(skip);
    portal.editBeforeNextCommand(() => portal.edit("step-pack", { title: "Edited in the gap" }));
    const undone = await go(["undo"]);
    expect(undone.exitCode).toBe(EXIT.conflict);
    expect(undone.stderr).toContain("Not undone");
    expect(portal.step("step-pack")).toMatchObject({ status: "skipped", title: "Edited in the gap" });
    expect(journal.read()[0]?.status).toBe("applied");
  });

  it("refuses a redo over an edit made after the undo", async () => {
    const { journal, portal, go } = setup();
    await go(skip);
    await go(["undo"]);
    portal.edit("step-pack", { title: "Renamed meanwhile" });
    const redone = await go(["undo", "--redo"]);
    expect(redone.exitCode).toBe(EXIT.conflict);
    expect(redone.stderr).toContain("Not redone");
    expect(journal.read()[0]?.status).toBe("undone");
  });

  it("--force restores over the edit when the person says so", async () => {
    const { journal, portal, go } = setup();
    await go(skip);
    portal.edit("step-pack", { title: "Renamed meanwhile" });
    const undone = await go(["undo", "--force"]);
    expect(undone.exitCode).toBe(EXIT.ok);
    expect(portal.step("step-pack").status).toBe("pending");
    expect(journal.read()[0]?.status).toBe("undone");
  });

  it("repeats undo down the same record without --force: each undo refreshes the next entry's version", async () => {
    const { journal, portal, go } = setup();
    await go(skip);
    await go(["save", "routine-step", "--id", "step-pack", "--set", "title=Changed title"]);
    expect(journal.read().map((entry) => entry.version)).toEqual([4, 5]);

    expect((await go(["undo"])).exitCode).toBe(EXIT.ok);
    expect(portal.step("step-pack").title).not.toBe("Changed title");
    expect(portal.step("step-pack").status).toBe("skipped");
    // The save's undo made version 6; the skip's entry is now guarded by that, not by 4 (or the save's 5).
    expect(journal.read().map((entry) => entry.version)).toEqual([6, 6]);

    const second = await go(["undo"]);
    expect(second.exitCode).toBe(EXIT.ok);
    expect(((posts(second.calls)[0]?.body ?? {}) as Record<string, unknown>).expectedVersion).toBe(6);
    expect(portal.step("step-pack").status).toBe("pending");
    expect(journal.read().map((entry) => entry.status)).toEqual(["undone", "undone"]);
  });

  it("still refuses the second undo when the record was really edited after the first", async () => {
    const { journal, portal, go } = setup();
    await go(skip);
    await go(["save", "routine-step", "--id", "step-pack", "--set", "title=Changed title"]);
    await go(["undo"]);
    portal.edit("step-pack", { notes: "edited in the portal between the two undos" });
    const second = await go(["undo"]);
    expect(second.exitCode).toBe(EXIT.conflict);
    expect(second.stderr).toContain("changed since it was written");
    expect(posts(second.calls)).toHaveLength(0);
    expect(portal.step("step-pack").status).toBe("skipped");
    expect(journal.read().map((entry) => entry.status)).toEqual(["applied", "undone"]);
  });

  it("does not refresh the older entry when someone edited the record between the two writes", async () => {
    const { journal, portal, go } = setup();
    await go(skip);
    // The owner edits the step in the portal after the skip, before the next write.
    portal.edit("step-pack", { notes: "foreign edit between the two writes" });
    await go(["save", "routine-step", "--id", "step-pack", "--set", "title=Changed title"]);
    expect((await go(["undo"])).exitCode).toBe(EXIT.ok);
    expect(portal.step("step-pack")).toMatchObject({ notes: "foreign edit between the two writes", status: "skipped" });
    // Undoing the skip would restore the pre-skip record and wipe the foreign edit, so it is refused.
    const second = await go(["undo"]);
    expect(second.exitCode).toBe(EXIT.conflict);
    expect(second.stderr).toContain("changed since it was written");
    expect(posts(second.calls)).toHaveLength(0);
    expect(portal.step("step-pack")).toMatchObject({ notes: "foreign edit between the two writes", status: "skipped" });
    expect(journal.read().map((entry) => entry.status)).toEqual(["applied", "undone"]);
  });

  it("does not refresh another owner's entry, or any entry after a forced undo", async () => {
    const { journal, go } = setup();
    await go(skip, { OPENRHEN_AGENT: "a" });
    await go(["save", "routine-step", "--id", "step-pack", "--set", "title=Changed title"], { OPENRHEN_AGENT: "b" });
    await go(["undo"], { OPENRHEN_AGENT: "b" });
    expect(journal.read()[0]?.version).toBe(4);

    const forced = setup();
    await forced.go(skip);
    await forced.go(["save", "routine-step", "--id", "step-pack", "--set", "title=Changed title"]);
    await forced.go(["undo", "--force"]);
    // Not refreshed, and no longer trusted at all: a forced move may have deleted or recreated the record.
    expect(forced.journal.read()[0]?.version).toBeUndefined();
  });

  it("does not journal a version that includes an edit made between the commit and the state read", async () => {
    const { journal, portal, go } = setup();
    portal.editAfterNextCommit(() => portal.edit("step-pack", { notes: "edited by another client just after" }));
    expect((await go(skip)).exitCode).toBe(EXIT.ok);
    // The write left version 4, but the answer showed 5: the entry must not claim 5 as the write's own.
    expect(journal.read()[0]?.version).toBeUndefined();
    const undone = await go(["undo"]);
    expect(undone.exitCode).toBe(EXIT.conflict);
    expect(posts(undone.calls)).toHaveLength(0);
    expect(portal.step("step-pack").notes).toBe("edited by another client just after");
    expect(journal.read()[0]?.status).toBe("applied");
    // The person can still choose to overwrite.
    expect((await go(["undo", "--force"])).exitCode).toBe(EXIT.ok);
  });

  it("does not journal the version of a reversal that included another client's edit", async () => {
    const { journal, portal, go } = setup();
    await go(skip);
    portal.editAfterNextCommit(() => portal.edit("step-pack", { notes: "edited just after the undo committed" }));
    expect((await go(["undo"])).exitCode).toBe(EXIT.ok);
    // The undo left version 5; the answer showed 6, so the entry must not claim 6 as the undo's own.
    expect(journal.read()[0]).toMatchObject({ status: "undone" });
    expect(journal.read()[0]?.version).toBeUndefined();
    const redone = await go(["undo", "--redo"]);
    expect(redone.exitCode).toBe(EXIT.conflict);
    expect(redone.stderr).toContain("recorded without the record's version");
    expect(posts(redone.calls)).toHaveLength(0);
    expect(portal.step("step-pack").notes).toBe("edited just after the undo committed");
  });

  it("does not refresh the older entry from a reversal whose version is not provably its own", async () => {
    const { journal, portal, go } = setup();
    await go(skip);
    await go(["save", "routine-step", "--id", "step-pack", "--set", "title=Changed title"]);
    portal.editAfterNextCommit(() => portal.edit("step-pack", { notes: "edited just after the undo committed" }));
    expect((await go(["undo"])).exitCode).toBe(EXIT.ok);
    expect(journal.read()[0]?.version).toBe(4);
    expect((await go(["undo"])).exitCode).toBe(EXIT.conflict);
    expect(portal.step("step-pack").status).toBe("skipped");
  });

  it("keeps the older-entry refresh working after undo, redo, undo of the newest write", async () => {
    const { journal, portal, go } = setup();
    await go(skip);
    await go(["save", "routine-step", "--id", "step-pack", "--set", "title=Changed title"]);
    expect((await go(["undo"])).exitCode).toBe(EXIT.ok);
    expect((await go(["undo", "--redo"])).exitCode).toBe(EXIT.ok);
    expect(portal.step("step-pack").title).toBe("Changed title");
    expect((await go(["undo"])).exitCode).toBe(EXIT.ok);
    expect(journal.read().map((entry) => entry.version)).toEqual([
      portal.step("step-pack").version,
      portal.step("step-pack").version
    ]);
    const second = await go(["undo"]);
    expect(second.exitCode).toBe(EXIT.ok);
    expect(portal.step("step-pack").status).toBe("pending");
  });

  it("still does not refresh across a foreign edit after undo, redo, undo", async () => {
    const { journal, portal, go } = setup();
    await go(skip);
    portal.edit("step-pack", { notes: "foreign edit between the two writes" });
    await go(["save", "routine-step", "--id", "step-pack", "--set", "title=Changed title"]);
    await go(["undo"]);
    await go(["undo", "--redo"]);
    await go(["undo"]);
    const second = await go(["undo"]);
    expect(second.exitCode).toBe(EXIT.conflict);
    expect(posts(second.calls)).toHaveLength(0);
    expect(portal.step("step-pack").notes).toBe("foreign edit between the two writes");
    expect(journal.read().map((entry) => entry.status)).toEqual(["applied", "undone"]);
  });

  it("guards a save the same way", async () => {
    const { journal, portal, go } = setup();
    const saved = await go(["save", "routine-step", "--id", "step-pack", "--set", "title=Changed title"]);
    expect(saved.exitCode).toBe(EXIT.ok);
    expect(journal.read()[0]?.version).toBe(4);
    portal.edit("step-pack", { notes: "added in the portal" });
    expect((await go(["undo"])).exitCode).toBe(EXIT.conflict);
    expect(portal.step("step-pack").title).toBe("Changed title");
  });

  it("refuses an entry written without a version (an older CLI) unless forced", async () => {
    const { journal, portal, go } = setup();
    await go(skip);
    const [entry] = journal.read();
    const { version: _version, owner: _owner, ...legacy } = entry!;
    journal.write([legacy]);
    const refused = await go(["undo"]);
    expect(refused.exitCode).toBe(EXIT.conflict);
    expect(refused.stderr).toContain("recorded without the record's version");
    expect(posts(refused.calls)).toHaveLength(0);
    const forced = await go(["undo", "--force"]);
    expect(forced.exitCode).toBe(EXIT.ok);
    expect(portal.step("step-pack").status).toBe("pending");
  });
});

describe("undo only reverses its own writes (audit L4)", () => {
  const skip = (id: string) => ["activity", "skip-step", "--step", id];
  const setup = () => {
    const journal = memoryJournal();
    const portal = statefulPortal();
    const go = (argv: string[], agent?: string, env: Record<string, string> = {}) =>
      run(agent ? [...argv, "--agent", agent] : argv, journal, portal.raw, { routes: portal.routes, env });
    return { journal, portal, go };
  };

  it("labels each write with the agent that made it", async () => {
    const { journal, go } = setup();
    await go(skip("step-pack"), "alice");
    await go(skip("step-shower"));
    expect(journal.read().map((entry) => entry.owner)).toEqual(["agent:alice", "unlabeled"]);
    expect((await go(["undo", "--list"])).stdout).toContain("[agent:alice]");
  });

  it("lets the same owner undo its write", async () => {
    const { portal, go } = setup();
    await go(skip("step-pack"), "alice");
    expect((await go(["undo"], "alice")).exitCode).toBe(EXIT.ok);
    expect(portal.step("step-pack").status).toBe("pending");
  });

  it("refuses another agent's write, and --any-owner overrides", async () => {
    const { journal, portal, go } = setup();
    await go(skip("step-pack"), "alice");
    const refused = await go(["undo"], "bob");
    expect(refused.exitCode).toBe(EXIT.usage);
    expect(refused.stderr).toContain("made by agent:alice");
    expect(refused.stderr).toContain("--any-owner");
    expect(posts(refused.calls)).toHaveLength(0);
    expect(portal.step("step-pack").status).toBe("skipped");
    expect((await go(["undo"])).exitCode).toBe(EXIT.usage); // unlabeled is not alice either
    const forced = await go(["undo", "--any-owner"], "bob");
    expect(forced.exitCode).toBe(EXIT.ok);
    expect(journal.read()[0]?.status).toBe("undone");
  });

  it("takes your own newest write rather than the newest write of anyone", async () => {
    const { journal, portal, go } = setup();
    await go(skip("step-pack"), "alice");
    await go(skip("step-shower"), "bob");
    expect((await go(["undo"], "alice")).exitCode).toBe(EXIT.ok);
    expect(portal.step("step-pack").status).toBe("pending");
    expect(portal.step("step-shower").status).toBe("skipped");
    expect(journal.read().map((entry) => entry.status)).toEqual(["undone", "applied"]);
    // Bob's write leaves Alice's undone write redoable; only her own next write would supersede it.
    expect((await go(["undo", "--redo"], "alice")).exitCode).toBe(EXIT.ok);
  });

  it("does not let one owner's new write supersede another's undone write", async () => {
    const { journal, go } = setup();
    await go(skip("step-pack"), "alice");
    await go(["undo"], "alice");
    await go(skip("step-shower"), "bob");
    expect(journal.read().map((entry) => entry.status)).toEqual(["undone", "applied"]);
  });

  it("names a token's owner by a fingerprint, never the token", async () => {
    const { journal, go } = setup();
    const token = "pat_secret_token_value_123456";
    await go(skip("step-pack"), undefined, { OPENRHEN_TOKEN: token });
    const owner = journal.read()[0]?.owner ?? "";
    expect(owner).toMatch(/^token:[0-9a-f]{8}$/);
    expect(JSON.stringify(journal.read())).not.toContain(token);
    expect((await go(["undo"], undefined, { OPENRHEN_TOKEN: token })).exitCode).toBe(EXIT.ok);
  });

  it("lets a token win over --agent, as the portal does, so changing the name does not change the owner", async () => {
    const { journal, go } = setup();
    const env = { OPENRHEN_TOKEN: "pat_secret_token_value_123456" };
    await go(skip("step-pack"), "alice", env);
    expect(journal.read()[0]?.owner).toMatch(/^token:[0-9a-f]{8}$/);
    expect((await go(["undo"], "someone-else", env)).exitCode).toBe(EXIT.ok);
    // Without the token the same name is a different owner.
    await go(skip("step-shower"), "alice", env);
    expect((await go(["undo"], "alice")).exitCode).toBe(EXIT.usage);
  });
});

describe("a reversible create is journaled only at the version a new row starts at", () => {
  /** A portal with spans: a new span starts at version 1; `afterCommit` lets another client edit it before the answer. */
  function spanPortal(afterCommit?: (span: Record<string, unknown>) => void) {
    const raw: Record<string, unknown> = { ...fixtureRawState(), spans: [] as Record<string, unknown>[] };
    const spans = raw.spans as Record<string, unknown>[];
    const command = (call: { body: unknown }) => {
      const body = call.body as { entity: Record<string, unknown>; expectedVersion: number | null };
      const found = spans.find((item) => item.id === body.entity.id);
      if (body.entity.remove === true) spans.splice(spans.indexOf(found!), 1);
      else if (!found) {
        const created = { ...body.entity, version: 1 };
        spans.push(created);
        afterCommit?.(created);
      }
      return { body: { state: raw } };
    };
    return { raw, spans, routes: { "/api/state": () => ({ body: { state: raw } }), "/api/commands/entity": command } };
  }
  const add = ["span", "add", "--title", "Away", "--start", "2026-10-01"];

  it("records version 1 for an add the portal answered with its own row", async () => {
    const journal = memoryJournal();
    const portal = spanPortal();
    const r = await run(add, journal, portal.raw, { routes: portal.routes });
    expect(r.exitCode).toBe(EXIT.ok);
    expect(journal.read()[0]?.version).toBe(1);
    expect((await run(["undo"], journal, portal.raw, { routes: portal.routes })).exitCode).toBe(EXIT.ok);
    expect(portal.spans).toHaveLength(0);
    expect(journal.read()[0]?.version).toBeNull();
  });

  it("leaves an add unguarded when another client edited the span before the answer was read", async () => {
    const journal = memoryJournal();
    const portal = spanPortal((span) => {
      span.title = "Edited by another client";
      span.version = 2;
    });
    await run(add, journal, portal.raw, { routes: portal.routes });
    expect(journal.read()[0]?.version).toBeUndefined();
    const undone = await run(["undo"], journal, portal.raw, { routes: portal.routes });
    expect(undone.exitCode).toBe(EXIT.conflict);
    expect(portal.spans).toHaveLength(1);
    expect(portal.spans[0]?.title).toBe("Edited by another client");
  });
});

describe("--force and a record that was deleted since the write", () => {
  /** A portal with spans that enforces versions like the entity handler: a save of a missing id creates it, but only from `expectedVersion: null`. */
  function spanStore(initial: Record<string, unknown>[]) {
    const raw: Record<string, unknown> = { ...fixtureRawState(), spans: initial.map((span) => ({ ...span })) };
    const spans = () => raw.spans as Record<string, unknown>[];
    const command = (call: { body: unknown }) => {
      const body = call.body as { entity: Record<string, unknown>; expectedVersion: number | null };
      const found = spans().find((item) => item.id === body.entity.id);
      if (body.entity.remove === true) {
        if (!found) return { status: 400, body: { error: "That span no longer exists." } };
        raw.spans = spans().filter((item) => item !== found);
      } else if (found) {
        if (body.expectedVersion !== found.version)
          return { status: 409, body: { error: "This record changed elsewhere. Reload before saving." } };
        Object.assign(found, body.entity, { version: (found.version as number) + 1 });
      } else {
        if (body.expectedVersion !== null)
          return { status: 409, body: { error: "This record no longer exists. Reload before saving." } };
        spans().push({ ...body.entity, version: 1 });
      }
      return { body: { state: raw } };
    };
    return {
      raw,
      spans,
      routes: { "/api/state": () => ({ body: { state: raw } }), "/api/commands/entity": command }
    };
  }
  const trip = { id: "span-trip", version: 2, title: "Trip", startDate: "2026-09-27", endDate: "2026-09-29" };

  it("lets --force put a deleted span back from its saved before-image", async () => {
    const journal = memoryJournal();
    const portal = spanStore([trip]);
    const go = (argv: string[]) => run(argv, journal, portal.raw, { routes: portal.routes });
    expect((await go(["span", "set", "span-trip", "--end", "2026-09-30"])).exitCode).toBe(EXIT.ok);
    portal.raw.spans = [];

    const plain = await go(["undo"]);
    expect(plain.exitCode).toBe(EXIT.conflict);
    expect(plain.stderr).toContain("--force");
    expect(posts(plain.calls)).toHaveLength(0);

    const forced = await go(["undo", "--force"]);
    expect(forced.exitCode).toBe(EXIT.ok);
    const sent = posts(forced.calls)[0]?.body as Record<string, unknown>;
    expect(sent.expectedVersion).toBeNull();
    expect(portal.spans()).toMatchObject([{ id: "span-trip", endDate: "2026-09-29", version: 1 }]);
    expect(journal.read()[0]?.status).toBe("undone");
  });

  it("does not tell the user to force an undo that cannot recreate the record", async () => {
    const journal = memoryJournal();
    const portal = statefulPortal();
    const go = (argv: string[]) => run(argv, journal, portal.raw, { routes: portal.routes });
    await go(["activity", "skip-step", "--step", "step-pack"]);
    portal.raw.routineSteps = (portal.raw.routineSteps as Record<string, unknown>[]).filter(
      (item) => item.id !== "step-pack"
    );
    const result = await go(["undo", "--force"]);
    expect(result.exitCode).toBe(EXIT.notFound);
    expect(result.stderr).toContain("no longer exists");
    expect(result.stderr).not.toContain("--force");
    expect(posts(result.calls)).toHaveLength(0);
    // It can never be undone, so it is dropped rather than left to block every older entry.
    expect(journal.read()[0]?.status).toBe("superseded");
    expect((await go(["undo"])).exitCode).toBe(EXIT.notFound);
  });

  it("does not offer --force to undo an added span that is already gone", async () => {
    const journal = memoryJournal();
    const portal = spanStore([]);
    const go = (argv: string[]) => run(argv, journal, portal.raw, { routes: portal.routes });
    await go(["span", "add", "--title", "Away", "--start", "2026-10-01"]);
    portal.raw.spans = [];
    // The add left the span at version 1, so a plain undo reports it gone; recreating it is not what undo does.
    const result = await go(["undo", "--force"]);
    expect(result.exitCode).toBe(EXIT.notFound);
    expect(result.stderr).not.toContain("--force");
    expect(posts(result.calls)).toHaveLength(0);
  });
  it("redoes an undone add and then an undone edit of the same span with no false conflict", async () => {
    const journal = memoryJournal();
    const portal = spanStore([]);
    const go = (argv: string[]) => run(argv, journal, portal.raw, { routes: portal.routes });
    await go(["span", "add", "--title", "Away", "--start", "2026-10-01"]);
    const id = portal.spans()[0]?.id as string;
    expect((await go(["span", "set", id, "--title", "Away longer"])).exitCode).toBe(EXIT.ok);
    expect((await go(["undo"])).exitCode).toBe(EXIT.ok);
    expect((await go(["undo"])).exitCode).toBe(EXIT.ok);
    expect(portal.spans()).toHaveLength(0);

    // Redoing the add recreates the span at version 1, not one past the version the edit's undo read.
    expect((await go(["undo", "--redo"])).exitCode).toBe(EXIT.ok);
    expect(portal.spans()).toMatchObject([{ id, title: "Away", version: 1 }]);
    const second = await go(["undo", "--redo"]);
    expect(second.exitCode).toBe(EXIT.ok);
    expect(portal.spans()).toMatchObject([{ id, title: "Away longer", version: 2 }]);
    expect(journal.read().map((entry) => entry.status)).toEqual(["applied", "applied"]);
  });

  it("still refuses the edit's redo when the recreated span was really edited first", async () => {
    const journal = memoryJournal();
    const portal = spanStore([]);
    const go = (argv: string[]) => run(argv, journal, portal.raw, { routes: portal.routes });
    await go(["span", "add", "--title", "Away", "--start", "2026-10-01"]);
    const id = portal.spans()[0]?.id as string;
    await go(["span", "set", id, "--title", "Away longer"]);
    await go(["undo"]);
    await go(["undo"]);
    await go(["undo", "--redo"]);
    Object.assign(portal.spans()[0]!, { title: "Edited in the portal", version: 2 });
    const second = await go(["undo", "--redo"]);
    expect(second.exitCode).toBe(EXIT.conflict);
    expect(portal.spans()[0]?.title).toBe("Edited in the portal");
  });
});

describe("redo takes the write undone last", () => {
  const setup = () => {
    const journal = memoryJournal();
    const portal = statefulPortal();
    const go = (argv: string[]) => run(argv, journal, portal.raw, { routes: portal.routes });
    return { journal, portal, go };
  };

  it("redoes two undos on the same record in reverse order, with no false conflict", async () => {
    const { journal, portal, go } = setup();
    const original = portal.step("step-pack").title;
    await go(["activity", "skip-step", "--step", "step-pack"]);
    await go(["save", "routine-step", "--id", "step-pack", "--set", "title=Changed title"]);
    expect((await go(["undo"])).exitCode).toBe(EXIT.ok);
    expect((await go(["undo"])).exitCode).toBe(EXIT.ok);
    expect(portal.step("step-pack")).toMatchObject({ status: "pending", title: original });
    expect(journal.read().map((entry) => entry.undoSeq)).toEqual([2, 1]);

    // The skip was undone last, so it comes back first, and on top of the record as the undo left it.
    const first = await go(["undo", "--redo"]);
    expect(first.exitCode).toBe(EXIT.ok);
    expect(sentBody(first.calls).type).toBe("skip_routine_step");
    expect(portal.step("step-pack")).toMatchObject({ status: "skipped", title: original });
    expect(journal.read().map((entry) => entry.status)).toEqual(["applied", "undone"]);
    expect(journal.read()[0]?.undoSeq).toBeUndefined();

    // Then the save, still without --force: the first redo refreshed its guard.
    const second = await go(["undo", "--redo"]);
    expect(second.exitCode).toBe(EXIT.ok);
    expect(portal.step("step-pack")).toMatchObject({ status: "skipped", title: "Changed title" });
    expect(journal.read().map((entry) => entry.status)).toEqual(["applied", "applied"]);
    expect((await go(["undo", "--redo"])).exitCode).toBe(EXIT.notFound);
  });

  it("still refuses the second redo when the record was really edited between the redos", async () => {
    const { portal, go } = setup();
    await go(["activity", "skip-step", "--step", "step-pack"]);
    await go(["save", "routine-step", "--id", "step-pack", "--set", "title=Changed title"]);
    await go(["undo"]);
    await go(["undo"]);
    expect((await go(["undo", "--redo"])).exitCode).toBe(EXIT.ok);
    portal.edit("step-pack", { notes: "edited in the portal between the redos" });
    const second = await go(["undo", "--redo"]);
    expect(second.exitCode).toBe(EXIT.conflict);
    expect(posts(second.calls)).toHaveLength(0);
    expect(portal.step("step-pack").title).not.toBe("Changed title");
  });

  it("redoes two undos on different records, the one undone last first", async () => {
    const { journal, portal, go } = setup();
    await go(["activity", "skip-step", "--step", "step-pack"]);
    await go(["activity", "skip-step", "--step", "step-shower"]);
    await go(["undo"]); // the shower skip
    await go(["undo"]); // the pack skip
    const first = await go(["undo", "--redo"]);
    expect(first.exitCode).toBe(EXIT.ok);
    expect(sentBody(first.calls).stepId).toBe("step-pack");
    expect(portal.step("step-pack").status).toBe("skipped");
    expect(portal.step("step-shower").status).toBe("pending");
    const second = await go(["undo", "--redo"]);
    expect(sentBody(second.calls).stepId).toBe("step-shower");
    expect(portal.step("step-shower").status).toBe("skipped");
    expect(journal.read().map((entry) => entry.status)).toEqual(["applied", "applied"]);
  });

  it("falls back to journal order for a journal written before undos were numbered", async () => {
    const { journal, portal, go } = setup();
    await go(["activity", "skip-step", "--step", "step-pack"]);
    await go(["activity", "skip-step", "--step", "step-shower"]);
    await go(["undo"]);
    await go(["undo"]);
    journal.write(journal.read().map(({ undoSeq: _undoSeq, ...entry }) => entry));
    const redone = await go(["undo", "--redo"]);
    expect(redone.exitCode).toBe(EXIT.ok);
    expect(sentBody(redone.calls).stepId).toBe("step-shower");
    expect(portal.step("step-shower").status).toBe("skipped");
  });
});

/** A portal with spans that enforces versions like the entity handler: a save of a missing id creates it (at version 1) only from `expectedVersion: null`. */
function versionedSpans(initial: Record<string, unknown>[] = []) {
  const raw: Record<string, unknown> = { ...fixtureRawState(), spans: initial.map((span) => ({ ...span })) };
  const spans = () => raw.spans as Record<string, unknown>[];
  const command = (call: { body: unknown }) => {
    const body = call.body as { entity: Record<string, unknown>; expectedVersion: number | null };
    const found = spans().find((item) => item.id === body.entity.id);
    if (body.entity.remove === true) {
      if (!found) return { status: 400, body: { error: "That span no longer exists." } };
      if (body.expectedVersion !== found.version)
        return { status: 409, body: { error: "This record changed elsewhere. Reload before saving." } };
      raw.spans = spans().filter((item) => item !== found);
    } else if (found) {
      if (body.expectedVersion !== found.version)
        return { status: 409, body: { error: "This record changed elsewhere. Reload before saving." } };
      Object.assign(found, body.entity, { version: (found.version as number) + 1 });
    } else {
      if (body.expectedVersion !== null)
        return { status: 409, body: { error: "This record no longer exists. Reload before saving." } };
      spans().push({ ...body.entity, version: 1 });
    }
    return { body: { state: raw } };
  };
  return { raw, spans, routes: { "/api/state": () => ({ body: { state: raw } }), "/api/commands/entity": command } };
}

describe("a forced delete and recreate restarts the record's version", () => {
  it("does not let another owner's older entry undo over an edit made after the recreate", async () => {
    const journal = memoryJournal();
    const portal = versionedSpans();
    const go = (agent: string, argv: string[]) =>
      run([...argv, "--agent", agent], journal, portal.raw, { routes: portal.routes });
    await go("alice", ["span", "add", "--title", "Original", "--start", "2026-10-01"]);
    const id = portal.spans()[0]?.id as string;
    await go("bob", ["span", "set", id, "--title", "Bob edit"]); // bob's entry reads version 1, leaves 2
    // Alice forces over Bob's edit: the span is removed, then put back by her redo at version 1.
    expect((await go("alice", ["undo", "--force"])).exitCode).toBe(EXIT.ok);
    expect(portal.spans()).toHaveLength(0);
    expect((await go("alice", ["undo", "--redo"])).exitCode).toBe(EXIT.ok);
    expect(portal.spans()).toMatchObject([{ id, title: "Original", version: 1 }]);
    await go("alice", ["span", "set", id, "--title", "Alice later edit"]); // version 2, Bob's old number

    const bob = await go("bob", ["undo"]);
    expect(bob.exitCode).toBe(EXIT.conflict);
    expect(bob.stderr).toContain("--force");
    expect(posts(bob.calls)).toHaveLength(0);
    expect(portal.spans()).toMatchObject([{ title: "Alice later edit", version: 2 }]);
  });

  it("still lets a forced move keep working for the entry it moved, and for later writes", async () => {
    const journal = memoryJournal();
    const portal = versionedSpans();
    const go = (argv: string[]) => run(argv, journal, portal.raw, { routes: portal.routes });
    await go(["span", "add", "--title", "Original", "--start", "2026-10-01"]);
    const id = portal.spans()[0]?.id as string;
    await go(["span", "set", id, "--title", "Edit"]);
    portal.raw.spans = []; // deleted elsewhere
    expect((await go(["undo", "--force"])).exitCode).toBe(EXIT.ok); // recreates it from the before-image
    expect((await go(["undo", "--redo"])).exitCode).toBe(EXIT.ok); // its own entry kept the new version
    expect(portal.spans()).toMatchObject([{ id, title: "Edit", version: 2 }]);
    // The older add's version is no longer trusted after the forced recreate.
    const add = journal.read()[0]!;
    expect(add.version).toBeUndefined();
  });
});

describe("an entry that can never be reversed does not block older ones", () => {
  it("drops it, says so, and the next undo reaches the older write", async () => {
    const journal = memoryJournal();
    const trip = { id: "span-trip", version: 2, title: "Trip", startDate: "2026-09-27", endDate: "2026-09-29" };
    const portal = versionedSpans([trip]);
    const go = (argv: string[]) => run(argv, journal, portal.raw, { routes: portal.routes });
    await go(["span", "set", "span-trip", "--end", "2026-09-30"]);
    await go(["span", "add", "--title", "Away", "--start", "2026-10-01"]);
    const added = portal.spans().find((item) => item.id !== "span-trip")!;
    portal.raw.spans = portal.spans().filter((item) => item !== added); // deleted in the portal

    const stuck = await go(["undo"]);
    expect(stuck.exitCode).toBe(EXIT.notFound);
    expect(stuck.stderr).toContain("dropped from the journal");
    expect(posts(stuck.calls)).toHaveLength(0);
    expect(journal.read().map((entry) => entry.status)).toEqual(["applied", "superseded"]);
    expect((await go(["undo", "--list"])).stdout).toContain("superseded");

    const next = await go(["undo"]);
    expect(next.exitCode).toBe(EXIT.ok);
    expect(portal.spans()).toMatchObject([{ id: "span-trip", endDate: "2026-09-29" }]);
  });

  it("leaves the journal alone on --dry-run", async () => {
    const journal = memoryJournal();
    const portal = versionedSpans();
    const go = (argv: string[]) => run(argv, journal, portal.raw, { routes: portal.routes });
    await go(["span", "add", "--title", "Away", "--start", "2026-10-01"]);
    portal.raw.spans = [];
    expect((await go(["undo", "--dry-run"])).exitCode).toBe(EXIT.notFound);
    expect(journal.read()[0]?.status).toBe("applied");
  });
});

describe("undo's ownership message", () => {
  it("skips someone else's newer write to your own older one, and only errors when you have none", async () => {
    const journal = memoryJournal();
    const portal = statefulPortal();
    const go = (argv: string[], agent: string) =>
      run([...argv, "--agent", agent], journal, portal.raw, { routes: portal.routes });
    await go(["activity", "skip-step", "--step", "step-pack"], "alice");
    await go(["activity", "skip-step", "--step", "step-shower"], "bob");
    expect((await go(["undo"], "alice")).exitCode).toBe(EXIT.ok);
    expect(portal.step("step-pack").status).toBe("pending");
    const none = await go(["undo"], "alice");
    expect(none.exitCode).toBe(EXIT.usage);
    expect(none.stderr).toContain("all someone else's");
    expect(none.stderr).toContain("--any-owner");
  });
});

describe("a journal target names the row a single-record state key holds", () => {
  const plan = (id: string, version: number) => ({
    ...fixtureRawState(),
    dailyPlan: { id, version, localDate: "2026-09-03" }
  });

  it("matches the daily plan and the active session only by id when the entry has one", () => {
    const state = (raw: Record<string, unknown>) => raw as never;
    expect(currentVersion(state(plan("plan-1", 4)), { stateKey: "dailyPlan", id: "plan-1" })).toBe(4);
    expect(currentVersion(state(plan("plan-2", 4)), { stateKey: "dailyPlan", id: "plan-1" })).toBeUndefined();
    // An entry from before targets carried ids matches whichever row is there.
    expect(currentVersion(state(plan("plan-2", 4)), { stateKey: "dailyPlan" })).toBe(4);
    const session = { ...fixtureRawState(), activeSession: { id: "session-2", version: 3 } };
    expect(currentVersion(state(session), { stateKey: "activeSession", id: "session-1" })).toBeUndefined();
    expect(currentVersion(state(session), { stateKey: "activeSession", id: "session-2" })).toBe(3);
  });

  it("records the row id for a daily plan save and for a pause", async () => {
    const journal = memoryJournal();
    const raw = {
      ...fixtureRawState(),
      dailyPlan: { id: "plan-today", version: 2, localDate: "2026-09-03", desiredActionIds: [], deferredItems: [] }
    };
    await run(["save", "daily-plan", "--set", "desiredActionIds=[]"], journal, raw);
    await run(["activity", "pause"], journal, { ...fixtureRawState(), ...fixtureActiveSession() });
    expect(journal.read().map((entry) => entry.target)).toEqual([
      { stateKey: "dailyPlan", id: "plan-today" },
      {
        stateKey: "activeSession",
        id: fixtureActiveSession().activeSession && (fixtureActiveSession().activeSession as { id: string }).id
      }
    ]);
  });

  it("refuses to undo a pause once a different session is the open one", async () => {
    const journal = memoryJournal();
    const first = { ...fixtureRawState(), ...fixtureActiveSession() };
    await run(["activity", "pause"], journal, first);
    const entry = journal.read()[0]!;
    // The paused session ended and another opened, at the very version the pause left.
    const other = {
      ...fixtureRawState(),
      activeSession: {
        ...(fixtureActiveSession().activeSession as object),
        id: "another-session",
        version: entry.version
      }
    };
    const result = await run(["undo"], journal, other);
    expect(result.exitCode).toBe(EXIT.notFound);
    expect(posts(result.calls)).toHaveLength(0);
  });
});

describe("undo --id targets one recorded write", () => {
  const skip = (id: string) => ["activity", "skip-step", "--step", id];
  const setup = () => {
    const journal = memoryJournal();
    const portal = statefulPortal();
    const go = (argv: string[], agent?: string) =>
      run(agent ? [...argv, "--agent", agent] : argv, journal, portal.raw, { routes: portal.routes });
    return { journal, portal, go };
  };

  it("undoes an older entry on a different record and leaves the newest alone, with the id in the JSON answer", async () => {
    const { journal, portal, go } = setup();
    await go(skip("step-pack"));
    await go(skip("step-shower"));
    const [older, newer] = journal.read();
    const result = await go(["undo", "--id", older!.id, "--json"]);
    expect(result.exitCode).toBe(EXIT.ok);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, direction: "undo", id: older!.id });
    expect(portal.step("step-pack").status).toBe("pending");
    expect(portal.step("step-shower").status).toBe("skipped");
    expect(journal.read().map((entry) => entry.status)).toEqual(["undone", "applied"]);
    expect(journal.read()[1]?.id).toBe(newer!.id);
  });

  it("redoes a named undone entry, and refuses the wrong direction", async () => {
    const { journal, portal, go } = setup();
    await go(skip("step-pack"));
    const id = journal.read()[0]!.id;
    const early = await go(["undo", "--id", id, "--redo"]);
    expect(early.exitCode).toBe(EXIT.conflict);
    expect(early.stderr).toContain("nothing to redo");
    expect((await go(["undo", "--id", id])).exitCode).toBe(EXIT.ok);
    const twice = await go(["undo", "--id", id]);
    expect(twice.exitCode).toBe(EXIT.conflict);
    expect(twice.stderr).toContain("already undone");
    const redone = await go(["undo", "--id", id, "--redo", "--json"]);
    expect(redone.exitCode).toBe(EXIT.ok);
    expect(JSON.parse(redone.stdout)).toMatchObject({ direction: "redo", id });
    expect(portal.step("step-pack").status).toBe("skipped");
    expect(journal.read()[0]?.status).toBe("applied");
  });

  it("reports an unknown id and a superseded entry", async () => {
    const { journal, go } = setup();
    await go(skip("step-pack"));
    const missing = await go(["undo", "--id", "nope"]);
    expect(missing.exitCode).toBe(EXIT.notFound);
    expect(posts(missing.calls)).toHaveLength(0);
    journal.write(journal.read().map((entry) => ({ ...entry, status: "superseded" as const })));
    const gone = await go(["undo", "--id", journal.read()[0]!.id]);
    expect(gone.exitCode).toBe(EXIT.conflict);
    expect(gone.stderr).toContain("can no longer be reversed");
  });

  it("keeps the owner check, and --any-owner overrides it", async () => {
    const { journal, portal, go } = setup();
    await go(skip("step-pack"), "alice");
    const id = journal.read()[0]!.id;
    const refused = await go(["undo", "--id", id], "bob");
    expect(refused.exitCode).toBe(EXIT.usage);
    expect(refused.stderr).toContain("made by agent:alice");
    expect(posts(refused.calls)).toHaveLength(0);
    expect(portal.step("step-pack").status).toBe("skipped");
    expect((await go(["undo", "--id", id, "--any-owner"], "bob")).exitCode).toBe(EXIT.ok);
    expect(portal.step("step-pack").status).toBe("pending");
  });

  it("keeps the version check: an older write to a record edited since is refused, not overwritten", async () => {
    const { journal, portal, go } = setup();
    await go(skip("step-pack"));
    const id = journal.read()[0]!.id;
    portal.edit("step-pack", { title: "Edited elsewhere" });
    const result = await go(["undo", "--id", id]);
    expect(result.exitCode).toBe(EXIT.conflict);
    expect(posts(result.calls)).toHaveLength(0);
    expect(portal.step("step-pack").status).toBe("skipped");
    expect(journal.read()[0]?.status).toBe("applied");
  });
});

describe("reverseOfCreate finds the record a create made only by proof", () => {
  const stateWith = (key: string, rows: Record<string, unknown>[]) => ({ [key]: rows }) as unknown as PortalState;
  const COMMAND = "11111111-2222-4333-8444-555555555555";
  const reverse = (type: string, before: PortalState, after: PortalState, sent: Record<string, unknown>) =>
    reverseOfCreate(findEntityType(type)!, before, fixtureNow)!(after, sent);

  it("never falls back to a save that sets a closed status: a record the portal answered without a version is closed by version-less undo, one without a command id is not journaled", () => {
    const sent = { commandId: COMMAND, entityType: "area", entity: { id: "area-gym", name: "Gym", status: "active" } };
    const noVersion = reverse("area", stateWith("areas", []), stateWith("areas", [{ id: "area-gym" }]), sent)!;
    expect(noVersion.undo).toMatchObject({
      path: "/api/commands/close",
      payload: {
        type: "area",
        id: "area-gym",
        verb: "archive",
        do: "close",
        expectedVersion: null,
        undoOfCommandId: COMMAND
      }
    });
    expect(noVersion.redo).toBeUndefined();
    const { commandId: _drop, ...noCommand } = sent;
    expect(
      reverse("area", stateWith("areas", []), stateWith("areas", [{ id: "area-gym", version: 1 }]), noCommand)
    ).toBeUndefined();
  });

  it("takes the fresh record whose id is the command id when the create sent no id", () => {
    const sent = { commandId: COMMAND, entityType: "area", entity: { name: "Gym", status: "active" } };
    const found = reverse(
      "area",
      stateWith("areas", []),
      stateWith("areas", [
        { id: "someone-elses", name: "Other" },
        { id: COMMAND, name: "Gym", version: 1 }
      ]),
      sent
    );
    expect(found?.target).toEqual({ stateKey: "areas", id: COMMAND });
  });

  it("does not take 'the only new record' when it is not the command's own", () => {
    const sent = { commandId: COMMAND, entityType: "area", entity: { name: "Gym", status: "active" } };
    expect(
      reverse("area", stateWith("areas", []), stateWith("areas", [{ id: "someone-elses" }]), sent)
    ).toBeUndefined();
    // A command id the portal would hash cannot be matched either.
    const hashed = { ...sent, commandId: "00000000-0000-0000-0000-000000000001" };
    expect(
      reverse("area", stateWith("areas", []), stateWith("areas", [{ id: hashed.commandId }]), hashed)
    ).toBeUndefined();
  });

  it("still takes the record named by the id the create sent", () => {
    const sent = { commandId: COMMAND, entityType: "area", entity: { id: "area-gym", name: "Gym", status: "active" } };
    const found = reverse("area", stateWith("areas", []), stateWith("areas", [{ id: "area-gym" }]), sent);
    expect(found?.target).toEqual({ stateKey: "areas", id: "area-gym" });
  });

  it("takes a capture only when exactly one new capture has the sent text", () => {
    const sent = { commandId: COMMAND, entityType: "capture", entity: { text: "Call mum", status: "pending" } };
    const one = reverse(
      "capture",
      stateWith("captures", []),
      stateWith("captures", [
        { id: "c1", text: "Call mum" },
        { id: "c2", text: "Something else" }
      ]),
      sent
    );
    expect(one?.target).toEqual({ stateKey: "captures", id: "c1" });
    expect(
      reverse(
        "capture",
        stateWith("captures", []),
        stateWith("captures", [
          { id: "c1", text: "Call mum" },
          { id: "c2", text: "Call mum" }
        ]),
        sent
      )
    ).toBeUndefined();
    expect(
      reverse("capture", stateWith("captures", []), stateWith("captures", [{ id: "c2", text: "Other text" }]), sent)
    ).toBeUndefined();
  });
});

describe("what the person undid stays theirs to put back", () => {
  const skip = (id: string) => ["activity", "skip-step", "--step", id];
  const setup = () => {
    const journal = memoryJournal();
    const portal = statefulPortal();
    const go = (argv: string[], options: { byOwner?: boolean } = {}) =>
      run([...argv, "--agent", "alice"], journal, portal.raw, { routes: portal.routes, ...options });
    return { journal, portal, go };
  };

  it("marks an owner undo, and the agent's newest-first redo and --id redo cannot reach it", async () => {
    const { journal, portal, go } = setup();
    await go(skip("step-pack"));
    const id = journal.read()[0]!.id;
    expect((await go(["undo", "--id", id, "--any-owner"], { byOwner: true })).exitCode).toBe(EXIT.ok);
    expect(journal.read()[0]).toMatchObject({ status: "undone", undoneBy: "owner" });
    expect(portal.step("step-pack").status).toBe("pending");

    const redo = await go(["undo", "--redo"]);
    expect(redo.exitCode).toBe(EXIT.notFound);
    expect(posts(redo.calls)).toHaveLength(0);
    const byId = await go(["undo", "--id", id, "--redo"]);
    expect(byId.exitCode).toBe(EXIT.usage);
    expect(posts(byId.calls)).toHaveLength(0);
    expect(portal.step("step-pack").status).toBe("pending");
  });

  it("lets the owner redo it, which clears the mark", async () => {
    const { journal, portal, go } = setup();
    await go(skip("step-pack"));
    const id = journal.read()[0]!.id;
    await go(["undo", "--id", id, "--any-owner"], { byOwner: true });
    const redone = await go(["undo", "--id", id, "--any-owner", "--redo"], { byOwner: true });
    expect(redone.exitCode).toBe(EXIT.ok);
    expect(portal.step("step-pack").status).toBe("skipped");
    expect(journal.read()[0]?.status).toBe("applied");
    expect(journal.read()[0]).not.toHaveProperty("undoneBy");
  });

  it("is not set by the agent's own undo, which it can redo", async () => {
    const { journal, portal, go } = setup();
    await go(skip("step-pack"));
    await go(["undo"]);
    expect(journal.read()[0]).not.toHaveProperty("undoneBy");
    expect((await go(["undo", "--redo"])).exitCode).toBe(EXIT.ok);
    expect(portal.step("step-pack").status).toBe("skipped");
  });

  it("is not superseded by the agent's next write, so the owner's redo survives", async () => {
    const { journal, portal, go } = setup();
    await go(skip("step-pack"));
    const id = journal.read()[0]!.id;
    await go(["undo", "--id", id, "--any-owner"], { byOwner: true });
    await go(skip("step-shower"));
    expect(journal.read().map((entry) => entry.status)).toEqual(["undone", "applied"]);
    expect((await go(["undo", "--id", id, "--any-owner", "--redo"], { byOwner: true })).exitCode).toBe(EXIT.ok);
    expect(portal.step("step-pack").status).toBe("skipped");
  });

  it("still supersedes the agent's own undone entries on a new write", async () => {
    const { journal, go } = setup();
    await go(skip("step-pack"));
    await go(["undo"]);
    await go(skip("step-shower"));
    expect(journal.read().map((entry) => entry.status)).toEqual(["superseded", "applied"]);
  });
});

describe("a journal can keep more than the default", () => {
  it("trims to its own limit, and to 50 when it names none", () => {
    const entry = (n: number) => ({
      id: `e${n}`,
      at: fixtureNow.toISOString(),
      label: `write ${n}`,
      undo: { path: "/api/commands/entity", payload: {} },
      redo: { path: "/api/commands/entity", payload: {} },
      target: { stateKey: "routineSteps", id: `s${n}` }
    });
    const big = memoryJournal([], 100);
    const small = memoryJournal();
    for (let n = 0; n < 120; n += 1) {
      recordWrite(big, entry(n));
      recordWrite(small, entry(n));
    }
    expect(big.read()).toHaveLength(100);
    expect(big.read()[0]?.id).toBe("e20");
    expect(small.read()).toHaveLength(JOURNAL_LIMIT);
    expect(small.read().at(-1)?.id).toBe("e119");
  });
});

describe("undoing a create takes the record out of the plan and redo puts it back", () => {
  const newAction = [
    "save",
    "action",
    "--create",
    "--set",
    "title=Wrong action",
    "--set",
    "projectId=project-thesis",
    "--set",
    "id=action-wrong"
  ];
  const span = ["save", "span", "--set", "title=Away", "--set", "startDate=2026-10-01", "--set", "endDate=2026-10-03"];

  it("cancels a new action, then redoes it as planned, at the versions each move left", async () => {
    const journal = memoryJournal();
    const portal = createPortal();
    const go = (argv: string[]) => run(argv, journal, portal.raw, { routes: portal.routes });
    const created = await go(newAction);
    expect(created.exitCode).toBe(EXIT.ok);
    expect(created.stderr).toContain("rhen undo");
    const entry = journal.read()[0]!;
    expect(entry.version).toBe(1);
    const stateId = entry.target.id!;
    const row = () => portal.rows("actions").find((item) => item.id === stateId);
    expect(row()).toMatchObject({ status: "planned", version: 1 });

    const undone = await go(["undo"]);
    expect(undone.exitCode).toBe(EXIT.ok);
    const undoCall = posts(undone.calls)[0]!;
    expect(undoCall.path).toBe("/api/commands/close");
    // The close tool takes it back; the portal proves in its ledger that this agent made it (undoOfCommandId).
    expect(undoCall.body).toMatchObject({
      type: "action",
      id: stateId,
      verb: "cancel",
      do: "close",
      expectedVersion: 1,
      undoOfCommandId: sentBody(created.calls).commandId
    });
    expect((undoCall.body as { reason?: string }).reason).toBeUndefined();
    expect(row()).toMatchObject({ status: "cancelled", version: 2 });
    expect(journal.read()[0]).toMatchObject({ status: "undone", version: 2 });

    const redone = await go(["undo", "--redo"]);
    expect(redone.exitCode).toBe(EXIT.ok);
    const redoCall = posts(redone.calls)[0]!;
    expect(redoCall.path).toBe("/api/commands/close");
    expect(redoCall.body).toMatchObject({ type: "action", id: stateId, do: "restore", expectedVersion: 2 });
    expect(row()).toMatchObject({ status: "planned", version: 3 });
    expect(journal.read()[0]).toMatchObject({ status: "applied", version: 3 });

    // The cycle repeats: undo again takes it out at the version the redo left.
    expect((await go(["undo"])).exitCode).toBe(EXIT.ok);
    expect(row()?.status).toBe("cancelled");
  });

  it("says the exact retry call, with a reason, when the portal wants a reason for an undo it could not prove", async () => {
    const journal = memoryJournal();
    const portal = createPortal();
    const go = (argv: string[]) => run(argv, journal, portal.raw, { routes: portal.routes });
    expect((await go(newAction)).exitCode).toBe(EXIT.ok);
    const entry = journal.read()[0]!;
    const stateId = entry.target.id!;
    const reasonRoutes = {
      ...portal.routes,
      "/api/commands/close": () => ({
        status: 400,
        body: { error: 'A reason is required. Say why, for example "finished the quarter".' }
      })
    };
    const undone = await run(["undo"], journal, portal.raw, { routes: reasonRoutes });
    expect(undone.exitCode).not.toBe(EXIT.ok);
    expect(undone.stderr).toContain(`rhen cancel action ${stateId} close --reason "undo of create"`);
    expect(journal.read()[0]).toMatchObject({ status: "applied" });
  });

  it("refuses to undo a create that was edited since, and changes nothing", async () => {
    const journal = memoryJournal();
    const portal = createPortal();
    const go = (argv: string[]) => run(argv, journal, portal.raw, { routes: portal.routes });
    await go(newAction);
    const row = portal.rows("actions").find((item) => item.id === journal.read()[0]!.target.id)!;
    row.version = 2;
    row.title = "Edited elsewhere";
    const undone = await go(["undo"]);
    expect(undone.exitCode).toBe(EXIT.conflict);
    expect(row.status).toBe("planned");
  });

  it("forces the undo of an edited create at the version it finds, still naming the create", async () => {
    const journal = memoryJournal();
    const portal = createPortal();
    const go = (argv: string[]) => run(argv, journal, portal.raw, { routes: portal.routes });
    const created = await go(newAction);
    const row = portal.rows("actions").find((item) => item.id === journal.read()[0]!.target.id)!;
    row.version = 2;
    const forced = await go(["undo", "--force"]);
    expect(forced.exitCode).toBe(EXIT.ok);
    expect(posts(forced.calls)[0]!.body).toMatchObject({
      do: "close",
      expectedVersion: 2,
      undoOfCommandId: sentBody(created.calls).commandId
    });
  });

  it("finds a new record the portal keyed itself: no id given, a non-uuid id hashed", async () => {
    const journal = memoryJournal();
    const portal = createPortal();
    const go = (argv: string[]) => run(argv, journal, portal.raw, { routes: portal.routes });
    // No id: the entity is keyed by its command id, so a redo must restate it against that id, not a new command id.
    await go(["save", "area", "--set", "name=Wrong area", "--set", "status=active", "--set", "sortOrder=4"]);
    const area = journal.read()[0]!;
    expect(area.target.id).toMatch(/^[0-9a-f]{8}-/);
    expect(area.redo.payload).toMatchObject({ type: "area", id: area.target.id, do: "restore" });
    expect((await go(["undo"])).exitCode).toBe(EXIT.ok);
    const areaRow = () => portal.rows("areas").find((row) => row.id === area.target.id);
    expect(areaRow()).toMatchObject({ status: "archived", version: 2 });
    expect((await go(["undo", "--redo"])).exitCode).toBe(EXIT.ok);
    expect(areaRow()).toMatchObject({ status: "active", version: 3 });

    // A non-uuid id is hashed by the portal: the journal names the row by the id the state shows.
    await go([
      "save",
      "project",
      "--create",
      "--set",
      "id=project-wrong",
      "--set",
      "title=Wrong project",
      "--set",
      "outcomeId=outcome-house"
    ]);
    const project = journal.read().at(-1)!;
    expect(project.target.id).toMatch(/^00000000-/);
    expect(project.undo.payload).toMatchObject({
      type: "project",
      id: project.target.id,
      verb: "cancel",
      do: "close",
      undoOfCommandId: expect.any(String)
    });
    // The entry is named by the stored id (what the change feed and every list show), not the one sent.
    expect(project.label).toBe(`create project "Wrong project" (${project.target.id})`);
    expect((await go(["undo"])).exitCode).toBe(EXIT.ok);
    expect(portal.rows("projects").find((row) => row.id === project.target.id)).toMatchObject({
      status: "cancelled",
      version: 2
    });
  });

  it("keys a new action or project that named no id by its command id, and undoes and redoes it", async () => {
    const journal = memoryJournal();
    const portal = createPortal();
    const go = (argv: string[]) => run(argv, journal, portal.raw, { routes: portal.routes });
    const commandId = "5b1f3c1e-0f7a-4c52-9d0e-6a1d4f0b2a11";
    const created = await go([
      "save",
      "action",
      "--set",
      "title=Call mum",
      "--set",
      "projectId=project-thesis",
      "--command-id",
      commandId
    ]);
    expect(created.exitCode).toBe(EXIT.ok);
    expect(sentBody(created.calls)).toMatchObject({ commandId, action: { id: commandId } });
    const action = journal.read()[0]!;
    expect(action.target).toEqual({ stateKey: "actions", id: commandId });
    expect(action.label).toBe(`create action "Call mum" (${commandId})`);
    expect(portal.rows("actions").find((row) => row.id === commandId)).toMatchObject({ status: "planned", version: 1 });
    expect(action.undo.payload).toMatchObject({ type: "action", id: commandId, undoOfCommandId: commandId });
    expect(action.redo.payload).toMatchObject({ type: "action", id: commandId, do: "restore" });

    expect((await go(["undo"])).exitCode).toBe(EXIT.ok);
    expect(portal.rows("actions").find((row) => row.id === commandId)).toMatchObject({
      status: "cancelled",
      version: 2
    });
    expect((await go(["undo", "--redo"])).exitCode).toBe(EXIT.ok);
    expect(portal.rows("actions").find((row) => row.id === commandId)).toMatchObject({ status: "planned", version: 3 });

    const projectCommandId = "9c2d4e6f-1a3b-4c5d-8e7f-0a1b2c3d4e5f";
    await go([
      "save",
      "project",
      "--set",
      "title=Garden",
      "--set",
      "outcomeId=outcome-house",
      "--command-id",
      projectCommandId
    ]);
    const project = journal.read().at(-1)!;
    expect(project.target).toEqual({ stateKey: "projects", id: projectCommandId });
    expect(project.label).toBe(`create project "Garden" (${projectCommandId})`);
    expect((await go(["undo"])).exitCode).toBe(EXIT.ok);
    expect(portal.rows("projects").find((row) => row.id === projectCommandId)).toMatchObject({
      status: "cancelled",
      version: 2
    });
  });

  it("ignores a new capture and redoes it as pending with its stored fields", async () => {
    const journal = memoryJournal();
    const portal = createPortal();
    const go = (argv: string[]) => run(argv, journal, portal.raw, { routes: portal.routes });
    expect((await go(["capture", "Ring the plumber"])).exitCode).toBe(EXIT.ok);
    const entry = journal.read()[0]!;
    expect(entry.version).toBe(1);

    const undone = await go(["undo"]);
    expect(undone.exitCode).toBe(EXIT.ok);
    const undoBody = posts(undone.calls)[0]!.body as { entityType: string; entity: Record<string, unknown> };
    expect(undoBody.entityType).toBe("capture");
    expect(undoBody.entity).toMatchObject({
      id: entry.target.id,
      status: "ignored",
      proposalType: "unclassified",
      proposedFields: { text: "Ring the plumber" },
      reviewedAt: fixtureNow.toISOString()
    });

    const redone = await go(["undo", "--redo"]);
    expect(redone.exitCode).toBe(EXIT.ok);
    const redoBody = posts(redone.calls)[0]!.body as { expectedVersion: number; entity: Record<string, unknown> };
    expect(redoBody.expectedVersion).toBe(2);
    expect(redoBody.entity).toMatchObject({
      id: entry.target.id,
      status: "pending",
      proposalType: "unclassified",
      proposedFields: { text: "Ring the plumber" }
    });
    expect(portal.rows("captures").find((row) => row.id === entry.target.id)).toMatchObject({
      status: "pending",
      version: 3
    });
  });

  it("removes a new span, and redo creates it again", async () => {
    const journal = memoryJournal();
    const portal = createPortal();
    const go = (argv: string[]) => run(argv, journal, portal.raw, { routes: portal.routes });
    await go(span);
    const entry = journal.read()[0]!;
    expect(portal.rows("spans")).toHaveLength(1);
    expect((entry.undo.payload.entity as Record<string, unknown>).remove).toBe(true);
    expect((await go(["undo"])).exitCode).toBe(EXIT.ok);
    expect(portal.rows("spans")).toHaveLength(0);
    expect((await go(["undo", "--redo"])).exitCode).toBe(EXIT.ok);
    expect(portal.rows("spans")).toMatchObject([{ title: "Away", version: 1 }]);
  });

  it("says so when the undo is filed as a proposal for the owner, and leaves the journal as it was", async () => {
    const journal = memoryJournal();
    const portal = createPortal();
    const go = (argv: string[], routes: Parameters<typeof run>[3] = { routes: portal.routes }) =>
      run(argv, journal, portal.raw, routes);
    await go(span);
    const filing = {
      ...portal.routes,
      "/api/commands/entity": () => ({
        status: 202,
        body: { proposal: { id: "proposal-1", status: "pending" }, filedBecause: "removal: removes a span" }
      })
    };
    const undone = await go(["undo"], { routes: filing });
    expect(undone.exitCode).toBe(EXIT.ok);
    expect(undone.stderr).toContain("Filed as proposal proposal-1");
    expect(undone.stderr).toContain("removal: removes a span");
    expect(journal.read()[0]?.status).toBe("applied");
    expect(portal.rows("spans")).toHaveLength(1);
  });

  it("records nothing when the answer does not show which record is new", async () => {
    const journal = memoryJournal();
    const portal = createPortal();
    const unchanged = { ...portal.routes, "/api/commands/action": () => ({ body: { state: fixtureRawState() } }) };
    const created = await run(newAction, journal, portal.raw, { routes: unchanged });
    expect(created.exitCode).toBe(EXIT.ok);
    expect(journal.read()).toHaveLength(0);
    expect(created.stderr).not.toContain("rhen undo");
  });
});
