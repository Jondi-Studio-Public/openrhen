import { describe, expect, it } from "vitest";
import { parseBasis, parseEvidence, parseEvidenceHeader, encodeEvidenceHeader } from "./agent-claim.js";
import {
  ADMIN_SCOPES,
  AGENT_ENTITY_TYPES,
  AGENT_WRITE_TOOLS,
  OWNER_ONLY_SETTINGS_FIELDS,
  PLAN_PREFERENCE_SETTINGS_FIELDS,
  PROPOSE_ONLY_SETTINGS_FIELDS,
  WAKE_SETTINGS_FIELDS,
  downgradeScope,
  hardFloorInstead,
  hardFloorReason,
  isAgentWritableSettings,
  isKnownScope,
  ownerOnlySettingsFieldsIn,
  parseScope,
  requiredScopes,
  scopeCovers,
  settingsPlace,
  validateGrantableScopes,
  type HardFloorCall
} from "./agent-scopes.js";
import { ARCHIVE_TYPES, CANCEL_TYPES } from "./closed-entity.js";
import { contractsExtensions } from "./extensions.js";
import { actionStatusSchema, lifecycleStatusSchema } from "./core.js";
import { planningEntityCommandSchema } from "./planning/commands.js";
import { conditionStatusSchema } from "./planning/context-model.js";
import { commitmentStatusSchema, portalStateSchema, routinePresetStatusSchema } from "./portal/state-schema.js";

/** The mutating commands in tools/cli/src/registry.ts (`mcp` excluded); tools/cli's own test compares the live registry to the table. */
const REGISTRY_WRITE_TOOLS = [
  "activity",
  "archive",
  "arrive",
  "bulk",
  "cadence",
  "cancel",
  "capture",
  "catch-up-settle",
  "changeset",
  "check-in",
  "deliverable",
  "disrupt",
  "disruption",
  "free",
  "import",
  "inbox-act",
  "propose",
  "recalculate",
  "reenter",
  "review",
  "recurrence",
  "routine",
  "save",
  "session",
  "span",
  "stretch",
  "undo",
  "wake"
];

describe("parseScope", () => {
  it("parses verb, resource and qualifier", () => {
    expect(parseScope("write:entity:commitment")).toEqual({
      ok: true,
      scope: { verb: "write", resource: "entity", qualifier: "commitment" }
    });
    expect(parseScope("read:mail")).toEqual({ ok: true, scope: { verb: "read", resource: "mail" } });
  });
  it("refuses malformed scopes", () => {
    for (const bad of [
      "",
      "write",
      "grant:plan",
      "write:",
      "write:Entity",
      "write:a:b:c",
      "write:entity:Bad",
      "write:x y"
    ])
      expect(parseScope(bad).ok, bad).toBe(false);
  });
});

describe("scopeCovers", () => {
  it("lets write cover propose and a bare resource cover its qualifiers", () => {
    expect(scopeCovers("write:entity", "write:entity:action")).toBe(true);
    expect(scopeCovers("write:entity:action", "propose:entity:action")).toBe(true);
    expect(scopeCovers("propose:entity:action", "write:entity:action")).toBe(false);
    expect(scopeCovers("write:entity:action", "write:entity:project")).toBe(false);
    expect(scopeCovers("write:session", "read:plan")).toBe(false);
  });
  it("downgrades write to propose only", () => {
    expect(downgradeScope("write:entity:action")).toBe("propose:entity:action");
    expect(downgradeScope("read:plan")).toBe("read:plan");
  });
});

describe("the write-tool table", () => {
  it("lists exactly the registry's mutating commands", () => {
    const extensionTools = new Set(
      contractsExtensions().flatMap((extension) => Object.keys(extension.toolScopes ?? {}))
    );
    expect([...AGENT_WRITE_TOOLS].filter((tool) => !extensionTools.has(tool)).sort()).toEqual(
      [...REGISTRY_WRITE_TOOLS].sort()
    );
  });
  it("gives every non-resolved tool at least one known scope", () => {
    for (const tool of AGENT_WRITE_TOOLS) {
      if (tool === "save" || tool === "bulk" || tool === "inbox-act" || tool === "archive" || tool === "cancel")
        continue;
      const scopes = requiredScopes({ tool });
      expect(scopes.length, tool).toBeGreaterThan(0);
      for (const scope of scopes) expect(isKnownScope(scope), scope).toBe(true);
    }
  });
  it("covers the whole 17-value entity enum plus project and action", () => {
    const enumValues = planningEntityCommandSchema.shape.entityType.options as string[];
    expect(enumValues).toHaveLength(17);
    for (const type of [...enumValues, "project", "action"]) {
      expect(AGENT_ENTITY_TYPES, type).toContain(type);
      const [scope] = requiredScopes({ tool: "save", entityType: type });
      expect(scope, type).toBeDefined();
      expect(isKnownScope(scope!), scope).toBe(true);
    }
    expect(AGENT_ENTITY_TYPES).toHaveLength(19);
  });
  it("resolves the documented examples", () => {
    expect(requiredScopes({ tool: "save", entityType: "commitment" })).toEqual(["write:entity:commitment"]);
    expect(requiredScopes({ tool: "bulk", entityType: "action" })).toEqual(["write:entity:action"]);
    expect(requiredScopes({ tool: "session" })).toEqual(["write:session"]);
    expect(requiredScopes({ tool: "catch-up-settle" })).toEqual(["propose:catch-up"]);
    // a write:catch-up token covers the propose scope, and both are grantable
    expect(scopeCovers("write:catch-up", "propose:catch-up")).toBe(true);
    expect(isKnownScope("write:catch-up")).toBe(true);
    expect(requiredScopes({ tool: "capture" })).toEqual(["propose:capture"]);
    expect(requiredScopes({ tool: "save", entityType: "capture" })).toEqual(["propose:capture"]);
    expect(requiredScopes({ tool: "save", entityType: "settings" })).toEqual(["propose:entity:settings"]);
    expect(requiredScopes({ tool: "inbox-act", room: "kept", action: "drop" })).toEqual(["write:inbox"]);
    expect(requiredScopes({ tool: "inbox-act", room: "map", action: "link" })).toEqual(["write:plan-map"]);
  });
  it("returns nothing for an unknown tool or entity type", () => {
    expect(requiredScopes({ tool: "nope" })).toEqual([]);
    expect(requiredScopes({ tool: "save", entityType: "nope" })).toEqual([]);
    expect(requiredScopes({ tool: "save" })).toEqual([]);
  });
});

describe("owner-only", () => {
  it("names the data-flow settings fields", () => {
    expect([...OWNER_ONLY_SETTINGS_FIELDS]).toEqual([
      "calendarShareEnabled",
      "sharePrimaryEvents",
      "pulsePublishEnabled",
      "deliverableChatModel",
      "importExtractorModel"
    ]);
    expect(
      ownerOnlySettingsFieldsIn({ timezone: "UTC", sharePrimaryEvents: false, importExtractorModel: null })
    ).toEqual(["sharePrimaryEvents", "importExtractorModel"]);
    expect(ownerOnlySettingsFieldsIn({ timezone: "UTC" })).toEqual([]);
  });

  it("puts every settings field in exactly one class, so a new one can't become agent-writable unseen", () => {
    const classes: readonly (readonly string[])[] = [
      OWNER_ONLY_SETTINGS_FIELDS,
      PROPOSE_ONLY_SETTINGS_FIELDS,
      WAKE_SETTINGS_FIELDS,
      PLAN_PREFERENCE_SETTINGS_FIELDS
    ];
    // The settings handler also takes this one, which the state does not echo back under the same name.
    const fields = [
      ...Object.keys(portalStateSchema.shape.settings.shape).filter((key) => key !== "version"),
      "setupCompleted"
    ];
    for (const field of fields) expect(classes.filter((list) => list.includes(field)).length, field).toBe(1);
    expect(classes.flat().sort()).toEqual([...new Set(fields)].sort());
  });

  it("makes the pulse lapse thresholds plan preferences an agent writes directly", () => {
    const thresholds = { pulseUnknownToOffMinutes: 45, pulseFurtherPrompts: 2, pulseUnknownHardOffMinutes: 90 };
    expect(isAgentWritableSettings(thresholds)).toBe(true);
    expect(ownerOnlySettingsFieldsIn(thresholds)).toEqual([]);
  });

  it("files a field no class names for the person", () => {
    expect(isAgentWritableSettings({ desiredSleepMinutes: 480, homeLocationId: null })).toBe(true);
    expect(isAgentWritableSettings({ desiredSleepMinutes: 480, someNewSetting: true })).toBe(false);
  });
});

describe("validateGrantableScopes", () => {
  it("accepts known scopes and drops duplicates", () => {
    expect(validateGrantableScopes(["read:plan", "write:entity:action", "read:plan", "write:inbox"])).toEqual({
      scopes: ["read:plan", "write:entity:action", "write:inbox"],
      errors: []
    });
  });
  it("rejects admin scopes, unknown scopes and malformed ones", () => {
    for (const admin of ADMIN_SCOPES) {
      const result = validateGrantableScopes([admin]);
      expect(result.scopes).toEqual([]);
      expect(result.errors[0]).toMatch(/owner only/);
    }
    expect(validateGrantableScopes(["admin:anything"]).errors).toHaveLength(1);
    expect(validateGrantableScopes(["write:entity:nope", "bogus"]).errors).toHaveLength(2);
  });
});

describe("hardFloorReason", () => {
  it("floors removals and names what to do instead", () => {
    expect(hardFloorReason({ tool: "span", action: "remove" })).toBe(
      "removal: deleting a span is the person's call; to shorten it instead, run `rhen span set <span> --end YYYY-MM-DD`"
    );
    expect(hardFloorReason({ tool: "save", entityType: "span", remove: true })).toMatch(/^removal: deleting a span/);
    expect(hardFloorReason({ tool: "save", entityType: "sleep_log_entry", remove: true })).toBe(
      "removal: deleting a logged night is the person's call; to correct its times instead, run `rhen save sleep-log-entry --id <id> --set sleepAt=<time> --set wakeAt=<time>`"
    );
    expect(hardFloorReason({ tool: "save", entityType: "action", remove: true })).toBe(
      "removal: deleting this action is the person's call; " +
        'to take it out of the plan instead, run `rhen cancel action <id> close --reason "<why>"`'
    );
    expect(hardFloorReason({ tool: "save", entityType: "routine_preset", remove: true })).toContain(
      'rhen archive routine_preset <id> close --reason "<why>"`'
    );
    expect(hardFloorReason({ tool: "save", entityType: "capture", remove: true })).toContain(
      "`rhen inbox-act captured ignore <id>`"
    );
    // A kind with no status that takes it out of the plan is the person's, in the portal.
    expect(hardFloorReason({ tool: "save", entityType: "routine_step", remove: true })).toBe(
      "removal: deleting this routine step is the person's call; they do it in the portal"
    );
    expect(hardFloorReason({ tool: "import", action: "delete" })).toBe(
      "removal: deleting an import batch is the person's call (Inbox > Calendar & imports); " +
        "to fix its records instead, run `rhen import update <id> --from <file>`"
    );
    expect(hardFloorReason({ tool: "import", action: "commit", rowCount: 21 })).toBe(
      "bulk: 21 rows is over 20, so the person commits it in Inbox > Calendar & imports; the batch stays a draft for them"
    );
    expect(hardFloorReason({ tool: "import", action: "commit", rowCount: 2, touchesPeople: true })).toBe(
      "touches another person: the batch changes commitments on the family calendar, so the person commits it in " +
        "Inbox > Calendar & imports; the batch stays a draft for them"
    );
    expect(hardFloorReason({ tool: "import", action: "commit", rowCount: 20 })).toBeNull();
    expect(hardFloorReason({ tool: "inbox-act", room: "kept", action: "drop" })).toBe(
      "removal: dropping a kept item is the person's call (Inbox > Someday & reference); " +
        "to send it back to review instead, run `rhen inbox-act kept reopen <id>`"
    );
  });
  it("floors ending a recurrence, and sets the end date on a commitment's rule or on an action", () => {
    expect(hardFloorReason({ tool: "recurrence", action: "end" })).toBe(
      "removal: ending a recurrence is the person's call; to stop it sooner, set an end date: " +
        "`rhen recurrence set --id <rule> --set endDate=YYYY-MM-DD --yes`"
    );
    expect(hardFloorReason({ tool: "recurrence", action: "end", entityType: "action" })).toBe(
      "removal: ending a recurring action is the person's call; to stop it sooner, give it an end date: " +
        "`rhen save action --id <action> --set recurrence.endDate=YYYY-MM-DD`"
    );
  });
  it("floors settings, names the fields that are the person's and where they change them", () => {
    expect(hardFloorReason({ tool: "save", entityType: "settings", settingsFields: ["timezone"] })).toBe(
      "settings: timezone is the person's to change, in Settings > Planning"
    );
    // A plan preference sent with them is not named as guarded, and is told to go on its own; each place is listed once.
    expect(
      hardFloorReason({
        tool: "save",
        entityType: "settings",
        settingsFields: ["sessionBreakMinutes", "setupCompleted", "setupCompletedAt", "pulsePublishEnabled", "newThing"]
      })
    ).toBe(
      "settings: setupCompleted, setupCompletedAt, pulsePublishEnabled, newThing are the person's to change, " +
        "in the Setup page, Settings > Pulse, Settings; " +
        "the plan preferences in this save are not held for that, so send them in a save of their own"
    );
    // Without the fields, the sentence covers the whole guarded class.
    expect(hardFloorReason({ tool: "save", entityType: "settings" })).toBe(
      "settings: timezone, setup and data-flow fields are the person's to change, in Settings"
    );
    expect(hardFloorReason({ tool: "save", entityType: "settings", agentWritableSettings: true })).toBeNull();
  });
  it("places every settings field the person alone changes on a screen, so no refusal says only Settings", () => {
    for (const field of [...PROPOSE_ONLY_SETTINGS_FIELDS, ...OWNER_ONLY_SETTINGS_FIELDS])
      expect(settingsPlace(field), field).not.toBe("Settings");
    expect(settingsPlace("unplacedField")).toBe("Settings");
  });
  it("floors bulk writes above 20 rows only", () => {
    expect(hardFloorReason({ tool: "bulk", entityType: "action", rowCount: 21 })).toBe(
      "bulk: 21 rows is over 20, so the person confirms them as one batch in Inbox > Captured > From agents"
    );
    expect(hardFloorReason({ tool: "bulk", entityType: "action", rowCount: 20 })).toBeNull();
  });
  it("floors anything that touches another person", () => {
    expect(hardFloorReason({ tool: "save", entityType: "commitment", touchesPeople: true })).toBe(
      "touches another person: sharing with the family calendar is the person's call; " +
        "leave shareToCalendar off, and they turn it on in the commitment's Family calendar section"
    );
  });
  it("never tells an agent to unshare a stored record, whose own shareToCalendar rides along on every edit", () => {
    const edit = hardFloorReason({ tool: "save", entityType: "commitment", touchesPeople: true, existing: true });
    expect(edit).toBe(
      "touches another person: a commitment shared with the family calendar, or a change that shares one, " +
        "needs the person's confirm, so this waits for them in Inbox > Captured > From agents"
    );
    const rule = hardFloorReason({ tool: "recurrence", action: "set", touchesPeople: true, existing: true });
    expect(rule).toBe(
      "touches another person: a recurring commitment shared with the family calendar, or a change that shares " +
        "one, is the person's to change, in Schedule > Recurring commitments; tell them the change"
    );
    for (const reason of [edit, rule]) expect(reason).not.toMatch(/shareToCalendar|off/);
    // A new rule can still be set unshared and shared by the person.
    expect(hardFloorReason({ tool: "recurrence", action: "set", touchesPeople: true })).toBe(
      "touches another person: sharing with the family calendar is the person's call; " +
        "set the rule with shareToCalendar off, and they share it in Schedule > Recurring commitments"
    );
  });
  it("does not send an agent ending a shared recurring commitment to an end date it cannot set either", () => {
    const reason = hardFloorReason({ tool: "recurrence", action: "end", touchesPeople: true, existing: true });
    expect(reason).toBe(
      "removal: ending a recurring commitment shared with the family calendar is the person's call, " +
        "and so is giving it an end date; they do it in Schedule > Recurring commitments"
    );
    expect(reason).not.toContain("rhen recurrence set");
  });
  it("leaves an ordinary write off the floor", () => {
    expect(hardFloorReason({ tool: "save", entityType: "commitment" })).toBeNull();
    expect(hardFloorReason({ tool: "session", action: "start" })).toBeNull();
    expect(hardFloorReason({ tool: "capture" })).toBeNull();
    // Undo reverses the agent's own recorded write: it is the safety net, not a removal (scope write:undo).
    expect(hardFloorReason({ tool: "undo" })).toBeNull();
  });
});

describe("hardFloorInstead", () => {
  /** One call per way onto the floor, so a new branch of `hardFloorReason` shows up as a call that lacks a path. */
  const floored: HardFloorCall[] = [
    { tool: "span", action: "remove" },
    { tool: "save", entityType: "span", remove: true },
    { tool: "save", entityType: "sleep_log_entry", remove: true },
    { tool: "save", entityType: "project", remove: true },
    { tool: "save", entityType: "capture", remove: true },
    { tool: "save", entityType: "routine_step", remove: true },
    { tool: "import", action: "delete" },
    { tool: "recurrence", action: "end" },
    { tool: "recurrence", action: "end", entityType: "action" },
    { tool: "inbox-act", room: "kept", action: "drop" },
    { tool: "save", entityType: "settings" },
    { tool: "save", entityType: "settings", settingsFields: ["timezone", "sharePrimaryEvents", "sessionBreakMinutes"] },
    { tool: "bulk", entityType: "action", rowCount: 21 },
    { tool: "save", entityType: "commitment", touchesPeople: true },
    { tool: "save", entityType: "commitment", touchesPeople: true, existing: true },
    { tool: "recurrence", action: "set", touchesPeople: true },
    { tool: "recurrence", action: "set", touchesPeople: true, existing: true },
    { tool: "recurrence", action: "end", touchesPeople: true, existing: true }
  ];

  it("names, for every floored call, a path that sits inside its reason", () => {
    for (const call of floored) {
      const reason = hardFloorReason(call);
      const instead = hardFloorInstead(call);
      expect(reason, JSON.stringify(call)).not.toBeNull();
      expect(instead, JSON.stringify(call)).not.toBeNull();
      expect(reason, JSON.stringify(call)).toContain(instead as string);
      expect(reason, JSON.stringify(call)).toMatch(/^(removal|outward message|settings|bulk|touches another person): /);
      // `propose` files entity saves only; no reason sends an agent there.
      expect(reason, JSON.stringify(call)).not.toContain("rhen propose");
    }
  });

  it("is a command the agent can run, or where in the portal the person does it", () => {
    expect(hardFloorInstead({ tool: "span", action: "remove" })).toBe("rhen span set <span> --end YYYY-MM-DD");
    expect(hardFloorInstead({ tool: "recurrence", action: "end" })).toBe(
      "rhen recurrence set --id <rule> --set endDate=YYYY-MM-DD --yes"
    );
    expect(hardFloorInstead({ tool: "recurrence", action: "end", entityType: "action" })).toBe(
      "rhen save action --id <action> --set recurrence.endDate=YYYY-MM-DD"
    );
    expect(hardFloorInstead({ tool: "import", action: "delete" })).toBe("rhen import update <id> --from <file>");
    expect(hardFloorInstead({ tool: "inbox-act", room: "kept", action: "drop" })).toBe(
      "rhen inbox-act kept reopen <id>"
    );
    expect(hardFloorInstead({ tool: "save", entityType: "project", remove: true })).toBe(
      'rhen cancel project <id> close --reason "<why>"'
    );
    expect(hardFloorInstead({ tool: "save", entityType: "settings", settingsFields: ["timezone"] })).toBe(
      "Settings > Planning"
    );
    expect(
      hardFloorInstead({
        tool: "save",
        entityType: "settings",
        settingsFields: ["timezone", "sharePrimaryEvents", "sessionBreakMinutes"]
      })
    ).toBe("Settings > Planning, Settings > Family calendar sharing");
    expect(hardFloorInstead({ tool: "bulk", rowCount: 21 })).toBe("Inbox > Captured > From agents");
    expect(hardFloorInstead({ tool: "save", entityType: "sleep_log_entry", remove: true })).toBe(
      "rhen save sleep-log-entry --id <id> --set sleepAt=<time> --set wakeAt=<time>"
    );
  });

  it("is null for a call that is not on the floor, exactly when its reason is", () => {
    for (const call of [
      { tool: "save", entityType: "commitment" },
      { tool: "save", entityType: "settings", agentWritableSettings: true },
      { tool: "bulk", entityType: "action", rowCount: 20 },
      { tool: "session", action: "start" },
      { tool: "capture" },
      { tool: "undo" }
    ] satisfies HardFloorCall[]) {
      expect(hardFloorInstead(call), JSON.stringify(call)).toBeNull();
      expect(hardFloorReason(call), JSON.stringify(call)).toBeNull();
    }
  });

  it("gives a status that exists for every kind it tells the agent to set one on", () => {
    // Mirrors the statuses the close tools write to take a record out of the plan; a rename in the schemas fails here.
    const statuses: Record<string, readonly string[]> = {
      area: lifecycleStatusSchema.options,
      outcome: lifecycleStatusSchema.options,
      project: lifecycleStatusSchema.options,
      action: actionStatusSchema.options,
      commitment: commitmentStatusSchema.options,
      routine_preset: routinePresetStatusSchema.options,
      condition_definition: conditionStatusSchema.options
    };
    for (const [kind, allowed] of Object.entries(statuses)) {
      const instead = hardFloorInstead({ tool: "save", entityType: kind, remove: true }) as string;
      // Now the close tool for that kind, which must take the kind, and the status it writes must exist for it.
      const verb = /^rhen (archive|cancel) /.exec(instead)?.[1];
      expect(verb, kind).toBeDefined();
      expect((verb === "archive" ? ARCHIVE_TYPES : CANCEL_TYPES) as readonly string[], kind).toContain(kind);
      expect(allowed, kind).toContain(verb === "archive" ? "archived" : "cancelled");
    }
  });
});

describe("basis and evidence values", () => {
  it("parses a basis", () => {
    expect(parseBasis(" Stated ")).toEqual({ ok: true, value: "stated" });
    expect(parseBasis(null)).toEqual({ ok: true, value: undefined });
    expect(parseBasis("guess").ok).toBe(false);
  });
  it("trims evidence and limits it to 300 characters without control characters", () => {
    expect(parseEvidence("  can we do Friday  ")).toEqual({ ok: true, value: "can we do Friday" });
    expect(parseEvidence("x".repeat(300)).ok).toBe(true);
    expect(parseEvidence("x".repeat(301)).ok).toBe(false);
    expect(parseEvidence("a\nb").ok).toBe(false);
    expect(parseEvidence("a\u0000b").ok).toBe(false);
  });
  it("round-trips non-Latin-1 evidence through the header encoding", () => {
    const quote = "Friday’s fine — 金曜日 🙂";
    expect(parseEvidenceHeader(encodeEvidenceHeader(quote))).toEqual({ ok: true, value: quote });
    expect(parseEvidenceHeader("%E0%A4%A").ok).toBe(false);
    expect(parseEvidenceHeader(encodeEvidenceHeader("a\nb")).ok).toBe(false);
  });
});
