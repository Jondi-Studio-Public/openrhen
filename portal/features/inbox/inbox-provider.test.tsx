// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@/test/render";
import { useInbox } from "./inbox-provider";

const refreshQueue = vi.fn();
const refreshOpenBatch = vi.fn();
const decide = vi.fn(
  async (_ids: string[], _exit: string, write: () => Promise<unknown>, ..._rest: unknown[]) => (await write(), true)
);
const review = {
  draft: { proposalType: "action", title: "UXR2: buy printer ink", projectId: "p1" },
  confirm: vi.fn(async (_tentative: boolean, wrap: (id: string, save: () => Promise<boolean>) => Promise<boolean>) =>
    wrap("c1", async () => true)
  )
};

vi.mock("@/shared/use-media-query", () => ({ useMediaQuery: () => false }));
vi.mock("@/shared/clock", () => ({ useNow: () => new Date("2026-10-28T09:00:00Z") }));
vi.mock("@/state/portal-provider", () => ({
  usePortal: () => ({ extensions: {}, state: { settings: { timezone: "America/New_York" } } })
}));
vi.mock("@/features/imports/import-workflow-provider", () => ({
  useImportWorkflowContext: () => ({ refreshQueue, refreshOpenBatch, queue: [], history: [] })
}));
vi.mock("@/features/capture/use-proposal-review", () => ({
  useProposalReview: () => ({
    pending: [],
    someday: [],
    reference: [],
    emailChangeContext: {},
    state: { captures: [], projects: [{ id: "p1", title: "Family" }] },
    draft: review.draft,
    confirm: review.confirm
  })
}));
vi.mock("@/features/capture/email-review-count", () => ({
  refreshEmailReviewCount: vi.fn(),
  useEmailReviewCount: () => ({})
}));
vi.mock("@/features/calendar-sync/calendar-review-count", () => ({
  refreshCalendarReviewCount: vi.fn(),
  useCalendarReviewCount: () => ({})
}));
vi.mock("@/features/agent-proposals/agent-proposals-store", () => ({
  shownAgentProposals: () => [],
  useAgentProposals: () => []
}));
vi.mock("@/features/plan-map/use-plan-map-review", () => ({
  usePlanMapReview: () => ({ map: null, resolver: { titleOf: () => "" } })
}));
vi.mock("./use-room-counts", () => ({ useRoomCounts: () => ({}) }));
vi.mock("./use-inbox-decisions", () => ({ useInboxDecisions: () => ({ hidden: new Set(), decide }) }));
vi.mock("./queue", () => ({ buildQueue: () => [] }));

const { InboxProvider } = await import("./inbox-provider");

describe("InboxProvider", () => {
  it("refreshes the shell's import queue each time the Inbox is entered", () => {
    refreshQueue.mockClear();
    refreshOpenBatch.mockClear();
    const first = render(
      <InboxProvider>
        <p>room</p>
      </InboxProvider>
    );
    expect(screen.getByText("room")).toBeTruthy();
    expect(refreshQueue).toHaveBeenCalledTimes(1);
    first.unmount();
    render(
      <InboxProvider>
        <p>room</p>
      </InboxProvider>
    );
    expect(refreshQueue).toHaveBeenCalledTimes(2);
    // The batch kept open under review is reloaded on each entry too, so it is not stale.
    expect(refreshOpenBatch).toHaveBeenCalledTimes(2);
  });

  it("names what was added, and where, in the confirm toast", async () => {
    function Confirm() {
      const inbox = useInbox();
      return <button onClick={() => void inbox.confirmReviewed()}>go</button>;
    }
    render(
      <InboxProvider>
        <Confirm />
      </InboxProvider>
    );
    screen.getByText("go").click();
    await vi.waitFor(() => expect(decide).toHaveBeenCalled());
    expect(decide.mock.calls[0]![3]).toEqual({ kind: "view" });
    expect(decide.mock.calls[0]![6]).toBe("Added to Family: UXR2: buy printer ink");
    review.draft.projectId = "";
    decide.mockClear();
    screen.getByText("go").click();
    await vi.waitFor(() => expect(decide).toHaveBeenCalled());
    expect(decide.mock.calls[0]![6]).toBe("Added: UXR2: buy printer ink");
  });
});
