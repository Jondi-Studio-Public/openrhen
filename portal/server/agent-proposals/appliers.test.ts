import { beforeEach, describe, expect, it, vi } from "vitest";

const writes = vi.hoisted(() => ({
  saveEntity: vi.fn(),
  saveProject: vi.fn(),
  saveAction: vi.fn(),
  closeEntity: vi.fn()
}));
vi.mock("@/server/persistence/postgres/close-commands", () => ({
  closeEntity: writes.closeEntity,
  closeRowVersion: vi.fn(async () => 5)
}));
vi.mock("@/server/persistence/postgres/entity-commands", () => ({ saveEntity: writes.saveEntity }));
vi.mock("@/server/persistence/postgres/project-commands", () => ({
  saveProject: writes.saveProject,
  saveAction: writes.saveAction
}));

const { CommandConflictError } = await import("@/server/persistence/postgres/command-errors");
const { proposalApplier, proposalKinds, receiptId, registerProposalApplier, versionConflicts } =
  await import("./appliers");

beforeEach(() => {
  for (const mock of Object.values(writes)) mock.mockReset();
});

describe("versionConflicts", () => {
  it("reports each entity whose version moved, and a vanished one", () => {
    expect(versionConflicts({ "project:p": 2, "action:a": 1 }, { "project:p": 3, "action:a": 1 })).toEqual([
      { entity: "project:p", proposedAgainst: 2, current: 3 }
    ]);
    expect(versionConflicts({ "project:p": 2 }, { "project:p": null })).toEqual([
      { entity: "project:p", proposedAgainst: 2, current: null }
    ]);
  });
  it("treats a create against a still-missing record as no conflict", () => {
    expect(versionConflicts({ "project:p": null }, { "project:p": null })).toEqual([]);
  });
});

describe("entity_command applier validation", () => {
  const validate = proposalApplier("entity_command")!.hooks.validate!;
  const project = { id: "p1", outcomeId: "o1", title: "T", status: "active", uncertainty: "some", consequence: 3 };

  it("is registered and names the entity version the command was written against", () => {
    expect(validate({ command: "save_project", body: { expectedVersion: 4, project } })).toEqual({
      ok: true,
      targetVersions: { "project:p1": 4 }
    });
    expect(
      validate({
        command: "save_entity",
        body: {
          expectedVersion: null,
          entityType: "area",
          entity: { id: "a1", name: "Home", status: "active", sortOrder: 1 }
        }
      })
    ).toEqual({ ok: true, targetVersions: { "area:a1": null } });
  });

  it("does not need a commandId in the stored body", () => {
    expect(validate({ command: "save_project", body: { expectedVersion: null, project } }).ok).toBe(true);
  });

  it("requires expectedVersion, so a stale proposal cannot overwrite a newer edit", () => {
    const result = validate({ command: "save_project", body: { project } });
    expect(result.ok).toBe(false);
  });

  it("an action missing fields is refused with the path of each, the complete-action shape and the next call (F10)", () => {
    const result = validate({
      command: "save_action",
      body: { action: { projectId: "p1", title: "x" }, expectedVersion: null }
    }) as { ok: false; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toContain("body.action.id is required");
    expect(result.error).toContain("body.action.expectedMinutes is required");
    expect(result.error).toContain("the COMPLETE action: id, projectId, title, status, optimisticMinutes");
    expect(result.error).toContain("save_entity cannot carry an action");
    expect(result.error).toContain("call rhen_propose again with the same coalesce-key");
    expect(result.error).not.toContain("Invalid input: expected number, received undefined.");
  });

  it("an action sent through save_entity is told to use save_action (F10)", () => {
    const result = validate({
      command: "save_entity",
      body: { entityType: "action", entity: { projectId: "p1", title: "x" }, expectedVersion: null }
    }) as { ok: false; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toContain('body.entityType "action" cannot be sent with command save_entity');
    expect(result.error).toContain("For save_action");
  });

  it("a payload that is not {command, body} names the field path and the right shape (F10)", () => {
    const result = validate({ nope: true }) as { ok: false; error: string };
    expect(result.error).toContain('payload-json.command must be "save_entity", "save_project" or "save_action"');
    expect(result.error).toContain("none was sent");
  });

  it("refuses a payload that is not one of the three commands or whose body is invalid", () => {
    expect(validate({ command: "delete_everything", body: {} }).ok).toBe(false);
    expect(validate({ command: "save_project", body: { expectedVersion: 1, project: { id: "p1" } } }).ok).toBe(false);
    expect(validate({ nope: true }).ok).toBe(false);
  });
});

describe("what a proposal may hold, and the line the person reads", () => {
  const entity = proposalApplier("entity_command")!;
  const batch = proposalApplier("entity_command_batch")!;
  const settings = (fields: Record<string, unknown>) => ({
    command: "save_entity",
    body: { expectedVersion: 1, entityType: "settings", entity: fields }
  });
  const context = { sql: {} as never, userId: "user-1" };

  it("refuses a data-flow setting, a contract review or a confirmed capture, alone or inside a batch", () => {
    const bad = [
      settings({ desiredSleepMinutes: 480, pulsePublishEnabled: true }),
      {
        command: "save_entity",
        body: { expectedVersion: null, entityType: "deliverable_contract_review", entity: {} }
      },
      {
        command: "save_entity",
        body: { expectedVersion: null, entityType: "capture", entity: { status: "confirmed" } }
      }
    ];
    for (const payload of bad) {
      expect(entity.hooks.validate!(payload)).toMatchObject({ ok: false });
      expect(batch.hooks.validate!({ commands: [payload] })).toMatchObject({ ok: false });
    }
  });

  it("refuses on confirm a proposal filed before the rule, instead of applying it", async () => {
    await expect(
      entity.apply(context, {
        id: "11111111-1111-4111-8111-111111111111",
        agent: "scribe",
        kind: "entity_command",
        payload: settings({ calendarShareEnabled: true }),
        targetVersions: {}
      })
    ).rejects.toThrow(/cannot be confirmed: settings: calendarShareEnabled is the person's/);
  });

  it("replays under the proposal's own id, whatever commandId the stored body names", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const project = { id: "p1", outcomeId: "o1", title: "T", status: "active", uncertainty: "some", consequence: 3 };
    await entity.apply(context, {
      id,
      agent: "scribe",
      kind: "entity_command",
      payload: {
        command: "save_project",
        body: { commandId: "22222222-2222-4222-8222-222222222222", expectedVersion: null, project }
      },
      targetVersions: {}
    });
    expect(writes.saveProject.mock.calls[0]![1]).toMatchObject({ commandId: id });
  });

  it("checks every batch row before applying any, so a refused row leaves nothing written", async () => {
    const area = {
      command: "save_entity",
      body: {
        expectedVersion: null,
        entityType: "area",
        entity: { id: "a1", name: "Home", status: "active", sortOrder: 1 }
      }
    };
    await expect(
      batch.apply(context, {
        id: "11111111-1111-4111-8111-111111111111",
        agent: "scribe",
        kind: "entity_command_batch",
        payload: { commands: [area, settings({ pulsePublishEnabled: true })] },
        targetVersions: {}
      })
    ).rejects.toThrow(/row 2 of 2/);
    expect(writes.saveEntity).not.toHaveBeenCalled();
  });

  it("gives each batch row a receipt of its revision, so a coalesced replacement never replays an earlier one", async () => {
    const area = {
      command: "save_entity",
      body: {
        expectedVersion: null,
        entityType: "area",
        entity: { id: "a1", name: "Home", status: "active", sortOrder: 1 }
      }
    };
    const apply = (revision: number) =>
      batch.apply(context, {
        id: "11111111-1111-4111-8111-111111111111",
        agent: "scribe",
        kind: "entity_command_batch",
        payload: { commands: [area] },
        targetVersions: {},
        revision
      });
    await apply(1);
    await apply(1);
    await apply(2);
    const ids = writes.saveEntity.mock.calls.map((call) => (call[1] as { commandId: string }).commandId);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[2]).not.toBe(ids[0]);
  });

  it("an atomic batch writes every row inside one transaction and keeps none when a row conflicts", async () => {
    const area = (id: string) => ({
      command: "save_entity",
      body: { expectedVersion: 2, entityType: "area", entity: { id, name: "Home", status: "active", sortOrder: 1 } }
    });
    const inside: unknown[] = [];
    const tx = { savepoint: vi.fn() };
    const begin = vi.fn(async (run: (tx: unknown) => Promise<unknown>) => run(tx));
    const atomicContext = { sql: { begin } as never, userId: "user-1" };
    const proposal = {
      id: "11111111-1111-4111-8111-111111111111",
      agent: "scribe",
      kind: "entity_command_batch",
      payload: { atomic: true, commands: [area("a1"), area("a2")] },
      targetVersions: {}
    };
    writes.saveEntity.mockImplementation((sql: unknown) => {
      inside.push(sql);
      return Promise.resolve({});
    });
    await batch.apply(atomicContext, proposal);
    expect(begin).toHaveBeenCalledTimes(1);
    expect(inside).toHaveLength(2);
    expect(inside.every((sql) => sql !== atomicContext.sql)).toBe(true);

    // The second row is stale: the error leaves the transaction, so the first row's write is rolled back with it.
    begin.mockClear();
    writes.saveEntity.mockReset();
    writes.saveEntity.mockResolvedValueOnce({}).mockRejectedValueOnce(new CommandConflictError("moved"));
    await expect(batch.apply(atomicContext, proposal)).rejects.toThrow(/Row 2 of 2.*moved/);
    expect(begin).toHaveBeenCalledTimes(1);
  });

  it("a non-atomic batch does not open a transaction", async () => {
    const begin = vi.fn();
    await batch.apply(
      { sql: { begin } as never, userId: "user-1" },
      {
        id: "11111111-1111-4111-8111-111111111111",
        agent: "scribe",
        kind: "entity_command_batch",
        payload: {
          commands: [
            {
              command: "save_entity",
              body: {
                expectedVersion: null,
                entityType: "area",
                entity: { id: "a1", name: "H", status: "active", sortOrder: 1 }
              }
            }
          ]
        },
        targetVersions: {}
      }
    );
    expect(begin).not.toHaveBeenCalled();
  });

  it("writes a batch's line from its rows", async () => {
    const area = (id: string, name: string) => ({
      command: "save_entity" as const,
      body: { expectedVersion: null, entityType: "area", entity: { id, name, status: "active", sortOrder: 1 } }
    });
    expect(await batch.hooks.summarize!(context, { commands: [area("a1", "Home"), area("a2", "Work")] })).toBe(
      '2 changes: Create area "Home"; Create area "Work"'
    );
  });
});

describe("registerProposalApplier", () => {
  it("lets a later feature plug in its own kind", () => {
    registerProposalApplier("settle_catch_up_test", async () => "done");
    expect(proposalApplier("settle_catch_up_test")).toBeDefined();
    expect(proposalApplier("never_registered")).toBeUndefined();
  });
});

describe("close_entity applier", () => {
  const hooks = proposalApplier("close_entity")!.hooks;
  const payload = {
    type: "project",
    verb: "archive",
    id: "p1",
    do: "close",
    expectedVersion: 4,
    reason: "done",
    includeChildren: true,
    children: [{ type: "action", id: "a1", version: 2 }]
  };
  const stored = {
    id: "11111111-1111-4111-8111-111111111111",
    agent: "scribe",
    kind: "close_entity",
    payload,
    targetVersions: {}
  };

  it("is filed by the server only, so rhen_propose does not list it", () => {
    expect(proposalKinds()).not.toContain("close_entity");
    expect(proposalKinds()).not.toContain("entity_command_batch");
    expect(proposalKinds()).not.toContain("settle_catch_up");
    expect(proposalKinds()).toContain("entity_command");
  });

  it("pins the target at the version the call was decided against", () => {
    expect(hooks.validate!(payload)).toEqual({ ok: true, targetVersions: { "project:p1": 4 } });
    const { expectedVersion: _version, ...unpinned } = payload;
    expect(hooks.validate!(unpinned)).toEqual({ ok: true, targetVersions: {} });
    expect(hooks.validate!({ ...payload, do: "restore", expectedVersion: undefined }).ok).toBe(false);
    expect(hooks.validate!({ ...payload, type: "spaceship" }).ok).toBe(false);
  });

  it("reads the live version of the target, so a moved row is stale", async () => {
    const current = await hooks.currentVersions!(
      { sql: {} as never, userId: "u1" },
      { ...stored, targetVersions: { "deliverable:d1": 4 } }
    );
    expect(current).toEqual({ "deliverable:d1": 5 });
  });

  it("summarises from the payload", async () => {
    expect(await hooks.summarize!({ sql: {} as never, userId: "u1" }, payload)).toBe(
      'Archive project "p1" and 1 item under it: done'
    );
    expect(
      await hooks.summarize!(
        { sql: {} as never, userId: "u1" },
        { ...payload, do: "restore", children: [], reason: undefined }
      )
    ).toBe('Restore project "p1"');
  });

  it("replays the close under the proposal's receipt and requires the pinned children to be the live set", async () => {
    writes.closeEntity.mockResolvedValue({ closed: { ok: true }, state: {} });
    await proposalApplier("close_entity")!.apply({ sql: {} as never, userId: "u1" }, stored);
    const [, command, options] = writes.closeEntity.mock.calls[0]!;
    expect(command).toMatchObject({ type: "project", id: "p1", do: "close", commandId: receiptId(stored) });
    expect(command).not.toHaveProperty("children");
    expect(options).toEqual({ expectedChildren: [{ type: "action", id: "a1", version: 2 }] });
  });

  it("passes no child check for a restore", async () => {
    writes.closeEntity.mockResolvedValue({ closed: { ok: true }, state: {} });
    await proposalApplier("close_entity")!.apply(
      { sql: {} as never, userId: "u1" },
      { ...stored, payload: { ...payload, do: "restore" } }
    );
    expect(writes.closeEntity.mock.calls[0]![2]).toEqual({});
  });

  it("lets a stale child set surface as a conflict", async () => {
    writes.closeEntity.mockRejectedValue(new CommandConflictError("different items"));
    await expect(
      proposalApplier("close_entity")!.apply({ sql: {} as never, userId: "u1" }, stored)
    ).rejects.toBeInstanceOf(CommandConflictError);
  });
});
