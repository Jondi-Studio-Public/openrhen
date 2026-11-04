// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/test/render";
import { buildTitleResolver } from "@/features/plan-map/plan-map-model";
import { finding, link, planMap, titles } from "@/features/plan-map/test-fixtures";
import { FindingCard, SuggestedLinkCard } from "./plan-map-review-cards";

const resolver = buildTitleResolver(titles, planMap());

function showLink(overrides: Partial<Parameters<typeof SuggestedLinkCard>[0]> = {}) {
  const props = { link: link(), resolver, busy: false, onDecide: vi.fn(), ...overrides };
  render(<SuggestedLinkCard {...props} />);
  return props;
}

function showFinding(overrides: Partial<Parameters<typeof FindingCard>[0]> = {}) {
  const props = { finding: finding(), resolver, busy: false, onDecide: vi.fn(), ...overrides };
  render(<FindingCard {...props} />);
  return props;
}

describe("SuggestedLinkCard", () => {
  it("shows both ends by title, the kind, the proposer and its confidence, and the evidence", () => {
    showLink({ link: link({ evidence: ["Title mentions maths"], weight: 0.8 }) });
    expect(screen.getByText("Practice paper")).toBeTruthy();
    expect(screen.getByText("Maths")).toBeTruthy();
    expect(screen.getByText("about")).toBeTruthy();
    expect(screen.getByText(/Suggested by rule:keywords · confidence 80%/)).toBeTruthy();
    expect(screen.getByText("Title mentions maths")).toBeTruthy();
  });

  it("leaves the confidence out when the proposer gave none", () => {
    showLink();
    expect(screen.getByText("Suggested by rule:keywords")).toBeTruthy();
  });

  it("confirms and rejects the link", () => {
    const props = showLink();
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(props.onDecide).toHaveBeenLastCalledWith("confirm");
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    expect(props.onDecide).toHaveBeenLastCalledWith("reject");
  });

  it("marks Confirm and Reject as the queue's yes and no", () => {
    showLink();
    expect(screen.getByRole("button", { name: "Confirm" }).getAttribute("data-inbox-action")).toBe("yes");
    expect(screen.getByRole("button", { name: "Reject" }).getAttribute("data-inbox-action")).toBe("no");
  });

  it("disables decisions while a change is running", () => {
    showLink({ busy: true });
    expect((screen.getByRole("button", { name: "Confirm" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Reject" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("FindingCard", () => {
  it("shows the finding with item titles, evidence and suggested changes", () => {
    showFinding({ finding: finding({ suggestedChanges: [{ summary: "Add a revision action" }, "Link the paper"] }) });
    expect(screen.getByText("Nothing prepares the exam.")).toBeTruthy();
    expect(screen.getByText("About Maths exam")).toBeTruthy();
    expect(screen.getByText("No action is linked")).toBeTruthy();
    expect(screen.getByText("2 suggested changes (not applied yet):")).toBeTruthy();
    expect(screen.getByText("Add a revision action")).toBeTruthy();
  });

  it("accepts and dismisses a finding with no question", () => {
    const open = finding();
    const props = showFinding({ finding: open });
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    expect(props.onDecide).toHaveBeenLastCalledWith("accept");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(props.onDecide).toHaveBeenLastCalledWith("dismiss");
  });

  it("marks Accept and Dismiss as the queue's yes and no", () => {
    showFinding();
    expect(screen.getByRole("button", { name: "Accept" }).getAttribute("data-inbox-action")).toBe("yes");
    expect(screen.getByRole("button", { name: "Dismiss" }).getAttribute("data-inbox-action")).toBe("no");
  });

  it("names a health check by its label and any other check by its own name", () => {
    const { unmount } = render(
      <FindingCard
        finding={finding({ checkName: "stale_deadline", text: "Overdue." })}
        resolver={resolver}
        busy={false}
        onDecide={() => {}}
      />
    );
    expect(screen.getByText("Raised by Deadline passed on an active item")).toBeTruthy();
    unmount();
    showFinding({ finding: finding({ checkName: "gap-check", text: "Gap." }) });
    expect(screen.getByText("Raised by gap-check")).toBeTruthy();
  });

  it("disables decisions while a change is running", () => {
    showFinding({ busy: true });
    expect((screen.getByRole("button", { name: "Accept" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Dismiss" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("holds Accept on a finding that asks a question until a chip or typed answer is given, then sends it", () => {
    const asking = finding({
      text: "Which subject is the action Pay rego about?",
      questions: [{ field: "subject", question: "Which subject?", suggestions: ["Maths", "Meals"] }]
    });
    const props = showFinding({ finding: asking });
    const accept = screen.getByRole("button", { name: "Accept" }) as HTMLButtonElement;
    expect(accept.disabled).toBe(true);
    expect(screen.getByText("Answer the question to accept.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Meals" }));
    expect(accept.disabled).toBe(false);
    expect(screen.queryByText("Answer the question to accept.")).toBeNull();
    fireEvent.click(accept);
    expect(props.onDecide).toHaveBeenCalledWith("accept", { subject: "Meals" });
    // Dismissing never needs an answer.
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(props.onDecide).toHaveBeenLastCalledWith("dismiss");
  });
});
