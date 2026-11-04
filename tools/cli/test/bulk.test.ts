import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { serveMcp } from "../src/commands/mcp.js";
import { commands } from "../src/registry.js";
import { EXIT } from "../src/errors.js";
import { memoryJournal, type Journal } from "../src/undo-journal.js";
import { fakeFetch, type RecordedCall } from "./fake-fetch.js";
import { fixtureNow, fixtureRawState } from "./fixture-state.js";

interface Run {
  exitCode: number;
  stdout: string;
  stderr: string;
  calls: RecordedCall[];
  json: unknown;
}

async function run(
  argv: string[],
  routes: Parameters<typeof fakeFetch>[0] = {},
  rawState: Record<string, unknown> = fixtureRawState(),
  journal?: Journal
): Promise<Run> {
  const calls: RecordedCall[] = [];
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const fetchImpl = fakeFetch({ "/api/state": { body: { state: rawState } }, ...routes }, calls);
  const exitCode = await runCli(argv[0] === "undo" ? argv : ["bulk", ...argv], {
    ...(journal ? { journal } : {}),
    stdout: (text) => stdoutLines.push(text),
    stderr: (text) => stderrLines.push(text),
    env: {},
    readConfigFile: () => null,
    now: () => fixtureNow,
    fetchImpl
  });
  const stdout = stdoutLines.join("\n");
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    json = undefined;
  }
  return { exitCode, stdout, stderr: stderrLines.join("\n"), calls, json };
}

function writeTempJson(name: string, value: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "openrhen-cli-bulk-"));
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(value));
  return path;
}

/** A `/api/commands/action` route that accepts every save and echoes back a state with a bumped version. */
function okActionRoute(raw: Record<string, unknown>) {
  return (call: RecordedCall) => {
    const body = call.body as { action: Record<string, unknown> };
    const actions = (raw.actions as Record<string, unknown>[]).map((action) =>
      action.id === body.action.id ? { ...action, ...body.action, version: 1 } : action
    );
    return { body: { state: { ...raw, actions } } };
  };
}

describe("bulk: selection", () => {
  it("refuses without any selector", async () => {
    const result = await run(["action", "--set", "status=blocked"]);
    expect(result.exitCode).toBe(EXIT.usage);
    expect(result.stderr).toContain("needs a selector");
  });

  it("refuses more than one selector at once", async () => {
    const result = await run(["action", "--status", "planned", "--ids", "action-draft", "--set", "status=blocked"]);
    expect(result.exitCode).toBe(EXIT.usage);
    expect(result.stderr).toContain("only one selection method");
  });

  it("refuses an unknown entity", async () => {
    const result = await run(["widgets", "--ids", "a", "--set", "x=1"]);
    expect(result.exitCode).toBe(EXIT.usage);
    expect(result.stderr).toContain('Unknown entity "widgets"');
  });

  it("refuses an entity list has but save cannot update directly", async () => {
    const result = await run(["occurrences", "--ids", "a", "--set", "x=1"]);
    expect(result.exitCode).toBe(EXIT.usage);
    expect(result.stderr).toContain("bulk cannot update occurrences");
  });

  it("refuses with no patch", async () => {
    const result = await run(["action", "--status", "planned"]);
    expect(result.exitCode).toBe(EXIT.usage);
    expect(result.stderr).toContain("needs --set");
  });

  it("selects by --ids, comma separated", async () => {
    const result = await run([
      "action",
      "--ids",
      "action-draft,action-cite",
      "--set",
      "energy=high",
      "--dry-run",
      "--json"
    ]);
    expect(result.exitCode).toBe(EXIT.ok);
    const body = result.json as { count: number; wouldSucceed: { id: string }[] };
    expect(body.count).toBe(2);
    expect(body.wouldSucceed.map((row) => row.id).sort()).toEqual(["action-cite", "action-draft"]);
    expect(result.calls.every((call) => call.method === "GET")).toBe(true);
  });

  it("reports an unknown id as a would-fail entry rather than throwing", async () => {
    const result = await run(["action", "--ids", "action-draft,nope", "--set", "energy=high", "--dry-run", "--json"]);
    const body = result.json as { wouldSucceed: unknown[]; wouldFail: { id: string; exitCode: number }[] };
    expect(body.wouldSucceed).toHaveLength(1);
    expect(body.wouldFail).toEqual([{ id: "nope", reason: "No such action.", exitCode: EXIT.notFound }]);
  });

  it("selects by a --targets file, honouring an explicit expectedVersion", async () => {
    const path = writeTempJson("targets.json", [{ id: "action-draft", expectedVersion: 7 }]);
    const posted: Record<string, unknown>[] = [];
    const result = await run(["action", "--targets", path, "--set", "energy=high", "--yes"], {
      "/api/commands/action": (call) => {
        posted.push(call.body as Record<string, unknown>);
        const raw = fixtureRawState();
        return { body: { state: raw } };
      }
    });
    expect(result.exitCode).toBe(EXIT.ok);
    expect(posted).toHaveLength(1);
    expect(posted[0]?.expectedVersion).toBe(7);
  });

  it("selects by --targets-json inline, defaulting expectedVersion from the current record", async () => {
    const raw = fixtureRawState();
    const posted: Record<string, unknown>[] = [];
    const result = await run(
      ["action", "--targets-json", JSON.stringify([{ id: "action-draft" }]), "--set", "energy=high", "--yes"],
      {
        "/api/commands/action": (call) => (posted.push(call.body as Record<string, unknown>), { body: { state: raw } })
      },
      raw
    );
    expect(result.exitCode).toBe(EXIT.ok);
    expect(posted[0]?.expectedVersion).toBeNull();
  });

  it("selects by list-style filters, including a date comparison in --where", async () => {
    // Only action-draft carries a deadlineAt in the fixture.
    const result = await run([
      "action",
      "--where",
      "deadlineAt<2026-09-15",
      "--set",
      "status=blocked",
      "--dry-run",
      "--json"
    ]);
    const body = result.json as { wouldSucceed: { id: string }[] };
    expect(body.wouldSucceed.map((row) => row.id)).toEqual(["action-draft"]);
  });

  it("selects by list-style filters, including a numeric comparison in --where", async () => {
    // action-draft has importance 5; the rest default to 3.
    const result = await run(["action", "--where", "importance>=4", "--set", "status=blocked", "--dry-run", "--json"]);
    const body = result.json as { wouldSucceed: { id: string }[] };
    expect(body.wouldSucceed.map((row) => row.id)).toEqual(["action-draft"]);
  });
});

describe("bulk: dry-run", () => {
  it("prints the before/after diff and sends nothing", async () => {
    const result = await run(["action", "--ids", "action-draft", "--set", "energy=high", "--dry-run", "--json"]);
    const body = result.json as {
      dryRun: boolean;
      wouldSucceed: { id: string; "energy before": string; "energy after": string }[];
    };
    expect(body.dryRun).toBe(true);
    expect(body.wouldSucceed).toHaveLength(1);
    expect(body.wouldSucceed[0]?.["energy before"]).toBe("medium");
    expect(body.wouldSucceed[0]?.["energy after"]).toBe("high");
    expect(result.calls.every((call) => call.method === "GET")).toBe(true);
  });

  it("still validates the patch and reports what would fail, without sending anything", async () => {
    const result = await run([
      "action",
      "--ids",
      "action-draft",
      "--set",
      "energy=not-a-real-energy",
      "--dry-run",
      "--json"
    ]);
    expect(result.exitCode).toBe(EXIT.validation);
    const body = result.json as { wouldSucceed: unknown[]; wouldFail: { id: string; exitCode: number }[] };
    expect(body.wouldSucceed).toHaveLength(0);
    expect(body.wouldFail[0]?.exitCode).toBe(EXIT.validation);
    expect(result.calls.every((call) => call.method === "GET")).toBe(true);
  });

  it("refuses a status the kind does not have, and a field it does not take, before selecting anything", async () => {
    const status = await run(["action", "--ids", "action-draft", "--set", "status=not-a-real-status", "--dry-run"]);
    expect(status.exitCode).toBe(EXIT.validation);
    expect(status.stderr).toContain("Use one of: inbox, planned");
    const field = await run(["action", "--ids", "action-draft", "--set", "colour=blue", "--dry-run"]);
    expect(field.exitCode).toBe(EXIT.validation);
    expect(field.stderr).toContain('has no field "colour"');
    const synonym = await run(["action", "--ids", "action-draft", "--set", "status=completed", "--dry-run", "--json"]);
    expect(synonym.exitCode).toBe(EXIT.ok);
    expect(JSON.stringify(synonym.json)).toContain("done");
  });
});

describe("bulk: --yes", () => {
  it("is required outside --dry-run", async () => {
    const result = await run(["action", "--ids", "action-draft", "--set", "energy=high"]);
    expect(result.exitCode).toBe(EXIT.usage);
    expect(result.stderr).toContain("Pass --yes");
    expect(result.calls.every((call) => call.method === "GET")).toBe(true);
  });
});

describe("bulk: execution", () => {
  it("reports a per-record version conflict as a failure while the rest still succeed", async () => {
    const raw = fixtureRawState();
    const result = await run(
      ["action", "--ids", "action-draft,action-cite", "--set", "energy=high", "--yes", "--json"],
      {
        "/api/commands/action": (call) => {
          const body = call.body as { action: { id: string } };
          if (body.action.id === "action-draft")
            return { status: 409, body: { error: "This record changed elsewhere. Reload before saving." } };
          const actions = (raw.actions as Record<string, unknown>[]).map((action) =>
            action.id === body.action.id ? { ...action, ...body.action, version: 1 } : action
          );
          return { body: { state: { ...raw, actions } } };
        }
      },
      raw
    );
    expect(result.exitCode).toBe(EXIT.conflict);
    const body = result.json as {
      succeeded: number;
      failed: number;
      results: { id: string; ok: boolean; exitCode: number }[];
    };
    expect(body.succeeded).toBe(1);
    expect(body.failed).toBe(1);
    expect(body.results).toHaveLength(1);
    expect(body.results[0]).toMatchObject({ id: "action-draft", ok: false, exitCode: EXIT.conflict });
  });

  it("--verbose lists every result, not only the failures", async () => {
    const raw = fixtureRawState();
    const result = await run(
      ["action", "--ids", "action-draft,action-cite", "--set", "energy=high", "--yes", "--json", "--verbose"],
      { "/api/commands/action": okActionRoute(raw) },
      raw
    );
    const body = result.json as { results: { id: string }[] };
    expect(body.results).toHaveLength(2);
  });

  it("--stop-on-error halts before writing the remaining records", async () => {
    const raw = fixtureRawState();
    const attempted: string[] = [];
    const result = await run(
      [
        "action",
        "--ids",
        "action-draft,action-cite,action-weed",
        "--set",
        "energy=high",
        "--yes",
        "--json",
        "--concurrency",
        "1",
        "--stop-on-error"
      ],
      {
        "/api/commands/action": (call) => {
          const body = call.body as { action: { id: string } };
          attempted.push(body.action.id);
          if (body.action.id === "action-draft") return { status: 409, body: { error: "conflict" } };
          const actions = (raw.actions as Record<string, unknown>[]).map((action) =>
            action.id === body.action.id ? { ...action, ...body.action, version: 1 } : action
          );
          return { body: { state: { ...raw, actions } } };
        }
      },
      raw
    );
    expect(attempted).toEqual(["action-draft"]);
    const body = result.json as { succeeded: number; failed: number; skipped: number };
    expect(body.succeeded).toBe(0);
    expect(body.failed).toBe(1);
    expect(body.skipped).toBe(2);
    expect(result.exitCode).toBe(EXIT.conflict);
  });

  it("prints the compact summary and a failures table in table mode", async () => {
    const raw = fixtureRawState();
    const result = await run(
      ["action", "--ids", "action-draft,action-cite", "--set", "energy=high", "--yes"],
      {
        "/api/commands/action": (call) => {
          const body = call.body as { action: { id: string } };
          if (body.action.id === "action-draft")
            return { status: 409, body: { error: "This record changed elsewhere." } };
          const actions = (raw.actions as Record<string, unknown>[]).map((action) =>
            action.id === body.action.id ? { ...action, ...body.action, version: 1 } : action
          );
          return { body: { state: { ...raw, actions } } };
        }
      },
      raw
    );
    expect(result.stdout).toContain("1 succeeded, 1 failed");
    expect(result.stdout).toContain("action-draft");
    expect(result.stdout).toContain("conflict");
  });

  it("refuses a --status the entity never carries, as list does", async () => {
    const result = await run(["action", "--status", "does-not-exist-anymore", "--set", "energy=high", "--yes"]);
    expect(result.exitCode).toBe(EXIT.usage);
    expect(result.stderr).toContain('Unknown action status "does-not-exist-anymore"');
  });

  it("re-running the same selector after a full success finds nothing left to do", async () => {
    const raw = fixtureRawState();
    const result = await run(
      ["action", "--status", "archived", "--set", "energy=high", "--yes", "--json"],
      { "/api/commands/action": okActionRoute(raw) },
      raw
    );
    expect(result.exitCode).toBe(EXIT.ok);
    const body = result.json as { succeeded: number; failed: number };
    expect(body.succeeded).toBe(0);
    expect(body.failed).toBe(0);
  });
});

/**
 * A stand-in for the portal's action route that keeps state: every action carries a version, a save whose
 * `expectedVersion` is not the stored one is refused with a 409 (like the real handler), and every applied
 * save bumps the version. Lets a test edit a record "elsewhere" between a bulk and its undo.
 */
function versionedActions(failIds: string[] = []) {
  const raw = fixtureRawState();
  raw.actions = (raw.actions as Record<string, unknown>[]).map((action) => ({ ...action, version: 3 }));
  const actions = () => raw.actions as Record<string, unknown>[];
  const find = (id: string) => actions().find((action) => action.id === id)!;
  return {
    raw,
    find,
    /** Someone else edits the action: its version moves on. */
    edit(id: string, fields: Record<string, unknown>) {
      Object.assign(find(id), fields, { version: (find(id).version as number) + 1 });
    },
    routes: {
      "/api/commands/action": (call: { body: unknown }) => {
        const body = call.body as { action: Record<string, unknown>; expectedVersion: number | null };
        const stored = find(String(body.action.id));
        if (failIds.includes(String(body.action.id)))
          return { status: 409, body: { error: "This record changed elsewhere. Reload before saving." } };
        if (body.expectedVersion !== stored.version)
          return { status: 409, body: { error: "This record changed elsewhere. Reload before saving." } };
        Object.assign(stored, body.action, { version: (stored.version as number) + 1 });
        return { body: { state: raw } };
      }
    }
  };
}

describe("bulk: undo journal", () => {
  const ids = "action-draft,action-cite,action-weed";
  const serial = ["--yes", "--concurrency", "1"];

  it("journals one entry per applied row, the same as `save` journals the same edit", async () => {
    const portal = versionedActions();
    const journal = memoryJournal();
    const result = await run(
      ["action", "--ids", ids, "--set", "energy=high", ...serial],
      portal.routes,
      portal.raw,
      journal
    );
    expect(result.exitCode).toBe(EXIT.ok);
    const entries = journal.read();
    expect(entries).toHaveLength(3);
    for (const entry of entries) expect(entry.label).toMatch(/^bulk action: .+/);
    expect(entries.map((entry) => entry.target.id)).toEqual(["action-draft", "action-cite", "action-weed"]);
    const cite = entries.find((entry) => entry.target.id === "action-cite")!;
    expect(cite.status).toBe("applied");
    expect(cite.undo.path).toBe("/api/commands/action");
    expect(cite.redo.payload).toMatchObject({ expectedVersion: 3, action: { id: "action-cite", energy: "high" } });

    const savePortal = versionedActions();
    const saveJournal = memoryJournal();
    const saved = await runCli(["save", "action", "--id", "action-cite", "--set", "energy=high"], {
      stdout: () => undefined,
      stderr: () => undefined,
      env: {},
      readConfigFile: () => null,
      now: () => fixtureNow,
      journal: saveJournal,
      fetchImpl: fakeFetch({ "/api/state": { body: { state: savePortal.raw } }, ...savePortal.routes }, [])
    });
    expect(saved).toBe(EXIT.ok);
    const savedEntry = saveJournal.read()[0]!;
    const withoutCommandId = (payload: Record<string, unknown>) => ({ ...payload, commandId: undefined });
    expect(withoutCommandId(cite.undo.payload)).toEqual(withoutCommandId(savedEntry.undo.payload));
    expect(cite.target).toEqual(savedEntry.target);
    expect(cite.version).toBe(savedEntry.version);
    expect(cite.version).toBe(4);
  });

  it("journals one server-checked entry per command id when the portal kept rows for each row", async () => {
    const portal = versionedActions();
    const journal = memoryJournal();
    const inner = portal.routes["/api/commands/action"] as (call: RecordedCall) => { body: Record<string, unknown> };
    const result = await run(
      ["action", "--ids", ids, "--set", "energy=high", ...serial],
      {
        ...portal.routes,
        "/api/commands/action": (call: RecordedCall) => {
          const answer = inner(call);
          return { body: { ...answer.body, revertible: (call.body as { commandId: string }).commandId } };
        }
      },
      portal.raw,
      journal
    );
    expect(result.exitCode).toBe(EXIT.ok);
    const sent = result.calls
      .filter((call) => call.method === "POST")
      .map((call) => (call.body as { commandId: string }).commandId);
    expect(new Set(sent).size).toBe(3);
    const entries = journal.read();
    expect(entries.map((entry) => entry.target.id)).toEqual(sent);
    for (const entry of entries) expect(entry).toMatchObject({ serverChecked: true, status: "applied" });
    expect(result.stderr).not.toContain("undo with");
  });

  it("undo reverts the newest row only; three undos revert all three, each version-checked", async () => {
    const portal = versionedActions();
    const journal = memoryJournal();
    const original = new Map(["action-draft", "action-cite", "action-weed"].map((id) => [id, portal.find(id).energy]));
    await run(["action", "--ids", ids, "--set", "energy=high", ...serial], portal.routes, portal.raw, journal);

    const first = await run(["undo"], portal.routes, portal.raw, journal);
    expect(first.exitCode).toBe(EXIT.ok);
    const posted = first.calls.filter((call) => call.method === "POST");
    expect(posted).toHaveLength(1);
    expect(posted[0]?.body).toMatchObject({ expectedVersion: 4, action: { id: "action-weed" } });
    expect(portal.find("action-weed").energy).toBe(original.get("action-weed"));
    expect(portal.find("action-cite").energy).toBe("high");
    expect(portal.find("action-draft").energy).toBe("high");

    expect((await run(["undo"], portal.routes, portal.raw, journal)).exitCode).toBe(EXIT.ok);
    expect((await run(["undo"], portal.routes, portal.raw, journal)).exitCode).toBe(EXIT.ok);
    for (const [id, energy] of original) expect(portal.find(id).energy).toBe(energy);
    expect(journal.read().every((entry) => entry.status === "undone")).toBe(true);
  });

  it("refuses the undo of a row that was edited after the bulk", async () => {
    const portal = versionedActions();
    const journal = memoryJournal();
    await run(
      ["action", "--ids", "action-draft,action-cite", "--set", "energy=high", ...serial],
      portal.routes,
      portal.raw,
      journal
    );
    portal.edit("action-cite", { title: "Edited elsewhere" });
    const refused = await run(["undo"], portal.routes, portal.raw, journal);
    expect(refused.exitCode).toBe(EXIT.conflict);
    expect(refused.stderr).toContain("changed since");
    expect(portal.find("action-cite").title).toBe("Edited elsewhere");
    expect(portal.find("action-cite").energy).toBe("high");
  });

  it("journals nothing for rows that fail", async () => {
    const portal = versionedActions(["action-cite"]);
    const journal = memoryJournal();
    const result = await run(
      ["action", "--ids", "action-draft,action-cite,nope", "--set", "energy=high", ...serial],
      portal.routes,
      portal.raw,
      journal
    );
    expect(result.exitCode).toBe(EXIT.notFound);
    expect(journal.read().map((entry) => entry.target.id)).toEqual(["action-draft"]);

    // A patch that fails validation never reaches the portal.
    const invalid = memoryJournal();
    const rejected = await run(
      ["action", "--ids", ids, "--set", "status=not-a-real-status", "--yes"],
      portal.routes,
      portal.raw,
      invalid
    );
    expect(rejected.exitCode).toBe(EXIT.validation);
    expect(invalid.read()).toEqual([]);
  });

  it("journals nothing on a dry run", async () => {
    const portal = versionedActions();
    const journal = memoryJournal();
    const result = await run(
      ["action", "--ids", ids, "--set", "energy=high", "--dry-run"],
      portal.routes,
      portal.raw,
      journal
    );
    expect(result.exitCode).toBe(EXIT.ok);
    expect(journal.read()).toEqual([]);
  });

  it("journals nothing for a row the portal held as a proposal", async () => {
    const portal = versionedActions();
    const journal = memoryJournal();
    const result = await run(
      ["action", "--ids", "action-draft", "--set", "energy=high", "--yes"],
      { "/api/commands/action": { status: 202, body: { proposal: { id: "proposal-2", status: "pending" } } } },
      portal.raw,
      journal
    );
    expect(result.exitCode).toBe(EXIT.ok);
    expect(journal.read()).toEqual([]);
  });

  it("journals nothing when more than 20 rows are filed as one batch proposal", async () => {
    const portal = versionedActions();
    const journal = memoryJournal();
    const template = portal.find("action-draft");
    const many = Array.from({ length: 21 }, (_, index) => ({ ...template, id: `action-bulk-${index}` }));
    portal.raw.actions = [...(portal.raw.actions as unknown[]), ...many];
    const calls: RecordedCall[] = [];
    const errors: string[] = [];
    const exitCode = await runCli(
      ["bulk", "action", "--ids", many.map((row) => row.id).join(","), "--set", "energy=high", "--yes"],
      {
        stdout: () => undefined,
        stderr: (text) => errors.push(text),
        env: { OPENRHEN_TOKEN: "pri_test" },
        readConfigFile: () => null,
        now: () => fixtureNow,
        journal,
        fetchImpl: fakeFetch(
          {
            "/api/state": { body: { state: portal.raw } },
            "/api/agent-proposals": { status: 202, body: { proposal: { id: "proposal-1", status: "pending" } } }
          },
          calls
        )
      }
    );
    expect(exitCode).toBe(EXIT.ok);
    expect(calls.some((call) => call.path === "/api/agent-proposals")).toBe(true);
    expect(calls.some((call) => call.path === "/api/commands/action")).toBe(false);
    expect(journal.read()).toEqual([]);
    // The agent is told where the batch waits, and the summary names the field the person is asked to approve.
    expect(errors.join("\n")).toContain("so it goes to the owner as one proposal (Inbox > Captured > From agents)");
    expect(calls.find((call) => call.path === "/api/agent-proposals")).toMatchObject({
      body: { summary: "Bulk action: update 21 records (energy)" }
    });
  });
});

describe("bulk: MCP", () => {
  async function sendMcp(lines: string[], routes: Parameters<typeof fakeFetch>[0] = {}, rawState = fixtureRawState()) {
    const calls: RecordedCall[] = [];
    const fetchImpl = fakeFetch({ "/api/state": { body: { state: rawState } }, ...routes }, calls);
    const written: string[] = [];
    await serveMcp({
      input: lines,
      write: (line) => written.push(line),
      runner: (argv, capture) =>
        runCli(argv, { ...capture, env: {}, fetchImpl, now: () => fixtureNow, readConfigFile: () => null })
    });
    return { calls, parsed: written.map((line) => JSON.parse(line) as { result?: unknown; error?: unknown }) };
  }

  it("lists rhen_bulk with mutates:true (WRITES DATA prefix) and useful array/inline-JSON fields", async () => {
    expect(commands.some((spec) => spec.name === "bulk" && spec.mutates)).toBe(true);
    const { parsed } = await sendMcp([JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })]);
    const result = parsed[0]?.result as {
      tools: { name: string; description: string; inputSchema: Record<string, unknown> }[];
    };
    const tool = result.tools.find((candidate) => candidate.name === "rhen_bulk");
    expect(tool).toBeDefined();
    expect(tool?.description.startsWith("WRITES DATA. ")).toBe(true);
    const properties = (tool?.inputSchema.properties ?? {}) as Record<
      string,
      { type: string; items?: { type: string } }
    >;
    expect(properties.where).toEqual({ type: "array", items: { type: "string" }, description: expect.any(String) });
    expect(properties.ids?.type).toBe("string");
    expect(properties["targets-json"]).toEqual({
      type: "array",
      items: { type: "object" },
      description: expect.any(String)
    });
    expect(properties["dry-run"]?.type).toBe("boolean");
  });

  it("rhen_bulk over MCP runs in JSON mode and returns the compact result", async () => {
    const raw = fixtureRawState();
    const { parsed } = await sendMcp(
      [
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "rhen_bulk",
            arguments: { entity: "action", ids: "action-draft", set: ["energy=high"], "dry-run": true }
          }
        })
      ],
      {},
      raw
    );
    const result = parsed[0]?.result as { isError: boolean; content: { type: string; text: string }[] };
    expect(result.isError).toBe(false);
    const body = JSON.parse(result.content[0]?.text ?? "") as { dryRun: boolean; count: number };
    expect(body.dryRun).toBe(true);
    expect(body.count).toBe(1);
  });
});

describe("bulk: assumed fields", () => {
  it("drops a field the patch names from each action's assumed list and keeps the rest", async () => {
    const raw = fixtureRawState();
    raw.actions = (raw.actions as Record<string, unknown>[]).map((item) =>
      item.id === "action-draft" || item.id === "action-cite"
        ? { ...item, assumedFields: ["expectedMinutes", "energy"] }
        : item
    );
    const posted: { id: unknown; assumedFields: unknown }[] = [];
    const route = okActionRoute(raw);
    const result = await run(
      ["action", "--ids", "action-draft,action-cite", "--set", "energy=high", "--yes"],
      {
        "/api/commands/action": (call) => {
          const action = (call.body as { action: Record<string, unknown> }).action;
          posted.push({ id: action.id, assumedFields: action.assumedFields });
          return route(call);
        }
      },
      raw
    );
    expect(result.exitCode).toBe(EXIT.ok);
    expect(posted).toEqual([
      { id: "action-draft", assumedFields: ["expectedMinutes"] },
      { id: "action-cite", assumedFields: ["expectedMinutes"] }
    ]);
  });
});
