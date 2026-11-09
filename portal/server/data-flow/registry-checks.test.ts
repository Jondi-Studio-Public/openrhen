import { describe, expect, it } from "vitest";
import type { DatasetNote, FlowEntry } from "@openrhen/contracts/data-flow";
import {
  checkE1,
  checkS1,
  checkS2,
  checkS3,
  checkS4,
  checkS5,
  checkS6,
  checkS7,
  checkS8,
  checkShape,
  checkX1,
  checkX2,
  type CheckEnv
} from "./registry-checks";

const none = { kind: "none", reason: "fixture" } as const;

function entry(partial: Partial<FlowEntry> & Pick<FlowEntry, "id">): FlowEntry {
  return {
    name: partial.id,
    role: "source",
    category: "files",
    method: "push",
    trigger: { kind: "none" },
    code: {},
    from: [],
    to: [],
    health: none,
    ...partial
  };
}

const env: CheckEnv = {
  tables: new Set(["notes", "activity_events", "agent_tokens", "user_preferences", "watch_imports"]),
  columns: new Map([
    ["notes", new Set(["id", "created_at", "kind", "active"])],
    ["agent_tokens", new Set(["last_used_at", "name"])],
    ["user_preferences", new Set(["settings"])]
  ]),
  pathKind: (path) =>
    (
      ({
        "a/file.ts": "file",
        "integrations/x/src/sub/": "dir",
        "other/dir/": "dir",
        "portal/app/review/page.tsx": "file"
      }) as Record<string, "file" | "dir">
    )[path] ?? null,
  routes: new Map([
    ["/api/notes", ["GET", "POST"]],
    ["/api/device/now", ["GET"]]
  ]),
  loops: new Set(["tick"]),
  connections: new Set(["calendar-x"]),
  syncProviders: new Set(["calendar-x"]),
  mcpTools: new Set(["rhen_notes"]),
  activitySources: { alpha: { kinds: ["one", "two"] } }
};

describe("shape", () => {
  it("reports an entry the schema refuses", () => {
    expect(checkShape([entry({ id: "ok" })])).toEqual([]);
    expect(checkShape([{ ...entry({ id: "bad" }), status: "x" } as unknown as FlowEntry])[0]).toMatch(/^bad: /);
  });
});

describe("S1 paths", () => {
  it("passes existing files and allowed directories, fails missing, odd directories and code on planned entries", () => {
    expect(checkS1([entry({ id: "a", code: { paths: ["a/file.ts", "integrations/x/src/sub/"] } })], env)).toEqual([]);
    expect(checkS1([entry({ id: "a", code: { paths: ["a/missing.ts"] } })], env)).toEqual([
      "a: code.paths a/missing.ts does not exist"
    ]);
    expect(checkS1([entry({ id: "a", code: { paths: ["other/dir/"] } })], env)[0]).toMatch(/directory/);
    const planned = entry({
      id: "p",
      planned: { landsAs: { table: "t" } },
      code: { paths: ["a/file.ts"], external: ["x:y"] }
    });
    expect(checkS1([planned], env)).toEqual(["p: a planned entry has code.paths; only code.external is allowed"]);
  });
});

describe("S2 routes", () => {
  it("needs an exact route that exports the method", () => {
    expect(checkS2([entry({ id: "a", code: { routes: ["POST /api/notes"] } })], env)).toEqual([]);
    expect(checkS2([entry({ id: "a", code: { routes: ["DELETE /api/notes"] } })], env)[0]).toMatch(
      /does not export DELETE/
    );
    expect(checkS2([entry({ id: "a", code: { routes: ["GET /api/nope"] } })], env)[0]).toMatch(/no such route/);
    expect(checkS2([entry({ id: "a", code: { routes: ["GET /api/*"] } })], env)[0]).toMatch(/wildcard/);
    expect(checkS2([entry({ id: "a", code: { routes: ["/api/notes"] } })], env)[0]).toMatch(/METHOD/);
  });
});

describe("S3 loops", () => {
  it("needs each loop to be a worker or service loop", () => {
    expect(
      checkS3([entry({ id: "a", code: { loops: ["tick"] }, trigger: { kind: "loop", loop: "tick" } })], env)
    ).toEqual([]);
    expect(checkS3([entry({ id: "a", code: { loops: ["gone"] } })], env)).toEqual([
      "a: code.loops gone is not a known loop"
    ]);
    expect(checkS3([entry({ id: "a", trigger: { kind: "loop", loop: "gone" } })], env)).toEqual([
      "a: trigger loop gone is not a known loop"
    ]);
  });
});

describe("S4 references", () => {
  const pipe = entry({ id: "pipe", role: "pipe" });
  it("passes known references and fails each unknown kind", () => {
    const good = entry({
      id: "a",
      connection: "calendar-x",
      syncProvider: "calendar-x",
      activitySource: "alpha",
      via: ["pipe"],
      feeds: ["pipe"],
      code: { mcpTools: ["rhen_notes"] }
    });
    expect(checkS4([good, pipe], env)).toEqual([]);
    expect(checkS4([entry({ id: "a", connection: "nope" })], env)).toEqual(["a: connection nope is not registered"]);
    expect(checkS4([entry({ id: "a", syncProvider: "nope" })], env)).toEqual(["a: syncProvider nope is not known"]);
    expect(checkS4([entry({ id: "a", activitySource: "nope" })], env)).toEqual([
      "a: activitySource nope is not registered"
    ]);
    expect(checkS4([entry({ id: "a", code: { mcpTools: ["nope"] } })], env)).toEqual([
      "a: mcp tool nope is not in the manifest"
    ]);
    expect(checkS4([entry({ id: "a", via: ["ghost"] })], env)).toEqual(["a: via ghost is not an entry"]);
    expect(checkS4([entry({ id: "a", via: ["b"] }), entry({ id: "b" })], env)).toEqual(["a: via b is not a pipe"]);
    expect(checkS4([entry({ id: "a", feeds: ["ghost"] })], env)).toEqual(["a: feeds ghost is not an entry"]);
  });
  it("does not check the activity source of a planned entry", () => {
    expect(
      checkS4([entry({ id: "p", activitySource: "later", planned: { landsAs: { activitySource: "later" } } })], env)
    ).toEqual([]);
  });
});

describe("S5 datasets", () => {
  const notes: DatasetNote[] = [{ ref: "pg:mail.messages", columns: ["id"] }];
  it("passes known tables, note tables and valid partitions", () => {
    const good = entry({
      id: "a",
      from: ["pg:notes", "pg:mail.messages"],
      to: [
        "pg:activity_events[source=alpha,kind=one]",
        "pg:activity_events[source=alpha,kind=correction]",
        "pg:activity_events[source=*]"
      ]
    });
    expect(checkS5([good], notes, env)).toEqual([]);
  });
  it("fails an unknown table, source, kind, filter key and a kind without a source", () => {
    const run = (ref: string) => checkS5([entry({ id: "a", to: [ref as never] })], notes, env);
    expect(run("pg:nope")).toEqual(["a: pg:nope is not a known table"]);
    expect(run("pg:activity_events[source=zzz]")).toEqual([
      "a: pg:activity_events[source=zzz] names an unregistered activity source"
    ]);
    expect(run("pg:activity_events[source=alpha,kind=three]")).toEqual([
      "a: pg:activity_events[source=alpha,kind=three] names a kind alpha does not take"
    ]);
    expect(run("pg:activity_events[kind=one]")).toEqual([
      "a: pg:activity_events[kind=one] filters on kind without a source"
    ]);
    expect(run("pg:notes[source=alpha]")).toEqual([
      "a: pg:notes[source=alpha] is a partition of a table that has none"
    ]);
    expect(run("pg:activity_events[colour=red]")).toEqual([
      "a: pg:activity_events[colour=red] filters on colour, which is not source or kind"
    ]);
  });
  it("checks incidental writes, notRead and dataset notes too", () => {
    expect(checkS5([entry({ id: "a", incidentalWrites: [{ table: "nope", reason: "r" }] })], [], env)).toEqual([
      "a: incidentalWrites table nope is not a known table"
    ]);
    expect(checkS5([entry({ id: "a", notRead: [{ table: "nope", reason: "r" }] })], [], env)).toEqual([
      "a: notRead table nope is not a known table"
    ]);
    expect(checkS5([], [{ ref: "pg:gone" }], env)).toEqual(["dataset note pg:gone is not a known table"]);
  });
});

describe("S6 amend", () => {
  it("fails an amend key that is not a core entry id", () => {
    expect(checkS6(["a"], new Set(["a", "b"]))).toEqual([]);
    expect(checkS6(["a", "zzz"], new Set(["a"]))).toEqual(["amend zzz is not a core entry id"]);
  });
});

describe("S7 probes", () => {
  const notes: DatasetNote[] = [{ ref: "pg:mail.messages", columns: ["stored_at"] }];
  const probe = (health: FlowEntry["health"]) => checkS7([entry({ id: "a", health })], notes, env);
  it("passes probes over known tables, columns and where keys", () => {
    expect(probe({ kind: "max", table: "notes", column: "created_at", where: { kind: "x", active: true } })).toEqual(
      []
    );
    expect(probe({ kind: "max", table: "mail.messages", column: "stored_at" })).toEqual([]);
    expect(probe({ kind: "last-used", table: "agent_tokens", tokenName: "any" })).toEqual([]);
    expect(probe({ kind: "json-stamp", table: "user_preferences", column: "settings", path: ["a"] })).toEqual([]);
    expect(probe({ kind: "activity", source: "alpha" })).toEqual([]);
  });
  it("fails an unknown table, column, where key and activity source, including inside a lag probe", () => {
    expect(probe({ kind: "max", table: "nope", column: "x" })).toEqual(["a: probe table nope is not a known table"]);
    expect(probe({ kind: "max", table: "notes", column: "nope" })).toEqual([
      "a: probe column notes.nope does not exist"
    ]);
    expect(probe({ kind: "max", table: "notes", column: "created_at", where: { nope: "x" } })).toEqual([
      "a: probe where key notes.nope does not exist"
    ]);
    expect(probe({ kind: "json-stamp", table: "user_preferences", column: "nope", path: [] })).toEqual([
      "a: probe column user_preferences.nope does not exist"
    ]);
    expect(probe({ kind: "activity", source: "nope" })).toEqual(["a: probe activity source nope is not registered"]);
    const lag = {
      kind: "lag",
      upstream: { kind: "max", table: "notes", column: "nope" },
      downstream: none,
      allowHours: 1
    } as const;
    expect(probe(lag)).toEqual(["a: probe column notes.nope does not exist"]);
  });
});

describe("S8 surfaces", () => {
  const surface = (ref: string) => checkS8([entry({ id: "a", role: "reader", to: [ref as never] })], env);
  it("passes a page that exists, an engine, a push, a tool, a device route and a connection", () => {
    for (const ref of [
      "surface:page/review",
      "surface:engine",
      "surface:push",
      "surface:tool/rhen_notes",
      "surface:device/api/device/now",
      "surface:external/calendar-x",
      "surface:rest"
    ])
      expect(surface(ref), ref).toEqual([]);
  });
  it("fails a missing page, tool, route, connection and a malformed surface", () => {
    expect(surface("surface:page/missing")).toEqual(["a: surface:page/missing has no portal/app/missing/page.tsx"]);
    expect(surface("surface:tool/nope")).toEqual(["a: surface:tool/nope is not an MCP tool"]);
    expect(surface("surface:device/api/nope")).toEqual(["a: surface:device/api/nope is not a route"]);
    expect(surface("surface:external/nope")).toEqual(["a: surface:external/nope is not a connection"]);
    expect(surface("surface:nowhere")).toEqual(["a: surface:nowhere is not a surface"]);
  });
});

describe("X1 ids", () => {
  it("needs unique kebab-case ids, a reason on a probe-less reader, planned entries with no probe and registered overlay files", () => {
    expect(checkX1([entry({ id: "a-b" }), entry({ id: "c" })], { overlayFiles: [], extensionIds: [] })).toEqual([]);
    expect(checkX1([entry({ id: "a" }), entry({ id: "a" })], { overlayFiles: [], extensionIds: [] })).toEqual([
      "a: id is used twice"
    ]);
    expect(checkX1([entry({ id: "A_b" })], { overlayFiles: [], extensionIds: [] })).toEqual([
      "A_b: id is not kebab-case"
    ]);
    expect(
      checkX1([entry({ id: "r", role: "reader", health: { kind: "none", reason: " " } })], {
        overlayFiles: [],
        extensionIds: []
      })
    ).toEqual(["r: a reader with no probe needs a reason"]);
    expect(
      checkX1(
        [
          entry({
            id: "p",
            planned: { landsAs: { table: "t" } },
            health: { kind: "max", table: "notes", column: "id" }
          })
        ],
        { overlayFiles: [], extensionIds: [] }
      )
    ).toEqual(["p: a planned entry must have health none"]);
    expect(checkX1([], { overlayFiles: ["data-flow-gmail.ts"], extensionIds: [] })).toEqual([
      "data-flow-gmail.ts: no extension registered with id data-flow-gmail"
    ]);
    expect(checkX1([], { overlayFiles: ["data-flow-gmail.ts"], extensionIds: ["data-flow-gmail"] })).toEqual([]);
  });
});

describe("X2 text caps", () => {
  it("fails each free-text field over its cap", () => {
    const long = (n: number) => "x".repeat(n);
    expect(
      checkX2(
        [entry({ id: "a", name: long(60), gives: long(80), value: { note: long(80), potential: long(120) } })],
        []
      )
    ).toEqual([]);
    expect(checkX2([entry({ id: "a", name: long(61) })], [])).toEqual(["a: name is 61 characters; the cap is 60"]);
    expect(checkX2([entry({ id: "a", gives: long(81) })], [])).toEqual(["a: gives is 81 characters; the cap is 80"]);
    expect(checkX2([entry({ id: "a", value: { note: long(81) } })], [])).toEqual([
      "a: value.note is 81 characters; the cap is 80"
    ]);
    expect(checkX2([entry({ id: "a", value: { potential: long(121) } })], [])).toEqual([
      "a: value.potential is 121 characters; the cap is 120"
    ]);
    expect(checkX2([entry({ id: "a", incidentalWrites: [{ table: "t", reason: long(121) }] })], [])).toEqual([
      "a: incidentalWrites reason is 121 characters; the cap is 120"
    ]);
    expect(checkX2([entry({ id: "a", health: { kind: "none", reason: long(121) } })], [])).toEqual([
      "a: health.none reason is 121 characters; the cap is 120"
    ]);
    expect(checkX2([], [{ ref: "pg:t", label: long(121), dead: long(121), infrastructure: long(121) }])).toHaveLength(
      3
    );
  });
});

describe("E1 engine input", () => {
  const planInput = ["actions", "commitments", "daily_plan_desired_actions"];
  const engine = (from: string[], notRead: string[]) =>
    entry({
      id: "engine",
      role: "reader",
      from: from.map((t) => `pg:${t}` as const),
      to: ["surface:engine"],
      notRead: notRead.map((table) => ({ table, reason: "r" }))
    });
  it("passes when from is the list minus notRead", () => {
    expect(
      checkE1([engine(["actions", "commitments"], ["daily_plan_desired_actions"])], planInput, ["offer_log"])
    ).toEqual([]);
  });
  it("fails a missing table, an extra table, a notRead outside the list, no engine reader and a blind table in the list", () => {
    expect(checkE1([engine(["actions"], ["daily_plan_desired_actions"])], planInput, [])).toEqual([
      "engine: engine reader does not read commitments, which is a plan input and not in notRead"
    ]);
    expect(
      checkE1([engine(["actions", "commitments", "users"], ["daily_plan_desired_actions"])], planInput, [])
    ).toEqual(["engine: engine reader reads users, which is not a plan input"]);
    expect(
      checkE1([engine(["actions", "commitments"], ["daily_plan_desired_actions", "ghost"])], planInput, [])
    ).toEqual(["engine: notRead ghost is not a plan input"]);
    expect(checkE1([], planInput, [])).toEqual(["no entry is the engine reader (a reader whose to is surface:engine)"]);
    expect(
      checkE1([engine(["actions", "commitments"], ["daily_plan_desired_actions"])], planInput, ["actions"])
    ).toEqual(["actions is both a plan input and a blind table"]);
  });
});
