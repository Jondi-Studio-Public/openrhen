import { planningEntityCommandSchema, saveActionCommandSchema, saveProjectCommandSchema } from "@openrhen/contracts";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { findEntityType, reverseOfUpdate } from "../src/commands/save.js";
import { EXIT } from "../src/errors.js";
import { fakeFetch, type RecordedCall } from "./fake-fetch.js";
import { fixtureNow, fixtureRawState } from "./fixture-state.js";

interface Run {
  exitCode: number;
  stdout: string;
  stderr: string;
  calls: RecordedCall[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function run(
  argv: string[],
  routes: Parameters<typeof fakeFetch>[0] = {},
  rawState: Record<string, unknown> = fixtureRawState()
): Promise<Run> {
  const calls: RecordedCall[] = [];
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const fetchImpl = fakeFetch({ "/api/state": { body: { state: rawState } }, ...routes }, calls);
  const exitCode = await runCli(["save", ...argv], {
    stdout: (text) => stdoutLines.push(text),
    stderr: (text) => stderrLines.push(text),
    env: {},
    readConfigFile: () => null,
    now: () => fixtureNow,
    fetchImpl
  });
  return { exitCode, stdout: stdoutLines.join("\n"), stderr: stderrLines.join("\n"), calls };
}

describe("save", () => {
  it("prints the portal's reason for a refused write first, not under the summary line", async () => {
    const result = await run(["capture", "--set", "text=Book the dentist follow-up"], {
      "/api/commands/entity": { status: 400, body: { error: "The selected project does not exist." } }
    });
    expect(result.exitCode).toBe(EXIT.validation);
    expect(result.stderr.split("\n")[0]).toMatch(
      /^rhen: The selected project does not exist\. \(command id [0-9a-f-]{36}\)$/
    );
  });

  it("creates a capture via --set", async () => {
    const raw = fixtureRawState();
    let posted: Record<string, unknown> | undefined;
    const { exitCode, stdout, calls } = await run(
      ["capture", "--set", "text=Book the dentist follow-up", "--json"],
      {
        "/api/commands/entity": (call) => {
          posted = call.body as Record<string, unknown>;
          const parsed = planningEntityCommandSchema.safeParse(call.body);
          expect(parsed.success).toBe(true);
          const captures = raw.captures as Record<string, unknown>[];
          const created = {
            id: "capture-new",
            status: "pending",
            ...(posted.entity as Record<string, unknown>)
          };
          return { body: { state: { ...raw, captures: [...captures, created] } } };
        }
      },
      raw
    );
    expect(exitCode).toBe(EXIT.ok);
    expect(posted?.expectedVersion).toBeNull();
    expect(typeof posted?.commandId).toBe("string");
    expect(UUID_RE.test(posted?.commandId as string)).toBe(true);
    expect(posted?.entityType).toBe("capture");
    expect(calls.some((call) => call.method === "POST")).toBe(true);
    const doc = JSON.parse(stdout) as { id: string; text: string };
    expect(doc.id).toBe("capture-new");
    expect(doc.text).toBe("Book the dentist follow-up");
  });

  it("updates a commitment's status via --id, sending the stored version and keeping other fields", async () => {
    const raw = fixtureRawState();
    const commitments = raw.commitments as Record<string, unknown>[];
    raw.commitments = commitments.map((commitment) =>
      commitment.id === "commitment-gym" ? { ...commitment, version: 3 } : commitment
    );
    let posted: Record<string, unknown> | undefined;
    const { exitCode, stdout } = await run(
      ["commitment", "--id", "commitment-gym", "--set", "status=cancelled", "--json"],
      {
        "/api/commands/entity": (call) => {
          posted = call.body as Record<string, unknown>;
          const parsed = planningEntityCommandSchema.safeParse(call.body);
          expect(parsed.success).toBe(true);
          const entity = posted.entity as Record<string, unknown>;
          const updated = (raw.commitments as Record<string, unknown>[]).map((commitment) =>
            commitment.id === "commitment-gym" ? { ...commitment, ...entity, version: 4 } : commitment
          );
          return { body: { state: { ...raw, commitments: updated } } };
        }
      },
      raw
    );
    expect(exitCode).toBe(EXIT.ok);
    expect(posted?.expectedVersion).toBe(3);
    const entity = posted?.entity as Record<string, unknown>;
    expect(entity.status).toBe("cancelled");
    expect(entity.title).toBe("Gym session");
    expect(entity.startsAt).toBe("2026-09-03T17:00:00+10:00");
    const doc = JSON.parse(stdout) as { id: string; status: string; title: string };
    expect(doc.id).toBe("commitment-gym");
    expect(doc.status).toBe("cancelled");
    expect(doc.title).toBe("Gym session");
  });

  describe("the version the caller read", () => {
    const atVersion = (version: number) => {
      const raw = fixtureRawState();
      raw.commitments = (raw.commitments as Record<string, unknown>[]).map((commitment) =>
        commitment.id === "commitment-gym" ? { ...commitment, version } : commitment
      );
      return raw;
    };
    const posts = (raw: Record<string, unknown>, sink: Record<string, unknown>[]) => ({
      "/api/commands/entity": (call: RecordedCall) => {
        sink.push(call.body as Record<string, unknown>);
        return { body: { state: raw } };
      }
    });

    it("sends the update while the stored record is still at --expected-version", async () => {
      const raw = atVersion(3);
      const sent: Record<string, unknown>[] = [];
      const result = await run(
        ["commitment", "--id", "commitment-gym", "--set", "status=cancelled", "--expected-version", "3", "--json"],
        posts(raw, sent),
        raw
      );
      expect(result.exitCode).toBe(EXIT.ok);
      expect(sent[0]?.expectedVersion).toBe(3);
    });

    it("refuses an update read at an older version as a conflict, naming the current one, and sends nothing", async () => {
      const raw = atVersion(5);
      const sent: Record<string, unknown>[] = [];
      const result = await run(
        ["commitment", "--id", "commitment-gym", "--set", "status=cancelled", "--expected-version", "3"],
        posts(raw, sent),
        raw
      );
      expect(result.exitCode).toBe(EXIT.conflict);
      expect(result.stderr).toContain("is at version 5 now, not 3");
      expect(result.stderr).toContain("--expected-version 5");
      expect(sent).toHaveLength(0);
    });

    it("refuses the same way on --dry-run, so a preview never promises a write that would conflict", async () => {
      const raw = atVersion(5);
      const result = await run(
        ["commitment", "--id", "commitment-gym", "--set", "status=cancelled", "--expected-version", "3", "--dry-run"],
        {},
        raw
      );
      expect(result.exitCode).toBe(EXIT.conflict);
    });

    it("honours a version passed back with the record's own fields", async () => {
      const raw = atVersion(5);
      const sent: Record<string, unknown>[] = [];
      const result = await run(
        ["commitment", "--id", "commitment-gym", "--fields", JSON.stringify({ status: "cancelled", version: 4 })],
        posts(raw, sent),
        raw
      );
      expect(result.exitCode).toBe(EXIT.conflict);
      expect(sent).toHaveLength(0);
    });

    it("refuses --create on an id deleted since it was read as a conflict, never advising to recreate it", async () => {
      const raw = atVersion(3);
      const sent: Record<string, unknown>[] = [];
      const result = await run(
        ["commitment", "--id", "commitment-gone", "--create", "--set", "status=cancelled", "--expected-version", "3"],
        posts(raw, sent),
        raw
      );
      expect(result.exitCode).toBe(EXIT.conflict);
      expect(result.stderr).toContain("was removed after you read it (at version 3)");
      expect(result.stderr).not.toContain("Leave it out to create one");
      expect(sent).toHaveLength(0);
    });

    it("refuses an update of an id deleted since it was read as a conflict, not a plain not-found", async () => {
      const raw = atVersion(3);
      const result = await run(
        ["commitment", "--id", "commitment-gone", "--set", "status=cancelled", "--expected-version", "3"],
        {},
        raw
      );
      expect(result.exitCode).toBe(EXIT.conflict);
      expect(result.stderr).toContain("was removed after you read it (at version 3)");
      expect(result.stderr).not.toContain("--create");
    });

    it("sends a keyed repeat read at an older version with that version, so the portal's receipt can replay it", async () => {
      const commandId = "6f1c1a52-4c1e-4b8e-9a51-3c5c2a4c9e10";
      const args = ["commitment", "--id", "commitment-gym", "--set", "status=cancelled", "--expected-version", "3"];
      const raw = atVersion(4);
      const sent: Record<string, unknown>[] = [];
      const replayed = await run([...args, "--command-id", commandId], posts(raw, sent), raw);
      expect(replayed.exitCode).toBe(EXIT.ok);
      expect(sent[0]?.commandId).toBe(commandId);
      expect(sent[0]?.expectedVersion).toBe(3);
      // The record read is already past version 3, so restating it as the undo would put back nothing.
      expect(replayed.stderr).not.toContain("rhen undo");
      const fresh = await run(
        ["commitment", "--id", "commitment-gym", "--set", "status=cancelled", "--expected-version", "4"],
        posts(raw, []),
        raw
      );
      expect(fresh.stderr).toContain("rhen undo");

      const refused = await run(
        [...args, "--command-id", commandId],
        {
          "/api/commands/entity": {
            status: 409,
            body: { error: "This record changed elsewhere. Reload before saving." }
          }
        },
        raw
      );
      expect(refused.exitCode).toBe(EXIT.conflict);
    });

    it("sends a keyed repeat of a removal whose record is gone, so the portal's receipt can replay it", async () => {
      const commandId = "0b7f3c1e-2a4d-4e6f-8a1b-9c2d3e4f5a6b";
      const sent: Record<string, unknown>[] = [];
      const result = await run(
        [
          "sleep-log-entry",
          "--id",
          "night-old",
          "--set",
          "remove=true",
          "--expected-version",
          "3",
          "--command-id",
          commandId
        ],
        {
          "/api/sleep-log": { body: { sleepPlans: [] } },
          ...posts(fixtureRawState(), sent)
        }
      );
      expect(result.exitCode).toBe(EXIT.ok);
      expect(sent[0]?.commandId).toBe(commandId);
      expect(sent[0]?.expectedVersion).toBe(3);
      expect(sent[0]?.entity).toMatchObject({ id: "night-old", remove: true });
    });

    it("refuses an --expected-version that disagrees with the version field, or one given for a create", async () => {
      const raw = atVersion(3);
      const disagree = await run(
        ["commitment", "--id", "commitment-gym", "--set", "version=2", "--expected-version", "3"],
        {},
        raw
      );
      expect(disagree.exitCode).toBe(EXIT.usage);
      const create = await run(["capture", "--set", "text=Call the bank", "--expected-version", "1"]);
      expect(create.exitCode).toBe(EXIT.usage);
      expect(create.stderr).toContain("no stored capture");
    });
  });

  it("sends latenessMatters and transportMode on a commitment save", async () => {
    const { exitCode, stdout } = await run([
      "commitment",
      "--id",
      "commitment-gym",
      "--set",
      "latenessMatters=false",
      "--set",
      "transportMode=walk",
      "--dry-run",
      "--json"
    ]);
    expect(exitCode).toBe(EXIT.ok);
    expect(stdout).toContain('"latenessMatters": false');
    expect(stdout).toContain('"transportMode": "walk"');
  });

  it("accepts the plural alias 'commitments'", async () => {
    const raw = fixtureRawState();
    const { exitCode } = await run(
      ["commitments", "--id", "commitment-gym", "--set", "status=cancelled"],
      {
        "/api/commands/entity": (call) => {
          const entity = (call.body as Record<string, unknown>).entity as Record<string, unknown>;
          const commitments = raw.commitments as Record<string, unknown>[];
          const updated = commitments.map((commitment) =>
            commitment.id === "commitment-gym" ? { ...commitment, ...entity } : commitment
          );
          return { body: { state: { ...raw, commitments: updated } } };
        }
      },
      raw
    );
    expect(exitCode).toBe(EXIT.ok);
  });

  it("prefills currentEnergy/assertedConditions and the settings-row version for a location-only current_availability write", async () => {
    // finding 6: a bare `--set currentSituation.locationId=...` must not omit the two fields the
    // server's current_availability handler requires, and must not send expectedVersion:null against
    // a row that already exists (both would make the write fail every time).
    const raw = fixtureRawState();
    raw.settings = { ...(raw.settings as Record<string, unknown>), version: 9 };
    let posted: Record<string, unknown> | undefined;
    const { exitCode } = await run(
      ["current_availability", "--set", "currentSituation.locationId=ctx-gym", "--json"],
      {
        "/api/commands/entity": (call) => {
          posted = call.body as Record<string, unknown>;
          const parsed = planningEntityCommandSchema.safeParse(call.body);
          expect(parsed.success).toBe(true);
          return { body: { state: raw } };
        }
      },
      raw
    );
    expect(exitCode).toBe(EXIT.ok);
    expect(posted?.expectedVersion).toBe(9);
    const entity = posted?.entity as Record<string, unknown>;
    expect(entity.currentEnergy).toBe("high");
    expect(entity.assertedConditions).toEqual(["home", "laptop"]);
    expect(entity.currentSituation).toMatchObject({ locationId: "ctx-gym" });
    // The energy it carries over was not said now, so it must not be re-dated.
    expect(entity).not.toHaveProperty("energyAsserted");
  });

  it("accepts the current-availability alias too, prefilled the same way", async () => {
    const raw = fixtureRawState();
    raw.settings = { ...(raw.settings as Record<string, unknown>), version: 2 };
    let posted: Record<string, unknown> | undefined;
    const { exitCode } = await run(
      ["current-availability", "--set", "currentEnergy=low"],
      {
        "/api/commands/entity": (call) => {
          posted = call.body as Record<string, unknown>;
          return { body: { state: raw } };
        }
      },
      raw
    );
    expect(exitCode).toBe(EXIT.ok);
    expect(posted?.expectedVersion).toBe(2);
    const entity = posted?.entity as Record<string, unknown>;
    expect(entity.currentEnergy).toBe("low");
    expect(entity.assertedConditions).toEqual(["home", "laptop"]);
  });

  it("dates energy it is given as said now, even when it matches what is stored", async () => {
    // An agent relaying "still low" sends the stored value: without the assertion the portal keeps the old
    // `energySetAt`, and the energy need never clears.
    const raw = fixtureRawState();
    raw.settings = { ...(raw.settings as Record<string, unknown>), version: 4 };
    let posted: Record<string, unknown> | undefined;
    const { exitCode } = await run(
      ["current_availability", "--set", `currentEnergy=${String(raw.currentEnergy)}`],
      {
        "/api/commands/entity": (call) => {
          posted = call.body as Record<string, unknown>;
          expect(planningEntityCommandSchema.safeParse(call.body).success).toBe(true);
          return { body: { state: raw } };
        }
      },
      raw
    );
    expect(exitCode).toBe(EXIT.ok);
    expect(posted?.entity).toMatchObject({ currentEnergy: raw.currentEnergy, energyAsserted: true });
  });

  it("--dry-run prints the payload and never sends the POST", async () => {
    const { exitCode, stdout, calls } = await run(["capture", "--set", "text=Book the dentist follow-up", "--dry-run"]);
    expect(exitCode).toBe(EXIT.ok);
    expect(stdout).toContain('"dryRun": true');
    expect(stdout).toContain("/api/commands/entity");
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("files a new capture as pending when --set gives no status (the status `capture` uses)", async () => {
    const { exitCode, stdout } = await run(["capture", "--set", "text=x", "--dry-run"]);
    expect(exitCode).toBe(EXIT.ok);
    const printed = JSON.parse(stdout) as { payload: { entity: { status: string; text: string } } };
    expect(printed.payload.entity).toMatchObject({ text: "x", status: "pending" });
  });

  it("keeps a status given for a new capture", async () => {
    const { exitCode, stdout } = await run(["capture", "--set", "text=x", "--set", "status=ignored", "--dry-run"]);
    expect(exitCode).toBe(EXIT.ok);
    const printed = JSON.parse(stdout) as { payload: { entity: { status: string } } };
    expect(printed.payload.entity.status).toBe("ignored");
  });

  it("refuses to create an action that is missing required fields, without calling the portal", async () => {
    const { exitCode, calls } = await run(["action", "--set", "title=X"]);
    expect(exitCode).toBe(EXIT.validation);
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("reports a portal conflict as exit 3", async () => {
    const { exitCode } = await run(["capture", "--set", "text=X"], {
      "/api/commands/entity": { status: 409, body: { error: "stale, re-read and retry" } }
    });
    expect(exitCode).toBe(EXIT.conflict);
  });

  it("reports a portal validation refusal as exit 2", async () => {
    const { exitCode } = await run(["capture", "--set", "text=X"], {
      "/api/commands/entity": {
        status: 400,
        body: { error: "bad request", issues: [{ path: ["entity", "text"], message: "required" }] }
      }
    });
    expect(exitCode).toBe(EXIT.validation);
  });

  // write-time gate lives server-side (`linkedCadenceAction`, entity-commands.ts) — the CLI is
  // a thin HTTP client over the same `save_entity` route the portal UI uses, so this only pins that the
  // refusal reaches the person clearly rather than surfacing as an opaque failure.
  it("surfaces the portal's cadence-link refusal clearly when a routine step names a non-cadence action", async () => {
    const dir = mkdtempSync(join(tmpdir(), "openrhen-cli-"));
    const file = join(dir, "routine-step.json");
    writeFileSync(
      file,
      JSON.stringify({
        commitmentId: "commitment-college",
        title: "Practice piano",
        durationMinutes: 10,
        sequence: 0,
        timingRule: "contiguous",
        energy: "low",
        phase: "before",
        contexts: [],
        cadenceActionId: "action-not-cadence"
      }),
      "utf8"
    );
    const { exitCode, stderr } = await run(["routine_step", "--from", file], {
      "/api/commands/entity": {
        status: 400,
        body: { error: "The linked action is not scheduled as cadence." }
      }
    });
    expect(exitCode).toBe(EXIT.validation);
    expect(stderr).toContain("The linked action is not scheduled as cadence.");
  });

  it("creates a project via --from a JSON file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "openrhen-cli-"));
    const file = join(dir, "new-project.json");
    writeFileSync(
      file,
      JSON.stringify({
        id: "project-new",
        outcomeId: "outcome-degree",
        title: "New Project",
        status: "active",
        uncertainty: "some",
        consequence: 3
      }),
      "utf8"
    );
    const raw = fixtureRawState();
    let posted: Record<string, unknown> | undefined;
    const { exitCode, stdout } = await run(
      ["project", "--create", "--from", file, "--json"],
      {
        "/api/commands/project": (call) => {
          posted = call.body as Record<string, unknown>;
          const parsed = saveProjectCommandSchema.safeParse(call.body);
          expect(parsed.success).toBe(true);
          const projects = raw.projects as Record<string, unknown>[];
          return { body: { state: { ...raw, projects: [...projects, posted!.project] } } };
        }
      },
      raw
    );
    expect(exitCode).toBe(EXIT.ok);
    expect(posted?.expectedVersion).toBeNull();
    const doc = JSON.parse(stdout) as { id: string; title: string };
    expect(doc.id).toBe("project-new");
    expect(doc.title).toBe("New Project");
  });

  it("refuses an unknown entity type and lists the accepted names", async () => {
    const { exitCode, stderr } = await run(["bogus-type", "--set", "x=1"]);
    expect(exitCode).toBe(EXIT.usage);
    expect(stderr).toContain("area");
    expect(stderr).toContain("deliverable_contract_review");
  });

  it("reads state exactly once for a straightforward save", async () => {
    const raw = fixtureRawState();
    const { calls } = await run(["capture", "--set", "text=X"], {
      "/api/commands/entity": { body: { state: raw } }
    });
    const getCalls = calls.filter((call) => call.method === "GET");
    expect(getCalls.length).toBe(1);
  });

  it("updates an action's status without a --set on requirementPathways, converting the stored read shape to the write shape", async () => {
    const raw = fixtureRawState();
    let posted: Record<string, unknown> | undefined;
    const { exitCode, stdout } = await run(
      ["action", "--id", "action-cite", "--set", "status=done", "--json"],
      {
        "/api/commands/action": (call) => {
          posted = call.body as Record<string, unknown>;
          const parsed = saveActionCommandSchema.safeParse(call.body);
          expect(parsed.success).toBe(true);
          const action = posted.action as Record<string, unknown>;
          const updated = (raw.actions as Record<string, unknown>[]).map((item) =>
            item.id === "action-cite" ? { ...item, ...action, version: 2 } : item
          );
          return { body: { state: { ...raw, actions: updated } } };
        }
      },
      raw
    );
    expect(exitCode).toBe(EXIT.ok);
    const action = posted?.action as Record<string, unknown>;
    expect(action.status).toBe("done");
    // The fixture's action-cite carries the read shape `[{ id, contextIds }]`; the posted payload
    // must be the write shape the command schema requires.
    expect(action.requirementPathways).toEqual([["home"]]);
    const doc = JSON.parse(stdout) as { id: string; status: string };
    expect(doc.id).toBe("action-cite");
    expect(doc.status).toBe("done");
  });

  it("saves an existing action that has no requirementPathways at all", async () => {
    const raw = fixtureRawState();
    const { exitCode } = await run(
      ["action", "--id", "action-draft", "--set", "status=active"],
      {
        "/api/commands/action": (call) => {
          const parsed = saveActionCommandSchema.safeParse(call.body);
          expect(parsed.success).toBe(true);
          const action = (call.body as Record<string, unknown>).action as Record<string, unknown>;
          const updated = (raw.actions as Record<string, unknown>[]).map((item) =>
            item.id === "action-draft" ? { ...item, ...action, version: 2 } : item
          );
          return { body: { state: { ...raw, actions: updated } } };
        }
      },
      raw
    );
    expect(exitCode).toBe(EXIT.ok);
  });

  it("confirms the remaining time on an action it is given, even at the stored figure, and not when it only carries it over", async () => {
    // "Still about 90 minutes": the answer to an aged-effort need. Without the assertion the server keeps the old
    // `remainingSetAt` (it moves only when the figure changes), and the need would never clear.
    const sent = async (set: string[]) => {
      const raw = fixtureRawState();
      let posted: Record<string, unknown> | undefined;
      const { exitCode } = await run(
        ["action", "--id", "action-draft", ...set.flatMap((item) => ["--set", item])],
        {
          "/api/commands/action": (call) => {
            posted = call.body as Record<string, unknown>;
            expect(saveActionCommandSchema.safeParse(call.body).success).toBe(true);
            return { body: { state: raw } };
          }
        },
        raw
      );
      expect(exitCode).toBe(EXIT.ok);
      return posted!;
    };
    const stored = (fixtureRawState().actions as Record<string, unknown>[]).find((item) => item.id === "action-draft")!;
    const same = await sent([`remainingMinutes=${String(stored.remainingMinutes)}`]);
    expect(same.remainingAsserted).toBe(true);
    expect((same.action as Record<string, unknown>).remainingMinutes).toBe(stored.remainingMinutes);
    expect((same.action as Record<string, unknown>).remainingAsserted).toBeUndefined();
    expect((await sent(["remainingMinutes=30"])).remainingAsserted).toBe(true);
    // Editing something else restates the stored figure without saying it.
    expect(await sent(["status=active"])).not.toHaveProperty("remainingAsserted");
  });

  it("generates a recurrence id and a window id for a new recurring action", async () => {
    const raw = fixtureRawState();
    let posted: Record<string, unknown> | undefined;
    const { exitCode } = await run(
      [
        "action",
        "--create",
        "--set",
        "id=action-yoga",
        "--set",
        "title=Yoga",
        "--set",
        "projectId=project-thesis",
        "--set",
        "schedulingMode=recurring",
        "--set",
        "recurrence.timezone=Australia/Sydney",
        "--set",
        "recurrence.startDate=2026-09-10",
        "--set",
        "recurrence.intervalDays=1",
        "--set",
        'recurrence.windows=[{"name":"Morning","anchor":"local_time","localStartTime":"07:00","localEndTime":"08:00"}]'
      ],
      {
        "/api/commands/action": (call) => {
          posted = call.body as Record<string, unknown>;
          const parsed = saveActionCommandSchema.safeParse(call.body);
          expect(parsed.success).toBe(true);
          const action = posted.action as Record<string, unknown>;
          return { body: { state: { ...raw, actions: [...(raw.actions as Record<string, unknown>[]), action] } } };
        }
      },
      raw
    );
    expect(exitCode).toBe(EXIT.ok);
    const action = posted?.action as Record<string, unknown>;
    const recurrence = action.recurrence as Record<string, unknown>;
    expect(typeof recurrence.id).toBe("string");
    expect(recurrence.id as string).toMatch(UUID_RE);
    const windows = recurrence.windows as Record<string, unknown>[];
    expect(windows).toHaveLength(1);
    expect(typeof windows[0]?.id).toBe("string");
    expect(windows[0]?.id as string).toMatch(UUID_RE);
    expect(windows[0]?.name).toBe("Morning");
  });

  it("generates a recurrence id for a new cadence action, which carries no windows", async () => {
    let posted: Record<string, unknown> | undefined;
    const { exitCode } = await run(
      [
        "action",
        "--create",
        "--set",
        "id=action-stretch",
        "--set",
        "title=Morning stretch",
        "--set",
        "projectId=project-thesis",
        "--set",
        "schedulingMode=cadence",
        "--set",
        "recurrence.timezone=Australia/Sydney",
        "--set",
        "recurrence.startDate=2026-09-01",
        "--set",
        "recurrence.intervalDays=2"
      ],
      {
        "/api/commands/action": (call) => {
          posted = call.body as Record<string, unknown>;
          const parsed = saveActionCommandSchema.safeParse(call.body);
          expect(parsed.success).toBe(true);
          return { body: { state: fixtureRawState() } };
        }
      }
    );
    expect(exitCode).toBe(EXIT.ok);
    const action = posted?.action as Record<string, unknown>;
    const recurrence = action.recurrence as Record<string, unknown>;
    expect(typeof recurrence.id).toBe("string");
    expect(recurrence.id as string).toMatch(UUID_RE);
    expect(recurrence.windows).toEqual([]);
  });

  it("keeps an existing recurrence.id and window id unchanged when both are supplied", async () => {
    const raw = fixtureRawState();
    let posted: Record<string, unknown> | undefined;
    const { exitCode } = await run(
      [
        "action",
        "--create",
        "--set",
        "id=action-yoga",
        "--set",
        "title=Yoga",
        "--set",
        "projectId=project-thesis",
        "--set",
        "schedulingMode=recurring",
        "--set",
        "recurrence.id=rule-yoga-fixed",
        "--set",
        "recurrence.timezone=Australia/Sydney",
        "--set",
        "recurrence.startDate=2026-09-10",
        "--set",
        "recurrence.intervalDays=1",
        "--set",
        'recurrence.windows=[{"id":"window-fixed","name":"Morning","anchor":"local_time","localStartTime":"07:00","localEndTime":"08:00"}]'
      ],
      {
        "/api/commands/action": (call) => {
          posted = call.body as Record<string, unknown>;
          const parsed = saveActionCommandSchema.safeParse(call.body);
          expect(parsed.success).toBe(true);
          const action = posted.action as Record<string, unknown>;
          return { body: { state: { ...raw, actions: [...(raw.actions as Record<string, unknown>[]), action] } } };
        }
      },
      raw
    );
    expect(exitCode).toBe(EXIT.ok);
    const action = posted?.action as Record<string, unknown>;
    const recurrence = action.recurrence as Record<string, unknown>;
    expect(recurrence.id).toBe("rule-yoga-fixed");
    const windows = recurrence.windows as Record<string, unknown>[];
    expect(windows[0]?.id).toBe("window-fixed");
  });

  it("adds a guide pointer to an action validation failure that touches recurrence", async () => {
    const { exitCode, stderr } = await run([
      "action",
      "--create",
      "--set",
      "id=action-bad",
      "--set",
      "title=Bad",
      "--set",
      "projectId=project-thesis",
      "--set",
      "schedulingMode=recurring"
      // No recurrence object at all -> "Recurring actions require a recurrence rule."
    ]);
    expect(exitCode).toBe(EXIT.validation);
    expect(stderr).toContain("rhen guide recurrence");
  });

  it("does not add the recurrence pointer to an unrelated action validation failure", async () => {
    const { exitCode, stderr } = await run(["action", "--set", "title=X"]);
    expect(exitCode).toBe(EXIT.validation);
    expect(stderr).not.toContain("rhen guide recurrence");
  });

  describe("prerequisites", () => {
    const edge = (kind: string, id: string) => JSON.stringify([{ kind, id }]);

    it("accepts --set prerequisites on a project and sends it", async () => {
      const { exitCode, stdout } = await run([
        "project",
        "--id",
        "project-garden",
        "--set",
        `prerequisites=${edge("deliverable", "deliverable-chapter")}`,
        "--dry-run"
      ]);
      expect(exitCode).toBe(EXIT.ok);
      expect(stdout).toContain('"prerequisites"');
      expect(stdout).toContain("deliverable-chapter");
    });

    it("refuses an action listing its own kind, its own project, an unknown id, or malformed refs", async () => {
      const cases: [string, string][] = [
        [edge("action", "action-draft"), "dependencyIds"],
        [edge("project", "project-thesis"), "own project"],
        [edge("deliverable", "nope"), "does not exist"],
        ['[{"kind":"thing","id":"x"}]', "list of"]
      ];
      for (const [value, message] of cases) {
        const result = await run(["action", "--id", "action-cite", "--set", `prerequisites=${value}`, "--dry-run"]);
        expect(result.exitCode).toBe(EXIT.validation);
        expect(result.stderr).toContain(message);
        expect(result.calls.some((call) => call.method === "POST")).toBe(false);
      }
    });

    it("refuses a loop through a project", async () => {
      // The project already waits on the action, so the action cannot wait back on the project's other work.
      const raw = fixtureRawState();
      (raw.projects as Record<string, unknown>[])[1]!.prerequisites = [{ kind: "action", id: "action-cite" }];
      const result = await run(
        [
          "deliverable",
          "--id",
          "deliverable-chapter",
          "--set",
          `prerequisites=${edge("project", "project-garden")}`,
          "--dry-run"
        ],
        {},
        raw
      );
      // deliverable-chapter -> project-garden -> action-cite is not a loop unless action-cite waits on the deliverable.
      expect(result.exitCode).toBe(EXIT.ok);
      (raw.actions as Record<string, unknown>[]).find((a) => a.id === "action-cite")!.prerequisites = [
        { kind: "deliverable", id: "deliverable-chapter" }
      ];
      const looped = await run(
        [
          "deliverable",
          "--id",
          "deliverable-chapter",
          "--set",
          `prerequisites=${edge("project", "project-garden")}`,
          "--dry-run"
        ],
        {},
        raw
      );
      expect(looped.exitCode).toBe(EXIT.validation);
      expect(looped.stderr).toContain("cycle");
    });
  });
});

describe("save daily-plan", () => {
  const stateWithPlan = (): Record<string, unknown> => {
    const raw = fixtureRawState();
    return { ...raw, dailyPlan: { ...(raw.dailyPlan as Record<string, unknown>), version: 3 } };
  };
  const payloadOf = (result: Run) =>
    (JSON.parse(result.stdout) as { payload: { expectedVersion: number | null; entity: Record<string, unknown> } })
      .payload;

  it("updates the stored plan when the day is the same or not named", async () => {
    const same = await run(
      ["daily-plan", "--set", "localDate=2026-09-03", "--set", 'desiredActionIds=["action-draft"]', "--dry-run"],
      {},
      stateWithPlan()
    );
    expect(payloadOf(same).expectedVersion).toBe(3);
    expect(payloadOf(same).entity).toMatchObject({ id: "plan-today", localDate: "2026-09-03" });
    const unnamed = await run(
      ["daily-plan", "--set", 'desiredActionIds=["action-draft"]', "--dry-run"],
      {},
      stateWithPlan()
    );
    expect(payloadOf(unnamed).expectedVersion).toBe(3);
    expect(payloadOf(unnamed).entity).toMatchObject({ id: "plan-today", localDate: "2026-09-03" });
  });

  it("creates a new plan for another day instead of merging onto the stored row", async () => {
    const result = await run(
      ["daily-plan", "--set", "localDate=2026-09-04", "--set", 'desiredActionIds=["action-cite"]', "--dry-run"],
      {},
      stateWithPlan()
    );
    expect(result.exitCode).toBe(EXIT.ok);
    const payload = payloadOf(result);
    expect(payload.expectedVersion).toBeNull();
    expect(payload.entity).toEqual({ localDate: "2026-09-04", desiredActionIds: ["action-cite"] });
    expect(result.stderr).toContain("create daily plan");
  });
});

describe("save: typed fields and create versus update", () => {
  const posted = (result: Run) =>
    result.calls.find((call) => call.method === "POST")?.body as Record<string, unknown> | undefined;
  const ok = { "/api/commands/entity": { body: { state: fixtureRawState() } } };

  it("refuses an id that names no record instead of creating one", async () => {
    const result = await run(["commitment", "--id", "commitment-gmy", "--set", "status=cancelled"]);
    expect(result.exitCode).toBe(EXIT.notFound);
    expect(result.stderr).toContain('No commitment has the id "commitment-gmy"');
    expect(result.stderr).toContain("--create");
    expect(posted(result)).toBeUndefined();
  });

  it("creates with a chosen id only when asked, and --create over a record that exists updates it", async () => {
    const fresh = await run(["capture", "--create", "--set", "id=capture-new", "--set", "text=Call the bank"], ok);
    expect(fresh.exitCode).toBe(EXIT.ok);
    expect((posted(fresh)?.entity as Record<string, unknown> | undefined)?.id).toBe("capture-new");
    expect(posted(fresh)?.expectedVersion).toBeNull();
    const again = await run(["capture", "--create", "--id", "capture-dentist", "--set", "text=Again", "--dry-run"]);
    expect(again.exitCode).toBe(EXIT.ok);
    expect(again.stderr + again.stdout).toContain("update capture");
    const noId = await run(["capture", "--create", "--set", "text=Call the bank"]);
    expect(noId.exitCode).toBe(EXIT.usage);
  });

  it("keys a new action or project that named no id by its command id, and keeps a chosen id", async () => {
    const commandId = "5b1f3c1e-0f7a-4c52-9d0e-6a1d4f0b2a11";
    const routes = {
      "/api/commands/action": { body: { state: fixtureRawState() } },
      "/api/commands/project": { body: { state: fixtureRawState() } }
    };
    const action = ["action", "--set", "title=Call mum", "--set", "projectId=project-thesis"];
    const project = ["project", "--set", "title=Garden", "--set", "outcomeId=outcome-degree"];

    // The portal's schema wants an id on both routes, so a create that named none is sent the command id.
    const newAction = await run([...action, "--command-id", commandId], routes);
    expect(newAction.exitCode).toBe(EXIT.ok);
    expect(saveActionCommandSchema.safeParse(posted(newAction)).success).toBe(true);
    expect(posted(newAction)).toMatchObject({ commandId, action: { id: commandId }, expectedVersion: null });
    const newProject = await run([...project, "--command-id", commandId], routes);
    expect(newProject.exitCode).toBe(EXIT.ok);
    expect(saveProjectCommandSchema.safeParse(posted(newProject)).success).toBe(true);
    expect(posted(newProject)).toMatchObject({ commandId, project: { id: commandId }, expectedVersion: null });

    // A repeat with the same command id sends the same record id, so the portal's receipt for that id answers it.
    const repeat = await run([...action, "--command-id", commandId], routes);
    expect(posted(repeat)).toEqual(posted(newAction));

    // Without a key, each invocation mints its own, and the record is keyed by that one.
    const minted = await run(action, routes);
    const mintedBody = posted(minted) as { commandId: string; action: { id: string } };
    expect(mintedBody.commandId).toMatch(UUID_RE);
    expect(mintedBody.action.id).toBe(mintedBody.commandId);

    // A chosen id is kept, and is not the command id.
    const chosen = await run([...action, "--create", "--set", "id=action-call-mum"], routes);
    const chosenBody = posted(chosen) as { commandId: string; action: { id: string } };
    expect(chosenBody.action.id).toBe("action-call-mum");
    expect(chosenBody.commandId).not.toBe("action-call-mum");
  });

  it("says where a new action will land: not placed yet, and the calls that show it", async () => {
    const routes = { "/api/commands/action": { body: { state: fixtureRawState() } } };
    const created = await run(
      ["action", "--set", "title=Call mum", "--set", "projectId=project-thesis", "--json"],
      routes
    );
    expect(created.exitCode).toBe(EXIT.ok);
    const json = JSON.parse(created.stdout) as { applied: boolean; placement: string };
    expect(json.applied).toBe(true);
    expect(json.placement).toContain("not placed in the day yet");
    expect(json.placement).toContain("rhen_recalculate");
    expect(json.placement).toContain("rhen_status");
    // An update, and other kinds, make no promise about placement.
    const capture = await run(["capture", "--set", "text=Call the bank", "--json"], {
      "/api/commands/entity": { body: { state: fixtureRawState() } }
    });
    expect(JSON.parse(capture.stdout)).not.toHaveProperty("placement");
  });

  it("refuses a field the kind does not take, naming the ones it does", async () => {
    const result = await run(["project", "--id", "project-thesis", "--set", "area=Study"]);
    expect(result.exitCode).toBe(EXIT.validation);
    expect(result.stderr).toContain('A project has no field "area"');
    expect(result.stderr).toContain("outcomeId");
    expect(posted(result)).toBeUndefined();
  });

  it("hints the closest field name when the refused one is part of a real one", async () => {
    const result = await run(["deliverable", "--id", "deliverable-x", "--set", "deadlineAt=2026-09-30T17:00:00+10:00"]);
    expect(result.exitCode).toBe(EXIT.validation);
    expect(result.stderr).toContain('has no field "deadlineAt"');
    expect(result.stderr).toMatch(/did you mean [^?]*"internalDeadlineAt"/);
    expect(posted(result)).toBeUndefined();
    // A misspelling gets the hint too; a name nothing resembles gets none.
    const typo = await run(["project", "--id", "project-thesis", "--set", "outcomeID=o1"]);
    expect(typo.stderr).toContain('did you mean "outcomeId"');
    const unrelated = await run(["project", "--id", "project-thesis", "--set", "zzzzzz=1"]);
    expect(unrelated.stderr).not.toContain("did you mean");
  });

  it("refuses the removed calendar-sharing names, naming nothing else as an alias", async () => {
    for (const [kind, old] of [
      ["commitment", "shareWithFamily"],
      ["settings", "shareWithFamilyEnabled"]
    ] as const) {
      const result = await run([kind, "--id", "x", "--set", `${old}=true`]);
      expect(result.exitCode, `${kind} ${old}`).toBe(EXIT.validation);
      expect(result.stderr).toContain(`has no field "${old}"`);
      expect(posted(result)).toBeUndefined();
    }
  });

  it("drops the bookkeeping fields of a record read back rather than refusing them", async () => {
    const result = await run([
      "capture",
      "--fields",
      JSON.stringify({ id: "capture-dentist", text: "Book it", updatedAt: "2026-09-02T18:00:00+10:00" }),
      "--dry-run"
    ]);
    expect(result.exitCode).toBe(EXIT.ok);
  });

  it("takes the fields as one JSON object, with --set applied over it", async () => {
    const result = await run([
      "capture",
      "--fields",
      JSON.stringify({ text: "Call the bank", proposalType: "unclassified" }),
      "--set",
      "text=Call the bank today",
      "--dry-run"
    ]);
    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.stdout).toContain("Call the bank today");
    const bad = await run(["capture", "--fields", "[1,2]"]);
    expect(bad.exitCode).toBe(EXIT.usage);
  });

  it("maps a status synonym to the kind's own word and refuses one it lacks", async () => {
    const synonym = await run(["commitment", "--id", "commitment-gym", "--set", "status=canceled"], ok);
    expect(synonym.exitCode).toBe(EXIT.ok);
    expect((posted(synonym)?.entity as Record<string, unknown> | undefined)?.status).toBe("cancelled");
    const unknown = await run(["commitment", "--id", "commitment-gym", "--set", "status=done"]);
    expect(unknown.exitCode).toBe(EXIT.validation);
    expect(unknown.stderr).toContain("Use one of: confirmed, tentative, cancelled");
  });

  it("finds a logged night by id and sends its version, from the sleep log when state does not carry it", async () => {
    const night = {
      id: "night-old",
      version: 3,
      plannedStartAt: "2026-08-20T22:30:00+10:00",
      plannedWakeAt: "2026-08-21T06:30:00+10:00",
      actualStartAt: "2026-08-20T23:00:00+10:00",
      actualWakeAt: "2026-08-21T06:00:00+10:00",
      status: "completed"
    };
    const result = await run(["sleep-log-entry", "--id", "night-old", "--set", "wakeAt=2026-08-21T07:00:00+10:00"], {
      ...ok,
      "/api/sleep-log": { body: { sleepPlans: [night] } }
    });
    expect(result.exitCode).toBe(EXIT.ok);
    expect(posted(result)?.expectedVersion).toBe(3);
    expect(posted(result)?.entity).toEqual({
      id: "night-old",
      sleepAt: "2026-08-20T23:00:00+10:00",
      wakeAt: "2026-08-21T07:00:00+10:00"
    });
    const missing = await run(["sleep-log-entry", "--id", "night-none", "--set", "remove=true"], {
      "/api/sleep-log": { body: { sleepPlans: [] } }
    });
    expect(missing.exitCode).toBe(EXIT.notFound);
  });

  it("sends only the fields given for a sleep plan, so its stored times are not restated as a move", async () => {
    const result = await run(["sleep-plan", "--id", "sleep-tonight", "--set", "placementChoice=early"], ok);
    expect(result.exitCode).toBe(EXIT.ok);
    expect(posted(result)?.entity).toEqual({ id: "sleep-tonight", placementChoice: "early" });
  });

  it("carries an action's completion time", async () => {
    const result = await run([
      "action",
      "--id",
      "action-draft",
      "--set",
      "status=completed",
      "--set",
      "completedAt=2026-09-01T09:00:00+10:00",
      "--dry-run"
    ]);
    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.stdout).toContain('"completedAt": "2026-09-01T09:00:00+10:00"');
    expect(result.stdout).toContain('"status": "done"');
  });
});

describe("save action: why it waits", () => {
  it("lifts blockingReason and note out of the fields onto the command", async () => {
    const result = await run([
      "action",
      "--id",
      "action-draft",
      "--set",
      "status=waiting",
      "--set",
      "blockingReason=waiting_on_someone",
      "--set",
      "note=Emailed Jess",
      "--dry-run"
    ]);
    expect(result.exitCode).toBe(EXIT.ok);
    const body = JSON.parse(result.stdout.slice(result.stdout.indexOf("{"))) as Record<string, unknown>;
    const payload = (body.body ?? body.payload ?? body) as Record<string, unknown>;
    expect(payload.blockingReason).toBe("waiting_on_someone");
    expect(payload.note).toBe("Emailed Jess");
    expect((payload.action as Record<string, unknown>).blockingReason).toBeUndefined();
  });
});

describe("save action: assumed fields", () => {
  /** The `action` of the dry-run payload. */
  function sentAction(result: Run): Record<string, unknown> {
    expect(result.exitCode, result.stderr).toBe(EXIT.ok);
    const body = JSON.parse(result.stdout.slice(result.stdout.indexOf("{"))) as { payload: { action: unknown } };
    return body.payload.action as Record<string, unknown>;
  }

  /** The fixture state with `action-draft` listing three fields as assumed. */
  function withAssumed(assumed: string[]): Record<string, unknown> {
    const raw = fixtureRawState();
    raw.actions = (raw.actions as Record<string, unknown>[]).map((item) =>
      item.id === "action-draft" ? { ...item, assumedFields: assumed } : item
    );
    return raw;
  }

  it("records every estimate and judgement field it defaulted on a create", async () => {
    const action = sentAction(
      await run([
        "action",
        "--create",
        "--fields",
        '{"id":"action-bank","title":"Call the bank","projectId":"project-thesis"}',
        "--dry-run"
      ])
    );
    expect(action.assumedFields).toEqual([
      "optimisticMinutes",
      "expectedMinutes",
      "pessimisticMinutes",
      "remainingMinutes",
      "energy",
      "minimumSessionMinutes",
      "maximumSessionMinutes",
      "importance",
      "consequence",
      "splittable",
      "setupMinutes"
    ]);
    expect(action).toMatchObject({ status: "planned", expectedMinutes: 60, energy: "medium", contexts: [] });
  });

  it("builds a valid payload from a lone expected estimate, working out the rest and listing it as assumed", async () => {
    const result = await run([
      "action",
      "--create",
      "--set",
      "id=action-short",
      "--set",
      "projectId=project-thesis",
      "--set",
      "title=x",
      "--set",
      "expectedMinutes=15",
      "--dry-run"
    ]);
    const action = sentAction(result);
    expect(action).toMatchObject({
      expectedMinutes: 15,
      optimisticMinutes: 15,
      pessimisticMinutes: 15,
      remainingMinutes: 15
    });
    expect(action.assumedFields).toEqual([
      "optimisticMinutes",
      "pessimisticMinutes",
      "remainingMinutes",
      "energy",
      "minimumSessionMinutes",
      "maximumSessionMinutes",
      "importance",
      "consequence",
      "splittable",
      "setupMinutes"
    ]);
    const body = JSON.parse(result.stdout.slice(result.stdout.indexOf("{"))) as { payload: unknown };
    expect(saveActionCommandSchema.safeParse(body.payload).success).toBe(true);
  });

  it("does not record a field the caller gave on a create", async () => {
    const action = sentAction(
      await run([
        "action",
        "--create",
        "--fields",
        '{"id":"action-bank","title":"Call the bank","projectId":"project-thesis","expectedMinutes":75,"pessimisticMinutes":100,"energy":"low","importance":5,"splittable":false}',
        "--dry-run"
      ])
    );
    expect(action.assumedFields).toEqual([
      "optimisticMinutes",
      "remainingMinutes",
      "minimumSessionMinutes",
      "maximumSessionMinutes",
      "consequence",
      "setupMinutes"
    ]);
    expect(saveActionCommandSchema.shape.action.safeParse(action).success).toBe(true);
  });

  it("keeps a field a caller lists itself as a guess on a create, besides the ones it defaulted", async () => {
    const action = sentAction(
      await run([
        "action",
        "--create",
        "--fields",
        '{"id":"action-x","title":"x","projectId":"project-thesis","expectedMinutes":75,"pessimisticMinutes":100,"assumedFields":["expectedMinutes"]}',
        "--dry-run"
      ])
    );
    expect(action.assumedFields).toContain("expectedMinutes");
    expect(action.assumedFields).not.toContain("pessimisticMinutes");
    expect(action.assumedFields).toContain("optimisticMinutes");
  });

  it("drops a field an update names from the stored assumed list, even to the value it had", async () => {
    const raw = withAssumed(["expectedMinutes", "energy", "importance"]);
    const changed = sentAction(
      await run(["action", "--id", "action-draft", "--set", "expectedMinutes=75", "--dry-run"], {}, raw)
    );
    expect(changed.assumedFields).toEqual(["energy", "importance"]);
    const same = sentAction(
      await run(["action", "--id", "action-draft", "--set", "energy=medium", "--dry-run"], {}, raw)
    );
    expect(same.assumedFields).toEqual(["expectedMinutes", "importance"]);
  });

  it("keeps the stored assumed list when an update names none of its fields", async () => {
    const raw = withAssumed(["expectedMinutes", "energy", "importance"]);
    const action = sentAction(
      await run(["action", "--id", "action-draft", "--set", "status=active", "--dry-run"], {}, raw)
    );
    expect(action.assumedFields).toEqual(["expectedMinutes", "energy", "importance"]);
  });

  it("sends an empty list for an update of an action that has nothing assumed", async () => {
    const action = sentAction(await run(["action", "--id", "action-draft", "--set", "status=active", "--dry-run"]));
    expect(action.assumedFields).toEqual([]);
  });

  it("takes the caller's own list on an update over the stored one", async () => {
    const raw = withAssumed(["expectedMinutes", "energy"]);
    const action = sentAction(
      await run(
        ["action", "--id", "action-draft", "--fields", '{"importance":2,"assumedFields":["importance"]}', "--dry-run"],
        {},
        raw
      )
    );
    expect(action.assumedFields).toEqual(["importance"]);
  });

  it("restates the stored list in an undo, empty when the state names none", () => {
    const def = findEntityType("action")!;
    const stored = (fixtureRawState().actions as Record<string, unknown>[]).find((item) => item.id === "action-draft")!;
    const undoOf = (existing: Record<string, unknown>) =>
      (reverseOfUpdate(def, existing, 3, "action-draft")!.undo.payload.action as Record<string, unknown>).assumedFields;
    expect(undoOf({ ...stored, assumedFields: ["energy", "importance"] })).toEqual(["energy", "importance"]);
    expect(undoOf(stored)).toEqual([]);
  });
});
