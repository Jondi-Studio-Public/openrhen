import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSeedState, type PortalState } from "@/state/portal-state";
import { deliverable } from "@/features/deliverables/test-fixtures";

const stateHolder = vi.hoisted(() => ({ current: null as PortalState | null }));
vi.mock("@/server/persistence/state-store", () => ({
  getStateStore: () => ({ get: async () => stateHolder.current })
}));

const chatHolder = vi.hoisted(() => ({
  coordination: {
    handedOff: false,
    tool: null as string | null,
    since: null as string | null,
    lastDropOffSummary: null as string | null
  },
  appended: [] as { role: string; content: string; meta?: { kind: string; tool: string } }[]
}));
vi.mock("@/server/persistence/postgres/deliverable-chat-store", () => ({
  withDeliverableChatStore: async (operation: (store: unknown) => Promise<unknown>) =>
    operation({
      coordinationState: async () => chatHolder.coordination,
      append: async (
        _id: string,
        role: string,
        content: string,
        _attachments: unknown[],
        meta?: { kind: string; tool: string }
      ) => {
        chatHolder.appended.push({ role, content, ...(meta ? { meta } : {}) });
        return {
          id: `row-${chatHolder.appended.length}`,
          role,
          content,
          attachments: [],
          createdAt: "2026-09-07T00:00:00.000Z",
          ...(meta ? { meta } : {})
        };
      }
    })
}));

import { POST } from "./route";

function post(id: string, body: unknown) {
  return POST(new Request("http://x", { method: "POST", body: JSON.stringify(body) }), {
    params: Promise.resolve({ id })
  });
}

describe("POST /api/deliverables/[id]/handoff", () => {
  beforeEach(() => {
    stateHolder.current = { ...createSeedState(new Date("2026-09-07T00:00:00.000Z")), deliverables: [deliverable()] };
    chatHolder.coordination = { handedOff: false, tool: null, since: null, lastDropOffSummary: null };
    chatHolder.appended = [];
  });

  it("records a pick-up with generated content when no text is given", async () => {
    const response = await post("assessment-2", { kind: "pick_up", tool: "Claude Desktop" });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.row).toMatchObject({
      role: "external",
      content: "Picked up in Claude Desktop",
      meta: { kind: "pick_up", tool: "Claude Desktop" }
    });
    expect(chatHolder.appended).toHaveLength(1);
  });

  it("records a drop-off with the given summary text", async () => {
    const response = await post("assessment-2", { kind: "drop_off", tool: "Codex CLI", text: "Finished the outline." });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.row).toMatchObject({ content: "Finished the outline.", meta: { kind: "drop_off", tool: "Codex CLI" } });
  });

  it("records nothing for a second pick-up by the same tool while already handed off", async () => {
    chatHolder.coordination = {
      handedOff: true,
      tool: "Claude Desktop",
      since: "2026-09-07T00:00:00.000Z",
      lastDropOffSummary: null
    };
    const response = await post("assessment-2", { kind: "pick_up", tool: "Claude Desktop" });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.row).toBeNull();
    expect(chatHolder.appended).toHaveLength(0);
  });

  it("records a fresh pick-up when a different tool takes over", async () => {
    chatHolder.coordination = {
      handedOff: true,
      tool: "Claude Desktop",
      since: "2026-09-07T00:00:00.000Z",
      lastDropOffSummary: null
    };
    const response = await post("assessment-2", { kind: "pick_up", tool: "Codex CLI" });
    const body = await response.json();
    expect(body.row).not.toBeNull();
    expect(chatHolder.appended).toHaveLength(1);
  });

  it("400s a note with no text", async () => {
    const response = await post("assessment-2", { kind: "note", tool: "Claude Desktop" });
    expect(response.status).toBe(400);
    expect(chatHolder.appended).toHaveLength(0);
  });

  it("404s for an unknown deliverable", async () => {
    const response = await post("missing", { kind: "pick_up", tool: "Claude Desktop" });
    expect(response.status).toBe(404);
  });

  it("400s an invalid request body", async () => {
    const response = await post("assessment-2", { kind: "not_a_real_kind" });
    expect(response.status).toBe(400);
  });
});
