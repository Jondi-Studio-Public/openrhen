// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/test/render";
import { emptyProposalDraft } from "@/features/capture/proposal-draft";
import type { PortalState } from "@/state/portal-state";
import { ProposalEditor } from "./proposal-editor";

const state = {
  areas: [{ id: "a1", name: "Home" }],
  outcomes: [{ id: "o1", title: "Move house" }],
  projects: [{ id: "p1", title: "Packing" }],
  conditionDefinitions: [
    { id: "campus", name: "Campus", kind: "location", status: "active", travelMinutes: 18 },
    { id: "shed", name: "Old shed", kind: "location", status: "archived" },
    { id: "laptop", name: "Laptop", kind: "capability", status: "active" }
  ]
} as unknown as Pick<PortalState, "areas" | "outcomes" | "projects" | "conditionDefinitions">;

describe("ProposalEditor", () => {
  it("asks for the type first and only shows the fields that type needs", () => {
    const onDraftChange = vi.fn();
    const { rerender } = render(
      <ProposalEditor
        state={state}
        draft={emptyProposalDraft()}
        error=""
        onDraftChange={onDraftChange}
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    );
    expect(screen.getByLabelText("What should this become?")).toBeTruthy();
    expect(screen.getByLabelText("Corrected title")).toBeTruthy();
    expect(screen.queryByLabelText("Project")).toBeNull();
    fireEvent.change(screen.getByLabelText("What should this become?"), { target: { value: "action" } });
    expect(onDraftChange).toHaveBeenCalledWith(expect.objectContaining({ proposalType: "action" }));
    rerender(
      <ProposalEditor
        state={state}
        draft={{ ...emptyProposalDraft(), proposalType: "action" }}
        error=""
        onDraftChange={onDraftChange}
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    );
    expect(screen.getByLabelText("Project")).toBeTruthy();
    expect(screen.getByRole("option", { name: "Packing" })).toBeTruthy();
    expect(screen.getByLabelText("Expected minutes")).toBeTruthy();
    expect(screen.queryByLabelText("Starts")).toBeNull();
  });

  it("asks for a project, deadlines and notes when the type is deliverable", () => {
    render(
      <ProposalEditor
        state={state}
        draft={{ ...emptyProposalDraft(), proposalType: "deliverable" }}
        error=""
        onDraftChange={() => {}}
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    );
    expect(screen.getByLabelText("Project")).toBeTruthy();
    expect(screen.getByRole("option", { name: "Packing" })).toBeTruthy();
    expect(screen.getByLabelText("External deadline")).toBeTruthy();
    expect(screen.getByLabelText("Internal deadline")).toBeTruthy();
    expect(screen.getByLabelText("Notes")).toBeTruthy();
    expect(screen.queryByLabelText("Starts")).toBeNull();
  });

  it("explains someday and reference instead of asking for fields", () => {
    render(
      <ProposalEditor
        state={state}
        draft={{ ...emptyProposalDraft(), proposalType: "reference" }}
        error=""
        onDraftChange={() => {}}
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    );
    expect(screen.getByText(/will not be offered as current work/)).toBeTruthy();
  });

  it("drops the standalone note and action styles when embedded in another card", () => {
    const props = {
      state,
      draft: { ...emptyProposalDraft(), proposalType: "reference" as const },
      error: "",
      onDraftChange: () => {},
      onConfirm: () => {}
    };
    const { container, rerender } = render(<ProposalEditor {...props} />);
    expect(container.querySelector(".proposal-note")).not.toBeNull();
    expect(container.querySelector(".form-actions")).not.toBeNull();
    rerender(<ProposalEditor {...props} embedded />);
    expect(container.querySelector(".proposal-note")).toBeNull();
    expect(container.querySelector(".form-actions")).toBeNull();
    expect(screen.getByText(/will not be offered as current work/)).toBeTruthy();
  });

  it("offers the active places on a commitment and names the chosen one in the empty label", () => {
    const onDraftChange = vi.fn();
    const draft = { ...emptyProposalDraft(), proposalType: "fixed_commitment" as const };
    render(
      <ProposalEditor
        state={state}
        draft={draft}
        error=""
        onDraftChange={onDraftChange}
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    );
    const place = screen.getByLabelText(/^Place/) as HTMLSelectElement;
    expect([...place.options].map((option) => option.textContent)).toEqual(["— none —", "Campus"]);
    fireEvent.change(place, { target: { value: "campus" } });
    expect(onDraftChange).toHaveBeenCalledWith({ ...draft, locationId: "campus", location: "Campus" });
  });

  it("offers Confirm as tentative on a commitment only", () => {
    const onConfirm = vi.fn();
    const onConfirmTentative = vi.fn();
    const { rerender } = render(
      <ProposalEditor
        state={state}
        draft={{ ...emptyProposalDraft(), proposalType: "fixed_commitment" }}
        error=""
        onDraftChange={() => {}}
        onConfirm={onConfirm}
        onConfirmTentative={onConfirmTentative}
        onCancel={() => {}}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Confirm as tentative" }));
    expect(onConfirmTentative).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
    rerender(
      <ProposalEditor
        state={state}
        draft={{ ...emptyProposalDraft(), proposalType: "action" }}
        error=""
        onDraftChange={() => {}}
        onConfirm={onConfirm}
        onConfirmTentative={onConfirmTentative}
        onCancel={() => {}}
      />
    );
    expect(screen.queryByRole("button", { name: "Confirm as tentative" })).toBeNull();
  });

  it("confirms on submit, cancels on Cancel, and shows the error as an alert", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ProposalEditor
        state={state}
        draft={emptyProposalDraft()}
        error="Choose what this item should become."
        onDraftChange={() => {}}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />
    );
    expect(screen.getByRole("alert").textContent).toBe("Choose what this item should become.");
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("holds Confirm until every open question is answered", () => {
    const onAnswer = vi.fn();
    const questions = [
      { field: "projectId", question: "Which project?", suggestions: ["Packing"], input: "text" as const }
    ];
    const props = {
      state,
      draft: { ...emptyProposalDraft(), proposalType: "action" as const },
      error: "",
      onDraftChange: () => {},
      onConfirm: () => {},
      onCancel: () => {},
      questions,
      onAnswer
    };
    const { rerender } = render(<ProposalEditor {...props} answers={{}} />);
    expect((screen.getByRole("button", { name: "Confirm" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Packing" }));
    expect(onAnswer).toHaveBeenCalledWith("projectId", "Packing");
    rerender(<ProposalEditor {...props} answers={{ projectId: "Packing" }} />);
    expect((screen.getByRole("button", { name: "Confirm" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("says which project the placement add-on prefilled and why", () => {
    render(
      <ProposalEditor
        state={state}
        draft={{ ...emptyProposalDraft(), proposalType: "action", projectId: "p1" }}
        error=""
        onDraftChange={() => {}}
        onConfirm={() => {}}
        onCancel={() => {}}
        suggestion={{ projectId: "p1", projectTitle: "Packing", reason: "Shared words.", by: "rules" }}
      />
    );
    expect(screen.getByText(/Suggested project:/).textContent).toContain("Packing");
    expect(screen.getByText(/Suggested project:/).textContent).toContain("Shared words.");
  });

  it("explains the held Confirm in the shorter microcopy", () => {
    render(
      <ProposalEditor
        state={state}
        draft={emptyProposalDraft()}
        error=""
        onDraftChange={() => {}}
        onConfirm={() => {}}
        onCancel={() => {}}
        questions={[{ field: "title", question: "What is it called?", suggestions: [], input: "text" as const }]}
        answers={{}}
      />
    );
    expect(screen.getByText("Answer the questions to confirm.")).toBeTruthy();
  });

  it("labels the confirm button with confirmLabel, defaulting to Confirm", () => {
    const props = {
      state,
      draft: emptyProposalDraft(),
      error: "",
      onDraftChange: () => {},
      onConfirm: () => {},
      onCancel: () => {}
    };
    const { rerender } = render(<ProposalEditor {...props} />);
    expect(screen.getByRole("button", { name: "Confirm" }).getAttribute("data-inbox-action")).toBe("yes");
    rerender(<ProposalEditor {...props} confirmLabel="Add to plan" />);
    expect(screen.queryByRole("button", { name: "Confirm" })).toBeNull();
    expect(screen.getByRole("button", { name: "Add to plan" }).getAttribute("type")).toBe("submit");
  });

  it("offers Cancel only when it is given onCancel", () => {
    const onCancel = vi.fn();
    const props = { state, draft: emptyProposalDraft(), error: "", onDraftChange: () => {}, onConfirm: () => {} };
    const { rerender } = render(<ProposalEditor {...props} />);
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    rerender(<ProposalEditor {...props} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("hides the fields behind Change first but keeps the questions and Confirm", () => {
    const onShowFields = vi.fn();
    const onAnswer = vi.fn();
    const props = {
      state,
      draft: { ...emptyProposalDraft(), proposalType: "action" as const },
      error: "",
      onDraftChange: () => {},
      onConfirm: () => {},
      questions: [{ field: "projectId", question: "Which project?", suggestions: ["Packing"], input: "text" as const }],
      onAnswer,
      answers: {},
      onShowFields
    };
    const { rerender } = render(<ProposalEditor {...props} fieldsHidden />);
    expect(screen.queryByLabelText("What should this become?")).toBeNull();
    expect(screen.queryByLabelText("Corrected title")).toBeNull();
    expect(screen.getByText("Which project?")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Confirm" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Packing" }));
    expect(onAnswer).toHaveBeenCalledWith("projectId", "Packing");
    fireEvent.click(screen.getByRole("button", { name: "Change first" }));
    expect(onShowFields).toHaveBeenCalledTimes(1);
    rerender(<ProposalEditor {...props} />);
    expect(screen.getByLabelText("Corrected title")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Change first" })).toBeNull();
  });

  it("shows no Change first button without onShowFields, even with the fields hidden", () => {
    render(
      <ProposalEditor
        state={state}
        draft={emptyProposalDraft()}
        error=""
        onDraftChange={() => {}}
        onConfirm={() => {}}
        fieldsHidden
      />
    );
    expect(screen.queryByRole("button", { name: "Change first" })).toBeNull();
  });

  it("places extraActions after the editor's own buttons", () => {
    render(
      <ProposalEditor
        state={state}
        draft={emptyProposalDraft()}
        error=""
        onDraftChange={() => {}}
        onConfirm={() => {}}
        onCancel={() => {}}
        extraActions={<button type="button">Ignore</button>}
      />
    );
    const names = screen.getAllByRole("button").map((button) => button.textContent);
    expect(names.indexOf("Ignore")).toBe(names.length - 1);
    expect(names).toContain("Cancel");
  });
});
