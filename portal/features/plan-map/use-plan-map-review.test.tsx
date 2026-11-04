// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlanFinding, PlanLink, PlanMap } from "@openrhen/contracts";
import { fireEvent, render, screen } from "@/test/render";
import { DecisionToast } from "@/features/inbox/components/decision-toast";
import { useInboxDecisions } from "@/features/inbox/use-inbox-decisions";
import { bulkConfirmGroups } from "@/features/plan-map/plan-map-model";
import { finding, link, planMap } from "@/features/plan-map/test-fixtures";
import { FindingCard, SuggestedLinkCard } from "./components/plan-map-review-cards";
import { usePlanMapReview } from "./use-plan-map-review";

const portalState = {
  projects: [{ id: "p1", title: "Maths exam", status: "active" }],
  actions: [{ id: "a1", title: "Practice paper", status: "ready", projectId: "p1" }],
  deliverables: [],
  commitments: [],
  commitmentRecurrenceRules: []
};
vi.mock("@/state/portal-provider", () => ({ usePortal: () => ({ state: portalState }) }));
vi.mock("@/shared/clock", () => ({ useNow: () => new Date("2026-09-04T00:00:00.000Z") }));

/** A server that holds the map, so a decision, its reload and its Undo read back what a real one would. */
function serve(initial: PlanMap, options: { failReopen?: boolean } = {}) {
  let map = initial;
  const calls: string[] = [];
  const setLink = (id: string, patch: Partial<PlanLink>) =>
    (map = { ...map, links: map.links.map((item) => (item.id === id ? { ...item, ...patch } : item)) });
  const setFinding = (id: string, patch: Partial<PlanFinding>) =>
    (map = { ...map, findings: map.findings.map((item) => (item.id === id ? { ...item, ...patch } : item)) });
  const json = (body: unknown, ok = true) => Promise.resolve({ ok, json: () => Promise.resolve(body) });
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: { method?: string; body?: string }) => {
      const body = init?.body ? (JSON.parse(init.body) as { action?: string }) : {};
      if (!init?.method) return json(map);
      calls.push(`${url} ${init.body}`);
      const target = /\/(links|findings)\/([^/]+)$/.exec(url);
      if (url.endsWith("/links/bulk")) {
        const waiting = map.links.filter((item) => item.status === "suggested");
        for (const item of waiting) setLink(item.id, { status: "confirmed" });
        return json({ confirmed: waiting.length, ids: waiting.map((item) => item.id) });
      }
      if (body.action === "reopen" && options.failReopen) return json({ error: "That link is not decided." }, false);
      const id = target![2]!;
      if (target![1] === "links") {
        setLink(id, {
          status: body.action === "reopen" ? "suggested" : body.action === "confirm" ? "confirmed" : "rejected"
        });
      } else {
        setFinding(id, {
          status: body.action === "reopen" ? "open" : body.action === "accept" ? "accepted" : "dismissed"
        });
      }
      return json({});
    })
  );
  return calls;
}

/** What the Inbox does with the hook: the cards for what is still open, and the bulk confirm under Links. */
function Harness() {
  const decisions = useInboxDecisions();
  const review = usePlanMapReview(decisions);
  const links = (review.map?.links ?? []).filter((item) => item.status === "suggested");
  const findings = (review.map?.findings ?? []).filter((item) => item.status === "open");
  return (
    <>
      {links.map((item) => (
        <SuggestedLinkCard
          key={item.id}
          link={item}
          resolver={review.resolver}
          busy={review.busy}
          onDecide={(action) => void review.decideLink(item.id, action)}
        />
      ))}
      {findings.map((item) => (
        <FindingCard
          key={item.id}
          finding={item}
          resolver={review.resolver}
          busy={review.busy}
          onDecide={(action, answers) => void review.decideFinding(item.id, action, answers)}
        />
      ))}
      {review.map &&
        bulkConfirmGroups(review.map.links).map((group) => (
          <button
            key={`${group.proposer}:${group.kind}`}
            onClick={() => void review.bulkConfirm(group.proposer, group.kind)}
          >
            {`Confirm all ${group.count} "${group.kind}" from ${group.proposer}`}
          </button>
        ))}
      {review.actionError && <p role="alert">{review.actionError}</p>}
      <DecisionToast toast={decisions.toast} onDismiss={decisions.dismiss} />
    </>
  );
}

const toast = () => document.querySelector(".inbox-toast-region")!;
const button = (name: string) => screen.findByRole("button", { name });

beforeEach(() => vi.stubGlobal("matchMedia", undefined));
afterEach(() => vi.unstubAllGlobals());

describe("usePlanMapReview decisions", () => {
  it("confirms a link with a toast, and Undo reopens it on the server and brings the card back", async () => {
    const suggested = link({ fromType: "action", fromId: "a1", toType: "project", toId: "p1", kind: "prepares" });
    const calls = serve(planMap({ links: [suggested] }));
    render(<Harness />);
    fireEvent.click(await button("Confirm"));
    await vi.waitFor(() => expect(toast().textContent).toContain("Link confirmed"));
    expect(calls).toEqual([`/api/plan-map/links/${suggested.id} {"action":"confirm"}`]);
    expect(screen.queryByRole("button", { name: "Confirm" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(await button("Confirm")).toBeTruthy();
    expect(calls[1]).toBe(`/api/plan-map/links/${suggested.id} {"action":"reopen"}`);
    await vi.waitFor(() => expect(toast().textContent).toBe(""));
  });

  it("rejects a link with a toast and Undo", async () => {
    const calls = serve(planMap({ links: [link()] }));
    render(<Harness />);
    fireEvent.click(await button("Reject"));
    await vi.waitFor(() => expect(toast().textContent).toContain("Link rejected"));
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(await button("Reject")).toBeTruthy();
    expect(calls[1]).toContain('{"action":"reopen"}');
  });

  it("accepts and dismisses findings, each with an Undo that reopens it", async () => {
    const first = finding({ text: "First finding." });
    const second = finding({ text: "Second finding." });
    const calls = serve(planMap({ findings: [first, second] }));
    render(<Harness />);
    fireEvent.click((await screen.findAllByRole("button", { name: "Accept" }))[0]!);
    await vi.waitFor(() => expect(toast().textContent).toContain("Finding accepted"));
    expect(screen.queryByText("First finding.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(await screen.findByText("First finding.")).toBeTruthy();
    expect(calls[1]).toBe(`/api/plan-map/findings/${first.id} {"action":"reopen"}`);

    fireEvent.click((await screen.findAllByRole("button", { name: "Dismiss" }))[1]!);
    await vi.waitFor(() => expect(toast().textContent).toContain("Finding dismissed"));
    expect(calls[2]).toBe(`/api/plan-map/findings/${second.id} {"action":"dismiss"}`);
  });

  it("confirms many at once with one toast whose Undo reopens every link the server confirmed", async () => {
    const calls = serve(planMap({ links: [link({ fromId: "a1" }), link({ fromId: "a2" })] }));
    render(<Harness />);
    fireEvent.click(await button('Confirm all 2 "about" from rule:keywords'));
    await vi.waitFor(() => expect(toast().textContent).toContain("Confirmed 2 links"));
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await vi.waitFor(() => expect(calls.filter((call) => call.includes('"reopen"'))).toHaveLength(2));
    expect(await button('Confirm all 2 "about" from rule:keywords')).toBeTruthy();
  });

  it("shows the reason in the toast when the server refuses the Undo, and keeps the decision", async () => {
    serve(planMap({ links: [link()] }), { failReopen: true });
    render(<Harness />);
    fireEvent.click(await button("Confirm"));
    await vi.waitFor(() => expect(toast().textContent).toContain("Link confirmed"));
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await vi.waitFor(() => expect(toast().textContent).toContain("That link is not decided."));
    expect(screen.queryByRole("button", { name: "Confirm" })).toBeNull();
  });

  it("brings the card back with its error and no toast when the decision is refused", async () => {
    const suggested = link();
    serve(planMap({ links: [suggested] }));
    const fetchMock = vi.mocked(fetch);
    const read = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url, init) =>
      init?.method
        ? Promise.resolve({
            ok: false,
            json: () => Promise.resolve({ error: "That link no longer exists." })
          } as Response)
        : read(url, init)
    );
    render(<Harness />);
    fireEvent.click(await button("Confirm"));
    expect((await screen.findByRole("alert")).textContent).toBe("That link no longer exists.");
    expect(await button("Confirm")).toBeTruthy();
    expect(toast().textContent).toBe("");
  });
});
