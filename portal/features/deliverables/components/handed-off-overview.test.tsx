// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/test/render";
import type { CoordinationMessage, CoordinationPrompts } from "@/features/deliverables/use-coordination";
import type { CoordinationState } from "@openrhen/contracts";
import { HandedOffOverview } from "./handed-off-overview";
import { assess, deliverable, session, step, criterion, fixtureNow } from "@/features/deliverables/test-fixtures";

const coordinationMessage = (overrides: Partial<CoordinationMessage> = {}): CoordinationMessage => ({
  id: crypto.randomUUID(),
  role: "assistant",
  content: "Here's what we did",
  attachments: [],
  createdAt: "2026-09-07T10:00:00.000Z",
  ...overrides
});

function mockFetch(handlers: Record<string, (init?: RequestInit) => unknown>) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${String(input)}`;
    const handler = handlers[key];
    if (!handler) throw new Error(`Unexpected request ${key}`);
    const result = handler(init);
    return result instanceof Response ? result : new Response(JSON.stringify(result), { status: 200 });
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("HandedOffOverview", () => {
  it("renders the heading with the coordinator tool name and since time", async () => {
    const testDeliverable = deliverable({
      contractApprovedAt: fixtureNow.toISOString(),
      planApprovedAt: fixtureNow.toISOString(),
      steps: [step("a"), step("b")],
      criteria: [criterion("c", { stepIds: ["a", "b"] })]
    });
    const readiness = assess(testDeliverable);
    const coordination: CoordinationState = {
      handedOff: true,
      tool: "Claude Desktop",
      since: "2026-09-07T00:00:00.000Z",
      lastDropOffSummary: null
    };

    vi.stubGlobal(
      "fetch",
      mockFetch({
        "GET /api/deliverables/test-id/chat": () => ({
          messages: [],
          coordination,
          prompts: { handoff: "Pick up...", bringBack: "Drop off..." }
        })
      })
    );

    render(
      <HandedOffOverview
        deliverableId="test-id"
        deliverable={testDeliverable}
        readiness={readiness}
        engine={null}
        conditionDefinitions={[]}
        session={null}
        now={fixtureNow}
        currentStepTitle={undefined}
        timezone="Australia/Brisbane"
      />
    );

    const heading = await screen.findByText(/Coordinated in Claude Desktop since/);
    expect(heading).toBeTruthy();
  });

  it("renders phase and step progress", () => {
    const testDeliverable = deliverable({
      contractApprovedAt: fixtureNow.toISOString(),
      planApprovedAt: fixtureNow.toISOString(),
      steps: [step("a", { status: "done" }), step("b", { status: "doing" }), step("c", { status: "planned" })],
      criteria: [criterion("c", { stepIds: ["a", "b", "c"] })]
    });
    const readiness = assess(testDeliverable);

    vi.stubGlobal(
      "fetch",
      mockFetch({
        "GET /api/deliverables/test-id/chat": () => ({
          messages: [],
          coordination: {
            handedOff: true,
            tool: "Claude Desktop",
            since: "2026-09-07T00:00:00.000Z",
            lastDropOffSummary: null
          },
          prompts: { handoff: "Pick up...", bringBack: "Drop off..." }
        })
      })
    );

    render(
      <HandedOffOverview
        deliverableId="test-id"
        deliverable={testDeliverable}
        readiness={readiness}
        engine={null}
        conditionDefinitions={[]}
        session={null}
        now={fixtureNow}
        currentStepTitle={undefined}
        timezone="Australia/Brisbane"
      />
    );

    expect(screen.getByText(/Do the work · 1 of 3 actions done/)).toBeTruthy();
  });

  it("lists external notes oldest-first, excluding user and assistant roles", async () => {
    const testDeliverable = deliverable({
      contractApprovedAt: fixtureNow.toISOString(),
      planApprovedAt: fixtureNow.toISOString(),
      steps: [step("a")],
      criteria: [criterion("c", { stepIds: ["a"] })]
    });
    const readiness = assess(testDeliverable);

    vi.stubGlobal(
      "fetch",
      mockFetch({
        "GET /api/deliverables/test-id/chat": () => ({
          messages: [
            coordinationMessage({
              role: "user",
              content: "User message (should not appear)",
              createdAt: "2026-09-07T08:00:00.000Z"
            }),
            coordinationMessage({
              role: "external",
              content: "First note",
              createdAt: "2026-09-07T10:00:00.000Z",
              meta: { kind: "note", tool: "Claude Desktop" }
            }),
            coordinationMessage({
              role: "external",
              content: "Second note",
              createdAt: "2026-09-07T11:00:00.000Z",
              meta: { kind: "note", tool: "Claude Desktop" }
            }),
            coordinationMessage({
              role: "assistant",
              content: "Assistant message (should not appear)",
              createdAt: "2026-09-07T12:00:00.000Z"
            })
          ],
          coordination: {
            handedOff: true,
            tool: "Claude Desktop",
            since: "2026-09-07T00:00:00.000Z",
            lastDropOffSummary: null
          },
          prompts: { handoff: "Pick up...", bringBack: "Drop off..." }
        })
      })
    );

    render(
      <HandedOffOverview
        deliverableId="test-id"
        deliverable={testDeliverable}
        readiness={readiness}
        engine={null}
        conditionDefinitions={[]}
        session={null}
        now={fixtureNow}
        currentStepTitle={undefined}
        timezone="Australia/Brisbane"
      />
    );

    expect(screen.queryByText("User message (should not appear)")).toBeNull();
    expect(screen.queryByText("Assistant message (should not appear)")).toBeNull();

    const firstNote = await screen.findByText("First note");
    expect(firstNote).toBeTruthy();
    const secondNote = screen.getByText("Second note");
    expect(secondNote).toBeTruthy();

    const firstNoteElement = firstNote.closest("li");
    const secondNoteElement = secondNote.closest("li");
    expect(firstNoteElement?.compareDocumentPosition(secondNoteElement!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("POSTs to /api/deliverables/<id>/handoff when taking back without a summary", async () => {
    const testDeliverable = deliverable({
      contractApprovedAt: fixtureNow.toISOString(),
      planApprovedAt: fixtureNow.toISOString(),
      steps: [step("a")],
      criteria: [criterion("c", { stepIds: ["a"] })]
    });
    const readiness = assess(testDeliverable);
    const sent: unknown[] = [];

    let callCount = 0;
    vi.stubGlobal(
      "fetch",
      mockFetch({
        "GET /api/deliverables/test-id/chat": () => {
          callCount++;
          return {
            messages: [],
            coordination:
              callCount === 1
                ? {
                    handedOff: true,
                    tool: "Claude Desktop",
                    since: "2026-09-07T00:00:00.000Z",
                    lastDropOffSummary: null
                  }
                : { handedOff: false, tool: null, since: null, lastDropOffSummary: null },
            prompts: { handoff: "Pick up...", bringBack: "Drop off..." }
          };
        },
        "POST /api/deliverables/test-id/handoff": (init) => {
          sent.push(JSON.parse(String(init?.body)));
          return {
            coordination: { handedOff: false, tool: null, since: null, lastDropOffSummary: null },
            row: null
          };
        }
      })
    );

    render(
      <HandedOffOverview
        deliverableId="test-id"
        deliverable={testDeliverable}
        readiness={readiness}
        engine={null}
        conditionDefinitions={[]}
        session={null}
        now={fixtureNow}
        currentStepTitle={undefined}
        timezone="Australia/Brisbane"
      />
    );

    const takeBackButton = screen.getByRole("button", { name: "Take back without a summary" });
    fireEvent.click(takeBackButton);

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(sent).toEqual([{ kind: "drop_off", tool: "portal", text: "" }]);
  });

  it("reveals the bring-back prompt and Copy button when clicking 'Bring back to the portal'", async () => {
    const testDeliverable = deliverable({
      contractApprovedAt: fixtureNow.toISOString(),
      planApprovedAt: fixtureNow.toISOString(),
      steps: [step("a")],
      criteria: [criterion("c", { stepIds: ["a"] })]
    });
    const readiness = assess(testDeliverable);
    const prompts: CoordinationPrompts = {
      handoff: "Pick up...",
      bringBack: "Please hand this back: run `rhen deliverable drop-off <id>`"
    };

    vi.stubGlobal(
      "fetch",
      mockFetch({
        "GET /api/deliverables/test-id/chat": () => ({
          messages: [],
          coordination: {
            handedOff: true,
            tool: "Claude Desktop",
            since: "2026-09-07T00:00:00.000Z",
            lastDropOffSummary: null
          },
          prompts
        })
      })
    );

    render(
      <HandedOffOverview
        deliverableId="test-id"
        deliverable={testDeliverable}
        readiness={readiness}
        engine={null}
        conditionDefinitions={[]}
        session={null}
        now={fixtureNow}
        currentStepTitle={undefined}
        timezone="Australia/Brisbane"
      />
    );

    await screen.findByRole("button", { name: "Bring back to the portal" });
    const bringBackButton = screen.getByRole("button", { name: "Bring back to the portal" });
    fireEvent.click(bringBackButton);

    const textarea = await screen.findByDisplayValue(/Please hand this back/);
    expect(textarea).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy" })).toBeTruthy();
  });

  it("renders session line with step title and elapsed time when session is provided", async () => {
    const testDeliverable = deliverable({
      contractApprovedAt: fixtureNow.toISOString(),
      planApprovedAt: fixtureNow.toISOString(),
      steps: [step("a", { title: "Review the outline" })],
      criteria: [criterion("c", { stepIds: ["a"] })]
    });
    const readiness = assess(testDeliverable);
    const testSession = session({
      targetId: "test-id",
      stepId: "a",
      activeElapsedSeconds: 600
    });

    vi.stubGlobal(
      "fetch",
      mockFetch({
        "GET /api/deliverables/test-id/chat": () => ({
          messages: [],
          coordination: {
            handedOff: true,
            tool: "Claude Desktop",
            since: "2026-09-07T00:00:00.000Z",
            lastDropOffSummary: null
          },
          prompts: { handoff: "Pick up...", bringBack: "Drop off..." }
        })
      })
    );

    render(
      <HandedOffOverview
        deliverableId="test-id"
        deliverable={testDeliverable}
        readiness={readiness}
        engine={null}
        conditionDefinitions={[]}
        session={testSession}
        now={fixtureNow}
        currentStepTitle="Review the outline"
        timezone="Australia/Brisbane"
      />
    );

    const sessionLine = screen.getByText(/Session:/);
    expect(sessionLine.textContent).toContain("Review the outline");
    expect(sessionLine.textContent).toContain("elapsed");
  });

  it("does not render a session line when session is null", () => {
    const testDeliverable = deliverable({
      contractApprovedAt: fixtureNow.toISOString(),
      planApprovedAt: fixtureNow.toISOString(),
      steps: [step("a")],
      criteria: [criterion("c", { stepIds: ["a"] })]
    });
    const readiness = assess(testDeliverable);

    vi.stubGlobal(
      "fetch",
      mockFetch({
        "GET /api/deliverables/test-id/chat": () => ({
          messages: [],
          coordination: {
            handedOff: true,
            tool: "Claude Desktop",
            since: "2026-09-07T00:00:00.000Z",
            lastDropOffSummary: null
          },
          prompts: { handoff: "Pick up...", bringBack: "Drop off..." }
        })
      })
    );

    render(
      <HandedOffOverview
        deliverableId="test-id"
        deliverable={testDeliverable}
        readiness={readiness}
        engine={null}
        conditionDefinitions={[]}
        session={null}
        now={fixtureNow}
        currentStepTitle={undefined}
        timezone="Australia/Brisbane"
      />
    );

    expect(screen.queryByText(/Session:/)).toBeNull();
  });
});
