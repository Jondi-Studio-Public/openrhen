import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCliWithAgentJournal, type JournalStore } from "./agent-journal-runner";
import type { AgentPrincipal } from "./agent-tokens";
import { fakeJournalStore, fakeWorld, serverCheckedEntry } from "./mcp-test-support";

const principal = (name = "companion"): AgentPrincipal => ({
  name,
  source: "db",
  tokenId: "t1",
  scopes: ["read:plan", "write:entity", "write:undo"],
  directWrites: { area: "on" }
});
const inbound = () => new Request("https://portal.test/mcp", { method: "POST", headers: { host: "portal.test" } });
const rename = (name: string) => ["save", `--set=name=${name}`, "--id=a1", "--json", "--", "area"];

beforeEach(() => {
  // The default host allowlist is closed: admit the host these tests send.
  vi.stubEnv("PORTAL_PUBLIC_URL", "https://portal.test");
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function run(
  world: Awaited<ReturnType<typeof fakeWorld>>,
  store: JournalStore | null,
  argv: string[],
  agent = "companion"
) {
  return runCliWithAgentJournal({
    argv,
    actor: { kind: "agent", principal: principal(agent) },
    inbound: inbound(),
    loadRoute: world.loadRoute,
    agent,
    store
  });
}

describe("the agent's undo journal on /mcp", () => {
  it("undoes the agent's newest ledger entry by posting its write to the revert route, and saves nothing", async () => {
    const world = await fakeWorld();
    const { store, rows, calls } = fakeJournalStore();
    rows.set("companion", [serverCheckedEntry("w1")]);
    const undone = await run(world, store, ["undo", "--json"]);
    expect(undone.exitCode).toBe(0);
    expect(calls.loads).toBe(1);
    expect(world.reverts).toHaveLength(1);
    expect(world.reverts[0]!.actor).toBe("companion");
    expect(world.reverts[0]!.body).toMatchObject({ target: "w1", direction: "undo" });
    // The ledger is the record: the run's journal edits are not stored anywhere.
    expect(rows.get("companion")![0]!.status).toBe("applied");
  });

  it("lists the ledger entries without sending anything", async () => {
    const world = await fakeWorld();
    const { store, rows, calls } = fakeJournalStore();
    rows.set("companion", [serverCheckedEntry("w1")]);
    const listed = await run(world, store, ["undo", "--list", "--json"]);
    expect(listed.exitCode).toBe(0);
    expect(listed.stdout.join("\n")).toContain("w1");
    expect(calls.loads).toBe(1);
    expect(world.reverts).toHaveLength(0);
  });

  it("keeps each agent's journal apart: one agent cannot undo another's write", async () => {
    const world = await fakeWorld();
    const { store, rows } = fakeJournalStore();
    rows.set("companion", [serverCheckedEntry("w1")]);
    const other = await run(world, store, ["undo", "--json"], "openclaw");
    expect(other.exitCode).toBe(4);
    expect(world.reverts).toHaveLength(0);
  });

  it("relays the portal's refusal to revert, leaving the record alone", async () => {
    const world = await fakeWorld();
    const { store, rows } = fakeJournalStore();
    rows.set("companion", [serverCheckedEntry("w1")]);
    world.revertRefusal.status = 409;
    const undone = await run(world, store, ["undo", "--json"]);
    expect(undone.exitCode).toBe(3);
    expect(world.area.name).toBe("Old");
  });

  it("lands a write without adding to the journal it loaded: its entry comes from the ledger on the next call", async () => {
    const world = await fakeWorld();
    const { store, rows, calls } = fakeJournalStore();
    const written = await run(world, store, rename("New"));
    expect(written.exitCode).toBe(0);
    expect(world.area.name).toBe("New");
    expect(calls.loads).toBe(1);
    expect(rows.has("companion")).toBe(false);
    // The fake route answers without `revertible`, so nothing promises an undo that the next call could not find.
    expect(written.stderr.join("\n")).not.toContain("rhen undo");
    // This store has no ledger behind it, so the next call finds nothing to undo.
    expect((await run(world, store, ["undo", "--json"])).exitCode).toBe(4);
  });

  it("runs on without a database: the write lands, the undo has nothing to find", async () => {
    const world = await fakeWorld();
    expect((await run(world, null, rename("New"))).exitCode).toBe(0);
    expect(world.area.name).toBe("New");
    const undone = await run(world, null, ["undo", "--json"]);
    expect(undone.exitCode).toBe(4);
    expect(world.area.name).toBe("New");
  });

  it("refuses a write when the journal cannot be read: nothing changes, and the answer says to try again", async () => {
    const world = await fakeWorld();
    const broken: JournalStore = {
      load: async () => {
        throw new Error("relation does not exist");
      }
    };
    const refused = await run(world, broken, rename("New"));
    expect(refused.exitCode).not.toBe(0);
    expect(refused.failed).toBe(true);
    expect(refused.retryMessage).toBe("The undo record could not be read; nothing was changed. Try again.");
    expect(world.posts).toHaveLength(0);
    expect(world.area.name).toBe("Old");
    // undo needs the journal too.
    expect((await run(world, broken, ["undo", "--json"])).failed).toBe(true);
  });

  it("never loads the journal for a read-only command, even when the journal is unreadable", async () => {
    const world = await fakeWorld();
    const { store, calls } = fakeJournalStore();
    const read = await run(world, store, ["list", "--json", "--", "area"]);
    expect(read.exitCode).toBe(0);
    expect(calls.loads).toBe(0);
    const broken: JournalStore = {
      load: async () => {
        throw new Error("down");
      }
    };
    expect((await run(world, broken, ["list", "--json", "--", "area"])).exitCode).toBe(0);
  });
});
