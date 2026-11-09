import { describe, expect, it, vi } from "vitest";
import { renderCommandsForMcp, type AgentBasis } from "@openrhen/contracts";
import {
  decideWrite,
  enforceAgentRequest,
  entityProposal,
  proposalSummary,
  type EnforceDeps
} from "./agent-enforcement";
import { AgentProposalError } from "./agent-proposals/errors";
import type { AgentPrincipal } from "./agent-tokens";

const principal = (scopes: string[], directWrites: AgentPrincipal["directWrites"] = {}): AgentPrincipal => ({
  name: "companion",
  source: "db",
  tokenId: "t1",
  scopes,
  directWrites
});

const ID = "11111111-1111-4111-8111-111111111111";
const entityBody = (entityType: string, entity: Record<string, unknown> = { id: "c1", title: "Dentist" }) => ({
  commandId: ID,
  type: "save_entity",
  entityType,
  expectedVersion: 3,
  entity
});

const fakePropose = () =>
  vi.fn<NonNullable<EnforceDeps["propose"]>>(async (_agent, input) => ({
    proposal: { id: ID, kind: input.kind, summary: input.summary, shadow: input.shadow === true } as never
  }));

const call = (
  method: string,
  route: string,
  held: AgentPrincipal,
  body?: unknown,
  claim: { basis?: AgentBasis; evidence?: string } = {},
  deps: EnforceDeps = {}
) =>
  enforceAgentRequest(
    new Request(`http://portal.test${route}`, {
      method,
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
    }),
    route,
    held,
    claim,
    // Nothing is stored unless a test says so, whatever database the environment points at.
    { stored: async () => ({}), ...deps }
  );

describe("reads", () => {
  it("lets a token read what its read scopes cover and refuses the rest with the full challenge", async () => {
    expect(await call("GET", "/api/state", principal(["read:plan"]))).toBeNull();
    const refused = await call("GET", "/api/changes", principal(["read:plan"]));
    expect(refused?.status).toBe(403);
    expect(await refused?.json()).toMatchObject({ requiredScopes: ["read:changes"], missingScopes: ["read:changes"] });
    expect(refused?.headers.get("www-authenticate")).toBe('Bearer error="insufficient_scope", scope="read:changes"');
  });

  it("denies a read route nobody classified, and the owner's configuration reads", async () => {
    for (const route of ["/api/brand-new", "/api/connections/status", "/api/snapshots"]) {
      const refused = await call("GET", route, principal(["read:plan", "read:mail", "read:files"]));
      expect(refused?.status, route).toBe(403);
      expect(refused?.headers.get("www-authenticate"), route).toBeNull();
    }
  });

  it("serves health and the CLI bundle to any valid token", async () => {
    expect(await call("GET", "/api/health/database", principal([]))).toBeNull();
  });
});

describe("the enforcement matrix for entity saves", () => {
  const write = ["write:entity:commitment"];
  const cases: {
    name: string;
    held: AgentPrincipal;
    entityType?: string;
    entity?: Record<string, unknown>;
    claim?: { basis?: AgentBasis };
    expected: "apply" | "propose" | "shadow" | "deny";
  }[] = [
    {
      name: "stated + write + on applies",
      held: principal(write, { commitment: "on" }),
      claim: { basis: "stated" },
      expected: "apply"
    },
    { name: "stated + write + off proposes", held: principal(write), claim: { basis: "stated" }, expected: "propose" },
    {
      name: "stated + write + shadow proposes and shadows",
      held: principal(write, { commitment: "shadow" }),
      claim: { basis: "stated" },
      expected: "shadow"
    },
    {
      name: "inferred + write + on applies",
      held: principal(write, { commitment: "on" }),
      claim: { basis: "inferred" },
      expected: "apply"
    },
    { name: "a missing basis + write + on applies", held: principal(write, { commitment: "on" }), expected: "apply" },
    {
      name: "observed + write + on applies",
      held: principal(write, { commitment: "on" }),
      claim: { basis: "observed" },
      expected: "apply"
    },
    {
      name: "inferred + write + off still proposes",
      held: principal(write),
      claim: { basis: "inferred" },
      expected: "propose"
    },
    {
      name: "inferred + write + shadow proposes and shadows",
      held: principal(write, { commitment: "shadow" }),
      claim: { basis: "inferred" },
      expected: "shadow"
    },
    {
      name: "a propose scope only proposes",
      held: principal(["propose:entity:commitment"], { commitment: "on" }),
      claim: { basis: "stated" },
      expected: "propose"
    },
    {
      name: "broad propose:entity proposes",
      held: principal(["propose:entity"]),
      claim: { basis: "stated" },
      expected: "propose"
    },
    {
      name: "broad write:entity applies when on",
      held: principal(["write:entity"], { commitment: "on" }),
      claim: { basis: "stated" },
      expected: "apply"
    },
    {
      name: "directWrites for another class does not help",
      held: principal(write, { action: "on" }),
      claim: { basis: "stated" },
      expected: "propose"
    },
    {
      name: "no matching scope is a 403",
      held: principal(["write:entity:action"], { commitment: "on" }),
      claim: { basis: "stated" },
      expected: "deny"
    },
    {
      name: "read scopes alone are a 403",
      held: principal(["read:plan"]),
      claim: { basis: "stated" },
      expected: "deny"
    },
    {
      name: "a removal floors even a stated on write",
      held: principal(["write:entity:span"], { span: "on" }),
      entityType: "span",
      entity: { id: "s1", remove: true },
      claim: { basis: "stated" },
      expected: "propose"
    },
    {
      name: "cancelling a commitment is a field change and applies when on",
      held: principal(write, { commitment: "on" }),
      entity: { id: "c1", status: "cancelled" },
      claim: { basis: "inferred" },
      expected: "apply"
    },
    {
      name: "settings always propose",
      held: principal(["propose:entity:settings"]),
      entityType: "settings",
      entity: { timezone: "Europe/London" },
      claim: { basis: "stated" },
      expected: "propose"
    },
    {
      name: "a shared item floors",
      held: principal(write, { commitment: "on" }),
      entity: { id: "c1", shareToCalendar: true },
      claim: { basis: "stated" },
      expected: "propose"
    },
    {
      name: "a capture is written as asked",
      held: principal(["propose:capture"]),
      entityType: "capture",
      entity: { text: "buy milk", status: "pending" },
      expected: "apply"
    },
    {
      name: "confirming a captured item applies with write:inbox, never as a proposal",
      held: principal(["write:inbox"]),
      entityType: "capture_review",
      entity: { id: "r1", proposalType: "someday" },
      claim: { basis: "stated" },
      expected: "apply"
    },
    {
      name: "confirming a captured item needs write:inbox, which write:entity does not cover",
      held: principal(["write:entity"]),
      entityType: "capture_review",
      entity: { id: "r1", proposalType: "someday" },
      claim: { basis: "stated" },
      expected: "deny"
    },
    {
      name: "approving a contract is the owner's",
      held: principal(["write:entity", "write:inbox"]),
      entityType: "deliverable_contract_review",
      entity: { id: "r1" },
      claim: { basis: "stated" },
      expected: "deny"
    },
    {
      name: "saving a capture as confirmed is the owner's",
      held: principal(["write:entity", "write:inbox", "propose:capture"]),
      entityType: "capture",
      entity: { id: "c1", status: "confirmed" },
      claim: { basis: "stated" },
      expected: "deny"
    }
  ];

  for (const row of cases)
    it(row.name, async () => {
      const propose = fakePropose();
      const response = await call(
        "POST",
        "/api/commands/entity",
        row.held,
        entityBody(row.entityType ?? "commitment", row.entity),
        row.claim ?? {},
        { propose }
      );
      if (row.expected === "apply") {
        expect(response).toBeNull();
        expect(propose).not.toHaveBeenCalled();
      } else if (row.expected === "deny") {
        expect(response?.status).toBe(403);
        expect(propose).not.toHaveBeenCalled();
      } else {
        expect(response?.status).toBe(202);
        const input = propose.mock.calls[0]![1];
        expect(propose.mock.calls[0]![0]).toBe("companion");
        expect(input).toMatchObject({ kind: "entity_command", payload: { command: "save_entity" } });
        expect(input.shadow === true).toBe(row.expected === "shadow");
        expect((await response!.json()).proposal.id).toBe(ID);
      }
    });

  it("stores the body exactly as sent, with the basis and evidence from the headers", async () => {
    const propose = fakePropose();
    const body = entityBody("commitment");
    await call(
      "POST",
      "/api/commands/entity",
      principal(write),
      body,
      { basis: "stated", evidence: "the owner: dentist at 3" },
      { propose }
    );
    expect(propose.mock.calls[0]![1]).toMatchObject({
      payload: { command: "save_entity", body },
      basis: "stated",
      evidence: "the owner: dentist at 3",
      commandId: ID,
      coalesceKey: "commitment:c1"
    });
  });

  describe("agentNote says plainly that a proposal cannot be taken back", () => {
    const note = async (entityType: string, entity: Record<string, unknown>, scope: string) => {
      const response = await call(
        "POST",
        "/api/commands/entity",
        principal([scope]),
        entityBody(entityType, entity),
        {},
        { propose: fakePropose() }
      );
      return ((await response!.json()) as { agentNote: string }).agentNote;
    };

    it("with a record id: how to replace the card, and what to do if the correction is applied instead", async () => {
      const text = await note("commitment", { id: "c1", title: "Dentist" }, "propose:entity:commitment");
      expect(text).toContain("Do not send it again unchanged");
      expect(text).toContain("You cannot take a proposal back");
      expect(text).toContain("same save call you just used");
      expect(text).toContain("same record id");
      expect(text).toContain("new commandId");
      expect(text).toContain("revision is above 1");
      expect(text).toContain(`proposal ${ID} is still pending`);
      expect(text).toContain("tell the owner to reject it in Inbox > Captured > From agents");
      expect(text).toContain("does not prove the owner had not already confirmed");
      expect(text).toContain("`rhen save`");
      expect(text).toContain("`rhen proposals`");
    });

    it("with no record id (settings, delete, new record): do not resend, ask the owner to reject", async () => {
      const text = await note("settings", { timezone: "x" }, "propose:entity:settings");
      expect(text).toContain("Do not send it again unchanged");
      expect(text).toContain("You cannot take a proposal back");
      expect(text).toContain("A different second call files a second card");
      expect(text).toContain("an identical copy returns the same card");
      expect(text).toContain(`Please reject proposal ${ID} in Inbox > Captured > From agents.`);
      expect(text).not.toContain("revision is above 1");
      expect(text).not.toContain("same record id");
    });

    it("renders for stdio as tool calls, never shell syntax, and keeps the CLI form raw", async () => {
      for (const [type, entity, scope] of [
        ["commitment", { id: "c1", title: "Dentist" }, "propose:entity:commitment"],
        ["settings", { timezone: "x" }, "propose:entity:settings"]
      ] as const) {
        const raw = await note(type, entity, scope);
        expect(raw).toContain("`rhen proposals`");
        const rendered = renderCommandsForMcp(raw);
        // The owner-only agent-token command in the floor reason keeps its flags on purpose (the agent relays it as written).
        expect(rendered).not.toMatch(/`rhen (?!agent-token)/);
        if (type === "commitment") expect(rendered).toContain("call rhen_save");
        expect(rendered).toContain("call rhen_proposals");
      }
    });
  });

  it("names the floor reason in a 202 and relays the store's refusals", async () => {
    const response = await call(
      "POST",
      "/api/commands/entity",
      principal(["propose:entity:settings"]),
      entityBody("settings", { timezone: "x" }),
      {},
      { propose: fakePropose() }
    );
    const body = (await response!.json()) as { filedBecause: string; agentNote: string; proposal: { id: string } };
    const filedBecause = body.filedBecause;
    expect(filedBecause).toBe("settings: timezone is the person's to change, in Settings > Planning");
    // The 202 is a success that reads like a refusal: say it is NOT applied, not to resend, and how to check.
    expect(body.agentNote).toContain(`Filed as proposal ${body.proposal.id}`);
    expect(body.agentNote).toContain("has NOT been applied");
    expect(body.agentNote).toContain("Do not send it again");
    expect(body.agentNote).toContain("`rhen proposals`");
    expect(body.agentNote).toContain(filedBecause);
    const over = vi.fn(async () => {
      throw new AgentProposalError(429, "Over the cap.", { cap: 50 });
    });
    const capped = await call(
      "POST",
      "/api/commands/entity",
      principal(write),
      entityBody("commitment"),
      {},
      { propose: over }
    );
    expect(capped?.status).toBe(429);
  });
});

describe("free on a commitment shared with the family calendar", () => {
  const route = "/api/commands/entity";
  const held = principal(["write:entity:commitment"], { commitment: "on" });
  const freeBody = { ...entityBody("commitment", { id: "c1", free: true }), expectedVersion: 4 };

  it("files a proposal for the owner to confirm, whose summary says what freed means", async () => {
    const propose = fakePropose();
    const response = await call(
      "POST",
      route,
      held,
      freeBody,
      { basis: "stated" },
      { propose, stored: async () => ({ shared: true }) }
    );
    expect(response?.status).toBe(202);
    expect(propose).toHaveBeenCalledTimes(1);
    expect(propose.mock.calls[0]![1]).toMatchObject({
      kind: "entity_command",
      payload: { command: "save_entity", body: freeBody },
      coalesceKey: "commitment:c1"
    });
    expect(propose.mock.calls[0]![1].summary).toMatch(/Free the person from commitment/);
    expect(propose.mock.calls[0]![1].summary).toMatch(/nothing is ended or moved/);
  });

  it("applies directly when the commitment is not shared", async () => {
    const propose = fakePropose();
    expect(
      await call(
        "POST",
        route,
        held,
        freeBody,
        { basis: "stated" },
        { propose, stored: async () => ({ shared: false }) }
      )
    ).toBeNull();
    expect(propose).not.toHaveBeenCalled();
  });

  it("names the undo in the proposal summary", () => {
    expect(proposalSummary("save_entity", { ...freeBody, entity: { id: "c1", free: false } })).toMatch(
      /Undo free on commitment/
    );
  });
});

describe("project and action saves", () => {
  it("downgrades the dedicated routes the same way", async () => {
    const propose = fakePropose();
    const response = await call(
      "POST",
      "/api/commands/action",
      principal(["write:entity:action"]),
      { commandId: ID, expectedVersion: null, action: { id: "a1", title: "Call the dentist" } },
      { basis: "stated" },
      { propose }
    );
    expect(response?.status).toBe(202);
    expect(propose.mock.calls[0]![1]).toMatchObject({ payload: { command: "save_action" }, coalesceKey: "action:a1" });
    expect(
      await call(
        "POST",
        "/api/commands/project",
        principal(["write:entity:project"], { project: "on" }),
        { project: { id: "p1" } },
        { basis: "stated" },
        { propose }
      )
    ).toBeNull();
  });
});

describe("routes that cannot become proposals", () => {
  it("applies a write whose scope is held and refuses one that is not, naming every scope in one challenge", async () => {
    expect(await call("POST", "/api/commands/session", principal(["write:session"]))).toBeNull();
    const refused = await call("POST", "/api/commands/session", principal(["read:plan"]));
    expect(refused?.status).toBe(403);
    expect(refused?.headers.get("www-authenticate")).toBe('Bearer error="insufficient_scope", scope="write:session"');
  });

  it("refuses a hard-floor write on such a route even with the scope, naming what the agent can do instead", async () => {
    for (const [method, route, scope, instead] of [
      ["DELETE", "/api/imports/[id]", "write:import", "rhen import update"]
    ] as const) {
      const refused = await call(method, route, principal([scope]));
      expect(refused?.status, route).toBe(403);
      const { error, suggestedPath } = (await refused!.json()) as { error: string; suggestedPath?: string };
      expect(error, route).toContain(instead);
      expect(error, route).toMatch(/^An agent token cannot make this write: /);
      expect(error, route).not.toMatch(/\.\.$/);
      // `propose` files entity saves only, so none of these may be sent there.
      expect(error, route).not.toContain("rhen propose");
      // The command to run instead, on its own, for the CLI's JSON error (`code: guarded`, `suggestedPath`).
      expect(suggestedPath, route).toBeTruthy();
      expect(error, route).toContain(suggestedPath!);
    }
    const end = await call("POST", "/api/commands/recurrence-goal", principal(["write:recurrence"]), {
      type: "end_recurrence_goal"
    });
    expect(end?.status).toBe(403);
    expect(((await end!.json()) as { error: string }).error).toContain("recurrence.endDate=YYYY-MM-DD");
    expect(
      await call("POST", "/api/commands/recurrence-goal", principal(["write:recurrence"]), { type: "x" })
    ).toBeNull();
  });

  it("refuses a recurring commitment that shares with the family calendar or ends, and says what to do instead", async () => {
    const route = "/api/commands/commitment-recurrence";
    const held = principal(["write:recurrence"]);
    const rule = { id: "r1", title: "Gym" };
    expect(await call("POST", route, held, { expectedVersion: 2, rule })).toBeNull();
    expect(
      await call("POST", route, held, { expectedVersion: 2, rule: { ...rule, shareToCalendar: false } })
    ).toBeNull();
    for (const [expectedVersion, fields, instead] of [
      // An edit to a shared rule is the person's; a new one can be set unshared and shared by them.
      [2, { shareToCalendar: true }, "is the person's to change, in Schedule > Recurring commitments"],
      [null, { shareToCalendar: true }, "set the rule with shareToCalendar off"],
      [2, { status: "ended" }, "--set endDate=YYYY-MM-DD"],
      [2, { status: "ended", shareToCalendar: true }, "they do it in Schedule > Recurring commitments"]
    ] as const) {
      const refused = await call("POST", route, held, { expectedVersion, rule: { ...rule, ...fields } });
      expect(refused?.status, JSON.stringify(fields)).toBe(403);
      expect((await refused!.json()).error).toContain(instead);
    }
    // The decision depends on the body, so a body that cannot be read is a 400, never a pass.
    expect((await call("POST", route, held))?.status).toBe(400);
  });

  it("answers 400 with the current field name when a body still carries a removed calendar-sharing name", async () => {
    const held = principal(["write:recurrence", "write:entity:commitment", "write:entity:settings"]);
    const rule = await call("POST", "/api/commands/commitment-recurrence", held, {
      expectedVersion: null,
      rule: { id: "r1", title: "Gym", shareWithFamily: true }
    });
    expect(rule?.status).toBe(400);
    expect((await rule!.json()).error).toContain('use "shareToCalendar"');
    const settings = await call("POST", "/api/commands/entity", held, {
      commandId: "c1",
      type: "save_entity",
      entityType: "settings",
      entity: { shareWithFamilyEnabled: true }
    });
    expect(settings?.status).toBe(400);
    expect((await settings!.json()).error).toContain('use "calendarShareEnabled"');
  });

  it("reads whether the stored record is shared and refuses a write that would change it, even one unsharing", async () => {
    const route = "/api/commands/commitment-recurrence";
    const held = principal(["write:recurrence"]);
    const body = { expectedVersion: 2, rule: { id: "r1", title: "Gym", shareToCalendar: false } };
    const stored = vi.fn<NonNullable<EnforceDeps["stored"]>>(async () => ({ shared: true }));
    const refused = await call("POST", route, held, body, {}, { stored });
    expect(refused?.status).toBe(403);
    expect(stored).toHaveBeenCalledWith("POST", route, body, expect.anything());
    expect(await call("POST", route, held, body, {}, { stored: async () => ({ shared: false }) })).toBeNull();
    const split = { commitmentId: "c1", expectedVersion: 3 };
    const splitHeld = principal(["write:recurrence"]);
    expect(
      (await call("POST", "/api/commands/commitment-source-split", splitHeld, split, {}, { stored }))?.status
    ).toBe(403);
    // A read never asks the store.
    stored.mockClear();
    await call("GET", "/api/state", principal(["read:plan"]), undefined, {}, { stored });
    expect(stored).not.toHaveBeenCalled();
  });

  it("refuses owner surfaces and unknown write routes whatever the scopes", async () => {
    const everything = principal(["write:entity", "write:session", "read:plan", "propose:agent-change"]);
    for (const [method, route] of [
      ["POST", "/api/agent-proposals/[id]/resolve"],
      ["POST", "/api/agent-tokens"],
      ["PUT", "/api/plan-map/switches"],
      ["POST", "/api/location/ping"],
      ["POST", "/api/not-a-route"]
    ] as const)
      expect((await call(method, route, everything))?.status, route).toBe(403);
  });

  it("requires the propose scope of every entity in a proposal, and the batch kind passes through", async () => {
    const batch = {
      kind: "entity_command_batch",
      summary: "x",
      payload: { commands: [{ command: "save_entity", body: { entityType: "commitment" } }] }
    };
    const refused = await call("POST", "/api/agent-proposals", principal(["propose:agent-change"]), batch);
    expect(refused?.status).toBe(403);
    expect(await refused?.json()).toMatchObject({ missingScopes: ["propose:entity:commitment"] });
    expect(
      await call("POST", "/api/agent-proposals", principal(["propose:agent-change", "propose:entity"]), batch)
    ).toBeNull();
  });
});

describe("decideWrite", () => {
  it("says why a write was filed and where the person can change that", () => {
    const decision = {
      kind: "scopes" as const,
      scopes: ["write:entity:sleep_log_entry"],
      floor: { tool: "save", entityType: "sleep_log_entry" },
      downgradable: true,
      entityClass: "sleep_log_entry",
      command: "save_entity" as const
    };
    const reason = (held: AgentPrincipal) => {
      const outcome = decideWrite(decision, held);
      return outcome.action === "propose" ? outcome.reason : outcome.action;
    };
    expect(reason(principal(["write:entity:sleep_log_entry"]))).toBe(
      "direct writes are off for sleep log entry, so it waits for the person; " +
        'they can turn on "Writes apply directly" for this token in Settings > Add-ons and sign-in'
    );
    expect(reason(principal(["write:entity:sleep_log_entry"], { sleep_log_entry: "shadow" }))).toContain(
      "direct writes are in shadow for sleep log entry"
    );
    expect(reason(principal(["propose:entity:sleep_log_entry"], { sleep_log_entry: "on" }))).toBe(
      "this token may only propose changes to sleep log entry; " +
        "the person can issue a token that writes them directly: `rhen agent-token create --name <agent> --scopes <scopes>`"
    );
  });

  it("tells a token that lacks a scope how the person gives it", async () => {
    const refused = await call("GET", "/api/changes", principal(["read:plan"]));
    const { error } = (await refused!.json()) as { error: string };
    // What went wrong, what the token holds, that a retry is pointless, and the sentence to tell the owner.
    expect(error).toContain("This token lacks the scope read:changes");
    expect(error).toContain("holds read:plan");
    expect(error).toContain("Do not retry");
    expect(error).toContain('Tell the owner: "');
    // The exact line, scopes filled in (what it holds plus what is missing); no placeholder left to guess.
    expect(error).toContain("rhen agent-token create --name <agent> --scopes read:plan,read:changes");
    expect(error).not.toContain("<scopes>");
    expect(error).toContain("reconnect");
    expect(error).not.toMatch(/\b(he|his)\b/);
  });

  it("answers an entity type agents cannot write as a 400 validation error that lists the valid types", async () => {
    const refused = await call("POST", "/api/commands/entity", principal(["write:entity:action"]), {
      type: "save_entity",
      entityType: "widget",
      entity: {}
    });
    expect(refused?.status).toBe(400);
    const { error } = (await refused!.json()) as { error: string };
    expect(error).toContain('"widget" is not an entity type agents can write');
    expect(error).toContain("Agents can write: area, outcome");
  });
});

describe("the proposal summary", () => {
  const settings = (entity: Record<string, unknown>) => ({
    commandId: ID,
    type: "save_entity",
    entityType: "settings",
    expectedVersion: 4,
    entity
  });

  it("names a create by its kind and name only", () => {
    expect(proposalSummary("save_entity", { ...entityBody("commitment"), expectedVersion: null })).toBe(
      'Create commitment "Dentist"'
    );
    expect(proposalSummary("save_project", { expectedVersion: null, project: { id: "p", title: "T" } })).toBe(
      'Create project "T"'
    );
    const input = entityProposal("save_project", { project: { id: "p", title: "T" } }, { basis: "stated" }, false);
    expect(input.summary).toBe('Create project "T"');
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
    const text = proposalSummary(
      "save_entity",
      {
        type: "save_entity",
        entityType: "commitment",
        expectedVersion: 3,
        entity: { ...stored, attendance: "in_person", routineSource: "custom" }
      },
      stored
    );
    expect(text).toContain("loc-1 → none");
    expect(text).toContain("p1 → none");
  });

  it("says what changes from what it was when the stored record is known", () => {
    expect(
      proposalSummary("save_entity", settings({ timezone: "Australia/Brisbane" }), {
        version: 4,
        timezone: "Australia/Sydney",
        sessionBreakMinutes: 15
      })
    ).toBe("Update settings: timezone Australia/Sydney → Australia/Brisbane");
    expect(proposalSummary("save_entity", settings({ sessionBreakMinutes: 10 }), { sessionBreakMinutes: 15 })).toBe(
      "Update settings: session break minutes 15 → 10"
    );
  });

  it("lists only the fields that differ from a whole record, however it is written", () => {
    const stored = {
      id: "c1",
      version: 3,
      title: "Dentist",
      startsAt: "2026-10-28T09:00:00.000Z",
      status: "confirmed",
      repeat: { unit: "days", intervalDays: 7 }
    };
    const sent = {
      id: "c1",
      version: 3,
      title: "Dentist",
      startsAt: "2026-10-28T20:00:00+11:00",
      status: "cancelled",
      repeat: { intervalDays: 7, unit: "days" }
    };
    expect(proposalSummary("save_entity", entityBody("commitment", sent), stored)).toBe(
      'Update commitment "Dentist": status confirmed → cancelled'
    );
    expect(proposalSummary("save_entity", entityBody("commitment", stored), stored)).toBe(
      'Update commitment "Dentist" (no field changes)'
    );
  });

  it("says a capture restore only puts it back in review", () => {
    expect(
      proposalSummary(
        "save_entity",
        {
          expectedVersion: 2,
          entityType: "capture",
          entity: { id: "k1", status: "pending", restore: true, proposedFields: {} }
        },
        { id: "k1", text: "Learn the cello", status: "superseded" }
      )
    ).toBe('Restore capture "Learn the cello": status → pending (other fields kept)');
  });

  it("names a stored field the update leaves out, which the save clears, and not a field the save keeps", () => {
    const stored = {
      id: "p1",
      version: 4,
      outcomeId: "o1",
      title: "Thesis",
      status: "active",
      uncertainty: "some",
      consequence: 3,
      internalDeadlineAt: "2026-11-20T00:00:00.000Z",
      private: true
    };
    const { internalDeadlineAt: _deadline, private: _private, ...sent } = stored;
    expect(proposalSummary("save_project", { expectedVersion: 4, project: sent }, stored)).toBe(
      'Update project "Thesis": internal deadline at 2026-11-20T00:00:00.000Z → none'
    );
  });

  it("names the nested field that changed, not the whole object, and ignores a pathway written another way", () => {
    const recurrence = { id: "r1", timezone: "Australia/Brisbane", startDate: "2026-10-01", intervalDays: 7 };
    const stored = {
      id: "a1",
      title: "Gym",
      recurrence,
      requirementPathways: [{ id: "p1", contextIds: ["car"] }]
    };
    const sent = {
      ...stored,
      recurrence: { ...recurrence, endDate: "2026-12-01" },
      requirementPathways: [["car"]]
    };
    expect(proposalSummary("save_action", { expectedVersion: 2, action: sent }, stored)).toBe(
      'Update action "Gym": recurrence.endDate none → 2026-12-01'
    );
    expect(
      proposalSummary("save_action", { expectedVersion: 2, action: { ...sent, recurrence: undefined } }, stored)
    ).toContain("recurrence ");
  });

  it("does not print two long values that read alike once cut short, or a long list in full", () => {
    const ids = ["a", "b", "c", "d", "e"].map((id) => id.repeat(10));
    const stored = { id: "c1", title: "Gym", notes: `${"x".repeat(60)}a`, dependencyIds: ids };
    const sent = { ...stored, notes: `${"x".repeat(60)}b`, dependencyIds: [...ids, "f".repeat(10)] };
    expect(proposalSummary("save_entity", entityBody("commitment", sent), stored)).toBe(
      'Update commitment "Gym": notes changed; dependency ids 5 items → 6 items'
    );
  });

  it("shows a missing value as none and names the record by its stored title when the title changes", () => {
    expect(
      proposalSummary("save_entity", entityBody("commitment", { id: "c1", title: "Dentist 2", location: "Clinic" }), {
        id: "c1",
        title: "Dentist"
      })
    ).toBe('Update commitment "Dentist": title Dentist → Dentist 2; location none → Clinic');
  });

  it("lists the new values when the stored record is not known, and counts what it leaves out", () => {
    expect(proposalSummary("save_entity", settings({ timezone: "Australia/Brisbane" }))).toBe(
      "Update settings: timezone set to Australia/Brisbane"
    );
    const many = Object.fromEntries(["a", "b", "c", "d", "e", "f", "g"].map((key) => [key, key]));
    expect(proposalSummary("save_entity", entityBody("commitment", { id: "c1", title: "Gym", ...many }))).toBe(
      'Update commitment "Gym": title set to Gym; a set to a; b set to b; c set to c; d set to d; and 3 more'
    );
  });

  it("uses the portal's names for the settings fields an agent can only propose", () => {
    expect(
      proposalSummary(
        "save_entity",
        settings({ calendarShareEnabled: true, setupCompleted: true, setupCompletedAt: "2026-10-27T01:00:00Z" }),
        { calendarShareEnabled: false, setupCompleted: false }
      )
    ).toBe(
      "Update settings: share with family calendar false → true; setup completed false → true; " +
        "setup completed at none → 2026-10-27T01:00:00Z"
    );
    expect(
      proposalSummary("save_entity", settings({ deliverableChatModel: "gpt-5", pulsePublishEnabled: true }), {
        deliverableChatModel: "gpt-4.1"
      })
    ).toBe("Update settings: deliverable workspace chat model gpt-4.1 → gpt-5; Pulse publishing none → true");
  });

  it("names as many changes as fit in 300 characters, and counts the rest", () => {
    const stored = { id: "c1", title: "T".repeat(80) };
    const sent = { ...stored, ...Object.fromEntries(["a", "b", "c", "d", "e"].map((key) => [key, key.repeat(60)])) };
    const summary = proposalSummary("save_entity", entityBody("commitment", sent), stored);
    expect(summary.length).toBeLessThanOrEqual(300);
    expect(summary).toMatch(/^Update commitment "T+": a none → a+…; .*; and \d more$/);
  });

  it("says a removal is one", () => {
    const remove = { ...entityBody("span", { id: "s1", remove: true }) };
    expect(proposalSummary("save_entity", remove, { id: "s1", title: "Trip 1" })).toBe('Remove span "Trip 1"');
    expect(proposalSummary("save_entity", remove)).toBe("Remove span s1");
  });

  it("is at most 300 characters, built from the command and not from free-form claims", () => {
    expect(
      proposalSummary("save_action", { expectedVersion: null, action: { id: "a", title: "x".repeat(500) } }).length
    ).toBeLessThanOrEqual(300);
    expect(
      proposalSummary("save_entity", settings({ timezone: "y".repeat(500), setupCompletedAt: "z".repeat(500) }), {
        timezone: "q".repeat(500)
      }).length
    ).toBeLessThanOrEqual(300);
  });

  it("files the change with the stored record it reads, and without one when it cannot", async () => {
    const propose = fakePropose();
    const current = vi.fn(async () => ({ id: "c1", version: 3, title: "Dentist", status: "confirmed" }));
    await call(
      "POST",
      "/api/commands/entity",
      principal(["write:entity:commitment"]),
      entityBody("commitment", { id: "c1", title: "Dentist", status: "cancelled" }),
      {},
      { propose, current }
    );
    expect(current).toHaveBeenCalledWith("commitment", "c1", expect.objectContaining({ id: "c1" }));
    expect(propose.mock.calls[0]![1].summary).toBe('Update commitment "Dentist": status confirmed → cancelled');
    // A create has nothing stored to read.
    const created = vi.fn(async () => undefined);
    await call(
      "POST",
      "/api/commands/entity",
      principal(["write:entity:commitment"]),
      { ...entityBody("commitment"), expectedVersion: null },
      {},
      { propose, current: created }
    );
    expect(created).not.toHaveBeenCalled();
    await call(
      "POST",
      "/api/commands/entity",
      principal(["write:entity:commitment"]),
      entityBody("commitment", { id: "c1", status: "cancelled" }),
      {},
      { propose, current: async () => undefined }
    );
    expect(propose.mock.calls[2]![1].summary).toBe("Update commitment: status set to cancelled");
    // A record that changed since the agent read it (version 4, not 3) would show the newer edit as the
    // agent's own, so only the new values are listed.
    await call(
      "POST",
      "/api/commands/entity",
      principal(["write:entity:commitment"]),
      entityBody("commitment", { id: "c1", status: "cancelled" }),
      {},
      { propose, current: async () => ({ id: "c1", version: 4, title: "Dentist", status: "tentative" }) }
    );
    expect(propose.mock.calls[3]![1].summary).toBe("Update commitment: status set to cancelled");
  });
});

describe("activity store", () => {
  const events = { schema: 1, events: [] };
  const everyActivityScope = principal(["read:plan", "write:activity-event", "read:activity-event"]);

  it("lets a capture token post events and check an import, and nothing else it holds helps", async () => {
    expect(await call("POST", "/api/activity-events", principal(["write:activity-event"]), events)).toBeNull();
    expect(await call("GET", "/api/activity-imports", principal(["write:activity-event"]))).toBeNull();
    const refused = await call("POST", "/api/activity-events", principal(["read:plan", "read:activity-event"]), events);
    expect(refused?.status).toBe(403);
    expect(await refused?.json()).toMatchObject({ missingScopes: ["write:activity-event"] });
  });

  it("lets only the derived scope post fact rows, and keeps fact_status and override with the event scope", async () => {
    const one = (kind: string) => ({
      schema: 1,
      events: [{ id: "k", source: "derived", kind, start: "2026-11-08T01:00:00Z" }]
    });
    expect(await call("POST", "/api/activity-events", principal(["write:activity-derived"]), one("fact"))).toBeNull();
    const refusedFact = await call("POST", "/api/activity-events", principal(["write:activity-event"]), one("fact"));
    expect(await refusedFact?.json()).toMatchObject({ missingScopes: ["write:activity-derived"] });
    // An extractor token never outranks a person's confirmed status.
    for (const kind of ["fact_status", "override"]) {
      const refused = await call("POST", "/api/activity-events", principal(["write:activity-derived"]), one(kind));
      expect(refused?.status, kind).toBe(403);
      expect(await refused?.json(), kind).toMatchObject({ missingScopes: ["write:activity-event"] });
      expect(
        await call("POST", "/api/activity-events", principal(["write:activity-event"]), one(kind)),
        kind
      ).toBeNull();
    }
  });

  it("answers an oversize activity body with the handler's 413, valid JSON or not, and does not parse it", async () => {
    const big = (text: string) =>
      enforceAgentRequest(
        new Request("http://portal.test/api/activity-events", { method: "POST", body: text }),
        "/api/activity-events",
        principal(["write:activity-event"]),
        {},
        { stored: async () => ({}) }
      );
    const pad = "x".repeat(2 * 1024 * 1024 + 1);
    const validJson = JSON.stringify({ schema: 1, events: [{ source: "rhen-watch", kind: "window", pad }] });
    for (const text of [validJson, pad]) {
      const response = await big(text);
      expect(response?.status).toBe(413);
      expect(await response?.json()).toMatchObject({ error: expect.stringContaining("over 2 MB") });
    }
    // At the cap and below, the rule still reads the body as before.
    expect(
      await call("POST", "/api/activity-events", principal(["write:activity-event"]), { schema: 1, events: [] })
    ).toBeNull();
  });

  it("cancels the whole body stream when the declared length is over the cap, and answers 400 when the read fails", async () => {
    const run = (stream: ReadableStream<Uint8Array>, headers: Record<string, string>) =>
      enforceAgentRequest(
        new Request("http://portal.test/api/activity-events", {
          method: "POST",
          headers,
          body: stream,
          duplex: "half"
        } as RequestInit),
        "/api/activity-events",
        principal(["write:activity-event"]),
        {},
        { stored: async () => ({}) }
      );
    let cancelled = false;
    const declared = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(1024));
      },
      cancel() {
        cancelled = true;
      }
    });
    const tooLarge = await run(declared, { "content-length": String(3 * 1024 * 1024) });
    expect(tooLarge?.status).toBe(413);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(cancelled).toBe(true);

    // A client that aborts mid-body is a bad request, not a server error.
    const aborted = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"schema":1,'));
        controller.error(new Error("client aborted"));
      }
    });
    const response = await run(aborted, {});
    expect(response?.status).toBe(400);
  });

  it("refuses an empty batch from a token holding no activity scope (the scope list is never empty)", async () => {
    const refused = await call("POST", "/api/activity-events", principal(["read:plan"]), { schema: 1, events: [] });
    expect(refused?.status).toBe(403);
    expect(await refused?.json()).toMatchObject({ missingScopes: ["write:activity-event"] });
  });

  it("lets one malformed row through to the handler, which rejects it alone", async () => {
    const held = principal(["write:activity-event"]);
    expect(
      await call("POST", "/api/activity-events", held, {
        schema: 1,
        events: [{ source: "rhen-watch", kind: "window" }, null]
      })
    ).toBeNull();
  });

  it("refuses a token a derived label or correction, whatever scopes it holds", async () => {
    const all = principal(["write:activity-event", "write:activity-derived", "read:activity-event"]);
    for (const kind of ["label", "correction"]) {
      const refused = await call("POST", "/api/activity-events", all, {
        schema: 1,
        events: [{ id: "k", source: "derived", kind, start: "2026-11-08T01:00:00Z" }]
      });
      expect(refused?.status, kind).toBe(403);
      expect(JSON.stringify(await refused?.json()), kind).toContain("owner session");
    }
  });

  it("keeps the read-back (which returns content) behind read:activity-event, which capture does not hold", async () => {
    expect(await call("GET", "/api/activity-events", principal(["read:activity-event"]))).toBeNull();
    const refused = await call("GET", "/api/activity-events", principal(["write:activity-event"]));
    expect(refused?.status).toBe(403);
    expect(await refused?.json()).toMatchObject({ missingScopes: ["read:activity-event"] });
  });

  it("refuses a token the owner-only activity routes, whatever activity scopes it holds", async () => {
    for (const [method, route] of [
      ["DELETE", "/api/activity-imports/[id]"],
      ["PUT", "/api/activity-sources/[source]"],
      ["DELETE", "/api/activity-sources/[source]/events"],
      ["GET", "/api/activity-events/summary"],
      ["GET", "/api/derived-settings"],
      ["PUT", "/api/derived-settings"],
      ["POST", "/api/derived-settings/test"]
    ] as const) {
      const refused = await call(method, route, everyActivityScope, method === "GET" ? undefined : {});
      expect(refused?.status, `${method} ${route}`).toBe(403);
    }
  });
});

describe("agent time ingest", () => {
  const body = { schemaVersion: 1, sessions: [] };

  it("lets a token with write:agent-session post, and nothing else it holds helps", async () => {
    expect(await call("POST", "/api/agent-sessions", principal(["write:agent-session"]), body)).toBeNull();
    const refused = await call("POST", "/api/agent-sessions", principal(["read:plan", "write:entity:action"]), body);
    expect(refused?.status).toBe(403);
    expect(await refused?.json()).toMatchObject({ missingScopes: ["write:agent-session"] });
  });

  it("does not let the agent-time token read the plan or write anything else", async () => {
    const held = principal(["write:agent-session"]);
    expect((await call("GET", "/api/state", held))?.status).toBe(403);
    expect((await call("POST", "/api/commands/session", held, {}))?.status).toBe(403);
    expect((await call("GET", "/api/agent-sessions", held))?.status).toBe(403);
  });
});
