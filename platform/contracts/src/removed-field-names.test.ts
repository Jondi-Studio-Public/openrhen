import { describe, expect, it } from "vitest";
import { REMOVED_FIELD_NAMES, removedFieldMessage, removedFieldNamesIn } from "./removed-field-names.js";
import { ownerOnlySettingsFieldsIn } from "./agent-scopes.js";
import { scopesForRoute } from "./agent-routes.js";
import { saveCommitmentRecurrenceRuleCommandSchema } from "./planning/commands.js";

describe("the old calendar-sharing field names (migration 0133) are refused", () => {
  it("names each old field and its replacement", () => {
    expect(Object.values(REMOVED_FIELD_NAMES)).toEqual(
      expect.arrayContaining(["shareToCalendar", "calendarShareEnabled"])
    );
    expect(removedFieldNamesIn({ shareWithFamilyEnabled: false, title: "x", shareWithFamily: true })).toEqual([
      "shareWithFamily",
      "shareWithFamilyEnabled"
    ]);
    expect(removedFieldMessage({ shareWithFamily: true })).toBe(
      '"shareWithFamily" is no longer a field: use "shareToCalendar".'
    );
    expect(removedFieldMessage({ shareToCalendar: true, title: "x" })).toBeNull();
  });

  it("refuses an agent save that carries an old name, whatever the entity", () => {
    for (const [entityType, entity, current] of [
      ["commitment", { shareWithFamily: true }, "shareToCalendar"],
      ["settings", { shareWithFamilyEnabled: true }, "calendarShareEnabled"]
    ] as const) {
      const decision = scopesForRoute("POST", "/api/commands/entity", {
        commandId: "c1",
        type: "save_entity",
        entityType,
        entity
      });
      expect(decision).toMatchObject({ kind: "refused", reason: "removed-field" });
      expect(decision.kind === "refused" && decision.message).toContain(`use "${current}"`);
    }
  });

  it("refuses a recurring-commitment rule that carries the old name, and a proposal that wraps one", () => {
    expect(
      scopesForRoute("POST", "/api/commands/commitment-recurrence", { rule: { shareWithFamily: true } })
    ).toMatchObject({
      kind: "refused",
      reason: "removed-field"
    });
    expect(
      scopesForRoute("POST", "/api/agent-proposals", {
        kind: "entity_command",
        payload: {
          command: "save_entity",
          body: { entityType: "commitment", entity: { shareWithFamily: true } }
        }
      })
    ).toMatchObject({ kind: "refused", reason: "removed-field" });
  });

  it("reads the new name for the hard floor and still treats the new settings names as owner only", () => {
    const decision = scopesForRoute("POST", "/api/commands/entity", {
      commandId: "c1",
      type: "save_entity",
      entityType: "commitment",
      entity: { shareToCalendar: true }
    });
    expect(decision).toMatchObject({ kind: "scopes", floor: { touchesPeople: true } });
    expect(ownerOnlySettingsFieldsIn({ calendarShareEnabled: true, sharePrimaryEvents: true }).sort()).toEqual([
      "calendarShareEnabled",
      "sharePrimaryEvents"
    ]);
    expect(ownerOnlySettingsFieldsIn({ shareWithFamilyEnabled: true })).toEqual([]);
  });

  it("fails the rule command's parse with the current field name instead of dropping the old one", () => {
    const rule = {
      id: "r1",
      title: "Shift",
      timezone: "UTC",
      startDate: "2026-11-02",
      repeat: { unit: "weeks", intervalWeeks: 1, weekdays: [1] },
      localStartTime: "09:00",
      localEndTime: "10:00",
      setupBeforeMinutes: 0,
      transitionAfterMinutes: 0
    };
    const ok = saveCommitmentRecurrenceRuleCommandSchema.safeParse({ expectedVersion: null, rule });
    expect(ok.success, JSON.stringify(ok)).toBe(true);
    const bad = saveCommitmentRecurrenceRuleCommandSchema.safeParse({
      expectedVersion: null,
      rule: { ...rule, shareWithFamily: true }
    });
    expect(bad.success).toBe(false);
    expect(JSON.stringify(bad.error?.issues)).toContain('use \\"shareToCalendar\\"');
  });

  it("no longer classifies the old provider-named portal routes for an agent", () => {
    for (const route of ["/api/integrations/google-calendar/sync"])
      expect(scopesForRoute("POST", route), route).toMatchObject({ kind: "refused", reason: "unclassified" });
    expect(scopesForRoute("GET", "/api/connections/[connectionId]/proof")).toMatchObject({ reason: "owner-only" });
  });
});
