// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@/test/render";
import { createSeedState } from "@/state/portal-state";
import { deliverable } from "@/features/deliverables/test-fixtures";
import { DeliverableRegisterForm } from "@/features/plan/components/deliverable-register-form";

const seed = () => createSeedState(new Date("2026-08-18T09:00:00.000Z"));
const SEED_ZONE = "Australia/Sydney";

describe("DeliverableRegisterForm", () => {
  it("reads the whole form into one draft when it is submitted", async () => {
    const onRegister = vi.fn().mockResolvedValue(true);
    const { container } = render(
      <DeliverableRegisterForm projects={seed().projects} timezone={SEED_ZONE} onRegister={onRegister} />
    );
    fireEvent.change(screen.getByLabelText("Project"), { target: { value: "clean-room" } });
    fireEvent.change(screen.getByLabelText("Deliverable title"), { target: { value: "Assessment 2" } });
    fireEvent.change(screen.getByLabelText("Importance (1–5)"), { target: { value: "5" } });
    fireEvent.change(screen.getByLabelText("Uncertainty"), { target: { value: "high" } });
    await act(async () => {
      fireEvent.submit(container.querySelector("form")!);
    });
    expect(onRegister).toHaveBeenCalledWith({
      projectId: "clean-room",
      title: "Assessment 2",
      externalDeadlineAt: "",
      internalDeadlineAt: "",
      uncertainty: "high",
      dependencyIds: [],
      prerequisites: [],
      importance: 5,
      consequence: 3,
      private: false
    });
  });

  it("clears the form once the deliverable is accepted", async () => {
    const { container } = render(
      <DeliverableRegisterForm
        projects={seed().projects}
        timezone={SEED_ZONE}
        onRegister={vi.fn().mockResolvedValue(true)}
      />
    );
    const title = screen.getByLabelText<HTMLInputElement>("Deliverable title");
    fireEvent.change(title, { target: { value: "Assessment 2" } });
    await act(async () => {
      fireEvent.submit(container.querySelector("form")!);
    });
    expect(title.value).toBe("");
  });

  it("keeps what was typed when the deliverable is refused", async () => {
    const { container } = render(
      <DeliverableRegisterForm
        projects={seed().projects}
        timezone={SEED_ZONE}
        onRegister={vi.fn().mockResolvedValue(false)}
      />
    );
    const title = screen.getByLabelText<HTMLInputElement>("Deliverable title");
    fireEvent.change(title, { target: { value: "Assessment 2" } });
    await act(async () => {
      fireEvent.submit(container.querySelector("form")!);
    });
    expect(title.value).toBe("Assessment 2");
  });

  it("edits a registered deliverable's planning metadata, offering the others as prerequisites", async () => {
    const onUpdate = vi.fn().mockResolvedValue(true);
    const registered = deliverable({
      id: "assessment-2",
      projectId: "clean-room",
      status: "needs_breakdown",
      externalDeadlineAt: "2026-09-01T07:00:00.000Z",
      dependencyIds: []
    });
    const other = deliverable({ id: "reading", title: "Reading log", projectId: "clean-room", status: "ready" });
    const done = deliverable({ id: "old", title: "Old one", status: "completed" });
    const { container } = render(
      <DeliverableRegisterForm
        projects={seed().projects}
        deliverables={[registered, other, done]}
        timezone={SEED_ZONE}
        onRegister={vi.fn()}
        onUpdate={onUpdate}
      />
    );
    fireEvent.change(screen.getByLabelText("Registered deliverable"), { target: { value: "assessment-2" } });
    expect(screen.getByLabelText<HTMLInputElement>("Deliverable title").value).toBe("Assessment 2");
    // 07:00 UTC on 1 September is 17:00 in the seed zone (AEST, +10).
    expect(screen.getByLabelText<HTMLInputElement>("External deadline").value).toBe("2026-09-01T17:00");
    // The deliverable itself is not offered as its own prerequisite; a completed one still can be.
    const group = within(screen.getByRole("group", { name: "Deliverables" }));
    expect(group.getAllByRole("checkbox").map((box) => box.parentElement?.textContent?.trim())).toEqual([
      "Reading log",
      "Old one"
    ]);
    // Projects are offered too, grouped apart from the deliverables.
    expect(screen.getByRole("group", { name: "Projects" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Internal deadline"), { target: { value: "2026-08-30T17:00" } });
    fireEvent.change(screen.getByLabelText("Uncertainty"), { target: { value: "known" } });
    fireEvent.click(group.getByRole("checkbox", { name: "Reading log" }));
    fireEvent.click(within(screen.getByRole("group", { name: "Projects" })).getAllByRole("checkbox")[0]!);
    await act(async () => {
      fireEvent.submit(container.querySelector("form")!);
    });
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate.mock.calls[0]![0].id).toBe("assessment-2");
    expect(onUpdate.mock.calls[0]![1]).toMatchObject({
      projectId: "clean-room",
      title: "Assessment 2",
      internalDeadlineAt: "2026-08-30T17:00",
      uncertainty: "known",
      dependencyIds: ["reading"],
      prerequisites: [{ kind: "project", id: expect.any(String) }]
    });
    // Accepted, so the form returns to registering.
    expect(screen.getByRole("button", { name: "Register deliverable" })).toBeTruthy();
  });

  it("does not offer editing without an update handler, and never offers a completed deliverable", () => {
    render(
      <DeliverableRegisterForm
        projects={seed().projects}
        deliverables={[deliverable({ status: "completed" })]}
        timezone={SEED_ZONE}
        onRegister={vi.fn()}
        onUpdate={vi.fn()}
      />
    );
    expect(screen.queryByLabelText("Registered deliverable")).toBeNull();
  });
});
