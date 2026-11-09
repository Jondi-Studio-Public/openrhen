import { describe, expect, it } from "vitest";
import { renderCommandsForMcp } from "./agent-surface.js";
import {
  classifiedRoutes,
  closeTarget,
  ownerAuthExemption,
  placeNameTarget,
  proposableCommandRefusal,
  registerAgentRoutes,
  routeNeedsBody,
  scopesForRoute,
  sharingTarget,
  type StoredFacts
} from "./agent-routes.js";
import { hardFloorReason, isKnownScope } from "./agent-scopes.js";
import { AGENT_SCOPE_PRESETS } from "./agent-tokens.js";
import { planningEntityCommandSchema } from "./planning/commands.js";

const entity = (entityType: string, entity: Record<string, unknown> = {}) => ({ entityType, entity });

describe("scopesForRoute: entity writes", () => {
  it("maps every entity type the save_entity schema accepts, so none is unclassified", () => {
    const types = planningEntityCommandSchema.shape.entityType.options as readonly string[];
    for (const type of types) {
      const decision = scopesForRoute("POST", "/api/commands/entity", entity(type));
      expect(decision.kind === "refused" && decision.reason, type).not.toBe("unknown-entity");
      if (decision.kind === "refused") expect(decision.reason, type).toBe("owner-only");
      else if (decision.kind === "scopes")
        for (const scope of decision.scopes) expect(isKnownScope(scope), scope).toBe(true);
    }
  });

  it("asks for the entity's write scope and makes the save downgradable by its class", () => {
    expect(scopesForRoute("POST", "/api/commands/entity", entity("commitment"))).toMatchObject({
      kind: "scopes",
      scopes: ["write:entity:commitment"],
      downgradable: true,
      entityClass: "commitment",
      command: "save_entity"
    });
    expect(scopesForRoute("POST", "/api/commands/project", { project: { id: "p" } })).toMatchObject({
      scopes: ["write:entity:project"],
      command: "save_project"
    });
    expect(scopesForRoute("POST", "/api/commands/action", { action: { id: "a" } })).toMatchObject({
      scopes: ["write:entity:action"],
      command: "save_action"
    });
  });

  it("lets an agent with the project write scope keep a project, applied directly (never a proposal)", () => {
    const decision = scopesForRoute("POST", "/api/commands/project-review", { projectId: "p", expectedVersion: 1 });
    expect(decision).toMatchObject({ kind: "scopes", scopes: ["write:entity:project"], call: { tool: "review" } });
    expect(decision).not.toHaveProperty("downgradable");
  });

  it("refuses an unknown or missing entity type rather than letting it through", () => {
    expect(scopesForRoute("POST", "/api/commands/entity", entity("mystery"))).toMatchObject({
      reason: "unknown-entity"
    });
    expect(scopesForRoute("POST", "/api/commands/entity", {})).toMatchObject({ reason: "unknown-entity" });
  });

  it("lets an agent confirm an Inbox item with the scope of its tool, not as a proposal", () => {
    const generic = scopesForRoute(
      "POST",
      "/api/commands/entity",
      entity("capture_review", { proposalType: "action" })
    );
    expect(generic).toMatchObject({
      kind: "scopes",
      scopes: ["write:inbox"],
      call: { tool: "inbox-act", room: "captured", action: "confirm" }
    });
    expect(generic).not.toHaveProperty("downgradable");
    // Neither is on the hard floor (a capture from another person is refused by the handler, which sees the source).
    for (const decision of [generic])
      expect(decision.kind === "scopes" && decision.floor ? hardFloorReason(decision.floor) : "none").toBeNull();
  });

  it("keeps a contract review and a capture saved as confirmed the owner's", () => {
    for (const body of [entity("deliverable_contract_review"), entity("capture", { status: "confirmed" })])
      expect(scopesForRoute("POST", "/api/commands/entity", body)).toMatchObject({ reason: "owner-only" });
  });

  it("writes the wake like a sleep log and plan preferences directly, and keeps timezone, setup and data flow on the floor", () => {
    expect(
      scopesForRoute("POST", "/api/commands/entity", entity("settings", { lastWokeAt: "2026-10-27T20:30:00.000Z" }))
    ).toMatchObject({
      scopes: ["write:entity:sleep_log_entry"],
      entityClass: "sleep_log_entry",
      floor: { tool: "save", entityType: "sleep_log_entry" }
    });
    // A plan preference, with or without the wake time, applies directly under the settings class.
    for (const fields of [
      { lastWokeAt: "2026-10-27T20:30:00.000Z", desiredSleepMinutes: 480 },
      { desiredSleepMinutes: 480 },
      { energyMeanings: { high: "x" }, defaultSetupBufferMinutes: 10 }
    ]) {
      const decision = scopesForRoute("POST", "/api/commands/entity", entity("settings", fields));
      expect(decision).toMatchObject({
        scopes: ["write:entity:settings"],
        entityClass: "settings",
        downgradable: true
      });
      expect(decision.kind === "scopes" && decision.floor ? hardFloorReason(decision.floor) : "none").toBeNull();
    }
    // Timezone, setup and an empty change stay on the floor, filed for the person.
    for (const fields of [
      { timezone: "Australia/Sydney" },
      { desiredSleepMinutes: 480, setupCompleted: true },
      { setupCompletedAt: "2026-10-27T00:00:00.000Z" },
      {}
    ]) {
      const decision = scopesForRoute("POST", "/api/commands/entity", entity("settings", fields));
      expect(decision).toMatchObject({ scopes: ["propose:entity:settings"], floor: { entityType: "settings" } });
      expect(decision.kind === "scopes" && decision.floor ? hardFloorReason(decision.floor) : null).toMatch(
        /^settings/
      );
    }
  });

  it("refuses a data-flow settings field outright, alone or mixed in, rather than filing it for the person", () => {
    for (const fields of [
      { pulsePublishEnabled: true },
      { desiredSleepMinutes: 480, calendarShareEnabled: true },
      { deliverableChatModel: "x", importExtractorModel: "y" }
    ]) {
      const decision = scopesForRoute("POST", "/api/commands/entity", entity("settings", fields));
      expect(decision).toMatchObject({ kind: "refused", reason: "owner-only" });
      expect(decision.kind === "refused" ? decision.message : "").toMatch(
        /^settings: .* the person's to change, in Settings > /
      );
    }
  });

  it("treats a new capture as the reviewable item it is and a non-pending one as an inbox action", () => {
    expect(scopesForRoute("POST", "/api/commands/entity", entity("capture", { status: "pending" }))).toMatchObject({
      scopes: ["propose:capture"]
    });
    const ignored = scopesForRoute("POST", "/api/commands/entity", entity("capture", { status: "ignored" }));
    expect(ignored).toMatchObject({ scopes: ["write:inbox"] });
    expect(ignored).not.toHaveProperty("downgradable");
  });

  it("floors a place save that carries the env-named-place fact, and leaves other places alone", () => {
    const place = entity("condition_definition", { kind: "location", name: "Main St Store" });
    const floored = scopesForRoute("POST", "/api/commands/entity", place, { envNamedPlace: true });
    expect(floored.kind === "scopes" && floored.floor ? hardFloorReason(floored.floor) : "none").toMatch(
      /^shared shift text:/
    );
    const plain = scopesForRoute("POST", "/api/commands/entity", place, {});
    expect(plain.kind === "scopes" && plain.floor ? hardFloorReason(plain.floor) : "none").toBeNull();
    // The fact only counts for a place.
    const other = scopesForRoute("POST", "/api/commands/entity", entity("action"), { envNamedPlace: true });
    expect(other.kind === "scopes" && other.floor ? hardFloorReason(other.floor) : "none").toBeNull();
  });

  it("names the place writes whose name could match an env-named place", () => {
    expect(
      placeNameTarget("POST", "/api/commands/entity", entity("condition_definition", { kind: "location", name: "A" }))
    ).toEqual({ name: "A" });
    expect(
      placeNameTarget("POST", "/api/commands/entity", {
        ...entity("condition_definition", { id: "p1", name: "B" }),
        expectedVersion: 2
      })
    ).toEqual({ id: "p1", name: "B" });
    expect(
      placeNameTarget("POST", "/api/commands/entity", entity("condition_definition", { kind: "contact", name: "A" }))
    ).toBeUndefined();
    expect(placeNameTarget("POST", "/api/commands/entity", entity("action", { name: "A" }))).toBeUndefined();
  });

  it("puts settings, removals and shared items on the hard floor, but not a status change", () => {
    const floor = (body: unknown, route = "/api/commands/entity") => {
      const decision = scopesForRoute("POST", route, body);
      return decision.kind === "scopes" && decision.floor ? hardFloorReason(decision.floor) : "none";
    };
    expect(floor(entity("settings", { timezone: "x" }))).toMatch(/^settings: timezone is the person's to change/);
    // The reason names only the guarded fields, whatever else the payload carries.
    expect(floor(entity("settings", { id: "s", desiredSleepMinutes: 480, setupCompleted: true }))).toMatch(
      /^settings: setupCompleted is the person's to change, in the Setup page; the plan preferences in this save are not held/
    );
    expect(floor(entity("span", { remove: true }))).toMatch(/^removal/);
    expect(floor(entity("commitment", { shareToCalendar: true }))).toMatch(/another person/);
    // An edit to a stored shared commitment (the body carries the version read) waits for the person's confirm;
    // a new one can be saved unshared.
    expect(floor({ ...entity("commitment", { id: "c1", shareToCalendar: true }), expectedVersion: 4 })).toMatch(
      /^touches another person: a commitment shared .*needs the person's confirm/
    );
    expect(floor({ ...entity("commitment", { shareToCalendar: true }), expectedVersion: null })).toMatch(
      /leave shareToCalendar off/
    );
    expect(floor({ action: { id: "a", remove: true } }, "/api/commands/action")).toMatch(/^removal/);
    // Cancelling, archiving or dropping is a reversible field change, so undo covers it and the floor does not.
    expect(floor({ action: { id: "a", status: "cancelled" } }, "/api/commands/action")).toBeNull();
    expect(floor({ project: { id: "p", status: "archived" } }, "/api/commands/project")).toBeNull();
    expect(floor(entity("commitment", { status: "dropped" }))).toBeNull();
    expect(floor(entity("commitment", { title: "Dentist" }))).toBeNull();
  });
});

describe("scopesForRoute: other writes", () => {
  it("maps the command routes to their tool scopes", () => {
    const scopes = (route: string, body?: unknown) => {
      const decision = scopesForRoute("POST", route, body);
      return decision.kind === "scopes" ? decision.scopes : decision.kind;
    };
    expect(scopes("/api/commands/session")).toEqual(["write:session"]);
    // The wake is the sleep log's fact: its scope, applied directly (no downgrade to a proposal), nothing on the floor.
    expect(scopes("/api/commands/wake")).toEqual(["write:entity:sleep_log_entry"]);
    const wake = scopesForRoute("POST", "/api/commands/wake", { commandId: "x", type: "wake" });
    expect(wake).not.toHaveProperty("downgradable");
    expect(wake.kind === "scopes" && wake.floor ? hardFloorReason(wake.floor) : "none").toBeNull();
    // An answer to a group of items to rank is a log entry: the comparison class's scope, applied directly, never a proposal.
    expect(scopes("/api/commands/consequence")).toEqual(["write:entity:comparison"]);
    const rank = scopesForRoute("POST", "/api/commands/consequence", { groupId: "g", rankedIds: ["a", "b"] });
    expect(rank).not.toHaveProperty("downgradable");
    expect(rank.kind === "scopes" && rank.floor ? hardFloorReason(rank.floor) : "none").toBeNull();
    expect(scopesForRoute("GET", "/api/consequence/next")).toMatchObject({ kind: "scopes", scopes: ["read:plan"] });
    expect(scopes("/api/commands/catch-up-settle")).toEqual(["propose:catch-up"]);
    expect(scopes("/api/commands/activity")).toEqual(["write:activity"]);
    expect(scopes("/api/commands/check-in")).toEqual(["write:check-in"]);
    expect(scopes("/api/commands/cadence-completion")).toEqual(["write:cadence"]);
    expect(scopes("/api/commands/commitment-recurrence")).toEqual(["write:recurrence"]);
    expect(scopes("/api/commands/recalculate")).toEqual(["write:recalculate"]);
    expect(scopes("/api/imports/extract")).toEqual(["write:import"]);
    expect(scopes("/api/plan-map/links")).toEqual(["write:plan-map"]);
    expect(scopes("/api/plan-map/findings/[id]")).toEqual(["write:plan-map"]);
    expect(scopes("/api/deliverables/[id]/workspace")).toEqual(["write:deliverable"]);
  });

  it("flags the writes that no downgrade can save: outward messages, drafts, import deletes, ending a recurrence", () => {
    const floor = (method: string, route: string, body?: unknown) => {
      const decision = scopesForRoute(method, route, body);
      return decision.kind === "scopes" && decision.floor ? hardFloorReason(decision.floor) : null;
    };
    expect(floor("DELETE", "/api/imports/[id]")).toMatch(/^removal/);
    expect(floor("POST", "/api/commands/recurrence-goal", { type: "end_recurrence_goal" })).toMatch(/^removal/);
    // Ending a recurring action's goal points at the action's own end date, not the commitment rule's.
    expect(floor("POST", "/api/commands/recurrence-goal", { type: "end_recurrence_goal" })).toMatch(
      /^removal: ending a recurring action .*`rhen save action --id <action> --set recurrence\.endDate=YYYY-MM-DD`$/
    );
    expect(floor("POST", "/api/commands/recurrence-goal", { type: "x" })).toBeNull();
    expect(floor("POST", "/api/commands/session")).toBeNull();
  });

  it("floors a recurring commitment that publishes to the family calendar or ends", () => {
    const rule = (fields: Record<string, unknown>) => {
      const decision = scopesForRoute("POST", "/api/commands/commitment-recurrence", {
        expectedVersion: 2,
        rule: { id: "r1", title: "Gym", ...fields }
      });
      return decision.kind === "scopes" && decision.floor ? hardFloorReason(decision.floor) : null;
    };
    // An edit to a shared rule carries its own shareToCalendar, so the person makes it; nothing says to unshare.
    expect(rule({ shareToCalendar: true })).toMatch(
      /^touches another person: a recurring commitment shared .*tell them/
    );
    // Ending names the end date as the way to stop a series sooner, unless the rule is shared, when that is refused too.
    expect(rule({ status: "ended" })).toMatch(/^removal: ending a recurrence .*--set endDate=YYYY-MM-DD/);
    expect(rule({ status: "ended", shareToCalendar: true })).toMatch(
      /^removal: ending a recurring commitment shared with the family calendar .*Schedule > Recurring commitments$/
    );
    // A new rule (no version read) can be set unshared and shared by the person.
    const created = scopesForRoute("POST", "/api/commands/commitment-recurrence", {
      expectedVersion: null,
      rule: { id: "r2", title: "Gym", shareToCalendar: true }
    });
    expect(created.kind === "scopes" && created.floor ? hardFloorReason(created.floor) : null).toMatch(
      /set the rule with shareToCalendar off/
    );
    // Anything else about the rule stays a plain write:recurrence set.
    expect(rule({})).toBeNull();
    expect(rule({ status: "active", shareToCalendar: false })).toBeNull();
    expect(scopesForRoute("POST", "/api/commands/commitment-recurrence", { rule: { status: "ended" } })).toMatchObject({
      scopes: ["write:recurrence"]
    });
    // No body at all is still decided: the portal enforcement reads one and refuses a body it cannot.
    expect(scopesForRoute("POST", "/api/commands/commitment-recurrence")).toMatchObject({ kind: "scopes" });
  });

  it("asks a changeset for the least each command inside could land with, and leaves refusals to the portal", () => {
    const decision = scopesForRoute("POST", "/api/commands/changeset", {
      items: [
        { path: "/api/commands/action", payload: { action: {} } },
        { path: "/api/commands/entity", payload: { entityType: "commitment", entity: {} } },
        { path: "/api/commands/session", payload: {} },
        // A capture saved as confirmed is the owner's: it adds nothing, and the portal refuses that one command.
        { path: "/api/commands/entity", payload: { entityType: "capture", entity: { status: "confirmed" } } },
        { path: "/api/commands/changeset", payload: {} }
      ]
    });
    expect(decision).toEqual({
      kind: "scopes",
      scopes: ["propose:entity:action", "propose:entity:commitment", "write:session"]
    });
    expect(routeNeedsBody("POST", "/api/commands/changeset")).toBe(true);
    // The close decision names its target in the body, so the body is read.
    expect(routeNeedsBody("POST", "/api/commands/close")).toBe(true);
    // A replay sends no commands but reads a stored result back, so it needs the changeset tool's own scope.
    expect(scopesForRoute("POST", "/api/commands/changeset", { replay: true, items: [] })).toEqual({
      kind: "scopes",
      scopes: ["propose:entity"]
    });
  });

  it("floors a write to a record the family calendar shows now, whatever the body says about sharing", () => {
    const floor = (route: string, body: unknown, shared: boolean) => {
      const decision = scopesForRoute("POST", route, body, { shared });
      return decision.kind === "scopes" && decision.floor ? hardFloorReason(decision.floor) : null;
    };
    const commitment = (fields: Record<string, unknown>) => ({
      ...entity("commitment", { id: "c1", title: "Dentist", ...fields }),
      expectedVersion: 4
    });
    // A body that leaves the flag out keeps it, and one that sends false takes the record off the calendar.
    expect(floor("/api/commands/entity", commitment({}), true)).toMatch(/^touches another person: a commitment shared/);
    expect(floor("/api/commands/entity", commitment({ shareToCalendar: false }), true)).toMatch(
      /^touches another person/
    );
    expect(floor("/api/commands/entity", commitment({}), false)).toBeNull();
    // Only a commitment shares; the stored fact says nothing about another entity type.
    expect(floor("/api/commands/entity", { ...entity("action", { id: "a1" }), expectedVersion: 1 }, true)).toBeNull();
    const rule = { expectedVersion: 2, rule: { id: "r1", title: "Gym", shareToCalendar: false } };
    expect(floor("/api/commands/commitment-recurrence", rule, true)).toMatch(/^touches another person: a recurring/);
    expect(floor("/api/commands/commitment-recurrence", rule, false)).toBeNull();
    const split = { commitmentId: "c1", expectedVersion: 3 };
    expect(floor("/api/commands/commitment-source-split", split, true)).toMatch(/^touches another person/);
    expect(floor("/api/commands/commitment-source-split", split, false)).toBeNull();
  });

  it("names the stored record a write can change the sharing of, and none for a create", () => {
    expect(
      sharingTarget("POST", "/api/commands/entity", { ...entity("commitment", { id: "c1" }), expectedVersion: 4 })
    ).toEqual({ kind: "commitment", id: "c1" });
    expect(
      sharingTarget("POST", "/api/commands/commitment-recurrence", { expectedVersion: 2, rule: { id: "r1" } })
    ).toEqual({ kind: "commitment-rule", id: "r1" });
    expect(sharingTarget("POST", "/api/commands/commitment-source-split", { commitmentId: "c1" })).toEqual({
      kind: "commitment",
      id: "c1"
    });
    expect(
      sharingTarget("POST", "/api/commands/entity", { ...entity("commitment", { id: "c1" }), expectedVersion: null })
    ).toBeUndefined();
    expect(
      sharingTarget("POST", "/api/commands/entity", { ...entity("action", { id: "a1" }), expectedVersion: 1 })
    ).toBeUndefined();
    expect(sharingTarget("GET", "/api/commands/commitment-source-split", { commitmentId: "c1" })).toBeUndefined();
    expect(sharingTarget("POST", "/api/commands/commitment-recurrence", undefined)).toBeUndefined();
  });

  it("asks a proposal for propose:agent-change plus the propose scope of each entity it carries", () => {
    expect(scopesForRoute("POST", "/api/agent-proposals", { kind: "something_else", payload: {} })).toMatchObject({
      scopes: ["propose:agent-change"]
    });
    expect(
      scopesForRoute("POST", "/api/agent-proposals", {
        kind: "entity_command_batch",
        payload: {
          commands: [
            { command: "save_entity", body: { entityType: "commitment" } },
            { command: "save_action", body: {} },
            { command: "save_entity", body: { entityType: "commitment" } }
          ]
        }
      })
    ).toMatchObject({ scopes: ["propose:agent-change", "propose:entity:commitment", "propose:entity:action"] });
    expect(
      scopesForRoute("POST", "/api/agent-proposals", {
        kind: "entity_command",
        payload: { command: "save_entity", body: {} }
      })
    ).toMatchObject({ reason: "unknown-entity" });
  });

  it("refuses a proposal carrying a write the save routes would refuse or never file for the person", () => {
    const propose = (commands: unknown[]) =>
      scopesForRoute("POST", "/api/agent-proposals", { kind: "entity_command_batch", payload: { commands } });
    const save = (entityType: string, fields: Record<string, unknown>) => ({
      command: "save_entity",
      body: entity(entityType, fields)
    });
    const fine = save("commitment", { title: "Dentist" });
    for (const bad of [
      save("settings", { desiredSleepMinutes: 480, pulsePublishEnabled: true }),
      save("deliverable_contract_review", { deliverableId: "d1" }),
      save("capture", { status: "confirmed" }),
      save("capture_review", { proposalType: "action" }),
      { command: "delete_everything", body: entity("commitment", {}) }
    ]) {
      expect(propose([fine, bad])).toMatchObject({ kind: "refused" });
      expect(proposableCommandRefusal(bad)).toEqual(expect.any(String));
    }
    expect(
      scopesForRoute("POST", "/api/agent-proposals", {
        kind: "entity_command",
        payload: save("settings", { sharePrimaryEvents: true })
      })
    ).toMatchObject({ kind: "refused", reason: "owner-only" });
    // What the save routes would file for the person stays proposable: timezone, a removal, a shared commitment.
    for (const ok of [
      fine,
      save("settings", { timezone: "Australia/Sydney" }),
      save("commitment", { id: "c1", remove: true }),
      save("commitment", { title: "Party", shareToCalendar: true }),
      // Dropping a kept item or ignoring another person's capture is floored by the stored row, so it is filed.
      save("capture", { status: "ignored" }),
      { command: "save_project", body: { project: { id: "p1", title: "Thesis" }, expectedVersion: 3 } }
    ])
      expect(proposableCommandRefusal(ok)).toBeNull();
  });

  it("keeps owner and device surfaces away from agents, and default-denies what it does not know", () => {
    for (const [method, route] of [
      ["POST", "/api/agent-proposals/[id]/resolve"],
      ["POST", "/api/agent-tokens"],
      ["PUT", "/api/plan-map/switches"],
      ["POST", "/api/location/ping"],
      ["POST", "/api/push/subscriptions"],
      ["PUT", "/api/state"]
    ] as const)
      expect(scopesForRoute(method, route)).toMatchObject({ kind: "refused", reason: "owner-only" });
    expect(scopesForRoute("POST", "/api/brand-new")).toMatchObject({ kind: "refused", reason: "unclassified" });
    expect(scopesForRoute("GET", "/api/brand-new")).toMatchObject({ kind: "refused", reason: "unclassified" });
  });
});

describe("refusal wording", () => {
  const message = (method: string, route: string, body?: unknown) => {
    const decision = scopesForRoute(method, route, body);
    return decision.kind === "refused" ? decision.message : `not refused: ${JSON.stringify(decision)}`;
  };

  it("says where the person does an owner route, or that they do it in the portal", () => {
    expect(message("POST", "/api/agent-proposals/[id]/resolve")).toBe(
      "Confirming or rejecting a proposal is for the owner; an agent token cannot use it, so nothing was changed. " +
        "The person does it in Inbox > Captured > From agents. Do not retry this call. " +
        'Tell the owner: "I cannot do this myself; please do it in Inbox > Captured > From agents."'
    );
    // Issuing a token is the owner's CLI; revoking or changing one is Settings.
    expect(message("POST", "/api/agent-tokens")).toContain(
      "The person does it with `rhen agent-token create --name <agent> --scopes <scopes>`."
    );
    expect(message("POST", "/api/owner/credentials")).toContain("with `rhen owner-token create`.");
    expect(message("DELETE", "/api/agent-tokens/[id]")).toContain("in Settings > Add-ons and sign-in.");
    expect(message("POST", "/api/push/test")).toContain("The person does it in Settings > Notifications.");
    expect(message("POST", "/api/owner/enroll")).toContain("The person does it on the Sign in page.");
    expect(message("PUT", "/api/state")).toContain("The person does it in the portal.");
    expect(message("GET", "/api/snapshots")).toContain("The person does it in the portal.");
    expect(message("POST", "/api/commands/entity", entity("deliverable_contract_review"))).toBe(
      "Approving a deliverable's contract is for the owner; an agent token cannot use it, so nothing was changed. " +
        "The person does it on the Deliverables page. Do not retry this call. " +
        'Tell the owner: "I cannot do this myself; please do it on the Deliverables page."'
    );
  });

  it("a refusal that points at a write the agent may make says which tool and arguments", () => {
    const refused = message("POST", "/api/commands/entity", entity("capture", { status: "confirmed" }));
    expect(refused).toContain("nothing was changed");
    expect(renderCommandsForMcp(refused)).toContain(
      'call rhen_inbox_act {"room":"captured","action":"confirm","id":"<id>","type":"<type>"}'
    );
    const proposed = message("POST", "/api/agent-proposals", {
      kind: "entity_command",
      payload: { command: "save_entity", body: { entityType: "capture", entity: { status: "confirmed" } } }
    });
    expect(proposed).toContain("rhen inbox-act captured confirm <id> --type <type>");
    expect(renderCommandsForMcp(proposed)).not.toMatch(/`rhen |\s--[a-z]/);
  });

  it("says a job or a device report has nothing for an agent to do, rather than pointing at a screen", () => {
    for (const [method, route] of [
      ["POST", "/api/photo-checkins"],
      ["POST", "/api/location/observe"]
    ] as const)
      expect(message(method, route), route).toMatch(/so an agent has nothing to do here\.$/);
  });

  it("sends a capture saved as confirmed to the Inbox action an agent may use", () => {
    expect(message("POST", "/api/commands/entity", entity("capture", { status: "confirmed" }))).toContain(
      "run `rhen inbox-act captured confirm <id> --type <type>`"
    );
  });

  it("points an unknown entity type, and a route nobody classified, at what agents can use", () => {
    for (const text of [
      message("POST", "/api/commands/entity", entity("mystery")),
      message("POST", "/api/commands/entity", {}),
      message("POST", "/api/agent-proposals", {
        kind: "entity_command",
        payload: { command: "save_entity", body: {} }
      })
    ])
      expect(text).toMatch(/Agents can write: area, outcome, project, action, commitment, .*, capture_review\.$/);
    expect(message("POST", "/api/brand-new")).toBe(
      "POST /api/brand-new is not available to agent tokens. Find what you may call with `rhen search` or `rhen list`, or ask the owner to do it."
    );
  });

  it("leaves no owner-only refusal without a place for the person, or a reason there is nothing to do", () => {
    for (const entry of classifiedRoutes()) {
      const [method, route] = entry.split(" ") as [string, string];
      const decision = scopesForRoute(method, route);
      if (decision.kind === "refused" && decision.reason === "owner-only")
        expect(decision.message, entry).toMatch(
          /The person does it (in|on|with) |so an agent has nothing to do here\.$/
        );
    }
  });
});

describe("scopesForRoute: stretch answers", () => {
  it("is an agent write under the availability scope, never owner-only, for every answer", () => {
    for (const body of [
      undefined,
      { choice: "accept", actionId: "a", basis: "stated", evidence: "yes" },
      { choice: "decline_all" }
    ]) {
      const decision = scopesForRoute("POST", "/api/commands/stretch", body);
      expect(decision).toMatchObject({ kind: "scopes", scopes: ["write:entity:current_availability"] });
      expect(decision.kind === "scopes" && decision.floor ? hardFloorReason(decision.floor) : "none").toBeNull();
    }
    expect(classifiedRoutes()).toContain("POST /api/commands/stretch");
  });
});

describe("scopesForRoute: reads", () => {
  it("classifies reads into plan, mail, files, changes and proposals", () => {
    const read = (route: string) => {
      const decision = scopesForRoute("GET", route);
      return decision.kind === "scopes" ? decision.scopes : decision.kind;
    };
    expect(read("/api/state")).toEqual(["read:plan"]);
    // The attention feed needs only read:plan; its proposal kinds are left out for a token without read:proposals.
    expect(read("/api/attention")).toEqual(["read:plan"]);
    expect(scopesForRoute("GET", "/api/attention")).not.toHaveProperty("anyOf");
    expect(read("/api/deliverables/[id]/pack")).toEqual(["read:files"]);
    expect(read("/api/changes")).toEqual(["read:changes"]);
    expect(read("/api/agent-proposals")).toEqual(["read:proposals"]);
    expect(read("/api/health/database")).toBe("public");
    expect(read("/api/connections/status")).toBe("refused");
    expect(read("/api/snapshots")).toBe("refused");
  });
});

describe("the table itself", () => {
  it("names only well-formed routes and each at most once", () => {
    const all = classifiedRoutes();
    expect(new Set(all).size).toBe(all.length);
    for (const entry of all)
      expect(entry).toMatch(/^(GET|POST|PUT|PATCH|DELETE) \/(api|mcp|oauth|\.well-known)(\/[A-Za-z0-9[\].-]+)*$/);
  });
  it("reads the body only where the decision depends on it", () => {
    expect(routeNeedsBody("POST", "/api/commands/entity")).toBe(true);
    expect(routeNeedsBody("POST", "/api/commands/commitment-recurrence")).toBe(true);
    expect(routeNeedsBody("POST", "/api/commands/session")).toBe(false);
  });
});

describe("the remote MCP routes", () => {
  it("serve the OAuth discovery documents to anyone", () => {
    for (const route of [
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp",
      "/.well-known/oauth-authorization-server"
    ])
      expect(scopesForRoute("GET", route)).toEqual({ kind: "public" });
  });

  it("refuse an agent token sent to the endpoint or the token endpoint, which authenticate themselves", () => {
    for (const [method, route] of [
      ["POST", "/mcp"],
      ["POST", "/oauth/token"],
      ["POST", "/oauth/register"],
      ["POST", "/oauth/authorize"]
    ] as const) {
      const decision = scopesForRoute(method, route);
      expect(decision).toMatchObject({ kind: "refused", reason: "self-authenticated" });
      expect(ownerAuthExemption(method, route), route).toBeDefined();
    }
  });

  it("keep the consent page away from agents, while the owner's browser reaches it without the gate", () => {
    expect(scopesForRoute("GET", "/oauth/authorize")).toMatchObject({ kind: "refused", reason: "owner-only" });
    expect(ownerAuthExemption("GET", "/oauth/authorize")).toBeDefined();
  });

  it("leave nothing else under those paths open", () => {
    expect(scopesForRoute("GET", "/mcp")).toMatchObject({ kind: "refused", reason: "unclassified" });
    expect(scopesForRoute("GET", "/oauth/token")).toMatchObject({ kind: "refused", reason: "unclassified" });
    expect(scopesForRoute("POST", "/.well-known/oauth-authorization-server")).toMatchObject({
      kind: "refused",
      reason: "unclassified"
    });
  });
});

describe("scopesForRoute: agent time", () => {
  it("lets the narrow write:agent-session scope post sessions, as an ordinary write with no floor", () => {
    const decision = scopesForRoute("POST", "/api/agent-sessions", { schemaVersion: 1, sessions: [] });
    expect(decision).toEqual({ kind: "scopes", scopes: ["write:agent-session"] });
    expect(isKnownScope("write:agent-session")).toBe(true);
  });

  it("keeps reading agent time to the owner", () => {
    expect(scopesForRoute("GET", "/api/agent-sessions")).toMatchObject({ kind: "refused", reason: "owner-only" });
  });
});

describe("scopesForRoute: watch history", () => {
  it("keeps importing, undoing and reading watch history to the owner", () => {
    expect(scopesForRoute("POST", "/api/imports/watch-history", {})).toMatchObject({
      kind: "refused",
      reason: "owner-only"
    });
    expect(scopesForRoute("DELETE", "/api/imports/watch-history/[id]")).toMatchObject({
      kind: "refused",
      reason: "owner-only"
    });
    expect(scopesForRoute("GET", "/api/review/watch-history")).toMatchObject({ kind: "refused", reason: "owner-only" });
  });
});

describe("scopesForRoute: passwords and keys", () => {
  it("keeps saving, removing and listing keys, and fetching video lengths, to the owner", () => {
    expect(scopesForRoute("PUT", "/api/settings/secrets/[name]", {})).toMatchObject({
      kind: "refused",
      reason: "owner-only"
    });
    expect(scopesForRoute("DELETE", "/api/settings/secrets/[name]")).toMatchObject({
      kind: "refused",
      reason: "owner-only"
    });
    expect(scopesForRoute("GET", "/api/settings/secrets")).toMatchObject({ kind: "refused", reason: "owner-only" });
    expect(scopesForRoute("POST", "/api/review/watch-history/lengths", {})).toMatchObject({
      kind: "refused",
      reason: "owner-only"
    });
  });

  it("offers no secret route to an agent under any other method", () => {
    for (const method of ["GET", "POST", "PATCH"])
      expect(scopesForRoute(method, "/api/settings/secrets/[name]", {}).kind, method).toBe("refused");
    expect(scopesForRoute("POST", "/api/settings/secrets", {}).kind).toBe("refused");
  });
});

describe("scopesForRoute: re-entry", () => {
  it("lets a token holding only write:catch-up read what re-entry needs and re-enter", () => {
    expect(scopesForRoute("GET", "/api/commands/reenter")).toMatchObject({
      kind: "scopes",
      anyOf: expect.arrayContaining(["write:catch-up"])
    });
    expect(scopesForRoute("POST", "/api/commands/reenter", {})).toEqual({ kind: "scopes", scopes: ["write:catch-up"] });
  });

  it("lets a propose-only token read the re-entry questions but never submit answers", () => {
    const read = scopesForRoute("GET", "/api/commands/reenter");
    expect(read).toMatchObject({ kind: "scopes", anyOf: ["read:plan", "write:catch-up", "propose:catch-up"] });
    for (const preset of ["scribe", "assistant"])
      expect(AGENT_SCOPE_PRESETS[preset]!.some((scope) => (read as { anyOf: string[] }).anyOf.includes(scope))).toBe(
        true
      );
    // The write is untouched: one scope, no any-of.
    expect(scopesForRoute("POST", "/api/commands/reenter", {})).not.toHaveProperty("anyOf");
  });
});

describe("registered routes", () => {
  it("classifies a route a drop-in registers, and forgets it when removed", () => {
    const route = "/api/drop-in-test/devices";
    expect(scopesForRoute("POST", route).kind).toBe("refused");
    const remove = registerAgentRoutes({
      ownerRoutes: { [`POST ${route}`]: "Registering a device", [`PATCH ${route}/[id]`]: "Editing a device" },
      ownerRunsItself: [`POST ${route}`],
      ownerReads: [route],
      ownerAuthExempt: { [`PATCH ${route}/[id]`]: "the device secret from registration" }
    });
    try {
      expect(scopesForRoute("POST", route)).toMatchObject({ kind: "refused", reason: "owner-only" });
      expect(scopesForRoute("POST", route)).toMatchObject({
        message: expect.stringMatching(/so an agent has nothing to do here\.$/)
      });
      expect(scopesForRoute("GET", route)).toMatchObject({ kind: "refused", reason: "owner-only" });
      expect(ownerAuthExemption("PATCH", `${route}/[id]`)).toBe("the device secret from registration");
      expect(classifiedRoutes()).toContain(`POST ${route}`);
    } finally {
      remove();
    }
    expect(scopesForRoute("POST", route).kind).toBe("refused");
    expect(classifiedRoutes()).not.toContain(`POST ${route}`);
    expect(ownerAuthExemption("PATCH", `${route}/[id]`)).toBeUndefined();
  });
});

describe("scopesForRoute: archive and cancel (POST /api/commands/close)", () => {
  const body = (type: string, extra: Record<string, unknown> = {}) => ({
    type,
    id: "x1",
    verb: "cancel",
    do: "close",
    ...extra
  });
  const read = (extra: StoredFacts = {}): StoredFacts => ({
    closeTypes: ["project"],
    needsOwner: false,
    shared: false,
    rowCount: 1,
    restorableByAgent: true,
    ...extra
  });
  const scoped = (decision: ReturnType<typeof scopesForRoute>) => {
    if (decision.kind !== "scopes") throw new Error(`expected scopes, got ${decision.kind}`);
    return decision;
  };

  it("reads the target from the body, for the portal to look up", () => {
    expect(closeTarget("POST", "/api/commands/close", body("project", { verb: "archive" }))).toEqual({
      type: "project",
      id: "x1",
      verb: "archive",
      do: "close"
    });
    expect(closeTarget("POST", "/api/commands/close", body("project", { do: "restore" }))?.do).toBe("restore");
    expect(closeTarget("GET", "/api/commands/close", body("project"))).toBeUndefined();
    expect(closeTarget("POST", "/api/commands/entity", body("project"))).toBeUndefined();
    expect(closeTarget("POST", "/api/commands/close", { type: "project" })).toBeUndefined();
    expect(closeTarget("POST", "/api/commands/close", { ...body("project"), verb: "delete" })).toBeUndefined();
  });

  it("is a downgradable write under the type's own scope and class, replayed as close_entity", () => {
    for (const type of [
      "area",
      "outcome",
      "project",
      "action",
      "deliverable",
      "commitment",
      "routine_preset",
      "condition_definition"
    ]) {
      const decision = scoped(scopesForRoute("POST", "/api/commands/close", body(type), read({ closeTypes: [type] })));
      expect(decision).toMatchObject({
        scopes: [`write:entity:${type}`],
        call: { tool: "cancel", entityType: type },
        downgradable: true,
        entityClass: type,
        command: "close_entity"
      });
    }
    expect(
      scoped(scopesForRoute("POST", "/api/commands/close", { ...body("area"), verb: "archive" }, read())).call?.tool
    ).toBe("archive");
  });

  it("names the eight types for an unknown one, as a 400", () => {
    const decision = scopesForRoute("POST", "/api/commands/close", body("span"), read());
    expect(decision).toMatchObject({ kind: "refused", reason: "unknown-entity" });
    expect((decision as { message: string }).message).toContain("routine_preset");
    expect(scopesForRoute("POST", "/api/commands/close", { type: "project" }, read())).toMatchObject({
      kind: "refused",
      reason: "unknown-entity"
    });
  });

  it("files a proposal unless the stored facts were read and say it may apply", () => {
    const decide = (facts: StoredFacts, extra: Record<string, unknown> = {}) =>
      scoped(scopesForRoute("POST", "/api/commands/close", body("project", extra), facts));
    expect(decide(read()).mustPropose).toBeUndefined();
    // nothing read at all: the facts are not there to trust
    expect(decide({}).mustPropose).toMatch(/could not be read/);
    expect(decide(read({ needsOwner: true })).mustPropose).toMatch(/owner/);
    expect(decide(read({ shared: true })).mustPropose).toMatch(/shared|other people/);
    expect(decide(read({ closeTypes: ["project", "action"] })).closeTypes).toEqual(["project", "action"]);
    // an agent's restore applies only when it closed the row itself
    expect(decide(read({ restorableByAgent: false }), { do: "restore" }).mustPropose).toMatch(/closed/);
    expect(decide(read({ restorableByAgent: false })).mustPropose).toBeUndefined();
    expect(decide(read({ restorableByAgent: true }), { do: "restore" }).mustPropose).toBeUndefined();
  });

  it("applies the rolling-hour budget: the hour's closures plus this call, with retries and undo exempt", () => {
    const decide = (facts: StoredFacts, extra: Record<string, unknown> = {}) =>
      scoped(scopesForRoute("POST", "/api/commands/close", body("project", extra), facts));
    expect(decide(read({ closedInHour: 19, rowCount: 1 })).mustPropose).toBeUndefined();
    expect(decide(read({ closedInHour: 20, rowCount: 1 })).mustPropose).toMatch(/last hour.*20/);
    expect(decide(read({ closedInHour: 19, rowCount: 2 })).mustPropose).toMatch(/21 closures/);
    // a restore is never counted
    expect(decide(read({ closedInHour: 20 }), { do: "restore" }).mustPropose).toBeUndefined();
    // a retry of a call that already landed is answered from its receipt, not filed again
    expect(decide(read({ closedInHour: 20, closeCommandLanded: true })).mustPropose).toBeUndefined();
    // a verified undo of the agent's own create is exempt
    expect(decide(read({ closedInHour: 20, undoOfCreate: true })).mustPropose).toBeUndefined();
    // an unverified undo claim is an ordinary close
    expect(decide(read({ closedInHour: 20 }), { undoOfCommandId: crypto.randomUUID() }).mustPropose).toMatch(/hour/);
  });

  it("puts a call past 20 rows on the hard floor", () => {
    const decision = scoped(scopesForRoute("POST", "/api/commands/close", body("project"), read({ rowCount: 21 })));
    expect(decision.floor?.rowCount).toBe(21);
    expect(hardFloorReason(decision.floor!)).toMatch(/21 rows is over 20/);
    const small = scoped(scopesForRoute("POST", "/api/commands/close", body("project"), read({ rowCount: 20 })));
    expect(hardFloorReason(small.floor!)).toBeNull();
  });
});

describe("scopesForRoute: the activity store", () => {
  it("lets the capture scope post events, and nothing else posts them", () => {
    expect(
      scopesForRoute("POST", "/api/activity-events", { source: "rhen-watch", kind: "window", start: "x" })
    ).toEqual({
      kind: "scopes",
      scopes: ["write:activity-event"]
    });
    expect(AGENT_SCOPE_PRESETS["activity-capture"]).toEqual(["write:activity-event"]);
  });

  describe("derived rows: the scope follows the kind in the body", () => {
    const post = (...events: Array<{ source: string; kind: string }>) =>
      scopesForRoute("POST", "/api/activity-events", { schema: 1, events });
    const needs = (decision: ReturnType<typeof scopesForRoute>) =>
      decision.kind === "scopes" ? [...decision.scopes].sort() : decision.kind === "refused" ? "owner-only" : "?";

    it("reads the body, because the scope depends on it", () => {
      expect(routeNeedsBody("POST", "/api/activity-events")).toBe(true);
    });

    it("registers write:activity-derived", () => {
      expect(isKnownScope("write:activity-derived")).toBe(true);
    });

    it("asks the derived scope for fact and msg_class, and for any derived-shadow row", () => {
      expect(needs(post({ source: "derived", kind: "fact" }))).toEqual(["write:activity-derived"]);
      expect(needs(post({ source: "derived", kind: "msg_class" }))).toEqual(["write:activity-derived"]);
      expect(needs(post({ source: "derived-shadow", kind: "fact" }))).toEqual(["write:activity-derived"]);
      expect(needs(post({ source: "derived-shadow", kind: "label" }))).toEqual(["write:activity-derived"]);
    });

    it("asks the event scope for override and fact_status, so an extractor token cannot write them", () => {
      expect(needs(post({ source: "derived", kind: "override" }))).toEqual(["write:activity-event"]);
      expect(needs(post({ source: "derived", kind: "fact_status" }))).toEqual(["write:activity-event"]);
    });

    it("keeps label and every other derived kind (including correction) with the owner session, naming the fix", () => {
      for (const kind of ["label", "correction", "invite"]) {
        const decision = post({ source: "derived", kind });
        expect(decision).toMatchObject({ kind: "refused", reason: "owner-only" });
        expect((decision as { message: string }).message).toMatch(/owner session/);
        expect((decision as { message: string }).message).toMatch(/write:activity-event|write:activity-derived/);
      }
    });

    it("demands the union for a mixed batch, and the owner for a batch with an owner-only row", () => {
      expect(needs(post({ source: "derived", kind: "fact" }, { source: "derived", kind: "override" }))).toEqual([
        "write:activity-derived",
        "write:activity-event"
      ]);
      expect(needs(post({ source: "rhen-watch", kind: "window" }, { source: "derived", kind: "fact" }))).toEqual([
        "write:activity-derived",
        "write:activity-event"
      ]);
      expect(needs(post({ source: "derived", kind: "fact" }, { source: "derived", kind: "label" }))).toBe("owner-only");
    });

    it("reads the single-event shorthand the same way", () => {
      expect(
        needs(scopesForRoute("POST", "/api/activity-events", { source: "derived", kind: "fact", start: "x" }))
      ).toEqual(["write:activity-derived"]);
    });

    it("asks only the event scope for a row or body that can never be stored, so the handler rejects it alone", () => {
      for (const body of [
        {},
        undefined,
        { schema: 1, events: "no" },
        { schema: 1, events: [null] },
        { schema: 1, events: [{ kind: "fact" }] },
        { source: 5 }
      ])
        expect(needs(scopesForRoute("POST", "/api/activity-events", body as never)), JSON.stringify(body)).toEqual([
          "write:activity-event"
        ]);
      // One bad row does not turn the good rows owner-only.
      expect(
        needs(
          scopesForRoute("POST", "/api/activity-events", {
            schema: 1,
            events: [{ source: "rhen-watch", kind: "window" }, null, { kind: "x" }, 7]
          })
        )
      ).toEqual(["write:activity-event"]);
    });

    it("still gives a derived row of an unreadable kind to the owner", () => {
      expect(needs(post({ source: "derived", kind: 5 as never }))).toBe("owner-only");
      expect(
        needs(scopesForRoute("POST", "/api/activity-events", { schema: 1, events: [{ source: "derived" }] }))
      ).toBe("owner-only");
    });

    it("never returns an empty scope list, which would authorise a token that holds nothing", () => {
      expect(needs(post())).toEqual(["write:activity-event"]);
    });
  });

  it("opens the read-back to the read scope only, and the import check to the capture scope only", () => {
    expect(scopesForRoute("GET", "/api/activity-events")).toEqual({ kind: "scopes", scopes: ["read:activity-event"] });
    expect(scopesForRoute("GET", "/api/activity-imports")).toEqual({
      kind: "scopes",
      scopes: ["write:activity-event"]
    });
    for (const scope of ["read:activity-event", "write:activity-event"]) expect(isKnownScope(scope)).toBe(true);
  });

  it("keeps the summary, the source settings and every deletion with the owner", () => {
    expect(scopesForRoute("GET", "/api/activity-events/summary")).toMatchObject({
      kind: "refused",
      reason: "owner-only"
    });
    for (const [method, route] of [
      ["PUT", "/api/activity-sources/[source]"],
      ["DELETE", "/api/activity-sources/[source]/events"],
      ["DELETE", "/api/activity-imports/[id]"]
    ] as const)
      expect(scopesForRoute(method, route, {}), `${method} ${route}`).toMatchObject({
        kind: "refused",
        reason: "owner-only"
      });
  });
});
