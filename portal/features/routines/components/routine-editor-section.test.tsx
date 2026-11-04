// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/test/render";
import { createSeedState } from "@/state/portal-state";
import type { PortalState } from "@/state/portal-state";
import { RoutineEditorSection } from "@/features/routines/components/routine-editor-section";

// The board measures itself after layout, which needs an observer jsdom does not ship — see
// routine-board.test.tsx's own note.
beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
});

const now = new Date("2026-08-18T10:00:00.000Z");
const seed = createSeedState(now);

const context = {
  state: { ...seed, routinePresets: [] as PortalState["routinePresets"] },
  saving: false,
  saveEntityCommand: vi.fn()
};
vi.mock("@/state/portal-provider", () => ({ usePortal: () => context }));

beforeEach(() => {
  context.state = { ...seed, routinePresets: [] };
  context.saving = false;
  context.saveEntityCommand.mockReset();
});

/**
 * `009` — three tails the command authoring design note's Verification section names for this
 * component (item 6), pinned here for the first time: the `submittingRef` guard, the topological
 * reorder, and the baseline reset, plus the refusals that make the reorder reachable at all.
 */

function openNewPreset() {
  fireEvent.click(screen.getByRole("button", { name: "New routine" }));
}
function setRoutineName(name: string) {
  fireEvent.change(screen.getByLabelText(/^Routine name/), { target: { value: name } });
}
function setCommitmentName(name: string) {
  fireEvent.change(screen.getByLabelText("Commitment name"), { target: { value: name } });
}
function addTile() {
  fireEvent.click(screen.getByRole("button", { name: "Add tile" }));
}
/** Types into whichever tile's editor is currently open — the one `addStep`/"Edit …" most recently opened. */
function setOpenTileName(name: string) {
  fireEvent.change(screen.getByLabelText("Step name"), { target: { value: name } });
}
function reopenTileEditor(title: string) {
  fireEvent.click(screen.getByRole("button", { name: `Edit ${title}` }));
}
function checkDependency(name: string) {
  fireEvent.click(screen.getByRole("checkbox", { name }));
}
function saveButton() {
  return screen.getByRole("button", { name: "Save routine" });
}
/** Name both the preset and its commitment, and add one named tile — the minimum valid draft. */
function buildMinimalValidDraft() {
  openNewPreset();
  setRoutineName("Morning routine");
  setCommitmentName("Class");
  addTile();
  setOpenTileName("Wake up");
}

describe("RoutineEditorSection save", () => {
  it("sends exactly one command when two submits land in the same tick (the submittingRef guard)", async () => {
    render(<RoutineEditorSection heading="Routines" />);
    buildMinimalValidDraft();

    const button = saveButton();
    // Not awaited in between: both clicks happen before the first submit's own `await` has a chance
    // to resolve and clear the guard, which is exactly the race the guard exists for.
    fireEvent.click(button);
    fireEvent.click(button);

    await vi.waitFor(() => expect(context.saveEntityCommand).toHaveBeenCalledTimes(1));
  });

  it("renumbers steps entered out of dependency order into a sequence that satisfies every dependency", async () => {
    render(<RoutineEditorSection heading="Routines" />);
    openNewPreset();
    setRoutineName("Morning routine");
    setCommitmentName("Class");

    // Shower is created first (and so would naturally sequence first), but is then made dependent on
    // Wake up, which is created second — the out-of-order case the topological pass has to fix.
    addTile();
    setOpenTileName("Shower");
    addTile();
    setOpenTileName("Wake up");
    reopenTileEditor("Shower");
    checkDependency("Wake up");

    fireEvent.click(saveButton());

    await vi.waitFor(() => expect(context.saveEntityCommand).toHaveBeenCalledTimes(1));
    const command = context.saveEntityCommand.mock.calls[0]![0];
    const steps: { id: string; title: string; sequence: number; dependencyIds: string[] }[] = command.entity.steps;
    expect(steps).toHaveLength(2);
    // Not one hardcoded permutation: whatever order the two tiles land in, every dependency must sit
    // at a strictly lower sequence than its dependent.
    const sequenceOf = (id: string) => steps.find((step) => step.id === id)!.sequence;
    for (const step of steps)
      for (const dependencyId of step.dependencyIds) expect(sequenceOf(dependencyId)).toBeLessThan(step.sequence);
    // And the renumbering actually ran: sequences are the reordered array's own indices, not whatever
    // the tiles happened to carry from creation order.
    expect(steps.map((step) => step.sequence).sort()).toEqual([0, 1]);
    const shower = steps.find((step) => step.title === "Shower")!;
    const wakeUp = steps.find((step) => step.title === "Wake up")!;
    expect(shower.dependencyIds).toEqual([wakeUp.id]);
  });

  it("closes the tile editor, reports the save, and clears dirty on a successful save with no further edit", async () => {
    render(<RoutineEditorSection heading="Routines" />);
    openNewPreset();
    // Padded with the spaces `normalizeRoutineLabel` trims: the saved draft the baseline is taken
    // from is not byte-identical to the live one, so a save that forgets to also reset `draft` itself
    // (not just `baseline`) would leave a mismatch behind and re-offer unsaved changes.
    setRoutineName("  Morning routine  ");
    setCommitmentName("Class");
    addTile();
    setOpenTileName("Wake up");
    // The tile's editor is left open going into the save.
    expect(screen.getByText("Edit tile")).toBeTruthy();
    expect(screen.getByText("Unsaved changes")).toBeTruthy();

    fireEvent.click(saveButton());

    await vi.waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe("Routine saved and planning evidence recalculated.")
    );
    // The tile editor closed: the compact view's "Edit …" button is back, "Edit tile" is gone.
    expect(screen.queryByText("Edit tile")).toBeNull();
    expect(screen.getByRole("button", { name: "Edit Wake up" })).toBeTruthy();
    // Not dirty: a save with no further edit does not re-offer unsaved changes.
    expect(screen.getByText("All changes saved")).toBeTruthy();
    expect(screen.queryByText("Unsaved changes")).toBeNull();
    expect((saveButton() as HTMLButtonElement).disabled).toBe(true);
  });

  it("round-trips wait, must-start-by and preferred-band edits made on the tile into the saved command", async () => {
    render(<RoutineEditorSection heading="Routines" />);
    buildMinimalValidDraft();
    // The open tile from buildMinimalValidDraft is flexible and before-phase, so its band group shows.
    fireEvent.change(screen.getByLabelText(/^Timing/), { target: { value: "flexible" } });
    fireEvent.change(screen.getByLabelText("Then wait"), { target: { value: "15" } });
    fireEvent.change(screen.getByLabelText(/at least N min before it starts/), { target: { value: "20" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Morning" }));

    fireEvent.click(saveButton());

    await vi.waitFor(() => expect(context.saveEntityCommand).toHaveBeenCalledTimes(1));
    const command = context.saveEntityCommand.mock.calls[0]![0];
    const step = command.entity.steps[0];
    expect(step.waitAfterMinutes).toBe(15);
    expect(step.mustStartByMinutes).toBe(20);
    expect(step.preferredBands).toEqual(["morning"]);
  });
});

describe("RoutineEditorSection refusals", () => {
  it("refuses to save with neither the preset nor its commitment named, and sends nothing", async () => {
    render(<RoutineEditorSection heading="Routines" />);
    openNewPreset();
    // Dirty via a tile, with the preset and commitment names both left blank.
    addTile();

    fireEvent.click(saveButton());

    expect((await screen.findByRole("alert")).textContent).toBe("Name both the preset and its commitment.");
    expect(context.saveEntityCommand).not.toHaveBeenCalled();
  });

  it("refuses to save an empty tile name, and sends nothing", async () => {
    render(<RoutineEditorSection heading="Routines" />);
    openNewPreset();
    setRoutineName("Morning routine");
    setCommitmentName("Class");
    addTile();
    // Left blank deliberately: the new tile's title is never filled in.

    fireEvent.click(saveButton());

    expect((await screen.findByRole("alert")).textContent).toBe("Every preparation tile needs a name.");
    expect(context.saveEntityCommand).not.toHaveBeenCalled();
  });

  it("refuses to save with no tiles at all, and sends nothing", async () => {
    render(<RoutineEditorSection heading="Routines" />);
    openNewPreset();
    setRoutineName("Morning routine");
    setCommitmentName("Class");

    fireEvent.click(saveButton());

    expect((await screen.findByRole("alert")).textContent).toBe("Add at least one preparation tile.");
    expect(context.saveEntityCommand).not.toHaveBeenCalled();
  });
});
