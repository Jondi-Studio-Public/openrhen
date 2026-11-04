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
 * The agent contract: what an agent that follows the OpenClaw skill gets for the facts in a single owner message of
 * the kind an agent trust review replays,
 * against a seeded portal, through `/mcp` itself. The agent is the plugin's own token (its manifest scopes, every
 * direct write on, the database undo journal) and every call is a JSON-RPC `tools/call` that goes through the
 * manifest's schema check and the generated route table, so a tool that stops accepting what the skill tells an agent
 * to send fails here before it fails in front of the owner. Each fact is replayed as the skill says (look up, then write
 * with `basis` and `evidence`), then read back the way an agent would: the record's kind, fields and times, that no
 * second copy appeared, that the undo journal and the change feed hold the write, and that the Now answer
 * (`rhen_status`) moved.
 *
 * Wednesday's facts end with a block of stale ones (fact freshness): the portal's clock is moved on to the
 * instant each fact ages out, and an open session, a paused one, an unsaid energy and an old wake are each asked about
 * and settled the way the need itself says. The session here was already stopped at its planned end by the page, which
 * is the case the session-clock fix covers; that block covers the one nobody closed at all.
 *
 * Of the sixteen facts, fifteen are replayed (feeling flat is a replay too: the skill says to write nothing, and the
 * test checks nothing was written). Two more writes, which are not from his message, pin how the portal keys what an
 * agent creates: a project and an action made with no id are keyed by their command ids (so a retry finds them), and an
 * action made with a chosen slug is stored under the hash of it, which is the id the change feed and the undo journal
 * name. It asserts only outcomes that are right on main today. A fact, or the part of one,
 * that cannot land right yet is not replayed (no skip, no assertion of the wrong result) and waits here, so the fix
 * that makes it land adds it in the same change:
 *
 *   - The 9pm rule ("no study after 9pm") joins when a plan preference for one area or tag exists. Today its only
 *     home is the global, guarded `planningHorizonEnd`, which is the wrong scope.
 *   - The 600 words written have no field. Only the "five more hours" half of the essay is replayed; the words join
 *     when progress can be stated on a deliverable.
 *   - Anything ambiguous in what he said (a date that is not that weekday, "Thursday after uni" with no uni on
 *     Thursday, "tell Priya" beside an existing "Email Priya: can it be hand-drawn?") joins when a write can carry a
 *     "needs confirming" flag. The replay uses the unambiguous reading, and for Priya checks only that the existing
 *     action is updated in place, never duplicated.
 *   - The same facts sent as one changeset are replayed in `agent-contract-changeset.integration.test.ts`; here they
 *     are written one record at a time, as an agent without the changeset tool would.
 *   - Undo of the sleep night and of the Gym recurrence rule joins when those two writes take a reverse. The write
 *     ledger keeps row images only for session, check-in, catch-up and confirm writes, and the CLI builds
 *     no reverse for a sleep-log-entry update (`reverseOfUpdate` needs a state key) or for `recurrence set`. Both
 *     are written and read back here; neither has a journal entry to check, and the ledger test counts exactly
 *     the entries that exist, so a new one fails it until it is added.
 *   - A done action's `completedAt` is checked in the database, because no read tool returns it; it joins the
 *     agent's reads when the typed manifest carries it.
 *
 * Time is fixed: the portal's clock is faked at Wednesday 08:30 Brisbane (`contractClock`), so "Thursday", "next
 * Wednesday" and "Monday" are the same days on every run. Only the week is the real one, because the sleep log is read
 * against the database's own clock.
 */
const BASE = "openrhen_agent_contract";
setupStateStoreSuite(BASE, { resetBetweenTests: false });

const clock = contractClock();
const at = (days: number, time: string) => clock.at(days, time).getTime();
const instant = (value: unknown) => Date.parse(String(value));

/** A fixed command id per write, so the change feed can be matched back to the call that made it. */
const commandId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const COMMAND = {
  sleep: commandId(1),
  session: commandId(2),
  essay: commandId(3),
  gym: commandId(4),
  mum: commandId(5),
  dana: commandId(6),
  shift: commandId(7),
  electricity: commandId(8),
  dentist: commandId(9),
  slides: commandId(10),
  priya: commandId(11),
  home: commandId(12),
  form: commandId(13),
  library: commandId(14),
  rego: commandId(15),
  // Not from his message: the project and the chosen-slug action that pin how created records are keyed.
  birthday: commandId(16),
  flowers: commandId(17)
} as const;

/** The record each write touched, noted as the facts are replayed, so the change feed can be checked against them. */
const touched: Partial<Record<keyof typeof COMMAND, string>> = {};

let call: AgentCall;
let previousDatabaseUrl: string | undefined;

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: clock.at(-1, "12:50") });
  // The route handlers behind `/mcp` reach the database through DATABASE_URL, as the portal does.
  const url = new URL(process.env.POSTGRES_ADMIN_URL!);
  url.pathname = `/${integrationDatabaseName(process.env.TEST_DATABASE_NAME, BASE)}`;
  previousDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = url.toString();

  await sql.unsafe("TRUNCATE TABLE users, portal_state, jobs RESTART IDENTITY CASCADE");
  // Tuesday: the plan as it stood, and Lab 7 started for an hour that nobody ever closed.
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
  // Wednesday: the portal opens, sees the planned end long gone, and asks for feedback, which stops the clock at the
  // planned end (14:00) instead of running it to now.
  vi.setSystemTime(clock.at(0, "08:29"));
  await unplannedStore.runSessionCommand({
    commandId: crypto.randomUUID(),
    expectedVersion: started.activeSession!.version ?? null,
    type: "request_feedback",
    sessionId: started.activeSession!.id
  });
  await seedContractRepeats(unplannedStore, clock);
  // 08:30: the message reaches the agent.
  vi.setSystemTime(clock.now);
  await refreshPlanning();
  call = await connectAgent(clock);
}, 120_000);

afterAll(() => {
  vi.useRealTimers();
  if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = previousDatabaseUrl;
});

// What an agent reads back. Only the fields a check below uses are named.
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
  plan: string;
  session: unknown;
  inboxPending: number;
  next: Item[];
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
  needs: Need[];
}
/** One entry of status's `needs`: what has gone stale and the call that settles it. Instants are in his zone. */
interface Need {
  fact: "wake" | "session_end" | "energy" | "location" | "date" | "effort";
  subjectId?: string;
  title: string;
  question: string;
  asOf?: string;
  blocksDirective: boolean;
  answer: {
    tool: string;
    action: string;
    fields: string[];
    cli: string;
    call: { tool: string; arguments: Record<string, unknown> };
    instructions: string;
  };
}
interface JournalEntry {
  id: string;
  label: string;
  status: string;
  owner: string;
}

/** A tool call that must succeed, answered as parsed JSON. */
async function ok<T = unknown>(tool: string, args: Record<string, unknown> = {}): Promise<T> {
  const outcome = await call(tool, args);
  expect(outcome.isError, `${tool} ${JSON.stringify(args).slice(0, 300)}: ${outcome.text.slice(0, 600)}`).toBe(false);
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
/** The one record a search finds under that title, so a write updates it rather than adding a second. */
async function only(query: string, kinds: string, title: string, fact: keyof typeof COMMAND): Promise<string> {
  const found = await search(query, kinds);
  expect(found.results.map((result) => result.title)).toEqual([title]);
  touched[fact] = found.results[0]!.id;
  return found.results[0]!.id;
}
const actionsTitled = async (pattern: RegExp) =>
  (await list("actions", { fields: "id,title,status,remainingMinutes" })).filter((item) =>
    pattern.test(String(item.title))
  );
const stated = (evidence: string) => ({ basis: "stated", evidence });

describe("the agent contract: the owner's Wednesday message, replayed through /mcp", () => {
  it("sleep: corrects the night already logged, in place, and the wake counts", async () => {
    const nights = async () => (await list("sleep-plans")).filter((plan) => plan.status === "completed");
    const [logged, ...others] = await nights();
    expect(others).toEqual([]);

    await ok("rhen_save", {
      entityType: "sleep-log-entry",
      id: logged!.id,
      fields: { sleepAt: clock.local(-1, "23:40"), wakeAt: clock.local(0, "07:30") },
      ...stated("went to bed at 11:40, up at 7:30"),
      "command-id": COMMAND.sleep
    });

    const [night, ...rest] = await nights();
    expect(rest).toEqual([]);
    expect(night!.id).toBe(logged!.id);
    expect(instant(night!.actualStartAt)).toBe(at(-1, "23:40"));
    expect(instant(night!.actualWakeAt)).toBe(at(0, "07:30"));
    const history = await ok<{ sleep: { minutes: number; actualWakeAt: string }[] }>("rhen_history", {
      from: clock.date(-1),
      to: clock.date(0)
    });
    expect(history.sleep).toHaveLength(1);
    expect(history.sleep[0]!.minutes).toBe(470);
    // The wake the engine plans from is the corrected one, not the 06:20 first logged.
    const [preferences] = await sql<{ last_woke_at: Date }[]>`SELECT last_woke_at FROM user_preferences`;
    expect(preferences!.last_woke_at.getTime()).toBe(at(0, "07:30"));
  });

  it("stale session: Lab 7 ends when he stopped, not when the page noticed", async () => {
    const [waiting] = await sql<{ status: string }[]>`SELECT status FROM sessions`;
    expect(waiting!.status).toBe("awaiting_feedback");

    await ok("rhen_session", {
      subcommand: "finish",
      outcome: "progress",
      remaining: 40,
      "ended-at": clock.local(-1, "15:00"),
      ...stated("I stopped lab 7 at 3 yesterday"),
      "command-id": COMMAND.session
    });

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
      // 13:00 to 15:00, not the 1,163 minutes the review recorded when the end was left to the page.
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

  it("essay: five more hours is spread over the open steps, and the steps stay the same steps", async () => {
    const reportId = await only(
      "network design report",
      "deliverables",
      "Assessment 2: Network design report",
      "essay"
    );
    const before = await show("deliverable", reportId);
    const steps = before.steps as Item[];
    const hours: Record<string, number> = {
      "Write sections 1 and 2": 100,
      "Write sections 3 and 4": 100,
      "Draw the network diagram": 50,
      "Add references and check the formatting": 25,
      "Submit the report": 25
    };
    await ok("rhen_save", {
      entityType: "deliverable",
      id: reportId,
      fields: {
        steps: steps.map((step) =>
          step.status === "done" ? step : { ...step, remainingMinutes: hours[String(step.title)] }
        )
      },
      ...stated("about 600 words written, five more hours"),
      "command-id": COMMAND.essay
    });

    const after = await show("deliverable", reportId);
    const stepsAfter = after.steps as Item[];
    expect(stepsAfter.map((step) => step.id)).toEqual(steps.map((step) => step.id));
    expect(stepsAfter.map((step) => step.status)).toEqual(steps.map((step) => step.status));
    expect(
      stepsAfter.filter((step) => step.status !== "done").reduce((sum, step) => sum + Number(step.remainingMinutes), 0)
    ).toBe(300);
    // His deadlines were not part of what he said.
    expect(instant(after.internalDeadlineAt)).toBe(at(2, "17:00"));
    expect(instant(after.externalDeadlineAt)).toBe(at(3, "23:59"));
    expect(await list("deliverables", { fields: "id,title" })).toHaveLength(1);
  });

  it("gym: a new Tuesday and Thursday 6pm rule, beside the Spin class that is already there", async () => {
    expect((await search("gym")).total).toBe(0);
    const rulesBefore = await list("commitment-rules", { fields: "id,title" });
    expect(rulesBefore.map((rule) => rule.title).sort()).toEqual(["Networking class", "Spin class", "Work (shift)"]);

    await ok("rhen_recurrence", {
      subcommand: "set",
      set: [
        "title=Gym",
        `timezone=${FIXTURE_ZONE}`,
        `startDate=${clock.date(1)}`,
        "repeat.unit=weeks",
        "repeat.intervalWeeks=1",
        "repeat.weekdays=[2,4]",
        "localStartTime=18:00",
        "localEndTime=19:00",
        "setupBeforeMinutes=0",
        "transitionAfterMinutes=0"
      ],
      yes: true,
      ...stated("gym is Tuesday and Thursday at 6"),
      "command-id": COMMAND.gym
    });

    const rules = await list("commitment-rules");
    expect(rules).toHaveLength(4);
    expect(rules.filter((rule) => rule.title === "Gym")).toHaveLength(1);
    touched.gym = rules.find((rule) => rule.title === "Gym")!.id;
    expect(rules.find((rule) => rule.title === "Gym")).toMatchObject({
      status: "active",
      timezone: FIXTURE_ZONE,
      startDate: clock.date(1),
      repeat: { unit: "weeks", intervalWeeks: 1, weekdays: [2, 4] },
      localStartTime: "18:00",
      localEndTime: "19:00"
    });
    expect(rules.find((rule) => rule.title === "Spin class")).toMatchObject({ repeat: { weekdays: [3, 5] } });
    // The rule's occurrences are written by the next plan, so the agent reads them after it. Thursday, then
    // Tuesday, at six in the evening.
    await refreshPlanning();
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

  it("call mum: one new action in Family for Sunday afternoon, made with no id, and a retry adds no second", async () => {
    expect((await search("mum", "actions")).total).toBe(0);
    const family = (await list("projects", { fields: "id,title" })).find((project) => project.title === "Family")!;
    // The skill's "no id creates": the action is keyed by the command id, so the retry finds the same one.
    const write = () =>
      ok("rhen_save_action", {
        fields: {
          title: "Call mum",
          projectId: family.id,
          availableFrom: clock.local(4, "12:00"),
          deadlineAt: clock.local(4, "17:00")
        },
        ...stated("call mum Sunday afternoon"),
        "command-id": COMMAND.mum
      });
    await write();
    // The write timed out, so the agent sent it again with the same command id.
    await write();

    const mums = (await list("actions", { fields: "id,title,status,projectId,availableFrom,deadlineAt" })).filter(
      (action) => action.title === "Call mum"
    );
    expect(mums).toHaveLength(1);
    expect(mums[0]).toMatchObject({ id: COMMAND.mum, status: "planned", projectId: family.id });
    expect(instant(mums[0]!.availableFrom)).toBe(at(4, "12:00"));
    expect(instant(mums[0]!.deadlineAt)).toBe(at(4, "17:00"));
    expect((await search("mum", "actions")).total).toBe(1);
    touched.mum = mums[0]!.id;
  });

  it("ids: a project made with no id is keyed by its command id, a chosen slug is stored hashed, and both are named by the stored id", async () => {
    const family = (await list("projects", { fields: "id,title,outcomeId" })).find(
      (project) => project.title === "Family"
    )!;
    // The generic tool, which the skill sends the other kinds through, takes a project and an action the same way.
    await ok("rhen_save", {
      entityType: "project",
      fields: { title: "Mum's birthday", outcomeId: family.outcomeId },
      ...stated("it is mum's birthday on Sunday"),
      "command-id": COMMAND.birthday
    });
    const birthdays = (await list("projects", { fields: "id,title,status" })).filter(
      (project) => project.title === "Mum's birthday"
    );
    expect(birthdays).toMatchObject([{ id: COMMAND.birthday, status: "active" }]);
    touched.birthday = COMMAND.birthday;

    await ok("rhen_save", {
      entityType: "action",
      id: "action-flowers",
      create: true,
      fields: { title: "Buy flowers", projectId: COMMAND.birthday },
      ...stated("buy flowers for her birthday"),
      "command-id": COMMAND.flowers
    });
    const flowers = await actionsTitled(/^Buy flowers/);
    expect(flowers).toHaveLength(1);
    // The portal keys a slug by hashing it: the record lives under a uuid, and every read of it names that one.
    expect(flowers[0]!.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(flowers[0]!.id).not.toBe("action-flowers");
    expect((await show("action", flowers[0]!.id)).title).toBe("Buy flowers");
    touched.flowers = flowers[0]!.id;
  });

  it("Dana and the shift: the question is done, and Saturday's shift is renamed without moving", async () => {
    const danaId = await only("Dana trial shift", "actions", "Ask Dana about a supervisor trial shift", "dana");
    await ok("rhen_save_action", {
      id: danaId,
      fields: { status: "done" },
      ...stated("Dana confirmed the trial shift"),
      "command-id": COMMAND.dana
    });
    expect((await actionsTitled(/Dana/)).map((action) => action.status)).toEqual(["done"]);

    const saturday = () =>
      list("commitments", {
        from: clock.local(3, "00:00"),
        to: clock.local(4, "00:00"),
        fields: "id,title,startsAt,endsAt"
      });
    const [shift, ...others] = await saturday();
    expect(others).toEqual([]);
    touched.shift = shift!.id;
    expect(shift!.title).toBe("Work (shift)");
    await ok("rhen_save_commitment", {
      id: shift!.id,
      fields: { title: "Work (supervisor trial)" },
      ...stated("Dana confirmed the supervisor trial shift on Saturday"),
      "command-id": COMMAND.shift
    });

    const [renamed, ...rest] = await saturday();
    expect(rest).toEqual([]);
    expect(renamed).toMatchObject({ id: shift!.id, title: "Work (supervisor trial)" });
    expect(instant(renamed!.startsAt)).toBe(at(3, "07:00"));
    expect(instant(renamed!.endsAt)).toBe(at(3, "15:30"));
    // Only that Saturday: the rule, and the Saturday after it, are still the shift.
    expect((await list("commitment-rules", { fields: "id,title" })).map((rule) => rule.title)).toContain(
      "Work (shift)"
    );
    const nextSaturday = await list("commitments", {
      from: clock.local(10, "00:00"),
      to: clock.local(11, "00:00"),
      fields: "id,title"
    });
    expect(nextSaturday.map((commitment) => commitment.title)).toEqual(["Work (shift)"]);
  });

  it("electricity: done, dated Monday, and no longer a deadline in the next two days", async () => {
    const id = await only("electricity", "actions", "Pay the electricity bill", "electricity");
    expect((await brief()).deadlinesWithin48h.map((deadline) => deadline.id)).toContain(id);

    await ok("rhen_save_action", {
      id,
      fields: { status: "done", completedAt: clock.local(-2, "12:00") },
      ...stated("paid the electricity bill on Monday"),
      "command-id": COMMAND.electricity
    });

    expect(await actionsTitled(/electricity/)).toMatchObject([{ id, status: "done" }]);
    const [row] = await sql<
      { completed_at: Date | null }[]
    >`SELECT completed_at FROM actions WHERE title LIKE '%electricity%'`;
    expect(row!.completed_at?.getTime()).toBe(at(-2, "12:00"));
    expect((await brief()).deadlinesWithin48h.map((deadline) => deadline.id)).not.toContain(id);
  });

  it("dentist: the booking moves to next Wednesday at 10, and the Tuesday slot is empty", async () => {
    // Looked up in the calendar around its slot, not by search: search keeps only records still in play by
    // default, judged by the database's real clock, and which week this runs in is not fixed.
    const dentistIn = async (fromDay: number, toDay: number) =>
      (
        await list("commitments", {
          from: clock.local(fromDay, "00:00"),
          to: clock.local(toDay, "00:00"),
          fields: "id,title,startsAt,endsAt"
        })
      ).filter((commitment) => /dentist/i.test(String(commitment.title)));
    const [booked, ...others] = await dentistIn(5, 8);
    expect(others).toEqual([]);
    expect(booked).toMatchObject({ title: "Dentist check-up" });
    expect(instant(booked!.startsAt)).toBe(at(6, "14:00"));
    touched.dentist = booked!.id;

    await ok("rhen_save_commitment", {
      id: booked!.id,
      fields: { startsAt: clock.local(7, "10:00"), endsAt: clock.local(7, "10:45") },
      ...stated("dentist moved to next Wednesday at 10"),
      "command-id": COMMAND.dentist
    });

    expect(await dentistIn(6, 7)).toEqual([]);
    const [moved, ...rest] = await dentistIn(7, 8);
    expect(rest).toEqual([]);
    expect(moved!.id).toBe(booked!.id);
    expect(instant(moved!.startsAt)).toBe(at(7, "10:00"));
    expect(instant(moved!.endsAt)).toBe(at(7, "10:45"));
  });

  it("slides: half done means 15 of 30 minutes left, and the action stays in progress", async () => {
    const id = await only("slides", "actions", "Finish the threat modelling slides", "slides");
    expect(await actionsTitled(/slides/)).toMatchObject([{ remainingMinutes: 30, status: "doing" }]);

    await ok("rhen_save_action", {
      id,
      fields: { remainingMinutes: 15 },
      ...stated("slides are half done"),
      "command-id": COMMAND.slides
    });

    expect(await actionsTitled(/slides/)).toMatchObject([{ id, remainingMinutes: 15, status: "doing" }]);
    expect((await show("action", id)).expectedMinutes).toBe(30);
  });

  it("Priya: the one Priya action is rewritten in place and is no longer waiting", async () => {
    const id = await only("Priya", "actions", "Email Priya: can the diagram be hand-drawn?", "priya");
    await ok("rhen_save_action", {
      id,
      fields: { title: "Tell Priya the diagram can be hand-drawn", status: "planned" },
      ...stated("tell Priya the diagram can be hand-drawn"),
      "command-id": COMMAND.priya
    });

    expect(await actionsTitled(/Priya/)).toMatchObject([
      { id, title: "Tell Priya the diagram can be hand-drawn", status: "planned" }
    ]);
  });

  it("home: arriving at Home moves where he is, and Now says so", async () => {
    expect((await fullStatus()).situation.locationName).not.toBe("Home");

    await ok("rhen_arrive", { place: "Home", ...stated("I'm home"), "command-id": COMMAND.home });

    expect((await fullStatus()).situation).toMatchObject({ locationId: "place-home", locationName: "Home" });
  });

  it("form: Mia's form is done, and only the one form action exists", async () => {
    const id = await only("Mia", "actions", "Get Mia's excursion form signed", "form");
    await ok("rhen_save_action", {
      id,
      fields: { status: "done" },
      ...stated("Mia's form is signed"),
      "command-id": COMMAND.form
    });

    expect(await actionsTitled(/Mia/)).toMatchObject([{ id, status: "done" }]);
  });

  it("library: back after Thursday's class ends, before it shuts at five", async () => {
    const thursday = await list("commitments", {
      from: clock.local(1, "00:00"),
      to: clock.local(2, "00:00"),
      fields: "id,title,startsAt,endsAt"
    });
    const classEnds = thursday.find((commitment) => /class/i.test(String(commitment.title)))!.endsAt;
    const id = await only("library", "actions", "Return the library books", "library");

    await ok("rhen_save_action", {
      id,
      fields: { availableFrom: classEnds, deadlineAt: clock.local(1, "17:00") },
      ...stated("library books go back Thursday after uni, it shuts at 5"),
      "command-id": COMMAND.library
    });

    const [library, ...rest] = await list("actions", { fields: "id,title,availableFrom,deadlineAt" }).then((all) =>
      all.filter((action) => /library/i.test(String(action.title)))
    );
    expect(rest).toEqual([]);
    expect(instant(library!.availableFrom)).toBe(at(1, "15:30"));
    expect(instant(library!.deadlineAt)).toBe(at(1, "17:00"));
    expect((await brief()).deadlinesWithin48h).toMatchObject([{ id, title: "Return the library books" }]);
  });

  it("rego: a window from Monday to the Sunday before it runs out, with the date in its note", async () => {
    const id = await only("rego", "actions", "Renew the car rego", "rego");
    await ok("rhen_save_action", {
      id,
      fields: {
        availableFrom: clock.local(5, "00:00"),
        deadlineAt: clock.local(11, "23:59"),
        notes: `Rego runs out on ${clock.date(12)}`
      },
      ...stated("rego runs out on the 9th"),
      "command-id": COMMAND.rego
    });

    const rego = await show("action", id);
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
    // What he said is finished is not offered to him again, and what he said opens later is held back until it does.
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
    expect(short.session).toBeNull();
    expect(short.nextCommitment).toMatchObject({ title: "Spin class", minutesAway: 570 });
    expect(short.deadlinesWithin48h.map((deadline) => deadline.title)).toEqual(["Return the library books"]);
    expect(short.inboxPending).toBe(0);
  });

  it("the ledger: each write has one undo entry and one change-feed row, kept under the agent's name", async () => {
    const journal = await ok<JournalEntry[]>("rhen_undo", { list: true });
    // A snapshotted write's entry is the ledger's own (its id is the command id the agent sent); the deliverable
    // save keeps no rows, so it keeps the journal's entry, with a label and id of its own.
    const written: [keyof typeof COMMAND, string][] = [
      ["mum", 'create action "Call mum"'],
      ["dana", 'update action "Ask Dana about a supervisor trial shift"'],
      ["slides", 'update action "Finish the threat modelling slides"'],
      ["form", 'update action "Get Mia\'s excursion form signed"'],
      ["electricity", 'update action "Pay the electricity bill"'],
      ["rego", 'update action "Renew the car rego"'],
      ["library", 'update action "Return the library books"'],
      ["priya", 'update action "Tell Priya the diagram can be hand-drawn"'],
      ["dentist", 'update commitment "Dentist check-up"'],
      ["shift", 'update commitment "Work (supervisor trial)"'],
      ["home", "update current availability"],
      ["session", "finish session"],
      ["birthday", 'create project "Mum\'s birthday"'],
      ["flowers", 'create action "Buy flowers"'],
      // Undoable since the portal keeps their rows: the gym rule and the corrected night.
      ["gym", 'create commitment recurrence rule "Gym"'],
      ["sleep", "update sleep log entry"]
    ];
    // One entry for each and none for anything else: the retried Call mum left no second entry.
    for (const [fact, label] of written) {
      const found = journal.filter((entry) => entry.id === COMMAND[fact]);
      expect(found, fact).toHaveLength(1);
      expect(found[0]!.label, fact).toBe(label);
    }
    expect(journal.filter((entry) => entry.label.startsWith('update deliverable "Assessment 2'))).toHaveLength(1);
    expect(journal).toHaveLength(written.length + 1);
    expect(new Set(journal.map((entry) => entry.status))).toEqual(new Set(["applied"]));
    // Every write keeps row images now (the deliverable save too), so no entry restates a record: the ledger
    // holds each by actor, and the journal names no owner.
    expect(journal.flatMap((entry) => (entry.owner == null ? [] : [entry.owner]))).toEqual([]);

    const { changes } = await ok<{
      changes: { entityType: string; entityId: string; operation: string; actor: string; commandId: string }[];
    }>("rhen_changes", { agent: "openclaw", limit: 100 });
    // Seventeen writes, seventeen rows, each carrying the command id the agent sent.
    expect(changes).toHaveLength(Object.keys(COMMAND).length);
    expect(new Set(changes.map((change) => change.actor))).toEqual(new Set(["openclaw"]));
    const rowFor = (fact: keyof typeof COMMAND) => changes.find((change) => change.commandId === COMMAND[fact])!;
    expect(
      Object.fromEntries(Object.keys(COMMAND).map((fact) => [fact, rowFor(fact as keyof typeof COMMAND)?.entityType]))
    ).toEqual({
      sleep: "sleep_log_entry",
      session: "session",
      essay: "deliverable",
      gym: "commitment_recurrence_rule",
      mum: "action",
      dana: "action",
      shift: "commitment",
      electricity: "action",
      dentist: "commitment",
      slides: "action",
      priya: "action",
      home: "current_availability",
      form: "action",
      library: "action",
      rego: "action",
      birthday: "project",
      flowers: "action"
    });
    expect(rowFor("session").operation).toBe("finish");
    // And each row points at the record that fact changed, by the id the portal stored it under. For the action made
    // with a chosen slug that is the hash of it: the row joins to the record, and the undo entry is named by the command id.
    for (const [fact, id] of Object.entries(touched))
      expect(rowFor(fact as keyof typeof COMMAND).entityId, fact).toBe(id);
    expect(rowFor("flowers").entityId).not.toBe("action-flowers");
    expect((await show("action", rowFor("flowers").entityId)).title).toBe("Buy flowers");
    expect((await show("project", rowFor("birthday").entityId)).title).toBe("Mum's birthday");
    expect(journal.find((entry) => entry.label.startsWith('create action "Buy flowers"'))!.id).toBe(COMMAND.flowers);
    expect(journal.find((entry) => entry.label.startsWith('create action "Call mum"'))!.id).toBe(COMMAND.mum);
  });

  it("undo: Priya's rewrite and the new Call mum are put back, then redone", async () => {
    const entry = async (label: string) =>
      (await ok<JournalEntry[]>("rhen_undo", { list: true })).find((item) => item.label.startsWith(label))!;

    const rewrite = await entry('update action "Tell Priya');
    await ok("rhen_undo", { id: rewrite.id });
    expect(await actionsTitled(/Priya/)).toMatchObject([
      { id: touched.priya, title: "Email Priya: can the diagram be hand-drawn?", status: "waiting" }
    ]);
    await ok("rhen_undo", { redo: true, id: rewrite.id });
    expect(await actionsTitled(/Priya/)).toMatchObject([
      { id: touched.priya, title: "Tell Priya the diagram can be hand-drawn", status: "planned" }
    ]);

    const [mum] = await actionsTitled(/Call mum/);
    const creation = await entry('create action "Call mum"');
    // The agent's own create is taken out whole (the portal kept it as an inserted row), and redo puts it back.
    await ok("rhen_undo", { id: creation.id });
    expect(await actionsTitled(/Call mum/)).toEqual([]);
    await ok("rhen_undo", { redo: true, id: creation.id });
    expect(await actionsTitled(/Call mum/)).toMatchObject([{ id: mum!.id, status: "planned" }]);
  });
});

/**
 * Stale facts (the fact freshness design note): a fact the agent was told long ago is unknown to the plan, and the
 * Now answer lists what OpenRhen needs to be told. The portal's clock is moved on from Wednesday's 08:30 to the
 * instants that matter, and at each one the agent reads Now the way it would, asks for a replan (`rhen_recalculate`,
 * which stamps the current time), then settles the need with the answer the need itself names (tool, action, fields), and
 * reads Now again to see it clear. The needs are the `needs` of `rhen_status` itself.
 * Every fact is stale from its `staleAt`
 * on, so each boundary is pinned a millisecond either side.
 */
describe("stale facts: what the agent is asked once what it was told has aged out", () => {
  const MINUTE = 60_000;
  /** Moves the portal's clock, asks for a replan from it, and returns the needs and the directive as the agent reads them. */
  async function nowAt(when: Date) {
    vi.setSystemTime(when);
    await ok("rhen_recalculate", {});
    await refreshPlanning();
    const status = await fullStatus();
    const needs = status.needs;
    return { needs, status };
  }
  const needFor = (needs: Need[], fact: Need["fact"]) => needs.find((need) => need.fact === fact);
  /** Settles a need the way it says: its own tool, its action as the subcommand or entity, its fields supplied. */
  const settle = (need: Need, expected: { tool: string; action: string }, args: Record<string, unknown>) => {
    expect(need.answer).toMatchObject(expected);
    // `rhen_wake` is one command, so it takes the fields alone; save names the entity, the rest a subcommand.
    if (need.answer.tool === "rhen_wake") return ok(need.answer.tool, args);
    const key = need.answer.tool === "rhen_save" ? "entityType" : "subcommand";
    return ok(need.answer.tool, { [key]: need.answer.action, ...args });
  };
  interface AnswerDirective {
    kind: string;
    title: string;
    question?: string;
  }
  const directiveOf = (status: FullStatus) => status.directive as unknown as AnswerDirective | null;

  it("an open session: past its planned end plus an hour, Now asks when it stopped and offers nothing else", async () => {
    const slides = await only("slides", "actions", "Finish the threat modelling slides", "slides");
    vi.setSystemTime(clock.at(0, "09:00"));
    await ok("rhen_session", {
      subcommand: "start",
      action: slides,
      minutes: 30,
      ...stated("starting the slides")
    });
    // Planned to 09:30, and stale an hour after that (a session gets its planned length or an hour, whichever is longer).
    const before = await nowAt(new Date(at(0, "10:30") - 1));
    expect(before.needs.filter((need) => need.fact === "session_end")).toEqual([]);
    expect(before.status.session).not.toBeNull();
    expect(directiveOf(before.status)?.kind).not.toBe("answer");

    const { needs, status } = await nowAt(new Date(at(0, "10:30")));
    // The question takes the place of the directive, and nothing is queued behind it: another start would be refused.
    expect(directiveOf(status)).toMatchObject({
      kind: "answer",
      title: "Finish the threat modelling slides is still open",
      question: "Running 1.5 h, planned 30 min. When did it stop?"
    });
    expect(status.upcoming).toEqual([]);
    const need = needFor(needs, "session_end")!;
    expect(needs[0]).toBe(need);
    expect(need).toMatchObject({
      subjectId: expect.any(String),
      blocksDirective: true,
      question: directiveOf(status)!.question
    });
    expect(need.answer).toMatchObject({ tool: "rhen_session", action: "finish", fields: ["endedAt"] });
    expect(need.answer.cli).toContain("--ended-at");

    // He stopped at the planned end, half done: the agent finishes it with that end.
    await settle(
      need,
      { tool: "rhen_session", action: "finish" },
      {
        outcome: "progress",
        remaining: 15,
        "ended-at": clock.local(0, "09:30"),
        ...stated("I stopped the slides at 9:30")
      }
    );
    const after = await nowAt(new Date(at(0, "10:30") + MINUTE));
    expect(after.needs.filter((item) => item.fact === "session_end")).toEqual([]);
    expect(after.status.session).toBeNull();
    expect(directiveOf(after.status)?.kind).not.toBe("answer");
    const history = await ok<{ sessions: Item[] }>("rhen_history", { from: clock.date(0), to: clock.date(0) });
    expect(
      history.sessions.filter((session) => session.actionTitle === "Finish the threat modelling slides")
    ).toMatchObject([{ result: "stopped", activeMinutes: 30, remainingAfterMinutes: 15 }]);
    expect(instant(history.sessions.at(-1)!.endedAt)).toBe(at(0, "09:30"));
  });

  it("a paused session: four hours after the pause Now asks to finish it, and a plain finish settles it", async () => {
    const slides = (await actionsTitled(/threat modelling slides/))[0]!.id;
    vi.setSystemTime(clock.at(0, "11:00"));
    await ok("rhen_session", {
      subcommand: "start",
      action: slides,
      minutes: 30,
      ...stated("back to the slides")
    });
    vi.setSystemTime(clock.at(0, "11:10"));
    await ok("rhen_session", { subcommand: "pause", ...stated("pausing the slides") });
    // A paused session has no end to run past: it ages from the pause, and is stale four hours after it.
    const before = await nowAt(new Date(at(0, "15:10") - 1));
    expect(before.needs.filter((need) => need.fact === "session_end")).toEqual([]);
    expect(directiveOf(before.status)?.kind).not.toBe("answer");

    const { needs, status } = await nowAt(new Date(at(0, "15:10")));
    expect(directiveOf(status)).toMatchObject({ kind: "answer", question: "Paused 4 h ago. Finish it?" });
    expect(status.upcoming).toEqual([]);
    const need = needFor(needs, "session_end")!;
    // Not "when did it stop": it stopped at the pause, so the answer is a bare finish with nothing to supply.
    expect(need.answer).toMatchObject({ tool: "rhen_session", action: "finish", fields: [] });
    expect(need.answer.cli).not.toContain("--ended-at");
    // And the portal refuses the end a running session would be given, so the old answer could never have settled it.
    const refused = await call("rhen_session", {
      subcommand: "finish",
      outcome: "progress",
      remaining: 15,
      "ended-at": clock.local(0, "11:10"),
      ...stated("paused at 11:10")
    });
    expect(refused.isError).toBe(true);
    expect((await nowAt(new Date(at(0, "15:10")))).status.session).not.toBeNull();

    await settle(
      need,
      { tool: "rhen_session", action: "finish" },
      {
        outcome: "progress",
        remaining: 15,
        ...stated("yes, I'm done with the slides for today")
      }
    );
    const after = await nowAt(new Date(at(0, "15:11")));
    expect(after.needs.filter((item) => item.fact === "session_end")).toEqual([]);
    expect(after.status.session).toBeNull();
    expect(directiveOf(after.status)?.kind).not.toBe("answer");
  });

  it("energy: undated is unknown, saying it again re-dates it even unchanged, and it is stale from eight hours on", async () => {
    const first = await nowAt(clock.at(0, "15:15"));
    // He has never said it: the seeded "medium" is not trusted, so the question comes without a date.
    expect(needFor(first.needs, "energy")).toMatchObject({
      question: "How is your energy now?",
      blocksDirective: false
    });
    expect(needFor(first.needs, "energy")!.asOf).toBeUndefined();
    expect(first.status.situation).toMatchObject({ energy: "medium" });

    const need = needFor(first.needs, "energy")!;
    expect(need.answer).toMatchObject({
      tool: "rhen_save",
      action: "current_availability",
      fields: ["currentEnergy"]
    });
    await settle(
      need,
      { tool: "rhen_save", action: "current_availability" },
      {
        fields: { currentEnergy: "medium" },
        ...stated("medium, same as it says")
      }
    );
    const fresh = await nowAt(new Date(at(0, "23:15") - 1));
    expect(fresh.needs.filter((item) => item.fact === "energy")).toEqual([]);

    const stale = await nowAt(clock.at(0, "23:15"));
    const again = needFor(stale.needs, "energy")!;
    expect(again.question).toBe("You said medium energy 8 h ago. How is it now?");
    expect(instant(again.asOf)).toBe(at(0, "15:15"));

    // "Still medium": the value is unchanged, and naming it asserts it all the same.
    vi.setSystemTime(clock.at(0, "23:20"));
    await settle(
      again,
      { tool: "rhen_save", action: "current_availability" },
      {
        fields: { currentEnergy: "medium" },
        ...stated("still medium")
      }
    );
    const settled = await nowAt(clock.at(0, "23:21"));
    expect(settled.needs.filter((item) => item.fact === "energy")).toEqual([]);
    const [row] = await sql<
      { energy_set_at: string }[]
    >`SELECT current_situation->>'energySetAt' AS energy_set_at FROM user_preferences`;
    expect(instant(row!.energy_set_at)).toBe(at(0, "23:20"));
  });

  it("wake: past the awake limit and two hours the wake is unknown, tonight is planned from the preferences, and telling it clears it", async () => {
    // Up at 07:30 with a 20 hour limit: stale at 05:30 the next morning, to the millisecond.
    const before = await nowAt(new Date(at(1, "05:30") - 1));
    expect(before.needs.filter((need) => need.fact === "wake")).toEqual([]);
    expect(before.status.directive).toMatchObject({ kind: "sleep" });
    const limited = (await list("sleep-plans")).find((plan) => plan.status === "planned")!;
    expect(limited.explanation).toContain("20-hour awake limit");

    const { needs, status } = await nowAt(clock.at(1, "05:30"));
    const need = needFor(needs, "wake")!;
    expect(need).toMatchObject({
      title: "Last wake",
      question: "Last woke 22 h ago. When did you wake up?",
      blocksDirective: false
    });
    expect(need.asOf).toBe(clock.local(0, "07:30"));
    expect(need.answer).toMatchObject({ tool: "rhen_wake", action: "wake", fields: ["at"] });
    // Tonight is planned as if from the wake the preferences give, with the awake limit no longer against him.
    const assumed = (await list("sleep-plans")).find((plan) => plan.status === "planned")!;
    expect(assumed.explanation).toContain("Planned from the sleep preferences because the last wake is unknown");
    expect(status.directive).toMatchObject({ kind: "sleep" });

    // He has been up since 5. No sleep was tracked or planned before then, so the wake is recorded alone.
    const nights = async () => (await list("sleep-plans")).filter((plan) => plan.status === "completed");
    const nightsBefore = (await nights()).length;
    await settle(
      need,
      { tool: "rhen_wake", action: "wake" },
      { at: clock.local(1, "05:00"), ...stated("I got up at 5 this morning") }
    );
    const after = await nowAt(clock.at(1, "05:31"));
    expect(after.needs.filter((item) => item.fact === "wake")).toEqual([]);
    expect((await list("sleep-plans")).find((plan) => plan.status === "planned")!.explanation).not.toContain(
      "wake is unknown"
    );
    const [preferences] = await sql<{ last_woke_at: Date }[]>`SELECT last_woke_at FROM user_preferences`;
    expect(preferences!.last_woke_at.getTime()).toBe(at(1, "05:00"));
    expect(await nights()).toHaveLength(nightsBefore);
  });

  it("a session paused and then left awaiting feedback also ends at its pause: asked as paused, settled with a plain finish", async () => {
    const slides = (await actionsTitled(/threat modelling slides/))[0]!.id;
    vi.setSystemTime(clock.at(1, "06:00"));
    await ok("rhen_session", { subcommand: "start", action: slides, minutes: 30, ...stated("slides again") });
    vi.setSystemTime(clock.at(1, "06:10"));
    await ok("rhen_session", { subcommand: "pause", ...stated("pausing") });
    // The page opens, sees the planned end long gone and asks for feedback; the pause (and its remaining time) is kept.
    vi.setSystemTime(clock.at(1, "06:20"));
    await ok("rhen_session", { subcommand: "feedback", ...stated("asking for feedback") });
    expect((await sql<{ status: string }[]>`SELECT status FROM sessions`).map((row) => row.status)).toContain(
      "awaiting_feedback"
    );

    // It ages from the pause, not from the planned end: four hours after 06:10, to the millisecond.
    const before = await nowAt(new Date(at(1, "10:10") - 1));
    expect(before.needs.filter((need) => need.fact === "session_end")).toEqual([]);
    const { needs, status } = await nowAt(clock.at(1, "10:10"));
    expect(directiveOf(status)).toMatchObject({ kind: "answer", question: "Paused 4 h ago. Finish it?" });
    const need = needFor(needs, "session_end")!;
    expect(instant(need.asOf)).toBe(at(1, "06:10"));
    expect(need.answer).toMatchObject({ tool: "rhen_session", action: "finish", fields: [] });
    expect(need.answer.cli).not.toContain("--ended-at");

    await settle(
      need,
      { tool: "rhen_session", action: "finish" },
      {
        outcome: "progress",
        remaining: 15,
        ...stated("yes, that's over")
      }
    );
    const after = await nowAt(clock.at(1, "10:11"));
    expect(after.needs.filter((item) => item.fact === "session_end")).toEqual([]);
    expect(after.status.session).toBeNull();
    expect(directiveOf(after.status)?.kind).not.toBe("answer");
  });
});
