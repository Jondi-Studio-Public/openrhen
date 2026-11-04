import { describe, expect, it, vi } from "vitest";
import type { PortalClient } from "../client.js";
import type { CommandContext } from "../command.js";
import { inboxCommand } from "./inbox.js";

function run(captures: unknown[], get: (path: string) => Promise<unknown>, room?: string) {
  const stdout: string[] = [];
  const client: PortalClient = {
    baseUrl: "http://localhost:8787",
    getState: vi.fn().mockResolvedValue({ captures }),
    get: get as PortalClient["get"],
    post: vi.fn()
  };
  const ctx: CommandContext = {
    client,
    mode: "json",
    now: () => new Date("2026-10-05T00:00:00Z"),
    stdout: (t) => stdout.push(t),
    stderr: () => {},
    setExitCode: () => {}
  };
  return inboxCommand.run(ctx, { positionals: room ? [room] : [], values: {} }).then(() => JSON.parse(stdout[0]!));
}

describe("inbox", () => {
  it("groups open items by room and reports a room it cannot read without hiding the rest", async () => {
    const get = vi.fn(async (path: string) => {
      if (path === "/api/imports")
        return {
          batches: [
            {
              id: "b1",
              sourceType: "example_shared",
              inputKind: "calendar",
              status: "ready",
              filename: null,
              recordCount: 3,
              blockingCount: 0
            }
          ]
        };
      return {
        findings: [
          { id: "f1", checkName: "orphan", text: "Project has no deliverable", status: "open", questions: [] }
        ],
        links: [
          {
            id: "l1",
            status: "suggested",
            kind: "about",
            fromType: "action",
            fromId: "a",
            toType: "subject",
            toId: "s"
          }
        ]
      };
    });
    const rooms = await run(
      [
        { id: "c1", status: "pending", proposalType: "fixed_commitment", text: "Dentist Tuesday" },
        {
          id: "c2",
          status: "pending",
          proposalType: "email_change",
          sourceType: "email_thread",
          proposedFields: { threadId: "t" }
        },
        { id: "c3", status: "confirmed", proposalType: "someday", text: "Learn piano" }
      ],
      get
    );
    const byRoom = Object.fromEntries(rooms.map((r: { room: string }) => [r.room, r]));
    expect(byRoom.captured.count).toBe(1);
    expect(byRoom.kept.count).toBe(1);
    expect(byRoom.calendar.count).toBe(1);
    expect(byRoom.map.count).toBe(2);
  });

  it("lists one room and rejects an unknown one", async () => {
    const rooms = await run([], async () => ({}), "captured");
    expect(rooms).toHaveLength(1);
    await expect(run([], async () => ({}), "nope")).rejects.toThrow(/Unknown room/);
  });
});
