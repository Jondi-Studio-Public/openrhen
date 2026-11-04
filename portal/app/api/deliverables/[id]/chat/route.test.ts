import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSeedState, type PortalState } from "@/state/portal-state";
import { deliverable } from "@/features/deliverables/test-fixtures";

const stateHolder = vi.hoisted(() => ({ current: null as PortalState | null }));
vi.mock("@/server/persistence/state-store", () => ({
  getStateStore: () => ({ get: async () => stateHolder.current })
}));

const chatStoreHolder = vi.hoisted(() => ({
  messages: [] as { id: string; role: string; content: string; attachments: unknown[]; createdAt: string }[],
  coordination: {
    handedOff: false,
    tool: null as string | null,
    since: null as string | null,
    lastDropOffSummary: null as string | null
  }
}));
vi.mock("@/server/persistence/postgres/deliverable-chat-store", () => ({
  withDeliverableChatStore: async (operation: (store: unknown) => Promise<unknown>) =>
    operation({
      list: async () => chatStoreHolder.messages,
      coordinationState: async () => chatStoreHolder.coordination
    })
}));

import { GET, POST } from "./route";

describe("GET /api/deliverables/[id]/chat", () => {
  beforeEach(() => {
    stateHolder.current = { ...createSeedState(new Date("2026-08-25T00:00:00.000Z")), deliverables: [deliverable()] };
    chatStoreHolder.messages = [];
    chatStoreHolder.coordination = { handedOff: false, tool: null, since: null, lastDropOffSummary: null };
  });

  it("returns messages, coordination and prompts for a known deliverable", async () => {
    const response = await GET(new Request("http://x"), { params: Promise.resolve({ id: "assessment-2" }) });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      messages: [],
      coordination: { handedOff: false },
      prompts: {
        handoff: expect.stringContaining("Assessment 2"),
        bringBack: expect.stringContaining("Assessment 2")
      }
    });
  });

  it("404s for an unknown deliverable", async () => {
    const response = await GET(new Request("http://x"), { params: Promise.resolve({ id: "missing" }) });
    expect(response.status).toBe(404);
  });
});

describe("POST /api/deliverables/[id]/chat", () => {
  beforeEach(() => {
    stateHolder.current = { ...createSeedState(new Date("2026-08-25T00:00:00.000Z")), deliverables: [deliverable()] };
    chatStoreHolder.messages = [];
    chatStoreHolder.coordination = { handedOff: false, tool: null, since: null, lastDropOffSummary: null };
  });

  it("refuses a turn while the deliverable is handed off to an external coordinator", async () => {
    chatStoreHolder.coordination = {
      handedOff: true,
      tool: "Claude Desktop",
      since: "2026-09-07T00:00:00.000Z",
      lastDropOffSummary: null
    };
    const response = await POST(new Request("http://x", { method: "POST", body: JSON.stringify({ text: "hi" }) }), {
      params: Promise.resolve({ id: "assessment-2" })
    });
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error).toBe("This deliverable is being coordinated in Claude Desktop. Bring it back first.");
  });

  it("404s for an unknown deliverable", async () => {
    const response = await POST(new Request("http://x", { method: "POST", body: JSON.stringify({ text: "hi" }) }), {
      params: Promise.resolve({ id: "missing" })
    });
    expect(response.status).toBe(404);
  });
});
