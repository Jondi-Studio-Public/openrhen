// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@/test/render";
import { createSeedState } from "@/state/portal-state";
import type { PortalState, ActiveSession, StoredDeliverableContractProposal } from "@/state/portal-state";
import { freezeClock } from "@/shared/clock";
import {
  deliverable as deliverableFixture,
  step as stepFixture,
  criterion as criterionFixture
} from "@/features/deliverables/test-fixtures";
import type { ConditionDefinition } from "@/features/settings/context-summary";
import type { CheckInPrompt } from "@/state/portal-provider";
import { requirementPathwaySchema } from "@openrhen/contracts";
// A static import, not a dynamic one inside each `it()` — see `now-page.test.tsx`'s own note on why:
// paying the page's large import graph transform cost once, at file-import time, keeps it off each
// test's individual timeout budget.
import DeliverablesPage from "./page";

const now = new Date("2026-08-18T10:00:00.000Z");
const seed = createSeedState(now);
const state = {
  ...seed,
  deliverables: [
    deliverableFixture({
      id: "assessment-1",
      projectId: "networking-assignment",
      title: "Assessment 1 – written assessment"
    })
  ]
};
freezeClock(now);

// The page reads everything through the portal context, so a partial context stands in for the
// provider; only the fields this composition touches are given real values.
const context = {
  state,
  saving: false,
  recommendation: { candidates: [], primary: null },
  continuation: null,
  pendingCheckIn: null as CheckInPrompt | null,
  dismissPendingCheckIn: vi.fn(),
  saveEntityCommand: vi.fn(),
  runActivityCommand: vi.fn(),
  finishSession: vi.fn(),
  acceptServerState: vi.fn()
};
vi.mock("@/state/portal-provider", () => ({ usePortal: () => context }));

// `finish` claims it navigates the reader away; this is the seam a test can watch — see
// `shared/navigate.ts`'s own doc comment on why `window.location.assign` cannot be observed directly.
const navigateTo = vi.fn();
vi.mock("@/shared/navigate", () => ({ navigateTo: (href: string) => navigateTo(href) }));

function checkIn(): CheckInPrompt {
  return {
    id: "check-in-1",
    version: 1,
    status: "pending",
    slotAt: now.toISOString(),
    directiveKind: "deliverable",
    directiveTitle: "Assessment 1 – written assessment"
  };
}

beforeEach(() => {
  navigateTo.mockClear();
  window.matchMedia = ((query: string) =>
    ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {}
    }) as unknown as MediaQueryList) as typeof window.matchMedia;
  window.localStorage.clear();
  // `ChatPanel` (mounted inside the workspace) loads its history on mount without any test
  // interaction. It needs a shape its reader accepts, or an uncaught rejection inside a `.then` crashes
  // the tree before the assertions below ever run.
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ messages: [] }) }))
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  context.pendingCheckIn = null;
  context.state = state;
});

async function openWorkspace(title = "Assessment 1 – written assessment") {
  render(<DeliverablesPage />);
  fireEvent.click(await screen.findByRole("button", { name: new RegExp(`^${title}`) }));
  await screen.findByRole("heading", { name: title });
}

describe("Deliverable workbench composition", () => {
  it("renders no check-in banner when there is no pending check-in", async () => {
    await openWorkspace();
    expect(document.querySelector(".check-in-banner")).toBeNull();
  });

  it("renders the check-in banner at the very top of the workbench when one is pending", async () => {
    context.pendingCheckIn = checkIn();
    await openWorkspace();
    const main = document.querySelector("main.deliverable-workspace");
    const banner = document.querySelector(".check-in-banner");
    expect(banner).not.toBeNull();
    // Above the workbench content, not merely present somewhere on the page: the very first child of
    // the workspace's own <main>, ahead of the header, phase bar and conversation.
    expect(main?.firstElementChild).toBe(banner);
  });
});

describe("Coordination-driven conversation column", () => {
  it("renders the chat composer, not the handed-off overview, when the deliverable is not coordinated externally", async () => {
    const runningSession: ActiveSession = {
      id: "session-assessment-1",
      actionId: "assessment-1",
      targetType: "deliverable",
      targetId: "assessment-1",
      targetTitle: "Assessment 1 – written assessment",
      status: "running",
      startedAt: new Date(now.getTime() - 300_000).toISOString(),
      plannedEndAt: new Date(now.getTime() + 900_000).toISOString(),
      plannedMinutes: 20,
      remainingBeforeMinutes: 90,
      activeElapsedSeconds: 300
    };
    context.state = { ...state, activeSession: runningSession };
    await openWorkspace();
    // ChatPanel is mounted and editable: its composer is accessible via its aria-label
    expect(await screen.findByLabelText("Message the assistant")).toBeTruthy();
    // HandedOffOverview is not mounted
    expect(document.querySelector(".handed-off-overview")).toBeNull();
  });

  it("renders the handed-off overview instead of the chat panel when the deliverable is coordinated externally", async () => {
    const runningSession: ActiveSession = {
      id: "session-assessment-1",
      actionId: "assessment-1",
      targetType: "deliverable",
      targetId: "assessment-1",
      targetTitle: "Assessment 1 – written assessment",
      status: "running",
      startedAt: new Date(now.getTime() - 300_000).toISOString(),
      plannedEndAt: new Date(now.getTime() + 900_000).toISOString(),
      plannedMinutes: 20,
      remainingBeforeMinutes: 90,
      activeElapsedSeconds: 300
    };
    context.state = { ...state, activeSession: runningSession };
    // Override the fetch stub to return coordination data for this test only
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/health/database"))
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ provider: "postgres", connected: true, version: "16.4, test", latencyMs: 1 })
        });
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            messages: [],
            coordination: {
              handedOff: true,
              tool: "Claude Desktop",
              since: "2026-08-18T09:00:00.000Z",
              lastDropOffSummary: null
            },
            prompts: {
              handoff: "Run pick-up.",
              bringBack: "Run drop-off."
            }
          })
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    await openWorkspace();
    // The chat panel loads the conversation, reads "handed off" and swaps itself for the overview, which
    // loads it again. Settle every fetch round inside act() instead of polling against a 1s clock, which
    // timed out on a loaded CI runner.
    for (let settled = -1; settled !== fetchMock.mock.calls.length;) {
      settled = fetchMock.mock.calls.length;
      await act(async () => {
        await Promise.all(fetchMock.mock.results.map((result) => result.value));
      });
    }
    // HandedOffOverview is mounted (check for its div element and class)
    expect(document.querySelector(".handed-off-overview")).not.toBeNull();
    // ChatPanel's composer is not mounted at all
    expect(screen.queryByLabelText("Message the assistant")).toBeNull();
  });
});

// the Deliverables tab's own `assessDeliverable` call has to thread `commitments` the same
// way Now already does (now-model.ts), or a step gated to a live commitment-kind context reads
// "Only during <title>." even while that commitment is actually running.
describe("Commitment-gated step readiness", () => {
  const commitmentContext: ConditionDefinition = {
    id: "ctx-college-class",
    name: "College class",
    kind: "live",
    status: "active",
    pathways: [],
    portability: "fixed",
    grants: [],
    setupBeforeMinutes: 0,
    transitionAfterMinutes: 0,
    channels: [],
    recurrenceRuleId: "college-rule"
  };

  const gatedDeliverable = deliverableFixture({
    id: "gated-1",
    projectId: "networking-assignment",
    title: "Gated deliverable",
    steps: [stepFixture("only-in-class", { requirementPathways: [{ id: "p0", contextIds: ["ctx-college-class"] }] })]
  });

  function stateWithCommitments(commitments: PortalState["commitments"]) {
    return {
      ...seed,
      deliverables: [gatedDeliverable],
      conditionDefinitions: [commitmentContext],
      commitments
    };
  }

  async function openStepsDrawer() {
    fireEvent.click(await screen.findByRole("button", { name: /^Actions/ }));
    return within(await screen.findByRole("dialog"));
  }

  it("shows no hold on the Deliverables tab while the gating commitment is running", async () => {
    context.state = stateWithCommitments([
      {
        id: "college-live",
        title: "College class",
        startsAt: new Date(now.getTime() - 10 * 60_000).toISOString(),
        endsAt: new Date(now.getTime() + 50 * 60_000).toISOString(),
        status: "confirmed",
        setupBeforeMinutes: 0,
        transitionAfterMinutes: 0,
        recurrenceRuleId: "college-rule"
      }
    ]);
    await openWorkspace("Gated deliverable");
    const drawer = await openStepsDrawer();
    expect(drawer.getByText("Ready to work on")).toBeTruthy();
    expect(drawer.queryByText(/Only during/)).toBeNull();
  });

  it('holds the step with "Only during …" on the Deliverables tab outside the commitment\'s window', async () => {
    context.state = stateWithCommitments([]);
    await openWorkspace("Gated deliverable");
    const drawer = await openStepsDrawer();
    expect(drawer.getByText("Only during College class.")).toBeTruthy();
  });
});

// A drafted step like "only at College" could only ever be set by the CLI
// or deliverable chat, because the workspace's own pathway editor only appears inside a session, and
// the engine will not offer a session on a step it cannot place — a step whose pathway is wrong is
// exactly a step that cannot be placed. This popup writes the field from the plain read-only view.
describe("Editing step context requirements from the read-only workspace", () => {
  const collegeContext: ConditionDefinition = {
    id: "ctx-college-class",
    name: "College class",
    kind: "live",
    status: "active",
    pathways: [],
    portability: "fixed",
    grants: [],
    setupBeforeMinutes: 0,
    transitionAfterMinutes: 0,
    channels: [],
    recurrenceRuleId: "college-rule"
  };
  const homeContext: ConditionDefinition = {
    id: "home",
    name: "Home",
    kind: "location",
    status: "active",
    pathways: [],
    portability: "fixed",
    grants: [],
    setupBeforeMinutes: 0,
    transitionAfterMinutes: 0,
    channels: []
  };
  const gatedDeliverable = deliverableFixture({
    id: "gated-2",
    projectId: "networking-assignment",
    title: "Another gated deliverable",
    steps: [stepFixture("only-in-class", { requirementPathways: [{ id: "p0", contextIds: ["ctx-college-class"] }] })]
  });

  beforeEach(() => {
    context.state = { ...seed, deliverables: [gatedDeliverable], conditionDefinitions: [collegeContext, homeContext] };
    context.saveEntityCommand.mockClear();
  });

  it("saves through save_entity/deliverable with no session open, in the shape the contract accepts", async () => {
    await openWorkspace("Another gated deliverable");
    fireEvent.click(await screen.findByRole("button", { name: /^Actions/ }));
    await screen.findByRole("dialog", { name: "Actions" });

    fireEvent.click(screen.getByRole("button", { name: "Edit requirements" }));
    const popup = await screen.findByRole("dialog", { name: /Where can/ });
    fireEvent.click(within(popup).getByRole("button", { name: "Add another way to do this" }));
    const homeCheckboxes = within(popup).getAllByRole("checkbox", { name: "Home" });
    fireEvent.click(homeCheckboxes[homeCheckboxes.length - 1]!);
    fireEvent.click(within(popup).getByRole("button", { name: "Save" }));

    await vi.waitFor(() => expect(context.saveEntityCommand).toHaveBeenCalled());
    const command = context.saveEntityCommand.mock.calls.at(-1)![0];
    expect(command.type).toBe("save_entity");
    expect(command.entityType).toBe("deliverable");
    const savedStep = command.entity.steps.find((item: { id: string }) => item.id === "only-in-class");
    expect(savedStep.requirementPathways).toEqual([
      { id: "p0", contextIds: ["ctx-college-class"] },
      expect.objectContaining({ contextIds: ["home"] })
    ]);
    // Proven against the real contract schema, not asserted by hand — the CLI and the session-editable
    // rail both write this same `{ id, contextIds }[]` read shape back, and this popup must match it.
    for (const pathway of savedStep.requirementPathways) requirementPathwaySchema.parse(pathway);
  });

  it("closes the popup with no save on Cancel", async () => {
    await openWorkspace("Another gated deliverable");
    fireEvent.click(await screen.findByRole("button", { name: /^Actions/ }));
    await screen.findByRole("dialog", { name: "Actions" });
    fireEvent.click(screen.getByRole("button", { name: "Edit requirements" }));
    const popup = await screen.findByRole("dialog", { name: /Where can/ });
    fireEvent.click(within(popup).getByRole("button", { name: "Cancel" }));
    expect(context.saveEntityCommand).not.toHaveBeenCalled();
  });
});

// 009 — the three non-command tails the command authoring design note's Verification section names
// (items 1–3), none of which had a page-level test before this. See deliverable-commands.ts for the
// builders these tails call.
describe("Handler tails a refactor could drop", () => {
  beforeEach(() => {
    context.saveEntityCommand.mockReset();
    context.runActivityCommand.mockReset();
    navigateTo.mockClear();
  });

  function runningSessionFor(deliverable: { id: string; title: string }): ActiveSession {
    return {
      id: `session-${deliverable.id}`,
      actionId: deliverable.id,
      targetType: "deliverable",
      targetId: deliverable.id,
      targetTitle: deliverable.title,
      status: "running",
      startedAt: new Date(now.getTime() - 300_000).toISOString(),
      plannedEndAt: new Date(now.getTime() + 900_000).toISOString(),
      plannedMinutes: 20,
      remainingBeforeMinutes: 90,
      activeElapsedSeconds: 300
    };
  }

  describe("finish", () => {
    it("still navigates to / after ending a running session", async () => {
      const runningSession = runningSessionFor({
        id: "assessment-1",
        title: "Assessment 1 – written assessment"
      });
      context.state = { ...state, activeSession: runningSession };

      await openWorkspace();
      fireEvent.click(await screen.findByRole("button", { name: "Session" }));
      const dialog = await screen.findByRole("dialog", { name: "Session" });
      fireEvent.click(within(dialog).getByRole("button", { name: "Stop — work remains" }));

      await vi.waitFor(() => expect(navigateTo).toHaveBeenCalledWith("/"));
      expect(context.runActivityCommand).toHaveBeenCalledTimes(1);
      const command = context.runActivityCommand.mock.calls[0]![0];
      expect(command.type).toBe("finish_activity");
      expect(command.sessionId).toBe(runningSession.id);
      expect(command.outcome).toBe("stopped");
    });
  });

  describe("markComplete", () => {
    function completableDeliverable() {
      return deliverableFixture({
        id: "completable-1",
        projectId: "networking-assignment",
        title: "Completable deliverable",
        status: "under_review",
        criteria: [criterionFixture("c1", { state: "satisfied" })],
        steps: []
      });
    }

    it("aborts cleanly with no command sent when the confirmation is declined", async () => {
      const deliverable = completableDeliverable();
      context.state = { ...state, deliverables: [deliverable], activeSession: runningSessionFor(deliverable) };
      vi.stubGlobal(
        "confirm",
        vi.fn(() => false)
      );

      await openWorkspace("Completable deliverable");
      fireEvent.click(screen.getByRole("button", { name: "Mark deliverable complete" }));

      expect(window.confirm).toHaveBeenCalledTimes(1);
      expect(context.saveEntityCommand).not.toHaveBeenCalled();
      expect(context.runActivityCommand).not.toHaveBeenCalled();
      expect(document.querySelector(".completion-panel")).toBeNull();
      expect(await screen.findByRole("button", { name: "Mark deliverable complete" })).toBeTruthy();
    });

    it("saves as completed, clears the draft and celebrates, and — with a session running — closes it only after the save lands", async () => {
      const deliverable = completableDeliverable();
      const runningSession = runningSessionFor(deliverable);
      context.state = { ...state, deliverables: [deliverable], activeSession: runningSession };
      // Stands in for the server accepting the save: the mock's own state mutation is what makes the
      // workspace's transition to its closed, completed view observable at all.
      context.saveEntityCommand.mockImplementation(async (command: { entity: Record<string, unknown> }) => {
        context.state = {
          ...context.state,
          deliverables: context.state.deliverables.map((item) =>
            item.id === deliverable.id ? ({ ...item, ...command.entity } as typeof deliverable) : item
          )
        };
      });
      // Deliberately leaves the session running rather than ending it in `context.state`: the
      // workspace's own `!editable` effect also clears a stale draft once a session ends, which would
      // mask a broken `setDraft(null)` in `markComplete` itself. Keeping the session live throughout
      // isolates that this handler's own clear is what gets the workspace to its closed view.
      context.runActivityCommand.mockImplementation(async () => {});
      vi.stubGlobal(
        "confirm",
        vi.fn(() => true)
      );

      await openWorkspace("Completable deliverable");
      // A real edit first, so `draft` is non-null going into the save — this is what lets the test see
      // whether the draft was actually cleared: if it were not, the stale (pre-completion) draft would
      // keep overriding `stored` forever and the workspace would never reach its closed, celebrating view.
      fireEvent.click(await screen.findByRole("button", { name: "Details" }));
      await screen.findByRole("dialog", { name: "Details" });
      fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Completable deliverable (edited)" } });
      fireEvent.click(screen.getByRole("button", { name: "Close Details" }));

      fireEvent.click(screen.getByRole("button", { name: "Mark deliverable complete" }));

      await vi.waitFor(() => expect(context.runActivityCommand).toHaveBeenCalledTimes(1));
      expect(context.saveEntityCommand).toHaveBeenCalledTimes(1);
      const savedCommand = context.saveEntityCommand.mock.calls[0]![0];
      expect(savedCommand.entityType).toBe("deliverable");
      expect(savedCommand.entity.status).toBe("completed");
      expect(savedCommand.entity.title).toBe("Completable deliverable (edited)");
      // The deliverable save lands before the session close.
      expect(context.saveEntityCommand.mock.invocationCallOrder[0]).toBeLessThan(
        context.runActivityCommand.mock.invocationCallOrder[0]!
      );
      const activityCommand = context.runActivityCommand.mock.calls[0]![0];
      expect(activityCommand.type).toBe("finish_activity");
      expect(activityCommand.sessionId).toBe(runningSession.id);
      expect(activityCommand.outcome).toBe("completed");

      await vi.waitFor(() => expect(document.querySelector(".completion-panel.celebrating")).not.toBeNull());
    });
  });

  describe("markComplete when the session cannot be ended", () => {
    it("celebrates the saved completion but says the timer is still running (S10-17)", async () => {
      const deliverable = deliverableFixture({
        id: "completable-2",
        projectId: "networking-assignment",
        title: "Completable deliverable",
        status: "under_review",
        criteria: [criterionFixture("c1", { state: "satisfied" })],
        steps: []
      });
      context.state = { ...state, deliverables: [deliverable], activeSession: runningSessionFor(deliverable) };
      context.saveEntityCommand.mockImplementation(async () => {});
      context.runActivityCommand.mockRejectedValue(new Error("offline"));
      vi.stubGlobal(
        "confirm",
        vi.fn(() => true)
      );

      await openWorkspace("Completable deliverable");
      fireEvent.click(screen.getByRole("button", { name: "Mark deliverable complete" }));

      await vi.waitFor(() => expect(screen.getByText(/timer could not be stopped \(offline\)/)).toBeTruthy());
    });
  });

  describe("reviewProposal", () => {
    const proposalFixture: StoredDeliverableContractProposal = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      version: 4,
      sourceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      status: "pending",
      key: "req-1",
      title: "Original title",
      required: true,
      basis: "explicit",
      confidence: "high",
      evidence: [],
      sourceType: "upload",
      createdAt: now.toISOString()
    };

    it("deletes its draft key, and sends the edited criterion's version rather than the live proposal's", async () => {
      const deliverable = deliverableFixture({
        id: "with-proposal-1",
        projectId: "networking-assignment",
        title: "Deliverable with a proposal",
        contractProposals: [proposalFixture]
      });
      context.state = { ...state, deliverables: [deliverable], activeSession: runningSessionFor(deliverable) };

      const view = render(<DeliverablesPage />);
      fireEvent.click(await screen.findByRole("button", { name: /^Deliverable with a proposal/ }));
      await screen.findByRole("heading", { name: "Deliverable with a proposal" });

      fireEvent.click(await screen.findByRole("button", { name: "Earlier extraction 1" }));
      let dialog = await screen.findByRole("dialog", { name: "Earlier bulk extraction" });
      fireEvent.change(within(dialog).getByLabelText("Requirement"), { target: { value: "Edited title" } });

      // Something else saves against the same proposal in between: the live version moves to 6 while
      // the edit above is still sitting in `proposalDrafts`, seeded at version 4.
      context.state = {
        ...context.state,
        deliverables: context.state.deliverables.map((item) =>
          item.id === deliverable.id
            ? {
                ...item,
                contractProposals: item.contractProposals.map((proposal) =>
                  proposal.id === proposalFixture.id ? { ...proposal, version: 6 } : proposal
                )
              }
            : item
        )
      };
      view.rerender(<DeliverablesPage />);
      dialog = await screen.findByRole("dialog", { name: "Earlier bulk extraction" });

      fireEvent.click(within(dialog).getByRole("button", { name: "Accept into contract" }));

      await vi.waitFor(() => expect(context.saveEntityCommand).toHaveBeenCalledTimes(1));
      const command = context.saveEntityCommand.mock.calls[0]![0];
      expect(command.entityType).toBe("deliverable_contract_review");
      expect(command.entity.id).toBe(proposalFixture.id);
      expect(command.entity.decision).toBe("confirm");
      expect(command.entity.criterion.title).toBe("Edited title");
      // The assertion: the version named is the edited criterion's (4), not the live proposal's
      // that moved underneath it (6).
      expect(command.expectedVersion).toBe(4);

      // And the draft key is gone: the field reverts to the live (unedited) proposal, not the edit.
      dialog = await screen.findByRole("dialog", { name: "Earlier bulk extraction" });
      await vi.waitFor(() =>
        expect((within(dialog).getByLabelText("Requirement") as HTMLInputElement).value).toBe("Original title")
      );
    });
  });
});
