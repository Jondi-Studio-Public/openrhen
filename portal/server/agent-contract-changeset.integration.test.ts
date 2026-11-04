import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { integrationDatabaseName } from "@openrhen/database";
import { refreshPlanning, setupStateStoreSuite, sql, unplannedStore } from "./persistence/postgres/state-store-harness";
import {
  FIXTURE_ZONE,
  connectAgent,
  contractClock,
  contractSeedState,
  seedContractPlaces,
  seedContractRepeats,
  type AgentCall
} from "./agent-contract-fixture";

/**
 * The owner's Wednesday message (the facts `agent-contract.integration.test.ts` replays one tool call at a time), sent as
 * ONE `rhen_changeset` through `/mcp`: a preview, then an apply with the preview's hash as `expect` and the same
 * `command-id`, then the same read-backs the one-at-a-time test makes, then one `rhen_undo` of the whole set.
 * Facts that test leaves out (the stale-fact block, the project and slug-keyed action, the 9pm rule, the words
 * written, the ambiguous readings) stay out here. Feeling flat is not a change: it writes nothing.
 */
const BASE = "openrhen_agent_contract_changeset";
setupStateStoreSuite(BASE, { resetBetweenTests: false });

const clock = contractClock();
const at = (days: number, time: string) => clock.at(days, time).getTime();
const instant = (value: unknown) => Date.parse(String(value));
const COMMAND_ID = "00000000-0000-4000-8000-0000000000c5";

let call: AgentCall;
let previousDatabaseUrl: string | undefined;

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: clock.at(-1, "12:50") });
  const url = new URL(process.env.POSTGRES_ADMIN_URL!);
  url.pathname = `/${integrationDatabaseName(process.env.TEST_DATABASE_NAME, BASE)}`;
  previousDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = url.toString();

  await sql.unsafe("TRUNCATE TABLE users, portal_state, jobs RESTART IDENTITY CASCADE");
  await unplannedStore.put(contractSeedState(clock));
  await seedContractPlaces(unplannedStore);
  await refreshPlanning();
  vi.setSystemTime(clock.at(-1, "13:00"));
  const lab = (await unplannedStore.get())!.actions.find((item) => item.title.startsWith("Lab 7"))!;
  const started = await unplannedStore.runSessionCommand({
    commandId: crypto.randomUUID(),
    expectedVersion: lab.version ?? null,
    type: "start",
    actionId: lab.id,
    plannedMinutes: 60
  });
  vi.setSystemTime(clock.at(0, "08:29"));
  await unplannedStore.runSessionCommand({
    commandId: crypto.randomUUID(),
    expectedVersion: started.activeSession!.version ?? null,
    type: "request_feedback",
    sessionId: started.activeSession!.id
  });
  await seedContractRepeats(unplannedStore, clock);
  vi.setSystemTime(clock.now);
  await refreshPlanning();
  call = await connectAgent(clock);
}, 120_000);

afterAll(() => {
  vi.useRealTimers();
  if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = previousDatabaseUrl;
});

interface Item {
  id: string;
  title?: string;
  status?: string;
  [field: string]: unknown;
}
interface SearchResult {
  total: number;
  results: Item[];
}
interface Brief {
  session: unknown;
  inboxPending: number;
  nextCommitment: { title: string; startsAt: string; minutesAway: number } | null;
  deadlinesWithin48h: { id: string; title: string; at: string }[];
}
interface FullStatus {
  plan: { status: string };
  directive: { title: string } | null;
  upcoming: { title: string }[];
  session: unknown;
  situation: { locationId: string | null; locationName: string | null };
  nextCommitment: { title: string; startsAt: string } | null;
}
interface JournalEntry {
  id: string;
  label: string;
  status: string;
  owner: string;
}
interface ChangesetAnswer {
  mode: "preview" | "apply";
  ok: boolean;
  changesetId?: string;
  previewHash?: string;
  apply?: { "command-id": string; expect: string };
  intents: {
    intents: number[];
    op: string;
    kind: string;
    id?: string;
    outcome: string;
    message?: string;
    undoable?: boolean;
  }[];
  checkWithOwner: { needed: boolean; why: string[] };
}

async function ok<T = unknown>(tool: string, args: Record<string, unknown> = {}): Promise<T> {
  const outcome = await call(tool, args);
  expect(outcome.isError, `${tool} ${JSON.stringify(args).slice(0, 300)}: ${outcome.text.slice(0, 1500)}`).toBe(false);
  return outcome.json as T;
}
const list = <T = Item>(entity: string, rest: Record<string, unknown> = {}) =>
  ok<T[]>("rhen_list", { entity, ...rest });
const search = (query: string, kinds?: string) =>
  ok<SearchResult>("rhen_search", { query, ...(kinds ? { kinds } : {}) });
const show = async (entity: string, id: string) => (await ok<{ item: Item }>("rhen_show", { entity, id })).item;
const brief = async () => {
  await refreshPlanning();
  return ok<Brief>("rhen_status", { brief: true });
};
const fullStatus = async () => {
  await refreshPlanning();
  return ok<FullStatus>("rhen_status");
};
async function only(query: string, kinds: string, title: string): Promise<string> {
  const found = await search(query, kinds);
  expect(found.results.map((result) => result.title)).toEqual([title]);
  return found.results[0]!.id;
}
const actionsTitled = async (pattern: RegExp) =>
  (await list("actions", { fields: "id,title,status,remainingMinutes" })).filter((item) =>
    pattern.test(String(item.title))
  );
const stated = (evidence: string) => ({ basis: "stated", evidence });
const commitmentsBetween = (from: number, to: number) =>
  list("commitments", {
    from: clock.local(from, "00:00"),
    to: clock.local(to, "00:00"),
    fields: "id,title,startsAt,endsAt"
  });

/** Everything the changeset touches, as an agent reads it, so an undo can be checked against the start. */
async function world() {
  const [row] = await sql<{ status: string }[]>`SELECT status FROM sessions`;
  const [prefs] = await sql<{ last_woke_at: Date }[]>`SELECT last_woke_at FROM user_preferences`;
  const deliverable = await show(
    "deliverable",
    await only("network design report", "deliverables", "Assessment 2: Network design report")
  );
  return {
    actions: await list("actions", {
      fields: "id,title,status,remainingMinutes,availableFrom,deadlineAt,notes,projectId"
    }),
    commitments: await commitmentsBetween(-1, 14),
    rules: await list("commitment-rules"),
    nights: (await list("sleep-plans")).filter((plan) => plan.status === "completed"),
    steps: deliverable.steps,
    session: row!.status,
    lastWokeAt: prefs!.last_woke_at.getTime(),
    location: (await fullStatus()).situation.locationName
  };
}

describe("the agent contract, as one changeset", () => {
  let intents: Record<string, unknown>[];
  let before: Awaited<ReturnType<typeof world>>;
  let preview: ChangesetAnswer;
  let applied: ChangesetAnswer;
  const ids = {} as Record<
    | "dana"
    | "electricity"
    | "slides"
    | "priya"
    | "form"
    | "library"
    | "rego"
    | "report"
    | "family"
    | "shift"
    | "dentist",
    string
  >;

  it("reads the ids the way an agent does, and builds the intents", async () => {
    ids.dana = await only("Dana trial shift", "actions", "Ask Dana about a supervisor trial shift");
    ids.electricity = await only("electricity", "actions", "Pay the electricity bill");
    ids.slides = await only("slides", "actions", "Finish the threat modelling slides");
    ids.priya = await only("Priya", "actions", "Email Priya: can the diagram be hand-drawn?");
    ids.form = await only("Mia", "actions", "Get Mia's excursion form signed");
    ids.library = await only("library", "actions", "Return the library books");
    ids.rego = await only("rego", "actions", "Renew the car rego");
    ids.report = await only("network design report", "deliverables", "Assessment 2: Network design report");
    expect((await search("gym")).total).toBe(0);
    expect((await search("mum", "actions")).total).toBe(0);

    ids.family = (await list("projects", { fields: "id,title" })).find((project) => project.title === "Family")!.id;
    const [shift, ...otherShifts] = await commitmentsBetween(3, 4);
    expect(otherShifts).toEqual([]);
    ids.shift = shift!.id;
    const dentist = (await commitmentsBetween(5, 8)).filter((commitment) => /dentist/i.test(String(commitment.title)));
    expect(dentist).toHaveLength(1);
    ids.dentist = dentist[0]!.id;
    const classEnds = (await commitmentsBetween(1, 2)).find((commitment) =>
      /class/i.test(String(commitment.title))
    )!.endsAt;
    const steps = (await show("deliverable", ids.report)).steps as Item[];
    const hours: Record<string, number> = {
      "Write sections 1 and 2": 100,
      "Write sections 3 and 4": 100,
      "Draw the network diagram": 50,
      "Add references and check the formatting": 25,
      "Submit the report": 25
    };

    before = await world();
    intents = [
      {
        op: "observe",
        kind: "sleep",
        fields: { sleepAt: clock.local(-1, "23:40"), wakeAt: clock.local(0, "07:30") },
        ...stated("went to bed at 11:40, up at 7:30")
      },
      {
        op: "observe",
        kind: "session",
        fields: { outcome: "progress", remaining: 40 },
        at: clock.local(-1, "15:00"),
        ...stated("I stopped lab 7 at 3 yesterday")
      },
      {
        op: "update",
        kind: "deliverable",
        id: ids.report,
        fields: {
          steps: steps.map((step) =>
            step.status === "done" ? step : { ...step, remainingMinutes: hours[String(step.title)] }
          )
        },
        ...stated("about 600 words written, five more hours")
      },
      {
        op: "create",
        kind: "commitment_rule",
        ref: "gym",
        fields: {
          title: "Gym",
          timezone: FIXTURE_ZONE,
          startDate: clock.date(1),
          repeat: { unit: "weeks", intervalWeeks: 1, weekdays: [2, 4] },
          localStartTime: "18:00",
          localEndTime: "19:00",
          setupBeforeMinutes: 0,
          transitionAfterMinutes: 0
        },
        ...stated("gym is Tuesday and Thursday at 6")
      },
      {
        op: "create",
        kind: "action",
        ref: "mum",
        fields: {
          title: "Call mum",
          projectId: ids.family,
          availableFrom: clock.local(4, "12:00"),
          deadlineAt: clock.local(4, "17:00")
        },
        ...stated("call mum Sunday afternoon")
      },
      { op: "complete", kind: "action", id: ids.dana, ...stated("Dana confirmed the trial shift") },
      {
        op: "update",
        kind: "commitment",
        id: ids.shift,
        fields: { title: "Work (supervisor trial)" },
        ...stated("Dana confirmed the supervisor trial shift on Saturday")
      },
      {
        op: "complete",
        kind: "action",
        id: ids.electricity,
        at: clock.local(-2, "12:00"),
        ...stated("paid the electricity bill on Monday")
      },
      {
        op: "update",
        kind: "commitment",
        id: ids.dentist,
        fields: { startsAt: clock.local(7, "10:00"), endsAt: clock.local(7, "10:45") },
        ...stated("dentist moved to next Wednesday at 10")
      },
      {
        op: "update",
        kind: "action",
        id: ids.slides,
        fields: { remainingMinutes: 15 },
        ...stated("slides are half done")
      },
      {
        op: "update",
        kind: "action",
        id: ids.priya,
        fields: { title: "Tell Priya the diagram can be hand-drawn", status: "planned" },
        ...stated("tell Priya the diagram can be hand-drawn")
      },
      { op: "observe", kind: "place", fields: { place: "Home" }, ...stated("I'm home") },
      { op: "complete", kind: "action", id: ids.form, ...stated("Mia's form is signed") },
      {
        op: "update",
        kind: "action",
        id: ids.library,
        fields: { availableFrom: classEnds, deadlineAt: clock.local(1, "17:00") },
        ...stated("library books go back Thursday after uni, it shuts at 5")
      },
      {
        op: "update",
        kind: "action",
        id: ids.rego,
        fields: {
          availableFrom: clock.local(5, "00:00"),
          deadlineAt: clock.local(11, "23:59"),
          notes: `Rego runs out on ${clock.date(12)}`
        },
        ...stated("rego runs out on the 9th")
      }
    ];
  });

  it("preview: every intent applies, and nothing is kept", async () => {
    preview = await ok<ChangesetAnswer>("rhen_changeset", {
      mode: "preview",
      changes: intents,
      "command-id": COMMAND_ID
    });
    expect(
      preview.intents.map((item) => `${item.intents.join("+")} ${item.kind}: ${item.outcome} ${item.message ?? ""}`)
    ).toEqual(preview.intents.map((item) => `${item.intents.join("+")} ${item.kind}: applies `));
    expect(preview.intents).toHaveLength(intents.length);
    expect(preview.ok).toBe(true);
    expect(preview.previewHash).toMatch(/^[0-9a-f]{16}$/);
    expect(preview.apply).toEqual({ "command-id": COMMAND_ID, expect: preview.previewHash });
    // Nothing was kept.
    expect(await world()).toEqual(before);
    expect(await actionsTitled(/Call mum/)).toEqual([]);
  });

  it("apply: with the preview's hash and command id, keeps all of it", async () => {
    const outcome = await call("rhen_changeset", {
      mode: "apply",
      changes: intents,
      expect: preview.previewHash,
      "command-id": COMMAND_ID
    });
    expect(outcome.isError, outcome.text.slice(0, 1500)).toBe(false);
    // The CLI appends its notes (how to undo) after the JSON answer.
    applied = JSON.parse(outcome.text.split("\nNotes from the CLI:")[0]!) as ChangesetAnswer;
    expect(applied.ok).toBe(true);
    expect(applied.changesetId).toBeTruthy();
    expect(applied.intents.map((item) => item.outcome)).toEqual(applied.intents.map(() => "applies"));
    await refreshPlanning();
  });

  it("sleep: the night already logged is corrected in place, and the wake counts", async () => {
    const nights = (await list("sleep-plans")).filter((plan) => plan.status === "completed");
    expect(nights).toHaveLength(1);
    expect(nights[0]!.id).toBe(before.nights[0]!.id);
    expect(instant(nights[0]!.actualStartAt)).toBe(at(-1, "23:40"));
    expect(instant(nights[0]!.actualWakeAt)).toBe(at(0, "07:30"));
    const history = await ok<{ sleep: { minutes: number }[] }>("rhen_history", {
      from: clock.date(-1),
      to: clock.date(0)
    });
    expect(history.sleep).toHaveLength(1);
    expect(history.sleep[0]!.minutes).toBe(470);
    const [preferences] = await sql<{ last_woke_at: Date }[]>`SELECT last_woke_at FROM user_preferences`;
    expect(preferences!.last_woke_at.getTime()).toBe(at(0, "07:30"));
  });

  it("stale session: Lab 7 ends when he stopped", async () => {
    const history = await ok<{ sessions: Item[] }>("rhen_history", {
      from: clock.date(-1),
      to: clock.date(0)
    });
    expect(history.sessions).toHaveLength(1);
    const [session] = history.sessions;
    expect(session).toMatchObject({
      actionTitle: "Lab 7: VLAN notes",
      result: "stopped",
      plannedMinutes: 60,
      activeMinutes: 120,
      remainingAfterMinutes: 40,
      segmentCount: 1,
      date: clock.date(-1)
    });
    expect(instant(session!.startedAt)).toBe(at(-1, "13:00"));
    expect(instant(session!.endedAt)).toBe(at(-1, "15:00"));
    const lab = await actionsTitled(/^Lab 7/);
    expect(lab).toHaveLength(1);
    expect(lab[0]!.remainingMinutes).toBe(40);
    expect((await brief()).session).toBeNull();
  });

  it("essay: five more hours over the open steps, the same steps, deadlines untouched", async () => {
    const after = await show("deliverable", ids.report);
    const stepsAfter = after.steps as Item[];
    const stepsBefore = before.steps as Item[];
    expect(stepsAfter.map((step) => step.id)).toEqual(stepsBefore.map((step) => step.id));
    expect(stepsAfter.map((step) => step.status)).toEqual(stepsBefore.map((step) => step.status));
    expect(
      stepsAfter.filter((step) => step.status !== "done").reduce((sum, step) => sum + Number(step.remainingMinutes), 0)
    ).toBe(300);
    expect(instant(after.internalDeadlineAt)).toBe(at(2, "17:00"));
    expect(instant(after.externalDeadlineAt)).toBe(at(3, "23:59"));
    expect(await list("deliverables", { fields: "id,title" })).toHaveLength(1);
  });

  it("gym: a new Tuesday and Thursday 6pm rule, beside the Spin class", async () => {
    const rules = await list("commitment-rules");
    expect(rules).toHaveLength(4);
    expect(rules.filter((rule) => rule.title === "Gym")).toHaveLength(1);
    expect(rules.find((rule) => rule.title === "Gym")).toMatchObject({
      status: "active",
      timezone: FIXTURE_ZONE,
      startDate: clock.date(1),
      repeat: { unit: "weeks", intervalWeeks: 1, weekdays: [2, 4] },
      localStartTime: "18:00",
      localEndTime: "19:00"
    });
    expect(rules.find((rule) => rule.title === "Spin class")).toMatchObject({ repeat: { weekdays: [3, 5] } });
    const gym = (
      await list("commitments", {
        from: clock.local(1, "00:00"),
        to: clock.local(7, "00:00"),
        fields: "id,title,startsAt,endsAt"
      })
    ).filter((commitment) => commitment.title === "Gym");
    const gymTimes = gym.map((commitment) => [instant(commitment.startsAt), instant(commitment.endsAt)]);
    expect(gymTimes.sort(([a], [b]) => a! - b!)).toEqual([
      [at(1, "18:00"), at(1, "19:00")],
      [at(6, "18:00"), at(6, "19:00")]
    ]);
  });

  it("call mum: one new action in Family for Sunday afternoon", async () => {
    const mums = (await list("actions", { fields: "id,title,status,projectId,availableFrom,deadlineAt" })).filter(
      (action) => action.title === "Call mum"
    );
    expect(mums).toHaveLength(1);
    expect(mums[0]).toMatchObject({ status: "planned", projectId: ids.family });
    expect(instant(mums[0]!.availableFrom)).toBe(at(4, "12:00"));
    expect(instant(mums[0]!.deadlineAt)).toBe(at(4, "17:00"));
    expect((await search("mum", "actions")).total).toBe(1);
  });

  it("Dana and the shift: the question is done, and Saturday's shift is renamed without moving", async () => {
    expect((await actionsTitled(/Dana/)).map((action) => action.status)).toEqual(["done"]);
    const [renamed, ...rest] = await commitmentsBetween(3, 4);
    expect(rest).toEqual([]);
    expect(renamed).toMatchObject({ id: ids.shift, title: "Work (supervisor trial)" });
    expect(instant(renamed!.startsAt)).toBe(at(3, "07:00"));
    expect(instant(renamed!.endsAt)).toBe(at(3, "15:30"));
    expect((await list("commitment-rules", { fields: "id,title" })).map((rule) => rule.title)).toContain(
      "Work (shift)"
    );
    const nextSaturday = await commitmentsBetween(10, 11);
    expect(nextSaturday.map((commitment) => commitment.title)).toEqual(["Work (shift)"]);
  });

  it("electricity: done, dated Monday, and no longer a deadline in the next two days", async () => {
    expect(await actionsTitled(/electricity/)).toMatchObject([{ id: ids.electricity, status: "done" }]);
    const [row] = await sql<
      { completed_at: Date | null }[]
    >`SELECT completed_at FROM actions WHERE title LIKE '%electricity%'`;
    expect(row!.completed_at?.getTime()).toBe(at(-2, "12:00"));
    expect((await brief()).deadlinesWithin48h.map((deadline) => deadline.id)).not.toContain(ids.electricity);
  });

  it("dentist: the booking moves to next Wednesday at 10, and the Tuesday slot is empty", async () => {
    const dentistIn = async (from: number, to: number) =>
      (await commitmentsBetween(from, to)).filter((commitment) => /dentist/i.test(String(commitment.title)));
    expect(await dentistIn(6, 7)).toEqual([]);
    const [moved, ...rest] = await dentistIn(7, 8);
    expect(rest).toEqual([]);
    expect(moved!.id).toBe(ids.dentist);
    expect(instant(moved!.startsAt)).toBe(at(7, "10:00"));
    expect(instant(moved!.endsAt)).toBe(at(7, "10:45"));
  });

  it("slides: half done means 15 of 30 minutes left, and the action stays in progress", async () => {
    expect(await actionsTitled(/slides/)).toMatchObject([{ id: ids.slides, remainingMinutes: 15, status: "doing" }]);
    expect((await show("action", ids.slides)).expectedMinutes).toBe(30);
  });

  it("Priya: the one Priya action is rewritten in place and is no longer waiting", async () => {
    expect(await actionsTitled(/Priya/)).toMatchObject([
      { id: ids.priya, title: "Tell Priya the diagram can be hand-drawn", status: "planned" }
    ]);
  });

  it("home: arriving at Home moves where he is, and Now says so", async () => {
    expect((await fullStatus()).situation).toMatchObject({ locationId: "place-home", locationName: "Home" });
  });

  it("form: Mia's form is done, and only the one form action exists", async () => {
    expect(await actionsTitled(/Mia/)).toMatchObject([{ id: ids.form, status: "done" }]);
  });

  it("library: back after Thursday's class ends, before it shuts at five", async () => {
    const libraries = (await list("actions", { fields: "id,title,availableFrom,deadlineAt" })).filter((action) =>
      /library/i.test(String(action.title))
    );
    expect(libraries).toHaveLength(1);
    expect(instant(libraries[0]!.availableFrom)).toBe(at(1, "15:30"));
    expect(instant(libraries[0]!.deadlineAt)).toBe(at(1, "17:00"));
    expect((await brief()).deadlinesWithin48h).toMatchObject([{ id: ids.library, title: "Return the library books" }]);
  });

  it("rego: a window from Monday to the Sunday before it runs out, with the date in its note", async () => {
    const rego = await show("action", ids.rego);
    expect(instant(rego.availableFrom)).toBe(at(5, "00:00"));
    expect(instant(rego.deadlineAt)).toBe(at(11, "23:59"));
    expect(rego.notes).toBe(`Rego runs out on ${clock.date(12)}`);
    expect(await actionsTitled(/rego/i)).toHaveLength(1);
  });

  it("flat: feeling flat is not written anywhere", async () => {
    const [row] = await sql<{ proposals: number }[]>`SELECT count(*)::int AS proposals FROM agent_proposals`;
    expect(row!.proposals).toBe(0);
    expect((await brief()).inboxPending).toBe(0);
    expect(await list("captures", { fields: "id" })).toEqual([]);
  });

  it("Now: what status answers after all of it", async () => {
    const now = await fullStatus();
    expect(now.plan.status).toBe("current");
    expect(now.session).toBeNull();
    expect(now.situation.locationName).toBe("Home");
    expect(now.nextCommitment).toMatchObject({ title: "Spin class" });
    expect(instant(now.nextCommitment!.startsAt)).toBe(at(0, "18:00"));
    const offered = [now.directive?.title, ...now.upcoming.map((item) => item.title)];
    for (const title of [
      "Pay the electricity bill",
      "Get Mia's excursion form signed",
      "Ask Dana about a supervisor trial shift",
      "Call mum",
      "Renew the car rego",
      "Return the library books"
    ])
      expect(offered).not.toContain(title);
    const short = await brief();
    expect(short.nextCommitment).toMatchObject({ title: "Spin class", minutesAway: 570 });
    expect(short.deadlinesWithin48h.map((deadline) => deadline.title)).toEqual(["Return the library books"]);
  });

  it("the ledger: the changeset is one undo entry and one set of change-feed rows under the command id", async () => {
    const journal = await ok<JournalEntry[]>("rhen_undo", { list: true });
    // The write ledger lists the changeset as one write under its command id.
    expect(journal).toHaveLength(1);
    expect(journal[0]).toMatchObject({ id: COMMAND_ID, label: `changeset of ${applied.intents.length} writes` });
    expect(journal[0]!.status).toBe("applied");
    const { changes } = await ok<{ changes: { actor: string; commandId: string }[] }>("rhen_changes", {
      agent: "openclaw",
      limit: 100
    });
    expect(new Set(changes.map((change) => change.actor))).toEqual(new Set(["openclaw"]));
    expect(changes.length).toBeGreaterThanOrEqual(intents.length - 1);
  });

  it("undo: one undo of the changeset puts back every member that can be undone, and says which cannot", async () => {
    expect(applied.intents.filter((item) => item.undoable === false).map((item) => item.kind)).toEqual([]);
    const entry = (await ok<JournalEntry[]>("rhen_undo", { list: true })).find((item) => item.id === COMMAND_ID)!;
    await ok("rhen_undo", { id: entry.id });
    await refreshPlanning();
    const after = await world();
    expect.soft(after.actions).toEqual(before.actions);
    expect.soft(after.commitments).toEqual(before.commitments);
    expect.soft(after.rules).toEqual(before.rules);
    // An undo restores the values at a new row version, so versions are not compared.
    const unversioned = (nights: Item[]) => nights.map(({ version: _version, ...night }) => night);
    expect.soft(unversioned(after.nights)).toEqual(unversioned(before.nights));
    expect.soft(unversioned(after.steps as Item[])).toEqual(unversioned(before.steps as Item[]));
    expect.soft(after.session).toEqual(before.session);
    expect.soft(after.lastWokeAt).toEqual(before.lastWokeAt);
    expect.soft(after.location).toEqual(before.location);
    expect.soft(await actionsTitled(/Call mum/)).toEqual([]);
    expect.soft((await list("commitment-rules")).filter((rule) => rule.title === "Gym")).toEqual([]);
    expect((await ok<JournalEntry[]>("rhen_undo", { list: true }))[0]!.status).toBe("undone");
  });

  it("still low, still home: a stale energy and place said again through a changeset are dated afresh", async () => {
    const situation = async () =>
      (
        await sql<{ energy: string; place: string; energy_set_at: string | null; location_set_at: string }[]>`
          SELECT current_energy AS energy, current_situation->>'locationId' AS place,
            current_situation->>'energySetAt' AS energy_set_at,
            current_situation->>'locationSetAt' AS location_set_at
          FROM user_preferences`
      )[0]!;
    const was = await situation();
    // Nine hours on, both are stale; saying the same values is what makes them current again.
    const later = clock.now.getTime() + 9 * 60 * 60 * 1000;
    vi.setSystemTime(later);
    try {
      const outcome = await call("rhen_changeset", {
        mode: "apply",
        changes: [
          { op: "observe", kind: "energy", fields: { energy: was.energy }, ...stated(`still ${was.energy}`) },
          { op: "observe", kind: "place", fields: { place: was.place }, ...stated("still here") }
        ],
        "command-id": "6f1c2d3e-4a5b-4c6d-8e7f-90a1b2c3d4e5",
        // The clock is held, so waiting for the plan would never end; the brief can say pending.
        wait: "0"
      });
      expect(outcome.isError, outcome.text.slice(0, 1500)).toBe(false);
      const answer = JSON.parse(outcome.text.split("\nNotes from the CLI:")[0]!) as ChangesetAnswer;
      expect(answer.intents.map((item) => item.outcome)).toEqual(["applies"]);
      const now = await situation();
      expect({ energy: now.energy, place: now.place }).toEqual({ energy: was.energy, place: was.place });
      expect(new Date(now.energy_set_at!).getTime()).toBe(later);
      expect(new Date(now.location_set_at).getTime()).toBe(later);
    } finally {
      vi.setSystemTime(clock.now);
    }
  });
});
