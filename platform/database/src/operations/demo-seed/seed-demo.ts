import { config } from "dotenv";
import { resolve } from "node:path";
import { writeFileSync } from "node:fs";
import postgres from "postgres";
import { createCli, setArgs, type DemoCli } from "./demo-cli.js";
import "../../schema/private/index.js";
import { registeredTableGroups } from "../../schema/table-groups.js";
import {
  ACTIONS,
  AREAS,
  CONDITIONS,
  DELIVERABLES,
  EVENING_PRESET,
  MORNING_PRESET,
  NETWORK_REPORT_TITLE,
  OUTCOMES,
  PRESETS,
  PROJECTS,
  type Fields
} from "./demo-data-planning.js";
import { ACTION_OUTCOMES, COMMITMENTS, HISTORY, RULES, SETUP_SETTINGS, SPAN } from "./demo-data-schedule.js";
import { KEPT_CAPTURES, classifiedCapture, plainCaptures, proposals, type SavedCapture } from "./demo-data-inbox.js";
import { extraCaptures } from "./demo-capture-extensions.js";
import { demoCalendarImports } from "./demo-calendar-imports.js";
import "./private/index.js";
import { addDays, createShifter, isoWeekday } from "./demo-dates.js";
import { assertLocalUrl, assertSeedDatabaseUrl } from "./demo-guard.js";

config({ path: resolve(process.cwd(), "../../.env"), quiet: true });

/**
 * Seeds a LOCAL dev database with one believable week (`pnpm seed:demo`). Everything goes through the
 * portal's own routes, by way of the CLI, except the few rows that have no write path (a registered table group's
 * `demoSeed`). It refuses any portal or database that is not on this machine.
 *
 * Dates are relative to today in the demo's zone (`TIMEZONE` in demo-dates.ts). Re-running is safe: every
 * record is looked up by title or name first, because the portal rewrites the custom ids used here to
 * UUIDv5 and a second `save --id <alias>` would no longer find it. History is backfilled only where it
 * fits the portal's rules (a start at most 24 hours back, an end already past), so a run at any hour
 * seeds what it can and a later run adds the rest.
 */
const portalUrl = process.env.OPENRHEN_URL ?? "http://localhost:5173";
assertLocalUrl(portalUrl, "OPENRHEN_URL");
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
assertSeedDatabaseUrl(databaseUrl, "DATABASE_URL");

const cli: DemoCli = createCli(portalUrl);
// DEMO_SEED_NOW (an ISO instant) pins the clock the dates are moved to, so a test can check how the fixtures
// land on another day. The portal still uses the real clock, so backfilled history only works unpinned.
const clockSkewMs = process.env.DEMO_SEED_NOW ? Date.parse(process.env.DEMO_SEED_NOW) - Date.now() : 0;
if (Number.isNaN(clockSkewMs)) throw new Error("DEMO_SEED_NOW must be an ISO date and time");
const nowMs = () => Date.now() + clockSkewMs;
const shifter = createShifter(new Date(nowMs()));
const failures: string[] = [];

type Row = Record<string, unknown>;
const say = (text: string) => console.log(text);
const heading = (text: string) => say(`\n== ${text}`);

/** Runs one record's work; a failure is reported and the run carries on with the next record. */
function attempt(label: string, work: () => string | void): void {
  try {
    const line = work();
    // Table output of a save starts with an "id" column; only short one-line confirmations are worth logging.
    say(`  ${label}${line && line.length < 70 && !line.startsWith("id") ? `: ${line}` : ""}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push(`${label}: ${message}`);
    say(`  FAILED ${label}: ${message}`);
  }
}

/** Map of `field` value to stored id for every row of an entity (ids are rewritten by the portal, so titles are the key). */
function index(entity: string, field: string, extra: string[] = []): Map<string, Row> {
  const rows = cli.json<Row[]>(["list", entity, "--fields", ["id", field, ...extra].join(",")]);
  return new Map(rows.map((row) => [String(row[field]), row]));
}
const idOf = (entity: string, field: string, value: string): string | undefined =>
  index(entity, field).get(value)?.id as string | undefined;

// `--create`: a record named by its id is made when missing and updated when there, so the seed can run again.
const save = (entity: string, fields: Fields) =>
  cli.ok(["save", entity, ...(fields.id === undefined ? [] : ["--create"]), "--from", cli.file(fields)]);

function section(name: string, work: () => void): void {
  heading(name);
  try {
    work();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push(`${name}: ${message}`);
    say(`  FAILED ${name}: ${message}`);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// A portal whose first setup is done is somebody's working data, not a blank sandbox. Seeding it again
// is only for a database this script seeded before (idempotent top-up), so that must be said with --force.
const force = process.argv.includes("--force") || process.env.DEMO_SEED_FORCE === "1";
{
  const settings = cli.json<Row>(["state", "--key", "settings"]);
  if (settings.setupCompletedAt && !force) {
    console.error(
      `Refusing to seed ${portalUrl}: its first setup is already done, so it is not an empty sandbox. ` +
        "Pass --force (or DEMO_SEED_FORCE=1) only if this is a database the demo seed filled earlier."
    );
    cli.cleanup();
    process.exit(2);
  }
  // Past the guard, before the first write: the dev-sandbox hook passes a marker path so a resumed session
  // may top up with --force. Writing it here, not after a run that merely did not refuse, means a run that
  // died before this point never vouches for a database somebody may then set up by hand.
  if (process.env.DEMO_SEED_MARKER) writeFileSync(process.env.DEMO_SEED_MARKER, `${new Date().toISOString()}\n`);
}

section("1. First setup (what /setup posts: settings with setupCompleted)", () => {
  const settings = cli.json<Row>(["state", "--key", "settings"]);
  if (settings.setupCompletedAt) return say("  already set up");
  say(`  ${cli.ok(["save", "settings", ...setArgs(shifter.deep(SETUP_SETTINGS))])}`);
});

section("2. Capabilities, then places (their grants refer to capabilities), then contacts", () => {
  const existing = index("conditions", "name");
  for (const condition of CONDITIONS) {
    const name = String(condition.name);
    if (existing.has(name)) continue;
    attempt(`condition ${name}`, () => save("condition-definition", condition));
  }
});

section("3. Areas (a fresh database ships 7 default areas, including Health and Study)", () => {
  const areas = index("areas", "name", ["status"]);
  for (const area of AREAS)
    if (!areas.has(String(area.name))) attempt(`area ${String(area.name)}`, () => save("area", area));
  // Archive every active default area the demo does not use, so none sits beside a near-duplicate.
  const keep = new Set(["Health", ...AREAS.map((area) => String(area.name))]);
  for (const [name, row] of areas) {
    if (keep.has(name) || row.status === "archived") continue;
    attempt(`archive default area ${name}`, () =>
      cli.ok(["save", "area", "--id", String(row.id), "--set", "status=archived"])
    );
  }
});

section("4. Outcomes and projects", () => {
  const healthId = idOf("areas", "name", "Health");
  const studyId = idOf("areas", "name", "Study");
  const areaIds: Record<string, unknown> = { HEALTH: healthId, STUDY: studyId };
  const outcomes = index("outcomes", "title");
  for (const outcome of OUTCOMES) {
    if (outcomes.has(String(outcome.title))) continue;
    attempt(`outcome ${String(outcome.title)}`, () =>
      save("outcome", shifter.deep({ ...outcome, areaId: areaIds[String(outcome.areaId)] ?? outcome.areaId }))
    );
  }
  const projects = index("projects", "title");
  for (const project of PROJECTS)
    if (!projects.has(String(project.title)))
      attempt(`project ${String(project.title)}`, () => save("project", shifter.deep(project)));
});

section("5. Deliverables with criteria and steps", () => {
  const existing = index("deliverables", "title");
  for (const deliverable of DELIVERABLES)
    if (!existing.has(String(deliverable.title)))
      attempt(`deliverable ${String(deliverable.title)}`, () => save("deliverable", shifter.deep(deliverable)));
});

section("6. Routine presets (morning = wake routine, evening shutdown = bedtime routine)", () => {
  const existing = index("routine-presets", "name");
  for (const preset of PRESETS)
    if (!existing.has(String(preset.name)))
      attempt(`preset ${String(preset.name)}`, () => save("routine-preset", preset));
  const presets = index("routine-presets", "name");
  const wanted = {
    bedtimeRoutinePresetId: presets.get(EVENING_PRESET)?.id,
    wakeRoutinePresetId: presets.get(MORNING_PRESET)?.id,
    homeLocationId: "ctx-home"
  };
  const settings = cli.json<Row>(["state", "--key", "settings"]);
  const changed = Object.fromEntries(
    Object.entries(wanted).filter(([key, value]) => value !== undefined && settings[key] !== value)
  );
  if (Object.keys(changed).length > 0)
    attempt("settings: routines and home", () => cli.ok(["save", "settings", ...setArgs(changed)]));
});

section("7. Actions (planned, active, waiting, blocked and done; overdue, today and next week)", () => {
  const existing = index("actions", "title");
  for (const action of ACTIONS)
    if (!existing.has(String(action.title)))
      attempt(`action ${String(action.title)}`, () => save("action", shifter.deep(action)));
});

section("8. Fixed commitments: recurring rules and one-offs", () => {
  const presets = index("routine-presets", "name");
  const rules = index("commitment-rules", "title");
  for (const rule of RULES) {
    const title = String(rule.fields.title);
    if (rules.has(title)) continue;
    const fields = shifter.deep(rule.fields) as Fields;
    const repeat = rule.fields.repeat as { weekdays: number[] };
    fields.repeat = { ...(fields.repeat as object), weekdays: shifter.weekdays(repeat.weekdays) };
    if (rule.preset) fields.routinePresetId = presets.get(rule.preset)?.id;
    attempt(`rule ${title}`, () => cli.ok(["recurrence", "set", "--from", cli.file(fields), "--yes"]));
  }
  const window = ["--from", addDays(shifter.today, -1), "--to", addDays(shifter.today, 30)];
  const present = cli.json<Row[]>(["list", "commitments", ...window, "--fields", "id,title,startsAt"]);
  const taken = new Set(present.map((row) => `${row.title}|${Date.parse(String(row.startsAt))}`));
  for (const commitment of COMMITMENTS) {
    const fields = shifter.deep(commitment.fields) as Fields;
    if (taken.has(`${fields.title}|${Date.parse(String(fields.startsAt))}`)) continue;
    if (commitment.preset) fields.routinePresetId = presets.get(commitment.preset)?.id;
    attempt(`commitment ${String(fields.title)}`, () => save("commitment", fields));
  }
});

section("9. This week's planning focus, and the trip", () => {
  const monday = addDays(shifter.today, 1 - isoWeekday(shifter.today));
  const focus = cli.json<Row[]>(["list", "planning-focus", "--fields", "id,kind,periodStart"]);
  if (!focus.some((row) => row.kind === "weekly" && row.periodStart === monday)) {
    const projects = cli.json<Row[]>(["list", "projects", "--fields", "id,title"]);
    const projectIds = projects
      .filter((row) => ["Networking", "Kids", "Cyber"].some((prefix) => String(row.title).startsWith(prefix)))
      .map((row) => row.id);
    attempt("planning focus", () =>
      save("planning-focus", {
        id: "focus-week",
        kind: "weekly",
        periodStart: monday,
        periodEnd: addDays(monday, 6),
        projectIds
      })
    );
  }
  const spans = index("spans", "title");
  if (!spans.has(SPAN.title))
    attempt(`span ${SPAN.title}`, () =>
      cli.ok([
        "span",
        "add",
        "--title",
        SPAN.title,
        "--start",
        shifter.date(SPAN.start),
        "--end",
        shifter.date(SPAN.end)
      ])
    );
});

section("10. History: two nights of sleep and the sessions that fit", () => {
  // The portal accepts a backfilled start at most 24 hours back and refuses one that overlaps a later
  // session, so entries go in chronological order and only those that fit this moment are made.
  // `session finish --ended-at` gives each one its end time (the activity commands refuse an action
  // session). A backfilled start is refused before the recorded wake, so the wake is put back to the
  // latest real one around every session.
  const now = nowMs();
  const earliestStart = now - (24 * 3600 - 120) * 1000;
  const latestEnd = now - 60 * 1000;
  const restoreWake = () => {
    const nights = cli.json<Row[]>(["list", "sleep-plans", "--fields", "id,status,actualWakeAt"]);
    const wakes = nights
      .filter((night) => night.status === "completed" && night.actualWakeAt)
      .map((night) => Date.parse(String(night.actualWakeAt)));
    if (wakes.length === 0) return;
    const lastWake = new Date(Math.max(...wakes));
    // SQL is not needed: the settings route accepts lastWokeAt, as first setup does.
    cli.ok(["save", "settings", "--set", `lastWokeAt=${lastWake.toISOString()}`]);
  };
  for (const entry of shifter.deep(HISTORY)) {
    if ("night" in entry) {
      const { sleepAt, wakeAt } = entry.night;
      if (Date.parse(wakeAt) > latestEnd) {
        say(`  skip night ending ${wakeAt}: not over yet`);
        continue;
      }
      const nights = cli.json<Row[]>(["list", "sleep-plans", "--fields", "id,status,actualStartAt"]);
      if (
        nights.some(
          (night) => night.status === "completed" && Date.parse(String(night.actualStartAt)) === Date.parse(sleepAt)
        )
      )
        continue;
      attempt(`sleep ${sleepAt}`, () => {
        const line = cli.ok(["save", "sleep-log-entry", "--set", `sleepAt=${sleepAt}`, "--set", `wakeAt=${wakeAt}`]);
        restoreWake();
        return line;
      });
      continue;
    }
    const { action, start, end, minutes } = entry.session;
    if (Date.parse(start) < earliestStart || Date.parse(end) > latestEnd) {
      say(`  skip session "${action}": ${start} to ${end} does not fit the last 24 hours`);
      continue;
    }
    const sessions = cli.json<Row[]>(["list", "sessions", "--fields", "id,actionTitle"]);
    if (sessions.some((session) => session.actionTitle === action)) continue;
    const actions = index("actions", "title", ["status"]);
    if (actions.get(action)?.status === "done") continue;
    attempt(`session ${action}`, () => {
      restoreWake();
      cli.ok(["session", "start", "--action", action, "--minutes", String(minutes), "--started-at", start]);
      const line = cli.ok(["session", "finish", "--outcome", "completed", "--ended-at", end]);
      restoreWake();
      return line;
    });
  }
  // A finished session never completes its action, so the resulting states are set by hand.
  const actions = index("actions", "title", ["status", "remainingMinutes"]);
  for (const outcome of ACTION_OUTCOMES) {
    const row = actions.get(outcome.title);
    if (!row || (row.status === outcome.status && row.remainingMinutes === outcome.remainingMinutes)) continue;
    attempt(`action ${outcome.title} -> ${outcome.status}`, () =>
      cli.ok([
        "save",
        "action",
        "--id",
        String(row.id),
        "--set",
        `status=${outcome.status}`,
        "--set",
        `remainingMinutes=${outcome.remainingMinutes}`
      ])
    );
  }
});

section("11. Where am I: at Home, carrying laptop, phone and car", () => {
  // A portal that has never confirmed the pulse reads as lapsed, and every agent call (the proposals in
  // section 12) is refused until `reenter` answers where, how much energy and which contexts. Done as
  // the owner would, so the later agent writes go through.
  if (cli.json<{ lapsed: boolean }>(["reenter"]).lapsed)
    attempt("reenter", () =>
      cli.ok(["reenter", "--location", "ctx-home", "--energy", "medium", "--contexts", "cap-laptop,cap-phone,cap-car"])
    );
  attempt("arrive", () => cli.ok(["arrive", "ctx-home"]));
  // Without `carrying` every laptop action is unavailable and Now says nothing fits.
  const carrying = (cli.json<Row>(["state", "--key", "currentSituation"]).carrying ?? {}) as Row;
  if (!["cap-laptop", "cap-phone", "cap-car"].every((id) => carrying[id] === true))
    attempt("carrying", () =>
      cli.ok([
        "save",
        "current-availability",
        "--set",
        "currentSituation.carrying.cap-laptop=true",
        "--set",
        "currentSituation.carrying.cap-phone=true",
        "--set",
        "currentSituation.carrying.cap-car=true"
      ])
    );
});

section("12. Inbox: captures, a classified capture, Kept items, email changes and agent proposals", () => {
  const texts = cli.json<Row[]>(["list", "captures", "--fields", "id,text"]).map((row) => String(row.text));
  const present = (key: string) => texts.some((text) => text.startsWith(key));
  for (const capture of plainCaptures(shifter))
    if (!present(capture.key))
      attempt(`capture ${capture.key}`, () =>
        cli.ok(["capture", capture.text, ...(capture.area ? ["--area", capture.area] : [])])
      );
  const houseId = idOf("projects", "title", "House and car admin");
  const dentalId = idOf("projects", "title", "Dental check-up and follow-up");
  const networkReportId = idOf("deliverables", "title", NETWORK_REPORT_TITLE);
  const saved: SavedCapture[] = [
    ...(houseId ? [classifiedCapture(houseId)] : []),
    ...KEPT_CAPTURES,
    ...(networkReportId ? extraCaptures(shifter, networkReportId) : [])
  ];
  for (const capture of saved)
    if (!present(capture.key)) attempt(`capture ${capture.key}`, () => save("capture", shifter.deep(capture.payload)));
  if (houseId && dentalId)
    for (const proposal of proposals(shifter, houseId, dentalId))
      attempt(`proposal ${proposal.key}`, () =>
        // --coalesce-key makes a repeat run a no-op.
        cli.ok([
          "propose",
          "entity_command",
          "--agent",
          "demo-agent",
          "--summary",
          proposal.summary,
          "--from",
          cli.file(shifter.deep(proposal.payload)),
          "--basis",
          "inferred",
          "--coalesce-key",
          proposal.key
        ])
      );
});

section("13. Inbox > Calendar: a previewed (uncommitted) calendar import batch", () => {
  const calendarImports = demoCalendarImports();
  if (calendarImports.length === 0) return say("  no calendar source installed; nothing to preview");
  const batches = cli.json<{ batches: unknown[] }>(["import", "list"]).batches;
  if (batches.length > 0) return say("  an import batch exists");
  for (const calendarImport of calendarImports)
    attempt("import preview", () =>
      cli.ok(["import", "preview", "--from", cli.file(shifter.deep(calendarImport)), "--kind", "calendar_events"])
    );
});

// Table groups installed in this build (schema/private) seed their own rows; none installed, none seeded.
for (const group of registeredTableGroups()) {
  const demoSeed = group.demoSeed;
  if (!demoSeed) continue;
  heading(demoSeed.heading);
  const sql = postgres(databaseUrl, { max: 1, connect_timeout: 10, onnotice: () => {} });
  try {
    await demoSeed.run(sql, shifter);
    say(`  ${group.id} seeded`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push(`${group.id}: ${message}`);
    say(`  FAILED ${group.id}: ${message}`);
  } finally {
    await sql.end();
  }
}

section("15. Recalculate and show the result", () => {
  attempt("recalculate", () => cli.ok(["recalculate"]));
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000);
  const status = cli.json<Row>(["status"]);
  const checkIn = status.checkIn;
  if (checkIn && typeof checkIn === "object" && (checkIn as Row).id)
    attempt("check-in", () => cli.ok(["check-in", "on-track"]));
  say(cli.run(["status"]).stdout.trimEnd());
});

cli.cleanup();
if (failures.length > 0) {
  console.error(`\nDemo seed finished with ${failures.length} failure(s):\n- ${failures.join("\n- ")}`);
  process.exitCode = 1;
} else {
  say(`\nDemo seed done for ${shifter.today} (shifted ${shifter.delta} day(s) from the 2026-10-27 anchor).`);
}
