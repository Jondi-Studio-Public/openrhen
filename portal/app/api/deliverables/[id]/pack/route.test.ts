import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSeedState, type PortalState } from "@/state/portal-state";
import { criterion, deliverable, session, step } from "@/features/deliverables/test-fixtures";

const stateHolder = vi.hoisted(() => ({ current: null as PortalState | null }));
vi.mock("@/server/persistence/state-store", () => ({
  getStateStore: () => ({ get: async () => stateHolder.current })
}));

const chatHolder = vi.hoisted(() => ({
  messages: [] as {
    id: string;
    role: "user" | "assistant" | "external";
    content: string;
    attachments: unknown[];
    createdAt: string;
    meta?: unknown;
  }[],
  coordination: {
    handedOff: false,
    tool: null as string | null,
    since: null as string | null,
    lastDropOffSummary: null as string | null
  }
}));
vi.mock("@/server/persistence/postgres/deliverable-chat-store", () => ({
  withDeliverableChatStore: async (operation: (store: unknown) => Promise<unknown>) =>
    operation({ list: async () => chatHolder.messages, coordinationState: async () => chatHolder.coordination })
}));

const proposalHolder = vi.hoisted(() => ({
  sources: [
    {
      id: "src-1",
      title: "Brief",
      sourceType: "deliverable_upload",
      capturedText: "Requirements text.",
      capturedTextTruncated: false,
      files: [{ id: "file-1", filename: "brief.pdf", mimeType: "application/pdf", byteSize: 1024 }]
    }
  ]
}));
vi.mock("@/server/persistence/postgres/deliverable-proposal-store", () => ({
  withDeliverableProposalStore: async (operation: (store: unknown) => Promise<unknown>) =>
    operation({ packSources: async () => proposalHolder.sources })
}));

import { GET } from "./route";

const firstStep = step("first", { title: "Draft the outline", status: "planned" });
const secondStep = step("second", { title: "Write the report", status: "planned", dependencyIds: [firstStep.id] });

describe("GET /api/deliverables/[id]/pack", () => {
  beforeEach(() => {
    chatHolder.messages = [
      { id: "m1", role: "user", content: "Let's start.", attachments: [], createdAt: "2026-09-01T00:00:00.000Z" }
    ];
    chatHolder.coordination = { handedOff: false, tool: null, since: null, lastDropOffSummary: null };
    const contract = criterion("done", { title: "Report is complete", stepIds: [firstStep.id, secondStep.id] });
    const fixture = deliverable({ criteria: [contract], steps: [firstStep, secondStep] });
    stateHolder.current = {
      ...createSeedState(new Date("2026-09-07T00:00:00.000Z")),
      deliverables: [fixture],
      activeSession: session({ targetId: fixture.id, actionId: fixture.id, stepId: firstStep.id })
    };
  });

  it("assembles the pack with executable flags, readiness text, sources and transcript", async () => {
    const response = await GET(new Request("http://x"), { params: Promise.resolve({ id: "assessment-2" }) });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.deliverable).toMatchObject({ id: "assessment-2", title: "Assessment 2", phase: "Carry out" });
    const returnedFirst = body.steps.find((s: { id: string }) => s.id === "first");
    const returnedSecond = body.steps.find((s: { id: string }) => s.id === "second");
    expect(returnedFirst).toMatchObject({ title: "Draft the outline", executable: true });
    expect(returnedFirst.readiness).toBeUndefined();
    expect(returnedSecond).toMatchObject({ title: "Write the report", executable: false });
    expect(returnedSecond.readiness).toContain("Draft the outline");
    expect(body.readiness.executableStepIds).toEqual(["first"]);
    expect(body.sources).toEqual([
      {
        id: "src-1",
        title: "Brief",
        sourceType: "deliverable_upload",
        capturedText: "Requirements text.",
        capturedTextTruncated: false,
        files: [
          {
            id: "file-1",
            filename: "brief.pdf",
            mimeType: "application/pdf",
            byteSize: 1024,
            downloadPath: "/api/deliverable-source-files/file-1"
          }
        ]
      }
    ]);
    expect(body.transcript).toEqual([
      { id: "m1", role: "user", content: "Let's start.", createdAt: "2026-09-01T00:00:00.000Z" }
    ]);
    expect(body.coordination).toEqual(chatHolder.coordination);
    expect(body.prompts.handoff).toContain("Assessment 2");
    expect(body.timezone).toBe(stateHolder.current!.settings.timezone);
    expect(body.deliverable.submittedAt).toBeNull();
  });

  it("names prerequisites that are a project or an action", async () => {
    const seed = stateHolder.current!;
    const project = seed.projects[0]!;
    stateHolder.current = {
      ...seed,
      deliverables: seed.deliverables.map((item) => ({ ...item, prerequisites: [{ kind: "project", id: project.id }] }))
    };
    const response = await GET(new Request("http://x"), { params: Promise.resolve({ id: "assessment-2" }) });
    const body = await response.json();
    expect(body.deliverable.prerequisites).toEqual([{ kind: "project", id: project.id, title: project.title }]);
  });

  it("404s for an unknown deliverable", async () => {
    const response = await GET(new Request("http://x"), { params: Promise.resolve({ id: "missing" }) });
    expect(response.status).toBe(404);
  });

  it("reports an awaiting_result deliverable as ineligible even with executable steps left", async () => {
    stateHolder.current!.deliverables[0] = {
      ...stateHolder.current!.deliverables[0]!,
      status: "awaiting_result",
      submittedAt: "2026-09-06T00:00:00.000Z"
    };
    const response = await GET(new Request("http://x"), { params: Promise.resolve({ id: "assessment-2" }) });
    const body = await response.json();
    expect(body.readiness.eligible).toBe(false);
    expect(body.readiness.reason).toContain("waiting on a result");
    expect(body.deliverable.submittedAt).toBe("2026-09-06T00:00:00.000Z");
  });
});
