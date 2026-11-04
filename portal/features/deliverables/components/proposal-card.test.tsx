// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { StoredDeliverableContractProposal } from "@/state/portal-state";
import { fireEvent, render, screen } from "@/test/render";
import { ProposalCard } from "./proposal-card";

const proposal: StoredDeliverableContractProposal = {
  id: "0f0c5c2a-9d0e-4b8f-9d54-1c8b8f6d2a11",
  version: 1,
  sourceId: "5a5c5c2a-9d0e-4b8f-9d54-1c8b8f6d2a22",
  status: "pending",
  key: "connectivity",
  title: "Demonstrate connectivity",
  required: true,
  interpretation: "A ping between the two hosts succeeds.",
  sourceLocation: "Rubric row 2",
  basis: "explicit",
  confidence: "high",
  evidence: ["“Students must demonstrate connectivity between hosts.”"],
  sourceTitle: "Assessment brief",
  sourceType: "deliverable_upload",
  createdAt: "2026-08-18T00:00:00.000Z"
};

describe("ProposalCard", () => {
  it("lets every criterion field be corrected before acceptance and keeps the source evidence", () => {
    const onChange = vi.fn();
    const onDecide = vi.fn();
    render(
      <ProposalCard
        proposal={proposal}
        draft={proposal}
        editable
        busy={false}
        onChange={onChange}
        onDecide={onDecide}
      />
    );
    fireEvent.change(screen.getByLabelText("Requirement"), { target: { value: "Show connectivity with a ping" } });
    fireEvent.change(screen.getByLabelText("Verification method"), { target: { value: "user_confirmation" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Required" }));
    expect(onChange.mock.calls.map(([change]) => change)).toEqual([
      { title: "Show connectivity with a ping" },
      { verificationMethod: "user_confirmation" },
      { required: false }
    ]);
    expect(screen.getByText(/Rubric row 2 · explicit · high confidence/)).toBeTruthy();
    expect(screen.getByText(/Students must demonstrate connectivity/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Accept into contract" }));
    fireEvent.click(screen.getByRole("button", { name: "Ignore" }));
    expect(onDecide.mock.calls.map(([decision]) => decision)).toEqual(["confirm", "ignore"]);
  });

  it("refuses to accept a proposal whose key or title has been blanked", () => {
    render(
      <ProposalCard
        proposal={proposal}
        draft={{ ...proposal, title: " " }}
        editable
        busy={false}
        onChange={() => {}}
        onDecide={() => {}}
      />
    );
    expect((screen.getByRole("button", { name: "Accept into contract" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows the proposal without controls when not editable", () => {
    render(
      <ProposalCard
        proposal={proposal}
        draft={proposal}
        editable={false}
        busy={false}
        onChange={() => {}}
        onDecide={() => {}}
      />
    );
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("Demonstrate connectivity")).toBeTruthy();
  });
});
